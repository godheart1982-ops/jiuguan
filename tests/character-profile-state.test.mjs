import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyMemoryState, applyMemoryStatePatch, formatMemoryState, formatCurrentMemoryState
} from '../src/services/memory-engine.js';

test('人物固定设定：外貌身材、性癖与内外气质写入后不被普通更新重抽', () => {
  const state = applyMemoryStatePatch(emptyMemoryState(), {
    characters: [{
      name: '林静',
      appearance: '神似新垣结衣；168cm/52kg，三围85/60/88，D杯',
      kinks: '轻度支配、被夸奖',
      outerAura: '端庄干练、疏离有礼',
      innerAura: '敏感好胜、害怕失控',
      relation: '朋友'
    }]
  }, 'turn-1');
  const updated = applyMemoryStatePatch(state, {
    characters: [{ name: '林静', mood: '低落', appearance: '神似新垣结衣；168cm/54kg，孕3月，三围88/66/90，D杯' }]
  }, 'turn-2');
  const person = updated.characters[0];
  assert.ok(person.appearance.includes('孕3月'));
  assert.equal(person.kinks, '轻度支配、被夸奖');
  assert.equal(person.outerAura, '端庄干练、疏离有礼');
  assert.equal(person.innerAura, '敏感好胜、害怕失控');
  assert.equal(person.relation, '朋友');
  const text = formatMemoryState(updated);
  assert.ok(text.includes('外貌身材='));
  assert.ok(text.includes('性癖=轻度支配、被夸奖'));
  assert.ok(text.includes('外在气质='));
  assert.ok(text.includes('实际内在气质='));
  assert.ok(formatCurrentMemoryState({ state: updated }).includes('性癖与内在气质均不等于主控知情'));
});

test('关系与秘密知情：同一条目更新全量知情人，公开后显式移除', () => {
  const state = emptyMemoryState();
  state.intel.push({ id: 'intel-relation', text: '主控与林静秘密交往', knownBy: ['林静'] });
  applyMemoryStatePatch(state, {
    intel: [{ id: 'intel-relation', text: '主控与林静秘密交往', knownBy: ['林静', '苏晴'] }]
  }, 'turn-1');
  assert.equal(state.intel.length, 1);
  assert.deepEqual(state.intel[0].knownBy, ['林静', '苏晴']);
  applyMemoryStatePatch(state, {
    intel: [{ id: 'intel-relation', op: 'remove' }]
  }, 'turn-2');
  assert.equal(state.intel.length, 0);
});
