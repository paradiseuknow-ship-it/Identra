'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VAULT_FILE = path.join(__dirname, '..', 'data', 'vault.json');

// 主密钥：优先读环境变量 FPB_MASTER_KEY（base64，32 字节）。缺失时生成一次性密钥（重启即失效，仅用于本地试用）。
let MASTER_KEY;
function getKey() {
  if (MASTER_KEY) return MASTER_KEY;
  const env = process.env.FPB_MASTER_KEY;
  if (env) {
    MASTER_KEY = Buffer.from(env, 'base64');
    if (MASTER_KEY.length !== 32) throw new Error('FPB_MASTER_KEY 必须是 32 字节 base64');
  } else {
    MASTER_KEY = crypto.randomBytes(32);
    console.warn('[vault] 未设置 FPB_MASTER_KEY，使用一次性内存密钥，重启后已存凭据不可解密。生产请设置环境变量。');
  }
  return MASTER_KEY;
}

function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const enc = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---- 持久化（仅存密文） ----
function readAll() {
  if (!fs.existsSync(VAULT_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeAll(obj) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  const data = JSON.stringify(obj, null, 2);
  // 重试以应对杀软/云同步/其他进程造成的瞬时 EPERM/EBUSY 锁
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      // 写临时文件再重命名，避免半截写入 + 降低被锁概率
      const tmp = VAULT_FILE + '.tmp';
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, VAULT_FILE);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code === 'EPERM' || e.code === 'EBUSY') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 * (i + 1)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

function setProfileSecrets(profileId, secrets) {
  const all = readAll();
  const enc = {};
  if (secrets.email != null) enc.email = encrypt(secrets.email);
  if (secrets.password != null) enc.password = encrypt(secrets.password);
  if (secrets.card) {
    const c = secrets.card;
    enc.card = {
      number: c.number != null ? encrypt(c.number) : null,
      expMonth: c.expMonth != null ? encrypt(c.expMonth) : null,
      expYear: c.expYear != null ? encrypt(c.expYear) : null,
      cvv: c.cvv != null ? encrypt(c.cvv) : null,
      name: c.name != null ? encrypt(c.name) : null,
    };
  }
  // 允许局部更新：合并已有密文
  const prev = all[profileId] || {};
  all[profileId] = { ...prev, ...enc };
  writeAll(all);
  return true;
}

function getProfileSecrets(profileId) {
  const all = readAll();
  const enc = all[profileId];
  if (!enc) return null;
  const out = {};
  if (enc.email) out.email = decrypt(enc.email);
  if (enc.password) out.password = decrypt(enc.password);
  if (enc.card) {
    out.card = {
      number: enc.card.number ? decrypt(enc.card.number) : null,
      expMonth: enc.card.expMonth ? decrypt(enc.card.expMonth) : null,
      expYear: enc.card.expYear ? decrypt(enc.card.expYear) : null,
      cvv: enc.card.cvv ? decrypt(enc.card.cvv) : null,
      name: enc.card.name ? decrypt(enc.card.name) : null,
    };
  }
  return out;
}

function deleteProfileSecrets(profileId) {
  const all = readAll();
  delete all[profileId];
  writeAll(all);
}

// 返回脱敏摘要（供前端展示，绝不回传明文）
function getMaskedSummary(profileId) {
  const s = getProfileSecrets(profileId);
  if (!s) return null;
  const mask = (v, head, tail) => !v ? null : (v.length <= head + tail ? v : v.slice(0, head) + '****' + v.slice(-tail));
  return {
    hasEmail: !!s.email,
    emailMasked: mask(s.email, 2, 4),
    hasPassword: !!s.password,
    card: s.card && s.card.number ? {
      numberMasked: '****' + s.card.number.slice(-4),
      expMonth: s.card.expMonth,
      expYear: s.card.expYear,
      name: s.card.name,
      hasCvv: !!s.card.cvv,
    } : null,
  };
}

module.exports = { setProfileSecrets, getProfileSecrets, deleteProfileSecrets, getMaskedSummary, encrypt, decrypt };
