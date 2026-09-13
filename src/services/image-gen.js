/**
 * 付费生图服务：火山方舟 Seedream / Google Gemini / xAI Grok Imagine
 *
 * Seedream：POST {baseUrl}/images/generations，Bearer 认证，data[0].b64_json 返回
 * 万相（阿里百炼）：POST {host}/api/v1/services/aigc/multimodal-generation/generation（DashScope 原生，
 *          Token Plan 网关同构；output.choices[*].message.content[*].image 取临时 URL 转存）
 * Grok   ：POST {baseUrl}/images/generations，Bearer 认证（OpenAI 兼容格式），
 *          data[0].b64_json 返回；官方 imgen.x.ai 的 url 会过期，b64_json 优先
 * Gemini ：POST {baseUrl}/v1beta/models/{model}:generateContent，
 *          key 同时放 x-goog-api-key 请求头与 ?key= 查询参数（部分中转站只认其一），
 *          图片在 candidates[].content.parts[].inlineData.data（base64），
 *          安全拦截表现为 promptFeedback.blockReason / finishReason=SAFETY / 无图片候选
 *
 * 提示词流水线分叉：
 *   严格版（Seedream / Gemini）——方案 A 纯机械：
 *     外貌锚点 + 衣着模板库随机一行 + 可选镜头词 → 硬过滤 → 生成
 *     不写表情/场景/剧情姿态；不 compose、不 sanitize；被拒同装重试，末次 L2 家居服
 *   Grok / 手动网页版——副 API 管线：
 *     回复正文 → compose 总结 → sanitize 预审 → 生成
 *     → 被拒：L1 改写重试 → 再拒：L2 机械降级纯肖像
 */

// 付费/本地服务商判断：seedream/wanx/grok/gemini/manual/grokweb 都走"AI 空标记 + 本地出图"模式
//（manual = 手动网页版：App 只出提示词，用户自行到网页版生图后选图插入；
// grokweb = 局域网自托管反代：grok.com 网页账号出的图，走 chat/completions 聊天格式）
export function isPaidImageProvider(provider) {
  return provider === 'seedream' || provider === 'wanx' || provider === 'grok' || provider === 'gemini' || provider === 'manual' || provider === 'grokweb';
}

// 严格版机械生图：Seedream / 万相 / Gemini（无 compose，单人 only）
export function isStrictMechanicalProvider(provider) {
  return provider === 'seedream' || provider === 'wanx' || provider === 'gemini';
}

// 服务商显示名（加载占位/通知栏文案用）
export function imageProviderDisplayName(provider) {
  if (provider === 'wanx') return '万相生图';
  if (provider === 'grok') return 'Grok 生图';
  if (provider === 'gemini') return 'Gemini 生图';
  if (provider === 'manual') return '手动网页版';
  if (provider === 'grokweb') return 'Grok 网页反代';
  return '火山生图';
}

import { sendChat } from './api.js';
import { resolveMemoryApi } from './api-memory.js';
import { getConfig } from './storage.js';

// ---------- 外貌身材锚点（生图人物一致性记忆，按角色名登记） ----------
// 与插图种子档案同构：{ 角色名: 外貌描述 } 存在对话（chat.appearanceAnchors）里，记忆页可编辑。
// 名字取自插图标记的 alt（AI 按输出格式写的就是状态栏里的她）；新名字首次生图后自动提取登记，
// 之后同名角色生图逐字注入锚点，保证同一个 NPC 每张图都是同一张脸。不进对话上下文，只占生图管线。

