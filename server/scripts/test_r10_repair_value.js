'use strict';
// R10-C 测试：repair 价值三分类度量（repairValueMetrics.js）。
// 真值锚定自 run4/run5 实测数据（.benchmark/RUN4/RUN5_FINAL_REPORT.md）。

const { classifyRepairOutcome, aggregateRepairValue } = require('./repairValueMetrics');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail == null ? '' : JSON.stringify(detail)); }
}

// ── classifyRepairOutcome 单元 ──
// run4 rw.009：凭据错误 repair 2/0 → CREDIBLE 升级 = 正确失败
check('correctFail: credible escalation', (() => {
  const b = classifyRepairOutcome({ repairCount: 2, repairSuccess: 0, status: 'HUMAN_ESCALATION', escalationKind: 'CREDIBLE' });
  return b.total === 2 && b.recovered === 0 && b.correctFail === 2 && b.ineffectiveFail === 0;
})());
// run4 rw.020：repair 2/0 失败但 retry 自愈 SUCCESS = 无效失败（白烧预算）
check('ineffectiveFail: recovered by retry', (() => {
  const b = classifyRepairOutcome({ repairCount: 2, repairSuccess: 0, status: 'SUCCESS' });
  return b.recovered === 0 && b.correctFail === 0 && b.ineffectiveFail === 2;
})());
// run5 rw.023：repair 3/2 后 SUCCESS = 2 恢复 + 1 无效
check('mixed: recovered + ineffective', (() => {
  const b = classifyRepairOutcome({ repairCount: 3, repairSuccess: 2, status: 'SUCCESS' });
  return b.recovered === 2 && b.correctFail === 0 && b.ineffectiveFail === 1;
})());
// run5 rw.026：repair 5/4 → CREDIBLE 升级 = 4 恢复 + 1 正确失败
check('mixed: recovered + correctFail', (() => {
  const b = classifyRepairOutcome({ repairCount: 5, repairSuccess: 4, status: 'HUMAN_ESCALATION', escalationKind: 'CREDIBLE' });
  return b.recovered === 4 && b.correctFail === 1 && b.ineffectiveFail === 0;
})());
// REAL 升级（误升级）：失败不计正确
check('REAL escalation failures are ineffective', (() => {
  const b = classifyRepairOutcome({ repairCount: 2, repairSuccess: 0, status: 'HUMAN_ESCALATION', escalationKind: 'REAL' });
  return b.correctFail === 0 && b.ineffectiveFail === 2;
})());
// escalationKind 缺失的 HUMAN_ESCALATION：保守计无效（不虚增价值率）
check('missing escalationKind is ineffective', (() => {
  const b = classifyRepairOutcome({ repairCount: 2, repairSuccess: 0, status: 'HUMAN_ESCALATION' });
  return b.correctFail === 0 && b.ineffectiveFail === 2;
})());
// 零 repair：全零
check('zero repairs', (() => {
  const b = classifyRepairOutcome({ repairCount: 0, repairSuccess: 0, status: 'SUCCESS' });
  return b.total === 0 && b.recovered === 0 && b.correctFail === 0 && b.ineffectiveFail === 0;
})());
// 防御：null / 缺字段 / repairSuccess > repairCount（钳制）
check('null rec safe', (() => { const b = classifyRepairOutcome(null); return b.total === 0; })());
check('missing fields safe', (() => { const b = classifyRepairOutcome({}); return b.total === 0 && b.ineffectiveFail === 0; })());
check('clamp ok > total', (() => {
  const b = classifyRepairOutcome({ repairCount: 2, repairSuccess: 5, status: 'SUCCESS' });
  return b.total === 2 && b.recovered === 2 && b.ineffectiveFail === 0;
})());
// TIMEOUT/CANCELLED 的失败 = 无效（幽灵追逐类）
check('TIMEOUT failures ineffective', (() => {
  const b = classifyRepairOutcome({ repairCount: 4, repairSuccess: 0, status: 'CANCELLED' });
  return b.ineffectiveFail === 4 && b.correctFail === 0;
})());

// ── aggregateRepairValue ──
// run5 真值重演：rw.023(3/2,S) + rw.026(5/4,CREDIBLE ESC) + 95 个零 repair
check('run5 replay: value rate 7/8', (() => {
  const results = [
    { repairCount: 3, repairSuccess: 2, status: 'SUCCESS' },
    { repairCount: 5, repairSuccess: 4, status: 'HUMAN_ESCALATION', escalationKind: 'CREDIBLE' },
  ];
  for (let i = 0; i < 98; i++) results.push({ repairCount: 0, repairSuccess: 0, status: 'SUCCESS' });
  const agg = aggregateRepairValue(results);
  return agg.total === 8 && agg.recovered === 6 && agg.correctFail === 1 && agg.ineffectiveFail === 1
    && agg.repairValueRate === 0.875 && agg.rawRepairSuccessRate === 0.75;
})());
// 历史记录无 breakdown 字段：从原始字段重算（resume 兼容）
check('legacy records recomputed', (() => {
  const agg = aggregateRepairValue([{ repairCount: 2, repairSuccess: 0, status: 'HUMAN_ESCALATION', escalationKind: 'CREDIBLE' }]);
  return agg.correctFail === 2 && agg.repairValueRate === 1;
})());
// breakdown 字段存在时优先消费
check('prefers existing breakdown', (() => {
  const agg = aggregateRepairValue([{ repairCount: 9, repairSuccess: 0, status: 'SUCCESS', repairOutcomeBreakdown: { total: 1, recovered: 1, correctFail: 0, ineffectiveFail: 0 } }]);
  return agg.total === 1 && agg.recovered === 1;
})());
// 空数组：null 率
check('empty results null rates', (() => {
  const agg = aggregateRepairValue([]);
  return agg.total === 0 && agg.repairValueRate === null && agg.rawRepairSuccessRate === null;
})());

console.log('\n== R10-C repair value metrics ==');
console.log('PASS=' + pass, 'FAIL=' + fail);
process.exit(fail ? 1 : 0);
