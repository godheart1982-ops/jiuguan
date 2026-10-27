// api-memory.js 纯函数单测：事实备忘归一化 / 增量合并 / 注入格式 / 世界事件标记
// 合并规则错了不会报错，只会悄悄丢约定、重复情报或让世界事件阶段回退
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyFacts,
  normalizeFacts,
  applyTurnFactsToMemory,
  formatFactsMemo,
  extractWorldEventMarkers,
  parseWorldEventsFromContent,
  trimAssistantForMemory,
  extractMemoryCorrections,
  parseTurnSummary,
  formatLongTermReference,
  formatLongTermInjection,
  extractMemoryRecalls,
  matchLongTermRecalls,
  LONG_TERM_FULL_COUNT
} from '../src/services/api-memory.js';

// ---------- normalizeFacts ----------

test('normalizeFacts: 非对象输入返回空结构', () => {
  assert.deepEqual(normalizeFacts(null), emptyFacts());
  assert.deepEqual(normalizeFacts('x'), emptyFacts());
});

test('normalizeFacts: 修剪空白、过滤空项、status 只认 done', () => {
  const f = normalizeFacts({
    promises: [
      { text: ' 陪她去医院 ', status: 'done' },
      { text: '买牛奶', status: 'weird' },
      { text: '  ', status: 'open' }
    ],
    relations: [{ name: ' 艾莉娅 ', note: ' 同事 ' }, { name: '', note: 'x' }],
    worldEvents: [{ text: '｜世界：裁员评审→发酵' }, { text: '' }],
    intel: ['主控已婚', { text: '', knownBy: ['公开'] }]
  });
  assert.deepEqual(f.promises, [
    { text: '陪她去医院', status: 'done' },
    { text: '买牛奶', status: 'open' }
  ]);
  assert.deepEqual(f.relations, [{ from: '艾莉娅', to: '主控', note: '同事' }]);
  assert.deepEqual(f.worldEvents, [{ text: '裁员评审→发酵' }]);
  assert.deepEqual(f.intel, [{ text: '主控已婚', knownBy: [] }]);
});

test('normalizeFacts: knownBy 字符串按顿号/逗号拆分并去重', () => {
  const f = normalizeFacts({
    intel: [{ text: '秘密', knownBy: '主控、艾莉娅，主控' }]
  });
  assert.deepEqual(f.intel[0].knownBy, ['主控', '艾莉娅']);
});

// ---------- applyTurnFactsToMemory ----------

test('applyTurnFacts: promises 全量重写——open 列表被 AI 清单整体替换', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { promises: [{ text: '周三改简历', status: 'open' }] });
  // 下一轮 AI 输出的完整清单：旧约定照抄 + 新约定
  applyTurnFactsToMemory(memory, {
    promises: [
      { text: '周三改简历', status: 'open' },
      { text: '周五看展', status: 'open' }
    ]
  });
  assert.deepEqual(memory.facts.promises.map(p => p.text), ['周三改简历', '周五看展']);
  assert.ok(memory.facts.promises.every(p => p.status === 'open'));
});

test('applyTurnFacts: 旧 open 未被 AI 提及 → 救回为 done，不静默丢失', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { promises: [{ text: '周三改简历', status: 'open' }] });
  // AI 的完整清单里没有它了（视为已完成/失效）
  applyTurnFactsToMemory(memory, { promises: [{ text: '周五看展', status: 'open' }] });
  assert.deepEqual(memory.facts.promises, [
    { text: '周五看展', status: 'open' },
    { text: '周三改简历', status: 'done' }
  ]);
});

test('applyTurnFacts: done 合并去重且只留最近 5 条', () => {
  const memory = { facts: emptyFacts() };
  // 历史已有 5 条 done
  applyTurnFactsToMemory(memory, {
    promises: [
      { text: 'd1', status: 'done' }, { text: 'd2', status: 'done' },
      { text: 'd3', status: 'done' }, { text: 'd4', status: 'done' }, { text: 'd5', status: 'done' }
    ]
  });
  // 本轮又完成 2 条
  applyTurnFactsToMemory(memory, {
    promises: [
      { text: '新open', status: 'open' },
      { text: 'd6', status: 'done' }, { text: 'd7', status: 'done' }
    ]
  });
  const doneTexts = memory.facts.promises.filter(p => p.status === 'done').map(p => p.text);
  assert.deepEqual(doneTexts, ['d3', 'd4', 'd5', 'd6', 'd7']);
  assert.deepEqual(memory.facts.promises.filter(p => p.status === 'open').map(p => p.text), ['新open']);
});

