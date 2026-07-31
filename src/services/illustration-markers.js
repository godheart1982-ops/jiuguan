/**
 * 插图标记清洗【防 AI 模仿幻觉】（独立小模块，供 api-messages / api-memory 共用，避免循环依赖）
 *
 * 生图成功后消息里存的是 local-img://本地路径?p=提示词（App 内部协议），
 * 手动模式存的是 seedream://manual?p=提示词，失败存 seedream://failed?p=提示词。
 * 这些若原样发给 AI，AI 会在输出中模仿格式编造 local-img:// 假地址，
 * 或把 ?p= 里的提示词文本带上下文里带歪文风、浪费 token。
 * 统一洗回 seedream:// 空标记——AI 只需要见过"它应该输出的格式"，
 * 本地路径与提示词参数属于 App 内部实现，永远不该出现在 AI 的视野里。
 * 仅影响发给 API 的副本，存储中的原始消息不动。
 */
export function sanitizeHistoryIllustrationMarkers(content) {
  if (typeof content !== 'string') return content;
  return content.replace(/!\[([^\]]*)\]\((?:local-img|seedream):\/\/[^)\s]*\)/g, '![$1](seedream://)');
}
