// 制卡工坊页：分步向导联动制卡（一句话扩写灵感→背景与主控→多名重要角色v6→联动配角v2→开场白/世界书→一键落盘）
// + 已有卡增量追加角色/世界书 + 一键建通用模拟器卡（v1.2）

import { navigate, refreshCharacters, state } from '../app.js';
import { getConfig, getCharacter, saveCharacter } from '../services/storage.js';
import { ensurePromptLibrary } from '../services/prompt-library.js';
import { getCharacterModules } from '../services/card-modules.js';
import { normalizeWorldBookSettings } from '../services/world-book.js';
import { openBigTextEditor } from '../utils/big-editor.js';
import { countTokens } from '../utils/tokenizer.js';
import {
  extractCharacterNamesFromModules,
  parseWorldAndMainControl,
  parseWorldBookDraft,
  runStudioStep,
  assembleCharacterCard,
  buildSimulatorCardObject,
  draftFromExistingCharacter,
  createCardId
} from '../services/card-studio.js';

const STUDIO_STORAGE_KEY = 'jiuguan_card_studio_draft_v1';

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

function createEmptyDraft() {
  return {
    cardName: '',
    group: '',
    oneLiner: '',
    concept: '',
    includeAdult: true,
    background: '',
    mainControlName: '',
    mainControlDesc: '',
    majorIdea: '',
    majorModules: [],
    supportingIdea: '',
    supportingModules: [],
    openingNote: '',
    greeting: '',
    worldbookIdea: '',
    worldBookEntries: [],
    outputPresetId: '',
    thinkingPresetId: '',
    enableRandomNarrative: true,
    offscreenRolesText: ''
  };
}

function createDefaultStudioState() {
  return {
    mode: 'new',          // 'new' | 'extend' | 'simulator'
    step: 1,              // 1..5
    apiTarget: 'main',    // 'main' | 'memory'
    injectBypass: true,   // 默认注入「默认·叙事引擎破甲」破甲词
    draft: createEmptyDraft(),
    extendCharId: '',
    extendRoleKind: 'supporting', // 'supporting' | 'major'
    extendSubIdea: '',
    extendSubResult: '',
    extendWbIdea: '',
    extendWbEntries: [],
    simName: '通用人生模拟器',
    simGroup: '模拟器',
    simOutputPresetId: '',
    simThinkingPresetId: '',
    lastCreatedCardId: ''
  };
}

function loadStudioState() {
  const base = createDefaultStudioState();
  try {
    const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return base;
    const mergedDraft = { ...createEmptyDraft(), ...(saved.draft && typeof saved.draft === 'object' ? saved.draft : {}) };
    // 兼容旧版单主角字段 protagonistModule
    if (!Array.isArray(mergedDraft.majorModules)) {
      mergedDraft.majorModules = [];
    }
    if (!mergedDraft.majorModules.length && typeof mergedDraft.protagonistModule === 'string' && mergedDraft.protagonistModule.trim()) {
      mergedDraft.majorModules = [mergedDraft.protagonistModule.trim()];
    }
    delete mergedDraft.protagonistModule;
    if (!Array.isArray(mergedDraft.supportingModules)) mergedDraft.supportingModules = [];
    if (!Array.isArray(mergedDraft.worldBookEntries)) mergedDraft.worldBookEntries = [];
    return {
      ...base,
      ...saved,
      step: Math.min(5, Math.max(1, Number(saved.step) || 1)),
      mode: ['new', 'extend', 'simulator'].includes(saved.mode) ? saved.mode : 'new',
      apiTarget: saved.apiTarget === 'memory' ? 'memory' : 'main',
      injectBypass: saved.injectBypass !== false,
      extendRoleKind: saved.extendRoleKind === 'major' ? 'major' : 'supporting',
      extendWbEntries: Array.isArray(saved.extendWbEntries) ? saved.extendWbEntries : [],
      draft: mergedDraft
    };
  } catch {
    return base;
  }
}

function persistStudioState() {
  try {
    localStorage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(studioState));
  } catch {
    // 存储空间满或隐私模式时静默降级为内存保留
  }
}

// 内存 + localStorage 双重持久化：切换页面、切换步骤或重启应用均不丢草稿
let studioState = loadStudioState();

