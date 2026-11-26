// 提示词组装、安全过滤、镜头词、锚点衔接与出图编排
import { sendChat } from '../api.js';
import { resolveMemoryApi } from '../api-memory.js';
import { getCharacterModules } from '../card-modules.js';
import {
  isStrictMechanicalProvider, generateSeedreamImage, generateWanxImage,
  generateGrokImage, generateGrokWebImage, generateGeminiImage,
  generateOpenAIImage, isModerationError
} from './providers.js';
import { anchorTextOf, extractNamedAppearanceAnchor, resolveAnchorRefImages } from './anchors.js';
import {
  DEFAULT_STRICT_OUTFIT_LIBRARY, DEFAULT_GROK_OUTFIT_LIBRARY,
  resolveStrictOutfitLibrary, resolveGrokOutfitLibrary,
  fillOutfitTemplate, replaceOutfitMarker, applyForcedOutfit, pickRandomOutfitLine, buildStrictBodyPrompt
} from './outfit-library.js';

const STYLE_SUFFIX = '，strictly photorealistic real photograph, natural skin texture with visible pores and subtle imperfections, unretouched, zero anime influence';

// 硬性禁词替换表【App 层机械过滤，发火山前必过】：
// 性器官名称、三点描写、露骨行为词出现必被审核拒，AI 清洗可能漏，这里确定性替换/删除。
// 顺序敏感：长词在前，先替换再清理。
const HARD_WORD_REPLACEMENTS = [
  // 三点与性器官 → 中性身体部位词
  [/乳[头頭尖晕暈]/g, '胸口'],
  [/乳房/g, '胸部'],
  [/阴[部道蒂唇核阜]/g, '身体'],
  [/阴茎|龟头|鸡巴|肉棒|阳[具物根]|性器官?/g, '身体'],
  [/子宫|卵巢/g, '身体'],
  [/肛门|菊[花穴]/g, '臀部'],
  // 体液与结果类 → 删除
  [/精液|爱液|淫[液水]|潮吹/g, ''],
  // 裸露直白词 → 安全改写
  [/全裸|赤裸|裸体|一丝不挂|光着身子/g, '衣着单薄'],
  // 露骨行为词 → 淡化或删除
  [/性交|做爱|交合|媾和|欢爱/g, '相拥'],
  [/抽插|插入|顶弄|挺动/g, '贴近'],
  [/后入/g, '从身后靠近'],
  [/口交|乳交|足交|肛交/g, ''],
  [/内射|中出|射精/g, ''],
  [/自慰|手淫/g, ''],
  [/强[奸暴]/g, ''],
  // 痛苦屈服类（胁迫信号，比暧昧词更敏感）
  [/泪流满面|潸然泪下|泣不成声/g, '出神'],
  [/哭[泣着喊]?|流泪|抽泣|哽咽/g, ''],
  [/臣服|屈服|屈辱|求饶|挣扎/g, ''],
  // 姿态部位细化（粗略姿态合法，展开到部位开合就撞审核）
  [/双腿[张分]开|两腿[张分]开|膝盖分开/g, ''],
  [/屁[股屁]|臀部|翘臀|胯部/g, ''],
  [/撅[起着]?|翘起|高高翘|扭腰|摆[胯臀]/g, ''],
  // 部位形状特写（报数据安全，描形状撞审）
  [/浑圆|水蜜桃|蜜桃臀|饱满|挺拔|酥胸/g, ''],
  // 罩杯字母（实测同样撞审核）
  [/罩杯|[A-Fa-f]\s?杯/g, '']
];

// Grok 专用轻量禁词表：Grok 审核宽松（实测非全裸即可过），只机械拦截最露骨的几类，
// 痛苦表情/姿态细节/部位形状/罩杯字母全部放行，交给 compose 指令自由发挥
const GROK_HARD_WORD_REPLACEMENTS = [
  // 三点与性器官 → 中性身体部位词（非全裸红线，保留）
  [/乳[头頭尖晕暈]/g, '胸口'],
  [/乳房/g, '胸部'],
  [/阴[部道蒂唇核阜]/g, '身体'],
  [/阴茎|龟头|鸡巴|肉棒|阳[具物根]|性器官?/g, '身体'],
  [/子宫|卵巢/g, '身体'],
  [/肛门|菊[花穴]/g, '臀部'],
  // 体液与结果类 → 删除
  [/精液|爱液|淫[液水]|潮吹/g, ''],
  // 全裸直白词 → 安全改写（非全裸红线，保留）
  [/全裸|赤裸|裸体|一丝不挂|光着身子/g, '衣衫不整'],
  // 露骨性行为词 → 淡化或删除（保留：这是行为不是穿着，Grok 同样会拒）
  [/性交|做爱|交合|媾和|欢爱/g, '相拥'],
  [/抽插|插入|顶弄|挺动/g, '贴近'],
  [/后入/g, '从身后靠近'],
  [/口交|乳交|足交|肛交/g, ''],
  [/内射|中出|射精/g, ''],
  [/自慰|手淫/g, ''],
  [/强[奸暴]/g, '']
];

// 机械过滤：返回过滤后的提示词（必定安全可发）。provider==='grok' 时用轻量表
function hardFilterPrompt(prompt, provider) {
  const table = provider === 'grok' ? GROK_HARD_WORD_REPLACEMENTS : HARD_WORD_REPLACEMENTS;
  let out = prompt || '';
  for (const [re, replacement] of table) {
    out = out.replace(re, replacement);
  }
  // 替换可能产生的重复标点/空泛段，顺手清理
  return out.replace(/，{2,}/g, '，').replace(/^，|，$/g, '').trim();
}

// L2 保底降级【最后一次生成尝试的机械安全模式】：
// 副API 被指令"场景信息尽量保留"，永远做不到"弃场景保出图"，
// 所以最后一次不再问 AI——机械删除全部风险维度（私密场景/衣着状态/媚态表情/身材强调/卧躺姿态），
// 只留容貌气质，追加固定安全框架。这级几乎不可能被驳回，保证有图可出。
const L2_STRIP_REPLACEMENTS = [
  // 私密/暧昧场景词
  [/卧室|床[单铺被头]?|浴室|酒店|宾馆|浴缸|浴池|温泉|被窝|枕头/g, ''],
  [/夜晚|深夜|夜里|凌晨|夜色|月光下?|昏[暗黄]灯光?|灯光昏[暗黄]/g, ''],
  // 衣着状态词
  [/单薄|暴露|透明|浴袍|浴巾|吊带|领口|肩带|睡衣|蕾丝|内衣|低胸/g, ''],
  // 媚态表情词
  [/红晕|潮红|咬唇|迷离|喘息|娇喘|妩媚|魅惑|媚眼/g, ''],
  // 身材强调（单独不违规，L2 求稳全删）
  [/巨乳|丰胸|豪乳|翘臀|[A-Fa-f]\s?罩?杯/g, ''],
  // 卧躺姿态（与肖像框架冲突）
  [/趴[着在]?|躺[着在]?|跪[着坐]?/g, ''],
  // 私密衣着占位符（降级会自带"日常家居服"，标记留着会双重衣着；宽容匹配括号变体）
  [/[【\[「『\(（]?\s*私密衣着\s*[】\]」』\)）]?/g, '']
];

