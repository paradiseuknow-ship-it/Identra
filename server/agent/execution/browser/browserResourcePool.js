'use strict';

// Browser Resource Pool（Phase 4.4 编排）。
// 按 profileId 提供 / 绑定 BrowserResource，并负责 Profile→Browser 一一绑定的占用控制。
//
// 严格职责边界（用户既定）：
//   Scheduler → WorkerManager → Worker → BrowserResourcePool → (Profile + BrowserResource) → Runtime
//  - Pool 不直接持有 Worker 引用；Worker 经 acquireResource/releaseResource 与资源交互（id 关联）；
//  - RESOURCE_BUSY 在 Pool 层阻断（经 profileBinding.acquire），先于 Browser 启动；
//  - 异常释放幂等：acquire/release 对所有终态（SUCCESS/FAILED/CANCEL/DEAD/CRASH/RESTART）安全。
//
// 注意：本环境无真实 Browser（沙箱无 chromium）。Pool 管理「资源实体状态」而非真实进程，
//   真实 launch 仍由 runtime.ensureBrowser 负责；本层为调度层的资源权威与互斥闸门。

const profileBinding = require('./profileBinding');
const browserResource = require('./browserResource');
const { STATUS } = require('./resourceState');

// 为一个任务申请某 Profile 的 Browser 资源。
// owner: { taskId, executionId?, workerId?, dispatchId? }
// 返回 { ok, resource?, reason? }。
//   - 同 Profile 已被其他 task 占用 → { ok:false, reason:'RESOURCE_BUSY' }（资源层阻断）
//   - 成功 → { ok:true, resource }（资源 BUSY + Profile 绑定）
function acquireResource(profileId, owner) {
  if (!profileId) return { ok: false, reason: 'profileId required' };
  owner = owner || {};

  // 1) 资源层占锁（最先阻断，不等 Browser 报错）
  const bind = profileBinding.acquire(profileId, owner);
  if (!bind.ok) return { ok: false, reason: bind.reason }; // RESOURCE_BUSY

  // 2) 取/建 BrowserResource 实体（按 profileId 一一绑定）
  let res = browserResource.getByProfile(profileId);
  if (!res) {
    res = browserResource.create({ profileId, capacity: 1 });
  }
  // 推进到 BUSY（若处于 CREATED/STARTING/READY/IDLE）
  if (res.status === STATUS.READY || res.status === STATUS.IDLE || res.status === STATUS.CREATED || res.status === STATUS.STARTING) {
    const busy = browserResource.markBusy(res.id, {
      taskId: owner.taskId, executionId: owner.executionId, workerId: owner.workerId, dispatchId: owner.dispatchId,
    });
    if (busy && busy.error) {
      // 状态非法（如 DEAD/CLOSED/DRAINING）→ 释放刚刚占的 Profile 锁，避免幽灵锁
      profileBinding.release(profileId, owner);
      return { ok: false, reason: 'BROWSER_NOT_AVAILABLE: ' + busy.error };
    }
    res = busy;
  } else if (res.status === STATUS.BUSY) {
    // 已被同 task 复用（幂等）；若被不同 task 占用则不应发生（Profile 锁已挡住）
    if (res.owner && res.owner.taskId !== owner.taskId) {
      profileBinding.release(profileId, owner);
      return { ok: false, reason: 'RESOURCE_BUSY: browser already busy by task ' + res.owner.taskId };
    }
  } else {
    // DEAD / CLOSED / DRAINING → 资源不可用
    profileBinding.release(profileId, owner);
    return { ok: false, reason: 'BROWSER_NOT_AVAILABLE: status=' + res.status };
  }

  return { ok: true, resource: res, binding: bind.binding, reused: !!bind.reused };
}

// 释放资源（幂等）。无论成功/失败/取消/死亡，都安全解除：
//   Profile 绑定 + BrowserResource 占坑（BUSY→IDLE）+ 清 owner。
// 返回 { ok, released?, reason? }。
function releaseResource(profileId, owner) {
  if (!profileId) return { ok: false, reason: 'profileId required' };
  // 1) Profile 绑定释放（按 owner 校验，非持有者忽略）
  const rel = profileBinding.release(profileId, owner);

  // 2) BrowserResource 占坑解除（BUSY → IDLE，可复用）
  const res = browserResource.getByProfile(profileId);
  if (res && res.status === STATUS.BUSY) {
    browserResource.markIdle(res.id);
  }
  // 3) 心跳刷新（标记资源仍健康空闲）
  if (res) browserResource.heartbeat(res.id);
  return { ok: true, released: rel.released !== false, reason: rel.reason };
}

// 强制释放（Recovery 用：Worker/Browser 死亡清理，避免幽灵锁）。
function forceReleaseResource(profileId, reason) {
  const rel = profileBinding.forceRelease(profileId, reason);
  const res = browserResource.getByProfile(profileId);
  if (res && res.status === STATUS.BUSY) browserResource.markIdle(res.id);
  return { ok: true, released: rel.released, forced: !!rel.forced };
}

// 是否某 Profile 当前可用（未被占用）。
function isAvailable(profileId) {
  return !profileBinding.isBound(profileId);
}

// 取某 Profile 的健康资源（READY/IDLE）用于复用查询。
function getHealthyResource(profileId) {
  return browserResource.getByProfile(profileId);
}

function listResources(filter) {
  return browserResource.list(filter);
}

function listBindings(filter) {
  return profileBinding.list(filter);
}

// 供 Worker 启动时预建（非必须）：为给定 profiles 登记 CREATED 资源。
function preregister(profileIds) {
  const created = [];
  for (const p of (profileIds || [])) {
    if (!browserResource.getByProfile(p)) created.push(browserResource.create({ profileId: p, capacity: 1 }));
    else created.push(browserResource.getByProfile(p));
  }
  return created;
}

module.exports = {
  acquireResource, releaseResource, forceReleaseResource, isAvailable,
  getHealthyResource, listResources, listBindings, preregister,
};
