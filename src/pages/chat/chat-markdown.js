// Markdown 渲染（含插图后处理）
import { marked as markedImport } from 'marked';
import { escapeHtml } from './chat-utils.js';
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
