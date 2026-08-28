'use strict';

// P6（Phase 2 Verification Trace 升级）测试：在既有 trace 结构上验证新增诊断字段，
// 不依赖浏览器 / 真实 store 文件，仅构造内存 store 校验纯函数增强。

const { buildTrace, buildLineageGraph, buildEvidenceTimeline } = require('./trace_single_task');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; fails.push(msg); console.log('  ✗ FAIL: ' + msg); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const TASK_ID = 'task_p6';

const beforeObs = {
  observationId: 'obs_b1', parentObservationId: null, source: 'initial', capturedAt: '2026-08-27T10:00:00.000Z',
  url: 'http://x/form', visibleText: 'form page',
  previousObservationDiff: { urlChanged: false, textChanged: false, domChanged: false, keyTextChanged: false, elementStateChanged: false, pageStructureChanged: false },
};
const afterObs = {
  observationId: 'obs_a1', parentObservationId: 'obs_b1', source: 'verification_window', capturedAt: '2026-08-27T10:00:02.000Z',
  url: 'http://x/dashboard', visibleText: 'submitted',
  previousObservationDiff: { urlChanged: true, textChanged: true, domChanged: true, keyTextChanged: true, elementStateChanged: true, pageStructureChanged: true },
};

const store = {
  tasks: [{ id: TASK_ID, status: 'FAILED', successMetrics: { isBusinessSuccess: false }, error: { code: 'VERIFY_FAILED', failureType: 'SUBMIT_RESULT_UNKNOWN' } }],
  steps: [],
  attempts: [{
    id: 'att1', stepId: TASK_ID + '_step1',
    startedAt: '2026-08-27T10:00:01.000Z', finishedAt: '2026-08-27T10:00:02.000Z',
    matchedBy: 'semantic', status: 'FAILED',
    action: { type: 'submit', target: { semantic: 'submit' }, expectedBusinessState: { stateType: 'SUBMITTED' } },
    error: {
      code: 'VERIFY_FAILED', failureType: 'SUBMIT_RESULT_UNKNOWN', confidence: 0.5,
      evidence: ['提交结果未确认'], observationBefore: beforeObs, observationAfter: afterObs,
    },
  }],
  events: [],
  repairs: [{ stepId: TASK_ID + '_step1', taskId: TASK_ID, strategy: 'VERIFY_RETRY', strategyType: 'verifyFailed', status: 'PAUSED_FOR_HUMAN', reason: '提交结果落点不确定，升级人工查询结果', startedAt: '2026-08-27T10:00:03.000Z' }],
  snapshots: [],
};

section('P6.1 buildTrace 返回增强字段');
const trace = buildTrace(TASK_ID, store);
ok(trace && trace.attempts.length === 1, 'trace 含 1 个 attempt');
const att = trace.attempts[0];

section('P6.2 evidence timeline');
ok(Array.isArray(att.evidenceTimeline) && att.evidenceTimeline.length >= 4, 'evidenceTimeline 含 ≥4 时点（before/start/finish/after/verify/repair）');
ok(att.evidenceTimeline.some((e) => e.label === 'before_observation'), '含 before_observation 时点');
ok(att.evidenceTimeline.some((e) => e.label === 'after_observation'), '含 after_observation 时点');
ok(att.evidenceTimeline.some((e) => e.label === 'verification_decision'), '含 verification_decision 时点');
ok(att.evidenceTimeline.some((e) => e.label.startsWith('repair_')), '含 repair 时点');

section('P6.3 observation lineage graph');
ok(att.observationLineage && att.observationLineage.nodes.length === 2, 'lineage 含 before/after 两节点');
ok(att.observationLineage.nodes[0].observationId === 'obs_b1' && att.observationLineage.nodes[1].observationId === 'obs_a1', '节点携带 observationId');
ok(Array.isArray(att.observationLineage.edges) && att.observationLineage.edges.length >= 1, 'lineage 含血缘边（parent/source）');
ok(att.observationLineage.edges.some((e) => e.kind === 'parent'), '含 parent 边（obs_b1→obs_a1）');

section('P6.4 verification evidence score');
ok(att.verificationEvidence && typeof att.verificationEvidence.evidenceScore === 'number', 'verificationEvidence.evidenceScore 为数值');
ok(att.verificationEvidence.evidenceScore > 0.5, '多信号（url+keyText+element+structure+fresh）→ 高分 = ' + att.verificationEvidence.evidenceScore);
ok(att['8_verificationDecision'].evidenceScore === att.verificationEvidence.evidenceScore, '8_verificationDecision 附带 evidenceScore');

section('P6.5 repair decision reason');
ok(att['9_repairDecision'].length === 1, 'repair 决策 1 条');
ok(att['9_repairDecision'][0].reason && /升级人工/.test(att['9_repairDecision'][0].reason), 'repair 带 reason 文本');

section('P6.6 既有字段未丢失（向后兼容）');
ok(att['1_beforeObservation'] && att['10_finalOutcome'], '原有 10 节点字段仍存在');
ok(att['3_resolvedTarget'].matchedBy === 'semantic', 'matchedBy 遥测字段保留');

section('P6.7 纯函数独立可用');
const lg = buildLineageGraph(beforeObs, afterObs);
ok(lg.nodes.length === 2 && lg.edges.length >= 1, 'buildLineageGraph 独立返回血缘图');
const tl = buildEvidenceTimeline(store.attempts[0], { repairs: store.repairs });
ok(Array.isArray(tl) && tl.length >= 3, 'buildEvidenceTimeline 独立返回时间线');

console.log('\n==== 结果：' + pass + ' passed, ' + fail + ' failed ====');
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
