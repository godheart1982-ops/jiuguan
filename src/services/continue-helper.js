// 一键续写纯函数：准备续写基准、构造续写 messages、剥离多余思考标签与无缝拼接去重。

import { hasActionOptions, stripActionOptions } from './action-options.js';
import { sanitizeHistoryIllustrationMarkers } from './illustration-markers.js';

const THINKING_PREFILL_TEXT = '<思考>';

/**
 * 准备续写基准正文：
 * 若原回复末尾已带行动选项菜单，先剥离旧菜单再从正文末尾继续往下演，
 * 避免模型在旧行动选项后面硬接剧情或重复两套行动选项。
 */
export function prepareContinueBase(existingContent) {
  const text = String(existingContent || '');
  if (hasActionOptions(text)) {
    return { baseContent: stripActionOptions(text), strippedOptions: true };
  }
  return { baseContent: text, strippedOptions: false };
}

/** 构造续写请求的 messages：去掉思维链预填充，附带已有半截回复与续写指令。 */
export function buildContinueMessages(baseMessages, baseContent, strippedOptions = false) {
  const list = Array.isArray(baseMessages) ? baseMessages : [];
  const cleaned = list.filter(
    (m) => !(m && m.role === 'assistant' && m.prefix === true && m.content === THINKING_PREFILL_TEXT)
  );
  const prompt = strippedOptions
    ? '请紧接上面已写完的正文末尾继续往下演一段剧情，并在最后重新给出更新后的收尾模块（如行动选项）。严禁重复前文已经写过的内容，也不要重新输出状态栏或 <思考> 标签。'
    : '你上一条回复尚未写完。请紧接上一条回复最后一个字无缝续写后续内容，把未演完的情节与收尾模块补完整；严禁重复前面已经写过的正文、状态栏或输出 <思考> 标签。';

  return [
    ...cleaned,
    { role: 'assistant', content: sanitizeHistoryIllustrationMarkers(baseContent) },
    { role: 'user', content: prompt }
  ];
}

/** 剥离模型在续写开头偶发吐出的 <思考>...</思考>（流式尚未闭合时先暂隐）。 */
export function stripLeadingThinkingBlock(text) {
  const raw = String(text || '');
  const trimmedStart = raw.trimStart();
  if (!trimmedStart.startsWith('<思考>')) return raw;
  const closeMatch = /^\s*<思考>[\s\S]*?<\/思考>\s*/.exec(raw);
  if (closeMatch) return raw.slice(closeMatch[0].length);
  return '';
}

/** 将基准正文与续写片段无缝合并，自动消除首尾重叠的几个字/词。 */
export function mergeContinuationText(baseContent, rawContinuation, { strippedOptions = false } = {}) {
  const base = String(baseContent || '');
  let cont = stripLeadingThinkingBlock(rawContinuation);
  if (!cont) return base;

  const maxOverlap = Math.min(40, base.length, cont.length);
  for (let len = maxOverlap; len >= 6; len--) {
    if (base.endsWith(cont.slice(0, len))) {
      cont = cont.slice(len);
      break;
    }
  }
  if (!cont) return base;
  if (!base) return cont;

  if (strippedOptions || /^\s*>\s*#{2,6}\s/.test(cont)) {
    return `${base.replace(/\n+$/, '')}\n\n${cont.replace(/^\n+/, '')}`;
  }
  return base + cont;
}
