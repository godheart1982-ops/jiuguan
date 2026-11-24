// migrations.js 单测：config 与 chat 的集中迁移表
// 迁移步骤错了不会报错，只会让老数据在新版本里读出 undefined
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateConfig, migrateChat } from '../src/services/migrations.js';

// ---------- migrateConfig ----------

test('migrateConfig: null 返回完整默认配置', () => {
  const cfg = migrateConfig(null);
  assert.equal(cfg.api.baseUrl, 'https://api.openai.com/v1');
  assert.equal(cfg.ui.fontSize, 14);
  assert.equal(cfg.ui.theme, 'tavern');
  assert.equal(cfg.search.enabled, false);
  assert.equal(cfg.webdav.baseUrl, 'https://dav.jianguoyun.com/dav');
  assert.equal(cfg.webdav.deviceName, '');
  assert.equal(cfg.debug.previewBeforeSend, false);
  assert.equal(cfg.behavior.autoCompleteLastModule, false);
  assert.equal(cfg.behavior.memoryCorrection, true); // 记忆修正通道默认开
  assert.deepEqual(cfg.apiProfiles, {});
  assert.deepEqual(cfg.api.memoryApi, {});
});

test('migrateConfig: 已有字段保留，缺失段落补齐', () => {
  const cfg = migrateConfig({
    api: { baseUrl: 'https://my.api/v1', apiKey: 'K', model: 'm' },
    ui: { fontSize: 18 }
  });
  assert.equal(cfg.api.baseUrl, 'https://my.api/v1'); // 不动已有值
  assert.equal(cfg.ui.fontSize, 18);
  assert.ok(cfg.search && cfg.webdav && cfg.debug && cfg.behavior); // 缺失的补上
});

test('migrateConfig: 废弃字段清理', () => {
  const cfg = migrateConfig({
    webdav: { fileName: 'backup-latest' },
    behavior: { shortTermMemoryMode: 'x' }
  });
  assert.equal('fileName' in cfg.webdav, false);
  assert.equal('shortTermMemoryMode' in cfg.behavior, false);
});

test('migrateConfig: 旧 memoryModel 迁移为 memoryApi', () => {
  const cfg = migrateConfig({
    api: {
      baseUrl: 'https://my.api/v1',
      apiKey: 'K',
      model: 'main',
      memoryModel: 'cheap-model',
      temperature: 0.5,
      maxTokens: 1000
    }
  });
  assert.deepEqual(cfg.api.memoryApi, {
    baseUrl: 'https://my.api/v1',
    apiKey: 'K',
    model: 'cheap-model',
    temperature: 0.5,
    maxTokens: 1000
  });
});

test('migrateConfig: 已有 memoryApi 不被 memoryModel 覆盖', () => {
  const cfg = migrateConfig({
    api: {
      baseUrl: 'https://my.api/v1',
      memoryModel: 'old',
      memoryApi: { baseUrl: 'https://other/v1', apiKey: 'K2', model: 'new' }
    }
  });
  assert.equal(cfg.api.memoryApi.model, 'new');
});

test('migrateConfig: 老配置缺省或非法 theme 回退为 tavern，合法 theme 保留', () => {
  assert.equal(migrateConfig({ ui: { fontSize: 16 } }).ui.theme, 'tavern');
  assert.equal(migrateConfig({ ui: { fontSize: 16, theme: 'unknown' } }).ui.theme, 'tavern');
  assert.equal(migrateConfig({ ui: { fontSize: 16, theme: 'charcoal' } }).ui.theme, 'charcoal');
  assert.equal(migrateConfig({ ui: { fontSize: 16, theme: 'parchment' } }).ui.theme, 'parchment');
});

// ---------- migrateChat ----------

test('migrateChat: 空会话补齐 memory / facts / roundCounter', () => {
  const chat = { messages: [{ role: 'user', content: 'a' }] };
  migrateChat(chat);
  assert.deepEqual(chat.memory.shortTerm, []);
  assert.deepEqual(chat.memory.longTerm, []);
  assert.deepEqual(chat.memory.facts, { promises: [], relations: [], worldEvents: [], intel: [] });
  assert.equal(chat.roundCounter, 1);
});

test('migrateChat: 旧短期记忆里的 ｜世界： 标记回填进 facts（仅 facts 全空时）', () => {
  const chat = {
    messages: [],
    memory: {
      shortTerm: [{ date: '2026-01-01', content: '发生了一些事｜世界：地铁停运→开始' }],
      longTerm: []
    }
  };
  migrateChat(chat);
  assert.deepEqual(chat.memory.facts.worldEvents, [{ text: '地铁停运→开始' }]);
});

test('migrateChat: facts 非空时不做回填（用户手改结果不被冲掉）', () => {
  const chat = {
    messages: [],
    memory: {
      shortTerm: [{ date: '2026-01-01', content: '发生了一些事｜世界：地铁停运→开始' }],
      longTerm: [],
      facts: { promises: [{ text: '周五看展', status: 'open' }], relations: [], worldEvents: [], intel: [] }
    }
  };
  migrateChat(chat);
  assert.deepEqual(chat.memory.facts.worldEvents, []);
  assert.equal(chat.memory.facts.promises[0].text, '周五看展');
});

test('migrateChat: 废弃字段一次性清干净', () => {
  const chat = {
    messages: [],
    generatingPing: 123,
    memory: {
      shortTerm: [],
      longTerm: [],
      shortTermBatchCounter: 2,
      recent: [], medium: [],
      relationship: 'x', npcStatus: 'x', events: [],
      playerFacts: [], characterFacts: [], custom: {}, stateDerived: {}
    }
  };
  migrateChat(chat);
  assert.equal('generatingPing' in chat, false);
  assert.equal('shortTermBatchCounter' in chat.memory, false);
  assert.equal('recent' in chat.memory, false);
  assert.equal('relationship' in chat.memory.longTerm, false);
});

test('migrateChat: 幂等——连跑两遍结果一致', () => {
  const chat = {
    messages: [{ role: 'user', content: 'a' }],
    memory: { shortTerm: [{ date: 'd', content: 'x｜世界：事件→开始' }], longTerm: [] }
  };
  migrateChat(chat);
  const first = JSON.parse(JSON.stringify(chat));
  migrateChat(chat);
  assert.deepEqual(chat, first);
});

test('migrateChat: 非对象输入安全返回', () => {
  assert.doesNotThrow(() => {
    migrateChat(null);
    migrateChat(undefined);
  });
});

test('migrateChat: appearanceAnchors 字符串升级为 {text, img}，对象形态补齐字段', () => {
  const chat = {
    messages: [],
    appearanceAnchors: {
      苏晴: '一位26岁女性，黑长直',
      林悦: { text: '一位24岁女性' },
      王姐: { img: 'images/c1/ch1/ref-王姐.jpg' }
    }
  };
  migrateChat(chat);
  assert.deepEqual(chat.appearanceAnchors['苏晴'], { text: '一位26岁女性，黑长直', img: '' });
  assert.deepEqual(chat.appearanceAnchors['林悦'], { text: '一位24岁女性', img: '' });
  assert.deepEqual(chat.appearanceAnchors['王姐'], { text: '', img: 'images/c1/ch1/ref-王姐.jpg' });
});
