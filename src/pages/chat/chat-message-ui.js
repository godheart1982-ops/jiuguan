// 消息 DOM：气泡、右键菜单、编辑、新建会话
import { saveChat, createUUID, toPlotPreset } from '../../services/storage.js';
import { countTokens } from '../../utils/tokenizer.js';
import { escapeHtml, extractThinkingForDisplay } from './chat-utils.js';
import { renderMarkdown, renderAssistantDisplay } from './chat-markdown.js';
import {
  swipeCount, activeSwipeIndex, isActiveSwipeAborted, syncActiveSwipe
} from './chat-swipes.js';
import { syncPendingRecalls } from '../../services/api-memory.js';

export async function createNewChat(character) {
  const now = new Date().toISOString();
  const chat = {
    id: await createUUID(),
    characterId: character.id,
    title: `与 ${character.name} 的对话`,
    messages: [],
    memory: {
      shortTerm: [],
      longTerm: []
    },
    roundCounter: 0,
    createdAt: now,
    updatedAt: now
  };

  if (character.greeting) {
    chat.messages.push({
      role: 'assistant',
      content: character.greeting,
      timestamp: now,
      round: 0
    });
  }

  // 卡级剧情线：开新局自动复制为对话副本（复用 toPlotPreset 白名单清洗；指针从 1 开始；副本可改不动卡）
  if (character.plot && Array.isArray(character.plot.stages) && character.plot.stages.length) {
    const preset = toPlotPreset(character.plot);
    if (preset.stages.length) {
      chat.plot = { ...preset, current: 1 };
    }
  }

  await saveChat(chat);
  return chat;
}

export function appendMessage(container, msg, avatarUrl, currentChat, onRefresh, onUpdate, onEditResend, onSwipe, onBranch) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${msg.role}`;
  wrapper.dataset.timestamp = msg.timestamp;
  if (Number.isFinite(msg.round)) wrapper.dataset.round = msg.round;

  const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  const roundHtml = msg.round === 0
    ? '<span class="message-round">开场白</span>'
    : (Number.isFinite(msg.round) ? `<span class="message-round">#${msg.round}</span>` : '');

  const isAssistant = msg.role === 'assistant';
  const isUser = msg.role === 'user';
  const isLastMessage = currentChat.messages.length > 0 && currentChat.messages[currentChat.messages.length - 1] === msg;

  // 操作按钮：AI 最后一条 → 滑动候选 + 刷新；用户最后一条 → 编辑并重发
  let actionsHtml = '';
  if (isAssistant && isLastMessage && onRefresh) {
    const count = swipeCount(msg);
    const swipeAt = activeSwipeIndex(msg);
    const swipeHtml = (count > 1 && onSwipe) ? `
      <button type="button" class="message-action-btn btn-swipe" data-dir="-1" ${swipeAt <= 0 ? 'disabled' : ''} title="上一稿">◀</button>
      <span class="swipe-indicator">${swipeAt + 1}/${count}</span>
      <button type="button" class="message-action-btn btn-swipe" data-dir="1" ${swipeAt >= count - 1 ? 'disabled' : ''} title="下一稿">▶</button>
    ` : '';
    actionsHtml = `<div class="message-actions">${swipeHtml}<button type="button" class="message-action-btn btn-refresh" title="再生成一稿，原来的会留下">🔄 刷新</button></div>`;
  } else if (isUser && isLastMessage && onEditResend) {
    actionsHtml = `<div class="message-actions"><button type="button" class="message-action-btn btn-edit-resend" title="编辑并重发">✎ 编辑</button></div>`;
  }

  // 中止标记跟当前稿走：翻回被中止的那一稿才显示
  const abortedHtml = isActiveSwipeAborted(msg) ? `<span style="font-size:0.8em; color:#888; margin-left:6px;">⚠ 已中止</span>` : '';
  const _disp = isAssistant ? extractThinkingForDisplay(msg.content) : { thinking: '', body: msg.content };
  const thinkingHtml = (isAssistant && _disp.thinking)
    ? `<div class="message-thinking collapsed"><button type="button" class="message-thinking-toggle">💭 思考过程（点击展开）</button><div class="message-thinking-body markdown-body">${renderMarkdown(_disp.thinking)}</div></div>`
    : '';

  wrapper.innerHTML = `
    <div class="message-body">
      ${thinkingHtml}
      <div class="message-content markdown-body">${isAssistant ? renderAssistantDisplay(_disp.body) : renderMarkdown(_disp.body)}</div>
      <div class="message-footer">
        ${actionsHtml}
        <div class="message-meta">${roundHtml}<span class="message-time">${timeStr}</span>${abortedHtml}</div>
      </div>
    </div>
  `;

  // 思考过程折叠展开
  const thinkingEl = wrapper.querySelector('.message-thinking');
  if (thinkingEl) {
    const thinkingToggle = thinkingEl.querySelector('.message-thinking-toggle');
    thinkingToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      thinkingEl.classList.toggle('collapsed');
      thinkingToggle.textContent = thinkingEl.classList.contains('collapsed') ? '💭 思考过程（点击展开）' : '💭 思考过程（点击收起）';
    });
  }

  // 绑定刷新 / 左右翻稿。只挂在最后一条回复上
  if (isAssistant && isLastMessage && onRefresh) {
    const refreshBtn = wrapper.querySelector('.btn-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = currentChat.messages.findIndex(m => m.timestamp === msg.timestamp && m.role === 'assistant');
        if (index !== -1) {
          onRefresh(index);
        }
      });
    }
    wrapper.querySelectorAll('.btn-swipe').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled || !onSwipe) return;
        const index = currentChat.messages.findIndex(m => m.timestamp === msg.timestamp && m.role === 'assistant');
        if (index !== -1) onSwipe(index, Number(btn.dataset.dir));
      });
    });
  }

  // 绑定编辑并重发按钮
  if (isUser && isLastMessage && onEditResend) {
    const editBtn = wrapper.querySelector('.btn-edit-resend');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = currentChat.messages.findIndex(m => m.timestamp === msg.timestamp && m.role === 'user');
        if (index !== -1) onEditResend(index);
      });
    }
  }

  // 消息操作菜单（编辑/复制/分支/删除）：右键与移动端长按共用
  const menuItems = [
    {
      label: '编辑消息',
      action: () => openMessageEditor(msg, wrapper, currentChat)
    },
    {
      label: '复制原文',
      action: () => navigator.clipboard.writeText(msg.content)
    },
    ...(onBranch ? [{
      label: '从这里分支',
      action: () => {
        const index = currentChat.messages.findIndex(m => m.timestamp === msg.timestamp && m.role === msg.role);
        if (index !== -1) onBranch(index);
      }
    }] : []),
    {
      label: '删除消息',
      action: async () => {
        if (!confirm('确定要删除这条消息吗？')) return;
        const index = currentChat.messages.findIndex(m => m.timestamp === msg.timestamp && m.role === msg.role);
        if (index !== -1) {
          currentChat.messages.splice(index, 1);
          await saveChat(currentChat);
          if (onUpdate) onUpdate();
        }
      }
    }
  ];
  const openMenu = (x, y) => showContextMenu(x, y, menuItems);

  // 桌面右键
  wrapper.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  });

  // 移动端：长按 1000ms 弹出同一菜单（位移超 10px / 抬起 / 滚动 / 节点被流式重绘卸载则中止）
  let pressTimer = null;
  let pressStart = null;
  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };
  wrapper.addEventListener('touchstart', (e) => {
    cancelPress();
    const t = e.touches[0];
    pressStart = { x: t.clientX, y: t.clientY };
    pressTimer = setTimeout(() => {
      pressTimer = null;
      // 流式生成会重建消息 DOM：旧节点已卸载时不许在过期节点上弹菜单
      if (!wrapper.isConnected) return;
      openMenu(pressStart.x, pressStart.y);
    }, 1000);
  }, { passive: true });
  wrapper.addEventListener('touchmove', (e) => {
    if (!pressTimer || !pressStart) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - pressStart.x) > 10 || Math.abs(t.clientY - pressStart.y) > 10) {
      cancelPress();
    }
  }, { passive: true });
  wrapper.addEventListener('touchend', cancelPress, { passive: true });
  wrapper.addEventListener('touchcancel', cancelPress, { passive: true });
  // 滚动即取消长按：流式生成中上下滑动时手指位移可能不到 10px，只能靠滚动事件兜底
  container.addEventListener('scroll', cancelPress, { passive: true });

  container.appendChild(wrapper);

  const contentEl = wrapper.querySelector('.message-content');
  return { wrapper, contentEl };
}

