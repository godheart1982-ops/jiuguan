// 免费生图记忆单测：seedArchive 迁移包装 + pollinations URL 锚点拼接
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateChat } from '../src/services/migrations.js';
import { spliceAnchorIntoPollinationsUrl, buildGrokWebChatBody, isPaidImageProvider, imageProviderDisplayName } from '../src/services/image-gen.js';

// ---------- migrateChat: seedArchive 升级 ----------

test('migrateChat: 旧数值种子档案包装为 {seed, anchor}，对象形态补齐字段', () => {
  const chat = {
    messages: [],
    seedArchive: { 林悦: 233, 苏晴: { seed: 240 }, 陈露: { anchor: 'A woman' } }
  };
  migrateChat(chat);
  assert.deepEqual(chat.seedArchive['林悦'], { seed: 233, anchor: '' });
  assert.deepEqual(chat.seedArchive['苏晴'], { seed: 240, anchor: '' });
  assert.deepEqual(chat.seedArchive['陈露'], { seed: 0, anchor: 'A woman' });
});

test('migrateChat: seedArchive 升级幂等', () => {
  const chat = { messages: [], seedArchive: { 林悦: 233 } };
  migrateChat(chat);
  const first = JSON.stringify(chat.seedArchive);
  migrateChat(chat);
  assert.equal(JSON.stringify(chat.seedArchive), first);
});

// ---------- spliceAnchorIntoPollinationsUrl ----------

const ANCHOR = 'A 26-year-old woman, long black hair, amber eyes';

test('spliceAnchorIntoPollinationsUrl: 锚点拼到 prompt 最前，query 原样保留', () => {
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent('sitting in a cafe, solo female') + '?nologo=true&seed=233';
  const out = spliceAnchorIntoPollinationsUrl(url, ANCHOR);
  const m = out.match(/^https:\/\/image\.pollinations\.ai\/prompt\/([^?]+)(\?.*)$/);
  assert.ok(m);
  const prompt = decodeURIComponent(m[1]);
  assert.equal(prompt, ANCHOR + ', sitting in a cafe, solo female');
  assert.equal(m[2], '?nologo=true&seed=233');
});

test('spliceAnchorIntoPollinationsUrl: 幂等——已含锚点不重复拼；空锚点原样返回；非目标 URL 不动', () => {
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(ANCHOR + ', sitting') + '?seed=233';
  assert.equal(spliceAnchorIntoPollinationsUrl(url, ANCHOR), url);
  assert.equal(spliceAnchorIntoPollinationsUrl(url, ''), url);
  assert.equal(spliceAnchorIntoPollinationsUrl(url, '   '), url);
  assert.equal(spliceAnchorIntoPollinationsUrl('https://example.com/x?a=1', ANCHOR), 'https://example.com/x?a=1');
});

// ---------- grokweb（网页反代）请求体构造 ----------

test('buildGrokWebChatBody: 默认模型+生图指令包装+非流式', () => {
  const body = buildGrokWebChatBody('', '竖向构图，黑色长发少女');
  assert.equal(body.model, 'grok-4.6-fast');
  assert.equal(body.stream, false);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.ok(body.messages[0].content.includes('竖向构图，黑色长发少女'));
  assert.ok(body.messages[0].content.includes('生成'));
});

test('buildGrokWebChatBody: 指定模型生效且去空白', () => {
  const body = buildGrokWebChatBody('  grok-4.6-expert  ', '一只猫');
  assert.equal(body.model, 'grok-4.6-expert');
});

test('grokweb 服务商注册：isPaidImageProvider 与显示名', () => {
  assert.equal(isPaidImageProvider('grokweb'), true);
  assert.equal(imageProviderDisplayName('grokweb'), 'Grok 网页反代');
});
