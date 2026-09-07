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

// 数据目录：C59 起统一走 dataRoot（与 identity.js 同批；一次性 legacy 迁移见 dataRoot.js）
const { dataRoot, migrateLegacyFile } = require('./dataRoot');
const DATA_DIR = dataRoot();
migrateLegacyFile('identity_audit.json');
const AUDIT_FILE = path.join(DATA_DIR, 'identity_audit.json');

const MAX_ENTRIES = 5000;
const SENSITIVE_KEY_RE = /password|passwd|secret|token|card|cvv|cvc|authorization|cookie|credential/i;

let _entries = null;
let _flushTimer = null;

function load() {
  if (_entries) return _entries;
  try {
    _entries = fs.existsSync(AUDIT_FILE) ? JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')) : [];
    if (!Array.isArray(_entries)) _entries = [];
  } catch (e) {
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
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(_entries, null, 2), 'utf8');
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
}

module.exports = {
  log, query, flush, count, resetForTests,
  MAX_ENTRIES, SENSITIVE_KEY_RE, AUDIT_FILE,
};
