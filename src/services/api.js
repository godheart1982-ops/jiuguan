/**
 * OpenAI 兼容 API 调用服务（入口）
 * 协议路由：OpenAI 兼容路径在此实现，Anthropic 原生路径委托给 api-anthropic.js
 */

import { getConfig } from './storage.js';
import { THINKING_PREFILL } from './api-messages.js';
import { wrapCallbacksWithPrefill, resolvePrefillUrl, sendChatStreamAuto, parseSSELine, makeOpenAISSEParser } from './api-transport.js';
import { buildCustomHeaders } from './api-headers.js';
import { sendChatAnthropic, sendChatStreamAnthropic } from './api-anthropic.js';
import { recordUsage } from './token-stats.js';

/**
 * 发送非流式聊天请求，一次性返回完整回复
 * @param {Array} messages OpenAI 格式的 messages 数组
 * @returns {Promise<string>} AI 回复的完整内容
 */
export async function sendChat(messages, options = {}) {
  const config = await getConfig();
  const api = config.api || {};
  const useApi = options.api || api;

  if (!useApi.baseUrl || !useApi.apiKey || !useApi.model) {
    throw new Error('API 配置不完整，请先在侧边栏设置 API 信息');
  }

  if ((useApi.format || 'openai') === 'anthropic') {
    const result = await sendChatAnthropic(messages, useApi);
    if (result && result.usage) {
      recordUsage(result.usage, 'anthropic', { ...options.usageContext, model: useApi.model });
    }
    return result ? result.content : '';
  }

  const body = {
    model: useApi.model,
    messages: messages,
    stream: false
  };
  // temperatureEnabled === false 时不发送 temperature（Claude Sonnet 5 / Opus 4.7+ 等已废弃温度参数，传非默认值会 400）
  if (useApi.temperatureEnabled !== false) {
    body.temperature = useApi.temperature !== undefined && useApi.temperature !== null ? useApi.temperature : 0.8;
  }
  if (useApi.maxTokens) {
    body.max_tokens = useApi.maxTokens;
  }

  const url = `${useApi.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const fetchOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${useApi.apiKey}`,
      // 自定义请求头（含 {{chatId}} 占位）：放最后，允许覆盖同名默认头
      ...buildCustomHeaders(useApi.customHeaders, options.chatId)
    },
    body: JSON.stringify(body)
  };

  // 自动重试一次：仅对网络错误、429、5xx 重试；4xx（除429）直接报错
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, fetchOpts);
      if (!response.ok) {
        let errorText = '';
        try {
          const text = await response.text();
          try {
            const errorData = JSON.parse(text);
            errorText = errorData.error?.message || JSON.stringify(errorData);
          } catch (parseErr) {
            errorText = text;
          }
        } catch (e) {
          errorText = '无法读取错误响应';
        }
        const err = new Error(`API 请求失败 (${response.status}): ${errorText}`);
        err._status = response.status;
        throw err;
      }
      const data = await response.json();
      if (data.usage) {
        recordUsage(data.usage, 'openai', { ...options.usageContext, model: useApi.model });
      }
      const msg = data.choices?.[0]?.message;
      const content = msg?.content || '';
      // DeepSeek 推理模式：reasoning_content 拼入正文前
      if (useApi.deepseekThinking && msg?.reasoning_content) {
        if (useApi.showThinking !== false) {
          return `<思考>\n${msg.reasoning_content}\n</思考>\n\n${content}`;
        }
      }
      return content;
    } catch (e) {
      lastError = e;
      const status = e._status;
      // 4xx（除 429）直接报错，重试没有意义
      if (status && status >= 400 && status < 500 && status !== 429) throw e;
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, status === 429 ? 1000 : 500));
      }
    }
  }
  throw lastError;
}

/**
 * 发送流式聊天请求
 * @param {Array} messages OpenAI 格式的 messages 数组
 * @param {Object} callbacks 回调：{ onChunk, onError, onDone }
 * @param {Object} usageContext 可选，token 统计上下文：{ characterId, characterName, kind }
 * @returns {AbortController} 可用于中断生成
 */
