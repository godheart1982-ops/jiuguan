// 外貌锚点与免费生图记忆：提取、参考图解析、pollinations URL 锚点拼接
import { sendChat } from '../api.js';
import { resolveMemoryApi } from '../api-memory.js';
import { getConfig, getAnchorRefImageDataUrl } from '../storage.js';
import { getCharacterModules } from '../card-modules.js';

// ---------- 外貌锚点记录（{text, img}，旧字符串形态由读档迁移升级，这里做防御兼容） ----------

/** 取锚点文本（兼容旧字符串形态） */
export function anchorTextOf(rec) {
  return typeof rec === 'string' ? rec : String((rec && rec.text) || '');
}

/** 取锚点参考图的存储相对路径（无则空串） */
export function anchorImgOf(rec) {
  return (rec && typeof rec === 'object') ? String(rec.img || '') : '';
}

/** 写入/更新锚点文本：保留已登记的参考图（AI 提取只换文字，不动用户传的图） */
export function mergeAnchorText(anchors, name, text) {
  if (!anchors || !name) return;
  anchors[name] = { text: String(text || ''), img: anchorImgOf(anchors[name]) };
}

/**
 * 解析当前插图标记可用的锚点参考图（data URL 数组，null=无）。
 * v1 仅 grokweb 通道支持参考图；锚点按名字挂——画谁就用谁的脸，没登记的没有参考图。
 */
export async function resolveAnchorRefImages(anchors, anchorName, config) {
  const rawProvider = (config && config.image && config.image.provider) || '';
  if (rawProvider !== 'grokweb') return null;
  const imgPath = anchorImgOf(anchors && anchorName ? anchors[anchorName] : null);
  if (!imgPath) return null;
  const dataUrl = await getAnchorRefImageDataUrl(imgPath).catch(() => null);
  return dataUrl ? [dataUrl] : null;
}

// ---------- 外貌身材锚点（生图人物一致性记忆，按角色名登记） ----------
// 与插图种子档案同构：{ 角色名: 外貌描述 } 存在对话（chat.appearanceAnchors）里，记忆页可编辑。
// 名字取自插图标记的 alt（AI 按输出格式写的就是状态栏里的她）；新名字首次生图后自动提取登记，
// 之后同名角色生图逐字注入锚点，保证同一个 NPC 每张图都是同一张脸。不进对话上下文，只占生图管线。

