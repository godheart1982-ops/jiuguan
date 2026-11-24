// 制卡工坊核心服务：分步联动提示词构造、结果解析、流式调用、一键组装落盘角色卡。
// 所有模板与本 App 的记忆账本（core/全名/神似明星/三围罩杯/外在内在气质/稳定XP）严格对齐。

import { getConfig, getWorldBook, createUUID } from './storage.js';
import { sendChatStream } from './api.js';
import { resolveMemoryApi } from './api-memory.js';
import { DEFAULT_ADULT_WORLD_BOOK_ID, DEFAULT_ADULT_WORLD_BOOK } from './default-world-books.js';
import { normalizeWorldBookSettings, createEmptyWorldBookEntry } from './world-book.js';
import { getCharacterModules } from './card-modules.js';

export const SIMULATOR_V12_BACKGROUND = `【模拟器身份】

你正在运行一张通用人生模拟器母卡，可根据用户要求生成并持续运行普通人生、特定职业、某段时期、某类场所或某种生活方式。
这不是经营游戏、文字闯关或数值养成，也不是围绕预设女主展开的普通角色扮演。
不存在系统、等级、经验、任务、奖励、成就、回合、属性结算或攻略目标。主控是在一个连续世界中生活，正文必须让用户体验正在经历的人生，而不是汇报游戏结果。

【初始化与元指令协议】

1. \`$初始化模拟器：……\`（或用户明确要求生成模拟环境/补充设定）：只生成「记忆补充设定」草案，不写正文、不推进时间、不生成状态栏和行动选项。草案单独放入一个代码块，不加使用说明或额外评论，方便完整复制。
2. 信息不足时，依据现实逻辑与主题需要合理补全，不反复追问；涉及用户明显在意的身份、婚姻、经济、世界观尺度时，不得擅自改成相反方向。
3. \`$修改模拟器草案：……\`：只输出修订后的完整草案代码块，不写正文。
4. 当前对话尚无用户确认并生效的补充设定时，即使用户直接输入「开始」，也只提示用户先用 \`$初始化模拟器：……\` 描述想体验的人生，不得自行建世界开局。补充设定生效后用户输入「开始」，才演出第一轮开局。
5. 补充设定生效后，禁止因普通对话再次初始化或重写世界。中后期用户发送 \`$补充设定补丁：……\` 时，只输出一小段可直接追加到「补充设定」末尾的增量补丁代码块（新增场所、势力或微调规则），不重写整份设定。
6. 用户发送 \`$场外速报\` 时，以客观旁白简要汇报当前活跃/重要 NPC 的近期场外动向与环境暗流（不推进时间、不输出状态栏、不进入主控知情范围）。
7. 补充设定只保存相对稳定的世界基础事实与运行边界；后续人物状态、关系变化、场外动态、事件和日程交由记忆系统维护，不得反复把动态信息堆回补充设定。

【补充设定草案生成规则】

草案必须针对用户指定的生活主题定制，只构建与本次体验直接相关的小社会，不无故扩写无关国家或宏大世界观。未涉及的现实背景默认与现代社会一致，不自行增加超凡、极端黑暗或全员开放等差异。没有内容的条目写「无特别设定」，不得编造：
【本次模拟】概括体验主题、时代背景、现实程度与整体生活氛围。
【主控起点】姓名、性别、年龄、身高体重与基础外貌、家庭与必要背景、当前身份、婚恋状态、住所、经济状况、既有重要关系、能力与资源、当前生活状态；不得擅自安排固定恋人、贵人、敌人或命中注定的重要人物。
【社会环境】主要活动、经济与利益来源、行业规则、公开规范与私下习惯、常见压力与现实后果。
【势力与利益关系】与本次体验有关的组织、阶层、职位与利益关系；势力不主动围绕主控运转。
【场所与生活圈】最初可能活动的区域、场所、消费层次、营业时间与主要人群；具名场所确立后固定。
【人物生成生态】自然出现的职业、阶层与认识渠道；除开局明确存在的家人/伴侣/旧识外，不提前预设具名重要 NPC。
【规则与体验边界】用户明确要求的偏好、禁忌、现实程度与现实代价。
【实际开局】第一轮年月日、星期、具体时间、地点、主控正在做什么及原因；自然切面，不强塞冲突或艳遇。

【运行与主控承接规则】

1. 用户确认的补充设定优先于通用默认；未确认的 AI 草案不自动生效。
2. 「主控起点」与「实际开局」仅用于初始化与第一轮。主控发生重大现实变动（换工作、搬家、大额收支/负债、婚恋或身份变动）时，必须在正文与状态栏清晰落盘；后续以最新正文和当前状态账本为准，禁止把中后期主控拉回开局状态。
3. 主控拥有完全行动自由。平淡日常具有正当性，禁止为制造刺激不断塞入巧合、艳遇、绝症或骤变。

【时间与大跨度推进】

1. 普通互动自然推进时间；只有主控明确提出才跳过数天/数月/数年。
2. 大跨度时间推进按三步自然演出：① 主控自身工作/经济/住所与持续关系变化；② 1–3 位重要 NPC 的场外动向（不等于主控知情）；③ 落到一个具体的新日期与当下生活切面。

【动态人物生成与命名铁律】

1. 数量节制：优先复用已有生活圈人物；同一新场景最多新立 1–2 个具名人物，其余保持无名路人；阶段结束允许旧人物自然淡出。
2. 完整真实全名铁律：具名持续人物在状态栏与人物档案中必须确立完整真实全名（姓+名，如「林小雨」），禁止只用花名/小名/职衔建档；若场景中对方只报花名/小名，正文按对外称呼互动（不让主控提前知情真名），状态栏标注「林小雨（对外自称小雨）」。
3. 不默认新人物单身、空虚或对主控有兴趣；不强制反差或特殊性癖（普通体位/力度/节奏不算性癖）。

【动态人物落地清单（对齐记忆账本）】

具名持续人物首次登场或升格时，通过正文、对话与状态栏自然落地以下要素（确立即为正史，不得重抽）：
· 完整全名、性别、年龄、职业与身份（如有花名一并标明）
· 一句话核心（20字以内大白话：身份 + 主要矛盾/目标 + 当前状态）
· 辨识外貌与基础身材（女性含神似明星、身高、体重、三围、罩杯；男性含身高、体重与基础外貌；避免撞脸）
· 外在气质与实际内在气质（可一致）
· 说话腔调与 1–2 个可演出的小习惯
· 与主控初始关系、认识渠道、现实压力与近期个人目标
· 亲密边界与 xp（仅对成年且可能进入亲密线的人物在触及时逐步落地）

【社会关系、知情边界与正文】

1. 关系从实际身份与相遇情境起步；交易、善意或一次亲密不自动等于恋爱与占有权；拒绝不等于欲擒故纵。
2. 补充设定与场外旁白不等于主控知情；非公开秘密须通过实际经历或他人告知才进入主控认知。
3. 完整沿用现有输出格式，不增加游戏面板；重要相遇、冲突与转折必须演出过程；行动选项不代表已发生事实。`;