export function sendChatStream(messages, callbacks, usageContext = {}) {
  const controller = new AbortController();

  // 思维链预填充：messages 末尾是预填开头时，源头拼回并去重，保证显示/存储层拿到完整回复
  const lastMsg = messages[messages.length - 1];
  const prefill = (lastMsg && lastMsg.role === 'assistant' && lastMsg.content === THINKING_PREFILL) ? THINKING_PREFILL : '';
  const cb = prefill ? wrapCallbacksWithPrefill(callbacks, prefill) : callbacks;

  (async () => {
    let config;
    try {
      config = await getConfig();
    } catch (e) {
      cb.onError('读取 API 配置失败：' + (e.message || String(e)));
      return;
    }
    const api = (usageContext && usageContext.api) || config.api || {};

    if (!api.baseUrl || !api.apiKey || !api.model) {
      cb.onError('API 配置不完整，请先在侧边栏设置 API 信息');
      return;
    }

    if ((api.format || 'openai') === 'anthropic') {
      let chunksReceived = 0;
      const trackedCb = {
        ...cb,
        onChunk: cb.onChunk ? (chunk) => { chunksReceived++; cb.onChunk(chunk); } : cb.onChunk
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await sendChatStreamAnthropic(messages, trackedCb, api, controller, usageContext);
          return;
        } catch (error) {
          if (error.name === 'AbortError') { cb.onDone('', true); return; }
          if (attempt === 0 && chunksReceived === 0) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          cb.onError(error.message || String(error)); return;
        }
      }
      return;
    }

    const body = {
      model: api.model,
      messages: messages,
      stream: true
    };
    if (api.temperatureEnabled !== false) {
      body.temperature = api.temperature !== undefined ? api.temperature : 0.8;
    }
    if (api.maxTokens) {
      body.max_tokens = api.maxTokens;
    }
    // DeepSeek 推理模式：附加 thinking 参数和强度
    if (api.deepseekThinking) {
      body.thinking = { type: 'enabled', reasoning_effort: api.deepseekReasoningEffort || 'high' };
    }
    // 流式响应末尾附带 usage 字段（token 统计用）
    body.stream_options = { include_usage: true };

    // 思维链预填充生效时，DeepSeek 官方接口走 beta 前缀续写端点，火山方舟走原生续写（无需标记）
    const url = prefill ? resolvePrefillUrl(api.baseUrl) : `${api.baseUrl.replace(/\/$/, '')}/chat/completions`;
    // 判断是否为 DeepSeek 官方端点：只有 DeepSeek 需要在 messages 里保留 prefix:true 标记
    const isDeepSeek = /^https?:\/\/api\.deepseek\.com/i.test(url);
    if (prefill && !isDeepSeek) {
      // 火山方舟及其他：移除 prefix 标记，保留 assistant 消息作为续写起点
      body.messages = body.messages.map(m => {
        if (m.role === 'assistant' && m.content === THINKING_PREFILL && m.prefix === true) {
          const { prefix, ...rest } = m;
          return rest;
        }
        return m;
      });
    }
    const requestBody = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api.apiKey}`,
      // 自定义请求头（含 {{chatId}} 占位）：放最后，允许覆盖同名默认头
      ...buildCustomHeaders(api.customHeaders, usageContext.chatId)
    };

    try {
      let chunksReceived = 0;
      const trackedCb = {
        ...cb,
        onChunk: cb.onChunk ? (chunk) => { chunksReceived++; cb.onChunk(chunk); } : cb.onChunk
      };
      // usage 回调：记录统计 + 透传给调用方
      const onUsage = (usage) => {
        recordUsage(usage, 'openai', { ...usageContext, model: api.model });
        if (cb.onUsage) cb.onUsage(usage);
      };
      // DeepSeek 推理模式用专用解析器，否则用通用 parseSSELine
      const parseLine = api.deepseekThinking
        ? makeOpenAISSEParser(trackedCb, { showThinking: api.showThinking !== false, onUsage })
        : (line) => parseSSELine(line, trackedCb.onChunk, onUsage);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await sendChatStreamAuto(url, headers, requestBody, controller, trackedCb, parseLine);
          return;
        } catch (innerErr) {
          if (innerErr.name === 'AbortError') { cb.onDone('', true); return; }
          if (attempt === 0 && chunksReceived === 0) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          throw innerErr;
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        cb.onDone('', true);
      } else {
        cb.onError(error.message || String(error));
      }
    }
  })();

  return controller;
}
