/**
 * 自定义请求头：解析配置文本 + 会话 ID 占位替换。
 * 用途：某些服务商（如 opencode Go）要求客户端携带稳定会话头做路由/缓存亲和。
 * 会话 ID 在发送消息时由聊天页设为当前对话 id；后台任务（记忆总结等）沿用同一会话，语义正确。
 */

let currentSessionId = '';

/** 设置当前请求会话 ID（聊天页发送消息时调用，传当前 chat.id） */
export function setRequestSessionId(id) {
  currentSessionId = String(id || '');
}

export function getRequestSessionId() {
  return currentSessionId;
}

// 合法 HTTP 头名（RFC 7230 token）
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * 解析「自定义请求头」配置文本（每行一个 "Key: Value"）。
 * - {{chatId}} 占位替换为会话 ID：显式参数 > 当前会话 > 'default'
 * - 会话 ID 清洗：剔除字母数字/_.- 之外的字符
 * - 非法行（无冒号/空键/空值/非法头名）静默跳过
 * 用法：headers: { 'Content-Type': ..., ...buildCustomHeaders(api.customHeaders) }
 * ——放在默认头之后展开，允许覆盖同名默认头（如自定义 User-Agent）。
 * @param {string} raw 配置文本
 * @param {string} [chatId] 显式会话 ID（测试/调用方覆盖用）
 * @returns {Object} 头名 → 头值
 */
export function buildCustomHeaders(raw, chatId) {
  const out = {};
  const text = String(raw || '').trim();
  if (!text) return out;
  const sid = String(chatId || currentSessionId || 'default').replace(/[^\w.-]/g, '') || 'default';
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/\{\{\s*chatId\s*\}\}/gi, sid);
    if (!key || !value || !HEADER_NAME_RE.test(key)) continue;
    out[key] = value;
  }
  return out;
}
