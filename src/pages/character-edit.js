import { navigate, refreshCharacters } from '../app.js';
import { getCharacter, saveCharacter, saveAvatar, getAvatarDataUrl, createUUID, getPlatform, listWorldBooks, getConfig } from '../services/storage.js';
import { ensurePromptLibrary } from '../services/prompt-library.js';
import { attachCharCounter } from '../utils/counter.js';
import { openBigTextEditor } from '../utils/big-editor.js';
import { normalizeWorldBookSettings, createEmptyWorldBookEntry } from '../services/world-book.js';
import { normalizeSubCharacters, getCharacterModules } from '../services/card-modules.js';

export async function renderCharacterEdit(container, characterId) {
  container.innerHTML = '';

  const isNew = !characterId;
  const character = isNew ? {
    id: await createUUID(),
    name: '',
    avatar: '',
    background: '',
    characterModules: [],
    greeting: '',
    thinkingFormat: '',
    outputFormat: '',
    group: '',
    mainControl: {
      name: '',
      description: ''
    },
    memoryEnabled: true,
    enableRandomNarrative: true,
    rawWindowTurns: 3,
    worldBook: {
      enabled: false,
      scanDepth: 4,
      caseSensitive: false,
      maxRecursion: 3,
      ignoreStatusBar: true,
      boundBookIds: [],
      entries: []
    },
    creator: '',
    tags: [],
    createdAt: null,
    updatedAt: null
  } : await getCharacter(characterId);

  // 兼容旧数据：确保 mainControl 存在
  if (!character.mainControl) {
    character.mainControl = { name: '', description: '' };
  }
  // 记忆系统开关 / 携带轮数（角色卡级），旧卡缺字段补默认
  if (character.memoryEnabled === undefined) character.memoryEnabled = true;
  if (!Number.isFinite(Number(character.rawWindowTurns))) character.rawWindowTurns = 3;
  // 叙事规则（随机 NPC / 随机事件）开关，旧卡缺字段默认开
  if (character.enableRandomNarrative === undefined) character.enableRandomNarrative = true;
  // 世界书：角色设置 + 专属条目 + 绑定独立库
  let worldBookEdit = normalizeWorldBookSettings(character.worldBook);
  const allWorldBooks = await listWorldBooks().catch(() => []);

  // 模板下拉配置与选项文本（DOM 填充在表单挂载之后进行）
  const promptConfig = await getConfig();
  ensurePromptLibrary(promptConfig);
  // 两个下拉按类型分开：思维链只出 thinking 模板，输出格式只出 outputFormat 模板
  const optionsFor = (kind) => ['<option value="">无（不注入）</option>']
    .concat(promptConfig.promptLibrary
      .filter((it) => (it.kind || 'outputFormat') === kind)
      .map((it) => `<option value="${escapeHtml(it.id)}">${escapeHtml(it.name)}</option>`))
    .join('');

  let avatarDataUrl = character.avatar ? await getAvatarDataUrl(character.avatar) : null;
  let pendingAvatarBase64 = null;
  let pendingAvatarMime = null;

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <h1 class="page-title">${isNew ? '新建角色' : '编辑角色'}</h1>
    <div class="page-actions">
      <button class="btn btn-ghost" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    </div>
  `;
  container.appendChild(header);

  const layout = document.createElement('div');
  layout.className = 'edit-layout';

  // 左侧头像上传
  const avatarSection = document.createElement('div');
  avatarSection.innerHTML = `
    <div class="avatar-upload" id="avatar-upload">
      <img class="avatar-preview" id="avatar-preview" src="${avatarDataUrl || defaultAvatarUrl()}" alt="头像预览">
      <div class="upload-hint">点击上传头像</div>
    </div>
    <input type="file" id="avatar-input" accept="image/*" style="display: none;">
  `;
  layout.appendChild(avatarSection);

  // 右侧表单
  const form = document.createElement('div');
  form.className = 'edit-form';
  form.innerHTML = `
    <div class="form-group">
      <label class="form-label">角色名称 *</label>
      <input class="form-input" id="input-name" type="text" placeholder="例如：艾莉娅" value="${escapeHtml(character.name)}">
    </div>

    <div class="form-group">
      <label class="form-label">分组</label>
      <input class="form-input" id="input-group" type="text" placeholder="例如：都市篇、奇幻世界（留空则放入未分组）" value="${escapeHtml(character.group || '')}">
    </div>

    <div class="form-group">
      <div class="form-label-with-action">
        <label class="form-label">开场白</label>
        <button class="btn btn-ghost btn-small" id="btn-edit-greeting">⛶ 展开编辑</button>
      </div>
      <textarea class="form-textarea" id="input-greeting" placeholder="角色对玩家说的第一句话（支持多行，长度不限）">${escapeHtml(character.greeting)}</textarea>
      <div class="form-hint">作为对话的第一条角色消息发送，可写多行，不限字数。</div>
    </div>

    <div class="form-group">
      <label class="form-label">背景设定（卡内模块）</label>
      <textarea class="form-textarea" id="input-background" placeholder="世界观、社会规则、故事舞台等背景信息；不写具体角色人设。">${escapeHtml(character.background || '')}</textarea>
      <div class="form-hint">选填。注入时位于所有角色模块之前；世界观集中写这里，避免和角色设定重复。</div>
    </div>

    <div class="form-section">
      <div class="form-section-title">角色模块 *</div>
      <div class="form-hint" style="margin-bottom: 8px;">每个角色一块设定，姓名直接写在设定文本里；<b>主角放第一块</b>，剧情里出现的重要新角色随时添加，下一轮请求即带上完整人格。全部模块每轮常驻注入（顺序：背景设定 → 各角色模块）。主角写法见《角色卡模板.txt》，配角精简写法见《配角卡模板.txt》。老卡的角色描述已自动并入第一块。</div>
      <div id="role-module-list"></div>
      <button class="btn btn-ghost btn-small" id="btn-role-module-add" type="button">＋ 添加角色</button>
    </div>

    <div class="form-group">
      <label class="form-label">场外动态角色（可选）</label>
      <input class="form-input" id="input-offscreen-roles" type="text" placeholder="人名用空格/逗号/顿号分隔，如：林静 苏晴" value="${escapeHtml((character.offscreenRoles || []).join('、'))}">
      <div class="form-hint">只有名单内的角色会生成场外个人线（不在场也自行行动、发生事件，随记忆回流）；留空 = 由 AI 自行判断重要NPC。名单外的角色不编场外戏，只出现在当下场景。</div>
    </div>

    <div class="form-group">
      <div class="form-label-with-action">
        <label class="form-label">思考格式（Markdown）</label>
        <button class="btn btn-ghost btn-small" id="btn-edit-thinking-format">⛶ 展开编辑</button>
      </div>
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px;">
        <span style="font-size: 0.85rem; color: #888; flex-shrink: 0;">模板：</span>
        <select class="form-input" id="input-thinking-preset" style="flex: 1;"></select>
      </div>
      <textarea class="form-textarea" id="input-thinking-format" placeholder="填写思维链要求，例如：先在 <思考></思考> 标签内分析当前局势、角色心理与走向，再开始正文。">${escapeHtml(character.thinkingFormat || '')}</textarea>
      <div class="form-hint">选填。仅当「设置 → 思考链输出」开关打开时，才会拼进 system prompt（放在输出格式之前）。给不需要思维链的模型可在设置里关闭。文本框留空 = 使用上方选中的模板；填写文本则完全覆盖模板。</div>
    </div>

    <div class="form-group">
      <div class="form-label-with-action">
        <label class="form-label">输出格式（Markdown）</label>
        <button class="btn btn-ghost btn-small" id="btn-edit-output-format">⛶ 展开编辑</button>
      </div>
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px;">
        <span style="font-size: 0.85rem; color: #888; flex-shrink: 0;">模板：</span>
        <select class="form-input" id="input-output-preset" style="flex: 1;"></select>
      </div>
      <textarea class="form-textarea" id="input-output-format" placeholder="在这里填写你期望的 AI 回复格式，例如状态栏、行动选项、正文结构等要求。支持 Markdown。">${escapeHtml(character.outputFormat)}</textarea>
      <div class="form-hint">选填。填写后，系统会自动把它追加到角色设定后面，作为 AI 回复格式的强制约束。文本框留空 = 使用上方选中的模板；填写文本则完全覆盖模板。</div>
    </div>

    <div class="form-section">
      <div class="form-section-title">主控设置</div>
      <div class="form-group">
        <label class="form-label">主控名称</label>
        <input class="form-input" id="input-main-control-name" type="text" placeholder="你的名字/身份" value="${escapeHtml(character.mainControl.name)}">
      </div>
      <div class="form-group">
        <div class="form-label-with-action">
          <label class="form-label">主控描述 / 设定</label>
          <button class="btn btn-ghost btn-small" id="btn-edit-main-control">⛶ 展开编辑</button>
        </div>
        <textarea class="form-textarea" id="input-main-control-description" placeholder="描述主控的性格、背景、外貌、与角色的关系等。这部分会作为 system prompt 的一部分。">${escapeHtml(character.mainControl.description)}</textarea>
        <div class="form-hint">例如：你叫李明，25岁，是一名普通大学生……</div>
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">剧情线（可选）</div>
      <div class="form-hint" style="margin-bottom: 8px;">本卡的默认主剧情线——开新对话时自动复制进对话（指针从第 1 阶段开始）；玩的时候在记忆编辑器「剧情线」页签改的是副本，不动这里。留空 = 纯自由局。写法和示范见仓库《剧情卡模板.txt》。</div>
      <div class="form-group" style="display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 8px;">
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="radio" name="card-plot-mode" value="soft"> 引力（选择优先）</label>
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><input type="radio" name="card-plot-mode" value="hard"> 铁轨（剧情优先）</label>
      </div>
      <div id="card-plot-stages"></div>
      <button class="btn btn-ghost btn-small" id="btn-card-plot-add" type="button">＋ 添加阶段</button>
    </div>

    <div class="form-section">
      <div class="form-section-title">叙事规则</div>
      <div class="form-group">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
          <input type="checkbox" id="input-enable-random-narrative" style="width: 16px; height: 16px; cursor: pointer;" ${character.enableRandomNarrative !== false ? 'checked' : ''}>
          <span>启用随机 NPC 与随机事件</span>
        </label>
        <div class="form-hint">开启后，AI 会按内置的「随机 NPC 生成规则」与「事件系统」，在对话中自然引入临时人物与叙事事件（涟漪/暗涌/地震）。关闭则不注入相关规则，可节省 token。</div>
      </div>
    </div>

    <div class="form-section" id="world-book-section">
      <div class="form-section-title">世界书（类 SillyTavern）</div>
      <div class="form-hint" style="margin-bottom: 10px;">
        常驻 / 关键词命中后注入 system（设定后）。可绑定侧边栏「世界书库」中的独立书，也可写本卡专属条目。每轮最多 10 条；支持递归。不写历史、不进记忆。
        <button type="button" class="btn btn-ghost btn-small" id="btn-goto-worldbook-lib" style="margin-left: 6px;">管理世界书库 →</button>
      </div>
      <div class="form-group">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
          <input type="checkbox" id="input-worldbook-enabled" style="width: 16px; height: 16px; cursor: pointer;" ${worldBookEdit.enabled ? 'checked' : ''}>
          <span>启用世界书</span>
        </label>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">扫描深度（最近消息条数）</label>
          <input class="form-input" id="input-worldbook-scan-depth" type="number" min="0" max="50" value="${worldBookEdit.scanDepth}">
          <div class="form-hint">再加本轮用户输入。0 = 只扫本轮输入。</div>
        </div>
        <div class="form-group">
          <label class="form-label">最大递归步数（0=关）</label>
          <input class="form-input" id="input-worldbook-recursion" type="number" min="0" max="5" value="${worldBookEdit.maxRecursion}">
          <div class="form-hint">条目 content 可再触发其它关键词条目。</div>
        </div>
      </div>
      <div class="form-group">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
          <input type="checkbox" id="input-worldbook-case" style="width: 16px; height: 16px; cursor: pointer;" ${worldBookEdit.caseSensitive ? 'checked' : ''}>
          <span>关键词区分大小写</span>
        </label>
      </div>
      <div class="form-group">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
          <input type="checkbox" id="input-worldbook-ignore-status" style="width: 16px; height: 16px; cursor: pointer;" ${worldBookEdit.ignoreStatusBar ? 'checked' : ''}>
          <span>扫描时忽略状态栏</span>
        </label>
        <div class="form-hint">剥离 AI 回复里的代码块与标题行再匹配关键词：人名只靠正文提及触发，避免状态栏（人际关系等）每轮重输出把条目钉成常驻。关掉则退回旧行为（扫回复全文）。</div>
      </div>
      <div class="form-group">
        <label class="form-label">绑定独立世界书</label>
        <div id="worldbook-bind-list" class="wb-bind-list"></div>
        <div class="form-hint">${allWorldBooks.length ? '勾选后本角色聊天会合并这些库的条目。' : '库为空。请先到侧边栏「世界书库」创建。'}</div>
      </div>
      <div class="form-label" style="margin-top: 8px;">本卡专属条目</div>
      <div class="worldbook-list" id="worldbook-list"></div>
      <div class="form-row" style="margin-top: 8px; gap: 8px;">
        <button type="button" class="btn btn-ghost" id="btn-worldbook-add">＋ 添加本卡条目</button>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">标签</label>
        <input class="form-input" id="input-tags" type="text" placeholder="用逗号分隔" value="${escapeHtml((character.tags || []).join(', '))}">
      </div>
      <div class="form-group">
        <label class="form-label">创作者</label>
        <input class="form-input" id="input-creator" type="text" placeholder="你的名字" value="${escapeHtml(character.creator || '')}">
      </div>
    </div>
  `;
  layout.appendChild(form);
  container.appendChild(layout);

  // 模板下拉：填充选项与预选（必须在表单挂载后执行，否则 select 不存在）
  document.getElementById('input-thinking-preset').innerHTML = optionsFor('thinking');
  document.getElementById('input-output-preset').innerHTML = optionsFor('outputFormat');
  // 预选：新版 presetId 优先（含显式"无"）；老卡留空且未禁用全局时预选旧全局默认，保存后即固化到卡上
  const legacyThinking = (!character.noGlobalPrompts && !(character.thinkingFormat || '').trim())
    ? (promptConfig.promptDefaults.thinkingFormatId || '') : '';
  const legacyOutput = (!character.noGlobalPrompts && !(character.outputFormat || '').trim())
    ? (promptConfig.promptDefaults.outputFormatId || '') : '';
  document.getElementById('input-thinking-preset').value =
    character.thinkingPresetId !== undefined ? character.thinkingPresetId : legacyThinking;
  document.getElementById('input-output-preset').value =
    character.outputFormatPresetId !== undefined ? character.outputFormatPresetId : legacyOutput;

  // ---------- 世界书：绑定库 + 本卡条目 ----------
  document.getElementById('btn-goto-worldbook-lib').addEventListener('click', () => {
    navigate('worldbooks');
  });

  const bindListEl = document.getElementById('worldbook-bind-list');
  const boundSet = new Set(worldBookEdit.boundBookIds || []);
  if (!allWorldBooks.length) {
    bindListEl.innerHTML = '<div class="worldbook-empty" style="padding:10px;">暂无独立世界书</div>';
  } else {
    bindListEl.innerHTML = allWorldBooks.map((b) => `
      <label class="wb-bind-item">
        <input type="checkbox" class="wb-bind-cb" data-id="${escapeHtml(b.id)}" ${boundSet.has(b.id) ? 'checked' : ''}>
        <span>${escapeHtml(b.name || b.id)} <span class="wb-bind-count">(${(b.entries && b.entries.length) || 0} 条)</span></span>
      </label>
    `).join('');
  }

  const worldbookListEl = document.getElementById('worldbook-list');

  function renderWorldBookList() {
    const entries = worldBookEdit.entries || [];
    if (entries.length === 0) {
      worldbookListEl.innerHTML = '<div class="worldbook-empty">暂无本卡专属条目。公共设定请建独立库并绑定。</div>';
      return;
    }
    worldbookListEl.innerHTML = entries
      .slice()
      .sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'zh'))
      .map((e) => {
        const keysPreview = e.constant
          ? '常驻'
          : (e.keys && e.keys.length ? e.keys.join(' / ') : '（无关键词）');
        const off = e.enabled === false ? ' worldbook-item-off' : '';
        return `
        <div class="worldbook-item${off}" data-id="${escapeHtml(e.id)}">
          <div class="worldbook-item-main">
            <div class="worldbook-item-title">${escapeHtml(e.name || '未命名条目')}</div>
            <div class="worldbook-item-meta">
              <span class="worldbook-badge">${e.constant ? '常驻' : '关键词'}</span>
              <span class="worldbook-keys">${escapeHtml(keysPreview)}</span>
              <span class="worldbook-order">order ${e.order ?? 100}</span>
            </div>
          </div>
          <div class="worldbook-item-actions">
            <button type="button" class="btn btn-ghost btn-small btn-wb-edit" data-id="${escapeHtml(e.id)}">编辑</button>
            <button type="button" class="btn btn-danger btn-small btn-wb-del" data-id="${escapeHtml(e.id)}">删除</button>
          </div>
        </div>`;
      })
      .join('');

    worldbookListEl.querySelectorAll('.btn-wb-edit').forEach((btn) => {
      btn.addEventListener('click', () => openWorldBookEntryEditor(btn.dataset.id));
    });
    worldbookListEl.querySelectorAll('.btn-wb-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!confirm('确定删除该世界书条目？')) return;
        worldBookEdit.entries = worldBookEdit.entries.filter((x) => x.id !== btn.dataset.id);
        renderWorldBookList();
      });
    });
  }

  async function openWorldBookEntryEditor(entryId) {
    let entry = worldBookEdit.entries.find((x) => x.id === entryId);
    const isNewEntry = !entry;
    if (isNewEntry) {
      entry = createEmptyWorldBookEntry(await createUUID());
    }
    const draft = {
      ...entry,
      keys: Array.isArray(entry.keys) ? entry.keys.slice() : []
    };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="width: 640px; max-width: 96vw;">
        <div class="modal-header">
          <h2>${isNewEntry ? '新建本卡世界书条目' : '编辑本卡世界书条目'}</h2>
          <button class="btn btn-ghost btn-icon" id="wb-entry-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">条目标题（备注，不进 AI）</label>
            <input class="form-input" id="wb-entry-name" type="text" value="${escapeHtml(draft.name)}" placeholder="例如：三里屯 / 公司背景">
          </div>
          <div class="form-group">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
              <input type="checkbox" id="wb-entry-enabled" ${draft.enabled !== false ? 'checked' : ''}>
              <span>启用此条目</span>
            </label>
          </div>
          <div class="form-group">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: normal;">
              <input type="checkbox" id="wb-entry-constant" ${draft.constant ? 'checked' : ''}>
              <span>常驻（每轮都注入）</span>
            </label>
          </div>
          <div class="form-group" id="wb-keys-group">
            <label class="form-label">关键词（逗号 / 换行分隔，OR）</label>
            <textarea class="form-textarea" id="wb-entry-keys" rows="2" placeholder="三里屯, 太古里">${escapeHtml((draft.keys || []).join(', '))}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">order（越大越靠后，影响通常更大）</label>
            <input class="form-input" id="wb-entry-order" type="number" value="${draft.order ?? 100}">
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
              <input type="checkbox" id="wb-entry-prevent-rec" ${draft.preventRecursion ? 'checked' : ''}>
              <span>阻止进一步递归</span>
            </label>
          </div>
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
              <input type="checkbox" id="wb-entry-exclude-rec" ${draft.excludeRecursion ? 'checked' : ''}>
              <span>不可被递归激活</span>
            </label>
          </div>
          <div class="form-group">
            <div class="form-label-with-action">
              <label class="form-label">注入内容</label>
              <button type="button" class="btn btn-ghost btn-small" id="wb-entry-expand">⛶ 展开编辑</button>
            </div>
            <textarea class="form-textarea" id="wb-entry-content" rows="8" placeholder="命中或常驻时写入 system…">${escapeHtml(draft.content || '')}</textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="wb-entry-cancel">取消</button>
          <button class="btn btn-primary" id="wb-entry-save">保存条目</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const keysGroup = document.getElementById('wb-keys-group');
    const constantEl = document.getElementById('wb-entry-constant');
    const syncKeysVis = () => {
      keysGroup.style.opacity = constantEl.checked ? '0.45' : '';
    };
    constantEl.addEventListener('change', syncKeysVis);
    syncKeysVis();

    document.getElementById('wb-entry-expand').addEventListener('click', () => {
      const ta = document.getElementById('wb-entry-content');
      openBigTextEditor({
        title: '世界书条目内容',
        value: ta.value,
        placeholder: ta.placeholder,
        onSave: (v) => {
          ta.value = v;
          ta.dispatchEvent(new Event('input'));
        }
      });
    });

    function close() {
      overlay.remove();
    }
    document.getElementById('wb-entry-close').addEventListener('click', close);
    document.getElementById('wb-entry-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });

    document.getElementById('wb-entry-save').addEventListener('click', () => {
      const name = document.getElementById('wb-entry-name').value.trim();
      const content = document.getElementById('wb-entry-content').value;
      const constant = document.getElementById('wb-entry-constant').checked;
      const enabled = document.getElementById('wb-entry-enabled').checked;
      const orderRaw = parseInt(document.getElementById('wb-entry-order').value, 10);
      const keys = document.getElementById('wb-entry-keys').value
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

      const saved = {
        id: draft.id,
        name: name || '未命名条目',
        enabled,
        constant,
        keys,
        content,
        order: Number.isFinite(orderRaw) ? orderRaw : 100,
        preventRecursion: document.getElementById('wb-entry-prevent-rec').checked,
        excludeRecursion: document.getElementById('wb-entry-exclude-rec').checked
      };

      const idx = worldBookEdit.entries.findIndex((x) => x.id === saved.id);
      if (idx >= 0) worldBookEdit.entries[idx] = saved;
      else worldBookEdit.entries.push(saved);
      renderWorldBookList();
      close();
    });
  }

  document.getElementById('btn-worldbook-add').addEventListener('click', () => openWorldBookEntryEditor(null));
  renderWorldBookList();

  // 为所有可编辑输入框添加 token 统计
  const editableSelectors = [
    '#input-name', '#input-group', '#input-greeting', '#input-output-format',
    '#input-main-control-name', '#input-main-control-description', '#input-tags', '#input-creator'
  ];
  for (const selector of editableSelectors) {
    const el = document.querySelector(selector);
    if (el) attachCharCounter(el);
  }

  // 大文本编辑按钮事件
  document.getElementById('btn-edit-thinking-format').addEventListener('click', () => {
    const textarea = document.getElementById('input-thinking-format');
    openBigTextEditor({
      title: '思考格式（Markdown）',
      value: textarea.value,
      placeholder: textarea.placeholder,
      onSave: (newValue) => {
        textarea.value = newValue;
        textarea.dispatchEvent(new Event('input'));
      }
    });
  });

  document.getElementById('btn-edit-output-format').addEventListener('click', () => {
    const textarea = document.getElementById('input-output-format');
    openBigTextEditor({
      title: '输出格式（Markdown）',
      value: textarea.value,
      placeholder: textarea.placeholder,
      onSave: (newValue) => {
        textarea.value = newValue;
        textarea.dispatchEvent(new Event('input'));
      }
    });
  });

  document.getElementById('btn-edit-greeting').addEventListener('click', () => {
    const textarea = document.getElementById('input-greeting');
    openBigTextEditor({
      title: '开场白',
      value: textarea.value,
      placeholder: textarea.placeholder,
      onSave: (newValue) => {
        textarea.value = newValue;
        textarea.dispatchEvent(new Event('input'));
      }
    });
  });

  document.getElementById('btn-edit-main-control').addEventListener('click', () => {
    const textarea = document.getElementById('input-main-control-description');
    openBigTextEditor({
      title: '主控描述 / 设定',
      value: textarea.value,
      placeholder: textarea.placeholder,
      onSave: (newValue) => {
        textarea.value = newValue;
        textarea.dispatchEvent(new Event('input'));
      }
    });
  });

  // 头像上传事件
  const avatarUpload = document.getElementById('avatar-upload');
  const avatarPreview = document.getElementById('avatar-preview');
  const avatarInput = document.getElementById('avatar-input');

  avatarInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target.result;
      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        pendingAvatarMime = match[1];
        pendingAvatarBase64 = match[2];
        avatarPreview.src = dataUrl;
      }
    };
    reader.readAsDataURL(file);
  });

  avatarUpload.addEventListener('click', async () => {
    const platform = await getPlatform();
    if (platform === 'electron') {
      const result = await window.electronAPI.dialog.selectImage();
      if (!result) return;
      pendingAvatarBase64 = result.base64;
      pendingAvatarMime = result.mime;
      avatarPreview.src = `data:${result.mime};base64,${result.base64}`;
    } else {
      avatarInput.click();
    }
  });

  // ---------- 卡级剧情线编辑（模板；开新局复制进对话副本，指针从 1 开始） ----------
  const cardPlotEdit = (() => {
    const p = character.plot;
    if (p && typeof p === 'object') {
      return {
        mode: p.mode === 'hard' ? 'hard' : 'soft',
        stages: (Array.isArray(p.stages) ? p.stages : []).map((s) => ({
          title: String((s && s.title) || ''),
          content: String((s && s.content) || ''),
          condition: String((s && s.condition) || ''),
          branches: String((s && s.branches) || '')
        }))
      };
    }
    return { mode: 'soft', stages: [] };
  })();

  const cardPlotStagesEl = document.getElementById('card-plot-stages');
  function renderCardPlotStages() {
    cardPlotStagesEl.innerHTML = cardPlotEdit.stages.map((s, i) => `
      <div class="memory-card" style="margin-bottom: 8px;">
        <div class="memory-card-header">
          <span style="flex: 1; font-size: 0.9rem; font-weight: 600;">第 ${i + 1} 阶段</span>
          <button class="btn btn-ghost btn-small card-plot-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-ghost btn-small card-plot-down" data-idx="${i}" ${i === cardPlotEdit.stages.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-danger btn-small card-plot-del" data-idx="${i}">删除</button>
        </div>
        <input type="text" class="form-input card-plot-title" data-idx="${i}" value="${escapeHtml(s.title)}" placeholder="阶段标题（如：破冰期）" style="margin-bottom: 6px;">
        <textarea class="form-textarea card-plot-content" data-idx="${i}" rows="2" placeholder="方向/氛围/关键事件——写方向和节点，不写台词和结果">${escapeHtml(s.content)}</textarea>
        <input type="text" class="form-input card-plot-condition" data-idx="${i}" value="${escapeHtml(s.condition)}" placeholder="推进条件（可空）：什么发生了算走完这阶段" style="margin-top: 6px;">
        <input type="text" class="form-input card-plot-branches" data-idx="${i}" value="${escapeHtml(s.branches)}" placeholder="支线种子（可空）：本阶段可能长出的支线" style="margin-top: 6px;">
      </div>`).join('');

    const bind = (sel, field) => {
      cardPlotStagesEl.querySelectorAll(sel).forEach((el) => {
        el.addEventListener('change', () => {
          const s = cardPlotEdit.stages[Number(el.dataset.idx)];
          if (s) s[field] = el.value;
        });
      });
    };
    bind('.card-plot-title', 'title');
    bind('.card-plot-content', 'content');
    bind('.card-plot-condition', 'condition');
    bind('.card-plot-branches', 'branches');
    cardPlotStagesEl.querySelectorAll('.card-plot-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        cardPlotEdit.stages.splice(Number(btn.dataset.idx), 1);
        renderCardPlotStages();
      });
    });
    cardPlotStagesEl.querySelectorAll('.card-plot-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.idx);
        if (i <= 0) return;
        [cardPlotEdit.stages[i - 1], cardPlotEdit.stages[i]] = [cardPlotEdit.stages[i], cardPlotEdit.stages[i - 1]];
        renderCardPlotStages();
      });
    });
    cardPlotStagesEl.querySelectorAll('.card-plot-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.idx);
        if (i >= cardPlotEdit.stages.length - 1) return;
        [cardPlotEdit.stages[i], cardPlotEdit.stages[i + 1]] = [cardPlotEdit.stages[i + 1], cardPlotEdit.stages[i]];
        renderCardPlotStages();
      });
    });
  }
  // 强度档位初始勾选
  const cardPlotModeRadio = document.querySelector(`input[name="card-plot-mode"][value="${cardPlotEdit.mode}"]`);
  if (cardPlotModeRadio) cardPlotModeRadio.checked = true;
  document.querySelectorAll('input[name="card-plot-mode"]').forEach((r) => {
    r.addEventListener('change', () => { cardPlotEdit.mode = r.value === 'hard' ? 'hard' : 'soft'; });
  });
  document.getElementById('btn-card-plot-add').addEventListener('click', () => {
    cardPlotEdit.stages.push({ title: '', content: '', condition: '', branches: '' });
    renderCardPlotStages();
  });
  renderCardPlotStages();

  // ---------- 角色模块编辑（每个角色一块设定文本，姓名写在文本里；老卡 description/subCharacters 由 getCharacterModules 惰性并入；change 时回写，空块在保存时过滤） ----------
  const roleModuleEdit = getCharacterModules(character);
  const roleModuleListEl = document.getElementById('role-module-list');
  function renderRoleModules() {
    roleModuleListEl.innerHTML = roleModuleEdit.map((text, i) => `
      <div class="memory-card" style="margin-bottom: 8px;">
        <div class="memory-card-header">
          <span style="flex: 1; font-size: 0.9rem; font-weight: 600;">角色 ${i + 1}${i === 0 ? '（主角）' : ''}</span>
          <button class="btn btn-ghost btn-small role-module-expand" data-idx="${i}" type="button">⛶ 展开编辑</button>
          <button class="btn btn-danger btn-small role-module-del" data-idx="${i}" type="button">删除</button>
        </div>
        <textarea class="form-textarea role-module-content" data-idx="${i}" rows="5" placeholder="这个角色的完整设定：一句话核心、基础信息、声音与台词样本、习惯怪癖、矛盾反差、情景反应、人际关系与好感推进规则等。">${escapeHtml(text)}</textarea>
      </div>`).join('');
    roleModuleListEl.querySelectorAll('.role-module-content').forEach((el) => {
      el.addEventListener('change', () => {
        roleModuleEdit[Number(el.dataset.idx)] = el.value;
      });
    });
    roleModuleListEl.querySelectorAll('.role-module-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        roleModuleEdit.splice(Number(btn.dataset.idx), 1);
        renderRoleModules();
      });
    });
    roleModuleListEl.querySelectorAll('.role-module-expand').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.idx);
        openBigTextEditor({
          title: `角色 ${i + 1}${i === 0 ? '（主角）' : ''} 设定`,
          value: roleModuleEdit[i],
          placeholder: '这个角色的完整设定：一句话核心、基础信息、声音与台词样本、习惯怪癖、矛盾反差、情景反应、人际关系与好感推进规则等。',
          onSave: (newValue) => {
            roleModuleEdit[i] = newValue;
            renderRoleModules();
          }
        });
      });
    });
  }
  document.getElementById('btn-role-module-add').addEventListener('click', () => {
    roleModuleEdit.push('');
    renderRoleModules();
  });
  renderRoleModules();

  // 取消
  document.getElementById('btn-cancel').addEventListener('click', () => {
    navigate('home');
  });

  // 保存
  document.getElementById('btn-save').addEventListener('click', async () => {
    try {
      const name = document.getElementById('input-name').value.trim();

      const modulesClean = normalizeSubCharacters(roleModuleEdit);

      if (!name) {
        alert('请输入角色名称');
        return;
      }
      if (!modulesClean.length) {
        alert('请至少填写一个角色模块（主角）');
        return;
      }

      character.name = name;
      character.group = document.getElementById('input-group').value.trim();
      character.greeting = document.getElementById('input-greeting').value.trim();
      character.background = document.getElementById('input-background').value.trim();
      character.characterModules = modulesClean;
      // 旧字段已并入角色模块，落盘为新结构后移除，避免两处重复
      delete character.description;
      delete character.subCharacters;
      character.offscreenRoles = document.getElementById('input-offscreen-roles').value
        .split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
      character.thinkingFormat = document.getElementById('input-thinking-format').value.trim();
      character.outputFormat = document.getElementById('input-output-format').value.trim();
      character.thinkingPresetId = document.getElementById('input-thinking-preset').value;
      character.outputFormatPresetId = document.getElementById('input-output-preset').value;
      // 新版卡级模板选择，旧"不继承全局"字段不再需要（显式"无"已能表达）
      delete character.noGlobalPrompts;
      character.mainControl = {
        name: document.getElementById('input-main-control-name').value.trim(),
        description: document.getElementById('input-main-control-description').value.trim()
      };
      character.creator = document.getElementById('input-creator').value.trim();
      character.tags = document.getElementById('input-tags').value.split(',').map(t => t.trim()).filter(Boolean);
      character.enableRandomNarrative = document.getElementById('input-enable-random-narrative').checked;

      // 剧情线（卡级模板，开新局复制进对话副本；无有效阶段则移除）
      const cardStagesClean = cardPlotEdit.stages
        .map((s) => ({
          title: String(s.title || '').trim(),
          content: String(s.content || '').trim(),
          condition: String(s.condition || '').trim(),
          branches: String(s.branches || '').trim()
        }))
        .filter((s) => s.title || s.content);
      if (cardStagesClean.length) {
        character.plot = { mode: cardPlotEdit.mode === 'hard' ? 'hard' : 'soft', stages: cardStagesClean };
      } else {
        delete character.plot;
      }

      // 世界书：设置 + 绑定库 + 本卡专属条目
      const wbDepth = parseInt(document.getElementById('input-worldbook-scan-depth').value, 10);
      const wbRec = parseInt(document.getElementById('input-worldbook-recursion').value, 10);
      const boundIds = [...document.querySelectorAll('.wb-bind-cb:checked')].map((el) => el.dataset.id).filter(Boolean);
      character.worldBook = normalizeWorldBookSettings({
        enabled: document.getElementById('input-worldbook-enabled').checked,
        scanDepth: Number.isFinite(wbDepth) ? wbDepth : 4,
        caseSensitive: document.getElementById('input-worldbook-case').checked,
        maxRecursion: Number.isFinite(wbRec) ? wbRec : 3,
        ignoreStatusBar: document.getElementById('input-worldbook-ignore-status').checked,
        boundBookIds: boundIds,
        entries: worldBookEdit.entries
      });

      // 保存头像
      if (pendingAvatarBase64) {
        const avatarName = await saveAvatar(character.id, pendingAvatarBase64, pendingAvatarMime);
        character.avatar = avatarName;
      }

      await saveCharacter(character);
      await refreshCharacters();
      navigate('home');
    } catch (error) {
      alert('保存角色失败：' + (error && error.message ? error.message : String(error)));
    }
  });
}

function defaultAvatarUrl() {
  return 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 200%22%3E%3Crect width=%22200%22 height=%22200%22 fill=%22%232a2a32%22/%3E%3Ctext x=%22100%22 y=%22115%22 font-size=%2280%22 text-anchor=%22middle%22 fill=%22%23888%22%3E👤%3C/text%3E%3C/svg%3E';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
