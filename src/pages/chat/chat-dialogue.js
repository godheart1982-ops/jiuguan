// 兼容 AI 偶发的引号外加粗：**"台词"** → "**台词**"。
// 仅改展示输入，不回写消息原文；旧聊天记录重新渲染时同样生效。
export function normalizeDialogueBold(text) {
  return String(text || '')
    .replace(/\*\*"([^"\n]+)"\*\*/g, '"**$1**"')
    .replace(/\*\*“([^”\n]+)”\*\*/g, '“**$1**”')
    .replace(/\*\*「([^」\n]+)」\*\*/g, '「**$1**」');
}