export const SIMULATOR_V12_GREETING = `欢迎使用通用模拟器。这里不预设人物和剧情，你可以从想体验的任何人生环境开始。

请用 \`$初始化模拟器：\` 开头，直接用自然语言告诉我：

1. **想体验什么生活**：例如普通都市职场、大学校园、夜场/特定行业、年代生活等。
2. **主控的起点**：年龄、身份、家庭、经济、性格及已有关系，想写多少都可以。
3. **世界与体验要求**：现实程度、城市、特殊社会规则，以及想要或不想要的内容。

示例（任选一条改着发即可）：
- \`$初始化模拟器：我想体验现代都市普通职场与日常社交，主控28岁男，程序员，单身租房，月薪一万五，偏写实。\`
- \`$初始化模拟器：我想体验南方大学校园生活，主控大二男生，家庭小康，社团活跃，不预设固定恋爱对象。\`
- \`$初始化模拟器：我想体验现代都市夜总会生态，主控30岁，经济普通，偏写实、有行业规则和现实代价。\`

生成「补充设定」草案后（\`$\` 开头走元指令，不占轮次也不进记忆），你可以用 \`$修改模拟器草案：……\` 继续微调；确认后复制到记忆编辑器的「补充设定」并保存，再直接发送 \`开始\`（不要加 \`$\`）即可正式开局。`;

