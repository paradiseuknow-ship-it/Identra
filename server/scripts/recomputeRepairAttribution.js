'use strict';

// Phase 7 Step 5 — 历史 24 条 repair 归因重算（按 Step 1 规则落实）。
// 规则：若一条 FAILED 的 repair 在其创建之后、同一 step 上出现 SUCCESS attempt，
//      则归因为 SUCCESS，并把 repairId 记录到这些成功 attempt 上。
// 仅作用于 Phase 7 那轮 30 任务对应的 24 条 repair（按 objective+createdAt 最大精确匹配），
// 不触碰其它历史运行数据。幂等：重跑不会把已 SUCCESS 翻回 FAILED。

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const D = JSON.parse(fs.readFileSync(path.join(root, '.benchmark', 'phase6_1787691693952.json'), 'utf8'));

const store = require(path.join(root, 'server', 'agent', 'store'));
const repairAttempts = require(path.join(root, 'server', 'agent', 'repair', 'repairAttempts'));
const stepManager = require(path.join(root, 'server', 'agent', 'stepManager'));

// 1) 锁定 Phase 7 那轮的 taskId 集合
const tasksAll = store.read('aiTasks', []);
const map = new Map();
for (const r of D.perTask) {
  const c = tasksAll.filter((t) => t.objective === r.objective).sort((a, b) => b.createdAt - a.createdAt);
  if (c[0]) map.set(r.objective, c[0].id);
}
const ids = new Set([...map.values()]);

const repairs = repairAttempts.listForTask ? null : null; // 占位（避免未使用告警）
const allRepairs = store.read('aiRepairAttempts', []).filter((x) => ids.has(x.taskId));
const allAttempts = store.read('aiAttempts', []);

console.log('Phase 7 轮 repair 总数:', allRepairs.length);

// 2) Before
const beforeSuccess = allRepairs.filter((r) => r.status === 'SUCCESS').length;
const beforeFailed = allRepairs.length - beforeSuccess;

// 3) 应用归因规则（落库）
let attributed = 0;
for (const r of allRepairs) {
  if (r.status !== 'FAILED') continue;
  const stepAttempts = allAttempts.filter((a) => a.stepId === r.stepId);
  const recon = repairAttempts.reconcileRepair(r, stepAttempts);
  if (recon.status === 'SUCCESS') {
    repairAttempts.update(r.id, { status: 'SUCCESS', error: null, finishedAt: Date.now(), attributedFrom: 'step_recovery' });
    for (const aid of recon.attributedAttemptIds) {
      const a = allAttempts.find((x) => x.id === aid);
      if (a && !a.repairIds.includes(r.repairId)) {
        a.repairIds.push(r.repairId);
        store.upsert('aiAttempts', a);
      }
    }
    attributed++;
  }
}

// 4) After（重新读取）
const afterRepairs = store.read('aiRepairAttempts', []).filter((x) => ids.has(x.taskId));
const afterSuccess = afterRepairs.filter((r) => r.status === 'SUCCESS').length;
const afterFailed = afterRepairs.length - afterSuccess;

console.log('\n=== 归因重算 Before → After ===');
console.log('  Before: SUCCESS=' + beforeSuccess + ' / FAILED=' + beforeFailed + '  (repair success rate = ' + Math.round((beforeSuccess / allRepairs.length) * 100) + '%)');
console.log('  本次新归因 SUCCESS: ' + attributed);
console.log('  After : SUCCESS=' + afterSuccess + ' / FAILED=' + afterFailed + '  (repair success rate = ' + Math.round((afterSuccess / allRepairs.length) * 100) + '%)');
console.log('\n  FAILED 明细（真正未恢复，应为 2 个 RESOURCE_LOCK）:');
for (const r of afterRepairs.filter((x) => x.status === 'FAILED')) {
  const step = store.read('aiSteps', []).find((s) => s.id === r.stepId);
  console.log('   - ' + r.repairId + ' step=' + r.stepId + ' strategy=' + r.strategy + ' stepStatus=' + (step ? step.status : '?'));
}
