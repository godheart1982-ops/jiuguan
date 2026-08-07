// 状态栏折叠的区域切分（纯函数，不依赖 DOM，可单测）
// 折叠范围：开头的连续模块区（>### 标题 + 归属的 ``` 围栏块与 > 注释行）；
// 尾部插图模块不在开头连续区内，天然不参与折叠，图片常显。

const MODULE_HEADING_RE = /^>\s*#{2,6}\s/;

function cleanModuleHeading(line) {
  let h = line.replace(/^>\s*#{2,6}\s*/, '').trim();
  h = h.replace(/^[-—–\s]+|[-—–\s]+$/g, '').trim(); // 去装饰破折号
  const bracket = h.match(/^\[([^\]|]+)/); // [林悦♀|职业] → 林悦♀
  return (bracket ? bracket[1] : h).trim();
}

/** 把回复体拆成「开头连续模块区」与「正文区」；无模块时 modules 为空串 */
export function splitLeadingModules(body) {
  const lines = String(body).split('\n');
  const headings = [];
  let inFence = false;
  let started = false;
  let end = 0; // 模块区结束行（不含）
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inFence) {
      if (t.startsWith('```')) inFence = false;
      end = i + 1;
      continue;
    }
    if (!t) { end = i + 1; continue; } // 空行视作模块区分隔
    if (MODULE_HEADING_RE.test(t)) {
      started = true;
      headings.push(cleanModuleHeading(t));
      end = i + 1;
      continue;
    }
    if (started && t.startsWith('```')) { inFence = true; end = i + 1; continue; }
    if (started && t.startsWith('>')) { end = i + 1; continue; } // 模块注释行
    break; // 第一行正文
  }
  if (!started) return { modules: '', headings: [], rest: body };
  return {
    modules: lines.slice(0, end).join('\n'),
    headings,
    rest: lines.slice(end).join('\n')
  };
}
