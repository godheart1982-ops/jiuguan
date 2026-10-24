// 卡内模块：背景设定 + 配角模块（主角 = character.description 主文档）。
// 一期全量常驻注入，顺序固定：背景设定 → 主角描述 → 各配角设定。
// 不做按在场/关键词的按需注入——配角随场景上下线会让 system prompt 每轮变化、破坏缓存。
// 老卡没有 background / subCharacters 字段时行为与旧版完全一致（只输出 description）。

/** 配角模块归一化：非数组按空处理；每项转字符串去首尾空白；丢弃空块。 */
export function normalizeSubCharacters(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s || '').trim()).filter(Boolean);
}

/** 拼出 system prompt 开头的卡设定段（背景 → 主角 → 配角）。 */
export function assembleCardDescription(character) {
  const c = character || {};
  const parts = [];
  const background = String(c.background || '').trim();
  if (background) parts.push('【背景设定】\n' + background);
  const description = String(c.description || '').trim();
  if (description) parts.push(description);
  for (const text of normalizeSubCharacters(c.subCharacters)) {
    parts.push('【配角设定】\n' + text);
  }
  return parts.join('\n\n');
}
