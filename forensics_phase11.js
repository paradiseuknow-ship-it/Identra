'use strict';
// Phase 11 — Failure Forensics (READ-ONLY analysis, rewritten for honest attribution).
//
// DATA-ATTRIBUTION CONSTRAINT (verified):
//   - server/data/{aiSteps,aiAttempts}.json belong to a DIFFERENT run (task_mtab…) than the
//     Phase 10.9 benchmark (task_mta9…). stepCount on perTask records is 0. Step/attempt
//     store detail is therefore NOT attributable to this run and is NOT used.
//   - VIL event capture (.cap) started mid-run: only 1 of the 58 VERIFY_FAILED tasks has
//     attributable VIL decision events. VIL per-task detail is therefore NOT used for classification.
//   - The 100%-attributable signals are the perTask fields of
//     .benchmark/phase10_1787763155065.json (objective, error, plannerOk, hasVerification,
//     verificationTotal, verificationPassed, escalationKind, category, fixture).
//
// We classify each VERIFY_FAILED into one of the 10 real-evidence categories using ONLY those
// attributable signals, with explicit confidence and an explicit evidence list. Where the
// available evidence cannot distinguish two categories, we assign the more conservative one
// and mark confidence low/medium rather than guessing.

const fs = require('fs');
const path = require('path');

const BENCH = '.benchmark/phase10_1787763155065.json';
const bench = JSON.parse(fs.readFileSync(BENCH, 'utf8'));
const pt = bench.perTask;

const vf = pt.filter((r) => r.taxonomy === 'VERIFY_FAILED');
const enf = pt.filter((r) => r.taxonomy === 'ELEMENT_NOT_FOUND');

function detectVerb(stepDesc) {
  if (/点击/.test(stepDesc)) return 'click';
  if (/提交/.test(stepDesc)) return 'submit';
  if (/输入|填入|填写/.test(stepDesc)) return 'fill';
  if (/打开|进入|导航/.test(stepDesc)) return 'navigate';
  if (/检查|确认|查看|定位|找到|提取|搜索结果|报表|列表|筛选/.test(stepDesc)) return 'check';
  if (/选择/.test(stepDesc)) return 'select';
  if (/修改|更新|改为|改|录入/.test(stepDesc)) return 'update';
  return 'other';
}

// objectives that imply an app-side transaction which can legitimately fail (not just a view)
function impliesTransactionRisk(obj) {
  return /支付|购买|下单|提交订单|删除|退款|付款|结算|转账/.test(obj || '');
}

