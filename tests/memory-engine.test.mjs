import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureMemoryEngine, emptyMemoryState, turnIdOf, archiveEntryForRound,
  applyMemoryStatePatch, formatMemoryState, formatRecentMemoryIndexes, formatRecalledTurns,
  needsMemoryRawFallback, getMemoryRawWindowSize, markMessageMemoryEdited, truncateMemoryForResend, readArchivedTurn,
  finalizeRecallSelections, chunkRecallCards, runRecallPipeline, sceneTimeFromText,
  syncMemoryProfiles, makeMemoryStateSnapshot, restoreMemoryStateSnapshot,
  memoryStateForRound, characterCardForMemoryRound, fillMissingIndexSceneTimes
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

test('多轮命中：较早轮次只给摘要，最近两轮保留详细原文', () => {
  const rounds = [1, 2, 3, 4].map((n) => makeRound(n));
  const recalls = rounds.map((round, i) => ({
    entry: { ...archiveEntryForRound(round), index: { title: `标题${i + 1}`, summary: `摘要${i + 1}` } },
    detail: i >= 2
  }));
  const messages = rounds.flatMap((round) => [round.user, round.assistant]);
  const text = formatRecalledTurns(recalls, messages);
  assert.ok(text.includes('【历史摘要｜第 1 轮'));
  assert.ok(text.includes('【历史摘要｜第 2 轮'));
  assert.ok(text.includes('【历史详细原文｜第 3 轮'));
  assert.ok(text.includes('【历史详细原文｜第 4 轮'));
  assert.ok(!text.includes('用户：输入1'));
  assert.ok(!text.includes('用户：输入2'));
  assert.ok(text.includes('用户：输入3'));
  assert.ok(text.includes('用户：输入4'));
});

test('分级召回：low 丢弃、medium 只给摘要、最近两轮 high 展开原文', () => {
  const memory = {
    archive: [1, 2, 3, 4].map((n) => ({ ...archiveEntryForRound(makeRound(n)), index: { title: `标题${n}` } }))
  };
  const recalls = finalizeRecallSelections(memory, [
    { turnId: 'turn-1', level: 'high' },
    { turnId: 'turn-2', level: 'medium' },
    { turnId: 'turn-3', level: 'low' },
    { turnId: 'turn-4', level: 'high' }
  ], 'normal');
  assert.equal(recalls.length, 3);
  assert.equal(recalls.find((r) => r.turnId === 'turn-2').detail, false);
  assert.equal(recalls.find((r) => r.turnId === 'turn-1').detail, true);
  assert.equal(recalls.find((r) => r.turnId === 'turn-4').detail, true);
  assert.equal(finalizeRecallSelections(memory, [{ turnId: 'turn-1', level: 'high' }], 'none').length, 0);
});