test('applyTurnFacts: 未提供 promises 字段时不动现有约定（回填安全）', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { promises: [{ text: '周三改简历', status: 'open' }] });
  applyTurnFactsToMemory(memory, { content: '剧情……｜世界：地铁停运→开始' });
  assert.deepEqual(memory.facts.promises, [{ text: '周三改简历', status: 'open' }]);
  assert.deepEqual(memory.facts.worldEvents, [{ text: '地铁停运→开始' }]);
});

test('applyTurnFacts: relations 全量重写——未变的照抄、变化的更新、新增的追加（边形态）', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { relations: [{ from: '艾莉娅', to: '主控', note: '同事' }] });
  applyTurnFactsToMemory(memory, {
    relations: [
      { from: '艾莉娅', to: '主控', note: '恋人' },
      { from: '王总', to: '主控', note: '上司' },
      { from: '艾莉娅', to: '王总', note: '前同事' }
    ]
  });
  assert.deepEqual(memory.facts.relations, [
    { from: '艾莉娅', to: '主控', note: '恋人' },
    { from: '王总', to: '主控', note: '上司' },
    { from: '艾莉娅', to: '王总', note: '前同事' }
  ]);
});

test('applyTurnFacts: relations 未被提及的旧边排队尾保留（防误删静水关系）', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { relations: [{ from: '旧友', to: '主控', note: '发小' }] });
  applyTurnFactsToMemory(memory, { relations: [{ from: '艾莉娅', to: '主控', note: '同事' }] });
  assert.deepEqual(memory.facts.relations, [
    { from: '旧友', to: '主控', note: '发小' },
    { from: '艾莉娅', to: '主控', note: '同事' }
  ]);
});

test('applyTurnFacts: 关系 note 的进度数值段原样存取、可按全量重写刷新', () => {
  const memory = { facts: emptyFacts() };
  // 数值段只是 note 自由文本的一部分：归一化/存储链路不得拆改
  applyTurnFactsToMemory(memory, {
    relations: [{ from: '苏晴', to: '李明', note: '同事｜好感45/100｜服从20/100｜阶段:信任' }]
  }, '李明');
  assert.deepEqual(memory.facts.relations, [
    { from: '苏晴', to: '李明', note: '同事｜好感45/100｜服从20/100｜阶段:信任' }
  ]);
  // 全量重写时同一条边（from+to 双键一致）数值段就地刷新
  applyTurnFactsToMemory(memory, {
    relations: [{ from: '苏晴', to: '李明', note: '同事｜好感48/100｜服从20/100｜阶段:信任' }]
  }, '李明');
  assert.deepEqual(memory.facts.relations, [
    { from: '苏晴', to: '李明', note: '同事｜好感48/100｜服从20/100｜阶段:信任' }
  ]);
});

test('applyTurnFacts: intel 全量重写——text 照抄、knownBy 全量更新（「她得知了」核心路径）', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { intel: [{ text: '主控已婚', knownBy: ['主控'] }] });
  applyTurnFactsToMemory(memory, { intel: [{ text: '主控已婚', knownBy: ['主控', '艾莉娅'] }] });
  assert.deepEqual(memory.facts.intel, [{ text: '主控已婚', knownBy: ['主控', '艾莉娅'] }]);
});

test('applyTurnFacts: intel 未被提及的旧情报排队尾保留（保守=不提前泄露）', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { intel: [{ text: '公司要裁员', knownBy: ['公开'] }] });
  applyTurnFactsToMemory(memory, { intel: [{ text: '主控已婚', knownBy: ['主控'] }] });
  assert.deepEqual(memory.facts.intel, [
    { text: '公司要裁员', knownBy: ['公开'] },
    { text: '主控已婚', knownBy: ['主控'] }
  ]);
});

