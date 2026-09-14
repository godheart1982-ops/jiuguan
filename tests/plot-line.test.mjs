// 剧情线单测：注入块装配 + 剧情线库白名单
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlotStageBlock } from '../src/services/api-messages.js';
import { toPlotPreset } from '../src/services/storage.js';

// ---------- buildPlotStageBlock ----------

test('buildPlotStageBlock: 无剧情线或空阶段返回空串', () => {
  assert.equal(buildPlotStageBlock(null), '');
  assert.equal(buildPlotStageBlock({ mode: 'soft', current: 1, stages: [] }), '');
  assert.equal(buildPlotStageBlock({ mode: 'soft', current: 1, stages: [{ title: '', content: '' }] }), '');
});

test('buildPlotStageBlock: 引力模式——只注入当前阶段，含阶段名与方向', () => {
  const plot = {
    mode: 'soft', current: 2,
    stages: [
      { title: '初识期', content: '职场摩擦', condition: '第一次独处', branches: '女二敌意' },
      { title: '破冰期', content: '关系松动，她开始试探', condition: '她主动分享私事', branches: '' },
      { title: '决裂期', content: '选边', condition: '', branches: '' }
    ]
  };
  const out = buildPlotStageBlock(plot);
  assert.ok(out.includes('第 2 阶段·破冰期'));
  assert.ok(out.includes('共 3 阶段'));
  assert.ok(out.includes('关系松动，她开始试探'));
  assert.ok(out.includes('她主动分享私事'));
  assert.ok(!out.includes('初识期')); // 其他阶段不进上下文
  assert.ok(out.includes('选择优先'));
  assert.ok(out.includes('不得自动翻章'));
  assert.ok(!out.includes('支线种子')); // 当前阶段无支线则不输出该行
});

test('buildPlotStageBlock: 铁轨模式文本与指针越界钳制', () => {
  const plot = { mode: 'hard', current: 99, stages: [{ title: '终章', content: '收束', condition: '', branches: '热搜危机' }] };
  const out = buildPlotStageBlock(plot);
  assert.ok(out.includes('第 1 阶段·终章')); // 指针 99 钳到最后一个
  assert.ok(out.includes('剧情优先'));
  assert.ok(out.includes('掀桌'));
  assert.ok(out.includes('支线种子：热搜危机'));
});

// ---------- toPlotPreset ----------

test('toPlotPreset: 白名单清洗（去指针/去脏字段/去空阶段），mode 非 hard 回落 soft', () => {
  const p = toPlotPreset({
    mode: 'hard',
    current: 3, // 运行态，不入库
    stages: [
      { title: ' 初识期 ', content: ' 摩擦 ', condition: ' 独处 ', branches: '', junk: 'x' },
      { title: '', content: '' }, // 全空阶段剔除
      { title: '破冰期', content: '' }
    ]
  });
  assert.deepEqual(p, {
    mode: 'hard',
    stages: [
      { title: '初识期', content: '摩擦', condition: '独处', branches: '' },
      { title: '破冰期', content: '', condition: '', branches: '' }
    ]
  });
  assert.equal(toPlotPreset({ mode: 'weird', stages: [] }).mode, 'soft');
  assert.deepEqual(toPlotPreset(null), { mode: 'soft', stages: [] });
});