export function openMessageEditor(msg, wrapper, currentChat) {
  // 移除已存在的编辑器
  const existing = document.querySelector('.message-editor-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay message-editor-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width: 680px; max-width: 90vw;">
      <div class="modal-header">
        <h2>编辑消息（Markdown 原文）</h2>
        <button class="btn btn-ghost btn-icon" id="btn-close-editor">✕</button>
      </div>
      <div class="modal-body">
        <textarea class="form-textarea" id="message-editor-text" style="min-height: 320px; font-family: monospace;">${escapeHtml(msg.content)}</textarea>
        <div class="char-counter" id="message-editor-counter">0 字符</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="btn-cancel-editor">取消</button>
        <button class="btn btn-primary" id="btn-save-editor">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const textarea = document.getElementById('message-editor-text');
  const counter = document.getElementById('message-editor-counter');

  function updateCounter() {
    const tokens = countTokens(textarea.value);
    counter.textContent = `${tokens} tokens`;
    if (tokens > 0) {
      counter.classList.add('has-content');
    } else {
      counter.classList.remove('has-content');
    }
  }

  textarea.addEventListener('input', updateCounter);
  updateCounter();

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  function closeEditor() {
    overlay.remove();
  }

  document.getElementById('btn-close-editor').addEventListener('click', closeEditor);
  document.getElementById('btn-cancel-editor').addEventListener('click', closeEditor);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEditor();
  });

  document.getElementById('btn-save-editor').addEventListener('click', async () => {
    const newContent = textarea.value;
    msg.content = newContent;
    syncActiveSwipe(msg);
    if (currentChat.memory) syncPendingRecalls(currentChat.memory, msg.content);
    msg.timestamp = new Date().toISOString();

    const contentEl = wrapper.querySelector('.message-content');
    contentEl.innerHTML = msg.role === 'assistant' ? renderAssistantDisplay(newContent) : renderMarkdown(newContent);

    await saveChat(currentChat);

    closeEditor();
  });
}

export function showContextMenu(x, y, items) {
  // 移除已存在的菜单
  const existing = document.getElementById('tavern-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'tavern-context-menu';
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'context-menu-item';
    div.textContent = item.label;
    div.addEventListener('click', () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(div);
  }

  document.body.appendChild(menu);

  // 点击其他地方关闭
  function closeMenu(e) {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('contextmenu', closeMenu);
    }
  }

  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('contextmenu', closeMenu);
  }, 0);
}
