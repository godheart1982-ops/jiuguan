// 设置页共享工具（API / 其他设置共用）

export const THEMES = [
  {
    id: 'tavern',
    name: '暗夜酒馆',
    desc: '暖琥珀光晕 · 衬线沉浸',
    swatches: ['#141210', '#1d1915', '#d97706', '#f3ede4']
  },
  {
    id: 'charcoal',
    name: '极简深炭',
    desc: '冷灰高对比 · 现代克制',
    swatches: ['#0f1115', '#171b22', '#5b8def', '#eef1f6']
  },
  {
    id: 'parchment',
    name: '羊皮纸浅色',
    desc: '温润书卷 · 日间护眼',
    swatches: ['#f4efe6', '#fbf8f2', '#b45309', '#2b241d']
  }
];

const VALID_THEME_IDS = new Set(THEMES.map((t) => t.id));

export function normalizeTheme(theme) {
  return VALID_THEME_IDS.has(theme) ? theme : 'tavern';
}

export function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.theme = normalized;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('jiuguan_theme', normalized);
    }
  } catch {
    // 忽略隐私模式或无 localStorage 环境
  }
  return normalized;
}

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