export async function renderCardStudio(container) {
  container.innerHTML = '';

  const config = await getConfig();
  ensurePromptLibrary(config);
  const library = Array.isArray(config.promptLibrary) ? config.promptLibrary : [];
  const outputPresets = library.filter((it) => (it.kind || 'outputFormat') === 'outputFormat');
  const thinkingPresets = library.filter((it) => it.kind === 'thinking');

  // 默认选中第一份输出格式与思维链模板（若用户尚未选过）
  if (!studioState.draft.outputPresetId && outputPresets[0]) {
    studioState.draft.outputPresetId = outputPresets[0].id;
  }
  if (!studioState.draft.thinkingPresetId && thinkingPresets[0]) {
    studioState.draft.thinkingPresetId = thinkingPresets[0].id;
  }
  if (!studioState.simOutputPresetId && outputPresets[0]) {
    studioState.simOutputPresetId = outputPresets[0].id;
  }
  if (!studioState.simThinkingPresetId && thinkingPresets[0]) {
    studioState.simThinkingPresetId = thinkingPresets[0].id;
  }
  if (!studioState.extendCharId && state.characters.length) {
    studioState.extendCharId = state.characters[0].id;
  }

  let activeAbort = null;
  let busy = false;

  const page = document.createElement('div');
  page.className = 'page studio-page';
  container.appendChild(page);

  function presetOptionsHtml(items, selectedId) {
    return ['<option value="">无（不注入）</option>']
      .concat(items.map((it) => `<option value="${escapeHtml(it.id)}"${it.id === selectedId ? ' selected' : ''}>${escapeHtml(it.name)}</option>`))
      .join('');
  }

  /** 在切换步骤/模式前强制把当前页所有输入控件同步回 studioState 并落盘，防止 IME 未提交丢字。 */
  function syncDomToState() {
    const d = studioState.draft;
    const val = (sel) => {
      const el = page.querySelector(sel);
      return el ? el.value : null;
    };
    const checked = (sel) => {
      const el = page.querySelector(sel);
      return el ? el.checked : null;
    };

    if (studioState.mode === 'new') {
      if (studioState.step === 1) {
        if (val('#st-card-name') !== null) d.cardName = val('#st-card-name');
        if (val('#st-group') !== null) d.group = val('#st-group');
        if (val('#st-one-liner') !== null) d.oneLiner = val('#st-one-liner');
        if (val('#st-concept') !== null) d.concept = val('#st-concept');
        if (checked('#st-include-adult') !== null) d.includeAdult = checked('#st-include-adult');
        if (val('#st-background') !== null) d.background = val('#st-background');
        if (val('#st-mc-name') !== null) d.mainControlName = val('#st-mc-name');
        if (val('#st-mc-desc') !== null) d.mainControlDesc = val('#st-mc-desc');
      } else if (studioState.step === 2) {
        if (val('#st-major-idea') !== null) d.majorIdea = val('#st-major-idea');
        page.querySelectorAll('.st-major-textarea').forEach((ta) => {
          d.majorModules[Number(ta.dataset.idx)] = ta.value;
        });
      } else if (studioState.step === 3) {
        if (val('#st-sub-idea') !== null) d.supportingIdea = val('#st-sub-idea');
        page.querySelectorAll('.st-sub-textarea').forEach((ta) => {
          d.supportingModules[Number(ta.dataset.idx)] = ta.value;
        });
      } else if (studioState.step === 4) {
        if (val('#st-opening-note') !== null) d.openingNote = val('#st-opening-note');
        if (val('#st-greeting') !== null) d.greeting = val('#st-greeting');
        if (val('#st-wb-idea') !== null) d.worldbookIdea = val('#st-wb-idea');
        page.querySelectorAll('.st-wb-title').forEach((el) => {
          const item = d.worldBookEntries[Number(el.dataset.idx)];
          if (item) item.name = el.value;
        });
        page.querySelectorAll('.st-wb-keys').forEach((el) => {
          const item = d.worldBookEntries[Number(el.dataset.idx)];
          if (item) item.keys = el.value.split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean);
        });
        page.querySelectorAll('.st-wb-content').forEach((el) => {
          const item = d.worldBookEntries[Number(el.dataset.idx)];
          if (item) item.content = el.value;
        });
      } else if (studioState.step === 5) {
        if (val('#st-final-name') !== null) d.cardName = val('#st-final-name');
        if (val('#st-final-group') !== null) d.group = val('#st-final-group');
        if (val('#st-offscreen-roles') !== null) d.offscreenRolesText = val('#st-offscreen-roles');
        if (val('#st-output-preset') !== null) d.outputPresetId = val('#st-output-preset');
        if (val('#st-thinking-preset') !== null) d.thinkingPresetId = val('#st-thinking-preset');
        if (checked('#st-random-narrative') !== null) d.enableRandomNarrative = checked('#st-random-narrative');
      }
    } else if (studioState.mode === 'extend') {
      if (val('#ext-sub-idea') !== null) studioState.extendSubIdea = val('#ext-sub-idea');
      if (val('#ext-sub-result') !== null) studioState.extendSubResult = val('#ext-sub-result');
      if (val('#ext-wb-idea') !== null) studioState.extendWbIdea = val('#ext-wb-idea');
    } else if (studioState.mode === 'simulator') {
      if (val('#sim-name') !== null) studioState.simName = val('#sim-name');
      if (val('#sim-group') !== null) studioState.simGroup = val('#sim-group');
    }
    persistStudioState();
  }

  function render() {
    const d = studioState.draft;
    const allModules = [...d.majorModules, ...d.supportingModules].filter((s) => String(s || '').trim());
    const extractedNames = extractCharacterNamesFromModules(allModules);

    page.innerHTML = `
      <div class="page-header studio-header">
        <div>
          <h1 class="page-title">✨ 制卡工坊</h1>
          <div class="form-hint" style="margin-top: 4px;">按 v6.1 重要角色 / v2 配角 / v1.2 模拟器规范分步联动生成，自动保存草稿，一键落盘为角色卡</div>
        </div>
        <div class="studio-toolbar">
          <select class="form-select studio-api-select" id="studio-api-target" title="选择制卡调用的 API">
            <option value="main"${studioState.apiTarget === 'main' ? ' selected' : ''}>使用主 API（推荐）</option>
            <option value="memory"${studioState.apiTarget === 'memory' ? ' selected' : ''}>使用副 API</option>
          </select>
          <label class="btn btn-ghost btn-small" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;" title="制卡调用 API 时自动注入世界书「默认·叙事引擎破甲」内容">
            <input type="checkbox" id="studio-inject-bypass" ${studioState.injectBypass !== false ? 'checked' : ''}>
            <span>破甲词</span>
          </label>
          ${studioState.mode === 'new' ? '<button class="btn btn-ghost btn-small" id="btn-studio-reset" type="button">↺ 清空草稿</button>' : ''}
        </div>
      </div>

      <div class="studio-mode-tabs">
        <button type="button" class="btn btn-small ${studioState.mode === 'new' ? 'btn-primary' : 'btn-ghost'}" data-mode="new">🪄 新建联动卡</button>
        <button type="button" class="btn btn-small ${studioState.mode === 'extend' ? 'btn-primary' : 'btn-ghost'}" data-mode="extend">➕ 已有卡加角色 / 世界书</button>
        <button type="button" class="btn btn-small ${studioState.mode === 'simulator' ? 'btn-primary' : 'btn-ghost'}" data-mode="simulator">🌍 一键建模拟器卡</button>
      </div>

      <div id="studio-status" class="memory-status hidden"></div>

      <div id="studio-body" class="studio-body"></div>
    `;

    page.querySelector('#studio-api-target').addEventListener('change', (e) => {
      studioState.apiTarget = e.target.value === 'memory' ? 'memory' : 'main';
      persistStudioState();
    });

    page.querySelector('#studio-inject-bypass').addEventListener('change', (e) => {
      studioState.injectBypass = e.target.checked;
      persistStudioState();
    });

    const resetBtn = page.querySelector('#btn-studio-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (busy) return;
        if (!confirm('确定清空当前制卡草稿并回到第 1 步吗？')) return;
        studioState.draft = createEmptyDraft();
        if (outputPresets[0]) studioState.draft.outputPresetId = outputPresets[0].id;
        if (thinkingPresets[0]) studioState.draft.thinkingPresetId = thinkingPresets[0].id;
        studioState.step = 1;
        studioState.lastCreatedCardId = '';
        persistStudioState();
        render();
      });
    }

    page.querySelectorAll('.studio-mode-tabs [data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (busy) return;
        syncDomToState();
        studioState.mode = btn.dataset.mode;
        persistStudioState();
        render();
      });
    });

    const bodyEl = page.querySelector('#studio-body');
    if (studioState.mode === 'new') {
      renderNewWizard(bodyEl, d, extractedNames);
    } else if (studioState.mode === 'extend') {
      renderExtendMode(bodyEl);
    } else {
      renderSimulatorMode(bodyEl);
    }
  }

  function showStatus(msg, type = 'info') {
    const el = page.querySelector('#studio-status');
    if (!el) return;
    if (!msg) {
      el.classList.add('hidden');
      return;
    }
    el.textContent = msg;
    el.className = `memory-status ${type}`;
  }

  async function executeStep(step, draft, { extraInstruction = '', onChunk, onFinished, onAborted }) {
    if (busy) return;
    busy = true;
    activeAbort = new AbortController();
    let latestFull = '';
    showStatus(`正在调用${studioState.apiTarget === 'memory' ? '副' : '主'} API 生成中…`, 'info');
    try {
      const result = await runStudioStep(step, draft, {
        apiTarget: studioState.apiTarget,
        injectBypass: studioState.injectBypass !== false,
        extraInstruction,
        signal: activeAbort.signal,
        onChunk: (full, chunk) => {
          latestFull = full;
          if (onChunk) onChunk(full, chunk);
        }
      });
      showStatus('生成完成，已自动保存草稿，可直接编辑微调', 'success');
      if (onFinished) await onFinished(result);
      persistStudioState();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        showStatus('已中止生成（已保留当前输出）', 'warning');
        if (onAborted && latestFull) await onAborted(latestFull);
        persistStudioState();
      } else {
        showStatus('生成失败：' + (err && err.message ? err.message : String(err)), 'error');
      }
    } finally {
      busy = false;
      activeAbort = null;
    }
  }

  function bindStopButton(btn) {
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (activeAbort) activeAbort.abort();
    });
  }

  function bindTextField(el, setter) {
    if (!el) return;
    const handler = () => {
      setter(el.value);
      persistStudioState();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }

  // ==================================================================
  // 模式 1：新建联动卡（5 步向导）
  // ==================================================================
  function renderNewWizard(bodyEl, d, extractedNames) {
    const steps = [
      { n: 1, label: '1. 灵感与背景' },
      { n: 2, label: `2. 重要角色 (${d.majorModules.length})` },
      { n: 3, label: `3. 联动配角 (${d.supportingModules.length})` },
      { n: 4, label: '4. 开场白与世界书' },
      { n: 5, label: '5. 一键建卡' }
    ];

    const stepperHtml = `
      <div class="studio-stepper">
        ${steps.map((s) => `
          <button type="button" class="studio-step-pill ${studioState.step === s.n ? 'active' : ''}" data-step="${s.n}">${s.label}</button>
        `).join('')}
      </div>
    `;

    let panelHtml = '';
    if (studioState.step === 1) {
      panelHtml = `
        <div class="studio-card">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">角色卡名称（可留空由 AI 建议）</label>
              <input class="form-input" id="st-card-name" type="text" value="${escapeHtml(d.cardName)}" placeholder="例如：江北嘴律所日常">
            </div>
            <div class="form-group">
              <label class="form-label">分组（可选）</label>
              <input class="form-input" id="st-group" type="text" value="${escapeHtml(d.group)}" placeholder="例如：都市篇、校园篇">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">一句话脑洞（先扩写再开卡，也可跳过直接写下方详细灵感）</label>
            <input class="form-input" id="st-one-liner" type="text" value="${escapeHtml(d.oneLiner)}" placeholder="例如：重庆写实都市，男主刚进红圈律所实习，同时被外冷内热的带教女合伙人和同组毒舌女同事卷进职场与情感拉扯">
          </div>
          <div class="studio-action-row" style="margin-bottom: 12px;">
            <button type="button" class="btn btn-ghost" id="btn-expand-concept">✨ 一句话扩写为详细开卡灵感</button>
            <button type="button" class="btn btn-danger hidden" id="btn-stop-concept">停止</button>
          </div>

          <div class="form-group">
            <div class="form-label-with-action">
              <label class="form-label">详细开卡灵感与核心要求 *</label>
              <button type="button" class="btn btn-ghost btn-small" id="btn-big-concept">⛶ 展开编辑</button>
            </div>
            <textarea class="form-textarea" id="st-concept" rows="6" placeholder="点击上方「一句话扩写」自动生成，或直接在这里写你的详细开卡灵感、主控起点、想安排的几位重要角色与雷区偏好…">${escapeHtml(d.concept)}</textarea>
          </div>

          <div class="form-group">
            <label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
              <input type="checkbox" id="st-include-adult" ${d.includeAdult ? 'checked' : ''}>
              <span>包含成人亲密扩展卡（亲密观念、稳定 XP、用语尺度、三段过程与身体细节）</span>
            </label>
          </div>
          <div class="studio-action-row">
            <button type="button" class="btn btn-primary" id="btn-gen-world">✨ 按详细灵感生成背景与主控</button>
            <button type="button" class="btn btn-danger hidden" id="btn-stop-step">停止</button>
          </div>
        </div>

        <div class="studio-card">
          <div class="form-group">
            <div class="form-label-with-action">
              <label class="form-label">背景设定（舞台 / 社会规则 / 场所）</label>
              <button type="button" class="btn btn-ghost btn-small" id="btn-big-bg">⛶ 展开编辑</button>
            </div>
            <textarea class="form-textarea" id="st-background" rows="6" placeholder="点击上方生成，或手动填写背景设定…">${escapeHtml(d.background)}</textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">主控姓名</label>
              <input class="form-input" id="st-mc-name" type="text" value="${escapeHtml(d.mainControlName)}" placeholder="例如：陈默">
            </div>
            <div class="form-group">
              <label class="form-label">主控身份与起点简介</label>
              <textarea class="form-textarea" id="st-mc-desc" rows="3" style="min-height: 80px;" placeholder="年龄、职业、经济、住所、性格底色…">${escapeHtml(d.mainControlDesc)}</textarea>
            </div>
          </div>
          <div class="studio-nav-footer">
            <span></span>
            <button type="button" class="btn btn-primary" id="btn-next-step">下一步：生成重要角色 →</button>
          </div>
        </div>
      `;
    } else if (studioState.step === 2) {
      const majorNames = extractCharacterNamesFromModules(d.majorModules);
      const majorCardsHtml = d.majorModules.length
        ? d.majorModules.map((mod, idx) => {
          const title = extractCharacterNamesFromModules([mod])[0] || `重要角色 #${idx + 1}`;
          return `
            <div class="studio-sub-card">
              <div class="studio-sub-card-head">
                <strong>重要角色 ${idx + 1}：${escapeHtml(title)}（约 ${countTokens(mod)} tokens）</strong>
                <div style="display:flex;gap:6px;">
                  <button type="button" class="btn btn-ghost btn-small btn-big-major" data-idx="${idx}">⛶ 大窗</button>
                  <button type="button" class="btn btn-danger btn-small btn-del-major" data-idx="${idx}">删除</button>
                </div>
              </div>
              <textarea class="form-textarea st-major-textarea" data-idx="${idx}" rows="10">${escapeHtml(mod)}</textarea>
            </div>
          `;
        }).join('')
        : '<div class="memory-empty">暂未生成重要角色，点击上方按钮按《角色卡模板 v6.1》生成第 1 位重要角色（可连续添加多位）</div>';

      panelHtml = `
        <div class="studio-card">
          <div class="form-hint" style="margin-bottom: 10px;">
            支持添加 <strong>1 位或多位重要角色</strong>（均按《角色卡模板 v6.1》生成完整高密度模块，含语言指纹、绝不说禁句、六阶段相处画面）。每次新增都会自动读取「背景 + 主控 + 已有重要角色」防重名、防撞脸并做关系联动。
            ${majorNames.length ? `<br>当前重要角色：<strong>${escapeHtml(majorNames.join('、'))}</strong>` : ''}
          </div>
          <div class="form-group">
            <label class="form-label">本名重要角色构思（留空则按详细开卡灵感自然生成）</label>
            <input class="form-input" id="st-major-idea" type="text" value="${escapeHtml(d.majorIdea)}" placeholder="例如：30岁外冷内热的红圈律所女合伙人，短发利落，嘴硬心软 / 或第2位重要角色：毒舌直球的同组女同事">
          </div>
          <div class="studio-action-row">
            <button type="button" class="btn btn-primary" id="btn-gen-major">✨ 联动生成一名重要角色（v6.1）</button>
            <button type="button" class="btn btn-danger hidden" id="btn-stop-step">停止</button>
            <button type="button" class="btn btn-ghost btn-small" id="btn-add-blank-major">＋ 手动添空白重要角色</button>
          </div>
          <textarea class="form-textarea hidden" id="st-major-streaming" rows="10" readonly style="margin-top: 10px;"></textarea>
        </div>

        <div class="studio-card">
          <div class="form-section-title" style="margin-top:0;">已添加的重要角色（${d.majorModules.length}）</div>
          <div class="studio-sub-list">${majorCardsHtml}</div>
          <div class="studio-nav-footer">
            <button type="button" class="btn btn-ghost" id="btn-prev-step">← 上一步</button>
            <button type="button" class="btn btn-primary" id="btn-next-step">下一步：联动配角 →</button>
          </div>
        </div>
      `;
    } else if (studioState.step === 3) {
      const subCardsHtml = d.supportingModules.length
        ? d.supportingModules.map((mod, idx) => {
          const title = extractCharacterNamesFromModules([mod])[0] || `配角 #${idx + 1}`;
          return `
            <div class="studio-sub-card">
              <div class="studio-sub-card-head">
                <strong>配角 ${idx + 1}：${escapeHtml(title)}（约 ${countTokens(mod)} tokens）</strong>
                <div style="display:flex;gap:6px;">
                  <button type="button" class="btn btn-ghost btn-small btn-big-sub" data-idx="${idx}">⛶ 大窗</button>
                  <button type="button" class="btn btn-danger btn-small btn-del-sub" data-idx="${idx}">删除</button>
                </div>
              </div>
              <textarea class="form-textarea st-sub-textarea" data-idx="${idx}" rows="7">${escapeHtml(mod)}</textarea>
            </div>
          `;
        }).join('')
        : '<div class="memory-empty">暂未添加配角（不需要配角可直接点「下一步」跳过）</div>';

      panelHtml = `
        <div class="studio-card">
          <div class="form-hint" style="margin-bottom: 10px;">
            每次生成配角都会自动读取「背景 + 主控 + 全部重要角色 + 已有配角」，严格按《配角卡模板 v2》输出，自动避开撞脸/重名并保持人际关系双向咬合。
            ${extractedNames.length ? `<br>当前已有角色：<strong>${escapeHtml(extractedNames.join('、'))}</strong>` : ''}
          </div>
          <div class="form-group">
            <label class="form-label">新配角构思（留空则由 AI 按生活圈自然推荐）</label>
            <input class="form-input" id="st-sub-idea" type="text" value="${escapeHtml(d.supportingIdea)}" placeholder="例如：律所行政，27岁，外热内冷、爱八卦但守口如瓶">
          </div>
          <div class="studio-action-row">
            <button type="button" class="btn btn-primary" id="btn-gen-sub">✨ 联动生成一名配角（v2）</button>
            <button type="button" class="btn btn-danger hidden" id="btn-stop-step">停止</button>
            <button type="button" class="btn btn-ghost btn-small" id="btn-add-blank-sub">＋ 手动添空白配角</button>
          </div>
          <textarea class="form-textarea hidden" id="st-sub-streaming" rows="8" readonly style="margin-top: 10px;"></textarea>
        </div>

        <div class="studio-card">
          <div class="form-section-title" style="margin-top:0;">已添加的联动配角（${d.supportingModules.length}）</div>
          <div class="studio-sub-list">${subCardsHtml}</div>
          <div class="studio-nav-footer">
            <button type="button" class="btn btn-ghost" id="btn-prev-step">← 上一步</button>
            <button type="button" class="btn btn-primary" id="btn-next-step">下一步：开场白与世界书 →</button>
          </div>
        </div>
      `;
    } else if (studioState.step === 4) {
      const wbHtml = d.worldBookEntries.length
        ? d.worldBookEntries.map((entry, idx) => `
          <div class="studio-sub-card">
            <div class="studio-sub-card-head">
              <input class="form-input st-wb-title" data-idx="${idx}" value="${escapeHtml(entry.name || '')}" placeholder="条目标题" style="flex:1;">
              <button type="button" class="btn btn-danger btn-small btn-del-wb" data-idx="${idx}">删除</button>
            </div>
            <input class="form-input st-wb-keys" data-idx="${idx}" value="${escapeHtml((entry.keys || []).join('，'))}" placeholder="触发关键词（逗号分隔）" style="margin: 6px 0;">
            <textarea class="form-textarea st-wb-content" data-idx="${idx}" rows="3" style="min-height: 70px;">${escapeHtml(entry.content)}</textarea>
          </div>
        `).join('')
        : '<div class="memory-empty">暂无卡专属世界书条目（可选，提炼后按关键词触发、帮主对话省常驻 Token）</div>';

      panelHtml = `
        <div class="studio-card">
          <div class="form-section-title" style="margin-top:0;">第一轮开场白</div>
          <div class="form-group">
            <label class="form-label">开场场景要求（可选）</label>
            <input class="form-input" id="st-opening-note" type="text" value="${escapeHtml(d.openingNote)}" placeholder="例如：周五下班下雨的律所门口 / 第一次面试见面">
          </div>
          <div class="studio-action-row">
            <button type="button" class="btn btn-primary" id="btn-gen-opening">${d.greeting ? '🔄 重新生成开场白' : '✨ 联动生成开场白'}</button>
            <button type="button" class="btn btn-danger hidden" id="btn-stop-step">停止</button>
            <button type="button" class="btn btn-ghost btn-small" id="btn-big-opening">⛶ 大窗编辑</button>
          </div>
          <div class="form-group" style="margin-top: 10px;">
            <textarea class="form-textarea" id="st-greeting" rows="8" placeholder="点击上方联动生成开场白，或手动撰写…">${escapeHtml(d.greeting)}</textarea>
          </div>
        </div>

        <div class="studio-card">
          <div class="form-section-title" style="margin-top:0;">联动世界书条目（可选）</div>
          <div class="form-group">
            <input class="form-input" id="st-wb-idea" type="text" value="${escapeHtml(d.worldbookIdea)}" placeholder="可选：指定想拆成世界书的势力、地点或旧事；留空自动提炼">
          </div>
          <div class="studio-action-row" style="margin-bottom: 10px;">
            <button type="button" class="btn btn-ghost" id="btn-gen-wb">✨ 提炼联动世界书条目</button>
            <button type="button" class="btn btn-danger hidden" id="btn-stop-wb">停止</button>
          </div>
          <div class="studio-sub-list">${wbHtml}</div>
          <div class="studio-nav-footer">
            <button type="button" class="btn btn-ghost" id="btn-prev-step">← 上一步</button>
            <button type="button" class="btn btn-primary" id="btn-next-step">下一步：确认并一键建卡 →</button>
          </div>
        </div>
      `;
    } else {
      const offscreenDefault = d.offscreenRolesText || extractedNames.join('、');
      const totalTokens = countTokens([
        d.background,
        d.mainControlName,
        d.mainControlDesc,
        ...d.majorModules,
        ...d.supportingModules,
        d.greeting
      ].join('\n'));

      panelHtml = `
        <div class="studio-card">
          <div class="form-section-title" style="margin-top:0;">最终确认与一键落盘</div>
          <div class="studio-summary-grid">
            <div class="studio-summary-item"><span>角色卡名</span><strong>${escapeHtml(d.cardName || extractedNames[0] || '未命名角色')}</strong></div>
            <div class="studio-summary-item"><span>角色模块</span><strong>重要 ${d.majorModules.length} / 配角 ${d.supportingModules.length}（${escapeHtml(extractedNames.join('、') || '未识别')}）</strong></div>
            <div class="studio-summary-item"><span>世界书条目</span><strong>${d.worldBookEntries.length} 条</strong></div>
            <div class="studio-summary-item"><span>总设定体量</span><strong>约 ${totalTokens} tokens</strong></div>
          </div>

          <div class="form-row" style="margin-top: 14px;">
            <div class="form-group">
              <label class="form-label">角色卡名称 *</label>
              <input class="form-input" id="st-final-name" type="text" value="${escapeHtml(d.cardName || extractedNames[0] || '')}" placeholder="角色卡显示名">
            </div>
            <div class="form-group">
              <label class="form-label">分组</label>
              <input class="form-input" id="st-final-group" type="text" value="${escapeHtml(d.group)}" placeholder="留空放未分组">
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">不在场重要 NPC 名单（自动识别，可修改）</label>
            <input class="form-input" id="st-offscreen-roles" type="text" value="${escapeHtml(offscreenDefault)}" placeholder="人名用顿号或空格分隔">
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">输出格式模板</label>
              <select class="form-select" id="st-output-preset">${presetOptionsHtml(outputPresets, d.outputPresetId)}</select>
            </div>
            <div class="form-group">
              <label class="form-label">思维链模板</label>
              <select class="form-select" id="st-thinking-preset">${presetOptionsHtml(thinkingPresets, d.thinkingPresetId)}</select>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
              <input type="checkbox" id="st-random-narrative" ${d.enableRandomNarrative !== false ? 'checked' : ''}>
              <span>启用随机 NPC 与随机事件（常规角色卡建议开启）</span>
            </label>
          </div>

          <div class="studio-nav-footer">
            <button type="button" class="btn btn-ghost" id="btn-prev-step">← 上一步</button>
            <button type="button" class="btn btn-primary" id="btn-save-new-card">🚀 一键保存为角色卡</button>
          </div>

          ${studioState.lastCreatedCardId ? `
            <div class="studio-success-banner">
              <span>✅ 角色卡已写入程序！无需手动复制，可直接开玩或微调：</span>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
                <button type="button" class="btn btn-primary btn-small" id="btn-goto-chat">💬 立即开始聊天</button>
                <button type="button" class="btn btn-ghost btn-small" id="btn-goto-edit">✏️ 去卡编辑页微调</button>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }

    bodyEl.innerHTML = stepperHtml + panelHtml;

    // Stepper 点击切换（切走前强制落盘当前页 DOM）
    bodyEl.querySelectorAll('.studio-step-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (busy) return;
        syncDomToState();
        studioState.step = Number(btn.dataset.step);
        persistStudioState();
        render();
      });
    });

    const prevBtn = bodyEl.querySelector('#btn-prev-step');
    const nextBtn = bodyEl.querySelector('#btn-next-step');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (busy) return;
        syncDomToState();
        studioState.step = Math.max(1, studioState.step - 1);
        persistStudioState();
        render();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (busy) return;
        syncDomToState();
        studioState.step = Math.min(5, studioState.step + 1);
        persistStudioState();
        render();
      });
    }

    // 各步骤事件绑定
    if (studioState.step === 1) {
      const nameEl = bodyEl.querySelector('#st-card-name');
      const groupEl = bodyEl.querySelector('#st-group');
      const oneLinerEl = bodyEl.querySelector('#st-one-liner');
      const conceptEl = bodyEl.querySelector('#st-concept');
      const adultEl = bodyEl.querySelector('#st-include-adult');
      const bgEl = bodyEl.querySelector('#st-background');
      const mcNameEl = bodyEl.querySelector('#st-mc-name');
      const mcDescEl = bodyEl.querySelector('#st-mc-desc');

      bindTextField(nameEl, (v) => { d.cardName = v; });
      bindTextField(groupEl, (v) => { d.group = v; });
      bindTextField(oneLinerEl, (v) => { d.oneLiner = v; });
      bindTextField(conceptEl, (v) => { d.concept = v; });
      bindTextField(bgEl, (v) => { d.background = v; });
      bindTextField(mcNameEl, (v) => { d.mainControlName = v; });
      bindTextField(mcDescEl, (v) => { d.mainControlDesc = v; });
      adultEl.addEventListener('change', () => { d.includeAdult = adultEl.checked; persistStudioState(); });

      bodyEl.querySelector('#btn-big-concept').addEventListener('click', () => {
        openBigTextEditor({
          title: '编辑详细开卡灵感',
          value: d.concept,
          onSave: (val) => { d.concept = val; conceptEl.value = val; persistStudioState(); }
        });
      });

      bodyEl.querySelector('#btn-big-bg').addEventListener('click', () => {
        openBigTextEditor({
          title: '编辑背景设定',
          value: d.background,
          onSave: (val) => { d.background = val; bgEl.value = val; persistStudioState(); }
        });
      });

      // 一句话扩写为详细开卡灵感
      const expandBtn = bodyEl.querySelector('#btn-expand-concept');
      const stopConceptBtn = bodyEl.querySelector('#btn-stop-concept');
      bindStopButton(stopConceptBtn);
      expandBtn.addEventListener('click', async () => {
        syncDomToState();
        if (!d.oneLiner.trim() && !d.concept.trim()) {
          showStatus('请先输入一句话脑洞', 'warning');
          oneLinerEl.focus();
          return;
        }
        expandBtn.disabled = true;
        stopConceptBtn.classList.remove('hidden');
        await executeStep('concept', d, {
          onChunk: (full) => {
            d.concept = full;
            conceptEl.value = full;
            conceptEl.scrollTop = conceptEl.scrollHeight;
          },
          onFinished: (raw) => {
            d.concept = String(raw || '').trim();
            conceptEl.value = d.concept;
          },
          onAborted: (partial) => {
            d.concept = String(partial || '').trim();
            conceptEl.value = d.concept;
          }
        });
        expandBtn.disabled = false;
        stopConceptBtn.classList.add('hidden');
      });

      // 按详细灵感生成背景与主控（实时分段拆分到各自字段）
      const genBtn = bodyEl.querySelector('#btn-gen-world');
      const stopBtn = bodyEl.querySelector('#btn-stop-step');
      bindStopButton(stopBtn);
      const applyWorldOutput = (raw) => {
        const parsed = parseWorldAndMainControl(raw);
        if (parsed.cardName && !d.cardName.trim()) {
          d.cardName = parsed.cardName;
          nameEl.value = d.cardName;
        }
        d.background = parsed.background || '';
        bgEl.value = d.background;
        if (parsed.mainControlName) {
          d.mainControlName = parsed.mainControlName;
          mcNameEl.value = d.mainControlName;
        }
        if (parsed.mainControlDesc) {
          d.mainControlDesc = parsed.mainControlDesc;
          mcDescEl.value = d.mainControlDesc;
        }
      };

      genBtn.addEventListener('click', async () => {
        syncDomToState();
        if (!d.concept.trim() && !d.oneLiner.trim()) {
          showStatus('请先填写详细开卡灵感（或先用一句话脑洞扩写）', 'warning');
          conceptEl.focus();
          return;
        }
        if (!d.concept.trim() && d.oneLiner.trim()) {
          d.concept = d.oneLiner.trim();
          conceptEl.value = d.concept;
        }
        genBtn.disabled = true;
        stopBtn.classList.remove('hidden');
        await executeStep('world', d, {
          onChunk: (full) => {
            const parsed = parseWorldAndMainControl(full);
            if (parsed.background || parsed.mainControlName || parsed.mainControlDesc) {
              if (parsed.cardName && !d.cardName.trim()) nameEl.value = parsed.cardName;
              bgEl.value = parsed.background;
              if (parsed.mainControlName) mcNameEl.value = parsed.mainControlName;
              if (parsed.mainControlDesc) mcDescEl.value = parsed.mainControlDesc;
            } else {
              bgEl.value = full;
            }
          },
          onFinished: (raw) => {
            applyWorldOutput(raw);
            persistStudioState();
            render();
          },
          onAborted: (partial) => {
            applyWorldOutput(partial);
            persistStudioState();
          }
        });
        genBtn.disabled = false;
        stopBtn.classList.add('hidden');
      });
    } else if (studioState.step === 2) {
      const ideaEl = bodyEl.querySelector('#st-major-idea');
      const streamEl = bodyEl.querySelector('#st-major-streaming');
      bindTextField(ideaEl, (v) => { d.majorIdea = v; });

      bodyEl.querySelector('#btn-add-blank-major').addEventListener('click', () => {
        syncDomToState();
        d.majorModules.push('【一句话核心】\n\n【基础信息】\n完整全名：\n性别：\n年龄：\n职业与身份：');
        persistStudioState();
        render();
      });

      bodyEl.querySelectorAll('.st-major-textarea').forEach((ta) => {
        bindTextField(ta, (v) => { d.majorModules[Number(ta.dataset.idx)] = v; });
      });
      bodyEl.querySelectorAll('.btn-del-major').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDomToState();
          d.majorModules.splice(Number(btn.dataset.idx), 1);
          persistStudioState();
          render();
        });
      });
      bodyEl.querySelectorAll('.btn-big-major').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.idx);
          openBigTextEditor({
            title: `编辑重要角色 #${idx + 1}（v6.1）`,
            value: d.majorModules[idx] || '',
            onSave: (val) => { d.majorModules[idx] = val; persistStudioState(); render(); }
          });
        });
      });

      const genBtn = bodyEl.querySelector('#btn-gen-major');
      const stopBtn = bodyEl.querySelector('#btn-stop-step');
      bindStopButton(stopBtn);
      genBtn.addEventListener('click', async () => {
        syncDomToState();
        genBtn.disabled = true;
        stopBtn.classList.remove('hidden');
        streamEl.classList.remove('hidden');
        streamEl.value = '';
        await executeStep('major', d, {
          onChunk: (full) => { streamEl.value = full; streamEl.scrollTop = streamEl.scrollHeight; },
          onFinished: (raw) => {
            const cleaned = String(raw || '').trim();
            if (cleaned) {
              d.majorModules.push(cleaned);
              const names = extractCharacterNamesFromModules([cleaned]);
              if (!d.cardName.trim() && names[0]) d.cardName = names[0];
            }
            d.majorIdea = '';
            persistStudioState();
            render();
          },
          onAborted: (partial) => {
            const cleaned = String(partial || '').trim();
            if (cleaned) d.majorModules.push(cleaned);
            persistStudioState();
            render();
          }
        });
        genBtn.disabled = false;
        stopBtn.classList.add('hidden');
      });
    } else if (studioState.step === 3) {
      const ideaEl = bodyEl.querySelector('#st-sub-idea');
      const streamEl = bodyEl.querySelector('#st-sub-streaming');
      bindTextField(ideaEl, (v) => { d.supportingIdea = v; });

      bodyEl.querySelector('#btn-add-blank-sub').addEventListener('click', () => {
        syncDomToState();
        d.supportingModules.push('【配角·姓名】\n完整全名：\n一句话核心：');
        persistStudioState();
        render();
      });

      bodyEl.querySelectorAll('.st-sub-textarea').forEach((ta) => {
        bindTextField(ta, (v) => { d.supportingModules[Number(ta.dataset.idx)] = v; });
      });
      bodyEl.querySelectorAll('.btn-del-sub').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDomToState();
          d.supportingModules.splice(Number(btn.dataset.idx), 1);
          persistStudioState();
          render();
        });
      });
      bodyEl.querySelectorAll('.btn-big-sub').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.idx);
          openBigTextEditor({
            title: `编辑配角 #${idx + 1}`,
            value: d.supportingModules[idx] || '',
            onSave: (val) => { d.supportingModules[idx] = val; persistStudioState(); render(); }
          });
        });
      });

      const genBtn = bodyEl.querySelector('#btn-gen-sub');
      const stopBtn = bodyEl.querySelector('#btn-stop-step');
      bindStopButton(stopBtn);
      genBtn.addEventListener('click', async () => {
        syncDomToState();
        genBtn.disabled = true;
        stopBtn.classList.remove('hidden');
        streamEl.classList.remove('hidden');
        streamEl.value = '';
        await executeStep('supporting', d, {
          onChunk: (full) => { streamEl.value = full; streamEl.scrollTop = streamEl.scrollHeight; },
          onFinished: (raw) => {
            const cleaned = String(raw || '').trim();
            if (cleaned) d.supportingModules.push(cleaned);
            d.supportingIdea = '';
            persistStudioState();
            render();
          },
          onAborted: (partial) => {
            const cleaned = String(partial || '').trim();
            if (cleaned) d.supportingModules.push(cleaned);
            persistStudioState();
            render();
          }
        });
        genBtn.disabled = false;
        stopBtn.classList.add('hidden');
      });
    } else if (studioState.step === 4) {
      const noteEl = bodyEl.querySelector('#st-opening-note');
      const greetEl = bodyEl.querySelector('#st-greeting');
      const wbIdeaEl = bodyEl.querySelector('#st-wb-idea');
      bindTextField(noteEl, (v) => { d.openingNote = v; });
      bindTextField(greetEl, (v) => { d.greeting = v; });
      bindTextField(wbIdeaEl, (v) => { d.worldbookIdea = v; });

      bodyEl.querySelector('#btn-big-opening').addEventListener('click', () => {
        openBigTextEditor({
          title: '编辑开场白',
          value: d.greeting,
          onSave: (val) => { d.greeting = val; greetEl.value = val; persistStudioState(); }
        });
      });

      bodyEl.querySelectorAll('.st-wb-title').forEach((el) => {
        bindTextField(el, (v) => { d.worldBookEntries[Number(el.dataset.idx)].name = v; });
      });
      bodyEl.querySelectorAll('.st-wb-keys').forEach((el) => {
        bindTextField(el, (v) => {
          d.worldBookEntries[Number(el.dataset.idx)].keys = v.split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean);
        });
      });
      bodyEl.querySelectorAll('.st-wb-content').forEach((el) => {
        bindTextField(el, (v) => { d.worldBookEntries[Number(el.dataset.idx)].content = v; });
      });
      bodyEl.querySelectorAll('.btn-del-wb').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDomToState();
          d.worldBookEntries.splice(Number(btn.dataset.idx), 1);
          persistStudioState();
          render();
        });
      });

      const genOpeningBtn = bodyEl.querySelector('#btn-gen-opening');
      const stopBtn = bodyEl.querySelector('#btn-stop-step');
      bindStopButton(stopBtn);
      genOpeningBtn.addEventListener('click', async () => {
        syncDomToState();
        genOpeningBtn.disabled = true;
        stopBtn.classList.remove('hidden');
        await executeStep('opening', d, {
          extraInstruction: d.openingNote.trim(),
          onChunk: (full) => {
            d.greeting = full;
            greetEl.value = full;
            greetEl.scrollTop = greetEl.scrollHeight;
          },
          onFinished: (raw) => { d.greeting = String(raw || '').trim(); persistStudioState(); render(); },
          onAborted: (partial) => { d.greeting = String(partial || '').trim(); persistStudioState(); }
        });
        genOpeningBtn.disabled = false;
        stopBtn.classList.add('hidden');
      });

      const genWbBtn = bodyEl.querySelector('#btn-gen-wb');
      const stopWbBtn = bodyEl.querySelector('#btn-stop-wb');
      bindStopButton(stopWbBtn);
      genWbBtn.addEventListener('click', async () => {
        syncDomToState();
        genWbBtn.disabled = true;
        stopWbBtn.classList.remove('hidden');
        await executeStep('worldbook', d, {
          onFinished: (raw) => {
            const entries = parseWorldBookDraft(raw);
            if (!entries.length) {
              showStatus('未解析出有效世界书条目，可重试或微调要求', 'warning');
              return;
            }
            d.worldBookEntries.push(...entries);
            persistStudioState();
            render();
          }
        });
        genWbBtn.disabled = false;
        stopWbBtn.classList.add('hidden');
      });
    } else if (studioState.step === 5) {
      const nameEl = bodyEl.querySelector('#st-final-name');
      const groupEl = bodyEl.querySelector('#st-final-group');
      const offscreenEl = bodyEl.querySelector('#st-offscreen-roles');
      const outEl = bodyEl.querySelector('#st-output-preset');
      const thinkEl = bodyEl.querySelector('#st-thinking-preset');
      const randEl = bodyEl.querySelector('#st-random-narrative');

      bindTextField(nameEl, (v) => { d.cardName = v; });
      bindTextField(groupEl, (v) => { d.group = v; });
      bindTextField(offscreenEl, (v) => { d.offscreenRolesText = v; });
      outEl.addEventListener('change', () => { d.outputPresetId = outEl.value; persistStudioState(); });
      thinkEl.addEventListener('change', () => { d.thinkingPresetId = thinkEl.value; persistStudioState(); });
      randEl.addEventListener('change', () => { d.enableRandomNarrative = randEl.checked; persistStudioState(); });

      bodyEl.querySelector('#btn-save-new-card').addEventListener('click', async () => {
        syncDomToState();
        const finalName = nameEl.value.trim();
        if (!finalName) {
          showStatus('请先填写角色卡名称', 'warning');
          nameEl.focus();
          return;
        }
        const offscreenRoles = offscreenEl.value
          .split(/[\s,，、;；]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const id = await createCardId();
        const card = assembleCharacterCard({ ...d, cardName: finalName, offscreenRoles }, id);
        await saveCharacter(card);
        await refreshCharacters();
        studioState.lastCreatedCardId = card.id;
        persistStudioState();
        showStatus(`角色卡「${card.name}」已保存！`, 'success');
        render();
      });

      const chatBtn = bodyEl.querySelector('#btn-goto-chat');
      const editBtn = bodyEl.querySelector('#btn-goto-edit');
      if (chatBtn) chatBtn.addEventListener('click', () => navigate('chat', { characterId: studioState.lastCreatedCardId }));
      if (editBtn) editBtn.addEventListener('click', () => navigate('edit', { characterId: studioState.lastCreatedCardId }));
    }
  }

  // ==================================================================
  // 模式 2：已有卡增量联动（给老卡加重要角色 / 配角 / 补世界书）
  // ==================================================================
  function renderExtendMode(bodyEl) {
    if (!state.characters.length) {
      bodyEl.innerHTML = '<div class="studio-card"><div class="memory-empty">还没有已有角色卡，请先在「新建联动卡」里创建一张吧。</div></div>';
      return;
    }

    const selectedChar = state.characters.find((c) => c.id === studioState.extendCharId) || state.characters[0];
    studioState.extendCharId = selectedChar.id;
    const existingModules = getCharacterModules(selectedChar);
    const existingNames = extractCharacterNamesFromModules(existingModules);

    bodyEl.innerHTML = `
      <div class="studio-card">
        <div class="form-group">
          <label class="form-label">选择要联动扩展的已有角色卡</label>
          <select class="form-select" id="ext-char-select">
            ${state.characters.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === selectedChar.id ? ' selected' : ''}>${escapeHtml(c.name)}${c.group ? `（${escapeHtml(c.group)}）` : ''}</option>`).join('')}
          </select>
          <div class="form-hint" style="margin-top: 6px;">
            已有角色模块：${existingModules.length} 块${existingNames.length ? `（${escapeHtml(existingNames.join('、'))}）` : ''}；生成时将自动读取该卡的背景、主控与全部角色模块防撞脸防冲突。
          </div>
        </div>
      </div>

      <div class="studio-card">
        <div class="form-section-title" style="margin-top:0;">➕ 追加联动角色</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">新角色规格</label>
            <select class="form-select" id="ext-role-kind">
              <option value="supporting"${studioState.extendRoleKind === 'supporting' ? ' selected' : ''}>配角（v2 精简演绎版）</option>
              <option value="major"${studioState.extendRoleKind === 'major' ? ' selected' : ''}>重要角色（v6.1 高密度演绎版）</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">新角色构思（留空自动推荐）</label>
            <input class="form-input" id="ext-sub-idea" type="text" value="${escapeHtml(studioState.extendSubIdea)}" placeholder="例如：32岁投行经理，表面体面实则控制欲强">
          </div>
        </div>
        <div class="studio-action-row">
          <button type="button" class="btn btn-primary" id="btn-ext-gen-sub">✨ 联动生成${studioState.extendRoleKind === 'major' ? '重要角色（v6.1）' : '配角（v2）'}</button>
          <button type="button" class="btn btn-danger hidden" id="btn-ext-stop">停止</button>
        </div>
        <div class="form-group" style="margin-top: 10px;">
          <textarea class="form-textarea" id="ext-sub-result" rows="10" placeholder="生成结果将显示在这里，可修改后一键追加到角色卡…">${escapeHtml(studioState.extendSubResult)}</textarea>
        </div>
        <div class="studio-nav-footer">
          <span></span>
          <button type="button" class="btn btn-primary" id="btn-ext-append-sub">➕ 一键追加到该角色卡</button>
        </div>
      </div>

      <div class="studio-card">
        <div class="form-section-title" style="margin-top:0;">🌍 追加联动世界书条目</div>
        <div class="form-group">
          <input class="form-input" id="ext-wb-idea" type="text" value="${escapeHtml(studioState.extendWbIdea)}" placeholder="输入想补充的地点、组织、行业规则或共享旧事（留空自动提炼）">
        </div>
        <div class="studio-action-row" style="margin-bottom: 10px;">
          <button type="button" class="btn btn-ghost" id="btn-ext-gen-wb">✨ 提炼世界书条目</button>
          <button type="button" class="btn btn-danger hidden" id="btn-ext-stop-wb">停止</button>
        </div>
        <div id="ext-wb-list" class="studio-sub-list">
          ${studioState.extendWbEntries.length
    ? studioState.extendWbEntries.map((e, i) => `
              <div class="studio-sub-card">
                <div class="studio-sub-card-head">
                  <strong>${escapeHtml(e.name || '世界书条目')}</strong>
                  <button type="button" class="btn btn-danger btn-small btn-ext-del-wb" data-idx="${i}">移除</button>
                </div>
                <div class="form-hint" style="margin:4px 0;">关键词：${escapeHtml((e.keys || []).join('、') || '常驻')}</div>
                <div style="font-size:0.86rem;white-space:pre-wrap;color:var(--text-secondary);">${escapeHtml(e.content)}</div>
              </div>
            `).join('')
    : '<div class="memory-empty">点击上方提炼后可预览并一键追加</div>'}
        </div>
        ${studioState.extendWbEntries.length ? `
          <div class="studio-nav-footer">
            <span></span>
            <button type="button" class="btn btn-primary" id="btn-ext-append-wb">➕ 一键追加进该卡世界书</button>
          </div>
        ` : ''}
      </div>
    `;

    bodyEl.querySelector('#ext-char-select').addEventListener('change', (e) => {
      studioState.extendCharId = e.target.value;
      studioState.extendSubResult = '';
      studioState.extendWbEntries = [];
      persistStudioState();
      render();
    });

    bodyEl.querySelector('#ext-role-kind').addEventListener('change', (e) => {
      studioState.extendRoleKind = e.target.value === 'major' ? 'major' : 'supporting';
      persistStudioState();
      render();
    });

    const subIdeaEl = bodyEl.querySelector('#ext-sub-idea');
    const subResEl = bodyEl.querySelector('#ext-sub-result');
    const wbIdeaEl = bodyEl.querySelector('#ext-wb-idea');
    bindTextField(subIdeaEl, (v) => { studioState.extendSubIdea = v; });
    bindTextField(subResEl, (v) => { studioState.extendSubResult = v; });
    bindTextField(wbIdeaEl, (v) => { studioState.extendWbIdea = v; });

    const genSubBtn = bodyEl.querySelector('#btn-ext-gen-sub');
    const stopSubBtn = bodyEl.querySelector('#btn-ext-stop');
    bindStopButton(stopSubBtn);
    genSubBtn.addEventListener('click', async () => {
      const fullChar = await getCharacter(studioState.extendCharId);
      if (!fullChar) return;
      const stepKind = studioState.extendRoleKind === 'major' ? 'major' : 'supporting';
      const baseDraft = {
        ...draftFromExistingCharacter(fullChar),
        includeAdult: studioState.draft.includeAdult,
        majorIdea: studioState.extendSubIdea,
        supportingIdea: studioState.extendSubIdea
      };
      genSubBtn.disabled = true;
      stopSubBtn.classList.remove('hidden');
      await executeStep(stepKind, baseDraft, {
        onChunk: (full) => {
          studioState.extendSubResult = full;
          subResEl.value = full;
          subResEl.scrollTop = subResEl.scrollHeight;
        },
        onFinished: (raw) => { studioState.extendSubResult = String(raw || '').trim(); },
        onAborted: (partial) => { studioState.extendSubResult = String(partial || '').trim(); }
      });
      genSubBtn.disabled = false;
      stopSubBtn.classList.add('hidden');
    });

    bodyEl.querySelector('#btn-ext-append-sub').addEventListener('click', async () => {
      syncDomToState();
      const text = studioState.extendSubResult.trim();
      if (!text) {
        showStatus('请先生成或填写角色内容', 'warning');
        return;
      }
      const fullChar = await getCharacter(studioState.extendCharId);
      if (!fullChar) return;
      const mods = getCharacterModules(fullChar);
      mods.push(text);
      fullChar.characterModules = mods;
      delete fullChar.description;
      delete fullChar.subCharacters;
      const newNames = extractCharacterNamesFromModules([text]);
      if (Array.isArray(fullChar.offscreenRoles) && fullChar.offscreenRoles.length && newNames[0]) {
        if (!fullChar.offscreenRoles.includes(newNames[0])) fullChar.offscreenRoles.push(newNames[0]);
      }
      await saveCharacter(fullChar);
      await refreshCharacters();
      studioState.extendSubResult = '';
      studioState.extendSubIdea = '';
      persistStudioState();
      showStatus(`已将新角色${newNames[0] ? `「${newNames[0]}」` : ''}追加到「${fullChar.name}」`, 'success');
      render();
    });

    const genWbBtn = bodyEl.querySelector('#btn-ext-gen-wb');
    const stopWbBtn = bodyEl.querySelector('#btn-ext-stop-wb');
    bindStopButton(stopWbBtn);
    genWbBtn.addEventListener('click', async () => {
      const fullChar = await getCharacter(studioState.extendCharId);
      if (!fullChar) return;
      const baseDraft = { ...draftFromExistingCharacter(fullChar), worldbookIdea: studioState.extendWbIdea };
      genWbBtn.disabled = true;
      stopWbBtn.classList.remove('hidden');
      await executeStep('worldbook', baseDraft, {
        onFinished: (raw) => {
          const entries = parseWorldBookDraft(raw);
          if (!entries.length) {
            showStatus('未解析出有效世界书条目，可重试', 'warning');
            return;
          }
          studioState.extendWbEntries = entries;
          persistStudioState();
          render();
        }
      });
      genWbBtn.disabled = false;
      stopWbBtn.classList.add('hidden');
    });

    bodyEl.querySelectorAll('.btn-ext-del-wb').forEach((btn) => {
      btn.addEventListener('click', () => {
        studioState.extendWbEntries.splice(Number(btn.dataset.idx), 1);
        persistStudioState();
        render();
      });
    });

    const appendWbBtn = bodyEl.querySelector('#btn-ext-append-wb');
    if (appendWbBtn) {
      appendWbBtn.addEventListener('click', async () => {
        const fullChar = await getCharacter(studioState.extendCharId);
        if (!fullChar) return;
        const wb = normalizeWorldBookSettings(fullChar.worldBook);
        wb.enabled = true;
        wb.entries = [...(wb.entries || []), ...studioState.extendWbEntries];
        fullChar.worldBook = wb;
        await saveCharacter(fullChar);
        await refreshCharacters();
        const count = studioState.extendWbEntries.length;
        studioState.extendWbEntries = [];
        studioState.extendWbIdea = '';
        persistStudioState();
        showStatus(`已向「${fullChar.name}」追加 ${count} 条世界书条目`, 'success');
        render();
      });
    }
  }

  // ==================================================================
  // 模式 3：一键建通用模拟器卡（内置 v1.2）
  // ==================================================================
  function renderSimulatorMode(bodyEl) {
    bodyEl.innerHTML = `
      <div class="studio-card">
        <div class="form-section-title" style="margin-top:0;">🌍 一键创建《通用人生模拟器母卡 v1.2》</div>
        <div class="form-hint" style="margin-bottom: 14px;">
          自动写入最新 v1.2 母卡规则（含完整全名铁律、NPC 节制退场、$场外速报 / $补充设定补丁元指令、大跨度三步推进）与多题材开场白，并自动关闭冲突的「随机 NPC/事件」开关。创建后直接进聊天发 <code>$初始化模拟器：……</code> 即可开玩。
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">角色卡名称</label>
            <input class="form-input" id="sim-name" type="text" value="${escapeHtml(studioState.simName)}">
          </div>
          <div class="form-group">
            <label class="form-label">分组</label>
            <input class="form-input" id="sim-group" type="text" value="${escapeHtml(studioState.simGroup)}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">输出格式模板</label>
            <select class="form-select" id="sim-output-preset">${presetOptionsHtml(outputPresets, studioState.simOutputPresetId)}</select>
          </div>
          <div class="form-group">
            <label class="form-label">思维链模板</label>
            <select class="form-select" id="sim-thinking-preset">${presetOptionsHtml(thinkingPresets, studioState.simThinkingPresetId)}</select>
          </div>
        </div>
        <div class="studio-nav-footer">
          <span></span>
          <button type="button" class="btn btn-primary" id="btn-create-sim">🚀 一键创建模拟器卡</button>
        </div>
        ${studioState.lastCreatedCardId ? `
          <div class="studio-success-banner">
            <span>✅ 模拟器卡已创建完成！</span>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
              <button type="button" class="btn btn-primary btn-small" id="btn-sim-goto-chat">💬 立即开局</button>
              <button type="button" class="btn btn-ghost btn-small" id="btn-sim-goto-edit">✏️ 查看/编辑卡</button>
            </div>
          </div>
        ` : ''}
      </div>
    `;

    bindTextField(bodyEl.querySelector('#sim-name'), (v) => { studioState.simName = v; });
    bindTextField(bodyEl.querySelector('#sim-group'), (v) => { studioState.simGroup = v; });
    bodyEl.querySelector('#sim-output-preset').addEventListener('change', (e) => { studioState.simOutputPresetId = e.target.value; persistStudioState(); });
    bodyEl.querySelector('#sim-thinking-preset').addEventListener('change', (e) => { studioState.simThinkingPresetId = e.target.value; persistStudioState(); });

    bodyEl.querySelector('#btn-create-sim').addEventListener('click', async () => {
      syncDomToState();
      const id = await createCardId();
      const card = buildSimulatorCardObject({
        name: studioState.simName,
        group: studioState.simGroup,
        outputPresetId: studioState.simOutputPresetId,
        thinkingPresetId: studioState.simThinkingPresetId
      }, id);
      await saveCharacter(card);
      await refreshCharacters();
      studioState.lastCreatedCardId = card.id;
      persistStudioState();
      showStatus(`模拟器卡「${card.name}」已创建！`, 'success');
      render();
    });

    const chatBtn = bodyEl.querySelector('#btn-sim-goto-chat');
    const editBtn = bodyEl.querySelector('#btn-sim-goto-edit');
    if (chatBtn) chatBtn.addEventListener('click', () => navigate('chat', { characterId: studioState.lastCreatedCardId }));
    if (editBtn) editBtn.addEventListener('click', () => navigate('edit', { characterId: studioState.lastCreatedCardId }));
  }

  render();
}
