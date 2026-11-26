import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureMemoryEngine, emptyMemoryState, turnIdOf, archiveEntryForRound,
  applyMemoryStatePatch, formatMemoryState, formatRecentMemoryIndexes, formatRecalledTurns,
  needsMemoryRawFallback, getMemoryRawWindowSize, markMessageMemoryEdited, truncateMemoryForResend, readArchivedTurn,
  finalizeRecallSelections, chunkRecallCards, runRecallPipeline, sceneTimeFromText,
  syncMemoryProfiles, makeMemoryStateSnapshot, restoreMemoryStateSnapshot,
  memoryStateForRound, characterCardForMemoryRound, fillMissingIndexSceneTimes, queryNeedsHistoricalDetail,
  filterCoveredRecallRows, shouldRunMemoryRecall, formatMemoryStateForRecall, cleanRecentAssistantForRecall,
  formatCurrentMemoryState, resolveRecallReferenceTime
} from '../src/services/memory-engine.js';
import { splitSystemForCache } from '../src/services/api-anthropic.js';
import { longTermGroupId } from '../src/services/memory-long-term.js';
import { resolveRawWindowSize } from '../src/services/api-messages.js';

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
  state.characters.push({ name: '夏逐波', core: '自由撰稿人，重视边界', relation: '炮友', agreement: '无排他承诺', mood: '平静' });
  state.promises.push({ id: 'p1', text: '周五复诊', status: 'open' });
  const next = applyMemoryStatePatch(state, {
    characters: [{ name: '夏逐波', relation: '', mood: '紧张', evidence: '她抓紧了书' }],
    promises: [{ id: 'p2', text: '周日看电影', status: 'open' }]
  }, 'turn-2');
  assert.equal(next.characters[0].core, '自由撰稿人，重视边界');
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
  state.characters.push({ name: '夏逐波', core: '独立插画师，想自由却怕失去稳定收入', relation: '炮友', agreement: '无排他承诺', scores: '好感50' });
  state.promises.push({ text: '周五复诊', status: 'open', due: '周五' });
  state.events.push({ text: '裁员评审', stage: '发酵' });
  state.intel.push({ text: '主控已婚', knownBy: ['夏逐波'] });
  const text = formatMemoryState(state);
  assert.ok(text.includes('一句话核心=独立插画师，想自由却怕失去稳定收入'));
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

test('分级召回：low 丢弃；默认全摘要，明确核验时最近两轮 high 展开原文', () => {
  const memory = {
    archive: [1, 2, 3, 4].map((n) => ({ ...archiveEntryForRound(makeRound(n)), index: { title: `标题${n}` } }))
  };
  const rows = [
    { turnId: 'turn-1', level: 'high' },
    { turnId: 'turn-2', level: 'medium' },
    { turnId: 'turn-3', level: 'low' },
    { turnId: 'turn-4', level: 'high' }
  ];
  const summaries = finalizeRecallSelections(memory, rows, 'normal');
  assert.equal(summaries.length, 3);
  assert.ok(summaries.every((recall) => recall.detail === false));
  const recalls = finalizeRecallSelections(memory, rows, 'normal', { allowDetail: true });
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
  assert.equal(memory.engine, 'archive-v2');
  assert.deepEqual(memory.longTermSummaries, []);
  ensureMemoryEngine(memory);
  assert.equal(memory.engine, 'archive-v2');
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


test('连续剧情脉络：当前短期组全部携带，排除原文与召回重复项', () => {
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
  assert.ok(text.includes('连续剧情脉络'));
  assert.ok(text.includes('第 1 轮｜标题1：摘要1'));
  assert.ok(text.includes('第 2 轮｜标题2：摘要2'));
  assert.ok(text.includes('第 3 轮｜标题3：摘要3'));
  assert.ok(text.includes('第 5 轮｜标题5：摘要5'));
  assert.ok(text.includes('第 6 轮｜标题6：摘要6'));
  assert.ok(!text.includes('第 4 轮'));
  assert.ok(!text.includes('第 7 轮'));
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
        name: '林静', core: '咖啡店长，想守住小店', appearance: '神似新垣结衣；168cm', kinks: '被夸奖',
        outerAura: '端庄', innerAura: '敏感', mood: '低落'
      }]
    }
  };
  syncMemoryProfiles(memory);
  const snapshot = makeMemoryStateSnapshot(memory.state);
  assert.equal(snapshot.characters[0].kinks, undefined);
  assert.equal(snapshot.characters[0].outerAura, undefined);
  assert.equal(snapshot.characters[0].appearance, '神似新垣结衣；168cm');
  assert.equal(snapshot.characters[0].core, '咖啡店长，想守住小店');
  assert.equal(memory.profiles.林静.core, undefined);
  assert.equal(snapshot.characters[0].mood, '低落');
  const restored = restoreMemoryStateSnapshot(snapshot, memory);
  assert.equal(restored.characters[0].kinks, '被夸奖');
  assert.equal(restored.characters[0].outerAura, '端庄');
  assert.equal(restored.characters[0].innerAura, '敏感');
});

