'use strict';

// JsonStore：StoreInterface 的 JSON 文件实现。
// 同步原子写（临时文件 + rename），与项目既有 db/vault 风格一致。
// 单进程下足够；多 Worker 场景由上层（TaskManager 唯一写入口 + 状态限频）兜底。

const fs = require('fs');
const path = require('path');
const { StoreInterface } = require('./store.interface');

const FILES = {
  aiTasks: 'aiTasks.json',
  aiSteps: 'aiSteps.json',
  aiAttempts: 'aiAttempts.json',
  aiRepairs: 'aiRepairs.json',
  aiExecutions: 'aiExecutions.json',
  aiCheckpoints: 'aiCheckpoints.json',
  aiEvents: 'aiEvents.json',
  aiCredentials: 'aiCredentials.json',
  aiKnowledge: 'aiKnowledge.json',
  aiQueue: 'aiQueue.json',
  aiSessions: 'aiSessions.json',
  aiCredentialUsage: 'aiCredentialUsage.json',
  aiFailureSnapshots: 'aiFailureSnapshots.json',
  aiRepairAttempts: 'aiRepairAttempts.json',
  aiSiteMemory: 'aiSiteMemory.json',
  aiElementMemory: 'aiElementMemory.json',
  aiFlowMemory: 'aiFlowMemory.json',
  aiFailureKnowledge: 'aiFailureKnowledge.json',
  aiProfileScores: 'aiProfileScores.json',
  aiDecisionCache: 'aiDecisionCache.json',
  aiIntelligenceEvaluations: 'aiIntelligenceEvaluations.json',
  aiDispatchExecutions: 'aiDispatchExecutions.json',
  aiWorkers: 'aiWorkers.json',
  aiBrowserResources: 'aiBrowserResources.json',
  aiProfileBindings: 'aiProfileBindings.json',
  aiPlannerEvidence: 'aiPlannerEvidence.json',
};

const EVENT_MAX = 500;

class JsonStore extends StoreInterface {
  constructor(dataDir) {
    super();
    this.dir = dataDir;
  }

  _file(name) {
    if (!FILES[name]) throw new Error('未知 AI 集合: ' + name);
    return path.join(this.dir, FILES[name]);
  }

  _ensure() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  // 读取并强制返回深拷贝：任何调用方拿到的都是隔离副本，
  // 就地修改不会影响下一次 read（防御共享引用污染，Phase 4 多 Worker 前的必要地基）。
  _readClone(name, fallback) {
    const raw = this.read(name, fallback);
    if (!Array.isArray(raw) && typeof raw !== 'object') return raw;
    try { return structuredClone(raw); } catch (e) { return JSON.parse(JSON.stringify(raw)); }
  }

  read(name, fallback = []) {
    const f = this._file(name);
    this._ensure();
    if (!fs.existsSync(f)) return Array.isArray(fallback) ? fallback.slice() : fallback;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return Array.isArray(fallback) ? fallback.slice() : fallback; }
    // 返回深拷贝，避免调用方改动污染后续读取
    try { return structuredClone(parsed); } catch (e) { return JSON.parse(JSON.stringify(parsed)); }
  }

  write(name, data) {
    const f = this._file(name);
    this._ensure();
    const tmp = f + '.tmp';
    const payload = JSON.stringify(data, null, 2);
    // Phase 5.8 加固（Benchmark 暴露的 Windows EPERM/EBUSY 竞态）：
    // 杀毒软件 / 文件索引器会短暂锁定目标文件，导致 rename 偶发失败。
    // 这里对 write+rename 做有限次数退避重试，避免瞬时锁造成整进程崩溃。
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.writeFileSync(tmp, payload, 'utf8');
        try { fs.renameSync(tmp, f); return; }
        catch (re) {
          // 某些情况下 .tmp 残留会阻碍下次 rename，先清理再重试
          if (attempt === 4) throw re;
          try { fs.unlinkSync(tmp); } catch (_) {}
          lastErr = re;
          const code = re && re.code;
          if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw re;
          const t = (attempt + 1) * 20;
          Atomics.wait ? null : null; // no-op，保持同步语义
          const end = Date.now() + t; while (Date.now() < end) { /* busy-wait 微退避 */ }
        }
      } catch (e) {
        lastErr = e;
        const code = e && e.code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
        const end = Date.now() + (attempt + 1) * 20; while (Date.now() < end) {}
      }
    }
    if (lastErr) throw lastErr;
  }

  find(name, id) {
    return this._readClone(name, []).find((x) => x && x.id === id) || null;
  }

  findWhere(name, pred) {
    return this._readClone(name, []).filter((x) => x && pred(x));
  }

  insert(name, obj) {
    const arr = this.read(name, []);
    arr.push(obj);
    this.write(name, arr);
    return obj;
  }

  upsert(name, obj) {
    const arr = this.read(name, []);
    const i = arr.findIndex((x) => x && x.id === obj.id);
    if (i >= 0) arr[i] = obj;
    else arr.push(obj);
    this.write(name, arr);
    return obj;
  }

  remove(name, id) {
    this.write(name, this.read(name, []).filter((x) => x && x.id !== id));
  }

  delete(name, id) { return this.remove(name, id); }

  // 清空集合（name 缺省则全部）。测试/重置用。
  clear(name) {
    if (name) { this.write(name, []); return true; }
    for (const n of Object.keys(FILES)) this.write(n, []);
    return true;
  }

  update(name, id, patch) {
    const arr = this.read(name, []);
    const i = arr.findIndex((x) => x && x.id === id);
    if (i < 0) return null;
    arr[i] = Object.assign({}, arr[i], patch);
    this.write(name, arr);
    return this._readClone(name, [])[i] || arr[i];
  }

  transaction(fn) {
    // JSON 单进程同步，无真正事务；回调内操作即时落盘，异常不回滚（保持与原语义一致）。
    return fn(this);
  }

  trimCollection(name, keep) {
    const arr = this.read(name, []);
    if (arr.length > keep) this.write(name, arr.slice(arr.length - keep));
  }

  appendEvent(evt) {
    const arr = this.read('aiEvents', []);
    arr.push(evt);
    if (arr.length > EVENT_MAX) arr.splice(0, arr.length - EVENT_MAX);
    this.write('aiEvents', arr);
    return evt;
  }

  eventsSince(lastEventId) {
    const arr = this.read('aiEvents', []);
    const idx = arr.findIndex((x) => x.eventId === lastEventId);
    return idx >= 0 ? arr.slice(idx + 1) : arr;
  }
}

module.exports = { JsonStore, FILES, EVENT_MAX };
