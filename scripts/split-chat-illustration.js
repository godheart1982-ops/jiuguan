const fs = require('fs');
const path = require('path');
const chatPath = path.join(__dirname, '../src/pages/chat.js');
let src = fs.readFileSync(chatPath, 'utf8');

if (src.includes('createIllustrationController')) {
  console.log('already wired');
  process.exit(0);
}

src = src.replace(
  "import { createNewChat, appendMessage, openMessageEditor } from './chat/chat-message-ui.js';",
  "import { createNewChat, appendMessage, openMessageEditor } from './chat/chat-message-ui.js';\nimport { createIllustrationController } from './chat/chat-illustration.js';"
);

const startMark = '  // 插图相关点击：seedream 生成/重试/改词/文件缺失补救';
const endMark = '  // 轮次跳转';
const start = src.indexOf(startMark);
const end = src.indexOf(endMark);
if (start < 0 || end < 0) {
  console.error('markers not found', start, end);
  process.exit(1);
}

const replacement = `  // 插图：事件委托 + 付费/手动生图（见 chat/chat-illustration.js）
  const illustration = createIllustrationController({
    getChat: () => currentChat,
    character,
    characterId,
    showMemoryStatus,
    renderMessages,
    getAbortController: () => abortController
  });
  const { processSeedreamMarkers, showSeedreamLoading } = illustration;
  illustration.bind(messagesContainer);

  // 手动刷新当前对话：重新从存储读取最新内容并重渲染（用于切走后回来跟上后台生成进度）
  async function refreshCurrentChat() {
    const fresh = await getChat(characterId, currentChat.id);
    if (!fresh) return;
    currentChat = fresh;
    renderMessages();
    showMemoryStatus('已刷新到最新内容', 'success');
  }

`;

src = src.slice(0, start) + replacement + src.slice(end);

// Drop unused image-gen / lightbox imports from chat.js
src = src.replace(
  /import \{ generateIllustrationForReply, generateIllustrationFromPrompt, prepareIllustrationPrompt, isPaidImageProvider, isStrictMechanicalProvider, imageProviderDisplayName, shotWordsOf \} from '\.\.\/services\/image-gen\.js';\n/,
  ''
);
src = src.replace(
  /import \{ openImageLightbox \} from '\.\.\/utils\/image-lightbox\.js';\n/,
  ''
);
// encodePromptParam / extractSeedreamMarkers only needed in illustration now
src = src.replace(
  `import {
  imageUi, generatedImageCache, applyImageUiFromConfig,
  normalizePollinationsUrls, encodePromptParam, extractSeedreamMarkers, extractImageSeeds,
  hydrateGeneratedImages
} from './chat/chat-image.js';`,
  `import {
  imageUi, applyImageUiFromConfig,
  normalizePollinationsUrls, extractImageSeeds,
  hydrateGeneratedImages
} from './chat/chat-image.js';`
);

fs.writeFileSync(chatPath, src);
console.log('ok, lines', src.split(/\n/).length);

const checks = [
  'generateIllustrationForReply',
  'openImageLightbox',
  'encodePromptParam',
  'extractSeedreamMarkers',
  'processSeedreamMarkers',
  'showSeedreamLoading',
  'createIllustrationController',
  'openBigTextEditor'
];
for (const c of checks) {
  const n = (src.match(new RegExp(c, 'g')) || []).length;
  console.log(c, n);
}
const o = (src.match(/\{/g) || []).length;
const cl = (src.match(/\}/g) || []).length;
console.log('braces', o, cl, o === cl ? 'OK' : 'BAD');
