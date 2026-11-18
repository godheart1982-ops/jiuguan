// 原文召回型记忆：当前状态账本 + 永久轮次原文 + 索引卡 + 发送前副 API 召回。
// 不做短期→长期自动压缩；未提及的旧状态保持不变，刷新稿只有在退到历史区后才入库。

import { getConfig, saveChat } from './storage.js';
import { sendChat } from './api.js';
import { resolveMemoryApi, trimAssistantForMemory, extractMemoryCorrections } from './api-memory.js';

export const RECENT_RAW_TURNS = 1;
export const MEMORY_ENGINE_VERSION = 'archive-v1';
export const MEMORY_RECALL_LIMIT = 16;
export const RECALL_BATCH_SIZE = 200;
export const MEMORY_RECALL_DETAIL_LIMIT = 2;

export function emptyMemoryState() {
  return {
    scene: '',
    characters: [],
    promises: [],
    events: [],
    intel: [],
    asOfTurn: '',
    stale: false
  };
}

export function ensureMemoryEngine(memory) {
  if (!memory || typeof memory !== 'object') return memory;
  if (!Array.isArray(memory.archive)) memory.archive = [];
  // 早期新版曾把原文复制进索引；原 messages 才是唯一数据源，旧重复字段读取时剔除
  for (const entry of memory.archive) {
    if (!entry || typeof entry !== 'object') continue;
    if (String(entry.assistantText || '').startsWith('【开场白】')) entry.includeGreeting = true;
    delete entry.userText;
    delete entry.assistantText;
  }
  if (!memory.state || typeof memory.state !== 'object') memory.state = emptyMemoryState();
  const state = memory.state;
  if (typeof state.scene !== 'string') state.scene = '';
  for (const key of ['characters', 'promises', 'events', 'intel']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  if (typeof state.asOfTurn !== 'string') state.asOfTurn = '';
  if (state.stale !== true) state.stale = false;
  if (!Array.isArray(memory.recallLog)) memory.recallLog = [];
  memory.engine = MEMORY_ENGINE_VERSION;
  return memory;
}

export function turnIdOf(round) {
  const user = round && round.user;
  const assistant = round && round.assistant;
  if (user && user.turnId) return String(user.turnId);
  const stamp = (user && user.timestamp) || (assistant && assistant.timestamp) || '';
  const number = user && Number.isFinite(user.round) ? user.round : 0;
  const id = `turn-${stamp || 'unknown'}-r${number}`;
  // 老消息首次使用时补上永久 ID；之后编辑 timestamp 不会改变记忆指向
  if (user && typeof user === 'object') user.turnId = id;
  return id;
}

export function revisionOf(userText, assistantText) {
  const text = String(userText || '') + '\n' + String(assistantText || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  return `${text.length}-${hash.toString(36)}`;
}

function cleanAssistantForArchive(content) {
  return trimAssistantForMemory(String(content || ''))
    .replace(/<思考>[\s\S]*?<\/思考>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/^>###\s*🖼️插图[\s\S]*$/m, '')
    .trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stringArray(value, limit = 12) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))].slice(0, limit);
}

function normalizeIndexCard(raw, fallbackText) {
  const card = raw && typeof raw === 'object' ? raw : {};
  const flat = String(fallbackText || '').replace(/\s+/g, ' ').trim();
  return {
    title: String(card.title || '').trim().slice(0, 60) || (flat.slice(0, 30) || '未命名对话'),
    summary: String(card.summary || '').trim() || flat.slice(0, 160),
    characters: stringArray(card.characters, 12),
    location: String(card.location || '').trim(),
    sceneTime: String(card.sceneTime || '').trim(),
    keywords: stringArray(card.keywords, 16),
    aliases: stringArray(card.aliases, 16),
    topics: stringArray(card.topics, 8),
    importance: Math.max(1, Math.min(5, Math.trunc(Number(card.importance) || 1)))
  };
}