// 为指定名字提取外貌身材锚点：容貌身材优先取设定原文（女主=角色卡设定，NPC=回复里的人物卡/设定段），
// 设定里没有才退到状态栏的样貌/身材字段。只在首次登记时调用一次。
export async function extractNamedAppearanceAnchor({ name, replyContent, character, apiConfig, english = false }) {
  const isHeroine = name && character && name === character.name;
  // 设定来源：女主读角色卡全文（一次性调用，不省这几千 token，长卡也要读全）；
  // NPC 的设定（随机 NPC 人物卡）就在回复正文里，和状态栏一起给
  const charDesc = isHeroine ? (character.description || '').slice(0, 30000) : '';
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

/**
 * 调用 seedream 生成一张图，返回 data:image/...;base64,... 形式的 data URL
 * @param {Object} opts
 * @param {string} opts.apiKey  Agent Plan 专属 Key / 方舟 API Key
 * @param {string} opts.baseUrl 例如 https://ark.cn-beijing.volces.com/api/plan/v3
 * @param {string} opts.model   例如 doubao-seedream-5.0-lite
 * @param {string} opts.size    档位（2K/3K/4K）或像素值（如 1664x2496）
 * @param {string} opts.prompt  提示词（中文原生支持，建议 ≤300 汉字）
 */
export async function generateSeedreamImage({ apiKey, baseUrl, model, size, prompt }) {
  if (!apiKey) throw new Error('未配置 Seedream API Key（在其他设置 → 插图功能中填写）');
  if (!prompt || !prompt.trim()) throw new Error('提示词为空');

  const url = `${(baseUrl || '').replace(/\/+$/, '')}/images/generations`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'doubao-seedream-5.0-lite',
        prompt: prompt.trim(),
        size: size || '2K',
        response_format: 'b64_json',
        output_format: 'jpeg',
        watermark: false
      })
    });
  } catch (e) {
    throw new Error(`网络请求失败：${e.message || e}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || json.message || text;
      } catch (e2) {
        detail = text;
      }
    } catch (e3) {
      detail = '无法读取错误响应';
    }
    throw new Error(`生图 API 请求失败 (${response.status})：${detail}`);
  }

  const data = await response.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('生图 API 未返回图片数据');
  return `data:image/jpeg;base64,${b64}`;
}

// 把远程图片 URL 拉下来转成 data URL（临时图床链接会过期，不能直接存）
async function fetchUrlAsDataUrl(imgUrl) {
  const imgResp = await fetch(imgUrl);
  if (!imgResp.ok) throw new Error(`图片下载失败 (${imgResp.status})`);
  const blob = await imgResp.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片转换失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 调用阿里百炼万相生图，返回 data URL
 * 万相不走 OpenAI 兼容的 /images/generations（该路径只对齐对话/向量），
 * 官方文生图是 DashScope 原生多模态端点（同步返回，Token Plan 网关同构）：
 *   POST {host}/api/v1/services/aigc/multimodal-generation/generation
 *   请求 {model, input:{messages:[{role:"user",content:[{text:prompt}]}]}, parameters:{size}}
 *   响应 output.choices[*].message.content[*].image → 临时 URL，拉取转存
 * 用户只需填控制台给的 compatible-mode 地址，这里自动推导原生端点。
 * @param {Object} opts
 * @param {string} opts.apiKey  百炼 / Token Plan 专属 Key
 * @param {string} opts.baseUrl 例如 https://dashscope.aliyuncs.com/compatible-mode/v1 或 Token Plan 专属地址
 * @param {string} opts.model   例如 wan2.7-image / wan2.7-image-pro
 * @param {string} opts.size    万相尺寸（* 分隔，如 1024*1024、720*1280）
 * @param {string} opts.prompt  提示词
 */
function resolveWanxEndpoint(baseUrl) {
  const b = (baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').trim();
  const m = b.match(/^(https?:\/\/[^/]+)/i);
  const origin = m ? m[1] : b.replace(/\/+$/, '');
  return `${origin}/api/v1/services/aigc/multimodal-generation/generation`;
}

export async function generateWanxImage({ apiKey, baseUrl, model, size, prompt }) {
  if (!apiKey) throw new Error('未配置万相 API Key（在插图设置中填写）');
  if (!prompt || !prompt.trim()) throw new Error('提示词为空');

  const url = resolveWanxEndpoint(baseUrl);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'wan2.7-image',
        input: {
          messages: [{ role: 'user', content: [{ text: prompt.trim() }] }]
        },
        parameters: { size: size || '1024*1024' }
      })
    });
  } catch (e) {
    throw new Error(`网络请求失败：${e.message || e}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || json.message || text;
      } catch (e2) {
        detail = text;
      }
    } catch (e3) {
      detail = '无法读取错误响应';
    }
    throw new Error(`生图 API 请求失败 (${response.status})：${detail}`);
  }

  const data = await response.json();
  // 原生格式：output.choices[*].message.content 为分块数组，图片块带 image（临时 URL）
  const choices = data?.output?.choices || [];
  for (const choice of choices) {
    const parts = choice?.message?.content || [];
    for (const part of parts) {
      if (part?.image) return await fetchUrlAsDataUrl(part.image);
      if (part?.b64_json) return `data:image/png;base64,${part.b64_json}`;
    }
  }
  throw new Error('生图 API 未返回图片数据');
}

