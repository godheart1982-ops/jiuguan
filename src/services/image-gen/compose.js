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
  DEFAULT_GROK_OUTFIT_LIBRARY, resolveGrokOutfitLibrary,
  fillOutfitTemplate, replaceOutfitMarker, applyForcedOutfit, pickRandomOutfitLine
} from './outfit-library.js';

const GROK_STYLE_SUFFIX = '，strictly photorealistic real photograph, natural skin texture with visible pores and subtle imperfections, unretouched, zero anime influence';
export const STRICT_CINEMATIC_STYLE_SUFFIX = '，cinematic live-action film still, 35mm film photography, natural dramatic lighting, shallow depth of field, authentic natural skin texture with subtle imperfections, rich filmic color grading, candid movie frame, zero anime or CGI look';

function styleSuffixFor(provider) {
  return isStrictMechanicalProvider(provider) ? STRICT_CINEMATIC_STYLE_SUFFIX : GROK_STYLE_SUFFIX;
}

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
  [/罩杯|[A-Fa-f]\s?杯/g, ''],
  // OpenAI / Gemini 易误杀老锚点词的温和转译
  [/童颜|幼态|萝莉/g, '面容清秀显年轻'],
  [/巨乳|豪乳|丰胸/g, '身材丰满']
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
export function hardFilterPrompt(prompt, provider) {
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
  return out + '，单人半身肖像，穿着得体日常衣着，神态自然柔和，简洁柔和自然光的室内背景';
}

// 严格版默认 compose system prompt（Seedream / 万相 / Gemini / OpenAI 共用，真人电影剧照风）
export const DEFAULT_COMPOSE_SYSTEM_PROMPT = '你是真人电影剧照的生图提示词编写器。根据【角色卡设定】和【AI 最新回复】，为审核严格的文生图模型编写一段 180～260 字的中文电影画面描述。\n' +
  '【输出要求】\n' +
  '- 只输出画面描述本身，连贯自然成段，不要编号、不要标签、不要解释、不要引号；\n' +
  '- 画面是静止的一帧电影定格：过程性动词（正在走来/开始脱/挥舞）、对话内容、心理活动、时间顺序词（随后/刚才）一律不写，只写镜头里看得见的画面；\n' +
  '- 画面结构按顺序自然展开：主体与外貌 → 当前发型与配饰 → 当前衣着 → 自然动作姿态 → 表情神态 → 环境场景与道具细节 → 光线色彩与空气氛围。\n' +
  '【人物与单人铁律】\n' +
  '- 主体锚定：以「一位{N}岁女性」开头（年龄取角色卡设定，未写则按气质推断为 20～35 岁成年人，严禁任何未成年或幼态/童颜暗示）；\n' +
  '- 永远只画本轮剧情中最重要的 1 位女性角色，第三人称视角；主控、男性、路人、模糊背景人影、画外伸来的手一律不入画；\n' +
  '- 禁止被动互动描述（被人抱着/搂着/托着/亲吻/坐在人身上）；若剧情存在互动，转化为她单人的自然反应姿态与环境承载物（如倚在窗台、轻靠桌沿、坐在沙发一角回眸、指尖轻搭栏杆或茶杯），画面所有可见肢体必须属于她自己。\n' +
  '【外貌与身材安全边界】\n' +
  '- 容貌优先取材角色卡的五官、脸型与气质（发型与配饰可随剧情与时代动态变化）；严禁真实明星姓名（涉及“神似某明星”时改为具体五官气质描述）；\n' +
  '- 身材只写自然优雅的整体轮廓（高挑/纤细/匀称/身材曼妙/曲线柔和），不写具体厘米数、罩杯字母，不写胸/臀等单一部位形状特写。\n' +
  '【发型、配饰与衣着规则（贴合剧情与时代）】\n' +
  '- 发型与配饰：结合本轮剧情、时代背景与当前场合具体描写她的发型（如现代披肩直发、微卷长发、低马尾、松散丸子头，或古风半挽发髻、垂坠青丝等）与恰当配饰（如耳钉、细项链、手表、发卡、围巾，或古风玉簪、耳坠等）；剧情未写明时顺时代与场景自然搭配；\n' +
  '- 日常或剧情有明确着装描写时，按剧情与角色卡设定如实描写，确保材质、剪裁与所处时代、天气一致；\n' +
  '- 若本轮剧情处于裸露、内衣或过于暴露的亲密桥段，【禁止描写裸露/内衣/透视/低胸敞开】，改为顺着当前时代与场景自然配一套得体且有质感的遮挡衣着（例如：现代室内→宽松纯棉衬衫/针织开衫/垂坠感长款睡袍；古风→素色交领中衣/轻纱外袍；户外→风衣/大衣），不跳戏。\n' +
  '【姿态与表情神态】\n' +
  '- 全篇只写 1 个核心自然姿态（如倚窗远眺、手肘轻搭木桌托腮、侧身回眸、坐在扶手椅上微倾身体），不要堆砌一连串手脚细节；严禁双腿张开、翘臀、撅起等高危部位姿态，也不要写成呆板僵硬的证件照站姿；\n' +
  '- 表情捕捉细腻真实的电影情绪层次（如微垂眼眸、唇角轻抿、若有所思、眼神柔和、微微偏头凝视、面颊泛起极淡微红等）；【绝对禁止】哭泣、流泪、泪痕、痛苦、屈辱、挣扎、求饶等易触发胁迫审核的词汇。\n' +
  '【环境场景与道具细节（核心重点）】\n' +
  '- 日常与公开场景（街景、咖啡馆、办公室、古风庭院、雨夜长廊、车厢等）：充分还原时代质感、空间纵深、前景与背景陈设、随手道具（茶杯、书卷、雨伞、车窗水珠、灯笼等）及天气时间；\n' +
  '- 私密/暧昧场景（卧室、床、浴室、温泉、昏暗酒店房等）【保空间、避焦点】：保留同一时代与室内空间的格调氛围（如木质家具、垂坠窗帘、台灯暖光、窗外夜色、屏风烛影、水汽朦胧的玻璃门等），但把人物与镜头落点移到窗边、书桌旁、沙发一角、梳妆台前或门廊处，严禁出现床铺、被窝、凌乱枕头、浴缸、淋浴等高危焦点词。\n' +
  '【光线、色调与电影氛围】\n' +
  '- 必须写出明确的自然/环境光源与色温（如午后斜射窗棂的暖金逆光、雨夜霓虹映在湿润玻璃上的冷蓝反光、阴天柔和漫射光、室内琥珀色暖灯或微弱烛火），并交代画面景深层次与静谧/克制/温暖等氛围感。\n' +
  '【绝对红线与留白】\n' +
  '- 严禁性器官名称、三点、裸露、露骨性行为及任何明显性暗示词汇；\n' +
  '- 不要自写画风词（写实/摄影/35mm/胶片/电影感等）和镜头机位词（俯视/仰视/特写/竖向构图等）——画风与镜头参数由系统统一拼接。\n\n' +
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

