// 行动选项的 API 历史处理与交互解析：旧轮剥离，最近一轮保留作格式示范与数字映射。
// 只处理发送内容或展示拆分，不修改本地聊天记录。

const ACTION_OPTIONS_HEADING = /^\s*(?:>\s*)?(?:#{1,6}\s*|\*{2}\s*|【\s*)(?:[-—–\s]*)(?:行动选项)(?:[-—–\s：:]*)(?:\*{2}|】)?\s*$/m;
const MODULE_HEADING_RE = /^>\s*#{2,6}\s/;
const OPTION_LINE_RE = /^\s*(?:>\s*)?(?:\*{2})?([1-9])(?:\*{2})?\s*[.、．)]\s*(?:\*{2})?(.+?)\s*$/;
const COMBO_PREFIX_RE = /^(?:选\s*)?([1-9](?:(?:\s*(?:[+＋、&]|和|与)\s*|\s*[,，]\s*(?=[1-9](?![\d点分秒号月日年天次个件块元岁米楼层])))[1-9])*)(?!\d)/;

export function hasActionOptions(content) {
  return ACTION_OPTIONS_HEADING.test(String(content || ''));
}

export function stripActionOptions(content) {
  const text = String(content || '');
  const match = ACTION_OPTIONS_HEADING.exec(text);
  return match ? text.slice(0, match.index).trimEnd() : text;
}

/**
 * 将回复正文拆分为「行动选项前」「解析出的选项列表」「行动选项后（如插图/记忆修正）」。
 * 仅用于展示层渲染交互卡片，不改动原文。
 */
export function splitActionOptionsBlock(content) {
  const text = String(content || '');
  const match = ACTION_OPTIONS_HEADING.exec(text);
  if (!match) return { before: text, options: [], after: '' };

  const afterHeadingStart = match.index + match[0].length;
  const tail = text.slice(afterHeadingStart);
  const lines = tail.split('\n');
  const options = [];
  const seen = new Set();
  let endLineIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (MODULE_HEADING_RE.test(trimmed) || /^#{2,6}\s/.test(trimmed) || /^!\[/.test(trimmed) || /^记忆修正[：:]/.test(trimmed)) {
      endLineIdx = i;
      break;
    }
    const optMatch = OPTION_LINE_RE.exec(line);
    if (optMatch) {
      const number = Number(optMatch[1]);
      const optText = optMatch[2].replace(/\*{2}$/, '').trim();
      if (optText && !seen.has(number)) {
        seen.add(number);
        options.push({ number, text: optText });
      }
    }
  }

  if (!options.length) return { before: text, options: [], after: '' };

  return {
    before: text.slice(0, match.index).trimEnd(),
    options,
    after: lines.slice(endLineIdx).join('\n').trim()
  };
}

export function extractActionOptions(content) {
  return splitActionOptionsBlock(content).options;
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
  const found = extractActionOptions(content).find((it) => it.number === number);
  return found ? found.text : '';
}

/**
 * 开头编号即选项：2 / 1+3 / 选1+3 / 1、3 / 1和3 / 2再…… / 2，……；
 * 保留点击/书写先后顺序并去重；后续文字均为补充。
 */
export function parseSelectedOptionNumbers(userMessage) {
  const text = String(userMessage || '').trim();
  const match = COMBO_PREFIX_RE.exec(text);
  if (!match) return [];
  const nums = [];
  const seen = new Set();
  for (const m of match[1].matchAll(/[1-9]/g)) {
    const n = Number(m[0]);
    if (!seen.has(n)) {
      seen.add(n);
      nums.push(n);
    }
  }
  return nums;
}

/** 取选项编号后的自由补充，供召回记录与提示词展示用户本轮意图。 */
export function extractActionOptionSupplement(userMessage) {
  const text = String(userMessage || '').trim();
  const prefix = COMBO_PREFIX_RE.exec(text);
  if (!prefix) return '';
  return text.slice(prefix[0].length).replace(/^(?:\s*[,，、;；+＋]\s*|\s+|再\s*)/, '').trim();
}

/** 将多选编号（按顺序）与补充文字拼成简洁发送文本（方案 A：3+1，补充文字）。 */
export function composeActionOptionMessage(selectedNumbers, supplementText = '') {
  const nums = [];
  const seen = new Set();
  for (const raw of Array.isArray(selectedNumbers) ? selectedNumbers : []) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 9 && !seen.has(n)) {
      seen.add(n);
      nums.push(n);
    }
  }
  const supplement = String(supplementText || '').trim();
  if (!nums.length) return supplement;
  const combo = nums.join('+');
  return supplement ? `${combo}，${supplement}` : combo;
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
    if (selected.length > 1) {
      lines.push('以上为多选组合行动，请严格按上述先后顺序自然衔接执行。');
    }
    const supplement = extractActionOptionSupplement(userMessage);
    if (supplement) {
      lines.push(`【用户补充说明（最高优先级）】${supplement}（若与上述选项细节有出入，一律以用户补充说明为准，并自然融入本轮行动。）`);
    }
    lines.push('仅以上所选项作为本轮行动核心，其余候选均未发生；若数字明显是在回答剧情内提问，则按剧情内容理解，不套用此映射。');
  }
  return lines.join('\n');
}
