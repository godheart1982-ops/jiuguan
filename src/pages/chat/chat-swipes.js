// 同一条助手回复上的多稿（滑动候选）。
// 只在「这条还是最后一条回复」时存在；发出下一句时丢掉未选中的稿。
// 发给模型、写入记忆的永远是 msg.content（当前稿）。

export function swipeCount(msg) {
  return Array.isArray(msg?.swipes) && msg.swipes.length >= 2 ? msg.swipes.length : 0;
}

export function activeSwipeIndex(msg) {
  const n = Array.isArray(msg?.swipes) ? msg.swipes.length : 0;
  if (n < 2) return 0;
  const id = Number(msg.swipeId);
  if (!Number.isInteger(id) || id < 0 || id >= n) return 0;
  return id;
}

export function isActiveSwipeAborted(msg) {
  if (!msg) return false;
  if (swipeCount(msg) < 2) return msg.aborted === true;
  const id = activeSwipeIndex(msg);
  return Array.isArray(msg.abortedSwipes) && msg.abortedSwipes.includes(id);
}

/** 当前稿正文。无多稿时就是 msg.content。 */
export function readSwipeContent(msg, index) {
  if (!msg) return '';
  if (swipeCount(msg) < 2) return String(msg.content ?? '');
  const id = index == null ? activeSwipeIndex(msg) : index;
  if (id === activeSwipeIndex(msg)) return String(msg.content ?? '');
  if (!Number.isInteger(id) || id < 0 || id >= msg.swipes.length) return '';
  return String(msg.swipes[id] ?? '');
}

/**
 * 把正文写入某一稿。
 * 写入当前稿时同步 msg.content。
 * @returns {{ changed: boolean, visible: boolean }} visible=当前正在看的正文变了
 */
export function writeSwipeContent(msg, index, content) {
  if (!msg) return { changed: false, visible: false };
  const text = String(content ?? '');
  if (swipeCount(msg) < 2) {
    if (msg.content === text) return { changed: false, visible: false };
    msg.content = text;
    return { changed: true, visible: true };
  }
  const id = index == null ? activeSwipeIndex(msg) : index;
  if (!Number.isInteger(id) || id < 0 || id >= msg.swipes.length) {
    return { changed: false, visible: false };
  }
  const visible = id === activeSwipeIndex(msg);
  const prev = visible ? msg.content : msg.swipes[id];
  if (prev === text) return { changed: false, visible: false };
  msg.swipes[id] = text;
  if (visible) msg.content = text;
  return { changed: true, visible };
}

/** 把 msg.content 写回当前稿槽位。手改正文、流式输出之后调用。 */
export function syncActiveSwipe(msg) {
  if (!msg || swipeCount(msg) < 2) return false;
  const id = activeSwipeIndex(msg);
  msg.swipeId = id;
  const text = String(msg.content ?? '');
  if (msg.swipes[id] === text) return false;
  msg.swipes[id] = text;
  return true;
}

/** 记住当前正文，并在末尾新开一稿作为当前稿。返回新稿下标。 */
export function beginNewSwipe(msg) {
  if (!msg) return -1;
  const priorAborted = [];
  if (Array.isArray(msg.abortedSwipes)) {
    for (const n of msg.abortedSwipes) {
      if (Number.isInteger(n) && !priorAborted.includes(n)) priorAborted.push(n);
    }
  } else if (msg.aborted === true) {
    priorAborted.push(0);
  }
  if (!Array.isArray(msg.swipes) || msg.swipes.length === 0) {
    msg.swipes = [String(msg.content ?? '')];
    msg.swipeId = 0;
  } else {
    syncActiveSwipe(msg);
  }
  msg.swipes.push('');
  msg.swipeId = msg.swipes.length - 1;
  msg.content = '';
  msg.aborted = false;
  if (priorAborted.length) msg.abortedSwipes = priorAborted;
  else delete msg.abortedSwipes;
  return msg.swipeId;
}

