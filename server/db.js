'use strict';

const fs = require('fs');
const path = require('path');

// B.11：代理凭据加密落库。复用 vault 的 AES-256-GCM 透明加解密：
// 落盘只存 passwordEnc（密文），读取时解密为内存明文供消费点（browserManager/proxyChecker）使用，
// 避免明文 JSON 残留（与 vault 凭据加密策略一致）。
const vault = require('./vault');

const DATA_DIR = path.join(__dirname, '..', 'data');
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

function readJson(file, fallback) {
  ensureDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
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