function degradeToPortraitPrompt(prompt) {
  let out = prompt || '';
  for (const [re, replacement] of L2_STRIP_REPLACEMENTS) {
    out = out.replace(re, replacement);
  }
  out = out.replace(/，{2,}/g, '，').replace(/^，|，$/g, '').trim();
  return out + '，单人半身肖像，日常家居服，自然微笑，简洁明亮的室内背景';
}

// 默认的 compose system prompt（可在设置中自定义）
export const DEFAULT_COMPOSE_SYSTEM_PROMPT = '你是生图提示词编写器。根据【角色卡设定】和【AI 最新回复】，为文生图模型编写一条中文画面描述。\n' +
  '要求：\n' +
  '- 只输出提示词本身，不要任何解释、引号或前后缀；\n' +
  '- 不超过 250 字；\n' +
  '- 画面人物【铁律】：永远只画 1 位女性角色（本轮互动中最重要的那位），第三人称视角；主控、男性、其他角色一律不入画；\n' +
  '- 肢体纯净【铁律】：画面中所有可见肢体必须属于她自己，禁止任何形式的第二人——虚构/模糊的人、身后的人、画外伸来的手、"被人抱着/搂着/托着/亲吻"等被动式描述一律禁止；剧情中的互动对象一律用家具道具替代（坐在人身上→坐在沙发扶手/椅子边缘；被人抱着→抱着抱枕/蜷缩在被子里；被托着→倚靠台面/床头）；\n' +
  '- 剧情还原方式：用她的姿态、表情、衣着还原本轮剧情瞬间；亲密场景就画她独自一人的姿态神情（如趴在台面、回头、抱着抱枕），禁止描绘双人互动；\n' +
  '- 姿态保真【优先级高于场景】：安全改写只能替换承载物与场景，禁止改变她的身体造型——跨坐在人身上→跨坐在沙发扶手/矮柜边缘；躺在床上→侧卧在沙发/软榻上；被环抱→抱着抱枕；被压身下→仰躺抱着枕头；禁止为了安全顺手改成站立/端坐等与原剧情无关的姿势；\n' +
  '- 场景环境【分级处理】：剧情场景本身日常安全（咖啡馆/公园/客厅/办公室/街道/庭院等）时照常还原；剧情场景属于私密暧昧场所（卧室/床/浴室/酒店房间/夜晚独处空间）时禁止还原——只保留时代与题材背景（现代都市/古代宫廷/校园等），另选一个同时代的日常安全场景（窗边/阳台/沙发旁/街边等）；\n' +
  '- 表情神态：按剧情自由描写，情动类（红晕/咬唇/迷离/娇羞/潮红/喘息等）允许使用——暧昧场景的衣着已全副武装，表情不占风险；唯一禁区【绝对禁止】痛苦屈服类：泪流满面/哭泣/流泪/抽泣/臣服/屈服/屈辱/挣扎/求饶——审核把泪痕与屈服词判定为胁迫信号，与衣着无关，剧情中的痛苦/屈服状态改由姿态传达；\n' +
  '- 主体锚定【必填】：提示词必须以"一位{N}岁女性"开头——年龄取角色卡设定；设定未写时按气质推断（御姐/成熟→30 岁上下，少女/童颜→二十出头），必须是成年人（18 岁以上），禁止任何未成年暗示；年龄锚定画面脸龄、性别锚定主体，两者都不可省略；\n' +
  '- 结构：主体锚定 + 容貌 + 身材 + 当前衣着 + 动作姿态 + 表情神态 + 场景环境；\n' +
  '- 容貌：优先摘取角色卡中的五官/脸型/发型/气质原文；禁止出现任何真实名人姓名——角色卡写"神似某明星"时，转化为对那种典型五官气质的描述（如鹅蛋脸、桃花眼、泪痣），只描述不点名；\n' +
  '- 身材与气质：优先使用角色卡原文的描述性体型词（高挑/娇小/丰满/纤细/曲线分明/长腿等）与气质定位词（御姐/童颜/少女感等）；设定未明确时才参考回复中状态栏的样貌/身材字段；【禁止罩杯与部位特写】身材只写整体轮廓词（如"高挑丰满、曲线分明"），禁止罩杯字母（A/B/C/D/E 杯等——实测同样撞审核），禁止对胸部/臀部等单一部位的形状、质感做细化描写（浑圆/饱满/水蜜桃状/蜜桃臀/挺拔/酥胸等）；\n' +
  '- 气质定位词必须与容貌描述一致，禁止矛盾（容貌是成熟妩媚路线就写御姐/成熟，禁止写童颜；反之亦然），禁止发明设定里没有的人设；\n' +
  '- 数字数据（身高 cm、三围数值、罩杯字母）一律不写——生图模型无法理解绝对尺寸，身高转化为相对体型描述（如 170cm→高挑，150cm→娇小），罩杯直接省略（胸部大小交给"丰满/纤细"等整体轮廓词表达）；\n' +
  '- 衣着：日常场景照剧情如实写；暧昧/亲密/私密场景【禁止写任何衣着】——在衣着该出现的位置原样输出占位标记【私密衣着】（强制衣着由系统事后机械填入，你写的任何衣着词都会与它冲突）；禁止透明/半透明等修饰词；\n' +
  '- 动作姿态【全篇只写一个】：只允许一个姿态描写，格式严格为"姿态动词+承载物"（趴在沙发上/侧卧在软榻上/跨坐在椅子边缘/倚在门框边）；剧情中有多个动作时只保留最有代表性的一个，其余全部丢弃；【禁止追加】第二个姿态、手部细节（"一只手…另一只手…"/拢着/撑着/拨弄）、腿部细节、"身体微微前倾/似靠在…借力"之类的补充描写；禁止部位细化——双腿张开/膝盖分开/臀部翘起/胸部压贴/腰胯扭动/撅起等着重描写一律禁止（这类部位细节是审核高危词，粗略姿态词才安全）；不要改成僵硬站姿；\n' +
  '图片是静止的，过程性动词（正在脱/开始哭/走过来/挥舞等）、对话内容、心理活动、时间顺序词（之后/刚才/趁机）一律不写——不可见的信息全部丢弃；' +
  '情绪只通过可见的表情神态表达（痛苦屈服类除外）；\n' +
  '- 内容安全【绝对红线】：性器官名称与三点描写（乳头、阴部等）绝对不能出现在提示词里，裸露场景一律用衣着/遮挡物/角度来表达；禁止露骨性行为的画面描写与词汇；整体身材轮廓词（高挑/丰满/童颜/巨乳等）不属于违规，可放心使用——但罩杯字母与部位的形状质感细化描写（浑圆/水蜜桃状等）属于违规；\n' +
  '- 风格与构图【禁止自写】：不要在提示词里写任何风格词（写实/摄影/photorealistic 等）与镜头构图词（视角/景别/横竖构图等）——风格后缀与镜头参数由系统统一机械拼接，自写会重复冲突。\n\n' +
  '【角色卡设定】\n{charDesc}';

