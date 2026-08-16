// Markdown 渲染（含插图后处理）
import { marked as markedImport } from 'marked';
import { escapeHtml } from './chat-utils.js';
import { splitLeadingModules } from './chat-status-fold.js';
import { normalizePollinationsUrls, transformSeedreamImages, applyImageDisplayMode } from './chat-image.js';

const marked = markedImport || (typeof window !== 'undefined' ? window.marked : null);
if (marked && marked.setOptions) {
  marked.setOptions({ breaks: true, gfm: true });
}

export function renderMarkdown(text) {
  if (!text) return '';
  try {
    text = normalizePollinationsUrls(text);
    const html = marked.parse(text, { breaks: true, gfm: true }).replace(/>\n\s*</g, '><');
    return transformSeedreamImages(applyImageDisplayMode(html));
  } catch (e) {
    console.warn('Markdown render failed:', e);
    return escapeHtml(text);
  }
}

/**
 * AI 回复的展示渲染 = 状态栏模块折叠 + 独白段落样式 + 正文 markdown。
 * 仅影响展示，msg.content 原文不动（记忆总结 / 世界书扫描均基于原文）。
 * 区域切分逻辑在 chat-status-fold.js（纯函数，可单测）。
 */

/** 独白段落：整段被全角括号包裹的段落加斜体弱色样式（与叙述/对话视觉分流） */
function applyMonologueStyle(html) {
  if (!html || typeof document === 'undefined') return html;
  const holder = document.createElement('div');
  holder.innerHTML = html;
  for (const p of holder.querySelectorAll('p')) {
    const text = (p.textContent || '').trim();
    if (text.length > 1 && text.startsWith('（') && text.endsWith('）')) {
      p.classList.add('rp-monologue');
    }
  }
  return holder.innerHTML;
}

export function renderAssistantDisplay(body) {
  if (!body) return '';
  const { modules, headings, rest } = splitLeadingModules(body);
  const restHtml = applyMonologueStyle(renderMarkdown(rest));
  if (!modules) return restHtml;
  // 摘要行：只列角色模块名（固定模块永远在不报名字），加模块总数
  const charNames = [...modules.matchAll(/^>\s*#{2,6}\s*\[([^\]|]+)/gm)].map((m) => m[1].trim()).filter(Boolean);
  const summary = charNames.length
    ? `状态栏｜${escapeHtml(charNames.join('、'))} 等 ${headings.length} 个模块`
    : `状态栏｜${headings.length} 个模块`;
  return (
    `<details class="status-fold" open><summary>` +
    `<span>📊</span><span class="status-fold-label">${summary}</span>` +
    `<span class="status-fold-caret">▸</span></summary>` +
    `<div class="status-fold-body">${renderMarkdown(modules)}</div></details>` +
    restHtml
  );
}
