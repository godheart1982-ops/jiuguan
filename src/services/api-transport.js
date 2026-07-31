/**
 * 底层传输：SSE 解析、预填充工具、fetch 流式、原生插件流式
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

const StreamHttp = registerPlugin('StreamHttp');

export function parseSSELine(line, onChunk, onUsage) {
  const trimmed = line.trim();
  if (!trimmed || trimmed === 'data: [DONE]') return '';
  if (trimmed.startsWith('data: ')) {
    try {
      const data = JSON.parse(trimmed.slice(6));
      // stream_options.include_usage 开启后，末尾会有一条只带 usage 的块
      if (data.usage && onUsage) onUsage(data.usage);
      const delta = data.choices?.[0]?.delta;
      if (delta && typeof delta.content === 'string') {
        onChunk(delta.content);
        return delta.content;
      }
    } catch (e) {
      console.warn('Failed to parse SSE chunk:', trimmed, e);
    }
  }
  return '';
}

/**
 * 创建支持 DeepSeek reasoning_content 的 OpenAI SSE 解析器
 * 推理 token 用 <思考>...</思考> 包裹，供 extractThinkingForDisplay 折叠显示
 * @param {Object} callbacks - { onChunk }
 * @param {Object} options   - { showThinking: boolean }
 * @returns {Function} parseLine(line) → string
 */
export function makeOpenAISSEParser(callbacks, options = {}) {
  const { showThinking = true, onUsage = null } = options;
  let state = 'idle'; // 'idle' | 'thinking' | 'content'

  return function parseOpenAILine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') return '';
    if (!trimmed.startsWith('data: ')) return '';

    let delta;
    try {
      const data = JSON.parse(trimmed.slice(6));
      if (data.usage && onUsage) onUsage(data.usage);
      delta = data.choices?.[0]?.delta;
    } catch (e) {
      console.warn('Failed to parse SSE chunk:', trimmed, e);
      return '';
    }
    if (!delta) return '';

    let emitted = '';

    // 推理 token（DeepSeek reasoning_content）
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (state === 'idle') {
        state = 'thinking';
        if (showThinking) { callbacks.onChunk('<思考>'); emitted += '<思考>'; }
      }
      if (showThinking) { callbacks.onChunk(delta.reasoning_content); emitted += delta.reasoning_content; }
    }

    // 正文 content
    if (typeof delta.content === 'string' && delta.content) {
      if (state === 'thinking') {
        state = 'content';
        if (showThinking) { callbacks.onChunk('</思考>\n\n'); emitted += '</思考>\n\n'; }
      } else if (state === 'idle') {
        state = 'content';
      }
      callbacks.onChunk(delta.content);
      emitted += delta.content;
    }

    return emitted;
  };
}

// 前缀续写端点：DeepSeek 官方 Chat Prefix Completion 在 /beta；火山方舟（豆包）天然支持续写，无需改端点；其他服务商保持原地址
// 官方 base_url 两种写法都匹配：https://api.deepseek.com 与 https://api.deepseek.com/v1
// 火山方舟 base_url 示例：https://ark.cn-beijing.volces.com/api/v3
export function resolvePrefillUrl(baseUrl) {
  const b = (baseUrl || '').replace(/\/$/, '');
  if (/^https?:\/\/api\.deepseek\.com(\/v1)?$/i.test(b)) {
    return 'https://api.deepseek.com/beta/chat/completions';
  }
  // 火山方舟：续写模式天然支持，无需改端点
  if (/^https?:\/\/ark\.(cn-beijing|cn-shanghai|cn-guangzhou)\.volces\.com(\/api\/v3)?$/i.test(b)) {
    return `${b}/chat/completions`;
  }
  return `${b}/chat/completions`;
}

// 拼回预填开头：端点未做前缀续写、模型已自己从头输出相同开头时，不再重复拼接
export function mergePrefill(prefill, content) {
  const c = content || '';
  if (c.trimStart().startsWith(prefill)) return c;
  return prefill + c;
}

