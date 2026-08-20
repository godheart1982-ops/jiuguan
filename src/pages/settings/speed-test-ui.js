// API 测速 / 跑分面板：挂在 API 设置「高级」区，主/副 API 均可测
// 记录持久化在 config.speedTestRecords（新纪录在前，上限见 SPEED_TEST_MAX_RECORDS）

import { getConfig, saveConfig } from '../../services/storage.js';
import {
  runSpeedTest, appendSpeedTestRecord, SPEED_TEST_DEFAULT_ROUNDS
} from '../../services/api-speed-test.js';
import { escapeHtml } from './settings-shared.js';

/**
 * @param {Object} deps
 * @param {() => Object} deps.readMainApi 读取主 API 表单当前值
 * @param {() => Object} deps.readSubApi 读取副 API 表单当前值（不完整返回 {}）
 * @param {Object} deps.els { target, rounds, quickBtn, fullBtn, status, records }
 */
export function createSpeedTestController(deps) {
  const { readMainApi, readSubApi, els } = deps;
  let running = false;

  function thinkingInfoOf(apiConfig) {
    const nativeOn = (apiConfig.reasoningEffort && apiConfig.reasoningEffort !== 'off') || apiConfig.deepseekThinking === true;
    const promptOn = apiConfig.enableThinking === true;
    if (nativeOn && promptOn) return { mode: 'both', label: '原生推理+思维链' };
    if (nativeOn) return { mode: 'native', label: '原生推理' };
    if (promptOn) return { mode: 'prompt', label: '提示词思维链' };
    return { mode: 'off', label: '关闭' };
  }

  function resolveTarget() {
    const target = els.target.value === 'memory' ? 'memory' : 'main';
    return { target, apiConfig: target === 'memory' ? readSubApi() : readMainApi() };
  }

  function setStatus(text, color) {
    els.status.textContent = text;
    els.status.style.color = color || '#aaa';
  }

  function setRunning(v) {
    running = v;
    els.quickBtn.disabled = v;
    els.fullBtn.disabled = v;
  }

  async function persistRecord(record) {
    const config = await getConfig();
    config.speedTestRecords = appendSpeedTestRecord(config.speedTestRecords, record);
    await saveConfig(config).catch(() => {});
  }

  async function run(mode) {
    if (running) return;
    const { target, apiConfig } = resolveTarget();
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
      setStatus(target === 'memory' ? '副 API 未填完整（Base URL / Key / 模型）' : '请先填写 API Base URL、API Key 和模型名称', '#ff6b6b');
      return;
    }
    const thinking = target === 'main' ? thinkingInfoOf(apiConfig) : { mode: 'off', label: '关闭' };
    setRunning(true);
    setStatus('准备中…');

    const record = {
      id: 'st' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      createdAt: new Date().toISOString(),
      mode,
      target,
      model: apiConfig.model,
      baseUrl: apiConfig.baseUrl,
      format: apiConfig.format || 'openai',
      thinkingLabel: thinking.label
    };

    try {
      const { summary, balance } = await runSpeedTest(apiConfig, {
        mode,
        rounds: parseInt(els.rounds.value, 10) || SPEED_TEST_DEFAULT_ROUNDS,
        thinkingMode: thinking.mode,
        onProgress: (text) => setStatus(text)
      });
      Object.assign(record, { status: 'done', balance: balance || null }, summary);
      setStatus('测速完成', '#7ee787');
    } catch (e) {
      Object.assign(record, { status: 'failed', error: (e && e.message) || String(e) });
      setStatus('测速失败：' + record.error, '#ff6b6b');
    }

    await persistRecord(record);
    await renderRecords();
    setRunning(false);
  }

  const fmtMs = (v) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' ms');
  const fmtRate = (v) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 1 }));
  const fmtInt = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));

  function metricHtml(value, label) {
    return `<div class="st-metric"><div class="st-metric-value">${value}</div><div class="st-metric-label">${label}</div></div>`;
  }

  function recordCardHtml(r) {
    const when = new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false });
    const targetLabel = r.target === 'memory' ? '副 API' : '主 API';
    const modeLabel = r.mode === 'full' ? '完整跑分' : '快速测速';
    const badge = r.status === 'done'
      ? '<span class="st-badge st-badge-ok">已完成</span>'
      : '<span class="st-badge st-badge-fail">失败</span>';
    let body;
    if (r.status === 'done') {
      body = `<div class="st-metrics">` +
        metricHtml(fmtInt(r.rounds), '参考轮数') +
        metricHtml(fmtMs(r.ttftP50Ms), '首 Token P50') +
        metricHtml(fmtMs(r.totalP95Ms), '总延迟 P95') +
        metricHtml(fmtRate(r.outTokPerSec), '输出 Token/s') +
        metricHtml(fmtRate(r.overallTokPerSec), '总体输出 Token/s') +
        metricHtml(fmtInt(r.rpm), '请求/分钟') +
        metricHtml(r.formatPassPct == null ? '—' : r.formatPassPct + '%', '格式遵循') +
        metricHtml(fmtInt(r.totalTokens), '总 Token（含预热）') +
        metricHtml(escapeHtml(r.balance || '平台未提供'), '余额') +
        `</div>`;
    } else {
      body = `<div class="st-error">${escapeHtml(r.error || '未知错误')}</div>`;
    }
    return `<div class="st-card">
      <div class="st-card-head">
        <span class="st-card-title">${escapeHtml(r.model || '')} ${badge}</span>
        <button class="btn btn-ghost btn-small st-del" data-id="${escapeHtml(r.id)}" type="button">删除这条记录</button>
      </div>
      <div class="st-card-sub">${targetLabel} · ${modeLabel} · ${escapeHtml(r.baseUrl || '')} · ${escapeHtml(r.format || 'openai')} · 思考：${escapeHtml(r.thinkingLabel || '关闭')} · ${when}</div>
      ${body}
    </div>`;
  }

  async function renderRecords() {
    const config = await getConfig();
    const records = Array.isArray(config.speedTestRecords) ? config.speedTestRecords : [];
    els.records.innerHTML = records.length
      ? records.map(recordCardHtml).join('')
      : '<div class="form-hint">暂无测速记录。</div>';
  }

  els.quickBtn.addEventListener('click', () => run('quick'));
  els.fullBtn.addEventListener('click', () => run('full'));
  els.records.addEventListener('click', async (e) => {
    const btn = e.target.closest('.st-del');
    if (!btn) return;
    const config = await getConfig();
    config.speedTestRecords = (Array.isArray(config.speedTestRecords) ? config.speedTestRecords : [])
      .filter((r) => r && r.id !== btn.dataset.id);
    await saveConfig(config).catch(() => {});
    await renderRecords();
  });

  return { run, renderRecords };
}
