/**
 * Anthropic 原生格式：/v1/messages + prompt caching + extended thinking
 */

import { sendChatStreamAuto } from './api-transport.js';
import { buildCustomHeaders } from './api-headers.js';
import { recordUsage } from './token-stats.js';

function buildAnthropicBody(messages, api, stream) {
  const systemMsg = messages.find(m => m.role === 'system');
  const dialogMsgs = messages
    .filter(m => m.role !== 'system' && !m.prefix)
    .map(({ role, content }) => ({ role, content }));

  // 断点1：静态部分（角色描述+规则+格式）放 cache_control，动态记忆不缓存
  // 记忆随对话推进持续更新，若混入断点1则哈希每轮都变，导致只创建从不命中
  // 记忆块固定以 \n\n【长期记忆】 或 \n\n【短期记忆】 开头，且总在系统消息末尾
  let system;
  if (systemMsg) {
    const text = systemMsg.content;
    const a = text.indexOf('\n\n【长期记忆】');
    const b = text.indexOf('\n\n【短期记忆】');
    const memStart = (a === -1 && b === -1) ? -1
      : (a === -1) ? b
      : (b === -1) ? a
      : Math.min(a, b);

    if (memStart === -1) {
      // 无记忆：全部静态，单块缓存
      system = [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
    } else {
      // 静态部分缓存 + 动态记忆不缓存（两块）
      system = [
        { type: 'text', text: text.slice(0, memStart), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: text.slice(memStart) }
      ];
    }
  }

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
