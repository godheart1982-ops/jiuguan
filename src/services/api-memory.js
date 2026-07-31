/**
 * 记忆 AI 调用：短期总结 / 长期整合 / 长期精简
 * 另含「事实备忘」structured facts：约定 / 关系 / 世界事件 / 知情情报 intel+knownBy（与散文短长期并列）
 */

import { getConfig } from './storage.js';
import { sendChat } from './api.js';
import { sanitizeHistoryIllustrationMarkers } from './illustration-markers.js';

// 原文窗口：发送给 AI 的最近完整对话轮数（最近 3 轮原样携带，更早的交给短期/长期记忆）
export const RAW_WINDOW_TURNS = 3;
// 短期记忆达到这个数量就自动压缩为 1 条长期记忆并清空（同时是短期窗口上限）
export const SHORT_TERM_LIMIT = 10;

// 事实备忘条数上限（防胀）
const FACTS_PROMISE_LIMIT = 20;
// 已完成约定只保留最近几条供编辑器查看（不注入 AI；超出的直接丢弃）
const FACTS_PROMISE_DONE_KEEP = 5;
const FACTS_RELATION_LIMIT = 15;
const FACTS_WORLD_LIMIT = 15;
const FACTS_INTEL_LIMIT = 30;

// 世界事件在记忆中的固定标记（摘要 AI 按此格式记录，App 机械提取用于去重；
// 该前缀同时是未来"机械世界事件簿"的解析接口，改动需全链路同步）
const WORLD_MARKER_LINE_RE = /｜世界：[^\n]*/g;

/**
 * 从短期记忆里机械提取已记录的世界事件标记（去掉"｜世界："前缀，去重）。
 * 只读已存数据，不解析 AI 新输出，零风险。
 * @param {Array<{content: string}>} shortTerm
 * @returns {string[]} 如 ["裁员评审→发酵", "地铁停运→平息"]
 */
export function extractWorldEventMarkers(shortTerm) {
  if (!Array.isArray(shortTerm)) return [];
  const found = [];
  for (const s of shortTerm) {
    if (!s || typeof s.content !== 'string') continue;
    const matches = s.content.match(WORLD_MARKER_LINE_RE);
    if (matches) found.push(...matches.map(m => m.replace(/^｜世界：/, '').trim()).filter(Boolean));
  }
  // 合并事实备忘里的世界事件（若调用方只传 shortTerm，下面函数另有入口）
  return [...new Set(found)];
}

/** 从 shortTerm 散文 + memory.facts.worldEvents 汇总已知世界事件（供摘要去重） */
export function extractKnownWorldEvents(memory) {
  const fromShort = extractWorldEventMarkers(memory && memory.shortTerm);
  const facts = normalizeFacts(memory && memory.facts);
  const fromFacts = facts.worldEvents.map((w) => w.text).filter(Boolean);
  return [...new Set([...fromShort, ...fromFacts])];
}

/**
 * 从 AI 回复中机械提取「记忆修正：」行（记忆修正通道；不调 AI）
 * 主模型上报的记忆矛盾，交总结 AI 按最高优先级合并进事实备忘
 * @returns {string[]} 修正内容列表（去前缀、去空、去重）
 */
export function extractMemoryCorrections(content) {
  if (!content || typeof content !== 'string') return [];
  const found = [];
  for (const m of content.matchAll(/^[>\s]*记忆修正[：:][ \t]*(.+)$/gm)) {
    const text = (m[1] || '').trim();
    if (text) found.push(text);
  }
  return [...new Set(found)];
}

// ---------- 事实备忘（structured） ----------

export function emptyFacts() {
  return { promises: [], relations: [], worldEvents: [], intel: [] };
}

function normalizeKnownBy(arr) {
  if (!Array.isArray(arr)) {
    if (typeof arr === 'string' && arr.trim()) {
      return [...new Set(arr.split(/[,，;；、]/).map((s) => s.trim()).filter(Boolean))];
    }
    return [];
  }
  return [...new Set(arr.map((n) => String(n || '').trim()).filter(Boolean))];
}

