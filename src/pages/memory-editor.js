// 记忆编辑器：🧠 全屏弹窗；当前状态/对话索引/长期记忆/召回记录 + 生图/补充辅助页签。
// 自包含模块——自己建遮罩、绑事件、保存，输入仅 (chat, character, onUpdate)，与聊天页状态零耦合。
// migrateMemory 也住在这里：它既被编辑器调用，也被聊天页打开旧对话时做结构迁移。
import { saveCharacter, saveChat, saveAnchorRefImage, deleteAnchorRefImage, getGeneratedImageDataUrl } from '../services/storage.js';
import { anchorTextOf, anchorImgOf } from '../services/image-gen.js';
import { migrateChat } from '../services/migrations.js';
import { countTokens } from '../utils/tokenizer.js';
import { openBigTextEditor } from '../utils/big-editor.js';
import { renderMemoryArchivePanel } from './memory-archive-panel.js';
import { emptyMemoryState, formatCurrentMemoryState, formatRecentMemoryIndexes, syncMemoryProfiles } from '../services/memory-engine.js';
import { formatLongTermMemories } from '../services/memory-long-term.js';
import { mergeMemoryEditorSnapshots } from '../services/memory-editor-merge.js';

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

  // 确保 memory 具备原文档案、状态账本和召回记录结构
  migrateMemory(chat);

  // 混合记忆本地副本：状态账本 / 轮次索引 / 一级长期摘要 / 召回记录
  let stateEdit = JSON.parse(JSON.stringify(chat.memory.state || emptyMemoryState()));
  let archiveEdit = JSON.parse(JSON.stringify(chat.memory.archive || []));
  let longTermSummariesEdit = JSON.parse(JSON.stringify(chat.memory.longTermSummaries || []));
  let archivePage = 1;
  let recallLogEdit = JSON.parse(JSON.stringify(chat.memory.recallLog || []));
  const memoryEditorBase = JSON.parse(JSON.stringify({
    state: chat.memory.state || emptyMemoryState(),
    archive: chat.memory.archive || [],
    longTermSummaries: chat.memory.longTermSummaries || [],
    recallLog: chat.memory.recallLog || []
  }));
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
  // 主记忆页签：state 当前状态 / archive 对话索引 / recalls 召回记录；其余为既有辅助页签
  let activeTab = 'state';

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
            <input type="number" class="form-input" id="mem-raw-window" style="width: 64px;" min="0" max="50" value="${character.memoryEnabled !== false ? 1 : (Number.isFinite(Number(character.rawWindowTurns)) ? Math.max(0, Math.min(50, Math.trunc(Number(character.rawWindowTurns)))) : 3)}" ${character.memoryEnabled !== false ? 'disabled' : ''}>
            <span>轮对话</span>
          </label>
          <span class="memory-sys-hint">开启时：动态原文窗口 + 当前状态 + 当前短期组全部索引 + 最近10条长期记忆 + 远史召回；关闭后按设定轮数携带原文</span>
        </div>
        <div class="memory-tabs">
          <div class="memory-tabs-row">
            <button class="btn btn-primary btn-small memory-tab-btn" id="tab-short" data-tab="state">当前状态</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-long" data-tab="archive">对话索引</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-longterm" data-tab="longTerm">长期记忆</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-facts" data-tab="recalls">召回记录</button>
          </div>
          <div class="memory-tabs-row">
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-seeds" data-tab="seeds">免费生图记忆</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-anchors" data-tab="anchors">外貌锚点</button>
            <button class="btn btn-ghost btn-small memory-tab-btn" id="tab-supplement" data-tab="supplement">补充设定</button>
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
    memRawInput.value = on ? '1' : String(Number.isFinite(Number(character.rawWindowTurns))
      ? Math.max(0, Math.min(50, Math.trunc(Number(character.rawWindowTurns)))) : 3);
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

  let counterTimer = null;
  function updateCounter(immediate = false) {
    if (counterTimer) clearTimeout(counterTimer);
    const update = () => {
      counterTimer = null;
      const memoryEdit = { archive: archiveEdit, longTermSummaries: longTermSummariesEdit };
      const residentText = [
        formatCurrentMemoryState({ state: stateEdit }),
        formatRecentMemoryIndexes(memoryEdit),
        formatLongTermMemories(memoryEdit),
        supplementEdit.trim()
      ].filter(Boolean).join('\n\n');
      const indexText = JSON.stringify(archiveEdit.map((entry) => ({
        turnId: entry.turnId,
        round: entry.round,
        ...(entry.index || {})
      })));
      const residentTokens = countTokens(residentText);
      const indexTokens = countTokens(indexText);
      counterEl.textContent = `常驻约 ${residentTokens}｜索引库约 ${indexTokens} tokens`;
      counterEl.title = '常驻=当前状态+连续索引+最近10条长期记忆+补充；不统计聊天详细原文、状态快照或召回记录';
    };
    if (immediate) update();
    else counterTimer = setTimeout(update, 300);
  }

  function renderContent() {
    if (['state', 'archive', 'longTerm', 'recalls'].includes(activeTab)) {
      const primaryTabs = [
        ['tab-short', 'state', `状态（${stateEdit.characters.length}）`],
        ['tab-long', 'archive', `索引（${archiveEdit.length}）`],
        ['tab-longterm', 'longTerm', `长期（${longTermSummariesEdit.length}）`],
        ['tab-facts', 'recalls', `召回（${recallLogEdit.length}）`]
      ];
      for (const [id, tab, label] of primaryTabs) {
        const btn = document.getElementById(id);
        btn.textContent = label;
        btn.className = 'btn btn-small memory-tab-btn ' + (activeTab === tab ? 'btn-primary' : 'btn-ghost');
      }
      renderMemoryArchivePanel({
        tab: activeTab,
        state: stateEdit,
        archive: archiveEdit,
        longTerm: longTermSummariesEdit,
        archivePage,
        onArchivePage: (page) => { archivePage = page; },
        recallLog: recallLogEdit,
        contentEl,
        chat,
        character,
        onChange: updateCounter,
        onData: (state, archive, logs, longTerm) => {
          stateEdit = JSON.parse(JSON.stringify(state));
          archiveEdit = JSON.parse(JSON.stringify(archive));
          recallLogEdit = JSON.parse(JSON.stringify(logs || []));
          longTermSummariesEdit = JSON.parse(JSON.stringify(longTerm || []));
        },
        rerender: renderContent
      });
      updateCounter();
      return;
    }
    // 更新顶部页签的标题与激活态（短文案 + 数量，避免撑破窄屏）
    const shortTabBtn = document.getElementById('tab-short');
    const longTabBtn = document.getElementById('tab-long');
    const longTermTabBtn = document.getElementById('tab-longterm');
    const factsTabBtn = document.getElementById('tab-facts');
    const seedsTabBtn = document.getElementById('tab-seeds');
    const anchorsTabBtn = document.getElementById('tab-anchors');
    const supplementTabBtn = document.getElementById('tab-supplement');
    if (shortTabBtn && longTabBtn && longTermTabBtn && factsTabBtn && seedsTabBtn && anchorsTabBtn && supplementTabBtn) {
      shortTabBtn.textContent = `状态（${stateEdit.characters.length}）`;
      longTabBtn.textContent = `索引（${archiveEdit.length}）`;
      longTermTabBtn.textContent = `长期（${longTermSummariesEdit.length}）`;
      factsTabBtn.textContent = `召回（${recallLogEdit.length}）`;
      seedsTabBtn.textContent = `免费生图（${Object.keys(seedArchiveEdit).length}）`;
      anchorsTabBtn.textContent = `锚点（${Object.keys(appearanceAnchorsEdit).length}）`;
      supplementTabBtn.textContent = `补充（${supplementEdit.trim().length}字）`;
      shortTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'state' ? 'btn-primary' : 'btn-ghost');
      longTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'archive' ? 'btn-primary' : 'btn-ghost');
      longTermTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'longTerm' ? 'btn-primary' : 'btn-ghost');
      factsTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'recalls' ? 'btn-primary' : 'btn-ghost');
      seedsTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'seeds' ? 'btn-primary' : 'btn-ghost');
      anchorsTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'anchors' ? 'btn-primary' : 'btn-ghost');
      supplementTabBtn.className = 'btn btn-small memory-tab-btn ' + (activeTab === 'supplement' ? 'btn-primary' : 'btn-ghost');
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

  }

  renderContent();
  updateCounter(true);

  // 顶部页签切换：当前状态 / 对话索引 / 长期记忆 / 召回记录 / 辅助设定
  document.getElementById('tab-short').addEventListener('click', () => { activeTab = 'state'; renderContent(); });
  document.getElementById('tab-long').addEventListener('click', () => { activeTab = 'archive'; renderContent(); });
  document.getElementById('tab-longterm').addEventListener('click', () => { activeTab = 'longTerm'; renderContent(); });
  document.getElementById('tab-facts').addEventListener('click', () => { activeTab = 'recalls'; renderContent(); });
  document.getElementById('tab-seeds').addEventListener('click', () => { activeTab = 'seeds'; renderContent(); });
  document.getElementById('tab-anchors').addEventListener('click', () => { activeTab = 'anchors'; renderContent(); });
  document.getElementById('tab-supplement').addEventListener('click', () => { activeTab = 'supplement'; renderContent(); });

  function closeEditor() {
    if (counterTimer) clearTimeout(counterTimer);
    overlay.remove();
  }

  document.getElementById('btn-close-memory').addEventListener('click', closeEditor);
  document.getElementById('btn-cancel-memory').addEventListener('click', closeEditor);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEditor();
  });

  document.getElementById('btn-save-memory').addEventListener('click', async () => {
    try {
      // 混合记忆：保存状态、索引、一级长期摘要与召回记录；原文档案不按摘要过滤
      stateEdit.characters = stateEdit.characters.filter((c) => String(c.name || '').trim());
      stateEdit.promises = stateEdit.promises.filter((p) => String(p.text || '').trim());
      stateEdit.events = stateEdit.events.filter((e) => String(e.text || '').trim());
      stateEdit.intel = stateEdit.intel.filter((i) => String(i.text || '').trim());
      const mergedMemory = mergeMemoryEditorSnapshots(memoryEditorBase, {
        state: stateEdit,
        archive: archiveEdit,
        longTermSummaries: longTermSummariesEdit.filter((item) => item && String(item.content || '').trim()),
        recallLog: recallLogEdit
      }, chat.memory);
      stateEdit = mergedMemory.state || emptyMemoryState();
      archiveEdit = mergedMemory.archive;
      longTermSummariesEdit = mergedMemory.longTermSummaries;
      recallLogEdit = mergedMemory.recallLog;
      chat.memory.state = stateEdit;
      syncMemoryProfiles(chat.memory, true);
      chat.memory.archive = archiveEdit;
      chat.memory.longTermSummaries = longTermSummariesEdit;
      chat.memory.recallLog = recallLogEdit;
      // 对话补充设定：单文本区，常驻注入 system（仅本对话生效）
      chat.memory.supplement = supplementEdit.trim();
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

      await saveChat(chat);
      if (onUpdate) onUpdate();
      closeEditor();
    } catch (error) {
      console.error('[memory editor] save failed:', error);
      alert('保存记忆失败：' + (error && error.message ? error.message : String(error)));
    }
  });
}