function classifyVF(r) {
  const err = r.error || '';
  const obj = r.objective || '';
  const stepDesc = err.split('需人工处理')[0] || obj;
  const verb = detectVerb(stepDesc);
  const vt = r.verificationTotal || 0;
  const vp = r.verificationPassed || 0;
  const actionRan = vt > 0; // verification was attempted => the step executed to verification stage
  const evidence = [];
  let classification, confidence, reason;

  evidence.push('plannerOk=' + r.plannerOk);
  evidence.push('hasVerification=' + r.hasVerification);
  evidence.push('verificationTotal=' + vt);
  evidence.push('verificationPassed=' + vp);
  evidence.push('failingStep="' + stepDesc.slice(0, 40) + '"');
  evidence.push('verb=' + verb);
  evidence.push('escalationKind=' + (r.escalationKind || '(none)'));

  // 1) user-aborted / runtime anomaly
  if (/用户取消/.test(err)) {
    classification = 'OTHER';
    confidence = 'high';
    reason = '任务被用户取消（非验证/动作缺陷），归 OTHER。';
  } else if (/runtime\s*执行异常/.test(err)) {
    classification = 'STATE_UNKNOWN';
    confidence = 'medium';
    reason = 'runtime 执行异常中断，无法从 perTask 证据定因，归 STATE_UNKNOWN。';
  }
  // 2) planner failed entirely → action likely never properly executed
  else if (!r.plannerOk && !r.hasVerification) {
    classification = 'ACTION_NOT_EXECUTED';
    confidence = 'medium';
    reason = 'plannerOk=false 且 hasVerification=false：计划未产出有效动作/验证，动作极可能未真正执行。';
  }
  // 3) action reached verification stage (vt>0) → action executed
  else if (actionRan) {
    if (vp > 0) {
      // verification passed at least once but failed overall → flaky / over-strict contract
      if (verb === 'check' || verb === 'select') {
        classification = 'STATE_CHANGED_BUT_VERIFICATION_WRONG';
        confidence = 'medium';
        reason = '验证/检查步骤在某些观察轮次通过(vp=' + vp + '/' + vt + ')，说明业务态曾出现，但验证契约检查的信号不稳定或错位 → STATE_CHANGED_BUT_VERIFICATION_WRONG。';
      } else {
        classification = 'VERIFICATION_TOO_STRICT';
        confidence = 'high';
        reason = '动作已执行且验证曾通过(vp=' + vp + '/' + vt + ')，说明业务态可达；验证整体仍失败 → 验证契约过严/抖动，属 VERIFICATION_TOO_STRICT。';
      }
    } else {
      // verification never passed → business state never confirmed
      if (verb === 'check' || verb === 'select') {
        classification = 'VERIFICATION_TOO_STRICT';
        confidence = 'medium';
        reason = '验证/检查步骤从未通过(vp=0/' + vt + ')：验证契约检查的信号在应用中从未出现，可能过严或检查错信号 → VERIFICATION_TOO_STRICT。';
      } else if (impliesTransactionRisk(obj)) {
        classification = 'REAL_BUSINESS_FAILURE';
        confidence = 'medium';
        reason = '状态变更型动作已执行(vt=' + vt + ')但业务态从未确认(vp=0)，且目标含交易类风险(支付/下单/删除)→应用可能真实拒绝/失败 → REAL_BUSINESS_FAILURE。';
      } else {
        classification = 'ACTION_EXECUTED_BUT_STATE_NOT_CHANGED';
        confidence = 'medium';
        reason = '状态变更型动作已执行(vt=' + vt + ')但业务态从未确认(vp=0)，无证据显示应用侧交易失败 → 动作执行了但目标业务态未改变 → ACTION_EXECUTED_BUT_STATE_NOT_CHANGED。';
      }
    }
  }
  // 4) fallback (no vt, no planner info) — cannot attribute
  else {
    classification = 'STATE_UNKNOWN';
    confidence = 'low';
    reason = '可用 perTask 证据不足（无 verificationTotal、无 planner 信息），无法定因 → STATE_UNKNOWN。';
  }

  return {
    rw: r.id,
    category: r.category,
    objective: obj,
    fixture: r.fixture,
    failingStep: stepDesc.slice(0, 60),
    verb,
    plannerOk: r.plannerOk,
    hasVerification: r.hasVerification,
    verificationTotal: vt,
    verificationPassed: vp,
    escalationKind: r.escalationKind || '(none)',
    error: err.slice(0, 140),
    classification,
    confidence,
    evidence,
  };
}

const vfResults = vf.map(classifyVF);

// ---- aggregate 10-category counts ----
const CATEGORIES = [
  'ACTION_NOT_EXECUTED', 'ACTION_EXECUTED_WRONG_TARGET', 'ACTION_EXECUTED_BUT_STATE_NOT_CHANGED',
  'STATE_CHANGED_BUT_VERIFICATION_WRONG', 'VERIFICATION_TOO_STRICT', 'VERIFICATION_TOO_WEAK',
  'STATE_UNKNOWN', 'DOM_CHANGED', 'REAL_BUSINESS_FAILURE', 'OTHER',
];
const agg = {};
for (const c of CATEGORIES) agg[c] = { count: 0, high: 0, medium: 0, low: 0 };
for (const x of vfResults) {
  agg[x.classification].count++;
  agg[x.classification][x.confidence] = (agg[x.classification][x.confidence] || 0) + 1;
}