test('后台总结输入：只保留本轮相关人物，档案完整时不重复附角色卡', () => {
  const complete = {
    name: '林静', core: '咖啡店长，想守住小店', appearance: '168cm', kinks: '被夸奖', outerAura: '端庄', innerAura: '敏感'
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
  const missingCore = { ...state, characters: [{ ...complete, core: '' }] };
  assert.ok(characterCardForMemoryRound(character, missingCore, round).includes('林静的角色设定'));
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


test('远史详细原文门槛：普通旧事只给摘要，原话与具体互动才核验原文', () => {
  assert.equal(queryNeedsHistoricalDetail('还记得我们上次约会吗'), false);
  assert.equal(queryNeedsHistoricalDetail('她当时的原话是什么'), true);
  assert.equal(queryNeedsHistoricalDetail('具体怎么互动的'), true);
});

test('召回管线汇总 needsDetail，不因复选丢失原文核验意图', async () => {
  const result = await runRecallPipeline(
    [{ turnId: 'turn-1' }, { turnId: 'turn-2' }],
    { userMessage: '继续' },
    async (batch, query, phase) => phase === 'coarse'
      ? { rows: [{ turnId: 'turn-1', level: 'high' }, { turnId: 'turn-2', level: 'medium' }], scope: 'specific', needsRerank: true, needsDetail: true }
      : { rows: [{ turnId: 'turn-1', level: 'high' }], scope: 'specific', needsDetail: false }
  );
  assert.equal(result.needsDetail, true);
});


test('动态原文窗口不设50轮截断；关闭记忆时仍遵守卡级上限', () => {
  assert.equal(resolveRawWindowSize({}, true, 73), 73);
  assert.equal(resolveRawWindowSize({}, true, 1), 1);
  assert.equal(resolveRawWindowSize({ rawWindowTurns: 73 }, false), 50);
  assert.equal(resolveRawWindowSize({ rawWindowTurns: 0 }, false), 0);
});


test('常驻覆盖区后置去重：普通续写排除，明确旧事和长线回顾仍允许召回', () => {
  const rows = [
    { turnId: 'turn-1', level: 'high' },
    { turnId: 'turn-49', level: 'high' },
    { turnId: 'turn-120', level: 'medium' }
  ];
  const covered = new Set(['turn-1', 'turn-49']);
  assert.deepEqual(
    filterCoveredRecallRows(rows, 'normal', covered).map((row) => row.turnId),
    ['turn-120']
  );
  assert.deepEqual(
    filterCoveredRecallRows(rows, 'specific', covered).map((row) => row.turnId),
    ['turn-1', 'turn-49', 'turn-120']
  );
  assert.deepEqual(
    filterCoveredRecallRows(rows, 'review', covered).map((row) => row.turnId),
    ['turn-1', 'turn-49', 'turn-120']
  );
  assert.deepEqual(
    filterCoveredRecallRows(rows, 'normal', covered, true).map((row) => row.turnId),
    ['turn-1', 'turn-49', 'turn-120']
  );
});

test('Anthropic 缓存切分：从最早出现的动态记忆块切开，不把当前状态账本混入静态缓存', () => {
  const staticPart = '角色卡设定\n\n【输出格式要求】...';
  const dynamicPart = '\n\n【当前状态账本】\n场景：咖啡店\n\n【长期记忆】\n过去的事';
  const blocks = splitSystemForCache(staticPart + dynamicPart);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, staticPart);
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.equal(blocks[1].text, dynamicPart);
  assert.equal(blocks[1].cache_control, undefined);

  const staticOnly = splitSystemForCache('纯静态角色卡');
  assert.equal(staticOnly.length, 1);
  assert.deepEqual(staticOnly[0].cache_control, { type: 'ephemeral' });
});

test('前置召回跳过策略：全员已在连续脉络且非原话核验时跳过；存在长期压缩或查原话时放行', () => {
  const shortMemory = {
    archive: Array.from({ length: 5 }, (_, i) => ({
      turnId: `turn-${i + 1}`, round: i + 1, revision: `r${i + 1}`,
      index: { title: `标题${i + 1}`, summary: `摘要${i + 1}` }
    })),
    longTermSummaries: []
  };
  assert.equal(shouldRunMemoryRecall(shortMemory, { userMessage: '继续往前走', excludeTurnIds: ['turn-5'] }), false);
  assert.equal(shouldRunMemoryRecall(shortMemory, { userMessage: '她当时的原话是什么', excludeTurnIds: ['turn-5'] }), true);

  const longArchive = Array.from({ length: 12 }, (_, i) => ({
    turnId: `turn-${i + 1}`, round: i + 1, revision: `r${i + 1}`,
    index: { title: `标题${i + 1}`, summary: `摘要${i + 1}` }
  }));
  const firstGroup = longArchive.slice(0, 10);
  const longMemory = {
    archive: longArchive,
    longTermSummaries: [{
      id: longTermGroupId(firstGroup),
      content: '前十轮摘要',
      sourceTurnIds: firstGroup.map((e) => e.turnId),
      sourceRevisions: Object.fromEntries(firstGroup.map((e) => [e.turnId, e.revision])),
      stale: false
    }]
  };
  assert.equal(shouldRunMemoryRecall(longMemory, { userMessage: '继续往前走', excludeTurnIds: ['turn-12'] }), true);
});

test('角色卡按需附带：kinks 留空（未成年/无特殊XP）不再导致每轮重复附带整份角色卡', () => {
  const noKinks = {
    name: '小满', core: '高三学生，备考压力大', appearance: '162cm', kinks: '', outerAura: '开朗', innerAura: '敏感'
  };
  const state = { ...emptyMemoryState(), characters: [noKinks] };
  const round = makeRound(2, '小满早安', '小满笑着挥手');
  const character = { background: '背景', characterModules: ['小满的角色设定'] };
  assert.equal(characterCardForMemoryRound(character, state, round), '');
});

test('召回载荷瘦身：消歧状态省略外貌/性癖/气质，最近回复剥离思考块/菜单/插图并控长', () => {
  const state = emptyMemoryState();
  state.scene = '咖啡馆';
  state.characters.push({
    name: '林静', core: '咖啡店长', presence: '在场', relation: '朋友',
    appearance: '168cm D杯', kinks: '支配', outerAura: '端庄', innerAura: '敏感'
  });
  const compact = formatMemoryStateForRecall(state);
  assert.ok(compact.includes('场景：咖啡馆'));
  assert.ok(compact.includes('核心=咖啡店长'));
  assert.ok(!compact.includes('168cm'));
  assert.ok(!compact.includes('支配'));
  assert.ok(!compact.includes('端庄'));

  const cleaned = cleanRecentAssistantForRecall('<思考>内部推理</思考>正文内容\n\n>### 行动选项\n1. A\n>### 🖼️插图\n![a](seedream://)', 100);
  assert.equal(cleaned, '正文内容');
  const longText = cleanRecentAssistantForRecall('甲'.repeat(500) + '乙'.repeat(500), 200);
  assert.ok(longText.includes('…（中略）…'));
  assert.ok(longText.length < 220);
});

test('Anthropic 双断点缓存：长期记忆前置时切为静态缓存 + 长期记忆缓存 + 每轮动态不缓存三段', () => {
  const staticPart = '角色卡设定\n\n【输出格式要求】...';
  const longTermPart = '\n\n【长期记忆】\n第1-10轮摘要';
  const dynamicPart = '\n\n【当前状态账本】\n场景：咖啡店\n\n【连续剧情脉络】\n第11轮';
  const blocks = splitSystemForCache(staticPart + longTermPart + dynamicPart);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].text, staticPart);
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.equal(blocks[1].text, longTermPart);
  assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' });
  assert.equal(blocks[2].text, dynamicPart);
  assert.equal(blocks[2].cache_control, undefined);
});

