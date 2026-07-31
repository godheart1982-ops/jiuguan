/**
 * chat.js Phase 1：抽出底部模块到 src/pages/chat/*
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const chatPath = path.join(root, 'src/pages/chat.js');
const outDir = path.join(root, 'src/pages/chat');
fs.mkdirSync(outDir, { recursive: true });

const src = fs.readFileSync(chatPath, 'utf8');
if (src.includes("./chat/chat-utils.js")) {
  console.log('Already split; abort');
  process.exit(0);
}

const lines = src.split(/\r?\n/);
const idx = (prefix) => {
  const i = lines.findIndex((l) => l.startsWith(prefix));
  if (i < 0) throw new Error('not found: ' + prefix);
  return i;
};

const createIdx = idx('async function createNewChat');
const splitIdx = idx('function splitThinking');
const extractThinkIdx = idx('function extractThinkingForDisplay');
const appendIdx = idx('function appendMessage');
const openEdIdx = idx('function openMessageEditor');
const ctxIdx = idx('function showContextMenu');
const scrollIdx = idx('function scrollToBottom');
const emptyIdx = idx('function renderEmptyChat');
const avIdx = idx('function defaultAvatarUrl');
const escIdx = idx('function escapeHtml');
const normIdx = idx('function normalizePollinationsUrls');
// comment lines before generatedImageCache
const cacheIdx = lines.findIndex((l) => l.startsWith('const generatedImageCache'));
const encIdx = idx('function encodePromptParam');
const markersIdx = idx('function extractSeedreamMarkers');
const transformIdx = idx('function transformSeedreamImages');
const hydrateIdx = idx('async function hydrateGeneratedImages');
const displayModeIdx = lines.findIndex((l) => l.startsWith('let imageDisplayMode'));
const shotHtmlIdx = idx('function shotAngleSelectsHtml');
const applyDispIdx = idx('function applyImageDisplayMode');
const mdIdx = idx('function renderMarkdown');

function slice(a, b) {
  return lines.slice(a, b).join('\n');
}
function exportify(code, from, to) {
  return code.replace(new RegExp('^' + from), to);
}

// --- chat-utils.js ---
let utils = [
  "import { navigate } from '../../app.js';",
  '',
  exportify(slice(escIdx, normIdx), 'function escapeHtml', 'export function escapeHtml').trimEnd(),
  '',
  exportify(slice(avIdx, escIdx), 'function defaultAvatarUrl', 'export function defaultAvatarUrl').trimEnd(),
  '',
  exportify(slice(scrollIdx, emptyIdx), 'function scrollToBottom', 'export function scrollToBottom').trimEnd(),
  '',
  exportify(slice(emptyIdx, avIdx), 'function renderEmptyChat', 'export function renderEmptyChat').trimEnd(),
  '',
  exportify(slice(splitIdx, extractThinkIdx), 'function splitThinking', 'export function splitThinking').trimEnd(),
  '',
  exportify(slice(extractThinkIdx, appendIdx), 'function extractThinkingForDisplay', 'export function extractThinkingForDisplay').trimEnd(),
  ''
].join('\n');
fs.writeFileSync(path.join(outDir, 'chat-utils.js'), utils + '\n');

// --- chat-image.js ---
// Build image module carefully with imageUi object instead of free lets
const extractSeedsNested = (() => {
  // from nested function in renderChat - find it
  const start = lines.findIndex((l) => l.includes('function extractImageSeeds(content)'));
  if (start < 0) return null;
  // find closing of function - lines starting with "  }" then blank then "  // 短期"
  let end = start + 1;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    if (i > start && depth === 0) {
      end = i + 1;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/^  function extractImageSeeds/, 'export function extractImageSeeds');
})();

let imageJs = `// 插图状态、seedream 标记、本地图缓存
import { getGeneratedImageDataUrl } from '../../services/storage.js';
import { escapeHtml } from './chat-utils.js';

export const imageUi = {
  displayMode: 'auto',
  providerMode: 'pollinations',
  shotSel: 'auto',
  orientSel: 'auto',
  elevSel: 'auto',
  aspectSel: 'landscape',
  cameraEnabled: true
};

export function applyImageUiFromConfig(appConfig) {
  imageUi.displayMode = (appConfig.ui && appConfig.ui.imageDisplay) || 'auto';
  imageUi.providerMode = (appConfig.image && appConfig.image.provider) || 'pollinations';
  imageUi.shotSel = (appConfig.ui && appConfig.ui.imageShot) || 'auto';
  imageUi.orientSel = (appConfig.ui && appConfig.ui.imageOrient) || 'auto';
  imageUi.elevSel = (appConfig.ui && appConfig.ui.imageElev) || 'auto';
  imageUi.aspectSel = (appConfig.ui && appConfig.ui.imageAspect) || 'landscape';
  imageUi.cameraEnabled = !appConfig.ui || appConfig.ui.imageCameraEnabled !== false;
}

export const generatedImageCache = new Map();

`;

// normalize, encode, extract markers - as exports
imageJs += exportify(slice(normIdx, cacheIdx), 'function normalizePollinationsUrls', 'export function normalizePollinationsUrls').trimEnd() + '\n\n';
imageJs += exportify(slice(encIdx, markersIdx), 'function encodePromptParam', 'export function encodePromptParam').trimEnd() + '\n\n';
imageJs += exportify(slice(markersIdx, transformIdx), 'function extractSeedreamMarkers', 'export function extractSeedreamMarkers').trimEnd() + '\n\n';

// transformSeedreamImages - replace free vars with imageUi
let transformBody = exportify(slice(transformIdx, hydrateIdx), 'function transformSeedreamImages', 'export function transformSeedreamImages');
transformBody = transformBody
  .replace(/imageProviderMode/g, 'imageUi.providerMode')
  .replace(/imageCameraEnabled/g, 'imageUi.cameraEnabled')
  .replace(/imageShotSel/g, 'imageUi.shotSel')
  .replace(/imageOrientSel/g, 'imageUi.orientSel')
  .replace(/imageElevSel/g, 'imageUi.elevSel')
  .replace(/imageAspectSel/g, 'imageUi.aspectSel');
imageJs += transformBody.trimEnd() + '\n\n';

let hydrateBody = exportify(slice(hydrateIdx, displayModeIdx), 'async function hydrateGeneratedImages', 'export async function hydrateGeneratedImages');
imageJs += hydrateBody.trimEnd() + '\n\n';

let shotBody = exportify(slice(shotHtmlIdx, applyDispIdx), 'function shotAngleSelectsHtml', 'export function shotAngleSelectsHtml');
shotBody = shotBody
  .replace(/imageCameraEnabled/g, 'imageUi.cameraEnabled')
  .replace(/imageShotSel/g, 'imageUi.shotSel')
  .replace(/imageOrientSel/g, 'imageUi.orientSel')
  .replace(/imageElevSel/g, 'imageUi.elevSel')
  .replace(/imageAspectSel/g, 'imageUi.aspectSel');
imageJs += shotBody.trimEnd() + '\n\n';

let applyBody = exportify(slice(applyDispIdx, mdIdx), 'function applyImageDisplayMode', 'export function applyImageDisplayMode');
applyBody = applyBody.replace(/imageDisplayMode/g, 'imageUi.displayMode');
imageJs += applyBody.trimEnd() + '\n\n';

if (extractSeedsNested) {
  imageJs += extractSeedsNested.replace(/^export function/, 'export function').trimEnd() + '\n';
} else {
  imageJs += `export function extractImageSeeds(content) {
  const found = [];
  if (!content) return found;
  const re = /!\\[([^\\]]+)\\]\\((https:\\/\\/image\\.pollinations\\.ai\\/[^)\\s]*?[?&]seed=(\\d+)[^)\\s]*)\\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1].trim();
    const seed = parseInt(m[3], 10);
    if (name && Number.isFinite(seed)) found.push({ name, seed });
  }
  return found;
}
`;
}

fs.writeFileSync(path.join(outDir, 'chat-image.js'), imageJs + '\n');

// --- chat-markdown.js ---
const mdJs = `// Markdown 渲染（含插图后处理）
import { marked as markedImport } from 'marked';
import { escapeHtml } from './chat-utils.js';
import { normalizePollinationsUrls, transformSeedreamImages, applyImageDisplayMode } from './chat-image.js';

const marked = markedImport || (typeof window !== 'undefined' ? window.marked : null);
if (marked && marked.setOptions) {
  marked.setOptions({ breaks: true, gfm: true });
}

export function renderMarkdown(text) {
  if (!text) return '';
  try {
    text = normalizePollinationsUrls(text);
    const html = marked.parse(text, { breaks: true, gfm: true }).replace(/>\\n\\s*</g, '><');
    return transformSeedreamImages(applyImageDisplayMode(html));
  } catch (e) {
    console.warn('Markdown render failed:', e);
    return escapeHtml(text);
  }
}
`;
fs.writeFileSync(path.join(outDir, 'chat-markdown.js'), mdJs);

// --- chat-message-ui.js ---
let msgUi = `// 消息 DOM：气泡、右键菜单、编辑、新建会话
import { saveChat, createUUID } from '../../services/storage.js';
import { countTokens } from '../../utils/tokenizer.js';
import { escapeHtml, extractThinkingForDisplay } from './chat-utils.js';
import { renderMarkdown } from './chat-markdown.js';

`;
msgUi += exportify(slice(createIdx, splitIdx), 'async function createNewChat', 'export async function createNewChat').trimEnd() + '\n\n';
msgUi += exportify(slice(appendIdx, openEdIdx), 'function appendMessage', 'export function appendMessage').trimEnd() + '\n\n';
msgUi += exportify(slice(openEdIdx, ctxIdx), 'function openMessageEditor', 'export function openMessageEditor').trimEnd() + '\n\n';
msgUi += exportify(slice(ctxIdx, scrollIdx), 'function showContextMenu', 'export function showContextMenu').trimEnd() + '\n';
fs.writeFileSync(path.join(outDir, 'chat-message-ui.js'), msgUi);

// --- Patch main chat.js body ---
let body = lines.slice(0, createIdx).join('\n');

// Remove marked import + setup
body = body.replace(
  /import \{ marked as markedImport \} from 'marked';\r?\nconst marked = markedImport \|\| \(typeof window !== 'undefined' \? window\.marked : null\);\r?\n/,
  ''
);
body = body.replace(
  /\/\/ 配置 marked：把单个换行也当作换行\r?\nmarked\.setOptions\(\{\r?\n  breaks: true,\r?\n  gfm: true\r?\n\}\);\r?\n\r?\n/,
  ''
);

// Remove getGeneratedImageDataUrl from storage import if present (hydrate moved)
body = body.replace(', getGeneratedImageDataUrl', '');

// Inject new imports after search-api line
const inject = `import {
  escapeHtml, defaultAvatarUrl, scrollToBottom, renderEmptyChat
} from './chat/chat-utils.js';
import {
  imageUi, generatedImageCache, applyImageUiFromConfig,
  normalizePollinationsUrls, encodePromptParam, extractSeedreamMarkers, extractImageSeeds,
  hydrateGeneratedImages
} from './chat/chat-image.js';
import { renderMarkdown } from './chat/chat-markdown.js';
import { createNewChat, appendMessage, openMessageEditor } from './chat/chat-message-ui.js';
`;
body = body.replace(
  /(import \{ isSearchReady, runWebSearch, formatSearchReferenceBrief, buildSearchQueryFromInput \} from '\.\.\/services\/search-api\.js';\n)/,
  `$1${inject}\n`
);

// Image init block
body = body.replace(
  /  \/\/ 插图显示档位（其他设置）：auto=自动加载 \/ click=点击加载 \/ hide=完全隐藏\n  const appConfig = await getConfig\(\)\.catch\(\(\) => \(\{\}\)\);\n  imageDisplayMode = \(appConfig\.ui && appConfig\.ui\.imageDisplay\) \|\| 'auto';\n  \/\/ 当前生图服务商（生成按钮文案跟随：手动模式是"生成提示词"，API 模式是"生成插图"\)\n  imageProviderMode = \(appConfig\.image && appConfig\.image\.provider\) \|\| 'pollinations';\n  \/\/ 镜头覆盖选择（景别\/朝向\/高度\/画幅；旧版 imageAngle 废弃）\n  imageShotSel = \(appConfig\.ui && appConfig\.ui\.imageShot\) \|\| 'auto';\n  imageOrientSel = \(appConfig\.ui && appConfig\.ui\.imageOrient\) \|\| 'auto';\n  imageElevSel = \(appConfig\.ui && appConfig\.ui\.imageElev\) \|\| 'auto';\n  imageAspectSel = \(appConfig\.ui && appConfig\.ui\.imageAspect\) \|\| 'landscape';\n  \/\/ 镜头控制总开关：缺省开（保持旧行为），关=一个词都不拼\n  imageCameraEnabled = !appConfig\.ui \|\| appConfig\.ui\.imageCameraEnabled !== false;\n/,
  `  const appConfig = await getConfig().catch(() => ({}));
  applyImageUiFromConfig(appConfig);
`
);

// Identifier replacements (order: longer first)
const reps = [
  ['imageCameraEnabled', 'imageUi.cameraEnabled'],
  ['imageProviderMode', 'imageUi.providerMode'],
  ['imageDisplayMode', 'imageUi.displayMode'],
  ['imageShotSel', 'imageUi.shotSel'],
  ['imageOrientSel', 'imageUi.orientSel'],
  ['imageElevSel', 'imageUi.elevSel'],
  ['imageAspectSel', 'imageUi.aspectSel']
];
for (const [a, b] of reps) {
  body = body.split(a).join(b);
}

// Remove nested extractImageSeeds
body = body.replace(
  /\n  \/\/ 从回复文本中提取插图种子：[^\n]*\n  function extractImageSeeds\(content\) \{[\s\S]*?\n  \}\n/,
  '\n'
);

if (!body.endsWith('\n')) body += '\n';
fs.writeFileSync(chatPath, body);

console.log('chat.js lines:', body.split('\n').length);
console.log('written:', fs.readdirSync(outDir));
// quick checks
for (const f of ['chat-utils.js', 'chat-image.js', 'chat-markdown.js', 'chat-message-ui.js']) {
  const t = fs.readFileSync(path.join(outDir, f), 'utf8');
  const o = (t.match(/\{/g) || []).length;
  const c = (t.match(/\}/g) || []).length;
  console.log(f, 'braces', o, c, o === c ? 'OK' : 'MISMATCH');
}
const t = body;
console.log('chat.js braces', (t.match(/\{/g) || []).length, (t.match(/\}/g) || []).length);
console.log('has applyImageUi', body.includes('applyImageUiFromConfig'));
console.log('has old imageShotSel free', /(?<!imageUi\.)imageShotSel/.test(body));
console.log('has createNewChat def', body.includes('async function createNewChat'));
console.log('has extractImageSeeds nested', body.includes('function extractImageSeeds'));
