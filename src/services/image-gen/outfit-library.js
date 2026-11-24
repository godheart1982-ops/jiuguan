// 私密强制衣着模板库与审美配色词库

// ---------- 衣着模板 ----------
// 严格版（Seedream/Gemini）：永远用模板库，一行一条，每次生图随机抽一行；不写表情/场景/剧情姿态。
// Grok/手动：仍走 compose；暧昧场景【私密衣着】→ 从 Grok 衣着库随机抽一行再机械替换。
// 模板颜色占位符（每次生图抽一条审美配色短语，同轮重试锁定）：
//   {颜色}/{主色}  完整色感短语——可以是单色，也可以是已混好的审美拼色/撞色（推荐主要用这个）
//   {同色}         与本次 {颜色} 相同（上下成套时用）
//   {配色}/{异色}/{颜色2}  与本次色感配套的次要色（仅多件套分写时用；多数模板只写 {颜色} 即可）

export const OUTFIT_MARKER = '【私密衣着】';
// 宽容匹配：AI 可能写成「私密衣着」[私密衣着]（私密衣着）甚至不带括号/带空格——核心是这四个字，
// 括号变体一律视为标记，否则 includes 精确匹配漏掉后标记原文会直接泄漏进最终提示词
const OUTFIT_MARKER_RE = /[【\[「『\(（]?\s*私密衣着\s*[】\]」』\)）]?/g;

// 严格版默认衣着库（偏保守，过审优先；性感款由用户自行往库里加）
// {颜色} 本身已可带混色，多数行只需一个 {颜色}
export const DEFAULT_STRICT_OUTFIT_LIBRARY = [
  '穿着{颜色}针织毛衣与牛仔裤',
  '穿着{颜色}连衣裙',
  '穿着{颜色}毛衣开衫与百褶裙',
  '穿着{颜色}衬衫与半身裙',
  '穿着{颜色}运动外套与休闲裤',
  '穿着{颜色}真丝吊带外袍',
  '穿着{颜色}针织开衫与长裤',
  '穿着{颜色}风衣与内搭',
  '穿着{颜色}卫衣与运动裤',
  '穿着{颜色}吊带裙'
];
// 兼容旧名：单条默认 = 库第一条（迁移旧 forcedOutfit 配置时也会用到）
export const DEFAULT_STRICT_FORCED_OUTFIT = DEFAULT_STRICT_OUTFIT_LIBRARY[0];
// Grok/手动私密强制衣着库：默认仅 1 条，其余用户自建
export const DEFAULT_GROK_FORCED_OUTFIT = '穿了一套{颜色}三点式蕾丝内衣与{同色}吊带袜';
export const DEFAULT_GROK_OUTFIT_LIBRARY = [DEFAULT_GROK_FORCED_OUTFIT];
// L2 保底衣着（严格机械路径末次尝试）
const L2_STRICT_OUTFIT = '穿着日常家居服';
// 无锚点且提取失败时的主体兜底（不写入档案，下次仍会再提取）
const FALLBACK_SUBJECT = '一位成年女性';

/**
 * 审美配色词库：每条 color 是完整色感（单色或已混搭好的短语），accent 仅给分写多件套的 {配色} 用。
 * {颜色} 直接填 color——混色审美写在短语里，不靠两次乱抽拼。
 */
