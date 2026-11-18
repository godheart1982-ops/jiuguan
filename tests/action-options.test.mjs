import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripActionOptions,
  trimHistoricalActionOptions,
  parseSelectedOptionNumbers,
  extractActionOptionSupplement,
  buildActionOptionContext
} from '../src/services/action-options.js';

function reply(label) {
  return `${label}\n\n>### 行动选项\n  1. 主控追问她昨晚去向（约1分钟）\n  2. 她接过主控的礼物（约1分钟）\n  3. 主控解释刚才的误会（约2分钟）\n  4. 她给主控看聊天记录（约3分钟）\n  5. ⏳ [时间推进至次日清晨]（约1天）\n  6. 🔞 [情欲推进：当前条件不足]\n  7. 📖 [剧情推进：她再次接到神秘来电]`;
}

test('行动选项历史：只保留最近一份完整菜单，旧轮剥离且不改原对象', () => {
  const old = { role: 'assistant', content: reply('旧正文') };
  const latest = { role: 'assistant', content: reply('新正文') };
  const user = { role: 'user', content: '2' };
  const result = trimHistoricalActionOptions([old, user, latest]);
  assert.equal(result[0].content, '旧正文');
  assert.equal(result[1], user);
  assert.equal(result[2], latest);
  assert.ok(old.content.includes('>### 行动选项'));
});

test('行动选项历史：最近回复没有菜单时，更早菜单也不保留', () => {
  const result = trimHistoricalActionOptions([
    { role: 'assistant', content: reply('旧正文') },
    { role: 'assistant', content: '最近正文没有菜单' }
  ]);
  assert.equal(result[0].content, '旧正文');
  assert.equal(result[1].content, '最近正文没有菜单');
});

test('剥离行动选项：无菜单原文保留，有菜单只留前文', () => {
  assert.equal(stripActionOptions('普通正文'), '普通正文');
  assert.equal(stripActionOptions(reply('正文')), '正文');
});

test('选择解析：单选、复合与各种文字补充简写', () => {
  assert.deepEqual(parseSelectedOptionNumbers('2'), [2]);
  assert.deepEqual(parseSelectedOptionNumbers('1+3'), [1, 3]);
  assert.deepEqual(parseSelectedOptionNumbers('1＋3'), [1, 3]);
  assert.deepEqual(parseSelectedOptionNumbers('选2再追问一句'), [2]);
  assert.deepEqual(parseSelectedOptionNumbers('2再追问一句'), [2]);
  assert.deepEqual(parseSelectedOptionNumbers('2，怎么'), [2]);
  assert.deepEqual(parseSelectedOptionNumbers('2 怎么怎么能'), [2]);
  assert.deepEqual(parseSelectedOptionNumbers('2怎么能这样'), [2]);
  assert.deepEqual(parseSelectedOptionNumbers('1+3再追问'), [1, 3]);
  assert.deepEqual(parseSelectedOptionNumbers('1+3 然后离开'), [1, 3]);
  assert.deepEqual(parseSelectedOptionNumbers('我拒绝'), []);
  assert.deepEqual(parseSelectedOptionNumbers('2026年'), []);
});

test('选项补充：单选、多选与连接符后的自由指令均完整保留', () => {
  assert.equal(extractActionOptionSupplement('6 其他指令'), '其他指令');
  assert.equal(extractActionOptionSupplement('6，其他指令'), '其他指令');
  assert.equal(extractActionOptionSupplement('选6再其他指令'), '其他指令');
  assert.equal(extractActionOptionSupplement('2怎么能这样'), '怎么能这样');
  assert.equal(extractActionOptionSupplement('1+3再追问'), '追问');
  assert.equal(extractActionOptionSupplement('1＋3 然后离开'), '然后离开');
  assert.equal(extractActionOptionSupplement('1+3'), '');
  assert.equal(extractActionOptionSupplement('我拒绝'), '');
});

test('选择上下文：只把已选项列为行动核心，其余候选未发生', () => {
  const context = buildActionOptionContext(reply('正文'), '2');
  assert.ok(context.includes('所有选项均未自动发生'));
  assert.ok(context.includes('第2条：她接过主控的礼物（约1分钟）'));
  assert.ok(!context.includes('第7条：'));
  assert.ok(context.includes('数字明显是在回答剧情内提问'));
});

test('选择上下文：复合选择保留顺序，自由输入只声明候选边界', () => {
  const combo = buildActionOptionContext(reply('正文'), '1+3再离开');
  assert.ok(combo.indexOf('第1条：') < combo.indexOf('第3条：'));
  const short = buildActionOptionContext(reply('正文'), '2 然后问她原因');
  assert.ok(short.includes('第2条：她接过主控的礼物（约1分钟）'));
  const free = buildActionOptionContext(reply('正文'), '我先离开');
  assert.ok(free.includes('候选与格式示例'));
  assert.ok(!free.includes('【本轮已选择行动】'));
  assert.equal(buildActionOptionContext('没有菜单', '2'), '');
});
