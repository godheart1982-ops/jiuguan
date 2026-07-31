import { navigate } from '../../app.js';

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function defaultAvatarUrl() {
  return 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%232a2a32%22/%3E%3Ctext x=%2250%22 y=%2255%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22%23888%22%3E👤%3C/text%3E%3C/svg%3E';
}

export function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

// 用户是否停留在消息列表底部附近：异步任务（记忆总结/插图生成）完成后的重渲染
// 只在用户本来就在底部时才跟随滚底，用户上翻阅读时保持原位不拽回。
export function isNearBottom(container, threshold = 160) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

export function renderEmptyChat(container) {
  container.innerHTML = `
    <div class="page">
      <div class="empty-state">
        <div class="icon">🍺</div>
        <h3>选择一个角色开始聊天</h3>
        <p>从左侧侧边栏选择角色，或先创建一个角色卡。</p>
        <button class="btn btn-primary" id="btn-empty-create">新建角色</button>
      </div>
    </div>
  `;
  document.getElementById('btn-empty-create').addEventListener('click', () => {
    navigate('edit', { characterId: null });
  });
}

export function splitThinking(msg) {
  if (!msg || typeof msg.content !== 'string') return;
  const re = /<thinking>[\s\S]*?<\/thinking>/gi;
  const matches = msg.content.match(re);
  if (!matches || matches.length === 0) return; // 无闭合标签：不动（不闭合不剥，避免误吃正文）
  const thinking = matches
    .map(m => m.replace(/<\/?thinking>/gi, '').trim())
    .filter(Boolean)
    .join('\n\n');
  let clean = msg.content.replace(re, '');
  clean = clean.replace(/^[\s ]+/, '').replace(/[\s ]+$/, '');
  msg.content = clean;
  if (thinking) msg.thinking = thinking;
  else delete msg.thinking;
}

export function extractThinkingForDisplay(content) {
  if (typeof content !== 'string') return { thinking: '', body: content || '' };
  // 优先按 <思考>...</思考> 配对提取
  const re = /<思考>[\s\S]*?<\/思考>/gi;
  const matches = content.match(re);
  if (matches && matches.length > 0) {
    const thinking = matches
      .map(m => m.replace(/<\/?思考>/gi, '').trim())
      .filter(Boolean)
      .join('\n\n');
    const body = content.replace(re, '').replace(/^[\s ]+/, '').replace(/[\s ]+$/, '');
    return { thinking, body };
  }
  // 方向二·解析兜底：模型漏了 </思考>（如 DeepSeek V4）时配对失败，改为「<思考> 到第一个正文模块 >###」之间算思维链，标签缺失也能正确折叠
  const openIdx = content.indexOf('<思考>');
  if (openIdx !== -1) {
    const bodyStart = content.indexOf('>###', openIdx);
    if (bodyStart !== -1) {
      return {
        thinking: content.slice(openIdx + '<思考>'.length, bodyStart).trim(),
        body: (content.slice(0, openIdx) + content.slice(bodyStart)).trim()
      };
    }
    // 连 >### 都没有：思维链未收尾且无正文模块，整段算思维链，避免裸露在正文里
    return { thinking: content.slice(openIdx + '<思考>'.length).trim(), body: '' };
  }
  return { thinking: '', body: content };
}

