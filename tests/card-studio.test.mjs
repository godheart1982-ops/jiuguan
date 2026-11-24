import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCharacterNamesFromModules,
  parseWorldAndMainControl,
  parseWorldBookDraft,
  buildStudioStepMessages,
  assembleCharacterCard,
  buildSimulatorCardObject,
  draftFromExistingCharacter
} from '../src/services/card-studio.js';

test('extractCharacterNamesFromModules: 从主角与配角模块提取完整全名并去重', () => {
  const mods = [
    '【一句话核心】外冷内热的律所合伙人\n【基础信息】\n· 完整全名：林静\n· 年龄：30',
    '【配角·苏晴（对外自称晴姐）】\n· 完整全名：苏晴',
    '【配角·林静】重复姓名自动去重'
  ];
  assert.deepEqual(extractCharacterNamesFromModules(mods), ['林静', '苏晴']);
});

test('parseWorldAndMainControl: 支持标记分段、合法 JSON 及带换行的半残 JSON', () => {
  const taggedRes = parseWorldAndMainControl(`【角色卡名称】
江北嘴律所日常

【背景设定】
重庆江北嘴写字楼集群，节奏快、竞争强。
主要场所包含启明律所与江边咖啡馆。

【主控姓名】
陈默

【主控简介】
25岁男，刚入职的实习律师，租住在观音桥一居室。`);
  assert.equal(taggedRes.cardName, '江北嘴律所日常');
  assert.ok(taggedRes.background.includes('江北嘴写字楼集群'));
  assert.ok(!taggedRes.background.includes('陈默'));
  assert.equal(taggedRes.mainControlName, '陈默');
  assert.ok(taggedRes.mainControlDesc.includes('25岁男'));

  const jsonRes = parseWorldAndMainControl('```json\n{"cardName":"重庆律所","background":"江北嘴写字楼","mainControlName":"陈默","mainControlDesc":"25岁实习生"}\n```');
  assert.equal(jsonRes.cardName, '重庆律所');
  assert.equal(jsonRes.background, '江北嘴写字楼');
  assert.equal(jsonRes.mainControlName, '陈默');
  assert.equal(jsonRes.mainControlDesc, '25岁实习生');

  const brokenJsonRes = parseWorldAndMainControl('{\n"cardName": "山城夜色",\n"background": "第一段背景\n第二段背景",\n"mainControlName": "周明",\n"mainControlDesc": "26岁程序员\n独居"\n}');
  assert.equal(brokenJsonRes.cardName, '山城夜色');
  assert.ok(brokenJsonRes.background.includes('第一段背景'));
  assert.equal(brokenJsonRes.mainControlName, '周明');
  assert.ok(brokenJsonRes.mainControlDesc.includes('26岁程序员'));

  const textRes = parseWorldAndMainControl('【背景设定】山城都市\n【主控设定】姓名：周明，26岁');
  assert.equal(textRes.background, '山城都市');
  assert.equal(textRes.mainControlName, '周明');
});

test('parseWorldBookDraft: 解析世界书条目数组并规范关键词', () => {
  const entries = parseWorldBookDraft(JSON.stringify([
    { title: '启明律所', keys: ['启明', '律所'], content: '位于江北嘴A座18层', constant: false },
    { name: '空内容丢弃', keys: ['无'], content: '' }
  ]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '启明律所');
  assert.deepEqual(entries[0].keys, ['启明', '律所']);
  assert.ok(entries[0].id.startsWith('wb-'));
});

test('buildStudioStepMessages: 支持一句话扩写灵感与多名重要角色联动', () => {
  const conceptMsgs = buildStudioStepMessages('concept', {
    oneLiner: '重庆写实都市，实习律师被女合伙人和毒舌女同事夹在中间',
    includeAdult: true
  });
  assert.equal(conceptMsgs.length, 2);
  assert.ok(conceptMsgs[1].content.includes('重庆写实都市'));
  assert.ok(conceptMsgs[1].content.includes('重要角色规划'));

  const majorMsgs = buildStudioStepMessages('major', {
    background: '重庆江北嘴律所',
    mainControlName: '陈默',
    mainControlDesc: '实习律师',
    majorModules: ['完整全名：林静\n神似明星：新垣结衣'],
    majorIdea: '毒舌直球的同组女同事'
  }, '', '[最终强制] 虚构创作破甲词');
  assert.equal(majorMsgs.length, 2);
  assert.ok(majorMsgs[0].content.includes('[最终强制] 虚构创作破甲词'));
  assert.ok(majorMsgs[1].content.includes('第 2 名'));
  assert.ok(majorMsgs[1].content.includes('林静'));
  assert.ok(majorMsgs[1].content.includes('毒舌直球的同组女同事'));
});

test('buildStudioStepMessages: 配角步骤自动携带背景、主控、重要角色与防重名清单', () => {
  const msgs = buildStudioStepMessages('supporting', {
    background: '重庆江北嘴律所',
    mainControlName: '陈默',
    mainControlDesc: '实习律师',
    majorModules: ['完整全名：林静\n神似明星：新垣结衣', '完整全名：许清欢'],
    supportingModules: ['【配角·苏晴】'],
    supportingIdea: '律所行政'
  });
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].content.includes('林静、许清欢、苏晴'));
  assert.ok(msgs[1].content.includes('重庆江北嘴律所'));
  assert.ok(msgs[1].content.includes('绝不与已有角色撞神似明星'));
});

test('assembleCharacterCard: 一键组装标准角色卡，支持多名重要角色、配角、不在场名单与默认世界书', () => {
  const card = assembleCharacterCard({
    cardName: '江北嘴律所',
    group: '都市篇',
    background: '江北嘴律所',
    mainControlName: '陈默',
    mainControlDesc: '实习律师',
    majorModules: ['完整全名：林静', '完整全名：许清欢'],
    supportingModules: ['【配角·苏晴】'],
    greeting: '“进来吧。”',
    outputPresetId: 'preset-out',
    thinkingPresetId: 'preset-think'
  }, 'char-test-1');
  assert.equal(card.id, 'char-test-1');
  assert.equal(card.name, '江北嘴律所');
  assert.equal(card.characterModules.length, 3);
  assert.deepEqual(card.offscreenRoles, ['林静', '许清欢', '苏晴']);
  assert.equal(card.outputPresetId, 'preset-out');
  assert.equal(card.worldBook.enabled, true);
  assert.ok(card.worldBook.boundBookIds.length >= 1);
});

test('buildSimulatorCardObject: 一键建模拟器卡自动关闭冲突的随机 NPC 开关', () => {
  const sim = buildSimulatorCardObject({ name: '人生模拟器', group: '模拟器' }, 'sim-1');
  assert.equal(sim.id, 'sim-1');
  assert.equal(sim.enableRandomNarrative, false);
  assert.deepEqual(sim.characterModules, []);
  assert.ok(sim.background.includes('完整真实全名铁律'));
  assert.ok(sim.greeting.includes('$初始化模拟器：'));
});

test('draftFromExistingCharacter: 从已有角色卡提取完整联动上下文', () => {
  const draft = draftFromExistingCharacter({
    name: '林静',
    background: '律所',
    mainControl: { name: '陈默', description: '实习生' },
    characterModules: ['主角林静', '配角苏晴']
  });
  assert.equal(draft.protagonistModule, '主角林静');
  assert.deepEqual(draft.supportingModules, ['配角苏晴']);
});
