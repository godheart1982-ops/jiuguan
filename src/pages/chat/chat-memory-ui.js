// 聊天页记忆/后台状态条：进行中任务常驻不消失 + 多任务并发叠加显示 + 完成后自动消退

export function inferStatusChannel(message) {
  const text = String(message || '').trim();
  if (/召回|历史对话|历史记忆/.test(text)) return 'recall';
  if (/长期记忆/.test(text)) return 'memory-long';
  if (/整理.*记忆|原文记忆|重建.*状态|状态已按原文重建|记忆整理|索引重建|待整理|重建第.*索引/.test(text)) return 'memory-archive';
  if (/^🖼|插图|画面|提示词/.test(text)) return 'illustration';
  if (/^🔍|^📄|检索|联网参考|全文/.test(text)) return 'search';
  return 'general';
}

export function isPendingStatus(message, type = 'info', options = {}) {
  if (options && typeof options.persist === 'boolean') return options.persist;
  if (type === 'loading') return true;
  if (type === 'info' && /(?:…|\.\.\.)\s*$/.test(String(message || '').trim())) return true;
  return false;
}

/**
 * @param {HTMLElement} memoryStatusEl
 */
export function createMemoryStatus(memoryStatusEl) {
  const slots = new Map();

  function renderStack() {
    if (!memoryStatusEl) return;
    memoryStatusEl.innerHTML = '';
    if (!slots.size) {
      memoryStatusEl.className = 'memory-status-stack hidden';
      return;
    }
    memoryStatusEl.className = 'memory-status-stack';
    const doc = memoryStatusEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    for (const slot of slots.values()) {
      const row = doc.createElement('div');
      row.className = `memory-status ${slot.type}${slot.pending ? ' pending' : ''}`;
      if (row.dataset) row.dataset.statusKey = slot.key;

      if (slot.isRetryBar) {
        const label = doc.createElement('span');
        label.textContent = '⚠ 记忆整理失败';
        const retryBtn = doc.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn btn-ghost btn-small';
        retryBtn.style.marginLeft = '8px';
        retryBtn.style.padding = '2px 8px';
        retryBtn.textContent = '🔄 重试整理';
        const skipBtn = doc.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'btn btn-ghost btn-small';
        skipBtn.style.marginLeft = '4px';
        skipBtn.style.padding = '2px 8px';
        skipBtn.textContent = '跳过';

        skipBtn.addEventListener('click', () => {
          slots.delete(slot.key);
          renderStack();
        });
        retryBtn.addEventListener('click', async () => {
          retryBtn.textContent = '总结中...';
          retryBtn.disabled = true;
          try {
            await slot.retryFn();
            if (slots.get(slot.key) === slot) {
              slots.delete(slot.key);
              renderStack();
            }
          } catch (e) {
            console.warn('手动总结仍失败:', e);
            showMemoryRetryBar(slot.retryFn);
          }
        });
        row.appendChild(label);
        row.appendChild(retryBtn);
        row.appendChild(skipBtn);
      } else {
        row.textContent = slot.message;
      }
      memoryStatusEl.appendChild(row);
    }
  }

  function clearMemoryStatus(key) {
    const existing = slots.get(key);
    if (existing && existing.timer) clearTimeout(existing.timer);
    if (slots.delete(key)) renderStack();
  }

  function showMemoryStatus(message, type = 'info', options = {}) {
    const key = (options && options.key) || inferStatusChannel(message);
    const pending = isPendingStatus(message, type, options);
    const prev = slots.get(key);
    if (prev && prev.timer) clearTimeout(prev.timer);

    const slot = {
      key,
      message: String(message || ''),
      type: type === 'loading' ? 'info' : type,
      pending,
      timer: null,
      isRetryBar: false,
      retryFn: null
    };
    slots.set(key, slot);

    if (!pending) {
      const delay = Number.isFinite(options.duration)
        ? options.duration
        : (type === 'error' ? 6000 : 4000);
      slot.timer = setTimeout(() => {
        if (slots.get(key) === slot) {
          slots.delete(key);
          renderStack();
        }
      }, delay);
    }
    renderStack();
  }

  function showMemoryRetryBar(retryFn) {
    const key = 'memory-archive';
    const prev = slots.get(key);
    if (prev && prev.timer) clearTimeout(prev.timer);
    slots.set(key, {
      key,
      message: '⚠ 记忆整理失败',
      type: 'error',
      pending: true,
      timer: null,
      isRetryBar: true,
      retryFn
    });
    renderStack();
  }

  return { showMemoryStatus, showMemoryRetryBar, clearMemoryStatus };
}
