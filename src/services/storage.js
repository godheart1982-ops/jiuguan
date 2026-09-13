/**
 * 本地 JSON 文件存储层
 * 支持 Electron（Windows 桌面端）、Capacitor（Android 端）和纯 Web（浏览器 IndexedDB）
 */

import { migrateConfig, migrateChat } from './migrations.js';

let api = null;

// ---------- 平台检测与后端初始化 ----------

function isElectron() {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

function isCapacitor() {
  return typeof window !== 'undefined' &&
    !!window.Capacitor &&
    !!window.Capacitor.Plugins &&
    !!window.Capacitor.Plugins.Filesystem;
}

function isWeb() {
  return typeof window !== 'undefined' && !!window.indexedDB && !isElectron() && !isCapacitor();
}

async function initBackend() {
  if (api) return api;

  if (isElectron()) {
    api = createElectronBackend(window.electronAPI);
  } else if (isCapacitor()) {
    api = createCapacitorBackend(window.Capacitor.Plugins.Filesystem);
  } else if (isWeb()) {
    api = await createWebBackend();
  } else {
    throw new Error('当前环境不支持文件存储，请在 Electron、Capacitor 或现代浏览器中运行');
  }
  return api;
}

// ---------- Electron 后端 ----------

function createElectronBackend(electronAPI) {
  return {
    fs: electronAPI.fs,
    dialog: electronAPI.dialog,
    crypto: electronAPI.crypto
  };
}

// ---------- Capacitor 后端 ----------

function createCapacitorBackend(fsPlugin) {
  const DIR = 'DATA';
  const ENC_UTF8 = 'utf8';

  function toPath(relativePath) {
    return relativePath.replace(/\\/g, '/');
  }

  async function ensureDir(relativePath) {
    try {
      await fsPlugin.mkdir({
        path: toPath(relativePath),
        directory: DIR,
        recursive: true
      });
    } catch (e) {
      // 目录已存在或其他可忽略错误
    }
  }

  async function readFile(relativePath) {
    try {
      const result = await fsPlugin.readFile({
        path: toPath(relativePath),
        directory: DIR,
        encoding: ENC_UTF8
      });
      return result.data;
    } catch (e) {
      const msg = (e && e.message) ? e.message.toLowerCase() : '';
      if (msg.includes('does not exist') || msg.includes('unable to read file') || msg.includes('not found')) {
        return null;
      }
      throw e;
    }
  }

  async function writeFile(relativePath, content) {
    await ensureDir(relativePath.split('/').slice(0, -1).join('/'));
    await fsPlugin.writeFile({
      path: toPath(relativePath),
      data: content,
      directory: DIR,
      encoding: ENC_UTF8,
      recursive: true
    });
  }

  async function deleteFile(relativePath) {
    try {
      await fsPlugin.deleteFile({
        path: toPath(relativePath),
        directory: DIR
      });
    } catch (e) {
      // 忽略文件不存在的错误
    }
  }

  async function listFiles(relativePath) {
    try {
      const result = await fsPlugin.readdir({
        path: toPath(relativePath),
        directory: DIR
      });
      return (result.files || []).map(item => {
        // 兼容不同版本 Capacitor：readdir 可能返回字符串数组或 FileInfo 对象数组
        if (typeof item === 'string') {
          return { name: item, isFile: true, isDirectory: false };
        }
        return {
          name: item.name || '',
          isFile: item.type === 'file',
          isDirectory: item.type === 'directory'
        };
      });
    } catch (e) {
      return [];
    }
  }

  async function exists(relativePath) {
    try {
      await fsPlugin.stat({
        path: toPath(relativePath),
        directory: DIR
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function readFileBuffer(relativePath) {
    try {
      const result = await fsPlugin.readFile({
        path: toPath(relativePath),
        directory: DIR
      });
      return result.data;
    } catch (e) {
      return null;
    }
  }

  async function writeFileBuffer(relativePath, base64Data) {
    await ensureDir(relativePath.split('/').slice(0, -1).join('/'));
    await fsPlugin.writeFile({
      path: toPath(relativePath),
      data: base64Data,
      directory: DIR,
      recursive: true
    });
  }

  // 返回 WebView 可直接加载的文件 URL（capacitor://localhost/_capacitor_file_/...），
  // 大图片走这个通道，避免几 MB 的 base64 经过 JS bridge 读写
  async function getFileUrl(relativePath) {
    try {
      const result = await fsPlugin.getUri({ path: toPath(relativePath), directory: DIR });
      if (!result || !result.uri) return null;
      return window.Capacitor.convertFileSrc(result.uri);
    } catch (e) {
      return null;
    }
  }

  // Android 端使用 HTML file input 选择图片，不需要原生 dialog
  const dialog = {
    selectImage: async () => {
      throw new Error('Android 端请使用页面上的文件选择器上传头像');
    }
  };

  // Capacitor 没有内置 uuid，使用浏览器 Crypto API
  const cryptoBackend = {
    uuid: () => {
      if (typeof window.crypto !== 'undefined' && window.crypto.randomUUID) {
        return window.crypto.randomUUID();
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }
  };

  return { fs: { readFile, writeFile, deleteFile, listFiles, exists, ensureDir, readFileBuffer, writeFileBuffer, getFileUrl }, dialog, crypto: cryptoBackend };
}

// ---------- Web 后端（IndexedDB） ----------

async function createWebBackend() {
  // 先尝试 IndexedDB，如果失败（例如某些浏览器在 file:// 下不支持）则回退到 localStorage
  try {
    return await createIndexedDBBackend();
  } catch (e) {
    console.warn('IndexedDB 不可用，回退到 localStorage:', e.message);
    return createLocalStorageBackend();
  }
}

async function createIndexedDBBackend() {
  const DB_NAME = 'jiuguan';
  const DB_VERSION = 1;
  const STORE_NAME = 'files';

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'path' });
        }
      };
    });
  }

  const db = await openDB();

  function normalizePath(relativePath) {
    return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  async function getFile(path) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(path);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function putFile(record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteRecord(path) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(path);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllKeys() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async function readFile(relativePath) {
    const path = normalizePath(relativePath);
    const file = await getFile(path);
    if (!file) return null;
    return file.type === 'text' ? file.content : null;
  }

  async function writeFile(relativePath, content) {
    await putFile({
      path: normalizePath(relativePath),
      type: 'text',
      content,
      updatedAt: Date.now()
    });
  }

  async function deleteFile(relativePath) {
    await deleteRecord(normalizePath(relativePath));
  }

  async function listFiles(relativePath) {
    const dir = normalizePath(relativePath || '');
    const prefix = dir ? dir + '/' : '';
    const keys = await getAllKeys();
    const names = new Set();
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const slashIndex = rest.indexOf('/');
        const name = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
        if (name) names.add(name);
      }
    }
    return Array.from(names).map(name => {
      const fullKey = prefix + name;
      const isFile = keys.includes(fullKey);
      return { name, isFile, isDirectory: !isFile };
    });
  }

  async function exists(relativePath) {
    const path = normalizePath(relativePath);
    const file = await getFile(path);
    if (file) return true;
    const keys = await getAllKeys();
    return keys.some(k => typeof k === 'string' && k.startsWith(path + '/'));
  }

  async function ensureDir(relativePath) {
    // IndexedDB 不需要创建目录
  }

  async function readFileBuffer(relativePath) {
    const path = normalizePath(relativePath);
    const file = await getFile(path);
    if (!file) return null;
    return file.type === 'base64' ? file.content : null;
  }

  async function writeFileBuffer(relativePath, base64Data) {
    await putFile({
      path: normalizePath(relativePath),
      type: 'base64',
      content: base64Data,
      updatedAt: Date.now()
    });
  }

  const dialog = {
    selectImage: async () => {
      throw new Error('网页版请使用页面上的文件选择器上传头像');
    }
  };

  const cryptoBackend = {
    uuid: () => {
      if (typeof window.crypto !== 'undefined' && window.crypto.randomUUID) {
        return window.crypto.randomUUID();
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }
  };

  return { fs: { readFile, writeFile, deleteFile, listFiles, exists, ensureDir, readFileBuffer, writeFileBuffer }, dialog, crypto: cryptoBackend };
}

