import { navigate } from '../app.js';
import { getCharacter, getAvatarDataUrl, listChats, getChat, saveChat, deleteChat, getConfig, readChatPing, deleteChatPing } from '../services/storage.js';
import { DEFAULT_AUTO_ADVANCE_PROMPT } from '../services/narrative-rules.js';
import { openMemoryEditor, migrateMemory } from './memory-editor.js';
import { countTokens } from '../utils/tokenizer.js';
import { isSearchReady, runWebSearch, formatSearchReferenceBrief, buildSearchQueryFromInput } from '../services/search-api.js';
import {
  escapeHtml, defaultAvatarUrl, scrollToBottom, renderEmptyChat
} from './chat/chat-utils.js';
import {
  applyImageUiFromConfig,
  normalizePollinationsUrls, extractImageSeeds
} from './chat/chat-image.js';
import { createNewChat, appendMessage } from './chat/chat-message-ui.js';
import { createIllustrationController } from './chat/chat-illustration.js';
import { createMemoryStatus } from './chat/chat-memory-ui.js';
import { createMessageListController } from './chat/chat-message-list.js';
import { createSendController } from './chat/chat-send.js';


export async function renderChat(container, characterId, chatId) {
  container.innerHTML = '';

  if (!characterId) {
    renderEmptyChat(container);
    return;
  }

  const character = await getCharacter(characterId);
  if (!character) {
    navigate('home');
    return;
  }

  // 插图显示档位 / 服务商 / 镜头（写入 imageUi，供渲染与生图共用）
  const appConfig = await getConfig().catch(() => ({}));
  applyImageUiFromConfig(appConfig);

  const avatarUrl = await getAvatarDataUrl(character.avatar) || defaultAvatarUrl();
  // 会话列表只是索引（id/title/updatedAt），当前会话正文按需单独加载
  let chats = await listChats(characterId);

  // 如果没有指定 chatId，使用最近的对话；如果没有对话，创建新对话
  let currentChat = null;
  if (chatId) {
    currentChat = await getChat(characterId, chatId);
  }
  if (!currentChat && chats.length > 0) {
    currentChat = await getChat(characterId, chats[0].id);
  }
  if (!currentChat) {
    currentChat = await createNewChat(character);
    chats = [currentChat];
  }

  // 兼容旧对话：迁移并确保 memory 字段为新的长期记忆结构
  migrateMemory(currentChat);

  // 插图种子档案：旧对话缺失时从历史消息补建（本地正则扫描，一次性，不调 AI）
  if (!currentChat.seedArchive) {
    const archive = {};
    for (const msg of currentChat.messages) {
      if (msg.role !== 'assistant') continue;
      for (const { name, seed } of extractImageSeeds(normalizePollinationsUrls(msg.content))) {
        archive[name] = seed;
      }
    }
    currentChat.seedArchive = archive;
    saveChat(currentChat).catch(() => {});
  }

  // 自愈：App 被杀/页面重载后 generating 标记残留会导致永远无法发送
  // 生成中每 5 秒刷新 .ping 心跳文件；标记在但心跳超 20 秒未更新，视为残留并清除
  if (currentChat.generating) {
    const ping = await readChatPing(characterId, currentChat.id) || 0;
    if (!ping || Date.now() - ping > 20000) {
      currentChat.generating = false;
      // 残留的"AI 正在输入…"占位消息标记为失败，避免一直显示输入中
      const lastMsg = currentChat.messages[currentChat.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === 'AI 正在输入…') {
        lastMsg.content = '（生成失败：连接中断）';
      }
      saveChat(currentChat).catch(() => {});
      deleteChatPing(characterId, currentChat.id).catch(() => {});
    }
  }

  // 构建聊天容器
  const chatContainer = document.createElement('div');
  chatContainer.className = 'chat-container';

  // 头部
  const header = document.createElement('div');
  header.className = 'chat-header';
  header.innerHTML = `
    <div class="chat-header-info">
      <img class="chat-header-avatar" src="${avatarUrl}" alt="${character.name}">
      <div>
        <div class="chat-header-title">${escapeHtml(character.name)}</div>
      </div>
    </div>
    <div class="chat-header-actions">
      <select class="form-select" id="chat-selector">
        ${chats.map(c => `<option value="${c.id}" ${c.id === currentChat.id ? 'selected' : ''}>${escapeHtml(c.title)}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-icon" id="btn-tools" title="工具">🧭</button>
    </div>
  `;
  chatContainer.appendChild(header);

  // 工具面板（默认折叠，点 🧭 展开；后续额外功能加在这里面）
  const toolsPanel = document.createElement('div');
  toolsPanel.className = 'chat-tools-panel hidden';
  toolsPanel.id = 'chat-tools-panel';
  toolsPanel.innerHTML = `
    <div class="chat-tools-grid">
      <button class="chat-tool-btn" id="btn-memory" title="编辑长期记忆">🧠 记忆</button>
      <button class="chat-tool-btn" id="btn-new-chat" title="新建对话">＋ 新对话</button>
      <button class="chat-tool-btn" id="btn-refresh-chat" title="刷新当前对话（重新读取最新内容）">🔄 刷新</button>
      <button class="chat-tool-btn" id="btn-reset-chat" title="重置对话">↺ 重置</button>
      <button class="chat-tool-btn" id="btn-edit-char" title="编辑角色">✎ 编辑角色</button>
      <button class="chat-tool-btn chat-tool-danger" id="btn-delete-chat" title="删除当前对话">🗑 删除对话</button>
    </div>
    <div class="chat-tools-divider"></div>
    <div class="chat-tools-row">
      <span class="chat-round-bar-label">跳至</span>
      <input type="number" class="chat-round-jump-input" id="round-jump-input" min="0" placeholder="轮次">
      <span class="chat-round-bar-label">轮</span>
      <button class="btn btn-ghost btn-small" id="btn-round-jump">跳转</button>
      <span class="chat-round-bar-total" id="round-jump-total"></span>
    </div>
    <div class="chat-tools-row">
      <input type="text" class="chat-round-jump-input" id="msg-search-input" placeholder="搜索消息内容...">
      <button class="btn btn-ghost btn-small" id="btn-search-prev" title="上一条">↑</button>
      <button class="btn btn-ghost btn-small" id="btn-search-next" title="下一条">↓</button>
      <span class="chat-round-bar-total" id="msg-search-count"></span>
    </div>
  `;
  chatContainer.appendChild(toolsPanel);

  // 消息列表
  const messagesContainer = document.createElement('div');
  messagesContainer.className = 'chat-messages';
  messagesContainer.id = 'chat-messages';
  chatContainer.appendChild(messagesContainer);

  // 输入区
  const inputArea = document.createElement('div');
  inputArea.className = 'chat-input-area';
  inputArea.innerHTML = `
    <div class="memory-status hidden" id="memory-status"></div>
    <div class="search-mount-bar hidden" id="search-mount-bar">
      <div class="search-mount-header">
        <span class="search-mount-label" id="search-mount-label">📎 已挂载联网参考</span>
        <span class="search-mount-actions">
          <button type="button" class="btn btn-ghost btn-small" id="btn-search-expand">展开</button>
          <button type="button" class="btn btn-ghost btn-small" id="btn-search-clear">清除</button>
        </span>
      </div>
      <pre class="search-mount-detail hidden" id="search-mount-detail"></pre>
    </div>
    <div class="chat-input-wrapper">
      <textarea class="chat-input" id="chat-input" placeholder="输入消息..." rows="1"></textarea>
      <div class="chat-input-actions">
        <button class="btn btn-ghost" id="btn-web-search" title="联网检索（仅用输入框内容）">🔍</button>
        <button class="btn btn-primary" id="btn-send">发送</button>
        <button class="btn btn-danger hidden" id="btn-stop">停止</button>
      </div>
    </div>
    <div class="char-counter" id="chat-input-counter">0 字符</div>
  `;
  chatContainer.appendChild(inputArea);
  container.appendChild(chatContainer);

  const memoryStatus = document.getElementById('memory-status');

  const { showMemoryStatus, showMemoryRetryBar } = createMemoryStatus(memoryStatus);

  // 消息列表：分页 / 轮次跳转 / 搜索（见 chat/chat-message-list.js）
  // onRefresh / onEditResend 在下方定义；调用时已初始化（function 声明提升）
  const messageList = createMessageListController({
    getChat: () => currentChat,
    messagesContainer,
    getAvatarUrl: () => avatarUrl,
    toolsPanel,
    onRefresh: (...args) => handleRefresh(...args),
    onEditResend: (...args) => handleEditResend(...args),
    showMemoryStatus,
    els: {
      roundJumpInput: document.getElementById('round-jump-input'),
      roundJumpBtn: document.getElementById('btn-round-jump'),
      roundJumpTotal: document.getElementById('round-jump-total'),
      searchInput: document.getElementById('msg-search-input'),
      searchCount: document.getElementById('msg-search-count'),
      toolsBtn: document.getElementById('btn-tools')
    }
  });
  const { renderMessages } = messageList;
  messageList.bind();

  // 插图：事件委托 + 付费/手动生图（见 chat/chat-illustration.js）
  const illustration = createIllustrationController({
    getChat: () => currentChat,
    character,
    characterId,
    showMemoryStatus,
    renderMessages,
    getAbortController: () => sendController.getAbortController()
  });
  const { processSeedreamMarkers, showSeedreamLoading } = illustration;
  illustration.bind(messagesContainer);

  // 手动刷新当前对话：重新从存储读取最新内容并重渲染（用于切走后回来跟上后台生成进度）
  async function refreshCurrentChat() {
    const fresh = await getChat(characterId, currentChat.id);
    if (!fresh) return;
    currentChat = fresh;
    messageList.resetPaging();
    renderMessages();
    showMemoryStatus('已刷新到最新内容', 'success');
  }


  renderMessages();

  // 事件绑定
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-send');
  const stopBtn = document.getElementById('btn-stop');
  const webSearchBtn = document.getElementById('btn-web-search');
  const searchMountBar = document.getElementById('search-mount-bar');
  const searchMountLabel = document.getElementById('search-mount-label');
  const searchMountDetail = document.getElementById('search-mount-detail');
  const btnSearchExpand = document.getElementById('btn-search-expand');
  const btnSearchClear = document.getElementById('btn-search-clear');
  // 发送/流式/记忆回调（见 chat/chat-send.js）
  // handleRefresh / handleEditResend 是下方 function 声明（提升后此处可引用）；调用发生在初始化之后
  const sendController = createSendController({
    getChat: () => currentChat,
    character,
    characterId,
    avatarUrl,
    messagesContainer,
    els: { sendBtn, stopBtn },
    showMemoryStatus,
    showMemoryRetryBar,
    renderMessages,
    handleRefresh,
    illustration: { processSeedreamMarkers, showSeedreamLoading }
  });
  // 本轮挂载的联网参考（仅内存；发送时注入 buildMessages，不写聊天历史/记忆）
  let mountedSearch = null; // { query, brief, items }

  const inputCounter = document.getElementById('chat-input-counter');

  function clearMountedSearch() {
    mountedSearch = null;
    searchMountBar.classList.add('hidden');
    searchMountDetail.classList.add('hidden');
    searchMountDetail.textContent = '';
    btnSearchExpand.textContent = '展开';
  }

  function setMountedSearch(payload) {
    mountedSearch = payload;
    searchMountLabel.textContent = `📎 已挂载联网参考 · ${payload.items.length} 条 · 「${payload.query.slice(0, 24)}${payload.query.length > 24 ? '…' : ''}」`;
    searchMountDetail.textContent = payload.brief;
    searchMountDetail.classList.add('hidden');
    btnSearchExpand.textContent = '展开';
    searchMountBar.classList.remove('hidden');
  }

  btnSearchClear.addEventListener('click', () => {
    clearMountedSearch();
    showMemoryStatus('已清除联网参考', 'info');
  });
  btnSearchExpand.addEventListener('click', () => {
    const open = searchMountDetail.classList.toggle('hidden');
    btnSearchExpand.textContent = open ? '展开' : '收起';
  });

  webSearchBtn.addEventListener('click', async () => {
    if (sendController.isGenerating() || currentChat.generating) {
      showMemoryStatus('生成中，请稍后再检索', 'info');
      return;
    }
    const q = buildSearchQueryFromInput(input.value);
    if (!q) {
      showMemoryStatus('请先在输入框填写要检索的内容（不会上传聊天记录）', 'info');
      return;
    }
    const cfg = await getConfig().catch(() => ({}));
    if (!isSearchReady(cfg.search)) {
      showMemoryStatus('请先在 API 设置 → 搜索 API 中启用并填写配置', 'error');
      return;
    }
    webSearchBtn.disabled = true;
    const prevTitle = webSearchBtn.textContent;
    webSearchBtn.textContent = '…';
    showMemoryStatus('🔍 正在检索（仅输入框内容）…', 'info');
    try {
      const { query, items } = await runWebSearch(q, cfg.search);
      const brief = formatSearchReferenceBrief(query, items);
      setMountedSearch({ query, brief, items });
      showMemoryStatus(`🔍 已挂载 ${items.length} 条参考，发送时注入本轮`, 'success');
    } catch (e) {
      showMemoryStatus('🔍 检索失败：' + ((e && e.message) || e), 'error');
    } finally {
      webSearchBtn.disabled = false;
      webSearchBtn.textContent = prevTitle;
    }
  });

  function adjustInputHeight() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  function updateInputCounter() {
    const tokens = countTokens(input.value);
    inputCounter.textContent = `${tokens} tokens`;
    if (input.value.length > 0) {
      inputCounter.classList.add('has-content');
    } else {
      inputCounter.classList.remove('has-content');
    }
  }

  input.addEventListener('input', () => {
    adjustInputHeight();
    updateInputCounter();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  sendBtn.addEventListener('click', async () => {
    let text = input.value.trim();
    if (sendController.isGenerating()) return;
    // 防竞态：后台仍有未完成的生成时禁止发送，避免与后台的 currentChat 互相覆盖
    if (currentChat.generating) {
      showMemoryStatus('上一条回复仍在后台生成中，请点 🔄 刷新查看进度或等待完成', 'info');
      return;
    }
    // 空输入 = AI 自主推演一轮：用占位指令作为 user 消息（入历史，AI 可知上一轮是它在推演）
    if (!text) {
      if (!currentChat.messages || currentChat.messages.length === 0) {
        showMemoryStatus('还没有对话历史，先发送一条消息开始吧', 'info');
        return;
      }
      const cfg = await getConfig();
      text = ((cfg.behavior && cfg.behavior.autoAdvancePrompt) || '').trim() || DEFAULT_AUTO_ADVANCE_PROMPT;
    }

    // $ 开头 = 元指令（系统指令，非剧情输入）：不推进剧情、不占轮次、不进记忆总结
    const isMeta = /^[\$＄]/.test(text);
    if (isMeta && !/^[\$＄]\s*\S/.test(text)) {
      showMemoryStatus('$ 后需要跟指令内容，例如：$总结现在所有人的关系', 'info');
      return;
    }

    // 取走本轮联网参考（只注入 API，不写入用户气泡/历史）
    const webSearchRef = mountedSearch ? mountedSearch.brief : '';
    clearMountedSearch();

    // 添加用户消息（meta 轮不分配轮次号，剧情轮编号保持连续）
    const userMsg = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      round: isMeta ? null : (currentChat.roundCounter = (Number.isFinite(currentChat.roundCounter) ? currentChat.roundCounter : 0) + 1),
      ...(isMeta ? { meta: true } : {})
    };
    currentChat.messages.push(userMsg);
    appendMessage(messagesContainer, userMsg, null, currentChat, handleRefresh, renderMessages, handleEditResend);
    input.value = '';
    input.style.height = 'auto';
    updateInputCounter();
    scrollToBottom(messagesContainer);
    await saveChat(currentChat);

    // 生成回复（联网参考仅本轮）
    await sendController.generate(currentChat.messages.length - 1, { webSearchRef });
  });

  async function handleRefresh(assistantIndex) {
    if (sendController.isGenerating()) {
      alert('请等待当前生成完成后再刷新');
      return;
    }

    // 只允许刷新最近一次回复（更老的回复可能已进入短期记忆，刷新会造成记忆断层）
    if (assistantIndex !== currentChat.messages.length - 1) {
      alert('只能刷新最近一次回复');
      return;
    }

    // 找到前一条 user 消息
    let userIndex = -1;
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (currentChat.messages[i].role === 'user') {
        userIndex = i;
        break;
      }
    }

    if (userIndex === -1) {
      alert('找不到对应的用户消息，无法刷新');
      return;
    }

    if (!confirm('确定要重新生成这条回复吗？')) return;

    // 删除该 user 消息之后的所有消息（即被刷新的旧回复）
    currentChat.messages.splice(userIndex + 1);
    // 最近一次回复一定还在原文窗口内、尚未进入短期记忆，因此短期记忆无需改动

    await saveChat(currentChat);
    renderMessages();

    // 重新生成（不算新一轮，不触发短期记忆总结）
    await sendController.generate(userIndex);
  }

  // 编辑最后一条用户消息并重发
  async function handleEditResend(userIndex) {
    if (sendController.isGenerating()) {
      alert('请等待当前生成完成后再编辑');
      return;
    }
    const userMsg = currentChat.messages[userIndex];
    if (!userMsg || userMsg.role !== 'user') return;
    openMessageEditorWithResend(userMsg, userIndex);
  }

  function openMessageEditorWithResend(msg, userIndex) {
    const existing = document.querySelector('.edit-resend-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay edit-resend-overlay';
    overlay.innerHTML = `
      <div class="modal" style="width: 680px; max-width: 90vw;">
        <div class="modal-header">
          <h2>编辑并重发</h2>
          <button class="btn btn-ghost btn-icon" id="btn-close-edit-resend">✕</button>
        </div>
        <div class="modal-body">
          <textarea class="form-textarea" id="edit-resend-text" style="min-height: 200px; font-family: inherit;">${escapeHtml(msg.content)}</textarea>
          <div class="form-hint" style="margin-top:6px;">保存后将删除此条之后的所有消息并重新生成回复。</div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="btn-cancel-edit-resend">取消</button>
          <button class="btn btn-primary" id="btn-confirm-edit-resend">保存并重发</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const textarea = document.getElementById('edit-resend-text');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    function closeEditor() { overlay.remove(); }

    document.getElementById('btn-close-edit-resend').addEventListener('click', closeEditor);
    document.getElementById('btn-cancel-edit-resend').addEventListener('click', closeEditor);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEditor(); });

    document.getElementById('btn-confirm-edit-resend').addEventListener('click', async () => {
      const newContent = textarea.value.trim();
      if (!newContent) return;

      msg.content = newContent;
      msg.timestamp = new Date().toISOString();
      // 删除该用户消息之后的所有消息（旧的 AI 回复）
      currentChat.messages.splice(userIndex + 1);

      closeEditor();
      await saveChat(currentChat);
      renderMessages();
      // 重新生成（不计新轮，不触发记忆总结）
      await sendController.generate(userIndex);
    });
  }

  stopBtn.addEventListener('click', () => {
    sendController.stop();
  });

  // 手动刷新当前对话
  document.getElementById('btn-refresh-chat').addEventListener('click', refreshCurrentChat);

  // 对话选择器
  document.getElementById('chat-selector').addEventListener('change', (e) => {
    navigate('chat', { characterId: character.id, chatId: e.target.value });
  });

  // 新建对话
  document.getElementById('btn-new-chat').addEventListener('click', async () => {
    const newChat = await createNewChat(character);
    navigate('chat', { characterId: character.id, chatId: newChat.id });
  });

  // 重置对话
  document.getElementById('btn-reset-chat').addEventListener('click', async () => {
    if (!confirm('确定要重置当前对话吗？所有聊天记录将被清除，并重新输出开场白。长期记忆会保留，短期记忆会清空。')) return;

    currentChat.messages = [];
    currentChat.memory.shortTerm = [];
    delete currentChat.memory.shortTermBatchCounter;
    if (character.greeting) {
      currentChat.messages.push({
        role: 'assistant',
        content: character.greeting,
        timestamp: new Date().toISOString()
      });
    }
    await saveChat(currentChat);
    renderMessages();
  });

  // 编辑记忆
  document.getElementById('btn-memory').addEventListener('click', () => {
    openMemoryEditor(currentChat, character, renderMessages);
  });

  // 编辑角色
  document.getElementById('btn-edit-char').addEventListener('click', () => {
    navigate('edit', { characterId: character.id });
  });

  // 删除当前对话
  document.getElementById('btn-delete-chat').addEventListener('click', async () => {
    if (confirm('确定要删除当前对话吗？')) {
      await deleteChat(character.id, currentChat.id);
      navigate('chat', { characterId: character.id, chatId: null });
    }
  });
}
