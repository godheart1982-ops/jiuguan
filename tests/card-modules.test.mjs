import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubCharacters, getCharacterModules, assembleCardDescription } from '../src/services/card-modules.js';

test('normalizeSubCharacters: 非数组与脏数据——转字符串、去空白、丢空块', () => {
  assert.deepEqual(normalizeSubCharacters(undefined), []);
  assert.deepEqual(normalizeSubCharacters(null), []);
  assert.deepEqual(normalizeSubCharacters('文本'), []);
  assert.deepEqual(normalizeSubCharacters([undefined, null, '', '   ', ' 林悦设定 ']), ['林悦设定']);
});

test('getCharacterModules: 新结构直读并归一化', () => {
  assert.deepEqual(getCharacterModules({ characterModules: [' 主角 ', '', '配角'] }), ['主角', '配角']);
});

test('getCharacterModules: 老卡 description 自动并入第一块，subCharacters 跟随', () => {
  assert.deepEqual(
    getCharacterModules({ description: '主角描述', subCharacters: ['配角A', '配角B'] }),
    ['主角描述', '配角A', '配角B']
  );
  assert.deepEqual(getCharacterModules({ description: '仅主角' }), ['仅主角']);
  assert.deepEqual(getCharacterModules({}), []);
  assert.deepEqual(getCharacterModules(null), []);
});

test('assembleCardDescription: 背景→各角色模块，统一【角色设定】头', () => {
  const out = assembleCardDescription({ background: '现代都市', characterModules: ['主角设定', '林悦设定'] });
  assert.equal(out, '【背景设定】\n现代都市\n\n【角色设定】\n主角设定\n\n【角色设定】\n林悦设定');
});

test('assembleCardDescription: 老卡迁移等价——description 成为首个【角色设定】；空卡为空串', () => {
  const out = assembleCardDescription({ description: '主角设定', subCharacters: ['林悦设定'] });
  assert.equal(out, '【角色设定】\n主角设定\n\n【角色设定】\n林悦设定');
  assert.equal(assembleCardDescription({}), '');
});