function createLocalStorageBackend() {
  const KEY_PREFIX = 'jiuguan_file_';

  function normalizePath(relativePath) {
    return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function storageKey(path) {
    return KEY_PREFIX + normalizePath(path);
  }

  function allKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      keys.push(localStorage.key(i));
    }
    return keys.filter(k => k && k.startsWith(KEY_PREFIX));
  }

  async function readFile(relativePath) {
    const raw = localStorage.getItem(storageKey(relativePath));
    if (!raw) return null;
    try {
      const record = JSON.parse(raw);
      return record.type === 'text' ? record.content : null;
    } catch (e) {
      return null;
    }
  }

  async function writeFile(relativePath, content) {
    localStorage.setItem(storageKey(relativePath), JSON.stringify({
      type: 'text',
      content,
      updatedAt: Date.now()
    }));
  }

  async function deleteFile(relativePath) {
    localStorage.removeItem(storageKey(relativePath));
  }

  async function listFiles(relativePath) {
    const dir = normalizePath(relativePath || '');
    const prefix = dir ? storageKey(dir) + '/' : KEY_PREFIX;
    const keys = allKeys();
    const names = new Set();
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const slashIndex = rest.indexOf('/');
        const name = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
        if (name) names.add(name);
      }
    }
    return Array.from(names).map(name => {
      const fullKey = prefix + name;
      const isFile = keys.includes(fullKey);
      return { name, isFile, isDirectory: !isFile };
    });
  }

  async function exists(relativePath) {
    const path = normalizePath(relativePath);
    if (localStorage.getItem(storageKey(path))) return true;
    const prefix = storageKey(path) + '/';
    return allKeys().some(k => k.startsWith(prefix));
  }

  async function ensureDir(relativePath) {
    // localStorage 不需要创建目录
  }

  async function readFileBuffer(relativePath) {
    const raw = localStorage.getItem(storageKey(relativePath));
    if (!raw) return null;
    try {
      const record = JSON.parse(raw);
      return record.type === 'base64' ? record.content : null;
    } catch (e) {
      return null;
    }
  }

  async function writeFileBuffer(relativePath, base64Data) {
    localStorage.setItem(storageKey(relativePath), JSON.stringify({
      type: 'base64',
      content: base64Data,
      updatedAt: Date.now()
    }));
  }

  const dialog = {
    selectImage: async () => {
      throw new Error('网页版请使用页面上的文件选择器上传头像');
    }
  };

  const cryptoBackend = {
    uuid: () => {
      if (typeof window.crypto !== 'undefined' && window.crypto.randomUUID) {
        return window.crypto.randomUUID();
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }
  };

  return { fs: { readFile, writeFile, deleteFile, listFiles, exists, ensureDir, readFileBuffer, writeFileBuffer }, dialog, crypto: cryptoBackend };
}

