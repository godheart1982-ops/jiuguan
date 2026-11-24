import { getConfig, saveConfig } from '../../services/storage.js';
import { escapeHtml, applyFontSize, applyTheme, normalizeTheme, THEMES } from './settings-shared.js';

export async function renderUiSettingsModal() {
  const existing = document.getElementById('ui-settings-modal');
  if (existing) existing.remove();

  const config = await getConfig();
  const ui = config.ui || { fontSize: 14, theme: 'tavern' };
  const initialTheme = normalizeTheme(ui.theme);
  const initialFontSize = ui.fontSize || 14;
  let selectedTheme = initialTheme;

  const themeCardsHtml = THEMES.map((t) => {
    const activeClass = t.id === selectedTheme ? ' active' : '';
    const dots = t.swatches
      .map((c) => `<span class="theme-swatch-dot" style="background:${c}"></span>`)
      .join('');
    return `
      <button type="button" class="theme-card${activeClass}" data-theme-id="${t.id}">
        <div class="theme-swatch-row">${dots}</div>
        <div class="theme-card-name">${escapeHtml(t.name)}</div>
        <div class="theme-card-desc">${escapeHtml(t.desc)}</div>
      </button>
    `;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'ui-settings-modal';

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>界面设置</h2>
        <button class="btn btn-ghost btn-icon" id="btn-close-ui-settings">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-section" style="margin-top: 0; padding-top: 0; border-top: none;">
          <div class="form-section-title">外观主题</div>
          <div class="form-group">
            <label class="form-label">界面主题（点击实时预览，保存后生效）</label>
            <div class="theme-picker-grid" id="setting-theme-picker">
              ${themeCardsHtml}
            </div>
            <div class="form-hint" style="margin-top: 8px;">选择「跟随系统」后，每次启动 App 及系统切换深/浅色模式时，都会自动切换为羊皮纸浅色或暗夜酒馆深色。</div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">排版</div>
          <div class="form-group">
            <label class="form-label">字体大小（px）</label>
            <input class="form-input" id="setting-font-size" type="number" min="10" max="24" step="1" value="${initialFontSize}">
            <div class="form-hint">聊天界面和全局文字大小，范围 10–24px，默认 14px</div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="btn-cancel-ui-settings">取消</button>
        <button class="btn btn-primary" id="btn-save-ui-settings">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const themePicker = overlay.querySelector('#setting-theme-picker');
  if (themePicker) {
    themePicker.querySelectorAll('.theme-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedTheme = normalizeTheme(btn.dataset.themeId);
        themePicker.querySelectorAll('.theme-card').forEach((el) => {
          el.classList.toggle('active', el.dataset.themeId === selectedTheme);
        });
        applyTheme(selectedTheme);
      });
    });
  }

  function closeModal(revert = true) {
    if (revert) {
      applyTheme(initialTheme);
      applyFontSize(initialFontSize);
    }
    overlay.remove();
  }

  document.getElementById('btn-close-ui-settings').addEventListener('click', () => closeModal(true));
  document.getElementById('btn-cancel-ui-settings').addEventListener('click', () => closeModal(true));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(true);
  });

  document.getElementById('btn-save-ui-settings').addEventListener('click', async () => {
    const fontSizeRaw = document.getElementById('setting-font-size').value.trim();
    const fontSize = fontSizeRaw ? parseInt(fontSizeRaw, 10) : 14;
    if (isNaN(fontSize) || fontSize < 10 || fontSize > 24) {
      alert('字体大小请输入 10-24 之间的数字');
      return;
    }
    const latestConfig = await getConfig();
    latestConfig.ui = {
      ...(latestConfig.ui || {}),
      fontSize,
      theme: selectedTheme
    };
    applyFontSize(fontSize);
    applyTheme(selectedTheme);
    await saveConfig(latestConfig);
    closeModal(false);
  });
}