// Grok 专用默认 compose system prompt（可在设置中自定义）
// 与严格版的差异：场景/衣着/表情/身材全面解放（Grok 审核宽松，实测非全裸即可过），
// 只保留"非全裸 + 无露骨行为 + 成年人"红线；人物铁律/肢体纯净/单姿态/静态画面等
// 出图质量规则与严格版一致（那些不是审核要求，是画质要求）
export const DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT = '你是生图提示词编写器。根据【角色卡设定】和【AI 最新回复】，为文生图模型编写一条中文画面描述。\n' +
  '要求：\n' +
  '- 只输出提示词本身，不要任何解释、引号或前后缀；\n' +
  '- 不超过 250 字；\n' +
  '- 画面人物【铁律】：永远只画 1 位女性角色（本轮互动中最重要的那位），第三人称视角；主控、男性、其他角色一律不入画；\n' +
  '- 肢体纯净【铁律】：画面中所有可见肢体必须属于她自己，禁止任何形式的第二人——虚构/模糊的人、身后的人、画外伸来的手、"被人抱着/搂着/托着/亲吻"等被动式描述一律禁止；剧情中的互动对象一律改为无道具的单人姿态（坐在人身上→跨坐在沙发扶手/床沿/椅子边缘；被人抱着→独自侧卧蜷缩、双臂环抱膝盖；被托着→倚靠台面/床头/墙边），禁止用抱枕/被子等道具遮挡身体；\n' +
  '- 剧情还原方式：用她的姿态、表情、衣着还原本轮剧情瞬间；亲密场景就画她独自一人的姿态神情（如趴在床头、侧卧、回头看镜头），禁止描绘双人互动；\n' +
  '- 姿态保真：剧情中的姿态如实还原（本服务商审核宽松，无需因审核改写承载物或场景），但禁止为了任何理由改成与原剧情无关的姿势；\n' +
  '- 场景环境【如实还原】：卧室/床/浴室/酒店/夜晚等私密场景均可直接描写，无需替换或回避；保留时代与题材背景（现代都市/古代宫廷/校园等）；\n' +
  '- 表情神态【不限】：按剧情自由描写，情动类（红晕/咬唇/迷离/娇羞/潮红/喘息）与痛苦类（哭泣/流泪/颤抖等）都允许——表情如实传达剧情情绪；\n' +
  '- 主体锚定【必填】：提示词必须以"一位{N}岁女性"开头——年龄取角色卡设定；设定未写时按气质推断（御姐/成熟→30 岁上下，少女/童颜→二十出头），必须是成年人（18 岁以上），禁止任何未成年暗示；年龄锚定画面脸龄、性别锚定主体，两者都不可省略；\n' +
  '- 结构：主体锚定 + 容貌 + 身材 + 当前衣着 + 动作姿态 + 表情神态 + 场景环境；\n' +
  '- 容貌：优先摘取角色卡中的五官/脸型/发型/气质原文；禁止出现任何真实名人姓名——角色卡写"神似某明星"时，转化为对那种典型五官气质的描述（如鹅蛋脸、桃花眼、泪痣），只描述不点名；\n' +
  '- 身材与气质：优先使用角色卡原文的体型词与形状词（高挑/娇小/丰满/纤细/曲线分明/浑圆/挺拔/蜜桃臀等均允许），罩杯字母允许直接写（如 D 罩杯）；气质定位词（御姐/童颜/少女感等）必须与容貌描述一致，禁止发明设定里没有的人设；\n' +
  '- 数字数据：身高 cm 转化为相对体型描述（如 170cm→高挑，150cm→娇小）——生图模型无法理解绝对尺寸；罩杯字母可直接写；\n' +
  '- 衣着：日常场景按剧情如实写；暧昧/激情/私密场景【禁止写任何衣着】——在衣着该出现的位置原样输出占位标记【私密衣着】（性感款式的强制衣着由系统事后机械填入，你写的任何衣着词都会与它冲突）；唯一红线【非全裸】适用于画面整体：除系统填入的衣着外，禁止再出现一丝不挂/全裸之类的描述；\n' +
  '- 动作姿态【全篇只写一个】：只允许一个姿态描写，格式为"姿态动词+承载物"（趴在沙发上/侧卧在床上/跨坐在椅子边缘）；剧情中有多个动作时只保留最有代表性的一个，其余全部丢弃；姿态的部位细节（双腿/臀部/腰胯）允许适度描写以还原剧情张力，但禁止露骨性行为的动作描写（交合/抽送等词汇一律禁止）；不要改成僵硬站姿；\n' +
  '图片是静止的，过程性动词（正在脱/开始哭/走过来/挥舞等）、对话内容、心理活动、时间顺序词（之后/刚才/趁机）一律不写——不可见的信息全部丢弃；' +
  '情绪只通过可见的表情神态表达；\n' +
  '- 内容安全【红线】：非全裸是底线——性器官名称与三点裸露画面（无遮挡的乳头/阴部）绝对不能出现在提示词里，亲密场景一律用衣着/遮挡物/角度表达；三点式内衣、丁字裤是衣着不是裸露，不属红线；禁止露骨性行为词汇；未成年暗示绝对禁止；\n' +
  '- 风格与构图【禁止自写】：不要在提示词里写任何风格词（写实/摄影/photorealistic 等）与镜头构图词（视角/景别/横竖构图等）——风格后缀与镜头参数由系统统一机械拼接，自写会重复冲突。\n\n' +
  '【角色卡设定】\n{charDesc}';

// 双人规则不只服务 Grok：严格版（Seedream/Gemini）同样有双人变体——
// 主控以背影/侧脸入镜不算违规（严格版其余审核装甲原样保留），由用户按平台实测选择。


/** 有档案用档案；无则 extract；失败返回空文本（拼词时用 FALLBACK_SUBJECT，不写档案） */
async function resolveAnchorText({ anchorName, anchors, replyContent, character, mergedApiConfig }) {
  const existing = (anchorName && anchors && anchors[anchorName]) ? anchors[anchorName] : '';
  if (existing) return { anchorText: existing, newAnchor: null };
  const newAnchor = await extractNewAnchor(anchorName, anchors, replyContent, character, mergedApiConfig);
  if (newAnchor) return { anchorText: newAnchor.anchor, newAnchor };
  return { anchorText: '', newAnchor: null };
}


