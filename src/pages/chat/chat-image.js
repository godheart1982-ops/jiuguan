// 插图状态、seedream 标记、本地图缓存
import { getGeneratedImageDataUrl } from '../../services/storage.js';
import { escapeHtml } from './chat-utils.js';

export const imageUi = {
  displayMode: 'auto',
  providerMode: 'pollinations',
  shotSel: 'auto',
  orientSel: 'auto',
  elevSel: 'auto',
  aspectSel: 'landscape',
  cameraEnabled: true
};

export function applyImageUiFromConfig(appConfig) {
  imageUi.displayMode = (appConfig.ui && appConfig.ui.imageDisplay) || 'auto';
  imageUi.providerMode = (appConfig.image && appConfig.image.provider) || 'pollinations';
  imageUi.shotSel = (appConfig.ui && appConfig.ui.imageShot) || 'auto';
  imageUi.orientSel = (appConfig.ui && appConfig.ui.imageOrient) || 'auto';
  imageUi.elevSel = (appConfig.ui && appConfig.ui.imageElev) || 'auto';
  imageUi.aspectSel = (appConfig.ui && appConfig.ui.imageAspect) || 'landscape';
  imageUi.cameraEnabled = !appConfig.ui || appConfig.ui.imageCameraEnabled !== false;
}

export const generatedImageCache = new Map();

export function normalizePollinationsUrls(content) {
  if (!content || typeof content !== 'string') return content;
  return content.replace(
    /(https:\/\/image\.pollinations\.ai\/prompt\/)([^?]+)(\?[^\s)]+)/g,
    (match, prefix, prompt, query) => {
      try {
        const decoded = decodeURIComponent(prompt);
        return prefix + encodeURIComponent(decoded) + query;
      } catch (e) {
        return prefix + encodeURIComponent(prompt) + query;
      }
    }
  );
}

// ---------- Seedream（付费生图） ----------

// 本地已生成图缓存：local-img 相对路径 → dataURL（避免每次渲染都读盘）

export function encodePromptParam(s) {
  return encodeURIComponent(s || '').replace(/[()']/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// 扫描 seedream 插图标记：![主题](seedream://)（待生成）、![主题](seedream://failed?p=...)（上次失败，p=最后用的提示词）、
// ![主题](seedream://manual?p=...)（手动模式：提示词已总结待选图，p=总结好的提示词）

export function extractSeedreamMarkers(content) {
  if (!content || typeof content !== 'string') return [];
  const results = [];
  const re = /!\[([^\]]*)\]\((seedream:\/\/[^)\s]*)\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const pm = /[?&]p=([^&]*)/.exec(m[2]);
    results.push({ alt: m[1].trim(), url: m[2], full: m[0], failed: m[2].includes('failed'), manual: m[2].includes('manual'), prompt: pm ? pm[1] : '' });
  }
  return results;
}

// renderMarkdown 后处理：seedream 标记 → 生成/重试/改词按钮/手动面板；local-img → 缓存 dataURL 或留待异步补水

export function transformSeedreamImages(html) {
  if (!html) return html;
  html = html.replace(/<img([^>]*?)src="seedream:\/\/([^"]*)"([^>]*)>/g, (match, pre, rest, post) => {
    const altMatch = (pre + post).match(/alt="([^"]*)"/);
    const alt = altMatch ? altMatch[1] : '';
    // 手动模式面板：提示词持久化在标记里，常驻显示，复制/改词/重新总结/选图插入
    if (rest.includes('manual')) {
      const pm = /[?&]p=([^&]*)/.exec(rest);
      const encP = pm ? pm[1] : '';
      let promptText = '';
      try { promptText = decodeURIComponent(encP); } catch (e) { /* 保留空串 */ }
      return `<span class="img-manual-panel" data-img-alt="${alt}" data-img-prompt="${encP}">` +
        `<span class="img-manual-title">🖼 手动生图（提示词已就绪，点提示词展开/收起）</span>` +
        `<span class="img-manual-prompt">${escapeHtml(promptText)}</span>` +
        `<span class="img-manual-actions">` +
        shotAngleSelectsHtml() +
        `<button type="button" class="img-manual-copy">📋 复制</button>` +
        `<button type="button" class="img-manual-edit">✏️ 改词</button>` +
        `<button type="button" class="img-manual-recompose">🔄 重新总结</button>` +
        `<button type="button" class="img-manual-pick">📁 选图插入</button>` +
        `</span></span>`;
    }
    if (rest.includes('failed')) {
      const pm = /[?&]p=([^&]*)/.exec(rest);
      const pAttr = pm ? ` data-img-prompt="${pm[1]}"` : '';
      const altText = alt ? '（' + alt + '）' : '';
      return `<span class="img-seedream-failrow">` +
        shotAngleSelectsHtml() +
        `<button type="button" class="img-seedream-retry" data-img-alt="${alt}"${pAttr}>🔄 重试${altText}</button>` +
        `<button type="button" class="img-seedream-edit" data-img-alt="${alt}"${pAttr}>✏️ 改词重试</button>` +
        `</span>`;
    }
    const genLabel = imageUi.providerMode === 'manual' ? '🖼 点击生成插图提示词' : '🖼 点击生成插图';
    return `<span class="img-gen-row">${shotAngleSelectsHtml()}<button type="button" class="img-seedream-gen" data-img-alt="${alt}">${genLabel}${alt ? '（' + alt + '）' : ''}</button></span>`;
  });
  html = html.replace(/<img([^>]*?)src="local-img:\/\/([^"]*)"([^>]*)>/g, (match, pre, full, post) => {
    // local-img://路径?p={encodeURIComponent(提示词)}：路径用于读图，提示词透传给大图查看器
    const qIdx = full.indexOf('?');
    const path = qIdx === -1 ? full : full.slice(0, qIdx);
    let promptAttr = '';
    if (qIdx !== -1) {
      const pm = /(?:^|&)p=([^&]*)/.exec(full.slice(qIdx + 1));
      if (pm && pm[1]) promptAttr = ` data-img-prompt="${pm[1]}"`;
    }
    const cached = generatedImageCache.get(path);
    if (cached) return `<img${pre}src="${cached}"${promptAttr}${post}>`;
    return `<img${pre}src="" data-gen-path="${path}"${promptAttr}${post}>`;
  });
  return html;
}

