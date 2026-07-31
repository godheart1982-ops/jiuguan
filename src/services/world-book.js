/**
 * 世界书（类 SillyTavern World Info）
 *
 * 来源：
 * 1) 独立库 worldbooks/{id}.json，可被角色绑定
 * 2) 角色卡 character.worldBook.entries 专属条目
 *
 * character.worldBook: {
 *   enabled, scanDepth, caseSensitive, maxRecursion (0–5, 默认 3),
 *   ignoreStatusBar (默认 true),
 *   boundBookIds: string[],
 *   entries: Entry[]  // 角色专属
 * }
 *
 * Entry: {
 *   id, name, enabled, constant, keys[], content, order,
 *   preventRecursion,  // 激活后不用 content 勾别人
 *   excludeRecursion   // 不能被递归勾出，只能聊天扫描/常驻
 * }
 *
 * order：对齐 ST，数字越大插入越靠后（影响通常更大）
 * 预算：每轮最多 10 条；常驻优先，再优先保留 order 大的；注入时仍按 order 升序排列
 */

import { getWorldBook } from './storage.js';

export const WORLD_BOOK_MAX_INJECT = 10;
export const WORLD_BOOK_DEFAULT_RECURSION = 3;

export function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const keys = Array.isArray(e.keys)
    ? e.keys.map((k) => String(k || '').trim()).filter(Boolean)
    : String(e.keys || '')
      .split(/[,，;；\n]/)
      .map((k) => k.trim())
      .filter(Boolean);
  const order = parseInt(e.order, 10);
  return {
    id: e.id || '',
    name: String(e.name || '').trim(),
    enabled: e.enabled !== false,
    constant: e.constant === true,
    keys,
    content: String(e.content || ''),
    order: Number.isFinite(order) ? order : 100,
    preventRecursion: e.preventRecursion === true,
    excludeRecursion: e.excludeRecursion === true
  };
}

export function normalizeWorldBookSettings(raw) {
  const wb = raw && typeof raw === 'object' ? raw : {};
  const depth = parseInt(wb.scanDepth, 10);
  const rec = parseInt(wb.maxRecursion, 10);
  const bound = Array.isArray(wb.boundBookIds)
    ? wb.boundBookIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const entries = Array.isArray(wb.entries) ? wb.entries.map(normalizeEntry).filter(Boolean) : [];
  return {
    enabled: wb.enabled === true,
    scanDepth: Number.isFinite(depth) ? Math.max(0, Math.min(50, depth)) : 4,
    caseSensitive: wb.caseSensitive === true,
    maxRecursion: Number.isFinite(rec)
      ? Math.max(0, Math.min(5, rec))
      : WORLD_BOOK_DEFAULT_RECURSION,
    ignoreStatusBar: wb.ignoreStatusBar !== false,
    boundBookIds: [...new Set(bound)],
    entries
  };
}

/** @deprecated 兼容旧名 */
export function normalizeWorldBook(raw) {
  return normalizeWorldBookSettings(raw);
}

export function createEmptyWorldBookEntry(id) {
  return {
    id: id || '',
    name: '',
    enabled: true,
    constant: false,
    keys: [],
    content: '',
    order: 100,
    preventRecursion: false,
    excludeRecursion: false
  };
}

export function createEmptyWorldBookFile(id, name) {
  return {
    id: id || '',
    name: name || '未命名世界书',
    entries: [],
    createdAt: null,
    updatedAt: null
  };
}

// 状态栏剥离：AI 回复里的 ``` 代码围栏块和 >### 模块标题行不参与关键词扫描。
// 状态栏（人际关系/心声等字段）每轮全量重输出，里面的人名会把对应条目钉成"伪常驻"，
// 挤占每轮注入预算；剥离后条目只由正文与用户输入触发，在场靠正文提及、离场自然关闭。
// 规则是通用模式（围栏 + 标题行），不绑定具体模板；模型没按格式加围栏时只是退回旧行为。
const FENCED_BLOCK_RE = /```[\s\S]*?(?:```|$)/g;
const HEADING_LINE_RE = /^[ \t>]*#{2,6}[^\n]*(?:\n|$)/gm;

export function stripStatusBlocks(text) {
  return String(text || '')
    .replace(FENCED_BLOCK_RE, '\n')
    .replace(HEADING_LINE_RE, '');
}

export function buildWorldBookHaystack(historyMessages, userMessage, scanDepth, ignoreStatusBar = true) {
  const parts = [];
  const hist = Array.isArray(historyMessages) ? historyMessages : [];
  const depth = Math.max(0, scanDepth | 0);
  const slice = depth > 0 ? hist.slice(-depth) : [];
  for (const msg of slice) {
    if (!msg || !msg.content) continue;
    const text = String(msg.content);
    parts.push(ignoreStatusBar && msg.role === 'assistant' ? stripStatusBlocks(text) : text);
  }
  if (userMessage) parts.push(String(userMessage));
  return parts.join('\n');
}

function textIncludesKey(haystack, key, caseSensitive) {
  if (!key) return false;
  if (caseSensitive) return haystack.includes(key);
  return haystack.toLowerCase().includes(key.toLowerCase());
}

