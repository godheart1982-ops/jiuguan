/**
 * Anthropic 原生格式：/v1/messages + prompt caching + extended thinking
 */

import { sendChatStreamAuto } from './api-transport.js';
import { buildCustomHeaders } from './api-headers.js';
import { recordUsage } from './token-stats.js';
import { foldExtraSystemIntoDialog } from './author-note.js';

const LONG_TERM_MARKER = '\n\n【长期记忆】';
const PER_TURN_DYNAMIC_MARKERS = [
  '\n\n【当前状态账本】',
  '\n\n【连续剧情脉络】',
  '\n\n【短期记忆】',
  '\n\n【召回的历史记忆】',
  '\n\n【对话补充设定】',
  '\n\n【插图种子档案】'
];

function earliestIndex(text, markers, fromIndex = 0) {
  let best = -1;
  for (const marker of markers) {
    const idx = text.indexOf(marker, fromIndex);
    if (idx !== -1 && (best === -1 || idx < best)) {
      best = idx;
    }
  }
  return best;
}

/**
 * 切分 Anthropic system 文本：
 * - 断点 1：静态前缀（角色卡/世界书/格式/规则）永久缓存；
 * - 断点 2（若紧跟【长期记忆】）：每 10 轮才更新一次的长期记忆单独缓存（10 轮命中 9 轮）；
 * - 尾段：每轮变化的动态记忆（当前状态账本/连续脉络/召回等）不缓存。
 */
export function splitSystemForCache(text) {
  const raw = String(text || '');
  const longTermStart = raw.indexOf(LONG_TERM_MARKER);
  const dynamicStart = earliestIndex(raw, PER_TURN_DYNAMIC_MARKERS);

  // 无长期记忆、或长期记忆排在每轮动态块之后：退回双块（静态缓存 + 动态不缓存）
  if (longTermStart === -1 || (dynamicStart !== -1 && dynamicStart < longTermStart)) {
    const splitAt = (longTermStart === -1)
      ? dynamicStart
      : (dynamicStart === -1 ? longTermStart : Math.min(longTermStart, dynamicStart));
    if (splitAt === -1) {
      return [{ type: 'text', text: raw, cache_control: { type: 'ephemeral' } }];
    }
    if (splitAt === 0) {
      return [{ type: 'text', text: raw }];
    }
    return [
      { type: 'text', text: raw.slice(0, splitAt), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: raw.slice(splitAt) }
    ];
  }

  // 长期记忆紧接静态前缀之后：最多三块（静态缓存 + 长期记忆缓存 + 每轮动态不缓存）
  const afterLongTerm = earliestIndex(raw, PER_TURN_DYNAMIC_MARKERS, longTermStart + LONG_TERM_MARKER.length);
  const blocks = [];
  if (longTermStart > 0) {
    blocks.push({ type: 'text', text: raw.slice(0, longTermStart), cache_control: { type: 'ephemeral' } });
  }
  if (afterLongTerm === -1) {
    blocks.push({ type: 'text', text: raw.slice(longTermStart), cache_control: { type: 'ephemeral' } });
  } else {
    blocks.push({ type: 'text', text: raw.slice(longTermStart, afterLongTerm), cache_control: { type: 'ephemeral' } });
    blocks.push({ type: 'text', text: raw.slice(afterLongTerm) });
  }
  return blocks;
}

function buildAnthropicBody(messages, api, stream) {
  const systemMsg = messages.find(m => m.role === 'system');
  const dialogMsgs = foldExtraSystemIntoDialog(messages);

  const system = systemMsg ? splitSystemForCache(systemMsg.content) : undefined;

  // 断点2已移除：倒数第二条 user 的位置每轮后移一格，
  // 每轮都新建缓存但从不命中，徒耗断点配额，无实际收益

  // 推理强度（原生 extended thinking）：档位 → budget_tokens
  const THINKING_BUDGET = { low: 4000, medium: 10000, high: 16000 };
  const budget = THINKING_BUDGET[api.reasoningEffort];
  // 正文额度：Max Tokens 设了就用，没设默认 8192
  const bodyBudget = api.maxTokens || 8192;

  const body = {
    model: api.model,
    // 开思考时 max_tokens 必须 > budget（它是「思考+正文」总和），自动叠加
    max_tokens: budget ? budget + bodyBudget : (api.maxTokens || 4096),
    messages: dialogMsgs,
    stream
  };
  if (system) body.system = system;

  if (budget) {
    // 开思考：带 thinking 参数；协议要求此时不发 temperature（否则 400）
    body.thinking = { type: 'enabled', budget_tokens: budget };
  } else if (api.temperatureEnabled !== false) {
    body.temperature = api.temperature ?? 0.8;
  }

  return body;
}