test('休眠 NPC 动态分级折叠：超 6 人时折叠远期不在场人物，提及时瞬间全字段唤醒', () => {
  const archive = Array.from({ length: 15 }, (_, i) => ({ turnId: `turn-${i + 1}`, round: i + 1 }));
  const makeChar = (name, extra = {}) => ({
    name,
    core: `${name}的核心`,
    presence: '不在场',
    offscreen: `${name}正在外地出差`,
    relation: '朋友',
    stage: '熟悉',
    appearance: `${name}外貌168cm`,
    kinks: `${name}特殊XP`,
    outerAura: `${name}外在气质`,
    innerAura: `${name}内在气质`,
    boundaries: `${name}亲密边界`,
    sourceTurn: 'turn-1',
    ...extra
  });
  const characters = [
    makeChar('在场角色', { presence: '在场', sourceTurn: 'turn-1' }),
    makeChar('近期角色', { presence: '不在场', sourceTurn: 'turn-14' }),
    makeChar('远期角色A'),
    makeChar('远期角色B'),
    makeChar('远期角色C'),
    makeChar('远期角色D'),
    makeChar('远期角色E')
  ];
  const memory = { archive, state: { ...emptyMemoryState(), characters } };

  const folded = formatCurrentMemoryState(memory, { mentionText: '今天天气不错' });
  // 在场 & 近期活跃：全字段保留
  assert.ok(folded.includes('在场角色外貌168cm'));
  assert.ok(folded.includes('近期角色外貌168cm'));
  // 远期不在场且未提及：折叠为锚点+关系+场外，省略外貌/性癖/边界
  assert.ok(folded.includes('人物【远期角色A】一句话核心=远期角色A的核心'));
  assert.ok(folded.includes('最近场外状态=远期角色A正在外地出差'));
  assert.ok(!folded.includes('远期角色A外貌168cm'));
  assert.ok(!folded.includes('远期角色A特殊XP'));
  assert.ok(!folded.includes('远期角色A亲密边界'));

  // 一旦本轮提到远期角色A：立刻全字段唤醒
  const woken = formatCurrentMemoryState(memory, { mentionText: '我突然想起了远期角色A' });
  assert.ok(woken.includes('远期角色A外貌168cm'));
  assert.ok(woken.includes('远期角色A特殊XP'));
  assert.ok(!woken.includes('远期角色B外貌168cm'));
});