/** 情报条目：text + knownBy（谁可当已知；含「公开」= 在场都可知道） */
export function normalizeIntelList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      if (typeof item === 'string') {
        return { text: item.trim(), knownBy: [] };
      }
      const text = String((item && item.text) || '').trim();
      const knownBy = normalizeKnownBy(item && item.knownBy);
      return { text, knownBy };
    })
    .filter((i) => i.text)
    .slice(0, FACTS_INTEL_LIMIT);
}

export function normalizeFacts(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const promises = Array.isArray(f.promises)
    ? f.promises
      .map((p) => ({
        text: String((p && p.text) || '').trim(),
        status: (p && p.status) === 'done' ? 'done' : 'open'
      }))
      .filter((p) => p.text)
      .slice(0, FACTS_PROMISE_LIMIT)
    : [];
  const relations = Array.isArray(f.relations)
    ? f.relations
      .map((r) => ({
        name: String((r && r.name) || '').trim(),
        note: String((r && r.note) || '').trim()
      }))
      .filter((r) => r.name)
      .slice(0, FACTS_RELATION_LIMIT)
    : [];
  const worldEvents = Array.isArray(f.worldEvents)
    ? f.worldEvents
      .map((w) => ({
        text: String((w && (typeof w === 'object' ? w.text : w)) || '').trim().replace(/^｜世界：/, '')
      }))
      .filter((w) => w.text)
      .slice(0, FACTS_WORLD_LIMIT)
    : [];
  const intel = normalizeIntelList(f.intel);
  return { promises, relations, worldEvents, intel };
}

function normalizePromiseList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => {
      if (typeof p === 'string') return { text: p.trim(), status: 'open' };
      return {
        text: String((p && p.text) || '').trim(),
        status: (p && p.status) === 'done' ? 'done' : 'open'
      };
    })
    .filter((p) => p.text);
}

function normalizeRelationList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => {
      if (typeof r === 'string') return { name: r.trim(), note: '' };
      return {
        name: String((r && r.name) || '').trim(),
        note: String((r && r.note) || '').trim()
      };
    })
    .filter((r) => r.name);
}

/** 从 content 里拆 ｜世界： 标记 */
export function parseWorldEventsFromContent(content) {
  if (!content || typeof content !== 'string') return [];
  const matches = content.match(WORLD_MARKER_LINE_RE);
  if (!matches) return [];
  return matches.map((m) => m.replace(/^｜世界：/, '').trim()).filter(Boolean);
}

function worldEventKey(text) {
  // "裁员评审→发酵" → 事件名部分用于去重升级
  const t = String(text || '').trim();
  const idx = t.search(/→|->|=>/);
  return (idx >= 0 ? t.slice(0, idx) : t).trim().toLowerCase();
}

function normalizeWorldEventList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((w) => {
      if (typeof w === 'string') return w.trim().replace(/^｜世界：/, '');
      return String((w && w.text) || '').trim().replace(/^｜世界：/, '');
    })
    .filter(Boolean);
}

/**
 * 把一轮摘要的增量合并进 memory.facts（就地修改 memory）
 * 世界事件优先用 turn.worldEvents；content 里若仍有旧式 ｜世界： 亦兼容解析
 * 约定/关系/知情【全量重写】：对应字段是 AI 拿着旧清单逐条核对后输出的**完整新清单**，整体替换；
 *   AI 没提到的旧条目——约定救回为 done；关系/情报排到队尾保留，随条数上限自然淘汰（保守不丢数据）；
 *   字段未提供时（如旧数据回填）对应清单不动
 * @param {Object} memory chat.memory
 * @param {{ content?: string, promises?: any[], relations?: any[], worldEvents?: any[], intel?: any[] }} turn
 */
