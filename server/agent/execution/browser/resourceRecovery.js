'use strict';

// Resource Recovery（Phase 4.4）。
// 区分三类故障并幂等恢复，避免幽灵锁与重复执行：
//
//   Worker DEAD  + Browser healthy → 释放 Worker assignment，Browser 可重绑（重建 Worker）
//   Browser DEAD + Worker healthy  → 标记 Browser DEAD，释放其占用的 Profile 锁，Worker 任务需重建 Browser
//   Profile LOCKED（不可抢占）     → 保持 QUEUED，等待持有者释放（不强行抢占）
//
// 同时处理 Node restart 残留：启动时扫描 READY/IDLE 超时无心跳资源 → 重置；
//   扫描未释放的 Profile 绑定但对应 task 已不存在/已终态 → 解除（防幽灵锁）。

const profileBinding = require('./profileBinding');
const browserResource = require('./browserResource');
const { STATUS } = require('./resourceState');
const store = require('../../store');

const DEFAULT_HEARTBEAT_TIMEOUT = 30000;

// 扫描并恢复。返回 { actions: [...], summary }。
// ctx: { now, heartbeatTimeoutMs, taskExists(id), taskIsTerminal(id) }
function recover(ctx) {
  ctx = ctx || {};
  const now = ctx.now || Date.now();
  const timeout = ctx.heartbeatTimeoutMs || DEFAULT_HEARTBEAT_TIMEOUT;
  const actions = [];

  // 1) Browser 资源心跳超时 → DEAD
  const deadResources = browserResource.scanDead(now, timeout);
  for (const d of deadResources) {
    actions.push({ type: 'browser.dead', profileId: d.profileId, resourceId: d.id, at: now });
    // 释放该 Profile 绑定（持有者已死）—— 但保留 task 记录供上层决策重排
    const b = profileBinding.get(d.profileId);
    if (b && b.releasedAt == null) {
      profileBinding.forceRelease(d.profileId, 'browser_dead');
      actions.push({ type: 'profile.unbound', profileId: d.profileId, reason: 'browser_dead', at: now });
    }
  }

  // 2) 残留 Profile 绑定清理（幽灵锁）：绑定持有者 task 已不存在或已终态
  for (const b of profileBinding.list({ activeOnly: true })) {
    const taskId = b.taskId;
    let stale = false;
    if (!taskId) stale = true;
    else if (ctx.taskExists && !ctx.taskExists(taskId)) stale = true;
    else if (ctx.taskIsTerminal && ctx.taskIsTerminal(taskId)) stale = true;
    if (stale) {
      profileBinding.forceRelease(b.profileId, 'stale_binding');
      actions.push({ type: 'profile.unbound', profileId: b.profileId, reason: 'stale_binding', at: now });
    }
  }

  // 3) 健康资源（READY/IDLE）但心跳超时（Node 重启残留）→ 重置 lastHeartbeat 视为存活
  for (const r of browserResource.list({ healthyOnly: true })) {
    if (now - (r.lastHeartbeat || 0) > timeout) {
      browserResource.heartbeat(r.id); // 重启后视为刚活，避免误判 DEAD
      actions.push({ type: 'resource.heartbeat_reset', resourceId: r.id, profileId: r.profileId, at: now });
    }
  }

  return { actions, summary: summarize() };
}

// 针对单个 Browser DEAD 的恢复：标记 DEAD 已做，提供「重建」入口（新建 CREATED 资源复用 profileId）。
// 同时释放该 Profile 的绑定（旧 Browser 已死，锁必须让出，避免幽灵锁）；
// 原 task 经 Recovery 重排后会以**同一 taskId** 重新 acquire（幂等复用），故不存在重复执行。
function rebuildBrowser(profileId) {
  // 移除旧资源实体（DEAD/CLOSED 残留），再新建 CREATED（同 profileId 重建）
  const old = browserResource.getByProfile(profileId);
  if (old) browserResource.remove(old.id);
  const fresh = browserResource.create({ profileId, capacity: 1 });
  // 释放 Profile 绑定（强制，因旧 Browser 死亡；原 task 重派时同 taskId 幂等复用）
  profileBinding.forceRelease(profileId, 'browser_rebuilt');
  return fresh;
}

// 针对单个 Worker DEAD 的恢复：Browser 健康 → 仅释放 Worker assignment（由 WorkerManager 处理），
//   本层确保 Profile 锁在 task 仍活跃时保持（不抢占），Browser 可重绑新 Worker。
function onWorkerDead(workerId) {
  // 找出该 Worker 占用的 Profile 绑定（若有）
  const bindings = profileBinding.list({ activeOnly: true }).filter((b) => b.workerId === workerId);
  // 注意：不强制释放 Profile 锁 —— 因为 task 仍应通过 Recovery 重排，锁保持可防重复执行。
  // 仅记录，实际释放由 task 终态/重建流程决定。
  return { workerId, bindings: bindings.map((b) => ({ profileId: b.profileId, taskId: b.taskId })) };
}

function summarize() {
  return {
    resources: {
      total: browserResource.list().length,
      busy: browserResource.list({ status: STATUS.BUSY }).length,
      ready: browserResource.list({ status: STATUS.READY }).length,
      idle: browserResource.list({ status: STATUS.IDLE }).length,
      dead: browserResource.list({ status: STATUS.DEAD }).length,
      closed: browserResource.list({ status: STATUS.CLOSED }).length,
    },
    bindings: {
      active: profileBinding.list({ activeOnly: true }).length,
      released: profileBinding.list().filter((b) => b.releasedAt != null).length,
    },
  };
}

module.exports = { recover, rebuildBrowser, onWorkerDead, summarize, DEFAULT_HEARTBEAT_TIMEOUT };