const OUTFIT_COLOR_ENTRIES = [
  // ——— 单色（丰富色名） ———
  { color: '纯黑色', accent: '白色' },
  { color: '纯白色', accent: '黑色' },
  { color: '米白色', accent: '驼色' },
  { color: '奶油色', accent: '浅咖' },
  { color: '象牙白', accent: '金色' },
  { color: '浅灰色', accent: '白色' },
  { color: '中灰色', accent: '黑色' },
  { color: '深灰色', accent: '银色' },
  { color: '炭灰色', accent: '白色' },
  { color: '燕麦色', accent: '白色' },
  { color: '卡其色', accent: '白色' },
  { color: '驼色', accent: '米白' },
  { color: '焦糖色', accent: '奶油色' },
  { color: '巧克力色', accent: '米色' },
  { color: '咖啡色', accent: '奶油色' },
  { color: '摩卡色', accent: '白色' },
  { color: '藏青色', accent: '白色' },
  { color: '深蓝色', accent: '浅蓝' },
  { color: '雾霾蓝', accent: '白色' },
  { color: '天空蓝', accent: '白色' },
  { color: '婴儿蓝', accent: '白色' },
  { color: '牛仔蓝', accent: '白色' },
  { color: '墨绿色', accent: '米色' },
  { color: '橄榄绿', accent: '卡其' },
  { color: '薄荷绿', accent: '白色' },
  { color: '苔藓绿', accent: '米白' },
  { color: '酒红色', accent: '黑色' },
  { color: '勃艮第红', accent: '米色' },
  { color: '正红色', accent: '黑色' },
  { color: '砖红色', accent: '米白' },
  { color: '番茄红', accent: '白色' },
  { color: '浅粉色', accent: '白色' },
  { color: '玫瑰粉', accent: '灰色' },
  { color: '藕粉色', accent: '浅灰' },
  { color: '裸粉色', accent: '米白' },
  { color: '珊瑚粉', accent: '白色' },
  { color: '深紫色', accent: '银色' },
  { color: '薰衣草紫', accent: '白色' },
  { color: '梅子色', accent: '黑色' },
  { color: '香芋紫', accent: '米白' },
  { color: '香槟金', accent: '黑色' },
  { color: '玫瑰金', accent: '米白' },
  { color: '银色', accent: '白色' },
  { color: '芥末黄', accent: '黑色' },
  { color: '奶油黄', accent: '白色' },
  { color: '橘橙色', accent: '米白' },
  { color: '焦橘色', accent: '驼色' },
  // ——— 审美混色（写在 {颜色} 里，整段替换） ———
  // 黑白灰
  { color: '黑白经典拼色', accent: '黑色' },
  { color: '黑白条纹配色', accent: '白色' },
  { color: '黑白格纹混搭', accent: '黑色' },
  { color: '黑灰渐变层次', accent: '深灰' },
  { color: '白与浅灰柔和拼接', accent: '白色' },
  { color: '炭灰与米白撞色', accent: '炭灰' },
  { color: '黑金点缀', accent: '黑色' },
  { color: '黑银冷调混搭', accent: '黑色' },
  // 中性大地
  { color: '米白与驼色叠搭', accent: '米白' },
  { color: '卡其与白色清爽拼色', accent: '卡其' },
  { color: '焦糖与奶油色暖调混搭', accent: '焦糖色' },
  { color: '摩卡与燕麦色层次', accent: '摩卡色' },
  { color: '巧克力与米色温润撞色', accent: '巧克力色' },
  { color: '驼棕与米白大地色系', accent: '驼色' },
  { color: '浅杏与白色柔和搭配', accent: '浅杏' },
  { color: '燕麦与浅咖自然混色', accent: '燕麦色' },
  // 蓝系
  { color: '藏青与白色海军风拼色', accent: '藏青' },
  { color: '牛仔蓝与白色清爽搭配', accent: '牛仔蓝' },
  { color: '雾霾蓝与米白高级混搭', accent: '雾霾蓝' },
  { color: '深蓝与浅蓝同色深浅', accent: '深蓝' },
  { color: '天蓝与白色清透拼色', accent: '天蓝' },
  { color: '藏青与卡其休闲撞色', accent: '藏青' },
  { color: '牛仔蓝与米白柔和混搭', accent: '牛仔蓝' },
  // 绿系
  { color: '墨绿与米色静奢混搭', accent: '墨绿' },
  { color: '橄榄绿与卡其工装感拼色', accent: '橄榄绿' },
  { color: '薄荷与白色清新拼色', accent: '薄荷绿' },
  { color: '苔绿与米白自然搭配', accent: '苔藓绿' },
  { color: '墨绿与金色点缀', accent: '墨绿' },
  // 红/粉/紫
  { color: '酒红与黑色沉稳撞色', accent: '酒红' },
  { color: '酒红与米色温柔混搭', accent: '酒红' },
  { color: '勃艮第红与米白复古拼色', accent: '勃艮第红' },
  { color: '正红与黑色利落撞色', accent: '正红' },
  { color: '浅粉与白色甜美拼色', accent: '浅粉' },
  { color: '玫瑰粉与浅灰温柔混搭', accent: '玫瑰粉' },
  { color: '藕粉与米白柔雾搭配', accent: '藕粉' },
  { color: '裸粉与驼色高级混搭', accent: '裸粉' },
  { color: '珊瑚粉与白色清爽拼色', accent: '珊瑚粉' },
  { color: '深紫与银色冷调点缀', accent: '深紫' },
  { color: '薰衣草紫与白色淡雅拼色', accent: '薰衣草紫' },
  { color: '梅子色与黑色成熟撞色', accent: '梅子色' },
  { color: '香芋紫与米白柔和混搭', accent: '香芋紫' },
  { color: '酒红与浅粉同色系渐变', accent: '酒红' },
  // 跨色审美（经典穿搭向）
  { color: '黑白红三点跳色', accent: '黑色' },
  { color: '藏青白红学院风拼色', accent: '藏青' },
  { color: '驼粉温柔撞色', accent: '驼色' },
  { color: '雾蓝与藕粉莫兰迪混搭', accent: '雾霾蓝' },
  { color: '墨绿与酒红复古撞色', accent: '墨绿' },
  { color: '卡其与牛仔蓝休闲拼色', accent: '卡其' },
  { color: '米白与浅牛仔蓝清爽混搭', accent: '米白' },
  { color: '烟灰与玫瑰金轻奢点缀', accent: '烟灰' },
  { color: '黑白与一点酒红点缀', accent: '黑色' },
  { color: '燕麦色与雾霾蓝柔和搭配', accent: '燕麦色' },
  { color: '焦糖与雾蓝秋冬混搭', accent: '焦糖色' },
  { color: '香槟金与米白柔光拼色', accent: '香槟金' },
  { color: '玫瑰金与裸粉细闪混搭', accent: '玫瑰金' },
  { color: '黑白细条纹经典配色', accent: '黑色' },
  { color: '蓝白细条纹清爽配色', accent: '蓝色' },
  { color: '红白细条纹活力拼色', accent: '红色' },
  { color: '灰白千鸟格混色', accent: '灰色' },
  { color: '驼白格纹温柔拼色', accent: '驼色' },
  { color: '黑白波点复古混搭', accent: '黑色' }
];

