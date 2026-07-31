import { navigate, refreshCharacters, state, toggleGroupCollapsed } from '../app.js';
import { getAvatarDataUrl, deleteCharacter } from '../services/storage.js';

const DEFAULT_GROUP = '未分组';

function getGroupName(char) {
  return (char.group || '').trim() || DEFAULT_GROUP;
}

function groupCharacters(characters) {
  const map = new Map();
  for (const char of characters) {
    const name = getGroupName(char);
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(char);
  }
  const sorted = [...map.entries()].sort((a, b) => {
    if (a[0] === DEFAULT_GROUP) return 1;
    if (b[0] === DEFAULT_GROUP) return -1;
    return a[0].localeCompare(b[0], 'zh-CN');
  });
  return new Map(sorted);
}

export async function renderHome(container) {
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <h1 class="page-title">角色卡</h1>
    <div class="page-actions">
      <button class="btn btn-primary" id="btn-create-char"><span>＋</span> 新建角色</button>
    </div>
  `;
  container.appendChild(header);

  if (state.characters.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="icon">🍺</div>
      <h3>还没有角色卡</h3>
      <p>点击右上角“新建角色”开始创建你的第一个 AI 角色吧。</p>
    `;
    container.appendChild(empty);
  } else {
    const groups = groupCharacters(state.characters);
    for (const [groupName, chars] of groups) {
      const collapsed = state.collapsedGroups.has(groupName);

      const section = document.createElement('section');
      section.className = 'character-group';

      const groupHeader = document.createElement('div');
      groupHeader.className = 'character-group-header';
      const toggle = document.createElement('span');
      toggle.className = 'group-toggle';
      toggle.textContent = collapsed ? '▶' : '▼';
      const title = document.createElement('span');
      title.className = 'group-title';
      title.textContent = groupName;
      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = String(chars.length);
      groupHeader.appendChild(toggle);
      groupHeader.appendChild(title);
      groupHeader.appendChild(count);
      groupHeader.addEventListener('click', () => toggleGroupCollapsed(groupName));
      section.appendChild(groupHeader);

      const grid = document.createElement('div');
      grid.className = 'character-grid character-group-content' + (collapsed ? ' collapsed' : '');
      for (const char of chars) {
        const card = await createCharacterCard(char);
        grid.appendChild(card);
      }
      section.appendChild(grid);
      container.appendChild(section);
    }
  }

  document.getElementById('btn-create-char').addEventListener('click', () => {
    navigate('edit', { characterId: null });
  });
}

async function createCharacterCard(char) {
  const card = document.createElement('div');
  card.className = 'character-card';

  const avatarUrl = char.avatarDataUrl || await getAvatarDataUrl(char.avatar) || defaultAvatarUrl();

  const desc = char.description ? char.description.slice(0, 80) + (char.description.length > 80 ? '...' : '') : '暂无描述';

  card.innerHTML = `
    <img class="card-cover" src="${avatarUrl}" alt="${char.name}">
    <div class="card-body">
      <h3 class="card-title">${escapeHtml(char.name)}</h3>
      <div class="card-desc">${escapeHtml(desc)}</div>
      <div class="card-actions">
        <button class="btn btn-primary btn-chat" data-id="${char.id}">聊天</button>
        <button class="btn btn-edit" data-id="${char.id}">编辑</button>
        <button class="btn btn-danger btn-delete" data-id="${char.id}">删除</button>
      </div>
    </div>
  `;

  // 点击卡片（大图区域）直接进入聊天
  card.addEventListener('click', () => {
    navigate('chat', { characterId: char.id });
  });

  card.querySelector('.btn-chat').addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('chat', { characterId: char.id });
  });

  card.querySelector('.btn-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('edit', { characterId: char.id });
  });

  card.querySelector('.btn-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm(`确定要删除角色“${char.name}”吗？相关的聊天记录也会被删除。`)) {
      await deleteCharacter(char.id);
      await refreshCharacters();
      navigate('home');
    }
  });

  return card;
}

function defaultAvatarUrl() {
  return 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%232a2a32%22/%3E%3Ctext x=%2250%22 y=%2255%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22%23888%22%3E👤%3C/text%3E%3C/svg%3E';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
