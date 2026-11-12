import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImmersiveActingRule, IMMERSIVE_ACTING_RULE, CHARACTER_CALIBRATION_RULE } from '../src/services/narrative-rules.js';

test('每轮人设校准：覆盖人格、关系名分、性设定与对主控认知', () => {
  assert.ok(CHARACTER_CALIBRATION_RULE.includes('近期回复只能延续人设，不能反向覆盖角色卡'));
  assert.ok(CHARACTER_CALIBRATION_RULE.includes('炮友/露水关系'));
  assert.ok(CHARACTER_CALIBRATION_RULE.includes('恋人式吃醋'));
  assert.ok(CHARACTER_CALIBRATION_RULE.includes('亲密与性设定'));
  assert.ok(CHARACTER_CALIBRATION_RULE.includes('突然放荡'));
  assert.ok(CHARACTER_CALIBRATION_RULE.includes('神化'));
  assert.ok(CHARACTER_CALIBRATION_RULE.includes('不篡改历史'));
});

// ---------- buildImmersiveActingRule ----------

test('buildImmersiveActingRule: 默认全开——四条全在，不再限制主控动作与对话', () => {
  const rule = buildImmersiveActingRule();
  assert.equal(rule, IMMERSIVE_ACTING_RULE);
  assert.ok(!rule.includes('不写主控'));
  assert.ok(!rule.includes('禁止代写主控'));
  assert.ok(rule.includes('1. 演出来，不解释'));
  assert.ok(rule.includes('2. 拥抱非理性'));
  assert.ok(rule.includes('3. 质感与节奏'));
  assert.ok(rule.includes('4. 内在生活：写出活人'));
});

test('buildImmersiveActingRule: 总开关关闭返回空串', () => {
  assert.equal(buildImmersiveActingRule({ immersiveActing: false }), '');
});

test('buildImmersiveActingRule: 子开关全关返回空串（整段不注入）', () => {
  assert.equal(buildImmersiveActingRule({
    immersiveShowDontTell: false,
    immersiveIrrational: false,
    immersiveTexture: false,
    immersiveInnerLife: false
  }), '');
});

test('buildImmersiveActingRule: 只留部分条目时序号重排不留空号', () => {
  const rule = buildImmersiveActingRule({ immersiveShowDontTell: false, immersiveTexture: false });
  assert.ok(!rule.includes('演出来，不解释'));
  assert.ok(!rule.includes('质感与节奏'));
  assert.ok(rule.includes('1. 拥抱非理性'));
  assert.ok(rule.includes('2. 内在生活：写出活人'));
  assert.ok(!rule.includes('3.'));
});

test('buildImmersiveActingRule: 子开关裁剪不影响头部角色声明；单开一条也成立', () => {
  const cut = buildImmersiveActingRule({ immersiveIrrational: false });
  assert.ok(cut.includes('你是一场文字角色扮演的演绎者'));
  assert.ok(!cut.includes('拥抱非理性'));
  const only = buildImmersiveActingRule({
    immersiveShowDontTell: false,
    immersiveTexture: false,
    immersiveInnerLife: false
  });
  assert.ok(only.includes('1. 拥抱非理性'));
  assert.ok(!only.includes('2.'));
});

test('buildImmersiveActingRule: 内在生活可单独关闭，其余三条序号不受影响', () => {
  const rule = buildImmersiveActingRule({ immersiveInnerLife: false });
  assert.ok(!rule.includes('内在生活'));
  assert.ok(!rule.includes('落笔先代入'));
  assert.ok(rule.includes('3. 质感与节奏'));
  assert.ok(!rule.includes('4.'));
});

test('buildImmersiveActingRule: 内在生活默认开启，含代入/误判条款；质感条含金句不批发', () => {
  const rule = buildImmersiveActingRule();
  assert.ok(rule.includes('落笔先代入'));
  assert.ok(rule.includes('允许误判'));
  assert.ok(rule.includes('情绪惯性'));
  assert.ok(rule.includes('金句不批发'));
});
