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
// C61 读路径硬化：vault 自持读写不走 jsonStore，C60 的 readFileSyncRetry 加固没有覆盖到这里。
//   老缺陷（A类/数据丢失）：readAll 的 catch 把瞬时文件锁（EPERM/EBUSY/EACCES——正是
//   writeAll 自己在重试加固的同一故障面）与「文件损坏」混为一谈，静默返回 {}，
//   而 setProfileSecrets/deleteProfileSecrets 全是 read-modify-write → 一次瞬时锁后
//   下一次写把整个 vault 覆写成 {}（全部凭据密文静默蒸发）。
//   修复消费 C62 共享原语 fsSafe.js（C60 语义对齐）+ vault 本地薄包装（ENOENT=合法缺失）。
const { readFileSyncRetry, atomicWriteFileSync } = require('./fsSafe');

// 瞬时锁重试；ENOENT 返回 null（vault 文件不存在=空 vault）；耗尽/非瞬时 fs 错误抛出（fail-loud，绝不吞成 {}）。
function readVaultRaw() {
  try {
    return readFileSyncRetry(VAULT_FILE);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// 真损坏（JSON 解析失败）：侧车保全原始字节后从空开始，绝不静默覆写未知密文。
function preserveCorruptSidecar(file) {
  try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (e) { /* 侧车尽力而为 */ }
}

function readAll() {
  const raw = readVaultRaw();
  if (raw == null) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    preserveCorruptSidecar(VAULT_FILE);
    return {};
  }
}
function writeAll(obj) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  // C61：共享原子写（tmp+rename+瞬时锁重试，fsSafe.js C60 语义对齐）
  atomicWriteFileSync(VAULT_FILE, JSON.stringify(obj, null, 2));
}

function setProfileSecrets(profileId, secrets) {
  const all = readAll();
  const enc = {};
  if (secrets.email != null) enc.email = encrypt(secrets.email);
  if (secrets.password != null) enc.password = encrypt(secrets.password);
  if (secrets.card) {
    const c = secrets.card;
    // C61 B类修复：模块注释承诺「局部更新：合并已有密文」，但老实现是浅合并——
    // 整个 card 对象被替换，局部卡更新（如只改 expMonth）把 number/cvv/name 密文
    // 全部置 null（卡数据静默丢失）。现在逐字段合并：
    //   字段缺失/undefined = 保留旧密文；null = 显式清除；有值 = 替换。
    const CARD_FIELDS = ['number', 'expMonth', 'expYear', 'cvv', 'name'];
    const prevCard = (all[profileId] && all[profileId].card) || {};
    const mergedCard = { ...prevCard };
    for (const k of CARD_FIELDS) {
      if (k in c) mergedCard[k] = c[k] != null ? encrypt(c[k]) : null;
    }
    enc.card = mergedCard;
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
