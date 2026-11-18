// 聊天页记忆状态条（提示 / 失败重试）

/**
 * @param {HTMLElement} memoryStatusEl
 */
export function createMemoryStatus(memoryStatusEl) {
  function showMemoryStatus(message, type = 'info') {
    memoryStatusEl.textContent = message;
    memoryStatusEl.className = `memory-status ${type}`;
    memoryStatusEl.classList.remove('hidden');
    setTimeout(() => {
      if (memoryStatusEl.textContent === message) {
        memoryStatusEl.classList.add('hidden');
      }
    }, 5000);
  }

  function showMemoryRetryBar(retryFn) {
    memoryStatusEl.innerHTML = `
      <span>⚠ 记忆整理失败</span>
      <button class="btn btn-ghost btn-small" id="btn-memory-retry" style="margin-left:8px; padding:2px 8px;">🔄 重试整理</button>
      <button class="btn btn-ghost btn-small" id="btn-memory-skip" style="margin-left:4px; padding:2px 8px;">跳过</button>
    `;
    memoryStatusEl.className = 'memory-status error';
    memoryStatusEl.classList.remove('hidden');

    document.getElementById('btn-memory-skip').addEventListener('click', () => {
      memoryStatusEl.classList.add('hidden');
    });

    document.getElementById('btn-memory-retry').addEventListener('click', async () => {
      const retryBtn = document.getElementById('btn-memory-retry');
      if (retryBtn) { retryBtn.textContent = '总结中...'; retryBtn.disabled = true; }
      try {
        await retryFn();
        memoryStatusEl.classList.add('hidden');
      } catch (e) {
        console.warn('手动总结仍失败:', e);
        showMemoryRetryBar(retryFn);
      }
    });
  }

  return { showMemoryStatus, showMemoryRetryBar };
}