export function applyTurnFactsToMemory(memory, turn) {
  if (!memory || typeof memory !== 'object') return;
  const facts = normalizeFacts(memory.facts);
  const deltaWorld = [
    ...normalizeWorldEventList(turn && turn.worldEvents),
    ...parseWorldEventsFromContent(turn && turn.content)
  ];

  // 约定：全量重写。AI 输出的完整清单整体替换 open 列表；
  // 旧 open 中未被 AI 提及的视为已完成/失效，救回为 done（不静默丢失，编辑器可见可改）；
  // done 只保留最近几条供查看，不注入 AI
  if (turn && Array.isArray(turn.promises)) {
    const aiList = normalizePromiseList(turn.promises);
    const aiOpen = aiList.filter((p) => p.status !== 'done').slice(0, FACTS_PROMISE_LIMIT);
    const aiTexts = new Set(aiList.map((p) => p.text.toLowerCase()));
    const rescued = facts.promises
      .filter((p) => p.status !== 'done' && !aiTexts.has(p.text.toLowerCase()))
      .map((p) => ({ text: p.text, status: 'done' }));
    const allDone = [
      ...facts.promises.filter((p) => p.status === 'done'),
      ...aiList.filter((p) => p.status === 'done'),
      ...rescued
    ];
    const seen = new Set();
    const doneMerged = [];
    for (let i = allDone.length - 1; i >= 0; i--) {
      const k = allDone[i].text.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      doneMerged.unshift(allDone[i]);
    }
    facts.promises = [...aiOpen, ...doneMerged.slice(-FACTS_PROMISE_DONE_KEEP)];
  }

  // 关系【全量重写】：AI 拿着旧清单核对后输出完整新清单，整体替换（对齐名字变体、刷新过期 note）；
  // AI 没提到的旧人物排到队尾保留（防误删静水关系），随条数上限自然淘汰；
  // 未提供 relations 字段时（如旧数据回填）不动现有关系
  if (turn && Array.isArray(turn.relations)) {
    const aiRelations = normalizeRelationList(turn.relations);
    const aiNames = new Set(aiRelations.map((r) => r.name.toLowerCase()));
    const rescued = facts.relations.filter((r) => !aiNames.has(r.name.toLowerCase()));
    facts.relations = [...rescued, ...aiRelations].slice(-FACTS_RELATION_LIMIT);
  }

  // 世界事件：同事件名保留最新阶段
  for (const text of deltaWorld) {
    const key = worldEventKey(text);
    const idx = facts.worldEvents.findIndex((w) => worldEventKey(w.text) === key);
    if (idx >= 0) facts.worldEvents[idx] = { text };
    else facts.worldEvents.push({ text });
  }
  // 完结的可保留但注入时仍带上（模型需要知道完结）；超限丢最旧
  if (facts.worldEvents.length > FACTS_WORLD_LIMIT) {
    facts.worldEvents = facts.worldEvents.slice(-FACTS_WORLD_LIMIT);
  }

  // 知情【全量重写】：AI 拿着旧清单核对后输出完整新清单（text 照抄、knownBy 给当前全量），整体替换；
  // AI 没提到的旧情报排到队尾保留（情报方向保守=安全：宁可多藏一天，不能提前泄露），随条数上限自然淘汰；
  // 未提供 intel 字段时不动现有情报
  if (turn && Array.isArray(turn.intel)) {
    const aiIntel = normalizeIntelList(turn.intel);
    const aiTexts = new Set(aiIntel.map((i) => i.text.toLowerCase()));
    const rescued = facts.intel.filter((i) => !aiTexts.has(i.text.toLowerCase()));
    facts.intel = [...rescued, ...aiIntel].slice(-FACTS_INTEL_LIMIT);
  }

  memory.facts = facts;
}

/**
 * 注入 system 的【事实备忘】正文；全空则返回 ''
 */
