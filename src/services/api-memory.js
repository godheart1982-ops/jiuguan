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

export function normalizeFacts(raw, mcName) {
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
  const relations = normalizeRelationList(f.relations, mcName).slice(0, FACTS_RELATION_LIMIT);
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

// 关系条目统一为边形态 {from, to, note}（"from → to：note"，读作「from 是 to 的 note」）；
// 旧星形 {name, note} 机械升级为 name → 主控（旧数据读取时自动迁移）。
// 端点归一化：提供主控真名时，「主控」端点一律映射为真名——防止图谱裂成"主控/真名"两个节点
function canonRelEndpoint(s, mcName) {
  const v = String(s || '').trim();
  const mc = String(mcName || '').trim();
  if (v === '主控' && mc) return mc;
  return v;
}

function normalizeRelationList(arr, mcName) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => {
      if (typeof r === 'string') return { from: r.trim(), to: canonRelEndpoint('主控', mcName), note: '' };
      const name = String((r && r.name) || '').trim();
      return {
        from: canonRelEndpoint(String((r && r.from) || '').trim() || name, mcName),
        to: canonRelEndpoint(String((r && r.to) || '').trim() || '主控', mcName),
        note: String((r && r.note) || '').trim()
      };
    })
    .filter((r) => r.from);
}

