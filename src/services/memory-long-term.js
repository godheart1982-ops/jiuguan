// 固定十轮一级压缩：索引与原文永久保留，长期摘要只作为连续历史背景。
// 每条摘要记录来源及版本；原文编辑后立即失效，不用旧摘要覆盖新正文。

import { getConfig, saveChat } from './storage.js';
import { sendChat } from './api.js';
import { resolveMemoryApi } from './api-memory.js';

export const LONG_TERM_GROUP_SIZE = 10;
export const LONG_TERM_RESIDENT_LIMIT = 10;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* continue */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* continue */ }
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* ignore */ }
  }
  return null;
}

function validArchive(memory) {
  return (memory && Array.isArray(memory.archive) ? memory.archive : [])
    .filter((entry) => entry && entry.turnId && entry.index);
}

export function ensureLongTermSummaries(memory) {
  if (!memory || typeof memory !== 'object') return memory;
  if (!Array.isArray(memory.longTermSummaries)) memory.longTermSummaries = [];
  memory.longTermSummaries = memory.longTermSummaries.filter((item) => item && typeof item === 'object');
  return memory;
}

export function longTermGroupId(entries) {
  const first = Array.isArray(entries) ? entries[0] : null;
  return first ? `long-${first.turnId}` : '';
}

/** 按永久档案顺序切分；失效索引仍占原位，避免编辑一轮导致后续所有组错位。 */
export function partitionLongTermArchive(memory) {
  const entries = memory && Array.isArray(memory.archive) ? memory.archive.filter(Boolean) : [];
  const completeCount = Math.floor(entries.length / LONG_TERM_GROUP_SIZE) * LONG_TERM_GROUP_SIZE;
  const groups = [];
  for (let i = 0; i < completeCount; i += LONG_TERM_GROUP_SIZE) {
    groups.push(entries.slice(i, i + LONG_TERM_GROUP_SIZE));
  }
  return {
    groups,
    current: entries.slice(completeCount).filter((entry) => entry.turnId && entry.index)
  };
}

export function isLongTermSummaryCurrent(summary, memory) {
  if (!summary || summary.stale === true || !String(summary.content || '').trim()) return false;
  const ids = Array.isArray(summary.sourceTurnIds) ? summary.sourceTurnIds.map(String) : [];
  if (ids.length !== LONG_TERM_GROUP_SIZE || !summary.sourceRevisions || typeof summary.sourceRevisions !== 'object') return false;
  const archive = validArchive(memory);
  return ids.every((id) => {
    const entry = archive.find((item) => String(item.turnId) === id);
    return entry && summary.sourceRevisions[id] === entry.revision;
  });
}

export function getResidentLongTermSummaries(memory) {
  ensureLongTermSummaries(memory);
  return memory.longTermSummaries.filter((item) => isLongTermSummaryCurrent(item, memory))
    .slice(-LONG_TERM_RESIDENT_LIMIT);
}

/**
 * 常驻索引包括当前余数组，以及尚未生成/已经失效的完整组。
 * 这样副 API 失败时只会增加 token，不会直接挖掉一段历史。
 */
export function getContinuousIndexEntries(memory) {
  const { groups, current } = partitionLongTermArchive(memory);
  const uncovered = groups.filter((group) => {
    const id = longTermGroupId(group);
    const summary = memory.longTermSummaries?.find((item) => item.id === id);
    return !isLongTermSummaryCurrent(summary, memory);
  }).flat();
  return [...uncovered, ...current].filter((entry) => entry.turnId && entry.index);
}

/** 常驻覆盖ID用于召回后的普通续写去重；specific/review 与原文核验不据此排除。 */
export function getCoveredMemoryTurnIds(memory) {
  const covered = new Set(getContinuousIndexEntries(memory).map((entry) => String(entry.turnId)));
  for (const summary of getResidentLongTermSummaries(memory)) {
    for (const id of summary.sourceTurnIds || []) covered.add(String(id));
  }
  return covered;
}

function formatIndexLine(entry) {
  return `第 ${entry.round ?? '—'} 轮｜${entry.index.title || '相关对话'}：${entry.index.summary || ''}｜时间：${entry.index.sceneTime || '时间未记录'}`;
}

export function formatContinuousMemoryIndexes(memory, options = {}) {
  const rawExcluded = new Set((options.rawWindowTurnIds || []).map(String));
  const recallExcluded = new Set((options.recalledTurns || [])
    .map((recall) => recall && (recall.turnId || recall.entry?.turnId))
    .filter(Boolean).map(String));
  const entries = getContinuousIndexEntries(memory)
    .filter((entry) => !rawExcluded.has(String(entry.turnId)) && !recallExcluded.has(String(entry.turnId)));
  if (!entries.length) return '';
  return '【连续剧情脉络】（当前尚未压入长期记忆的短期组全部索引；失效长期组也暂时以索引兜底。仅用于了解前情，当前状态与最新原文优先）\n'
    + entries.map(formatIndexLine).join('\n');
}

