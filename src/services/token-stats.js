/**
 * Token 用量统计：从 API 响应的 usage 字段记录输入/输出/缓存 token，按天+角色卡聚合
 */

import { getTokenStats, saveTokenStats } from './storage.js';

/**
 * 归一化各协议的 usage 字段
 * OpenAI/DeepSeek: prompt_tokens / completion_tokens / prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * Anthropic: input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
 */
function normalizeUsage(usage, format) {
  if (!usage || typeof usage !== 'object') return null;
  if (format === 'anthropic') {
    return {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0
    };
  }
  // OpenAI 兼容；DeepSeek 附带缓存命中/未命中细分
  const promptTokens = usage.prompt_tokens || 0;
  const cacheRead = usage.prompt_cache_hit_tokens || 0;
  const cacheMiss = usage.prompt_cache_miss_tokens || 0;
  return {
    // 有缓存细分时，input 只算未命中部分，避免与 cacheRead 重复计数
    input: cacheMiss > 0 ? cacheMiss : Math.max(0, promptTokens - cacheRead),
    output: usage.completion_tokens || 0,
    cacheRead,
    cacheWrite: 0
  };
}

function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

function addTo(bucket, entry) {
  bucket.input += entry.input;
  bucket.output += entry.output;
  bucket.cacheRead += entry.cacheRead;
  bucket.cacheWrite += entry.cacheWrite;
  bucket.requests += 1;
}

/**
 * 记录一次 API 调用的 token 用量（异步落盘，失败静默，不影响主流程）
 * @param {Object} usage API 响应的 usage 字段
 * @param {string} format 'openai' | 'anthropic'
 * @param {Object} context { characterId, characterName, kind: 'chat'|'memory', model }
 */
export async function recordUsage(usage, format, context = {}) {
  const entry = normalizeUsage(usage, format);
  if (!entry) return;
  if (!entry.input && !entry.output && !entry.cacheRead && !entry.cacheWrite) return;

  try {
    const stats = await getTokenStats();
    const day = new Date().toISOString().slice(0, 10);
    if (!stats.days[day]) {
      stats.days[day] = { total: emptyBucket(), chars: {}, models: {} };
    }
    const dayStats = stats.days[day];
    addTo(dayStats.total, entry);

    // 按角色卡聚合；记忆总结归入「记忆总结」伪角色
    const charKey = context.kind === 'memory'
      ? '_memory'
      : (context.characterId || '_other');
    const charName = context.kind === 'memory'
      ? '记忆总结'
      : (context.characterName || '其他');
    if (!dayStats.chars[charKey]) {
      dayStats.chars[charKey] = { name: charName, ...emptyBucket() };
    }
    dayStats.chars[charKey].name = charName; // 角色改名后跟随最新名字
    addTo(dayStats.chars[charKey], entry);

    // 按模型聚合（模型名在 api 层自动记录；旧数据无此字段，不影响）
    if (!dayStats.models) dayStats.models = {};
    const modelName = context.model || '未知模型';
    if (!dayStats.models[modelName]) {
      dayStats.models[modelName] = emptyBucket();
    }
    addTo(dayStats.models[modelName], entry);

    // 只保留最近 90 天，防止文件无限增长
    const dayKeys = Object.keys(stats.days).sort();
    while (dayKeys.length > 90) {
      delete stats.days[dayKeys.shift()];
    }

    await saveTokenStats(stats);
  } catch (e) {
    console.warn('记录 token 用量失败:', e);
  }
}

/**
 * 汇总统计：今日 / 本月 / 累计 / 按角色累计 / 按模型累计
 */
export function summarizeStats(stats) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const result = {
    today: emptyBucket(),
    month: emptyBucket(),
    allTime: emptyBucket(),
    charTotals: {},  // charKey -> { name, ...bucket }
    modelTotals: {}  // modelName -> bucket
  };

  for (const [day, dayStats] of Object.entries(stats.days || {})) {
    const t = dayStats.total || emptyBucket();
    if (day === today) {
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'requests']) result.today[k] += t[k] || 0;
    }
    if (day.startsWith(month)) {
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'requests']) result.month[k] += t[k] || 0;
    }
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'requests']) result.allTime[k] += t[k] || 0;

    for (const [charKey, charBucket] of Object.entries(dayStats.chars || {})) {
      if (!result.charTotals[charKey]) {
        result.charTotals[charKey] = { name: charBucket.name || charKey, ...emptyBucket() };
      }
      result.charTotals[charKey].name = charBucket.name || result.charTotals[charKey].name;
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'requests']) {
        result.charTotals[charKey][k] += charBucket[k] || 0;
      }
    }

    // 按模型累计：旧数据无 models 字段，差额归入「未知模型」
    const modelDayTotal = emptyBucket();
    for (const [modelName, modelBucket] of Object.entries(dayStats.models || {})) {
      if (!result.modelTotals[modelName]) {
        result.modelTotals[modelName] = emptyBucket();
      }
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'requests']) {
        result.modelTotals[modelName][k] += modelBucket[k] || 0;
        modelDayTotal[k] += modelBucket[k] || 0;
      }
    }
    // 当天总消耗与模型分类合计的差额 = 未记录模型的旧数据
    const gap = {
      input: (t.input || 0) - modelDayTotal.input,
      output: (t.output || 0) - modelDayTotal.output,
      cacheRead: (t.cacheRead || 0) - modelDayTotal.cacheRead,
      cacheWrite: (t.cacheWrite || 0) - modelDayTotal.cacheWrite,
      requests: (t.requests || 0) - modelDayTotal.requests
    };
    if (gap.input > 0 || gap.output > 0 || gap.requests > 0) {
      if (!result.modelTotals['未知模型']) {
        result.modelTotals['未知模型'] = emptyBucket();
      }
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'requests']) {
        result.modelTotals['未知模型'][k] += Math.max(0, gap[k]);
      }
    }
  }

  return result;
}
