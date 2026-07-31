// Electron 不支持 window.prompt()，用轻量弹窗替代

/**
 * @param {{
 *   title?: string,
 *   message?: string,
 *   defaultValue?: string,
 *   placeholder?: string,
 *   confirmText?: string,
 *   cancelText?: string,
 *   inputType?: 'text' | 'password',
 *   autocomplete?: string
 * }} opts
 * @returns {Promise<string|null>} 确认返回字符串，取消返回 null
 */
export function promptText(opts = {}) {
  const {
    title = '请输入',
    message = '',
    defaultValue = '',
    placeholder = '',
    confirmText = '确定',
    cancelText = '取消',
    inputType = 'text',
    autocomplete = 'off'
  } = opts;

  return new Promise((resolve) => {
    const existing = document.getElementById('app-prompt-overlay');
    if (existing) existing.remove();

    const type = inputType === 'password' ? 'password' : 'text';
    const overlay = document.createElement('div');
    overlay.id = 'app-prompt-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '2000';
    overlay.innerHTML = `
      <div class="modal" style="width: min(420px, 92vw);">
        <div class="modal-header">
          <h2 style="font-size: 1.05rem; margin: 0;">${escapeHtml(title)}</h2>
          <button type="button" class="btn btn-ghost btn-icon" id="app-prompt-close">✕</button>
        </div>
        <div class="modal-body" style="padding-top: 12px;">
          ${message ? `<div class="form-hint" style="margin-bottom: 10px; white-space: pre-wrap;">${escapeHtml(message)}</div>` : ''}
          <input class="form-input" id="app-prompt-input" type="${type}" value="${escapeAttr(defaultValue)}" placeholder="${escapeAttr(placeholder)}" autocomplete="${escapeAttr(autocomplete)}">
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" id="app-prompt-cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn btn-primary" id="app-prompt-ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = overlay.querySelector('#app-prompt-input');
    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };

    overlay.querySelector('#app-prompt-ok').addEventListener('click', () => finish(input.value));
    overlay.querySelector('#app-prompt-cancel').addEventListener('click', () => finish(null));
    overlay.querySelector('#app-prompt-close').addEventListener('click', () => finish(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });

    setTimeout(() => {
      input.focus();
      if (type !== 'password') input.select();
    }, 0);
  });
}

/**
 * 备份加密口令：创建时输两次，解密时输一次。取消返回 null。
 * @param {'create'|'unlock'} mode
 */
export async function promptBackupPassword(mode = 'create') {
  // 备份口令用明文输入（不用 password 星号），避免自己也看不清敲了什么
  if (mode === 'unlock') {
    const p = await promptText({
      title: '输入备份口令',
      message: '该备份已整包加密。请输入创建备份时设置的口令（明文显示，便于核对）。',
      placeholder: '备份口令',
      inputType: 'text',
      autocomplete: 'off',
      confirmText: '解密'
    });
    if (p === null) return null;
    if (!String(p).length) {
      alert('口令不能为空');
      return null;
    }
    return String(p);
  }

  const p1 = await promptText({
    title: '设置备份口令',
    message: '整包加密：角色、聊天、API Key 等都会加密。\n请牢记口令——丢失将无法恢复备份。\n口令不会保存在本机。\n（明文显示，请确认周围无人偷看）',
    placeholder: '至少 4 位',
    inputType: 'text',
    autocomplete: 'off',
    confirmText: '下一步'
  });
  if (p1 === null) return null;
  if (String(p1).length < 4) {
    alert('口令至少 4 位');
    return null;
  }
  const p2 = await promptText({
    title: '确认备份口令',
    message: '请再输入一次相同口令（明文显示）。',
    placeholder: '再次输入',
    inputType: 'text',
    autocomplete: 'off',
    confirmText: '开始加密'
  });
  if (p2 === null) return null;
  if (p1 !== p2) {
    alert('两次口令不一致');
    return null;
  }
  return String(p1);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