export function archiveEntryForRound(round, greeting = '') {
  const userText = String(round && round.user && round.user.content || '');
  const reply = cleanAssistantForArchive(round && round.assistant && round.assistant.content);
  return {
    turnId: turnIdOf(round),
    round: Number.isFinite(round && round.user && round.user.round) ? round.user.round : null,
    turnTimestamp: String(round && round.user && round.user.timestamp || ''),
    revision: revisionOf(userText, reply),
    includeGreeting: Boolean(greeting),
    index: null,
    stateAfter: null
  };
}

function roundFromMessages(messages, turnId) {
  if (!Array.isArray(messages)) return null;
  for (let i = 0; i < messages.length; i++) {
    const user = messages[i];
    if (!user || user.role !== 'user' || turnIdOf({ user }) !== turnId) continue;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === 'user') break;
      if (messages[j].role === 'assistant') return { user, assistant: messages[j] };
    }
  }
  return null;
}

/** 索引只存 turnId；需要原文时从当前消息与选定稿实时读取。 */
export function readArchivedTurn(messages, entryOrId) {
  const entry = entryOrId && typeof entryOrId === 'object' ? entryOrId : { turnId: String(entryOrId || '') };
  const round = roundFromMessages(messages, entry.turnId);
  if (!round) return null;
  let assistantText = cleanAssistantForArchive(round.assistant.content);
  if (entry.includeGreeting && messages[0] && messages[0].role === 'assistant') {
    assistantText = `【开场白】\n${messages[0].content || ''}\n\n【本轮回复】\n${assistantText}`;
  }
  return { userText: String(round.user.content || ''), assistantText, round };
}

function normalizeState(state) {
  const src = state && typeof state === 'object' ? state : {};
  return {
    scene: typeof src.scene === 'string' ? src.scene : '',
    characters: Array.isArray(src.characters) ? src.characters : [],
    promises: Array.isArray(src.promises) ? src.promises : [],
    events: Array.isArray(src.events) ? src.events : [],
    intel: Array.isArray(src.intel) ? src.intel : [],
    asOfTurn: typeof src.asOfTurn === 'string' ? src.asOfTurn : '',
    stale: src.stale === true
  };
}

const CHARACTER_FIELDS = ['relation', 'stage', 'scores', 'mood', 'goal', 'agreement', 'boundaries', 'knowledge', 'plans'];

function upsertById(list, item, kind, turnId) {
  if (!item || typeof item !== 'object') return;
  const text = String(item.text || '').trim();
  const id = String(item.id || '').trim() || (text ? `${kind}-${revisionOf(text, '')}` : '');
  if (!id && kind !== 'character') return;
  const existing = kind === 'character'
    ? list.find((it) => String(it.name || '') === String(item.name || '').trim())
    : list.find((it) => String(it.id || '') === id || (text && String(it.text || '') === text));
  if (item.op === 'remove') {
    const index = list.indexOf(existing);
    if (index >= 0) list.splice(index, 1);
    return;
  }
  const target = existing || (kind === 'character' ? { name: String(item.name || '').trim() } : { id, text });
  if (kind === 'character' && !target.name) return;
  if (kind !== 'character') {
    target.id = id;
    if (text) target.text = text;
    if (kind === 'promise' && item.status !== undefined) target.status = item.status === 'done' ? 'done' : 'open';
    if (item.due !== undefined) target.due = String(item.due || '').trim();
    if (kind === 'event' && item.stage !== undefined) target.stage = String(item.stage || '').trim();
    if (kind === 'intel' && item.knownBy !== undefined) target.knownBy = stringArray(item.knownBy, 30);
  } else {
    for (const field of CHARACTER_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(item, field)) continue;
      const value = String(item[field] || '').trim();
      // 空字段=模型没提供新值，不允许顺手清空旧状态
      if (value) target[field] = value;
    }
  }
  if (item.evidence) target.evidence = String(item.evidence).trim();
  target.sourceTurn = turnId;
  if (!existing) list.push(target);
}