const PROTAGONIST_GUIDE_V6 = `严格按《角色卡·人味完整融合版 v6.1》结构输出完整重要角色设定（**不限字数**，把每一个有效条目写透、写具体、写出活人感；直接输出正文，不要加前后解释或代码围栏；非必填项若角色确实没有对应设定则直接删行，严禁套话凑数，严禁为了复杂而强行制造口是心非或表里反差）：

一、核心卡
1. 【一句话核心】：用一句大白话说明身份、主要矛盾/目标与当前状态。
2. 【人物内核】：表面上想要什么 / 实际上需要什么 / 她（他）如何理解自己的行为（可以是清醒自知）/ 不愿面对的弱点或事实（没有就不写）/ 最怕失去什么 / 为了保住重要东西愿意付出什么代价 / 即使恋爱也不会改变的底线。
3. 【核心矛盾（带代价）】：有矛盾才写，无则整项删；有则写 1–2 组写透（矛盾表现与触发场景 / 通常如何给自己找理由 / 这个矛盾造成的实际代价；禁止默认暗恋主控）。
4. 【性格行为规则】：写 3–4 条「情境 → 倾向行为 → 可能后果」（感到丢脸时 / 感到被需要时 / 被冒犯或挑衅时 / 睡眠不足、饥饿或生病时的偏移）。
5. 【误判与盲点】：最容易把什么误读成什么（1–2 类典型误判，如把沉默误读为不在乎、把关心误读为控制）/ 最不擅长表达的需求 / 什么证据才会迫使其承认自己判断错了。

二、情绪与行为引擎
6. 【情绪、防御与延迟反应链】：常见触发 / 对外第一反应与当下自我解释 / 真正被触发的情绪 / 可观察的身体或语言信号 / **延迟反应与事后修复或继续嘴硬的方式（独处后、隔天或再见到对方时的变化）** / 遇到危险或崩溃时的反应 / 被背叛后的典型反应 / 冲突处理风格与压力恢复方式。
7. 【犯错与修复】：最常犯的错误 / 会把什么责任推给别人 / 被指出后的第一反应 / 什么情况下会承认 / 如何道歉 / 道歉后会不会真正改变及改变条件。
8. 【信息可见性】：自己明确知道的动机 / 只会从行为中察觉的动机 / 只有作者知道、角色本人尚未意识到的事实 / 主控必须通过哪些细节才能推断。

三、关系与推进卡
9. 【依恋防线与关系记账】：依恋倾向 / 恋爱当前排位 / 信任建立规则（凭什么信任、时间尺度）/ 关系升温时的防线动作 / 关系变冷时的防御动作 / 暗中试探人的方式 / 关系记账（最记什么好、最记什么仇、什么时候翻旧账）。
10. 【好感推进契约与六阶段相处画面】：初始好感/服从/堕落（非亲密线后两轴可省略）、专属加减分与下头清单、禁止超前称呼；用具体可演出的小动作和同步称呼写出「陌生 / 熟络 / 信任 / 暧昧 / 心动 / 交往中」六阶段相处画面（非恋爱线到信任/挚友即止）；附【恋爱后的样子】（若可恋爱）。

四、生活锚点与立体感
11. 【主控之外的生活与生活锚点】：当前最忙的 2–3 件事、不会轻易为主控取消的安排、固定使用的物件、固定去的地点、有特殊意义的气味或声音、作息与消费习惯。
12. 【习惯与怪癖】：4–6 条带触发条件的下意识小动作（自己没意识到或改不掉的真实习惯，不是卖萌装饰）。
13. 【私人记忆触发器】：2–4 条私人记忆（记忆内容 / 触发物件、气味或地点 / 对外怎么讲 / 刻意省略哪一部分 / 现在还影响什么行为）。
14. 【独处的样子】：3–4 条镜头外状态（独处时真实的样子、人前不会做的事、如何处理孤独无聊与失败、被主控撞见时会遮掩什么）。

五、社交面具与语言指纹
15. 【社交面具】：对陌生人 / 对服务生或弱势者 / 对熟人 / 对密友 / 对家人 / 在群体中的位置（表里一致则写统一表现，不硬分表里）。
16. 【语言指纹与绝不说（禁句清单）】：声线语速、自称分层、称谓分层、用词与比喻取材域、标点与句尾节奏、口头禅、撒谎或不想回答时的语言变化、发消息风格；列出 **3–5 条「绝不说」禁句**（专治礼貌腔、文青腔、顺滑认错话）；写 5–6 句鲜活台词样本（日常放松 / 被冒犯生气 / 害羞或被戳中 / 表达关心或有求于人 / 真正道歉 / 亲密或极度松弛时）。

六、基础信息、外貌与背景因果
17. 【基础信息与外貌穿着】：完整真实全名（姓+名，有花名一并标明，绝不与已有角色重名）、性别、年龄、职业与身份、身高/体重（女性附三围与罩杯，男性附基础体型）、外在气质、实际内在气质（可一致）、神似明星（绝不与已有角色撞脸）、动态第一眼印象与辨识标记、日常穿着与穿衣反映出的性格、2–3 条日常非情色身体存在感/小毛病、与主控及已有重要角色的初始关系。
18. 【成长因果节点与隐藏秘密/暗线】：用 3–5 个因果节点交代「时期事件 → 形成判断 → 留下的习惯或防御」；工作场景与平时住所（住所如何暴露其不愿承认的一面）；有隐藏秘密或进行中暗线才写，无则整项删。`;

const PROTAGONIST_ADULT_ADDON = `
七、成人扩展卡
19. 【亲密观念与稳定 XP】：身心分离/绑定程度、性经验、主动性与底线叫停方式（身体动情不自动等于心理投降）；特殊稳定 XP 仅写 1–2 项真正特别的唤起倾向（普通体位/力度/节奏不算，没有写常规）。
20. 【亲密过程与用语尺度】：情事用语尺度（隐晦/直白/粗俗 + 1–2 句示范台词）、唤起路径与节奏体位偏好、过程三段行为链（刚进入 → 中途动情与高潮 → 结束后余波与心理变化）、六阶段亲密举动解锁梯度。
21. 【身体状态栏与敏感带】：敏感带排序及具体反应 + 供状态栏使用的私密身体细节。`;

