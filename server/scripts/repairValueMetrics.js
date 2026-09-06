'use strict';

// R10-C：Repair 价值三分类度量（纯函数，零行为改动）。
// 来源：.benchmark/R10_DESIGN_EVAL.md 选项 C —— 原始 repair 成功率是误导性指标：
//   - 正确失败（correctFail）：repair 失败后按可信升级收口（如凭据错误），失败有正面价值
//   - 自愈冗余/无效失败（ineffectiveFail）：repair 失败且任务未按可信升级收口
//     （SUCCESS 靠 retry 自愈 / TIMEOUT / CANCELLED / REAL 误升级）
//   - 恢复成功（recovered）：repair 本身 ok
// 修复价值率 repairValueRate = (recovered + correctFail) / repairTotal。
//
// 边界注记（run5 rw.026 实证）：repair ok 只证动作执行不证业务闭环
// （5/4 但 verify 仍败），本分类无法识别该形态 —— 待恢复链证据落盘后再升级口径。

function classifyRepairOutcome(rec) {
  const r = rec || {};
  const total = Math.max(0, Number(r.repairCount) || 0);
  const ok = Math.min(total, Math.max(0, Number(r.repairSuccess) || 0));
  const failures = total - ok;
  const isCredibleEscalation = r.status === 'HUMAN_ESCALATION' && r.escalationKind === 'CREDIBLE';
  const correctFail = isCredibleEscalation ? failures : 0;
  return {
    total,
    recovered: ok,
    correctFail,
    ineffectiveFail: failures - correctFail,
  };
}

function aggregateRepairValue(results) {
  const list = Array.isArray(results) ? results : [];
  let total = 0, recovered = 0, correctFail = 0, ineffectiveFail = 0;
  for (const rec of list) {
    const b = (rec && rec.repairOutcomeBreakdown) || classifyRepairOutcome(rec);
    total += b.total || 0;
    recovered += b.recovered || 0;
    correctFail += b.correctFail || 0;
    ineffectiveFail += b.ineffectiveFail || 0;
  }
  return {
    total,
    recovered,
    correctFail,
    ineffectiveFail,
    repairValueRate: total ? +((recovered + correctFail) / total).toFixed(4) : null,
    rawRepairSuccessRate: total ? +(recovered / total).toFixed(4) : null,
  };
}

module.exports = { classifyRepairOutcome, aggregateRepairValue };