export function formatFactsMemo(factsRaw) {
  const facts = normalizeFacts(factsRaw);
  const lines = [];
  const openPromises = facts.promises.filter((p) => p.status !== 'done');
  if (openPromises.length) {
    lines.push('未完成约定：');
    openPromises.forEach((p, i) => lines.push(`${i + 1}. ${p.text}`));
  }
  if (facts.relations.length) {
    if (lines.length) lines.push('');
    lines.push('人物关系：');
    facts.relations.forEach((r) => {
      lines.push(`· ${r.name}${r.note ? '：' + r.note : ''}`);
    });
  }
  if (facts.worldEvents.length) {
    if (lines.length) lines.push('');
    lines.push('进行中世界事件：');
    facts.worldEvents.forEach((w) => lines.push(`· ${w.text}`));
  }
  if (facts.intel.length) {
    if (lines.length) lines.push('');
    lines.push('知情约束【硬性】：写某角色的对话/心声/动机时，仅可使用 knownBy 含该角色名、或含「公开」的情报；禁止使用其不在名单中的情报。');
    facts.intel.forEach((item) => {
      const who = item.knownBy.length ? item.knownBy.join('、') : '（暂无，仅作隐藏情报）';
      lines.push(`· 「${item.text}」可知：${who}`);
    });
  }
  if (!lines.length) return '';
  return (
    '【事实备忘】（结构化硬事实，优先于模糊回忆；与角色卡冲突时以本备忘与长期记忆为准；知情约束高于自由发挥）\n' +
    lines.join('\n')
  );
}

// 总结记忆前裁剪 AI 回复：在「行动选项」标题处截断（它是对记忆无用的选择清单），无该标题则保留全文。
const ACTION_OPTIONS_RE = /^[>\s]*#{2,6}[ \t]*行动选项.*$/m;