const SUPPORTING_GUIDE_V2 = `严格按《配角卡模板 v2》结构输出完整配角设定（**不限字数**，写具体、写出独立活人感，直接输出正文，不要加前后解释或代码围栏）：
1. 【配角·完整全名】：完整真实全名（姓+名，有花名一并标明，绝不与已有角色重名）+ 一句话核心。
2. 【基础信息与外貌】：性别/年龄/职业与身份、身高/体重（女性附三围罩杯，男性附基础体型）、外在气质/实际内在气质（可一致）、神似明星（绝不与已有角色撞脸）+ 第一眼印象与辨识特征 + 日常穿着、与主控及已有重要角色的初始关系。
3. 【性格、误判与雷区】：核心性格与处事逻辑 + 1–2 个典型误判/盲点 + 踩了会翻脸的雷区 + 2–4 条带触发条件的下意识小动作（有反差才写，表里如一则不硬编）。
4. 【语言指纹与绝不说】：声线、自称/称谓、用词底色与口癖；2–3 条「绝不说」禁句；3–4 句台词样本（日常放松 / 被冒犯不耐烦 / 表达关心 / 被戳中软肋）。
5. 【情景反应与关系梯度】：3–4 条「如果 → 第一反应与后续动作」；此人眼中的主控与诉求（不默认爱恋）；初始好感与阶段相处画面。
6. 【背景速记与场外生活】：来历、当前最忙的事、现实压力与近期目标。
（若此配角可能进入亲密线，附简短【xp与私密】：亲密观念、经验、用语尺度、底线与 1–2 项特殊稳定 XP，没有写常规。）`;

function parseJsonLoose(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* continue */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* continue */ }
  }
  for (const match of [text.match(/\{[\s\S]*\}/), text.match(/\[[\s\S]*\]/)]) {
    if (!match) continue;
    try { return JSON.parse(match[0]); } catch { /* continue */ }
  }
  return null;
}

