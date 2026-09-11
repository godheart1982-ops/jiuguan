// storage.js 纯函数单测：脱敏合并 / 密钥清理 / 会话记忆结构归一化
// 这些函数错了不会报错，只会在导入导出备份或打开旧会话时悄悄弄坏数据
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePreservingSecrets,
  redactSecretsInObject,
  normalizeChatMemory,
  toApiProfile
} from '../src/services/storage.js';

// ---------- mergePreservingSecrets ----------

test('mergePreservingSecrets: incoming 密钥为空时保留 existing 的本机密钥', () => {
  const incoming = { api: { apiKey: '', model: 'gpt-4' } };
  const existing = { api: { apiKey: 'SK-LOCAL', model: 'gpt-3.5' } };
  const merged = mergePreservingSecrets(incoming, existing);
  assert.equal(merged.api.apiKey, 'SK-LOCAL');
  assert.equal(merged.api.model, 'gpt-4'); // 非密钥字段以 incoming 为准
});

test('mergePreservingSecrets: incoming 提供了新密钥则以新值为准', () => {
  const incoming = { api: { apiKey: 'SK-NEW' } };
  const existing = { api: { apiKey: 'SK-OLD' } };
  assert.equal(mergePreservingSecrets(incoming, existing).api.apiKey, 'SK-NEW');
});

test('mergePreservingSecrets: 嵌套对象递归处理（webdav.password）', () => {
  const incoming = { webdav: { password: '', username: 'me@x.com' } };
  const existing = { webdav: { password: 'APP-PW', username: 'old@x.com' } };
  const merged = mergePreservingSecrets(incoming, existing);
  assert.equal(merged.webdav.password, 'APP-PW');
  assert.equal(merged.webdav.username, 'me@x.com');
});

test('mergePreservingSecrets: 数组直接用 incoming，不做合并', () => {
  const incoming = { tags: ['a'] };
  const existing = { tags: ['x', 'y'] };
  assert.deepEqual(mergePreservingSecrets(incoming, existing).tags, ['a']);
});

test('mergePreservingSecrets: existing 没有对应分支时不报错', () => {
  const incoming = { api: { apiKey: '' } };
  const merged = mergePreservingSecrets(incoming, {});
  assert.equal(merged.api.apiKey, '');
});

// ---------- redactSecretsInObject ----------

test('redactSecretsInObject: 递归清空密钥字段并计数', () => {
  const obj = {
    api: { apiKey: 'K1', model: 'm' },
    webdav: { password: 'P1' },
    list: [{ apiKey: 'K2' }]
  };
  const cleared = redactSecretsInObject(obj);
  assert.equal(cleared, 3);
  assert.equal(obj.api.apiKey, '');
  assert.equal(obj.webdav.password, '');
  assert.equal(obj.list[0].apiKey, '');
  assert.equal(obj.api.model, 'm'); // 非密钥字段不动
});

test('redactSecretsInObject: 已是空串的密钥不计数', () => {
  const obj = { apiKey: '' };
  assert.equal(redactSecretsInObject(obj), 0);
  assert.equal(obj.apiKey, '');
});

// ---------- normalizeChatMemory ----------

test('normalizeChatMemory: 缺失 memory / roundCounter 时按现有消息补齐', () => {
  const chat = {
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }
    ]
  };
  normalizeChatMemory(chat);
  assert.deepEqual(chat.memory, { shortTerm: [], longTerm: [], facts: { promises: [], relations: [], worldEvents: [], intel: [] } });
  assert.equal(chat.roundCounter, 2);
});

test('normalizeChatMemory: 已有 roundCounter 不被覆盖', () => {
  const chat = { roundCounter: 99, messages: [{ role: 'user', content: 'a' }] };
  normalizeChatMemory(chat);
  assert.equal(chat.roundCounter, 99);
});

test('normalizeChatMemory: 清理旧版残留字段（generatingPing / shortTermBatchCounter）', () => {
  const chat = {
    messages: [],
    generatingPing: 12345,
    memory: { shortTerm: [], longTerm: [], shortTermBatchCounter: 3 }
  };
  normalizeChatMemory(chat);
  assert.equal('generatingPing' in chat, false);
  assert.equal('shortTermBatchCounter' in chat.memory, false);
});

test('normalizeChatMemory: 非对象输入安全返回', () => {
  assert.doesNotThrow(() => {
    normalizeChatMemory(null);
    normalizeChatMemory(undefined);
    normalizeChatMemory('x');
  });
});

// ---------- toApiProfile ----------

test('toApiProfile: 白名单字段完整（含 customHeaders），脏字段被剔除', () => {
  const p = toApiProfile({
    baseUrl: 'https://x/v1',
    apiKey: 'sk-1',
    model: 'm1',
    temperature: 0.8,
    temperatureEnabled: true,
    maxTokens: 100,
    format: 'openai',
    reasoningEffort: 'off',
    showThinking: false,
    deepseekThinking: false,
    deepseekReasoningEffort: 'high',
    prefillThinking: false,
    enableThinking: false,
    customHeaders: 'x-opencode-session: {{chatId}}',
    junkField: '不应出现'
  });
  assert.equal(p.customHeaders, 'x-opencode-session: {{chatId}}');
  assert.equal('junkField' in p, false);
  assert.equal(p.baseUrl, 'https://x/v1');
});

test('toApiProfile: customHeaders 缺省时回落空串', () => {
  assert.equal(toApiProfile({}).customHeaders, '');
});
