/**
 * WebDAV 备份（默认适配坚果云）
 *
 * 坚果云：
 * - 地址：https://dav.jianguoyun.com/dav/
 * - 用户名：注册邮箱
 * - 密码：官网「账户信息 → 安全选项 → 添加应用密码」（不是登录密码）
 *
 * 文件名格式（可排序，含设备后缀）：
 *   backup-YYYYMMDD-HHmmss-设备名.json
 * 例：backup-20260729-213045-手机.json
 */

export const DEFAULT_WEBDAV_CONFIG = {
  enabled: false,
  baseUrl: 'https://dav.jianguoyun.com/dav',
  username: '',
  password: '',
  /** 云端目录（相对 dav 根） */
  remoteDir: 'jiuguan',
  /** 设备名称：写入文件名后缀，区分多台设备 */
  deviceName: '',
  lastBackupAt: null,
  lastBackupFileName: null,
  lastRestoreAt: null
};

/** 设备名做成文件名安全后缀（保留中文；去掉路径非法字符） */
export function sanitizeDeviceSuffix(name) {
  const s = String(name || '')
    .trim()
    // eslint-disable-next-line no-control-regex -- 有意剔除文件名中的控制字符
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/\.+$/g, '')
    .slice(0, 40);
  return s || 'default';
}

/** 本地时间 → YYYYMMDD-HHmmss（不用冒号，路径友好） */
export function formatBackupTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 生成备份文件名：backup-时间戳-设备.json
 * @param {object} cfg
 * @param {{ at?: Date|string|number }} [opts]
 */
export function resolveBackupFileName(cfg, opts = {}) {
  const c = normalizeWebdavConfig(cfg);
  const suffix = sanitizeDeviceSuffix(c.deviceName);
  const ts = formatBackupTimestamp(opts.at ? new Date(opts.at) : new Date());
  return `backup-${ts}-${suffix}.json`;
}

/**
 * 从文件名解析是否属于某设备的备份，并抽出可排序时间键
 * 支持：
 * - backup-YYYYMMDD-HHmmss-设备.json（新）
 * - backup-YYYY-MM-DD-设备.json（旧日期副本）
 * - backup-latest-设备.json（旧 latest，排序靠后）
 */
export function parseBackupFileName(fileName, deviceName) {
  const name = String(fileName || '').replace(/\\/g, '/').split('/').pop() || '';
  if (!name.toLowerCase().endsWith('.json')) return null;
  const suffix = sanitizeDeviceSuffix(deviceName);
  // 必须以 -设备.json 结尾
  const tail = `-${suffix}.json`;
  if (!name.endsWith(tail)) return null;

  // backup-20260729-213045-设备.json
  let m = name.match(/^backup-(\d{8})-(\d{6})-/);
  if (m) {
    return { fileName: name, sortKey: `${m[1]}${m[2]}`, kind: 'datetime' };
  }
  // backup-2026-07-29-设备.json
  m = name.match(/^backup-(\d{4})-(\d{2})-(\d{2})-/);
  if (m) {
    return { fileName: name, sortKey: `${m[1]}${m[2]}${m[3]}000000`, kind: 'date' };
  }
  // 其它带设备后缀的
  return { fileName: name, sortKey: '0', kind: 'other' };
}

export function normalizeWebdavConfig(raw) {
  const d = DEFAULT_WEBDAV_CONFIG;
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!r.enabled,
    baseUrl: String(r.baseUrl || d.baseUrl).trim() || d.baseUrl,
    username: String(r.username || '').trim(),
    password: String(r.password || ''),
    remoteDir: String(r.remoteDir != null ? r.remoteDir : d.remoteDir).trim().replace(/^\/+|\/+$/g, '') || d.remoteDir,
    deviceName: String(r.deviceName != null ? r.deviceName : d.deviceName).trim(),
    lastBackupAt: r.lastBackupAt || null,
    lastBackupFileName: r.lastBackupFileName || null,
    lastRestoreAt: r.lastRestoreAt || null
  };
}

function basicAuthHeader(username, password) {
  const token = btoa(unescape(encodeURIComponent(`${username}:${password}`)));
  return `Basic ${token}`;
}

function joinUrl(base, ...parts) {
  let u = String(base || '').replace(/\/+$/, '');
  for (const p of parts) {
    const seg = String(p || '').replace(/^\/+|\/+$/g, '');
    if (!seg) continue;
    u += '/' + seg;
  }
  return u;
}