/** 增量应用状态补丁：未出现的旧条目不变，删除必须显式 op=remove。 */
export function applyMemoryStatePatch(stateRaw, patch, turnId) {
  const state = normalizeState(stateRaw);
  if (!patch || typeof patch !== 'object') return state;
  if (typeof patch.scene === 'string' && patch.scene.trim()) state.scene = patch.scene.trim();
  for (const item of Array.isArray(patch.characters) ? patch.characters : []) {
    upsertById(state.characters, item, 'character', turnId);
  }
  for (const item of Array.isArray(patch.promises) ? patch.promises : []) {
    upsertById(state.promises, item, 'promise', turnId);
  }
  for (const item of Array.isArray(patch.events) ? patch.events : []) {
    upsertById(state.events, item, 'event', turnId);
  }
  for (const item of Array.isArray(patch.intel) ? patch.intel : []) {
    upsertById(state.intel, item, 'intel', turnId);
  }
  state.asOfTurn = turnId || state.asOfTurn;
  return state;
}

export function formatMemoryState(stateRaw) {
  const state = normalizeState(stateRaw);
  const lines = [];
  if (state.scene.trim()) lines.push('场景：' + state.scene.trim());
  for (const c of state.characters) {
    const details = CHARACTER_FIELDS
      .map((key) => [key, String(c[key] || '').trim()])
      .filter(([, value]) => value)
      .map(([key, value]) => `${({ relation: '关系', stage: '阶段', scores: '进度', mood: '情绪', goal: '目标', agreement: '关系约定', boundaries: '亲密边界', knowledge: '知情', plans: '个人计划' })[key]}=${value}`);
    if (c.name) lines.push(`人物【${c.name}】${details.join('；')}`);
  }
  const openPromises = state.promises.filter((p) => p.status !== 'done');
  if (openPromises.length) lines.push('未完成约定：' + openPromises.map((p) => `${p.text}${p.due ? `（${p.due}）` : ''}`).join('｜'));
  if (state.events.length) lines.push('进行中事件：' + state.events.map((e) => `${e.text}${e.stage ? `→${e.stage}` : ''}`).join('｜'));
  if (state.intel.length) lines.push('知情情报：' + state.intel.map((i) => `${i.text}【可知：${(i.knownBy || []).join('、') || '暂无'}】`).join('｜'));
  return lines.join('\n');
}

export function formatCurrentMemoryState(memory) {
  if (!memory || !memory.state) return '';
  const body = formatMemoryState(memory.state);
  if (!body) return '';
  return '【当前状态账本】（记录当前有效状态；与最近一轮状态栏存在新旧差异时，以最近一轮为准。人物核心人格与基础性观念仍以角色卡为准）\n' + body;
}

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* continue */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* continue */ }
  }
  for (const match of [text.match(/\{[\s\S]*\}/), text.match(/\[[\s\S]*\]/)]) {
    if (!match) continue;
    try { return JSON.parse(match[0]); } catch { /* continue */ }
  }
  return null;
}

function memoryApiOrThrow(config) {
  const api = resolveMemoryApi((config && config.api) || {});
  if (!api.baseUrl || !api.apiKey || !api.model) throw new Error('记忆副 API 配置不完整');
  return api;
}

