import { getConfig, saveConfig, exportAllData, importAllData } from '../../services/storage.js';
import { Capacitor } from '@capacitor/core';
import { refreshCharacters } from '../../app.js';
import { DEFAULT_AUTO_ADVANCE_PROMPT } from '../../services/narrative-rules.js';
import {
  normalizeWebdavConfig,
  webdavTestConnection,
  webdavUploadText,
  webdavDownloadText,
  resolveBackupFileName,
  findLatestBackupFileName,
  listAllBackupFiles,
  DEFAULT_WEBDAV_CONFIG
} from '../../services/webdav-backup.js';
import { encryptBackup, isEncryptedBackup, parseBackupText } from '../../utils/backup-crypto.js';
import { promptBackupPassword } from '../../utils/prompt-dialog.js';
import { escapeHtml, applyFontSize } from './settings-shared.js';

export async function renderOtherSettingsModal() {
  // 如果已经存在弹窗，先移除
  const existing = document.getElementById('other-settings-modal');
  if (existing) existing.remove();

  const config = await getConfig();
  const ui = config.ui || { fontSize: 14 };
  const debug = config.debug || { previewBeforeSend: false };
  const behavior = config.behavior || { autoCompleteLastModule: false };
  const webdav = normalizeWebdavConfig(config.webdav);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'other-settings-modal';

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>其他设置</h2>
        <button class="btn btn-ghost btn-icon" id="btn-close-other-settings">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-section">
          <div class="form-section-title">界面设置</div>
          <div class="form-hint" style="margin-bottom: 12px;">插图 / 生图相关选项已移至侧边栏「插图设置」。</div>
          <div class="form-group">
            <label class="form-label">字体大小（px）</label>
            <input class="form-input" id="setting-font-size" type="number" min="10" max="24" step="1" value="${ui.fontSize || 14}">
            <div class="form-hint">聊天界面和全局文字大小，默认 14px</div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">生成行为</div>
          <div class="form-group">
            <label class="form-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="setting-auto-complete" ${behavior.autoCompleteLastModule ? 'checked' : ''}>
              <span>输出格式末尾模块缺失时自动补全</span>
            </label>
            <div class="form-hint">开启后，如果 AI 回复漏掉了输出格式里最后一个模块（如“可行动选项”），会自动再请求一次补全。关闭则直接按原输出显示。</div>
          </div>
          <div class="form-group">
            <label class="form-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="setting-memory-correction" ${behavior.memoryCorrection !== false ? 'checked' : ''}>
              <span>记忆修正通道（允许 AI 上报记忆矛盾）</span>
            </label>
            <div class="form-hint">开启后，AI 发现【长期记忆】或【事实备忘】与剧情现状矛盾时，会在回复末尾输出「记忆修正：…」，记忆总结时据此自动更正事实备忘。若所用模型频繁误报修正，可在此关闭。</div>
          </div>
          <div class="form-group">
            <label class="form-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="setting-immersive-acting" ${behavior.immersiveActing !== false ? 'checked' : ''}>
              <span>沉浸演绎·反AI腔总则（增强人味）</span>
            </label>
            <div class="form-hint">开启后，向 system 注入一段演绎纪律：不写主控、演出来不解释、拥抱非理性、禁止点题抒情与客服腔，压制新模型"有问必答/句句完整"的对齐职业病。若某模型因此格式不稳定或风格过头，可在此关闭。</div>
          </div>
          <div class="form-group">
            <label class="form-label">空发送推演指令</label>
            <textarea class="form-input" id="setting-auto-advance-prompt" rows="4" style="font-family: monospace; font-size: 0.85rem;"></textarea>
            <div class="form-hint">输入框为空时点发送，App 会把这段文字作为你的消息发给 AI，让它根据设定、记忆与状态栏自行推演下一轮剧情。留空则用内置默认。</div>
            <div class="form-row" style="margin-top: 8px; gap: 8px;">
              <button class="btn btn-ghost" id="btn-auto-advance-reset">↺ 恢复默认</button>
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">调试</div>
          <div class="form-group">
            <label class="form-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="setting-preview-before-send" ${debug.previewBeforeSend ? 'checked' : ''}>
              <span>发送给 AI 前弹出预览窗口</span>
            </label>
            <div class="form-hint">开启后，每次调用 AI 前会先显示最终发送的 messages，确认后才真正发送。</div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">数据备份</div>
          <div class="form-group">
            <label class="form-label">导出/导入全部数据</label>
            <div class="form-hint">
              <strong>整包加密</strong>：导出/上传时会要求设置口令，角色、聊天、API Key 等全部加密进文件；没有口令无法打开。
              导入/从云恢复时<strong>每次都要输入口令</strong>。口令不会保存在本机。请务必牢记——丢失口令等于备份作废。
              仍兼容旧版明文/脱敏备份（导入时不需要口令）。
            </div>
            <div class="form-row" style="margin-top: 10px;">
              <button class="btn btn-ghost" id="btn-export-data">⬇️ 导出加密备份</button>
              <button class="btn btn-ghost" id="btn-import-data">⬆️ 导入恢复</button>
              <input type="file" id="import-file-input" accept="application/json,.json" style="display: none;">
            </div>
          </div>

          <div class="form-group" style="margin-top: 20px;">
            <label class="form-label">坚果云 / WebDAV 云备份</label>
            <div class="form-hint" style="margin-bottom: 10px;">
              默认适配<strong>坚果云</strong>：地址 <code>https://dav.jianguoyun.com/dav</code>；用户名=邮箱；密码=官网「账户信息 → 安全选项 → 添加应用密码」（不是登录密码）。
              上传前同样<strong>整包加密</strong>（每次输入备份口令）；云端文件无口令无法阅读。WebDAV 登录密码存在本机配置里，与备份口令无关。
            </div>
            <label class="form-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
              <input type="checkbox" id="setting-webdav-enabled" ${webdav.enabled ? 'checked' : ''}>
              <span>启用 WebDAV 配置（保存后生效）</span>
            </label>
            <div class="form-group" style="margin-top: 10px;">
              <label class="form-label">服务器地址</label>
              <input class="form-input" id="setting-webdav-base-url" type="text" value="${escapeHtml(webdav.baseUrl || DEFAULT_WEBDAV_CONFIG.baseUrl)}" placeholder="https://dav.jianguoyun.com/dav">
            </div>
            <div class="form-group">
              <label class="form-label">用户名（坚果云邮箱）</label>
              <input class="form-input" id="setting-webdav-username" type="text" value="${escapeHtml(webdav.username || '')}" placeholder="you@example.com" autocomplete="username">
            </div>
            <div class="form-group">
              <label class="form-label">应用密码</label>
              <input class="form-input" id="setting-webdav-password" type="password" value="${escapeHtml(webdav.password || '')}" placeholder="第三方应用密码" autocomplete="current-password">
            </div>
            <div class="form-group">
              <label class="form-label">设备名称</label>
              <input class="form-input" id="setting-webdav-device-name" type="text" value="${escapeHtml(webdav.deviceName || '')}" placeholder="例如：手机 / 平板 / 书房电脑">
              <div class="form-hint">写入备份文件名，区分多台设备。文件名格式：<code>backup-日期时间-设备.json</code>，例如 <code>backup-20260729-213045-手机.json</code>。留空则设备段为 <code>default</code>。</div>
            </div>
            <div class="form-group">
              <label class="form-label">云端目录</label>
              <input class="form-input" id="setting-webdav-remote-dir" type="text" value="${escapeHtml(webdav.remoteDir || 'jiuguan')}" placeholder="jiuguan">
            </div>
            <div class="form-hint" id="webdav-filename-preview" style="margin: 4px 0 8px;">下次上传文件名：—</div>
            <div class="form-hint" id="webdav-last-status" style="margin: 6px 0 10px;">
              ${webdav.lastBackupAt ? `上次上传：${escapeHtml(webdav.lastBackupAt)}` : '尚未上传过云备份'}
              ${webdav.lastBackupFileName ? ` · 文件：${escapeHtml(webdav.lastBackupFileName)}` : ''}
              ${webdav.lastRestoreAt ? ` · 上次恢复：${escapeHtml(webdav.lastRestoreAt)}` : ''}
            </div>
            <div class="form-row" style="gap: 8px; flex-wrap: wrap; align-items: center;">
              <button class="btn btn-ghost" id="btn-webdav-test" type="button">测试连接</button>
              <button class="btn btn-ghost" id="btn-webdav-upload" type="button">☁️ 上传到云</button>
              <button class="btn btn-ghost" id="btn-webdav-download" type="button" title="单击：恢复本设备最新备份；长按：列出目录下全部备份自选">☁️ 从云恢复</button>
              <span id="webdav-action-status" style="color: #aaa; font-size: 0.9em;"></span>
            </div>
            <div class="form-hint" style="margin-top: 6px;">从云恢复：<strong>单击</strong>恢复本设备最新一份；<strong>长按</strong>列出云端目录下<strong>全部备份</strong>（含其他设备），自选恢复。</div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="btn-cancel-other-settings">取消</button>
        <button class="btn btn-primary" id="btn-save-other-settings">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // 空发送推演指令
  const autoAdvanceEl = document.getElementById('setting-auto-advance-prompt');
  autoAdvanceEl.value = behavior.autoAdvancePrompt || DEFAULT_AUTO_ADVANCE_PROMPT;
  document.getElementById('btn-auto-advance-reset').addEventListener('click', () => {
    autoAdvanceEl.value = DEFAULT_AUTO_ADVANCE_PROMPT;
  });

  function closeModal() {
    overlay.remove();
  }

  document.getElementById('btn-close-other-settings').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-other-settings').addEventListener('click', closeModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.getElementById('btn-save-other-settings').addEventListener('click', async () => {
    const fontSizeRaw = document.getElementById('setting-font-size').value.trim();
    const fontSize = fontSizeRaw ? parseInt(fontSizeRaw, 10) : 14;

    if (isNaN(fontSize) || fontSize < 10 || fontSize > 24) {
      alert('字体大小请输入 10-24 之间的数字');
      return;
    }

    // 重新读取最新配置，避免覆盖掉 API 等字段
    const latestConfig = await getConfig();
    // 保留 ui 下其他字段（折叠状态等），只更新本页负责的几项
    latestConfig.ui = {
      ...(latestConfig.ui || {}),
      fontSize
    };
    latestConfig.debug = {
      previewBeforeSend: document.getElementById('setting-preview-before-send').checked
    };
    latestConfig.behavior = {
      autoCompleteLastModule: document.getElementById('setting-auto-complete').checked,
      autoAdvancePrompt: (autoAdvanceEl.value.trim() === DEFAULT_AUTO_ADVANCE_PROMPT.trim()) ? '' : autoAdvanceEl.value.trim(),
      memoryCorrection: document.getElementById('setting-memory-correction').checked,
      immersiveActing: document.getElementById('setting-immersive-acting').checked
    };
    // WebDAV（坚果云）
    const prevWebdav = normalizeWebdavConfig(latestConfig.webdav);
    latestConfig.webdav = normalizeWebdavConfig({
      enabled: document.getElementById('setting-webdav-enabled').checked,
      baseUrl: document.getElementById('setting-webdav-base-url').value.trim(),
      username: document.getElementById('setting-webdav-username').value.trim(),
      password: document.getElementById('setting-webdav-password').value,
      remoteDir: document.getElementById('setting-webdav-remote-dir').value.trim(),
      deviceName: document.getElementById('setting-webdav-device-name').value.trim(),
      lastBackupAt: prevWebdav.lastBackupAt,
      lastBackupFileName: prevWebdav.lastBackupFileName,
      lastRestoreAt: prevWebdav.lastRestoreAt
    });

    // 即时应用字体大小
    applyFontSize(fontSize);

    await saveConfig(latestConfig);
    closeModal();
  });

  function readWebdavForm() {
    return normalizeWebdavConfig({
      enabled: document.getElementById('setting-webdav-enabled').checked,
      baseUrl: document.getElementById('setting-webdav-base-url').value.trim(),
      username: document.getElementById('setting-webdav-username').value.trim(),
      password: document.getElementById('setting-webdav-password').value,
      remoteDir: document.getElementById('setting-webdav-remote-dir').value.trim(),
      deviceName: document.getElementById('setting-webdav-device-name').value.trim()
    });
  }

  function updateWebdavFilenamePreview() {
    const el = document.getElementById('webdav-filename-preview');
    if (!el) return;
    const form = readWebdavForm();
    const sample = resolveBackupFileName(form);
    el.innerHTML = `下次上传文件名示例：<code>${escapeHtml(sample)}</code>（按上传时刻生成）`;
  }
  const deviceNameEl = document.getElementById('setting-webdav-device-name');
  if (deviceNameEl) {
    deviceNameEl.addEventListener('input', updateWebdavFilenamePreview);
    deviceNameEl.addEventListener('change', updateWebdavFilenamePreview);
  }
  updateWebdavFilenamePreview();

  async function persistWebdavMeta(patch) {
    const cfg = await getConfig();
    cfg.webdav = normalizeWebdavConfig({ ...(cfg.webdav || {}), ...readWebdavForm(), ...patch });
    await saveConfig(cfg);
    const statusEl = document.getElementById('webdav-last-status');
    if (statusEl) {
      const w = cfg.webdav;
      statusEl.textContent =
        (w.lastBackupAt ? `上次上传：${w.lastBackupAt}` : '尚未上传过云备份') +
        (w.lastBackupFileName ? ` · 文件：${w.lastBackupFileName}` : '') +
        (w.lastRestoreAt ? ` · 上次恢复：${w.lastRestoreAt}` : '');
    }
  }

  /** 打包明文备份（含密钥）再整包加密，返回信封 JSON 字符串 */
  async function buildEncryptedBackupContent() {
    const password = await promptBackupPassword('create');
    if (password === null) return null;
    // 整包加密后可安全带上全部密钥
    const plain = await exportAllData({ includeSecrets: true });
    const envelope = await encryptBackup(plain, password);
    return JSON.stringify(envelope, null, 2);
  }

  /** 解析备份文本：加密则要口令；明文旧备份直接用 */
  async function loadBackupFromText(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error('备份文件不是有效 JSON');
    }
    if (isEncryptedBackup(obj)) {
      const password = await promptBackupPassword('unlock');
      if (password === null) return null;
      return parseBackupText(text, password);
    }
    return obj;
  }

  // 数据备份：整包加密导出 / 导入
  document.getElementById('btn-export-data').addEventListener('click', async () => {
    try {
      const content = await buildEncryptedBackupContent();
      if (content === null) return;
      const fileName = `jiuguan-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([content], { type: 'application/json' });

      if (Capacitor.isNativePlatform()) {
        const fs = Capacitor.Plugins.Filesystem;
        const share = Capacitor.Plugins.Share;
        if (fs && share) {
          await fs.writeFile({
            path: fileName,
            data: content,
            directory: 'EXTERNAL',
            encoding: 'utf8'
          });
          const uriResult = await fs.getUri({
            path: fileName,
            directory: 'EXTERNAL'
          });
          await share.share({
            title: '酒馆加密备份',
            files: [uriResult.uri],
            dialogTitle: '导出酒馆加密备份'
          });
          alert('已导出加密备份。请牢记口令，丢失将无法恢复。');
          return;
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      alert('已导出加密备份。请牢记口令，丢失将无法恢复。');
    } catch (error) {
      alert('导出失败：' + (error.message || String(error)));
    }
  });

  const importFileInput = document.getElementById('import-file-input');
  document.getElementById('btn-import-data').addEventListener('click', () => {
    importFileInput.click();
  });

  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('导入会覆盖当前角色卡、聊天记录等数据。确定继续吗？')) {
      importFileInput.value = '';
      return;
    }

    try {
      const text = await file.text();
      const backup = await loadBackupFromText(text);
      if (backup === null) return; // 用户取消口令
      await importAllData(backup);
      await refreshCharacters();
      alert(
        '导入成功，数据已恢复' +
        (backup.secretsRedacted ? '（旧版脱敏备份：已尽量合并本机密钥）' : '')
      );
      closeModal();
    } catch (error) {
      alert('导入失败：' + error.message);
    } finally {
      importFileInput.value = '';
    }
  });

  // WebDAV 操作（用表单当前值，可不先点底部保存）
  const webdavStatusEl = document.getElementById('webdav-action-status');
  const setWebdavStatus = (text, color) => {
    if (!webdavStatusEl) return;
    webdavStatusEl.textContent = text || '';
    webdavStatusEl.style.color = color || '#aaa';
  };

  document.getElementById('btn-webdav-test').addEventListener('click', async () => {
    const btn = document.getElementById('btn-webdav-test');
    btn.disabled = true;
    setWebdavStatus('测试中…');
    try {
      const r = await webdavTestConnection(readWebdavForm());
      setWebdavStatus(`连接正常 (${r.status})`, '#7ee787');
      alert('WebDAV 连接成功\n目录：' + r.url + (r.note ? '\n' + r.note : ''));
    } catch (e) {
      setWebdavStatus('连接失败', '#ff6b6b');
      alert('WebDAV 测试失败：' + (e.message || e));
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-webdav-upload').addEventListener('click', async () => {
    const btn = document.getElementById('btn-webdav-upload');
    btn.disabled = true;
    setWebdavStatus('等待设置口令…');
    try {
      const form = readWebdavForm();
      if (!form.deviceName.trim()) {
        if (!confirm('未填写设备名称，将使用「default」。建议为每台设备起不同名称。继续？')) {
          setWebdavStatus('');
          return;
        }
      }
      setWebdavStatus('打包加密中…');
      const content = await buildEncryptedBackupContent();
      if (content === null) {
        setWebdavStatus('');
        return;
      }
      setWebdavStatus('上传中…');
      const fileName = resolveBackupFileName(form); // backup-YYYYMMDD-HHmmss-设备.json
      await webdavUploadText(form, content, fileName);
      const now = new Date().toISOString();
      await persistWebdavMeta({ lastBackupAt: now, lastBackupFileName: fileName, enabled: true });
      setWebdavStatus('上传成功', '#7ee787');
      alert(
        `已上传加密备份到云端\n目录：${form.remoteDir}\n设备：${form.deviceName.trim() || 'default'}\n文件：${fileName}\n请牢记备份口令。`
      );
    } catch (e) {
      setWebdavStatus('上传失败', '#ff6b6b');
      alert('云备份上传失败：' + (e.message || e));
    } finally {
      btn.disabled = false;
    }
  });

  /**
   * 从云端指定文件恢复
   * @param {string} fileName
   * @param {{ note?: string }} [meta]
   */
  async function restoreFromWebdavFile(fileName, meta = {}) {
    const btn = document.getElementById('btn-webdav-download');
    btn.disabled = true;
    setWebdavStatus(`下载 ${fileName}…`);
    try {
      const form = readWebdavForm();
      const text = await webdavDownloadText(form, fileName);
      setWebdavStatus('解密中…');
      const backup = await loadBackupFromText(text);
      if (backup === null) {
        setWebdavStatus('已取消');
        return;
      }
      await importAllData(backup);
      await refreshCharacters();
      const now = new Date().toISOString();
      await persistWebdavMeta({ lastRestoreAt: now, enabled: true });
      setWebdavStatus('恢复成功', '#7ee787');
      alert(`云备份已恢复到本机\n文件：${fileName}${meta.note ? '\n' + meta.note : ''}`);
      closeModal();
    } catch (e) {
      setWebdavStatus('恢复失败', '#ff6b6b');
      alert('从云恢复失败：' + (e.message || e));
    } finally {
      btn.disabled = false;
    }
  }

  /** 长按：弹出云端目录下全部备份列表（含其他设备） */
  function openWebdavBackupPicker() {
    const form = readWebdavForm();
    const currentDevice = (form.deviceName || 'default').trim() || 'default';
    const existing = document.getElementById('webdav-backup-picker-overlay');
    if (existing) existing.remove();

    const overlayPick = document.createElement('div');
    overlayPick.id = 'webdav-backup-picker-overlay';
    overlayPick.className = 'modal-overlay';
    overlayPick.style.zIndex = '2100';
    overlayPick.innerHTML = `
      <div class="modal" style="width: min(480px, 94vw); max-height: 85vh; display: flex; flex-direction: column;">
        <div class="modal-header">
          <h2 style="font-size: 1.05rem; margin: 0;">选择云备份</h2>
          <button type="button" class="btn btn-ghost btn-icon" id="webdav-picker-close">✕</button>
        </div>
        <div class="modal-body" style="flex: 1; overflow-y: auto; min-height: 120px;">
          <div class="form-hint" style="margin-bottom: 10px;">目录 <code>${escapeHtml(form.remoteDir)}</code> · 全部设备（当前本机：${escapeHtml(currentDevice)}）</div>
          <div id="webdav-picker-list" style="color: #aaa;">加载中…</div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" id="webdav-picker-cancel">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlayPick);

    const closePick = () => overlayPick.remove();
    overlayPick.querySelector('#webdav-picker-close').addEventListener('click', closePick);
    overlayPick.querySelector('#webdav-picker-cancel').addEventListener('click', closePick);
    overlayPick.addEventListener('click', (e) => {
      if (e.target === overlayPick) closePick();
    });

    const listEl = overlayPick.querySelector('#webdav-picker-list');
    listAllBackupFiles(form)
      .then((list) => {
        if (!list.length) {
          listEl.innerHTML = '<div class="form-hint">该目录下暂无备份文件</div>';
          return;
        }
        listEl.innerHTML = list.map((item) => {
          const isMine = item.device && item.device === currentDevice;
          const badge = isMine
            ? ' <span style="color: var(--accent, #7c9eff); font-size: 0.8em;">本机设备</span>'
            : (item.device ? ` <span style="color: #c9a227; font-size: 0.8em;">设备：${escapeHtml(item.device)}</span>` : '');
          return `
          <button type="button" class="btn btn-ghost webdav-picker-item" data-name="${escapeHtml(item.fileName)}"
            style="display: block; width: 100%; text-align: left; margin-bottom: 8px; padding: 10px 12px; white-space: normal; line-height: 1.35;">
            <div style="font-weight: 600;">${escapeHtml(item.label)}${badge}</div>
            <div style="font-size: 0.8rem; color: #888; word-break: break-all;">${escapeHtml(item.fileName)}</div>
          </button>`;
        }).join('');
        listEl.querySelectorAll('.webdav-picker-item').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            if (!confirm(`确定用此备份覆盖本机数据？\n${name}`)) return;
            closePick();
            await restoreFromWebdavFile(name);
          });
        });
      })
      .catch((e) => {
        listEl.innerHTML = `<div style="color: #ff6b6b;">加载失败：${escapeHtml(e.message || String(e))}</div>`;
      });
  }

  // 单击 = 最新；长按 = 列表选择（触摸 + 鼠标）
  {
    const dlBtn = document.getElementById('btn-webdav-download');
    let longPressTimer = null;
    let longPressFired = false;
    const LONG_MS = 480;

    const clearLong = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const startLong = (e) => {
      longPressFired = false;
      clearLong();
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        // 触觉反馈（若支持）
        if (navigator.vibrate) {
          try { navigator.vibrate(30); } catch (err) { /* ignore */ }
        }
        openWebdavBackupPicker();
      }, LONG_MS);
    };

    const endLong = () => {
      clearLong();
    };

    dlBtn.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      startLong(e);
    });
    dlBtn.addEventListener('pointerup', endLong);
    dlBtn.addEventListener('pointerleave', endLong);
    dlBtn.addEventListener('pointercancel', endLong);
    // 避免长按后系统弹出菜单
    dlBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    dlBtn.addEventListener('click', async (e) => {
      if (longPressFired) {
        e.preventDefault();
        e.stopPropagation();
        longPressFired = false;
        return;
      }
      if (!confirm('将从云端下载「本设备最新一份」备份并覆盖本机数据。加密备份需输入口令。确定？')) {
        return;
      }
      try {
        setWebdavStatus('查找最新备份…');
        const form = readWebdavForm();
        const found = await findLatestBackupFileName(form);
        const note =
          (found.candidates ? `（该设备共 ${found.candidates} 份，已选最新）` : '') +
          (found.fallback ? '\n（列表失败时回退到本机记录的上次上传文件）' : '');
        await restoreFromWebdavFile(found.fileName, { note: note.trim() });
      } catch (err) {
        setWebdavStatus('恢复失败', '#ff6b6b');
        alert('从云恢复失败：' + (err.message || err));
      }
    });
  }
}