function anthropicHeaders(apiKey, customRaw, chatId) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'prompt-caching-2024-07-31',
    // 自定义请求头（含 {{chatId}} 占位）：放最后，允许覆盖同名默认头
    ...buildCustomHeaders(customRaw, chatId)
  };
}

// Anthropic SSE 是两行一组（event: X + data: {...}），需要有状态解析器
// 原生 extended thinking 走 thinking_delta，正文走 text_delta；
// showThinking=true 时把思考流包进 <思考></思考>，复用现有折叠 UI；
// showThinking=false（默认）时静默丢弃思考块，只输出正文
// usage 统计：message_start 带输入/缓存 token，message_delta 带输出 token，message_stop 时统一上报
function makeAnthropicSSEParser(onChunk, showThinking, onUsage) {
  let lastEvent = '';
  let inThinking = false;   // 是否正在接收思考块
  let thinkingClosed = false; // 思考标签是否已闭合
  let usageAcc = null;      // 累积 usage

  const closeThinking = () => {
    if (inThinking && !thinkingClosed) {
      thinkingClosed = true;
      inThinking = false;
      onChunk('</思考>\n\n');
      return '</思考>\n\n';
    }
    return '';
  };

  return function(line) {
    const t = line.trim();
    if (!t) return '';
    if (t.startsWith('event: ')) { lastEvent = t.slice(7).trim(); return ''; }
    if (!t.startsWith('data: ')) return '';

    if (lastEvent === 'message_start') {
      try {
        const d = JSON.parse(t.slice(6));
        if (d.message?.usage) usageAcc = { ...d.message.usage };
      } catch (e) {}
      return '';
    }

    if (lastEvent === 'message_delta') {
      try {
        const d = JSON.parse(t.slice(6));
        if (d.usage) {
          usageAcc = { ...(usageAcc || {}), ...d.usage };
        }
      } catch (e) {}
      return '';
    }

    if (lastEvent === 'message_stop') {
      if (usageAcc && onUsage) onUsage(usageAcc);
      return '';
    }

    if (lastEvent === 'content_block_delta') {
      try {
        const d = JSON.parse(t.slice(6));
        // 思考增量：showThinking 关闭时静默丢弃
        if (d.delta?.type === 'thinking_delta' && d.delta.thinking) {
          if (!showThinking) return '';
          let out = '';
          if (!inThinking && !thinkingClosed) { inThinking = true; out += '<思考>'; onChunk('<思考>'); }
          onChunk(d.delta.thinking);
          return out + d.delta.thinking;
        }
        // 正文增量：若思考还开着（showThinking=true 时才可能），先闭合再输出正文
        if (d.delta?.type === 'text_delta' && d.delta.text) {
          const closed = closeThinking();
          onChunk(d.delta.text);
          return closed + d.delta.text;
        }
      } catch (e) {}
    }
    return '';
  };
}

export async function sendChatAnthropic(messages, api) {
  const body = buildAnthropicBody(messages, api, false);
  const response = await fetch(`${api.baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    headers: anthropicHeaders(api.apiKey, api.customHeaders),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    let errorText = '';
    try {
      const text = await response.text();
      try { errorText = JSON.parse(text).error?.message || text; } catch { errorText = text; }
    } catch { errorText = '无法读取错误响应'; }
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  // 开思考时 content 里会有 thinking 块在前、text 块在后
  // showThinking=true 才展示思考；false（默认）则静默丢弃，只返回正文
  const blocks = Array.isArray(data.content) ? data.content : [];
  const thinking = blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('');
  const textOut = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
  const content = (thinking && api.showThinking === true)
    ? '<思考>' + thinking + '</思考>\n\n' + textOut
    : (textOut || data.content?.[0]?.text || '');
  return { content, usage: data.usage || null };
}

export async function sendChatStreamAnthropic(messages, callbacks, api, controller, usageContext = {}) {
  const body = buildAnthropicBody(messages, api, true);
  const url = `${api.baseUrl.replace(/\/$/, '')}/messages`;
  const headers = anthropicHeaders(api.apiKey, api.customHeaders, usageContext.chatId);
  const bodyStr = JSON.stringify(body);
  const onUsage = (usage) => {
    recordUsage(usage, 'anthropic', { ...usageContext, model: api.model });
    if (callbacks.onUsage) callbacks.onUsage(usage);
  };
  const parser = makeAnthropicSSEParser(callbacks.onChunk, api.showThinking === true, onUsage);
  await sendChatStreamAuto(url, headers, bodyStr, controller, callbacks, parser);
}