/** 换到另一稿。先把当前正文存回原槽。已经在这一稿上则返回 false。 */
export function activateSwipe(msg, index) {
  if (!msg || swipeCount(msg) < 2) return false;
  if (!Number.isInteger(index) || index < 0 || index >= msg.swipes.length) return false;
  syncActiveSwipe(msg);
  if (msg.swipeId === index) return false;
  msg.swipeId = index;
  msg.content = String(msg.swipes[index] ?? '');
  msg.aborted = Array.isArray(msg.abortedSwipes) && msg.abortedSwipes.includes(index);
  return true;
}

/** 当前这稿生成被中止。单稿沿用 msg.aborted；多稿记在槽位上。 */
export function markActiveSwipeAborted(msg) {
  if (!msg) return;
  if (swipeCount(msg) < 2) {
    msg.aborted = true;
    return;
  }
  const id = activeSwipeIndex(msg);
  const list = Array.isArray(msg.abortedSwipes) ? msg.abortedSwipes.slice() : [];
  if (!list.includes(id)) list.push(id);
  msg.abortedSwipes = list;
  msg.aborted = true;
}

/** 续写完成后清除当前稿的中止标记。 */
export function clearActiveSwipeAborted(msg) {
  if (!msg) return;
  if (swipeCount(msg) < 2) {
    delete msg.aborted;
    return;
  }
  const id = activeSwipeIndex(msg);
  if (Array.isArray(msg.abortedSwipes)) {
    const next = msg.abortedSwipes.filter((n) => n !== id);
    if (next.length) msg.abortedSwipes = next;
    else delete msg.abortedSwipes;
  }
  msg.aborted = false;
}

const LOCAL_IMG_RE = /local-img:\/\/([^?\s)"']+)/g;

function localImagePaths(text) {
  const found = new Set();
  for (const m of String(text ?? '').matchAll(LOCAL_IMG_RE)) {
    if (m[1]) found.add(m[1]);
  }
  return found;
}

/** 丢掉未选中稿之后，只出现在那些稿里的本地插图路径。须在 discard 之前调用。 */
export function imagePathsLostByDiscard(msg) {
  if (!msg || swipeCount(msg) < 2) return [];
  const active = activeSwipeIndex(msg);
  const kept = localImagePaths(msg.content);
  const lost = new Set();
  msg.swipes.forEach((text, i) => {
    const paths = localImagePaths(i === active ? msg.content : text);
    for (const p of paths) {
      if (!kept.has(p)) lost.add(p);
    }
  });
  return [...lost];
}

/** 只留下当前稿的正文，删掉其余候选。 */
export function discardInactiveSwipes(msg) {
  if (!msg || swipeCount(msg) < 2) return false;
  syncActiveSwipe(msg);
  const id = activeSwipeIndex(msg);
  const aborted = Array.isArray(msg.abortedSwipes) && msg.abortedSwipes.includes(id);
  delete msg.swipes;
  delete msg.swipeId;
  delete msg.abortedSwipes;
  if (aborted) msg.aborted = true;
  else delete msg.aborted;
  return true;
}

/** 取消刚开的新稿（发送前预览点了取消）。 */
export function rollbackNewSwipe(msg) {
  if (!msg || !Array.isArray(msg.swipes) || msg.swipes.length < 2) return false;
  const dropped = msg.swipes.length - 1;
  msg.swipes.pop();
  if (Array.isArray(msg.abortedSwipes)) {
    msg.abortedSwipes = msg.abortedSwipes.filter(n => n !== dropped);
  }
  if (msg.swipes.length < 2) {
    const onlyAborted = Array.isArray(msg.abortedSwipes) && msg.abortedSwipes.includes(0);
    msg.content = String(msg.swipes[0] ?? '');
    delete msg.swipes;
    delete msg.swipeId;
    delete msg.abortedSwipes;
    if (onlyAborted) msg.aborted = true;
    else delete msg.aborted;
    return true;
  }
  msg.swipeId = msg.swipes.length - 1;
  msg.content = String(msg.swipes[msg.swipeId] ?? '');
  msg.aborted = Array.isArray(msg.abortedSwipes) && msg.abortedSwipes.includes(msg.swipeId);
  return true;
}