/**
 * 调用 xAI Grok Imagine 生成一张图，返回 data:image/...;base64,... 形式的 data URL
 * 接口与 Seedream 同为 OpenAI 兼容的 images/generations 格式，可走 xAI 中转站
 * @param {Object} opts
 * @param {string} opts.apiKey     xAI API Key / 中转站 Key
 * @param {string} opts.baseUrl    官方 https://api.x.ai/v1 或中转地址
 * @param {string} opts.model      grok-imagine-image / grok-imagine-image-quality
 * @param {string} opts.aspectRatio 宽高比（9:16/2:3/3:4/1:1/4:3/3:2/16:9）
 * @param {string} opts.resolution 1k / 2k
 * @param {string} opts.prompt     提示词（中文支持）
 */
export async function generateGrokImage({ apiKey, baseUrl, model, aspectRatio, resolution, prompt }) {
  if (!apiKey) throw new Error('未配置 Grok API Key（在其他设置 → 插图功能中填写）');
  if (!prompt || !prompt.trim()) throw new Error('提示词为空');

  const url = `${(baseUrl || 'https://api.x.ai/v1').replace(/\/+$/, '')}/images/generations`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: (model || 'grok-imagine-image').trim(),
        prompt: prompt.trim(),
        n: 1,
        aspect_ratio: aspectRatio || '9:16',
        resolution: resolution || '1k',
        response_format: 'b64_json'
      })
    });
  } catch (e) {
    throw new Error(`网络请求失败：${e.message || e}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || json.message || text;
      } catch (e2) {
        detail = text;
      }
    } catch (e3) {
      detail = '无法读取错误响应';
    }
    throw new Error(`生图 API 请求失败 (${response.status})：${detail}`);
  }

  const data = await response.json();
  const item = data?.data?.[0] || {};
  if (item.b64_json) {
    return `data:image/png;base64,${item.b64_json}`;
  }
  // 中转站可能忽略 response_format 只回 url：拉下来转 base64（url 会过期，不能直接存）
  if (item.url) {
    try {
      return await fetchUrlAsDataUrl(item.url);
    } catch (e) {
      throw new Error(`图片下载失败：${e.message || e}`);
    }
  }
  throw new Error('生图 API 未返回图片数据');
}

// 中转 chat/completions 模式：把生图包装成 OpenAI 聊天接口的应答里提取图片
// content 可能的形态：markdown 图片链接 / 裸 URL / data: URI / image_url 数组部件
async function extractImageFromChatContent(content) {
  if (!content) throw new Error('中转站未返回图片数据');
  if (Array.isArray(content)) {
    for (const part of content) {
      const url = part?.image_url?.url || part?.image_url?.uri || (part?.type === 'image' && part?.url);
      if (url) {
        return url.startsWith('data:') ? url : await fetchUrlAsDataUrl(url);
      }
      const b64 = part?.inlineData?.data || part?.inline_data?.data || part?.b64_json;
      if (b64) return `data:image/png;base64,${b64}`;
    }
    throw new Error('中转站返回内容中没有图片部件');
  }
  const text = String(content);
  if (text.includes('data:image')) {
    const m = text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/);
    if (m) return m[0].replace(/\s/g, '');
  }
  const md = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/) || text.match(/(https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|webp)[^\s)"'<>]*)/i) || text.match(/(https?:\/\/[^\s)"'<>]+)/);
  if (md) return await fetchUrlAsDataUrl(md[1]);
  throw new Error(`中转站未返回图片：${text.slice(0, 120)}`);
}

/**
 * 中转站 chat/completions 生图：POST {baseUrl}/v1/chat/completions，OpenAI 兼容格式
 * 部分中转站把 Gemini Flash Image 等模型包装在这个端点下
 */
async function generateGeminiImageViaChat({ apiKey, baseUrl, model, prompt }) {
  const root = (baseUrl || '').replace(/\/+$/, '');
  if (!root) throw new Error('中转模式需要填写 Base URL（中转站地址）');
  const url = /\/chat\/completions$/.test(root) ? root
    : /\/v1$/.test(root) ? `${root}/chat/completions`
    : `${root}/v1/chat/completions`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: (model || 'gemini-3.1-flash-image').trim(),
        messages: [{ role: 'user', content: prompt.trim() }],
        stream: false
      })
    });
  } catch (e) {
    throw new Error(`网络请求失败：${e.message || e}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || json.message || text;
      } catch (e2) {
        detail = text;
      }
    } catch (e3) {
      detail = '无法读取错误响应';
    }
    throw new Error(`生图 API 请求失败 (${response.status})：${detail}`);
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message || {};
  return await extractImageFromChatContent(message.content);
}

