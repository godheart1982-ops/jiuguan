// 设置页共享工具（API / 其他设置共用）

export function renderProfileOptions(profiles, activeApi = null, selectedName = '') {
  return Object.keys(profiles).map((name) => {
    const isSelected = name === selectedName ? ' selected' : '';
    return `<option value="${escapeHtml(name)}"${isSelected}>${escapeHtml(name)}</option>`;
  }).join('');
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function applyFontSize(fontSize) {
  document.documentElement.style.fontSize = `${fontSize}px`;
}
