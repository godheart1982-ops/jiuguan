// 生成 src/services/prompt-presets-data.js：把仓库根目录的提示词 txt 打包成内置模板种子。
// 用法：node scripts/build-prompt-presets.js（txt 模板更新后跑一次，提示词库的内置条目随之更新）
const fs = require('fs');
const path = require('path');

const PRESETS = [
  { id: 'statusbar', name: '状态栏输出格式', file: '状态栏输出格式-v2.txt', kind: 'outputFormat' },
  { id: 'thinking', name: '思维链模板', file: '思维链模板.txt', kind: 'thinking' },
  { id: 'survival', name: '状态栏输出格式-荒野求生', file: '状态栏输出格式-荒野求生.txt', kind: 'outputFormat' }
];

const items = PRESETS.map((p) => ({
  id: p.id,
  name: p.name,
  content: fs.readFileSync(path.resolve(__dirname, '..', p.file), 'utf8').replace(/^﻿/, '')
}));

const out = '// 本文件由 scripts/build-prompt-presets.js 生成，请勿手改；模板源文件为仓库根目录同名 txt。\n' +
  'export const PROMPT_PRESET_SEED = ' + JSON.stringify(items, null, 2) + ';\n';

fs.writeFileSync(path.resolve(__dirname, '..', 'src/services/prompt-presets-data.js'), out, 'utf8');
console.log('prompt-presets-data.js written:', items.length, 'presets');
