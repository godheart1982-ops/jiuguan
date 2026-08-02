import { getConfig, saveConfig, saveApiProfile, getApiProfiles, deleteApiProfile } from '../../services/storage.js';
import { attachCharCounter } from '../../utils/counter.js';
import { normalizeSearchConfig, testSearchApi, DEFAULT_SEARCH_CONFIG } from '../../services/search-api.js';
import { escapeHtml, renderProfileOptions } from './settings-shared.js';
import { promptText } from '../../utils/prompt-dialog.js';
import { createSpeedTestController } from './speed-test-ui.js';

export async function renderApiSettingsModal() {
  // 如果已经存在弹窗，先移除
  const existing = document.getElementById('settings-modal');
  if (existing) existing.remove();

  const config = await getConfig();
  const api = config.api || {};
  const searchCfg = normalizeSearchConfig(config.search);
  const profiles = await getApiProfiles();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'settings-modal';

  const advCollapsed = !config.ui || config.ui.apiSettingsAdvancedCollapsed !== false;

  // 底层字段合成思考模式初始值：原生推理优先，其次提示词思维链
  let thinkingModeInit = 'off';
  if ((api.reasoningEffort && api.reasoningEffort !== 'off') || api.deepseekThinking === true) {
    thinkingModeInit = 'native';
  } else if (api.enableThinking === true) {
    thinkingModeInit = 'prompt';
  }

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>API 设置</h2>
        <button class="btn btn-ghost btn-icon" id="btn-close-settings">✕</button>
      </div>
      <div class="modal-body">
        <div class="api-tabs" style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
          <button class="btn btn-primary btn-small" id="tab-main-api" type="button">主 API</button>
          <button class="btn btn-ghost btn-small" id="tab-sub-api" type="button">副 API（记忆总结）</button>
          <button class="btn btn-ghost btn-small" id="tab-search-api" type="button">搜索 API</button>
        </div>
        <div id="panel-main-api">
        <div class="form-group">
          <label class="form-label">API Base URL</label>
          <input class="form-input" id="setting-base-url" type="text" value="${escapeHtml(api.baseUrl || 'https://api.openai.com/v1')}">
          <div class="form-hint">OpenAI 兼容接口地址，例如 https://api.openai.com/v1</div>
        </div>

        <div class="form-group">
          <label class="form-label">API Key</label>
          <input class="form-input" id="setting-api-key" type="password" value="${escapeHtml(api.apiKey || '')}" placeholder="sk-...">
        </div>

        <div class="form-group">
          <label class="form-label">模型名称</label>
          <input class="form-input" id="setting-model" type="text" value="${escapeHtml(api.model || 'gpt-3.5-turbo')}">
        </div>

        <div class="form-group">
          <label class="form-label">API 格式</label>
          <select class="form-input" id="setting-format">
            <option value="openai" ${!api.format || api.format === 'openai' ? 'selected' : ''}>OpenAI 兼容（默认）</option>
            <option value="anthropic" ${api.format === 'anthropic' ? 'selected' : ''}>Anthropic 原生（支持 prompt caching）</option>
          </select>
          <div class="form-hint">Anthropic 原生格式可启用稳定的 5 分钟 prompt 缓存，适用于直连或反代 Anthropic 接口；与思维链预填充互斥（Anthropic 格式下预填充自动跳过）。</div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: normal;">
              <input type="checkbox" id="setting-temperature-enabled" style="width: 15px; height: 15px; cursor: pointer;" ${api.temperatureEnabled === false ? '' : 'checked'}>
              Temperature（随机性）
            </label>
            <input class="form-input" id="setting-temperature" type="number" step="0.1" min="0" max="2" value="${api.temperature !== undefined ? api.temperature : 0.8}">
            <div class="form-hint">关闭则请求不发送 temperature。Claude Sonnet 5 / Opus 4.7+ 等已废弃温度（传非默认值报 400），用这类模型时需关闭；Sonnet/Opus 4.6 及更早、DeepSeek 等保持开启。</div>
          </div>
          <div class="form-group">
            <label class="form-label">Max Tokens（留空则不限制）</label>
            <input class="form-input" id="setting-max-tokens" type="number" min="1" max="8192" value="${api.maxTokens || ''}" placeholder="不限制">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">思考模式</label>
          <select class="form-input" id="setting-thinking-mode">
            <option value="off" ${thinkingModeInit === 'off' ? 'selected' : ''}>关闭</option>
            <option value="prompt" ${thinkingModeInit === 'prompt' ? 'selected' : ''}>提示词思维链</option>
            <option value="native" ${thinkingModeInit === 'native' ? 'selected' : ''}>原生推理</option>
          </select>
          <div class="form-hint">提示词思维链：把角色卡的「思考格式」拼进 system prompt，AI 先输出 &lt;思考&gt; 再写正文；原生推理：模型真正的深度推理，按 API 格式自动分流（Anthropic 走 extended thinking，OpenAI 走 DeepSeek reasoning）。</div>
        </div>

        <div class="form-group hidden" id="group-prefill-thinking">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
            <input type="checkbox" id="setting-prefill-thinking" style="width: 16px; height: 16px; cursor: pointer;" ${api.prefillThinking === true ? 'checked' : ''}>
            <span>思维链预填充（实验）</span>
          </label>
          <div class="form-hint">发送时在回复开头预置 &lt;思考&gt;，强制模型先输出思维链再写正文，可根治开头掉思维链的问题。需端点支持 assistant 前缀续写（DeepSeek 官方接口自动走 beta 端点，火山方舟/豆包原生支持）。不支持的服务商会报错，届时请关闭。</div>
        </div>

        <div class="form-group hidden" id="group-native-reasoning">
          <label class="form-label" id="native-effort-label">推理强度</label>
          <select class="form-input" id="setting-reasoning-effort">
            <option value="low" ${api.reasoningEffort === 'low' ? 'selected' : ''}>低（约 4K）</option>
            <option value="medium" ${api.reasoningEffort === 'medium' ? 'selected' : ''}>中（约 10K）</option>
            <option value="high" ${api.reasoningEffort === 'high' ? 'selected' : ''}>高（约 16K）</option>
          </select>
          <select class="form-input hidden" id="setting-deepseek-effort">
            <option value="high" ${(!api.deepseekReasoningEffort || api.deepseekReasoningEffort === 'high') ? 'selected' : ''}>高（high）</option>
            <option value="max" ${api.deepseekReasoningEffort === 'max' ? 'selected' : ''}>最强（max）</option>
          </select>
          <div class="form-hint" id="native-effort-hint"></div>
        </div>

        <div class="form-group hidden" id="group-show-thinking">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
            <input type="checkbox" id="setting-show-thinking" style="width: 16px; height: 16px; cursor: pointer;" ${api.showThinking === true ? 'checked' : ''}>
            <span>显示推理过程</span>
          </label>
          <div class="form-hint">开启后，推理内容会折叠显示在回复前；关闭则静默推理，只输出正文（token 费用不变）。</div>
        </div>

        <div class="stats-section" style="margin-top: 20px;">
          <div class="stats-section-header" id="api-advanced-header" style="margin-bottom: 0;">
            <span class="stats-section-toggle" id="api-advanced-icon">${advCollapsed ? '▶' : '▼'}</span>
            <span>高级（配置方案 · 连接测试 · 测速跑分）</span>
          </div>
          <div id="api-advanced-body" class="${advCollapsed ? 'hidden' : ''}" style="padding-top: 10px;">
        <div class="form-section" style="margin-top: 0; padding-top: 0; border-top: none;">
          <div class="form-section-title">API 配置方案</div>
          <div class="form-group">
            <label class="form-label">已保存的方案</label>
            <div class="form-row" style="gap: 8px; flex-wrap: wrap;">
              <select class="form-input" id="setting-profile-select" style="min-width: 160px; flex: 1;">
                <option value="">-- 选择一个方案 --</option>
                ${renderProfileOptions(profiles, api)}
              </select>
              <button class="btn btn-ghost" id="btn-load-profile">读取</button>
              <button class="btn btn-ghost" id="btn-save-profile">保存为…</button>
              <button class="btn btn-ghost" id="btn-delete-profile">删除</button>
            </div>
            <div class="form-hint">把当前填写的 API 配置保存成不同名字，方便多 key / 多模型切换。</div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">连接测试</div>
          <div class="form-group">
            <div class="form-row" style="gap: 8px; flex-wrap: wrap; align-items: center;">
              <button class="btn btn-ghost" id="btn-test-api">测试当前配置</button>
              <span id="test-api-status" style="color: #aaa; font-size: 0.9em;"></span>
            </div>
            <div class="form-hint">会用当前填写的配置发送一条极简请求（max_tokens=1），验证网络、Key、模型是否可用。</div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">测速 / 跑分</div>
          <div class="form-group">
            <div class="form-row" style="gap: 8px; flex-wrap: wrap; align-items: center;">
              <select class="form-input" id="speed-test-target" style="min-width: 150px;">
                <option value="main">主 API（当前填写）</option>
                <option value="memory">副 API（当前填写）</option>
              </select>
              <input class="form-input" id="speed-test-rounds" type="number" min="3" max="20" value="8" style="width: 90px;" title="完整跑分轮数">
              <button class="btn btn-ghost" id="btn-speed-quick" type="button">快速测速</button>
              <button class="btn btn-ghost" id="btn-speed-full" type="button">完整跑分</button>
              <span id="speed-test-status" style="color: #aaa; font-size: 0.9em;"></span>
            </div>
            <div class="form-hint">快速 = 1 次流式请求；完整 = 预热 1 轮 + 正式 N 轮（首 Token P50 / 总延迟 P95 / Token/s / 格式遵循）。固定提示词每轮输出约 200~400 token，会实际消耗额度；思考模式跟随主 API 表单当前设置；DeepSeek 端点自动查余额。</div>
          </div>
          <div id="speed-test-records" class="st-records"></div>
        </div>
          </div>
        </div>
        </div>

        <div id="panel-sub-api" style="display: none;">
          <div class="form-section">
            <div class="form-section-title">副 API（记忆总结）</div>
            <div class="form-group">
              <label class="form-label">从已保存方案读取</label>
              <div class="form-row" style="gap: 8px; flex-wrap: wrap;">
                <select class="form-input" id="setting-sub-profile-select" style="min-width: 160px; flex: 1;">
                  <option value="">-- 选择一个方案 --</option>
                  ${renderProfileOptions(profiles, null)}
                </select>
                <button class="btn btn-ghost" id="btn-load-sub-profile" type="button">读取</button>
              </div>
              <div class="form-hint">副 API 专门用于短期/长期记忆的总结与精简，可指向另一个服务商的便宜模型。读取方案会自动填入下方，可再改；Base URL / Key / 模型任一留空则记忆调用回退使用主 API。</div>
            </div>
            <div class="form-group">
              <label class="form-label">API Base URL</label>
              <input class="form-input" id="setting-sub-base-url" type="text" value="${escapeHtml((api.memoryApi && api.memoryApi.baseUrl) || '')}" placeholder="留空则跟随主 API">
            </div>
            <div class="form-group">
              <label class="form-label">API Key</label>
              <input class="form-input" id="setting-sub-api-key" type="password" value="${escapeHtml((api.memoryApi && api.memoryApi.apiKey) || '')}" placeholder="sk-...">
            </div>
            <div class="form-group">
              <label class="form-label">模型名称</label>
              <input class="form-input" id="setting-sub-model" type="text" value="${escapeHtml((api.memoryApi && api.memoryApi.model) || '')}" placeholder="例如 claude-haiku-4-5 / gpt-4o-mini">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Temperature</label>
                <input class="form-input" id="setting-sub-temperature" type="number" step="0.1" min="0" max="2" value="${(api.memoryApi && api.memoryApi.temperature !== undefined && api.memoryApi.temperature !== null) ? api.memoryApi.temperature : ''}" placeholder="留空跟随主 API">
              </div>
              <div class="form-group">
                <label class="form-label">Max Tokens</label>
                <input class="form-input" id="setting-sub-max-tokens" type="number" min="1" max="8192" value="${escapeHtml((api.memoryApi && api.memoryApi.maxTokens) || '')}" placeholder="留空跟随主 API">
              </div>
            </div>
          </div>
        </div>

        <div id="panel-search-api" style="display: none;">
          <div class="form-section">
            <div class="form-section-title">搜索 API（联网检索）</div>
            <div class="form-hint" style="margin-bottom: 12px;">与主/副对话 API 独立。聊天页点 🔍 时<strong>只用输入框原文</strong>作查询，不上传角色卡与对话历史。结果规则拼成摘要挂到本轮，发送后注入主 API，默认不进记忆。</div>
            <div class="form-group">
              <label class="form-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" id="setting-search-enabled" ${searchCfg.enabled ? 'checked' : ''}>
                <span>启用联网检索</span>
              </label>
            </div>
            <div class="form-group">
              <label class="form-label">服务商</label>
              <select class="form-input" id="setting-search-provider">
                <option value="anysearch" ${searchCfg.provider === 'anysearch' ? 'selected' : ''}>AnySearch（api.anysearch.com）</option>
                <option value="custom" ${searchCfg.provider === 'custom' ? 'selected' : ''}>自定义（兼容 /v1/search JSON）</option>
              </select>
              <div class="form-hint">换家时改服务商、Base URL 与 Key 即可；App 统一解析 title/snippet/url 字段。</div>
            </div>
            <div class="form-group">
              <label class="form-label">Base URL</label>
              <input class="form-input" id="setting-search-base-url" type="text" value="${escapeHtml(searchCfg.baseUrl || DEFAULT_SEARCH_CONFIG.baseUrl)}" placeholder="https://api.anysearch.com">
              <div class="form-hint">AnySearch 填 https://api.anysearch.com；自定义可填域名或完整 …/v1/search 地址。</div>
            </div>
            <div class="form-group">
              <label class="form-label">API Key</label>
              <input class="form-input" id="setting-search-api-key" type="password" value="${escapeHtml(searchCfg.apiKey || '')}" placeholder="as_sk_… 或服务商 Key（匿名档可留空）">
            </div>
            <div class="form-group">
              <label class="form-label">最多返回条数</label>
              <input class="form-input" id="setting-search-max-results" type="number" min="1" max="20" value="${searchCfg.maxResults || 5}">
              <div class="form-hint">AnySearch 支持 1–20；默认 5 较省额度。</div>
            </div>
            <div class="form-group">
              <div class="form-row" style="gap: 8px; flex-wrap: wrap; align-items: center;">
                <button class="btn btn-ghost" id="btn-test-search-api" type="button">测试搜索</button>
                <span id="test-search-api-status" style="color: #aaa; font-size: 0.9em;"></span>
              </div>
              <div class="form-hint">用 query「hello world」测连通性（会消耗搜索额度）。</div>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="btn-cancel-settings">取消</button>
        <button class="btn btn-primary" id="btn-save-settings">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // 为设置页输入框添加字符统计
  const settingInputs = ['#setting-base-url', '#setting-api-key', '#setting-model', '#setting-temperature', '#setting-max-tokens', '#setting-sub-base-url', '#setting-sub-api-key', '#setting-sub-model', '#setting-sub-temperature', '#setting-sub-max-tokens', '#setting-search-base-url', '#setting-search-api-key', '#setting-search-max-results'];
  for (const selector of settingInputs) {
    const el = document.querySelector(selector);
    if (el) attachCharCounter(el);
  }

  // 温度开关联动：关闭时禁用温度输入框
  const tempEnabledEl = document.getElementById('setting-temperature-enabled');
  const tempInputEl = document.getElementById('setting-temperature');
  if (tempEnabledEl && tempInputEl) {
    const syncTempDisabled = () => { tempInputEl.disabled = !tempEnabledEl.checked; };
    tempEnabledEl.addEventListener('change', syncTempDisabled);
    syncTempDisabled();
  }

  // 思考模式联动：off=全隐藏；prompt=预填充开关；native=按 API 格式分流强度下拉 + 显示推理过程
  const formatEl = document.getElementById('setting-format');
  const thinkingModeEl = document.getElementById('setting-thinking-mode');
  const reasoningEl = document.getElementById('setting-reasoning-effort');
  const deepseekEffortEl = document.getElementById('setting-deepseek-effort');
  const prefillGroup = document.getElementById('group-prefill-thinking');
  const nativeGroup = document.getElementById('group-native-reasoning');
  const showThinkingGroup = document.getElementById('group-show-thinking');
  const nativeEffortLabel = document.getElementById('native-effort-label');
  const nativeEffortHint = document.getElementById('native-effort-hint');

  const NATIVE_HINT_ANTHROPIC = '开启 Anthropic extended thinking，模型真正深度推理并返回思考块。max_tokens 自动叠加：思考预算 + 正文额度（正文额度取 Max Tokens，留空按 8192）；协议要求不发送 temperature。';
  const NATIVE_HINT_DEEPSEEK = '在请求中附加 thinking 参数，并解析返回的 reasoning_content 推理内容；适用于 deepseek-reasoner 等支持推理的模型。';

  const syncThinkingFields = () => {
    const mode = thinkingModeEl.value;
    const isAnthropic = formatEl.value === 'anthropic';
    prefillGroup.classList.toggle('hidden', mode !== 'prompt');
    nativeGroup.classList.toggle('hidden', mode !== 'native');
    showThinkingGroup.classList.toggle('hidden', mode !== 'native');
    reasoningEl.classList.toggle('hidden', !isAnthropic);
    deepseekEffortEl.classList.toggle('hidden', isAnthropic);
    nativeEffortLabel.textContent = isAnthropic ? '推理强度（Anthropic）' : '推理强度（DeepSeek）';
    nativeEffortHint.textContent = isAnthropic ? NATIVE_HINT_ANTHROPIC : NATIVE_HINT_DEEPSEEK;
  };
  thinkingModeEl.addEventListener('change', syncThinkingFields);
  formatEl.addEventListener('change', syncThinkingFields);
  syncThinkingFields();

  // 高级区域（配置方案 / 连接测试）折叠，状态持久化
  const advHeader = document.getElementById('api-advanced-header');
  const advBody = document.getElementById('api-advanced-body');
  const advIcon = document.getElementById('api-advanced-icon');
  advHeader.addEventListener('click', async () => {
    const isCollapsed = advBody.classList.toggle('hidden');
    advIcon.textContent = isCollapsed ? '▶' : '▼';
    const cfg = await getConfig();
    if (!cfg.ui) cfg.ui = {};
    cfg.ui.apiSettingsAdvancedCollapsed = isCollapsed;
    await saveConfig(cfg).catch(() => {});
  });

  function closeModal() {
    overlay.remove();
  }

  function readFormApi() {
    const baseUrl = document.getElementById('setting-base-url').value.trim();
    const apiKey = document.getElementById('setting-api-key').value.trim();
    const model = document.getElementById('setting-model').value.trim();
    const temperature = parseFloat(document.getElementById('setting-temperature').value);
    const maxTokensRaw = document.getElementById('setting-max-tokens').value.trim();
    const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw, 10) : null;
    const format = document.getElementById('setting-format').value || 'openai';
    const isAnthropic = format === 'anthropic';
    // 思考模式（off/prompt/native）拆回底层字段，api 层逻辑不变
    const thinkingMode = document.getElementById('setting-thinking-mode').value;
    return {
      baseUrl,
      apiKey,
      model,
      temperature: isNaN(temperature) ? 0.8 : temperature,
      temperatureEnabled: document.getElementById('setting-temperature-enabled').checked,
      maxTokens: maxTokensRaw && !isNaN(maxTokens) ? maxTokens : null,
      enableThinking: thinkingMode === 'prompt',
      prefillThinking: thinkingMode === 'prompt' ? document.getElementById('setting-prefill-thinking').checked : false,
      reasoningEffort: (thinkingMode === 'native' && isAnthropic) ? document.getElementById('setting-reasoning-effort').value : 'off',
      deepseekThinking: thinkingMode === 'native' && !isAnthropic,
      deepseekReasoningEffort: document.getElementById('setting-deepseek-effort').value || 'high',
      showThinking: thinkingMode === 'native' ? document.getElementById('setting-show-thinking').checked : (api.showThinking === true),
      format,
      memoryApi: readSubApi()
    };
  }

  function readSubApi() {
    const baseUrl = document.getElementById('setting-sub-base-url').value.trim();
    const apiKey = document.getElementById('setting-sub-api-key').value.trim();
    const model = document.getElementById('setting-sub-model').value.trim();
    const tRaw = document.getElementById('setting-sub-temperature').value.trim();
    const mRaw = document.getElementById('setting-sub-max-tokens').value.trim();
    const t = tRaw ? parseFloat(tRaw) : null;
    const m = mRaw ? parseInt(mRaw, 10) : null;
    // Base URL / Key / 模型缺一即视为未配置，记忆调用回退主 API
    if (!baseUrl || !apiKey || !model) return {};
    return {
      baseUrl,
      apiKey,
      model,
      temperature: (t !== null && !isNaN(t)) ? t : null,
      maxTokens: (m !== null && !isNaN(m)) ? m : null
    };
  }

  function fillSubFields(obj) {
    const o = obj || {};
    document.getElementById('setting-sub-base-url').value = o.baseUrl || '';
    document.getElementById('setting-sub-api-key').value = o.apiKey || '';
    document.getElementById('setting-sub-model').value = o.model || '';
    document.getElementById('setting-sub-temperature').value = (o.temperature !== undefined && o.temperature !== null) ? o.temperature : '';
    document.getElementById('setting-sub-max-tokens').value = (o.maxTokens !== undefined && o.maxTokens !== null) ? o.maxTokens : '';
  }

  function applyFormApi(apiConfig) {
    document.getElementById('setting-base-url').value = apiConfig.baseUrl || '';
    document.getElementById('setting-api-key').value = apiConfig.apiKey || '';
    document.getElementById('setting-model').value = apiConfig.model || '';
    document.getElementById('setting-temperature').value = apiConfig.temperature !== undefined ? apiConfig.temperature : 0.8;
    document.getElementById('setting-temperature-enabled').checked = apiConfig.temperatureEnabled !== false;
    document.getElementById('setting-temperature').disabled = apiConfig.temperatureEnabled === false;
    document.getElementById('setting-max-tokens').value = apiConfig.maxTokens || '';
    // 底层字段合成思考模式：原生推理优先（reasoningEffort 非 off 或 deepseekThinking），其次提示词思维链
    let thinkingMode = 'off';
    if ((apiConfig.reasoningEffort && apiConfig.reasoningEffort !== 'off') || apiConfig.deepseekThinking === true) {
      thinkingMode = 'native';
    } else if (apiConfig.enableThinking === true) {
      thinkingMode = 'prompt';
    }
    document.getElementById('setting-thinking-mode').value = thinkingMode;
    document.getElementById('setting-prefill-thinking').checked = apiConfig.prefillThinking === true;
    document.getElementById('setting-reasoning-effort').value = ['low', 'medium', 'high'].includes(apiConfig.reasoningEffort) ? apiConfig.reasoningEffort : 'medium';
    document.getElementById('setting-deepseek-effort').value = apiConfig.deepseekReasoningEffort || 'high';
    document.getElementById('setting-show-thinking').checked = apiConfig.showThinking === true;
    document.getElementById('setting-format').value = apiConfig.format || 'openai';
    syncThinkingFields();
  }

  async function refreshProfileSelect(selectedName = '') {
    const currentProfiles = await getApiProfiles();
    const select = document.getElementById('setting-profile-select');
    select.innerHTML = '<option value="">-- 选择一个方案 --</option>' + renderProfileOptions(currentProfiles, null, selectedName);
  }

  document.getElementById('btn-close-settings').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-settings').addEventListener('click', closeModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // 主 / 副 / 搜索 API 页签切换
  const tabMainBtn = document.getElementById('tab-main-api');
  const tabSubBtn = document.getElementById('tab-sub-api');
  const tabSearchBtn = document.getElementById('tab-search-api');
  const panelMain = document.getElementById('panel-main-api');
  const panelSub = document.getElementById('panel-sub-api');
  const panelSearch = document.getElementById('panel-search-api');
  function showApiTab(which) {
    panelMain.style.display = which === 'main' ? '' : 'none';
    panelSub.style.display = which === 'sub' ? '' : 'none';
    panelSearch.style.display = which === 'search' ? '' : 'none';
    tabMainBtn.className = 'btn btn-small ' + (which === 'main' ? 'btn-primary' : 'btn-ghost');
    tabSubBtn.className = 'btn btn-small ' + (which === 'sub' ? 'btn-primary' : 'btn-ghost');
    tabSearchBtn.className = 'btn btn-small ' + (which === 'search' ? 'btn-primary' : 'btn-ghost');
  }
  tabMainBtn.addEventListener('click', () => showApiTab('main'));
  tabSubBtn.addEventListener('click', () => showApiTab('sub'));
  tabSearchBtn.addEventListener('click', () => showApiTab('search'));

  function readSearchForm() {
    const maxRaw = document.getElementById('setting-search-max-results').value.trim();
    const maxResults = maxRaw ? parseInt(maxRaw, 10) : 5;
    return normalizeSearchConfig({
      enabled: document.getElementById('setting-search-enabled').checked,
      provider: document.getElementById('setting-search-provider').value,
      baseUrl: document.getElementById('setting-search-base-url').value.trim(),
      apiKey: document.getElementById('setting-search-api-key').value.trim(),
      maxResults: Number.isFinite(maxResults) ? maxResults : 5
    });
  }

  document.getElementById('setting-search-provider').addEventListener('change', () => {
    const p = document.getElementById('setting-search-provider').value;
    const urlEl = document.getElementById('setting-search-base-url');
    if (p === 'anysearch' && (!urlEl.value.trim() || urlEl.value.includes('anysearch'))) {
      urlEl.value = DEFAULT_SEARCH_CONFIG.baseUrl;
    }
  });

  document.getElementById('btn-test-search-api').addEventListener('click', async () => {
    const statusEl = document.getElementById('test-search-api-status');
    const btn = document.getElementById('btn-test-search-api');
    const form = readSearchForm();
    if (!form.baseUrl) {
      alert('请先填写搜索 Base URL');
      return;
    }
    btn.disabled = true;
    statusEl.textContent = '测试中…';
    statusEl.style.color = '#aaa';
    try {
      const result = await testSearchApi(form);
      statusEl.textContent = `正常（${result.items.length} 条）`;
      statusEl.style.color = '#7ee787';
      alert('搜索连通成功\n返回 ' + result.items.length + ' 条\n首条：' + (result.items[0].title || result.items[0].snippet || '（无标题）'));
    } catch (e) {
      statusEl.textContent = '失败';
      statusEl.style.color = '#ff6b6b';
      alert('搜索测试失败：' + (e.message || e));
    } finally {
      btn.disabled = false;
    }
  });

  // 副 API：从公共方案池读取并填入下方字段
  document.getElementById('btn-load-sub-profile').addEventListener('click', async () => {
    const select = document.getElementById('setting-sub-profile-select');
    const name = select.value;
    if (!name) { alert('请先选择一个方案'); return; }
    const currentProfiles = await getApiProfiles();
    const profile = currentProfiles[name];
    if (!profile) { alert('该方案不存在'); return; }
    fillSubFields(profile);
  });

  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const apiConfig = readFormApi();
    const searchConfig = readSearchForm();

    if (!apiConfig.baseUrl) {
      alert('请输入 API Base URL');
      return;
    }
    if (!apiConfig.apiKey) {
      alert('请输入 API Key');
      return;
    }
    if (!apiConfig.model) {
      alert('请输入模型名称');
      return;
    }
    if (searchConfig.enabled && !searchConfig.baseUrl) {
      alert('已启用搜索 API，请填写 Base URL');
      return;
    }

    // 重新读取最新配置，避免覆盖掉本会话中保存的其他字段
    const latestConfig = await getConfig();
    latestConfig.api = apiConfig;
    latestConfig.search = searchConfig;

    await saveConfig(latestConfig);
    closeModal();
  });

  // 读取已保存方案
  document.getElementById('btn-load-profile').addEventListener('click', async () => {
    const select = document.getElementById('setting-profile-select');
    const name = select.value;
    if (!name) {
      alert('请先在列表里选择一个方案');
      return;
    }
    const currentProfiles = await getApiProfiles();
    const profile = currentProfiles[name];
    if (!profile) {
      alert('该方案不存在');
      return;
    }
    applyFormApi(profile);
  });

  // 保存当前表单为方案（Electron 无 window.prompt，用应用内输入框）
  document.getElementById('btn-save-profile').addEventListener('click', async () => {
    const apiConfig = readFormApi();
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
      alert('请先填写完整的 API 配置再保存方案');
      return;
    }
    const defaultName = document.getElementById('setting-profile-select').value || '';
    const name = await promptText({
      title: '保存 API 方案',
      message: '给这个 API 配置方案起个名字：',
      defaultValue: defaultName,
      placeholder: '例如：主站-claude / 中转-deepseek'
    });
    if (name === null || !String(name).trim()) return;
    const trimmedName = String(name).trim();

    const currentProfiles = await getApiProfiles();
    if (currentProfiles[trimmedName]) {
      if (!confirm(`方案 "${trimmedName}" 已存在，确定覆盖吗？`)) {
        return;
      }
    }

    await saveApiProfile(trimmedName, apiConfig);
    await refreshProfileSelect(trimmedName);
    alert(`方案 "${trimmedName}" 已保存`);
  });

  // 删除方案
  document.getElementById('btn-delete-profile').addEventListener('click', async () => {
    const select = document.getElementById('setting-profile-select');
    const name = select.value;
    if (!name) {
      alert('请先在列表里选择一个方案');
      return;
    }
    if (!confirm(`确定删除方案 "${name}" 吗？`)) return;
    await deleteApiProfile(name);
    await refreshProfileSelect();
    alert(`方案 "${name}" 已删除`);
  });

  // 测试当前配置
  document.getElementById('btn-test-api').addEventListener('click', async () => {
    const apiConfig = readFormApi();
    const statusEl = document.getElementById('test-api-status');

    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
      alert('请先填写 API Base URL、API Key 和模型名称');
      return;
    }

    statusEl.textContent = '测试中…';
    statusEl.style.color = '#aaa';

    try {
      let response;
      if ((apiConfig.format || 'openai') === 'anthropic') {
        response = await fetch(`${apiConfig.baseUrl.replace(/\/$/, '')}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiConfig.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'prompt-caching-2024-07-31'
          },
          body: JSON.stringify({
            model: apiConfig.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
            ...(apiConfig.temperatureEnabled !== false ? { temperature: 0.5 } : {})
          })
        });
      } else {
        response = await fetch(`${apiConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey}`
          },
          body: JSON.stringify({
            model: apiConfig.model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
            ...(apiConfig.temperatureEnabled !== false ? { temperature: 0.5 } : {})
          })
        });
      }

      if (!response.ok) {
        let errorText = '';
        try {
          const text = await response.text();
          try {
            const errorData = JSON.parse(text);
            errorText = errorData.error?.message || JSON.stringify(errorData);
          } catch (parseErr) {
            errorText = text;
          }
        } catch (e) {
          errorText = '无法读取错误响应';
        }
        throw new Error(`API 返回错误 (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const reply = (apiConfig.format === 'anthropic')
        ? (data.content?.[0]?.text || '')
        : (data.choices?.[0]?.message?.content || '');
      statusEl.textContent = '连接正常';
      statusEl.style.color = '#7ee787';
      alert(`连接成功\n模型：${apiConfig.model}\n测试回复：${reply || '（空）'}`);
    } catch (error) {
      statusEl.textContent = '连接失败';
      statusEl.style.color = '#ff6b6b';
      alert('测试失败：' + (error.message || String(error)));
    }
  });

  // 测速 / 跑分（主/副 API，记录持久化在 config.speedTestRecords）
  const speedTest = createSpeedTestController({
    readMainApi: readFormApi,
    readSubApi: readSubApi,
    els: {
      target: document.getElementById('speed-test-target'),
      rounds: document.getElementById('speed-test-rounds'),
      quickBtn: document.getElementById('btn-speed-quick'),
      fullBtn: document.getElementById('btn-speed-full'),
      status: document.getElementById('speed-test-status'),
      records: document.getElementById('speed-test-records')
    }
  });
  speedTest.renderRecords();
}