/** 副 API 一次调用：生成一轮索引卡 + 增量状态补丁。 */
export async function processRoundForMemory(round, context = {}) {
  const config = await getConfig();
  const api = memoryApiOrThrow(config);
  const entry = archiveEntryForRound(round, context.greeting || '');
  const rawReply = cleanAssistantForArchive(round && round.assistant && round.assistant.content);
  const rawTurn = {
    userText: String(round && round.user && round.user.content || ''),
    assistantText: context.greeting ? `【开场白】\n${context.greeting}\n\n【本轮回复】\n${rawReply}` : rawReply
  };
  const prompt = `请为这一轮角色扮演对话建立“召回索引卡”，并只上报本轮真实发生的状态变化。

只输出一个 JSON 对象：
{
 "index":{"title":"含人名和事件的短标题","summary":"可独立阅读的一到两句摘要","characters":["全名"],"location":"地点","sceneTime":"剧情日期时间","keywords":["专名与关键概念"],"aliases":["以后提起此事的其他常见说法"],"topics":["关系/约定/亲密/工作/场外等"],"importance":1},
 "statePatch":{
  "scene":"当前场景；无变化留空",
  "characters":[{"name":"全名","relation":"当前关系名分","stage":"阶段","scores":"只照抄状态栏三轴","mood":"当前情绪","goal":"当前目标","agreement":"已明确的关系约定","boundaries":"当前亲密接受边界","knowledge":"当前知道的关键情报","plans":"正在推进的个人计划","evidence":"本轮正文证据"}],
  "promises":[{"id":"旧条目id；新增留空","text":"约定","status":"open/done","due":"期限","evidence":"证据","op":"upsert/remove"}],
  "events":[{"id":"旧id/新增留空","text":"事件名","stage":"当前阶段","evidence":"证据","op":"upsert/remove"}],
  "intel":[{"id":"旧id/新增留空","text":"秘密","knownBy":["当前全量知情人"],"evidence":"证据","op":"upsert/remove"}]
 }
}

硬性规则：
1. 索引摘要必须写具体人名，禁止只用她/他/对方；keywords 与 aliases 用于以后找回这一轮详细原文。
2. statePatch 只写变化项；没提到的旧数据保持原样。禁止因旧约定本轮没出现就标 done，删除必须 op=remove 且有明确依据。
3. 发生关系不自动等于恋爱；炮友不自动获得恋人式占有权。一次亲密、心软或吃醋不得无依据改写永久人格、性观念或既有关系约定。
4. 三轴数值只抄本轮状态栏，禁止估算；角色未出场则不要更新其数值。
5. 场外个人线若本轮有实际进展，更新该人物的 plans/mood；公共事件更新 events；秘密知情变化更新 intel。
6. 没有变化时对应数组输出 []。不要编造。

【当前状态账本（含旧条目id）】
${JSON.stringify(context.currentState || emptyMemoryState())}

【对话补充设定（仅供理解，不入索引）】
${String(context.supplement || '').trim() || '无'}

【主模型记忆修正（如有，作为权威更正）】
${(context.corrections || []).join('\n') || '无'}

【本轮对话原文】
用户：${rawTurn.userText}

AI：${rawTurn.assistantText}`;
  const raw = await sendChat([
    { role: 'system', content: '你是原文记忆索引与状态抽取助手。只输出合法 JSON，不输出解释。' },
    { role: 'user', content: prompt }
  ], { api, usageContext: { kind: 'memory' } });
  const parsed = parseJson(raw);
  entry.index = normalizeIndexCard(parsed && (parsed.index || parsed.card), rawTurn.userText + ' ' + rawTurn.assistantText);
  return {
    entry,
    statePatch: parsed && parsed.statePatch && typeof parsed.statePatch === 'object' ? parsed.statePatch : {}
  };
}

/** 回复完成后整理所有已退出最近一轮窗口的轮次；旧轮次编辑只重建索引，不擅自改当前状态。 */
export async function catchUpMemoryArchive(chat, character, rounds, hooks = {}) {
  ensureMemoryEngine(chat.memory);
  const list = Array.isArray(rounds) ? rounds.filter((r) => !r.user.meta) : [];
  const targets = list.slice(0, -RECENT_RAW_TURNS);
  let processed = 0;
  for (const round of targets) {
    const candidate = archiveEntryForRound(round, '');
    const existingIndex = chat.memory.archive.findIndex((a) => a.turnId === candidate.turnId);
    const existing = existingIndex >= 0 ? chat.memory.archive[existingIndex] : null;
    if (existing && existing.revision === candidate.revision && existing.index) continue;
    if (!existing && chat.memory.engineStartedAt && candidate.turnTimestamp && candidate.turnTimestamp < chat.memory.engineStartedAt) continue;

    hooks.onStatus?.(`正在整理第 ${candidate.round ?? '—'} 轮记忆…`, 'info');
    const greeting = processed === 0 && !chat.memory.archive.length ? (hooks.greeting || '') : '';
    const result = await processRoundForMemory(round, {
      currentState: chat.memory.state,
      supplement: chat.memory.supplement || '',
      corrections: extractMemoryCorrections(round.assistant.content || ''),
      characterName: character.name || '',
      greeting
    });
    if (existing) {
      result.entry.stateAfter = null;
      chat.memory.archive[existingIndex] = result.entry;
      chat.memory.state.stale = true;
    } else {
      chat.memory.state = applyMemoryStatePatch(chat.memory.state, result.statePatch, result.entry.turnId);
      result.entry.stateAfter = clone(chat.memory.state);
      chat.memory.archive.push(result.entry);
    }
    processed++;
    await saveChat(chat).catch(() => {});
  }
  if (processed) hooks.onStatus?.(`已整理 ${processed} 轮原文记忆`, 'success');
  return processed;
}

