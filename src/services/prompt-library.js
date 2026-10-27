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
  // 内置条目由种子定义：不在种子里的非自定义条目 = 已下线内置（如早期误收的做卡模板），
  // 自动移除并解除全局引用；自定义条目一律保留
  const seedIds = new Set(PROMPT_PRESET_SEED.map((s) => s.id));
  const removedIds = config.promptLibrary
    .filter((it) => it && it.custom !== true && !seedIds.has(it.id))
    .map((it) => it.id);
  if (removedIds.length) {
    config.promptLibrary = config.promptLibrary.filter((it) => it && (it.custom === true || seedIds.has(it.id)));
    changed = true;
  }
  for (const seed of PROMPT_PRESET_SEED) {
    if (!config.promptLibrary.some((it) => it && it.id === seed.id)) {
      config.promptLibrary.push({ ...seed });
      changed = true;
    }
  }
  // 条目类型（输出格式/思维链）回填：老库条目无 kind 时按 id 推断，自定义默认输出格式
  for (const it of config.promptLibrary) {
    if (it && !it.kind) {
      it.kind = it.id === 'thinking' ? 'thinking' : 'outputFormat';
      changed = true;
    }
  }
  if (!config.promptDefaults || typeof config.promptDefaults !== 'object') {
    config.promptDefaults = { outputFormatId: '', thinkingFormatId: '' };
    changed = true;
  }
  if (removedIds.includes(config.promptDefaults.outputFormatId)) {
    config.promptDefaults.outputFormatId = '';
    changed = true;
  }
  if (removedIds.includes(config.promptDefaults.thinkingFormatId)) {
    config.promptDefaults.thinkingFormatId = '';
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
 * 优先级：卡级文本（覆盖）→ 卡级模板选择（outputFormatPresetId / thinkingPresetId，指向库条目）
 *   → 显式选择"无"（presetId === ''）→ 旧版全局默认（仅历史配置回退，设置入口已下线）。
 * kind: 'outputFormat' | 'thinkingFormat'
 */
export function resolveCardPrompt(character, config, kind) {
  const own = character && String(character[kind] || '').trim();
  if (own) return character[kind];
  const presetKey = kind === 'outputFormat' ? 'outputFormatPresetId' : 'thinkingPresetId';
  const presetId = character && character[presetKey];
  if (presetId) return findPromptContent(config, presetId);
  if (presetId === '') return ''; // 新版卡上明确选择"无"
  // 旧版全局默认（已下线设置入口，仅为未按新结构保存过的老卡保留回退）
  if (character && character.noGlobalPrompts) return '';
  const idKey = kind === 'outputFormat' ? 'outputFormatId' : 'thinkingFormatId';
  const id = config && config.promptDefaults && config.promptDefaults[idKey];
  return findPromptContent(config, id);
}