// mechanism summary (action-ran vs not, partial vs zero pass)
let actionRan = 0, actionNotRan = 0, partialPass = 0, zeroPass = 0;
for (const x of vfResults) {
  if (x.verificationTotal > 0) actionRan++; else actionNotRan++;
  if (x.verificationPassed > 0) partialPass++; else zeroPass++;
}

// ---------------- ELEMENT_NOT_FOUND resolver matrix ----------------
const resolverMatrix = {
  byFailureType: {},
  byActionVerb: {},
  byCategory: {},
  byTargetHint: {},
  samples: [],
};
function relocateVerb(err) {
  if (/SEMANTIC_RELOCATE/.test(err)) return 'SEMANTIC_RELOCATE';
  if (/VERIFY_RETRY/.test(err)) return 'VERIFY_RETRY';
  return 'OTHER';
}
function targetHint(err) {
  // extract the human-readable target from the error: the part before "需人工处理"
  const m = (err.split('需人工处理')[0] || '').trim();
  return m || '(none)';
}
for (const r of enf) {
  const ft = relocateVerb(r.error || '');
  const verb = detectVerb(targetHint(r.error || ''));
  const hint = targetHint(r.error || '');
  resolverMatrix.byFailureType[ft] = (resolverMatrix.byFailureType[ft] || 0) + 1;
  resolverMatrix.byActionVerb[verb] = (resolverMatrix.byActionVerb[verb] || 0) + 1;
  resolverMatrix.byCategory[r.category] = (resolverMatrix.byCategory[r.category] || 0) + 1;
  resolverMatrix.byTargetHint[hint] = (resolverMatrix.byTargetHint[hint] || 0) + 1;
  resolverMatrix.samples.push({
    rw: r.id, category: r.category, objective: r.objective,
    fixture: r.fixture, failureType: ft, targetHint: hint, error: (r.error || '').slice(0, 140),
  });
}

// ---------------- output ----------------
console.log('=== VERIFY_FAILED forensics (' + vf.length + ' tasks) ===');
console.log('mechanism: actionRan=' + actionRan + ' actionNotRan=' + actionNotRan +
  ' | partialPass(vp>0)=' + partialPass + ' zeroPass(vp=0)=' + zeroPass);
console.log('\n--- 10-category aggregate ---');
for (const c of CATEGORIES) {
  const a = agg[c];
  console.log('  ' + (a.count ? '■' : '□') + ' ' + c + ': ' + a.count +
    (a.count ? '  (high=' + a.high + ' med=' + a.medium + ' low=' + a.low + ')' : ''));
}
console.log('\n--- per-task ---');
for (const x of vfResults) {
  console.log(x.rw + ' [' + x.category + '] verb=' + x.verb + ' vt/vp=' + x.verificationTotal + '/' + x.verificationPassed +
    ' => ' + x.classification + '(' + x.confidence + ') :: ' + x.failingStep.slice(0, 36));
}

console.log('\n=== ELEMENT_NOT_FOUND resolver matrix (' + enf.length + ' tasks) ===');
console.log('byFailureType:', JSON.stringify(resolverMatrix.byFailureType));
console.log('byActionVerb:', JSON.stringify(resolverMatrix.byActionVerb));
console.log('byCategory:', JSON.stringify(resolverMatrix.byCategory));
console.log('byTargetHint:');
for (const k of Object.keys(resolverMatrix.byTargetHint)) console.log('   ' + resolverMatrix.byTargetHint[k] + '  ' + k);

fs.writeFileSync('phase11_forensics.json', JSON.stringify({ verifyFailed: vfResults, verifyFailedAggregate: agg, mechanism: { actionRan, actionNotRan, partialPass, zeroPass }, resolverMatrix }, null, 2));
fs.writeFileSync('resolver_failure_matrix.json', JSON.stringify(resolverMatrix, null, 2));
console.log('\n[forensics] wrote phase11_forensics.json + resolver_failure_matrix.json');
