'use strict';

// Repair Attempt 数据层（aiRepairAttempts.json）。
// Repair 拥有独立生命周期：PENDING → RUNNING → SUCCESS/FAILED。
// 与原始 Action Attempt 并存（历史保留：Original Failure → Repair Decision → Repair Execution → Result）。

const store = require('../store');

const STATUS = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED'];

function uid() {
  return 'repair_attempt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function create({ taskId, stepId, diagnosisId, strategy, strategyType, risk, confidence }) {
  const rec = {
    id: uid(),
    repairId: 'repair_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    taskId, stepId,
    diagnosisId: diagnosisId || null,
    strategy: strategy || 'generic',
    strategyType: strategyType || '',
    risk: risk || 'LOW',
    confidence: confidence != null ? confidence : null,
    status: 'PENDING',
    actions: [],
    verification: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  store.insert('aiRepairAttempts', rec);
  return rec;
}

function update(id, patch) {
  const rec = store.find('aiRepairAttempts', id);
  if (!rec) return null;
  Object.assign(rec, patch);
  store.upsert('aiRepairAttempts', rec);
  return rec;
}

function get(id) {
  return store.find('aiRepairAttempts', id);
}

function listForTask(taskId) {
  return store.findWhere('aiRepairAttempts', (x) => x.taskId === taskId).sort((a, b) => a.createdAt - b.createdAt);
}

function listForStep(stepId) {
  return store.findWhere('aiRepairAttempts', (x) => x.stepId === stepId).sort((a, b) => a.createdAt - b.createdAt);
}

// 修复策略成功率统计（供后续 Site Intelligence / 模型优化）
function statsByStrategy() {
  const stats = {};
  for (const r of store.read('aiRepairAttempts', [])) {
    stats[r.strategy] = stats[r.strategy] || { total: 0, ok: 0 };
    stats[r.strategy].total += 1;
    if (r.status === 'SUCCESS') stats[r.strategy].ok += 1;
  }
  return Object.entries(stats).map(([strategy, s]) => ({
    strategy,
    successRate: s.total ? Math.round((s.ok / s.total) * 100) / 100 : 0,
    total: s.total,
  }));
}

// Phase 7 Step 5 归因修复（纯函数，便于测试）：
// 若一条 FAILED 的 repair 在其创建之后、同一 step 上出现了 SUCCESS attempt，
// 说明该 step 在 repair 后已实际恢复 → 该 repair 应被归因为 SUCCESS。
// 返回 { status, repairId, attributedAttemptIds }。不触碰存储（由调用方落库）。
function reconcileRepair(repair, stepAttempts) {
  if (!repair) return { status: repair ? repair.status : null, repairId: null, attributedAttemptIds: [] };
  if (repair.status !== 'FAILED') return { status: repair.status, repairId: repair.repairId, attributedAttemptIds: [] };
  const recovered = (stepAttempts || []).filter(
    (a) => a && a.status === 'SUCCESS' && a.startedAt > repair.createdAt
  );
  if (!recovered.length) return { status: 'FAILED', repairId: repair.repairId, attributedAttemptIds: [] };
  return {
    status: 'SUCCESS',
    repairId: repair.repairId,
    attributedAttemptIds: recovered.map((a) => a.id),
  };
}

module.exports = { create, update, get, listForTask, listForStep, statsByStrategy, STATUS, reconcileRepair };
