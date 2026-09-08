'use strict';

// CAP-O2：独立审计日志（AuditLog）。
//
// 定位：与 agent/events.js（运行时事件总线）分离的**安全审计流**——记录「谁在什么时候
// 对哪个资源做了什么」，供合规查询与导出。不参与任何业务决策（只写不读决策）。
//
// 设计约束：
//   - fail-open for logging：审计写入的任何异常绝不阻断业务请求（但绝不吞掉业务自身异常）。
//   - 有界环形：MAX_ENTRIES 上限，超出淘汰最旧，防 JSON 文件无限增长。
//   - 内存缓存 + 防抖落盘：查询/导出走内存（测试确定性），磁盘写合并（高频请求不吃 IO）。
//   - 脱敏兜底：detail 中任何疑似敏感字段（password/token/card/cvv/cookie…）一律替换，
//     上一道防线是调用方只传业务标识（name/id/count），这里防的是未来调用方手滑。

const fs = require('fs');
const path = require('path');
const { readFileSyncRetry, atomicWriteFileSync } = require('./fsSafe');

// 数据目录：C59 起统一走 dataRoot（与 identity.js 同批；一次性 legacy 迁移见 dataRoot.js）
const { dataRoot, migrateLegacyFile } = require('./dataRoot');
const DATA_DIR = dataRoot();
migrateLegacyFile('identity_audit.json');
const AUDIT_FILE = path.join(DATA_DIR, 'identity_audit.json');

const MAX_ENTRIES = 5000;
const SENSITIVE_KEY_RE = /password|passwd|secret|token|card|cvv|cvc|authorization|cookie|credential/i;

let _entries = null;
let _flushTimer = null;
// C80：读失败（瞬时锁耗尽 / 真损坏）期间禁止 flush 落盘——fail-open 只对查询与内存链生效，
// 绝不把内存 [] 覆写到磁盘（否则审计历史被静默清空，且损坏现场丢失）。
let _loadFailed = false;

function load() {
  if (_entries) return _entries;
  _loadFailed = false;
  if (!fs.existsSync(AUDIT_FILE)) { _entries = []; return _entries; }
  let raw;
  try {
    raw = readFileSyncRetry(AUDIT_FILE);
  } catch (e) {
    _loadFailed = true; // 瞬时锁耗尽等：查询/记录 fail-open（内存空），磁盘现状不动
    _entries = [];
    return _entries;
  }
  try {
    _entries = JSON.parse(raw);
    if (!Array.isArray(_entries)) _entries = [];
  } catch (e) {
    // 真损坏：先侧车保全现场（.corrupt-<ts>，供事后取证），再 fail-open
    try { fs.copyFileSync(AUDIT_FILE, AUDIT_FILE + '.corrupt-' + Date.now()); } catch (_) {}
    _loadFailed = true;
    _entries = [];
  }
  return _entries;
}

// 递归脱敏 + 截断（防大 payload 撑爆审计文件）
function redact(v, depth) {
  const d = depth || 0;
  if (d > 4) return '…';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, d + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '«redacted»' : redact(val, d + 1);
    }
    return out;
  }
  if (typeof v === 'string') return v.slice(0, 200);
  return v;
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; flush(); }, 300);
  if (_flushTimer.unref) _flushTimer.unref();
}

function flush() {
  try {
    if (!_entries) return;
    if (_loadFailed) return; // C80：读失败期间绝不落盘（防止把内存 [] 覆盖成审计历史清空）
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // C80：原子写（旧裸 writeFileSync 崩溃/锁中断留下半截 JSON → 下次 load 损坏分支）
    atomicWriteFileSync(AUDIT_FILE, JSON.stringify(_entries, null, 2), 'utf8');
  } catch (e) { /* 磁盘异常不阻断业务 */ }
}

// 唯一写入口。entry: { workspaceId, actorId, actorName, actorType, action, resourceType, resourceId, detail }
function log(entry) {
  try {
    const list = load();
    const e = {
      id: 'au_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      at: Date.now(),
      workspaceId: (entry && entry.workspaceId) || null,
      actorId: (entry && entry.actorId) || null,
      actorName: (entry && entry.actorName) || '',
      actorType: (entry && entry.actorType) || 'user', // user | api_key | local
      action: String((entry && entry.action) || 'unknown'),
      resourceType: (entry && entry.resourceType) || null,
      resourceId: (entry && entry.resourceId) || null,
      detail: redact((entry && entry.detail) || {}),
    };
    list.push(e);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    scheduleFlush();
    return e;
  } catch (err) {
    return null; // 审计失败绝不阻断业务
  }
}

// C84：共享请求审计原语。此前 auditReq 是 server/index.js 的本地 helper，
// agent/index.js（/api/ai/* 全部 mutation 面）零审计且拿不到它（require index.js 会循环）。
// 提升到 audit 模块 = 唯一事实源（C62 fsSafe 同款纪律），index.js 的 auditReq 委托到此。
// detail 只放业务标识（id/count/*Len）；敏感字段由 redact 兜底（调用方手滑是第二道防线）。
function logRequest(req, action, resourceType, resourceId, detail) {
  const u = req && req.identityUser;
  return log({
    workspaceId: u ? u.currentWorkspaceId : null,
    actorId: u ? u.id : null,
    actorName: u ? u.username : '',
    actorType: u ? (u.__apiKey ? 'api_key' : (u.status === 'local' ? 'local' : 'user')) : 'anonymous',
    action, resourceType, resourceId, detail: detail || {},
  });
}

// 查询（内存读， newest first）。opts: { workspaceId, action, resourceType, actorId, limit }
function query(opts) {
  const o = opts || {};
  let list = load().slice();
  if (o.workspaceId) list = list.filter((e) => e.workspaceId === o.workspaceId);
  if (o.action) list = list.filter((e) => e.action === o.action);
  if (o.resourceType) list = list.filter((e) => e.resourceType === o.resourceType);
  if (o.actorId) list = list.filter((e) => e.actorId === o.actorId);
  list.reverse();
  const total = list.length;
  const limit = Math.min(Number(o.limit) || 200, 1000);
  return { total, entries: list.slice(0, limit) };
}

function count() { return load().length; }

// 测试用：强制同步落盘并重置缓存（FPB_DATA_DIR 切换后必须重置内存态）
function resetForTests() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _entries = null;
  _loadFailed = false;
}

module.exports = {
  log, logRequest, query, flush, count, resetForTests,
  MAX_ENTRIES, SENSITIVE_KEY_RE, AUDIT_FILE,
};