// ---------- 严格版双人变体（Seedream/Gemini，主控入镜） ----------
// 与 Grok 双人版同构：只替换 人物/肢体/还原/姿态保真 四条 + 动作姿态一条，其余共享严格版原文。
// 【注意】修改严格版这五条的原文时必须同步修改下面的替换源，否则替换会静默失效。
const STRICT_SOLO_PERSON_RULES = '- 画面人物【铁律】：永远只画 1 位女性角色（本轮互动中最重要的那位），第三人称视角；主控、男性、其他角色一律不入画；\n' +
  '- 肢体纯净【铁律】：画面中所有可见肢体必须属于她自己，禁止任何形式的第二人——虚构/模糊的人、身后的人、画外伸来的手、"被人抱着/搂着/托着/亲吻"等被动式描述一律禁止；剧情中的互动对象一律用家具道具替代（坐在人身上→坐在沙发扶手/椅子边缘；被人抱着→抱着抱枕/蜷缩在被子里；被托着→倚靠台面/床头）；\n' +
  '- 剧情还原方式：用她的姿态、表情、衣着还原本轮剧情瞬间；亲密场景就画她独自一人的姿态神情（如趴在台面、回头、抱着抱枕），禁止描绘双人互动；\n' +
  '- 姿态保真【优先级高于场景】：安全改写只能替换承载物与场景，禁止改变她的身体造型——跨坐在人身上→跨坐在沙发扶手/矮柜边缘；躺在床上→侧卧在沙发/软榻上；被环抱→抱着抱枕；被压身下→仰躺抱着枕头；禁止为了安全顺手改成站立/端坐等与原剧情无关的姿势；\n';
const STRICT_DUO_PERSON_RULES = '- 画面人物【双人规则】：画面主角永远是本轮互动中最重要的那 1 位女性角色，第三人称视角；本轮剧情存在主控与她的直接互动（肢体接触/亲密行为/同框互动）时，主控作为第二人入镜、双人互动如实描绘；剧情是她独处或主控未参与时仍画她单人。除主控外禁止任何第三人（路人/围观者/虚构模糊的人）入镜；\n' +
  '- 主控形象【锚定】：主控统一写"一名成年男性"——角色卡有主控外貌设定时按设定补充（体型/发型），未设定时不发明细节；主控以背影/侧脸/肩颈以下/局部肢体入镜，正脸不对镜头（画面焦点永远是她）；主控衣着穿戴整齐（衬衫/T恤/长裤等日常服装）；两人必须都是成年人，禁止任何未成年暗示；\n' +
  '- 肢体归属【铁律】：双人画面必须写清每条肢体的主人（"他的手揽住她的腰""她跨坐在他腿上"），禁止省略主语导致两人肢体融合；两人是分明独立的个体；\n' +
  '- 剧情还原方式：用两人的组合姿态、她的表情、衣着还原本轮剧情瞬间；互动场景如实描绘双人互动（拥抱/搂抱/牵手/依偎等含蓄互动可直接描写），禁止把互动改写成她抱枕头/独自蜷缩之类的单人替代姿态；\n';
const STRICT_SOLO_POSE_RULE = '- 动作姿态【全篇只写一个】：只允许一个姿态描写，格式严格为"姿态动词+承载物"（趴在沙发上/侧卧在软榻上/跨坐在椅子边缘/倚在门框边）；剧情中有多个动作时只保留最有代表性的一个，其余全部丢弃；【禁止追加】第二个姿态、手部细节（"一只手…另一只手…"/拢着/撑着/拨弄）、腿部细节、"身体微微前倾/似靠在…借力"之类的补充描写；禁止部位细化——双腿张开/膝盖分开/臀部翘起/胸部压贴/腰胯扭动/撅起等着重描写一律禁止（这类部位细节是审核高危词，粗略姿态词才安全）；不要改成僵硬站姿；\n';
const STRICT_DUO_POSE_RULE = '- 动作姿态【全篇只写一个组合】：只允许一个组合姿态描写——单人写"姿态动词+承载物"（趴在沙发上/侧卧在软榻上）；双人写一个互动组合（"她跨坐在他腿上，他的手揽着她的腰"算一个组合）；剧情中有多个动作时只保留最有代表性的一个，其余全部丢弃；【禁止追加】第二个姿态、手部细节（"一只手…另一只手…"/拢着/撑着/拨弄）、腿部细节；禁止部位细化——双腿张开/膝盖分开/臀部翘起/胸部压贴/腰胯扭动/撅起等着重描写一律禁止（这类部位细节是审核高危词，粗略姿态词才安全）；不要改成僵硬站姿；\n';

// 严格版双人默认 compose system prompt（主控可入镜，可在设置中自定义；与严格单人版相互独立存储）
export const DEFAULT_STRICT_DUO_COMPOSE_SYSTEM_PROMPT = DEFAULT_COMPOSE_SYSTEM_PROMPT
  .replace(STRICT_SOLO_PERSON_RULES, STRICT_DUO_PERSON_RULES)
  .replace(STRICT_SOLO_POSE_RULE, STRICT_DUO_POSE_RULE);

// ---------- Grok 双人版（主控入镜） ----------
// 在单人版基础上只替换两组规则：人物/肢体/还原三条 + 动作姿态一条，其余共享单人版原文。
// 【注意】修改单人版这四条的原文时必须同步修改下面的替换源，否则替换会静默失效。
const GROK_SOLO_PERSON_RULES = '- 画面人物【铁律】：永远只画 1 位女性角色（本轮互动中最重要的那位），第三人称视角；主控、男性、其他角色一律不入画；\n' +
  '- 肢体纯净【铁律】：画面中所有可见肢体必须属于她自己，禁止任何形式的第二人——虚构/模糊的人、身后的人、画外伸来的手、"被人抱着/搂着/托着/亲吻"等被动式描述一律禁止；剧情中的互动对象一律改为无道具的单人姿态（坐在人身上→跨坐在沙发扶手/床沿/椅子边缘；被人抱着→独自侧卧蜷缩、双臂环抱膝盖；被托着→倚靠台面/床头/墙边），禁止用抱枕/被子等道具遮挡身体；\n' +
  '- 剧情还原方式：用她的姿态、表情、衣着还原本轮剧情瞬间；亲密场景就画她独自一人的姿态神情（如趴在床头、侧卧、回头看镜头），禁止描绘双人互动；\n';
const GROK_DUO_PERSON_RULES = '- 画面人物【双人规则】：画面主角永远是本轮互动中最重要的那 1 位女性角色，第三人称视角；本轮剧情存在主控与她的直接互动（肢体接触/亲密行为/同框互动）时，主控作为第二人入镜、双人互动如实描绘；剧情是她独处或主控未参与时仍画她单人。除主控外禁止任何第三人（路人/围观者/虚构模糊的人）入镜；\n' +
  '- 主控形象【锚定】：主控统一写"一名成年男性"——角色卡有主控外貌设定时按设定补充（体型/发型/衣着），未设定时不发明细节；主控以背影/侧脸/肩颈以下/局部肢体入镜，正脸不对镜头（画面焦点永远是她）；两人必须都是成年人，禁止任何未成年暗示；\n' +
  '- 肢体归属【铁律】：双人画面必须写清每条肢体的主人（"他的手揽住她的腰""她跨坐在他腿上"），禁止省略主语导致两人肢体融合；两人是分明独立的个体；\n' +
  '- 剧情还原方式：用两人的组合姿态、她的表情、衣着还原本轮剧情瞬间；亲密场景如实描绘双人互动（拥抱/搂抱/亲吻/跨坐等均可直接描写），禁止把互动改写成她抱枕头/独自蜷缩之类的单人替代姿态；\n';