// 严格版永久单人，保留此导出名称以兼容旧引用


export const DEFAULT_STRICT_DUO_COMPOSE_SYSTEM_PROMPT = DEFAULT_COMPOSE_SYSTEM_PROMPT;

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

const REF_IMAGE_COMPOSE_BLOCK = '\n\n【面部参考图模式·严禁写五官】\n本轮生图已附带角色面部参考图，她的五官、脸型、眼型、眉形、鼻唇与面容特征完全以参考图为准。\n' +
  '本次提示词【绝对禁止】描写任何脸型、五官、眉眼鼻唇或“瓜子脸/鹅蛋脸/杏眼/明艳御姐容貌”等面部特征词（文字写五官会与参考图打架导致换脸）。\n' +
  '请以“一位{N}岁女性”开头，重点描写：整体身高体型与曲线轮廓 + 按剧情/时代动态设计的当前发型与配饰 + 当前衣着 + 自然动作姿态 + 表情神态 + 环境场景与道具 + 光线色彩氛围。';

// 第一步：根据角色卡 + 本轮回复，总结出生图提示词
// suppressAppearance：该角色已登记锚点时为 true——禁止副 AI 写容貌/身材（锚点事后由 App 机械拼接）
async function composeIllustrationPrompt(replyContent, character, apiConfig, suppressAppearance, { hasRefImage = false } = {}) {
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
  // 外貌身材锚点【硬拼接模式】：有锚点时禁止副 AI 写底层容貌/身材（锚点事后由 App 机械拼接）
  const anchorBlock = suppressAppearance
    ? '\n\n【外貌身材锚点·拼接模式】\n本次提示词【绝对禁止】写固定的脸型、五官、眼色、年龄、身高体型、胸/腰/臀/腿、肤质等底层容貌身材描写，也不得以"一位{N}岁女性"之类的主体锚定开头：她的固定容貌身材锚点会由系统在事后机械拼接到最前面。\n' +
      '【务必主动描写当前发型与配饰】请根据本轮剧情、时代背景与场景氛围，主动写出她当下的发型（如披发/低马尾/微卷/丸子头/古风发髻等）与发饰/耳饰/项链/围巾等随身配饰（剧情未写明时顺时代自然搭配）。直接从「当前发型与配饰 + 当前衣着 + 动作姿态 + 表情神态 + 环境场景 + 光线氛围」开始写。'
    : (hasRefImage ? REF_IMAGE_COMPOSE_BLOCK : '');
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
      '请针对性改写：找出最可能触发审核的表达（例如裸露/内衣/透视、性暗示或暧昧动作、床铺/浴缸等高危场景焦点词、痛苦屈服词、真实名人姓名、第二人存在的暗示）并替换或删除——将衣着收紧为同年代得体日常装、姿态收紧为自然静姿、高危焦点移至窗边/桌旁/房间一角。\n' +
      '人物年龄性别锚定、容貌、整体体型词、环境空间氛围与光线色调必须保留，不要删成空洞的棚拍白底。\n' +
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
  // 【私密衣着】仅 Grok 管线使用占位标记，严格版无需保留该标记
  if (!isStrictMechanicalProvider(apiConfig.imageProvider)) {
    system += '\n另外：【私密衣着】是系统占位标记（不是乱码、不是违规内容），出现时必须原样保留，禁止删除、改写或翻译。';
  }
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
    return (prompt, images) => generateOpenAIImage({ ...oa, prompt, images });
  }
  if (imgCfg.provider === 'grok') {
    const gk = imgCfg.grok || {};
    return (prompt, images) => generateGrokImage({ ...gk, prompt, images });
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
// 严格版（seedream/wanx/gemini/openai）走副 API 真人电影剧照编词，duoMode 强制 false
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
  const customCompose = strict
    ? sdCfg.composePrompt
    : (provider === 'grok' ? (duoMode ? gkCfg.composePromptDuo : gkCfg.composePrompt) : '');
  const outfitLibrary = strict ? [] : resolveGrokOutfitLibrary(gkCfg);
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
async function extractNewAnchor(anchorName, anchors, replyContent, character, mergedApiConfig, { hasRefImage = false } = {}) {
  if (!anchorName || (anchors && anchors[anchorName])) return null;
  try {
    const anchor = await extractNamedAppearanceAnchor({
      name: anchorName, replyContent, character, apiConfig: mergedApiConfig, hasRefImage
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

const OUTFIT_MARKER_CLEANUP_RE = /[【\[「『\(（]?\s*私密衣着\s*[】\]」』\)）]?/g;

function finalizeStrictPrompt(anchorText, bodyPrompt, shotWords, provider) {
  let spliced = spliceAnchor(anchorText, bodyPrompt, shotWords && shotWords.head);
  if (shotWords && shotWords.tail) spliced += '，' + shotWords.tail;
  spliced = spliced.replace(OUTFIT_MARKER_CLEANUP_RE, '').replace(/，{2,}/g, '，');
  return hardFilterPrompt(spliced, provider) + STRICT_CINEMATIC_STYLE_SUFFIX;
}

/**
 * 严格版副 API 编词管线（L0 预览，不调生图 API）：
 * compose（真人电影剧照 + 完整环境光影 + 私密保空间避焦点）→ 首次登记锚点 → 硬过滤 + 电影感后缀。
 */
async function prepareStrictComposePrompt({ replyContent, character, config, anchorName, anchors, shotWords, provider, mergedApiConfig }) {
  const existingAnchor = (anchorName && anchors) ? anchorTextOf(anchors[anchorName]) : '';
  const refImages = await resolveAnchorRefImages(anchors, anchorName, config);
  const hasRefImage = Boolean(refImages && refImages.length > 0);
  const prompt = await composeIllustrationPrompt(replyContent, character, mergedApiConfig, !!existingAnchor, { hasRefImage });
  const newAnchor = await extractNewAnchor(anchorName, anchors, replyContent, character, mergedApiConfig, { hasRefImage });
  return {
    prompt: finalizeStrictPrompt(existingAnchor, prompt, shotWords, provider),
    newAnchor
  };
}

/**
 * 严格版完整出图（L0/L1/L2 分级兜底）：
 * - attempt 0 (L0)：仅调 1 次副 API 编词，保留完整环境光影直接出图
 * - attempt 1 (L1)：仅审核报错时调 1 次副 API 针对性改写（保环境，只收紧高危词）
 * - attempt 2 (L2)：仍被拒时机械降级为自然半身肖像保底
 */
async function generateStrictComposeIllustration({ replyContent, character, config, anchorName, anchors, shotWords, provider, mergedApiConfig, generate }) {
  const existingAnchor = (anchorName && anchors) ? anchorTextOf(anchors[anchorName]) : '';
  const refImages = await resolveAnchorRefImages(anchors, anchorName, config);
  const hasRefImage = Boolean(refImages && refImages.length > 0);
  let prompt = await composeIllustrationPrompt(replyContent, character, mergedApiConfig, !!existingAnchor, { hasRefImage });
  const newAnchor = await extractNewAnchor(anchorName, anchors, replyContent, character, mergedApiConfig, { hasRefImage });

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const bodyPrompt = attempt === 2 ? degradeToPortraitPrompt(prompt) : prompt;
    const finalPrompt = finalizeStrictPrompt(existingAnchor, bodyPrompt, shotWords, provider);
    try {
      const dataUrl = await generate(finalPrompt, refImages);
      return { dataUrl, prompt: finalPrompt, newAnchor };
    } catch (e) {
      lastErr = e;
      if (!isModerationError(e) || attempt === 2) {
        e.imagePrompt = finalPrompt.replace(STRICT_CINEMATIC_STYLE_SUFFIX, '');
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
 * 手动网页版 / 提示词预览：跑提示词管线，不调生图 API。
 * 严格版 = 副 API 真人电影感编词 + 锚点拼接；Grok = compose → sanitize → 锚点拼接。
 * anchorName = 插图标记 alt 里的角色名；anchors = 对话的外貌身材锚点档案 {角色名: 描述}
 * @returns {Promise<{prompt: string, newAnchor: ?{name: string, anchor: string}}>}
 */
export async function prepareIllustrationPrompt({ replyContent, character, config, anchorName, anchors, shotWords }) {
  const { provider, mergedApiConfig } = buildPromptPipelineConfig(config);

  if (isStrictMechanicalProvider(provider)) {
    return prepareStrictComposePrompt({
      replyContent, character, config, anchorName, anchors, shotWords, provider, mergedApiConfig
    });
  }

  // Grok / 手动管线
  const anchorText = (anchorName && anchors) ? anchorTextOf(anchors[anchorName]) : '';
  const refImages = await resolveAnchorRefImages(anchors, anchorName, config);
  const hasRefImage = Boolean(refImages && refImages.length > 0);
  let prompt = await composeIllustrationPrompt(replyContent, character, mergedApiConfig, !!anchorText, { hasRefImage });
  prompt = await sanitizeIllustrationPrompt(prompt, null, character, mergedApiConfig);
  const newAnchor = await extractNewAnchor(anchorName, anchors, replyContent, character, mergedApiConfig, { hasRefImage });
  // 锚点硬拼接：在机械过滤之前拼上；朝向词紧跟锚点之后
  let spliced = spliceAnchor(anchorText, prompt, shotWords && shotWords.head);
  if (shotWords && shotWords.tail) spliced += '，' + shotWords.tail;
  // 私密衣着：从库随机一行再抽色替换
  const grokLib = mergedApiConfig.outfitLibrary || resolveGrokOutfitLibrary((config.image || {}).grok);
  const filledOutfit = fillOutfitTemplate(pickRandomOutfitLine(grokLib, DEFAULT_GROK_OUTFIT_LIBRARY));
  spliced = replaceOutfitMarker(spliced, filledOutfit);
  return { prompt: hardFilterPrompt(spliced, provider) + styleSuffixFor(provider), newAnchor };
}

/**
 * 完整插图生成流程。
 * 严格版：副 API 编词（L0）→ 审核拒绝改写（L1）→ 肖像降级（L2）
 * Grok：compose → sanitize → 生成 → L1 改写 / L2 降级
 * @returns {Promise<{dataUrl: string, prompt: string, newAnchor: ?{name: string, anchor: string}}>}
 */
export async function generateIllustrationForReply({ replyContent, character, config, anchorName, anchors, shotWords }) {
  const { provider, mergedApiConfig } = buildPromptPipelineConfig(config);
  const generate = resolveImageGenerator(config);

  if (isStrictMechanicalProvider(provider)) {
    return generateStrictComposeIllustration({
      replyContent, character, config, anchorName, anchors, shotWords,
      provider, mergedApiConfig, generate
    });
  }

  // ---------- Grok 管线（compose + 私密衣着库随机一行） ----------
  const anchorText = (anchorName && anchors) ? anchorTextOf(anchors[anchorName]) : '';
  // grok / grokweb 参考图：锚点带图则出图带上（画谁用谁的脸）；文字锚点继续管身材/场景
  const refImages = await resolveAnchorRefImages(anchors, anchorName, config);
  const hasRefImage = Boolean(refImages && refImages.length > 0);
  let prompt = await composeIllustrationPrompt(replyContent, character, mergedApiConfig, !!anchorText, { hasRefImage });
  prompt = await sanitizeIllustrationPrompt(prompt, null, character, mergedApiConfig);
  const newAnchor = await extractNewAnchor(anchorName, anchors, replyContent, character, mergedApiConfig, { hasRefImage });
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
      const finalPrompt = safePrompt + styleSuffixFor(provider);
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
  const provider = (rawProvider === 'manual' || rawProvider === 'grokweb') ? 'grok' : rawProvider;
  const imgCfg = config.image || {};
  let prepared = prompt || '';
  if (provider === 'grok') {
    const library = resolveGrokOutfitLibrary(imgCfg.grok || {});
    const template = pickRandomOutfitLine(library, DEFAULT_GROK_OUTFIT_LIBRARY);
    prepared = applyForcedOutfit(prepared, template);
  } else {
    prepared = prepared.replace(OUTFIT_MARKER_CLEANUP_RE, '').replace(/，{2,}/g, '，');
  }
  const clean = hardFilterPrompt(prepared, provider);
  if (!clean) throw new Error('提示词为空');
  const finalPrompt = clean + styleSuffixFor(provider);
  try {
    const dataUrl = await generate(finalPrompt, refImages);
    return { dataUrl, prompt: finalPrompt };
  } catch (e) {
    e.imagePrompt = clean;
    throw e;
  }
}

// 内置随机测试剧情种子（覆盖现代/古风/日常/私密保空间场景，用于设置页副 API 随机出词测试）
export const STRICT_TEST_SCENARIO_SEEDS = [
  {
    label: '现代雨夜咖啡馆',
    charDesc: '27 岁女性，鹅蛋脸，偏冷淡温柔的气质，齐肩黑发微卷，深棕眼眸，身材高挑纤细，日常偏爱米白羊绒衫与驼色大衣。',
    bodyDesc: '27 岁女性，偏冷淡温柔的气质，身材高挑纤细、曲线匀称，日常偏爱米白羊绒衫与驼色大衣。',
    replyContent: '窗外下着连绵细雨，咖啡馆木桌上的热拿铁冒着微弱白气。她脱下搭在椅背的驼色大衣，只穿着米白高领羊绒衫坐在靠窗的角落，指尖轻搭着瓷杯边缘，侧头望着玻璃上流淌的霓虹雨痕，神情安静而略带疏离。'
  },
  {
    label: '午后旧书馆窗边',
    charDesc: '23 岁女性，清秀瓜子脸，长发扎成低马尾留出几缕碎发，琥珀色眼睛，匀称娇柔。',
    bodyDesc: '23 岁女性，气质文静温柔，身形匀称娇柔、肩颈纤细。',
    replyContent: '午后三点的阳光斜穿过高大的木格窗，在旧书馆的橡木长桌上投下明暗光斑，空气里浮着细微尘埃。她穿着浅蓝条纹牛津衬衫与深灰百褶裙，手肘轻撑在摊开的精装旧书旁托腮思索，眼角带着一丝微倦却温柔的笑意。'
  },
  {
    label: '古风夜雨廊下烛影',
    charDesc: '25 岁女性，古典杏眼柳眉，乌黑长发半挽插一支白玉簪，肌肤如瓷，身姿修长曼妙。',
    bodyDesc: '25 岁女性，古典清冷气质，肌肤白皙，身姿修长曼妙。',
    replyContent: '檐外春雨淅沥，青石庭院浸在夜色里，长廊下悬着一盏昏黄纱灯。她一袭月白色交领长裙外罩淡青轻纱，独自倚在朱漆廊柱旁，指尖接住一滴檐水，微垂眼眸听雨，脸上在灯火映照下泛着柔和清冷的光影。'
  },
  {
    label: '都市天台黄昏风起',
    charDesc: '30 岁女性，明艳大气的御姐容貌，长波浪栗色卷发，红唇深眸，身材高挑曲线分明。',
    bodyDesc: '30 岁女性，大气干练的成熟御姐气质，身材高挑、曲线分明。',
    replyContent: '傍晚的橘红色晚霞铺满都市楼群，天台风很大，吹乱了她额前的几缕卷发。她穿着剪裁利落的黑色西装外套与真丝内搭，倚在铁艺栏杆边俯瞰脚下渐次亮起的车流灯海，唇角轻抿，眼神锐利又带着一点疲惫的松弛。'
  },
  {
    label: '现代私密房间暧昧瞬间',
    charDesc: '26 岁女性，温柔明媚的鹅蛋脸，微卷深棕长发披散在肩头，身形曲线柔和。',
    bodyDesc: '26 岁女性，温柔明媚的气质，身形曲线柔和匀称。',
    replyContent: '深夜卧室只亮着一盏床头暖黄台灯，窗帘半掩透进城市微光。她刚洗完澡只披着一件宽大的白色男士衬衫，衣摆松垮地垂到大腿，被你轻揽着腰贴在身边。她耳尖泛红，眼底带着微醺似的水光，抬头看着你轻声喘息。'
  },
  {
    label: '古风闺房水汽夜灯',
    charDesc: '24 岁女性，眉目如画的大家闺秀，柔顺黑发散落肩背，身段纤细匀称。',
    bodyDesc: '24 岁女性，温婉大家闺秀气质，身段纤细匀称。',
    replyContent: '浴池里热气氤氲，纱幔垂落挡住大半夜风，案几上铜镜与烛火摇曳。她刚出浴只裹着半敞的丝绸里衣，浑身带着潮热红晕，倚在屏风边小口喘气，被你从身后贴近轻吻颈侧时下意识偏过头躲闪又带着一丝娇羞。'
  }
];

/**
 * 设置页测试用：调用副 API（resolveMemoryApi）根据当前 compose system prompt 随机生成一段测试画面描述。
 */
export async function composeTestIllustrationPrompt({
  composePrompt = '',
  provider = 'openai',
  duoMode = false,
  apiConfig = {},
  scenario = null,
  hasRefImage = false
} = {}) {
  const seed = scenario || STRICT_TEST_SCENARIO_SEEDS[Math.floor(Math.random() * STRICT_TEST_SCENARIO_SEEDS.length)];
  const isGrok = provider === 'grok' || provider === 'manual' || provider === 'grokweb';
  const defaultPrompt = isGrok
    ? (duoMode ? DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT : DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT)
    : DEFAULT_COMPOSE_SYSTEM_PROMPT;
  const basePrompt = (composePrompt || '').trim() || defaultPrompt;
  const charText = hasRefImage ? (seed.bodyDesc || seed.charDesc) : seed.charDesc;
  const filledSystem = basePrompt.replace('{charDesc}', charText);
  const system = filledSystem.includes('【AI 最新回复】')
    ? filledSystem
    : filledSystem + '\n\n【AI 最新回复】\n{replyContent}';
  const finalSystem = system.replace('{replyContent}', seed.replyContent) + (hasRefImage ? REF_IMAGE_COMPOSE_BLOCK : '');
  const result = await sendChat([
    { role: 'system', content: finalSystem },
    { role: 'user', content: '【AI 最新回复】\n' + seed.replyContent }
  ], { api: resolveMemoryApi(apiConfig), usageContext: { kind: 'settings' } });
  const cleaned = (result || '').trim().replace(/^["'「『]+|["'」』]+$/g, '');
  if (!cleaned) throw new Error('副 API 返回为空');
  return { prompt: cleaned, scenarioLabel: seed.label };
}

/**
 * 测试生图发送前整理：清理残留标记、过严格/Grok硬性禁词过滤，并按服务商追加对应风格后缀（不重复追加）。
 */
export function prepareFinalTestImagePrompt(rawPrompt, provider = 'openai') {
  const normalizedProvider = (provider === 'manual' || provider === 'grokweb') ? 'grok' : provider;
  let prepared = String(rawPrompt || '').trim();
  if (!prepared) return '';
  prepared = prepared.replace(OUTFIT_MARKER_CLEANUP_RE, '').replace(/，{2,}/g, '，');
  const clean = hardFilterPrompt(prepared, normalizedProvider);
  if (!clean) return '';
  if (/cinematic live-action film still|strictly photorealistic/i.test(clean)) {
    return clean;
  }
  return clean + styleSuffixFor(normalizedProvider);
}
