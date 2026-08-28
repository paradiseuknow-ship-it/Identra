'use strict';

// Browser Resource（Phase 4.4）。
// Browser 资源实体：持有 profileId + 资源状态 + 当前 owner + 心跳。
// **不解耦说明**：本实体不直接引用 Worker 实例（不出现 worker.browser=），
//   与 Worker 的解耦通过 BrowserResourcePool.acquire/Release 完成——
//   Worker 经 Pool 申请资源，资源记录 owner(workerId/taskId)，二者通过 id 关联而非对象引用。
//
// 职责边界：
//  - 本模块只管「Browser 资源实体 CRUD + 状态持久化」，不启动真实 Browser、不调度、不碰 Task；
//  - 状态迁移合法性由 resourceState 校验；这里负责落库 aiBrowserResources。
//  - 心跳读写也走这里，保证「心跳不写 Execution / 不写 Profile 绑定以外业务状态」。

const store = require('../../store');
const { STATUS, canTransition, isHealthy, isDead } = require('./resourceState');

const COLLECTION = 'aiBrowserResources';

let _seq = 0;
function uid() {
  _seq += 1;
  return 'br_' + Date.now().toString(36) + '_' + _seq.toString(36);
}

// 创建并持久化一个 Browser Resource 实体（CREATED）。
// opts: { id?, profileId, workerId?, capacity? }
function create(opts) {
  opts = opts || {};
  const now = Date.now();
  const id = opts.id || uid();
  const rec = {
    id,
    profileId: opts.profileId || null,
    status: STATUS.CREATED,
    owner: null, // { taskId, executionId, workerId, dispatchId }
    capacity: opts.capacity || 1,
    currentTaskId: null,
    lastHeartbeat: now,
    createdAt: now,
    closedAt: null,
    deadAt: null,
  };
  store.upsert(COLLECTION, rec); // upsert：同 id 重建
  return rec;
}

function get(id) {
  return store.find(COLLECTION, id);
}

function getByProfile(profileId) {
  return store.read(COLLECTION, []).find((r) => r.profileId === profileId) || null;
}

function list(filter) {
  let arr = store.read(COLLECTION, []);
  if (filter && filter.status) arr = arr.filter((r) => r.status === filter.status);
  if (filter && filter.profileId) arr = arr.filter((r) => r.profileId === filter.profileId);
  if (filter && filter.healthyOnly) arr = arr.filter((r) => isHealthy(r.status));
  return arr;
}

// 状态迁移（带合法性校验）。返回更新后的记录或 { error }。
function transition(id, to, extra) {
  const rec = store.find(COLLECTION, id);
  if (!rec) return { error: 'unknown resource' };
  if (!canTransition(rec.status, to)) {
    return { error: 'illegal_transition', from: rec.status, to };
  }
  rec.status = to;
  if (to === STATUS.CLOSED) rec.closedAt = Date.now();
  if (to === STATUS.DEAD) rec.deadAt = Date.now();
  if (extra) Object.assign(rec, extra);
  store.upsert(COLLECTION, rec);
  return rec;
}

// 启动：CREATED/STARTING → READY。
function markReady(id) {
  const rec = store.find(COLLECTION, id);
  if (!rec) return { error: 'unknown resource' };
  // CREATED 或 STARTING 皆可转 READY
  const target = rec.status === STATUS.CREATED ? STATUS.STARTING : rec.status;
  const step = transition(id, target);
  if (step && step.error) return step;
  return transition(id, STATUS.READY);
}

// 占用：READY/IDLE → BUSY，并记录 owner。
function markBusy(id, owner) {
  const rec = store.find(COLLECTION, id);
  if (!rec) return { error: 'unknown resource' };
  const t = transition(id, STATUS.BUSY, { owner: owner || null, currentTaskId: (owner && owner.taskId) || null });
  if (t && t.error) return t;
  return t;
}

// 释放占用：BUSY → IDLE（回到空闲可复用）。
function markIdle(id) {
  return transition(id, STATUS.IDLE, { owner: null, currentTaskId: null });
}

// 优雅退出：→ DRAINING。
function markDraining(id) {
  return transition(id, STATUS.DRAINING);
}

// 关闭：→ CLOSED（终态）。
function close(id) {
  return transition(id, STATUS.CLOSED);
}

// 死亡：→ DEAD（可重建）。
function markDead(id, reason) {
  const rec = store.find(COLLECTION, id);
  if (!rec) return { error: 'unknown resource' };
  const t = transition(id, STATUS.DEAD, { deathReason: reason || 'unknown' });
  if (t && t.error) {
    // 若当前状态不可直接转 DEAD（如已 CLOSED），则强制置 DEAD 以便重建标记
    rec.status = STATUS.DEAD;
    rec.deadAt = Date.now();
    rec.deathReason = reason || 'unknown';
    store.upsert(COLLECTION, rec);
    return rec;
  }
  return t;
}

// 心跳：仅更新 lastHeartbeat，绝不触碰 owner/execution。
function heartbeat(id) {
  const rec = store.find(COLLECTION, id);
  if (!rec) return null;
  rec.lastHeartbeat = Date.now();
  store.upsert(COLLECTION, rec);
  return rec;
}

// 进程内恢复用：扫描超时（无心跳）且健康的资源 → 判定 DEAD。
function scanDead(now, timeoutMs) {
  now = now || Date.now();
  timeoutMs = timeoutMs || 30000;
  const dead = [];
  for (const r of store.read(COLLECTION, [])) {
    if (isDead(r.status) || r.status === STATUS.CLOSED) continue;
    if (now - (r.lastHeartbeat || 0) > timeoutMs) {
      const t = markDead(r.id, 'heartbeat_timeout');
      if (t && !t.error) dead.push({ id: r.id, profileId: r.profileId });
    }
  }
  return dead;
}

function clear() {
  store.write(COLLECTION, []);
}

// 删除资源记录（重建时移除旧 DEAD/CLOSED 实体，避免 getByProfile 命中残留）。
function remove(id) {
  store.remove(COLLECTION, id);
}

module.exports = {
  COLLECTION, create, get, getByProfile, list, transition, markReady, markBusy, markIdle,
  markDraining, close, markDead, heartbeat, scanDead, clear, remove, uid,
};
