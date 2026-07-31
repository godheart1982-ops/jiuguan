const fs = require('fs');
const path = require('path');
const chatPath = path.join(__dirname, '../src/pages/chat.js');
let src = fs.readFileSync(chatPath, 'utf8');

if (src.includes('createMessageListController')) {
  console.log('already patched');
  process.exit(0);
}

// --- imports ---
src = src.replace(
  "import { createIllustrationController } from './chat/chat-illustration.js';",
  `import { createIllustrationController } from './chat/chat-illustration.js';
import { createMemoryStatus } from './chat/chat-memory-ui.js';
import {
  isIncompleteAssistant,
  getAllRounds,
  getLeadingGreeting,
  getLastOutputHeading,
  extractSceneDate,
  maybeCondenseLongTerm
} from './chat/chat-memory-helpers.js';
import { createMessageListController } from './chat/chat-message-list.js';`
);

// remove SHORT_TERM_LIMIT from api-memory import if only used by maybeCondense (check)
// summarizeShortTermMemories might still be unused after maybeCondense move

// --- memory status ---
const statusStart = src.indexOf('  function showMemoryStatus(message, type = \'info\') {');
const statusEnd = src.indexOf('  // 渲染已有消息（长对话分页');
if (statusStart < 0 || statusEnd < 0) {
  console.error('status block markers fail', statusStart, statusEnd);
  process.exit(1);
}
src =
  src.slice(0, statusStart) +
  `  const { showMemoryStatus, showMemoryRetryBar } = createMemoryStatus(memoryStatus);

` +
  src.slice(statusEnd);

// --- message list + search block: from "渲染已有消息" through search next/prev, before "renderMessages();" first call after search
// Actually structure:
//   // 渲染已有消息
//   const MSG_PAGE_SIZE ...
//   function renderMessages ...
//   ...
//   illustration ...
//   refreshCurrentChat
//   // 轮次跳转
//   ...
//   // 消息搜索
//   ...
//   document.getElementById('btn-search-next')...
//   renderMessages();

const listStart = src.indexOf('  // 渲染已有消息（长对话分页');
const listEnd = src.indexOf('\n  renderMessages();\n\n  // 事件绑定');
if (listStart < 0 || listEnd < 0) {
  console.error('list block markers fail', listStart, listEnd);
  process.exit(1);
}

const listReplacement = `  // 消息列表：分页 / 轮次跳转 / 搜索（见 chat/chat-message-list.js）
  // onRefresh / onEditResend 在下方定义；调用时已初始化（function 声明提升）
  const messageList = createMessageListController({
    getChat: () => currentChat,
    messagesContainer,
    getAvatarUrl: () => avatarUrl,
    toolsPanel,
    onRefresh: (...args) => handleRefresh(...args),
    onEditResend: (...args) => handleEditResend(...args),
    showMemoryStatus,
    els: {
      roundJumpInput: document.getElementById('round-jump-input'),
      roundJumpBtn: document.getElementById('btn-round-jump'),
      roundJumpTotal: document.getElementById('round-jump-total'),
      searchInput: document.getElementById('msg-search-input'),
      searchCount: document.getElementById('msg-search-count'),
      toolsBtn: document.getElementById('btn-tools')
    }
  });
  const { renderMessages, updateRoundJumpInfo, ensureMessageRendered } = messageList;
  messageList.bind();

  // 插图：事件委托 + 付费/手动生图（见 chat/chat-illustration.js）
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
    messageList.resetPaging();
    renderMessages();
    showMemoryStatus('已刷新到最新内容', 'success');
  }

`;

src = src.slice(0, listStart) + listReplacement + src.slice(listEnd);

// --- remove local helper functions and maybeCondense ---
const helpersStart = src.indexOf('  // 判断 assistant 消息是否为不完整/失败的回复');
const handleRefreshStart = src.indexOf('  async function handleRefresh(assistantIndex) {');
if (helpersStart < 0 || handleRefreshStart < 0) {
  console.error('helpers markers fail', helpersStart, handleRefreshStart);
  process.exit(1);
}
src = src.slice(0, helpersStart) + src.slice(handleRefreshStart);

// maybeCondenseLongTerm() calls -> maybeCondenseLongTerm(currentChat, showMemoryStatus)
src = src.replace(/await maybeCondenseLongTerm\(\)/g, 'await maybeCondenseLongTerm(currentChat, showMemoryStatus)');
src = src.replace(/maybeCondenseLongTerm\(\)/g, 'maybeCondenseLongTerm(currentChat, showMemoryStatus)');

// Clean api-memory imports: remove summarizeShortTermMemories, condenseLongTermMemory if unused, SHORT_TERM_LIMIT if unused
// Check after write

// Remove appendMessage from import if only used via message-list - chat.js may still need appendMessage in send path
// generateResponse uses appendMessage - keep import

fs.writeFileSync(chatPath, src);
console.log('lines', src.split(/\n/).length);

// verify no leftover local defs
const bad = [
  'function showMemoryStatus',
  'function renderMessages',
  'function getAllRounds',
  'function maybeCondenseLongTerm',
  'function isIncompleteAssistant',
  'function extractSceneDate',
  'function getLastOutputHeading',
  'function getLeadingGreeting'
];
for (const b of bad) {
  if (src.includes(b)) console.log('STILL HAS', b);
}
const o = (src.match(/\{/g) || []).length;
const c = (src.match(/\}/g) || []).length;
console.log('braces', o, c, o === c ? 'OK' : 'BAD');
console.log('createMessageListController', src.includes('createMessageListController'));
console.log('maybeCondense calls', (src.match(/maybeCondenseLongTerm\(/g) || []).length);