test('applyTurnFacts: 未提供 relations/intel 字段时不动现有条目（回填安全）', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, {
    relations: [{ name: '艾莉娅', note: '同事' }],
    intel: [{ text: '主控已婚', knownBy: ['主控'] }]
  });
  applyTurnFactsToMemory(memory, { content: '剧情……｜世界：地铁停运→开始' });
  assert.equal(memory.facts.relations.length, 1);
  assert.equal(memory.facts.intel.length, 1);
  assert.deepEqual(memory.facts.worldEvents, [{ text: '地铁停运→开始' }]);
});

test('applyTurnFacts: 世界事件同事件名保留最新阶段', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { worldEvents: ['裁员评审→发酵'] });
  applyTurnFactsToMemory(memory, { worldEvents: ['裁员评审→平息'] });
  assert.equal(memory.facts.worldEvents.length, 1);
  assert.equal(memory.facts.worldEvents[0].text, '裁员评审→平息');
});

test('applyTurnFacts: content 里的旧式 ｜世界： 标记也会并入世界事件', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { content: '今天聊了很多。｜世界：地铁停运→开始' });
  assert.deepEqual(memory.facts.worldEvents, [{ text: '地铁停运→开始' }]);
});

// ---------- formatFactsMemo ----------

test('formatFactsMemo: 全空返回空串', () => {
  assert.equal(formatFactsMemo(emptyFacts()), '');
  assert.equal(formatFactsMemo(null), '');
});

test('formatFactsMemo: 已完成的约定不注入', () => {
  const memo = formatFactsMemo({
    promises: [{ text: '已完成的事', status: 'done' }],
    relations: [], worldEvents: [], intel: []
  });
  assert.equal(memo, '');
});

test('formatFactsMemo: 分区齐全且含硬性知情约束；worldEvents 回流注入', () => {
  const memo = formatFactsMemo({
    promises: [{ text: '周五去看展', status: 'open' }],
    relations: [{ from: '艾莉娅', to: '主控', note: '同事' }],
    worldEvents: [{ text: '裁员评审→发酵' }],
    intel: [
      { text: '主控已婚', knownBy: ['主控'] },
      { text: '公司要裁员', knownBy: ['公开'] },
      { text: '隐藏情报', knownBy: [] }
    ]
  });
  assert.ok(memo.startsWith('【事实备忘】'));
  assert.ok(memo.includes('1. 周五去看展'));
  assert.ok(memo.includes('· 艾莉娅 → 主控：同事'));
  // 世界动态回流：场外动态与世界事件随事实备忘注入，附重逢承接/禁冲突指引
  assert.ok(memo.includes('世界动态'));
  assert.ok(memo.includes('· 裁员评审→发酵'));
  assert.ok(memo.includes('承接'));
  assert.ok(memo.includes('完结'));
  assert.ok(memo.includes('知情约束【硬性】'));
  assert.ok(memo.includes('· 「主控已婚」可知：主控'));
  assert.ok(memo.includes('· 「公司要裁员」可知：公开'));
  assert.ok(memo.includes('· 「隐藏情报」可知：（暂无，仅作隐藏情报）'));
});

test('formatFactsMemo: 关系区声明数值冻结/续写锚点语义，数值段随 note 原样注入', () => {
  const memo = formatFactsMemo({
    promises: [],
    relations: [
      { from: '苏晴', to: '李明', note: '同事｜好感45/100｜阶段:信任' },
      { from: '苏晴', to: '林晚', note: '合租室友' }
    ],
    worldEvents: [], intel: []
  }, '李明');
  // 注入区必须向主模型声明：数值是最新冻结值、重新出场以此为锚、未出场禁止漂移
  assert.ok(memo.includes('最新冻结数值'));
  assert.ok(memo.includes('续写锚点'));
  assert.ok(memo.includes('禁止漂移'));
  // 数值段作为 note 一部分原样注入；NPC 间无边值不受影响
  assert.ok(memo.includes('· 苏晴 → 李明：同事｜好感45/100｜阶段:信任'));
  assert.ok(memo.includes('· 苏晴 → 林晚：合租室友'));
});

// ---------- 世界事件标记提取 ----------