/**
 * 构造 grokweb（局域网自托管反代）chat/completions 生图请求体（纯函数，可单测）。
 * 反代（如 fandai）把 grok.com 网页账号包装成 OpenAI 聊天接口：发普通聊天请求，
 * 网页版出图后图片以 markdown 链接混在回复文本里（图片后出也会等齐——见反代 WS 收流逻辑）。
 */
export function buildGrokWebChatBody(model, prompt) {
  return {
    model: (model || 'grok-4.6-fast').trim(),
    messages: [
      {
        role: 'user',
        content: `请生成一张图片：${prompt.trim()}\n要求：直接出图，画面按描述执行，不要输出任何解释或询问。`
      }
    ],
    stream: false
  };
}

/**
 * grokweb 网页反代生图：POST {baseUrl}/chat/completions，OpenAI 兼容聊天格式
 * 适配 fandai 类反代：grok.com 网页版无 /images/generations，图片经回复文本的
 * markdown 链接返回（链接已指向反代 /image-proxy 回源，key 内嵌可直接下载）。
 * @param {Object} opts
 * @param {string} opts.apiKey  反代的 api_key（config.yaml 里的自定义 key）
 * @param {string} opts.baseUrl 反代地址，如 http://192.168.2.42:8000/v1（兼容填到 /chat/completions）
 * @param {string} opts.model   反代模型名，默认 grok-4.6-fast
 * @param {string} opts.prompt  提示词（中文支持）
 */