// ---------- 通用工具 ----------

const PATHS = {
  config: 'config.json',
  characters: 'characters',
  chats: 'chats',
  worldbooks: 'worldbooks',
  tokenStats: 'token-stats.json'
};

async function readJson(relativePath) {
  const backend = await initBackend();
  const content = await backend.fs.readFile(relativePath);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch (e) {
    console.error('Failed to parse JSON:', relativePath, e);
    return null;
  }
}

async function writeJson(relativePath, data) {
  const backend = await initBackend();
  await backend.fs.writeFile(relativePath, JSON.stringify(data, null, 2));
}

// ---------- 配置 ----------

export async function getConfig() {
  // 默认值补齐 / 废弃字段清理 / memoryModel→memoryApi 迁移全部集中在 migrations.js
  return migrateConfig(await readJson(PATHS.config));
}

export async function saveConfig(config) {
  await writeJson(PATHS.config, config);
}

// ---------- Token 用量统计 ----------

export async function getTokenStats() {
  const stats = await readJson(PATHS.tokenStats);
  return stats && typeof stats === 'object' && stats.days ? stats : { days: {} };
}

export async function saveTokenStats(stats) {
  await writeJson(PATHS.tokenStats, stats);
}

export async function getApiProfiles() {
  const config = await getConfig();
  return config.apiProfiles || {};
}

