/**
 * One-shot: split src/pages/settings.js into settings/* modules.
 * Safe to re-run only if settings.js is still the monolithic file.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const settingsPath = path.join(root, 'src/pages/settings.js');
const outDir = path.join(root, 'src/pages/settings');

const text = fs.readFileSync(settingsPath, 'utf8');
const lines = text.split(/\r?\n/);

// Already split?
if (lines.some((l) => l.includes("from './settings/api-settings.js'"))) {
  console.log('settings.js already re-exports; abort');
  process.exit(0);
}

const apiStart = lines.findIndex((l) => l.startsWith('export async function renderApiSettingsModal'));
const otherStart = lines.findIndex((l) => l.startsWith('export async function renderOtherSettingsModal'));
const profileStart = lines.findIndex((l) => l.startsWith('function renderProfileOptions'));

if (apiStart < 0 || otherStart < 0 || profileStart < 0) {
  console.error('Could not find split markers', { apiStart, otherStart, profileStart });
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const sharedBody = lines
  .slice(profileStart)
  .join('\n')
  .replace(/^function renderProfileOptions/, 'export function renderProfileOptions')
  .replace(/^function escapeHtml/, 'export function escapeHtml')
  .replace(/^export function applyFontSize/, 'export function applyFontSize');

fs.writeFileSync(
  path.join(outDir, 'settings-shared.js'),
  '// 设置页共享工具（API / 其他设置共用）\n' + sharedBody.replace(/\n*$/, '\n')
);

const apiImports = [
  "import { getConfig, saveConfig, saveApiProfile, getApiProfiles, deleteApiProfile } from '../../services/storage.js';",
  "import { attachCharCounter } from '../../utils/counter.js';",
  "import { normalizeSearchConfig, testSearchApi, DEFAULT_SEARCH_CONFIG } from '../../services/search-api.js';",
  "import { escapeHtml, renderProfileOptions } from './settings-shared.js';",
  '',
  ''
].join('\n');

const otherImports = [
  "import { getConfig, saveConfig, exportAllData, importAllData } from '../../services/storage.js';",
  "import { generateSeedreamImage, generateGeminiImage, generateGrokImage, DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT, DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT, DEFAULT_GROK_OUTFIT_LIBRARY, DEFAULT_STRICT_OUTFIT_LIBRARY, resolveStrictOutfitLibrary, resolveGrokOutfitLibrary, outfitLibraryToText, parseOutfitLibraryText } from '../../services/image-gen.js';",
  "import { sendChat } from '../../services/api.js';",
  "import { openBigTextEditor } from '../../utils/big-editor.js';",
  "import { openImageLightbox } from '../../utils/image-lightbox.js';",
  "import { Capacitor } from '@capacitor/core';",
  "import { refreshCharacters } from '../../app.js';",
  "import { DEFAULT_AUTO_ADVANCE_PROMPT } from '../../services/narrative-rules.js';",
  "import { escapeHtml, applyFontSize } from './settings-shared.js';",
  '',
  ''
].join('\n');

const apiBody = lines.slice(apiStart, otherStart).join('\n').replace(/\n*$/, '\n');
const otherBody = lines.slice(otherStart, profileStart).join('\n').replace(/\n*$/, '\n');

fs.writeFileSync(path.join(outDir, 'api-settings.js'), apiImports + apiBody);
fs.writeFileSync(path.join(outDir, 'other-settings.js'), otherImports + otherBody);

const barrel = [
  '// 设置模块入口：app.js 继续从 pages/settings.js 导入',
  "export { renderApiSettingsModal } from './settings/api-settings.js';",
  "export { renderOtherSettingsModal } from './settings/other-settings.js';",
  "export { applyFontSize } from './settings/settings-shared.js';",
  ''
].join('\n');

fs.writeFileSync(settingsPath, barrel);

console.log('Split OK:', {
  api: fs.statSync(path.join(outDir, 'api-settings.js')).size,
  other: fs.statSync(path.join(outDir, 'other-settings.js')).size,
  shared: fs.statSync(path.join(outDir, 'settings-shared.js')).size
});
