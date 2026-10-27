/**
 * 提示词库：内置模板（角色卡/状态栏/思维链/世界书/文风/剧情等）+ 自定义模板。
 * 内置条目可编辑/导出/恢复默认，自定义可增删改；全局默认输出格式/思维链指向库条目，卡上留空即继承。
 */
import { navigate } from '../app.js';
import { getConfig, saveConfig, createUUID } from '../services/storage.js';
import { ensurePromptLibrary, PROMPT_PRESET_SEED } from '../services/prompt-library.js';
import { openBigTextEditor } from '../utils/big-editor.js';
import { promptText } from '../utils/prompt-dialog.js';
import { Capacitor } from '@capacitor/core';

export async function renderPromptLibrary(container) {
  container.innerHTML = '';
  const config = await getConfig();
  if (ensurePromptLibrary(config)) await saveConfig(config);

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <h1 class="page-title">提示词库</h1>
    <div class="page-actions">
      <button class="btn btn-ghost" id="btn-prompt-back">返回</button>
      <button class="btn btn-primary" id="btn-prompt-add">＋ 添加自定义模板</button>
    </div>
  `;
  container.appendChild(header);

  const body = document.createElement('div');
  body.className = 'wb-manager-body';
  body.innerHTML = `
    <div class="form-section">
      <div class="form-section-title">模板列表</div>
      <div class="form-hint" style="margin-bottom: 8px;">内置模板可编辑、可导出、可恢复默认；自定义模板可增删改。导出的 txt 与仓库根目录的模板文件一致（含 BOM）。在卡编辑页为每张卡选择加载哪份输出格式/思维链模板（卡级选择，无全局默认）。</div>
      <div id="prompt-list"></div>
    </div>
  `;
  container.appendChild(body);

  function escapeHtml(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderList() {
    const listEl = document.getElementById('prompt-list');
    listEl.innerHTML = config.promptLibrary.map((it, idx) => `
      <div class="memory-card" style="margin-bottom: 8px;">
        <div class="memory-card-header" style="flex-wrap: wrap; gap: 6px;">
          <span style="flex: 1; min-width: 180px; font-size: 0.95rem; font-weight: 600;">
            ${escapeHtml(it.name)}
            <span style="font-weight: 400; font-size: 0.8rem; color: #888;">${it.custom ? '自定义' : '内置'} · ${String(it.content || '').length} 字</span>
          </span>
          <button class="btn btn-ghost btn-small" data-act="edit" data-idx="${idx}">编辑</button>
          <button class="btn btn-ghost btn-small" data-act="export" data-idx="${idx}">导出</button>
          ${it.custom
            ? `<select class="form-input" style="width: 96px; flex-shrink: 0;" data-act="kind" data-idx="${idx}" title="模板类型（决定出现在哪个下拉）">
                <option value="outputFormat" ${it.kind !== 'thinking' ? 'selected' : ''}>输出格式</option>
                <option value="thinking" ${it.kind === 'thinking' ? 'selected' : ''}>思维链</option>
              </select>
              <button class="btn btn-danger btn-small" data-act="del" data-idx="${idx}">删除</button>`
            : `<button class="btn btn-ghost btn-small" data-act="reset" data-idx="${idx}">恢复默认</button>`}
        </div>
      </div>`).join('');

    listEl.querySelectorAll('select[data-act="kind"]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const item = config.promptLibrary[Number(sel.dataset.idx)];
        if (!item) return;
        item.kind = sel.value;
        await saveConfig(config);
        renderList();
      });
    });

    listEl.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = config.promptLibrary[Number(btn.dataset.idx)];
        if (!item) return;
        const act = btn.dataset.act;
        if (act === 'edit') {
          openBigTextEditor({
            title: `编辑模板：${item.name}`,
            value: item.content,
            placeholder: '粘贴或编写模板内容……',
            onSave: async (newValue) => {
              item.content = newValue;
              item.updatedAt = new Date().toISOString();
              await saveConfig(config);
              renderList();
            }
          });
        } else if (act === 'export') {
          await exportPromptTxt(item);
        } else if (act === 'reset') {
          if (!confirm(`把「${item.name}」恢复为内置默认内容？你的修改会被覆盖。`)) return;
          const seed = PROMPT_PRESET_SEED.find((s) => s.id === item.id);
          if (!seed) return;
          item.content = seed.content;
          item.updatedAt = new Date().toISOString();
          await saveConfig(config);
          renderList();
        } else if (act === 'del') {
          if (!confirm(`删除自定义模板「${item.name}」？`)) return;
          config.promptLibrary.splice(Number(btn.dataset.idx), 1);
          if (config.promptDefaults.outputFormatId === item.id) config.promptDefaults.outputFormatId = '';
          if (config.promptDefaults.thinkingFormatId === item.id) config.promptDefaults.thinkingFormatId = '';
          await saveConfig(config);
          renderList();
        }
      });
    });
  }

  document.getElementById('btn-prompt-back').addEventListener('click', () => navigate('home'));
  document.getElementById('btn-prompt-add').addEventListener('click', async () => {
    const name = await promptText({ title: '添加自定义模板', message: '模板名称：', placeholder: '例如：我的输出格式' });
    if (!name || !name.trim()) return;
    const item = { id: 'custom-' + (await createUUID()), name: name.trim(), content: '', custom: true, kind: 'outputFormat' };
    config.promptLibrary.push(item);
    await saveConfig(config);
    renderList();
  });

  renderList();
}

/** 导出单个模板为 txt（带 BOM，和仓库模板文件一致）；Android 走系统分享，桌面/网页走下载。 */
async function exportPromptTxt(item) {
  const fileName = String(item.name || '模板').replace(/[\\/:*?"<>|]/g, '_') + '.txt';
  const content = '﻿' + String(item.content || '');
  try {
    if (Capacitor.isNativePlatform()) {
      const fs = Capacitor.Plugins.Filesystem;
      const share = Capacitor.Plugins.Share;
      if (fs && share) {
        await fs.writeFile({ path: fileName, data: content, directory: 'EXTERNAL', encoding: 'utf8' });
        const uriResult = await fs.getUri({ path: fileName, directory: 'EXTERNAL' });
        await share.share({ title: item.name, files: [uriResult.uri], dialogTitle: '导出提示词模板' });
        return;
      }
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    alert('导出失败：' + (error && error.message ? error.message : String(error)));
  }
}