export function resolveWebdavFileUrl(cfg, fileName) {
  const c = normalizeWebdavConfig(cfg);
  const name = fileName || resolveBackupFileName(c);
  return joinUrl(c.baseUrl, c.remoteDir, name);
}

function authHeaders(cfg) {
  const c = normalizeWebdavConfig(cfg);
  if (!c.username || !c.password) {
    throw new Error('请填写 WebDAV 用户名和应用密码');
  }
  return {
    Authorization: basicAuthHeader(c.username, c.password)
  };
}

/** 创建远程目录（已存在则忽略） */
async function ensureRemoteDir(cfg) {
  const c = normalizeWebdavConfig(cfg);
  const dirUrl = joinUrl(c.baseUrl, c.remoteDir);
  try {
    const res = await fetch(dirUrl, {
      method: 'MKCOL',
      headers: authHeaders(c)
    });
    if (res.ok || res.status === 405 || res.status === 409 || res.status === 301 || res.status === 302) {
      return;
    }
    if (res.status >= 400 && res.status !== 405 && res.status !== 409) {
      const t = await res.text().catch(() => '');
      console.warn('[webdav] MKCOL', res.status, t.slice(0, 200));
    }
  } catch (e) {
    console.warn('[webdav] MKCOL failed', e);
  }
}

/**
 * 上传文本内容到 WebDAV
 * @returns {Promise<{ url: string }>}
 */
export async function webdavUploadText(cfg, content, fileName) {
  const c = normalizeWebdavConfig(cfg);
  if (!c.baseUrl) throw new Error('请填写 WebDAV 服务器地址');
  await ensureRemoteDir(c);
  const url = resolveWebdavFileUrl(c, fileName);
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...authHeaders(c),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: typeof content === 'string' ? content : JSON.stringify(content)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`WebDAV 上传失败 (${res.status})：${t.slice(0, 200) || res.statusText}`);
  }
  return { url, fileName: fileName || resolveBackupFileName(c) };
}

/** 下载文本 */
export async function webdavDownloadText(cfg, fileName) {
  const c = normalizeWebdavConfig(cfg);
  const url = resolveWebdavFileUrl(c, fileName);
  const res = await fetch(url, {
    method: 'GET',
    headers: authHeaders(c)
  });
  if (res.status === 404) {
    throw new Error('云端未找到备份文件，请先上传备份');
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`WebDAV 下载失败 (${res.status})：${t.slice(0, 200) || res.statusText}`);
  }
  return await res.text();
}

/**
 * 列出远程目录下的文件名（PROPFIND Depth:1）
 * @returns {Promise<string[]>}
 */
export async function webdavListFiles(cfg) {
  const c = normalizeWebdavConfig(cfg);
  await ensureRemoteDir(c);
  const dirUrl = joinUrl(c.baseUrl, c.remoteDir);
  const res = await fetch(dirUrl, {
    method: 'PROPFIND',
    headers: {
      ...authHeaders(c),
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8'
    },
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>'
  });
  if (!(res.status === 207 || res.ok)) {
    const t = await res.text().catch(() => '');
    throw new Error(`列出云端文件失败 (${res.status})：${t.slice(0, 200) || 'PROPFIND 不可用'}`);
  }
  const xml = await res.text();
  const names = [];
  // 解析 href 末段文件名
  const hrefRe = /<(?:D:|d:|DAV:)?href[^>]*>([^<]+)<\/(?:D:|d:|DAV:)?href>/gi;
  let m;
  while ((m = hrefRe.exec(xml)) !== null) {
    let href = m[1].trim();
    try {
      href = decodeURIComponent(href);
    } catch (e) {
      /* keep raw */
    }
    href = href.replace(/\\/g, '/');
    // 去掉末尾 /
    const isDir = href.endsWith('/');
    if (isDir) continue;
    const base = href.split('/').filter(Boolean).pop() || '';
    if (!base || base === c.remoteDir) continue;
    if (!names.includes(base)) names.push(base);
  }
  return names;
}

/**
 * 列出本设备全部备份（新→旧）
 * @returns {Promise<Array<{ fileName: string, sortKey: string, kind: string, label: string }>>}
 */
export async function listDeviceBackupFiles(cfg) {
  const c = normalizeWebdavConfig(cfg);
  const all = await listAllBackupFiles(c);
  const suffix = `-${sanitizeDeviceSuffix(c.deviceName)}.json`;
  return all.filter((p) => p.fileName.endsWith(suffix));
}

