import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubCharacters, assembleCardDescription } from '../src/services/card-modules.js';

test('normalizeSubCharacters: 非数组与脏数据——转字符串、去空白、丢空块', () => {
  assert.deepEqual(normalizeSubCharacters(undefined), []);
  assert.deepEqual(normalizeSubCharacters(null), []);
  assert.deepEqual(normalizeSubCharacters('文本'), []);
  assert.deepEqual(normalizeSubCharacters([undefined, null, '', '   ', ' 林悦设定 ']), ['林悦设定']);
});

test('assembleCardDescription: 老卡无新字段——只输出 description，行为同旧版', () => {
  assert.equal(assembleCardDescription({ description: '主角设定' }), '主角设定');
  assert.equal(assembleCardDescription({}), '');
  assert.equal(assembleCardDescription(null), '');
});

test('assembleCardDescription: 背景→主角→配角固定顺序', () => {
  const out = assembleCardDescription({
    description: '主角设定',
    background: '现代都市背景',
    subCharacters: ['林悦设定', '苏晴设定']
  });
  assert.equal(
    out,
    '【背景设定】\n现代都市背景\n\n主角设定\n\n【配角设定】\n林悦设定\n\n【配角设定】\n苏晴设定'
  );
});

test('assembleCardDescription: 空背景与空配角块不占位', () => {
  const out = assembleCardDescription({ description: '主角', background: '  ', subCharacters: ['', '  ', '林悦'] });
  assert.equal(out, '主角\n\n【配角设定】\n林悦');
});