export function formatLongTermMemories(memory) {
  const summaries = getResidentLongTermSummaries(memory);
  if (!summaries.length) return '';
  const lines = summaries.map((item) => {
    const rounds = Array.isArray(item.sourceRounds) && item.sourceRounds.length
      ? `第 ${item.sourceRounds[0] ?? '—'}～${item.sourceRounds.at(-1) ?? '—'} 轮`
      : '轮次未记录';
    const time = [item.startSceneTime, item.endSceneTime].filter(Boolean).join(' 至 ') || '时间未记录';
    return `【${item.title || '阶段回忆'}｜${rounds}｜${time}】\n${String(item.content || '').trim()}`;
  });
  return '【长期记忆】（每10轮索引一级压缩，仅作历史背景；不得覆盖当前状态、连续索引或召回详细原文。人物现状以当前状态账本和最新原文为准）\n\n' + lines.join('\n\n');
}

function memoryApiOrThrow(config) {
  const api = resolveMemoryApi((config && config.api) || {});
  if (!api.baseUrl || !api.apiKey || !api.model) throw new Error('记忆副 API 配置不完整');
  return api;
}

function makeLongTermSummary(entries, rawResult) {
  const parsed = rawResult && typeof rawResult === 'object' ? rawResult : {};
  const first = entries[0];
  const last = entries.at(-1);
  const fallback = entries.map((entry) => entry.index.summary || entry.index.title || '').filter(Boolean).join('；');
  return {
    id: longTermGroupId(entries),
    title: String(parsed.title || '').trim().slice(0, 60) || `${first.index.title || '阶段剧情'}等`,
    content: String(parsed.content || '').trim() || fallback,
    sourceTurnIds: entries.map((entry) => String(entry.turnId)),
    sourceRounds: entries.map((entry) => entry.round).filter(Number.isFinite),
    sourceRevisions: Object.fromEntries(entries.map((entry) => [String(entry.turnId), entry.revision])),
    startSceneTime: String(first.index.sceneTime || '').trim(),
    endSceneTime: String(last.index.sceneTime || '').trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stale: false
  };
}

export async function processLongTermMemory(entries, context = {}) {
  if (!Array.isArray(entries) || entries.length !== LONG_TERM_GROUP_SIZE || entries.some((entry) => !entry?.index)) {
    throw new Error(`长期记忆需要 ${LONG_TERM_GROUP_SIZE} 张连续有效索引`);
  }
  const config = await getConfig();
  const api = memoryApiOrThrow(config);
  const cards = entries.map((entry) => ({
    turnId: entry.turnId,
    round: entry.round,
    title: entry.index.title,
    summary: entry.index.summary,
    characters: entry.index.characters || [],
    location: entry.index.location || '',
    sceneTime: entry.index.sceneTime || '',
    topics: entry.index.topics || []
  }));
  const previous = context.previousLongTerm && typeof context.previousLongTerm === 'object'
    ? context.previousLongTerm : null;
  const prompt = `把以下连续10轮角色扮演索引压缩成一条可独立阅读的长期记忆。只做一级压缩，不合并更早的长期记忆。

只输出 JSON：{"title":"含主要人物与阶段事件的短标题","content":"长期记忆正文"}

正文要求：
1. 按剧情时间梳理关键事件、关系变化、重要约定与未解冲突；保留具体人名、因果和不可逆结果，不写逐轮流水账。
2. 旧长期记忆只用于衔接与消歧，禁止把其中未发生在本10轮的事件重复写进本条。
3. 不推测索引之外的事实，不把当时的情绪、地点、关系名分写成永久现状；注明已结束或被后续变化取代的状态。
4. 保留会影响后续剧情的细节，普通衣着、重复寒暄和一次性动作可省略。剧情时间以索引 sceneTime 为准，禁止使用现实时间。

【上一条长期记忆（仅参考，禁止重复收纳）】
${previous ? `${previous.title || ''}\n${previous.content || ''}` : '无'}

【本组连续10轮索引】
${JSON.stringify(cards)}`;
  const raw = await sendChat([
    { role: 'system', content: '你是连续剧情长期记忆整理助手。只输出合法 JSON，不输出解释。' },
    { role: 'user', content: prompt }
  ], { api, usageContext: { kind: 'memory' } });
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || !String(parsed.content || '').trim()) {
    throw new Error('长期记忆压缩返回格式异常，请重试');
  }
  return makeLongTermSummary(entries, parsed);
}

