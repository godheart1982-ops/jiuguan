import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomHeaders, setRequestSessionId } from '../src/services/api-headers.js';

// ---------- buildCustomHeaders ----------

test('buildCustomHeaders: 空输入返回空对象', () => {
  assert.deepEqual(buildCustomHeaders(''), {});
  assert.deepEqual(buildCustomHeaders(null), {});
  assert.deepEqual(buildCustomHeaders('   \n  '), {});
});

test('buildCustomHeaders: 解析多行（含 CRLF），跳过非法行', () => {
  const out = buildCustomHeaders('X-Custom: abc\r\nUser-Agent: jiuguan/1.0\n坏行没有冒号\n: 空键\n空值:\n中文头: xx');
  assert.deepEqual(out, { 'X-Custom': 'abc', 'User-Agent': 'jiuguan/1.0' });
});

test('buildCustomHeaders: {{chatId}} 占位替换（显式参数优先，大小写不敏感）', () => {
  const out = buildCustomHeaders('x-opencode-session: {{chatId}}', 'chat-42');
  assert.equal(out['x-opencode-session'], 'chat-42');
  const spaced = buildCustomHeaders('x-opencode-session: {{ ChatId }}', 'chat-42');
  assert.equal(spaced['x-opencode-session'], 'chat-42');
});

test('buildCustomHeaders: 无显式参数时用当前会话 ID；都没有时回落 default', () => {
  setRequestSessionId('chat-77');
  assert.equal(buildCustomHeaders('x-opencode-session: {{chatId}}')['x-opencode-session'], 'chat-77');
  // 显式参数优先于当前会话
  assert.equal(buildCustomHeaders('x-opencode-session: {{chatId}}', 'chat-88')['x-opencode-session'], 'chat-88');
  setRequestSessionId('');
  assert.equal(buildCustomHeaders('x-opencode-session: {{chatId}}')['x-opencode-session'], 'default');
});

test('buildCustomHeaders: 会话 ID 清洗——非常规字符剔除', () => {
  const out = buildCustomHeaders('x-opencode-session: {{chatId}}', 'ch at#1<>2');
  assert.equal(out['x-opencode-session'], 'chat12');
});

test('buildCustomHeaders: 值里含冒号时按第一个冒号切分', () => {
  const out = buildCustomHeaders('X-Time: 12:30:00');
  assert.equal(out['X-Time'], '12:30:00');
});
