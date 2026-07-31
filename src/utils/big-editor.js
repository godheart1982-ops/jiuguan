/**
 * 大文本编辑弹窗工具
 */

import { attachCharCounter } from './counter.js';

/**
 * 打开大文本编辑弹窗
 * @param {Object} options
 * @param {string} options.title 弹窗标题
 * @param {string} options.value 初始文本
 * @param {string} options.placeholder 占位提示
 * @param {Function} options.onSave 保存回调，参数为新的文本；keepOpenOnSave 时第二参数为 closeEditor
 * @param {boolean} options.readonly 是否只读（仅展示/复制，不保存）
 * @param {string} options.saveText 保存按钮文案（默认"保存"）
 * @param {Array<{label: string, onClick: Function}>} options.extraButtons 底部额外按钮（onClick 收到当前文本，点击不关闭弹窗）
 * @param {boolean} options.keepOpenOnSave 保存后不自动关闭（由 onSave 自行决定何时 closeEditor）
 */
export function openBigTextEditor({ title, value, placeholder, onSave, readonly, saveText, extraButtons, keepOpenOnSave }) {
  // 移除已存在的编辑器
  const existing = document.querySelector('.big-text-editor-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay big-text-editor-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width: 800px; max-width: 92vw; height: 80vh; max-height: 700px;">
      <div class="modal-header">
        <h2>${escapeHtml(title)}</h2>
        <button class="btn btn-ghost btn-icon" id="btn-close-big-editor">✕</button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; flex: 1; min-height: 0;">
        <textarea class="form-textarea" id="big-editor-text" placeholder="${escapeHtml(placeholder || '')}" style="flex: 1; min-height: 0; font-family: monospace;" ${readonly ? 'readonly' : ''}>${escapeHtml(value || '')}</textarea>
      </div>
      <div class="modal-footer">
        ${(extraButtons || []).map((b, i) => `<button class="btn btn-ghost" data-extra-btn="${i}">${escapeHtml(b.label)}</button>`).join('')}
        <button class="btn btn-ghost" id="btn-cancel-big-editor">${readonly ? '关闭' : '取消'}</button>
        ${readonly ? '' : `<button class="btn btn-primary" id="btn-save-big-editor">${escapeHtml(saveText || '保存')}</button>`}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const textarea = document.getElementById('big-editor-text');
  if (!readonly) attachCharCounter(textarea);

  textarea.focus();
  if (!readonly) textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  function closeEditor() {
    overlay.remove();
  }

  document.getElementById('btn-close-big-editor').addEventListener('click', closeEditor);
  document.getElementById('btn-cancel-big-editor').addEventListener('click', closeEditor);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEditor();
  });

  (extraButtons || []).forEach((b, i) => {
    overlay.querySelector(`[data-extra-btn="${i}"]`).addEventListener('click', () => b.onClick(textarea.value));
  });

  if (!readonly) {
    document.getElementById('btn-save-big-editor').addEventListener('click', () => {
      if (keepOpenOnSave) {
        onSave(textarea.value, closeEditor);
        return;
      }
      onSave(textarea.value);
      closeEditor();
    });
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
