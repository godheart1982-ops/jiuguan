import { renderHome } from './pages/home.js';
import { renderCharacterEdit } from './pages/character-edit.js';
import { renderCardStudio } from './pages/card-studio.js';
import { renderChat } from './pages/chat.js';
import { renderWorldBookManager } from './pages/world-book-manager.js';
import { renderPromptLibrary } from './pages/prompt-library.js';
import { renderApiSettingsModal, renderUiSettingsModal, renderOtherSettingsModal, renderImageSettingsModal, applyFontSize, applyTheme } from './pages/settings.js';
import { renderTokenStatsModal } from './pages/token-stats.js';
import { listCharacters, getAvatarDataUrl, getConfig, saveConfig } from './services/storage.js';
import { requestNotificationPermission, startGenerationForeground } from './services/foreground.js';

// 全局状态
export const state = {
  currentPage: 'home',
  currentCharacterId: null,
  currentChatId: null,
  characters: [],
  collapsedGroups: new Set()
};

const mainContent = document.getElementById('main-content');
const sidebarCharacters = document.getElementById('sidebar-characters');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const mobileMenuBtn = document.getElementById('mobile-menu-btn');

function bootLog(message) {
  const el = document.getElementById('boot-log');
  if (el) {
    el.textContent += '\n' + message;
  }
  console.log('[boot]', message);
}

bootLog('app.js 开始执行');

export function navigate(page, options = {}) {
  state.currentPage = page;
  if (options.characterId !== undefined) state.currentCharacterId = options.characterId;
  if (options.chatId !== undefined) state.currentChatId = options.chatId;
  closeMobileSidebar();
  render();
}

function openMobileSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('show');
}

function closeMobileSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('show');
}

function toggleMobileSidebar() {
  if (sidebar.classList.contains('open')) {
    closeMobileSidebar();
  } else {
    openMobileSidebar();
  }
}

export async function refreshCharacters() {
  const characters = await listCharacters();
  state.characters = await Promise.all(characters.map(async (char) => {
    char.avatarDataUrl = await getAvatarDataUrl(char.avatar);
    return char;
  }));
  renderSidebar();
}

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

function getCurrentGroupName() {
  if (state.currentPage !== 'chat' || !state.currentCharacterId) return null;
  const char = state.characters.find(c => c.id === state.currentCharacterId);
  return char ? getGroupName(char) : null;
}

export function toggleGroupCollapsed(groupName) {
  if (state.collapsedGroups.has(groupName)) {
    state.collapsedGroups.delete(groupName);
  } else {
    state.collapsedGroups.add(groupName);
  }
  // 折叠状态持久化：折叠了就一直折叠，下次启动原样恢复
  getConfig().then(cfg => {
    cfg.ui = { ...(cfg.ui || {}), collapsedGroups: [...state.collapsedGroups] };
    return saveConfig(cfg);
  }).catch(() => {});
  if (state.currentPage === 'home') {
    render();
  } else {
    renderSidebar();
  }
}

function renderSidebar() {
  sidebarCharacters.innerHTML = '';

  const homeItem = document.createElement('div');
  homeItem.className = `sidebar-item ${state.currentPage === 'home' ? 'active' : ''}`;
  homeItem.innerHTML = `<span>🏠</span><span>全部角色</span>`;
  homeItem.addEventListener('click', () => navigate('home'));
  sidebarCharacters.appendChild(homeItem);

  const groups = groupCharacters(state.characters);
  const currentGroup = getCurrentGroupName();

  for (const [groupName, chars] of groups) {
    const collapsed = groupName !== currentGroup && state.collapsedGroups.has(groupName);

    const header = document.createElement('div');
    header.className = 'sidebar-group-header';
    const toggle = document.createElement('span');
    toggle.className = 'group-toggle';
    toggle.textContent = collapsed ? '▶' : '▼';
    const title = document.createElement('span');
    title.className = 'group-title';
    title.textContent = groupName;
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(chars.length);
    header.appendChild(toggle);
    header.appendChild(title);
    header.appendChild(count);
    header.addEventListener('click', () => toggleGroupCollapsed(groupName));
    sidebarCharacters.appendChild(header);

    if (collapsed) continue;

    for (const char of chars) {
      const item = document.createElement('div');
      item.className = `sidebar-item ${state.currentPage === 'chat' && state.currentCharacterId === char.id ? 'active' : ''}`;

      const avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.alt = char.name;
      if (char.avatarDataUrl) {
        avatar.src = char.avatarDataUrl;
      } else {
        avatar.src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23333%22/%3E%3Ctext x=%2250%22 y=%2255%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22%23888%22%3E👤%3C/text%3E%3C/svg%3E';
      }

      const nameSpan = document.createElement('span');
      nameSpan.textContent = char.name;

      item.appendChild(avatar);
      item.appendChild(nameSpan);
      item.addEventListener('click', () => navigate('chat', { characterId: char.id }));
      sidebarCharacters.appendChild(item);
    }
  }
}

