'use strict';

// P4（Phase 2 ASYNC_PENDING）测试：
// 验证「异步处理中」中间态识别，且优先级顺序 SUCCESS/FAILURE → ASYNC_PENDING → UNKNOWN 不被破坏。
// VIL 仅在 verification 失败后运行，故 SUCCESS/FAILURE 由 verification.js 负责；此处 FAILURE 对应
// ACTION_REAL_FAILURE，UNKNOWN 对应 STATE_UNKNOWN / SUBMIT_RESULT_UNKNOWN。

const vil = require('../agent/verification/verificationIntelligence');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; fails.push(msg); console.log('  ✗ FAIL: ' + msg); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// 构造一个「页面已稳定」的 after 观察，使其能抵达 ASYNC_PENDING 判定（不被 network/loading/domChanged 提前 return）
function stableObs(over) {
  const o = {
    loadingState: 'complete',
    networkState: 'idle',
    url: 'http://example.com/page',
    visibleText: 'some page content',
    previousObservationDiff: {
      urlChanged: false, textChanged: false, domChanged: false,
      keyTextChanged: false, elementStateChanged: false, pageStructureChanged: false,
    },
    elements: [],
  };
  return Object.assign({}, o, over || {});
}

function runAnalyze(after, action, expected) {
  return vil.analyze({
    beforeObservation: stableObs({}),
    afterObservation: after,
    expectedVerification: expected,
    actionResult: { success: true },
    action: action,
  });
}

// Case 1：processing 文本 → ASYNC_PENDING
section('Case 1: processing 文本 → ASYNC_PENDING');
{
  const after = stableObs({ visibleText: 'Your request is processing, please wait' });
  const det = vil.detectAsyncPending(stableObs({}), after);
  ok(det.pending === true, 'detectAsyncPending.pending=true');
  ok(det.signals.some((s) => s.startsWith('processing_text')), '信号含 processing_text');
  const r = runAnalyze(after, { type: 'click' });
  ok(r.failureType === vil.FAILURE_TYPES.ASYNC_PENDING, 'analyze.failureType=ASYNC_PENDING（非 UNKNOWN）');
}

// Case 2：loading 状态（spinner/progress） → ASYNC_PENDING
section('Case 2: loading 状态 → ASYNC_PENDING');
{
  const after = stableObs({ elements: [{ text: 'Loading', semantic: 'spinner', role: 'progressbar', state: {} }] });
  const det = vil.detectAsyncPending(stableObs({}), after);
  ok(det.pending === true, 'detectAsyncPending.pending=true');
  ok(det.signals.includes('loading_indicator'), '信号含 loading_indicator');
  const detUrl = vil.detectAsyncPending(stableObs({}), stableObs({ url: 'http://example.com/processing/job/9' }));
  ok(detUrl.pending === true && detUrl.signals.includes('pending_url'), 'URL /processing 段 → pending_url 信号');
  const r = runAnalyze(after, { type: 'click' });
  ok(r.failureType === vil.FAILURE_TYPES.ASYNC_PENDING, 'analyze.failureType=ASYNC_PENDING');
}

// Case 3：普通页面变化（无异步信号） → UNKNOWN
section('Case 3: 普通页面变化（无异步信号） → UNKNOWN');
{
  const after = stableObs({ visibleText: 'Profile settings have been changed' });
  ok(vil.detectAsyncPending(stableObs({}), after).pending === false, 'detectAsyncPending.pending=false');
  const r = runAnalyze(after, { type: 'click' });
  ok(r.failureType === vil.FAILURE_TYPES.STATE_UNKNOWN, 'analyze.failureType=STATE_UNKNOWN（UNKNOWN）');
  ok(r.failureType !== vil.FAILURE_TYPES.ASYNC_PENDING, '未被误判为 ASYNC_PENDING');
}

// Case 4：明确错误页面 → 不是 ASYNC_PENDING（错误归因在 verifyFailed 层，不在 VIL）
section('Case 4: 明确错误页面 → 非 ASYNC_PENDING');
{
  const after = stableObs({ visibleText: 'Error: something went wrong (500)' });
  ok(vil.detectAsyncPending(stableObs({}), after).pending === false, '错误页文本未被识别为 pending');
  const r = runAnalyze(after, { type: 'click' });
  ok(r.failureType !== vil.FAILURE_TYPES.ASYNC_PENDING, '错误页不进入 ASYNC_PENDING（保持原有 UNKNOWN 路径）');
}

// Case 5：明确成功页（负向控制）→ 不得被标为 pending
section('Case 5: 成功页文本 → 非 pending（负向控制）');
{
  const after = stableObs({ visibleText: 'Order placed successfully' });
  const det = vil.detectAsyncPending(stableObs({}), after);
  ok(det.pending === false, '成功页文本 pending=false（不属于 ASYNC_PENDING 关键词）');
}

// Case 6：payment async → ASYNC_PENDING + 人工升级（安全边界）
section('Case 6: payment async → ASYNC_PENDING + 人工升级');
{
  const after = stableObs({ visibleText: 'Payment is processing' });
  const r = runAnalyze(after, { type: 'payment', risk: 'CRITICAL' });
  ok(r.failureType === vil.FAILURE_TYPES.ASYNC_PENDING, 'payment async → ASYNC_PENDING');
  ok(r.decision === vil.DECISIONS.HUMAN_ESCALATE, '敏感动作 → HUMAN_ESCALATE（人工复核，不自动操作）');
  ok(r.decision !== vil.DECISIONS.RE_EXECUTE && r.decision !== vil.DECISIONS.RECHECK_OBSERVATION, '绝不自动重提交/重执行');
}

// Case 7（优先级守卫）：动作本身失败 → ACTION_REAL_FAILURE，不被 ASYNC_PENDING 抢占
section('Case 7: 优先级守卫 — 动作失败优先于 ASYNC_PENDING');
{
  const after = stableObs({ visibleText: 'Your request is processing' });
  const r = vil.analyze({
    beforeObservation: stableObs({}),
    afterObservation: after,
    actionResult: { success: false }, // 动作执行失败
    action: { type: 'click' },
  });
  ok(r.failureType === vil.FAILURE_TYPES.ACTION_REAL_FAILURE, 'actionResult.success=false → ACTION_REAL_FAILURE（FAILURE 优先）');
  ok(r.failureType !== vil.FAILURE_TYPES.ASYNC_PENDING, '未被误判为 ASYNC_PENDING');
}

console.log('\n==== 结果：' + pass + ' passed, ' + fail + ' failed ====');
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
