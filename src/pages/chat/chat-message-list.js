// 消息列表：分页渲染、轮次跳转、关键词搜索

import { appendMessage } from './chat-message-ui.js';
import { hydrateGeneratedImages } from './chat-image.js';
import { scrollToBottom } from './chat-utils.js';

const MSG_PAGE_SIZE = 50;

/**
 * @param {object} ctx
 * @param {() => object} ctx.getChat
 * @param {HTMLElement} ctx.messagesContainer
 * @param {() => string|null} ctx.getAvatarUrl
 * @param {HTMLElement} ctx.toolsPanel
 * @param {(i: number) => void} ctx.onRefresh
 * @param {(i: number) => void} ctx.onEditResend
 * @param {(msg: string, type?: string) => void} ctx.showMemoryStatus
 * @param {object} ctx.els - roundJumpInput, roundJumpBtn, roundJumpTotal, searchInput, searchCount, toolsBtn
 */
export function createMessageListController(ctx) {
  const {
    getChat,
    messagesContainer,
    getAvatarUrl,
    toolsPanel,
    onRefresh,
    onEditResend,
    showMemoryStatus,
    els
  } = ctx;

  const {
    roundJumpInput,
    roundJumpBtn,
    roundJumpTotal,
    searchInput,
    searchCount,
    toolsBtn
  } = els;

  let renderStartIdx = -1;
  let searchMatches = [];
  let searchCursor = -1;
  let searchDebounce = null;
  let loadingEarlier = false;

  function updateRoundJumpInfo() {
    const currentChat = getChat();
    let maxRound = -1;
    for (const m of currentChat.messages) {
      if (Number.isFinite(m.round) && m.round > maxRound) maxRound = m.round;
    }
    if (roundJumpTotal) {
      roundJumpTotal.textContent = maxRound >= 0 ? `共 ${maxRound} 轮` : '无轮次记录';
    }
    if (maxRound >= 0 && roundJumpInput) roundJumpInput.max = String(maxRound);
  }

  function refreshSearchAfterRender() {
    if (!searchInput || !searchInput.value.trim()) {
      searchMatches = [];
      searchCursor = -1;
      return;
    }
    const keepCursor = searchCursor;
    const kw = searchInput.value.trim().toLowerCase();
    const currentChat = getChat();
    searchMatches = [];
    for (let i = 0; i < currentChat.messages.length; i++) {
      const msg = currentChat.messages[i];
      if (msg.content && String(msg.content).toLowerCase().includes(kw)) {
        searchMatches.push(i);
      }
    }
    if (searchMatches.length === 0) {
      searchCursor = -1;
      if (searchCount) searchCount.textContent = '无匹配';
      return;
    }
    searchCursor = Math.min(Math.max(keepCursor, 0), searchMatches.length - 1);
    const msg = currentChat.messages[searchMatches[searchCursor]];
    const node = msg && messagesContainer.querySelector(`.message[data-timestamp="${msg.timestamp}"]`);
    if (node) node.classList.add('round-jump-highlight');
    if (searchCount) searchCount.textContent = `${searchCursor + 1}/${searchMatches.length}`;
  }

  function renderMessages(scrollToEnd = true) {
    const currentChat = getChat();
    const total = currentChat.messages.length;
    if (renderStartIdx < 0) {
      renderStartIdx = Math.max(0, total - MSG_PAGE_SIZE);
    }
    renderStartIdx = Math.max(0, Math.min(renderStartIdx, Math.max(0, total - 1)));
    messagesContainer.innerHTML = '';
    if (renderStartIdx > 0) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'btn btn-ghost chat-load-earlier';
      moreBtn.textContent = `↑ 加载更早的消息（还有 ${renderStartIdx} 条）`;
      moreBtn.addEventListener('click', loadEarlierMessages);
      messagesContainer.appendChild(moreBtn);
    }
    const avatarUrl = getAvatarUrl();
    for (let i = renderStartIdx; i < total; i++) {
      const msg = currentChat.messages[i];
      appendMessage(
        messagesContainer,
        msg,
        msg.role === 'assistant' ? avatarUrl : null,
        currentChat,
        onRefresh,
        renderMessages,
        onEditResend
      );
    }
    hydrateGeneratedImages(messagesContainer);
    if (scrollToEnd) scrollToBottom(messagesContainer);
    updateRoundJumpInfo();
    refreshSearchAfterRender();
  }

  function loadEarlierMessages() {
    if (renderStartIdx === 0) return;
    const prevHeight = messagesContainer.scrollHeight;
    const prevTop = messagesContainer.scrollTop;
    renderStartIdx = Math.max(0, renderStartIdx - MSG_PAGE_SIZE);
    renderMessages(false);
    messagesContainer.scrollTop = messagesContainer.scrollHeight - prevHeight + prevTop;
  }

  function ensureMessageRendered(index) {
    if (index >= 0 && index < renderStartIdx) {
      renderStartIdx = Math.max(0, index);
      renderMessages(false);
    }
  }

  function jumpToRound(n) {
    const currentChat = getChat();
    let msgIdx = currentChat.messages.findIndex((m) => m.round === n && m.role === 'user');
    if (msgIdx < 0) msgIdx = currentChat.messages.findIndex((m) => m.round === n);
    if (msgIdx < 0) {
      showMemoryStatus(`未找到第 ${n} 轮（可能超出范围或该对话无轮次记录）`, 'info');
      return;
    }
    ensureMessageRendered(msgIdx);
    const nodes = messagesContainer.querySelectorAll(`.message[data-round="${n}"]`);
    if (nodes.length === 0) {
      showMemoryStatus(`未找到第 ${n} 轮（可能超出范围或该对话无轮次记录）`, 'info');
      return;
    }
    let target = null;
    for (const node of nodes) {
      if (node.classList.contains('user')) { target = node; break; }
    }
    if (!target) target = nodes[0];
    target.style.scrollMarginTop = (toolsPanel.classList.contains('hidden') ? 8 : toolsPanel.offsetHeight + 8) + 'px';
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('round-jump-highlight');
    setTimeout(() => target.classList.remove('round-jump-highlight'), 1600);
  }

  function jumpToMatch(i) {
    if (searchMatches.length === 0) return;
    const currentChat = getChat();
    searchCursor = ((i % searchMatches.length) + searchMatches.length) % searchMatches.length;
    const msgIdx = searchMatches[searchCursor];
    ensureMessageRendered(msgIdx);
    const msg = currentChat.messages[msgIdx];
    const node = messagesContainer.querySelector(`.message[data-timestamp="${msg.timestamp}"]`);
    if (!node) return;
    messagesContainer.querySelectorAll('.round-jump-highlight').forEach((n) => n.classList.remove('round-jump-highlight'));
    node.style.scrollMarginTop = (toolsPanel.classList.contains('hidden') ? 8 : toolsPanel.offsetHeight + 8) + 'px';
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('round-jump-highlight');
    if (searchCount) searchCount.textContent = `${searchCursor + 1}/${searchMatches.length}`;
  }

  function runMessageSearch(autoJump = true) {
    const kw = searchInput.value.trim().toLowerCase();
    searchMatches = [];
    searchCursor = -1;
    if (!kw) {
      if (searchCount) searchCount.textContent = '';
      return;
    }
    const currentChat = getChat();
    for (let i = 0; i < currentChat.messages.length; i++) {
      const msg = currentChat.messages[i];
      if (msg.content && String(msg.content).toLowerCase().includes(kw)) {
        searchMatches.push(i);
      }
    }
    if (searchMatches.length === 0) {
      if (searchCount) searchCount.textContent = '无匹配';
      return;
    }
    if (autoJump) {
      jumpToMatch(0);
    } else if (searchCount) {
      searchCount.textContent = `共 ${searchMatches.length} 条`;
    }
  }

  function bind() {
    messagesContainer.addEventListener('scroll', () => {
      if (loadingEarlier || renderStartIdx <= 0) return;
      if (messagesContainer.scrollTop < 80) {
        loadingEarlier = true;
        loadEarlierMessages();
        setTimeout(() => { loadingEarlier = false; }, 300);
      }
    });

    function closeToolsOnOutside(e) {
      if (!toolsPanel.contains(e.target) && e.target !== toolsBtn && !toolsBtn.contains(e.target)) {
        toolsPanel.classList.add('hidden');
        toolsBtn.classList.remove('active');
        document.removeEventListener('click', closeToolsOnOutside);
      }
    }
    if (toolsBtn) {
      toolsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = toolsPanel.classList.toggle('hidden');
        toolsBtn.classList.toggle('active', !isHidden);
        if (!isHidden) {
          setTimeout(() => document.addEventListener('click', closeToolsOnOutside), 0);
        } else {
          document.removeEventListener('click', closeToolsOnOutside);
        }
      });
    }

    if (roundJumpBtn) {
      roundJumpBtn.addEventListener('click', () => {
        const n = parseInt(roundJumpInput.value, 10);
        if (Number.isFinite(n)) jumpToRound(n);
      });
    }
    if (roundJumpInput) {
      roundJumpInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          roundJumpBtn.click();
        }
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => runMessageSearch(true), 300);
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (searchMatches.length) jumpToMatch(searchCursor + 1);
          else runMessageSearch(true);
        }
      });
    }
    const prevBtn = document.getElementById('btn-search-prev');
    const nextBtn = document.getElementById('btn-search-next');
    if (prevBtn) prevBtn.addEventListener('click', () => jumpToMatch(searchCursor - 1));
    if (nextBtn) nextBtn.addEventListener('click', () => jumpToMatch(searchCursor + 1));
  }

  /** 切换会话后重置分页窗口 */
  function resetPaging() {
    renderStartIdx = -1;
  }

  return {
    bind,
    renderMessages,
    loadEarlierMessages,
    ensureMessageRendered,
    updateRoundJumpInfo,
    jumpToRound,
    runMessageSearch,
    refreshSearchAfterRender,
    resetPaging
  };
}
