// 发送与流式生成：从 chat.js 拆出（Phase D5）
// 通过 createSendController(deps) 注入聊天页状态；isGenerating / abortController / 心跳定时器自持于此。

import { getConfig, saveChat, writeChatPing, deleteChatPing } from '../../services/storage.js';
import { THINKING_PREFILL, buildMessages } from '../../services/api-messages.js';
import { resolveCardPrompt } from '../../services/prompt-library.js';
import { sendChat, sendChatStream } from '../../services/api.js';
import { setRequestSessionId } from '../../services/api-headers.js';
import { resolveMemoryApi } from '../../services/api-memory.js';
import {
  selectMemoryRecalls, catchUpMemoryArchive, needsMemoryRawFallback,
  RECENT_RAW_TURNS, turnIdOf
} from '../../services/memory-engine.js';
import { buildActionOptionContext } from '../../services/action-options.js';
import { updateGenerationForeground } from '../../services/foreground.js';
import { ensurePollinationsAnchors } from '../../services/image-gen.js';
import { countTokens } from '../../utils/tokenizer.js';
import { escapeHtml, scrollToBottom, isNearBottom, extractThinkingForDisplay } from './chat-utils.js';
import { normalizePollinationsUrls, extractImageSeeds, hydrateGeneratedImages } from './chat-image.js';
import { renderMarkdown, renderAssistantDisplay } from './chat-markdown.js';
import { appendMessage } from './chat-message-ui.js';
import {
  activeSwipeIndex, syncActiveSwipe, rollbackNewSwipe, markActiveSwipeAborted
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
        // 上一轮若还没来得及后台入库，临时多带一轮原文，不阻塞发送
        if (needsMemoryRawFallback(chat.memory, pastRounds)) rawWindowOverride = RECENT_RAW_TURNS + 1;
        const excludedTurnIds = pastRounds.slice(-rawWindowOverride).map(turnIdOf);
        rawWindowTurnIds = excludedTurnIds;
        const hasIndex = Array.isArray(chat.memory.archive) && chat.memory.archive.some((a) => a && a.index && !excludedTurnIds.includes(a.turnId));
        if (hasIndex) {
          try {
            showMemoryStatus('正在查找相关历史对话…', 'info');
            const latest = pastRounds[pastRounds.length - 1] || null;
            const result = await selectMemoryRecalls(chat.memory, {
              userMessage: userMsg.content,
              messages: chat.messages,
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
          plot: chat.plot || null,
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
              // 修正 AI 漏做的 URL 编码，避免插图链接因含空格被 markdown 截断
              assistantMsg.content = normalizePollinationsUrls(assistantMsg.content);
              // 方向一·思维链闭合兜底：V4 常漏 </思考>，在第一个正文模块(>###)前补上，保证折叠解析与 few-shot 样本格式正确（纯本地字符串处理，不调 AI、不费 token）
              if (assistantMsg.content.includes('<思考>') && !assistantMsg.content.includes('</思考>')) {
                const thinkingBodyStart = assistantMsg.content.indexOf('>###');
                if (thinkingBodyStart !== -1) {
                  assistantMsg.content = assistantMsg.content.slice(0, thinkingBodyStart) + '</思考>\n\n' + assistantMsg.content.slice(thinkingBodyStart);
                }
              }
              if (contentEl) {
                contentEl.innerHTML = renderMarkdown(assistantMsg.content);
              }

              // 检查是否漏掉了输出格式最后一个模块，若开启自动补全则自动补全（元指令轮无格式，跳过）
              const config = await getConfig();
              const lastHeading = getLastOutputHeading(resolveCardPrompt(character, config, 'outputFormat'));
              if (!isMeta && config.behavior?.autoCompleteLastModule && lastHeading && !assistantMsg.content.includes('>### ' + lastHeading)) {
                try {
                  await updateGenerationForeground({ title: 'AI 回复不完整', text: '正在补全缺失模块…' });
                  // 补全走副 API（机械补写任务，稳定便宜）
                  // 过滤思维链预填充条：它带 prefix:true，DeepSeek 官方端点只允许 prefix 出现在最后一条，
                  // 夹在这条 assistant 正文前面会被直接拒收（副 API 是非 DeepSeek 时过滤也无害）
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

              // 插图种子归档：扫描本轮回复中的插图 URL，自动维护种子档案（本地正则，不调 AI；元指令轮跳过）
              // 插图种子归档：只登记新角色（基准锁定），已有角色的 seed 永不覆盖——
              // AI 按规则从档案基准做 1-20 偏移让构图随剧情变，档案本身保持基准不漂移
              const foundSeeds = isMeta ? [] : extractImageSeeds(assistantMsg.content);
              if (foundSeeds.length > 0) {
                if (!chat.seedArchive) chat.seedArchive = {};
                let archiveChanged = false;
                for (const { name, seed } of foundSeeds) {
                  if (chat.seedArchive[name]) continue; // 已登记（含旧数值形态）→ 锁定不覆盖
                  chat.seedArchive[name] = { seed, anchor: '' };
                  archiveChanged = true;
                }
                if (archiveChanged) await saveChat(chat).catch(() => {});
              }

              // 免费生图记忆：pollinations URL 机械拼入英文外貌锚点（锁脸）。元指令轮跳过
              // 快路径为纯字符串处理；仅某角色首次出图时需一次副 API 提取（几秒，一次性）
              if (!isMeta && await ensurePollinationsAnchors(assistantMsg, chat, character).catch(() => false)) {
                await saveChat(chat).catch(() => {});
                if (contentEl && contentEl.isConnected) {
                  contentEl.innerHTML = renderMarkdown(assistantMsg.content);
                }
              }
              // 正文到此定稿（含补模块、锚点）。先写回这一稿，后台出图才不会写错槽。
              syncActiveSwipe(assistantMsg);

              // 付费插图（seedream/grok/gemini）：检测到 seedream:// 标记则自动生成
              // 先把插图位置原地换成生成进度占位——此时标记渲染为"点击生成"按钮，不替换会误导用户、还可能被重复点击
              // manual 手动模式不自动生成：保留"点击生成"按钮，由用户点击后走手动面板
              const cfgForAuto = await getConfig().catch(() => ({}));
              // 元指令轮视同 manual：不自动生成插图、不入插图队列
              const isManualMode = isMeta || ((cfgForAuto.image && cfgForAuto.image.provider) || '') === 'manual';
              if (contentEl && !isManualMode) {
                const autoGenBtn = contentEl.querySelector('.img-seedream-gen');
                if (autoGenBtn) showSeedreamLoading(autoGenBtn);
              }
              // 插图生成入后台串行队列，不再 await——出图期间即可发送下一条。
              // 完成时若气泡还在当前渲染里就原地更新；已被重建（用户又发了消息）则不动 DOM，
              // 内容已落盘，下次自然渲染时图片会出现（避免重建导致正在流式的下一条回复冻结）
              if (!isManualMode) {
                const illustrationChatId = chat.id;
                syncActiveSwipe(assistantMsg);
                const imageSwipe = lockedSwipe;
                enqueueIllustrationTask(async () => {
                  const freshChat = getChat();
                  if (!freshChat || freshChat.id !== illustrationChatId) return;
                  const result = await processSeedreamMarkers(assistantMsg, imageSwipe);
                  // 用户已经翻到别的稿时，图写在发起稿上，不改当前画面
                  if (!result || !result.visible) return;
                  // contentEl 可能已随回复完成时的 renderMessages 重建而失效：
                  // 优先原地更新，失效则按 timestamp 找回当前 DOM 里的气泡再更新；
                  // 气泡不在当前渲染分页（用户翻到了很早的消息）就不动 DOM，内容已落盘
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
