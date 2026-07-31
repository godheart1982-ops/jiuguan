// 大图查看器：全屏遮罩，支持按钮/滚轮/双击/双指捏合缩放，放大后可拖拽平移
// 供聊天页插图与设置页测试生图结果共用。
// prompt 为 encodeURIComponent 过的生图提示词（seedream 本地图），有才显示 📝 按钮；不传则无提示词按钮
export function openImageLightbox(src, alt, prompt) {
  const existing = document.getElementById('img-lightbox');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'img-lightbox';
  overlay.className = 'img-lightbox';
  overlay.innerHTML = `
    <div class="img-lightbox-toolbar">
      <span class="img-lightbox-alt">${escapeHtml(alt || '插图')}</span>
      <div class="img-lightbox-actions">
        ${prompt ? '<button type="button" class="btn btn-ghost btn-icon" id="lb-prompt" title="查看生图提示词">📝</button>' : ''}
        <button type="button" class="btn btn-ghost btn-icon" id="lb-zoom-out" title="缩小">−</button>
        <span class="img-lightbox-zoom" id="lb-zoom-level">100%</span>
        <button type="button" class="btn btn-ghost btn-icon" id="lb-zoom-in" title="放大">＋</button>
        <button type="button" class="btn btn-ghost btn-icon" id="lb-zoom-reset" title="适应屏幕">1:1</button>
        <button type="button" class="btn btn-ghost btn-icon" id="lb-close" title="关闭">✕</button>
      </div>
    </div>
    <div class="img-lightbox-stage" id="lb-stage">
      <img id="lb-img" src="${src}" alt="${escapeHtml(alt || '插图')}" draggable="false">
    </div>
    ${prompt ? `<div class="img-lightbox-prompt hidden" id="lb-prompt-panel">${escapeHtml(decodeURIComponent(prompt))}</div>` : ''}
  `;
  document.body.appendChild(overlay);

  const img = overlay.querySelector('#lb-img');
  const stage = overlay.querySelector('#lb-stage');
  const zoomLabel = overlay.querySelector('#lb-zoom-level');

  let scale = 1, tx = 0, ty = 0;

  function apply() {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    zoomLabel.textContent = Math.round(scale * 100) + '%';
    img.classList.toggle('zoomed', scale > 1);
  }

  // 以舞台中某点为锚缩放（鼠标位置 / 双指中心），默认舞台中心
  function zoomTo(newScale, px, py) {
    newScale = Math.min(8, Math.max(0.2, newScale));
    const rect = stage.getBoundingClientRect();
    const cx = px !== undefined ? px : rect.left + rect.width / 2;
    const cy = py !== undefined ? py : rect.top + rect.height / 2;
    const ox = cx - (rect.left + rect.width / 2);
    const oy = cy - (rect.top + rect.height / 2);
    const ratio = newScale / scale;
    tx = ox - (ox - tx) * ratio;
    ty = oy - (oy - ty) * ratio;
    scale = newScale;
    if (scale <= 1) { tx = 0; ty = 0; }
    apply();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }

  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  overlay.querySelector('#lb-close').addEventListener('click', close);
  overlay.querySelector('#lb-zoom-in').addEventListener('click', () => zoomTo(scale * 1.4));
  overlay.querySelector('#lb-zoom-out').addEventListener('click', () => zoomTo(scale / 1.4));
  overlay.querySelector('#lb-zoom-reset').addEventListener('click', () => { scale = 1; tx = 0; ty = 0; apply(); });

  // 提示词面板开关
  const promptBtn = overlay.querySelector('#lb-prompt');
  if (promptBtn) {
    const panel = overlay.querySelector('#lb-prompt-panel');
    promptBtn.addEventListener('click', () => {
      panel.classList.toggle('hidden');
    });
  }

  // 点背景（非图片）关闭；拖拽后的一次 click 不算
  let didDrag = false;
  stage.addEventListener('click', (e) => {
    if (e.target === stage && !didDrag) close();
    didDrag = false;
  });

  // 滚轮缩放（以光标为锚）
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }, { passive: false });

  // 双击在 1x 与 2.5x 之间切换
  stage.addEventListener('dblclick', (e) => {
    e.preventDefault();
    zoomTo(scale > 1 ? 1 : 2.5, e.clientX, e.clientY);
  });

  // 单指/鼠标拖拽平移 + 双指捏合缩放（Pointer Events 统一处理）
  const pointers = new Map();
  let dragLast = null;
  let pinchStartDist = 0, pinchStartScale = 1;

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchStartScale = scale;
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && dragLast) {
      const dx = e.clientX - dragLast.x;
      const dy = e.clientY - dragLast.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) didDrag = true;
      tx += dx;
      ty += dy;
      dragLast = { x: e.clientX, y: e.clientY };
      apply();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStartDist > 0) {
        zoomTo(pinchStartScale * (dist / pinchStartDist), (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
    }
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    dragLast = null;
    if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      dragLast = { x: p.x, y: p.y };
    } else if (pointers.size === 0) {
      // 手指全部抬起后，短时间内仍视为拖拽结束，抑制 click 关闭
      setTimeout(() => { didDrag = false; }, 50);
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  apply();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