/**
 * 列出云端目录下全部 .json 备份（不限设备，新→旧）
 * 用于长按自选恢复（可恢复其他设备的备份）
 * @returns {Promise<Array<{ fileName: string, sortKey: string, device: string, label: string }>>}
 */
export async function listAllBackupFiles(cfg) {
  const c = normalizeWebdavConfig(cfg);
  const names = await webdavListFiles(c);
  const items = [];
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    // 跳过明显不是备份的
    if (!/^backup-/i.test(name) && !/jiuguan/i.test(name)) {
      // 仍展示其它 json，方便用户看到目录里所有文件
    }
    const meta = parseAnyBackupFileName(name);
    items.push({
      fileName: name,
      sortKey: meta.sortKey,
      device: meta.device,
      label: meta.label
    });
  }
  items.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return items;
}

/**
 * 解析任意备份文件名（不绑定当前设备）
 */
export function parseAnyBackupFileName(fileName) {
  const name = String(fileName || '').replace(/\\/g, '/').split('/').pop() || '';
  // backup-YYYYMMDD-HHmmss-设备.json
  let m = name.match(/^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.json$/i);
  if (m) {
    return {
      sortKey: `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`,
      device: m[7],
      label: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} · ${m[7]}`
    };
  }
  // backup-YYYY-MM-DD-设备.json
  m = name.match(/^backup-(\d{4})-(\d{2})-(\d{2})-(.+)\.json$/i);
  if (m) {
    return {
      sortKey: `${m[1]}${m[2]}${m[3]}000000`,
      device: m[4],
      label: `${m[1]}-${m[2]}-${m[3]} · ${m[4]}`
    };
  }
  // backup-latest-设备.json 等
  m = name.match(/^backup-(.+)\.json$/i);
  if (m) {
    return {
      sortKey: '0',
      device: m[1],
      label: name
    };
  }
  return {
    sortKey: '0',
    device: '',
    label: name
  };
}

/** 文件名转可读时间标签 */
export function formatBackupFileLabel(fileName) {
  const name = String(fileName || '');
  // backup-YYYYMMDD-HHmmss-设备.json
  let m = name.match(/^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  // backup-YYYY-MM-DD-设备.json
  m = name.match(/^backup-(\d{4})-(\d{2})-(\d{2})-/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return name;
}

/**
 * 找本设备最新一份备份文件名（按文件名时间戳排序）
 * @returns {Promise<{ fileName: string, sortKey: string, candidates: number }>}
 */
export async function findLatestBackupFileName(cfg) {
  const c = normalizeWebdavConfig(cfg);
  let list = [];
  try {
    list = await listDeviceBackupFiles(c);
  } catch (e) {
    // 列表失败时回退 lastBackupFileName
    if (c.lastBackupFileName) {
      return { fileName: c.lastBackupFileName, sortKey: '', candidates: 0, fallback: true };
    }
    throw e;
  }
  if (!list.length) {
    if (c.lastBackupFileName) {
      return { fileName: c.lastBackupFileName, sortKey: '', candidates: 0, fallback: true };
    }
    throw new Error(
      `云端目录「${c.remoteDir}」中没有找到设备「${c.deviceName || 'default'}」的备份（文件名形如 backup-时间-设备.json）`
    );
  }
  return { fileName: list[0].fileName, sortKey: list[0].sortKey, candidates: list.length };
}

/** 连通性测试：对目录做 PROPFIND Depth:0 */
export async function webdavTestConnection(cfg) {
  const c = normalizeWebdavConfig(cfg);
  if (!c.baseUrl) throw new Error('请填写 WebDAV 服务器地址');
  if (!c.username || !c.password) throw new Error('请填写用户名和应用密码');

  await ensureRemoteDir(c);
  const dirUrl = joinUrl(c.baseUrl, c.remoteDir);
  const res = await fetch(dirUrl, {
    method: 'PROPFIND',
    headers: {
      ...authHeaders(c),
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8'
    },
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
  });

  if (res.status === 207 || res.ok) {
    return { ok: true, status: res.status, url: dirUrl };
  }
  const head = await fetch(joinUrl(c.baseUrl) + '/', {
    method: 'GET',
    headers: authHeaders(c)
  });
  if (head.ok || head.status === 207 || head.status === 405) {
    return { ok: true, status: head.status, url: c.baseUrl, note: 'PROPFIND 不可用但认证似乎成功' };
  }
  const t = await res.text().catch(() => '');
  throw new Error(`连接失败 (${res.status})：${t.slice(0, 200) || '请检查地址/邮箱/应用密码'}`);
}
