// 滑动候选：刷新留旧稿、左右翻只改当前稿、下一句丢掉未选中的稿
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  swipeCount,
  activeSwipeIndex,
  beginNewSwipe,
  activateSwipe,
  discardInactiveSwipes,
  rollbackNewSwipe,
  writeSwipeContent,
  readSwipeContent,
  syncActiveSwipe,
  markActiveSwipeAborted,
  isActiveSwipeAborted,
  imagePathsLostByDiscard
} from '../src/pages/chat/chat-swipes.js';
import { syncPendingRecalls } from '../src/services/api-memory.js';

test('刷新在同一条消息上追加一稿，不另起一条', () => {
  const msg = { role: 'assistant', content: '第一稿', timestamp: 't1' };
  const id = beginNewSwipe(msg);
  assert.equal(id, 1);
  assert.equal(swipeCount(msg), 2);
  assert.equal(activeSwipeIndex(msg), 1);
  assert.equal(msg.swipes[0], '第一稿');
  assert.equal(msg.content, '');
  msg.content = '第二稿';
  syncActiveSwipe(msg);
  assert.deepEqual(msg.swipes, ['第一稿', '第二稿']);
});

test('左右翻只切换当前稿，旧稿还在', () => {
  const msg = { role: 'assistant', content: '第一稿' };
  beginNewSwipe(msg);
  msg.content = '第二稿';
  syncActiveSwipe(msg);
  assert.equal(activateSwipe(msg, 0), true);
  assert.equal(msg.content, '第一稿');
  assert.equal(activateSwipe(msg, 1), true);
  assert.equal(msg.content, '第二稿');
  assert.equal(activateSwipe(msg, 1), false);
});

test('手改当前稿后再翻走，改动留在这一稿', () => {
  const msg = { content: '第一稿' };
  beginNewSwipe(msg);
  msg.content = '第二稿';
  syncActiveSwipe(msg);
  activateSwipe(msg, 0);
  msg.content = '第一稿改过';
  assert.equal(activateSwipe(msg, 1), true);
  assert.equal(msg.swipes[0], '第一稿改过');
  assert.equal(msg.content, '第二稿');
});

test('写出图结果写回发起稿，翻走后不盖住当前稿', () => {
  const msg = { content: '第一稿' };
  beginNewSwipe(msg);
  msg.content = '第二稿 ![她](seedream://x)';
  syncActiveSwipe(msg);
  activateSwipe(msg, 0);
  const wrote = writeSwipeContent(msg, 1, '第二稿 ![她](local-img://a.png)');
  assert.equal(wrote.visible, false);
  assert.equal(msg.content, '第一稿');
  assert.equal(readSwipeContent(msg, 1), '第二稿 ![她](local-img://a.png)');
  activateSwipe(msg, 1);
  assert.equal(msg.content, '第二稿 ![她](local-img://a.png)');
});

test('发出下一句后只留当前稿', () => {
  const msg = { content: '第一稿', round: 3, timestamp: 't1' };
  beginNewSwipe(msg);
  msg.content = '第二稿';
  syncActiveSwipe(msg);
  activateSwipe(msg, 0);
  assert.equal(discardInactiveSwipes(msg), true);
  assert.equal(msg.content, '第一稿');
  assert.equal(msg.round, 3);
  assert.equal(msg.timestamp, 't1');
  assert.equal(msg.swipes, undefined);
  assert.equal(msg.swipeId, undefined);
  assert.equal(discardInactiveSwipes(msg), false);
});

test('预览取消会撤回刚开的新稿', () => {
  const msg = { content: '第一稿', aborted: true };
  beginNewSwipe(msg);
  msg.content = 'AI 正在输入…';
  syncActiveSwipe(msg);
  assert.equal(rollbackNewSwipe(msg), true);
  assert.equal(msg.content, '第一稿');
  assert.equal(msg.swipes, undefined);
  assert.equal(msg.aborted, true);
});

test('中止标记跟稿走，翻回完整稿不显示中止', () => {
  const msg = { content: '半截', aborted: true };
  beginNewSwipe(msg);
  msg.content = '完整稿';
  syncActiveSwipe(msg);
  assert.equal(isActiveSwipeAborted(msg), false);
  activateSwipe(msg, 0);
  assert.equal(isActiveSwipeAborted(msg), true);
  assert.equal(msg.content, '半截');
  activateSwipe(msg, 1);
  assert.equal(isActiveSwipeAborted(msg), false);
  markActiveSwipeAborted(msg);
  discardInactiveSwipes(msg);
  assert.equal(msg.content, '完整稿');
  assert.equal(msg.aborted, true);
});

test('丢掉的稿里的插图路径会列出来，当前稿还在用的不删', () => {
  const msg = {
    content: '第一稿 ![她](local-img://images/c/chat/a.png?p=1)'
  };
  beginNewSwipe(msg);
  msg.content = '第二稿 ![她](local-img://images/c/chat/b.png) ![她](local-img://images/c/chat/a.png)';
  syncActiveSwipe(msg);
  activateSwipe(msg, 0);
  const lost = imagePathsLostByDiscard(msg).sort();
  assert.deepEqual(lost, ['images/c/chat/b.png']);
});

test('换稿时记忆调取按当前正文重算', () => {
  const memory = {
    longTerm: [{ content: 'a' }, { content: 'b' }, { content: 'c' }],
    pendingRecalls: [1]
  };
  assert.equal(syncPendingRecalls(memory, '正文\n记忆调取：#2 #9'), true);
  assert.deepEqual(memory.pendingRecalls, [2]);
  assert.equal(syncPendingRecalls(memory, '正文\n记忆调取：#2'), false);
  assert.equal(syncPendingRecalls(memory, '这稿没有调取'), true);
  assert.equal(memory.pendingRecalls, undefined);
});
