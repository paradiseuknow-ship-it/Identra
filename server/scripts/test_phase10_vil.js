'use strict';

// Phase 10.7 单元测试：VIL 控制流闭环（不依赖真实浏览器 / LLM / DB）。
// 运行：node server/scripts/test_phase10_vil.js
//
// 覆盖：
//  - VIL 分类（STATE_UNKNOWN → RECHECK_OBSERVATION）
//  - verifyWithAlternatives（VERIFICATION_TOO_STRICT 替代态）
//  - verificationWindow（async-success 恢复 / async-never 超时 / 不无限等待 / WAIT+RECHECK 计数）
//  - verifyFailed 路由（含真实重验证，杜绝 silent-pass）

const vil = require('../agent/verification/verificationIntelligence');
const vwin = require('../agent/verification/verificationWindow');
const verification = require('../agent/verification');
const verifyFailed = require('../agent/repair/strategies/verifyFailed');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n=== ' + name + ' ==='); }

async function main() {
// ---------------------------------------------------------------
section('1. VIL 分类：STATE_UNKNOWN 现在进入 RECHECK（而非放弃）');
const baseAfter = { loadingState: 'complete', networkState: 'idle', previousObservationDiff: { domChanged: false } };

let r = vil.analyze({ beforeObservation: {}, afterObservation: baseAfter, expectedVerification: { type: 'text_present', expect: 'zzz-no-such-text' }, actionResult: { success: true } });
ok(r.failureType === 'STATE_UNKNOWN' && r.decision === 'RECHECK_OBSERVATION', '稳定但无证据 → STATE_UNKNOWN / RECHECK_OBSERVATION（不再 HUMAN_ESCALATE）');

ok(vil.isReobservableDecision('WAIT') && vil.isReobservableDecision('RECHECK_OBSERVATION') && vil.isReobservableDecision('RETRY_VERIFY'), 'isReobservableDecision 覆盖 WAIT/RECHECK/RETRY_VERIFY');
ok(!vil.isReobservableDecision('RE_EXECUTE') && !vil.isReobservableDecision('HUMAN_ESCALATE'), 'RE_EXECUTE / HUMAN_ESCALATE 不进入观察窗口');

// ---------------------------------------------------------------
section('2. verifyWithAlternatives：VERIFICATION_TOO_STRICT 替代态');
const contract = { type: 'text_present', expect: 'dashboard', allowedAlternativeStates: [{ type: 'text_present', expect: 'Welcome' }] };
const afterWrong = { textSummary: 'Welcome to your account' };
const vr = vwin.verifyWithAlternatives(contract, afterWrong, {});
ok(vr.success === true && vr.used === 'alternative', '主验证失败但替代态命中 → 成功（used=alternative）');

const afterNone = { textSummary: 'something else' };
const vr2 = vwin.verifyWithAlternatives(contract, afterNone, {});
ok(vr2.success === false, '主验证与替代态均失败 → 失败（不 silent-pass）');

const contractNoAlt = { type: 'text_present', expect: 'dashboard' };
const vr3 = vwin.verifyWithAlternatives(contractNoAlt, afterWrong, {});
ok(vr3.success === false, '无替代态且主验证失败 → 失败');

// ---------------------------------------------------------------
section('3. verificationWindow（注入 fake page/inspect/verify）');

// 3a) async-success：第 1 次重观察即出现 SUCCESS → 恢复，且产生 WAIT + RECHECK
{
  let calls = 0;
  const fakeInspect = async () => { calls++; const text = calls >= 1 ? 'Status: SUCCESS' : 'Status: Pending'; return { ok: true, observation: { url: 'http://x/async', textSummary: text, domFingerprint: 'fp' + calls } }; };
  const fakeVerify = (c, after) => ({ success: /SUCCESS/.test(after.textSummary || ''), used: 'primary' });
  const events = [];
  const win = await vwin.runObservationWindow({
    page: {}, taskId: 't1', ctx: { taskId: 't1' },
    verification: { type: 'text_present', expect: 'SUCCESS' }, beforeObservation: {},
    initialObservation: { url: 'http://x/async', textSummary: 'Status: Pending', domFingerprint: 'fp0' },
    decision: 'STATE_UNKNOWN', verifyFn: fakeVerify, inspectFn: fakeInspect, emit: (e) => events.push(e),
  });
  ok(win.recovered === true, 'async-success：窗口恢复成功');
  ok(win.observationCount >= 2, '观察次数 >= 2（初始 + 至少一次重观察）');
  ok(win.verificationAttempts >= 2, '验证尝试 >= 2');
  const waits = events.filter((e) => e.type === 'ai.verification.window');
  ok(waits.length >= 1, '发出 ai.verification.window 事件（WAIT 次数 = ' + waits.length + '）');
  ok(waits.some((e) => e.payload.observationCount >= 2), 'RECHECK（重新观察）真实发生');
}

// 3b) async-never-success：永远不出现 SUCCESS → 超时收口，绝不无限等待
{
  const start = Date.now();
  let calls = 0;
  const fakeInspect = async () => { calls++; return { ok: true, observation: { url: 'http://x/never', textSummary: 'Processing…', domFingerprint: 'fp' + calls } }; };
  const fakeVerify = (c, after) => ({ success: /SUCCESS/.test(after.textSummary || ''), used: 'primary' });
  const win = await vwin.runObservationWindow({
    page: {}, taskId: 't2', ctx: { taskId: 't2' },
    verification: { type: 'text_present', expect: 'SUCCESS' }, beforeObservation: {},
    initialObservation: { url: 'http://x/never', textSummary: 'Processing…', domFingerprint: 'fp0' },
    decision: 'STATE_UNKNOWN', verifyFn: fakeVerify, inspectFn: fakeInspect, emit: () => {},
  });
  const elapsed = Date.now() - start;
  ok(win.recovered === false, 'async-never：窗口明确未恢复（recovered=false）');
  ok(elapsed < 8000, 'async-never：窗口在 8s 内收口（无无限等待），实际 ' + elapsed + 'ms');
  ok(win.elapsedMs <= vwin.DEFAULT_MAX_MS + 1500, '窗口受 maxMs 上限约束（elapsedMs=' + win.elapsedMs + '）');
}

// 3c) EVENTUAL_CONSISTENCY 时序窗口：使用完整时间表，仍能在第 2 次重观察恢复
{
  let calls = 0;
  const fakeInspect = async () => { calls++; const text = calls >= 2 ? 'Data: SUCCESS' : 'Data: Pending'; return { ok: true, observation: { url: 'http://x/ec', textSummary: text, domFingerprint: 'fp' + calls } }; };
  const fakeVerify = (c, after) => ({ success: /SUCCESS/.test(after.textSummary || ''), used: 'primary' });
  const win = await vwin.runObservationWindow({
    page: {}, taskId: 't3', ctx: { taskId: 't3' },
    verification: { type: 'text_present', expect: 'SUCCESS' }, beforeObservation: {},
    initialObservation: { url: 'http://x/ec', textSummary: 'Data: Pending', domFingerprint: 'fp0' },
    decision: 'EVENTUAL_CONSISTENCY', verifyFn: fakeVerify, inspectFn: fakeInspect, emit: () => {},
  });
  ok(win.recovered === true, 'EVENTUAL_CONSISTENCY：完整时间表下恢复成功（第2次重观察）');
}

// ---------------------------------------------------------------
section('4. verifyFailed 路由（真实重验证，杜绝 silent-pass）');

const submitBtn = { id: '', role: 'button', tag: 'button', type: '', name: 'submit', text: 'submit', placeholder: '', label: '', ariaLabel: '', cls: '', visible: true, state: {} };
// 重观察返回的「页面未变化」观察（与 before 一致 → 无 page_change；submit 仍在 → element_absent 不成立）。
const NOCHANGE_OBS = { url: 'http://x', textSummary: 'rechecked generic', domFingerprint: 'fpX', elements: [submitBtn] };
function mockCtx(failureType, contract, opts) {
  opts = opts || {};
  const calls = [];
  const reObs = opts.reObs || NOCHANGE_OBS;
  return {
    error: { failureType },
    observation: opts.beforeObs || null, // beforeObs（修复重验证的真实 before 观察）
    runAction: async (a) => {
      calls.push(a.type);
      return { success: true, observation: reObs };
    },
    calls,
    contract,
  };
}
const stepFor = (contract) => ({ action: { type: 'click', target: { field: 'submit', semantic: 'submit' }, verification: contract || { type: 'none' } }, verification: contract || { type: 'none' } });

// 4a) STATE_UNKNOWN：不再放弃——执行 wait + inspect（RECHECK），并真实重验证（此处 contract 失败 → ok:false）
{
  const ctx = mockCtx('STATE_UNKNOWN', { type: 'text_present', expect: 'nope' }, { beforeObs: NOCHANGE_OBS, reObs: NOCHANGE_OBS });
  const out = await verifyFailed.execute({ task: {}, step: stepFor({ type: 'text_present', expect: 'nope' }), ctx });
  ok(ctx.calls.includes('wait') && ctx.calls.includes('inspect'), 'STATE_UNKNOWN → 执行 RECHECK（wait + inspect），不再 no_repair 放弃');
  ok(out.ok === false, 'STATE_UNKNOWN：重验证未通过 → ok:false（不 silent-pass）');
  ok(out.actions.some((a) => a.tool === 'retry_verify' && a.ok === false), '记录 retry_verify ok:false（真实验证结果）');
}

// 4b) VERIFICATION_TOO_STRICT：提供替代态 → 重验证命中 → ok:true
{
  const ctx = mockCtx('VERIFICATION_TOO_STRICT', { type: 'text_present', expect: 'missing', allowedAlternativeStates: [{ type: 'text_present', expect: 'rechecked' }] }, { beforeObs: NOCHANGE_OBS, reObs: NOCHANGE_OBS });
  const out = await verifyFailed.execute({ task: {}, step: stepFor({ type: 'text_present', expect: 'missing', allowedAlternativeStates: [{ type: 'text_present', expect: 'rechecked' }] }), ctx });
  ok(out.ok === true, 'VERIFICATION_TOO_STRICT：替代态命中 → ok:true');
  ok(out.actions.some((a) => a.tool === 'retry_verify' && a.used === 'alternative' && a.ok === true), '记录 retry_verify used=alternative ok:true');
}

// 4c) ACTION_REAL_FAILURE：重执行且真实重验证；此处观察未变化（目标仍在）→ ok:false（不 silent-pass）
{
  const ctx = mockCtx('ACTION_REAL_FAILURE', { type: 'text_present', expect: 'nope' }, { beforeObs: NOCHANGE_OBS, reObs: NOCHANGE_OBS });
  const out = await verifyFailed.execute({ task: {}, step: stepFor({ type: 'text_present', expect: 'nope' }), ctx });
  const retry = out.actions.find((a) => a.tool === 'retry_verify' && a.targetObject === true);
  ok(retry && retry.targetObject === true, 'ACTION_REAL_FAILURE → 重执行且 target 对象保留');
  ok(out.ok === false, 'ACTION_REAL_FAILURE：重执行后重验证未通过 → ok:false（不 silent-pass）');
}

// 4d) DOM_CHANGED：语义重定位 + 重观察 + 真实重验证
{
  const ctx = mockCtx('DOM_CHANGED', { type: 'text_present', expect: 'nope' }, { beforeObs: NOCHANGE_OBS, reObs: NOCHANGE_OBS });
  const out = await verifyFailed.execute({ task: {}, step: stepFor({ type: 'text_present', expect: 'nope' }), ctx });
  ok(ctx.calls.includes('wait') || ctx.calls.includes('inspect'), 'DOM_CHANGED：进入重观察路径');
  ok(out.ok === false, 'DOM_CHANGED：重验证未通过 → ok:false（不 silent-pass）');
}

console.log('\n---------------------------------------------------');
console.log('PASS=' + pass + '  FAIL=' + fail);
console.log('---------------------------------------------------');
process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