export function previousLongTermSummary(memory, groups, groupIndex) {
  for (let i = Math.min(groups.length, groupIndex) - 1; i >= 0; i--) {
    const id = longTermGroupId(groups[i]);
    const summary = memory.longTermSummaries?.find((item) => item.id === id);
    if (isLongTermSummaryCurrent(summary, memory)) return summary;
  }
  return null;
}

/** 自动补齐所有完整十轮组；手动改过且来源未变的摘要不会重做。 */
export async function catchUpLongTermMemories(chat, hooks = {}) {
  ensureLongTermSummaries(chat.memory);
  const { groups } = partitionLongTermArchive(chat.memory);
  const validGroupIds = new Set(groups.map(longTermGroupId));
  let generated = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    // 原轮次正在等待重建索引时保持组边界，先跳过，后面的组不受影响。
    if (group.some((entry) => !entry.index)) continue;
    const id = longTermGroupId(group);
    const existingIndex = chat.memory.longTermSummaries.findIndex((item) => item.id === id);
    const existing = existingIndex >= 0 ? chat.memory.longTermSummaries[existingIndex] : null;
    if (isLongTermSummaryCurrent(existing, chat.memory)) continue;
    hooks.onStatus?.(`正在压缩第 ${group[0].round ?? '—'}～${group.at(-1).round ?? '—'} 轮长期记忆…`, 'info');
    const previous = previousLongTermSummary(chat.memory, groups, groupIndex);
    const summary = await processLongTermMemory(group, { previousLongTerm: previous });
    if (existing && existing.createdAt) summary.createdAt = existing.createdAt;
    if (existingIndex >= 0) chat.memory.longTermSummaries[existingIndex] = summary;
    else chat.memory.longTermSummaries.push(summary);
    generated++;
    await saveChat(chat).catch(() => {});
  }
  const before = chat.memory.longTermSummaries.length;
  chat.memory.longTermSummaries = chat.memory.longTermSummaries.filter((item) => validGroupIds.has(item.id));
  if (before !== chat.memory.longTermSummaries.length) await saveChat(chat).catch(() => {});
  if (generated) hooks.onStatus?.(`已生成 ${generated} 条长期记忆`, 'success');
  return generated;
}

export async function rebuildLongTermMemory(chat, summaryId, hooks = {}) {
  ensureLongTermSummaries(chat.memory);
  const index = chat.memory.longTermSummaries.findIndex((item) => item.id === summaryId);
  if (index < 0) throw new Error('长期记忆不存在');
  const existing = chat.memory.longTermSummaries[index];
  const ids = new Set((existing.sourceTurnIds || []).map(String));
  const entries = validArchive(chat.memory).filter((entry) => ids.has(String(entry.turnId)));
  if (entries.length !== LONG_TERM_GROUP_SIZE) throw new Error('来源轮次已删除或索引失效；请先在“对话索引”页重建失效索引');
  entries.sort((a, b) => (existing.sourceTurnIds || []).indexOf(String(a.turnId)) - (existing.sourceTurnIds || []).indexOf(String(b.turnId)));
  hooks.onStatus?.(`正在重建第 ${entries[0].round ?? '—'}～${entries.at(-1).round ?? '—'} 轮长期记忆…`, 'info');
  const { groups } = partitionLongTermArchive(chat.memory);
  const groupIndex = groups.findIndex((group) => longTermGroupId(group) === summaryId);
  const previous = groupIndex > 0 ? previousLongTermSummary(chat.memory, groups, groupIndex) : null;
  const summary = await processLongTermMemory(entries, { previousLongTerm: previous });
  summary.createdAt = existing.createdAt || summary.createdAt;
  chat.memory.longTermSummaries[index] = summary;
  await saveChat(chat).catch(() => {});
  return clone(summary);
}

export function markLongTermMemoryEdited(memory, turnId) {
  if (!memory || !Array.isArray(memory.longTermSummaries)) return false;
  let changed = false;
  for (const summary of memory.longTermSummaries) {
    if ((summary.sourceTurnIds || []).map(String).includes(String(turnId))) {
      summary.stale = true;
      changed = true;
    }
  }
  return changed;
}

export function filterLongTermSummariesForTurns(memory, allowedTurnIds) {
  if (!memory || !Array.isArray(memory.longTermSummaries)) return;
  const allowed = allowedTurnIds instanceof Set ? allowedTurnIds : new Set(allowedTurnIds || []);
  memory.longTermSummaries = memory.longTermSummaries.filter((summary) =>
    Array.isArray(summary.sourceTurnIds) && summary.sourceTurnIds.length > 0
    && summary.sourceTurnIds.every((id) => allowed.has(String(id)))
  );
}
