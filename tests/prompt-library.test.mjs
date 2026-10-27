import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePromptLibrary, findPromptContent, resolveCardPrompt, PROMPT_PRESET_SEED } from '../src/services/prompt-library.js';

test('ensurePromptLibrary: 首次播种全部内置模板与默认结构；二次调用幂等', () => {
  const config = {};
  assert.equal(ensurePromptLibrary(config), true);
  assert.equal(config.promptLibrary.length, PROMPT_PRESET_SEED.length);
  assert.deepEqual(config.promptDefaults, { outputFormatId: '', thinkingFormatId: '' });
  assert.equal(ensurePromptLibrary(config), false);
});

test('ensurePromptLibrary: 老库缺新内置模板自动补回，已有条目内容不动', () => {
  const config = { promptLibrary: [{ id: 'statusbar', name: '状态栏输出格式', content: '我改过的版本' }] };
  ensurePromptLibrary(config);
  assert.equal(config.promptLibrary.length, PROMPT_PRESET_SEED.length);
  assert.equal(config.promptLibrary.find((i) => i.id === 'statusbar').content, '我改过的版本');
});

test('resolveCardPrompt: 卡级填写覆盖全局默认', () => {
  const config = { promptLibrary: [{ id: 'a', content: '全局格式' }], promptDefaults: { outputFormatId: 'a', thinkingFormatId: '' } };
  assert.equal(resolveCardPrompt({ outputFormat: '卡自己的' }, config, 'outputFormat'), '卡自己的');
});

test('resolveCardPrompt: 留空继承全局；noGlobalPrompts 不注入；无默认为空', () => {
  const config = { promptLibrary: [{ id: 'a', content: '全局格式' }], promptDefaults: { outputFormatId: 'a', thinkingFormatId: '' } };
  assert.equal(resolveCardPrompt({}, config, 'outputFormat'), '全局格式');
  assert.equal(resolveCardPrompt({ noGlobalPrompts: true }, config, 'outputFormat'), '');
  assert.equal(resolveCardPrompt({}, config, 'thinkingFormat'), '');
  assert.equal(resolveCardPrompt({}, {}, 'outputFormat'), '');
});

test('resolveCardPrompt: 全局指向已删除条目时回退空串', () => {
  const config = { promptLibrary: [], promptDefaults: { outputFormatId: 'gone', thinkingFormatId: '' } };
  assert.equal(resolveCardPrompt({}, config, 'outputFormat'), '');
  assert.equal(findPromptContent(config, 'gone'), '');
});

test('ensurePromptLibrary: 下线内置条目自动清除并解除全局引用，自定义保留', () => {
  const config = {
    promptLibrary: [
      { id: 'character', name: '角色卡模板', content: '做卡用' },
      { id: 'custom-1', name: '我的格式', content: 'x', custom: true },
      { id: 'statusbar', content: '状态栏' }
    ],
    promptDefaults: { outputFormatId: 'character', thinkingFormatId: '' }
  };
  ensurePromptLibrary(config);
  assert.ok(!config.promptLibrary.some((i) => i.id === 'character'));
  assert.ok(config.promptLibrary.some((i) => i.id === 'custom-1'));
  assert.equal(config.promptDefaults.outputFormatId, '');
});

test('resolveCardPrompt: 卡级模板选择优先于旧全局默认', () => {
  const config = {
    promptLibrary: [{ id: 'a', content: '模板A' }, { id: 'b', content: '模板B' }],
    promptDefaults: { outputFormatId: 'a', thinkingFormatId: '' }
  };
  assert.equal(resolveCardPrompt({ outputFormatPresetId: 'b' }, config, 'outputFormat'), '模板B');
  assert.equal(resolveCardPrompt({ outputFormatPresetId: 'a' }, config, 'outputFormat'), '模板A');
});

test('resolveCardPrompt: 显式选择"无"则不再回退旧全局默认', () => {
  const config = { promptLibrary: [{ id: 'a', content: '模板A' }], promptDefaults: { outputFormatId: 'a', thinkingFormatId: '' } };
  assert.equal(resolveCardPrompt({ outputFormatPresetId: '' }, config, 'outputFormat'), '');
});

test('resolveCardPrompt: 卡级文本优先于模板选择', () => {
  const config = { promptLibrary: [{ id: 'b', content: '模板B' }], promptDefaults: {} };
  assert.equal(resolveCardPrompt({ outputFormat: '卡文本', outputFormatPresetId: 'b' }, config, 'outputFormat'), '卡文本');
});
