import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getArchivePage, ARCHIVE_PAGE_SIZE } from '../src/pages/memory-archive-panel.js';

test('索引分页：每页 20 张、最新优先、保留原数组下标', () => {
  const archive = Array.from({ length: 45 }, (_, i) => ({ turnId: `turn-${i + 1}` }));
  const first = getArchivePage(archive, 1);
  assert.equal(ARCHIVE_PAGE_SIZE, 20);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].index, 44);
  assert.equal(first.items[0].entry.turnId, 'turn-45');
  assert.equal(first.items.at(-1).entry.turnId, 'turn-26');
  const last = getArchivePage(archive, 3);
  assert.equal(last.items.length, 5);
  assert.equal(last.items[0].index, 4);
  assert.equal(last.items.at(-1).entry.turnId, 'turn-1');
  assert.equal(archive[0].turnId, 'turn-1');
});

test('索引分页：页码越界自动收敛，空数组安全', () => {
  const archive = Array.from({ length: 45 }, (_, i) => ({ turnId: `turn-${i + 1}` }));
  assert.equal(getArchivePage(archive, 99).page, 3);
  assert.equal(getArchivePage(archive, 0).page, 1);
  const empty = getArchivePage([], 8);
  assert.equal(empty.page, 1);
  assert.equal(empty.totalPages, 1);
  assert.deepEqual(empty.items, []);
});
