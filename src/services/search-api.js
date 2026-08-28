/**
 * 联网检索（Agent 专用搜索 API）
 *
 * 与主/副对话 API 独立：仅用输入框原文作 query，不附带角色卡/历史/记忆。
 * 结果规则拼接为【联网参考】短摘要，由聊天页挂载后在本轮 buildMessages 注入。
 *
 * 服务商：
 *   anysearch — POST {baseUrl}/v1/search，Bearer 认证
 *   custom    — POST 用户填写的完整 endpoint（或 baseUrl + /v1/search），兼容常见 JSON 结构
 */

export const DEFAULT_SEARCH_CONFIG = {
  enabled: false,
  provider: 'anysearch',
  baseUrl: 'https://api.anysearch.com',
  apiKey: '',
  maxResults: 5
};

const QUERY_MAX_LEN = 200;
// 单条正文上限：一次性注入（仅挂载轮生效），宁宽勿缺——长文腰斩比噪音更伤。
// 5 条 × 8000 ≈ 40K 字符单次，相对主设定仍可控；嫌长由用户减条数。
const SNIPPET_MAX_LEN = 8000;
const TITLE_MAX_LEN = 160;
// extract 抓全文上限：全文比摘要长一个量级，防个别超长页面灌爆
export const EXTRACT_MAX_LEN = 20000;

export function normalizeSearchConfig(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const maxResults = parseInt(s.maxResults, 10);
  // AnySearch REST 文档：max_results 1–20，默认 10；我们默认 5 省额度
  return {
    enabled: s.enabled === true,
    provider: s.provider === 'custom' ? 'custom' : 'anysearch',
    baseUrl: (s.baseUrl || DEFAULT_SEARCH_CONFIG.baseUrl).trim().replace(/\/+$/, ''),
    apiKey: (s.apiKey || '').trim(),
    maxResults: Number.isFinite(maxResults) ? Math.max(1, Math.min(20, maxResults)) : 5
  };
}

/** 是否已配置到可调用（总闸开 + 有地址；Key 可选以兼容匿名档） */
export function isSearchReady(searchCfg) {
  const s = normalizeSearchConfig(searchCfg);
  return s.enabled && !!s.baseUrl;
}

/**
 * 从输入框取 query：trim、截断。隐私：调用方不得再拼接历史/人设。
 */
export function buildSearchQueryFromInput(inputText) {
  const q = String(inputText || '').trim().replace(/\s+/g, ' ');
  if (!q) return '';
  return q.length > QUERY_MAX_LEN ? q.slice(0, QUERY_MAX_LEN) : q;
}

function resolveSearchUrl(cfg) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (cfg.provider === 'custom') {
    // 用户可填完整 endpoint（含 /v1/search）或仅域名
    if (/\/v1\/search\/?$/i.test(base) || /\/search\/?$/i.test(base)) return base;
    return base + '/v1/search';
  }
  // anysearch
  if (/\/v1\/search\/?$/i.test(base)) return base;
  return base + '/v1/search';
}

/**
 * 调用搜索 API，返回归一化条目列表
 * @returns {Promise<{query: string, items: Array<{title:string,snippet:string,url:string}>}>}
 */