/** 快速连发时：倒数第二轮尚未入库则临时多带一轮原文。 */
export function needsMemoryRawFallback(memory, rounds) {
  const list = Array.isArray(rounds) ? rounds.filter((r) => !r.user.meta) : [];
  if (list.length <= RECENT_RAW_TURNS) return false;
  const target = list[list.length - 1 - RECENT_RAW_TURNS];
  const entry = archiveEntryForRound(target);
  const found = memory && Array.isArray(memory.archive)
    ? memory.archive.find((a) => a.turnId === entry.turnId)
    : null;
  return !found || !found.index || found.revision !== entry.revision;
}

/** 已入库轮次被编辑后：旧索引立即停用，当前状态等待手动重建；最新未入库轮次无需处理。 */
export function markMessageMemoryEdited(chat, message) {
  if (!chat || !Array.isArray(chat.messages) || !message) return false;
  const index = chat.messages.indexOf(message);
  if (index < 0) return false;
  let user = message.role === 'user' ? message : null;
  if (!user) {
    for (let i = index - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'user') { user = chat.messages[i]; break; }
    }
  }
  if (!user) return false;
  const turnId = turnIdOf({ user });
  const entry = chat.memory && Array.isArray(chat.memory.archive)
    ? chat.memory.archive.find((a) => a.turnId === turnId)
    : null;
  if (!entry) return false;
  entry.index = null;
  entry.stateAfter = null;
  if (chat.memory.state) chat.memory.state.stale = true;
  return true;
}

/** 编辑并重发：删除目标轮及之后的档案，恢复重发点之前的最近状态快照。 */
export function truncateMemoryForResend(chat, userMessage) {
  if (!chat || !userMessage) return;
  ensureMemoryEngine(chat.memory);
  const messageIndex = chat.messages.indexOf(userMessage);
  const allowed = new Set(chat.messages.slice(0, Math.max(0, messageIndex))
    .filter((m) => m.role === 'user').map((user) => turnIdOf({ user })));
  chat.memory.archive = chat.memory.archive.filter((entry) => allowed.has(entry.turnId));
  const snapshot = [...chat.memory.archive].reverse().find((entry) => entry && entry.stateAfter);
  chat.memory.state = snapshot ? clone(snapshot.stateAfter) : emptyMemoryState();
  chat.memory.recallLog = [];
}

function selectorCards(memory, excluded) {
  return memory.archive.filter((entry) => entry && entry.index && !excluded.has(entry.turnId));
}

export function chunkRecallCards(cards, size = RECALL_BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < cards.length; i += size) chunks.push(cards.slice(i, i + size));
  return chunks;
}

function recallScopeRank(scope) {
  return ({ none: 0, normal: 1, specific: 2, review: 3 })[scope] ?? 1;
}

/** 清洗分级结果：low 丢弃；普通轮少量，长线回顾最多 16 条；只有 high 可展开原文。 */
export function finalizeRecallSelections(memory, rows, scope = 'normal') {
  const safeScope = ['none', 'normal', 'specific', 'review'].includes(scope) ? scope : 'normal';
  if (safeScope === 'none') return [];
  const limit = safeScope === 'review' ? MEMORY_RECALL_LIMIT : (safeScope === 'specific' ? 6 : 4);
  const seen = new Set();
  const valid = [];
  const ordered = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
    const rank = (level) => level === 'high' ? 0 : 1;
    return rank(a && a.level) - rank(b && b.level);
  });
  for (const row of ordered) {
    const turnId = String(row && (row.turnId || row.id) || '');
    const level = row && row.level === 'medium' ? 'medium' : (row && row.level === 'low' ? 'low' : 'high');
    if (!turnId || seen.has(turnId) || level === 'low') continue;
    const index = memory.archive.findIndex((a) => a.turnId === turnId && a.index);
    if (index < 0) continue;
    seen.add(turnId);
    valid.push({
      turnId,
      level,
      reason: String(row.reason || '').trim(),
      includeContext: row.includeContext === true,
      entry: memory.archive[index],
      before: row.includeContext === true && index > 0 ? memory.archive[index - 1].index?.summary || '' : '',
      after: row.includeContext === true && index < memory.archive.length - 1 ? memory.archive[index + 1].index?.summary || '' : ''
    });
    if (valid.length >= limit) break;
  }
  const high = valid.filter((r) => r.level === 'high');
  const newest = high.slice().sort((a, b) => memory.archive.indexOf(a.entry) - memory.archive.indexOf(b.entry))
    .slice(-MEMORY_RECALL_DETAIL_LIMIT);
  const detailIds = new Set(newest.map((r) => r.turnId));
  valid.forEach((recall) => { recall.detail = detailIds.has(recall.turnId); });
  return valid;
}

