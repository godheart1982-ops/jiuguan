import { getConfig, saveConfig } from '../../services/storage.js';
import {
  generateSeedreamImage,
  generateGeminiImage,
  generateGrokImage,
  generateGrokWebImage,
  generateWanxImage,
  generateOpenAIImage,
  fetchOpenAIModels,
  DEFAULT_COMPOSE_SYSTEM_PROMPT,
  DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT,
  DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT,
  DEFAULT_GROK_OUTFIT_LIBRARY,
  resolveGrokOutfitLibrary,
  outfitLibraryToText,
  parseOutfitLibraryText,
  composeTestIllustrationPrompt,
  prepareFinalTestImagePrompt
} from '../../services/image-gen.js';
import { sendChat } from '../../services/api.js';
import { resolveMemoryApi } from '../../services/api-memory.js';
import { openBigTextEditor } from '../../utils/big-editor.js';
import { openImageLightbox } from '../../utils/image-lightbox.js';
import { escapeHtml } from './settings-shared.js';

export async function renderImageSettingsModal() {
  const existing = document.getElementById('image-settings-modal');
  if (existing) existing.remove();

  const config = await getConfig();
  const ui = config.ui || {};
  const image = config.image || {};
  const sd = image.seedream || {};
  const gm = image.gemini || {};
  const wx = image.wanx || {};
  const oa = image.openai || {};
  const gk = image.grok || {};
  const gw = image.grokweb || {};

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'image-settings-modal';

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>插图设置</h2>
        <button class="btn btn-ghost btn-icon" id="btn-close-image-settings">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-section">
          <div class="form-section-title">插图与生图</div>
<div class="form-group">
            <label class="form-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="setting-image-enabled" ${ui.imageEnabled === true ? 'checked' : ''}>
              <span>插图功能（AI 回复中自动生成场景插图）</span>
            </label>
            <div class="form-hint">开启后自动向 AI 注入插图规则：本轮出现女性角色时，AI 会在回复末尾输出插图模块。角色卡无需任何修改。</div>
          </div>
          <div class="form-group" id="group-image-provider">
            <label class="form-label">生图服务</label>
            <select class="form-input" id="setting-image-provider" ${ui.imageEnabled === true ? '' : 'disabled'}>
              <option value="pollinations" ${(image.provider || 'pollinations') === 'pollinations' ? 'selected' : ''}>pollinations（免费，在线链接）</option>
              <option value="seedream" ${image.provider === 'seedream' ? 'selected' : ''}>火山方舟 Seedream（付费，约 99 AFP/张）</option>
              <option value="wanx" ${image.provider === 'wanx' ? 'selected' : ''}>阿里百炼 万相（付费，compatible-mode）</option>
              <option value="gemini" ${image.provider === 'gemini' ? 'selected' : ''}>Google Gemini（付费，Nano Banana 系列）</option>
              <option value="openai" ${image.provider === 'openai' ? 'selected' : ''}>OpenAI 生图（付费，审核严格）</option>
              <option value="grok" ${image.provider === 'grok' ? 'selected' : ''}>xAI Grok Imagine（付费，审核宽松）</option>
              <option value="grokweb" ${image.provider === 'grokweb' ? 'selected' : ''}>Grok 网页反代（局域网自托管，grok.com 账号）</option>
              <option value="manual" ${image.provider === 'manual' ? 'selected' : ''}>手动模式（App 出提示词，自己到网页版生图后选图插入）</option>
            </select>
            <div class="form-hint">免费模式由 AI 直接拼在线生图 URL。严格版（Seedream/万相/Gemini）用外貌锚点 + 衣着模板库机械拼词后本地出图；Grok / 手动模式由副 API 总结提示词。图床 URL 会过期，本地存储不丢图。</div>
          </div>
          <div class="form-group" id="group-image-display">
            <label class="form-label">插图显示</label>
            <select class="form-input" id="setting-image-display" ${ui.imageEnabled === true ? '' : 'disabled'}>
              <option value="auto" ${(ui.imageDisplay || 'auto') === 'auto' ? 'selected' : ''}>自动加载</option>
              <option value="click" ${ui.imageDisplay === 'click' ? 'selected' : ''}>点击加载（省流量）</option>
              <option value="hide" ${ui.imageDisplay === 'hide' ? 'selected' : ''}>完全隐藏</option>
            </select>
            <div class="form-hint">仅影响 pollinations 在线图：点击加载=图片显示为占位按钮，点击才加载；完全隐藏=只显示一行提示文字。Seedream 本地图始终自动显示。</div>
          </div>
          <div id="group-pollinations-config">
            <div class="form-group">
              <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
                <input type="checkbox" id="setting-pollinations-nsfw" style="width: 16px; height: 16px; cursor: pointer;" ${image.pollinationsNsfw === true ? 'checked' : ''}>
                <span>允许 NSFW 提示词</span>
              </label>
              <div class="form-hint">仅免费模式（pollinations）。开启后提示词不再强制 SFW，衣着/身体/亲密描写按正文如实翻译；画面仍锁单人。被平台过滤时表现为图片加载失败，关掉开关即可恢复。</div>
            </div>
          </div>
          <div id="group-seedream-config">
            <div class="form-group">
              <label class="form-label">Seedream Base URL</label>
              <input class="form-input" id="setting-seedream-base-url" type="text" value="${escapeHtml(sd.baseUrl || 'https://ark.cn-beijing.volces.com/api/plan/v3')}" placeholder="https://ark.cn-beijing.volces.com/api/plan/v3">
              <div class="form-hint">Agent Plan 用 /api/plan/v3；普通方舟 API Key 用 /api/v3</div>
            </div>
            <div class="form-group">
              <label class="form-label">Seedream API Key</label>
              <input class="form-input" id="setting-seedream-api-key" type="password" value="${escapeHtml(sd.apiKey || '')}" placeholder="Agent Plan 专属 Key 或方舟 API Key">
            </div>
            <div class="form-group">
              <label class="form-label">生图模型</label>
              <input class="form-input" id="setting-seedream-model" type="text" value="${escapeHtml(sd.model || 'doubao-seedream-5.0-lite')}" placeholder="doubao-seedream-5.0-lite">
            </div>
            <div class="form-group">
              <label class="form-label">图片尺寸</label>
              <select class="form-input" id="setting-seedream-size">
                <option value="2K" ${(sd.size || '2K') === '2K' ? 'selected' : ''}>2K（由 AI 决定构图比例）</option>
                <option value="3K" ${sd.size === '3K' ? 'selected' : ''}>3K（更精细）</option>
                <option value="4K" ${sd.size === '4K' ? 'selected' : ''}>4K（最精细，生成慢）</option>
                <option value="1664x2496" ${sd.size === '1664x2496' ? 'selected' : ''}>竖版 2:3（1664×2496，适合单人立绘）</option>
                <option value="2496x1664" ${sd.size === '2496x1664' ? 'selected' : ''}>横版 3:2（2496×1664，适合场景）</option>
              </select>
              <div class="form-hint">Seedream 的像素尺寸是真实重采样，不是拉伸；竖版更适合角色插图。</div>
            </div>
          </div>
          <div id="group-wanx-config">
            <div class="form-group">
              <label class="form-label">万相 Base URL</label>
              <input class="form-input" id="setting-wanx-base-url" type="text" value="${escapeHtml(wx.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1')}" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1">
              <div class="form-hint">填控制台给的 compatible-mode 地址即可（如 https://dashscope.aliyuncs.com/compatible-mode/v1 或 Token Plan 专属地址）；万相文生图走 DashScope 原生端点，App 会按主机地址自动推导，无需手改。</div>
            </div>
            <div class="form-group">
              <label class="form-label">万相 API Key</label>
              <input class="form-input" id="setting-wanx-api-key" type="password" value="${escapeHtml(wx.apiKey || '')}" placeholder="百炼 / Token Plan 专属 Key（sk-...）">
            </div>
            <div class="form-group">
              <label class="form-label">生图模型</label>
              <input class="form-input" id="setting-wanx-model" type="text" value="${escapeHtml(wx.model || 'wan2.7-image')}" placeholder="wan2.7-image">
              <div class="form-hint">万相系列：wan2.7-image（标准）/ wan2.7-image-pro（更精细）</div>
            </div>
            <div class="form-group">
              <label class="form-label">图片尺寸</label>
              <input class="form-input" id="setting-wanx-size" type="text" value="${escapeHtml(wx.size || '1024*1024')}" placeholder="1024*1024">
              <div class="form-hint">万相尺寸用 * 分隔（不是 x）：1024*1024 方形、720*1280 竖版（适合立绘）、1280*720 横版（适合场景）。</div>
            </div>
          </div>
          <div id="group-gemini-config">
            <div class="form-group">
              <label class="form-label">接口格式</label>
              <select class="form-input" id="setting-gemini-api-mode">
                <option value="generateContent" ${(gm.apiMode || 'generateContent') === 'generateContent' ? 'selected' : ''}>官方 generateContent（默认，AI Studio key 用这个）</option>
                <option value="chatCompletions" ${gm.apiMode === 'chatCompletions' ? 'selected' : ''}>中转 chat/completions（OpenAI 聊天格式包装的生图）</option>
              </select>
              <div class="form-hint">你的中转站文档写「用 /v1/chat/completions 端点」就选第二种；中转模式和官方一致的才选第一种。中转模式下宽高比/尺寸参数由中转站决定，下方两个选项不生效。</div>
            </div>
            <div class="form-group">
              <label class="form-label">Gemini Base URL</label>
              <input class="form-input" id="setting-gemini-base-url" type="text" value="${escapeHtml(gm.baseUrl || 'https://generativelanguage.googleapis.com')}" placeholder="https://generativelanguage.googleapis.com">
              <div class="form-hint">官方模式默认即可；中转模式填中转站地址（到域名或 /v1 为止，路径由 App 自动拼接）。</div>
            </div>
            <div class="form-group">
              <label class="form-label">Gemini API Key</label>
              <input class="form-input" id="setting-gemini-api-key" type="password" value="${escapeHtml(gm.apiKey || '')}" placeholder="AI Studio 申请的 Gemini API Key">
            </div>
            <div class="form-group">
              <label class="form-label">生图模型 ID</label>
              <input class="form-input" id="setting-gemini-model" type="text" value="${escapeHtml(gm.model || 'gemini-3.1-flash-lite-image')}" placeholder="gemini-3.1-flash-lite-image">
              <div class="form-hint">Nano Banana 2 Lite = gemini-3.1-flash-lite-image（最便宜，仅 1K）；Nano Banana 2 = gemini-3.1-flash-image；Nano Banana Pro = gemini-3-pro-image（最高质量，支持 2K/4K）。</div>
            </div>
            <div class="form-group">
              <label class="form-label">宽高比</label>
              <select class="form-input" id="setting-gemini-aspect-ratio">
                <option value="9:16" ${(gm.aspectRatio || '9:16') === '9:16' ? 'selected' : ''}>竖版 9:16（适合单人立绘）</option>
                <option value="2:3" ${gm.aspectRatio === '2:3' ? 'selected' : ''}>竖版 2:3</option>
                <option value="3:4" ${gm.aspectRatio === '3:4' ? 'selected' : ''}>竖版 3:4</option>
                <option value="1:1" ${gm.aspectRatio === '1:1' ? 'selected' : ''}>方形 1:1</option>
                <option value="4:3" ${gm.aspectRatio === '4:3' ? 'selected' : ''}>横版 4:3</option>
                <option value="3:2" ${gm.aspectRatio === '3:2' ? 'selected' : ''}>横版 3:2</option>
                <option value="16:9" ${gm.aspectRatio === '16:9' ? 'selected' : ''}>横版 16:9（适合场景）</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">图片尺寸</label>
              <select class="form-input" id="setting-gemini-image-size">
                <option value="1K" ${(gm.imageSize || '1K') === '1K' ? 'selected' : ''}>1K（默认，Lite 仅支持此档）</option>
                <option value="2K" ${gm.imageSize === '2K' ? 'selected' : ''}>2K（需 Nano Banana 2 / Pro）</option>
                <option value="4K" ${gm.imageSize === '4K' ? 'selected' : ''}>4K（需 Nano Banana 2 / Pro，生成慢）</option>
              </select>
            </div>
          </div>
          <div id="group-grok-config">
            <div class="form-group">
              <label class="form-label">Grok Base URL</label>
              <div style="display: flex; gap: 8px; align-items: center;">
                <input class="form-input" id="setting-grok-base-url" type="text" value="${escapeHtml(gk.baseUrl || 'https://api.x.ai/v1')}" placeholder="https://api.x.ai/v1" style="flex: 1;">
                <button class="btn btn-secondary btn-small" id="btn-grok-reset-base-url" type="button" style="white-space: nowrap;">重置为官方地址</button>
              </div>
              <div class="form-hint">用中转站就填中转地址（一般到 /v1 为止，/images/generations、/images/edits 与 /models 由 App 自动拼接）；官方直连填 https://api.x.ai/v1。</div>
            </div>
            <div class="form-group">
              <label class="form-label">Grok API Key</label>
              <input class="form-input" id="setting-grok-api-key" type="password" value="${escapeHtml(gk.apiKey || '')}" placeholder="xAI API Key 或中转站 Key">
              <div class="form-hint">中转站 Key 不一定开通了生图权限——先保存后用下方「测试生图」验证，报错就说明不支持。</div>
            </div>
            <div class="form-group">
              <label class="form-label">生图模型 ID</label>
              <div style="display: flex; gap: 8px; align-items: center;">
                <input class="form-input" id="setting-grok-model" type="text" value="${escapeHtml(gk.model || 'grok-imagine-image')}" placeholder="grok-imagine-image" style="flex: 1;">
                <button class="btn btn-secondary btn-small" id="btn-grok-fetch-models" type="button" style="white-space: nowrap;">获取模型</button>
              </div>
              <select class="form-input" id="setting-grok-model-select" style="display: none; margin-top: 8px;"></select>
              <div class="form-hint" id="grok-models-status">可手动填写（如 grok-imagine-image、grok-imagine-image-2.0），或点击「获取模型」从接口拉取列表选择。</div>
            </div>
            <div class="form-group">
              <label class="form-label">宽高比</label>
              <select class="form-input" id="setting-grok-aspect-ratio">
                <option value="9:16" ${(gk.aspectRatio || '9:16') === '9:16' ? 'selected' : ''}>竖版 9:16（适合单人立绘）</option>
                <option value="2:3" ${gk.aspectRatio === '2:3' ? 'selected' : ''}>竖版 2:3</option>
                <option value="3:4" ${gk.aspectRatio === '3:4' ? 'selected' : ''}>竖版 3:4</option>
                <option value="1:1" ${gk.aspectRatio === '1:1' ? 'selected' : ''}>方形 1:1</option>
                <option value="4:3" ${gk.aspectRatio === '4:3' ? 'selected' : ''}>横版 4:3</option>
                <option value="3:2" ${gk.aspectRatio === '3:2' ? 'selected' : ''}>横版 3:2</option>
                <option value="16:9" ${gk.aspectRatio === '16:9' ? 'selected' : ''}>横版 16:9（适合场景）</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">分辨率</label>
              <select class="form-input" id="setting-grok-resolution">
                <option value="1k" ${(gk.resolution || '1k') === '1k' ? 'selected' : ''}>1k（默认）</option>
                <option value="2k" ${gk.resolution === '2k' ? 'selected' : ''}>2k（更精细，更贵）</option>
              </select>
            </div>
          </div>
          <div id="group-grokweb-config">
            <div class="form-group">
              <label class="form-label">反代 Base URL</label>
              <input class="form-input" id="setting-grokweb-base-url" type="text" value="${escapeHtml(gw.baseUrl || 'http://127.0.0.1:8000/v1')}" placeholder="http://192.168.x.x:8000/v1">
              <div class="form-hint">局域网反代地址（一般到 /v1 为止，/chat/completions 由 App 自动拼接）；本机填 http://127.0.0.1:8000/v1，手机用电脑局域网 IP。</div>
            </div>
            <div class="form-group">
              <label class="form-label">反代 API Key</label>
              <input class="form-input" id="setting-grokweb-api-key" type="password" value="${escapeHtml(gw.apiKey || '')}" placeholder="反代 config.yaml 里的 api_key">
              <div class="form-hint">grok.com 网页账号出的图经反代 markdown 图片链接返回，App 自动下载转本地存储，反代不在线也不丢历史图。</div>
            </div>
            <div class="form-group">
              <label class="form-label">模型名</label>
              <input class="form-input" id="setting-grokweb-model" type="text" value="${escapeHtml(gw.model || 'grok-4.6-fast')}" placeholder="grok-4.6-fast">
              <div class="form-hint">以反代 /v1/models 返回的为准；网页版无宽高比/分辨率参数，构图写进提示词即可（管线已自动带"竖向构图"等镜头词）。</div>
            </div>
          </div>
          <div id="group-openai-config">
            <div class="form-group">
              <label class="form-label">OpenAI Base URL</label>
              <div style="display: flex; gap: 8px; align-items: center;">
                <input class="form-input" id="setting-openai-base-url" type="text" value="${escapeHtml(oa.baseUrl || 'https://api.openai.com/v1')}" placeholder="https://api.openai.com/v1" style="flex: 1;">
                <button class="btn btn-secondary btn-small" id="btn-openai-reset-base-url" type="button" style="white-space: nowrap;">重置为官方地址</button>
              </div>
              <div class="form-hint">支持官方及 OpenAI 兼容中转站（一般到 /v1 为止，/images/generations 与 /models 由 App 自动拼接）。</div>
            </div>
            <div class="form-group">
              <label class="form-label">OpenAI API Key</label>
              <input class="form-input" id="setting-openai-api-key" type="password" value="${escapeHtml(oa.apiKey || '')}" placeholder="sk-...">
              <div class="form-hint">按调用次数计费且审核严格（自动套用严格版外貌锚点、衣着模板库与敏感词硬过滤）。</div>
            </div>
            <div class="form-group">
              <label class="form-label">生图模型</label>
              <div style="display: flex; gap: 8px; align-items: center;">
                <input class="form-input" id="setting-openai-model" type="text" value="${escapeHtml(oa.model || 'gpt-image-1')}" placeholder="gpt-image-1" style="flex: 1;">
                <button class="btn btn-secondary btn-small" id="btn-openai-fetch-models" type="button" style="white-space: nowrap;">获取模型</button>
              </div>
              <select class="form-input" id="setting-openai-model-select" style="display: none; margin-top: 8px;"></select>
              <div class="form-hint" id="openai-models-status">可手动填写（如 gpt-image-1、dall-e-3），或点击「获取模型」从接口拉取列表选择。</div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">图片尺寸</label>
                <select class="form-input" id="setting-openai-size">
                  <option value="auto" ${(oa.size || '1024x1536') === 'auto' ? 'selected' : ''}>auto（自动）</option>
                  <option value="1024x1536" ${(oa.size || '1024x1536') === '1024x1536' ? 'selected' : ''}>竖版 1024x1536（gpt-image-1 推荐）</option>
                  <option value="1024x1024" ${oa.size === '1024x1024' ? 'selected' : ''}>方形 1024x1024</option>
                  <option value="1536x1024" ${oa.size === '1536x1024' ? 'selected' : ''}>横版 1536x1024</option>
                  <option value="1024x1792" ${oa.size === '1024x1792' ? 'selected' : ''}>竖版 1024x1792（dall-e-3）</option>
                  <option value="1792x1024" ${oa.size === '1792x1024' ? 'selected' : ''}>横版 1792x1024（dall-e-3）</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">生成质量</label>
                <select class="form-input" id="setting-openai-quality">
                  <option value="auto" ${(oa.quality || 'auto') === 'auto' ? 'selected' : ''}>auto（默认）</option>
                  <option value="low" ${oa.quality === 'low' ? 'selected' : ''}>low（省钱，gpt-image）</option>
                  <option value="medium" ${oa.quality === 'medium' ? 'selected' : ''}>medium（均衡，gpt-image）</option>
                  <option value="high" ${oa.quality === 'high' ? 'selected' : ''}>high（精细，gpt-image）</option>
                  <option value="standard" ${oa.quality === 'standard' ? 'selected' : ''}>standard（dall-e-3）</option>
                  <option value="hd" ${oa.quality === 'hd' ? 'selected' : ''}>hd（dall-e-3）</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">参考图还原度（input_fidelity）</label>
              <select class="form-input" id="setting-openai-input-fidelity">
                <option value="high" ${(oa.inputFidelity || 'high') === 'high' ? 'selected' : ''}>high（推荐，高保真锁脸，四视图必备）</option>
                <option value="low" ${oa.inputFidelity === 'low' ? 'selected' : ''}>low（弱参考，仅大致风格参考）</option>
              </select>
              <div class="form-hint">仅上传了角色外貌参考图且使用 gpt-image 系列时生效；默认 high 锁紧五官，发型与服装靠提示词按剧情重绘。</div>
            </div>
          </div>
          <div id="group-paid-common">
            <div class="form-group" id="group-grok-person-mode">
              <label class="form-label">人物模式（仅 Grok / 手动）</label>
              <select class="form-input" id="setting-grok-person-mode">
                <option value="solo" ${((image.personMode || gk.personMode) || 'solo') === 'solo' ? 'selected' : ''}>单人（默认）：画面只有她</option>
                <option value="duo" ${(image.personMode || gk.personMode) === 'duo' ? 'selected' : ''}>双人：主控可入镜（成年男性，正脸不对镜头）</option>
              </select>
              <div class="form-hint">仅 Grok 与手动模式生效。严格版（Seedream/Gemini）固定单人，不提供双人。主控以背影/侧脸入镜；单人/双人 compose 指令分开存储。</div>
            </div>
            <div class="form-group" id="group-compose-prompt">
              <label class="form-label">生图提示词系统指令（compose）</label>
              <div class="form-hint" id="compose-mode-hint" style="color: var(--accent, #7c9eff);"></div>
              <textarea class="form-input" id="setting-seedream-compose-prompt" rows="10" style="font-family: monospace; font-size: 0.85rem;"></textarea>
              <div class="form-hint">自定义副 API 总结生图提示词时的 system prompt。严格版（Seedream / 万相 / Gemini / OpenAI）与 Grok 单人/双人<strong>分开存储</strong>，留空则用内置默认。占位符：{charDesc}、{replyContent}。</div>
              <div class="form-row" style="margin-top: 8px; gap: 8px;">
                <button class="btn btn-ghost" id="btn-seedream-compose-reset">↺ 恢复默认</button>
                <button class="btn btn-ghost" id="btn-seedream-compose-test">🧪 测试总结</button>
              </div>
            </div>
            <div class="form-group" id="group-grok-forced-outfit">
              <label class="form-label">私密场景强制衣着库（Grok / 手动）</label>
              <textarea class="form-input" id="setting-grok-outfit-library" rows="6" style="font-family: monospace; font-size: 0.85rem;"></textarea>
              <div class="form-hint">compose 在暧昧场景输出【私密衣着】时，系统从本库<strong>随机抽一行</strong>机械替换。一行一套；支持 {颜色}/{同色}/{配色}。默认仅 1 条，可自行往下加。与默认完全一致则存空。</div>
              <div class="form-row" style="margin-top: 8px; gap: 8px;">
                <button class="btn btn-ghost" id="btn-grok-outfit-reset">↺ 恢复默认（1 条）</button>
              </div>
            </div>
            <div class="form-group" id="group-test-image">
              <div class="form-label-with-action">
                <label class="form-label">测试生图</label>
                <button class="btn btn-ghost btn-small" id="btn-edit-test-prompt">⛶ 展开编辑</button>
              </div>
              <textarea class="form-input" id="setting-seedream-test-prompt" rows="3" placeholder="留空点「测试生图」会自动调用副 API 随机生成一段画面描述并出图；也可以先点「副 API 随机出词」预览或手动修改"></textarea>
              <div id="group-test-ref-image" style="display: none; margin-top: 8px;">
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                  <img id="test-ref-image-preview" alt="" style="width: 48px; height: 48px; object-fit: cover; border-radius: 6px; background: #1c1c1f; display: none;">
                  <button class="btn btn-ghost btn-small" id="btn-upload-test-ref" type="button">📷 上传测试参考图</button>
                  <button class="btn btn-danger btn-small" id="btn-clear-test-ref" type="button" style="display: none;">清除参考图</button>
                  <input type="file" id="input-test-ref-image" accept="image/*" style="display: none;">
                </div>
                <div class="form-hint">可选：支持单人照或多角度脸部拼图（仅本次测试生效，不写入配置；OpenAI gpt-image、xAI Grok 与 Grok 网页反代可用，dall-e 模型会自动忽略）。</div>
              </div>
              <div class="form-row" style="margin-top: 8px; align-items: center; gap: 10px; flex-wrap: wrap;">
                <button class="btn btn-ghost" id="btn-random-test-prompt" type="button">🎲 副 API 随机出词</button>
                <button class="btn btn-ghost" id="btn-seedream-test" type="button">🧪 测试生图（消耗 1 张额度）</button>
                <span class="form-hint" id="seedream-test-status"></span>
              </div>
              <img id="seedream-test-result" class="seedream-test-result" style="display: none; cursor: zoom-in;" alt="测试生成结果" title="点击查看大图">
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="btn-cancel-image-settings">取消</button>
        <button class="btn btn-primary" id="btn-save-image-settings">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // 插图功能开关 ↔ 插图显示档位联动；生图服务商 ↔ 各服务商配置组联动
  const imageEnabledEl = document.getElementById('setting-image-enabled');
  const imageDisplayEl = document.getElementById('setting-image-display');
  const imageDisplayGroup = document.getElementById('group-image-display');
  const imageProviderEl = document.getElementById('setting-image-provider');
  const imageProviderGroup = document.getElementById('group-image-provider');
  const seedreamConfigGroup = document.getElementById('group-seedream-config');
  const geminiConfigGroup = document.getElementById('group-gemini-config');
  const wanxConfigGroup = document.getElementById('group-wanx-config');
  const pollinationsConfigGroup = document.getElementById('group-pollinations-config');
  const grokConfigGroup = document.getElementById('group-grok-config');
  const paidCommonGroup = document.getElementById('group-paid-common');
  const composePromptEl = document.getElementById('setting-seedream-compose-prompt');
  const grokPersonModeEl = document.getElementById('setting-grok-person-mode');
  // compose 三槽独立存储：严格版（Seedream/万相/Gemini/OpenAI 共用）、Grok 单人、Grok 双人
  const isStrictProvider = (p) => p === 'seedream' || p === 'wanx' || p === 'gemini' || p === 'openai';
  const composeDefaults = {
    strict: DEFAULT_COMPOSE_SYSTEM_PROMPT,
    grokSolo: DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT,
    grokDuo: DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT
  };
  const composeState = {
    strict: sd.composePrompt || DEFAULT_COMPOSE_SYSTEM_PROMPT,
    grokSolo: gk.composePrompt || DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT,
    grokDuo: gk.composePromptDuo || DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT
  };
  const composeModeOf = () => {
    if (isStrictProvider(imageProviderEl.value)) return 'strict';
    return grokPersonModeEl.value === 'duo' ? 'grokDuo' : 'grokSolo';
  };
  let composeMode = composeModeOf();
  const composeModeHintEl = document.getElementById('compose-mode-hint');
  const composeModeHints = {
    strict: '当前编辑：严格版真人电影剧照指令（单人 + 完整环境光影 + 私密保空间避焦点）',
    grokSolo: '当前编辑：Grok 单人宽松版（场景/衣着/表情/身材已解放，仅保留非全裸红线）',
    grokDuo: '当前编辑：Grok 双人版（主控可入镜，成年男性+背影/侧脸+肢体归属铁律）'
  };
  const updateComposeModeHint = () => {
    composeModeHintEl.textContent = composeModeHints[composeMode];
  };
  composePromptEl.value = composeState[composeMode];
  updateComposeModeHint();
  // Grok/手动私密衣着库（支持多行；兼容旧 forcedOutfit）
  const grokOutfitLibEl = document.getElementById('setting-grok-outfit-library');
  grokOutfitLibEl.value = outfitLibraryToText(resolveGrokOutfitLibrary(gk));
  document.getElementById('btn-grok-outfit-reset').addEventListener('click', () => {
    grokOutfitLibEl.value = outfitLibraryToText(DEFAULT_GROK_OUTFIT_LIBRARY);
  });
  // 切换服务商或人物模式时暂存并切换 compose 编辑内容
  const switchComposeMode = () => {
    composeState[composeMode] = composePromptEl.value;
    composeMode = composeModeOf();
    composePromptEl.value = composeState[composeMode];
    updateComposeModeHint();
  };
  grokPersonModeEl.addEventListener('change', switchComposeMode);
  const syncImageGroups = () => {
    const enabled = imageEnabledEl.checked;
    imageDisplayEl.disabled = !enabled;
    imageProviderEl.disabled = !enabled;
    imageDisplayGroup.style.opacity = enabled ? '' : '0.5';
    imageProviderGroup.style.opacity = enabled ? '' : '0.5';
    const isSeedream = enabled && imageProviderEl.value === 'seedream';
    const isGemini = enabled && imageProviderEl.value === 'gemini';
    const isWanx = enabled && imageProviderEl.value === 'wanx';
    const isOpenAI = enabled && imageProviderEl.value === 'openai';
    const isFree = enabled && imageProviderEl.value === 'pollinations';
    const isGrok = enabled && imageProviderEl.value === 'grok';
    const isGrokWeb = enabled && imageProviderEl.value === 'grokweb';
    const isManual = enabled && imageProviderEl.value === 'manual';
    const isStrict = isSeedream || isGemini || isWanx || isOpenAI;
    const isGrokLike = isGrok || isManual || isGrokWeb;
    seedreamConfigGroup.style.display = isSeedream ? '' : 'none';
    geminiConfigGroup.style.display = isGemini ? '' : 'none';
    wanxConfigGroup.style.display = isWanx ? '' : 'none';
    document.getElementById('group-openai-config').style.display = isOpenAI ? '' : 'none';
    pollinationsConfigGroup.style.display = isFree ? '' : 'none';
    grokConfigGroup.style.display = isGrok ? '' : 'none';
    document.getElementById('group-grokweb-config').style.display = isGrokWeb ? '' : 'none';
    paidCommonGroup.style.display = (isStrict || isGrokLike) ? '' : 'none';
    // 严格版与 Grok/手动共用 compose 指令；Grok/手动额外显示人物模式 + 私密强制衣着库
    document.getElementById('group-grok-person-mode').style.display = isGrokLike ? '' : 'none';
    document.getElementById('group-compose-prompt').style.display = (isStrict || isGrokLike) ? '' : 'none';
    document.getElementById('group-grok-forced-outfit').style.display = isGrokLike ? '' : 'none';
    document.getElementById('group-test-image').style.display = (isStrict || isGrok || isGrokWeb) ? '' : 'none';
    document.getElementById('group-test-ref-image').style.display = (isOpenAI || isGrok || isGrokWeb) ? '' : 'none';
  };
  imageEnabledEl.addEventListener('change', syncImageGroups);
  imageProviderEl.addEventListener('change', () => {
    switchComposeMode();
    syncImageGroups();
  });
  syncImageGroups();

  // 通用模型抓取与下拉选择绑定（OpenAI / Grok 共用）
  const bindModelFetcher = ({
    baseUrlId, apiKeyId, modelInputId, modelSelectId, fetchBtnId, statusId, resetBtnId, defaultBaseUrl
  }) => {
    const baseUrlInput = document.getElementById(baseUrlId);
    const apiKeyInput = document.getElementById(apiKeyId);
    const modelInput = document.getElementById(modelInputId);
    const modelSelect = document.getElementById(modelSelectId);
    const fetchBtn = document.getElementById(fetchBtnId);
    const statusEl = document.getElementById(statusId);
    if (resetBtnId && defaultBaseUrl) {
      document.getElementById(resetBtnId).addEventListener('click', () => {
        baseUrlInput.value = defaultBaseUrl;
      });
    }
    modelSelect.addEventListener('change', () => {
      if (modelSelect.value) {
        modelInput.value = modelSelect.value;
      }
    });
    fetchBtn.addEventListener('click', async () => {
      const baseUrl = baseUrlInput.value.trim();
      const apiKey = apiKeyInput.value.trim();
      fetchBtn.disabled = true;
      statusEl.textContent = '正在获取模型列表…';
      try {
        const { all, imageLikely } = await fetchOpenAIModels({ baseUrl, apiKey });
        if (!all.length) {
          modelSelect.style.display = 'none';
          statusEl.textContent = '⚠️ 接口未返回任何模型，请手动填写模型 ID。';
          return;
        }
        modelSelect.innerHTML = '';
        const imageSet = new Set(imageLikely);
        const others = all.filter(id => !imageSet.has(id));
        const appendOptions = (parent, ids) => {
          for (const id of ids) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            parent.appendChild(opt);
          }
        };
        if (imageLikely.length > 0 && others.length > 0) {
          const imgGroup = document.createElement('optgroup');
          imgGroup.label = `疑似生图模型 (${imageLikely.length})`;
          appendOptions(imgGroup, imageLikely);
          const otherGroup = document.createElement('optgroup');
          otherGroup.label = `其他模型 (${others.length})`;
          appendOptions(otherGroup, others);
          modelSelect.appendChild(imgGroup);
          modelSelect.appendChild(otherGroup);
        } else {
          appendOptions(modelSelect, all);
        }
        const current = modelInput.value.trim();
        if (current && all.includes(current)) {
          modelSelect.value = current;
        } else {
          modelSelect.value = all[0];
          modelInput.value = all[0];
        }
        modelSelect.style.display = '';
        statusEl.textContent = imageLikely.length > 0
          ? `✅ 已抓取 ${all.length} 个模型（其中 ${imageLikely.length} 个疑似生图模型，已优先排在前面）。`
          : `✅ 已抓取 ${all.length} 个模型，请从上方下拉框选择。`;
      } catch (e) {
        statusEl.textContent = `❌ ${e.message || '获取模型失败'}`;
      } finally {
        fetchBtn.disabled = false;
      }
    });
  };

  bindModelFetcher({
    baseUrlId: 'setting-openai-base-url',
    apiKeyId: 'setting-openai-api-key',
    modelInputId: 'setting-openai-model',
    modelSelectId: 'setting-openai-model-select',
    fetchBtnId: 'btn-openai-fetch-models',
    statusId: 'openai-models-status',
    resetBtnId: 'btn-openai-reset-base-url',
    defaultBaseUrl: 'https://api.openai.com/v1'
  });

  bindModelFetcher({
    baseUrlId: 'setting-grok-base-url',
    apiKeyId: 'setting-grok-api-key',
    modelInputId: 'setting-grok-model',
    modelSelectId: 'setting-grok-model-select',
    fetchBtnId: 'btn-grok-fetch-models',
    statusId: 'grok-models-status',
    resetBtnId: 'btn-grok-reset-base-url',
    defaultBaseUrl: 'https://api.x.ai/v1'
  });

  // 测试提示词：大窗口编辑（长提示词在小文本框里太难改）
  document.getElementById('btn-edit-test-prompt').addEventListener('click', () => {
    const textarea = document.getElementById('setting-seedream-test-prompt');
    openBigTextEditor({
      title: '测试生图提示词',
      value: textarea.value,
      placeholder: textarea.placeholder,
      onSave: (newValue) => {
        textarea.value = newValue;
        textarea.dispatchEvent(new Event('input'));
      }
    });
  });

  // 测试结果图：点开大图查看器（缩放/平移，与聊天页插图同款，不带提示词按钮）
  document.getElementById('seedream-test-result').addEventListener('click', (e) => {
    if (e.target.src) openImageLightbox(e.target.src, '测试生成结果');
  });

  // 测试参考图：弹窗内临时保存（支持单人照或多角度拼图），不写入全局配置
  let testRefImageDataUrl = null;
  const testRefPreviewEl = document.getElementById('test-ref-image-preview');
  const testRefClearBtn = document.getElementById('btn-clear-test-ref');
  const testRefFileInput = document.getElementById('input-test-ref-image');
  const resizeTestRefImage = (dataUrl, maxDim = 1536) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale >= 1) return resolve(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
  document.getElementById('btn-upload-test-ref').addEventListener('click', () => {
    testRefFileInput.click();
  });
  testRefFileInput.addEventListener('change', () => {
    const file = testRefFileInput.files?.[0];
    testRefFileInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      testRefImageDataUrl = await resizeTestRefImage(String(reader.result || ''));
      testRefPreviewEl.src = testRefImageDataUrl;
      testRefPreviewEl.style.display = '';
      testRefClearBtn.style.display = '';
    };
    reader.readAsDataURL(file);
  });
  testRefClearBtn.addEventListener('click', () => {
    testRefImageDataUrl = null;
    testRefPreviewEl.removeAttribute('src');
    testRefPreviewEl.style.display = 'none';
    testRefClearBtn.style.display = 'none';
  });

  // 副 API 随机出词：随机抽测试剧情，按当前 compose 指令生成一段画面描述并回填到测试框
  const testPromptTextarea = document.getElementById('setting-seedream-test-prompt');
  const randomPromptBtn = document.getElementById('btn-random-test-prompt');
  const generateRandomTestPrompt = async (statusEl) => {
    const latestConfig = await getConfig();
    const provider = imageProviderEl.value;
    const duoMode = !isStrictProvider(provider) && grokPersonModeEl.value === 'duo';
    const customCompose = composePromptEl.value.trim();
    const hasRefImage = Boolean(testRefImageDataUrl && (provider === 'openai' || provider === 'grok' || provider === 'grokweb'));
    statusEl.textContent = hasRefImage ? '副 API 正在随机编词（已开启参考图跳过五官模式）…' : '副 API 正在随机编词…';
    const { prompt: generatedPrompt, scenarioLabel } = await composeTestIllustrationPrompt({
      composePrompt: customCompose,
      provider,
      duoMode,
      apiConfig: latestConfig.api || {},
      hasRefImage
    });
    testPromptTextarea.value = generatedPrompt;
    return { generatedPrompt, scenarioLabel, hasRefImage };
  };

  randomPromptBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('seedream-test-status');
    randomPromptBtn.disabled = true;
    try {
      const { scenarioLabel, hasRefImage } = await generateRandomTestPrompt(statusEl);
      statusEl.textContent = hasRefImage
        ? `🎲 已由副 API 随机生成（${scenarioLabel}，已跳过五官描写），可直接点「测试生图」或微调`
        : `🎲 已由副 API 随机生成（${scenarioLabel}），可直接点「测试生图」或微调`;
    } catch (e) {
      statusEl.textContent = `❌ 副 API 随机出词失败：${e.message || e}`;
    } finally {
      randomPromptBtn.disabled = false;
    }
  });

  // 测试生图：框内为空时自动先调副 API 随机出词；已有内容则直接过滤+加画风后缀后生图
  document.getElementById('btn-seedream-test').addEventListener('click', async () => {
    const statusEl = document.getElementById('seedream-test-status');
    const resultEl = document.getElementById('seedream-test-result');
    const btn = document.getElementById('btn-seedream-test');
    btn.disabled = true;
    randomPromptBtn.disabled = true;
    resultEl.style.display = 'none';
    try {
      let rawPrompt = testPromptTextarea.value.trim();
      if (!rawPrompt) {
        const { generatedPrompt, scenarioLabel } = await generateRandomTestPrompt(statusEl);
        rawPrompt = generatedPrompt;
        statusEl.textContent = `🎲 已随机出词（${scenarioLabel}），正在生成图片…（通常需要 10-30 秒）`;
      } else {
        statusEl.textContent = '生成中…（通常需要 10-30 秒）';
      }
      const prompt = prepareFinalTestImagePrompt(rawPrompt, imageProviderEl.value);
      let dataUrl;
      let openaiMeta = null;
      if (imageProviderEl.value === 'gemini') {
        dataUrl = await generateGeminiImage({
          apiKey: document.getElementById('setting-gemini-api-key').value.trim(),
          baseUrl: document.getElementById('setting-gemini-base-url').value.trim(),
          model: document.getElementById('setting-gemini-model').value.trim(),
          aspectRatio: document.getElementById('setting-gemini-aspect-ratio').value,
          imageSize: document.getElementById('setting-gemini-image-size').value,
          apiMode: document.getElementById('setting-gemini-api-mode').value,
          prompt
        });
      } else if (imageProviderEl.value === 'grok') {
        dataUrl = await generateGrokImage({
          apiKey: document.getElementById('setting-grok-api-key').value.trim(),
          baseUrl: document.getElementById('setting-grok-base-url').value.trim(),
          model: document.getElementById('setting-grok-model').value.trim(),
          aspectRatio: document.getElementById('setting-grok-aspect-ratio').value,
          resolution: document.getElementById('setting-grok-resolution').value,
          prompt,
          images: testRefImageDataUrl ? [testRefImageDataUrl] : null,
          onMeta: (m) => { openaiMeta = m; }
        });
      } else if (imageProviderEl.value === 'grokweb') {
        dataUrl = await generateGrokWebImage({
          apiKey: document.getElementById('setting-grokweb-api-key').value.trim(),
          baseUrl: document.getElementById('setting-grokweb-base-url').value.trim(),
          model: document.getElementById('setting-grokweb-model').value.trim(),
          prompt,
          images: testRefImageDataUrl ? [testRefImageDataUrl] : null
        });
      } else if (imageProviderEl.value === 'wanx') {
        dataUrl = await generateWanxImage({
          apiKey: document.getElementById('setting-wanx-api-key').value.trim(),
          baseUrl: document.getElementById('setting-wanx-base-url').value.trim(),
          model: document.getElementById('setting-wanx-model').value.trim(),
          size: document.getElementById('setting-wanx-size').value.trim(),
          prompt
        });
      } else if (imageProviderEl.value === 'openai') {
        dataUrl = await generateOpenAIImage({
          apiKey: document.getElementById('setting-openai-api-key').value.trim(),
          baseUrl: document.getElementById('setting-openai-base-url').value.trim(),
          model: document.getElementById('setting-openai-model').value.trim(),
          size: document.getElementById('setting-openai-size').value,
          quality: document.getElementById('setting-openai-quality').value,
          inputFidelity: document.getElementById('setting-openai-input-fidelity').value,
          prompt,
          images: testRefImageDataUrl ? [testRefImageDataUrl] : null,
          onMeta: (m) => { openaiMeta = m; }
        });
      } else {
        dataUrl = await generateSeedreamImage({
          apiKey: document.getElementById('setting-seedream-api-key').value.trim(),
          baseUrl: document.getElementById('setting-seedream-base-url').value.trim(),
          model: document.getElementById('setting-seedream-model').value.trim(),
          size: document.getElementById('setting-seedream-size').value,
          prompt
        });
      }
      resultEl.src = dataUrl;
      resultEl.style.display = '';
      if (openaiMeta) {
        if (openaiMeta.mode === 'edits') {
          statusEl.textContent = openaiMeta.downgraded
            ? '✅ 生成成功（参考图 /images/edits，接口不支持 fidelity 已自动省略）'
            : `✅ 生成成功（参考图 /images/edits，fidelity=${openaiMeta.inputFidelity || '默认'}）`;
        } else {
          statusEl.textContent = openaiMeta.skippedRefImage
            ? '✅ 生成成功（纯文生图 /images/generations；当前模型不支持参考图已忽略）'
            : '✅ 生成成功（纯文生图 /images/generations）';
        }
      } else {
        statusEl.textContent = '✅ 生成成功';
      }
    } catch (e) {
      statusEl.textContent = `❌ ${e.message || e}`;
    } finally {
      btn.disabled = false;
      randomPromptBtn.disabled = false;
    }
  });

  // compose prompt：恢复默认（恢复当前编辑版本的默认）
  document.getElementById('btn-seedream-compose-reset').addEventListener('click', () => {
    composePromptEl.value = composeDefaults[composeMode];
  });

  // compose prompt：用当前 system prompt + 测试文本，调用副 API 快速看总结效果
  document.getElementById('btn-seedream-compose-test').addEventListener('click', async () => {
    const btn = document.getElementById('btn-seedream-compose-test');
    const originalText = btn.textContent;
    openBigTextEditor({
      title: '输入 AI 回复文本，测试 compose 总结效果',
      value: '她侧身站在落地窗前，手指轻轻拢着没有扣好的衬衫前襟，唇角微扬，眼神落在窗外的雨雾里。',
      placeholder: '把 AI 的回复正文贴进来（支持长文本），会用当前设置的 system prompt 总结成生图提示词。',
      onSave: async (testText) => {
        if (!testText || !testText.trim()) return;
        btn.disabled = true;
        btn.textContent = '总结中…';
        try {
          const latestConfig = await getConfig();
          const api = resolveMemoryApi(latestConfig.api || {});
          const customPrompt = composePromptEl.value.trim();
          const basePrompt = customPrompt || composeDefaults[composeMode];
          const charDesc = '【测试角色卡】一位 28 岁女性，黑长直，御姐气质，高挑匀称。';
          const system = basePrompt
            .replace('{charDesc}', charDesc)
            .replace('{replyContent}', testText.trim());
          const userContent = system.includes('【AI 最新回复】')
            ? '【AI 最新回复】\n' + testText.trim()
            : testText.trim();
          const result = await sendChat([
            { role: 'system', content: system },
            { role: 'user', content: userContent }
          ], { api, usageContext: { kind: 'settings' } });
          openBigTextEditor({
            title: '测试总结结果（可复制）',
            value: result || '',
            readonly: true
          });
        } catch (e) {
          openBigTextEditor({
            title: '测试总结失败',
            value: '失败原因：' + (e.message || e),
            readonly: true
          });
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }
    });
  });

  
  function closeModal() {
    overlay.remove();
  }

  document.getElementById('btn-close-image-settings').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-image-settings').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.getElementById('btn-save-image-settings').addEventListener('click', async () => {
    const latestConfig = await getConfig();
    composeState[composeMode] = composePromptEl.value;
    const parsedGrokOutfitLib = parseOutfitLibraryText(grokOutfitLibEl.value);
    const defaultGrokOutfitText = outfitLibraryToText(DEFAULT_GROK_OUTFIT_LIBRARY);
    const grokOutfitLibraryToSave = (parsedGrokOutfitLib.length === 0 || outfitLibraryToText(parsedGrokOutfitLib) === defaultGrokOutfitText)
      ? []
      : parsedGrokOutfitLib;

    latestConfig.ui = {
      ...(latestConfig.ui || {}),
      imageEnabled: document.getElementById('setting-image-enabled').checked,
      imageDisplay: document.getElementById('setting-image-display').value
    };
    latestConfig.image = {
      provider: document.getElementById('setting-image-provider').value,
      personMode: grokPersonModeEl.value,
      pollinationsNsfw: document.getElementById('setting-pollinations-nsfw').checked,
      seedream: {
        baseUrl: document.getElementById('setting-seedream-base-url').value.trim(),
        apiKey: document.getElementById('setting-seedream-api-key').value.trim(),
        model: document.getElementById('setting-seedream-model').value.trim(),
        size: document.getElementById('setting-seedream-size').value,
        composePrompt: (composeState.strict.trim() === DEFAULT_COMPOSE_SYSTEM_PROMPT.trim()) ? '' : composeState.strict.trim()
      },
      wanx: {
        baseUrl: document.getElementById('setting-wanx-base-url').value.trim(),
        apiKey: document.getElementById('setting-wanx-api-key').value.trim(),
        model: document.getElementById('setting-wanx-model').value.trim(),
        size: document.getElementById('setting-wanx-size').value.trim()
      },
      openai: {
        baseUrl: document.getElementById('setting-openai-base-url').value.trim(),
        apiKey: document.getElementById('setting-openai-api-key').value.trim(),
        model: document.getElementById('setting-openai-model').value.trim(),
        size: document.getElementById('setting-openai-size').value,
        quality: document.getElementById('setting-openai-quality').value,
        inputFidelity: document.getElementById('setting-openai-input-fidelity').value
      },
      gemini: {
        baseUrl: document.getElementById('setting-gemini-base-url').value.trim(),
        apiKey: document.getElementById('setting-gemini-api-key').value.trim(),
        model: document.getElementById('setting-gemini-model').value.trim(),
        aspectRatio: document.getElementById('setting-gemini-aspect-ratio').value,
        imageSize: document.getElementById('setting-gemini-image-size').value,
        apiMode: document.getElementById('setting-gemini-api-mode').value
      },
      grok: {
        baseUrl: document.getElementById('setting-grok-base-url').value.trim(),
        apiKey: document.getElementById('setting-grok-api-key').value.trim(),
        model: document.getElementById('setting-grok-model').value.trim(),
        aspectRatio: document.getElementById('setting-grok-aspect-ratio').value,
        resolution: document.getElementById('setting-grok-resolution').value,
        composePrompt: (composeState.grokSolo.trim() === DEFAULT_GROK_COMPOSE_SYSTEM_PROMPT.trim()) ? '' : composeState.grokSolo.trim(),
        composePromptDuo: (composeState.grokDuo.trim() === DEFAULT_GROK_DUO_COMPOSE_SYSTEM_PROMPT.trim()) ? '' : composeState.grokDuo.trim(),
        outfitLibrary: grokOutfitLibraryToSave
      },
      grokweb: {
        baseUrl: document.getElementById('setting-grokweb-base-url').value.trim(),
        apiKey: document.getElementById('setting-grokweb-api-key').value.trim(),
        model: document.getElementById('setting-grokweb-model').value.trim()
      }
    };
    await saveConfig(latestConfig);
    closeModal();
  });
}