/** 从角色模块文本中尽力提取每个模块的完整姓名（用于自动生成不在场 NPC 名单与防重名提示）。 */
export function extractCharacterNamesFromModules(modules) {
  const list = Array.isArray(modules) ? modules : [];
  const names = [];
  const seen = new Set();
  for (const mod of list) {
    const text = String(mod || '').trim();
    if (!text) continue;
    let found = '';
    const patterns = [
      /【配角[·•\s]*([^】\n（(]+?)(?:（|\(|】)/,
      /(?:完整全名|姓名)[：:]\s*([^\s，,。；;（(\n/｜|]{2,12})/,
      /^#+\s*([^\s，,。；;（(\n]{2,12})/m
    ];
    for (const re of patterns) {
      const m = re.exec(text);
      if (m && m[1]) {
        const candidate = m[1].trim().replace(/^[「『"']|[」』"']$/g, '');
        if (candidate && candidate.length >= 2 && candidate.length <= 12 && !/^(姓名|全名|配角|主角|基础信息|一句话核心)$/.test(candidate)) {
          found = candidate;
          break;
        }
      }
    }
    if (found && !seen.has(found)) {
      seen.add(found);
      names.push(found);
    }
  }
  return names;
}

function cleanShortName(val) {
  let s = String(val || '').trim();
  s = s.replace(/^(?:主控)?(?:完整)?(?:姓名|名字)[：:\s]+/, '').trim();
  s = s.replace(/^[「『"'*`]+|[」』"'*`]+$/g, '').trim();
  const firstLine = s.split(/\r?\n/)[0].trim();
  return firstLine.replace(/[（(].*$/, '').trim();
}

function extractTaggedSections(text) {
  const headerRe = /^(?:#{1,4}\s*|\*{2}|\[|【)?(角色卡名称|角色卡名|卡名|背景设定|世界观与背景|世界观设定|主控姓名|主控名字|主控简介|主控设定|主控信息)(?:】|\]|\*{2})?[：:\s]*$/gm;
  const inlineRe = /^(?:#{1,4}\s*|\*{2}|\[|【)?(角色卡名称|角色卡名|卡名|背景设定|世界观与背景|世界观设定|主控姓名|主控名字|主控简介|主控设定|主控信息)(?:】|\]|\*{2})[：:\s]*(.*)$/gm;

  const hits = [];
  let m;
  while ((m = inlineRe.exec(text)) !== null) {
    hits.push({ key: m[1], inlineVal: (m[2] || '').trim(), index: m.index, end: m.index + m[0].length });
  }
  if (!hits.length) {
    while ((m = headerRe.exec(text)) !== null) {
      hits.push({ key: m[1], inlineVal: '', index: m.index, end: m.index + m[0].length });
    }
  }
  if (!hits.length) return null;

  const map = {};
  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i];
    const nextStart = i + 1 < hits.length ? hits[i + 1].index : text.length;
    const body = text.slice(cur.end, nextStart).trim();
    const val = cur.inlineVal && body ? `${cur.inlineVal}\n${body}` : (cur.inlineVal || body);
    const k = cur.key;
    if (/^(角色卡名称|角色卡名|卡名)$/.test(k)) map.cardName = val;
    else if (/^(背景设定|世界观与背景|世界观设定)$/.test(k)) map.background = val;
    else if (/^(主控姓名|主控名字)$/.test(k)) map.mainControlName = val;
    else if (/^(主控简介|主控设定|主控信息)$/.test(k)) map.mainControlDesc = val;
  }
  return map;
}

function extractBrokenJsonWorldFields(text) {
  if (!/"background"\s*:/.test(text) && !/"mainControlName"\s*:/.test(text)) return null;
  const grab = (key) => {
    const re = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?=,\\s*"(?:cardName|name|background|mainControlName|mainControlDesc|mainControl)"|\\s*\\})`);
    const m = re.exec(text);
    if (!m) return '';
    return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
  };
  const background = grab('background');
  const mainControlName = grab('mainControlName');
  const mainControlDesc = grab('mainControlDesc');
  const cardName = grab('cardName') || grab('name');
  if (!background && !mainControlName && !mainControlDesc) return null;
  return { cardName, background, mainControlName, mainControlDesc };
}

/** 解析第 1 步「背景与主控」输出（兼容标记分段、合法 JSON 及带换行的半残 JSON）。 */
export function parseWorldAndMainControl(raw) {
  const text = String(raw || '').trim();
  if (!text) return { cardName: '', background: '', mainControlName: '', mainControlDesc: '' };

  // 1) 优先尝试合法 JSON
  const parsed = parseJsonLoose(text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return {
      cardName: String(parsed.cardName || parsed.name || '').trim(),
      background: String(parsed.background || '').trim(),
      mainControlName: cleanShortName(parsed.mainControlName || (parsed.mainControl && parsed.mainControl.name) || ''),
      mainControlDesc: String(parsed.mainControlDesc || (parsed.mainControl && parsed.mainControl.description) || '').trim()
    };
  }

  // 2) 其次解析标准标记分段（【角色卡名称】/【背景设定】/【主控姓名】/【主控简介】）
  const sections = extractTaggedSections(text);
  if (sections && (sections.background || sections.mainControlName || sections.mainControlDesc)) {
    let mcName = cleanShortName(sections.mainControlName || '');
    let mcDesc = String(sections.mainControlDesc || '').trim();
    if (!mcName && mcDesc) {
      const nameMatch = mcDesc.match(/(?:完整)?(?:姓名|名字)[：:]\s*([^\s，,。；;\n]{1,12})/);
      if (nameMatch) mcName = cleanShortName(nameMatch[1]);
    }
    return {
      cardName: String(sections.cardName || '').trim().split(/\r?\n/)[0].trim(),
      background: String(sections.background || '').trim(),
      mainControlName: mcName,
      mainControlDesc: mcDesc
    };
  }

  // 3) 兼容模型输出了含未转义换行的半残 JSON
  const broken = extractBrokenJsonWorldFields(text);
  if (broken) {
    return {
      cardName: broken.cardName,
      background: broken.background,
      mainControlName: cleanShortName(broken.mainControlName),
      mainControlDesc: broken.mainControlDesc
    };
  }

  // 4) 兜底
  return {
    cardName: '',
    background: text,
    mainControlName: '',
    mainControlDesc: ''
  };
}

/** 解析第 4 步可选「联动世界书条目」JSON 数组。 */
export function parseWorldBookDraft(raw) {
  const parsed = parseJsonLoose(raw);
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : []);
  const stamp = Date.now();
  return arr
    .filter((item) => item && typeof item === 'object' && String(item.content || '').trim())
    .map((item, idx) => {
      const keys = Array.isArray(item.keys)
        ? item.keys.map((k) => String(k || '').trim()).filter(Boolean)
        : String(item.keys || '').split(/[,，;；\n]+/).map((k) => k.trim()).filter(Boolean);
      return {
        ...createEmptyWorldBookEntry(`wb-${stamp}-${idx}`),
        name: String(item.name || item.title || '世界书条目').trim().slice(0, 40),
        keys,
        content: String(item.content || '').trim(),
        constant: item.constant === true,
        enabled: true,
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : 100
      };
    });
}

function getDraftMajorModules(draft = {}) {
  if (Array.isArray(draft.majorModules)) {
    return draft.majorModules.map((s) => String(s || '').trim()).filter(Boolean);
  }
  const single = String(draft.protagonistModule || '').trim();
  return single ? [single] : [];
}

/** 读取用户当前「默认·叙事引擎破甲」世界书中的启用条目内容（未落盘时回退内置默认值）。 */
export async function loadStudioBypassPrompt() {
  let book = null;
  try {
    book = await getWorldBook(DEFAULT_ADULT_WORLD_BOOK_ID);
  } catch {
    book = null;
  }
  const source = (book && Array.isArray(book.entries) && book.entries.length)
    ? book.entries
    : (DEFAULT_ADULT_WORLD_BOOK.entries || []);
  return source
    .filter((e) => e && e.enabled !== false && String(e.content || '').trim())
    .map((e) => String(e.content).trim())
    .join('\n\n');
}

/** 构造各步骤的联动提示词 messages（严格带入前置已确认内容，可选注入破甲词）。 */
export function buildStudioStepMessages(step, draft = {}, extraInstruction = '', bypassPrompt = '') {
  const note = String(extraInstruction || '').trim();
  const noteBlock = note ? `\n\n【本轮额外修改要求】\n${note}` : '';
  const bypass = String(bypassPrompt || '').trim();
  const withBypass = (sys) => (bypass ? `${sys}\n\n${bypass}` : sys);
  const majorModules = getDraftMajorModules(draft);
  const supportingModules = (Array.isArray(draft.supportingModules) ? draft.supportingModules : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const allModules = [...majorModules, ...supportingModules];
  const existingNames = extractCharacterNamesFromModules(allModules);

  if (step === 'concept') {
    const seed = String(draft.oneLiner || draft.concept || '').trim() || '现代都市写实日常';
    const prompt = `请把用户的「一句话脑洞」扩写成一份**可直接用于后续制卡的详细开卡灵感**（不限字数，写扎实、有画面感，纯文本分段，不要输出 JSON 或多余客套）。
请包含以下 5 个部分（简洁有力、有画面感、拒绝网文套话与廉价反差）：
1. 【题材基调与氛围】：时代/城市氛围、写实程度、情绪节奏与核心看点。
2. 【核心舞台与生活圈】：2–4 个可反复展开日常与冲突的具体场所、行业/圈层规则。
3. 【主控定位与起点】：建议的主控身份、年龄段、经济与生活处境、入局切入点。
4. 【重要角色规划（1–3位）】：建议的核心重要角色定位、彼此关系张力与明显区分度（先给轮廓与定位，不必写全套细则）。
5. 【互动钩子与雷区边界】：适合展开的日常/剧情冲突钩子、慢热或推进节奏建议、以及需要规避的雷点。

【用户一句话脑洞】
${seed}

【题材/尺度偏好】
${draft.includeAdult ? '包含亲密关系与成人扩展设定' : '常规剧情/日常向，不含露骨成人设定'}${noteBlock}`;
    return [
      { role: 'system', content: withBypass('你是经验丰富的中文角色扮演策划与制卡编剧。擅长把一句话想法扩写成扎实、可玩性高、人物关系有张力的开卡灵感，不写空话套话。') },
      { role: 'user', content: prompt }
    ];
  }

  if (step === 'world') {
    const prompt = `请根据用户的制卡灵感，构建本次角色扮演的「背景设定」与「主控设定」。
请严格按以下四个标记分段输出，**不要输出 JSON、不要用代码块、不要把主控姓名或主控简介混写进背景设定**：

【角色卡名称】
建议的角色卡显示名（如故事名或核心角色名，10字以内）

【背景设定】
世界观、城市/舞台、社会规则、主要场所与生活圈（不限字数，写具体可复用的舞台、地点与现实运行规则，不写具体角色人设，不写主控信息）

【主控姓名】
主控完整姓名（仅写姓名本身；如用户已指定则沿用，否则按题材起一个自然真名）

【主控简介】
主控的身份、年龄、基础外貌、住所、经济状况、性格底色与当前生活状态（不限字数，写具体扎实）

【用户制卡灵感】
${String(draft.concept || '').trim() || '现代都市写实日常'}

【题材/尺度偏好】
${draft.includeAdult ? '包含亲密关系与成人扩展设定' : '常规剧情/日常向，不含露骨成人设定'}${noteBlock}`;
    return [
      { role: 'system', content: withBypass('你是专业的中文角色扮演世界观与制卡架构师。严格按四个【】标记分段输出，严禁输出 JSON 或把主控信息写进背景设定。') },
      { role: 'user', content: prompt }
    ];
  }

  if (step === 'major' || step === 'protagonist') {
    const idea = String(draft.majorIdea || '').trim();
    const existingBlock = majorModules.length
      ? `\n\n【已有角色姓名（严禁重名）】\n${existingNames.length ? existingNames.join('、') : '暂无'}\n\n【已有重要角色模块（用于关系联动与防撞脸，绝不重复神似明星或人设）】\n${majorModules.join('\n\n---\n\n')}`
      : '';
    const prompt = `请基于以下已确认的「背景设定」和「主控设定」${majorModules.length ? '，以及已有的重要角色' : ''}，创作本卡的第 ${majorModules.length + 1} 名**重要角色模块**。
${PROTAGONIST_GUIDE_V6}${draft.includeAdult ? PROTAGONIST_ADULT_ADDON : ''}

【用户原始灵感】
${String(draft.concept || '').trim() || '无'}

【本名重要角色构思】
${idea || (majorModules.length ? '结合背景与已有重要角色，自然创作另一位戏份核心、性格与定位有明显区分度的重要角色' : '按用户原始灵感创作核心重要角色')}

【已确认·背景设定】
${String(draft.background || '').trim() || '现代都市'}

【已确认·主控信息】
主控姓名：${String(draft.mainControlName || '').trim() || '未指定'}
${String(draft.mainControlDesc || '').trim() || '无'}${existingBlock}${noteBlock}`;
    return [
      { role: 'system', content: withBypass('你是顶尖的中文角色扮演制卡师。严禁套话、严禁网文模板腔、严禁强制反差；注重鲜活的语言指纹、禁句与具体可演出的行为画面。') },
      { role: 'user', content: prompt }
    ];
  }

  if (step === 'supporting') {
    const prompt = `请基于以下已确认的世界观、主控与已有角色，创作一名**联动配角模块**，要求与已有角色关系自然咬合、不重复写已有角色视角里已写的内容、**绝不重名、绝不与已有角色撞神似明星或模板脸**。
${SUPPORTING_GUIDE_V2}

【本名新配角构思】
${String(draft.supportingIdea || '').trim() || '根据背景与已有角色生活圈，自然生成一位能带来互动张力或日常烟火气的重要配角'}

【已有角色姓名（严禁重名）】
${existingNames.length ? existingNames.join('、') : '暂无'}

【已确认·背景设定】
${String(draft.background || '').trim() || '无'}

【已确认·主控信息】
主控姓名：${String(draft.mainControlName || '').trim() || '未指定'}
${String(draft.mainControlDesc || '').trim() || '无'}

【已有角色模块（用于关系联动与防撞脸）】
${allModules.length ? allModules.join('\n\n---\n\n') : '暂无'}${noteBlock}`;
    return [
      { role: 'system', content: withBypass('你是顶尖的中文角色扮演配角制卡师。直接输出完整配角设定文本，注重语言辨识度、禁句与独立生活。') },
      { role: 'user', content: prompt }
    ];
  }

  if (step === 'opening') {
    const prompt = `请基于以下全套已确认的设定，撰写一段**第一轮开场白**（不限字数，写出沉浸生活流与场景氛围，直接输出开场白正文，不加任何解释或状态栏/行动选项）。
要求：
1. 自然切入一个具体的时间、地点与生活切面，与【与主控的初始关系】和【六阶段相处画面】的初始阶段严格一致，禁止超前熟络或强塞艳遇；
2. 人物对话严格遵守其【语言指纹】与【绝不说】禁句清单，一开口就立住人味；
3. 留出自然的互动空间让主控接话或行动，禁止替主控做决定或写主控台词。

【已确认·背景设定】
${String(draft.background || '').trim() || '无'}

【已确认·主控信息】
主控姓名：${String(draft.mainControlName || '').trim() || '未指定'}
${String(draft.mainControlDesc || '').trim() || '无'}

【已确认·全部角色模块】
${allModules.join('\n\n---\n\n') || '无'}${noteBlock}`;
    return [
      { role: 'system', content: withBypass('你是擅长生活流与沉浸叙事的中文小说作者。只输出开场白正文，不输出状态栏、行动选项或任何元说明。') },
      { role: 'user', content: prompt }
    ];
  }

  if (step === 'worldbook') {
    const prompt = `请基于以下全套角色卡设定，提炼 3–6 条**按关键词触发的世界书条目**（把非每轮必用、但提到特定地点/组织/专有名词/旧事时需要精准补全的细节拆进世界书，帮主对话省常驻 Token）。
只输出一个合法 JSON 数组，不要输出解释：
[{"name":"简短标题","keys":["触发词1","触发词2"],"content":"条目具体内容（不限字数，事实准确，不与主设定矛盾）","constant":false,"order":100}]

【额外主题要求】
${String(draft.worldbookIdea || '').trim() || '自动提炼背景中的关键地点、势力规则或共享旧事'}

【已确认·背景设定】
${String(draft.background || '').trim() || '无'}

【已确认·全部角色模块】
${allModules.join('\n\n---\n\n') || '无'}${noteBlock}`;
    return [
      { role: 'system', content: withBypass('你是世界书条目提炼助手。只输出合法 JSON 数组，宁缺毋滥。') },
      { role: 'user', content: prompt }
    ];
  }

  throw new Error(`未知制卡步骤：${step}`);
}

/** 调用主 API 或副 API 流式执行某一步生成。 */
export async function runStudioStep(step, draft, options = {}) {
  const config = await getConfig();
  const baseApi = (config && config.api) || {};
  const api = options.apiTarget === 'memory' ? resolveMemoryApi(baseApi) : baseApi;
  if (!api || !api.baseUrl || !api.apiKey || !api.model) {
    throw new Error(options.apiTarget === 'memory' ? '副 API 配置不完整，请先在「API 设置」中填写' : '主 API 配置不完整，请先在「API 设置」中填写');
  }
  const bypassPrompt = options.injectBypass !== false ? await loadStudioBypassPrompt() : '';
  const messages = buildStudioStepMessages(step, draft, options.extraInstruction || '', bypassPrompt);
  return new Promise((resolve, reject) => {
    let full = '';
    let settled = false;
    let controller = null;

    const cleanup = () => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (controller) controller.abort();
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error('已中止生成');
      err.name = 'AbortError';
      reject(err);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      controller = sendChatStream(
        messages,
        {
          onChunk: (chunk) => {
            full += chunk;
            if (options.onChunk) options.onChunk(full, chunk);
          },
          onDone: (finalText, aborted) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (aborted) {
              const err = new Error('已中止生成');
              err.name = 'AbortError';
              reject(err);
              return;
            }
            resolve(finalText || full);
          },
          onError: (errMsg) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(errMsg || '生成失败'));
          }
        },
        { kind: 'studio', api }
      );
    } catch (err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
  });
}

/** 将向导草稿一键组装为可直接 saveCharacter 的完整角色卡对象。 */
export function assembleCharacterCard(draft = {}, id = '') {
  const now = new Date().toISOString();
  const major = getDraftMajorModules(draft);
  const supporting = (Array.isArray(draft.supportingModules) ? draft.supportingModules : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const characterModules = [...major, ...supporting].filter(Boolean);
  const extractedNames = extractCharacterNamesFromModules(characterModules);
  const name = String(draft.cardName || '').trim() || extractedNames[0] || '未命名角色';
  const offscreenRoles = Array.isArray(draft.offscreenRoles)
    ? draft.offscreenRoles.map((s) => String(s || '').trim()).filter(Boolean)
    : extractedNames;
  const worldBookEntries = Array.isArray(draft.worldBookEntries) ? draft.worldBookEntries : [];

  return {
    id: id || `char-${Date.now()}`,
    name,
    avatar: '',
    background: String(draft.background || '').trim(),
    characterModules,
    greeting: String(draft.greeting || '').trim(),
    thinkingFormat: '',
    outputFormat: '',
    thinkingPresetId: String(draft.thinkingPresetId || '').trim(),
    outputPresetId: String(draft.outputPresetId || '').trim(),
    noGlobalPrompts: true,
    group: String(draft.group || '').trim(),
    mainControl: {
      name: String(draft.mainControlName || '').trim(),
      description: String(draft.mainControlDesc || '').trim()
    },
    offscreenRoles,
    memoryEnabled: true,
    enableRandomNarrative: draft.enableRandomNarrative !== false,
    rawWindowTurns: 3,
    worldBook: normalizeWorldBookSettings({
      enabled: true,
      scanDepth: 4,
      caseSensitive: false,
      maxRecursion: 3,
      ignoreStatusBar: true,
      boundBookIds: [DEFAULT_ADULT_WORLD_BOOK_ID],
      entries: worldBookEntries
    }),
    creator: '制卡工坊',
    tags: [],
    createdAt: now,
    updatedAt: now
  };
}

/** 一键生成内置《通用模拟器母卡 v1.2》标准角色卡对象。 */
export function buildSimulatorCardObject(options = {}, id = '') {
  const now = new Date().toISOString();
  return {
    id: id || `sim-${Date.now()}`,
    name: String(options.name || '').trim() || '通用人生模拟器',
    avatar: '',
    background: SIMULATOR_V12_BACKGROUND,
    characterModules: [],
    greeting: SIMULATOR_V12_GREETING,
    thinkingFormat: '',
    outputFormat: '',
    thinkingPresetId: String(options.thinkingPresetId || '').trim(),
    outputPresetId: String(options.outputPresetId || '').trim(),
    noGlobalPrompts: true,
    group: String(options.group || '').trim() || '模拟器',
    mainControl: { name: '', description: '' },
    offscreenRoles: [],
    memoryEnabled: true,
    enableRandomNarrative: false, // 模拟器自带生态，默认关闭冲突的内置随机 NPC/事件
    rawWindowTurns: 3,
    worldBook: normalizeWorldBookSettings({
      enabled: true,
      scanDepth: 4,
      caseSensitive: false,
      maxRecursion: 3,
      ignoreStatusBar: true,
      boundBookIds: [DEFAULT_ADULT_WORLD_BOOK_ID],
      entries: []
    }),
    creator: '制卡工坊',
    tags: ['模拟器'],
    createdAt: now,
    updatedAt: now
  };
}

/** 为已有角色卡构造增量扩展上下文草稿。 */
export function draftFromExistingCharacter(character) {
  const modules = getCharacterModules(character || {});
  return {
    cardName: String((character && character.name) || ''),
    background: String((character && character.background) || ''),
    mainControlName: String((character && character.mainControl && character.mainControl.name) || ''),
    mainControlDesc: String((character && character.mainControl && character.mainControl.description) || ''),
    majorModules: modules.slice(0, 1),
    protagonistModule: modules[0] || '',
    supportingModules: modules.slice(1)
  };
}

export async function createCardId() {
  return createUUID();
}
