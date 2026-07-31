// 记忆相关纯函数 / 压缩（不依赖 DOM）

import { saveChat } from '../../services/storage.js';
import {
  summarizeShortTermMemories,
  SHORT_TERM_LIMIT,
  LONG_TERM_REFERENCE_COUNT,
  formatFactsMemo
} from '../../services/api-memory.js';

export function isIncompleteAssistant(content) {
  if (!content) return true;
  const c = String(content).trim();
  if (!c) return true;
  if (c.startsWith('（生成失败') || c.startsWith('（已停止生成')) return true;
  return false;
}

/** 取全部完整的 user+assistant 轮次（开场白和失败回复不计入），按时间顺序排列 */
export function getAllRounds(messages) {
  const rounds = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    let assistant = null;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === 'user') break;
      if (messages[j].role === 'assistant') {
        assistant = messages[j];
        break;
      }
    }
    if (!assistant) continue;
    if (isIncompleteAssistant(assistant.content)) continue;
    rounds.push({ user: msg, assistant });
  }
  return rounds;
}

/** 取最开头的角色卡开场白（assistant 单发、且后面紧跟 user 的消息） */
export function getLeadingGreeting(messages) {
  if (messages.length >= 2 && messages[0].role === 'assistant' && messages[1].role === 'user') {
    return messages[0].content || '';
  }
  return '';
}

/** 从角色卡输出格式中提取最后一个 >### 标题 */
export function getLastOutputHeading(outputFormat) {
  if (!outputFormat) return null;
  const headings = [];
  const regex = /^>###\s*(.+)$/gm;
  let match;
  while ((match = regex.exec(outputFormat)) !== null) {
    const clean = match[1].split(/[（(：:]/)[0].trim();
    if (clean) headings.push(clean);
  }
  return headings.length > 0 ? headings[headings.length - 1] : null;
}

export function extractSceneDate(content) {
  if (!content) return '';
  const field = content.match(/(?:📅\s*)?日期\s*[:：]\s*(.+?)(?=\s*(?:🕑|🕐|🕒|🗺️|🌏|🌦|🌡️|👥|🏞|时间|地点|季节|天气|温度|周围|环境|\r?\n|$))/u);
  const raw = (field && field[1] ? field[1] : '').trim();
  if (!raw) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const thisYear = new Date().getFullYear();
  let m = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = raw.match(/(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = raw.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${thisYear}-${pad(m[1])}-${pad(m[2])}`;
  m = raw.match(/(\d{1,2})\s*[-/.]\s*(\d{1,2})/);
  if (m) return `${thisYear}-${pad(m[1])}-${pad(m[2])}`;
  return '';
}

/**
 * 短期满额时压缩为长期
 * @param {object} chat
 * @param {(msg: string, type?: string) => void} [showMemoryStatus]
 */
export async function maybeCondenseLongTerm(chat, showMemoryStatus) {
  if (!chat.memory || chat.memory.shortTerm.length < SHORT_TERM_LIMIT) return;
  if (showMemoryStatus) showMemoryStatus('正在压缩短期记忆为长期记忆...', 'info');
  try {
    // 参考最近几条旧长期（只读）与事实备忘：新条目能衔接剧情弧线、与硬事实一致
    const long = await summarizeShortTermMemories(chat.memory.shortTerm, {
      previousLongTerm: chat.memory.longTerm.slice(-LONG_TERM_REFERENCE_COUNT),
      factsMemo: formatFactsMemo(chat.memory.facts)
    });
    long.sourceRounds = chat.memory.shortTerm.map((s) => s.round).filter((r) => Number.isFinite(r));
    long.sourceTimestamps = chat.memory.shortTerm.map((s) => s.turnTimestamp).filter(Boolean);
    chat.memory.longTerm.push(long);
    chat.memory.shortTerm = [];
    await saveChat(chat).catch(() => {});
    if (showMemoryStatus) showMemoryStatus('长期记忆已整合', 'success');
  } catch (e) {
    console.warn('长期记忆整合失败，保留短期记忆:', e);
    if (showMemoryStatus) showMemoryStatus('长期记忆整合失败，稍后重试', 'warning');
  }
}