async function requestRecallBatch(api, cards, query) {
  const prompt = `请从索引卡中找出本轮真正需要的历史记忆。允许一个也不选，禁止为凑数而选。

只输出 JSON：{"scope":"none/normal/specific/review","recall":[{"turnId":"原id","level":"high/medium/low","reason":"一句理由","includeContext":false}]}
turnId 必须照抄。scope 含义：none=当前状态足够或无历史需要；normal=普通续写；specific=针对某件旧事；review=明确要求回顾一段长期关系/事件线。

选择纪律：
1. high=能直接回答当前问题、解释当前冲突或提供不可缺少的前因；medium=人物与主题相关，可作背景摘要；low=只有人名/地点/关系/物品/情绪等宽泛重合。low 会在本地直接丢弃。
2. 人名、地点、关系、当前状态只用于定位与消歧，不能单独构成召回理由。纯人名最多选一条 medium，也可为空。
3. 普通续写默认少选或不选；specific 围绕一件事，不多带其他经历；review 才选择多个关键节点。
4. 同一事件的多轮过程不得全选：普通问题选最直接一轮；长线回顾选起点/转折/结果/最新进展。
5. 最近一轮已直接携带，不要选排除项。需要前因后果时才设 includeContext=true。

【本轮输入】
${String(query.userMessage || '')}

【行动选项解析（与主 API 共用）】
${String(query.actionContext || '自由输入或无可用选项')}

【当前状态（仅用于消歧）】
${formatMemoryState(query.currentState) || '无'}

【最近一轮对话】
用户：${String(query.recentUser || '')}
AI：${String(query.recentAssistant || '')}

【本批索引卡】
${JSON.stringify(cards)}`;
  const raw = await sendChat([
    { role: 'system', content: '你是分级历史检索器。只输出合法 JSON，宁缺毋滥，禁止编造 turnId。' },
    { role: 'user', content: prompt }
  ], { api, usageContext: { kind: 'memory' } });
  const parsed = parseJson(raw);
  const rows = Array.isArray(parsed) ? parsed : (parsed && (parsed.recall || parsed.recalls)) || [];
  const scope = parsed && !Array.isArray(parsed) && ['none', 'normal', 'specific', 'review'].includes(parsed.scope) ? parsed.scope : 'normal';
  return { rows: Array.isArray(rows) ? rows : [], scope };
}

