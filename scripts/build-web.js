const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'dist', 'web');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ensureDir(dir);
}

async function buildWeb() {
  console.log('Building web version...');

  cleanDir(outputDir);

  // 用 esbuild 把所有前端代码打包成单个 IIFE 脚本，避免 file:// 下 ES module 被 Chrome 拦截
  await esbuild.build({
    entryPoints: [path.join(projectRoot, 'src', 'app.js')],
    bundle: true,
    outfile: path.join(outputDir, 'app.bundle.js'),
    format: 'iife',
    platform: 'browser',
    sourcemap: false,
    minify: false,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  });

  // 复制样式表
  copyFile(
    path.join(projectRoot, 'src', 'styles.css'),
    path.join(outputDir, 'styles.css')
  );

  // 复制主页面并替换 script 引用
  let indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf-8');
  indexHtml = indexHtml.replace(
    /\s*<script type="importmap">[\s\S]*?<\/script>\s*/,
    '\n'
  );
  indexHtml = indexHtml.replace(
    /<link rel="stylesheet" href="src\/styles\.css">/,
    '<link rel="stylesheet" href="styles.css">'
  );
  indexHtml = indexHtml.replace(
    /<script type="module" src="src\/app\.js"><\/script>/,
    '<script src="app.bundle.js"></script>'
  );
  fs.writeFileSync(path.join(outputDir, 'index.html'), indexHtml);

  // 生成说明文件
  fs.writeFileSync(path.join(outputDir, 'README.md'), `# 酒馆 网页版

直接用浏览器打开 index.html 即可运行。

## 注意事项

- 数据存储在浏览器的 IndexedDB 中，如果浏览器在 file:// 协议下禁用 IndexedDB，会自动回退到 localStorage。
- 把本文件夹拷贝到手机，用手机浏览器打开 index.html，数据会存在该手机的浏览器里。
- API 调用使用浏览器 fetch，需要你的 API 服务端允许跨域（CORS）。
- 头像上传使用系统文件选择器，手机浏览器通常支持。
`);

  console.log(`Web version built at: ${outputDir}`);
  console.log('Open dist/web/index.html in a browser to run.');
}

buildWeb().catch(err => {
  console.error('Web build failed:', err);
  process.exit(1);
});
