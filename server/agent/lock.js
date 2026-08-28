'use strict';

// Resource Lock：Profile / Browser / Execution 级别的互斥。
// 同一资源（profileId）同一时间只允许一个 active Execution 持有锁。
// 锁在进程内存中维护；进程重启后锁自然释放，由 Recovery Manager 重新获取。

const locks = new Map(); // resourceKey -> { executionId, taskId, acquiredAt, mode, ttlMs }

// 锁默认存活期（B.12）：active 锁超过此时长未释放自动失效，避免进程内异常绕过
// releaseAllForExecution 导致锁残留 → 同 profile 永久 RESOURCE_BUSY。
// paused 锁（人工介入期间有意持有）不生效 TTL，由 resume/cancel 显式释放。
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟

function resourceKeyForProfile(profileId) {
  return 'profile:' + profileId;
}

function resourceKeyForBrowser(profileId) {
  return 'browser:' + profileId;
}

// 尝试获取锁。mode: 'active' | 'paused'（paused 表示人工介入期间仍持有）
// opts.ttlMs: active 锁存活期（默认 DEFAULT_TTL_MS），过期自动失效；paused 锁忽略 TTL。
// 返回 { ok, reason?, expired? }
function acquire(key, owner, opts) {
  const cur = locks.get(key);
  // 过期 active 锁视为已释放（B.12 自动失效）
  if (cur && cur.mode === 'active' && isExpired(key)) {
    locks.delete(key);
  } else if (cur && cur.mode === 'active') {
    return { ok: false, reason: `RESOURCE_BUSY: ${key} 已被 execution ${cur.executionId} 占用` };
  }
  const ttlMs = (opts && opts.ttlMs) || DEFAULT_TTL_MS;
  locks.set(key, {
    executionId: owner.executionId,
    taskId: owner.taskId,
    acquiredAt: Date.now(),
    mode: owner.mode || 'active',
    ttlMs: owner.mode === 'paused' ? 0 : ttlMs, // paused 锁不自动过期
  });
  return { ok: true };
}

// 判断 key 的 active 锁是否已过期（paused 锁返回 false）
function isExpired(key, now) {
  const cur = locks.get(key);
  if (!cur) return true;
  if (cur.mode !== 'active') return false;
  if (!cur.ttlMs) return false; // 无 TTL（如 paused 或显式 0）不失效
  const t = now || Date.now();
  return (t - cur.acquiredAt) > cur.ttlMs;
}

// 主动清理所有过期 active 锁（可由定时任务或 acquire 前调用）
function pruneExpired(now) {
  const t = now || Date.now();
  let pruned = 0;
  for (const [k, v] of locks) {
    if (v.mode === 'active' && v.ttlMs && (t - v.acquiredAt) > v.ttlMs) {
      locks.delete(k);
      pruned++;
    }
  }
  return pruned;
}

function isHeld(key) {
  const cur = locks.get(key);
  if (!cur) return false;
  if (cur.mode === 'active' && isExpired(key)) {
    locks.delete(key); // 顺带清理
    return false;
  }
  return cur.mode === 'active';
}

function getOwner(key) {
  return locks.get(key) || null;
}

// 释放锁。校验 owner.executionId 匹配，避免误释放他人锁。
function release(key, executionId) {
  const cur = locks.get(key);
  if (!cur) return;
  if (executionId && cur.executionId !== executionId) return; // 非持有者，忽略
  locks.delete(key);
}

// 标记为暂停持有（人工介入期间）：仍占锁，但允许他人进入 WAITING
function markPaused(key, executionId) {
  const cur = locks.get(key);
  if (cur && cur.executionId === executionId) cur.mode = 'paused';
}

function markActive(key, executionId) {
  const cur = locks.get(key);
  if (cur && cur.executionId === executionId) cur.mode = 'active';
}

// 释放某个 execution 持有的全部锁（任务结束/崩溃清理）
function releaseAllForExecution(executionId) {
  for (const [k, v] of locks) {
    if (v.executionId === executionId) locks.delete(k);
  }
}

function summary() {
  return [...locks.entries()].map(([k, v]) => ({ key: k, ...v }));
}

module.exports = {
  acquire, isHeld, getOwner, release, markPaused, markActive,
  releaseAllForExecution, summary, isExpired, pruneExpired,
  resourceKeyForProfile, resourceKeyForBrowser, DEFAULT_TTL_MS,
};
