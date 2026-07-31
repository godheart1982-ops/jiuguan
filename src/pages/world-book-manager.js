/**
 * 独立世界书库管理：列表 / 新建 / 重命名 / 删除 / 编辑条目
 */
import { navigate } from '../app.js';
import {
  listWorldBooks,
  getWorldBook,
  saveWorldBook,
  deleteWorldBook,
  createUUID
} from '../services/storage.js';
import {
  normalizeEntry,
  createEmptyWorldBookEntry,
  createEmptyWorldBookFile
} from '../services/world-book.js';
import { openBigTextEditor } from '../utils/big-editor.js';
import { promptText } from '../utils/prompt-dialog.js';

export async function renderWorldBookManager(container, options = {}) {
  container.innerHTML = '';
  const openBookId = options.bookId || null;

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <h1 class="page-title">世界书库</h1>
    <div class="page-actions">
      <button class="btn btn-ghost" id="btn-wb-back">返回</button>
      <button class="btn btn-primary" id="btn-wb-new">＋ 新建世界书</button>
    </div>
  `;
  container.appendChild(header);

  const body = document.createElement('div');
  body.className = 'wb-manager-body';
  body.innerHTML = `
    <div class="form-hint" style="margin-bottom: 14px;">
      独立世界书可被多个角色绑定。角色编辑页还可写「本卡专属条目」。生成时合并激活（每轮最多 10 条，支持递归）。
    </div>
    <div id="wb-book-list" class="wb-book-list"></div>
    <div id="wb-editor-host"></div>
  `;
  container.appendChild(body);

  document.getElementById('btn-wb-back').addEventListener('click', () => navigate('home'));
  document.getElementById('btn-wb-new').addEventListener('click', async () => {
    const name = await promptText({
      title: '新建世界书',
      message: '世界书名称：',
      defaultValue: '未命名世界书'
    });
    if (name === null) return;
    const id = await createUUID();
    const book = createEmptyWorldBookFile(id, (name || '').trim() || '未命名世界书');
    await saveWorldBook(book);
    await refreshList();
    await openBookEditor(id);
  });

  async function refreshList() {
    const listEl = document.getElementById('wb-book-list');
    const books = await listWorldBooks();
    if (!books.length) {
      listEl.innerHTML = '<div class="worldbook-empty">还没有世界书。点「新建世界书」创建一本，再在角色编辑里绑定。</div>';
      return;
    }
    listEl.innerHTML = books.map((b) => {
      const n = (b.entries && b.entries.length) || 0;
      return `
        <div class="wb-book-card" data-id="${escapeHtml(b.id)}">
          <div class="wb-book-card-main">
            <div class="wb-book-card-title">${escapeHtml(b.name || '未命名')}</div>
            <div class="wb-book-card-meta">${n} 条条目</div>
          </div>
          <div class="wb-book-card-actions">
            <button type="button" class="btn btn-ghost btn-small btn-wb-open" data-id="${escapeHtml(b.id)}">编辑</button>
            <button type="button" class="btn btn-ghost btn-small btn-wb-rename" data-id="${escapeHtml(b.id)}">重命名</button>
            <button type="button" class="btn btn-danger btn-small btn-wb-del" data-id="${escapeHtml(b.id)}">删除</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.btn-wb-open').forEach((btn) => {
      btn.addEventListener('click', () => openBookEditor(btn.dataset.id));
    });
    listEl.querySelectorAll('.btn-wb-rename').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const book = await getWorldBook(btn.dataset.id);
        if (!book) return;
        const name = await promptText({
          title: '重命名世界书',
          message: '新名称：',
          defaultValue: book.name || ''
        });
        if (name === null) return;
        book.name = name.trim() || book.name;
        await saveWorldBook(book);
        await refreshList();
      });
    });
    listEl.querySelectorAll('.btn-wb-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('确定删除该世界书？已绑定的角色将无法再加载其条目。')) return;
        await deleteWorldBook(btn.dataset.id);
        document.getElementById('wb-editor-host').innerHTML = '';
        await refreshList();
      });
    });
  }

  async function openBookEditor(bookId) {
    const host = document.getElementById('wb-editor-host');
    const book = await getWorldBook(bookId);
    if (!book) {
      alert('世界书不存在');
      return;
    }
    let entries = Array.isArray(book.entries)
      ? book.entries.map(normalizeEntry).filter(Boolean)
      : [];

    host.innerHTML = `
      <div class="wb-editor-panel">
        <div class="wb-editor-header">
          <h2 class="wb-editor-title">编辑：${escapeHtml(book.name || '')}</h2>
          <button type="button" class="btn btn-ghost btn-small" id="btn-wb-editor-close">收起</button>
        </div>
        <div class="worldbook-list" id="wb-entry-list"></div>
        <div class="form-row" style="margin-top: 10px; gap: 8px;">
          <button type="button" class="btn btn-ghost" id="btn-wb-entry-add">＋ 添加条目</button>
          <button type="button" class="btn btn-primary" id="btn-wb-book-save">保存本世界书</button>
        </div>
      </div>
    `;

    function renderEntries() {
      const list = document.getElementById('wb-entry-list');
      if (!entries.length) {
        list.innerHTML = '<div class="worldbook-empty">暂无条目</div>';
        return;
      }
      const sorted = entries.slice().sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'zh'));
      list.innerHTML = sorted.map((e) => {
        const keysPreview = e.constant ? '常驻' : ((e.keys && e.keys.length) ? e.keys.join(' / ') : '（无关键词）');
        const off = e.enabled === false ? ' worldbook-item-off' : '';
        return `
          <div class="worldbook-item${off}">
            <div class="worldbook-item-main">
              <div class="worldbook-item-title">${escapeHtml(e.name || '未命名条目')}</div>
              <div class="worldbook-item-meta">
                <span class="worldbook-badge">${e.constant ? '常驻' : '关键词'}</span>
                <span class="worldbook-keys">${escapeHtml(keysPreview)}</span>
                <span class="worldbook-order">order ${e.order ?? 100}</span>
              </div>
            </div>
            <div class="worldbook-item-actions">
              <button type="button" class="btn btn-ghost btn-small btn-e-edit" data-id="${escapeHtml(e.id)}">编辑</button>
              <button type="button" class="btn btn-danger btn-small btn-e-del" data-id="${escapeHtml(e.id)}">删除</button>
            </div>
          </div>`;
      }).join('');

      list.querySelectorAll('.btn-e-edit').forEach((btn) => {
        btn.addEventListener('click', () => openEntryModal(btn.dataset.id));
      });
      list.querySelectorAll('.btn-e-del').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!confirm('删除该条目？')) return;
          entries = entries.filter((x) => x.id !== btn.dataset.id);
          renderEntries();
        });
      });
    }

    async function openEntryModal(entryId) {
      let entry = entries.find((x) => x.id === entryId);
      const isNew = !entry;
      if (isNew) entry = createEmptyWorldBookEntry(await createUUID());
      const draft = { ...entry, keys: Array.isArray(entry.keys) ? entry.keys.slice() : [] };

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = entryModalHtml(draft, isNew);
      document.body.appendChild(overlay);
      wireEntryModal(overlay, draft, isNew, (saved) => {
        const idx = entries.findIndex((x) => x.id === saved.id);
        if (idx >= 0) entries[idx] = saved;
        else entries.push(saved);
        renderEntries();
      });
    }

    document.getElementById('btn-wb-editor-close').addEventListener('click', () => {
      host.innerHTML = '';
    });
    document.getElementById('btn-wb-entry-add').addEventListener('click', () => openEntryModal(null));
    document.getElementById('btn-wb-book-save').addEventListener('click', async () => {
      book.entries = entries;
      await saveWorldBook(book);
      alert('世界书已保存');
      await refreshList();
    });

    renderEntries();
  }

  await refreshList();
  if (openBookId) await openBookEditor(openBookId);
}

