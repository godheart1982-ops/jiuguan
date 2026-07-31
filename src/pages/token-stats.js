/**
 * Token 用量统计弹窗：汇总 + 按角色/按模型/按天明细（可折叠、可下钻）
 * 下钻：点角色 → 该卡每日消耗；点模型 → 该模型每日消耗；点某天 → 当天按模型/按角色明细
 */

import { getTokenStats, saveTokenStats, getConfig, saveConfig } from '../services/storage.js';
import { summarizeStats } from '../services/token-stats.js';

function fmt(n) {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function bucketCells(b) {
  return `<td>${fmt(b.input)}</td><td>${fmt(b.output)}</td><td>${fmt(b.cacheRead)}</td><td>${fmt(b.requests)}</td>`;
}

function sumOf(b) {
  return (b.input || 0) + (b.output || 0) + (b.cacheRead || 0);
}

function isEmptyBucket(b) {
  return !b || (!b.input && !b.output && !b.cacheRead && !b.cacheWrite && !b.requests);
}

function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
}

// 当天总消耗减去各模型合计的差额 = 未记录模型的旧数据（「未知模型」的当日量）
function dayModelGap(dayStats) {
  const t = dayStats.total || emptyBucket();
  const sum = emptyBucket();
  for (const m of Object.values(dayStats.models || {})) {
    for (const k of Object.keys(sum)) sum[k] += m[k] || 0;
  }
  const gap = emptyBucket();
  for (const k of Object.keys(gap)) gap[k] = Math.max(0, (t[k] || 0) - sum[k]);
  return gap;
}