function entryMatchesHaystack(entry, haystack, caseSensitive) {
  if (!entry.keys || !entry.keys.length) return false;
  return entry.keys.some((k) => textIncludesKey(haystack, k, caseSensitive));
}

/**
 * 收集角色专属 + 绑定库条目，带稳定 uid（跨库去重）
 * @returns {Promise<Array<Entry & { uid: string, source: string }>>}
 */
export async function collectCharacterWorldBookEntries(character) {
  const settings = normalizeWorldBookSettings(character && character.worldBook);
  const pool = [];

  for (const e of settings.entries) {
    if (!e.id) continue;
    pool.push({
      ...e,
      uid: 'char:' + e.id,
      source: 'character'
    });
  }

  for (const bookId of settings.boundBookIds) {
    let book = null;
    try {
      book = await getWorldBook(bookId);
    } catch (err) {
      console.warn('加载世界书失败:', bookId, err);
    }
    if (!book || !Array.isArray(book.entries)) continue;
    for (const raw of book.entries) {
      const e = normalizeEntry(raw);
      if (!e || !e.id) continue;
      pool.push({
        ...e,
        uid: 'book:' + bookId + ':' + e.id,
        source: book.name || bookId
      });
    }
  }

  return pool;
}

/**
 * 激活 + 递归 + 预算截断，返回按注入顺序（order 升序）排列的条目
 */
export function activateWorldBookEntries(pool, historyMessages, userMessage, settings) {
  const cfg = normalizeWorldBookSettings(settings);
  if (!cfg.enabled) return [];

  const all = (pool || []).filter((e) => e && e.enabled !== false && (e.content || '').trim());
  if (!all.length) return [];

  const activated = new Map(); // uid -> entry

  const chatHaystack = buildWorldBookHaystack(historyMessages, userMessage, cfg.scanDepth, cfg.ignoreStatusBar);
  const caseSensitive = cfg.caseSensitive;

  // 第一轮：常驻 + 聊天扫描命中（excludeRecursion 仍可被聊天激活）
  for (const entry of all) {
    if (entry.constant) {
      activated.set(entry.uid, entry);
      continue;
    }
    if (entryMatchesHaystack(entry, chatHaystack, caseSensitive)) {
      activated.set(entry.uid, entry);
    }
  }

  // 递归：用已激活且未 preventRecursion 的 content 勾其它条目
  const maxRec = cfg.maxRecursion;
  for (let step = 0; step < maxRec; step++) {
    let buffer = '';
    for (const e of activated.values()) {
      if (e.preventRecursion) continue;
      buffer += '\n' + (e.content || '');
    }
    if (!buffer.trim()) break;

    let added = 0;
    for (const entry of all) {
      if (activated.has(entry.uid)) continue;
      if (entry.excludeRecursion) continue; // 不能被递归勾出
      if (entry.constant) continue; // 常驻已在第一轮处理
      if (entryMatchesHaystack(entry, buffer, caseSensitive)) {
        activated.set(entry.uid, entry);
        added++;
      }
    }
    if (!added) break;
  }

  // 预算：最多 10 条。常驻优先，再优先保留 order 大的
  const list = [...activated.values()];
  const constants = list.filter((e) => e.constant);
  const others = list.filter((e) => !e.constant);

  constants.sort((a, b) => (b.order - a.order) || String(a.name).localeCompare(String(b.name), 'zh'));
  others.sort((a, b) => (b.order - a.order) || String(a.name).localeCompare(String(b.name), 'zh'));

  const picked = [];
  const seen = new Set();
  for (const e of constants) {
    if (picked.length >= WORLD_BOOK_MAX_INJECT) break;
    if (seen.has(e.uid)) continue;
    seen.add(e.uid);
    picked.push(e);
  }
  for (const e of others) {
    if (picked.length >= WORLD_BOOK_MAX_INJECT) break;
    if (seen.has(e.uid)) continue;
    seen.add(e.uid);
    picked.push(e);
  }

  // 注入顺序：order 升序（大的靠后）
  picked.sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'zh'));
  return picked;
}

export function formatWorldBookBlock(entries) {
  if (!entries || !entries.length) return '';
  const body = entries.map((e) => {
    const title = e.name || '未命名条目';
    return `### ${title}\n${(e.content || '').trim()}`;
  }).join('\n\n');
  return (
    '【世界书】\n' +
    '以下为与当前剧情相关的补充设定，请自然遵循，不要逐条复读或提及「世界书」：\n\n' +
    body
  );
}

/**
 * 角色本轮世界书注入文本（异步：需读绑定库）
 */
export async function resolveWorldBookInjection(character, historyMessages, userMessage) {
  if (!character) return '';
  const settings = normalizeWorldBookSettings(character.worldBook);
  if (!settings.enabled) return '';
  const pool = await collectCharacterWorldBookEntries(character);
  const selected = activateWorldBookEntries(pool, historyMessages, userMessage, settings);
  return formatWorldBookBlock(selected);
}
