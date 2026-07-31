const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'dist', 'android-web');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest, options = {}) {
  const { exclude = [] } = options;
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, options);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ensureDir(dir);
}

console.log('Building Android web assets...');

// 清理并创建输出目录
cleanDir(outputDir);

// 复制主页面
copyFile(path.join(projectRoot, 'index.html'), path.join(outputDir, 'index.html'));

// 复制前端源码
copyDir(path.join(projectRoot, 'src'), path.join(outputDir, 'src'));

// 复制 marked 库（ESM 版本）
copyDir(
  path.join(projectRoot, 'node_modules', 'marked'),
  path.join(outputDir, 'node_modules', 'marked'),
  { exclude: ['.bin', '.github', 'docs', 'test'] }
);

// 复制 Capacitor 核心库和插件，供 Android WebView 的 ES Module 解析
copyDir(
  path.join(projectRoot, 'node_modules', '@capacitor', 'core'),
  path.join(outputDir, 'node_modules', '@capacitor', 'core'),
  { exclude: ['.bin', '.github', 'docs', 'test'] }
);
copyDir(
  path.join(projectRoot, 'node_modules', '@capacitor', 'filesystem'),
  path.join(outputDir, 'node_modules', '@capacitor', 'filesystem'),
  { exclude: ['.bin', '.github', 'docs', 'test'] }
);
copyDir(
  path.join(projectRoot, 'node_modules', '@capacitor', 'share'),
  path.join(outputDir, 'node_modules', '@capacitor', 'share'),
  { exclude: ['.bin', '.github', 'docs', 'test'] }
);
copyDir(
  path.join(projectRoot, 'node_modules', '@capacitor', 'synapse'),
  path.join(outputDir, 'node_modules', '@capacitor', 'synapse'),
  { exclude: ['.bin', '.github', 'docs', 'test'] }
);

console.log(`Android web assets built at: ${outputDir}`);
console.log('Next step: run npx cap sync android to copy assets into the Android project.');