test('extractWorldEventMarkers: 从短期记忆 content 提取并去重', () => {
  const shortTerm = [
    { content: '今天……｜世界：裁员评审→发酵' },
    { content: '明天……｜世界：裁员评审→发酵\n另一行' }
  ];
  assert.deepEqual(extractWorldEventMarkers(shortTerm), ['裁员评审→发酵']);
});

test('parseWorldEventsFromContent: 无标记返回空数组', () => {
  assert.deepEqual(parseWorldEventsFromContent('普通文本'), []);
  assert.deepEqual(parseWorldEventsFromContent(''), []);
  assert.deepEqual(parseWorldEventsFromContent(null), []);
});

// ---------- trimAssistantForMemory ----------

test('trimAssistantForMemory: 在「行动选项」标题处截断', () => {
  const content = '正文部分\n\n>### 行动选项\n1. 选项A\n2. 选项B';
  assert.equal(trimAssistantForMemory(content), '正文部分');
});

test('trimAssistantForMemory: 无该标题则保留全文', () => {
  const content = '正文\n>### 状态栏\n内容';
  assert.equal(trimAssistantForMemory(content), content);
});

// ---------- parseTurnSummary（结构化短期摘要解析） ----------

test('parseTurnSummary: 结构化字段组装为带标签的多行摘要', () => {
  const raw = JSON.stringify({
    date: '2024-03-05',
    characters: '艾莉娅、李明（主控）',
    location: '傍晚·星巴克',
    events: '李明答应周三下午三点帮艾莉娅改简历。',
    changes: '两人约定周三再见面。',
    mood: '艾莉娅由焦虑转为放松',
    promises: [{ text: '周三下午三点星巴克改简历', status: 'open' }],
    relations: [{ from: '艾莉娅', to: '主控', note: '对主控信任加深' }],
    worldEvents: [],
    intel: []
  });
  const r = parseTurnSummary(raw, '2024-03-05');
  assert.equal(r.date, '2024-03-05');
  assert.ok(r.content.includes('出场：艾莉娅、李明（主控）'));
  assert.ok(r.content.includes('场景：傍晚·星巴克'));
  assert.ok(r.content.includes('经过：李明答应周三下午三点帮艾莉娅改简历。'));
  assert.ok(r.content.includes('变化：两人约定周三再见面。'));
  assert.ok(r.content.includes('情绪：艾莉娅由焦虑转为放松'));
  assert.equal(r.promises[0].text, '周三下午三点星巴克改简历');
  assert.equal(r.relations[0].from, '艾莉娅');
});

test('parseTurnSummary: 空字段省略，不留下空标签行', () => {
  const raw = JSON.stringify({ date: '2024-03-05', events: '李明独自回家。', changes: '', mood: '' });
  const r = parseTurnSummary(raw, '2024-03-05');
  assert.equal(r.content, '经过：李明独自回家。');
});

test('parseTurnSummary: 模型退回旧版 content 时原样采用', () => {
  const raw = JSON.stringify({ date: '2024-03-05', content: '一句话旧摘要', promises: [] });
  const r = parseTurnSummary(raw, '2024-03-05');
  assert.equal(r.content, '一句话旧摘要');
});

test('parseTurnSummary: 无法解析时以原文兜底并使用兜底日期', () => {
  const r = parseTurnSummary('这不是 JSON', '2024-01-01');
  assert.equal(r.date, '2024-01-01');
  assert.equal(r.content, '这不是 JSON');
  assert.deepEqual(r.promises, []);
});

test('parseTurnSummary: 带代码块标记的 JSON 也能解析', () => {
  const raw = '```json\n{"date":"2024-03-05","events":"李明加班到深夜。"}\n```';
  const r = parseTurnSummary(raw, '2024-01-01');
  assert.equal(r.date, '2024-03-05');
  assert.equal(r.content, '经过：李明加班到深夜。');
});

// ---------- formatLongTermReference（旧长期只读参考块） ----------

test('formatLongTermReference: 空/非法输入返回空串', () => {
  assert.equal(formatLongTermReference([]), '');
  assert.equal(formatLongTermReference(null), '');
  assert.equal(formatLongTermReference([{ startDate: '2024-01-01' }]), '');
});

