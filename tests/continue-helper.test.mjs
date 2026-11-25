import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareContinueBase,
  buildContinueMessages,
  stripLeadingThinkingBlock,
  mergeContinuationText
} from '../src/services/continue-helper.js';

test('prepareContinueBase: 已完整结束的回复自动剥离末尾行动选项', () => {
  const withMenu = '正文第一段。\n\n>### 行动选项\n  1. 选项A\n  2. 选项B';
  assert.deepEqual(prepareContinueBase(withMenu), {
    baseContent: '正文第一段。',
    strippedOptions: true
  });
  assert.deepEqual(prepareContinueBase('被截断到一半的句子'), {
    baseContent: '被截断到一半的句子',
    strippedOptions: false
  });
});

test('buildContinueMessages: 去掉思维链预填充并附带续写提示', () => {
  const msgs = buildContinueMessages(
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '<思考>', prefix: true }
    ],
    '她刚推开门，',
    false
  );
  assert.equal(msgs.length, 4);
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].content, '她刚推开门，');
  assert.equal(msgs[3].role, 'user');
  assert.ok(msgs[3].content.includes('无缝续写'));
});

test('stripLeadingThinkingBlock: 剥离已闭合思考块，未闭合时暂隐', () => {
  assert.equal(stripLeadingThinkingBlock('<思考>推理</思考>\n\n继续正文'), '继续正文');
  assert.equal(stripLeadingThinkingBlock('  <思考>还没写完'), '');
  assert.equal(stripLeadingThinkingBlock('正常正文'), '正常正文');
});

test('mergeContinuationText: 无缝拼接、重叠去重与段落换行控制', () => {
  assert.equal(
    mergeContinuationText('她刚推开门，就看见桌上放着', '看见桌上放着一只旧杯子。'),
    '她刚推开门，就看见桌上放着一只旧杯子。'
  );
  assert.equal(
    mergeContinuationText('正文第一段。', '正文第二段。', { strippedOptions: true }),
    '正文第一段。\n\n正文第二段。'
  );
  assert.equal(
    mergeContinuationText('正文补全了。', '>### 行动选项\n1. 继续'),
    '正文补全了。\n\n>### 行动选项\n1. 继续'
  );
});