export async function runWebSearch(query, searchCfg) {
  const cfg = normalizeSearchConfig(searchCfg);
  const q = buildSearchQueryFromInput(query);
  if (!q) throw new Error('请先在输入框填写要检索的内容');
  if (!cfg.enabled) throw new Error('请先在 API 设置 → 搜索 API 中启用联网检索');
  if (!cfg.baseUrl) throw new Error('未配置搜索 API Base URL');

  const url = resolveSearchUrl(cfg);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: q,
        max_results: cfg.maxResults
      })
    });
  } catch (e) {
    throw new Error('搜索网络请求失败：' + (e.message || e));
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
    throw new Error(`搜索 API 失败 (${response.status})：${detail}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error('搜索 API 返回了无法解析的 JSON');
  }

  // AnySearch 业务码：HTTP 200 仍可能 code !== 0
  if (data && typeof data === 'object' && data.code !== undefined && data.code !== 0 && data.code !== '0') {
    throw new Error(data.message || data.error?.message || ('搜索失败 code=' + data.code));
  }

  const items = normalizeSearchResults(data).slice(0, cfg.maxResults);
  if (items.length === 0) {
    throw new Error('搜索无结果，可换个关键词再试');
  }
  return { query: q, items };
}

/**
 * 兼容多种常见响应结构，抽出 title / snippet / url。
 * AnySearch REST：{ code:0, data: { results: [{ title, url, snippet, content }] } }
 */
export function normalizeSearchResults(data) {
  if (!data) return [];
  let list = null;
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data.results)) list = data.results;
  // AnySearch：优先 data.results（data 本身是对象不是数组）
  else if (data.data && Array.isArray(data.data.results)) list = data.data.results;
  else if (Array.isArray(data.data)) list = data.data;
  else if (Array.isArray(data.items)) list = data.items;
  else if (Array.isArray(data.organic)) list = data.organic;
  else if (Array.isArray(data.web)) list = data.web;

  if (!list) {
    // 单条对象兜底
    if (data.title || data.snippet || data.content || data.url) list = [data];
    else return [];
  }

  return list.map((raw) => {
    if (typeof raw === 'string') {
      return { title: '', snippet: raw.slice(0, SNIPPET_MAX_LEN), url: '' };
    }
    const o = raw || {};
    const title = String(o.title || o.name || o.heading || '').trim();
    // AnySearch 同时有 snippet（短）与 content（长）；优先 content，信息更全
    const snippet = String(
      o.content || o.snippet || o.description || o.summary || o.text || o.abstract || ''
    ).trim();
    const url = String(o.url || o.link || o.href || o.source_url || '').trim();
    return {
      title: title.slice(0, TITLE_MAX_LEN),
      snippet: snippet.slice(0, SNIPPET_MAX_LEN),
      url
    };
  }).filter((it) => it.title || it.snippet || it.url);
}

/**
 * 规则拼接【联网参考】块（不调 LLM）
 * @param {string} query
 * @param {Array<{title:string,snippet:string,url:string}>} items
 */
export function formatSearchReferenceBrief(query, items) {
  const lines = (items || []).map((it, i) => {
    const parts = [];
    const head = it.title || it.snippet || it.url || '（无标题）';
    parts.push(`${i + 1}. ${head}`);
    if (it.title && it.snippet) parts.push('   ' + it.snippet);
    else if (!it.title && it.snippet && head !== it.snippet) parts.push('   ' + it.snippet);
    if (it.url) parts.push('   ' + it.url);
    return parts.join('\n');
  });

  return (
    '【联网参考·仅本轮·事实摘录】\n' +
    '查询：' + (query || '') + '\n' +
    lines.join('\n') + '\n' +
    '使用说明：用角色口吻自然融入；勿提及搜索/联网；与角色卡或世界设定冲突时以设定为准；不必强行用满。'
  );
}

/** 测试配置：发一条简单 query */
export async function testSearchApi(searchCfg) {
  const result = await runWebSearch('hello world', { ...normalizeSearchConfig(searchCfg), enabled: true });
  return result;
}

/**
 * AnySearch 原生正文提取：POST {baseUrl}/v1/extract，抓指定 URL 的完整正文（Markdown）
 * 用于搜索结果摘要太短时的按需深挖；失败（反爬/超时/非 HTML）向上抛错
 * @returns {Promise<string>} 正文全文（截断至 EXTRACT_MAX_LEN）
 */
export async function extractUrlContent(url, searchCfg) {
  const cfg = normalizeSearchConfig(searchCfg);
  const u = String(url || '').trim();
  if (!u) throw new Error('缺少要提取的 URL');
  if (!/^https?:\/\//i.test(u)) throw new Error('URL 格式不合法');
  if (!cfg.enabled) throw new Error('请先在 API 设置 → 搜索 API 中启用联网检索');
  if (!cfg.baseUrl) throw new Error('未配置搜索 API Base URL');

  // extract 端点与 search 同主机：容忍 baseUrl 带 /v1 或 /v1/search 的填法
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1(\/search)?$/i, '');
  const extractUrl = base + '/v1/extract';
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;

  let response;
  try {
    response = await fetch(extractUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: u })
    });
  } catch (e) {
    throw new Error('提取网络请求失败：' + (e.message || e));
  }

  let data = null;
  const rawText = await response.text().catch(() => '');
  try { data = JSON.parse(rawText); } catch (e) { data = null; }

  if (!response.ok) {
    const detail = (data && (data.message || (data.error && data.error.message))) || rawText || ('HTTP ' + response.status);
    throw new Error(`正文提取失败 (${response.status})：${String(detail).slice(0, 200)}`);
  }
  if (data && typeof data === 'object' && data.code !== undefined && data.code !== 0 && data.code !== '0') {
    throw new Error(data.message || ('提取失败 code=' + data.code));
  }

  // 兼容常见返回形态：data 为字符串 / data.content|markdown|text / 顶层同名字段
  const content = (typeof data === 'string') ? data
    : (typeof (data && data.data) === 'string') ? data.data
    : String(
      (data && data.data && (data.data.content || data.data.markdown || data.data.text)) ||
      (data && (data.content || data.markdown || data.text)) || ''
    ).trim();
  if (!content) throw new Error('提取成功但正文为空（该页面可能无正文内容）');
  return content.length > EXTRACT_MAX_LEN ? content.slice(0, EXTRACT_MAX_LEN) + '\n（正文过长，已截断）' : content;
}
