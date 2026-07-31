const fs = require('fs');
const path = require('path');

const otherPath = path.join(__dirname, '../src/pages/settings/other-settings.js');
const imagePath = path.join(__dirname, '../src/pages/settings/image-settings.js');
const full = fs.readFileSync(otherPath, 'utf8').replace(/\r\n/g, '\n');

const imgHtmlStart = full.indexOf('id="setting-image-enabled"');
if (imgHtmlStart < 0) throw new Error('image-enabled not found');
// back up to form-group
let hs = full.lastIndexOf('<div class="form-group">', imgHtmlStart);
const he = full.indexOf('<div class="form-section-title">生成行为</div>');
if (he < 0) throw new Error('生成行为 not found');
// include from form-group; end before the form-section that contains 生成行为
let formSectionGen = full.lastIndexOf('<div class="form-section">', he);
const imageHtmlInner = full.slice(hs, formSectionGen);

const jsStart = full.indexOf('// 插图功能开关');
const jsEnd = full.indexOf('function closeModal() {');
if (jsStart < 0 || jsEnd < 0) throw new Error('js markers');
// include leading spaces: find line start
const jsS = full.lastIndexOf('\n', jsStart) + 1;
let imageJsBody = full.slice(jsS, jsEnd);
// drop auto-advance block that lived between image handlers
imageJsBody = imageJsBody.replace(
  /\n  \/\/ 空发送推演指令[^\n]*\n  const autoAdvanceEl[\s\S]*?btn-auto-advance-reset[\s\S]*?\n  \}\);\n/,
  '\n'
);

const imageFile = `import { getConfig, saveConfig } from '../../services/storage.js';
import {
  generateSeedreamImage,
  generateGeminiImage,
  generateGrokImage,
  DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT,
  DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT,
  DEFAULT_GROK_OUTFIT_LIBRARY,
  DEFAULT_STRICT_OUTFIT_LIBRARY,
  resolveStrictOutfitLibrary,
  resolveGrokOutfitLibrary,
  outfitLibraryToText,
  parseOutfitLibraryText
} from '../../services/image-gen.js';
import { sendChat } from '../../services/api.js';
import { openBigTextEditor } from '../../utils/big-editor.js';
import { openImageLightbox } from '../../utils/image-lightbox.js';
import { escapeHtml } from './settings-shared.js';

export async function renderImageSettingsModal() {
  const existing = document.getElementById('image-settings-modal');
  if (existing) existing.remove();

  const config = await getConfig();
  const ui = config.ui || {};
  const image = config.image || {};
  const sd = image.seedream || {};
  const gm = image.gemini || {};
  const gk = image.grok || {};

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'image-settings-modal';

  overlay.innerHTML = \`
    <div class="modal">
      <div class="modal-header">
        <h2>插图设置</h2>
        <button class="btn btn-ghost btn-icon" id="btn-close-image-settings">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-section">
          <div class="form-section-title">插图与生图</div>
${imageHtmlInner}        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="btn-cancel-image-settings">取消</button>
        <button class="btn btn-primary" id="btn-save-image-settings">保存</button>
      </div>
    </div>
  \`;

  document.body.appendChild(overlay);

${imageJsBody}
  function closeModal() {
    overlay.remove();
  }

  document.getElementById('btn-close-image-settings').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-image-settings').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.getElementById('btn-save-image-settings').addEventListener('click', async () => {
    const latestConfig = await getConfig();
    composeState[composeMode] = composePromptEl.value;
    const parsedOutfitLib = parseOutfitLibraryText(strictOutfitLibEl.value);
    const defaultOutfitText = outfitLibraryToText(DEFAULT_STRICT_OUTFIT_LIBRARY);
    const outfitLibraryToSave = (parsedOutfitLib.length === 0 || outfitLibraryToText(parsedOutfitLib) === defaultOutfitText)
      ? []
      : parsedOutfitLib;
    const parsedGrokOutfitLib = parseOutfitLibraryText(grokOutfitLibEl.value);
    const defaultGrokOutfitText = outfitLibraryToText(DEFAULT_GROK_OUTFIT_LIBRARY);
    const grokOutfitLibraryToSave = (parsedGrokOutfitLib.length === 0 || outfitLibraryToText(parsedGrokOutfitLib) === defaultGrokOutfitText)
      ? []
      : parsedGrokOutfitLib;

    latestConfig.ui = {
      ...(latestConfig.ui || {}),
      imageEnabled: document.getElementById('setting-image-enabled').checked,
      imageDisplay: document.getElementById('setting-image-display').value
    };
    latestConfig.image = {
      provider: document.getElementById('setting-image-provider').value,
      personMode: grokPersonModeEl.value,
      seedream: {
        baseUrl: document.getElementById('setting-seedream-base-url').value.trim(),
        apiKey: document.getElementById('setting-seedream-api-key').value.trim(),
        model: document.getElementById('setting-seedream-model').value.trim(),
        size: document.getElementById('setting-seedream-size').value,
        outfitLibrary: outfitLibraryToSave
      },
      gemini: {
        baseUrl: document.getElementById('setting-gemini-base-url').value.trim(),
        apiKey: document.getElementById('setting-gemini-api-key').value.trim(),
        model: document.getElementById('setting-gemini-model').value.trim(),
        aspectRatio: document.getElementById('setting-gemini-aspect-ratio').value,
        imageSize: document.getElementById('setting-gemini-image-size').value,
        apiMode: document.getElementById('setting-gemini-api-mode').value
      },
      grok: {
        baseUrl: document.getElementById('setting-grok-base-url').value.trim(),
        apiKey: document.getElementById('setting-grok-api-key').value.trim(),
        model: document.getElementById('setting-grok-model').value.trim(),
        aspectRatio: document.getElementById('setting-grok-aspect-ratio').value,
        resolution: document.getElementById('setting-grok-resolution').value,
        composePrompt: (composeState.grokSolo.trim() === DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT.trim()) ? '' : composeState.grokSolo.trim(),
        composePromptDuo: (composeState.grokDuo.trim() === DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT.trim()) ? '' : composeState.grokDuo.trim(),
        outfitLibrary: grokOutfitLibraryToSave
      }
    };
    await saveConfig(latestConfig);
    closeModal();
  });
}
`;