test('sexExp（性经历）：补全后锁定保持、在场展示、快照保留且留空不重复附带整张角色卡', () => {
  const s1 = applyMemoryStatePatch(emptyMemoryState(), {
    characters: [{ name: '林静', core: '律所合伙人', presence: '在场', appearance: '168cm', outerAura: '冷淡', innerAura: '护短', sexExp: '总共1人合计:2次' }]
  }, 'turn-1');
  assert.equal(s1.characters[0].sexExp, '总共1人合计:2次');

  // 后续轮次未传或传空字符串时保持锁定不漂移
  const s2 = applyMemoryStatePatch(s1, {
    characters: [{ name: '林静', mood: '平静', sexExp: '' }]
  }, 'turn-2');
  assert.equal(s2.characters[0].sexExp, '总共1人合计:2次');

  // 状态格式化包含性经历
  const formatted = formatMemoryState(s2);
  assert.ok(formatted.includes('性经历=总共1人合计:2次'));

  // 快照保留当轮 sexExp，分支/重发能准确还原历史次数
  const snap = makeMemoryStateSnapshot(s2);
  assert.equal(snap.characters[0].sexExp, '总共1人合计:2次');
  const s3 = applyMemoryStatePatch(s2, {
    characters: [{ name: '林静', sexExp: '总共1人合计:3次' }]
  }, 'turn-3');
  assert.equal(s3.characters[0].sexExp, '总共1人合计:3次');
  assert.equal(snap.characters[0].sexExp, '总共1人合计:2次');

  // 未成年或非亲密角色 sexExp 留空时不重复附带整份角色卡
  const noSexExpState = {
    ...emptyMemoryState(),
    characters: [{ name: '小满', core: '高三学生', appearance: '162cm', outerAura: '开朗', innerAura: '敏感', sexExp: '' }]
  };
  const card = { name: '小满', characterModules: ['【一句话核心】高三学生'] };
  const round = { user: { content: '小满吃早饭' }, assistant: { content: '小满喝牛奶' } };
  assert.equal(characterCardForMemoryRound(card, noSexExpState, round), '');
});

