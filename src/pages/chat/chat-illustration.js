// 插图交互：事件委托 + 付费/手动生图流程
// 通过 createIllustrationController(ctx) 注入会话状态，避免与 renderChat 闭包耦合

import { getConfig, saveConfig, saveChat, saveGeneratedImage } from '../../services/storage.js';
import {
  generateIllustrationForReply,
  generateIllustrationFromPrompt,
  prepareIllustrationPrompt,
  isPaidImageProvider,
  isStrictMechanicalProvider,
  imageProviderDisplayName,
  shotWordsOf,
  mergeAnchorText,
  resolveAnchorRefImages
} from '../../services/image-gen.js';
import { updateGenerationForeground } from '../../services/foreground.js';
import { openBigTextEditor } from '../../utils/big-editor.js';
import { openImageLightbox } from '../../utils/image-lightbox.js';
import {
  imageUi,
  generatedImageCache,
  encodePromptParam,
  extractSeedreamMarkers
} from './chat-image.js';

export async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* 忽略 */ }
    ta.remove();
    return ok;
  }
}

export function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(f);
    };
    input.click();
  });
}

export async function showSeedreamLoading(anchorEl) {
  const cfg = await getConfig().catch(() => ({}));
  const p = (cfg.image && cfg.image.provider) || 'pollinations';
  const providerName = imageProviderDisplayName(p);
  const phase = isStrictMechanicalProvider(p)
    ? `锚点+衣着模板 → ${providerName}`
    : `副 API 总结画面 → ${providerName}`;
  const target = anchorEl.closest('.img-seedream-failrow') || anchorEl;
  const loading = document.createElement('div');
  loading.className = 'img-seedream-loading';
  loading.innerHTML = `<span class="img-seedream-spinner"></span>插图生成中…（${phase}，约 10~30 秒）`;
  target.replaceWith(loading);
}

/**
 * @param {object} ctx
 * @param {() => object} ctx.getChat - 当前会话（可读写 memory/messages/anchors）
 * @param {object} ctx.character
 * @param {string} ctx.characterId
 * @param {(message: string, type?: string) => void} ctx.showMemoryStatus
 * @param {(scrollToEnd?: boolean) => void} ctx.renderMessages
 * @param {() => AbortController|null|undefined} ctx.getAbortController
 */
