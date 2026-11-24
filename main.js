const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 保持窗口对象全局，避免被垃圾回收
let mainWindow;

// 数据根目录：便携版放在 exe 同级目录的 data 文件夹，开发/安装版放在 userData/data
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataDir = portableDir
  ? path.join(portableDir, 'data')
  : path.join(app.getPath('userData'), 'data');
const charactersDir = path.join(dataDir, 'characters');
const chatsDir = path.join(dataDir, 'chats');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function initDataDirs() {
  ensureDir(dataDir);
  ensureDir(charactersDir);
  ensureDir(chatsDir);
}

function createWindow() {
  initDataDirs();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    titleBarStyle: 'default',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on('renderer:console', (event, level, text) => {
  console.log(`[Renderer ${level.toUpperCase()}] ${text}`);
});

ipcMain.handle('fs:readFile', async (event, relativePath) => {
  const fullPath = path.join(dataDir, relativePath);
  if (!fullPath.startsWith(dataDir)) throw new Error('Path outside data dir');
  if (!fs.existsSync(fullPath)) return null;
  return fs.promises.readFile(fullPath, 'utf-8');
});

ipcMain.handle('fs:readFileBuffer', async (event, relativePath) => {
  const fullPath = path.join(dataDir, relativePath);
  if (!fullPath.startsWith(dataDir)) throw new Error('Path outside data dir');
  if (!fs.existsSync(fullPath)) return null;
  const buffer = await fs.promises.readFile(fullPath);
  return buffer.toString('base64');
});

async function atomicWriteFile(fullPath, data, encoding) {
  ensureDir(path.dirname(fullPath));
  const tmpPath = `${fullPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    if (encoding) {
      await fs.promises.writeFile(tmpPath, data, encoding);
    } else {
      await fs.promises.writeFile(tmpPath, data);
    }
    await fs.promises.rename(tmpPath, fullPath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

ipcMain.handle('fs:writeFile', async (event, relativePath, content) => {
  const fullPath = path.join(dataDir, relativePath);
  if (!fullPath.startsWith(dataDir)) throw new Error('Path outside data dir');
  await atomicWriteFile(fullPath, content, 'utf-8');
  return true;
});

ipcMain.handle('fs:writeFileBuffer', async (event, relativePath, base64Content) => {
  const fullPath = path.join(dataDir, relativePath);
  if (!fullPath.startsWith(dataDir)) throw new Error('Path outside data dir');
  await atomicWriteFile(fullPath, Buffer.from(base64Content, 'base64'));
  return true;
});

ipcMain.handle('fs:deleteFile', async (event, relativePath) => {
  const fullPath = path.join(dataDir, relativePath);
  if (!fullPath.startsWith(dataDir)) throw new Error('Path outside data dir');
  if (fs.existsSync(fullPath)) {
    await fs.promises.unlink(fullPath);
  }
  return true;
});

ipcMain.handle('fs:listFiles', async (event, relativePath) => {
  const fullPath = path.join(dataDir, relativePath || '.');
  if (!fullPath.startsWith(dataDir)) throw new Error('Path outside data dir');
  ensureDir(fullPath);
  const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
  return entries.map(e => ({
    name: e.name,
    isDirectory: e.isDirectory(),
    isFile: e.isFile()
  }));
});

ipcMain.handle('fs:exists', async (event, relativePath) => {
  const fullPath = path.join(dataDir, relativePath);
  if (!fullPath.startsWith(dataDir)) throw new Error('Path outside data dir');
  return fs.existsSync(fullPath);
});

ipcMain.handle('fs:ensureDir', async (event, relativePath) => {
  const fullPath = path.join(dataDir, relativePath);
  if (!fullPath.startsWith(dataDir)) throw new Error('Path outside data dir');
  ensureDir(fullPath);
  return true;
});

ipcMain.handle('dialog:selectImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const buffer = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.gif' ? 'image/gif'
    : 'image/webp';
  return { mime, base64: buffer.toString('base64') };
});

ipcMain.handle('crypto:uuid', () => {
  return crypto.randomUUID();
});
