import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMemoryEditorSnapshots } from '../src/services/memory-editor-merge.js';

function snapshots() {
  return {
    base: {
      state: { scene: '旧场景', characters: [] },
      archive: [{ turnId: 'turn-1', revision: 'r1', index: { title: '旧标题' } }],
      longTermSummaries: [{ id: 'long-1', content: '旧长期', sourceTurnIds: ['turn-1'] }],
      recallLog: [{ userText: '旧召回' }]
    },
    local: {
      state: { scene: '旧场景', characters: [] },
      archive: [{ turnId: 'turn-1', revision: 'r1', index: { title: '旧标题' } }],
      longTermSummaries: [{ id: 'long-1', content: '旧长期', sourceTurnIds: ['turn-1'] }],
      recallLog: [{ userText: '旧召回' }]
    },
    latest: {
      state: { scene: '后台新场景', characters: [{ name: '林静' }] },
      archive: [
        { turnId: 'turn-1', revision: 'r1', index: { title: '旧标题' }, stateAfter: { scene: '后台快照' } },
        { turnId: 'turn-2', revision: 'r2', index: { title: '后台新增索引' } }
      ],
      longTermSummaries: [
        { id: 'long-1', content: '旧长期', sourceTurnIds: ['turn-1'], stale: false },
        { id: 'long-2', content: '后台新增长期', sourceTurnIds: ['turn-2'] }
      ],
      recallLog: [{ userText: '旧召回' }, { userText: '后台新召回' }]
    }
  };
}

test('编辑器未修改时保留后台完成的状态、索引、长期与召回', () => {
  const { base, local, latest } = snapshots();
  const merged = mergeMemoryEditorSnapshots(base, local, latest);
  assert.equal(merged.state.scene, '后台新场景');
  assert.equal(merged.archive.length, 2);
  assert.equal(merged.archive[0].stateAfter.scene, '后台快照');
  assert.equal(merged.longTermSummaries.length, 2);
  assert.equal(merged.recallLog.length, 2);
});

test('用户明确修改优先，同时不抹掉其他后台新增条目', () => {
  const { base, local, latest } = snapshots();
  local.state.scene = '用户手改场景';
  local.archive[0].index.title = '用户手改标题';
  local.longTermSummaries[0].content = '用户手改长期';
  local.recallLog = [];
  const merged = mergeMemoryEditorSnapshots(base, local, latest);
  assert.equal(merged.state.scene, '用户手改场景');
  assert.equal(merged.archive[0].index.title, '用户手改标题');
  assert.equal(merged.archive[1].turnId, 'turn-2');
  assert.equal(merged.longTermSummaries[0].content, '用户手改长期');
  assert.equal(merged.longTermSummaries[1].id, 'long-2');
  assert.deepEqual(merged.recallLog, []);
});

test('编辑器内删除长期记忆不会被后台同ID更新复活', () => {
  const { base, local, latest } = snapshots();
  local.longTermSummaries = [];
  latest.longTermSummaries[0].content = '后台重建版本';
  const merged = mergeMemoryEditorSnapshots(base, local, latest);
  assert.deepEqual(merged.longTermSummaries.map((item) => item.id), ['long-2']);
});