// 预填充回调包装：流开始前先补开头（流式显示从源头就是完整结构），结束时拼回去重
export function wrapCallbacksWithPrefill(callbacks, prefill) {
  queueMicrotask(() => { if (callbacks.onChunk) callbacks.onChunk(prefill); });
  return {
    onChunk: (chunk) => { if (callbacks.onChunk) callbacks.onChunk(chunk); },
    onError: (msg) => { if (callbacks.onError) callbacks.onError(msg); },
    onDone: (fullContent, aborted) => {
      if (!callbacks.onDone) return;
      callbacks.onDone(aborted ? fullContent : mergePrefill(prefill, fullContent), aborted);
    }
  };
}

export async function sendChatStreamNative(url, headers, body, controller, callbacks, parseLine) {
  parseLine = parseLine || ((line) => parseSSELine(line, callbacks.onChunk, callbacks.onUsage));
  let streamId = null;
  let buffer = '';
  let fullContent = '';
  let finished = false;

  const chunkHandle = await StreamHttp.addListener('chunk', (event) => {
    if (finished || !event || event.id !== streamId) return;
    buffer += event.chunk || '';
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      fullContent += parseLine(line);
    }
  });

  const endHandle = await StreamHttp.addListener('end', (event) => {
    if (finished || !event || event.id !== streamId) return;
    finished = true;
    if (buffer.trim()) {
      fullContent += parseLine(buffer);
      buffer = '';
    }
    cleanup();
    callbacks.onDone(fullContent);
  });

  const errorHandle = await StreamHttp.addListener('error', (event) => {
    if (finished || !event || event.id !== streamId) return;
    finished = true;
    cleanup();
    callbacks.onError(event.error || '流式请求失败');
  });

  async function cleanup() {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    try { chunkHandle?.remove(); } catch (e) {}
    try { endHandle?.remove(); } catch (e) {}
    try { errorHandle?.remove(); } catch (e) {}
  }

  controller.signal.addEventListener('abort', async () => {
    if (streamId && !finished) {
      try {
        await StreamHttp.cancelStream({ id: streamId });
      } catch (e) {
        // ignore
      }
    }
    finished = true;
    await cleanup();
    callbacks.onDone(fullContent, true);
  });

  const result = await StreamHttp.startStream({
    url,
    method: 'POST',
    headers,
    body
  });
  streamId = result.id;

  // 兜底：如果插件没有正常触发 end/error，5 分钟后自动清理
  let fallbackTimer = setTimeout(async () => {
    if (!finished) {
      finished = true;
      await cleanup();
      callbacks.onDone(fullContent);
    }
  }, 5 * 60 * 1000);
}

// 自动选择传输方式：原生平台用 StreamHttp 插件（绕过 CapacitorHttp 缓冲），其他用 fetch
export async function sendChatStreamAuto(url, headers, body, controller, callbacks, parseLine) {
  const nativeAvail = Capacitor.isNativePlatform() && StreamHttp && typeof StreamHttp.startStream === 'function';
  if (nativeAvail) {
    return sendChatStreamNative(url, headers, body, controller, callbacks, parseLine);
  }
  return sendChatStreamFetch(url, headers, body, controller, callbacks, parseLine);
}

export async function sendChatStreamFetch(url, headers, body, controller, callbacks, parseLine) {
  parseLine = parseLine || ((line) => parseSSELine(line, callbacks.onChunk, callbacks.onUsage));
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: controller.signal
  });

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
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  // CapacitorHttp 等环境可能不支持 ReadableStream，退化成一次性 SSE 文本解析
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    let fullContent = '';
    for (const line of text.split('\n')) {
      fullContent += parseLine(line);
    }
    callbacks.onDone(fullContent);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      fullContent += parseLine(line);
    }
  }

  // 处理最后可能残留的一行
  if (buffer.trim()) {
    fullContent += parseLine(buffer);
  }

  callbacks.onDone(fullContent);
}
