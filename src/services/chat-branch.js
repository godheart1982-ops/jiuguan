// 对话分支：从任意一条消息开新线——该条及之前的消息与对应记忆快照复制成新对话，原线不动。
// 新版原文记忆按永久 turnId 过滤，并恢复分支点最近的 stateAfter，而不是误用最新状态。

import { emptyMemoryState, turnIdOf } from './memory-engine.js';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

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
  const clone = cloneJson(source);
  clone.id = newId;
  clone.title = `${source.title || '对话'} · 分支`;
  clone.messages = clone.messages.slice(0, i + 1);
  clone.createdAt = nowIso;
  clone.updatedAt = nowIso;

  if (clone.memory && Array.isArray(clone.memory.archive)) {
    const included = new Set(clone.messages.filter((m) => m.role === 'user').map((user) => turnIdOf({ user })));
    clone.memory.archive = clone.memory.archive.filter((entry) => included.has(entry.turnId));
    const snapshot = [...clone.memory.archive].reverse().find((entry) => entry && entry.stateAfter);
    clone.memory.state = snapshot ? cloneJson(snapshot.stateAfter) : emptyMemoryState();
    clone.memory.recallLog = [];
    delete clone.memory.pendingRecalls;
  }
  return clone;
}