test('远期约定静默休眠与自动唤醒：未到时间不注入主对话，临期(<=3天)或用户提及时唤醒', () => {
  const memory = {
    archive: [{ turnId: 'turn-1', round: 1, index: { sceneTime: '2026年5月10日_星期日 14:00' } }],
    state: {
      ...emptyMemoryState(),
      scene: '2026年5月10日 家中客厅',
      characters: [{ name: '林静', core: '律所合伙人', presence: '在场' }],
      promises: [
        { id: 'p-near', text: '晚上一起吃火锅', status: 'open', due: '2026年5月11日', sourceTurn: 'turn-1' },
        { id: 'p-far', text: '去三亚度假旅游', status: 'open', due: '2026年6月15日', sourceTurn: 'turn-1' },
        { id: 'p-rel', text: '参加行业峰会', status: 'open', due: '下个月', sourceTurn: 'turn-1' }
      ]
    }
  };

  // 5月10日日常对话（即使提到林静名字，也不唤醒6月及下个月的约定）
  const mayText = formatCurrentMemoryState(memory, {
    mentionText: '林静今天在家做饭',
    promiseMentionText: '今晚吃什么？',
    currentSceneTime: '2026年5月10日_星期日 18:00'
  });
  assert.ok(mayText.includes('备忘约定（未到时间勿提）：'));
  assert.ok(mayText.includes('未临近或未到约定时间前，严禁角色在日常对话中反复提起'));
  assert.ok(mayText.includes('晚上一起吃火锅'));
  assert.ok(!mayText.includes('去三亚度假旅游'));
  assert.ok(!mayText.includes('参加行业峰会'));

  // 用户主动提及「三亚」，立刻唤醒该约定
  const userMentionText = formatCurrentMemoryState(memory, {
    promiseMentionText: '对了，三亚那边的酒店定好了吗？',
    currentSceneTime: '2026年5月10日_星期日 18:00'
  });
  assert.ok(userMentionText.includes('去三亚度假旅游'));
  assert.ok(!userMentionText.includes('参加行业峰会'));

  // 剧情推进到 5月30日（距离下个月6月1日 <= 3天），自动唤醒相对远期约定
  const mayEndText = formatCurrentMemoryState(memory, {
    promiseMentionText: '早安',
    currentSceneTime: '2026年5月30日_星期六 09:00'
  });
  assert.ok(mayEndText.includes('参加行业峰会'));
  assert.ok(!mayEndText.includes('去三亚度假旅游'));

  // 剧情推进到 6月13日（距离 6月15日 <= 3天），自动唤醒绝对远期约定
  const juneText = formatCurrentMemoryState(memory, {
    promiseMentionText: '出发前收拾一下',
    currentSceneTime: '2026年6月13日_星期六 10:00'
  });
  assert.ok(juneText.includes('去三亚度假旅游'));

  // 召回消歧精简状态仍保留全部未完成约定，供历史查询使用
  const recallText = formatMemoryStateForRecall(memory.state);
  assert.ok(recallText.includes('去三亚度假旅游'));
  assert.ok(recallText.includes('参加行业峰会'));
});

