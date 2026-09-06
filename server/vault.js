'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 测试隔离通道：FPB_VAULT_FILE 可把 vault 落到 os.tmpdir（默认路径不变，生产行为零变化）。
const VAULT_FILE = process.env.FPB_VAULT_FILE
  ? path.resolve(process.env.FPB_VAULT_FILE)
  : path.join(__dirname, '..', 'data', 'vault.json');

// 主密钥：优先读环境变量 FPB_MASTER_KEY（base64，32 字节）。缺失时生成一次性密钥（重启即失效，仅用于本地试用）。
let MASTER_KEY;
function getKey() {
  if (MASTER_KEY) return MASTER_KEY;
  const env = process.env.FPB_MASTER_KEY;
  if (env) {
    MASTER_KEY = Buffer.from(env, 'base64');
    if (MASTER_KEY.length !== 32) throw new Error('FPB_MASTER_KEY 必须是 32 字节 base64');
  } else {
    // STEP 0.5 §2.5：此前为静默降级 —— 生成一次性内存密钥，写入的凭据重启后永久不可解密，
    // 且用户只会看到一行 console.warn。这是"数据静默丢失"，不是"可用性降级"。
    // 现在：生产环境直接拒绝；开发环境仍需可跑（用户可显式 FPB_ALLOW_EPHEMERAL_KEY=1 确认）。
    const env = String(process.env.NODE_ENV || '').toLowerCase();
    const allowEphemeral = process.env.FPB_ALLOW_EPHEMERAL_KEY === '1';
    if (env === 'production' || (!allowEphemeral && process.env.FPB_API_TOKEN)) {
      throw new Error(
        'FPB_MASTER_KEY 未设置：拒绝以一次性内存密钥启动（重启将导致全部已存凭据永久不可解密）。' +
          '请用 `openssl rand -base64 32` 生成并写入环境变量 FPB_MASTER_KEY；' +
          '仅在本机试用且接受凭据不可恢复时，可设置 FPB_ALLOW_EPHEMERAL_KEY=1。'
      );
    }
    MASTER_KEY = crypto.randomBytes(32);
    console.warn('[vault] ⚠️ 未设置 FPB_MASTER_KEY，使用一次性内存密钥 —— 重启后已存凭据将永久不可解密。');
    console.warn('[vault]    生成命令: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
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
  // Phase D 交付健壮性修复：getMaskedSummary 是只读展示面。解密失败（FPB_MASTER_KEY
  // 缺失/更换/数据损坏）时 fail-soft 返回锁定摘要，而不是让 GET /profiles、
  // GET /profiles/:id、GET /vault/:id 整个端点 500（新环境首启必踩的可用性阻断）。
  // 语义边界：写路径（setProfileSecrets/encrypt）与执行路径（getProfileSecrets 的
  // 自动化消费）保持 fail-closed 不变；此处绝不回传任何明文。
  let s = null;
  try {
    s = getProfileSecrets(profileId);
  } catch (e) {
    return {
      locked: true,
      vaultError: 'DECRYPT_FAILED',
      hasEmail: false,
      emailMasked: null,
      hasPassword: false,
      card: null,
    };
  }
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