export async function renderTokenStatsModal() {
  const existing = document.getElementById('token-stats-modal');
  if (existing) existing.remove();

  const stats = await getTokenStats();
  const summary = summarizeStats(stats);

  // 折叠状态持久化：config.ui.tokenStatsCollapsed = { chars, models, days }
  const config = await getConfig();
  if (!config.ui) config.ui = {};
  const collapsed = config.ui.tokenStatsCollapsed || {};

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'token-stats-modal';

  overlay.innerHTML = `
    <div class="modal" style="width: 680px; max-width: 94vw;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
          <button class="btn btn-ghost btn-icon hidden" id="btn-stats-back" title="返回">←</button>
          <h2 id="stats-title" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">📊 Token 用量统计</h2>
        </div>
        <button class="btn btn-ghost btn-icon" id="btn-close-stats">✕</button>
      </div>
      <div class="modal-body" id="stats-body">
        <div id="stats-main"></div>
        <div id="stats-detail" class="hidden"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger" id="btn-clear-stats">清空统计</button>
        <button class="btn btn-ghost" id="btn-cancel-stats">关闭</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const mainEl = overlay.querySelector('#stats-main');
  const detailEl = overlay.querySelector('#stats-detail');
  const titleEl = overlay.querySelector('#stats-title');
  const backBtn = overlay.querySelector('#btn-stats-back');
  const clearBtn = overlay.querySelector('#btn-clear-stats');

  function close() { overlay.remove(); }
  overlay.querySelector('#btn-close-stats').addEventListener('click', close);
  overlay.querySelector('#btn-cancel-stats').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  backBtn.addEventListener('click', () => {
    detailEl.classList.add('hidden');
    mainEl.classList.remove('hidden');
    backBtn.classList.add('hidden');
    clearBtn.classList.remove('hidden');
    titleEl.textContent = '📊 Token 用量统计';
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('确定清空所有 token 统计数据？')) return;
    await saveTokenStats({ days: {} });
    overlay.remove();
    renderTokenStatsModal();
  });

  // ---------- 主视图 ----------

  const emptyRow = (cols) => `<tr><td colspan="${cols}" style="text-align:center; color:var(--text-muted);">暂无数据</td></tr>`;
  const drillArrow = '<td class="stats-drill-arrow">›</td>';

  // 按角色累计（按总消耗降序）
  const charRows = Object.entries(summary.charTotals)
    .sort((a, b) => sumOf(b[1]) - sumOf(a[1]))
    .map(([key, c]) => `<tr class="stats-row-click" data-drill-type="char" data-drill-key="${encodeURIComponent(key)}"><td title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>${bucketCells(c)}${drillArrow}</tr>`)
    .join('');

  // 按模型累计（按总消耗降序）
  const modelRows = Object.entries(summary.modelTotals)
    .sort((a, b) => sumOf(b[1]) - sumOf(a[1]))
    .map(([name, m]) => `<tr class="stats-row-click" data-drill-type="model" data-drill-key="${encodeURIComponent(name)}"><td title="${escapeHtml(name)}">${escapeHtml(name)}</td>${bucketCells(m)}${drillArrow}</tr>`)
    .join('');

  // 最近 14 天明细（新→旧）
  const dayRows = Object.entries(stats.days || {})
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14)
    .map(([day, d]) => `<tr class="stats-row-click" data-drill-type="day" data-drill-key="${day}"><td>${day}</td>${bucketCells(d.total || {})}${drillArrow}</tr>`)
    .join('');

  mainEl.innerHTML = `
    <div class="stats-cards">
      <div class="stats-card">
        <div class="stats-card-title">今日</div>
        <div class="stats-card-value">${fmt(sumOf(summary.today))}</div>
        <div class="stats-card-sub">${summary.today.requests} 次请求</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-title">本月</div>
        <div class="stats-card-value">${fmt(sumOf(summary.month))}</div>
        <div class="stats-card-sub">${summary.month.requests} 次请求</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-title">累计</div>
        <div class="stats-card-value">${fmt(sumOf(summary.allTime))}</div>
        <div class="stats-card-sub">${summary.allTime.requests} 次请求</div>
      </div>
    </div>
    <div class="form-hint" style="margin: 4px 0 16px;">缓存读 = 命中 prompt 缓存的输入 token（费用约为普通输入的 1/10）；统计保留最近 90 天，按模型分组仅对新数据生效。点击表格行可查看明细。</div>

    <div class="stats-section">
      <div class="stats-section-header" data-section="chars">
        <span class="stats-section-toggle">${collapsed.chars ? '▶' : '▼'}</span>
        <span>按角色累计</span>
      </div>
      <div class="stats-section-body ${collapsed.chars ? 'hidden' : ''}" data-section="chars">
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>角色</th><th>输入</th><th>输出</th><th>缓存读</th><th>请求</th><th></th></tr></thead>
            <tbody>${charRows || emptyRow(6)}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="stats-section">
      <div class="stats-section-header" data-section="models">
        <span class="stats-section-toggle">${collapsed.models ? '▶' : '▼'}</span>
        <span>按模型累计</span>
      </div>
      <div class="stats-section-body ${collapsed.models ? 'hidden' : ''}" data-section="models">
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读</th><th>请求</th><th></th></tr></thead>
            <tbody>${modelRows || emptyRow(6)}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="stats-section">
      <div class="stats-section-header" data-section="days">
        <span class="stats-section-toggle">${collapsed.days ? '▶' : '▼'}</span>
        <span>最近 14 天</span>
      </div>
      <div class="stats-section-body ${collapsed.days ? 'hidden' : ''}" data-section="days">
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>日期</th><th>输入</th><th>输出</th><th>缓存读</th><th>请求</th><th></th></tr></thead>
            <tbody>${dayRows || emptyRow(6)}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // 折叠/展开分类，状态写入 config 持久化
  mainEl.querySelectorAll('.stats-section-header').forEach(header => {
    header.addEventListener('click', async () => {
      const section = header.dataset.section;
      const body = mainEl.querySelector(`.stats-section-body[data-section="${section}"]`);
      const toggle = header.querySelector('.stats-section-toggle');
      const isCollapsed = body.classList.toggle('hidden');
      toggle.textContent = isCollapsed ? '▶' : '▼';

      const cfg = await getConfig();
      if (!cfg.ui) cfg.ui = {};
      if (!cfg.ui.tokenStatsCollapsed) cfg.ui.tokenStatsCollapsed = {};
      cfg.ui.tokenStatsCollapsed[section] = isCollapsed;
      await saveConfig(cfg).catch(() => {});
    });
  });

  // 行点击下钻
  mainEl.querySelectorAll('.stats-row-click').forEach(row => {
    row.addEventListener('click', () => {
      openDetail(row.dataset.drillType, decodeURIComponent(row.dataset.drillKey));
    });
  });

  // ---------- 下钻详情 ----------

  function openDetail(type, key) {
    let title = '';
    let html = '';

    if (type === 'char') {
      const total = summary.charTotals[key] || emptyBucket();
      title = total.name || key;
      const rows = Object.entries(stats.days || {})
        .sort((a, b) => b[0].localeCompare(a[0]))
        .filter(([, d]) => d.chars && d.chars[key] && !isEmptyBucket(d.chars[key]))
        .map(([day, d]) => `<tr><td>${day}</td>${bucketCells(d.chars[key])}</tr>`)
        .join('');
      html = detailSummaryCard(total) + detailTable('每日消耗', '日期', rows);

    } else if (type === 'model') {
      const total = summary.modelTotals[key] || emptyBucket();
      title = key;
      const rows = Object.entries(stats.days || {})
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([day, d]) => {
          // 「未知模型」按天现算差额，其他模型直接读记录
          const bucket = key === '未知模型'
            ? dayModelGap(d)
            : (d.models && d.models[key]);
          return bucket && !isEmptyBucket(bucket)
            ? `<tr><td>${day}</td>${bucketCells(bucket)}</tr>`
            : '';
        })
        .join('');
      html = detailSummaryCard(total) + detailTable('每日消耗', '日期', rows);

    } else if (type === 'day') {
      const d = (stats.days || {})[key];
      if (!d) return;
      title = key;
      const modelRowsDay = Object.entries(d.models || {})
        .sort((a, b) => sumOf(b[1]) - sumOf(a[1]))
        .map(([name, m]) => `<tr><td title="${escapeHtml(name)}">${escapeHtml(name)}</td>${bucketCells(m)}</tr>`)
        .join('');
      const gap = dayModelGap(d);
      const gapRow = isEmptyBucket(gap) ? '' : `<tr><td title="未记录模型名的旧数据">未知模型</td>${bucketCells(gap)}</tr>`;
      const charRowsDay = Object.entries(d.chars || {})
        .sort((a, b) => sumOf(b[1]) - sumOf(a[1]))
        .map(([, c]) => `<tr><td title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>${bucketCells(c)}</tr>`)
        .join('');
      html = detailSummaryCard(d.total || emptyBucket())
        + detailTable('当天按模型', '模型', modelRowsDay + gapRow)
        + detailTable('当天按角色', '角色', charRowsDay);
    }

    detailEl.innerHTML = html;
    mainEl.classList.add('hidden');
    detailEl.classList.remove('hidden');
    backBtn.classList.remove('hidden');
    clearBtn.classList.add('hidden');
    titleEl.textContent = title;
  }

  function detailSummaryCard(bucket) {
    return `
      <div class="stats-cards" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 16px;">
        <div class="stats-card">
          <div class="stats-card-title">总消耗</div>
          <div class="stats-card-value">${fmt(sumOf(bucket))}</div>
        </div>
        <div class="stats-card">
          <div class="stats-card-title">输入</div>
          <div class="stats-card-value">${fmt(bucket.input)}</div>
        </div>
        <div class="stats-card">
          <div class="stats-card-title">输出</div>
          <div class="stats-card-value">${fmt(bucket.output)}</div>
        </div>
        <div class="stats-card">
          <div class="stats-card-title">缓存读</div>
          <div class="stats-card-value">${fmt(bucket.cacheRead)}</div>
        </div>
      </div>
    `;
  }

  function detailTable(title, firstCol, rows) {
    return `
      <div class="stats-section">
        <div class="stats-section-header" style="cursor: default;">
          <span>${title}</span>
        </div>
        <div class="stats-table-wrap">
          <table class="stats-table">
            <thead><tr><th>${firstCol}</th><th>输入</th><th>输出</th><th>缓存读</th><th>请求</th></tr></thead>
            <tbody>${rows || emptyRow(5)}</tbody>
          </table>
        </div>
      </div>
    `;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