function entryModalHtml(draft, isNew) {
  return `
    <div class="modal" style="width: 640px; max-width: 96vw;">
      <div class="modal-header">
        <h2>${isNew ? '新建条目' : '编辑条目'}</h2>
        <button class="btn btn-ghost btn-icon" id="wb-entry-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">条目标题（备注，不进 AI）</label>
          <input class="form-input" id="wb-entry-name" type="text" value="${escapeHtml(draft.name)}" placeholder="例如：三里屯">
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
            <input type="checkbox" id="wb-entry-enabled" ${draft.enabled !== false ? 'checked' : ''}>
            <span>启用</span>
          </label>
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
            <input type="checkbox" id="wb-entry-constant" ${draft.constant ? 'checked' : ''}>
            <span>常驻（每轮注入，不依赖关键词）</span>
          </label>
        </div>
        <div class="form-group" id="wb-keys-group">
          <label class="form-label">关键词（逗号/换行分隔，OR 命中）</label>
          <textarea class="form-textarea" id="wb-entry-keys" rows="2" placeholder="三里屯, 太古里">${escapeHtml((draft.keys || []).join(', '))}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">插入顺序 order（越大越靠后，影响通常更大）</label>
          <input class="form-input" id="wb-entry-order" type="number" value="${draft.order ?? 100}">
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
            <input type="checkbox" id="wb-entry-prevent-rec" ${draft.preventRecursion ? 'checked' : ''}>
            <span>阻止进一步递归（本条不勾出其它条目）</span>
          </label>
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
            <input type="checkbox" id="wb-entry-exclude-rec" ${draft.excludeRecursion ? 'checked' : ''}>
            <span>不可被递归激活（只能被聊天关键词/常驻触发）</span>
          </label>
        </div>
        <div class="form-group">
          <div class="form-label-with-action">
            <label class="form-label">注入内容</label>
            <button type="button" class="btn btn-ghost btn-small" id="wb-entry-expand">⛶ 展开</button>
          </div>
          <textarea class="form-textarea" id="wb-entry-content" rows="8" placeholder="命中后写入 system 的设定…">${escapeHtml(draft.content || '')}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="wb-entry-cancel">取消</button>
        <button class="btn btn-primary" id="wb-entry-save">保存条目</button>
      </div>
    </div>`;
}

