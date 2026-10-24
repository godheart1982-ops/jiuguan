import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBranchedChat } from '../src/services/chat-branch.js';

function makeChat() {
  return {
    id: 'chat-1',
    characterId: 'char-1',
    title: '与 林悦 的对话',
    messages: [
      { role: 'assistant', content: '开场', timestamp: 't0', round: 0 },
      { role: 'user', content: '你好', timestamp: 't1', round: 1 },
      { role: 'assistant', content: '回复1', timestamp: 't2', round: 1 },
      { role: 'user', content: '选择A', timestamp: 't3', round: 2 },
      { role: 'assistant', content: '回复2', timestamp: 't4', round: 2 }
    ],
    memory: { shortTerm: [{ text: 's' }], longTerm: [{ text: 'l' }], facts: { promises: [] } },
    plot: { mode: 'soft', current: 2, stages: [{ title: '一' }] },
    appearanceAnchors: { 林悦: { text: '锚点', img: 'x.jpg' } },
    authorNote: { text: '保持毒舌', depth: 2, frequency: 1 },
    roundCounter: 2,
    createdAt: 'old',
    updatedAt: 'old'
  };
}

test('buildBranchedChat: 分支点及之前消息保留、之后截断；元信息更新', () => {
  const branched = buildBranchedChat(makeChat(), 2, 'new-id', 'now');
  assert.equal(branched.messages.length, 3);
  assert.equal(branched.messages[2].content, '回复1');
  assert.equal(branched.id, 'new-id');
  assert.equal(branched.characterId, 'char-1');
  assert.equal(branched.title, '与 林悦 的对话 · 分支');
  assert.equal(branched.createdAt, 'now');
  assert.equal(branched.roundCounter, 2);
  assert.deepEqual(branched.plot, { mode: 'soft', current: 2, stages: [{ title: '一' }] });
});

test('buildBranchedChat: 记忆/锚点/作者注释/消息均为深拷贝，改分支不动原线', () => {
  const source = makeChat();
  const branched = buildBranchedChat(source, 4, 'new-id', 'now');
  branched.memory.longTerm.push({ text: '新增' });
  branched.appearanceAnchors.林悦.text = '改过的锚点';
  branched.authorNote.text = '改过的注释';
  branched.messages[0].content = '改过的开场';
  branched.plot.current = 3;
  assert.equal(source.memory.longTerm.length, 1);
  assert.equal(source.appearanceAnchors.林悦.text, '锚点');
  assert.equal(source.authorNote.text, '保持毒舌');
  assert.equal(source.messages[0].content, '开场');
  assert.equal(source.plot.current, 2);
  assert.equal(source.messages.length, 5);
});

test('buildBranchedChat: 越界下标收敛；空对话报错', () => {
  const source = makeChat();
  assert.equal(buildBranchedChat(source, 99, 'x', 'now').messages.length, 5);
  assert.equal(buildBranchedChat(source, -5, 'x', 'now').messages.length, 1);
  assert.throws(() => buildBranchedChat({ messages: [] }, 0, 'x', 'now'));
});