test('长线回顾最多 16 条；索引卡按 200 张分批', () => {
  const memory = {
    archive: Array.from({ length: 20 }, (_, i) => ({
      ...archiveEntryForRound(makeRound(i + 1)), index: { title: `标题${i + 1}` }
    }))
  };
  const rows = memory.archive.map((entry) => ({ turnId: entry.turnId, level: 'high' }));
  assert.equal(finalizeRecallSelections(memory, rows, 'review').length, 16);
  const cards = Array.from({ length: 450 }, (_, i) => ({ turnId: `t${i}` }));
  assert.deepEqual(chunkRecallCards(cards).map((c) => c.length), [200, 200, 50]);
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


test('查询改写并入粗筛：普通且明确时不增加复选调用', async () => {
  const cards = [{ turnId: 'turn-1' }, { turnId: 'turn-2' }];
  const calls = [];
  const result = await runRecallPipeline(cards, { userMessage: '继续' }, async (batch, query, phase) => {
    calls.push({ batch, query, phase });
    return {
      rows: [{ turnId: 'turn-1', level: 'medium' }],
      scope: 'normal', rewrittenQuery: '继续当前互动', needsRerank: false
    };
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, 'coarse');
  assert.equal(result.rewrittenQuery, '继续当前互动');
  assert.equal(result.reranked, false);
  assert.equal(result.rows[0].turnId, 'turn-1');
});

test('特定旧事复选：携带改写意图，且不得扩大到粗筛候选之外', async () => {
  const cards = [{ turnId: 'turn-1' }, { turnId: 'turn-2' }, { turnId: 'turn-3' }];
  const calls = [];
  const result = await runRecallPipeline(cards, { userMessage: '她还记得那件事吗' }, async (batch, query, phase) => {
    calls.push({ batch, query, phase });
    if (phase === 'coarse') {
      return {
        rows: [{ turnId: 'turn-1', level: 'medium' }, { turnId: 'turn-2', level: 'medium' }],
        scope: 'specific', rewrittenQuery: '林雪是否记得上周的约定', needsRerank: true
      };
    }
    return {
      rows: [{ turnId: 'turn-2', level: 'high' }, { turnId: 'turn-3', level: 'high' }],
      scope: 'specific', rewrittenQuery: '', needsRerank: false
    };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].phase, 'final');
  assert.equal(calls[1].query.rewrittenQuery, '林雪是否记得上周的约定');
  assert.deepEqual(calls[1].batch.map((card) => card.turnId), ['turn-1', 'turn-2']);
  assert.deepEqual(result.rows.map((row) => row.turnId), ['turn-2']);
  assert.equal(result.reranked, true);
});

test('大量索引保持分批粗筛与汇总复选，并传递改写意图', async () => {
  const cards = Array.from({ length: 201 }, (_, i) => ({ turnId: `turn-${i + 1}` }));
  const calls = [];
  const result = await runRecallPipeline(cards, { userMessage: '回顾我们的关系' }, async (batch, query, phase) => {
    calls.push({ batch, query, phase });
    if (phase === 'final') {
      return {
        rows: [{ turnId: 'turn-201', level: 'high' }],
        scope: 'review', rewrittenQuery: '', needsRerank: false
      };
    }
    const isLastBatch = batch.some((card) => card.turnId === 'turn-201');
    return {
      rows: isLastBatch ? [{ turnId: 'turn-201', level: 'medium' }] : [],
      scope: isLastBatch ? 'review' : 'normal',
      rewrittenQuery: isLastBatch ? '回顾主控与林雪的关系关键节点' : '',
      needsRerank: true
    };
  });
  assert.equal(calls.filter((call) => call.phase === 'coarse').length, 2);
  assert.equal(calls.filter((call) => call.phase === 'final').length, 1);
  assert.equal(calls.at(-1).query.rewrittenQuery, '回顾主控与林雪的关系关键节点');
  assert.equal(result.rows[0].turnId, 'turn-201');
  assert.equal(result.scope, 'review');
});


test('近期剧情脉络：先排原文窗口再取最近 5 张，召回去重后不补足', () => {
  const memory = {
    archive: Array.from({ length: 7 }, (_, i) => ({
      turnId: `turn-${i + 1}`,
      round: i + 1,
      index: { title: `标题${i + 1}`, summary: `摘要${i + 1}`, keywords: ['不应注入的关键词'] }
    }))
  };
  const text = formatRecentMemoryIndexes(memory, {
    recalledTurns: [{ entry: { turnId: 'turn-4' } }],
    rawWindowTurnIds: ['turn-7']
  });
  assert.ok(text.includes('近期剧情脉络'));
  assert.ok(text.includes('第 2 轮｜标题2：摘要2'));
  assert.ok(text.includes('第 3 轮｜标题3：摘要3'));
  assert.ok(text.includes('第 5 轮｜标题5：摘要5'));
  assert.ok(text.includes('第 6 轮｜标题6：摘要6'));
  assert.ok(!text.includes('第 4 轮'));
  assert.ok(!text.includes('第 7 轮'));
  assert.ok(!text.includes('第 1 轮'));
  assert.ok(!text.includes('不应注入的关键词'));
  assert.ok(text.indexOf('第 2 轮') < text.indexOf('第 3 轮'));
  assert.ok(text.indexOf('第 3 轮') < text.indexOf('第 5 轮'));
});


test('召回记录：初始化即裁剪为最近 20 条且保持幂等', () => {
  const memory = {
    recallLog: Array.from({ length: 25 }, (_, i) => ({ id: i, turnIds: [] }))
  };
  ensureMemoryEngine(memory);
  assert.equal(memory.recallLog.length, 20);
  assert.equal(memory.recallLog[0].id, 5);
  assert.equal(memory.recallLog.at(-1).id, 24);
  ensureMemoryEngine(memory);
  assert.equal(memory.recallLog.length, 20);
});


test('动态原文窗口：连续待整理轮次全部携带，遇到最近有效索引即停止', () => {
  const rounds = [makeRound(1), makeRound(2), makeRound(3), makeRound(4)];
  const memory = { archive: [] };
  memory.archive.push({ ...archiveEntryForRound(rounds[0]), index: { title: '已整理1' } });
  assert.equal(getMemoryRawWindowSize(memory, rounds), 3);
  memory.archive.push({ ...archiveEntryForRound(rounds[1]), index: { title: '已整理2' } });
  memory.archive.push({ ...archiveEntryForRound(rounds[2]), index: { title: '已整理3' } });
  assert.equal(getMemoryRawWindowSize(memory, rounds), 1);
  memory.archive[2].revision = 'stale';
  assert.equal(getMemoryRawWindowSize(memory, rounds), 2);
});

test('动态原文窗口：不会把新记忆系统启用前的旧聊天全部卷入', () => {
  const rounds = [makeRound(1), makeRound(2), makeRound(3), makeRound(4)];
  const memory = { archive: [], engineStartedAt: 't3' };
  assert.equal(getMemoryRawWindowSize(memory, rounds), 2);
});


test('索引剧情时间：从状态栏提取完整日期时间，不使用现实发送时间', () => {
  const text = '📅日期:2026年11月19日_星期四  🕑时间:18:05【按剧情推进】\n🗺️地点:家';
  assert.equal(sceneTimeFromText(text), '2026年11月19日_星期四 18:05');
  assert.equal(sceneTimeFromText('无状态栏'), '');
});

test('索引剧情时间：近期脉络和召回详细原文均显式携带', () => {
  const round = makeRound(8);
  const entry = {
    ...archiveEntryForRound(round),
    index: { title: '确认约定', summary: '林静与主控约定复诊', sceneTime: '2026年11月19日_星期四 18:05' }
  };
  const recent = formatRecentMemoryIndexes({ archive: [entry] });
  assert.ok(recent.includes('时间：2026年11月19日_星期四 18:05'));
  const recalled = formatRecalledTurns([{ entry, detail: true }], [round.user, round.assistant]);
  assert.ok(recalled.includes('时间：2026年11月19日_星期四 18:05'));
  const old = formatRecentMemoryIndexes({ archive: [{ ...entry, index: { title: '旧索引', summary: '旧摘要' } }] });
  assert.ok(old.includes('时间：时间未记录'));
});


test('固定人物档案：快照省略固定字段并可从 profiles 完整恢复', () => {
  const memory = {
    state: {
      ...emptyMemoryState(),
      characters: [{
        name: '林静', appearance: '神似新垣结衣；168cm', kinks: '被夸奖',
        outerAura: '端庄', innerAura: '敏感', mood: '低落'
      }]
    }
  };
  syncMemoryProfiles(memory);
  const snapshot = makeMemoryStateSnapshot(memory.state);
  assert.equal(snapshot.characters[0].kinks, undefined);
  assert.equal(snapshot.characters[0].outerAura, undefined);
  assert.equal(snapshot.characters[0].appearance, '神似新垣结衣；168cm');
  assert.equal(snapshot.characters[0].mood, '低落');
  const restored = restoreMemoryStateSnapshot(snapshot, memory);
  assert.equal(restored.characters[0].kinks, '被夸奖');
  assert.equal(restored.characters[0].outerAura, '端庄');
  assert.equal(restored.characters[0].innerAura, '敏感');
});

test('后台总结输入：只保留本轮相关人物，档案完整时不重复附角色卡', () => {
  const complete = {
    name: '林静', appearance: '168cm', kinks: '被夸奖', outerAura: '端庄', innerAura: '敏感'
  };
  const other = { ...complete, name: '苏晴' };
  const state = { ...emptyMemoryState(), characters: [complete, other] };
  const round = makeRound(1, '林静你好', '林静点头');
  const relevant = memoryStateForRound(state, round);
  assert.deepEqual(relevant.characters.map((c) => c.name), ['林静']);
  const character = { background: '背景', characterModules: ['林静的角色设定', '苏晴的角色设定'] };
  assert.equal(characterCardForMemoryRound(character, state, round), '');
  const missing = { ...state, characters: [{ ...complete, appearance: '' }] };
  assert.ok(characterCardForMemoryRound(character, missing, round).includes('林静的角色设定'));
});

test('旧索引时间：从对应原文本地补齐，不改已有时间', () => {
  const first = makeRound(1, '你好', '📅日期:2026年11月19日_星期四  🕑时间:18:05【推进】');
  const second = makeRound(2, '再见', '📅日期:2026年11月20日_星期五  🕑时间:09:00【推进】');
  const archive = [
    { ...archiveEntryForRound(first), index: { title: '一' } },
    { ...archiveEntryForRound(second), index: { title: '二', sceneTime: '手动时间' } }
  ];
  const messages = [first.user, first.assistant, second.user, second.assistant];
  assert.equal(fillMissingIndexSceneTimes(archive, messages), 1);
  assert.equal(archive[0].index.sceneTime, '2026年11月19日_星期四 18:05');
  assert.equal(archive[1].index.sceneTime, '手动时间');
});

test('单一明确旧事候选：无需第二次复选', async () => {
  const cards = [{ turnId: 'turn-1' }, { turnId: 'turn-2' }];
  let calls = 0;
  const result = await runRecallPipeline(cards, {}, async () => {
    calls++;
    return {
      rows: [{ turnId: 'turn-1', level: 'high' }],
      scope: 'specific', rewrittenQuery: '明确旧事', needsRerank: false
    };
  });
  assert.equal(calls, 1);
  assert.equal(result.reranked, false);
  assert.equal(result.rows[0].turnId, 'turn-1');
});