// 方案白名单：存方案时只保留这些字段（防脏字段混入）——新增 API 字段时必须同步这里，否则方案存读会丢字段
export function toApiProfile(apiConfig) {
  return {
    baseUrl: apiConfig.baseUrl,
    apiKey: apiConfig.apiKey,
    model: apiConfig.model,
    temperature: apiConfig.temperature,
    temperatureEnabled: apiConfig.temperatureEnabled,
    maxTokens: apiConfig.maxTokens,
    format: apiConfig.format,
    reasoningEffort: apiConfig.reasoningEffort,
    showThinking: apiConfig.showThinking,
    deepseekThinking: apiConfig.deepseekThinking,
    deepseekReasoningEffort: apiConfig.deepseekReasoningEffort,
    prefillThinking: apiConfig.prefillThinking,
    enableThinking: apiConfig.enableThinking,
    customHeaders: apiConfig.customHeaders || ''
  };
}

export async function saveApiProfile(name, apiConfig) {
  const config = await getConfig();
  if (!config.apiProfiles) {
    config.apiProfiles = {};
  }
  config.apiProfiles[name] = toApiProfile(apiConfig);
  await saveConfig(config);
}

export async function deleteApiProfile(name) {
  const config = await getConfig();
  if (config.apiProfiles) {
    delete config.apiProfiles[name];
  }
  await saveConfig(config);
}

// ---------- 世界书库（独立文件，可被角色绑定） ----------

export async function listWorldBooks() {
  const backend = await initBackend();
  await backend.fs.ensureDir(PATHS.worldbooks).catch(() => {});
  const entries = await backend.fs.listFiles(PATHS.worldbooks).catch(() => []);
  const jsonFiles = (entries || []).filter((e) => e.isFile && e.name.endsWith('.json'));
  const books = [];
  for (const entry of jsonFiles) {
    const book = await readJson(`${PATHS.worldbooks}/${entry.name}`);
    if (book && book.id) books.push(book);
  }
  return books.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
}

export async function getWorldBook(id) {
  if (!id) return null;
  return await readJson(`${PATHS.worldbooks}/${id}.json`);
}

export async function saveWorldBook(book) {
  if (!book || !book.id) throw new Error('世界书缺少 id');
  const backend = await initBackend();
  await backend.fs.ensureDir(PATHS.worldbooks);
  const now = new Date().toISOString();
  if (!book.createdAt) book.createdAt = now;
  book.updatedAt = now;
  if (!Array.isArray(book.entries)) book.entries = [];
  await writeJson(`${PATHS.worldbooks}/${book.id}.json`, book);
  return book;
}

export async function deleteWorldBook(id) {
  if (!id) return;
  const backend = await initBackend();
  await backend.fs.deleteFile(`${PATHS.worldbooks}/${id}.json`).catch(() => {});
}

// ---------- 角色卡 ----------

