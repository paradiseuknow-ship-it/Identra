'use strict';

// Profile Binding（Phase 4.4）。
// Profile → Browser 一一绑定：同一 Profile 默认不能被两个任务同时占用。
// RESOURCE_BUSY 必须在**资源层**阻断（此时 Browser 尚未启动），而不是等 Browser 报错。
//
// 设计边界（用户既定）：
//  - 本模块是「Profile 占用锁」的权威来源，持久化 aiProfileBindings（跨重启可见）；
//  - 与既有 lock.js（进程内存、按 executionId）不同：本层按 profileId 持有、按 owner 校验释放；
//  - 不启动 Browser、不碰 Worker、不改 Task 状态；只管「Profile 是否被占用」。
//
// 幂等：无论 Task SUCCESS / FAILED / CANCEL / Worker DEAD / Browser crash / Node restart，
//   release 都能安全解除绑定（校验 owner，非持有者忽略）。

const store = require('../../store');

const COLLECTION = 'aiProfileBindings';

// 尝试占用 Profile。
// owner: { taskId, executionId?, workerId?, dispatchId? }
// 返回 { ok, reason? , binding? }。已占用（非同一 owner）→ { ok:false, reason:'RESOURCE_BUSY' }。
function acquire(profileId, owner) {
  if (!profileId) return { ok: false, reason: 'profileId required' };
  owner = owner || {};
  const existing = store.find(COLLECTION, profileId);
  if (existing && existing.releasedAt == null) {
    // 已绑定且未释放
    if (existing.taskId === owner.taskId) {
      // 同一 task 重复 acquire：幂等返回已持有
      return { ok: true, binding: existing, reused: true };
    }
    return { ok: false, reason: 'RESOURCE_BUSY: profile ' + profileId + ' 已被 task ' + existing.taskId + ' 占用' };
  }
  const binding = {
    id: profileId,                 // 以 profileId 为主键（一一绑定）
    profileId,
    taskId: owner.taskId || null,
    executionId: owner.executionId || null,
    workerId: owner.workerId || null,
    dispatchId: owner.dispatchId || null,
    acquiredAt: Date.now(),
    releasedAt: null,
    lastHeartbeat: Date.now(),
  };
  store.upsert(COLLECTION, binding);
  return { ok: true, binding, reused: false };
}

// 释放 Profile 绑定。校验 owner.taskId 匹配（非持有者忽略），保证幂等安全。
// 返回 { ok, released?, reason? }。
function release(profileId, owner) {
  const existing = store.find(COLLECTION, profileId);
  if (!existing) return { ok: true, released: false, reason: 'no binding' }; // 无绑定也算成功（幂等）
  if (existing.releasedAt != null) return { ok: true, released: false, reason: 'already released' }; // 已释放幂等
  if (owner && owner.taskId && existing.taskId !== owner.taskId) {
    return { ok: false, reason: 'owner mismatch: binding held by task ' + existing.taskId }; // 非持有者，忽略
  }
  existing.releasedAt = Date.now();
  store.upsert(COLLECTION, existing);
  return { ok: true, released: true };
}

// 是否已被占用（未释放）。
function isBound(profileId) {
  const b = store.find(COLLECTION, profileId);
  return !!(b && b.releasedAt == null);
}

// 当前持有者（未释放）。
function getOwner(profileId) {
  const b = store.find(COLLECTION, profileId);
  if (!b || b.releasedAt != null) return null;
  return { taskId: b.taskId, executionId: b.executionId, workerId: b.workerId, dispatchId: b.dispatchId };
}

function get(profileId) {
  return store.find(COLLECTION, profileId);
}

function list(filter) {
  let arr = store.read(COLLECTION, []);
  if (filter && filter.activeOnly) arr = arr.filter((b) => b.releasedAt == null);
  return arr;
}

// 心跳：仅更新 lastHeartbeat（绝不写 Browser/Execution）。
function heartbeat(profileId, owner) {
  const b = store.find(COLLECTION, profileId);
  if (!b) return null;
  if (owner && owner.taskId && b.taskId !== owner.taskId) return null; // 非持有者忽略
  b.lastHeartbeat = Date.now();
  store.upsert(COLLECTION, b);
  return b;
}

// 强制解除（Recovery 用：Worker/Browser 死亡时清理残留绑定，避免幽灵锁）。
// 不校验 owner（因为持有者已死），但记录被强解原因。
function forceRelease(profileId, reason) {
  const b = store.find(COLLECTION, profileId);
  if (!b) return { ok: true, released: false, reason: 'no binding' };
  if (b.releasedAt != null) return { ok: true, released: false, reason: 'already released' };
  b.releasedAt = Date.now();
  b.forceReleased = true;
  b.forceReleaseReason = reason || 'recovery';
  store.upsert(COLLECTION, b);
  return { ok: true, released: true, forced: true };
}

function clear() {
  store.write(COLLECTION, []);
}

module.exports = {
  COLLECTION, acquire, release, isBound, getOwner, get, list, heartbeat, forceRelease, clear,
};
