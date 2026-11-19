import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyMemoryState, applyMemoryStatePatch, formatMemoryState, formatCurrentMemoryState
} from '../src/services/memory-engine.js';
import { PROMPT_PRESET_SEED } from '../src/services/prompt-presets-data.js';

test('不在场重要NPC：状态补丁记录在场与最近场外状态，入场后保留衔接信息', () => {
  const state = emptyMemoryState();
  state.characters.push({ name: '林静', relation: '朋友', scores: '好感40' });
  const offscreen = applyMemoryStatePatch(state, {
    scene: '主控家中',
    characters: [{ name: '林静', presence: '不在场', offscreen: '公司加班，情绪低落（下午）', mood: '低落' }]
  }, 'turn-1');
  assert.equal(offscreen.scene, '主控家中');
  assert.equal(offscreen.characters[0].presence, '不在场');
  assert.equal(offscreen.characters[0].offscreen, '公司加班，情绪低落（下午）');
  assert.equal(offscreen.characters[0].relation, '朋友');
  assert.equal(offscreen.characters[0].scores, '好感40');
  const entered = applyMemoryStatePatch(offscreen, {
    characters: [{ name: '林静', presence: '在场', mood: '疲惫' }]
  }, 'turn-2');
  assert.equal(entered.characters[0].presence, '在场');
  assert.equal(entered.characters[0].offscreen, '公司加班，情绪低落（下午）');
});

test('不在场重要NPC：状态账本注入带知情边界与入场覆盖规则', () => {
  const memory = {
    state: {
      ...emptyMemoryState(),
      characters: [{ name: '林静', presence: '在场', offscreen: '公司加班（下午）' }]
    }
  };
  const body = formatMemoryState(memory.state);
  assert.ok(body.includes('在场状态=在场'));
  assert.ok(body.includes('最近场外状态=公司加班（下午）'));
  const block = formatCurrentMemoryState(memory);
  assert.ok(block.includes('仅供衔接'));
  assert.ok(block.includes('场外旁白'));
  assert.ok(block.includes('不等于主控知情'));
});

test('输出模板与思维链：两套状态栏均使用常驻不在场NPC模块', () => {
  for (const id of ['statusbar', 'survival']) {
    const preset = PROMPT_PRESET_SEED.find((item) => item.id === id);
    assert.ok(preset.content.includes('>### 不在场重要NPC'));
    assert.ok(!preset.content.includes('👥场外动态'));
    assert.ok(preset.content.includes('显示被挤出≠记忆删除'));
    assert.ok(preset.content.includes('不等于主控知情'));
  }
  const thinking = PROMPT_PRESET_SEED.find((item) => item.id === 'thinking');
  assert.ok(thinking.content.includes('不在场重要NPC'));
  assert.ok(thinking.content.includes('电话视频仍属不在场'));
});
