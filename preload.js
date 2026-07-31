const { contextBridge, ipcRenderer } = require('electron');

// 把渲染进程的 console 日志转发到主进程
function forwardConsole(level) {
  const original = console[level];
  console[level] = (...args) => {
    original.apply(console, args);
    try {
      const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      ipcRenderer.send('renderer:console', level, text);
    } catch (e) {}
  };
}

forwardConsole('log');
forwardConsole('warn');
forwardConsole('error');

// 捕获全局错误和未处理的 Promise 错误
window.addEventListener('error', (e) => {
  ipcRenderer.send('renderer:console', 'error', `window.onerror: ${e.message} at ${e.filename}:${e.lineno}`);
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason?.message || e.reason || 'Unknown rejection';
  ipcRenderer.send('renderer:console', 'error', `unhandledrejection: ${reason}`);
});

contextBridge.exposeInMainWorld('electronAPI', {
  getDataDir: () => ipcRenderer.invoke('app:getDataDir'),
  fs: {
    readFile: (relativePath) => ipcRenderer.invoke('fs:readFile', relativePath),
    readFileBuffer: (relativePath) => ipcRenderer.invoke('fs:readFileBuffer', relativePath),
    writeFile: (relativePath, content) => ipcRenderer.invoke('fs:writeFile', relativePath, content),
    writeFileBuffer: (relativePath, base64Content) => ipcRenderer.invoke('fs:writeFileBuffer', relativePath, base64Content),
    deleteFile: (relativePath) => ipcRenderer.invoke('fs:deleteFile', relativePath),
    listFiles: (relativePath) => ipcRenderer.invoke('fs:listFiles', relativePath),
    exists: (relativePath) => ipcRenderer.invoke('fs:exists', relativePath),
    ensureDir: (relativePath) => ipcRenderer.invoke('fs:ensureDir', relativePath)
  },
  dialog: {
    selectImage: () => ipcRenderer.invoke('dialog:selectImage')
  },
  crypto: {
    uuid: () => ipcRenderer.invoke('crypto:uuid')
  }
});