const GROK_SOLO_POSE_RULE = '- 动作姿态【全篇只写一个】：只允许一个姿态描写，格式为"姿态动词+承载物"（趴在沙发上/侧卧在床上/跨坐在椅子边缘）；剧情中有多个动作时只保留最有代表性的一个，其余全部丢弃；姿态的部位细节（双腿/臀部/腰胯）允许适度描写以还原剧情张力，但禁止露骨性行为的动作描写（交合/抽送等词汇一律禁止）；不要改成僵硬站姿；\n';
const GROK_DUO_POSE_RULE = '- 动作姿态【全篇只写一个组合】：只允许一个组合姿态描写——单人写"姿态动词+承载物"（趴在沙发上/侧卧在床上）；双人写一个互动组合（"她跨坐在他腿上，他的手揽着她的腰"算一个组合）；剧情中有多个动作时只保留最有代表性的一个，其余全部丢弃；禁止在此之外追加第二个姿态或更多部位细化（双腿张开/臀部翘起等露骨分解仍禁）；禁止露骨性行为的动作描写（交合/抽送等词汇一律禁止）；不要改成僵硬站姿；\n';

// Grok 双人版默认 compose system prompt（主控可入镜，可在设置中自定义；与单人版相互独立存储）
export const DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT = DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT
  .replace(GROK_SOLO_PERSON_RULES, GROK_DUO_PERSON_RULES)
  .replace(GROK_SOLO_POSE_RULE, GROK_DUO_POSE_RULE);

