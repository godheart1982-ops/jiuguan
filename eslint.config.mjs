// ESLint 最小配置：只抓 bug，不管风格
// 规则集 = eslint:recommended（未定义变量/未使用变量/不可达代码/重复 key 等），
// 不含任何格式风格规则；未使用变量降级 warn，存量不阻塞。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'android/**',
      'src_backup_1.2.35/**',
      'archive/**',
      'web-assets/**'
    ]
  },
  js.configs.recommended,
  {
    // 全文件共享的规则微调
    rules: {
      // 回调未使用的形参/catch(e) 是有意写法；{ prefix, ...rest } 省略解构是合法惯用法
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      // 空 catch 块在本项目即「忽略该错误」（如清理监听器），允许
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 正则里的全角/不换行空格是有意匹配 CJK 文本，放行
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
      // 以下三条对本项目是噪音而非 bug：
      // - 「let x = 默认值 然后 try/catch 各分支重赋」的错误文案提取惯用法
      'no-useless-assignment': 'off',
      // - catch 里重抛简化 Error 不带 cause 是有意的简化（错误文案面向用户）
      'preserve-caught-error': 'off',
      // - 一次性拆分脚本里的多空格正则是有意的格式匹配
      'no-regex-spaces': 'off',
      // - 敏感词过滤/标记匹配等复杂正则里的防御性转义是有意的，改它们比告警更危险
      'no-useless-escape': 'off'
    }
  },
  {
    // 前端源码：浏览器环境 ESM
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser }
    }
  },
  {
    // Node 原生测试
    files: ['tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },
  {
    // Electron 主进程 / 构建脚本：CommonJS
    files: ['scripts/**/*.js', 'main.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  {
    // preload 桥：渲染进程上下文（有 window）+ Node（contextBridge/ipcRenderer）
    files: ['preload.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser }
    }
  }
];