function render() {
  mainContent.innerHTML = '';
  renderSidebar();

  switch (state.currentPage) {
    case 'home':
      renderHome(mainContent);
      break;
    case 'edit':
      renderCharacterEdit(mainContent, state.currentCharacterId);
      break;
    case 'studio':
      renderCardStudio(mainContent);
      break;
    case 'chat':
      renderChat(mainContent, state.currentCharacterId, state.currentChatId);
      break;
    case 'worldbooks':
      renderWorldBookManager(mainContent);
      break;
    case 'prompts':
      renderPromptLibrary(mainContent);
      break;
    default:
      renderHome(mainContent);
  }
}

// 侧边栏按钮事件
document.getElementById('btn-new-character').addEventListener('click', () => {
  navigate('edit', { characterId: null });
});

document.getElementById('btn-card-studio').addEventListener('click', () => {
  navigate('studio');
});

document.getElementById('btn-worldbooks').addEventListener('click', () => {
  navigate('worldbooks');
  closeMobileSidebar();
});

document.getElementById('btn-prompt-library').addEventListener('click', () => {
  navigate('prompts');
  closeMobileSidebar();
});

bootLog('事件绑定完成');

document.getElementById('btn-token-stats').addEventListener('click', async () => {
  try {
    await renderTokenStatsModal();
  } catch (error) {
    alert('打开用量统计失败：' + (error && error.message ? error.message : String(error)));
  } finally {
    closeMobileSidebar();
  }
});

document.getElementById('btn-settings').addEventListener('click', async () => {
  try {
    await renderApiSettingsModal();
  } catch (error) {
    alert('打开设置失败：' + (error && error.message ? error.message : String(error)));
  } finally {
    closeMobileSidebar();
  }
});

document.getElementById('btn-ui-settings').addEventListener('click', async () => {
  try {
    await renderUiSettingsModal();
  } catch (error) {
    alert('打开界面设置失败：' + (error && error.message ? error.message : String(error)));
  } finally {
    closeMobileSidebar();
  }
});

document.getElementById('btn-image-settings').addEventListener('click', async () => {
  try {
    await renderImageSettingsModal();
  } catch (error) {
    alert('打开插图设置失败：' + (error && error.message ? error.message : String(error)));
  } finally {
    closeMobileSidebar();
  }
});

document.getElementById('btn-other-settings').addEventListener('click', async () => {
  try {
    await renderOtherSettingsModal();
  } catch (error) {
    alert('打开设置失败：' + (error && error.message ? error.message : String(error)));
  } finally {
    closeMobileSidebar();
  }
});

// 移动端菜单按钮
if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener('click', toggleMobileSidebar);
}

if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener('click', closeMobileSidebar);
}

// 初始化
(async function init() {
  bootLog('init 开始');
  try {
    // Android 13+ 需要通知权限，否则前台服务无法显示通知，切后台会被杀
    let notificationGranted = false;
    try {
      notificationGranted = await requestNotificationPermission();
      bootLog('通知权限: ' + (notificationGranted ? '已授权' : '未授权'));
    } catch (e) {
      bootLog('请求通知权限出错: ' + (e && e.message ? e.message : String(e)));
    }

    // 启动常驻前台服务，保持 App 在后台时不被系统杀掉网络连接
    if (notificationGranted) {
      try {
        await startGenerationForeground({ title: '酒馆正在运行', text: '保持后台连接中…' });
        bootLog('常驻前台服务已启动');
      } catch (e) {
        bootLog('启动常驻前台服务失败: ' + (e && e.message ? e.message : String(e)));
      }
    }

    const config = await getConfig();
    bootLog('getConfig 完成');
    applyTheme(config.ui && config.ui.theme);
    bootLog('主题已应用');
    if (config.ui && config.ui.fontSize) {
      applyFontSize(config.ui.fontSize);
      bootLog('字体大小已应用');
    }
    // 恢复上次的分组折叠状态
    if (config.ui && Array.isArray(config.ui.collapsedGroups)) {
      state.collapsedGroups = new Set(config.ui.collapsedGroups);
    }
    await refreshCharacters();
    bootLog('refreshCharacters 完成');
    render();
    bootLog('render 完成');
  } catch (e) {
    bootLog('init 出错: ' + (e && e.message ? e.message : String(e)));
    console.error(e);
  }
})();