// 第一步：根据角色卡 + 本轮回复，总结出生图提示词
// suppressAppearance：该角色已登记锚点时为 true——禁止副 AI 写容貌/身材（锚点事后由 App 机械拼接）
async function composeIllustrationPrompt(replyContent, character, apiConfig, suppressAppearance) {
  // 卡内全部角色模块（给任何角色生图时设定都在场；背景模块与生图外貌无关，不带入以免挤占截断配额）
  const charDesc = getCharacterModules(character).join('\n\n').slice(0, 4000);
  // 允许用户在设置中自定义 compose system prompt；未设置时按服务商（与人物模式）用对应内置默认
  const defaultPrompt = apiConfig.imageProvider === 'grok'
    ? (apiConfig.duoMode ? DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT : DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT)
    : (apiConfig.duoMode ? DEFAULT_STRICT_DUO_COMPOSE_SYSTEM_PROMPT : DEFAULT_COMPOSE_SYSTEM_PROMPT);
  const basePrompt = (apiConfig.composePrompt || defaultPrompt)
    .replace('{charDesc}', charDesc);
  const system = basePrompt.includes('【AI 最新回复】')
    ? basePrompt
    : basePrompt + '\n\n【AI 最新回复】\n{replyContent}';
  const finalSystem = system.replace('{replyContent}', (replyContent || '').slice(0, 6000));
  // 外貌身材锚点【硬拼接模式】：有锚点时禁止副 AI 写任何容貌/身材——它誊写必然会二次加工
  // （按红线删改/自行精简），改为生成后由 App 把锚点原文机械拼到提示词最前面，一字不丢
  const anchorBlock = suppressAppearance
    ? '\n\n【外貌身材锚点·拼接模式】\n本次提示词【绝对禁止】写任何容貌/身材/年龄描写——脸型、五官、发型发色、眼色、年龄、身高体型、胸/腰/臀/腿、肤质、痣/饰品等辨识特征一律不写，也不得以"一位{N}岁女性"之类的主体锚定开头：她的完整主体描述（含年龄性别）会由系统在事后机械拼接到最前面，你写的任何相关词都是重复的。\n' +
      '直接从当前衣着开始写，结构：衣着 + 动作姿态 + 表情神态 + 场景环境。'
    : '';
  const result = await sendChat([
    { role: 'system', content: finalSystem + anchorBlock },
    { role: 'user', content: '【AI 最新回复】\n' + (replyContent || '').slice(0, 6000) }
  ], { api: resolveMemoryApi(apiConfig), usageContext: { characterId: character.id, characterName: character.name, kind: 'chat' } });
  return (result || '').trim().replace(/^["'「『]+|["'」』]+$/g, '');
}

// 第二步：内容安全改写。errorMsg 为空=事前预审；带错误信息=被判违规后的针对性改写
async function sanitizeIllustrationPrompt(prompt, errorMsg, character, apiConfig) {
  let system;
  if (errorMsg) {
    system = '你是内容安全改写器。下面这条 AI 生图提示词被生图平台的内容审核拒绝（错误信息：' + errorMsg.slice(0, 300) + '）。\n' +
      '请针对性改写：找出最可能触发审核的表达（通常是裸露画面、性暗示动作、真实名人姓名、第二人存在的暗示）并替换或删除，动作如仍有风险则调整为更中性的近似姿势。\n' +
      '年龄与性别锚定、人物容貌、整体体型词不算违规，必须原样保留；场景信息尽量保留。\n' +
      '只输出最终提示词本身，不要任何解释。';
  } else if (apiConfig.duoMode && apiConfig.imageProvider === 'grok') {
    // Grok 双人版轻量预审：主控允许入镜，只拦非全裸红线/露骨行为/第三人
    system = '你是内容安全改写器。下面是一条 AI 生图提示词，即将发给生图平台（该平台审核宽松，非全裸即可过审）。\n' +
      '只需检查并改写这几类问题：性器官名称与三点裸露描写（乳头、阴部等，绝对不能出现，用衣着/拍摄角度表达）、全裸画面（必须保留衣着或遮挡物）、露骨性行为词汇（交合/抽送等，改为亲密姿态的含蓄表达）、真实名人姓名（替换为五官气质描述）、任何形式的第三人（路人/围观者/虚构模糊的人——画面最多她与主控两人，第三人一律删除）、主控正脸对镜头（改为背影/侧脸/肩颈以下入镜）、双人描写肢体主语缺失（补全肢体归属，如"他的手…"，防止肢体融合）。\n' +
      '以下都不算违规，不要删改：她与主控的双人互动（拥抱/搂抱/亲吻/跨坐等）、主控背影或侧脸入镜、性感衣着（三点式蕾丝内衣/丁字裤/吊带袜/性感睡衣/领口敞开等——三点式内衣是衣着不是裸露）、情动与痛苦表情（红晕/咬唇/哭泣/流泪等）、身材形状词与罩杯字母、私密场景（卧室/床/浴室等）。\n' +
      '如果没有上述问题，原样输出。只输出最终提示词本身，不要任何解释。';
  } else if (apiConfig.duoMode) {
    // 严格版双人预审：主控允许以背影/侧脸入镜，其余审核规则与严格单人版一致
    system = '你是内容安全改写器。下面是一条 AI 生图提示词，即将发给有生图审核的平台。\n' +
      '只需检查并改写这几类问题：性器官名称与三点描写（乳头、阴部等，绝对不能出现，用衣着/遮挡/角度表达）、裸露画面描写、露骨性行为词汇、真实名人姓名（替换为五官气质描述）、任何形式的第三人（路人/围观者/虚构模糊的人——画面最多她与主控两人，第三人一律删除）、主控正脸对镜头（改为背影/侧脸/肩颈以下入镜）、主控未穿衣（主控必须穿戴整齐）、双人描写肢体主语缺失（补全肢体归属，如"他的手…"，防止肢体融合）、痛苦屈服类词汇（泪流满面/哭泣/臣服/屈辱/挣扎/求饶等——审核判定为胁迫信号，表情改为中性安全词）、姿态部位细化（双腿张开/臀部翘起/撅起等着重描写——改为粗略姿态）、部位形状特写（胸部/臀部的形状质感描写如浑圆/水蜜桃状/饱满等——删除，只保留整体轮廓词，罩杯字母也一并删除）。\n' +
      '以下都不算违规，不要删改：她与主控的含蓄双人互动（拥抱/搂抱/牵手/依偎/跨坐等）、主控背影或侧脸入镜、她的身材体型词（童颜/巨乳等）、动作姿态（趴/躺/抱等，不要改成站姿）。\n' +
      '如果没有上述问题，原样输出。只输出最终提示词本身，不要任何解释。';
  } else if (apiConfig.imageProvider === 'grok') {
    // Grok 轻量预审：只拦非全裸红线与露骨行为，表情/姿态/身材词全部放行
    system = '你是内容安全改写器。下面是一条 AI 生图提示词，即将发给生图平台（该平台审核宽松，非全裸即可过审）。\n' +
      '只需检查并改写这几类问题：性器官名称与三点裸露描写（乳头、阴部等，绝对不能出现，用衣着/拍摄角度表达）、全裸画面（必须保留衣着或遮挡物）、露骨性行为词汇（交合/抽送等，改为亲密姿态的含蓄表达）、真实名人姓名（替换为五官气质描述）、任何形式的第二人（虚构/模糊的人、身后的人、画外伸来的手、被动拥抱/被托举等——改为她的无道具单人姿态，如侧卧蜷缩/双臂环抱膝盖/倚靠床头，禁止用抱枕/被子等道具遮挡身体）。\n' +
      '以下都不算违规，不要删改：性感衣着（三点式蕾丝内衣/丁字裤/吊带袜/性感睡衣/领口敞开等——三点式内衣是衣着不是裸露）、情动与痛苦表情（红晕/咬唇/哭泣/流泪等）、姿态与部位细节（趴/躺/双腿/臀部等）、身材形状词与罩杯字母、私密场景（卧室/床/浴室等）。\n' +
      '如果没有上述问题，原样输出。只输出最终提示词本身，不要任何解释。';
  } else {
    system = '你是内容安全改写器。下面是一条 AI 生图提示词，即将发给有生图审核的平台。\n' +
      '只需检查并改写这几类问题：性器官名称与三点描写（乳头、阴部等，绝对不能出现，用衣着/遮挡/角度表达）、裸露画面描写、性暗示词汇、真实名人姓名（替换为五官气质描述）、任何形式的第二人（虚构/模糊的人、身后的人、画外伸来的手、被动拥抱/被托举等——改为她单人姿态或用抱枕/沙发等道具替代）、痛苦屈服类词汇（泪流满面/哭泣/臣服/屈辱/挣扎/求饶等——审核判定为胁迫信号，表情改为中性安全词）、姿态部位细化（双腿张开/臀部翘起/撅起等着重描写——改为粗略姿态，如"趴在沙发上"）、部位形状特写（胸部/臀部的形状质感描写如浑圆/水蜜桃状/饱满等——删除，只保留整体轮廓词，罩杯字母也一并删除）。\n' +
      '身材体型词（童颜/巨乳等）不算违规，不要删改；动作姿态（趴/躺/抱等）不算违规，不要改成站姿。\n' +
      '如果没有上述问题，原样输出。只输出最终提示词本身，不要任何解释。';
  }
  // 【私密衣着】是 App 层占位标记（强制衣着事后机械填入），清洗时容易当乱码洗掉——所有分支统一叮嘱保留
  system += '\n另外：【私密衣着】是系统占位标记（不是乱码、不是违规内容），出现时必须原样保留，禁止删除、改写或翻译。';
  const result = await sendChat([
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ], { api: resolveMemoryApi(apiConfig), usageContext: { characterId: character.id, characterName: character.name, kind: 'chat' } });
  const cleaned = (result || '').trim().replace(/^["'「『]+|["'」』]+$/g, '');
  return cleaned || prompt; // 改写失败（空返回）时退回原词
}

// 按当前服务商返回生成函数：seedream/grok/gemini 共用同一条提示词流水线，只换最后一步调用
function resolveImageGenerator(config) {
  const imgCfg = config.image || {};
  if (imgCfg.provider === 'gemini') {
    const gm = imgCfg.gemini || {};
    return (prompt) => generateGeminiImage({ ...gm, prompt });
  }
  if (imgCfg.provider === 'openai') {
    const oa = imgCfg.openai || {};
    return (prompt) => generateOpenAIImage({ ...oa, prompt });
  }
  if (imgCfg.provider === 'grok') {
    const gk = imgCfg.grok || {};
    return (prompt) => generateGrokImage({ ...gk, prompt });
  }
  if (imgCfg.provider === 'grokweb') {
    const gw = imgCfg.grokweb || {};
    return (prompt, images) => generateGrokWebImage({ ...gw, prompt, images });
  }
  if (imgCfg.provider === 'wanx') {
    const wx = imgCfg.wanx || {};
    return (prompt) => generateWanxImage({ ...wx, prompt });
  }
  const sd = imgCfg.seedream || {};
  return (prompt) => generateSeedreamImage({ ...sd, prompt });
}

// 提示词管线配置：manual（手动网页版）与 grokweb（网页反代）沿用 Grok 宽松管线（网页版审核由用户自己把握，宽松版最自由）
// 严格版（seedream/gemini）不再走 compose，duoMode 强制 false；衣着库见 resolveStrictOutfitLibrary
function buildPromptPipelineConfig(config) {
  const imgCfg = config.image || {};
  const rawProvider = imgCfg.provider || 'pollinations';
  const provider = (rawProvider === 'manual' || rawProvider === 'grokweb') ? 'grok' : rawProvider;
  const apiConfig = config.api || {};
  const sdCfg = imgCfg.seedream || {};
  const gkCfg = imgCfg.grok || {};
  const strict = isStrictMechanicalProvider(provider);
  // 双人模式仅 Grok（及 manual→grok）有效；严格版永久单人，忽略 personMode=duo
  const duoMode = !strict && (imgCfg.personMode || gkCfg.personMode) === 'duo';
  // compose 仅 Grok 管线使用（严格版不读）
  const customCompose = provider === 'grok'
    ? (duoMode ? gkCfg.composePromptDuo : gkCfg.composePrompt)
    : '';
  // 严格版：永远用 seedream.outfitLibrary；Grok/手动：私密标记替换用 grok.outfitLibrary
  const outfitLibrary = strict
    ? resolveStrictOutfitLibrary(sdCfg)
    : resolveGrokOutfitLibrary(gkCfg);
  const mergedApiConfig = {
    ...apiConfig,
    imageProvider: provider,
    duoMode,
    composePrompt: customCompose || apiConfig.composePrompt || '',
    outfitLibrary
  };
  return { provider, mergedApiConfig };
}

// 镜头控制（手动覆盖）：朝向 × 高度 × 景别 × 画幅 四维选择，'auto' 不追加（画幅必选，无自动）。
// 朝向不用"前方/后方"这类空间方向词（AI 会当成场景纵深），直接以她为主体描述与镜头的关系；
// 高度/景别/画幅也都是带谓语的短句而不是名词堆砌——Grok Imagine 对自然语言的响应远好于 tag 式拼贴。
// 朝向词（head）拼在锚点之后、场景描述之前，避免场景描写干扰朝向判断；
// 高度/景别/画幅（tail）合成一句追加在场景段之后。全程机械拼接不经过副 AI
const SHOT_WORDS = { closeup: '特写取景', half: '半身取景', full: '全身取景' };
const ORIENT_WORDS = { front: '她面向镜头', sideL: '她左侧面对镜头', sideR: '她右侧面对镜头', back: '她背对镜头' };
const ELEV_WORDS = { level: '镜头与人物平视', top: '镜头从高处俯视', low: '镜头从低处仰视' };
const ASPECT_WORDS = { landscape: '横向构图', portrait: '竖向构图' };
export function shotWordsOf(shot, orient, elev, aspect) {
  const head = ORIENT_WORDS[orient] || '';
  const tail = [ELEV_WORDS[elev], SHOT_WORDS[shot], ASPECT_WORDS[aspect]].filter(Boolean).join('，');
  return { head, tail };
}

// 新面孔首次登记：有名字且档案里没有时，从设定/状态栏提取她的外貌身材锚点（失败静默，不阻塞出图）
async function extractNewAnchor(anchorName, anchors, replyContent, character, mergedApiConfig) {
  if (!anchorName || (anchors && anchors[anchorName])) return null;
  try {
    const anchor = await extractNamedAppearanceAnchor({
      name: anchorName, replyContent, character, apiConfig: mergedApiConfig
    });
    return { name: anchorName, anchor };
  } catch (e) {
    return null;
  }
}

// 锚点机械拼接：锚点原文（含"一位N岁女性"主体锚定，画面年龄以锚点为准——剧情年龄不影响出图）
// 整体置于提示词最前，结尾句号/换行改逗号衔接 compose 输出的 衣着/姿态/场景 段。
// compose 在拼接模式下被禁写主体锚定，但偶尔还是照写（默认提示词里"主体锚定【必填】"是正文规则，
// 约束力比追加指令强）——这里机械剥掉，避免与锚点自带的开头重复。
// orientWords（"她背对镜头"等朝向词）紧跟锚点/主体锚定之后、场景描述之前，位置靠前不被场景描写稀释
function spliceAnchor(anchorText, prompt, orientWords) {
  const head = (anchorText || '').trim().replace(/[。\.\s]+$/g, '');
  const orient = (orientWords || '').trim();
  const body = (prompt || '').trim();
  if (!head) {
    if (!orient) return body;
    // 无锚点：插在 compose 自写的"一位N岁女性"主体锚定之后；没有就放最前
    const m = body.match(/^(一位|一名)\s*[^，。,]{0,12}?(女性|女人|男性|男人)\s*[，,、]?\s*/);
    if (!m) return orient + '，' + body;
    const opening = m[0].replace(/[，,、\s]+$/g, '');
    return opening + '，' + orient + '，' + body.slice(m[0].length);
  }
  const stripped = body
    .replace(/^(一位|一名)\s*[^，。,]{0,12}?(女性|女人|男性|男人)\s*[，,、]?\s*/, '');
  return head + '，' + (orient ? orient + '，' : '') + stripped;
}

/**
 * 严格版机械管线：先解析/提取锚点 → 模板库随机一行（同轮锁定）→ 拼接 → 硬过滤。
 * 不 compose、不 sanitize、不写表情场景。
 */
async function prepareStrictMechanicalPrompt({ replyContent, character, config, anchorName, anchors, shotWords, provider, mergedApiConfig }) {
  const { anchorText, newAnchor } = await resolveAnchorText({
    anchorName, anchors, replyContent, character, mergedApiConfig
  });
  const library = mergedApiConfig.outfitLibrary || resolveStrictOutfitLibrary((config.image || {}).seedream);
  const filledOutfit = fillOutfitTemplate(pickRandomOutfitLine(library, DEFAULT_STRICT_OUTFIT_LIBRARY));
  const body = buildStrictBodyPrompt({ anchorText, outfitFilled: filledOutfit, shotWords, l2: false });
  return {
    prompt: hardFilterPrompt(body, provider) + STYLE_SUFFIX,
    newAnchor,
    // 供 generate 重试用（prepare 本身不重试）
    _strictMeta: { anchorText, filledOutfit }
  };
}

async function generateStrictMechanicalIllustration({ replyContent, character, config, anchorName, anchors, shotWords, provider, mergedApiConfig, generate }) {
  const { anchorText, newAnchor } = await resolveAnchorText({
    anchorName, anchors, replyContent, character, mergedApiConfig
  });
  const library = mergedApiConfig.outfitLibrary || resolveStrictOutfitLibrary((config.image || {}).seedream);
  // 同轮重试锁定同一行 + 同一颜色；仅末次 L2 换家居服
  const filledOutfit = fillOutfitTemplate(pickRandomOutfitLine(library, DEFAULT_STRICT_OUTFIT_LIBRARY));

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const l2 = attempt === 2;
    const attemptPrompt = buildStrictBodyPrompt({
      anchorText,
      outfitFilled: filledOutfit,
      shotWords,
      l2
    });
    try {
      const safePrompt = hardFilterPrompt(attemptPrompt, provider);
      const finalPrompt = safePrompt + STYLE_SUFFIX;
      const dataUrl = await generate(finalPrompt);
      return { dataUrl, prompt: finalPrompt, newAnchor };
    } catch (e) {
      lastErr = e;
      if (!isModerationError(e) || attempt === 2) {
        e.imagePrompt = hardFilterPrompt(attemptPrompt, provider);
        throw e;
      }
      // attempt 0/1：同装同色再请求一次；attempt 2：L2
    }
  }
  throw lastErr;
}

/**
 * 手动网页版 / 提示词预览：跑提示词管线，不调生图 API。
 * 严格版 = 机械拼接；Grok = compose → sanitize → 锚点拼接。
 * anchorName = 插图标记 alt 里的角色名；anchors = 对话的外貌身材锚点档案 {角色名: 描述}
 * @returns {Promise<{prompt: string, newAnchor: ?{name: string, anchor: string}}>}
 */
export async function prepareIllustrationPrompt({ replyContent, character, config, anchorName, anchors, shotWords }) {
  const { provider, mergedApiConfig } = buildPromptPipelineConfig(config);

  if (isStrictMechanicalProvider(provider)) {
    const result = await prepareStrictMechanicalPrompt({
      replyContent, character, config, anchorName, anchors, shotWords, provider, mergedApiConfig
    });
    return { prompt: result.prompt, newAnchor: result.newAnchor };
  }

  // Grok / 手动管线
  const anchorText = (anchorName && anchors) ? anchors[anchorName] : '';
  let prompt = await composeIllustrationPrompt(replyContent, character, mergedApiConfig, !!anchorText);
  prompt = await sanitizeIllustrationPrompt(prompt, null, character, mergedApiConfig);
  const newAnchor = await extractNewAnchor(anchorName, anchors, replyContent, character, mergedApiConfig);
  // 锚点硬拼接：在机械过滤之前拼上；朝向词紧跟锚点之后
  let spliced = spliceAnchor(anchorText, prompt, shotWords && shotWords.head);
  if (shotWords && shotWords.tail) spliced += '，' + shotWords.tail;
  // 私密衣着：从库随机一行再抽色替换
  const grokLib = mergedApiConfig.outfitLibrary || resolveGrokOutfitLibrary((config.image || {}).grok);
  const filledOutfit = fillOutfitTemplate(pickRandomOutfitLine(grokLib, DEFAULT_GROK_OUTFIT_LIBRARY));
  spliced = replaceOutfitMarker(spliced, filledOutfit);
  return { prompt: hardFilterPrompt(spliced, provider) + STYLE_SUFFIX, newAnchor };
}

/**
 * 完整插图生成流程。
 * 严格版：锚点 + 衣着模板库 → 生成（同装重试 / L2 家居服）
 * Grok：compose → sanitize → 生成 → L1 改写 / L2 降级
 * @returns {Promise<{dataUrl: string, prompt: string, newAnchor: ?{name: string, anchor: string}}>}
 */
export async function generateIllustrationForReply({ replyContent, character, config, anchorName, anchors, shotWords }) {
  const { provider, mergedApiConfig } = buildPromptPipelineConfig(config);
  const generate = resolveImageGenerator(config);

  if (isStrictMechanicalProvider(provider)) {
    return generateStrictMechanicalIllustration({
      replyContent, character, config, anchorName, anchors, shotWords,
      provider, mergedApiConfig, generate
    });
  }

  // ---------- Grok 管线（compose + 私密衣着库随机一行） ----------
  const anchorText = (anchorName && anchors) ? anchorTextOf(anchors[anchorName]) : '';
  // grokweb 参考图：锚点带图则出图带上（画谁用谁的脸）；文字锚点继续管身材/场景
  const refImages = await resolveAnchorRefImages(anchors, anchorName, config);
  let prompt = await composeIllustrationPrompt(replyContent, character, mergedApiConfig, !!anchorText);
  prompt = await sanitizeIllustrationPrompt(prompt, null, character, mergedApiConfig);
  const newAnchor = await extractNewAnchor(anchorName, anchors, replyContent, character, mergedApiConfig);
  // 衣着库随机一行 + 颜色：循环外锁定，同张图重试同装同色
  const grokLib = mergedApiConfig.outfitLibrary || resolveGrokOutfitLibrary((config.image || {}).grok);
  const filledOutfit = fillOutfitTemplate(pickRandomOutfitLine(grokLib, DEFAULT_GROK_OUTFIT_LIBRARY));

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const bodyPrompt = attempt === 2 ? degradeToPortraitPrompt(prompt) : prompt;
    let attemptPrompt = spliceAnchor(anchorText, bodyPrompt, shotWords && shotWords.head);
    if (shotWords && shotWords.tail) attemptPrompt += '，' + shotWords.tail;
    attemptPrompt = replaceOutfitMarker(attemptPrompt, filledOutfit);
    try {
      const safePrompt = hardFilterPrompt(attemptPrompt, provider);
      const finalPrompt = safePrompt + STYLE_SUFFIX;
      const dataUrl = await generate(finalPrompt, refImages);
      return { dataUrl, prompt: finalPrompt, newAnchor };
    } catch (e) {
      lastErr = e;
      if (!isModerationError(e) || attempt === 2) {
        e.imagePrompt = hardFilterPrompt(attemptPrompt, provider);
        throw e;
      }
      if (attempt === 0) {
        prompt = await sanitizeIllustrationPrompt(prompt, e.message, character, mergedApiConfig);
      }
    }
  }
  throw lastErr;
}

/**
 * 用户手动改词后的直接生成：不经过副 API 总结/清洗，只过 App 层硬性禁词过滤 + 追加风格后缀。
 * 若仍被审核拒绝，错误上会挂 imagePrompt（过滤后的词），方便再次编辑。
 * refImages：可选，锚点参考图（grokweb 通道，调用方用 resolveAnchorRefImages 解析）
 */
export async function generateIllustrationFromPrompt({ prompt, config, refImages = null }) {
  const generate = resolveImageGenerator(config);
  const rawProvider = (config.image && config.image.provider) || 'pollinations';
  const provider = rawProvider === 'manual' ? 'grok' : rawProvider;
  // 提示词里可能残留【私密衣着】标记，手动改词路径同样从对应衣着库随机一行替换
  const imgCfg = config.image || {};
  const library = provider === 'grok'
    ? resolveGrokOutfitLibrary(imgCfg.grok || {})
    : resolveStrictOutfitLibrary(imgCfg.seedream || {});
  const fallback = provider === 'grok' ? DEFAULT_GROK_OUTFIT_LIBRARY : DEFAULT_STRICT_OUTFIT_LIBRARY;
  const template = pickRandomOutfitLine(library, fallback);
  const clean = hardFilterPrompt(applyForcedOutfit(prompt, template), provider);
  if (!clean) throw new Error('提示词为空');
  const finalPrompt = clean + STYLE_SUFFIX;
  try {
    const dataUrl = await generate(finalPrompt, refImages);
    return { dataUrl, prompt: finalPrompt };
  } catch (e) {
    e.imagePrompt = clean;
    throw e;
  }
}
