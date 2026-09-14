// 记忆编辑器：🧠 全屏弹窗；页签两行（短/长/事实 | 种子/锚点）。
// 自包含模块——自己建遮罩、绑事件、保存，输入仅 (chat, character, onUpdate)，与聊天页状态零耦合。
// migrateMemory 也住在这里：它既被编辑器调用，也被聊天页打开旧对话时做结构迁移。
import { saveCharacter, saveChat, saveAnchorRefImage, deleteAnchorRefImage, getGeneratedImageDataUrl, getPlotPresets, savePlotPreset, deletePlotPreset } from '../services/storage.js';
import {
  summarizeShortTermMemories,
  condenseLongTermMemory,
  RAW_WINDOW_TURNS,
  SHORT_TERM_LIMIT,
  LONG_TERM_REFERENCE_COUNT,
  normalizeFacts,
  formatFactsMemo
} from '../services/api-memory.js';
import { anchorTextOf, anchorImgOf } from '../services/image-gen.js';
import { migrateChat } from '../services/migrations.js';
import { promptText } from '../utils/prompt-dialog.js';
import { countTokens } from '../utils/tokenizer.js';
import { openBigTextEditor } from '../utils/big-editor.js';

// 参考图上传前压缩：最长边 ≤1024px 转 jpeg（脸特征足够，省存储省上传）
function resizeImageDataUrl(dataUrl, maxDim = 1024) {
  return new Promise((resolve) => {
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
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function migrateMemory(chat) {
  // 实现已集中到 migrations.js（与 storage.normalizeChatMemory 同源，逻辑不再重复）
  migrateChat(chat);
}

export async function openMemoryEditor(chat, character, onUpdate) {
  // 移除已存在的编辑器
  const existing = document.querySelector('.memory-editor-overlay');
  if (existing) existing.remove();

  // 确保 memory 结构为新版长期记忆
  migrateMemory(chat);

  // 使用本地可变副本，避免依赖 DOM 收集时出现的浏览器/时序问题
  let shortTermMemories = [...(chat.memory.shortTerm || [])];
  let longTermMemories = [...(chat.memory.longTerm || [])];
  // 事实备忘（本地副本）；mcName：主控真名，关系端点归一化用（「主控」→真名）
  const mcName = (character && character.mainControl && character.mainControl.name) || '';
  let factsEdit = normalizeFacts(chat.memory.facts, mcName);
  // 免费生图记忆（本地副本，保存时写回 chat.seedArchive；{角色名: {seed, anchor}} 形态）
  let seedArchiveEdit = Object.fromEntries(
    Object.entries(chat.seedArchive || {}).map(([k, v]) => [k, (v && typeof v === 'object')
      ? { seed: Number.isFinite(v.seed) ? v.seed : 0, anchor: typeof v.anchor === 'string' ? v.anchor : '' }
      : { seed: v, anchor: '' }])
  );
  // 生图外貌身材锚点档案（本地副本，保存时写回 chat.appearanceAnchors；{角色名: {text, img}} 形态，
  // img = 参考图存储相对路径；migrateChat 已把旧字符串形态升级为对象，这里再做一层防御）
  let appearanceAnchorsEdit = Object.fromEntries(
    Object.entries(chat.appearanceAnchors || {}).map(([k, v]) => [k, {
      text: anchorTextOf(v),
      img: anchorImgOf(v)
    }])
  );
  // 对话补充设定（本地副本，保存时写回 chat.memory.supplement；常驻注入 system，仅本对话生效）
  let supplementEdit = String((chat.memory && chat.memory.supplement) || '');
  // 剧情线（本地副本，保存时写回 chat.plot；{mode, current, stages:[{title, content, condition, branches}]}）
  let plotEdit = (() => {
    const p = chat.plot;
    if (p && typeof p === 'object') {
      return {
        mode: p.mode === 'hard' ? 'hard' : 'soft',
        current: Number.isFinite(p.current) ? p.current : 1,
        stages: (Array.isArray(p.stages) ? p.stages : []).map((s) => ({
          title: String((s && s.title) || ''),
          content: String((s && s.content) || ''),
          condition: String((s && s.condition) || ''),
          branches: String((s && s.branches) || '')
        }))
      };
    }
    return { mode: 'soft', current: 1, stages: [] };
  })();
  // 剧情线库（全局预设，打开后异步加载）
  let plotPresets = {};
  // 当前激活的记忆页签：'short' 短期 / 'long' 长期 / 'facts' 事实备忘 / 'seeds' 插图种子 / 'anchors' 外貌身材锚点 / 'supplement' 补充设定 / 'plot' 剧情线
  let activeTab = 'short';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay memory-editor-overlay';
  overlay.innerHTML = `
    <div class="modal memory-editor-modal">
      <div class="modal-header">
        <h2>编辑记忆</h2>
        <button class="btn btn-ghost btn-icon" id="btn-close-memory">✕</button>
      </div>
      <div class="modal-body memory-editor-body">
        <div class="memory-sys-controls">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin: 0;">
            <input type="checkbox" id="mem-enabled-toggle" ${character.memoryEnabled !== false ? 'checked' : ''}>
            <span>启用记忆系统</span>
          </label>
          <label id="mem-raw-window-label" style="display: flex; align-items: center; gap: 8px; margin: 0; ${character.memoryEnabled !== false ? 'opacity: 0.5;' : ''}">
            <span>携带最近</span>
            <input type="number" class="form-input" id="mem-raw-window" style="width: 64px;" min="0" max="50" value="${Number.isFinite(Number(character.rawWindowTurns)) ? Math.max(0, Math.min(50, Math.trunc(Number(character.rawWindowTurns)))) : 3}" ${character.memoryEnabled !== false ? 'disabled' : ''}>
            <span>轮对话</span>
          </label>
          <span class="memory-sys-hint">关闭记忆后不再总结/注入，仅按设定轮数携带原文</span>
        </div>
        <div class="memory-tabs">
          <div class="memory-tabs-row">
            <button class="btn btn-primary btn-small memory-tab-btn" id="tab-short" data-tab="short">短期记忆</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-long" data-tab="long">长期记忆</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-facts" data-tab="facts">事实备忘</button>
          </div>
          <div class="memory-tabs-row">
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-seeds" data-tab="seeds">免费生图记忆</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-anchors" data-tab="anchors">外貌锚点</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-supplement" data-tab="supplement">补充设定</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-plot" data-tab="plot">剧情线</button>
          </div>
        </div>
        <div class="memory-tab-content" id="memory-content">
          <!-- 动态内容 -->
        </div>
      </div>
      <div class="modal-footer">
        <div class="char-counter" id="memory-counter">0 tokens</div>
        <button class="btn btn-ghost" id="btn-cancel-memory">取消</button>
        <button class="btn btn-primary" id="btn-save-memory">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // 剧情线库异步加载（不阻塞弹窗；加载完成时若正停在剧情页签则重绘出方案列表）
  getPlotPresets().then((p) => {
    plotPresets = p || {};
    if (activeTab === 'plot') renderContent();
  }).catch(() => {});

  const contentEl = document.getElementById('memory-content');
  const counterEl = document.getElementById('memory-counter');

  // 角色卡级：记忆开关 + 携带轮数（仅当前卡生效，立即存到 character）
  const memToggle = document.getElementById('mem-enabled-toggle');
  const memRawInput = document.getElementById('mem-raw-window');
  const memRawLabel = document.getElementById('mem-raw-window-label');
  const syncMemoryControls = () => {
    const on = memToggle.checked;
    memRawInput.disabled = on;
    if (memRawLabel) memRawLabel.style.opacity = on ? '0.5' : '1';
  };
  memToggle.addEventListener('change', async () => {
    character.memoryEnabled = memToggle.checked;
    await saveCharacter(character);
    syncMemoryControls();
    renderContent();
  });
  memRawInput.addEventListener('change', async () => {
    let v = parseInt(memRawInput.value, 10);
    if (isNaN(v)) v = 3;
    v = Math.max(0, Math.min(50, v));
    memRawInput.value = String(v);
    character.rawWindowTurns = v;
    await saveCharacter(character);
  });
  syncMemoryControls();

  function formatRoundRange(rounds) {
    if (rounds === undefined) return '—';
    if (!Array.isArray(rounds) || rounds.length === 0) return '已精简';
    const sorted = [...new Set(rounds)].sort((a, b) => a - b);
    const ranges = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === prev + 1) { prev = sorted[i]; continue; }
      ranges.push(start === prev ? `${start}` : `${start}~${prev}`);
      if (i < sorted.length) { start = sorted[i]; prev = sorted[i]; }
    }
    return '第 ' + ranges.join(', ') + ' 轮';
  }

  function updateCounter() {
    const text = JSON.stringify({ shortTerm: shortTermMemories, longTerm: longTermMemories, facts: factsEdit, supplement: supplementEdit });
    const tokens = countTokens(text);
    counterEl.textContent = `${tokens} tokens`;
  }

  function factsCount() {
    return (factsEdit.promises?.length || 0)
      + (factsEdit.relations?.length || 0)
      + (factsEdit.intel?.length || 0);
  }

  function renderContent() {
    const shortTerm = shortTermMemories;
    const longTerm = longTermMemories;

    const shortTermHtml = shortTerm.length === 0
      ? '<div class="memory-empty">暂无短期记忆</div>'
      : shortTerm.map((item, index) => `
          <div class="memory-card memory-card-short" data-index="${index}">
            <div class="memory-card-header">
              <span class="memory-round-badge">${Number.isFinite(item.round) ? '第 ' + item.round + ' 轮' : '—'}</span>
              <input type="date" class="form-input memory-date-input" value="${escapeHtml(item.date || '')}">
              <button class="btn btn-danger btn-small btn-delete-short" data-index="${index}">删除</button>
            </div>
            <textarea class="form-textarea memory-content" placeholder="短期记忆摘要" rows="2">${escapeHtml(item.content || '')}</textarea>
          </div>
        `).join('');

    const longTermHtml = longTerm.length === 0
      ? '<div class="memory-empty">暂无长期记忆</div>'
      : longTerm.map((item, index) => `
          <div class="memory-card memory-card-long" data-index="${index}">
            <div class="memory-card-header memory-card-header-long">
              <div class="memory-card-row-top">
                <span class="memory-round-badge">${formatRoundRange(item.sourceRounds)}</span>
                <button class="btn ${item.pinned ? 'btn-primary' : 'btn-ghost'} btn-small btn-pin-long" data-index="${index}" title="加星常驻：全文注入，永不降级为目录">★</button>
                <button class="btn btn-danger btn-small btn-delete-long" data-index="${index}">删除</button>
              </div>
              <div class="memory-date-range">
                <input type="date" class="form-input memory-date-input" value="${escapeHtml(item.startDate || '')}">
                <span>至</span>
                <input type="date" class="form-input memory-date-input" value="${escapeHtml(item.endDate || '')}">
              </div>
            </div>
            <input type="text" class="form-input memory-long-title" value="${escapeHtml(item.title || '')}" placeholder="目录标题（≤25字，含人名与事件；降级为目录后凭它召回）" style="margin-bottom:6px;">
            <textarea class="form-textarea memory-content memory-long-content" placeholder="长期记忆内容（点击展开大窗口编辑）" rows="3" readonly>${escapeHtml(item.content || '')}</textarea>
          </div>
        `).join('');

    const shortTermModeHint = `每轮滞后 ${RAW_WINDOW_TURNS} 轮总结 · 进度 ${shortTerm.length}/${SHORT_TERM_LIMIT}（满 ${SHORT_TERM_LIMIT} 条自动压缩成长期记忆）`;

    // 更新顶部页签的标题与激活态（短文案 + 数量，避免撑破窄屏）
    const shortTabBtn = document.getElementById('tab-short');
    const longTabBtn = document.getElementById('tab-long');
    const factsTabBtn = document.getElementById('tab-facts');
    const seedsTabBtn = document.getElementById('tab-seeds');
    const anchorsTabBtn = document.getElementById('tab-anchors');
    const supplementTabBtn = document.getElementById('tab-supplement');
    const plotTabBtn = document.getElementById('tab-plot');
    if (shortTabBtn && longTabBtn && factsTabBtn && seedsTabBtn && anchorsTabBtn && supplementTabBtn && plotTabBtn) {
      shortTabBtn.textContent = `短期（${shortTerm.length}）`;
      longTabBtn.textContent = `长期（${longTerm.length}）`;
      factsTabBtn.textContent = `事实（${factsCount()}）`;
      seedsTabBtn.textContent = `免费生图（${Object.keys(seedArchiveEdit).length}）`;
      anchorsTabBtn.textContent = `锚点（${Object.keys(appearanceAnchorsEdit).length}）`;
      supplementTabBtn.textContent = `补充（${supplementEdit.trim().length}字）`;
      plotTabBtn.textContent = `剧情（${plotEdit.stages.length}）`;
      shortTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'short' ? 'btn-primary' : 'btn-ghost');
      longTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'long' ? 'btn-primary' : 'btn-ghost');
      factsTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'facts' ? 'btn-primary' : 'btn-ghost');
      seedsTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'seeds' ? 'btn-primary' : 'btn-ghost');
      anchorsTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'anchors' ? 'btn-primary' : 'btn-ghost');
      supplementTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'supplement' ? 'btn-primary' : 'btn-ghost');
      plotTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'plot' ? 'btn-primary' : 'btn-ghost');
    }

    if (activeTab === 'plot') {
      const stageCards = plotEdit.stages.map((s, i) => {
        const isCurrent = (plotEdit.current || 1) === i + 1;
        return `
        <div class="memory-card">
          <div class="memory-card-header">
            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; flex: 1; min-width: 0;" title="点圆点把当前阶段切到这里">
              <input type="radio" name="plot-current" data-idx="${i}" ${isCurrent ? 'checked' : ''}>
              <span style="font-size: 0.9rem; font-weight: 600;">第 ${i + 1} 阶段${isCurrent ? '（当前·注入中）' : ''}</span>
            </label>
            <button class="btn btn-ghost btn-small btn-plot-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-ghost btn-small btn-plot-down" data-idx="${i}" ${i === plotEdit.stages.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn btn-danger btn-small btn-plot-del" data-idx="${i}">删除</button>
          </div>
          <input type="text" class="form-input plot-title-input" data-idx="${i}" value="${escapeHtml(s.title)}" placeholder="阶段标题（如：破冰期）" style="margin-bottom: 6px;">
          <textarea class="form-textarea plot-content-input" data-idx="${i}" rows="2" placeholder="方向/氛围/关键事件——写方向和节点，不写台词和结果；分支提示可直接写在文本里">${escapeHtml(s.content)}</textarea>
          <input type="text" class="form-input plot-condition-input" data-idx="${i}" value="${escapeHtml(s.condition)}" placeholder="推进条件：什么发生了算走完这阶段（满足也不自动翻章，等你触发）" style="margin-top: 6px;">
          <input type="text" class="form-input plot-branches-input" data-idx="${i}" value="${escapeHtml(s.branches)}" placeholder="支线种子（可空）：本阶段可能长出的支线，长出后由状态栏事件追踪承载" style="margin-top: 6px;">
        </div>`;
      }).join('');
      contentEl.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">剧情线（主剧情线，把控整体走向）</div>
        <div class="memory-section-hint" style="font-size: 12px; color: #888; margin: 2px 0 8px;">只注入当前阶段，推进节奏归你：点阶段前的圆点直接切换当前阶段；聊天页「📖」按钮=收束本章并推进到下一阶段。引力=选择优先（可与自由世界书共存）；铁轨=剧情优先（建议卸载《世界运行底层规则》，自带掀桌条款）。支线种子长出后由状态栏「事件追踪」承载，不占指针。</div>
        <div class="form-group" style="display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 10px;">
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="radio" name="plot-mode" value="soft" ${plotEdit.mode !== 'hard' ? 'checked' : ''}> 引力（选择优先）</label>
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="radio" name="plot-mode" value="hard" ${plotEdit.mode === 'hard' ? 'checked' : ''}> 铁轨（剧情优先）</label>
        </div>
        <div class="form-group">
          <label class="form-label">剧情线库（全局预设，读取为副本，改动不影响库）</label>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <select class="form-input" id="plot-preset-select" style="min-width: 150px; flex: 1;">
              <option value="">-- 选择一条剧情线 --</option>
              ${Object.keys(plotPresets).map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
            </select>
            <button class="btn btn-ghost btn-small" id="btn-plot-load">读取</button>
            <button class="btn btn-ghost btn-small" id="btn-plot-save-as">另存为…</button>
            <button class="btn btn-ghost btn-small" id="btn-plot-del-preset">删除</button>
          </div>
        </div>
        <div class="memory-list">${stageCards || '<div class="memory-empty">暂无阶段——从剧情线库读取，或手动添加</div>'}</div>
        <button class="btn btn-ghost btn-small" id="btn-plot-add" style="margin-top: 8px;">＋ 添加阶段</button>
      </div>
      `;

      contentEl.querySelectorAll('input[name="plot-mode"]').forEach((r) => {
        r.addEventListener('change', () => { plotEdit.mode = r.value === 'hard' ? 'hard' : 'soft'; });
      });
      contentEl.querySelectorAll('input[name="plot-current"]').forEach((r) => {
        r.addEventListener('change', () => {
          plotEdit.current = Number(r.dataset.idx) + 1;
          renderContent();
        });
      });
      const bindPlotInput = (sel, field) => {
        contentEl.querySelectorAll(sel).forEach((el) => {
          el.addEventListener('change', () => {
            const s = plotEdit.stages[Number(el.dataset.idx)];
            if (s) s[field] = el.value;
          });
        });
      };
      bindPlotInput('.plot-title-input', 'title');
      bindPlotInput('.plot-content-input', 'content');
      bindPlotInput('.plot-condition-input', 'condition');
      bindPlotInput('.plot-branches-input', 'branches');
      contentEl.querySelectorAll('.btn-plot-del').forEach((btn) => {
        btn.addEventListener('click', () => {
          plotEdit.stages.splice(Number(btn.dataset.idx), 1);
          plotEdit.current = Math.min(plotEdit.current || 1, Math.max(plotEdit.stages.length, 1));
          renderContent();
        });
      });
      contentEl.querySelectorAll('.btn-plot-up').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.idx);
          if (i <= 0) return;
          [plotEdit.stages[i - 1], plotEdit.stages[i]] = [plotEdit.stages[i], plotEdit.stages[i - 1]];
          renderContent();
        });
      });
      contentEl.querySelectorAll('.btn-plot-down').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.idx);
          if (i >= plotEdit.stages.length - 1) return;
          [plotEdit.stages[i], plotEdit.stages[i + 1]] = [plotEdit.stages[i + 1], plotEdit.stages[i]];
          renderContent();
        });
      });
      const addPlotBtn = contentEl.querySelector('#btn-plot-add');
      if (addPlotBtn) {
        addPlotBtn.addEventListener('click', () => {
          plotEdit.stages.push({ title: '', content: '', condition: '', branches: '' });
          renderContent();
        });
      }
      // 剧情线库：读取为副本（指针回 1）/ 另存为 / 删除
      contentEl.querySelector('#btn-plot-load').addEventListener('click', () => {
        const name = contentEl.querySelector('#plot-preset-select').value;
        if (!name || !plotPresets[name]) { alert('请先选择一条剧情线'); return; }
        if (plotEdit.stages.length && !confirm('读取会用库里的剧情线覆盖当前副本，确定吗？')) return;
        const p = plotPresets[name];
        plotEdit = {
          mode: p.mode === 'hard' ? 'hard' : 'soft',
          current: 1,
          stages: (p.stages || []).map((s) => ({
            title: String(s.title || ''), content: String(s.content || ''),
            condition: String(s.condition || ''), branches: String(s.branches || '')
          }))
        };
        renderContent();
      });
      contentEl.querySelector('#btn-plot-save-as').addEventListener('click', async () => {
        const name = await promptText({
          title: '保存到剧情线库',
          placeholder: '剧情线名称，如：临海市-新人上位线'
        });
        if (name === null || !String(name).trim()) return;
        const trimmed = String(name).trim();
        if (plotPresets[trimmed] && !confirm(`剧情线 "${trimmed}" 已存在，确定覆盖吗？`)) return;
        await savePlotPreset(trimmed, plotEdit);
        plotPresets = await getPlotPresets().catch(() => plotPresets);
        renderContent();
        alert(`剧情线 "${trimmed}" 已保存`);
      });
      contentEl.querySelector('#btn-plot-del-preset').addEventListener('click', async () => {
        const name = contentEl.querySelector('#plot-preset-select').value;
        if (!name) { alert('请先选择一条剧情线'); return; }
        if (!confirm(`确定删除剧情线 "${name}" 吗？（不影响当前对话的副本）`)) return;
        await deletePlotPreset(name);
        plotPresets = await getPlotPresets().catch(() => plotPresets);
        renderContent();
      });

      updateCounter();
      return;
    }

    if (activeTab === 'supplement') {
      // 对话补充设定：单文本区，常驻注入 system（与角色卡冲突以本区为准）；仅本对话生效，不动角色卡
      contentEl.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">对话补充设定（${supplementEdit.trim().length} 字）</div>
        <div class="memory-section-hint" style="font-size: 12px; color: #888; margin: 2px 0 8px;">仅当前对话生效，不影响角色卡。写临时的想法、对本卡的改动、retcon——常驻注入，每轮随 system 发给 AI；与角色卡冲突时以这里为准。它每轮都占 token，写完留意字数。</div>
        <textarea class="form-textarea" id="supplement-text" rows="12" style="font-size: 0.9rem; line-height: 1.6;" placeholder="例如：苏晴其实是主控的大学同学，两人都在装不认识；本档节奏放慢，禁止快速进入亲密戏。">${escapeHtml(supplementEdit)}</textarea>
      </div>
      `;
      const textarea = contentEl.querySelector('#supplement-text');
      textarea.addEventListener('input', () => {
        supplementEdit = textarea.value;
        // 轻量刷新页签字数，不整页重渲染（避免输入中丢焦点）
        const btn = document.getElementById('tab-supplement');
        if (btn) btn.textContent = `补充（${supplementEdit.trim().length}字）`;
        updateCounter();
      });
      updateCounter();
      return;
    }

    if (activeTab === 'facts') {
      const promiseRows = (factsEdit.promises || []).map((p, index) => `
        <div class="memory-card" data-index="${index}" style="display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <select class="form-input fact-promise-status" data-index="${index}" style="width:100px;">
              <option value="open" ${p.status !== 'done' ? 'selected' : ''}>进行中</option>
              <option value="done" ${p.status === 'done' ? 'selected' : ''}>已完成</option>
            </select>
            <button class="btn btn-danger btn-small btn-del-promise" data-index="${index}">删除</button>
          </div>
          <input type="text" class="form-input fact-promise-text" data-index="${index}" value="${escapeHtml(p.text)}" placeholder="约定内容（敷衍/欺骗式承诺前加【敷衍】【谎言】标记）">
        </div>
      `).join('');
      const relationRows = (factsEdit.relations || []).map((r, index) => `
        <div class="memory-card" style="display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="text" class="form-input fact-rel-from" data-index="${index}" value="${escapeHtml(r.from || '')}" placeholder="A（全名）" style="width:110px;">
            <span style="flex-shrink:0;">→</span>
            <input type="text" class="form-input fact-rel-to" data-index="${index}" value="${escapeHtml(r.to || '')}" placeholder="B（全名或主控）" style="width:110px;">
            <button class="btn btn-danger btn-small btn-del-rel" data-index="${index}">删除</button>
          </div>
          <input type="text" class="form-input fact-rel-note" data-index="${index}" value="${escapeHtml(r.note || '')}" placeholder="A 是 B 的…（身份关系+状态词；指向主控可附数值段，如：同事｜好感45/100｜阶段:信任）">
        </div>
      `).join('');
      const intelRows = (factsEdit.intel || []).map((item, index) => `
        <div class="memory-card" style="display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="text" class="form-input fact-intel-text" data-index="${index}" value="${escapeHtml(item.text || '')}" placeholder="情报内容（如：主控已婚）" style="flex:1;">
            <button class="btn btn-danger btn-small btn-del-intel" data-index="${index}">删除</button>
          </div>
          <input type="text" class="form-input fact-intel-knownby" data-index="${index}" value="${escapeHtml((item.knownBy || []).join('、'))}" placeholder="可知名单：人名用顿号分隔；全员写「公开」">
        </div>
      `).join('');

      contentEl.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">事实备忘</div>
        <div class="memory-section-hint" style="font-size: 12px; color: #888; margin: 2px 0 12px;">
          由每轮记忆总结自动抽取并合并；压缩短期/长期<strong>不会清空</strong>本页。发送时注入 system【事实备忘】（含知情约束）。可在此手改。约定/情报有录入门槛（跨轮才兑现的约定、有保密价值的情报），清单常年应保持很少。
        </div>
        <div class="memory-section-title" style="font-size:0.95rem;">未完成/历史约定（${factsEdit.promises.length}）</div>
        <div class="memory-list">${promiseRows || '<div class="memory-empty">暂无约定</div>'}</div>
        <button class="btn btn-ghost btn-small" id="btn-add-promise" style="margin:8px 0 16px;">＋ 添加约定</button>
        <div class="memory-section-title" style="font-size:0.95rem;">人物关系（${factsEdit.relations.length}）</div>
        <div class="memory-list">${relationRows || '<div class="memory-empty">暂无关系记录</div>'}</div>
        <button class="btn btn-ghost btn-small" id="btn-add-rel" style="margin:8px 0 16px;">＋ 添加关系</button>
        <div class="memory-section-title" style="font-size:0.95rem;">知情情报（${(factsEdit.intel || []).length}）</div>
        <div class="memory-section-hint" style="font-size: 12px; color: #888; margin: 2px 0 8px;">
          每条情报 + knownBy（谁可当已知；全员可用「公开」）。与约定/关系常一起变。注入时生成硬性知情约束。
        </div>
        <div class="memory-list">${intelRows || '<div class="memory-empty">暂无知情记录</div>'}</div>
        <button class="btn btn-ghost btn-small" id="btn-add-intel" style="margin:8px 0 8px;">＋ 添加情报</button>
      </div>
      `;

      contentEl.querySelectorAll('.fact-promise-text').forEach((input) => {
        input.addEventListener('change', () => {
          const i = parseInt(input.dataset.index, 10);
          if (factsEdit.promises[i]) factsEdit.promises[i].text = input.value.trim();
        });
      });
      contentEl.querySelectorAll('.fact-promise-status').forEach((sel) => {
        sel.addEventListener('change', () => {
          const i = parseInt(sel.dataset.index, 10);
          if (factsEdit.promises[i]) factsEdit.promises[i].status = sel.value === 'done' ? 'done' : 'open';
        });
      });
      contentEl.querySelectorAll('.btn-del-promise').forEach((btn) => {
        btn.addEventListener('click', () => {
          factsEdit.promises.splice(parseInt(btn.dataset.index, 10), 1);
          renderContent();
        });
      });
      contentEl.querySelector('#btn-add-promise')?.addEventListener('click', () => {
        factsEdit.promises.push({ text: '', status: 'open' });
        renderContent();
      });

      contentEl.querySelectorAll('.fact-rel-from').forEach((input) => {
        input.addEventListener('change', () => {
          const i = parseInt(input.dataset.index, 10);
          if (factsEdit.relations[i]) factsEdit.relations[i].from = input.value.trim();
        });
      });
      contentEl.querySelectorAll('.fact-rel-to').forEach((input) => {
        input.addEventListener('change', () => {
          const i = parseInt(input.dataset.index, 10);
          if (factsEdit.relations[i]) factsEdit.relations[i].to = input.value.trim();
        });
      });
      contentEl.querySelectorAll('.fact-rel-note').forEach((input) => {
        input.addEventListener('change', () => {
          const i = parseInt(input.dataset.index, 10);
          if (factsEdit.relations[i]) factsEdit.relations[i].note = input.value.trim();
        });
      });
      contentEl.querySelectorAll('.btn-del-rel').forEach((btn) => {
        btn.addEventListener('click', () => {
          factsEdit.relations.splice(parseInt(btn.dataset.index, 10), 1);
          renderContent();
        });
      });
      contentEl.querySelector('#btn-add-rel')?.addEventListener('click', () => {
        factsEdit.relations.push({ from: '', to: '主控', note: '' });
        renderContent();
      });

      contentEl.querySelectorAll('.fact-intel-text').forEach((input) => {
        input.addEventListener('change', () => {
          const i = parseInt(input.dataset.index, 10);
          if (factsEdit.intel[i]) factsEdit.intel[i].text = input.value.trim();
        });
      });
      contentEl.querySelectorAll('.fact-intel-knownby').forEach((input) => {
        input.addEventListener('change', () => {
          const i = parseInt(input.dataset.index, 10);
          if (!factsEdit.intel[i]) return;
          factsEdit.intel[i].knownBy = input.value
            .split(/[,，;；、]/)
            .map((s) => s.trim())
            .filter(Boolean);
        });
      });
      contentEl.querySelectorAll('.btn-del-intel').forEach((btn) => {
        btn.addEventListener('click', () => {
          factsEdit.intel.splice(parseInt(btn.dataset.index, 10), 1);
          renderContent();
        });
      });
      contentEl.querySelector('#btn-add-intel')?.addEventListener('click', () => {
        if (!Array.isArray(factsEdit.intel)) factsEdit.intel = [];
        factsEdit.intel.push({ text: '', knownBy: [] });
        renderContent();
      });

      updateCounter();
      return;
    }

    if (activeTab === 'seeds') {
      // 免费生图记忆：一个角色一张卡，两行——种子（基准锁定，AI 从它偏移）+ 英文外貌锚点（机械拼进 URL 锁脸）
      const seedRows = Object.entries(seedArchiveEdit).map(([name, rec]) => `
        <div class="memory-card">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="flex: 1; font-size: 0.9rem; min-width: 0; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(name)}</span>
            <input type="number" class="form-input seed-value-input" data-name="${escapeHtml(name)}" style="width: 110px;" min="1" max="99999" value="${rec.seed || ''}" placeholder="种子">
            <button class="btn btn-danger btn-small btn-delete-seed" data-name="${escapeHtml(name)}">删除</button>
          </div>
          <textarea class="form-input seed-anchor-input" data-name="${escapeHtml(name)}" rows="2" style="margin-top: 6px; font-size: 0.85rem; font-family: monospace;" placeholder="英文外貌锚点（留空则该角色下次出图时自动提取）">${escapeHtml(rec.anchor || '')}</textarea>
        </div>
      `).join('');
      contentEl.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">免费生图记忆（${Object.keys(seedArchiveEdit).length}）</div>
        <div class="memory-section-hint" style="font-size: 12px; color: #888; margin: 2px 0 8px;">仅免费模式（pollinations）使用。种子：AI 以此为基础做小偏移让构图随剧情变化，档案基准本身锁定不变；想给某个角色"换脸"，改成新数字即可。英文锚点：首次出图时副 API 从设定自动提取，App 逐字拼进生图 URL 锁住外貌；设定写了"神似某明星"会保留为 resembling {英文名}（锁脸效果最强，也可手改）；清空后下次出图自动重新提取。</div>
        <div class="memory-list">${seedRows || '<div class="memory-empty">暂无记录（AI 首次插图后自动归档）</div>'}</div>
        <div style="display: flex; gap: 8px; margin-top: 12px;">
          <input type="text" class="form-input" id="seed-new-name" placeholder="角色名" style="flex: 1;">
          <input type="number" class="form-input" id="seed-new-value" placeholder="种子(100-999)" style="width: 130px;" min="1" max="99999">
          <button class="btn btn-ghost btn-small" id="btn-add-seed">＋ 添加</button>
        </div>
      </div>
      `;

      contentEl.querySelectorAll('.seed-value-input').forEach(input => {
        input.addEventListener('change', () => {
          const v = parseInt(input.value, 10);
          if (Number.isFinite(v) && v >= 1) {
            seedArchiveEdit[input.dataset.name].seed = v;
          }
        });
      });
      // 锚点实时同步（不触发重渲染，避免输入中丢焦点）
      contentEl.querySelectorAll('.seed-anchor-input').forEach(input => {
        input.addEventListener('input', () => {
          seedArchiveEdit[input.dataset.name].anchor = input.value;
        });
      });
      contentEl.querySelectorAll('.btn-delete-seed').forEach(btn => {
        btn.addEventListener('click', () => {
          delete seedArchiveEdit[btn.dataset.name];
          renderContent();
        });
      });
      const addSeedBtn = contentEl.querySelector('#btn-add-seed');
      if (addSeedBtn) {
        addSeedBtn.addEventListener('click', () => {
          const name = (contentEl.querySelector('#seed-new-name').value || '').trim();
          const v = parseInt(contentEl.querySelector('#seed-new-value').value, 10);
          if (!name || !Number.isFinite(v) || v < 1) return;
          seedArchiveEdit[name] = { seed: v, anchor: '' };
          renderContent();
        });
      }

      updateCounter();
      return;
    }

    if (activeTab === 'anchors') {
      const anchorRows = Object.entries(appearanceAnchorsEdit).map(([name, rec]) => `
        <div class="memory-card" data-name="${escapeHtml(name)}">
          <div class="memory-card-header">
            <span style="flex: 1; font-size: 0.9rem; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(name)}</span>
            <button class="btn btn-ghost btn-small btn-expand-anchor" data-name="${escapeHtml(name)}">⛶ 展开编辑</button>
            <button class="btn btn-danger btn-small btn-delete-anchor" data-name="${escapeHtml(name)}">删除</button>
          </div>
          <textarea class="form-textarea anchor-value-input" data-name="${escapeHtml(name)}" rows="2" placeholder="一位{N}岁女性，…">${escapeHtml(rec.text || '')}</textarea>
          <div style="display: flex; align-items: center; gap: 8px; margin-top: 6px;">
            <img class="anchor-ref-preview" data-name="${escapeHtml(name)}" ${rec.img ? `data-img="${escapeHtml(rec.img)}"` : ''} alt="" style="width: 48px; height: 48px; object-fit: cover; border-radius: 6px; background: #1c1c1f; ${rec.img ? '' : 'display: none;'}">
            <button class="btn btn-ghost btn-small btn-upload-anchor-ref" data-name="${escapeHtml(name)}">📷 ${rec.img ? '更换参考图' : '上传参考图'}</button>
            ${rec.img ? `<button class="btn btn-danger btn-small btn-clear-anchor-ref" data-name="${escapeHtml(name)}">清除图</button>` : ''}
            <span style="font-size: 11px; color: #888;">有图时出图的脸以图为准（仅 Grok 网页反代通道）</span>
          </div>
        </div>
      `).join('');
      contentEl.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">生图外貌身材锚点档案（${Object.keys(appearanceAnchorsEdit).length}）</div>
        <div class="memory-section-hint" style="font-size: 12px; color: #888; margin: 2px 0 8px;">按角色名登记的固定容貌身材描述+可选参考图，只用于生图（不进对话上下文）。新角色首次生图后自动从设定/状态栏提取登记，之后同名角色每张图都是同一张脸。提取不准就直接改；删掉则下次生图重新提取。锚点建议以"一位{N}岁女性"开头——画面年龄以锚点为准（想让角色显年轻就写小几岁），剧情里的年龄不影响出图。参考图（Grok 网页反代通道）：上传后出图时一并发送，容貌以图为准、文字锚点管身材与场景。</div>
        <div class="memory-list">${anchorRows || '<div class="memory-empty">暂无锚点记录（新角色首次生图后自动登记）</div>'}</div>
        <div style="display: flex; gap: 8px; margin-top: 12px;">
          <input type="text" class="form-input" id="anchor-new-name" placeholder="角色名（与状态栏一致）" style="flex: 1;">
          <button class="btn btn-ghost btn-small" id="btn-add-anchor">＋ 添加空锚点</button>
        </div>
      </div>
      `;

      // 参考图缩略图异步加载（显示用 file-URL/base64 均可；发送时才强制 base64）
      contentEl.querySelectorAll('.anchor-ref-preview[data-img]').forEach((img) => {
        getGeneratedImageDataUrl(img.dataset.img).then((u) => {
          if (u && img.isConnected) img.src = u;
        }).catch(() => {});
      });

      // 隐藏文件选择器：参考图上传（每次渲染重建，target 名字存在 dataset 上）
      const refFileInput = document.createElement('input');
      refFileInput.type = 'file';
      refFileInput.accept = 'image/*';
      refFileInput.style.display = 'none';
      contentEl.appendChild(refFileInput);
      refFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        const targetName = refFileInput.dataset.targetName;
        refFileInput.value = '';
        if (!file || !targetName) return;
        try {
          const raw = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (ev) => resolve(ev.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const resized = await resizeImageDataUrl(raw, 1024);
          const relPath = await saveAnchorRefImage(character.id, chat.id, targetName, resized);
          if (!appearanceAnchorsEdit[targetName]) appearanceAnchorsEdit[targetName] = { text: '', img: '' };
          appearanceAnchorsEdit[targetName].img = relPath;
          renderContent();
        } catch (err) {
          alert('参考图保存失败：' + (err && err.message ? err.message : err));
        }
      });

      contentEl.querySelectorAll('.anchor-value-input').forEach(input => {
        input.addEventListener('change', () => {
          const name = input.dataset.name;
          const rec = appearanceAnchorsEdit[name] || { text: '', img: '' };
          rec.text = input.value.trim();
          // 文本清空且有参考图时只清文字（纯图锚点合法）；都空才删整条
          if (!rec.text && !rec.img) {
            delete appearanceAnchorsEdit[name];
          } else {
            appearanceAnchorsEdit[name] = rec;
          }
          renderContent();
        });
      });
      contentEl.querySelectorAll('.btn-delete-anchor').forEach(btn => {
        btn.addEventListener('click', () => {
          const rec = appearanceAnchorsEdit[btn.dataset.name];
          if (rec && rec.img) deleteAnchorRefImage(rec.img).catch(() => {});
          delete appearanceAnchorsEdit[btn.dataset.name];
          renderContent();
        });
      });
      contentEl.querySelectorAll('.btn-upload-anchor-ref').forEach(btn => {
        btn.addEventListener('click', () => {
          refFileInput.dataset.targetName = btn.dataset.name;
          refFileInput.click();
        });
      });
      contentEl.querySelectorAll('.btn-clear-anchor-ref').forEach(btn => {
        btn.addEventListener('click', () => {
          const rec = appearanceAnchorsEdit[btn.dataset.name];
          if (rec && rec.img) {
            deleteAnchorRefImage(rec.img).catch(() => {});
            rec.img = '';
          }
          renderContent();
        });
      });
      // ⛶ 大窗口编辑（长锚点/英文锚点小框里太难改）
      contentEl.querySelectorAll('.btn-expand-anchor').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.name;
          const textarea = contentEl.querySelector(`.anchor-value-input[data-name="${CSS.escape(name)}"]`);
          const rec = appearanceAnchorsEdit[name] || { text: '', img: '' };
          openBigTextEditor({
            title: `「${name}」的外貌身材锚点`,
            value: textarea ? textarea.value : rec.text,
            onSave: (text) => {
              rec.text = (text || '').trim();
              if (!rec.text && !rec.img) {
                delete appearanceAnchorsEdit[name];
              } else {
                appearanceAnchorsEdit[name] = rec;
              }
              renderContent();
            }
          });
        });
      });
      const addAnchorBtn = contentEl.querySelector('#btn-add-anchor');
      if (addAnchorBtn) {
        addAnchorBtn.addEventListener('click', () => {
          const nameInput = contentEl.querySelector('#anchor-new-name');
          const name = (nameInput.value || '').trim();
          if (!name || appearanceAnchorsEdit[name]) return;
          openBigTextEditor({
            title: `新建「${name}」的外貌身材锚点`,
            value: '',
            placeholder: '一位26岁女性，及腰黑长直，鹅蛋脸，桃花眼，高挑匀称，曲线分明，肤质白皙',
            onSave: (text) => {
              const v = (text || '').trim();
              if (!v) return;
              appearanceAnchorsEdit[name] = { text: v, img: '' };
              renderContent();
            }
          });
        });
      }

      updateCounter();
      return;
    }

    contentEl.innerHTML = activeTab === 'short'
      ? `
      <div class="memory-section">
        <div class="memory-section-title">短期记忆（${shortTerm.length}/${SHORT_TERM_LIMIT}，满 ${SHORT_TERM_LIMIT} 条自动压缩成长期记忆）</div>
        <div class="memory-section-hint" style="font-size: 12px; color: #888; margin: 2px 0 8px;">生成方式：${shortTermModeHint}</div>
        <div style="margin: 0 0 12px;"><button class="btn btn-ghost btn-small" id="btn-manual-condense">📦 压缩当前短期为长期（${shortTerm.length} 条）</button></div>
        <div class="memory-list" id="short-term-list">
          ${shortTermHtml}
        </div>
      </div>
      `
      : `
      <div class="memory-section">
        <div class="memory-section-title">长期记忆（${longTerm.length} 条）</div>
        <div style="margin: 0 0 12px;"><button class="btn btn-ghost btn-small" id="btn-ai-condense">🤖 精简长期</button></div>
        <div class="memory-list" id="long-term-list">
          ${longTermHtml}
        </div>
      </div>
      `;

    // 绑定短期记忆：删除 + 实时同步到本地数组
    contentEl.querySelectorAll('.memory-card-short').forEach((card, index) => {
      const dateInput = card.querySelector('input[type="date"]');
      const contentTextarea = card.querySelector('textarea');
      const deleteBtn = card.querySelector('.btn-delete-short');

      const syncToState = () => {
        shortTermMemories[index] = {
          ...shortTermMemories[index],
          date: dateInput.value,
          content: contentTextarea.value
        };
        updateCounter();
      };

      dateInput.addEventListener('input', syncToState);
      contentTextarea.addEventListener('input', syncToState);

      deleteBtn.addEventListener('click', () => {
        shortTermMemories.splice(index, 1);
        renderContent();
        updateCounter();
      });
    });

    // 手动压缩当前短期为长期（使用记忆副 API）
    const manualCondenseBtn = contentEl.querySelector('#btn-manual-condense');
    if (manualCondenseBtn) {
      manualCondenseBtn.disabled = character.memoryEnabled === false;
      manualCondenseBtn.addEventListener('click', async () => {
        if (character.memoryEnabled === false) {
          alert('记忆系统已关闭，无法压缩');
          return;
        }
        if (shortTermMemories.length === 0) {
          alert('当前没有短期记忆可压缩');
          return;
        }
        if (!confirm(`把当前 ${shortTermMemories.length} 条短期记忆压缩成 1 条长期记忆？`)) return;
        manualCondenseBtn.textContent = '压缩中...';
        manualCondenseBtn.disabled = true;
        try {
          // 参考最近几条旧长期（只读）与事实备忘：与自动压缩同一条路径
          const long = await summarizeShortTermMemories(shortTermMemories, {
            previousLongTerm: longTermMemories.slice(-LONG_TERM_REFERENCE_COUNT),
            factsMemo: formatFactsMemo(factsEdit, mcName)
          });
          long.sourceRounds = shortTermMemories.map(s => s.round).filter(r => Number.isFinite(r));
          long.sourceTimestamps = shortTermMemories.map(s => s.turnTimestamp).filter(Boolean);
          longTermMemories.push(long);
          shortTermMemories = [];
          activeTab = 'long';
          renderContent();
        } catch (e) {
          alert('压缩失败：' + e.message);
          manualCondenseBtn.textContent = `📦 压缩当前短期为长期（${shortTermMemories.length} 条）`;
          manualCondenseBtn.disabled = false;
        }
      });
    }

    // AI 精简长期记忆（按钮在长期页内容区内）
    const aiCondenseBtn = contentEl.querySelector('#btn-ai-condense');
    if (aiCondenseBtn) {
      aiCondenseBtn.addEventListener('click', async () => {
        if (!confirm('让 AI 自动精简长期记忆？这会覆盖当前长期记忆，重点压缩事件记录。')) return;
        aiCondenseBtn.textContent = '精简中...';
        aiCondenseBtn.disabled = true;
        try {
          const mergedSourceRounds = longTermMemories.flatMap(lt => lt.sourceRounds || []).filter(r => Number.isFinite(r));
          const mergedSourceTimestamps = longTermMemories.flatMap(lt => lt.sourceTimestamps || []).filter(Boolean);
          const condensed = await condenseLongTermMemory(longTermMemories);
          longTermMemories = (condensed || []).map((c, i) => ({
            ...c,
            sourceRounds: i === 0 ? mergedSourceRounds : [],
            sourceTimestamps: i === 0 ? mergedSourceTimestamps : []
          }));
          renderContent();
        } catch (error) {
          alert('精简失败：' + error.message);
          aiCondenseBtn.textContent = '🤖 精简长期';
          aiCondenseBtn.disabled = false;
        }
      });
    }

    // 绑定长期记忆：删除 + 日期同步 + 大窗口编辑
    contentEl.querySelectorAll('.memory-card-long').forEach((card, index) => {
      const dateInputs = card.querySelectorAll('input[type="date"]');
      const startDateInput = dateInputs[0];
      const endDateInput = dateInputs[1];
      const contentTextarea = card.querySelector('.memory-long-content');
      const deleteBtn = card.querySelector('.btn-delete-long');
      const pinBtn = card.querySelector('.btn-pin-long');
      const titleInput = card.querySelector('.memory-long-title');

      const syncDatesToState = () => {
        longTermMemories[index].startDate = startDateInput.value;
        longTermMemories[index].endDate = endDateInput.value;
        updateCounter();
      };

      startDateInput.addEventListener('input', syncDatesToState);
      endDateInput.addEventListener('input', syncDatesToState);

      deleteBtn.addEventListener('click', () => {
        longTermMemories.splice(index, 1);
        renderContent();
        updateCounter();
      });

      // 加星常驻：全文注入、永不降级为目录行（主线/承重记忆用）
      pinBtn.addEventListener('click', () => {
        longTermMemories[index].pinned = !longTermMemories[index].pinned;
        renderContent();
        updateCounter();
      });

      titleInput.addEventListener('change', () => {
        longTermMemories[index].title = titleInput.value.trim();
      });

      contentTextarea.addEventListener('click', () => {
        const item = longTermMemories[index];
        openBigTextEditor({
          title: '编辑长期记忆',
          value: item.content || '',
          placeholder: '长期记忆内容',
          onSave: (newValue) => {
            item.content = newValue;
            renderContent();
            updateCounter();
          }
        });
      });
    });

    updateCounter();
  }

  renderContent();

  // 顶部页签切换：短期 / 长期 / 事实备忘 / 插图种子 / 外貌身材锚点
  document.getElementById('tab-short').addEventListener('click', () => { activeTab = 'short'; renderContent(); });
  document.getElementById('tab-long').addEventListener('click', () => { activeTab = 'long'; renderContent(); });
  document.getElementById('tab-facts').addEventListener('click', () => { activeTab = 'facts'; renderContent(); });
  document.getElementById('tab-seeds').addEventListener('click', () => { activeTab = 'seeds'; renderContent(); });
  document.getElementById('tab-anchors').addEventListener('click', () => { activeTab = 'anchors'; renderContent(); });
  document.getElementById('tab-supplement').addEventListener('click', () => { activeTab = 'supplement'; renderContent(); });
  document.getElementById('tab-plot').addEventListener('click', () => { activeTab = 'plot'; renderContent(); });

  function closeEditor() {
    overlay.remove();
  }

  document.getElementById('btn-close-memory').addEventListener('click', closeEditor);
  document.getElementById('btn-cancel-memory').addEventListener('click', closeEditor);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEditor();
  });

  document.getElementById('btn-save-memory').addEventListener('click', async () => {
    try {
      // 保存前把当前页未 blur 的输入同步进本地副本
      contentEl.querySelectorAll('.fact-promise-text').forEach((input) => {
        const i = parseInt(input.dataset.index, 10);
        if (factsEdit.promises[i]) factsEdit.promises[i].text = input.value.trim();
      });
      contentEl.querySelectorAll('.fact-promise-status').forEach((sel) => {
        const i = parseInt(sel.dataset.index, 10);
        if (factsEdit.promises[i]) factsEdit.promises[i].status = sel.value === 'done' ? 'done' : 'open';
      });
      contentEl.querySelectorAll('.fact-rel-from').forEach((input) => {
        const i = parseInt(input.dataset.index, 10);
        if (factsEdit.relations[i]) factsEdit.relations[i].from = input.value.trim();
      });
      contentEl.querySelectorAll('.fact-rel-to').forEach((input) => {
        const i = parseInt(input.dataset.index, 10);
        if (factsEdit.relations[i]) factsEdit.relations[i].to = input.value.trim();
      });
      contentEl.querySelectorAll('.fact-rel-note').forEach((input) => {
        const i = parseInt(input.dataset.index, 10);
        if (factsEdit.relations[i]) factsEdit.relations[i].note = input.value.trim();
      });
      contentEl.querySelectorAll('.fact-intel-text').forEach((input) => {
        const i = parseInt(input.dataset.index, 10);
        if (factsEdit.intel[i]) factsEdit.intel[i].text = input.value.trim();
      });
      contentEl.querySelectorAll('.fact-intel-knownby').forEach((input) => {
        const i = parseInt(input.dataset.index, 10);
        if (!factsEdit.intel[i]) return;
        factsEdit.intel[i].knownBy = input.value
          .split(/[,，;；、]/)
          .map((s) => s.trim())
          .filter(Boolean);
      });

      // 过滤掉内容为空的对象，同时保留本地编辑结果
      const newShortTerm = shortTermMemories.filter(item => item && String(item.content).trim());
      const newLongTerm = longTermMemories.filter(item => item && String(item.content).trim());

      console.log('[memory editor] save shortTerm:', newShortTerm.length, 'longTerm:', newLongTerm.length);

      chat.memory.shortTerm = newShortTerm;
      chat.memory.longTerm = newLongTerm;
      // 对话补充设定：单文本区，常驻注入 system（仅本对话生效）
      chat.memory.supplement = supplementEdit.trim();
      // 事实备忘（过滤空行；含知情情报 intel + knownBy）
      // worldEvents 已废弃（与状态栏事件追踪重复）：不再保存，旧数据在此处自然清除
      chat.memory.facts = normalizeFacts({
        promises: (factsEdit.promises || []).filter((p) => p && String(p.text || '').trim()),
        relations: (factsEdit.relations || []).filter((r) => r && String(r.from || r.name || '').trim()),
        intel: (factsEdit.intel || [])
          .filter((i) => i && String(i.text || '').trim())
          .map((i) => ({
            text: String(i.text).trim(),
            knownBy: Array.isArray(i.knownBy) ? i.knownBy : []
          }))
      }, mcName);
      // 免费生图记忆（种子 + 英文锚点）：保留有合法种子或非空锚点的记录
      const cleanedSeeds = {};
      for (const [name, rec] of Object.entries(seedArchiveEdit)) {
        if (!name.trim()) continue;
        const seed = (rec && typeof rec === 'object') ? rec.seed : rec;
        const anchor = (rec && typeof rec === 'object') ? String(rec.anchor || '').trim() : '';
        const seedOk = Number.isFinite(seed) && seed >= 1;
        if (seedOk || anchor) cleanedSeeds[name.trim()] = { seed: seedOk ? seed : 0, anchor };
      }
      chat.seedArchive = cleanedSeeds;
      // 生图外貌身材锚点档案（{text, img} 形态；文本与参考图任一非空即保留——纯图锚点合法）
      const cleanedAnchors = {};
      for (const [name, rec] of Object.entries(appearanceAnchorsEdit)) {
        const text = String((rec && rec.text) || '').trim();
        const img = String((rec && rec.img) || '').trim();
        if (name.trim() && (text || img)) cleanedAnchors[name.trim()] = { text, img };
      }
      chat.appearanceAnchors = cleanedAnchors;
      // 剧情线（对话级副本）：有阶段则写回；清空所有阶段=移除本对话的剧情线
      const stagesClean = plotEdit.stages
        .map((s) => ({
          title: String(s.title || '').trim(),
          content: String(s.content || '').trim(),
          condition: String(s.condition || '').trim(),
          branches: String(s.branches || '').trim()
        }))
        .filter((s) => s.title || s.content);
      if (stagesClean.length) {
        chat.plot = {
          mode: plotEdit.mode === 'hard' ? 'hard' : 'soft',
          current: Math.min(Math.max(1, plotEdit.current || 1), stagesClean.length),
          stages: stagesClean
        };
      } else if (chat.plot) {
        delete chat.plot;
      }

      await saveChat(chat);
      if (onUpdate) onUpdate();
      closeEditor();
    } catch (error) {
      console.error('[memory editor] save failed:', error);
      alert('保存记忆失败：' + (error && error.message ? error.message : String(error)));
    }
  });
}
