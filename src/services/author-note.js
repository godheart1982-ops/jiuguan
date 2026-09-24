// 作者注释：不进聊天记录、不进记忆。组请求时按深度插进历史末尾附近。

export const AUTHOR_NOTE_DEPTH_MAX = 20;
export const AUTHOR_NOTE_FREQUENCY_MAX = 50;

export const AUTHOR_NOTE_HEADER =
  '【作者注释】这是写给本轮的常驻要求，不是用户或角色说的话。禁止写进正文，禁止让角色回应这段话本身。';

export function normalizeAuthorNote(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const text = String(src.text || '').replace(/\s+$/g, '').replace(/^\s+/g, '');
  let depth = Number(src.depth);
  if (!Number.isFinite(depth)) depth = 0;
  depth = Math.max(0, Math.min(AUTHOR_NOTE_DEPTH_MAX, Math.trunc(depth)));
  let frequency = Number(src.frequency);
  if (!Number.isFinite(frequency)) frequency = 1;
  frequency = Math.max(0, Math.min(AUTHOR_NOTE_FREQUENCY_MAX, Math.trunc(frequency)));
  return { text, depth, frequency };
}

/** 历史里的剧情用户轮数。元指令（meta）不计入。不含正在发送的这一轮。 */
export function storyUserTurnCount(historyMessages) {
  if (!Array.isArray(historyMessages)) return 0;
  let n = 0;
  for (const m of historyMessages) {
    if (m && m.role === 'user' && m.meta !== true) n++;
  }
  return n;
}

/**
 * 本轮是否插入。userTurnCount 含正在发送的这一轮。
 * 频率 1 = 每轮；频率 4 = 第 4、8、12… 轮；频率 0 = 不送。
 */
export function shouldInjectAuthorNote(note, userTurnCount) {
  const n = normalizeAuthorNote(note);
  if (!n.text || n.frequency <= 0) return false;
  const turn = Number(userTurnCount);
  if (!Number.isFinite(turn) || turn <= 0) return false;
  return Math.trunc(turn) % n.frequency === 0;
}

/**
 * 把注释插进已经拼好的 messages（就地修改）。
 * 深度 0 = 最末尾；深度 N = 后面留 N 条。不会插到首条 system 提示之前。
 * 调用方须在思维链预填充之前插入，预填充才能仍是最后一条。
 */
export function insertAuthorNote(messages, note) {
  const n = normalizeAuthorNote(note);
  if (!n.text || !Array.isArray(messages) || messages.length === 0) return messages;
  const entry = {
    role: 'system',
    content: AUTHOR_NOTE_HEADER + '\n' + n.text
  };
  const tailStart = messages.findIndex(m => m && m.role !== 'system');
  const start = tailStart === -1 ? messages.length : tailStart;
  const index = n.depth <= 0 ? messages.length : Math.max(start, messages.length - n.depth);
  messages.splice(index, 0, entry);
  return messages;
}

function appendDialog(dialog, role, content) {
  const text = String(content || '');
  if (!text) return;
  const last = dialog[dialog.length - 1];
  if (last && last.role === role) {
    last.content += '\n\n' + text;
  } else {
    dialog.push({ role, content: text });
  }
}

/**
 * Anthropic 只收一条 system，中间再插 system 会被丢掉。
 * 首条 system 仍交给 system 字段；其后的 system（作者注释）并进相邻 user，保留所在位置。
 * 思维链预填充（prefix）不进入对话数组。
 */
export function foldExtraSystemIntoDialog(messages) {
  const dialog = [];
  if (!Array.isArray(messages)) return dialog;
  let skippedMainSystem = false;
  for (const m of messages) {
    if (!m || m.prefix) continue;
    if (m.role === 'system') {
      if (!skippedMainSystem) {
        skippedMainSystem = true;
        continue;
      }
      appendDialog(dialog, 'user', m.content);
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    appendDialog(dialog, m.role, m.content);
  }
  return dialog;
}
