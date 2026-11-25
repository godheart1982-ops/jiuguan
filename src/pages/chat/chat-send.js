// 发送与流式生成：从 chat.js 拆出（Phase D5）
// 通过 createSendController(deps) 注入聊天页状态；isGenerating / abortController / 心跳定时器自持于此。

import { getConfig, saveChat, writeChatPing, deleteChatPing } from '../../services/storage.js';
import { THINKING_PREFILL, buildMessages } from '../../services/api-messages.js';
import { resolveCardPrompt } from '../../services/prompt-library.js';
import { sendChat, sendChatStream } from '../../services/api.js';
import { setRequestSessionId } from '../../services/api-headers.js';
import { resolveMemoryApi } from '../../services/api-memory.js';
import {
  selectMemoryRecalls, catchUpMemoryArchive, getMemoryRawWindowSize,
  shouldRunMemoryRecall, RECENT_RAW_TURNS, turnIdOf
} from '../../services/memory-engine.js';
import { buildActionOptionContext } from '../../services/action-options.js';
import { prepareContinueBase, buildContinueMessages, mergeContinuationText } from '../../services/continue-helper.js';
import { updateGenerationForeground } from '../../services/foreground.js';
import { ensurePollinationsAnchors } from '../../services/image-gen.js';
import { countTokens } from '../../utils/tokenizer.js';
import { escapeHtml, scrollToBottom, isNearBottom, extractThinkingForDisplay } from './chat-utils.js';
import { normalizePollinationsUrls, extractImageSeeds, hydrateGeneratedImages } from './chat-image.js';
import { renderMarkdown, renderAssistantDisplay } from './chat-markdown.js';
import { appendMessage } from './chat-message-ui.js';
import {
  activeSwipeIndex, syncActiveSwipe, rollbackNewSwipe, markActiveSwipeAborted, clearActiveSwipeAborted
} from './chat-swipes.js';
import {
  getAllRounds, getLeadingGreeting, getLastOutputHeading
} from './chat-memory-helpers.js';

/**
 * @param {Object} deps
 * @param {() => Object} deps.getChat 当前会话（手动刷新会换对象，每次调用现取）
 * @param {Object} deps.character 当前角色卡
 * @param {string} deps.characterId
 * @param {string} deps.avatarUrl
 * @param {HTMLElement} deps.messagesContainer
 * @param {{ sendBtn: HTMLElement, stopBtn: HTMLElement }} deps.els
 * @param {Function} deps.showMemoryStatus
 * @param {Function} deps.showMemoryRetryBar
 * @param {Function} deps.renderMessages
 * @param {Function} deps.handleRefresh 传给 appendMessage 的「刷新回复」回调
 * @param {Function} deps.handleSwipe 传给 appendMessage 的「左右翻稿」回调
 * @param {{ processSeedreamMarkers: Function, showSeedreamLoading: Function }} deps.illustration
 */
