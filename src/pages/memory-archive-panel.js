// 原文召回记忆的三个主面板：当前状态 / 对话索引 / 召回记录。
// 与插图、补充设定、剧情线等既有页签并存。

import {
  processRoundForMemory, rebuildMemoryState, catchUpMemoryArchive, selectMemoryRecalls, readArchivedTurn,
  fillMissingIndexSceneTimes
} from '../services/memory-engine.js';
import { getAllRounds, getLeadingGreeting } from './chat/chat-memory-helpers.js';
import { extractActionOptionSupplement } from '../services/action-options.js';

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

const CHARACTER_FIELDS = [
  ['presence', '在场状态'], ['offscreen', '最近场外状态'],
  ['appearance', '外貌身材'], ['kinks', '特殊性癖（体位/力度偏好不算）'],
  ['outerAura', '外在气质'], ['innerAura', '实际内在气质'],
  ['relation', '关系名分'], ['stage', '关系阶段'], ['scores', '三轴进度'],
  ['mood', '当前情绪'], ['goal', '当前目标'], ['agreement', '关系约定'],
  ['boundaries', '亲密边界'], ['knowledge', '当前知情'], ['plans', '个人计划']
];

export const ARCHIVE_PAGE_SIZE = 20;

export function getArchivePage(archive, requestedPage = 1, pageSize = ARCHIVE_PAGE_SIZE) {
  const list = Array.isArray(archive) ? archive : [];
  const size = Math.max(1, Math.trunc(Number(pageSize)) || ARCHIVE_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  const requested = Math.trunc(Number(requestedPage)) || 1;
  const page = Math.min(Math.max(1, requested), totalPages);
  const items = list.map((entry, index) => ({ entry, index })).reverse()
    .slice((page - 1) * size, page * size);
  return { items, page, totalPages };
}

export function renderMemoryArchivePanel(options) {
  const { tab, state, archive, recallLog, contentEl, chat, character, onChange, onData, rerender } = options;

  function renderState() {
    const characters = state.characters.map((c, i) => `
      <div class="memory-card">
        <div class="memory-card-header"><strong>${escapeHtml(c.name || '未命名')}</strong><button class="btn btn-danger btn-small state-del-char" data-i="${i}">删除</button></div>
        <input class="form-input state-char-name" data-i="${i}" value="${escapeHtml(c.name || '')}" placeholder="人物全名" style="margin-bottom:6px;">
        ${CHARACTER_FIELDS.map(([key, label]) => `<input class="form-input state-char-field" data-i="${i}" data-key="${key}" value="${escapeHtml(c[key] || '')}" placeholder="${label}" style="margin-top:6px;">`).join('')}
      </div>`).join('');
    const promises = state.promises.map((p, i) => `
      <div class="memory-card"><div style="display:flex;gap:6px;flex-wrap:wrap;">
        <input class="form-input state-promise-text" data-i="${i}" value="${escapeHtml(p.text || '')}" placeholder="约定内容" style="flex:1;min-width:180px;">
        <select class="form-input state-promise-status" data-i="${i}" style="width:96px;"><option value="open" ${p.status !== 'done' ? 'selected' : ''}>进行中</option><option value="done" ${p.status === 'done' ? 'selected' : ''}>已完成</option></select>
        <button class="btn btn-danger btn-small state-del-promise" data-i="${i}">删除</button></div>
        <input class="form-input state-promise-due" data-i="${i}" value="${escapeHtml(p.due || '')}" placeholder="期限/触发条件" style="margin-top:6px;">
      </div>`).join('');
    const events = state.events.map((e, i) => `
      <div class="memory-card" style="display:flex;gap:6px;flex-wrap:wrap;">
        <input class="form-input state-event-text" data-i="${i}" value="${escapeHtml(e.text || '')}" placeholder="事件名" style="flex:1;min-width:150px;">
        <input class="form-input state-event-stage" data-i="${i}" value="${escapeHtml(e.stage || '')}" placeholder="阶段" style="width:110px;">
        <button class="btn btn-danger btn-small state-del-event" data-i="${i}">删除</button>
      </div>`).join('');
    const intel = state.intel.map((it, i) => `
      <div class="memory-card">
        <div style="display:flex;gap:6px;"><input class="form-input state-intel-text" data-i="${i}" value="${escapeHtml(it.text || '')}" placeholder="未公开关系或白名单秘密" style="flex:1;"><button class="btn btn-danger btn-small state-del-intel" data-i="${i}">删除</button></div>
        <input class="form-input state-intel-known" data-i="${i}" value="${escapeHtml((it.knownBy || []).join('、'))}" placeholder="当前全量知情人；公开后应移除此条" style="margin-top:6px;">
      </div>`).join('');
    contentEl.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">当前状态账本</div>
        <div class="memory-section-hint" style="font-size:12px;color:#888;margin:2px 0 10px;">记录当前有效状态；角色卡提供初始设定，重要人物首次入库会补全外貌、成年性癖与内外气质，后续只按明确事件更新。未提到的旧状态不会变。${state.stale ? '<strong style="color:#d99;">旧轮次被编辑过，建议重建状态。</strong>' : ''}</div>
        <label class="form-label">当前场景</label>
        <textarea class="form-textarea" id="state-scene" rows="2" placeholder="日期时间、地点、在场人物">${escapeHtml(state.scene)}</textarea>
        <div class="memory-section-title" style="margin-top:16px;">人物当前状态（${state.characters.length}）</div>
        <div class="memory-list">${characters || '<div class="memory-empty">暂无人物状态</div>'}</div>
        <button class="btn btn-ghost btn-small" id="state-add-char">＋ 添加人物</button>
        <div class="memory-section-title" style="margin-top:16px;">约定（${state.promises.length}）</div>
        <div class="memory-list">${promises || '<div class="memory-empty">暂无约定</div>'}</div>
        <button class="btn btn-ghost btn-small" id="state-add-promise">＋ 添加约定</button>
        <div class="memory-section-title" style="margin-top:16px;">进行中事件（${state.events.length}）</div>
        <div class="memory-list">${events || '<div class="memory-empty">暂无事件</div>'}</div>
        <button class="btn btn-ghost btn-small" id="state-add-event">＋ 添加事件</button>
        <div class="memory-section-title" style="margin-top:16px;">关系与秘密知情（${state.intel.length}）</div>
        <div class="memory-list">${intel || '<div class="memory-empty">暂无关系或秘密知情</div>'}</div>
        <button class="btn btn-ghost btn-small" id="state-add-intel">＋ 添加知情</button>
        <div style="margin-top:16px;"><button class="btn btn-danger btn-small" id="state-rebuild">从全部已入库原文重建状态</button></div>
      </div>`;
    contentEl.querySelector('#state-scene').addEventListener('input', (e) => { state.scene = e.target.value; onChange(); });
    contentEl.querySelectorAll('.state-char-name').forEach((el) => el.addEventListener('change', () => { state.characters[el.dataset.i].name = el.value.trim(); onChange(); }));
    contentEl.querySelectorAll('.state-char-field').forEach((el) => el.addEventListener('change', () => { state.characters[el.dataset.i][el.dataset.key] = el.value.trim(); onChange(); }));
    contentEl.querySelectorAll('.state-promise-text').forEach((el) => el.addEventListener('change', () => { state.promises[el.dataset.i].text = el.value.trim(); onChange(); }));
    contentEl.querySelectorAll('.state-promise-status').forEach((el) => el.addEventListener('change', () => { state.promises[el.dataset.i].status = el.value; onChange(); }));
    contentEl.querySelectorAll('.state-promise-due').forEach((el) => el.addEventListener('change', () => { state.promises[el.dataset.i].due = el.value.trim(); onChange(); }));
    contentEl.querySelectorAll('.state-event-text').forEach((el) => el.addEventListener('change', () => { state.events[el.dataset.i].text = el.value.trim(); onChange(); }));
    contentEl.querySelectorAll('.state-event-stage').forEach((el) => el.addEventListener('change', () => { state.events[el.dataset.i].stage = el.value.trim(); onChange(); }));
    contentEl.querySelectorAll('.state-intel-text').forEach((el) => el.addEventListener('change', () => { state.intel[el.dataset.i].text = el.value.trim(); onChange(); }));
    contentEl.querySelectorAll('.state-intel-known').forEach((el) => el.addEventListener('change', () => { state.intel[el.dataset.i].knownBy = el.value.split(/[,，;；、]/).map((s) => s.trim()).filter(Boolean); onChange(); }));
    for (const [selector, list] of [['.state-del-char', state.characters], ['.state-del-promise', state.promises], ['.state-del-event', state.events], ['.state-del-intel', state.intel]]) {
      contentEl.querySelectorAll(selector).forEach((el) => el.addEventListener('click', () => { list.splice(Number(el.dataset.i), 1); onChange(); rerender(); }));
    }
    contentEl.querySelector('#state-add-char').addEventListener('click', () => { state.characters.push({ name: '' }); onChange(); rerender(); });
    contentEl.querySelector('#state-add-promise').addEventListener('click', () => { state.promises.push({ id: `promise-${Date.now()}`, text: '', status: 'open', due: '' }); onChange(); rerender(); });
    contentEl.querySelector('#state-add-event').addEventListener('click', () => { state.events.push({ id: `event-${Date.now()}`, text: '', stage: '' }); onChange(); rerender(); });
    contentEl.querySelector('#state-add-intel').addEventListener('click', () => { state.intel.push({ id: `intel-${Date.now()}`, text: '', knownBy: [] }); onChange(); rerender(); });
    contentEl.querySelector('#state-rebuild').addEventListener('click', async (e) => {
      if (!archive.length || !confirm('按全部已入库原文重新计算当前状态？现有手动状态修改会被覆盖。')) return;
      e.target.disabled = true;
      try {
        chat.memory.state = state;
        chat.memory.archive = archive;
        await rebuildMemoryState(chat, character);
        onData(chat.memory.state, chat.memory.archive, chat.memory.recallLog);
        rerender();
      } catch (err) { alert('状态重建失败：' + err.message); e.target.disabled = false; }
    });
  }

  function renderArchive() {
    const { items, page, totalPages } = getArchivePage(archive, options.archivePage);
    options.onArchivePage?.(page);
    const cards = items.map(({ entry, index: i }) => `
      <div class="memory-card">
        <div class="memory-card-header"><span class="memory-round-badge">第 ${entry.round ?? '—'} 轮</span><button class="btn btn-ghost btn-small archive-reindex" data-i="${i}">重建索引</button></div>
        <input class="form-input archive-scene-time" data-i="${i}" value="${escapeHtml(entry.index?.sceneTime || '')}" placeholder="剧情日期时间，如2026年11月19日 15:30" style="margin-bottom:6px;">
        <input class="form-input archive-title" data-i="${i}" value="${escapeHtml(entry.index?.title || '')}" placeholder="索引标题" style="margin-bottom:6px;">
        <textarea class="form-textarea archive-summary" data-i="${i}" rows="2" placeholder="索引摘要">${escapeHtml(entry.index?.summary || '')}</textarea>
        <input class="form-input archive-keywords" data-i="${i}" value="${escapeHtml((entry.index?.keywords || []).join('、'))}" placeholder="关键词，顿号分隔" style="margin-top:6px;">
        <input class="form-input archive-aliases" data-i="${i}" value="${escapeHtml((entry.index?.aliases || []).join('、'))}" placeholder="其他说法/语义别名" style="margin-top:6px;">
        <details class="archive-original" data-i="${i}" style="margin-top:8px;"><summary style="cursor:pointer;color:#aaa;">查看本轮详细原文</summary><pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;color:#bbb;margin-top:8px;"></pre></details>
      </div>`).join('');
    const pagination = archive.length > ARCHIVE_PAGE_SIZE ? `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0;">
        <button class="btn btn-ghost btn-small" id="archive-prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <span style="font-size:12px;color:#aaa;">第</span>
        <input type="number" class="form-input" id="archive-page" min="1" max="${totalPages}" value="${page}" style="width:64px;">
        <span style="font-size:12px;color:#aaa;">/ ${totalPages} 页，每页 ${ARCHIVE_PAGE_SIZE} 张</span>
        <button class="btn btn-ghost btn-small" id="archive-next" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>` : '';
    contentEl.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">对话索引（${archive.length}）</div>
        <div class="memory-section-hint" style="font-size:12px;color:#888;margin:2px 0 10px;">原文永久保留；这里只编辑用于查找它的目录。最新轮次优先，每页 ${ARCHIVE_PAGE_SIZE} 张；详细原文仅在展开时读取。索引可以手改或按原文重建。</div>
        <button class="btn btn-ghost btn-small" id="archive-catchup" style="margin-bottom:10px;">整理所有待入库轮次</button>
        <button class="btn btn-ghost btn-small" id="archive-fill-times" style="margin:0 0 10px 6px;">本地补齐旧索引时间</button>
        ${pagination}
        <div class="memory-list">${cards || '<div class="memory-empty">暂无已入库轮次</div>'}</div>
      </div>`;
    for (const [selector, key] of [['.archive-scene-time', 'sceneTime'], ['.archive-title', 'title'], ['.archive-summary', 'summary']]) {
      contentEl.querySelectorAll(selector).forEach((el) => el.addEventListener('change', () => { (archive[el.dataset.i].index ||= {})[key] = el.value.trim(); onChange(); }));
    }
    for (const [selector, key] of [['.archive-keywords', 'keywords'], ['.archive-aliases', 'aliases']]) {
      contentEl.querySelectorAll(selector).forEach((el) => el.addEventListener('change', () => { (archive[el.dataset.i].index ||= {})[key] = el.value.split(/[,，;；、]/).map((s) => s.trim()).filter(Boolean); onChange(); }));
    }
    contentEl.querySelectorAll('.archive-original').forEach((el) => el.addEventListener('toggle', () => {
      const pre = el.querySelector('pre');
      if (!el.open) { pre.textContent = ''; return; }
      const raw = readArchivedTurn(chat.messages, archive[el.dataset.i]);
      pre.textContent = raw ? `用户：${raw.userText}\n\nAI：${raw.assistantText}` : '原消息已删除或当前分支不包含此轮';
    }));
    const goToPage = (nextPage) => {
      options.onArchivePage?.(getArchivePage(archive, nextPage).page);
      rerender();
    };
    contentEl.querySelector('#archive-prev')?.addEventListener('click', () => goToPage(page - 1));
    contentEl.querySelector('#archive-next')?.addEventListener('click', () => goToPage(page + 1));
    contentEl.querySelector('#archive-page')?.addEventListener('change', (e) => goToPage(e.target.value));
    contentEl.querySelectorAll('.archive-reindex').forEach((el) => el.addEventListener('click', async () => {
      const entry = archive[el.dataset.i];
      el.disabled = true;
      try {
        const raw = readArchivedTurn(chat.messages, entry);
        if (!raw) throw new Error('原消息已删除，无法重建索引');
        const result = await processRoundForMemory(raw.round, {
          currentState: state,
          supplement: chat.memory.supplement || '',
          greeting: entry.includeGreeting ? getLeadingGreeting(chat.messages) : ''
        });
        entry.index = result.entry.index;
        entry.revision = result.entry.revision;
        onChange();
        rerender();
      } catch (err) { alert('索引重建失败：' + err.message); el.disabled = false; }
    }));
    contentEl.querySelector('#archive-fill-times').addEventListener('click', () => {
      const filled = fillMissingIndexSceneTimes(archive, chat.messages);
      if (filled) { onChange(); rerender(); }
      alert(filled ? `已从原文补齐 ${filled} 条索引时间` : '没有可从原文补齐的缺失时间');
    });
    contentEl.querySelector('#archive-catchup').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        chat.memory.state = state;
        chat.memory.archive = archive;
        await catchUpMemoryArchive(chat, character, getAllRounds(chat.messages).filter((r) => !r.user.meta), { greeting: getLeadingGreeting(chat.messages) });
        onData(chat.memory.state, chat.memory.archive, chat.memory.recallLog);
        rerender();
      } catch (err) { alert('整理失败：' + err.message); e.target.disabled = false; }
    });
  }

  function renderRecalls() {
    const rows = [...recallLog].reverse().map((log) => {
      const titles = log.turnIds.map((id) => {
        const entry = archive.find((a) => a.turnId === id);
        return entry ? `第${entry.round ?? '—'}轮「${entry.index?.title || ''}」` : id;
      }).join('、');
      const selectedActions = String(log.actionContext || '').match(/^第\d+条：.+$/gm) || [];
      const translatedInput = selectedActions.map((line) => line.replace(/^第\d+条：/, '')).join('；');
      const supplement = selectedActions.length ? extractActionOptionSupplement(log.userText) : '';
      const inputText = translatedInput
        ? translatedInput + (supplement ? `；补充：${supplement}` : '')
        : String(log.userText || '');
      return `<div class="memory-card"><div style="font-size:12px;color:#888;">${escapeHtml(log.createdAt || '')}</div><div style="margin-top:4px;">输入：${escapeHtml(inputText)}</div><div style="margin-top:4px;color:#c9bda9;">命中：${escapeHtml(titles || '无')}</div>${log.reasons?.length ? `<div style="margin-top:4px;color:#999;">${escapeHtml(log.reasons.join('；'))}</div>` : ''}</div>`;
    }).join('');
    contentEl.innerHTML = `
      <div class="memory-section">
        <div class="memory-section-title">召回记录</div>
        <div class="memory-section-hint" style="font-size:12px;color:#888;margin:2px 0 10px;">记录副 API 每轮选中了哪些历史原文。可在下面输入一句话测试当前索引会召回什么。</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;"><input class="form-input" id="recall-test-input" placeholder="输入测试内容" style="flex:1;min-width:180px;"><button class="btn btn-primary btn-small" id="recall-test-btn">测试召回</button><button class="btn btn-danger btn-small" id="recall-clear">清空记录</button></div>
        <div id="recall-test-result" style="margin:10px 0;"></div>
        <div class="memory-list">${rows || '<div class="memory-empty">暂无召回记录</div>'}</div>
      </div>`;
    contentEl.querySelector('#recall-clear').addEventListener('click', () => { recallLog.splice(0); onChange(); rerender(); });
    contentEl.querySelector('#recall-test-btn').addEventListener('click', async (e) => {
      const input = contentEl.querySelector('#recall-test-input').value.trim();
      if (!input) return;
      e.target.disabled = true;
      try {
        const result = await selectMemoryRecalls({ archive, state, recallLog: [] }, { userMessage: input, currentState: state });
        contentEl.querySelector('#recall-test-result').innerHTML = result.recalls.length
          ? result.recalls.map((r) => `<div class="memory-card">第${r.entry.round ?? '—'}轮「${escapeHtml(r.entry.index?.title || '')}」<br><span style="color:#999;">${escapeHtml(r.reason)}</span></div>`).join('')
          : '<div class="memory-empty">没有相关历史</div>';
      } catch (err) { alert('召回测试失败：' + err.message); }
      e.target.disabled = false;
    });
  }

  if (tab === 'state') renderState();
  else if (tab === 'archive') renderArchive();
  else renderRecalls();
}