// 为指定名字提取外貌身材锚点：容貌身材优先取设定原文（卡内角色模块 / 回复里的人物卡、设定段），
// 设定里没有才退到状态栏的样貌/身材字段。只在首次登记时调用一次。
export async function extractNamedAppearanceAnchor({ name, replyContent, character, apiConfig, english = false }) {
  // 设定来源：卡内全部角色模块（主角配角都在，提取 prompt 已限定只取「name」一人，长卡也读全）；
  // 老卡的 description/subCharacters 由 getCharacterModules 惰性并入；
  // 正文里随机 NPC 的人物卡和状态栏照旧一起给
  const charDesc = getCharacterModules(character).join('\n\n').slice(0, 30000);
  const system = english
    ? 'You are an appearance extraction assistant for text-to-image models. From the given materials, extract the appearance and figure of the female character named 「' + name + '」, and output ONE English description of at most 60 words, used to keep her look consistent across generated images.\n' +
      'Source priority [strict]: prefer the original setting text (character card / profile sections in the reply); only when settings lack details, use the status-bar appearance fields.\n' +
      'Rules:\n' +
      '- Include only: age, face shape & features, hairstyle & color, eye color, body type (relative words like tall/petite, no centimeter numbers), figure (overall contour words only), skin;\n' +
      '- Start with "A {N}-year-old woman" — age from the setting, infer from vibe if absent, must be an adult;\n' +
      '- No clothing, personality, identity, background, speech habits;\n' +
      '- Celebrity resemblance: if the setting explicitly says she resembles a real celebrity, keep it as "resembling {English name}" (strong face anchor for the image model); if the setting names none, do NOT invent one;\n' +
      '- Do not invent details absent from the materials; extract ONLY 「' + name + '」, ignore all other characters;\n' +
      '- Output the description itself only, no explanations or prefixes.'
    : '你是生图外貌提取助手。从给定材料中提取名为「' + name + '」的女性角色的外貌与身材，输出一段不超过 120 字的中文描述，用于文生图模型保持人物一致性。\n' +
    '取材优先级【严格】：优先使用设定原文（角色卡设定 / 回复中该角色的人物卡、设定段）里的容貌身材描写；设定里找不到时，才使用状态栏的样貌/身材字段；都找到时以设定为准，状态栏仅作补充。\n' +
    '要求：\n' +
    '- 只包含：年龄、脸型五官、发型发色、眼色、身高体型（转化为高挑/娇小等相对词，禁止写具体厘米数）、身材曲线特点、肤质；\n' +
    '- 以"一位{N}岁女性"开头——年龄取设定，未写则按气质推断，必须是成年人；\n' +
    '- 禁止衣着描写、性格、身份、背景、口癖；\n' +
    '- 禁止真实名人姓名（"神似某明星"转化为对那种典型五官气质的描述，只描述不点名）；\n' +
    '- 禁止罩杯字母与单一部位的形状特写，只用整体轮廓词（丰满/纤细/曲线分明等）；\n' +
    '- 材料里没有的信息不要发明；只提取「' + name + '」一个人，其他角色的描写一律忽略；\n' +
    '- 只输出描述段落本身，不要任何解释或前后缀。';
  const userContent = (charDesc ? '【角色卡设定】\n' + charDesc + '\n\n' : '') +
    '【本轮回复（含状态栏）】\n' + (replyContent || '').slice(0, 6000);
  const result = await sendChat([
    { role: 'system', content: system },
    { role: 'user', content: userContent }
  ], { api: resolveMemoryApi(apiConfig), usageContext: { characterId: character.id, characterName: character.name, kind: 'chat' } });
  const cleaned = (result || '').trim().replace(/^["'「『]+|["'」』]+$/g, '');
  if (!cleaned) throw new Error('提取结果为空');
  return cleaned;
}

// ---------- 免费生图记忆（pollinations 英文锚点，锁外貌） ----------
// 与中文锚点（chat.appearanceAnchors，付费管线用）物理隔离：
// 免费模式的锚点存在 chat.seedArchive[name].anchor 里，由 App 机械拼进 pollinations URL，
// 不进 system prompt（AI 看到会照抄进 prompt 造成重复），不依赖 AI 每轮抄设定。

/** 把英文锚点机械拼进 pollinations URL 的 prompt 最前；幂等（已含锚点则不重复拼） */
export function spliceAnchorIntoPollinationsUrl(url, anchor) {
  const head = (anchor || '').trim().replace(/[。\.\s]+$/g, '');
  if (!head) return url;
  const m = String(url || '').match(/^(https:\/\/image\.pollinations\.ai\/prompt\/)([^?\s)]+)(\?[^\s)]*)$/);
  if (!m) return url;
  let prompt;
  try { prompt = decodeURIComponent(m[2]); } catch (e) { prompt = m[2]; }
  if (prompt.includes(head.slice(0, 20))) return url; // 幂等检查（前 20 字符足以判定）
  return m[1] + encodeURIComponent(head + ', ' + prompt) + m[3];
}

/**
 * 回复落盘前处理免费模式插图 URL：确保该角色已登记英文锚点（缺失时调副 API 提取一次），
 * 并把锚点拼进 URL。仅 pollinations 模式生效；任何失败都静默跳过（退回 AI 自由写词）。
 * @returns {Promise<boolean>} msg.content 是否有改动
 */
export async function ensurePollinationsAnchors(msg, chat, character) {
  if (!msg || !msg.content || !msg.content.includes('image.pollinations.ai')) return false;
  const config = await getConfig().catch(() => ({}));
  if (!(config.ui && config.ui.imageEnabled === true)) return false;
  const provider = (config.image && config.image.provider) || 'pollinations';
  if (provider !== 'pollinations') return false;

  const re = /!\[([^\]]+)\]\((https:\/\/image\.pollinations\.ai\/prompt\/[^?\s)]+(\?[^\s)]*))\)/g;
  const matches = [...msg.content.matchAll(re)];
  if (!matches.length) return false;
  if (!chat.seedArchive) chat.seedArchive = {};

  let content = msg.content;
  let changed = false;
  for (const m of matches) {
    const name = m[1].trim();
    if (!name) continue;
    let rec = chat.seedArchive[name];
    if (typeof rec === 'number') rec = chat.seedArchive[name] = { seed: rec, anchor: '' }; // 旧形态防御
    if (!rec || typeof rec !== 'object') continue; // 未登记种子（理论上种子扫描先跑）不拼锚点
    if (!rec.anchor) {
      try {
        rec.anchor = await extractNamedAppearanceAnchor({
          name, replyContent: msg.content, character, apiConfig: config.api || {}, english: true
        });
        changed = true;
      } catch (e) {
        continue; // 提取失败：本轮退回自由拼词，下轮再试
      }
    }
    const newUrl = spliceAnchorIntoPollinationsUrl(m[2], rec.anchor);
    if (newUrl !== m[2]) {
      content = content.split(m[0]).join(`![${m[1]}](${newUrl})`);
      changed = true;
    }
  }
  if (changed) msg.content = content;
  return changed;
}
