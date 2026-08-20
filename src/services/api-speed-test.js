/**
 * API 测速 / 跑分
 *
 * 快速测速 = 1 次流式请求；完整跑分 = 预热 1 轮（不计入统计、只计入总 Token）+ 正式 N 轮。
 * 计时：首 Token 延迟（请求发出 → 首个可见内容块，含思考块）、总延迟。
 * token 数优先取 API 返回的 usage，拿不到（部分平台不吐 usage）用本地估算兜底。
 * 格式遵循：固定提示词要求输出 4 行简化状态栏 + 一段正文，机械校验字段标记是否齐全，
 * 贴近本 App 状态栏实战，不做通用 JSON 校验。
 */

import { parseSSELine, makeOpenAISSEParser, sendChatStreamAuto } from './api-transport.js';
import { sendChatStreamAnthropic } from './api-anthropic.js';
import { countTokens } from '../utils/tokenizer.js';

export const SPEED_TEST_MAX_TOKENS = 400;
export const SPEED_TEST_DEFAULT_ROUNDS = 8;
export const SPEED_TEST_MAX_RECORDS = 50;
export const SPEED_TEST_ROUND_TIMEOUT_MS = 120 * 1000;

// 格式遵循校验的字段标记（与提示词一一对应）
export const SPEED_TEST_FORMAT_MARKERS = ['📅日期', '🗺️地点', '🏞环境', '💕心声'];

/**
 * 固定测速提示词：4 行简化状态栏 + 一段正文。
 * 格式可机械校验（四个字段标记），正文保证足够输出量，token/s 才有意义。
 * @param {string} thinkingMode 'off' | 'prompt' | 'native'（prompt 模式加一行思考指令，贴近实战 TTFT）
 */
export function buildSpeedTestPrompt(thinkingMode) {
  const thinkLine = thinkingMode === 'prompt' ? '先输出一行以「思考：」开头的简短规划，然后' : '';
  return `请严格按以下格式输出一个场景片段（${thinkLine}先写 4 行状态栏，再写一段正文，除此之外不要输出任何其他内容）：
📅日期:2026年8月1日_星期六  🕑时间:14:30
🗺️地点:中国_上海_静安区_街角咖啡馆
🏞环境:(不超过2个分句的场景环境描写)
💕心声:(不超过2个分句的咖啡店老板娘心声)

（另起一段）正文：100~150 字的第三人称场景描写。`;
}

/** 格式遵循机械校验：四个字段标记齐全且总长度达标（防只写状态栏漏正文） */
export function checkFormatCompliance(content) {
  if (!content) return false;
  return SPEED_TEST_FORMAT_MARKERS.every((m) => content.includes(m)) && content.trim().length >= 100;
}

/** 最近位次分位数（nearest-rank）；空数组返回 null */
export function percentile(values, p) {
  const nums = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!nums.length) return null;
  const rank = Math.ceil((p / 100) * nums.length) - 1;
  return nums[Math.min(Math.max(rank, 0), nums.length - 1)];
}

/**
 * 汇总正式轮统计
 * @param {Array} runs [{ ttftMs, totalMs, inTokens, outTokens, formatPass }]
 * @param {number} elapsedMs 正式阶段墙钟耗时（含轮间间隙，用于请求/分钟）
 */
export function summarizeRuns(runs, elapsedMs) {
  const n = (runs || []).length;
  if (!n) return null;
  const sum = (f) => runs.reduce((acc, r) => acc + (Number.isFinite(f(r)) ? f(r) : 0), 0);
  const totalOut = sum((r) => r.outTokens);
  const totalIn = sum((r) => r.inTokens);
  const genSec = sum((r) => Math.max(0, r.totalMs - r.ttftMs)) / 1000;
  const totalSec = sum((r) => r.totalMs) / 1000;
  const passed = runs.filter((r) => r.formatPass).length;
  return {
    rounds: n,
    ttftP50Ms: percentile(runs.map((r) => r.ttftMs), 50),
    totalP95Ms: percentile(runs.map((r) => r.totalMs), 95),
    // 输出 Token/s：首 Token 之后的纯生成速度；总体：含首 Token 等待
    outTokPerSec: genSec > 0 ? totalOut / genSec : null,
    overallTokPerSec: totalSec > 0 ? totalOut / totalSec : null,
    rpm: elapsedMs > 0 ? n / (elapsedMs / 60000) : null,
    formatPassPct: Math.round((passed / n) * 100),
    totalTokens: totalIn + totalOut // 不含预热，调用方自行叠加
  };
}

/** 记录列表追加（新纪录插最前，超出上限截断） */
export function appendSpeedTestRecord(records, record, max = SPEED_TEST_MAX_RECORDS) {
  return [record, ...(Array.isArray(records) ? records : [])].slice(0, max);
}

