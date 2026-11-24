// 设置模块入口：app.js 继续从 pages/settings.js 导入
export { renderApiSettingsModal } from './settings/api-settings.js';
export { renderUiSettingsModal } from './settings/ui-settings.js';
export { renderOtherSettingsModal } from './settings/other-settings.js';
export { renderImageSettingsModal } from './settings/image-settings.js';
export { applyFontSize, applyTheme, normalizeTheme, THEMES } from './settings/settings-shared.js';
