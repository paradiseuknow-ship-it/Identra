'use strict';

const fs = require('fs');
const path = require('path');

// B.11：代理凭据加密落库。复用 vault 的 AES-256-GCM 透明加解密：
// 落盘只存 passwordEnc（密文），读取时解密为内存明文供消费点（browserManager/proxyChecker）使用，
// 避免明文 JSON 残留（与 vault 凭据加密策略一致）。
const vault = require('./vault');

// CAP-O1：FPB_DATA_DIR 供测试/部署隔离（identity.js 与 agent/storage 同步支持）
const DATA_DIR = process.env.FPB_DATA_DIR
  ? path.resolve(process.env.FPB_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const PROXIES_FILE = path.join(DATA_DIR, 'proxies.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

// 解密单个 proxy（passwordEnc → password；兼容旧明文 password 字段）
function _decryptProxy(p) {
  if (!p) return p;
  const np = { ...p };
  if (typeof np.passwordEnc === 'string' && np.passwordEnc) {
    try { np.password = vault.decrypt(np.passwordEnc); } catch (e) { np.password = ''; }
    delete np.passwordEnc;
  }
  return np;
}

// 加密单个 proxy（password 明文 → passwordEnc；空密码或缺失则不存密文）
function _encryptProxy(p) {
  if (!p) return p;
  const np = { ...p };
  if (typeof np.password === 'string') {
    if (np.password === '') { delete np.password; delete np.passwordEnc; }
    else { np.passwordEnc = vault.encrypt(np.password); delete np.password; }
  }
  return np;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// C79 读路径硬化（消费 C62 fsSafe，范式对齐 identity.js readJson）：
// 本模块三个集合（profiles/proxies/tasks）的 upsert/delete 全是 read-all → modify → write-all
// RMW 链——旧实现 readJson 把瞬时文件锁（EPERM/EBUSY，杀毒/索引器）与真损坏一并吞成
// fallback[]，下一次 save* 就把整个集合覆写成空 = 永久静默清空（C60/C61/C62 同族 A 类）。
//   - 瞬时锁：5 次退避重试，耗尽 fail-loud 抛出（API 5xx 优于数据覆写清空）；
//   - ENOENT：集合尚未创建，返回 fallback（合法缺省语义，含 exists 竞态）；
//   - 真 JSON 损坏：仍走 fallback（与 C60 jsonStore / identity 契约一致）；
//   - 写路径：tmp+rename 原子写（旧裸 writeFileSync 崩溃/锁中断会留下半截 JSON，
//     而「半截 JSON」正是下一次 readJson 走损坏 fallback 的直接来源）。
const { readFileSyncRetry, atomicWriteFileSync } = require('./fsSafe');

function readJson(file, fallback) {
  ensureDir();
  if (!fs.existsSync(file)) return fallback;
  let raw;
  try {
    raw = readFileSyncRetry(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    throw e; // 瞬时锁耗尽 / 其他 fs 故障：fail-loud，绝不静默降级
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback; // 真损坏：保持 fallback 契约
  }
}

function writeJson(file, data) {
  ensureDir();
  atomicWriteFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ---- Profiles ----
function getProfiles() {
  return readJson(PROFILES_FILE, []);
}

function saveProfiles(list) {
  writeJson(PROFILES_FILE, list);
  return list;
}

function getProfile(id) {
  return getProfiles().find((p) => p.id === id) || null;
}

function upsertProfile(profile) {
  const list = getProfiles();
  const idx = list.findIndex((p) => p.id === profile.id);
  if (idx >= 0) list[idx] = profile;
  else list.push(profile);
  saveProfiles(list);
  return profile;
}

function deleteProfile(id) {
  const list = getProfiles().filter((p) => p.id !== id);
  saveProfiles(list);
  return list;
}

// ---- Proxies ----
// 读取时透明解密（内存明文供消费点使用；落盘仅密文）
function getProxies() {
  return readJson(PROXIES_FILE, []).map(_decryptProxy);
}

// 落盘前透明加密 password → passwordEnc（不写明文）
function saveProxies(list) {
  const enc = (list || []).map(_encryptProxy);
  writeJson(PROXIES_FILE, enc);
  return list; // 返回原始（含明文），供调用方内存链路继续使用
}

// 对外接口（GET 列表）：mask 密码，避免 API 泄露明文（与 vault.getMaskedSummary 一致）
function getProxiesPublic() {
  return getProxies().map((p) => ({
    ...p,
    password: p.password ? '••••••' + (p.password.length > 2 ? p.password.slice(-2) : '') : '',
  }));
}

// ---- Tasks (workflow definitions) ----
function getTasks() {
  return readJson(TASKS_FILE, []);
}

function saveTasks(list) {
  writeJson(TASKS_FILE, list);
  return list;
}

function getTask(id) {
  return getTasks().find((t) => t.id === id) || null;
}

function upsertTask(task) {
  const list = getTasks();
  const idx = list.findIndex((t) => t.id === task.id);
  if (idx >= 0) list[idx] = task;
  else list.push(task);
  saveTasks(list);
  return task;
}

function deleteTask(id) {
  const list = getTasks().filter((t) => t.id !== id);
  saveTasks(list);
  return list;
}

module.exports = {
  getProfiles, saveProfiles, getProfile, upsertProfile, deleteProfile,
  getProxies, saveProxies, getProxiesPublic,
  getTasks, saveTasks, getTask, upsertTask, deleteTask,
};