test('formatLongTermReference: 单日期与日期区间两种形态', () => {
  const out = formatLongTermReference([
    { startDate: '2024-01-01', endDate: '2024-01-01', content: '第一段' },
    { startDate: '2024-01-02', endDate: '2024-01-10', content: '第二段' }
  ]);
  assert.ok(out.includes('【2024-01-01】\n第一段'));
  assert.ok(out.includes('【2024-01-02 至 2024-01-10】\n第二段'));
});

// ---------- extractMemoryCorrections（记忆修正行机械提取） ----------

test('extractMemoryCorrections: 提取修正行并去前缀去重', () => {
  const content = '正文……\n>### 状态栏\n内容\n记忆修正：艾莉娅其实不知道主控已婚\n记忆修正:裁员评审已经平息\n记忆修正：艾莉娅其实不知道主控已婚\n';
  assert.deepEqual(extractMemoryCorrections(content), [
    '艾莉娅其实不知道主控已婚',
    '裁员评审已经平息'
  ]);
});

test('extractMemoryCorrections: 行首引用符与空白可容忍；无修正返回空', () => {
  assert.deepEqual(extractMemoryCorrections('>>> 记忆修正：测试内容'), ['测试内容']);
  assert.deepEqual(extractMemoryCorrections('正文里没有修正'), []);
  assert.deepEqual(extractMemoryCorrections(''), []);
  assert.deepEqual(extractMemoryCorrections(null), []);
});

test('extractMemoryCorrections: 行中途出现的「记忆修正」不算（必须行首）', () => {
  assert.deepEqual(extractMemoryCorrections('她说：记忆修正：这个不算'), []);
});

// ---------- 长期记忆分层注入（全文区 / 远期目录 / 调取） ----------

function makeLongEntries(n) {
  return Array.from({ length: n }, (_, i) => ({
    startDate: `2026-08-${String(i + 1).padStart(2, '0')}`,
    endDate: `2026-08-${String(i + 1).padStart(2, '0')}`,
    content: `第${i + 1}条剧情的完整内容`,
    title: `第${i + 1}条标题`,
    recallKeys: [`专名${i + 1}号`],
    metaDone: true
  }));
}

test('formatLongTermInjection: 不超过全文区条数时全部全文、无目录', () => {
  const { text, fullIndices } = formatLongTermInjection(makeLongEntries(3));
  assert.ok(text.includes('第1条剧情的完整内容'));
  assert.ok(text.includes('第3条剧情的完整内容'));
  assert.ok(!text.includes('远期记忆目录'));
  assert.equal(fullIndices.size, 3);
});

test('formatLongTermInjection: 超出全文区后旧条目降级为目录行（带绝对编号与标题）', () => {
  const list = makeLongEntries(LONG_TERM_FULL_COUNT + 2);
  const { text, fullIndices } = formatLongTermInjection(list);
  assert.ok(text.includes('远期记忆目录'));
  // 最旧两条进目录，最新 10 条全文
  assert.ok(text.includes('#1 【2026-08-01】第1条标题'));
  assert.ok(text.includes('#2 【2026-08-02】第2条标题'));
  assert.ok(!text.includes('第1条剧情的完整内容'));
  assert.ok(text.includes('第12条剧情的完整内容'));
  assert.equal(fullIndices.size, LONG_TERM_FULL_COUNT);
  assert.ok(!fullIndices.has(0) && !fullIndices.has(1));
});

test('formatLongTermInjection: 加星旧条目保持全文且不进目录', () => {
  const list = makeLongEntries(LONG_TERM_FULL_COUNT + 2);
  list[0].pinned = true;
  const { text, fullIndices } = formatLongTermInjection(list);
  assert.ok(fullIndices.has(0));
  assert.ok(text.includes('第1条剧情的完整内容'));
  assert.ok(!text.includes('#1 【2026-08-01】第1条标题'));
});

test('formatLongTermInjection: 老条目无 title 时以 content 截断兜底', () => {
  const list = makeLongEntries(LONG_TERM_FULL_COUNT + 1);
  delete list[0].title;
  const { text } = formatLongTermInjection(list);
  assert.ok(text.includes('#1 【2026-08-01】第1条剧情的完整内容'.slice(0, 30)));
});

test('extractMemoryRecalls: 提取调取编号并去重；行中途出现不算', () => {
  const content = '正文\n记忆调取：#3\n记忆调取: #5、#3\n她说：记忆调取：#9\n';
  assert.deepEqual(extractMemoryRecalls(content).sort(), [3, 5]);
});