/** 边的全量重写匹配键：from+to 双键（端点全名纪律由提示词保证） */
function relationEdgeKey(r) {
  return (String(r.from || '') + '→' + String(r.to || '')).toLowerCase();
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
 * @param {string} [mcName] 主控真名（关系端点归一化用：「主控」→真名）
 */
export function applyTurnFactsToMemory(memory, turn, mcName) {
  if (!memory || typeof memory !== 'object') return;
  const facts = normalizeFacts(memory.facts, mcName);
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

  // 关系【全量重写】：AI 拿着旧图谱核对后输出完整新清单（按 from+to 双键对齐、刷新过期 note）；
  // AI 没提到的旧边排到队尾保留（防误删静水关系），随条数上限自然淘汰；
  // 未提供 relations 字段时（如旧数据回填）不动现有关系
  if (turn && Array.isArray(turn.relations)) {
    const aiRelations = normalizeRelationList(turn.relations, mcName);
    const aiKeys = new Set(aiRelations.map(relationEdgeKey));
    const rescued = facts.relations.filter((r) => !aiKeys.has(relationEdgeKey(r)));
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
export function formatFactsMemo(factsRaw, mcName) {
  const facts = normalizeFacts(factsRaw, mcName);
  const lines = [];
  const openPromises = facts.promises.filter((p) => p.status !== 'done');
  if (openPromises.length) {
    lines.push('未完成约定：');
    openPromises.forEach((p, i) => lines.push(`${i + 1}. ${p.text}`));
  }
  if (facts.relations.length) {
    if (lines.length) lines.push('');
    lines.push('人物关系（"A → B：关系"读作「A 是 B 的…」；边内「好感/服从/堕落/阶段」为该边最新冻结数值——角色重新出场时状态栏关系进度必须以此为续写锚点，仅当轮正文发生的事件可推动其变化，未出场期间禁止漂移）：');
    facts.relations.forEach((r) => {
      lines.push(`· ${r.from} → ${r.to}${r.note ? '：' + r.note : ''}`);
    });
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
    '【事实备忘】（结构化硬事实，优先于模糊回忆；约定/关系/知情等硬事实与角色卡冲突时以本备忘与长期记忆为准；人物性格与态度以角色卡与剧情呈现为准；知情约束高于自由发挥）\n' +
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
      maxTokens: (m.maxTokens !== undefined && m.maxTokens !== null) ? m.maxTokens : api.maxTokens,
      // 副 API 是独立服务商：只用自己的自定义请求头，不继承主 API 的（避免把会话头泄漏给别家）
      customHeaders: m.customHeaders || ''
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
 * @param {string} [context.supplement] 对话补充设定（用户手动维护，仅作理解背景）
 * @param {Array<{text: string, status: string}>} [context.openPromises] 当前未完成约定清单（全量重写核对用）
 * @param {Array<{name: string, note: string}>} [context.currentRelations] 当前人物关系清单（全量重写核对用）
 * @param {Array<{text: string, knownBy: string[]}>} [context.currentIntel] 当前知情情报清单（全量重写核对用）
 * @returns {Promise<{date: string, content: string, promises: Array, relations: Array, worldEvents: string[], intel: Array}>}
 */
export async function summarizeTurn(userContent, assistantContent, sceneDate, context = {}) {
  const config = await getConfig();
  const api = config.api || {};

  const memApi = resolveMemoryApi(api);
  if (!memApi.baseUrl || !memApi.apiKey || !memApi.model) {
    throw new Error('API 配置不完整，请先在侧边栏设置 API 信息');
  }

  const date = sceneDate || new Date().toISOString().slice(0, 10);

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

  // 对话补充设定：用户手动维护的单档补丁，作为理解背景（retcon 防摘要按旧设定写），不要总结它本身
  const supplementNote = (context.supplement || '').trim()
    ? `\n对话补充设定（用户手动维护，仅作理解背景，【不要】总结其内容本身）：\n${context.supplement.trim()}\n`
    : '';

  // 记忆修正上报：主模型在回复末尾标记的记忆矛盾，按最高优先级并入事实清单
  const corrections = Array.isArray(context.corrections) ? context.corrections.filter(Boolean) : [];
  const correctionNote = corrections.length
    ? `\n记忆修正【最高优先级】：本轮 AI 回复中包含以下记忆修正上报，视为对现有记忆的权威更正——请据此修正 promises/relations/intel（如更新 knownBy 名单、把已失效约定置为 done、更新关系 note）；修正内容本身不要写进 events/changes/mood：\n${corrections.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
    : '';

  // 当前未完成约定清单：AI 逐条核对后输出全量新清单（全量重写语义，
  // 解决自由文本下「已完成」永远对不上旧条目、open 只增不消的问题）
  const openList = Array.isArray(context.openPromises) ? context.openPromises.filter(p => p && p.text) : [];
  const openNote = openList.length
    ? `\n当前未完成约定清单（promises 字段需逐条核对）：\n${openList.map((p, i) => `${i + 1}. ${p.text}`).join('\n')}\n`
    : '';

  // 当前人物关系 / 知情情报清单：与约定同机制——AI 逐条核对后全量重写
  //（对齐名字变体、刷新过期 note、对齐情报文本与 knownBy，杜绝同一人/同一秘密多份矛盾条目）
  // 关系端点归一化：「主控」一律映射为主控真名，防止图谱裂成"主控/真名"两个节点
  const relList = normalizeRelationList(
    Array.isArray(context.currentRelations) ? context.currentRelations.filter(r => r && (r.from || r.name)) : [],
    context.mainControlName
  );
  const relNote = relList.length
    ? `\n当前人物关系图谱（relations 字段需逐条核对）：\n${relList.map((r, i) => `${i + 1}. ${r.from} → ${r.to}${r.note ? '：' + r.note : ''}`).join('\n')}\n`
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
  "relations":[{"from":"人物全名","to":"人物全名或「主控」","note":"身份关系+可选状态词，≤15字；指向主控的边须附进度数值段"}],
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
   记录门槛【三道闸，缺一不可】：①跨轮才兑现——当轮或下一轮就能随手完成的事不记；②有明确时点或触发条件——「周五来接我」记，「改天约/下次再说」不记；③不兑现会产生后果——忘了它剧情会矛盾或角色会生气的才记，纯社交寒暄、客套、无后续影响的口头约定一律不记。
   照抄例外：不符合三道闸的旧约定直接标 done 移出 open 清单（视为自然淘汰）。
   诚意标记【必须辨别】：明显敷衍/欺骗/安抚式的承诺仍然记录（它是"对方信了的债"，拆穿时是戏），但文本前加标记：【敷衍】=说说而已没打算兑现（如「【敷衍】周五陪她看电影」）；【谎言】=刻意欺骗对方（如「【谎言】保证没有别人」）。标记后可注明谁骗谁（如「（她信了，他没打算去）」）；拿不准是否真诚时按真诚记录，禁止乱标。
7. relations【强制检查·全量重写】：输出本轮之后的**完整人物关系图谱**——关系以边表示："from → to：note"，读作「from 是 to 的 note」；一段关系默认只写一行（关系天然是双向的，如「上司」自然蕴含对方是下属），仅当两边视角/认知真正不同时才追加反向行（示范：「林晚 → 苏晴：母亲（自知，瞒着苏晴）」+「苏晴 → 林晚：阿姨（误认，不知是生母）」）。反向认知行的 note 必须带认知标记（误认/不知情/以为），无标记的反向行不合法——否则一真一假两条边无法分辨哪个是事实。认知不对称的秘密本体应同时记入 intel（带 knownBy）。从上方「当前人物关系图谱」逐条核对：没变的边**原样照抄**（from/to/note 都不许改）；关系有实质变化的就地更新 note；新出现的重要关系追加。清单为空且本轮无新关系时输出 []。不要编造。
   端点规则【硬性】：端点一律使用该人物最近出现过的**全名**，禁止昵称/爱称/缩写当端点（图谱只用正式名，昵称留在正文）；涉及主控的边，主控端固定写主控的真实全名（见登场人物参照），禁止写「主控」二字。
   NPC间关系【重点·禁止遗漏】：AI 容易只盯主控的关系——本轮中 NPC 之间新建立/变化/揭示的关系（相识、结盟、结仇、亲属关系揭示等）同样必须记为边，即使主控不在场或不知情（图谱是给叙事者看的，不是主控的视野）。
   note 格式【硬性】：只写身份关系+可选的简短状态词（如「上司，手持裁员名单」「同班同学，暧昧」），≤15字；【禁止】态度描写（如"表面冷淡实则关心"）、动机/心理解释（如"因为愧疚"）、行为预测（如"会暗中帮他"）——人物性格与态度由角色卡与剧情呈现，不记入备忘。
   进度数值段【指向主控的边·必须】：本轮 AI 回复状态栏若含该角色的「关系进度」字段（好感/服从/堕落/阶段），在 note 末尾用「｜」追加数值段：｜好感X/100｜服从X/100｜堕落X/100｜阶段:Y（服从/堕落为 0 时省略该项；数值段不计入上面15字上限）。示范：「同事｜好感45/100｜阶段:信任」「青梅竹马｜好感72/100｜服从30/100｜阶段:暧昧」。NPC 之间的边不写数值段（状态栏没有它们的进度）。
   数值三条铁律【最高优先级】：①只抄不估——数值逐字抄自本轮状态栏「关系进度」原文，禁止估算/取整/凭剧情氛围编造；本轮回复中该角色无状态栏（未出场）则保留旧数值段原样，一个数字都不许动。②冻结——角色未出场期间数值视为冻结，任何总结/修正不得擅自增减（记忆修正上报未明确提及进度数值变化时同样不得改）。③照抄连带——没变的边原样照抄时数值段一并照抄；关系身份部分有实质变化就地更新时，数值段保留并仅按本轮状态栏原文刷新。
   照抄例外：旧 note 若含态度/动机/行为描写或身份状态部分超过15字，就地精简为上述格式（保留身份关系与核心状态词，数值段原样保留）。
8. intel【强制检查·全量重写】：输出本轮之后的**完整知情情报清单**——从上方「当前知情情报清单」逐条核对：没变的情报**原样照抄**（text 与 knownBy 都不许改）；知情范围有变化的，text 照抄并给出**当前**全量 knownBy（刚得知的人必须加入，仍应保密的人不得加入）；新出现的情报追加。knownBy 用角色名，全员公开可用「公开」。清单为空且本轮无新情报时输出 []。不要编造。
   记录门槛【三道闸，缺一不可】：①秘密性——有人刻意隐瞒或知情范围明显受限；双方共同经历的普通事件不记（在场者自然知道，无需追踪）；②会制约演绎——「某人不知道这件事」必须会影响他后续的言行（出轨的痕迹、未公开的裁员名单、瞒着主控的检查结果）；③有泄露路径——存在被不该知道的人撞破或透露的可能。公开信息、共同经历、无保密价值的日常一律不记。
   照抄例外：不符合三道闸的旧情报直接移除（视为自然淘汰）。
${contextNote}${prevNote}${supplementNote}${correctionNote}${openNote}${relNote}${intelNote}
当轮对话：
用户：${sanitizeHistoryIllustrationMarkers(userContent)}

AI：${sanitizeHistoryIllustrationMarkers(assistantContent)}
`;

  const messages = [
    {
      role: 'system',
      content: '你是对话摘要与事实抽取助手。请严格按 JSON 输出。人名必须写具体名字，禁止任何指代词。知情放 intel（text+knownBy）。无则空字符串/空数组，禁止编造。'
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

// ---------- 长期记忆分层注入（全文区 / 远期目录 / 调取） ----------

// 全文区条数：加星条目 + 最近 N 条未加星条目全文注入；更早的降级为目录行
export const LONG_TERM_FULL_COUNT = 10;
// 目录行最多列出的条数（最旧的超出部分只存不列）
export const LONG_TERM_CATALOG_LIMIT = 50;
// 每轮调取/召回注入上限
export const RECALL_PER_TURN_LIMIT = 2;

/** 目录标题兜底：无 title 的老条目取 content 压平截断 */
function fallbackLongTermTitle(content) {
  const flat = String(content || '').replace(/\s+/g, ' ').trim();
  return flat.length > 25 ? flat.slice(0, 25) : flat;
}

/** 目录行标题：优先压缩时生成的 title，老条目兜底截断 */
export function longTermTitleOf(entry) {
  const t = String((entry && entry.title) || '').trim();
  return t || fallbackLongTermTitle(entry && entry.content);
}

/**
 * 长期记忆注入文本：全文区（加星 + 最近 N 条）+ 远期目录 + 调取说明
 * 编号 = 条目在 longTerm 数组中的绝对序号（1-based），目录与「记忆调取：#N」凭它对齐
 * @returns {{ text: string, fullIndices: Set<number> }} fullIndices 为全文区的 0-based 下标（一次性注入去重用）
 */
export function formatLongTermInjection(longTerm) {
  const list = (Array.isArray(longTerm) ? longTerm : []).filter(lt => lt && lt.content);
  const fullIndices = new Set();
  if (!list.length) return { text: '', fullIndices };
  list.forEach((lt, i) => { if (lt.pinned === true) fullIndices.add(i); });
  const unpinned = list.map((_, i) => i).filter(i => !fullIndices.has(i));
  unpinned.slice(-LONG_TERM_FULL_COUNT).forEach(i => fullIndices.add(i));

  const fullText = list
    .map((lt, i) => {
      const start = lt.startDate || '';
      const end = lt.endDate || start;
      const header = start === end ? `【${start}】` : `【${start} 至 ${end}】`;
      return { i, block: header + '\n' + (lt.content || '') };
    })
    .filter(x => fullIndices.has(x.i))
    .map(x => x.block)
    .join('\n\n');

  const catalog = list
    .map((lt, i) => ({ lt, i }))
    .filter(x => !fullIndices.has(x.i))
    .slice(-LONG_TERM_CATALOG_LIMIT)
    .map(({ lt, i }) => {
      const start = lt.startDate || '';
      const end = lt.endDate || start;
      const date = start === end ? `【${start}】` : `【${start} 至 ${end}】`;
      return `#${i + 1} ${date}${longTermTitleOf(lt)}`;
    });

  let text = fullText;
  if (catalog.length) {
    text += (text ? '\n\n' : '') +
      '【远期记忆目录】（更早的长期记忆仅列目录；若本轮剧情涉及某条目录所述的人或事而你想不起细节，在回复末尾输出「记忆调取：#编号」，该条全文将于下一轮注入。仅在确有指向时调取、每轮最多 ' + RECALL_PER_TURN_LIMIT + ' 条、无指向禁止输出）\n' +
      catalog.join('\n');
  }
  return { text, fullIndices };
}

/** 从 AI 回复机械提取「记忆调取：#N」（记忆调取通道；不调 AI） */
export function extractMemoryRecalls(content) {
  if (!content || typeof content !== 'string') return [];
  const found = [];
  for (const m of content.matchAll(/^[>\s]*记忆调取[：:][ \t]*(.+)$/gm)) {
    for (const n of (m[1] || '').matchAll(/#?\s*(\d{1,4})/g)) {
      found.push(parseInt(n[1], 10));
    }
  }
  return [...new Set(found)].filter(Number.isFinite);
}

/**
 * 按当前稿正文重写 memory.pendingRecalls。
 * 换滑动稿时调用，避免下一轮注入没被选中的那一稿。
 * @returns {boolean} 调取清单是否变化
 */
export function syncPendingRecalls(memory, content) {
  if (!memory || typeof memory !== 'object') return false;
  const longTerm = Array.isArray(memory.longTerm) ? memory.longTerm : [];
  const recalls = extractMemoryRecalls(content)
    .filter(n => n >= 1 && n <= longTerm.length)
    .slice(0, RECALL_PER_TURN_LIMIT);
  const prev = Array.isArray(memory.pendingRecalls) ? memory.pendingRecalls : null;
  if (recalls.length) {
    const same = prev
      && prev.length === recalls.length
      && prev.every((n, i) => n === recalls[i]);
    memory.pendingRecalls = recalls;
    return !same;
  }
  if (prev) {
    delete memory.pendingRecalls;
    return true;
  }
  return false;
}

/**
 * 主控输入关键词召回：用户输入命中目录区条目的 recallKeys，返回绝对序号（1-based，命中数降序）
 * 全文区条目无需召回（已在注入）；无 recallKeys 的老条目不参与（等 ensureLongTermMeta 升级）
 */
export function matchLongTermRecalls(longTerm, userText, fullIndices, limit = RECALL_PER_TURN_LIMIT) {
  const text = String(userText || '');
  const list = (Array.isArray(longTerm) ? longTerm : []);
  const full = fullIndices instanceof Set ? fullIndices : new Set();
  if (!text.trim() || !list.length) return [];
  const scored = [];
  list.forEach((lt, i) => {
    if (!lt || !lt.content || full.has(i)) return;
    const keys = Array.isArray(lt.recallKeys) ? lt.recallKeys : [];
    let hits = 0;
    for (const k of keys) {
      const key = String(k || '').trim();
      if (key.length >= 2 && text.includes(key)) hits++;
    }
    if (hits > 0) scored.push({ n: i + 1, hits });
  });
  scored.sort((a, b) => (b.hits - a.hits) || (b.n - a.n));
  return scored.slice(0, limit).map(s => s.n);
}

/**
 * 老格式一次性升级：为未标记 metaDone 的长期记忆批量生成目录标题与召回关键词（一次副 API 调用）
 * AI 失败或未覆盖的条目用兜底标题保底（目录立即可用，recallKeys 留空=不参与关键词召回）
 * 处理过的条目标 metaDone=true，不重复调用；新格式压缩产出的条目自带元数据与本标记
 * @returns {Promise<number>} 本次处理的条数（0 = 无需升级）
 */
export async function ensureLongTermMeta(memory) {
  const list = memory && Array.isArray(memory.longTerm) ? memory.longTerm : [];
  const targets = list.filter(lt => lt && lt.content && lt.metaDone !== true);
  if (!targets.length) return 0;

  const config = await getConfig();
  const memApi = resolveMemoryApi((config && config.api) || {});
  if (memApi.baseUrl && memApi.apiKey && memApi.model) {
    const chunk = targets.slice(0, 40);
    const prompt = `以下是 ${chunk.length} 条历史剧情记忆，请为每一条生成：
1. title：目录标题，≤25字，必须含关键人名与核心事件（示范：与苏晴地铁偶遇并交换联系方式）
2. recallKeys：3-5个召回关键词，选人名/地名/事件专名，禁止泛用词（如"医院""吃饭"）
只输出一个 JSON 数组，不要任何额外解释：[{"i":1,"title":"…","recallKeys":["…"]}]，i 为条目序号。

条目：
` + chunk.map((lt, idx) => `${idx + 1}. 【${lt.startDate || ''}】${lt.content}`).join('\n\n');
    try {
      const raw = await sendChat([
        { role: 'system', content: '你是记忆索引助手。只输出 JSON 数组。' },
        { role: 'user', content: prompt }
      ], { api: memApi, usageContext: { kind: 'memory' } });
      const arr = parseJsonOrText(raw);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const t = chunk[(item && item.i) - 1];
          if (!t || !item || !item.title) continue;
          t.title = String(item.title).replace(/\s+/g, ' ').trim().slice(0, 40);
          t.recallKeys = (Array.isArray(item.recallKeys) ? item.recallKeys : [])
            .map(k => String(k || '').trim()).filter(k => k.length >= 2).slice(0, 5);
        }
      }
    } catch (e) {
      console.warn('长期记忆目录元数据 AI 生成失败，改用兜底标题:', e);
    }
  }
  // 兜底与封档：未被 AI 覆盖的给兜底标题；全部标记 metaDone，不再重复处理
  for (const lt of targets) {
    if (!String(lt.title || '').trim()) lt.title = fallbackLongTermTitle(lt.content);
    if (!Array.isArray(lt.recallKeys)) lt.recallKeys = [];
    lt.metaDone = true;
  }
  return targets.length;
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
   {"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","content":"长期记忆摘要","title":"目录标题≤25字，含关键人名与核心事件（示范：与苏晴地铁偶遇并交换联系方式）","recallKeys":["3-5个召回关键词，选人名/地名/事件专名，禁止泛用词"]}
6. startDate 建议使用 ${firstDate}，endDate 建议使用 ${lastDate}（如果跨度更大可以调整）。
7. content 用一段连贯的中文叙述，不要分点，不要罗列日期。
8. title 是给远期记忆目录用的一句话索引，recallKeys 用于用户提及旧事时的机械召回，两者都必须脱离 content 也成立。
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
    const title = String(parsed.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const recallKeys = (Array.isArray(parsed.recallKeys) ? parsed.recallKeys : [])
      .map(k => String(k || '').trim()).filter(k => k.length >= 2).slice(0, 5);
    return {
      startDate: parsed.startDate || firstDate,
      endDate: parsed.endDate || lastDate,
      content: parsed.content.trim(),
      title: title || fallbackLongTermTitle(parsed.content),
      recallKeys,
      metaDone: true
    };
  }

  return { startDate: firstDate, endDate: lastDate, content: raw.trim(), title: fallbackLongTermTitle(raw), recallKeys: [], metaDone: true };
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