/** DeepSeek 余额（该平台有 /user/balance 公开接口）；其它平台返回 null，UI 显示「平台未提供」 */
export async function fetchDeepSeekBalance(apiConfig) {
  if (!/deepseek\.com/i.test((apiConfig && apiConfig.baseUrl) || '')) return null;
  try {
    const resp = await fetch(`${apiConfig.baseUrl.replace(/\/$/, '')}/user/balance`, {
      headers: { Authorization: `Bearer ${apiConfig.apiKey}` }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    if (!infos.length) return null;
    return infos.map((i) => `${i.total_balance} ${i.currency}`).join(' / ');
  } catch (e) {
    return null;
  }
}

/**
 * 单轮流式请求，计时 + 收集 token 数与全文
 * @returns {Promise<{ttftMs, totalMs, inTokens, outTokens, content, aborted}>}
 */
export function runSpeedTestRound(apiConfig, prompt) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const start = performance.now();
    let ttftMs = null;
    let usage = null;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { controller.abort(); } catch (e) { /* ignore */ }
      reject(new Error('单轮超时（120 秒）'));
    }, SPEED_TEST_ROUND_TIMEOUT_MS);

    const callbacks = {
      onChunk: () => { if (ttftMs === null) ttftMs = performance.now() - start; },
      onUsage: (u) => { usage = u; },
      onError: (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(msg || '流式请求失败'));
      },
      onDone: (content, aborted) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const totalMs = performance.now() - start;
        const outFromUsage = usage ? (usage.completion_tokens ?? usage.output_tokens ?? 0) : 0;
        const inFromUsage = usage ? (usage.prompt_tokens ?? usage.input_tokens ?? 0) : 0;
        resolve({
          ttftMs: ttftMs === null ? totalMs : ttftMs,
          totalMs,
          inTokens: inFromUsage,
          outTokens: outFromUsage || countTokens(content),
          content: content || '',
          aborted: aborted === true
        });
      }
    };

    if ((apiConfig.format || 'openai') === 'anthropic') {
      // Anthropic 路径内部会按 reasoningEffort 附加 thinking 参数并回传 usage
      sendChatStreamAnthropic(
        [{ role: 'user', content: prompt }],
        callbacks,
        { ...apiConfig, maxTokens: SPEED_TEST_MAX_TOKENS },
        controller,
        { kind: 'speedtest' }
      ).catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(e);
      });
      return;
    }

    const body = {
      model: apiConfig.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: SPEED_TEST_MAX_TOKENS,
      // 请求末尾吐 usage；平台不支持会静默忽略，走本地估算兜底
      stream_options: { include_usage: true }
    };
    if (apiConfig.temperatureEnabled !== false) {
      body.temperature = apiConfig.temperature !== undefined && apiConfig.temperature !== null ? apiConfig.temperature : 0.8;
    }
    if (apiConfig.deepseekThinking) {
      body.thinking = { type: 'enabled', reasoning_effort: apiConfig.deepseekReasoningEffort || 'high' };
    }
    const url = `${apiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey}`
    };
    // 思考显隐跟随配置：显示推理时思考块也触发 onChunk，TTFT = 首个可见 token（与聊天页观感一致）
    const parseLine = apiConfig.deepseekThinking
      ? makeOpenAISSEParser(callbacks, { showThinking: apiConfig.showThinking === true, onUsage: callbacks.onUsage })
      : (line) => parseSSELine(line, callbacks.onChunk, callbacks.onUsage);
    sendChatStreamAuto(url, headers, JSON.stringify(body), controller, callbacks, parseLine)
      .catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(e);
      });
  });
}

/**
 * 测速入口
 * @param {Object} apiConfig 表单当前读取的 API 配置（不要求已保存）
 * @param {Object} opts { mode: 'quick'|'full', rounds, thinkingMode, onProgress }
 * @returns {Promise<{ summary, balance, warmupTokens }>}
 */
export async function runSpeedTest(apiConfig, opts = {}) {
  const mode = opts.mode === 'full' ? 'full' : 'quick';
  const countedTarget = mode === 'full'
    ? Math.max(3, Math.min(20, parseInt(opts.rounds, 10) || SPEED_TEST_DEFAULT_ROUNDS))
    : 1;
  const prompt = buildSpeedTestPrompt(opts.thinkingMode || 'off');
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  // 预热：仅完整跑分；不计入统计，只计入总 Token
  let warmupTokens = 0;
  if (mode === 'full') {
    onProgress('预热中…');
    const w = await runSpeedTestRound(apiConfig, prompt);
    warmupTokens = w.inTokens + w.outTokens;
  }

  const runs = [];
  const start = performance.now();
  for (let i = 0; i < countedTarget; i++) {
    onProgress(mode === 'full' ? `第 ${i + 1}/${countedTarget} 轮…` : '测速中…');
    const run = await runSpeedTestRound(apiConfig, prompt);
    run.formatPass = checkFormatCompliance(run.content);
    runs.push(run);
  }
  const elapsedMs = performance.now() - start;

  const summary = summarizeRuns(runs, elapsedMs);
  summary.totalTokens += warmupTokens;
  const balance = await fetchDeepSeekBalance(apiConfig);
  return { summary, balance, warmupTokens };
}