/**
 * 填充衣着模板颜色占位符。
 * 一次调用抽一条审美配色；{颜色} 直接是完整色感（可含混色）；同轮重试应复用返回值。
 */
export function fillOutfitTemplate(template) {
  const entry = OUTFIT_COLOR_ENTRIES[Math.floor(Math.random() * OUTFIT_COLOR_ENTRIES.length)];
  const color = entry.color;
  const accent = entry.accent;
  return (template || '')
    .replace(/\{颜色\}/g, color)
    .replace(/\{主色\}/g, color)
    .replace(/\{同色\}/g, color)
    .replace(/\{配色\}/g, accent)
    .replace(/\{异色\}/g, accent)
    .replace(/\{颜色2\}/g, accent);
}

// 把提示词里的所有私密衣着标记（含括号变体）替换为填充后的衣着文本；无标记则原样返回
export function replaceOutfitMarker(prompt, filledOutfit) {
  if (!prompt || prompt.indexOf('私密衣着') === -1) return prompt;
  return prompt.replace(OUTFIT_MARKER_RE, filledOutfit)
    .replace(/，{2,}/g, '，').replace(/，([。！？])/g, '$1').replace(/(^，)|(，$)/g, '').trim();
}

// 便捷封装：填充模板（随机抽色）并替换；多次调用的场景（重试循环）应先自行 fill 再逐次 replace，保证同色
export function applyForcedOutfit(prompt, template) {
  return replaceOutfitMarker(prompt, fillOutfitTemplate(template));
}

/** 多行文本 → 模板数组（空行忽略） */
export function parseOutfitLibraryText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 模板数组 → 设置页多行文本 */
export function outfitLibraryToText(library) {
  const lib = (library && library.length) ? library : DEFAULT_STRICT_OUTFIT_LIBRARY;
  return lib.join('\n');
}

/**
 * 解析严格版衣着库：优先 outfitLibrary；否则迁移旧 forcedOutfit 单串；再否则内置默认。
 * @param {Object} sdCfg image.seedream 配置
 * @returns {string[]}
 */
export function resolveStrictOutfitLibrary(sdCfg) {
  const cfg = sdCfg || {};
  if (Array.isArray(cfg.outfitLibrary)) {
    const lines = cfg.outfitLibrary.map((s) => String(s).trim()).filter(Boolean);
    if (lines.length > 0) return lines;
  }
  if (cfg.forcedOutfit && String(cfg.forcedOutfit).trim()) {
    return [String(cfg.forcedOutfit).trim()];
  }
  return DEFAULT_STRICT_OUTFIT_LIBRARY.slice();
}

/**
 * 解析 Grok/手动私密强制衣着库（image.grok）
 * 优先 outfitLibrary；否则迁移旧 forcedOutfit 单串；再否则默认一条
 */
export function resolveGrokOutfitLibrary(gkCfg) {
  const cfg = gkCfg || {};
  if (Array.isArray(cfg.outfitLibrary)) {
    const lines = cfg.outfitLibrary.map((s) => String(s).trim()).filter(Boolean);
    if (lines.length > 0) return lines;
  }
  if (cfg.forcedOutfit && String(cfg.forcedOutfit).trim()) {
    // 旧配置可能是多行塞在一个字符串里
    const asLines = parseOutfitLibraryText(cfg.forcedOutfit);
    if (asLines.length > 0) return asLines;
  }
  return DEFAULT_GROK_OUTFIT_LIBRARY.slice();
}

export function pickRandomOutfitLine(library, fallbackLibrary) {
  const fb = (fallbackLibrary && fallbackLibrary.length) ? fallbackLibrary : DEFAULT_STRICT_OUTFIT_LIBRARY;
  const lib = (library && library.length) ? library : fb;
  return lib[Math.floor(Math.random() * lib.length)];
}

function joinPromptParts(parts) {
  return parts
    .filter(Boolean)
    .map((s) => String(s).trim().replace(/[，,。.\s]+$/g, ''))
    .filter(Boolean)
    .join('，');
}

/**
 * 严格版机械提示词：锚点 + 朝向 + 衣着 + 镜头 tail。不写表情/场景/剧情姿态。
 * l2=true 时换家居服并只保留半身取景，尽量过审。
 */
export function buildStrictBodyPrompt({ anchorText, outfitFilled, shotWords, l2 }) {
  const subject = (anchorText || '').trim() || FALLBACK_SUBJECT;
  const orient = (!l2 && shotWords && shotWords.head) ? shotWords.head : '';
  const outfit = l2 ? L2_STRICT_OUTFIT : (outfitFilled || L2_STRICT_OUTFIT);
  const tail = l2
    ? '半身取景'
    : (shotWords && shotWords.tail ? shotWords.tail : '');
  return joinPromptParts([subject, orient, outfit, tail]);
}
