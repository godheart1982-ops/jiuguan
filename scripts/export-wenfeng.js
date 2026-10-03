// 导出《文风规则包.txt》：内容与 APP 注入的「沉浸演绎·反AI腔总则」（全开形态）保持一致。
// 用法：node scripts/export-wenfeng.js
// 总则源文件是 src/services/narrative-rules.js（ESM，这里动态 import）；总则更新后跑一次本脚本即可同步 txt。
const { writeFileSync } = require('fs');

async function main() {
  const { IMMERSIVE_ACTING_RULE } = await import('../src/services/narrative-rules.js');

  const header = `# 文风规则包（沉浸演绎·反AI腔总则）

用法：全文粘贴到预设/世界书/角色卡的规则位，置于「输出格式要求」之后生效（先立格式、再立腔调）。
与酒馆 APP「其他设置 → 生成行为 → 沉浸演绎·反AI腔总则」注入的内容一致；源文件是
src/services/narrative-rules.js，APP 端总则更新后需重新导出本文件（node scripts/export-wenfeng.js）。

---

`;

  writeFileSync('文风规则包.txt', '﻿' + header + IMMERSIVE_ACTING_RULE + '\n', 'utf8');
  console.log('文风规则包.txt written,', IMMERSIVE_ACTING_RULE.length, 'chars of rule body');
}

main();
