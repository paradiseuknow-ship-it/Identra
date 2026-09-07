'use strict';

// Phase 16-B1 前置 — Identity Store（Option B：Profile-bound identity.json）
//
// 架构边界（Phase 16-A NATIVE_PATCH_ARCHITECTURE / 16-B 规格 §7 §9 §10）：
//   data/profiles/<profileId>/identity.json   ← 本模块唯一读写目标
//   Chromium Native 侧（16-B1 POC）只读取该文件，不感知生成来源。
//
// 纪律：
//   - 写入前 assertValidIdentity fail-fast；磁盘上永不存在 invalid identity
//   - 读取时 parse 失败 / schema invalid → fail-fast（IDENTITY_*），禁止 random fallback
//   - 原子写（tmp + rename），避免半写文件被 Native 读到
//   - 路径安全：profileId 过 assertSafeName + resolveWithin（与 browserManager 同一纪律）
//   - 不携带 secrets（identitySchema 秘密扫描拦截）

const fs = require('fs');
const path = require('path');
const { assertSafeName, resolveWithin } = require('../security/safePath');
const { assertValidIdentity, IdentityError, canonicalIdentityString } = require('./identitySchema');

// C46：补接 CAP-O1 FPB_DATA_DIR 隔离约定（与 browserManager.PROFILES_ROOT 同步解析），
// 保证 identity.json 与 userDataDir 永远同根——测试环境两者随 FPB_DATA_DIR 一起落到 tmp。
const PROFILES_ROOT = process.env.FPB_DATA_DIR
  ? path.resolve(process.env.FPB_DATA_DIR, 'profiles')
  : path.join(__dirname, '..', '..', 'data', 'profiles');

function identityFilePath(profileId, rootOverride) {
  const root = rootOverride ? path.resolve(rootOverride) : PROFILES_ROOT;
  return path.join(resolveWithin(root, assertSafeName(profileId, 'profileId')), 'identity.json');
}

// 写入（幂等覆盖）：校验 → 确定性序列化 → 原子落盘。返回写入的字节串（供证据）。
function writeIdentity(profileId, identity, opts = {}) {
  assertValidIdentity(identity);
  const file = identityFilePath(profileId, opts.root);
  const body = canonicalIdentityString(identity);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
  return body;
}

// 读取：缺失 → null（调用方决定是否生成）；存在但 invalid/损坏 → fail-fast。
function readIdentity(profileId, opts = {}) {
  const file = identityFilePath(profileId, opts.root);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new IdentityError('[fp.identity] profile=' + profileId + ' identity.json 解析失败: ' + e.message, 'IDENTITY_MALFORMED');
  }
  assertValidIdentity(parsed);
  return parsed;
}

// ensure：存在 → 读回（校验）；不存在 → factory() 生成 → 校验 → 写入 → 返回。
// factory 必须纯确定性（调用方契约），本模块不做任何随机/时间戳注入。
function ensureIdentity(profileId, factory, opts = {}) {
  const existing = readIdentity(profileId, opts);
  if (existing) return { identity: existing, created: false };
  const identity = factory(profileId);
  writeIdentity(profileId, identity, opts);
  return { identity: readIdentity(profileId, opts), created: true };
}

module.exports = {
  PROFILES_ROOT,
  identityFilePath,
  writeIdentity,
  readIdentity,
  ensureIdentity,
};
