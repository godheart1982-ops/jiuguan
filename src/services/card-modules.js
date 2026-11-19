// 卡内模块：背景设定 + 角色模块×N（主角就是第一块角色模块，不再有独立的"角色描述"字段）。
// 数据结构：character.background（string）+ character.characterModules（string[]）。
// 旧字段迁移（读取时惰性完成，保存时由卡编辑器落盘为新结构）：
//   老卡 character.description（角色描述）→ 第一块角色模块；
//   老卡 character.subCharacters（配角模块）→ 依次排在其后。
// 注入顺序固定：背景设定 → 各角色模块，全量常驻；不做按需注入（配角随场景上下线会破坏缓存）。

/** 角色模块数组归一化：非数组按空处理；每项转字符串去首尾空白；丢弃空块。 */
export function normalizeSubCharacters(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => String(s || '').trim()).filter(Boolean);
}

/** 读取卡的角色模块（兼容旧字段：description 作为第一块，subCharacters 跟随）。 */
export function getCharacterModules(character) {
  const c = character || {};
  if (Array.isArray(c.characterModules)) return normalizeSubCharacters(c.characterModules);
  const modules = [];
  const legacyMain = String(c.description || '').trim();
  if (legacyMain) modules.push(legacyMain);
  return modules.concat(normalizeSubCharacters(c.subCharacters));
}

/** 拼出 system prompt 开头的卡设定段（背景设定 → 各角色模块）。 */
export function assembleCardDescription(character) {
  const c = character || {};
  const parts = [];
  const background = String(c.background || '').trim();
  if (background) parts.push('【背景设定】\n' + background);
  for (const text of getCharacterModules(c)) {
    parts.push('【角色设定】\n' + text);
  }
  return parts.join('\n\n');
}

/** 不在场重要NPC名单（卡级 offscreenRoles）：非空时只有名单内角色拥有常驻场外状态；空 = AI 自行判断重要NPC。 */
export function buildOffscreenRosterBlock(character) {
  const names = Array.isArray(character && character.offscreenRoles)
    ? character.offscreenRoles.map((n) => String(n || '').trim()).filter(Boolean)
    : [];
  if (!names.length) return '';
  return '【不在场重要NPC名单】只有以下角色拥有常驻场外状态（不在场时也会自行行动、发生事件）：' +
    names.join('、') +
    '。名单之外的角色不生成场外动态，仅在当下场景需要时登场；名单内角色每轮保留最近状态，跨时段至少推进1条、同时段照抄，入场离场或用户明确新信息立即更新，不得与正文事实冲突。';
}
