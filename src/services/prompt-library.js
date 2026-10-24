// 提示词库：config.promptLibrary = [{id, name, content, custom?, updatedAt?}]
// 内置条目 id 与种子一致：可编辑、可恢复默认、不可删除；库已存在时缺失的内置条目自动补回（新版新增模板能落到老库）。
// 全局默认：config.promptDefaults = { outputFormatId, thinkingFormatId }，指向库条目；空串 = 不设全局默认。
// 继承规则：卡级字段非空 → 用卡级（覆盖）；留空 → 全局默认；character.noGlobalPrompts = true → 留空也不注入。
import { PROMPT_PRESET_SEED } from './prompt-presets-data.js';

export { PROMPT_PRESET_SEED };

/** 确保库与全局默认结构存在；有改动返回 true（调用方负责 saveConfig）。 */
export function ensurePromptLibrary(config) {
  if (!config || typeof config !== 'object') return false;
  let changed = false;
  if (!Array.isArray(config.promptLibrary)) {
    config.promptLibrary = [];
    changed = true;
  }
  for (const seed of PROMPT_PRESET_SEED) {
    if (!config.promptLibrary.some((it) => it && it.id === seed.id)) {
      config.promptLibrary.push({ ...seed });
      changed = true;
    }
  }
  if (!config.promptDefaults || typeof config.promptDefaults !== 'object') {
    config.promptDefaults = { outputFormatId: '', thinkingFormatId: '' };
    changed = true;
  }
  return changed;
}

export function findPromptContent(config, id) {
  if (!id || !config) return '';
  const item = (config.promptLibrary || []).find((it) => it && it.id === id);
  return item ? String(item.content || '') : '';
}

/**
 * 解析某张卡实际使用的输出格式/思维链文本。
 * kind: 'outputFormat' | 'thinkingFormat'
 */
export function resolveCardPrompt(character, config, kind) {
  const own = character && String(character[kind] || '').trim();
  if (own) return character[kind];
  if (character && character.noGlobalPrompts) return '';
  const idKey = kind === 'outputFormat' ? 'outputFormatId' : 'thinkingFormatId';
  const id = config && config.promptDefaults && config.promptDefaults[idKey];
  return findPromptContent(config, id);
}