export async function listCharacters() {
  const backend = await initBackend();
  const entries = await backend.fs.listFiles(PATHS.characters);
  const jsonFiles = entries.filter(e => e.isFile && e.name.endsWith('.json'));
  const characters = [];
  for (const entry of jsonFiles) {
    const char = await readJson(`${PATHS.characters}/${entry.name}`);
    if (char) characters.push(char);
  }
  return characters.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getCharacter(id) {
  return await readJson(`${PATHS.characters}/${id}.json`);
}

export async function saveCharacter(character) {
  const now = new Date().toISOString();
  if (!character.createdAt) character.createdAt = now;
  character.updatedAt = now;
  await writeJson(`${PATHS.characters}/${character.id}.json`, character);
  return character;
}

export async function deleteCharacter(id) {
  const backend = await initBackend();
  const character = await getCharacter(id);
  if (character && character.avatar) {
    await backend.fs.deleteFile(`${PATHS.characters}/${character.avatar}`).catch(() => {});
  }
  await backend.fs.deleteFile(`${PATHS.characters}/${id}.json`);
  await deleteGeneratedImagesDir(`images/${id}`);
  const chatDir = `${PATHS.chats}/${id}`;
  const exists = await backend.fs.exists(chatDir);
  if (exists) {
    const entries = await backend.fs.listFiles(chatDir);
    for (const entry of entries) {
      await backend.fs.deleteFile(`${chatDir}/${entry.name}`).catch(() => {});
    }
  }
}

export async function saveAvatar(id, base64Image, mimeType) {
  const backend = await initBackend();
  const ext = mimeType === 'image/png' ? 'png'
    : mimeType === 'image/jpeg' ? 'jpg'
    : mimeType === 'image/gif' ? 'gif'
    : mimeType === 'image/webp' ? 'webp'
    : 'png';
  const avatarName = `${id}.${ext}`;
  await backend.fs.writeFileBuffer(`${PATHS.characters}/${avatarName}`, base64Image);
  return avatarName;
}

export async function getAvatarDataUrl(avatarName) {
  if (!avatarName) return null;
  const backend = await initBackend();
  const ext = avatarName.split('.').pop().toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'gif' ? 'image/gif'
    : ext === 'webp' ? 'image/webp'
    : 'image/png';
  const base64 = await backend.fs.readFileBuffer(`${PATHS.characters}/${avatarName}`);
  return base64 ? `data:${mime};base64,${base64}` : null;
}

// ---------- 付费生图（seedream）本地图片 ----------

// 生成图片统一存到 images/{角色ID}/{对话ID}/ 下，聊天记录里只存相对路径（local-img://...）
export async function saveGeneratedImage(characterId, chatId, dataUrl) {
  const backend = await initBackend();
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('无效的图片数据');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const relPath = `images/${characterId}/${chatId}/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
  await backend.fs.ensureDir(`images/${characterId}/${chatId}`);
  await backend.fs.writeFileBuffer(relPath, m[2]);
  // 写完立即校验：大文件走 bridge 偶发静默失败，这里当场发现当场报错（而不是等下次读取才发现）
  const written = await backend.fs.exists(relPath).catch(() => false);
  if (!written) throw new Error('图片写入本地存储失败');
  return relPath;
}

export async function getGeneratedImageDataUrl(relPath) {
  if (!relPath) return null;
  const backend = await initBackend();
  // 原生平台优先 file-URL：WebView 直接读文件，几 MB 的 base64 不用走 bridge，更稳更快
  if (typeof backend.fs.getFileUrl === 'function') {
    const fileUrl = await backend.fs.getFileUrl(relPath);
    if (fileUrl) return fileUrl;
  }
  const ext = relPath.split('.').pop().toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'webp' ? 'image/webp'
    : 'image/png';
  const base64 = await backend.fs.readFileBuffer(relPath).catch(() => null);
  return base64 ? `data:${mime};base64,${base64}` : null;
}

// 锚点参考图（grokweb 生图参考脸）：存 images/{角色ID}/{对话ID}/ref-{名字}.{ext}——
// 每个名字固定一个文件名（覆盖即换图），随对话/角色删除自动清理（复用生成图目录的生命周期）
export async function saveAnchorRefImage(characterId, chatId, name, dataUrl) {
  const backend = await initBackend();
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('无效的图片数据');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const safe = String(name || 'ref').replace(/[\\/:*?"<>|\s]+/g, '_');
  const relPath = `images/${characterId}/${chatId}/ref-${safe}.${ext}`;
  await backend.fs.ensureDir(`images/${characterId}/${chatId}`);
  await backend.fs.writeFileBuffer(relPath, m[2]);
  const written = await backend.fs.exists(relPath).catch(() => false);
  if (!written) throw new Error('图片写入本地存储失败');
  return relPath;
}

// 读取锚点参考图：固定返回 base64 data URL（不走 file-URL——要作为 data URI 塞进反代请求体）
export async function getAnchorRefImageDataUrl(relPath) {
  if (!relPath) return null;
  const backend = await initBackend();
  const ext = relPath.split('.').pop().toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'webp' ? 'image/webp'
    : 'image/png';
  const base64 = await backend.fs.readFileBuffer(relPath).catch(() => null);
  return base64 ? `data:${mime};base64,${base64}` : null;
}

export async function deleteAnchorRefImage(relPath) {
  if (!relPath) return;
  const backend = await initBackend();
  await backend.fs.deleteFile(relPath).catch(() => {});
}

// 清理某个对话（或整个角色）目录下的全部生成图
async function deleteGeneratedImagesDir(dir) {
  const backend = await initBackend();
  const exists = await backend.fs.exists(dir).catch(() => false);
  if (!exists) return;
  const entries = await backend.fs.listFiles(dir).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile) {
      await backend.fs.deleteFile(`${dir}/${entry.name}`).catch(() => {});
    } else {
      await deleteGeneratedImagesDir(`${dir}/${entry.name}`);
    }
  }
}

// ---------- 聊天记录 ----------

export function normalizeChatMemory(chat) {
  // 实现已集中到 migrations.js（与 memory-editor.migrateMemory 同源，逻辑不再重复）
  migrateChat(chat);
}

/**
 * 列出某角色的会话索引（只含 id/title/时间戳，不含消息正文）。
 * 旧数据没有 .meta.json 时读一次全量补建（一次性迁移），之后只读索引。
 * 需要会话正文时用 getChat(characterId, chatId)。
 */
export async function listChats(characterId) {
  const backend = await initBackend();
  const chatDir = `${PATHS.chats}/${characterId}`;
  const exists = await backend.fs.exists(chatDir);
  if (!exists) return [];
  const entries = await backend.fs.listFiles(chatDir);
  const chatIds = entries
    .filter(e => e.isFile && e.name.endsWith('.json') && !e.name.endsWith('-summary.json') && !e.name.endsWith('.meta.json'))
    .map(e => e.name.slice(0, -'.json'.length));
  const metas = [];
  for (const id of chatIds) {
    let meta = await readJson(`${chatDir}/${id}.meta.json`);
    if (!meta || meta.id !== id) {
      const chat = await readJson(`${chatDir}/${id}.json`);
      if (!chat) continue;
      normalizeChatMemory(chat);
      meta = toChatMeta(chat);
      await writeJson(`${chatDir}/${id}.meta.json`, meta).catch(() => {});
    }
    metas.push(meta);
  }
  return metas.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getChat(characterId, chatId) {
  const chat = await readJson(`${PATHS.chats}/${characterId}/${chatId}.json`);
  if (chat) normalizeChatMemory(chat);
  return chat;
}

// 会话索引：列表只读这个几百字节的边车文件，不再为渲染下拉框全量读取每个会话 JSON
function toChatMeta(chat) {
  return {
    id: chat.id,
    characterId: chat.characterId,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
  };
}

export async function saveChat(chat) {
  const backend = await initBackend();
  const now = new Date().toISOString();
  if (!chat.createdAt) chat.createdAt = now;
  chat.updatedAt = now;
  const chatDir = `${PATHS.chats}/${chat.characterId}`;
  await backend.fs.ensureDir(chatDir);
  await writeJson(`${chatDir}/${chat.id}.json`, chat);
  // 索引写失败不影响主流程：下次列表时会从全量 JSON 补建
  await writeJson(`${chatDir}/${chat.id}.meta.json`, toChatMeta(chat)).catch(() => {});
  return chat;
}

export async function deleteChat(characterId, chatId) {
  const backend = await initBackend();
  await backend.fs.deleteFile(`${PATHS.chats}/${characterId}/${chatId}.json`);
  await backend.fs.deleteFile(`${PATHS.chats}/${characterId}/${chatId}.meta.json`).catch(() => {});
  await deleteChatPing(characterId, chatId);
  await deleteGeneratedImagesDir(`images/${characterId}/${chatId}`);
}

// ---------- 生成心跳（.ping 边车文件） ----------
// 流式生成期间每 5 秒只写这个几十字节的时间戳文件，替代旧方案（心跳也全量写整个会话 JSON）。
// 页面重载后的自愈逻辑据此区分「后台仍在生成」与「App 被杀后的残留 generating 标记」。

export async function writeChatPing(characterId, chatId) {
  const backend = await initBackend();
  await backend.fs.writeFile(`${PATHS.chats}/${characterId}/${chatId}.ping`, String(Date.now()));
}

export async function readChatPing(characterId, chatId) {
  const backend = await initBackend();
  const content = await backend.fs.readFile(`${PATHS.chats}/${characterId}/${chatId}.ping`).catch(() => null);
  const ts = Number(content);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

export async function deleteChatPing(characterId, chatId) {
  const backend = await initBackend();
  await backend.fs.deleteFile(`${PATHS.chats}/${characterId}/${chatId}.ping`).catch(() => {});
}

// ---------- 导出 ----------

export const PATHS_PUBLIC = PATHS;

export async function getPlatform() {
  if (isElectron()) return 'electron';
  if (isCapacitor()) return 'capacitor';
  if (isWeb()) return 'web';
  return 'unknown';
}

export async function createUUID() {
  const backend = await initBackend();
  if (backend.crypto && backend.crypto.uuid) {
    return backend.crypto.uuid();
  }
  if (typeof window.crypto !== 'undefined' && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/** 备份中视为敏感、默认不导出的字段名（递归匹配） */
const SECRET_KEY_RE = /^(apiKey|password|appPassword|secret|accessToken|refreshToken|token)$/i;

/**
 * 递归清空对象中的密钥类字段（就地修改）
 * @returns {number} 清空的字段个数
 */
export function redactSecretsInObject(obj) {
  let n = 0;
  if (!obj || typeof obj !== 'object') return 0;
  if (Array.isArray(obj)) {
    for (const item of obj) n += redactSecretsInObject(item);
    return n;
  }
  for (const k of Object.keys(obj)) {
    if (SECRET_KEY_RE.test(k) && (typeof obj[k] === 'string' || obj[k] == null)) {
      if (obj[k]) n += 1;
      obj[k] = '';
    } else if (obj[k] && typeof obj[k] === 'object') {
      n += redactSecretsInObject(obj[k]);
    }
  }
  return n;
}

/**
 * 若 incoming 中敏感字段为空、existing 有值，则保留 existing（导入时避免把本机 Key 冲掉）
 */
export function mergePreservingSecrets(incoming, existing) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (!existing || typeof existing !== 'object') return incoming;
  if (Array.isArray(incoming)) return incoming;
  for (const k of Object.keys(incoming)) {
    if (SECRET_KEY_RE.test(k)) {
      const inc = incoming[k];
      const ex = existing[k];
      if ((inc === '' || inc == null) && typeof ex === 'string' && ex) {
        incoming[k] = ex;
      }
    } else if (
      incoming[k] &&
      typeof incoming[k] === 'object' &&
      !Array.isArray(incoming[k]) &&
      existing[k] &&
      typeof existing[k] === 'object'
    ) {
      mergePreservingSecrets(incoming[k], existing[k]);
    }
  }
  // existing 有、incoming 没有的敏感分支（如 webdav）不必整块覆盖
  return incoming;
}

function redactSecretsInJsonText(jsonText) {
  try {
    const obj = JSON.parse(jsonText);
    const cleared = redactSecretsInObject(obj);
    return { text: JSON.stringify(obj, null, 2), cleared };
  } catch (e) {
    return { text: jsonText, cleared: 0 };
  }
}

/**
 * 导出所有数据为可下载的备份对象
 * @param {{ includeSecrets?: boolean }} [options]
 *   includeSecrets=true 时保留 API Key 等（不推荐）；默认 false 脱敏
 * @returns {Promise<Object>} 包含 version、exportedAt、files 的备份对象
 */
export async function exportAllData(options = {}) {
  const includeSecrets = options.includeSecrets === true;
  const backend = await initBackend();
  const files = {};
  let secretsRedactedCount = 0;

  // 1. 配置（默认脱敏 apiKey / password 等）
  const configContent = await backend.fs.readFile(PATHS.config);
  if (configContent !== null) {
    if (includeSecrets) {
      files[PATHS.config] = configContent;
    } else {
      const { text, cleared } = redactSecretsInJsonText(configContent);
      files[PATHS.config] = text;
      secretsRedactedCount += cleared;
    }
  }

  // 2. 角色卡
  const charEntries = await backend.fs.listFiles(PATHS.characters);
  for (const entry of charEntries) {
    if (!entry.isFile) continue;
    const relativePath = `${PATHS.characters}/${entry.name}`;
    if (entry.name.endsWith('.json')) {
      const content = await backend.fs.readFile(relativePath);
      if (content !== null) files[relativePath] = content;
    } else {
      // 头像图片，按 base64 存储
      const base64 = await backend.fs.readFileBuffer(relativePath);
      if (base64) files[relativePath] = base64;
    }
  }

  // 3. 聊天记录
  const chatCharEntries = await backend.fs.listFiles(PATHS.chats);
  for (const charEntry of chatCharEntries) {
    if (charEntry.isFile) continue;
    const chatDir = `${PATHS.chats}/${charEntry.name}`;
    const chatEntries = await backend.fs.listFiles(chatDir);
    for (const chatEntry of chatEntries) {
      if (!chatEntry.isFile || !chatEntry.name.endsWith('.json')) continue;
      const relativePath = `${chatDir}/${chatEntry.name}`;
      const content = await backend.fs.readFile(relativePath);
      if (content !== null) files[relativePath] = content;
    }
  }

  // 4. 独立世界书库
  try {
    await backend.fs.ensureDir(PATHS.worldbooks);
    const wbEntries = await backend.fs.listFiles(PATHS.worldbooks);
    for (const entry of wbEntries || []) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue;
      const relativePath = `${PATHS.worldbooks}/${entry.name}`;
      const content = await backend.fs.readFile(relativePath);
      if (content !== null) files[relativePath] = content;
    }
  } catch (e) {
    /* 目录不存在则跳过 */
  }

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    secretsRedacted: !includeSecrets,
    secretsRedactedCount,
    files
  };
}

/**
 * 从备份对象恢复所有数据（会覆盖现有数据）
 * 若备份已脱敏，本机原有 API Key / WebDAV 密码等会尽量保留
 * @param {Object} backup exportAllData 生成的备份对象
 */
export async function importAllData(backup) {
  if (!backup || !backup.files || typeof backup.files !== 'object') {
    throw new Error('无效的备份文件');
  }

  const backend = await initBackend();

  // 导入前读出本机配置，用于合并敏感字段
  let localConfigRaw = null;
  try {
    localConfigRaw = await backend.fs.readFile(PATHS.config);
  } catch (e) {
    localConfigRaw = null;
  }
  let localConfigObj = null;
  if (localConfigRaw) {
    try {
      localConfigObj = JSON.parse(localConfigRaw);
    } catch (e) {
      localConfigObj = null;
    }
  }

  // 按路径长度排序，确保先创建父目录
  const paths = Object.keys(backup.files).sort((a, b) => a.split('/').length - b.split('/').length);

  for (const relativePath of paths) {
    let content = backup.files[relativePath];
    if (content === undefined || content === null) continue;

    await backend.fs.ensureDir(relativePath.split('/').slice(0, -1).join('/'));

    const isBase64 = !relativePath.endsWith('.json');
    if (isBase64) {
      await backend.fs.writeFileBuffer(relativePath, content);
    } else {
      // config.json：脱敏备份导入时保留本机密钥
      if (relativePath === PATHS.config || relativePath.replace(/\\/g, '/') === PATHS.config) {
        try {
          const incoming = typeof content === 'string' ? JSON.parse(content) : content;
          if (localConfigObj) mergePreservingSecrets(incoming, localConfigObj);
          content = JSON.stringify(incoming, null, 2);
        } catch (e) {
          // 解析失败则原样写入
        }
      }
      await backend.fs.writeFile(relativePath, content);
    }
  }
}
