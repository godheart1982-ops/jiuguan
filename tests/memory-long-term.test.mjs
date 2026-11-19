import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LONG_TERM_GROUP_SIZE, LONG_TERM_RESIDENT_LIMIT, partitionLongTermArchive,
  longTermGroupId, isLongTermSummaryCurrent, getContinuousIndexEntries,
  getResidentLongTermSummaries, getCoveredMemoryTurnIds,
  formatContinuousMemoryIndexes, formatLongTermMemories,
  markLongTermMemoryEdited, filterLongTermSummariesForTurns, previousLongTermSummary
} from '../src/services/memory-long-term.js';

function makeArchive(count) {
  return Array.from({ length: count }, (_, i) => ({
    turnId: `turn-${i + 1}`,
    round: i + 1,
    revision: `rev-${i + 1}`,
    index: { title: `标题${i + 1}`, summary: `摘要${i + 1}`, sceneTime: `11月${i + 1}日 12:00` }
  }));
}

function makeSummary(group) {
  return {
    id: longTermGroupId(group),
    title: `${group[0].index.title}阶段`,
    content: `覆盖${group[0].round}至${group.at(-1).round}轮的关键事件`,
    sourceTurnIds: group.map((entry) => entry.turnId),
    sourceRounds: group.map((entry) => entry.round),
    sourceRevisions: Object.fromEntries(group.map((entry) => [entry.turnId, entry.revision])),
    startSceneTime: group[0].index.sceneTime,
    endSceneTime: group.at(-1).index.sceneTime,
    stale: false
  };
}

test('固定十轮分组：余数全部属于当前短期组，不再只取最近5张', () => {
  const memory = { archive: makeArchive(27), longTermSummaries: [] };
  const { groups, current } = partitionLongTermArchive(memory);
  assert.equal(LONG_TERM_GROUP_SIZE, 10);
  assert.deepEqual(groups.map((group) => group.length), [10, 10]);
  assert.deepEqual(current.map((entry) => entry.round), [21, 22, 23, 24, 25, 26, 27]);
  memory.longTermSummaries = groups.map(makeSummary);
  assert.deepEqual(getContinuousIndexEntries(memory).map((entry) => entry.round), current.map((entry) => entry.round));
  const text = formatContinuousMemoryIndexes(memory);
  assert.ok(text.includes('第 21 轮'));
  assert.ok(text.includes('第 27 轮'));
  assert.ok(!text.includes('第 20 轮'));
});

test('长期组失效时用原索引连续兜底，且失效索引不会造成后续组错位', () => {
  const memory = { archive: makeArchive(22), longTermSummaries: [] };
  const { groups } = partitionLongTermArchive(memory);
  memory.longTermSummaries = groups.map(makeSummary);
  memory.archive[2].index = null;
  const partitioned = partitionLongTermArchive(memory);
  assert.equal(partitioned.groups[1][0].turnId, 'turn-11');
  assert.deepEqual(partitioned.current.map((entry) => entry.round), [21, 22]);
  assert.equal(isLongTermSummaryCurrent(memory.longTermSummaries[0], memory), false);
  assert.deepEqual(getContinuousIndexEntries(memory).map((entry) => entry.round), [1, 2, 4, 5, 6, 7, 8, 9, 10, 21, 22]);
  const text = formatContinuousMemoryIndexes(memory);
  assert.ok(!text.includes('undefined'));
  assert.ok(text.includes('第 21 轮'));
});

test('最近10条长期记忆常驻；覆盖集合不重复包含更早的非驻留组', () => {
  const memory = { archive: makeArchive(125), longTermSummaries: [] };
  const { groups } = partitionLongTermArchive(memory);
  memory.longTermSummaries = groups.map(makeSummary);
  const resident = getResidentLongTermSummaries(memory);
  assert.equal(LONG_TERM_RESIDENT_LIMIT, 10);
  assert.equal(resident.length, 10);
  assert.equal(resident[0].sourceRounds[0], 21);
  assert.equal(resident.at(-1).sourceRounds.at(-1), 120);
  const covered = getCoveredMemoryTurnIds(memory);
  assert.equal(covered.has('turn-1'), false);
  assert.equal(covered.has('turn-21'), true);
  assert.equal(covered.has('turn-125'), true);
  const text = formatLongTermMemories(memory);
  assert.ok(text.includes('仅作历史背景'));
  assert.ok(!text.includes('覆盖1至10轮'));
  assert.ok(text.includes('覆盖111至120轮'));
});

test('来源版本变化或显式编辑会使长期摘要失效，内容手改本身不会', () => {
  const memory = { archive: makeArchive(10), longTermSummaries: [] };
  memory.longTermSummaries = [makeSummary(memory.archive)];
  const summary = memory.longTermSummaries[0];
  summary.content = '用户手动修订后的内容';
  assert.equal(isLongTermSummaryCurrent(summary, memory), true);
  assert.equal(markLongTermMemoryEdited(memory, 'turn-4'), true);
  assert.equal(isLongTermSummaryCurrent(summary, memory), false);
  summary.stale = false;
  memory.archive[4].revision = 'new-revision';
  assert.equal(isLongTermSummaryCurrent(summary, memory), false);
});

test('分支与重发只保留来源完整包含在允许轮次内的长期摘要', () => {
  const memory = { archive: makeArchive(20), longTermSummaries: [] };
  const { groups } = partitionLongTermArchive(memory);
  memory.longTermSummaries = groups.map(makeSummary);
  filterLongTermSummariesForTurns(memory, new Set(groups[0].map((entry) => entry.turnId)));
  assert.deepEqual(memory.longTermSummaries.map((item) => item.id), [longTermGroupId(groups[0])]);
});


test('重建早期长期组时只参考更早摘要，绝不把未来剧情发给副 API', () => {
  const memory = { archive: makeArchive(30), longTermSummaries: [] };
  const { groups } = partitionLongTermArchive(memory);
  memory.longTermSummaries = groups.map(makeSummary);
  assert.equal(previousLongTermSummary(memory, groups, 0), null);
  assert.equal(previousLongTermSummary(memory, groups, 1).id, longTermGroupId(groups[0]));
  memory.longTermSummaries[0].stale = true;
  assert.equal(previousLongTermSummary(memory, groups, 1), null);
  assert.equal(previousLongTermSummary(memory, groups, 2).id, longTermGroupId(groups[1]));
});
