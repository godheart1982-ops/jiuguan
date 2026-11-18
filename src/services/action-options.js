// 行动选项的 API 历史处理：旧轮剥离，最近一轮保留作格式示范与数字映射。
// 只处理发送内容，不修改本地聊天记录。

const ACTION_OPTIONS_HEADING = /^>###\s*行动选项\s*$/m;

export function hasActionOptions(content) {
  return ACTION_OPTIONS_HEADING.test(String(content || ''));
}

export function stripActionOptions(content) {
  const text = String(content || '');
  const match = ACTION_OPTIONS_HEADING.exec(text);
  return match ? text.slice(0, match.index).trimEnd() : text;
}

/** 较早 assistant 回复剥离行动选项；最近一份带菜单的 assistant 回复原样保留。 */
export function trimHistoricalActionOptions(historyMessages) {
  if (!Array.isArray(historyMessages)) return [];
  let latestMenuIndex = -1;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (msg && msg.role === 'assistant') {
      if (hasActionOptions(msg.content)) latestMenuIndex = i;
      break;
    }
  }
  return historyMessages.map((msg, index) => {
    if (!msg || msg.role !== 'assistant' || index === latestMenuIndex || !hasActionOptions(msg.content)) return msg;
    return { ...msg, content: stripActionOptions(msg.content) };
  });
}

function optionLineFor(content, number) {
  const text = String(content || '');
  const match = ACTION_OPTIONS_HEADING.exec(text);
  if (!match) return '';
  const block = text.slice(match.index);
  const line = new RegExp(`^\\s*${number}[.、]\\s+(.+)$`, 'm').exec(block);
  return line ? line[1].trim() : '';
}

/** 开头编号即选项：2 / 1+3 / 选2再…… / 2再…… / 2，…… / 2 ……；后续文字均为补充。 */
export function parseSelectedOptionNumbers(userMessage) {
  const text = String(userMessage || '').trim();
  const combo = /^[1-7](?:\s*[+＋]\s*[1-7])+(?![+＋\d])/.exec(text);
  if (combo) return Array.from(combo[0].matchAll(/[1-7]/g), (m) => Number(m[0]));
  const pick = /^选\s*([1-7])(?=\D|$)/.exec(text);
  if (pick) return [Number(pick[1])];
  const short = /^([1-7])(?!\d)/.exec(text);
  return short ? [Number(short[1])] : [];
}

/** 最近菜单仍完整出现在历史里，因此在本轮 user 旁声明其非事实属性与已选项。 */
export function buildActionOptionContext(assistantContent, userMessage) {
  if (!hasActionOptions(assistantContent)) return '';
  const lines = [
    '【上轮行动选项的事实边界】上轮末尾的完整菜单仅是候选与格式示例，所有选项均未自动发生；只有用户本轮明确选择的条目才可执行，未选项不得写成已经发生。'
  ];
  const selected = parseSelectedOptionNumbers(userMessage)
    .map((n) => ({ n, text: optionLineFor(assistantContent, n) }))
    .filter((it) => it.text);
  if (selected.length) {
    lines.push('【本轮已选择行动】');
    selected.forEach((it) => lines.push(`第${it.n}条：${it.text}`));
    lines.push('仅以上所选项作为本轮行动核心，其余候选均未发生；若数字明显是在回答剧情内提问，则按剧情内容理解，不套用此映射。');
  }
  return lines.join('\n');
}
