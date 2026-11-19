import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAllRounds } from '../src/pages/chat/chat-memory-helpers.js';

function round(n, assistant = {}) {
  return [
    { role: 'user', content: `输入${n}`, round: n },
    { role: 'assistant', content: `回复${n}`, round: n, ...assistant }
  ];
}

test('记忆轮次只收完整定稿：失败、空回复和中止稿均不进入索引', () => {
  const messages = [
    ...round(1),
    ...round(2, { content: '（生成失败：网络错误）' }),
    ...round(3, { content: '半途而废', aborted: true }),
    ...round(4)
  ];
  assert.deepEqual(getAllRounds(messages).map((item) => item.user.round), [1, 4]);
});

test('多稿只按当前选定稿判断是否中止，不影响其他正常轮次', () => {
  const messages = round(1, {
    content: '当前正常稿',
    swipes: ['中止稿', '当前正常稿'],
    swipeId: 1,
    abortedSwipes: [0],
    aborted: false
  });
  assert.equal(getAllRounds(messages).length, 1);
  messages[1].swipeId = 0;
  messages[1].content = '中止稿';
  messages[1].aborted = true;
  assert.equal(getAllRounds(messages).length, 0);
});
