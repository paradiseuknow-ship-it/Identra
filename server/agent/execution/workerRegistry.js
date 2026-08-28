'use strict';

// Worker Registry（Phase 4.2）。
// 把 Worker「实体」持久化到 aiWorkers 集合，作为调度与恢复的可信来源。
// 内存中的 Worker 实例是运行态；aiWorkers 记录是权威态（跨进程/重启可见）。
//
// 设计边界（与用户既定职责一致）：
//  - 本模块只管「Worker 实体 CRUD + 状态持久化」，不调度、不执行、不碰 task。
//  - 状态迁移合法性由 workerState 校验；这里负责落库。
//  - 心跳读写也走这里（workerHeartbeat 薄封装），保证「Heartbeat 不写 execution」。

const store = require('../store');
const { STATUS, canTransition } = require('./workerState');

const COLLECTION = 'aiWorkers';

let _seq = 0;
function uid() {
  _seq += 1;
  return 'worker_' + Date.now().toString(36) + '_' + _seq.toString(36);
}

// 创建并持久化一个 Worker 实体。
// opts: { id?, type?, profileId?, capacity?, pid?, hostname? }
// 返回落库后的 worker 记录（STARTING）。
// 防重：若 id 已存在——
//  - 旧记录为 STOPPED / DEAD（终态）→ 重建（覆盖为新的 STARTING）；
//  - 否则（仍存活）→ 返回现有记录，避免重复 insert 导致 aiWorkers 堆积与状态错乱。
function create(opts) {
  opts = opts || {};
  const now = Date.now();
  const id = opts.id || uid();
  const existing = store.find(COLLECTION, id);
  if (existing) {
    // 同 id 已存在：一律重建为新的 STARTING 实体（覆盖）。
    // 理由：startWorker 代表「启动一个新的 Worker 实例」；旧记录若是残留（进程重启僵尸）
    // 或冲突，重建比复用更安全——避免把僵尸的 RUNNING 状态继承给新实例。
    const fresh = buildRecord(id, opts, now);
    store.upsert(COLLECTION, fresh);
    return fresh;
  }
  const rec = buildRecord(id, opts, now);
  store.insert(COLLECTION, rec);
  return rec;
}

function buildRecord(id, opts, now) {
  return {
    id,
    type: opts.type || 'browser_worker',
    status: STATUS.STARTING,
    pid: opts.pid != null ? opts.pid : (typeof process !== 'undefined' ? process.pid : null),
    hostname: opts.hostname || (typeof process !== 'undefined' ? (process.env.HOSTNAME || 'node') : 'node'),
    profileId: opts.profileId || null,
    capacity: opts.capacity || 1,
    currentExecutionId: null,
    currentTaskId: null,
    lastHeartbeat: now,
    startedAt: now,
    stoppedAt: null,
    metrics: { totalTasks: 0, success: 0, failed: 0 },
  };
}

function get(id) {
  return store.find(COLLECTION, id);
}

function list(filter) {
  let arr = store.read(COLLECTION, []);
  if (filter && filter.status) arr = arr.filter((w) => w.status === filter.status);
  if (filter && filter.type) arr = arr.filter((w) => w.type === filter.type);
  return arr;
}

function remove(id) {
  store.remove(COLLECTION, id);
}

// 状态迁移（带合法性校验）。返回更新后的记录或 null（非法转移）。
function transition(id, to, extra) {
  const rec = store.find(COLLECTION, id);
  if (!rec) return null;
  if (!canTransition(rec.status, to)) {
    return { error: 'illegal_transition', from: rec.status, to };
  }
  rec.status = to;
  if (to === STATUS.STOPPED) rec.stoppedAt = Date.now();
  if (extra) Object.assign(rec, extra);
  store.upsert(COLLECTION, rec);
  return rec;
}

// 更新心跳。仅改 lastHeartbeat / currentExecutionId，绝不触碰 execution 集合。
function heartbeat(id, currentExecutionId) {
  const rec = store.find(COLLECTION, id);
  if (!rec) return null;
  rec.lastHeartbeat = Date.now();
  if (currentExecutionId !== undefined) rec.currentExecutionId = currentExecutionId;
  store.upsert(COLLECTION, rec);
  return rec;
}

// 任务计数（成功/失败）。
function recordOutcome(id, ok) {
  const rec = store.find(COLLECTION, id);
  if (!rec) return null;
  rec.metrics = rec.metrics || { totalTasks: 0, success: 0, failed: 0 };
  rec.metrics.totalTasks += 1;
  if (ok) rec.metrics.success += 1; else rec.metrics.failed += 1;
  store.upsert(COLLECTION, rec);
  return rec;
}

function clear() {
  store.write(COLLECTION, []);
}

module.exports = {
  COLLECTION, create, get, list, remove, transition, heartbeat, recordOutcome, clear, uid,
};
