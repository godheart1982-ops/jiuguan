// 作者注释：不进历史，按深度插入；频率决定哪一轮送
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAuthorNote,
  storyUserTurnCount,
  shouldInjectAuthorNote,
  insertAuthorNote,
  foldExtraSystemIntoDialog,
  AUTHOR_NOTE_HEADER
} from '../src/services/author-note.js';

function dialog() {
  return [
    { role: 'system', content: '系统' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }
  ];
}

test('空白注释不插入；深度和频率被夹到范围内', () => {
  assert.equal(shouldInjectAuthorNote({ text: '  ', frequency: 1 }, 1), false);
  assert.deepEqual(normalizeAuthorNote({ text: ' 别和好 ', depth: -3, frequency: 99 }), {
    text: '别和好',
    depth: 0,
    frequency: 50
  });
  assert.equal(normalizeAuthorNote(null).frequency, 1);
});

test('频率 1 每轮都送，频率 4 只在第 4、8 轮送，频率 0 暂停', () => {
  const every = { text: '别和好', frequency: 1 };
  const every4 = { text: '别和好', frequency: 4 };
  const paused = { text: '别和好', frequency: 0 };
  assert.equal(shouldInjectAuthorNote(every, 1), true);
  assert.equal(shouldInjectAuthorNote(every, 2), true);
  assert.equal(shouldInjectAuthorNote(every4, 3), false);
  assert.equal(shouldInjectAuthorNote(every4, 4), true);
  assert.equal(shouldInjectAuthorNote(every4, 8), true);
  assert.equal(shouldInjectAuthorNote(paused, 4), false);
});

test('元指令轮不计入频率用的轮次', () => {
  const n = storyUserTurnCount([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '嗯' },
    { role: 'user', content: '$总结', meta: true }
  ]);
  assert.equal(n, 1);
});

test('深度 0 插在最末尾，深度 1 留在最后一条之前', () => {
  const atEnd = insertAuthorNote(dialog(), { text: '别和好', depth: 0 });
  assert.equal(atEnd[atEnd.length - 1].role, 'system');
  assert.ok(atEnd[atEnd.length - 1].content.startsWith(AUTHOR_NOTE_HEADER));
  assert.equal(atEnd[atEnd.length - 2].content, 'u2');

  const beforeLast = insertAuthorNote(dialog(), { text: '别和好', depth: 1 });
  assert.equal(beforeLast[beforeLast.length - 1].content, 'u2');
  assert.equal(beforeLast[beforeLast.length - 2].role, 'system');
});

test('深度超出历史时停在首条 system 之后，不盖住系统提示', () => {
  const msgs = insertAuthorNote(dialog(), { text: '别和好', depth: 20 });
  assert.equal(msgs[0].content, '系统');
  assert.equal(msgs[1].role, 'system');
  assert.ok(msgs[1].content.includes('别和好'));
});

test('Anthropic：作者注释并进相邻 user，首条 system 仍单独拿走', () => {
  const messages = dialog();
  insertAuthorNote(messages, { text: '别和好', depth: 0 });
  messages.push({ role: 'assistant', content: '<思考>', prefix: true });
  const dialogMsgs = foldExtraSystemIntoDialog(messages);
  assert.equal(dialogMsgs.length, 3);
  assert.equal(dialogMsgs[2].role, 'user');
  assert.ok(dialogMsgs[2].content.includes('u2'));
  assert.ok(dialogMsgs[2].content.includes('别和好'));
  assert.equal(dialogMsgs.some(m => m.content === '<思考>'), false);
});