/** 主回复前：少量一次检索；超过 200 张卡分批并行初筛，再对候选汇总复选。 */
export async function selectMemoryRecalls(memory, query = {}) {
  ensureMemoryEngine(memory);
  const excluded = new Set(query.excludeTurnIds || []);
  const candidates = selectorCards(memory, excluded);
  if (!candidates.length) return { selections: [], recalls: [] };
  const config = await getConfig();
  const api = memoryApiOrThrow(config);
  const cards = candidates.map((entry) => ({ turnId: entry.turnId, round: entry.round, ...entry.index }));
  const batches = chunkRecallCards(cards);
  let scope = 'normal';
  let rows = [];
  if (batches.length === 1) {
    const result = await requestRecallBatch(api, batches[0], query);
    rows = result.rows;
    scope = result.scope;
  } else {
    const settled = await Promise.allSettled(batches.map((batch) => requestRecallBatch(api, batch, query)));
    const successful = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!successful.length) throw new Error('所有记忆分批检索均失败');
    rows = successful.flatMap((r) => r.rows);
    scope = successful.map((r) => r.scope).sort((a, b) => recallScopeRank(b) - recallScopeRank(a))[0] || 'normal';
    const ids = new Set(rows.map((r) => String(r && (r.turnId || r.id) || '')));
    const candidateCards = cards.filter((card) => ids.has(card.turnId));
    if (candidateCards.length) {
      const merged = await requestRecallBatch(api, candidateCards, { ...query, recallScope: scope });
      rows = merged.rows;
      scope = merged.scope;
    }
  }
  const recalls = finalizeRecallSelections(memory, rows, scope);
  const selections = recalls.map((recall) => ({
    turnId: recall.turnId,
    level: recall.level,
    reason: recall.reason,
    includeContext: recall.includeContext
  }));
  memory.recallLog.push({
    createdAt: new Date().toISOString(),
    userText: String(query.userMessage || ''),
    actionContext: String(query.actionContext || ''),
    scope,
    turnIds: selections.map((s) => s.turnId),
    levels: selections.map((s) => s.level),
    reasons: selections.map((s) => s.reason).filter(Boolean)
  });
  if (memory.recallLog.length > 50) memory.recallLog = memory.recallLog.slice(-50);
  return { selections, recalls };
}

export function formatRecalledTurns(recalls, messages = []) {
  if (!Array.isArray(recalls) || !recalls.length) return '';
  const byRound = (a, b) => (a.entry?.round || 0) - (b.entry?.round || 0);
  const isDetail = (recall) => recall.detail === true || (recall.detail === undefined && recalls.length <= MEMORY_RECALL_DETAIL_LIMIT);
  const summaries = recalls.filter((recall) => !isDetail(recall)).sort(byRound).map((recall) => {
    const entry = recall.entry;
    return `【历史摘要｜第 ${entry.round ?? '—'} 轮｜${entry.index?.title || '相关对话'}】${entry.index?.summary || ''}`;
  });
  const details = recalls.filter(isDetail).sort(byRound).map((recall) => {
    const entry = recall.entry;
    const raw = entry && readArchivedTurn(messages, entry);
    if (!raw) return '';
    const lines = [`【历史详细原文｜第 ${entry.round ?? '—'} 轮｜${entry.index?.title || '相关对话'}】`];
    if (recall.before) lines.push('前情：' + recall.before);
    lines.push('用户：' + raw.userText, 'AI：' + raw.assistantText);
    if (recall.after) lines.push('后续：' + recall.after);
    return lines.join('\n');
  }).filter(Boolean);
  const blocks = [...summaries, ...details];
  if (!blocks.length) return '';
  return '【召回的历史记忆】（以下只代表过去实际发生的对话；较早命中只给摘要，最近两轮给详细原文；过去的场景、衣着、情绪和数值不得覆盖当前状态）\n\n' + blocks.join('\n\n');
}

/** 从当前全部已入库原文重建状态；用于旧轮编辑后的手动修复。 */
export async function rebuildMemoryState(chat, character, hooks = {}) {
  ensureMemoryEngine(chat.memory);
  let state = emptyMemoryState();
  for (const entry of chat.memory.archive) {
    const round = roundFromMessages(chat.messages, entry.turnId);
    if (!round) continue;
    hooks.onStatus?.(`正在重建第 ${entry.round ?? '—'} 轮状态…`, 'info');
    const result = await processRoundForMemory(round, {
      currentState: state,
      supplement: chat.memory.supplement || '',
      characterName: character.name || '',
      greeting: entry.includeGreeting && chat.messages[0] && chat.messages[0].role === 'assistant' ? chat.messages[0].content : ''
    });
    entry.index = result.entry.index;
    entry.revision = result.entry.revision;
    state = applyMemoryStatePatch(state, result.statePatch, entry.turnId);
    entry.stateAfter = clone(state);
    await saveChat(chat).catch(() => {});
  }
  state.stale = false;
  chat.memory.state = state;
  await saveChat(chat).catch(() => {});
  hooks.onStatus?.('当前状态已按原文重建', 'success');
}
