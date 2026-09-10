import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImmersiveActingRule, IMMERSIVE_ACTING_RULE } from '../src/services/narrative-rules.js';

// ---------- buildImmersiveActingRule ----------

test('buildImmersiveActingRule: 默认全开——四条全在且与 IMMERSIVE_ACTING_RULE 等价', () => {
  const rule = buildImmersiveActingRule();
  assert.equal(rule, IMMERSIVE_ACTING_RULE);
  assert.ok(rule.includes('1. 边界：不写主控'));
  assert.ok(rule.includes('2. 演出来，不解释'));
  assert.ok(rule.includes('3. 拥抱非理性'));
  assert.ok(rule.includes('4. 质感与节奏'));
});

test('buildImmersiveActingRule: 总开关关闭返回空串', () => {
  assert.equal(buildImmersiveActingRule({ immersiveActing: false }), '');
});

test('buildImmersiveActingRule: 子开关全关返回空串（整段不注入）', () => {
  assert.equal(buildImmersiveActingRule({
    immersiveBoundary: false,
    immersiveShowDontTell: false,
    immersiveIrrational: false,
    immersiveTexture: false
  }), '');
});

test('buildImmersiveActingRule: 只留部分条目时序号重排不留空号', () => {
  const rule = buildImmersiveActingRule({ immersiveBoundary: false, immersiveTexture: false });
  assert.ok(!rule.includes('不写主控'));
  assert.ok(!rule.includes('质感与节奏'));
  assert.ok(rule.includes('1. 演出来，不解释')); // 原第2条重排为1
  assert.ok(rule.includes('2. 拥抱非理性')); // 原第3条重排为2
  assert.ok(!rule.includes('3.'));
});

test('buildImmersiveActingRule: 子开关裁剪不影响头部角色声明；单开一条也成立', () => {
  const cut = buildImmersiveActingRule({ immersiveIrrational: false });
  assert.ok(cut.includes('你是一场文字角色扮演的演绎者'));
  assert.ok(!cut.includes('拥抱非理性'));
  const only = buildImmersiveActingRule({
    immersiveBoundary: false,
    immersiveShowDontTell: false,
    immersiveTexture: false
  });
  assert.ok(only.includes('1. 拥抱非理性'));
  assert.ok(!only.includes('2.'));
});
