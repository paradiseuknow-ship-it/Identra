'use strict';

// SqliteStore：StoreInterface 的 SQLite 实现（零依赖，使用 Node 22 内置 node:sqlite）。
// 设计原则：
//  1. 业务层零 SQL —— 所有访问走 StoreInterface 统一方法。
//  2. 同步 API —— better-sqlite3 / node:sqlite 同步语义，不改 Agent 层调用风格（无 await 污染）。
//  3. 集合隔离 + 唯一键下沉 —— 通用表 ai_store(name, id, doc)，PRIMARY KEY(name, id) 强制唯一。
//  4. 返回强制 structuredClone —— 与 JsonStore 一致，防御共享引用污染。
//  5. WAL 模式 + 事务化写入。

const { StoreInterface } = require('./store.interface');

const EVENT_MAX = 500;

class SqliteStore extends StoreInterface {
  constructor(dbPath) {
    super();
    // 延迟初始化，允许 new SqliteStore() 后再 open。
    this._db = null;
    this._dbPath = dbPath || ':memory:';
  }

  // 打开连接（幂等）。测试可传 ':memory:'。
  open(dbPath) {
    if (this._db) return this._db;
    const path = dbPath || this._dbPath || ':memory:';
    const sqlite = require('node:sqlite');
    const { DatabaseSync } = sqlite;
    const isFile = path !== ':memory:';
    if (isFile) {
      const fs = require('fs');
      const dir = require('path').dirname(path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    const db = new DatabaseSync(path);
    // WAL 模式：并发读 + 单写事务
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`CREATE TABLE IF NOT EXISTS ai_store (
      name TEXT NOT NULL,
      id   TEXT NOT NULL,
      doc  TEXT NOT NULL,
      PRIMARY KEY (name, id)
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS ai_events (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId  TEXT NOT NULL,
      type     TEXT NOT NULL,
      payload  TEXT NOT NULL,
      ts       INTEGER NOT NULL
    );`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_events_eventId ON ai_events(eventId);`);
    this._db = db;
    this._dbPath = path;
    return db;
  }

  _dbh() {
    if (!this._db) this.open();
    return this._db;
  }

  _clone(obj) {
    if (obj === undefined || obj === null) return obj;
    if (typeof obj !== 'object') return obj;
    try { return structuredClone(obj); } catch (e) { return JSON.parse(JSON.stringify(obj)); }
  }

  _rowToObj(row) {
    if (!row) return null;
    try { return JSON.parse(row.doc); } catch (e) { return null; }
  }

  read(name, fallback = []) {
    // aiEvents 存储在独立 ai_events 表（支持增量 eventsSince），但 read 契约需返回事件数组，
    // 与 JsonStore（aiEvents.json 数组）保持一致。
    if (name === 'aiEvents') {
      const db = this._dbh();
      const rows = db.prepare('SELECT * FROM ai_events ORDER BY seq ASC').all();
      const arr = rows.map(normalizeEvent);
      return this._clone(arr.length ? arr : (Array.isArray(fallback) ? [] : fallback));
    }
    const db = this._dbh();
    const rows = db.prepare('SELECT doc FROM ai_store WHERE name = ? ORDER BY rowid').all(name);
    const arr = rows.map((r) => this._rowToObj(r));
    // 返回深拷贝
    return this._clone(arr.length ? arr : (Array.isArray(fallback) ? [] : fallback));
  }

  write(name, data) {
    const db = this._dbh();
    const tx = db.prepare('INSERT INTO ai_store (name, id, doc) VALUES (?, ?, ?) '
      + 'ON CONFLICT(name, id) DO UPDATE SET doc = excluded.doc');
    this._dbh().exec('BEGIN');
    try {
      db.prepare('DELETE FROM ai_store WHERE name = ?').run(name);
      const put = db.prepare('INSERT INTO ai_store (name, id, doc) VALUES (?, ?, ?)');
      for (const obj of data) {
        if (!obj || obj.id == null) continue;
        put.run(name, String(obj.id), JSON.stringify(obj));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return data;
  }

  find(name, id) {
    const db = this._dbh();
    const row = db.prepare('SELECT doc FROM ai_store WHERE name = ? AND id = ?').get(name, String(id));
    return this._clone(this._rowToObj(row));
  }

  findWhere(name, pred) {
    const all = this.read(name, []);
    const out = all.filter((x) => x && pred(x));
    return this._clone(out);
  }

  insert(name, obj) {
    if (!obj) throw new Error('insert 需要 obj');
    // 语义对齐 JsonStore：缺失 id 时自动补 id（JsonStore 直接 push，不强制 id）。
    // 避免「sqlite 抛错 / json 静默通过」的双后端行为不一致（B.9）。
    let id = obj.id;
    if (id == null) {
      id = 'auto_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
      obj = Object.assign({}, obj, { id });
    }
    const db = this._dbh();
    db.prepare('INSERT INTO ai_store (name, id, doc) VALUES (?, ?, ?)').run(name, String(id), JSON.stringify(obj));
    return this._clone(obj);
  }

  upsert(name, obj) {
    if (!obj) throw new Error('upsert 需要 obj');
    // 语义对齐 JsonStore：缺失 id 时自动补 id（与 insert 一致）。
    let id = obj.id;
    if (id == null) {
      id = 'auto_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
      obj = Object.assign({}, obj, { id });
    }
    const db = this._dbh();
    db.prepare('INSERT INTO ai_store (name, id, doc) VALUES (?, ?, ?) '
      + 'ON CONFLICT(name, id) DO UPDATE SET doc = excluded.doc').run(name, String(id), JSON.stringify(obj));
    return this._clone(obj);
  }

  update(name, id, patch) {
    const db = this._dbh();
    const existing = this._rowToObj(db.prepare('SELECT doc FROM ai_store WHERE name = ? AND id = ?').get(name, String(id)));
    if (!existing) return null;
    const merged = Object.assign({}, existing, patch);
    db.prepare('INSERT INTO ai_store (name, id, doc) VALUES (?, ?, ?) '
      + 'ON CONFLICT(name, id) DO UPDATE SET doc = excluded.doc').run(name, String(id), JSON.stringify(merged));
    return this._clone(merged);
  }

  remove(name, id) {
    const db = this._dbh();
    db.prepare('DELETE FROM ai_store WHERE name = ? AND id = ?').run(name, String(id));
    return true;
  }

  delete(name, id) { return this.remove(name, id); }

  transaction(fn) {
    const db = this._dbh();
    db.exec('BEGIN');
    try {
      const result = fn(this);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  trimCollection(name, keep) {
    const db = this._dbh();
    const count = db.prepare('SELECT COUNT(*) AS c FROM ai_store WHERE name = ?').get(name).c;
    if (count > keep) {
      // 按 rowid 保留最近 keep 条（rowid 近似插入顺序）
      db.prepare(`DELETE FROM ai_store WHERE name = ? AND rowid IN (
        SELECT rowid FROM ai_store WHERE name = ? ORDER BY rowid ASC LIMIT ?
      )`).run(name, name, count - keep);
    }
    return true;
  }

  appendEvent(evt) {
    const db = this._dbh();
    const eventId = evt.eventId || ('evt_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
    const ts = evt.ts || evt.timestamp || Date.now();
    // 完整保留原始事件字段（taskId/executionId/stepId/attemptId/type/payload/timestamp），
    // 与 JsonStore 存储原 evt 对象保持一致；eventId/type 单独列供索引增量。
    const e = Object.assign({}, evt, { eventId, ts });
    const payloadJson = JSON.stringify(e);
    db.prepare('INSERT INTO ai_events (eventId, type, payload, ts) VALUES (?, ?, ?, ?)').run(
      eventId, e.type, payloadJson, ts);
    // 仅保留最近 EVENT_MAX
    const count = db.prepare('SELECT COUNT(*) AS c FROM ai_events').get().c;
    if (count > EVENT_MAX) {
      db.prepare('DELETE FROM ai_events WHERE seq IN (SELECT seq FROM ai_events ORDER BY seq ASC LIMIT ?)').run(count - EVENT_MAX);
    }
    return e;
  }

  eventsSince(lastEventId) {
    const db = this._dbh();
    if (!lastEventId) return db.prepare('SELECT * FROM ai_events ORDER BY seq ASC').all().map(normalizeEvent);
    const row = db.prepare('SELECT seq FROM ai_events WHERE eventId = ?').get(lastEventId);
    if (!row) return db.prepare('SELECT * FROM ai_events ORDER BY seq ASC').all().map(normalizeEvent);
    return db.prepare('SELECT * FROM ai_events WHERE seq > ? ORDER BY seq ASC').all(row.seq).map(normalizeEvent);
  }

  // 列出全部集合名（供 migration 枚举）。
  listCollections() {
    const db = this._dbh();
    const rows = db.prepare('SELECT DISTINCT name FROM ai_store').all();
    return rows.map((r) => r.name);
  }

  // 清空（测试用）。
  clear(name) {
    const db = this._dbh();
    if (name) db.prepare('DELETE FROM ai_store WHERE name = ?').run(name);
    else { db.prepare('DELETE FROM ai_store').run(); db.prepare('DELETE FROM ai_events').run(); }
    return true;
  }

  close() {
    if (this._db) { try { this._db.close(); } catch (e) {} this._db = null; }
  }
}

function normalizeEvent(row) {
  if (!row) return row;
  // payload 列存的是完整 evt 的 JSON（含 taskId/type/payload/timestamp 等），
  // 直接解析还原，与 JsonStore 返回原始 evt 对象保持一致。
  if (typeof row.payload === 'string') {
    try { return JSON.parse(row.payload); } catch (e) { return { eventId: row.eventId, type: row.type, ts: row.ts }; }
  }
  return row.payload;
}

module.exports = { SqliteStore, EVENT_MAX };
