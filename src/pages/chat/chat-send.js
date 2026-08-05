// 发送与流式生成：从 chat.js 拆出（Phase D5）
// 通过 createSendController(deps) 注入聊天页状态；isGenerating / abortController / 心跳定时器自持于此。

import { getConfig, saveChat, writeChatPing, deleteChatPing } from '../../services/storage.js';
import { THINKING_PREFILL, buildMessages } from '../../services/api-messages.js';
import { sendChat, sendChatStream } from '../../services/api.js';
import {
  summarizeTurn, trimAssistantForMemory, resolveMemoryApi,
  extractKnownWorldEvents, applyTurnFactsToMemory, RAW_WINDOW_TURNS,
  extractMemoryCorrections
} from '../../services/api-memory.js';
import { updateGenerationForeground } from '../../services/foreground.js';
import { countTokens } from '../../utils/tokenizer.js';
import { escapeHtml, scrollToBottom, isNearBottom } from './chat-utils.js';
import { normalizePollinationsUrls, extractImageSeeds, hydrateGeneratedImages } from './chat-image.js';
import { renderMarkdown } from './chat-markdown.js';
import { appendMessage } from './chat-message-ui.js';
import {
  getAllRounds, getLeadingGreeting, getLastOutputHeading,
  extractSceneDate, maybeCondenseLongTerm
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
 * @param {{ processSeedreamMarkers: Function, showSeedreamLoading: Function }} deps.illustration
 */
export function createSendController(deps) {
  const {
    getChat, character, characterId, avatarUrl, messagesContainer,
    els, showMemoryStatus, showMemoryRetryBar, renderMessages,
    handleRefresh, illustration
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
      const messages = await buildMessages(
        character,
        history,
        userMsg.content,
        chat.memory,
        chat.seedArchive,
        { webSearchRef: options.webSearchRef || '' }
      );

      const assistantMsg = {
        role: 'assistant',
        content: 'AI 正在输入…',
        timestamp: new Date().toISOString(),
        round: userMsg.round
      };
      chat.messages.push(assistantMsg);
      const appendResult = appendMessage(messagesContainer, assistantMsg, avatarUrl, chat, handleRefresh, renderMessages);
      contentEl = appendResult.contentEl;
      scrollToBottom(messagesContainer);

      // 调试模式：发送前弹出预览
      const config = await getConfig();
      if (config.debug?.previewBeforeSend) {
        const shouldSend = await showSendPreview(messages);
        if (!shouldSend) {
          chat.messages.pop();
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
            if (contentEl) {
              contentEl.innerHTML = renderMarkdown(assistantMsg.content);
            }
            await saveChat(chat).catch(() => {});
            resolve();
          },
          onDone: async (fullContent, aborted) => {
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

              // 检查是否漏掉了输出格式最后一个模块，若开启自动补全则自动补全
              const config = await getConfig();
              const lastHeading = getLastOutputHeading(character.outputFormat);
              if (config.behavior?.autoCompleteLastModule && lastHeading && !assistantMsg.content.includes('>### ' + lastHeading)) {
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

              // 插图种子归档：扫描本轮回复中的插图 URL，自动维护种子档案（本地正则，不调 AI）
              const foundSeeds = extractImageSeeds(assistantMsg.content);
              if (foundSeeds.length > 0) {
                if (!chat.seedArchive) chat.seedArchive = {};
                let archiveChanged = false;
                for (const { name, seed } of foundSeeds) {
                  if (chat.seedArchive[name] !== seed) {
                    chat.seedArchive[name] = seed;
                    archiveChanged = true;
                  }
                }
                if (archiveChanged) await saveChat(chat).catch(() => {});
              }

              // 付费插图（seedream/grok/gemini）：检测到 seedream:// 标记则自动生成
              // 先把插图位置原地换成生成进度占位——此时标记渲染为"点击生成"按钮，不替换会误导用户、还可能被重复点击
              // manual 手动模式不自动生成：保留"点击生成"按钮，由用户点击后走手动面板
              const cfgForAuto = await getConfig().catch(() => ({}));
              const isManualMode = ((cfgForAuto.image && cfgForAuto.image.provider) || '') === 'manual';
              if (contentEl && !isManualMode) {
                const autoGenBtn = contentEl.querySelector('.img-seedream-gen');
                if (autoGenBtn) showSeedreamLoading(autoGenBtn);
              }
              // 插图生成入后台串行队列，不再 await——出图期间即可发送下一条。
              // 完成时若气泡还在当前渲染里就原地更新；已被重建（用户又发了消息）则不动 DOM，
              // 内容已落盘，下次自然渲染时图片会出现（避免重建导致正在流式的下一条回复冻结）
              if (!isManualMode) {
                const illustrationChatId = chat.id;
                enqueueIllustrationTask(async () => {
                  const freshChat = getChat();
                  if (!freshChat || freshChat.id !== illustrationChatId) return;
                  const changed = await processSeedreamMarkers(assistantMsg);
                  if (changed && contentEl && contentEl.isConnected) {
                    const follow = isNearBottom(messagesContainer);
                    contentEl.innerHTML = renderMarkdown(assistantMsg.content);
                    hydrateGeneratedImages(contentEl);
                    if (follow) scrollToBottom(messagesContainer);
                  }
                });
              }

              // 生成短期记忆：入后台串行队列，不再 await——发送按钮随 resolve 立即恢复，
              // 总结在后台按 catch-up 顺序补全所有未总结的窗口外轮次（直到 index U-1-3）
              const shouldSummarize = character.memoryEnabled !== false;
              if (shouldSummarize) {
                const memoryChatId = chat.id;
                enqueueMemoryTask(async () => {
                // 任务真正执行时重新取当前会话（用户可能已切换对话），身份不符则跳过，
                // 跳过的轮次不丢：回到该对话后的下一次回复会经 catch-up 补总结
                const chat = getChat();
                if (!chat || chat.id !== memoryChatId) return;
                // 摘要上下文：人名参照 + 最近两条短期摘要（指代消解用；随 catch-up 推进自动滚动）
                // + 记忆修正行（从当轮回复【全文】机械提取——裁切后的总结文本可能已丢掉末尾修正行）
                // + 约定/关系/情报当前清单（全量重写：AI 拿着旧清单逐条核对，对齐文本后整体替换）
                const memoryContext = (assistantFullContent) => ({
                  characterName: character.name || '',
                  mainControlName: (character.mainControl && character.mainControl.name) || '',
                  previousSummaries: chat.memory.shortTerm.slice(-2),
                  corrections: extractMemoryCorrections(assistantFullContent || ''),
                  openPromises: (((chat.memory.facts || {}).promises) || []).filter(p => p && p.status !== 'done'),
                  currentRelations: (((chat.memory.facts || {}).relations) || []),
                  currentIntel: (((chat.memory.facts || {}).intel) || [])
                });
                const allRounds = getAllRounds(chat.messages);
                const U = allRounds.length;
                const normalTargetIdx = U - 1 - RAW_WINDOW_TURNS;
                if (normalTargetIdx >= 0) {
                  // 已总结的时间戳：短期记忆中的 + 已压缩进长期记忆的（防止压缩后 shortTerm 清空导致重复总结）
                  const summarizedTs = new Set(chat.memory.shortTerm.map(s => s.turnTimestamp));
                  const longTermSourceTs = new Set(
                    chat.memory.longTerm.flatMap(lt => lt.sourceTimestamps || [])
                  );
                  const longTermSourceRounds = new Set(
                    chat.memory.longTerm.flatMap(lt => lt.sourceRounds || [])
                  );

                  // 计算 catch-up 起始位置，避免重复总结已压缩进长期记忆的轮次
                  let catchUpStartIdx = 0;
                  if (chat.memory.longTerm.length > 0) {
                    const allSourceRounds = chat.memory.longTerm
                      .flatMap(lt => lt.sourceRounds || [])
                      .filter(r => Number.isFinite(r));

                    if (allSourceRounds.length > 0) {
                      // 新数据：sourceRounds 有效 → 找到最大已压缩轮次，从其后一轮开始
                      const maxCondensedRound = Math.max(...allSourceRounds);
                      const firstUncondensed = allRounds.findIndex(r =>
                        !Number.isFinite(r.user.round) || r.user.round > maxCondensedRound
                      );
                      catchUpStartIdx = firstUncondensed >= 0 ? firstUncondensed : normalTargetIdx;
                    } else if (chat.memory.shortTerm.length > 0) {
                      // 旧数据（sourceRounds 为空）：用短期记忆最早条目作边界
                      const shortTermTsSet = new Set(chat.memory.shortTerm.map(s => s.turnTimestamp).filter(Boolean));
                      const firstShortIdx = allRounds.findIndex(r => shortTermTsSet.has(r.user.timestamp));
                      if (firstShortIdx > 0) catchUpStartIdx = firstShortIdx;
                    } else {
                      // 旧数据 + 短期记忆也为空：无法判断边界，只处理当前目标轮次
                      catchUpStartIdx = normalTargetIdx;
                    }
                  }

                  let anySummarized = false;
                  let catchUpFailed = false;
                  // 剧情日期兜底：状态栏日期解析失败时沿用最近已知剧情日期，
                  // 不用现实世界当天——避免设定在过去/未来时间线的故事被盖上真实日期
                  let lastKnownDate = chat.memory.shortTerm.length
                    ? (chat.memory.shortTerm[chat.memory.shortTerm.length - 1].date || '')
                    : '';
                  if (!lastKnownDate) lastKnownDate = new Date().toISOString().slice(0, 10);

                  for (let i = catchUpStartIdx; i <= normalTargetIdx; i++) {
                    const target = allRounds[i];
                    // 已在短期记忆 / 已压缩进长期记忆（按 timestamp 或轮次号双重校验），跳过
                    if (
                      summarizedTs.has(target.user.timestamp) ||
                      longTermSourceTs.has(target.user.timestamp) ||
                      (Number.isFinite(target.user.round) && longTermSourceRounds.has(target.user.round))
                    ) continue;

                    const isCatchUp = i < normalTargetIdx;
                    showMemoryStatus(
                      isCatchUp ? `正在补全记忆（第 ${target.user.round ?? i + 1} 轮）...` : '正在生成短期记忆...',
                      'info'
                    );

                    // 在 try 外声明，确保 catch 里也能拿到（用于重试 payload）
                    let assistantForMemory = '';
                    let sceneDate = extractSceneDate(target.assistant.content) || lastKnownDate;
                    lastKnownDate = sceneDate;
                    try {
                      assistantForMemory = trimAssistantForMemory(target.assistant.content);
                      // 第 1 轮把开场白并进记忆
                      if (i === 0) {
                        const greeting = getLeadingGreeting(chat.messages);
                        if (greeting) assistantForMemory = `【开场白】\n${greeting}\n\n【本轮回复】\n${assistantForMemory}`;
                      }
                      const short = await summarizeTurn(
                        target.user.content,
                        assistantForMemory,
                        sceneDate,
                        extractKnownWorldEvents(chat.memory),
                        memoryContext(target.assistant.content)
                      );
                      const exists = chat.memory.shortTerm.some(s => s.turnTimestamp === target.user.timestamp);
                      if (!exists) {
                        // 散文进 shortTerm；事实备忘（含 worldEvents）单独合并，不随 shortTerm 清空而丢
                        const { promises, relations, worldEvents, intel, ...shortRow } = short;
                        chat.memory.shortTerm.push({
                          date: shortRow.date,
                          content: shortRow.content,
                          turnTimestamp: target.user.timestamp,
                          round: target.user.round ?? null
                        });
                        applyTurnFactsToMemory(chat.memory, {
                          content: short.content,
                          promises,
                          relations,
                          worldEvents,
                          intel
                        });
                        summarizedTs.add(target.user.timestamp);
                        anySummarized = true;
                      }
                      await saveChat(chat).catch(() => {});
                    } catch (e) {
                      console.warn('短期记忆生成失败:', e);
                      catchUpFailed = true;
                      const retryUser = target.user.content;
                      const retryAi = assistantForMemory;
                      const retryFullContent = target.assistant.content;
                      const retryDate = sceneDate;
                      const retryTimestamp = target.user.timestamp;
                      const retryRound = target.user.round;
                      showMemoryRetryBar(async () => {
                        showMemoryStatus('正在重试记忆总结...', 'info');
                        const short = await summarizeTurn(
                          retryUser,
                          retryAi,
                          retryDate,
                          extractKnownWorldEvents(chat.memory),
                          memoryContext(retryFullContent)
                        );
                        const existsRetry = chat.memory.shortTerm.some(s => s.turnTimestamp === retryTimestamp);
                        if (!existsRetry) {
                          const { promises, relations, worldEvents, intel, ...shortRow } = short;
                          chat.memory.shortTerm.push({
                            date: shortRow.date,
                            content: shortRow.content,
                            turnTimestamp: retryTimestamp,
                            round: retryRound ?? null
                          });
                          applyTurnFactsToMemory(chat.memory, {
                            content: short.content,
                            promises,
                            relations,
                            worldEvents,
                            intel
                          });
                        }
                        await saveChat(chat).catch(() => {});
                        showMemoryStatus('短期记忆已生成', 'success');
                        await maybeCondenseLongTerm(chat, showMemoryStatus);
                      });
                      break; // 失败时中断循环，等用户手动重试
                    }
                  }

                  if (!catchUpFailed && anySummarized) {
                    showMemoryStatus('短期记忆已生成', 'success');
                    await maybeCondenseLongTerm(chat, showMemoryStatus);
                  }
                }
                });
              }

              await updateGenerationForeground({ title: 'AI 回复完成', text: '可以去查看了' });
            } else {
              assistantMsg.aborted = true;
              assistantMsg.content = assistantMsg.content || '（已停止生成）';
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
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === 'AI 正在输入…') {
        lastMsg.content = `（生成失败：${error.message || String(error)}）`;
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
