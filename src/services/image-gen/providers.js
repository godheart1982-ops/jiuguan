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
  return provider === 'seedream' || provider === 'wanx' || provider === 'openai' || provider === 'grok' || provider === 'gemini' || provider === 'manual' || provider === 'grokweb';
}

// 严格版机械生图：Seedream / 万相 / Gemini / OpenAI（无 compose，单人 only）
export function isStrictMechanicalProvider(provider) {
  return provider === 'seedream' || provider === 'wanx' || provider === 'gemini' || provider === 'openai';
}

// 服务商显示名（加载占位/通知栏文案用）
export function imageProviderDisplayName(provider) {
  if (provider === 'wanx') return '万相生图';
  if (provider === 'openai') return 'OpenAI 生图';
  if (provider === 'grok') return 'Grok 生图';
  if (provider === 'gemini') return 'Gemini 生图';
  if (provider === 'manual') return '手动网页版';
  if (provider === 'grokweb') return 'Grok 网页反代';
  return '火山生图';
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
  if (!apiKey) throw new Error('未配置 Seedream API Key（在侧边栏「插图设置」中填写）');
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
/**
 * 构造 xAI Grok 生图请求体（纯函数，可单测）。
 * 无参考图走 /images/generations；有参考图走 /images/edits（application/json，支持 image 或 images）。
 */
export function buildGrokImageRequestBody({ model, aspectRatio, resolution, prompt, images } = {}) {
  const validImages = (Array.isArray(images) ? images : []).filter((u) => typeof u === 'string' && u.startsWith('data:image/'));
  const isEdit = validImages.length > 0;
  const rawPrompt = String(prompt || '').trim();
  const finalPrompt = isEdit && !rawPrompt.startsWith("Use the exact woman's face")
    ? `${OPENAI_REF_IMAGE_PROMPT_PREFIX}${rawPrompt}`
    : rawPrompt;

  const body = {
    model: (model || 'grok-imagine-image').trim() || 'grok-imagine-image',
    prompt: finalPrompt,
    n: 1,
    aspect_ratio: aspectRatio || '9:16',
    resolution: resolution || '1k',
    response_format: 'b64_json'
  };

  if (validImages.length === 1) {
    body.image = { url: validImages[0], type: 'image_url' };
  } else if (validImages.length > 1) {
    body.images = validImages.map((url) => ({ url, type: 'image_url' }));
  }

  return { isEdit, body };
}

export async function generateGrokImage({ apiKey, baseUrl, model, aspectRatio, resolution, prompt, images, onMeta }) {
  if (!apiKey) throw new Error('未配置 Grok API Key（在侧边栏「插图设置」中填写）');
  if (!prompt || !prompt.trim()) throw new Error('提示词为空');

  const cleanBase = (baseUrl || 'https://api.x.ai/v1')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(images\/generations|images\/edits)$/i, '');
  const { isEdit, body } = buildGrokImageRequestBody({ model, aspectRatio, resolution, prompt, images });
  const url = `${cleanBase}/images/${isEdit ? 'edits' : 'generations'}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
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
  let out = '';
  if (item.b64_json) {
    out = `data:image/png;base64,${item.b64_json}`;
  } else if (item.url) {
    // 中转站可能忽略 response_format 只回 url：拉下来转 base64（url 会过期，不能直接存）
    try {
      out = await fetchUrlAsDataUrl(item.url);
    } catch (e) {
      throw new Error(`图片下载失败：${e.message || e}`);
    }
  } else {
    throw new Error('生图 API 未返回图片数据');
  }
  if (typeof onMeta === 'function') {
    onMeta({ mode: isEdit ? 'edits' : 'generations' });
  }
  return out;
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
 * images：可选，参考图 data URL 数组（OpenAI 多模态 image_url 部件，反代上限 4 张，超出截断）；
 * 带参考图时指令改为"容貌以参考图为准"，文字锚点继续管身材/场景。
 */
export function buildGrokWebChatBody(model, prompt, images) {
  const hasRef = Array.isArray(images) && images.length > 0;
  const text = hasRef
    ? `参考所附图片中人物的容貌特征（同一张脸、发型与神态），生成一张图片：${prompt.trim()}\n要求：直接出图，人物长相以参考图为准，身材与画面按描述执行，不要输出任何解释或询问。`
    : `请生成一张图片：${prompt.trim()}\n要求：直接出图，画面按描述执行，不要输出任何解释或询问。`;
  const content = hasRef
    ? [
        { type: 'text', text },
        ...images.slice(0, 4).map((u) => ({ type: 'image_url', image_url: { url: u } }))
      ]
    : text;
  return {
    model: (model || 'grok-4.6-fast').trim(),
    messages: [{ role: 'user', content }],
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
export async function generateGrokWebImage({ apiKey, baseUrl, model, prompt, images }) {
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
      body: JSON.stringify(buildGrokWebChatBody(model, prompt, images))
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
  if (!apiKey) throw new Error('未配置 Gemini API Key（在侧边栏「插图设置」中填写）');
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

const IMAGE_MODEL_HINT_RE = /image|dall-e|gpt-image|imagen|flux|sdxl|stable-diffusion|midjourney|ideogram|recraft|seedream|wanx|kolors|cogview|qwen-image|grok-imagine|kontext|banana/i;

function normalizeOpenAIBaseUrl(baseUrl) {
  return (baseUrl || 'https://api.openai.com/v1')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(images\/generations|images\/edits|chat\/completions)$/i, '');
}

export const OPENAI_REF_IMAGE_PROMPT_PREFIX = "Use the exact woman's face, facial features, and facial bone structure strictly from the reference image(s) (ignore any conflicting facial feature descriptions in the text below). Generate a single full-frame live-action film still (not a collage, split-screen, multi-angle turnaround sheet, or plain studio background) using the body figure, new hairstyle, accessories, clothing, pose, expression, and scene described below: ";

function supportsOpenAIRefImages(model) {
  return !/^dall-e-/i.test((model || 'gpt-image-1').trim() || 'gpt-image-1');
}

function dataUrlToBlob(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) throw new Error('参考图格式无效');
  const mime = m[1];
  const ext = mime.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return { blob: new Blob([bytes], { type: mime }), filename: `ref.${ext}` };
}

/**
 * 构造 OpenAI /images/edits multipart/form-data 请求体（用于角色外貌参考图出图）。
 */
export function buildOpenAIImageEditFormData({
  model, prompt, size, quality, images, inputFidelity = 'high', includeFidelity = true
} = {}) {
  const cleanModel = (model || 'gpt-image-1').trim() || 'gpt-image-1';
  const rawPrompt = String(prompt || '').trim();
  const finalPrompt = rawPrompt.startsWith("Use the exact woman's face")
    ? rawPrompt
    : `${OPENAI_REF_IMAGE_PROMPT_PREFIX}${rawPrompt}`;
  const fd = new FormData();
  fd.append('model', cleanModel);
  fd.append('prompt', finalPrompt);
  fd.append('n', '1');
  if (size && size !== 'auto') {
    fd.append('size', size);
  }
  if (quality && quality !== 'auto') {
    fd.append('quality', quality);
  }
  const fidelity = inputFidelity === 'low' ? 'low' : 'high';
  if (includeFidelity && /^(gpt-image|chatgpt-image)/i.test(cleanModel)) {
    fd.append('input_fidelity', fidelity);
  }
  const validImages = (Array.isArray(images) ? images : []).filter((u) => typeof u === 'string' && u.startsWith('data:image/'));
  const fieldName = validImages.length > 1 ? 'image[]' : 'image';
  validImages.forEach((imgUrl, idx) => {
    const { blob, filename } = dataUrlToBlob(imgUrl);
    fd.append(fieldName, blob, validImages.length > 1 ? `ref-${idx + 1}-${filename.split('.').pop()}` : filename);
  });
  return fd;
}

async function parseErrorMessage(resp) {
  const errText = await resp.text().catch(() => '');
  let errMsg = errText || `HTTP ${resp.status}`;
  try {
    const errJson = JSON.parse(errText);
    errMsg = errJson?.error?.message || errJson?.message || errMsg;
  } catch {}
  return errMsg;
}

/**
 * 构造 OpenAI /images/generations 请求体。
 * gpt-image-* 模型不接受 response_format 参数（传了会报 400），仅 dall-e-* 附带 response_format: 'b64_json'。
 */
export function buildOpenAIImageRequestBody({ model, prompt, size, quality } = {}) {
  const cleanModel = (model || 'gpt-image-1').trim() || 'gpt-image-1';
  const body = {
    model: cleanModel,
    prompt,
    n: 1
  };
  if (size && size !== 'auto') {
    body.size = size;
  }
  if (quality && quality !== 'auto') {
    body.quality = quality;
  }
  if (/^dall-e-/i.test(cleanModel)) {
    body.response_format = 'b64_json';
  }
  return body;
}

async function extractOpenAIImageDataUrl(data) {
  const item = data?.data?.[0];
  if (item?.b64_json) {
    const rawFmt = (data?.output_format || 'png').toLowerCase();
    const fmt = rawFmt === 'jpg' ? 'jpeg' : rawFmt;
    return `data:image/${fmt};base64,${item.b64_json}`;
  }
  if (item?.url) {
    return await fetchUrlAsDataUrl(item.url);
  }
  throw new Error('OpenAI 未返回图片数据');
}

/**
 * 调用 OpenAI 官方或兼容中转站的 /images/generations（纯文生图）或 /images/edits（带参考图）接口生图。
 * 返回 data URL（data:image/...;base64,...），若返回临时 URL 则自动转存为本地 data URL。
 */
export async function generateOpenAIImage({ baseUrl, apiKey, model, prompt, size, quality, inputFidelity = 'high', images, onMeta }) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('请先在插图设置里填写 OpenAI API Key');
  }
  const cleanKey = apiKey.trim();
  const cleanModel = (model || 'gpt-image-1').trim() || 'gpt-image-1';
  const validImages = (Array.isArray(images) ? images : []).filter((u) => typeof u === 'string' && u.startsWith('data:image/'));

  if (validImages.length > 0 && supportsOpenAIRefImages(cleanModel)) {
    const cleanBase = normalizeOpenAIBaseUrl(baseUrl);
    const editEndpoint = `${cleanBase}/images/edits`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const fd = buildOpenAIImageEditFormData({
        model: cleanModel,
        prompt,
        size,
        quality,
        images: validImages,
        inputFidelity,
        includeFidelity: attempt === 0
      });
      const resp = await fetch(editEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cleanKey}`
        },
        body: fd
      });
      if (resp.ok) {
        const out = await extractOpenAIImageDataUrl(await resp.json());
        if (typeof onMeta === 'function') {
          const sentFidelity = attempt === 0 && /^(gpt-image|chatgpt-image)/i.test(cleanModel)
            ? (inputFidelity === 'low' ? 'low' : 'high')
            : null;
          onMeta({ mode: 'edits', inputFidelity: sentFidelity, downgraded: attempt === 1 });
        }
        return out;
      }
      const errMsg = await parseErrorMessage(resp);
      const isFidelityUnsupported = attempt === 0 && resp.status === 400
        && /input_fidelity|unknown parameter|unrecognized/i.test(errMsg);
      if (isFidelityUnsupported) continue;
      throw new Error(`OpenAI 生图失败 (${resp.status}): ${errMsg}`);
    }
  }

  const cleanBase = (baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const endpoint = /\/images\/generations$/i.test(cleanBase)
    ? cleanBase
    : `${cleanBase}/images/generations`;

  const body = buildOpenAIImageRequestBody({ model: cleanModel, prompt, size, quality });

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cleanKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errMsg = await parseErrorMessage(resp);
    throw new Error(`OpenAI 生图失败 (${resp.status}): ${errMsg}`);
  }

  const out = await extractOpenAIImageDataUrl(await resp.json());
  if (typeof onMeta === 'function') {
    onMeta({ mode: 'generations', skippedRefImage: validImages.length > 0 });
  }
  return out;
}