test('记忆注入卫生 5 项修复：过期动态字段清空、已完结事件过滤、过期约定隐藏、离线秘密静默与召回时间基准', () => {
  // 1) goal/plans/agreement 支持填「无」或「已结束」清空，而 sexExp="无" 必须保留
  const s1 = applyMemoryStatePatch(emptyMemoryState(), {
    characters: [{ name: '林静', goal: '准备汇报', plans: '周末出差', agreement: '下周签合同', sexExp: '无' }]
  }, 'turn-1');
  const s2 = applyMemoryStatePatch(s1, {
    characters: [{ name: '林静', goal: '无', plans: '已结束', agreement: '暂无', sexExp: '无' }]
  }, 'turn-2');
  assert.equal(s2.characters[0].goal, undefined);
  assert.equal(s2.characters[0].plans, undefined);
  assert.equal(s2.characters[0].agreement, undefined);
  assert.equal(s2.characters[0].sexExp, '无');
  const legacyFormatted = formatMemoryState({
    ...emptyMemoryState(),
    characters: [{ name: '苏晴', goal: '无', plans: '暂无', sexExp: '无' }]
  });
  assert.ok(!legacyFormatted.includes('目标=无'));
  assert.ok(!legacyFormatted.includes('个人计划=暂无'));
  assert.ok(legacyFormatted.includes('性经历=无'));

  // 2) 已完结事件过滤 + 3) 过期 >7 天约定隐藏 + 4) 离线/未提及秘密静默
  const mem = {
    archive: [{ turnId: 'turn-1', round: 1, index: { sceneTime: '2026年5月10日_星期日 14:00' } }],
    state: {
      ...emptyMemoryState(),
      scene: '2026年5月25日 公司茶水间',
      characters: [
        { name: '林静', presence: '在场' },
        { name: '苏晴', presence: '不在场' },
        { name: '周明', presence: '不在场' }
      ],
      promises: [
        { id: 'p-old', text: '晚上8点视频', status: 'open', due: '2026年5月10日', sourceTurn: 'turn-1' }
      ],
      events: [
        { id: 'e-done', text: '季度审计', stage: '已完结' },
        { id: 'e-live', text: '新项目竞标', stage: '发酵' }
      ],
      intel: [
        { id: 'i-off', text: '苏晴暗中跳槽去竞争对手公司', knownBy: ['苏晴', '周明'] },
        { id: 'i-on', text: '林静偷偷帮主控挡下处分', knownBy: ['林静'] }
      ]
    }
  };
  const injected = formatCurrentMemoryState(mem, {
    mentionText: '林静在茶水间泡咖啡',
    promiseMentionText: '今天项目进度如何？',
    currentSceneTime: '2026年5月25日_星期一 10:00'
  });
  assert.ok(!injected.includes('季度审计'));
  assert.ok(injected.includes('新项目竞标→发酵'));
  assert.ok(!injected.includes('晚上8点视频'));
  assert.ok(!injected.includes('苏晴暗中跳槽'));
  assert.ok(injected.includes('林静偷偷帮主控挡下处分'));
  assert.ok(injected.includes('欲言又止、眼神闪烁'));

  // 一旦用户主动提及苏晴或视频，立刻唤醒对应秘密/过期约定
  const woken = formatCurrentMemoryState(mem, {
    mentionText: '听说苏晴最近很忙',
    promiseMentionText: '上次5月10日说好晚上8点视频后来怎么没打？',
    currentSceneTime: '2026年5月25日_星期一 10:00'
  });
  assert.ok(woken.includes('苏晴暗中跳槽'));
  assert.ok(woken.includes('晚上8点视频'));

  // 5) 召回基准剧情时间优先从 recentAssistant 状态栏提取，其次 latestArchiveSceneTime，再其次 state.scene
  assert.equal(resolveRecallReferenceTime({
    recentAssistant: '>### — 🏙️场景信息🌆 —\n```\n📅日期:2026年6月2日_星期二  🕑时间:20:30\n```',
    latestArchiveSceneTime: '2026年6月1日_星期一 18:00',
    currentState: { scene: '家中客厅' }
  }), '2026年6月2日_星期二 20:30');
  assert.equal(resolveRecallReferenceTime({
    recentAssistant: '无状态栏',
    latestArchiveSceneTime: '2026年6月1日_星期一 18:00',
    currentState: { scene: '家中客厅' }
  }), '2026年6月1日_星期一 18:00');
});