export function createSendController(deps) {
  const {
    getChat, character, characterId, avatarUrl, messagesContainer,
    els, showMemoryStatus, showMemoryRetryBar, renderMessages,
    handleRefresh, handleSwipe, illustration
  } = deps;
  const { sendBtn, stopBtn } = els;
  const { processSeedreamMarkers, showSeedreamLoading } = illustration;

  let isGenerating = false;
  let abortController = null;
  let generatingPingTimer = null;

  // 后台任务队列（记忆 / 插图各一条）：域内串行——记忆 catch-up 依赖顺序与去重，
  // 插图避免连发时并发打生图平台；域间并行——回复完成即可发送下一条，记忆总结与出图同时开跑。
  // 断档在构造上不存在——记忆任务都按"补全所有未总结的窗口外轮次"catch-up，
  // 连发多条也只是队列里多排几个任务；App 中途被杀，下次回复时 catch-up 接着补。
  let memoryTaskQueue = Promise.resolve();
  let illustrationTaskQueue = Promise.resolve();
  function enqueueMemoryTask(job) {
    memoryTaskQueue = memoryTaskQueue.then(job).catch((e) => console.warn('后台记忆总结失败:', e));
  }
  function enqueueIllustrationTask(job) {
    illustrationTaskQueue = illustrationTaskQueue.then(job).catch((e) => console.warn('后台插图任务失败:', e));
  }

  async function showSendPreview(messages) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay send-preview-overlay';
      overlay.innerHTML = `
        <div class="modal" style="width: 900px; max-width: 96vw; height: 85vh; max-height: 800px;">
          <div class="modal-header">
            <h2>发送给 AI 的内容预览</h2>
            <button class="btn btn-ghost btn-icon" id="btn-close-preview">✕</button>
          </div>
          <div class="modal-body" style="display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0;">
            <div class="form-group" style="margin: 16px 20px 0;">
              <div class="form-label-with-action">
                <label class="form-label">最终 messages（${messages.length} 条 / 约 ${countTokens(JSON.stringify(messages))} tokens）</label>
                <button class="btn btn-ghost btn-small" id="btn-copy-preview">📋 复制</button>
              </div>
              <textarea class="form-textarea" id="preview-text" readonly style="height: 60vh; min-height: 280px; font-family: monospace; font-size: 12px;">${escapeHtml(JSON.stringify(messages, null, 2))}</textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="btn-cancel-send">取消</button>
            <button class="btn btn-primary" id="btn-confirm-send">发送</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const textarea = document.getElementById('preview-text');
      textarea.focus();

      function close(result) {
        overlay.remove();
        resolve(result);
      }

      document.getElementById('btn-close-preview').addEventListener('click', () => close(false));
      document.getElementById('btn-cancel-send').addEventListener('click', () => close(false));
      document.getElementById('btn-confirm-send').addEventListener('click', () => close(true));

      document.getElementById('btn-copy-preview').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(textarea.value);
          const btn = document.getElementById('btn-copy-preview');
          const original = btn.textContent;
          btn.textContent = '已复制';
          setTimeout(() => btn.textContent = original, 1500);
        } catch (e) {
          alert('复制失败');
        }
      });

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
    });
  }

  async function generateResponseForUserMessage(userIndex, options = {}) {
    if (isGenerating) return;

    const chat = getChat();
    const userMsg = chat.messages[userIndex];
    if (!userMsg || userMsg.role !== 'user') return;
    // 元指令轮（$开头）：跳过全部剧情向后处理（补全/种子/插图/记忆总结/调取落盘）
    const isMeta = userMsg.meta === true;

    isGenerating = true;
    sendBtn.classList.add('hidden');
    // 持久化生成标记：切走再切回时可据此判断后台仍在生成（防竞态禁发送）
    chat.generating = true;
    saveChat(chat).catch(() => {});
    // 心跳：生成期间每 5 秒刷新 .ping 心跳文件（只写时间戳，不再全量写会话 JSON），
    // 供页面重载后的残留标记自愈判断
    writeChatPing(characterId, chat.id).catch(() => {});
    generatingPingTimer = setInterval(() => {
      writeChatPing(characterId, chat.id).catch(() => {});
    }, 5000);

    let contentEl = null;

    try {
      await updateGenerationForeground({ title: 'AI 正在回复', text: '请耐心等待…' });

      const history = chat.messages.slice(0, userIndex);
      let recalledTurns = [];
      let rawWindowTurnIds = [];
      let rawWindowOverride = RECENT_RAW_TURNS;
      if (character.memoryEnabled !== false && !isMeta && chat.memory) {
        const pastRounds = getAllRounds(history).filter((r) => !r.user.meta);
        // 本地检查总结进度：尚未整理的连续新轮次全部携带原文
        rawWindowOverride = getMemoryRawWindowSize(chat.memory, pastRounds);
        const excludedTurnIds = pastRounds.slice(-rawWindowOverride).map(turnIdOf);
        rawWindowTurnIds = excludedTurnIds;
        if (shouldRunMemoryRecall(chat.memory, { userMessage: userMsg.content, excludeTurnIds: excludedTurnIds })) {
          try {
            showMemoryStatus('正在查找相关历史对话…', 'info');
            const latest = pastRounds[pastRounds.length - 1] || null;
            const result = await selectMemoryRecalls(chat.memory, {
              userMessage: userMsg.content,
              currentState: chat.memory.state,
              recentUser: latest ? latest.user.content : '',
              recentAssistant: latest ? latest.assistant.content : '',
              actionContext: latest ? buildActionOptionContext(latest.assistant.content, userMsg.content) : '',
              excludeTurnIds: excludedTurnIds
            });
            recalledTurns = result.recalls;
            await saveChat(chat).catch(() => {});
            if (recalledTurns.length) {
              showMemoryStatus('已召回历史轮次：' + recalledTurns.map((r) => `第${r.entry.round ?? '—'}轮`).join('、'), 'success');
            }
          } catch (e) {
            console.warn('历史记忆召回失败，继续使用当前状态与最近原文:', e);
            showMemoryStatus('本轮记忆召回失败，已按当前状态继续', 'warning');
          }
        }
      }
      const messages = await buildMessages(
        character,
        history,
        userMsg.content,
        chat.memory,
        chat.seedArchive,
        {
          webSearchRef: options.webSearchRef || '',
          metaCommand: isMeta,
          authorNote: chat.authorNote || null,
          recalledTurns,
          rawWindowTurnIds,
          rawWindowOverride
        }
      );

      // 刷新：复用同一条助手消息，新字写入刚开的那一稿。普通发送才新推一条。
      const reuse = options.reuseMessage || null;
      let assistantMsg;
      if (reuse) {
        assistantMsg = reuse;
        if (!assistantMsg.content) assistantMsg.content = 'AI 正在输入…';
        syncActiveSwipe(assistantMsg);
        renderMessages();
        const node = messagesContainer.querySelector(`.message[data-timestamp="${assistantMsg.timestamp}"]`);
        contentEl = node ? node.querySelector('.message-content') : null;
      } else {
        assistantMsg = {
          role: 'assistant',
          content: 'AI 正在输入…',
          timestamp: new Date().toISOString(),
          round: userMsg.round,
          ...(isMeta ? { meta: true } : {})
        };
        chat.messages.push(assistantMsg);
        const appendResult = appendMessage(
          messagesContainer, assistantMsg, avatarUrl, chat, handleRefresh, renderMessages, null, handleSwipe
        );
        contentEl = appendResult.contentEl;
      }
      // 这一稿的下标在开写时锁定。出图写回这一稿，即使用户稍后翻到别的稿。
      const lockedSwipe = activeSwipeIndex(assistantMsg);
      // 流式光标：生成期间消息末尾跳动 ▍，完成/出错/中止时移除（完成后的 renderMessages 重建也会清掉）
      if (contentEl) contentEl.classList.add('streaming-cursor');
      scrollToBottom(messagesContainer);

      // 调试模式：发送前弹出预览
      const config = await getConfig();
      if (config.debug?.previewBeforeSend) {
        const shouldSend = await showSendPreview(messages);
        if (!shouldSend) {
          if (reuse) rollbackNewSwipe(assistantMsg);
          else chat.messages.pop();
          renderMessages();
          await saveChat(chat).catch(() => {});
          finishGeneration(chat);
          stopBtn.classList.add('hidden');
          await updateGenerationForeground({ title: '已取消发送', text: '用户取消了 AI 请求' });
          setTimeout(() => {
            updateGenerationForeground({ title: '酒馆正在运行', text: '保持后台连接中…' }).catch(() => {});
          }, 4000);
          return;
        }
      }

      // 流式请求，逐字显示；同时定期保存中间结果，方便切角色卡后回来能看到
      // 会话 ID 设为当前对话 id：自定义请求头（如 opencode Go 的 x-opencode-session）按此路由；
      // 后台记忆/补全任务沿用同一会话（都属于这个对话），语义正确
      setRequestSessionId(chat.id);
      stopBtn.classList.remove('hidden');
      let lastSaveTime = 0;
      const SAVE_INTERVAL = 1000;
      await new Promise((resolve) => {
        abortController = sendChatStream(messages, {
          onChunk: (chunk) => {
            if (assistantMsg.content === 'AI 正在输入…') {
              assistantMsg.content = '';
            }
            assistantMsg.content += chunk;
            syncActiveSwipe(assistantMsg);
            if (contentEl) {
              // 跟随滚底只在用户停留在底部时进行：上翻阅读即暂停跟随，回到底部自动恢复
              const follow = isNearBottom(messagesContainer);
              contentEl.innerHTML = renderMarkdown(assistantMsg.content);
              if (follow) scrollToBottom(messagesContainer);
            }
            // 定期保存中间输出，避免切走后回来页面空白
            const now = Date.now();
            if (now - lastSaveTime > SAVE_INTERVAL) {
              lastSaveTime = now;
              saveChat(chat).catch(() => {});
            }
          },
          onError: async (message) => {
            assistantMsg.content = `（生成失败：${message}）`;
            syncActiveSwipe(assistantMsg);
            if (contentEl) {
              contentEl.classList.remove('streaming-cursor');
              contentEl.innerHTML = renderMarkdown(assistantMsg.content);
            }
            await saveChat(chat).catch(() => {});
            resolve();
          },
          onDone: async (fullContent, aborted) => {
            if (contentEl) contentEl.classList.remove('streaming-cursor');
            if (!aborted) {
              assistantMsg.content = fullContent || assistantMsg.content;
              await finalizeAssistantReply(chat, assistantMsg, {
                messages,
                isMeta,
                contentEl,
                lockedSwipe
              });

              // 最新一轮仍可刷新，不入库；只整理已经退出最近一轮窗口的定稿
              const shouldArchive = character.memoryEnabled !== false && !isMeta;
              if (shouldArchive) {
                const memoryChatId = chat.id;
                enqueueMemoryTask(async () => {
                  const fresh = getChat();
                  if (!fresh || fresh.id !== memoryChatId) return;
                  try {
                    const rounds = getAllRounds(fresh.messages).filter((r) => !r.user.meta);
                    await catchUpMemoryArchive(fresh, character, rounds, {
                      greeting: getLeadingGreeting(fresh.messages),
                      onStatus: showMemoryStatus
                    });
                  } catch (e) {
                    console.warn('原文记忆整理失败:', e);
                    showMemoryStatus('记忆整理失败，原文已保留，可在记忆编辑器重试', 'warning');
                    showMemoryRetryBar(async () => {
                      const latest = getChat();
                      const rounds = getAllRounds(latest.messages).filter((r) => !r.user.meta);
                      await catchUpMemoryArchive(latest, character, rounds, {
                        greeting: getLeadingGreeting(latest.messages),
                        onStatus: showMemoryStatus
                      });
                    });
                  }
                });
              }

              await updateGenerationForeground({ title: 'AI 回复完成', text: '可以去查看了' });
            } else {
              markActiveSwipeAborted(assistantMsg);
              assistantMsg.content = assistantMsg.content || '（已停止生成）';
              syncActiveSwipe(assistantMsg);
              if (contentEl) {
                contentEl.innerHTML = renderMarkdown(assistantMsg.content);
              }
              await updateGenerationForeground({ title: 'AI 生成已停止', text: '已保留已输出内容' });
            }
            renderMessages(isNearBottom(messagesContainer));
            await saveChat(chat).catch(() => {});
            resolve();
          }
        }, { characterId: character.id, characterName: character.name, kind: 'chat' });
      });
    } catch (error) {
      // 如果已经有占位消息，更新为错误提示
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && (lastMsg.content === 'AI 正在输入…' || lastMsg === options.reuseMessage)) {
        if (lastMsg.content === 'AI 正在输入…' || !String(lastMsg.content || '').trim()) {
          lastMsg.content = `（生成失败：${error.message || String(error)}）`;
        }
        syncActiveSwipe(lastMsg);
        renderMessages();
      } else {
        const errMsg = {
          role: 'assistant',
          content: `（生成失败：${error.message || String(error)}）`,
          timestamp: new Date().toISOString(),
          round: chat.messages[userIndex]?.round ?? null
        };
        chat.messages.push(errMsg);
        appendMessage(messagesContainer, errMsg, avatarUrl, chat, handleRefresh, renderMessages);
      }
      await saveChat(chat);
    } finally {
      finishGeneration(chat);
      // 4 秒后把常驻通知恢复为默认状态
      setTimeout(() => {
        updateGenerationForeground({ title: '酒馆正在运行', text: '保持后台连接中…' }).catch(() => {});
      }, 4000);
    }
  }

  /** 回复定稿后处理：URL 编码修正、思维链闭合、末模块补全、种子归档、锚点拼接与付费插图入队。 */
  async function finalizeAssistantReply(chat, assistantMsg, { messages, isMeta, contentEl, lockedSwipe }) {
    assistantMsg.content = normalizePollinationsUrls(assistantMsg.content);
    if (assistantMsg.content.includes('<思考>') && !assistantMsg.content.includes('</思考>')) {
      const thinkingBodyStart = assistantMsg.content.indexOf('>###');
      if (thinkingBodyStart !== -1) {
        assistantMsg.content = assistantMsg.content.slice(0, thinkingBodyStart) + '</思考>\n\n' + assistantMsg.content.slice(thinkingBodyStart);
      }
    }
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(assistantMsg.content);
    }

    const config = await getConfig();
    const lastHeading = getLastOutputHeading(resolveCardPrompt(character, config, 'outputFormat'));
    if (!isMeta && config.behavior?.autoCompleteLastModule && lastHeading && !assistantMsg.content.includes('>### ' + lastHeading)) {
      try {
        await updateGenerationForeground({ title: 'AI 回复不完整', text: '正在补全缺失模块…' });
        const completionMessages = messages.filter(m => !(m.role === 'assistant' && m.prefix === true && m.content === THINKING_PREFILL));
        const continuation = await sendChat([
          ...completionMessages,
          { role: 'assistant', content: assistantMsg.content },
          { role: 'user', content: `你上一条回复漏掉了“${lastHeading}”模块。请不要重复正文，直接补输出该模块的完整内容。` }
        ], { api: resolveMemoryApi(config.api), usageContext: { characterId: character.id, characterName: character.name, kind: 'chat' } });
        if (continuation) {
          let extra = continuation.trim();
          const marker = '>### ' + lastHeading;
          const markerIndex = extra.indexOf(marker);
          if (markerIndex !== -1) {
            extra = extra.slice(markerIndex);
          }
          assistantMsg.content += '\n\n' + extra;
          if (contentEl) {
            const follow = isNearBottom(messagesContainer);
            contentEl.innerHTML = renderMarkdown(assistantMsg.content);
            if (follow) scrollToBottom(messagesContainer);
          }
        }
      } catch (e) {
        console.warn('补全缺失模块失败:', e);
      }
    }

    const foundSeeds = isMeta ? [] : extractImageSeeds(assistantMsg.content);
    if (foundSeeds.length > 0) {
      if (!chat.seedArchive) chat.seedArchive = {};
      let archiveChanged = false;
      for (const { name, seed } of foundSeeds) {
        if (chat.seedArchive[name]) continue;
        chat.seedArchive[name] = { seed, anchor: '' };
        archiveChanged = true;
      }
      if (archiveChanged) await saveChat(chat).catch(() => {});
    }

    if (!isMeta && await ensurePollinationsAnchors(assistantMsg, chat, character).catch(() => false)) {
      await saveChat(chat).catch(() => {});
      if (contentEl && contentEl.isConnected) {
        contentEl.innerHTML = renderMarkdown(assistantMsg.content);
      }
    }
    syncActiveSwipe(assistantMsg);

    const cfgForAuto = await getConfig().catch(() => ({}));
    const isManualMode = isMeta || ((cfgForAuto.image && cfgForAuto.image.provider) || '') === 'manual';
    if (contentEl && !isManualMode) {
      const autoGenBtn = contentEl.querySelector('.img-seedream-gen');
      if (autoGenBtn) showSeedreamLoading(autoGenBtn);
    }
    if (!isManualMode) {
      const illustrationChatId = chat.id;
      syncActiveSwipe(assistantMsg);
      const imageSwipe = lockedSwipe;
      enqueueIllustrationTask(async () => {
        const freshChat = getChat();
        if (!freshChat || freshChat.id !== illustrationChatId) return;
        const result = await processSeedreamMarkers(assistantMsg, imageSwipe);
        if (!result || !result.visible) return;
        let target = (contentEl && contentEl.isConnected) ? contentEl : null;
        if (!target) {
          const node = messagesContainer.querySelector(`.message[data-timestamp="${assistantMsg.timestamp}"]`);
          target = node ? node.querySelector('.message-content') : null;
        }
        if (target) {
          const follow = isNearBottom(messagesContainer);
          target.innerHTML = renderAssistantDisplay(extractThinkingForDisplay(assistantMsg.content).body);
          hydrateGeneratedImages(target);
          if (follow) scrollToBottom(messagesContainer);
        }
      });
    }
  }

  /** 一键续写：沿用最新一条 assistant 消息末尾继续往下写，不新开轮次、不污染记忆计数。 */
  async function continueAssistantMessage(assistantIndex) {
    if (isGenerating) return;
    const chat = getChat();
    if (!chat || chat.generating) {
      showMemoryStatus('上一条回复仍在后台生成中，请稍候', 'info');
      return;
    }
    if (assistantIndex !== chat.messages.length - 1) {
      showMemoryStatus('只能续写最近一条回复', 'info');
      return;
    }
    const assistantMsg = chat.messages[assistantIndex];
    if (!assistantMsg || assistantMsg.role !== 'assistant') return;
    const prevContent = String(assistantMsg.content || '');
    if (!prevContent.trim() || prevContent === 'AI 正在输入…' || /^（生成失败：/.test(prevContent)) {
      showMemoryStatus('当前回复无法续写，请点刷新重新生成', 'info');
      return;
    }

    let userIndex = -1;
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (chat.messages[i] && chat.messages[i].role === 'user') {
        userIndex = i;
        break;
      }
    }

    const { baseContent, strippedOptions } = prepareContinueBase(prevContent);
    let isMeta = false;

    isGenerating = true;
    sendBtn.classList.add('hidden');
    chat.generating = true;
    saveChat(chat).catch(() => {});
    writeChatPing(characterId, chat.id).catch(() => {});
    generatingPingTimer = setInterval(() => {
      writeChatPing(characterId, chat.id).catch(() => {});
    }, 5000);

    const node = messagesContainer.querySelector(`.message[data-timestamp="${assistantMsg.timestamp}"]`);
    const contentEl = node ? node.querySelector('.message-content') : null;
    const lockedSwipe = activeSwipeIndex(assistantMsg);

    try {
      await updateGenerationForeground({ title: 'AI 正在续写', text: '请耐心等待…' });

      let baseMessages;
      if (userIndex !== -1) {
        const history = chat.messages.slice(0, userIndex);
        const userMsg = chat.messages[userIndex];
        isMeta = userMsg.meta === true;
        let rawWindowOverride = RECENT_RAW_TURNS;
        if (character.memoryEnabled !== false && !isMeta && chat.memory) {
          const pastRounds = getAllRounds(history).filter((r) => !r.user.meta);
          rawWindowOverride = getMemoryRawWindowSize(chat.memory, pastRounds);
        }
        baseMessages = await buildMessages(
          character,
          history,
          userMsg.content,
          chat.memory,
          chat.seedArchive,
          {
            metaCommand: isMeta,
            authorNote: chat.authorNote || null,
            rawWindowOverride
          }
        );
      } else {
        baseMessages = await buildMessages(
          character,
          [],
          '请接着开场白继续推进剧情。',
          chat.memory,
          chat.seedArchive,
          { authorNote: chat.authorNote || null }
        );
      }

      const continueMessages = buildContinueMessages(baseMessages, baseContent, strippedOptions);

      const config = await getConfig();
      if (config.debug?.previewBeforeSend) {
        const shouldSend = await showSendPreview(continueMessages);
        if (!shouldSend) {
          assistantMsg.content = prevContent;
          syncActiveSwipe(assistantMsg);
          renderMessages(false);
          await saveChat(chat).catch(() => {});
          finishGeneration(chat);
          stopBtn.classList.add('hidden');
          await updateGenerationForeground({ title: '已取消续写', text: '用户取消了 AI 请求' });
          setTimeout(() => {
            updateGenerationForeground({ title: '酒馆正在运行', text: '保持后台连接中…' }).catch(() => {});
          }, 4000);
          return;
        }
      }

      if (contentEl) contentEl.classList.add('streaming-cursor');
      scrollToBottom(messagesContainer);
      setRequestSessionId(chat.id);
      stopBtn.classList.remove('hidden');

      let rawCont = '';
      let receivedChunk = false;
      let lastSaveTime = 0;
      const SAVE_INTERVAL = 1000;

      await new Promise((resolve) => {
        abortController = sendChatStream(continueMessages, {
          onChunk: (chunk) => {
            receivedChunk = true;
            rawCont += chunk;
            assistantMsg.content = mergeContinuationText(baseContent, rawCont, { strippedOptions });
            syncActiveSwipe(assistantMsg);
            if (contentEl) {
              const follow = isNearBottom(messagesContainer);
              contentEl.innerHTML = renderAssistantDisplay(extractThinkingForDisplay(assistantMsg.content).body);
              if (follow) scrollToBottom(messagesContainer);
            }
            const now = Date.now();
            if (now - lastSaveTime > SAVE_INTERVAL) {
              lastSaveTime = now;
              saveChat(chat).catch(() => {});
            }
          },
          onError: async (message) => {
            if (contentEl) contentEl.classList.remove('streaming-cursor');
            if (!receivedChunk) {
              assistantMsg.content = prevContent;
              showMemoryStatus('续写失败：' + message, 'error');
            } else {
              assistantMsg.content = mergeContinuationText(baseContent, rawCont, { strippedOptions });
              showMemoryStatus('续写中断：' + message, 'warning');
            }
            syncActiveSwipe(assistantMsg);
            renderMessages(false);
            await saveChat(chat).catch(() => {});
            resolve();
          },
          onDone: async (fullContent, aborted) => {
            if (contentEl) contentEl.classList.remove('streaming-cursor');
            const finalRaw = fullContent || rawCont;
            if (!aborted) {
              assistantMsg.content = mergeContinuationText(baseContent, finalRaw, { strippedOptions });
              clearActiveSwipeAborted(assistantMsg);
              await finalizeAssistantReply(chat, assistantMsg, {
                messages: continueMessages,
                isMeta,
                contentEl,
                lockedSwipe
              });
              await updateGenerationForeground({ title: 'AI 续写完成', text: '可以去查看了' });
            } else {
              assistantMsg.content = receivedChunk
                ? mergeContinuationText(baseContent, rawCont, { strippedOptions })
                : prevContent;
              markActiveSwipeAborted(assistantMsg);
              syncActiveSwipe(assistantMsg);
              await updateGenerationForeground({ title: 'AI 续写已停止', text: '已保留已输出内容' });
            }
            renderMessages(isNearBottom(messagesContainer));
            await saveChat(chat).catch(() => {});
            resolve();
          }
        }, { characterId: character.id, characterName: character.name, kind: 'chat' });
      });
    } catch (error) {
      assistantMsg.content = prevContent;
      syncActiveSwipe(assistantMsg);
      showMemoryStatus('续写失败：' + (error.message || String(error)), 'error');
      renderMessages(false);
      await saveChat(chat).catch(() => {});
    } finally {
      finishGeneration(chat);
      setTimeout(() => {
        updateGenerationForeground({ title: '酒馆正在运行', text: '保持后台连接中…' }).catch(() => {});
      }, 4000);
    }
  }

  function finishGeneration(chat) {
    isGenerating = false;
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    abortController = null;
    if (generatingPingTimer) {
      clearInterval(generatingPingTimer);
      generatingPingTimer = null;
    }
    // 清除持久化生成标记与心跳文件
    if (chat) {
      chat.generating = false;
      saveChat(chat).catch(() => {});
      deleteChatPing(characterId, chat.id).catch(() => {});
    }
  }

  return {
    generate: generateResponseForUserMessage,
    continue: continueAssistantMessage,
    stop() {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    },
    isGenerating: () => isGenerating,
    getAbortController: () => abortController
  };
}