// 异步给 data-gen-path 占位图补水（读本地文件 → dataURL）

export async function hydrateGeneratedImages(root) {
  if (!root || !root.querySelectorAll) return;
  const pending = root.querySelectorAll('img[data-gen-path]');
  for (const img of pending) {
    const path = img.dataset.genPath;
    if (!path) continue;
    let dataUrl = generatedImageCache.get(path);
    if (!dataUrl) {
      dataUrl = await getGeneratedImageDataUrl(path).catch(() => null);
      if (dataUrl) generatedImageCache.set(path, dataUrl);
    }
    if (!img.isConnected) continue;
    if (dataUrl) {
      img.src = dataUrl;
      img.removeAttribute('data-gen-path');
    } else {
      // 文件读不到：换成"重新生成"按钮，点击后把 local-img 引用改回失败标记，走标准重试/改词流程
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'img-seedream-gen img-file-missing';
      btn.dataset.imgAlt = img.alt || '';
      btn.dataset.genPath = path;
      if (img.dataset.imgPrompt) btn.dataset.imgPrompt = img.dataset.imgPrompt;
      btn.textContent = '🖼 插图文件缺失，点击重新生成';
      img.replaceWith(btn);
    }
  }
}

// 插图显示档位（renderChat 加载时从 config 读取）：auto / click / hide

export function shotAngleSelectsHtml() {
  const shotOpts = [['auto', '景别:自动'], ['closeup', '特写'], ['half', '半身'], ['full', '全身']];
  const orientOpts = [['auto', '朝向:自动'], ['front', '面向镜头'], ['sideL', '左侧面'], ['sideR', '右侧面'], ['back', '背对镜头']];
  const elevOpts = [['auto', '高度:自动'], ['level', '平行'], ['top', '俯视'], ['low', '仰视']];
  const aspectOpts = [['landscape', '横向'], ['portrait', '竖向']];
  const mk = (opts, cls, cur) => `<select class="${cls}"${imageUi.cameraEnabled ? '' : ' disabled'}>` +
    opts.map(([v, t]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`).join('') + '</select>';
  const toggle = `<button type="button" class="img-camera-toggle${imageUi.cameraEnabled ? ' on' : ''}" title="镜头控制：${imageUi.cameraEnabled ? '开（构图词会拼进提示词）' : '关（AI 自由判断构图）'}，点击切换">🎥</button>`;
  return `<span class="img-shot-controls">${toggle}${mk(shotOpts, 'img-shot-select', imageUi.shotSel)}${mk(orientOpts, 'img-orient-select', imageUi.orientSel)}${mk(elevOpts, 'img-elev-select', imageUi.elevSel)}${mk(aspectOpts, 'img-aspect-select', imageUi.aspectSel)}</span>`;
}

// 按档位处理 pollinations 插图：auto 原样；click 换成占位按钮（点击加载）；hide 换成提示文字

export function applyImageDisplayMode(html) {
  if (imageUi.displayMode === 'auto' || !html) return html;
  return html.replace(/<img([^>]*?)src="(https:\/\/image\.pollinations\.ai\/[^"]*)"([^>]*)>/g, (match, pre, src, post) => {
    const altMatch = (pre + post).match(/alt="([^"]*)"/);
    const alt = altMatch ? altMatch[1] : '';
    if (imageUi.displayMode === 'click') {
      return `<button type="button" class="img-placeholder" data-img-src="${src}" data-img-alt="${alt}">🖼 点击加载插图${alt ? '（' + alt + '）' : ''}</button>`;
    }
    return `<span class="img-hidden-note">🖼 插图已隐藏（可在其他设置中开启）</span>`;
  });
}

export function extractImageSeeds(content) {
  const found = [];
  if (!content) return found;
  const re = /!\[([^\]]+)\]\((https:\/\/image\.pollinations\.ai\/[^)\s]*?[?&]seed=(\d+)[^)\s]*)\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1].trim();
    const seed = parseInt(m[3], 10);
    if (name && Number.isFinite(seed)) found.push({ name, seed });
  }
  return found;
}

