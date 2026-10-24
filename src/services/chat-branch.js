// 对话分支：从任意一条消息开新线——该条及之前的消息与全部记忆快照复制成新对话，原线不动。
// 深拷贝覆盖 messages / memory / plot / appearanceAnchors / authorNote 等全部字段，
// 分支后的编辑、记忆总结、剧情推进都不影响原对话。

/**
 * @param {object} source 原对话（不修改）
 * @param {number} index 分支点消息下标（新对话包含该条及之前全部消息）
 * @param {string} newId 新对话 id（调用方 createUUID）
 * @param {string} nowIso 新对话创建时间
 */
export function buildBranchedChat(source, index, newId, nowIso) {
  if (!source || !Array.isArray(source.messages) || !source.messages.length) {
    throw new Error('buildBranchedChat: 原对话为空或没有消息');
  }
  const i = Math.max(0, Math.min(Math.trunc(Number(index) || 0), source.messages.length - 1));
  const clone = JSON.parse(JSON.stringify(source));
  clone.id = newId;
  clone.title = `${source.title || '对话'} · 分支`;
  clone.messages = clone.messages.slice(0, i + 1);
  clone.createdAt = nowIso;
  clone.updatedAt = nowIso;
  return clone;
}