export function trimAssistantForMemory(content) {
  if (!content) return '';
  const text = String(content);
  const idx = text.search(ACTION_OPTIONS_RE);
  return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

// 记忆类调用（短期总结 / 长期整合 / 长期精简）使用的 API：优先用独立配置的「副 API（memoryApi）」，
// 可指向另一个服务商；未配置则回退主 API。
export function resolveMemoryApi(api) {
  const m = api && api.memoryApi;
  if (m && m.baseUrl && m.apiKey && m.model) {
    return {
      baseUrl: m.baseUrl,
      apiKey: m.apiKey,
      model: m.model,
      temperature: (m.temperature !== undefined && m.temperature !== null) ? m.temperature : api.temperature,
      temperatureEnabled: m.temperatureEnabled !== undefined ? m.temperatureEnabled : api.temperatureEnabled,
      maxTokens: (m.maxTokens !== undefined && m.maxTokens !== null) ? m.maxTokens : api.maxTokens
    };
  }
  return api;
}

/**
 * 把总结 AI 的返回解析为一条短期记忆
 * 优先取结构化字段（出场/场景/经过/变化/情绪）组装 content；
 * 模型退回旧版单段 content 时原样采用；完全无法解析时以原文兜底
 * @param {string} raw AI 原始返回
 * @param {string} fallbackDate 解析不出 date 时使用的日期
 */
export function parseTurnSummary(raw, fallbackDate) {
  const date = fallbackDate || new Date().toISOString().slice(0, 10);
  const parsed = parseJsonOrText(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const structured = composeStructuredSummary(parsed);
    const legacy = typeof parsed.content === 'string' ? parsed.content.trim() : '';
    const content = structured || legacy;
    if (content) {
      return {
        date: parsed.date || date,
        content,
        promises: normalizePromiseList(parsed.promises),
        relations: normalizeRelationList(parsed.relations),
        worldEvents: normalizeWorldEventList(parsed.worldEvents),
        intel: normalizeIntelList(parsed.intel)
      };
    }
  }
  // 兜底：把整段返回文本作为 content，结构字段空
  return { date, content: (raw || '').trim(), promises: [], relations: [], worldEvents: [], intel: [] };
}

/** 结构化字段 → 带标签的多行摘要文本（空字段省略） */
function composeStructuredSummary(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const fields = [
    ['出场', parsed.characters],
    ['场景', parsed.location],
    ['经过', parsed.events],
    ['变化', parsed.changes],
    ['情绪', parsed.mood]
  ];
  return fields
    .map(([label, v]) => (typeof v === 'string' && v.trim()) ? `${label}：${v.trim()}` : '')
    .filter(Boolean)
    .join('\n');
}

/**
 * 调用 AI 把当轮对话总结为一条短期记忆 + 事实清单增量
 * 摘要为结构化字段（出场/场景/经过/变化/情绪），由 parseTurnSummary 组装为 content 存储；
 * context 提供人名参照与前情摘要（指代消解用），显著降低摘要张冠李戴的概率
 * @param {Object} [context]
 * @param {string} [context.characterName] 角色名
 * @param {string} [context.mainControlName] 主控名
 * @param {Array<{date: string, content: string}>} [context.previousSummaries] 最近的短期摘要（前情锚点）
 * @param {string[]} [context.corrections] 主模型上报的记忆修正（extractMemoryCorrections 提取）
 * @param {Array<{text: string, status: string}>} [context.openPromises] 当前未完成约定清单（全量重写核对用）
 * @param {Array<{name: string, note: string}>} [context.currentRelations] 当前人物关系清单（全量重写核对用）
 * @param {Array<{text: string, knownBy: string[]}>} [context.currentIntel] 当前知情情报清单（全量重写核对用）
 * @returns {Promise<{date: string, content: string, promises: Array, relations: Array, worldEvents: string[], intel: Array}>}
 */
export async function summarizeTurn(userContent, assistantContent, sceneDate, knownWorldEvents = [], context = {}) {
  const config = await getConfig();
  const api = config.api || {};

  const memApi = resolveMemoryApi(api);
  if (!memApi.baseUrl || !memApi.apiKey || !memApi.model) {
    throw new Error('API 配置不完整，请先在侧边栏设置 API 信息');
  }

  const date = sceneDate || new Date().toISOString().slice(0, 10);

  // 已知世界事件清单：跳过原样重复且阶段未变的事件
  const worldNote = knownWorldEvents.length
    ? `\n已知世界事件（已在事实备忘中）：${knownWorldEvents.join('；')}\n`
    : '';

  // 人名参照与前情摘要：仅供指代消解，不参与总结
  const names = [context.characterName, context.mainControlName ? context.mainControlName + '（主控）' : '']
    .filter(Boolean).join('、');
  const contextNote = names ? `\n登场人物参照：${names}\n` : '';
  const prev = Array.isArray(context.previousSummaries)
    ? context.previousSummaries.filter(s => s && s.content)
    : [];
  const prevNote = prev.length
    ? `\n此前剧情摘要（仅供理解指代与背景，【不要】重复总结这些内容）：\n${prev.map(s => `${s.date || ''}：${s.content}`).join('\n')}\n`
    : '';

  // 记忆修正上报：主模型在回复末尾标记的记忆矛盾，按最高优先级并入事实清单
  const corrections = Array.isArray(context.corrections) ? context.corrections.filter(Boolean) : [];
  const correctionNote = corrections.length
    ? `\n记忆修正【最高优先级】：本轮 AI 回复中包含以下记忆修正上报，视为对现有记忆的权威更正——请据此修正 promises/relations/worldEvents/intel（如更新 knownBy 名单、把已失效约定置为 done、更新关系 note、更正世界事件阶段）；修正内容本身不要写进 events/changes/mood：\n${corrections.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
    : '';

  // 当前未完成约定清单：AI 逐条核对后输出全量新清单（全量重写语义，
  // 解决自由文本下「已完成」永远对不上旧条目、open 只增不消的问题）
  const openList = Array.isArray(context.openPromises) ? context.openPromises.filter(p => p && p.text) : [];
  const openNote = openList.length
    ? `\n当前未完成约定清单（promises 字段需逐条核对）：\n${openList.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}\n`
    : '';

  // 当前人物关系 / 知情情报清单：与约定同机制——AI 逐条核对后全量重写
  //（对齐名字变体、刷新过期 note、对齐情报文本与 knownBy，杜绝同一人/同一秘密多份矛盾条目）
  const relList = Array.isArray(context.currentRelations) ? context.currentRelations.filter(r => r && r.name) : [];
  const relNote = relList.length
    ? `\n当前人物关系清单（relations 字段需逐条核对）：\n${relList.map((r, i) => `${i + 1}. ${r.name}${r.note ? '：' + r.note : ''}`).join('\n')}\n`
    : '';
  const intelList = Array.isArray(context.currentIntel) ? context.currentIntel.filter(i => i && i.text) : [];
  const intelNote = intelList.length
    ? `\n当前知情情报清单（intel 字段需逐条核对）：\n${intelList.map((it, i) => `${i + 1}. 「${it.text}」可知：${(it.knownBy || []).join('、') || '（暂无）'}`).join('\n')}\n`
    : '';

  const prompt = `
请根据以下当轮对话，生成短期记忆摘要，并抽取硬事实清单（强制检查下列项，没有则空数组）。约定/关系/知情常一起变化：有泄密或隐瞒时必须在 intel 中体现。

要求：
1. 只输出一条 JSON，不要任何额外解释或代码块标记。
2. JSON 格式必须严格如下（字符串字段没有内容时留空字符串，数组没有内容时留 []）：
{
  "date":"YYYY-MM-DD",
  "characters":"本轮出场且有名有姓的人物，顿号分隔",
  "location":"本轮的剧情内时间与地点",
  "events":"关键行动与事件经过，2-4句话，保留具体数字、人名地名，每句写清主语",
  "changes":"本轮新产生的计划/状态/立场变化，没有则留空",
  "mood":"主要人物的情绪或态度转折，没有则留空",
  "promises":[{"text":"未完成或新产生的具体约定/承诺","status":"open或done"}],
  "relations":[{"name":"人物名","note":"与主控或关键人物的关系变化一句"}],
  "worldEvents":["事件名→阶段"],
  "intel":[{"text":"一条情报/秘密的简短陈述","knownBy":["可知此人的名字","主控"]}]
}
3. date 必须使用：${date}
4. 【指代铁律】所有人名一律写具体名字，禁止使用「她/他/对方/有人」指代——这条记忆会脱离上下文被单独阅读。
5. events/changes/mood 只写本轮新发生的事，不要复述前情摘要。
6. promises【强制检查·全量重写】：输出本轮之后的**完整约定清单**，不是增量——
   - 仍未完成的约定：从上方「当前未完成约定清单」中**原样照抄**文本（禁止改写、禁止遗漏），标 open；
   - 本轮完成/兑现/取消的约定：同样**原样照抄**清单中的文本，标 done；
   - 本轮新产生的约定：追加，标 open；
   - 清单为空且本轮无新约定时输出 []。不要编造。
7. relations【强制检查·全量重写】：输出本轮之后的**完整人物关系清单**——从上方「当前人物关系清单」逐条核对：没变的人物**原样照抄**（name 与 note 都不许改）；有明显变化的就地更新 note；新出现的重要人物追加。清单为空且本轮无新人物时输出 []。不要编造。
8. worldEvents【强制检查】：若回复含「🌍世界信息」模块，其中【新事件】或【阶段有变化】的长期伏笔写入本数组，格式"事件→阶段"；与已知世界事件完全重复且阶段未变的不要写入；全部为"平稳无事/无"则 []。不要编造。
9. intel【强制检查·全量重写】：输出本轮之后的**完整知情情报清单**——从上方「当前知情情报清单」逐条核对：没变的情报**原样照抄**（text 与 knownBy 都不许改）；知情范围有变化的，text 照抄并给出**当前**全量 knownBy（刚得知的人必须加入，仍应保密的人不得加入）；新出现的情报追加。knownBy 用角色名，全员公开可用「公开」。清单为空且本轮无新情报时输出 []。不要编造。
${worldNote}${contextNote}${prevNote}${correctionNote}${openNote}${relNote}${intelNote}
当轮对话：
用户：${sanitizeHistoryIllustrationMarkers(userContent)}

AI：${sanitizeHistoryIllustrationMarkers(assistantContent)}
`;

  const messages = [
    {
      role: 'system',
      content: '你是对话摘要与事实抽取助手。请严格按 JSON 输出。人名必须写具体名字，禁止任何指代词。世界事件放 worldEvents；知情放 intel（text+knownBy）。无则空字符串/空数组，禁止编造。'
    },
    { role: 'user', content: prompt }
  ];

  // 自动重试一次（网络抖动 / 临时服务错误），失败才向上抛
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await sendChat(messages, { api: memApi, usageContext: { kind: 'memory' } });
      return parseTurnSummary(raw, date);
    } catch (e) {
      lastError = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

// 长期压缩时附带的旧长期记忆条数：只读参考，够衔接最近剧情即可，成本不随历史膨胀
export const LONG_TERM_REFERENCE_COUNT = 3;

/** 旧长期记忆参考块（只读）；无参考时返回空串 */
export function formatLongTermReference(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(lt => lt && lt.content);
  if (!list.length) return '';
  return list
    .map(lt => `【${lt.startDate || ''}${lt.startDate === lt.endDate ? '' : ' 至 ' + (lt.endDate || '')}】\n${lt.content}`)
    .join('\n\n');
}

/**
 * 调用 AI 把短期记忆合并为一条长期记忆
 * 纪律：旧长期只读参考、严禁并入或重写；新条目自包含；每段记忆一生只被压缩一次
 * @param {Array<{date: string, content: string}>} shortTerm
 * @param {Object} [context]
 * @param {Array<{startDate: string, endDate: string, content: string}>} [context.previousLongTerm] 最近的旧长期记忆（只读参考）
 * @param {string} [context.factsMemo] 事实备忘注入文本（formatFactsMemo 输出）
 * @returns {Promise<{startDate: string, endDate: string, content: string}>}
 */
export async function summarizeShortTermMemories(shortTerm, context = {}) {
  const config = await getConfig();
  const api = config.api || {};

  const memApi = resolveMemoryApi(api);
  if (!memApi.baseUrl || !memApi.apiKey || !memApi.model) {
    throw new Error('API 配置不完整，请先在侧边栏设置 API 信息');
  }

  if (!Array.isArray(shortTerm) || shortTerm.length === 0) {
    throw new Error('短期记忆为空，无法整合');
  }

  const formatted = shortTerm.map(s => `${s.date}: ${s.content}`).join('\n');
  const firstDate = shortTerm[0].date;
  const lastDate = shortTerm[shortTerm.length - 1].date;

  // 只读参考：最近几条旧长期（衔接剧情弧线）+ 事实备忘（与硬事实保持一致）
  const refBlock = formatLongTermReference(context.previousLongTerm);
  const refNote = refBlock
    ? `\n【参考·只读】以下是以往的长期记忆，仅供理解背景与衔接：\n【严禁】把其中内容并入本次输出或重新总结它们；新条目必须自包含、脱离参考也能读懂，禁止「接上文 / 如前所述」式写法。\n${refBlock}\n`
    : '';
  const factsNote = (context.factsMemo || '').trim()
    ? `\n【参考·事实备忘】当前硬事实如下（由备忘单独维护，新条目不必照抄，聚焦情节叙述）：\n${context.factsMemo.trim()}\n`
    : '';

  const prompt = `
请将以下 ${shortTerm.length} 条短期记忆整合精简为一条长期记忆摘要。

短期记忆为结构化分段（出场/场景/经过/变化/情绪），整合时按情节主线组织，不必逐条对应。

要求：
1. 合并重复内容，删除琐碎细节，只保留主要情节、关键转折和重要信息。必须保留具体承诺/约定、数字、人名地名、人物关系或状态的变化，不要省略主语；人名一律写具体名字，禁止用「她/他/对方」指代——这段记忆会脱离上下文被单独阅读。
2. 变化弧线【重要】：若本轮剧情与参考中的旧状态相比发生了变化（关系/计划/立场/住处等），明确写出「由 X 变为 Y」，不要只写静态结果。
3. 世界事件已由「事实备忘」单独维护，content 不必再抄公共事件追踪表；若旧摘要里仍有"｜世界："字样可忽略或并入叙述一句即可。
4. 输出一条 JSON，不要任何额外解释。
5. JSON 格式必须严格如下：
   {"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","content":"长期记忆摘要"}
6. startDate 建议使用 ${firstDate}，endDate 建议使用 ${lastDate}（如果跨度更大可以调整）。
7. content 用一段连贯的中文叙述，不要分点，不要罗列日期。
${refNote}${factsNote}
短期记忆：
${formatted}
`;

  const raw = await sendChat([
    {
      role: 'system',
      content: '你是记忆整合助手。请把短期记忆合并精简为一段连贯的长期情节记忆，严格按 JSON 格式输出。参考内容只读，严禁并入或重写；世界事件不在此维护。'
    },
    { role: 'user', content: prompt }
  ], { api: memApi, usageContext: { kind: 'memory' } });

  const parsed = parseJsonOrText(raw);
  if (parsed && typeof parsed.content === 'string') {
    return {
      startDate: parsed.startDate || firstDate,
      endDate: parsed.endDate || lastDate,
      content: parsed.content.trim()
    };
  }

  return { startDate: firstDate, endDate: lastDate, content: raw.trim() };
}

/**
 * 调用 AI 精简长期记忆
 * @param {Array<{startDate: string, endDate: string, content: string}>} longTerm
 * @returns {Promise<Array<{startDate: string, endDate: string, content: string}>>}
 */
export async function condenseLongTermMemory(longTerm) {
  const config = await getConfig();
  const api = config.api || {};

  const memApi = resolveMemoryApi(api);
  if (!memApi.baseUrl || !memApi.apiKey || !memApi.model) {
    throw new Error('API 配置不完整，请先在侧边栏设置 API 信息');
  }

  if (!Array.isArray(longTerm) || longTerm.length === 0) {
    return [];
  }

  const formatted = longTerm.map(l =>
    `【${l.startDate}${l.startDate === l.endDate ? '' : ' 至 ' + l.endDate}】\n${l.content}`
  ).join('\n\n');

  const prompt = `
请对以下长期记忆进行精简。

要求：
1. 合并重复或相近的内容，删除对剧情影响很小的琐碎细节，保留核心情节和关键转折。必须保留具体承诺/约定、数字、人名地名、人物关系或状态的变化，不要省略主语；人名一律写具体名字，禁止用「她/他/对方」指代。
2. 世界事件由「事实备忘」维护，精简时不必保留"｜世界："列表；旧文本中的该类标记可删除。
3. 输出一个 JSON 数组，不要任何额外解释。
4. 数组中每个元素的格式：
   {"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","content":"精简后的内容"}
5. 如果多条记忆可以合并成一条，就合并；如果某条记忆已经过时或无关，可以删除。
6. content 用一段连贯的中文叙述，不要分点。

长期记忆：
${formatted}
`;

  const raw = await sendChat([
    {
      role: 'system',
      content: '你是记忆精简助手。请精简长期情节记忆，严格按 JSON 数组格式输出。世界事件不在此维护。'
    },
    { role: 'user', content: prompt }
  ], { api: memApi, usageContext: { kind: 'memory' } });

  const parsed = parseJsonOrText(raw);
  if (Array.isArray(parsed)) {
    return parsed
      .filter(item => item && typeof item.content === 'string' && item.content.trim())
      .map(item => ({
        startDate: item.startDate || longTerm[0]?.startDate || '',
        endDate: item.endDate || item.startDate || longTerm[0]?.startDate || '',
        content: item.content.trim()
      }));
  }

  // 兜底：如果 AI 没返回数组，直接返回原内容
  return longTerm;
}

/**
 * 尝试解析 AI 返回的 JSON，失败时做兜底提取
 */
function parseJsonOrText(raw) {
  if (!raw) return null;

  const cleaned = raw.trim();

  // 先尝试直接解析
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // 尝试去掉可能的 ```json ... ``` 代码块
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch (e2) {
        // ignore
      }
    }

    // 尝试提取第一个 {} 或 [] 块
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch (e3) {
        // ignore
      }
    }

    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch (e4) {
        // ignore
      }
    }
  }

  return null;
}