test('matchLongTermRecalls: 命中目录区 recallKeys，全文区跳过，无 keys 跳过', () => {
  const list = makeLongEntries(LONG_TERM_FULL_COUNT + 2);
  const { fullIndices } = formatLongTermInjection(list);
  // 全文区第12条的关键词不该命中
  assert.deepEqual(matchLongTermRecalls(list, '我想起专名12号了', fullIndices), []);
  // 目录区命中：同命中数时较新的条目优先
  assert.deepEqual(matchLongTermRecalls(list, '专名1号 和 专名2号 都提了', fullIndices), [2, 1]);
  // 无 recallKeys 的老条目不参与
  delete list[0].recallKeys;
  assert.deepEqual(matchLongTermRecalls(list, '专名1号', fullIndices), []);
});

test('normalizeFacts/applyTurnFacts: 主控端点归一化——「主控」映射为真名，防裂成两个节点', () => {
  // 无真名时保持「主控」字面（迁移等无名场景）
  const noName = normalizeFacts({ relations: [{ from: '艾莉娅', to: '主控', note: '同事' }] });
  assert.equal(noName.relations[0].to, '主控');
  // 有真名时「主控」→真名；from 端同样归一
  const named = normalizeFacts({ relations: [{ from: '主控', to: '艾莉娅', note: '下属' }] }, '李明');
  assert.deepEqual(named.relations, [{ from: '李明', to: '艾莉娅', note: '下属' }]);
  // 同一条边一边写真名一边写「主控」→ 归并为同一条（不裂图）
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { relations: [{ from: '艾莉娅', to: '李明', note: '同事' }] }, '李明');
  applyTurnFactsToMemory(memory, { relations: [{ from: '艾莉娅', to: '主控', note: '恋人' }] }, '李明');
  assert.deepEqual(memory.facts.relations, [{ from: '艾莉娅', to: '李明', note: '恋人' }]);
});

test('applyTurnFactsToMemory: 世界动态按事件名追加合并——同名不覆盖、保留轨迹，未报的条目原样保留', () => {
  const memory = { facts: emptyFacts() };
  applyTurnFactsToMemory(memory, { worldEvents: [{ text: '裁员评审→发酵' }, { text: '林静→相亲中' }] });
  assert.deepEqual(memory.facts.worldEvents.map((w) => w.text), ['裁员评审→发酵', '林静→相亲中']);
  applyTurnFactsToMemory(memory, { worldEvents: [{ text: '裁员评审→完结' }] });
  // 同名不覆盖：发酵保留，完结追加
  assert.deepEqual(memory.facts.worldEvents.map((w) => w.text), ['裁员评审→发酵', '林静→相亲中', '裁员评审→完结']);
  applyTurnFactsToMemory(memory, { worldEvents: [] });
  assert.equal(memory.facts.worldEvents.length, 3);
});

test('applyTurnFactsToMemory: 同名最多保留最近3条，完全重复文本去重', () => {
  const memory = { facts: emptyFacts() };
  const stages = ['发酵', '升级', '平息', '完结', '后续'];
  for (const s of stages) {
    applyTurnFactsToMemory(memory, { worldEvents: [{ text: `林静→相亲${s}` }] });
  }
  // 只保留最近3条：升级/平息/完结被挤掉发酵，最新是后续
  assert.deepEqual(memory.facts.worldEvents.map((w) => w.text), ['林静→相亲平息', '林静→相亲完结', '林静→相亲后续']);
  applyTurnFactsToMemory(memory, { worldEvents: [{ text: '林静→相亲后续' }] });
  assert.equal(memory.facts.worldEvents.length, 3);
});

test('applyTurnFactsToMemory: 世界动态超过上限丢最旧', () => {
  const memory = { facts: emptyFacts() };
  for (let i = 1; i <= 20; i++) {
    applyTurnFactsToMemory(memory, { worldEvents: [{ text: `事件${i}→发酵` }] });
  }
  assert.equal(memory.facts.worldEvents.length, 15);
  assert.equal(memory.facts.worldEvents[0].text, '事件6→发酵');
});
