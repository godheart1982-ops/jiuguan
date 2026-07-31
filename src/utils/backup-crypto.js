/**
 * 备份整包加密（Web Crypto AES-GCM-256 + PBKDF2）
 * 导出/上传前加密；导入/恢复时解密。口令不落盘，每次由用户输入。
 */

const ITERATIONS = 210000;
const SALT_LEN = 16;
const IV_LEN = 12;

function b64encode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt, iterations) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: iterations || ITERATIONS,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 是否为加密备份信封
 */
export function isEncryptedBackup(obj) {
  return !!(
    obj &&
    typeof obj === 'object' &&
    obj.encrypted === true &&
    typeof obj.data === 'string' &&
    typeof obj.salt === 'string' &&
    typeof obj.iv === 'string'
  );
}

/**
 * 加密完整备份对象 → 信封 JSON 对象
 * @param {object} payload exportAllData() 的结果
 * @param {string} password
 */
export async function encryptBackup(payload, password) {
  if (!password || !String(password).length) {
    throw new Error('备份口令不能为空');
  }
  if (!crypto || !crypto.subtle) {
    throw new Error('当前环境不支持 Web Crypto，无法加密备份');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(String(password), salt, ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return {
    version: 3,
    encrypted: true,
    cipher: 'AES-GCM-256',
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: b64encode(salt),
    iv: b64encode(iv),
    data: b64encode(new Uint8Array(cipherBuf)),
    exportedAt: new Date().toISOString()
  };
}

/**
 * 解密信封 → 原始备份对象
 * @param {object} envelope
 * @param {string} password
 */
export async function decryptBackup(envelope, password) {
  if (!isEncryptedBackup(envelope)) {
    throw new Error('不是加密备份文件');
  }
  if (!password || !String(password).length) {
    throw new Error('请输入备份口令');
  }
  if (!crypto || !crypto.subtle) {
    throw new Error('当前环境不支持 Web Crypto，无法解密备份');
  }
  const iterations = Number(envelope.iterations) || ITERATIONS;
  const salt = b64decode(envelope.salt);
  const iv = b64decode(envelope.iv);
  const data = b64decode(envelope.data);
  const key = await deriveKey(String(password), salt, iterations);
  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  } catch (e) {
    throw new Error('解密失败：口令错误或文件已损坏');
  }
  const text = new TextDecoder().decode(plainBuf);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('解密后的内容不是有效 JSON');
  }
}

/**
 * 解析备份文本：加密则需 password；明文则直接 parse
 * @returns {Promise<object>} 可交给 importAllData 的对象
 */
export async function parseBackupText(text, password) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('备份文件不是有效 JSON');
  }
  if (isEncryptedBackup(obj)) {
    return decryptBackup(obj, password);
  }
  // 旧版明文备份
  return obj;
}
