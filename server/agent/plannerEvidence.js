'use strict';

// Planner Evidence：每次「真实规划」落库审计证据（Phase 2）。
// 记录 provider / model / timestamp / objective hash / context hash / step count / schema result。
// 用于未来审计与复现，不依赖任何 benchmark/E4/fingerprint 冻结区。

const crypto = require('crypto');
const store = require('./store'); // Store Facade（json | sqlite）

function sha256(s) {
  return crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex');
}

// ev: { taskId, executionId, provider, model, objective, context, stepCount, schemaOk, schemaErrors, capability }
function record(ev) {
  const objective = ev.objective || '';
  const context = ev.context || '';
  const entry = {
    id: 'pe_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    taskId: ev.taskId || null,
    executionId: ev.executionId || null,
    provider: ev.provider || 'unknown',
    model: ev.model || null,
    capability: ev.capability || null,
    timestamp: new Date().toISOString(),
    objectiveHash: sha256(objective),
    contextHash: sha256(context),
    objectiveLen: objective.length,
    contextLen: context.length,
    stepCount: ev.stepCount || 0,
    schemaResult: ev.schemaOk ? 'PASS' : 'FAIL',
    schemaErrors: ev.schemaErrors || [],
  };
  store.insert('aiPlannerEvidence', entry);
  return entry;
}

function list(limit = 50) {
  const all = store.findWhere('aiPlannerEvidence', () => true);
  return all.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))).slice(0, limit);
}

module.exports = { record, list, sha256 };