export async function generateGrokWebImage({ apiKey, baseUrl, model, prompt }) {
  if (!apiKey) throw new Error('未配置反代 API Key（插图设置 → Grok 网页反代 中填写）');
  if (!prompt || !prompt.trim()) throw new Error('提示词为空');
  const root = (baseUrl || '').replace(/\/+$/, '');
  if (!root) throw new Error('Grok 网页反代需要填写 Base URL（反代地址，如 http://192.168.x.x:8000/v1）');
  const url = /\/chat\/completions$/.test(root) ? root
    : /\/v1$/.test(root) ? `${root}/chat/completions`
    : `${root}/v1/chat/completions`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(buildGrokWebChatBody(model, prompt))
    });
  } catch (e) {
    throw new Error(`网络请求失败：${e.message || e}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || json.message || text;
      } catch (e2) {
        detail = text;
      }
    } catch (e3) {
      detail = '无法读取错误响应';
    }
    throw new Error(`反代生图请求失败 (${response.status})：${detail}`);
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message || {};
  return await extractImageFromChatContent(message.content);
}

/**
 * 调用 Gemini 生图模型（Nano Banana 系列），返回 data:image/...;base64,... 形式的 data URL
 * @param {Object} opts
 * @param {string} opts.apiKey     Gemini API Key / 中转站 Key
 * @param {string} opts.baseUrl    官方 https://generativelanguage.googleapis.com 或中转地址
 * @param {string} opts.model      如 gemini-3.1-flash-lite-image / gemini-3-pro-image
 * @param {string} opts.aspectRatio 宽高比（9:16/2:3/3:4/1:1/16:9 等）
 * @param {string} opts.imageSize  1K/2K/4K（Lite 仅支持 1K）
 * @param {string} opts.prompt     提示词（中文支持）
 * @param {string} opts.apiMode    'generateContent'（官方，默认）| 'chatCompletions'（中转 OpenAI 聊天格式）
 */
export async function generateGeminiImage({ apiKey, baseUrl, model, aspectRatio, imageSize, prompt, apiMode }) {
  if (!apiKey) throw new Error('未配置 Gemini API Key（在其他设置 → 插图功能中填写）');
  if (!prompt || !prompt.trim()) throw new Error('提示词为空');

  // 中转站把 Gemini 生图包装成 OpenAI chat/completions 的情况：走完全不同的请求/应答格式
  if (apiMode === 'chatCompletions') {
    return await generateGeminiImageViaChat({ apiKey, baseUrl, model, prompt });
  }

  const modelId = (model || 'gemini-3.1-flash-lite-image').trim();
  const root = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  // key 同时放请求头与查询参数：官方认 header，部分中转站只认 ?key=
  const url = `${root}/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt.trim() }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: aspectRatio || '9:16',
            imageSize: imageSize || '1K'
          }
        }
      })
    });
  } catch (e) {
    throw new Error(`网络请求失败：${e.message || e}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || json.message || text;
      } catch (e2) {
        detail = text;
      }
    } catch (e3) {
      detail = '无法读取错误响应';
    }
    throw new Error(`生图 API 请求失败 (${response.status})：${detail}`);
  }

  const data = await response.json();

  // 安全拦截形态一：prompt 级直接拒绝
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`内容被 Gemini 安全审核拦截（${blockReason}），已触发自动改写重试`);
  }

  const candidates = data?.candidates || [];
  // 安全拦截形态二：候选被 finishReason 标记（IMAGE_SAFETY / SAFETY / BLOCKLIST 等）
  const safetyFinish = candidates.find(c => /SAFETY|BLOCK|PROHIBITED/i.test(c?.finishReason || ''));
  if (safetyFinish) {
    throw new Error(`内容被 Gemini 安全审核拦截（${safetyFinish.finishReason}），已触发自动改写重试`);
  }

  // 从所有候选的所有 parts 里找图片（兼容 inlineData / inline_data 两种命名）
  for (const cand of candidates) {
    for (const part of (cand?.content?.parts || [])) {
      const inline = part.inlineData || part.inline_data;
      if (inline && inline.data) {
        const mime = inline.mimeType || inline.mime_type || 'image/png';
        return `data:${mime};base64,${inline.data}`;
      }
    }
  }

  // 无图：把模型返回的文本片段（通常是拒绝理由）带进错误信息，方便诊断
  const textSnippet = candidates
    .flatMap(c => (c?.content?.parts || []))
    .map(p => p.text || '')
    .join(' ')
    .slice(0, 120);
  throw new Error(`Gemini 未返回图片数据${textSnippet ? `：${textSnippet}` : ''}`);
}

// ---------- 提示词流水线（副 API） ----------

// 判断是否内容审核类错误（网络/鉴权/限流错误不该触发改写重试）
function isModerationError(err) {
  const msg = (err && err.message) || '';
  return /敏感|违规|审核|不合规|不适宜|risk|safety|moderation|inappropriate|policy|blocked/i.test(msg);
}

// 风格锚定后缀：App 层固定拼接，保证各轮插图风格一致（不依赖副 API 自觉，清洗改写也洗不掉）
// 风格后缀：每条提示词末尾必带。Grok 官方建议的反漫画感压舱石 + 皮肤质感词（抗塑料感/AI 感），
// 中英混杂不如纯英文术语直接；compose 规则里的"写实摄影风格"约束照常生效
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
function fillOutfitTemplate(template) {
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
function replaceOutfitMarker(prompt, filledOutfit) {
  if (!prompt || prompt.indexOf('私密衣着') === -1) return prompt;
  return prompt.replace(OUTFIT_MARKER_RE, filledOutfit)
    .replace(/，{2,}/g, '，').replace(/，([。！？])/g, '$1').replace(/(^，)|(，$)/g, '').trim();
}

// 便捷封装：填充模板（随机抽色）并替换；多次调用的场景（重试循环）应先自行 fill 再逐次 replace，保证同色
function applyForcedOutfit(prompt, template) {
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

function pickRandomOutfitLine(library, fallbackLibrary) {
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
function buildStrictBodyPrompt({ anchorText, outfitFilled, shotWords, l2 }) {
  const subject = (anchorText || '').trim() || FALLBACK_SUBJECT;
  const orient = (!l2 && shotWords && shotWords.head) ? shotWords.head : '';
  const outfit = l2 ? L2_STRICT_OUTFIT : (outfitFilled || L2_STRICT_OUTFIT);
  const tail = l2
    ? '半身取景'
    : (shotWords && shotWords.tail ? shotWords.tail : '');
  return joinPromptParts([subject, orient, outfit, tail]);
}

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
  const charDesc = (character.description || '').slice(0, 4000);
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
  if (imgCfg.provider === 'grok') {
    const gk = imgCfg.grok || {};
    return (prompt) => generateGrokImage({ ...gk, prompt });
  }
  if (imgCfg.provider === 'grokweb') {
    const gw = imgCfg.grokweb || {};
    return (prompt) => generateGrokWebImage({ ...gw, prompt });
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
  const anchorText = (anchorName && anchors) ? anchors[anchorName] : '';
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
      const dataUrl = await generate(finalPrompt);
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
 */
export async function generateIllustrationFromPrompt({ prompt, config }) {
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
    const dataUrl = await generate(finalPrompt);
    return { dataUrl, prompt: finalPrompt };
  } catch (e) {
    e.imagePrompt = clean;
    throw e;
  }
}