export function createIllustrationController(ctx) {
  const {
    getChat,
    character,
    characterId,
    showMemoryStatus,
    renderMessages,
    getAbortController
  } = ctx;

  async function generateWithCustomPrompt(msg, prompt) {
    const currentChat = getChat();
    const cfg = await getConfig().catch(() => ({}));
    const markers = extractSeedreamMarkers(msg.content);
    const mk = markers[0];
    if (!mk) return;
    showMemoryStatus('🖼 正在用手动提示词生成插图…', 'info');
    await updateGenerationForeground({ title: '正在生成插图', text: '使用手动修改的提示词…' }).catch(() => {});
    try {
      const { dataUrl, prompt: finalPrompt } = await generateIllustrationFromPrompt({
        prompt,
        config: cfg,
        refImages: await resolveAnchorRefImages(
          currentChat.appearanceAnchors, (mk.alt || '').trim() || character.name, cfg
        )
      });
      const relPath = await saveGeneratedImage(characterId, currentChat.id, dataUrl);
      generatedImageCache.set(relPath, dataUrl);
      msg.content = msg.content.replace(mk.full, `![${mk.alt}](local-img://${relPath}?p=${encodePromptParam(finalPrompt)})`);
      showMemoryStatus('🖼 插图生成完成', 'success');
    } catch (e2) {
      console.warn('seedream 手动提示词生成失败:', e2);
      const failedP = encodePromptParam((e2 && e2.imagePrompt) || prompt);
      msg.content = msg.content.replace(mk.full, `![${mk.alt}](seedream://failed?p=${failedP})`);
      showMemoryStatus(`🖼 插图生成失败：${(e2 && e2.message) || e2}`, 'error');
    }
    await saveChat(currentChat).catch(() => {});
    await updateGenerationForeground({ title: '酒馆正在运行', text: '保持后台连接中…' }).catch(() => {});
  }

  // 同一标记的生成中集合：后台自动生成 / 手动点击 / 失败重试并发时，后到的调用直接跳过，防重复出图
  const inFlightMarkers = new Set();

  async function processSeedreamMarkers(msg) {
    const currentChat = getChat();
    const cfg = await getConfig().catch(() => ({}));
    if (!(cfg.ui && cfg.ui.imageEnabled === true)) return false;
    const provider = (cfg.image && cfg.image.provider) || 'pollinations';
    if (provider === 'manual') return false;
    if (!isPaidImageProvider(provider)) return false;
    const providerName = imageProviderDisplayName(provider);
    const markers = extractSeedreamMarkers(msg.content);
    if (markers.length === 0) return false;
    const mk = markers[0];
    const flightKey = `${msg.timestamp || ''}::${mk.full.slice(0, 50)}`;
    if (inFlightMarkers.has(flightKey)) return false;
    inFlightMarkers.add(flightKey);
    const statusPhase = isStrictMechanicalProvider(provider)
      ? `锚点+衣着模板 → ${providerName}`
      : `副 API 总结画面 → ${providerName}`;
    await updateGenerationForeground({
      title: '正在生成插图',
      text: isStrictMechanicalProvider(provider) ? '正在拼接锚点与衣着模板…' : '副 API 正在总结画面…'
    }).catch(() => {});
    showMemoryStatus(`🖼 正在生成插图（${statusPhase}）…`, 'info');
    try {
      const anchors = currentChat.appearanceAnchors || (currentChat.appearanceAnchors = {});
      const anchorName = (mk.alt || '').trim() || character.name;
      const { dataUrl, prompt, newAnchor } = await generateIllustrationForReply({
        replyContent: msg.content,
        character,
        config: cfg,
        anchorName,
        anchors,
        shotWords: imageUi.cameraEnabled
          ? shotWordsOf(imageUi.shotSel, imageUi.orientSel, imageUi.elevSel, imageUi.aspectSel)
          : null
      });
      if (newAnchor) mergeAnchorText(anchors, newAnchor.name, newAnchor.anchor);
      const relPath = await saveGeneratedImage(characterId, currentChat.id, dataUrl);
      generatedImageCache.set(relPath, dataUrl);
      msg.content = msg.content.replace(mk.full, `![${mk.alt}](local-img://${relPath}?p=${encodePromptParam(prompt)})`);
      showMemoryStatus('🖼 插图生成完成', 'success');
    } catch (e2) {
      console.warn('seedream 插图生成失败:', e2);
      const failedP = encodePromptParam((e2 && e2.imagePrompt) || '');
      msg.content = msg.content.replace(mk.full, `![${mk.alt}](seedream://failed${failedP ? '?p=' + failedP : ''})`);
      showMemoryStatus(`🖼 插图生成失败：${(e2 && e2.message) || e2}`, 'error');
    }
    await saveChat(currentChat).catch(() => {});
    await updateGenerationForeground({ title: '酒馆正在运行', text: '保持后台连接中…' }).catch(() => {});
    inFlightMarkers.delete(flightKey);
    return true;
  }

  async function runManualCompose(msg, mk) {
    const currentChat = getChat();
    mk = mk || extractSeedreamMarkers(msg.content)[0];
    if (!mk) return;
    showMemoryStatus('🖼 副 API 正在总结画面…', 'info');
    const cfg = await getConfig().catch(() => ({}));
    let prompt;
    try {
      const anchors = currentChat.appearanceAnchors || (currentChat.appearanceAnchors = {});
      const anchorName = (mk.alt || '').trim() || character.name;
      const result = await prepareIllustrationPrompt({
        replyContent: msg.content,
        character,
        config: cfg,
        anchorName,
        anchors,
        shotWords: imageUi.cameraEnabled
          ? shotWordsOf(imageUi.shotSel, imageUi.orientSel, imageUi.elevSel, imageUi.aspectSel)
          : null
      });
      prompt = result.prompt;
      if (result.newAnchor) mergeAnchorText(anchors, result.newAnchor.name, result.newAnchor.anchor);
    } catch (e) {
      showMemoryStatus(`🖼 提示词总结失败：${(e && e.message) || e}`, 'error');
      return;
    }
    const copied = await copyTextToClipboard(prompt);
    msg.content = msg.content.replace(mk.full, `![${mk.alt}](seedream://manual?p=${encodePromptParam(prompt)})`);
    await saveChat(currentChat).catch(() => {});
    renderMessages(false);
    showMemoryStatus(
      copied ? '🖼 提示词已总结并自动复制，去 Grok App 粘贴生成' : '🖼 提示词已总结（自动复制失败，点面板的「复制」）',
      copied ? 'success' : 'info'
    );
  }

  function bind(messagesContainer) {
    messagesContainer.addEventListener('change', (e) => {
      const sel = e.target.closest('.img-shot-select, .img-orient-select, .img-elev-select, .img-aspect-select');
      if (!sel) return;
      if (sel.classList.contains('img-shot-select')) imageUi.shotSel = sel.value;
      else if (sel.classList.contains('img-orient-select')) imageUi.orientSel = sel.value;
      else if (sel.classList.contains('img-elev-select')) imageUi.elevSel = sel.value;
      else imageUi.aspectSel = sel.value;
      messagesContainer.querySelectorAll('.img-shot-select').forEach(s => { s.value = imageUi.shotSel; });
      messagesContainer.querySelectorAll('.img-orient-select').forEach(s => { s.value = imageUi.orientSel; });
      messagesContainer.querySelectorAll('.img-elev-select').forEach(s => { s.value = imageUi.elevSel; });
      messagesContainer.querySelectorAll('.img-aspect-select').forEach(s => { s.value = imageUi.aspectSel; });
      getConfig().then(cfg => {
        cfg.ui = {
          ...(cfg.ui || {}),
          imageShot: imageUi.shotSel,
          imageOrient: imageUi.orientSel,
          imageElev: imageUi.elevSel,
          imageAspect: imageUi.aspectSel
        };
        return saveConfig(cfg);
      }).catch(() => {});
    });

    messagesContainer.addEventListener('click', async (e) => {
      const currentChat = getChat();
      const camToggle = e.target.closest('.img-camera-toggle');
      if (camToggle) {
        imageUi.cameraEnabled = !imageUi.cameraEnabled;
        messagesContainer.querySelectorAll('.img-camera-toggle').forEach(b => {
          b.classList.toggle('on', imageUi.cameraEnabled);
          b.title = `镜头控制：${imageUi.cameraEnabled ? '开（构图词会拼进提示词）' : '关（AI 自由判断构图）'}，点击切换`;
        });
        messagesContainer.querySelectorAll('.img-shot-select, .img-orient-select, .img-elev-select, .img-aspect-select')
          .forEach(s => { s.disabled = !imageUi.cameraEnabled; });
        getConfig().then(cfg => {
          cfg.ui = { ...(cfg.ui || {}), imageCameraEnabled: imageUi.cameraEnabled };
          return saveConfig(cfg);
        }).catch(() => {});
        return;
      }

      const findMsg = (el) => {
        const msgEl = el.closest('.message');
        const ts = msgEl && msgEl.dataset.timestamp;
        return currentChat.messages.find(m => m.timestamp === ts);
      };
      const guardSeedream = async () => {
        if (getAbortController && getAbortController()) {
          showMemoryStatus('AI 正在回复中，等回复完成后再生成插图', 'info');
          return false;
        }
        const cfg = await getConfig().catch(() => ({}));
        const p = (cfg.image && cfg.image.provider) || 'pollinations';
        if (!isPaidImageProvider(p)) {
          showMemoryStatus('当前生图服务为免费模式（pollinations），无法生成该插图', 'info');
          return false;
        }
        return true;
      };

      const genBtn = e.target.closest('.img-seedream-gen:not(.img-file-missing)');
      if (genBtn && messagesContainer.contains(genBtn)) {
        if (!(await guardSeedream())) return;
        const msg = findMsg(genBtn);
        if (!msg) return;
        const cfgNow = await getConfig().catch(() => ({}));
        if (((cfgNow.image && cfgNow.image.provider) || '') === 'manual') {
          await runManualCompose(msg, null);
          return;
        }
        showSeedreamLoading(genBtn);
        await processSeedreamMarkers(msg);
        renderMessages(false);
        return;
      }

      const manualPromptEl = e.target.closest('.img-manual-prompt');
      if (manualPromptEl && messagesContainer.contains(manualPromptEl)) {
        manualPromptEl.classList.toggle('expanded');
        return;
      }
      const manualBtn = e.target.closest('.img-manual-copy, .img-manual-edit, .img-manual-recompose, .img-manual-pick');
      if (manualBtn && messagesContainer.contains(manualBtn)) {
        const panel = manualBtn.closest('.img-manual-panel');
        const msg = panel && findMsg(panel);
        if (!msg) return;
        const mk = extractSeedreamMarkers(msg.content).find(m => m.manual);
        if (!mk) return;
        const encP = (panel && panel.dataset.imgPrompt) || mk.prompt || '';

        if (manualBtn.classList.contains('img-manual-copy')) {
          let text = '';
          try { text = decodeURIComponent(encP); } catch (e2) { /* 保留空串 */ }
          const ok = await copyTextToClipboard(text);
          showMemoryStatus(ok ? '提示词已复制，去 Grok App 粘贴生成' : '复制失败，请点提示词展开后手动全选', ok ? 'success' : 'error');
          return;
        }

        if (manualBtn.classList.contains('img-manual-edit')) {
          let current = '';
          try { current = decodeURIComponent(encP); } catch (e2) { /* 保留空串 */ }
          openBigTextEditor({
            title: '修改生图提示词（保存后点「复制」再粘贴到 Grok App）',
            value: current,
            onSave: async (newText) => {
              const trimmed = (newText || '').trim();
              if (!trimmed) return;
              msg.content = msg.content.replace(mk.full, `![${mk.alt}](seedream://manual?p=${encodePromptParam(trimmed)})`);
              await saveChat(getChat()).catch(() => {});
              renderMessages(false);
              showMemoryStatus('提示词已更新', 'success');
            }
          });
          return;
        }

        if (manualBtn.classList.contains('img-manual-recompose')) {
          await runManualCompose(msg, mk);
          return;
        }

        if (manualBtn.classList.contains('img-manual-pick')) {
          const dataUrl = await pickImageFile();
          if (!dataUrl) {
            showMemoryStatus('未选择图片，面板保留可稍后继续', 'info');
            return;
          }
          try {
            const chat = getChat();
            const relPath = await saveGeneratedImage(characterId, chat.id, dataUrl);
            generatedImageCache.set(relPath, dataUrl);
            msg.content = msg.content.replace(mk.full, `![${mk.alt}](local-img://${relPath}${encP ? '?p=' + encP : ''})`);
            await saveChat(chat).catch(() => {});
            renderMessages(false);
            showMemoryStatus('🖼 插图已插入', 'success');
          } catch (e2) {
            showMemoryStatus(`🖼 插图保存失败：${(e2 && e2.message) || e2}`, 'error');
          }
          return;
        }
      }

      const retryBtn = e.target.closest('.img-seedream-retry');
      if (retryBtn && messagesContainer.contains(retryBtn)) {
        if (!(await guardSeedream())) return;
        const msg = findMsg(retryBtn);
        if (!msg) return;
        showSeedreamLoading(retryBtn);
        await processSeedreamMarkers(msg);
        renderMessages(false);
        return;
      }

      const editBtn = e.target.closest('.img-seedream-edit');
      if (editBtn && messagesContainer.contains(editBtn)) {
        if (!(await guardSeedream())) return;
        const msg = findMsg(editBtn);
        if (!msg) return;
        let currentPrompt = '';
        try { currentPrompt = decodeURIComponent(editBtn.dataset.imgPrompt || ''); } catch (e2) { /* 保留空串 */ }
        openBigTextEditor({
          title: '修改生图提示词（直接生成，不再重新拼词/总结）',
          value: currentPrompt,
          placeholder: '上次生成失败没有留下提示词，可手动输入。支持中文，风格后缀会自动追加。',
          onSave: async (newPrompt) => {
            if (!newPrompt || !newPrompt.trim()) return;
            showSeedreamLoading(editBtn);
            await generateWithCustomPrompt(msg, newPrompt.trim());
            renderMessages(false);
          }
        });
        return;
      }

      const missingBtn = e.target.closest('.img-file-missing');
      if (missingBtn && messagesContainer.contains(missingBtn)) {
        if (!(await guardSeedream())) return;
        const msg = findMsg(missingBtn);
        if (!msg) return;
        const path = (missingBtn.dataset.genPath || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const p = missingBtn.dataset.imgPrompt || '';
        const re = new RegExp(`!\\[[^\\]]*\\]\\(local-img://${path}[^)]*\\)`);
        if (!re.test(msg.content)) return;
        msg.content = msg.content.replace(re, `![${missingBtn.dataset.imgAlt || '插图'}](seedream://failed${p ? '?p=' + p : ''})`);
        await saveChat(getChat()).catch(() => {});
        renderMessages(false);
        return;
      }

      const btn = e.target.closest('.img-placeholder');
      if (btn && messagesContainer.contains(btn)) {
        const img = document.createElement('img');
        img.src = btn.dataset.imgSrc;
        img.alt = btn.dataset.imgAlt || '插图';
        btn.replaceWith(img);
        return;
      }
      const img = e.target.closest('.message-content img, .message-thinking-body img');
      if (img && messagesContainer.contains(img) && img.src) {
        openImageLightbox(img.src, img.alt || '插图', img.dataset.imgPrompt || '');
      }
    });
  }

  return {
    bind,
    processSeedreamMarkers,
    generateWithCustomPrompt,
    runManualCompose,
    showSeedreamLoading
  };
}