fs.writeFileSync(imagePath, imageFile);
console.log('image-settings.js written', fs.statSync(imagePath).size);

// Build slim other-settings
let other = full;
// imports: remove image-gen, sendChat, big-editor, lightbox if only for image
other = other.replace(
  /import \{[\s\S]*?\} from '\.\.\/\.\.\/services\/image-gen\.js';\n/,
  ''
);
other = other.replace(/import \{ sendChat \} from '\.\.\/\.\.\/services\/api\.js';\n/, '');
other = other.replace(/import \{ openBigTextEditor \} from '\.\.\/\.\.\/utils\/big-editor\.js';\n/, '');
other = other.replace(/import \{ openImageLightbox \} from '\.\.\/\.\.\/utils\/image-lightbox\.js';\n/, '');
other = other.replace(
  /  const image = config\.image \|\| \{\};\n  const sd = image\.seedream \|\| \{\};\n  const gm = image\.gemini \|\| \{\};\n  const gk = image\.grok \|\| \{\};\n/,
  ''
);
// remove image html
other = other.replace(imageHtmlInner, '          <!-- 插图设置已移至侧边栏「插图设置」 -->\n');
// remove image js, keep auto advance
other = other.replace(
  full.slice(jsS, jsEnd),
  `  // 空发送推演指令
  const autoAdvanceEl = document.getElementById('setting-auto-advance-prompt');
  autoAdvanceEl.value = behavior.autoAdvancePrompt || DEFAULT_AUTO_ADVANCE_PROMPT;
  document.getElementById('btn-auto-advance-reset').addEventListener('click', () => {
    autoAdvanceEl.value = DEFAULT_AUTO_ADVANCE_PROMPT;
  });

`
);

// strip image save from save handler
const outfitMark = '    composeState[composeMode] = composePromptEl.value;';
const outfitMark2 = '    const parsedOutfitLib = parseOutfitLibraryText';
let cutA = other.indexOf(outfitMark2);
if (cutA < 0) cutA = other.indexOf(outfitMark);
const webdavMark = '    // WebDAV（坚果云）';
const webdavAt = other.indexOf(webdavMark);
if (cutA > 0 && webdavAt > cutA) {
  other = other.slice(0, cutA) + other.slice(webdavAt);
}

// remove latestConfig.image = {...}
const imgAssign = other.indexOf('    latestConfig.image = {');
if (imgAssign >= 0) {
  // find closing of this object assign: "    };" after image that precedes webdav or 即时
  let depth = 0;
  let i = imgAssign + '    latestConfig.image = '.length;
  let end = -1;
  for (; i < other.length; i++) {
    if (other[i] === '{') depth++;
    else if (other[i] === '}') {
      depth--;
      if (depth === 0) {
        // skip to after };
        end = other.indexOf('\n', i) + 1;
        break;
      }
    }
  }
  if (end > 0) other = other.slice(0, imgAssign) + other.slice(end);
}

// ui only fontSize (preserve other ui fields including imageEnabled)
other = other.replace(
  /latestConfig\.ui = \{\n      \.\.\.\(latestConfig\.ui \|\| \{\}\),\n      fontSize,\n      imageEnabled:[\s\S]*?imageDisplay:[\s\S]*?\n    \};/,
  `latestConfig.ui = {
      ...(latestConfig.ui || {}),
      fontSize
    };`
);
// if still has imageEnabled in ui assign
other = other.replace(
  /fontSize,\n      imageEnabled: document\.getElementById\('setting-image-enabled'\)\.checked,\n      imageDisplay: document\.getElementById\('setting-image-display'\)\.value\n/,
  'fontSize\n'
);

// 界面设置下增加跳转说明
if (!other.includes('已移至侧边栏「插图设置」')) {
  other = other.replace(
    '<div class="form-section-title">界面设置</div>',
    '<div class="form-section-title">界面设置</div>\n          <div class="form-hint" style="margin-bottom: 12px;">插图 / 生图相关选项已移至侧边栏「插图设置」。</div>'
  );
}

fs.writeFileSync(otherPath, other);
console.log('other-settings.js updated', fs.statSync(otherPath).size);

// sanity
const img = fs.readFileSync(imagePath, 'utf8');
const oth = fs.readFileSync(otherPath, 'utf8');
console.log('image has renderImageSettingsModal', img.includes('renderImageSettingsModal'));
console.log('image has setting-image-enabled', img.includes('setting-image-enabled'));
console.log('other has setting-image-enabled', oth.includes('setting-image-enabled'));
console.log('other has webdav', oth.includes('webdav'));
console.log('other has auto-advance', oth.includes('auto-advance'));
console.log('other has parseOutfit', oth.includes('parseOutfitLibraryText'));
console.log('other braces', (oth.match(/\{/g)||[]).length, (oth.match(/\}/g)||[]).length);
console.log('image braces', (img.match(/\{/g)||[]).length, (img.match(/\}/g)||[]).length);
