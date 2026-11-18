import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureMemoryEngine, emptyMemoryState, turnIdOf, archiveEntryForRound,
  applyMemoryStatePatch, formatMemoryState, formatRecalledTurns,
  needsMemoryRawFallback, markMessageMemoryEdited, truncateMemoryForResend, readArchivedTurn
} from '../src/services/memory-engine.js';

function makeRound(n, userText = `输入${n}`, aiText = `回复${n}`) {
  return {
    user: { role: 'user', turnId: `turn-${n}`, timestamp: `t${n}`, round: n, content: userText },
    assistant: { role: 'assistant', timestamp: `a${n}`, round: n, content: aiText }
  };
}

test('永久轮次 ID：已有 turnId 不变，老消息首次计算后补写', () => {
  const round = makeRound(1);
  assert.equal(turnIdOf(round), 'turn-1');
  delete round.user.turnId;
  const id = turnIdOf(round);
  assert.equal(round.user.turnId, id);
  round.user.timestamp = 'edited-time';
  assert.equal(turnIdOf(round), id);
});

test('原文档案：索引不复制原文，引用消息时清理并附开场白', () => {
  const round = makeRound(1, '你好', '<思考>推演</思考>正文\n\n>### 行动选项\n1. 其他可能');
  const plain = archiveEntryForRound(round);
  const withGreeting = archiveEntryForRound(round, '开场');
  assert.equal('userText' in plain, false);
  assert.equal('assistantText' in plain, false);
  assert.equal(plain.revision, withGreeting.revision);
  assert.equal(withGreeting.includeGreeting, true);
  const raw = readArchivedTurn([{ role: 'assistant', content: '开场' }, round.user, round.assistant], withGreeting);
  assert.equal(raw.userText, '你好');
  assert.ok(raw.assistantText.includes('【开场白】'));
  assert.ok(raw.assistantText.includes('正文'));
  assert.ok(!raw.assistantText.includes('行动选项'));
});

test('状态补丁：未提旧项不变，人物按名局部更新，删除必须显式', () => {
  const state = emptyMemoryState();
  state.characters.push({ name: '夏逐波', relation: '炮友', agreement: '无排他承诺', mood: '平静' });
  state.promises.push({ id: 'p1', text: '周五复诊', status: 'open' });
  const next = applyMemoryStatePatch(state, {
    characters: [{ name: '夏逐波', relation: '', mood: '紧张', evidence: '她抓紧了书' }],
    promises: [{ id: 'p2', text: '周日看电影', status: 'open' }]
  }, 'turn-2');
  assert.equal(next.characters[0].relation, '炮友');
  assert.equal(next.characters[0].agreement, '无排他承诺');
  assert.equal(next.characters[0].mood, '紧张');
  assert.equal(next.promises[0].status, 'open');
  assert.equal(next.promises.length, 2);
  assert.equal(next.asOfTurn, 'turn-2');
  applyMemoryStatePatch(next, { promises: [{ id: 'p1', op: 'remove' }] }, 'turn-3');
  assert.equal(next.promises.length, 1);
  assert.equal(next.promises[0].text, '周日看电影');
});

test('状态账本格式化：保留关系约定、约定、事件与知情范围', () => {
  const state = emptyMemoryState();
  state.scene = '11月21日 22:45 观音桥家';
  state.characters.push({ name: '夏逐波', relation: '炮友', agreement: '无排他承诺', scores: '好感50' });
  state.promises.push({ text: '周五复诊', status: 'open', due: '周五' });
  state.events.push({ text: '裁员评审', stage: '发酵' });
  state.intel.push({ text: '主控已婚', knownBy: ['夏逐波'] });
  const text = formatMemoryState(state);
  assert.ok(text.includes('无排他承诺'));
  assert.ok(text.includes('周五复诊'));
  assert.ok(text.includes('裁员评审→发酵'));
  assert.ok(text.includes('夏逐波'));
});

test('历史原文注入：明确过去属性并从 messages 读取详细对话', () => {
  const round = makeRound(38, '你凭什么管我', '当初我们说好不干涉');
  const entry = archiveEntryForRound(round);
  entry.index = { title: '确认炮友边界' };
  const text = formatRecalledTurns([{ entry, before: '前情', after: '后续' }], [round.user, round.assistant]);
  assert.ok(text.includes('只代表过去'));
  assert.ok(text.includes('当初我们说好不干涉'));
  assert.ok(text.includes('前情'));
});

test('快速连发兜底：倒数第二轮未入库或版本变化时增加原文窗口', () => {
  const memory = { archive: [] };
  const rounds = [makeRound(1), makeRound(2)];
  assert.equal(needsMemoryRawFallback(memory, rounds), true);
  memory.archive.push({ ...archiveEntryForRound(rounds[0]), index: { title: '已整理' } });
  assert.equal(needsMemoryRawFallback(memory, rounds), false);
  assert.equal(needsMemoryRawFallback(memory, [makeRound(3)]), false);
});

test('编辑已入库轮次：旧索引立即失效；未入库最新轮不受影响', () => {
  const round = makeRound(1);
  const entry = { ...archiveEntryForRound(round), index: { title: '旧索引' }, stateAfter: emptyMemoryState() };
  const chat = {
    messages: [round.user, round.assistant],
    memory: { archive: [entry], state: emptyMemoryState() }
  };
  assert.equal(markMessageMemoryEdited(chat, round.assistant), true);
  assert.equal(entry.index, null);
  assert.equal(entry.stateAfter, null);
  assert.equal(chat.memory.state.stale, true);
  assert.equal(markMessageMemoryEdited(chat, round.assistant), true); // 幂等仍可标记
  const fresh = makeRound(2);
  chat.messages.push(fresh.user, fresh.assistant);
  assert.equal(markMessageMemoryEdited(chat, fresh.assistant), false);
});

test('记忆结构初始化幂等，旧版重复原文自动剔除', () => {
  const memory = { archive: [{ turnId: 'turn-1', userText: '重复输入', assistantText: '重复回复' }] };
  ensureMemoryEngine(memory);
  assert.equal('userText' in memory.archive[0], false);
  assert.equal('assistantText' in memory.archive[0], false);
  assert.equal(memory.engine, 'archive-v1');
  ensureMemoryEngine(memory);
  assert.equal(memory.engine, 'archive-v1');
});


test('编辑重发：截断目标及之后档案并恢复重发点前状态', () => {
  const r1 = makeRound(1);
  const r2 = makeRound(2);
  const chat = {
    messages: [r1.user, r1.assistant, r2.user, r2.assistant],
    memory: {
      archive: [
        { turnId: 'turn-1', stateAfter: { ...emptyMemoryState(), scene: '第一轮后' } },
        { turnId: 'turn-2', stateAfter: { ...emptyMemoryState(), scene: '第二轮后' } }
      ],
      state: { ...emptyMemoryState(), scene: '第二轮后' },
      recallLog: [{ turnIds: ['turn-2'] }]
    }
  };
  truncateMemoryForResend(chat, r2.user);
  assert.equal(chat.memory.archive.length, 1);
  assert.equal(chat.memory.state.scene, '第一轮后');
  assert.equal(chat.memory.recallLog.length, 0);
});
