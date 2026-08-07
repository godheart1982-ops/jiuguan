// 记忆编辑器：🧠 全屏弹窗；页签两行（短/长/事实 | 种子/锚点）。
// 自包含模块——自己建遮罩、绑事件、保存，输入仅 (chat, character, onUpdate)，与聊天页状态零耦合。
// migrateMemory 也住在这里：它既被编辑器调用，也被聊天页打开旧对话时做结构迁移。
import { saveCharacter, saveChat } from '../services/storage.js';
import {
  summarizeShortTermMemories,
  condenseLongTermMemory,
  RAW_WINDOW_TURNS,
  SHORT_TERM_LIMIT,
  LONG_TERM_REFERENCE_COUNT,
  normalizeFacts,
  formatFactsMemo
} from '../services/api-memory.js';
import { migrateChat } from '../services/migrations.js';
import { countTokens } from '../utils/tokenizer.js';
import { openBigTextEditor } from '../utils/big-editor.js';

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
  // 事实备忘（本地副本）
  let factsEdit = normalizeFacts(chat.memory.facts);
  // 免费生图记忆（本地副本，保存时写回 chat.seedArchive；{角色名: {seed, anchor}} 形态）
  let seedArchiveEdit = Object.fromEntries(
    Object.entries(chat.seedArchive || {}).map(([k, v]) => [k, (v && typeof v === 'object')
      ? { seed: Number.isFinite(v.seed) ? v.seed : 0, anchor: typeof v.anchor === 'string' ? v.anchor : '' }
      : { seed: v, anchor: '' }])
  );
  // 生图外貌身材锚点档案（本地副本，保存时写回 chat.appearanceAnchors）
  let appearanceAnchorsEdit = { ...(chat.appearanceAnchors || {}) };
  // 当前激活的记忆页签：'short' 短期 / 'long' 长期 / 'facts' 事实备忘 / 'seeds' 插图种子 / 'anchors' 外貌身材锚点
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
    const text = JSON.stringify({ shortTerm: shortTermMemories, longTerm: longTermMemories, facts: factsEdit });
    const tokens = countTokens(text);
    counterEl.textContent = `${tokens} tokens`;
  }

  function factsCount() {
    return (factsEdit.promises?.length || 0)
      + (factsEdit.relations?.length || 0)
      + (factsEdit.worldEvents?.length || 0)
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
                <button class="btn btn-danger btn-small btn-delete-long" data-index="${index}">删除</button>
              </div>
              <div class="memory-date-range">
                <input type="date" class="form-input memory-date-input" value="${escapeHtml(item.startDate || '')}">
                <span>至</span>
                <input type="date" class="form-input memory-date-input" value="${escapeHtml(item.endDate || '')}">
              </div>
            </div>
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
    if (shortTabBtn && longTabBtn && factsTabBtn && seedsTabBtn && anchorsTabBtn) {
      shortTabBtn.textContent = `短期（${shortTerm.length}）`;
      longTabBtn.textContent = `长期（${longTerm.length}）`;
      factsTabBtn.textContent = `事实（${factsCount()}）`;
      seedsTabBtn.textContent = `免费生图（${Object.keys(seedArchiveEdit).length}）`;
      anchorsTabBtn.textContent = `锚点（${Object.keys(appearanceAnchorsEdit).length}）`;
      shortTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'short' ? 'btn-primary' : 'btn-ghost');
      longTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'long' ? 'btn-primary' : 'btn-ghost');
      factsTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'facts' ? 'btn-primary' : 'btn-ghost');
      seedsTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'seeds' ? 'btn-primary' : 'btn-ghost');
      anchorsTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'anchors' ? 'btn-primary' : 'btn-ghost');
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
          <input type="text" class="form-input fact-promise-text" data-index="${index}" value="${escapeHtml(p.text)}" placeholder="约定内容">
        </div>
      `).join('');
      const relationRows = (factsEdit.relations || []).map((r, index) => `
        <div class="memory-card" style="display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="text" class="form-input fact-rel-name" data-index="${index}" value="${escapeHtml(r.name)}" placeholder="人名" style="width:120px;">
            <button class="btn btn-danger btn-small btn-del-rel" data-index="${index}">删除</button>
          </div>
          <input type="text" class="form-input fact-rel-note" data-index="${index}" value="${escapeHtml(r.note || '')}" placeholder="关系说明一句">
        </div>
      `).join('');
      const worldRows = (factsEdit.worldEvents || []).map((w, index) => `
        <div class="memory-card" style="display:flex; gap:8px; align-items:center;">
          <input type="text" class="form-input fact-world-text" data-index="${index}" value="${escapeHtml(w.text)}" placeholder="事件→阶段" style="flex:1;">
          <button class="btn btn-danger btn-small btn-del-world" data-index="${index}">删除</button>
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
          由每轮记忆总结自动抽取并合并；压缩短期/长期<strong>不会清空</strong>本页。世界事件与知情情报只记在本页。发送时注入 system【事实备忘】（含知情约束）。可在此手改。
        </div>
        <div class="memory-section-title" style="font-size:0.95rem;">未完成/历史约定（${factsEdit.promises.length}）</div>
        <div class="memory-list">${promiseRows || '<div class="memory-empty">暂无约定</div>'}</div>
        <button class="btn btn-ghost btn-small" id="btn-add-promise" style="margin:8px 0 16px;">＋ 添加约定</button>
        <div class="memory-section-title" style="font-size:0.95rem;">人物关系（${factsEdit.relations.length}）</div>
        <div class="memory-list">${relationRows || '<div class="memory-empty">暂无关系记录</div>'}</div>
        <button class="btn btn-ghost btn-small" id="btn-add-rel" style="margin:8px 0 16px;">＋ 添加关系</button>
        <div class="memory-section-title" style="font-size:0.95rem;">世界事件（${factsEdit.worldEvents.length}）</div>
        <div class="memory-list">${worldRows || '<div class="memory-empty">暂无世界事件</div>'}</div>
        <button class="btn btn-ghost btn-small" id="btn-add-world" style="margin:8px 0 16px;">＋ 添加事件</button>
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

      contentEl.querySelectorAll('.fact-rel-name').forEach((input) => {
        input.addEventListener('change', () => {
          const i = parseInt(input.dataset.index, 10);
          if (factsEdit.relations[i]) factsEdit.relations[i].name = input.value.trim();
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
        factsEdit.relations.push({ name: '', note: '' });
        renderContent();
      });

      contentEl.querySelectorAll('.fact-world-text').forEach((input) => {
        input.addEventListener('change', () => {
          const i = parseInt(input.dataset.index, 10);
          if (factsEdit.worldEvents[i]) factsEdit.worldEvents[i].text = input.value.trim();
        });
      });
      contentEl.querySelectorAll('.btn-del-world').forEach((btn) => {
        btn.addEventListener('click', () => {
          factsEdit.worldEvents.splice(parseInt(btn.dataset.index, 10), 1);
          renderContent();
        });
      });
      contentEl.querySelector('#btn-add-world')?.addEventListener('click', () => {
        factsEdit.worldEvents.push({ text: '' });
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
      const anchorRows = Object.entries(appearanceAnchorsEdit).map(([name, anchor]) => `
        <div class="memory-card" data-name="${escapeHtml(name)}">
          <div class="memory-card-header">
            <span style="flex: 1; font-size: 0.9rem; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(name)}</span>
            <button class="btn btn-ghost btn-small btn-expand-anchor" data-name="${escapeHtml(name)}">⛶ 展开编辑</button>
            <button class="btn btn-danger btn-small btn-delete-anchor" data-name="${escapeHtml(name)}">删除</button>
          </div>
          <textarea class="form-textarea anchor-value-input" data-name="${escapeHtml(name)}" rows="2" placeholder="一位{N}岁女性，…">${escapeHtml(anchor)}</textarea>
        </div>
      `).join('');
      contentEl.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">生图外貌身材锚点档案（${Object.keys(appearanceAnchorsEdit).length}）</div>
        <div class="memory-section-hint" style="font-size: 12px; color: #888; margin: 2px 0 8px;">按角色名登记的固定容貌身材描述，只用于生图（不进对话上下文）。新角色首次生图后自动从设定/状态栏提取登记，之后同名角色每张图都是同一张脸。提取不准就直接改；删掉则下次生图重新提取。锚点建议以"一位{N}岁女性"开头——画面年龄以锚点为准（想让角色显年轻就写小几岁），剧情里的年龄不影响出图。</div>
        <div class="memory-list">${anchorRows || '<div class="memory-empty">暂无锚点记录（新角色首次生图后自动登记）</div>'}</div>
        <div style="display: flex; gap: 8px; margin-top: 12px;">
          <input type="text" class="form-input" id="anchor-new-name" placeholder="角色名（与状态栏一致）" style="flex: 1;">
          <button class="btn btn-ghost btn-small" id="btn-add-anchor">＋ 添加空锚点</button>
        </div>
      </div>
      `;

      contentEl.querySelectorAll('.anchor-value-input').forEach(input => {
        input.addEventListener('change', () => {
          const v = input.value.trim();
          if (v) {
            appearanceAnchorsEdit[input.dataset.name] = v;
          } else {
            // 清空等于删除（下次生图重新提取）
            delete appearanceAnchorsEdit[input.dataset.name];
          }
          renderContent();
        });
      });
      contentEl.querySelectorAll('.btn-delete-anchor').forEach(btn => {
        btn.addEventListener('click', () => {
          delete appearanceAnchorsEdit[btn.dataset.name];
          renderContent();
        });
      });
      // ⛶ 大窗口编辑（长锚点/英文锚点小框里太难改）
      contentEl.querySelectorAll('.btn-expand-anchor').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.name;
          const textarea = contentEl.querySelector(`.anchor-value-input[data-name="${CSS.escape(name)}"]`);
          openBigTextEditor({
            title: `「${name}」的外貌身材锚点`,
            value: textarea ? textarea.value : (appearanceAnchorsEdit[name] || ''),
            onSave: (text) => {
              const v = (text || '').trim();
              if (v) {
                appearanceAnchorsEdit[name] = v;
              } else {
                delete appearanceAnchorsEdit[name];
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
              appearanceAnchorsEdit[name] = v;
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
            factsMemo: formatFactsMemo(factsEdit)
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
      contentEl.querySelectorAll('.fact-rel-name').forEach((input) => {
        const i = parseInt(input.dataset.index, 10);
        if (factsEdit.relations[i]) factsEdit.relations[i].name = input.value.trim();
      });
      contentEl.querySelectorAll('.fact-rel-note').forEach((input) => {
        const i = parseInt(input.dataset.index, 10);
        if (factsEdit.relations[i]) factsEdit.relations[i].note = input.value.trim();
      });
      contentEl.querySelectorAll('.fact-world-text').forEach((input) => {
        const i = parseInt(input.dataset.index, 10);
        if (factsEdit.worldEvents[i]) factsEdit.worldEvents[i].text = input.value.trim();
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
      // 事实备忘（过滤空行；含知情情报 intel + knownBy）
      chat.memory.facts = normalizeFacts({
        promises: (factsEdit.promises || []).filter((p) => p && String(p.text || '').trim()),
        relations: (factsEdit.relations || []).filter((r) => r && String(r.name || '').trim()),
        worldEvents: (factsEdit.worldEvents || []).filter((w) => w && String(w.text || '').trim()),
        intel: (factsEdit.intel || [])
          .filter((i) => i && String(i.text || '').trim())
          .map((i) => ({
            text: String(i.text).trim(),
            knownBy: Array.isArray(i.knownBy) ? i.knownBy : []
          }))
      });
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
      // 生图外貌身材锚点档案（过滤空描述）
      const cleanedAnchors = {};
      for (const [name, anchor] of Object.entries(appearanceAnchorsEdit)) {
        if (name.trim() && String(anchor).trim()) cleanedAnchors[name.trim()] = String(anchor).trim();
      }
      chat.appearanceAnchors = cleanedAnchors;

      await saveChat(chat);
      if (onUpdate) onUpdate();
      closeEditor();
    } catch (error) {
      console.error('[memory editor] save failed:', error);
      alert('保存记忆失败：' + (error && error.message ? error.message : String(error)));
    }
  });
}