function wireEntryModal(overlay, draft, isNew, onSave) {
  const keysGroup = overlay.querySelector('#wb-keys-group');
  const constantEl = overlay.querySelector('#wb-entry-constant');
  const sync = () => {
    keysGroup.style.opacity = constantEl.checked ? '0.45' : '';
  };
  constantEl.addEventListener('change', sync);
  sync();

  overlay.querySelector('#wb-entry-expand').addEventListener('click', () => {
    const ta = overlay.querySelector('#wb-entry-content');
    openBigTextEditor({
      title: '世界书条目内容',
      value: ta.value,
      onSave: (v) => {
        ta.value = v;
      }
    });
  });

  function close() {
    overlay.remove();
  }
  overlay.querySelector('#wb-entry-close').addEventListener('click', close);
  overlay.querySelector('#wb-entry-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector('#wb-entry-save').addEventListener('click', () => {
    const name = overlay.querySelector('#wb-entry-name').value.trim();
    const content = overlay.querySelector('#wb-entry-content').value;
    const constant = overlay.querySelector('#wb-entry-constant').checked;
    const enabled = overlay.querySelector('#wb-entry-enabled').checked;
    const orderRaw = parseInt(overlay.querySelector('#wb-entry-order').value, 10);
    const keys = overlay.querySelector('#wb-entry-keys').value
      .split(/[,，;；\n]/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (!content.trim()) {
      alert('请填写注入内容');
      return;
    }
    if (!constant && keys.length === 0) {
      alert('非常驻条目请至少填写一个关键词');
      return;
    }
    onSave({
      id: draft.id,
      name: name || '未命名条目',
      enabled,
      constant,
      keys,
      content,
      order: Number.isFinite(orderRaw) ? orderRaw : 100,
      preventRecursion: overlay.querySelector('#wb-entry-prevent-rec').checked,
      excludeRecursion: overlay.querySelector('#wb-entry-exclude-rec').checked
    });
    close();
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}
