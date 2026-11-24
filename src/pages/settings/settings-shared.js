// 设置页共享工具（API / 其他设置共用）

export const THEMES = [
  {
    id: 'system',
    name: '跟随系统',
    desc: '浅色羊皮纸 · 深色暗夜酒馆',
    swatches: ['#f4efe6', '#141210', '#d97706', '#b45309']
  },
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
let currentThemePref = 'tavern';
let systemSchemeMql = null;
let visibilityBound = false;

export function normalizeTheme(theme) {
  return VALID_THEME_IDS.has(theme) ? theme : 'tavern';
}

export function resolveEffectiveTheme(theme, isSystemLight = false) {
  const normalized = normalizeTheme(theme);
  if (normalized === 'system') {
    return isSystemLight ? 'parchment' : 'tavern';
  }
  return normalized;
}

function syncSystemThemeIfNeeded() {
  if (currentThemePref !== 'system') return;
  const isLight = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)').matches
    : false;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.theme = resolveEffectiveTheme('system', isLight);
  }
}

function getSystemLightQuery() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (!systemSchemeMql) {
    systemSchemeMql = window.matchMedia('(prefers-color-scheme: light)');
    if (typeof systemSchemeMql.addEventListener === 'function') {
      systemSchemeMql.addEventListener('change', syncSystemThemeIfNeeded);
    } else if (typeof systemSchemeMql.addListener === 'function') {
      systemSchemeMql.addListener(syncSystemThemeIfNeeded);
    }
  }
  if (!visibilityBound && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    visibilityBound = true;
    // 部分 Android WebView 后台切系统深浅色时可能漏派发 matchMedia change，回到前台时补同步一次
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncSystemThemeIfNeeded();
    });
  }
  return systemSchemeMql;
}

export function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  currentThemePref = normalized;
  const mql = getSystemLightQuery();
  const effective = resolveEffectiveTheme(normalized, Boolean(mql && mql.matches));
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.theme = effective;
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