/**
 * 从 OpenAI 或兼容中转站 GET /models 抓取可用模型列表。
 * 将疑似生图模型优先排在前面，返回 { all, imageLikely }。
 */
export async function fetchOpenAIModels({ baseUrl, apiKey }) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('请先填写 API Key');
  }
  const cleanBase = normalizeOpenAIBaseUrl(baseUrl);
  const endpoint = `${cleanBase}/models`;

  const resp = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey.trim()}`
    }
  });

  if (!resp.ok) {
    const errMsg = await parseErrorMessage(resp);
    throw new Error(`获取模型失败 (${resp.status}): ${errMsg}`);
  }

  const json = await resp.json();
  const rawList = Array.isArray(json?.data)
    ? json.data
    : (Array.isArray(json) ? json : (Array.isArray(json?.models) ? json.models : []));

  const unique = new Set();
  for (const item of rawList) {
    const id = typeof item === 'string' ? item.trim() : String(item?.id || item?.name || '').trim();
    if (id) unique.add(id);
  }

  const imageLikely = [];
  const others = [];
  for (const id of unique) {
    if (IMAGE_MODEL_HINT_RE.test(id)) {
      imageLikely.push(id);
    } else {
      others.push(id);
    }
  }
  imageLikely.sort((a, b) => a.localeCompare(b));
  others.sort((a, b) => a.localeCompare(b));

  return {
    all: [...imageLikely, ...others],
    imageLikely
  };
}

// ---------- 提示词流水线（副 API） ----------

// 判断是否内容审核类错误（网络/鉴权/限流错误不该触发改写重试）
export function isModerationError(err) {
  const msg = (err && err.message) || '';
  return /敏感|违规|审核|不合规|不适宜|risk|safety|moderation|inappropriate|policy|blocked/i.test(msg);
}

// 风格锚定后缀：App 层固定拼接，保证各轮插图风格一致（不依赖副 API 自觉，清洗改写也洗不掉）
// 风格后缀：每条提示词末尾必带。Grok 官方建议的反漫画感压舱石 + 皮肤质感词（抗塑料感/AI 感），
