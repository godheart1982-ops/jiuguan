// chat-markdown.js splitLeadingModules 单测：状态栏折叠的区域切分
// 切错会把正文吞进折叠块或把模块漏在外面——直接影响聊天页每条回复的展示
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLeadingModules } from '../src/pages/chat/chat-status-fold.js';

const TYPICAL_REPLY = `>### — 🌍世界信息 —
\`\`\`
📰公共事件:平稳无事
\`\`\`
>### — 🏙️场景信息🌆 —
\`\`\`
📅日期:2026年8月1日_星期六  🕑时间:14:30
\`\`\`
>### [林悦♀|咖啡店老板]（各字段上限见字段内说明）
>【身体五字段·仅亲密场景输出】非亲密场景整组省略
\`\`\`
📋基础信息:26|168cm|52kg
\`\`\`

午后的阳光斜斜切进咖啡馆。

"**今天怎么一个人？**"她偏过头。

（他从刚才起就没移开过视线……）

>### 🖼️插图
![林悦](https://image.pollinations.ai/prompt/xxx?seed=233)`;

test('splitLeadingModules: 开头连续模块区与正文正确分离，尾部插图模块留在正文区', () => {
  const { modules, headings, rest } = splitLeadingModules(TYPICAL_REPLY);
  assert.ok(modules.includes('🌍世界信息'));
  assert.ok(modules.includes('📋基础信息')); // 模块注释行（> 开头）归属模块区
  assert.ok(!modules.includes('午后的阳光')); // 正文不进折叠
  assert.ok(rest.includes('午后的阳光斜斜切进咖啡馆'));
  assert.ok(rest.includes('🖼️插图')); // 尾部插图模块不折叠，图片常显
  assert.ok(rest.includes('（他从刚才起就没移开过视线……）'));
  // 摘要标题提取：装饰破折号剥离、角色名从方括号取出
  assert.deepEqual(headings, ['🌍世界信息', '🏙️场景信息🌆', '林悦♀']);
});

test('splitLeadingModules: 无模块的回复原样返回', () => {
  const plain = '第一句正文。\n\n第二句。';
  const { modules, headings, rest } = splitLeadingModules(plain);
  assert.equal(modules, '');
  assert.deepEqual(headings, []);
  assert.equal(rest, plain);
});

test('splitLeadingModules: 空行开头 + 模块区围栏未闭合也不越过正文', () => {
  const text = '\n>### — 🌍世界信息 —\n```\n📰公共事件:平稳无事\n```\n\n正文开始。';
  const { modules, rest } = splitLeadingModules(text);
  assert.ok(modules.includes('🌍世界信息'));
  assert.ok(rest.startsWith('正文开始。'));
});
