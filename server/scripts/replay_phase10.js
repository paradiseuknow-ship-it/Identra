'use strict';

// Phase 10 历史数据回放（只读，不修改历史结果）。
// 输入：.benchmark/phase9_1787698717444.json（Phase 9 真实 100 任务）。
// 目的：
//   1) 用原始 perTask 重算 VERIFY_FAILED 分类分布（taxonomy 字段）。
//   2) 重算 Repair 恢复率（repairCount>0 且最终 SUCCESS）。
//   3) 明确：VIL 6 子类（EVENTUAL_CONSISTENCY 等）依赖动作前后 observation 信号，
//      Phase 9 原始数据未采集这些字段，无法逐条回放子类；子类实测将在新 benchmark 产出。
//
// 运行：node server/scripts/replay_phase10.js

const fs = require('fs');
const path = require('path');

const benchDir = path.join(__dirname, '..', '..', '.benchmark');
const files = fs.readdirSync(benchDir).filter((f) => f.startsWith('phase9_') && f.endsWith('.json'));
if (!files.length) { console.log('未找到 phase9 JSON'); process.exit(1); }
// 选取 perTask 最多的文件（排除 smoke 小文件）
let bestFile = null, bestLen = -1;
for (const f of files) {
  try {
    const jt = JSON.parse(fs.readFileSync(path.join(benchDir, f), 'utf8'));
    const n = (jt.perTask || []).length;
    if (n > bestLen) { bestLen = n; bestFile = f; }
  } catch (e) {}
}
const j = JSON.parse(fs.readFileSync(path.join(benchDir, bestFile), 'utf8'));
const PT = j.perTask || [];
console.log('使用文件: ' + bestFile + ' (perTask=' + PT.length + ')');

function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 + '%' : '0%'; }

// 1) taxonomy 分布
const tax = {};
for (const t of PT) { const k = t.taxonomy || 'UNKNOWN'; tax[k] = (tax[k] || 0) + 1; }
console.log('=== Phase 9 taxonomy 分布（原始 perTask 重算，n=' + PT.length + '） ===');
for (const k of Object.keys(tax).sort((a, b) => tax[b] - tax[a])) {
  console.log('  ' + k + ': ' + tax[k] + ' (' + pct(tax[k], PT.length) + ')');
}

// 2) escalation 拆分
const esc = PT.filter((t) => t.escalated);
const cred = esc.filter((t) => t.escalationKind === 'CREDIBLE').length;
const real = esc.filter((t) => t.escalationKind === 'REAL').length;
console.log('\n=== Human Escalation 拆分 ===');
console.log('  Total escalated: ' + esc.length + ' (' + pct(esc.length, PT.length) + ')');
console.log('  Credible: ' + cred + '  Real: ' + real);

// 3) repair 恢复率
const repaired = PT.filter((t) => t.repairCount > 0);
const recovered = repaired.filter((t) => t.status === 'SUCCESS');
console.log('\n=== Repair 恢复率（Phase 9 实测） ===');
console.log('  tasks with repair>0: ' + repaired.length);
console.log('  recovered (status=SUCCESS): ' + recovered.length + ' (' + pct(recovered.length, repaired.length) + ')');
console.log('  Business recovery rate: ' + pct(recovered.length, repaired.length));

// 4) VERIFY_FAILED 子集
const vf = PT.filter((t) => t.taxonomy === 'VERIFY_FAILED');
console.log('\n=== VERIFY_FAILED 子集 ===');
console.log('  count: ' + vf.length + ' (' + pct(vf.length, PT.length) + ')');
console.log('  escalated: ' + vf.filter((t) => t.escalated).length);
console.log('  repaired: ' + vf.filter((t) => t.repairCount > 0).length);
console.log('  recovered: ' + vf.filter((t) => t.status === 'SUCCESS').length);

// 5) 诚实声明
console.log('\n=== 回放结论（诚实声明） ===');
console.log('  - taxonomy / escalation / repair 恢复率均来自 Phase 9 原始 perTask，未修改历史结果。');
console.log('  - VIL 6 子类（EVENTUAL_CONSISTENCY / OBSERVATION_DELAY / VERIFICATION_TOO_STRICT /');
console.log('    ACTION_REAL_FAILURE / STATE_UNKNOWN / DOM_CHANGED）依赖动作前后 observation 信号');
console.log('    （loadingState/networkState/previousObservationDiff），Phase 9 未采集 → 无法逐条回放。');
console.log('  - 子类实测分布将在 Phase 10 新 benchmark（v0.2.1 runtime）产出后在结果报告中给出。');

// 输出 JSON 供报告引用
const out = {
  total: PT.length,
  taxonomy: tax,
  escalation: { total: esc.length, credible: cred, real: real },
  repair: { withRepair: repaired.length, recovered: recovered.length, recoveryRate: pct(recovered.length, repaired.length) },
  verifyFailed: { count: vf.length, escalated: vf.filter((t) => t.escalated).length, repaired: vf.filter((t) => t.repairCount > 0).length, recovered: vf.filter((t) => t.status === 'SUCCESS').length },
  note: 'VIL subclass replay requires v0.2.1 runtime observations; not available in Phase 9 JSON.',
};
fs.writeFileSync(path.join(benchDir, 'phase10_replay.json'), JSON.stringify(out, null, 2));
console.log('\n已写出 .benchmark/phase10_replay.json');
