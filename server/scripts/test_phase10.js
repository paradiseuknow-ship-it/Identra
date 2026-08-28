'use strict';

// Phase 10 v0.2.1 单元测试（仅验证新增能力，不依赖浏览器 / LLM / 数据库）。
// 运行：node server/scripts/test_phase10.js

const vil = require('../agent/verification/verificationIntelligence');
const resolver = require('../agent/semanticResolver');
const verifyFailed = require('../agent/repair/strategies/verifyFailed');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n=== ' + name + ' ==='); }

// ---------------------------------------------------------------
section('1. Verification Intelligence 分类');
const baseAfter = { loadingState: 'complete', networkState: 'idle', previousObservationDiff: { domChanged: false } };

// 动作失败
let r = vil.analyze({ beforeObservation: {}, afterObservation: baseAfter, expectedVerification: { type: 'text_present', expect: 'x' }, actionResult: { success: false } });
ok(r.failureType === 'ACTION_REAL_FAILURE' && r.decision === 'RE_EXECUTE', 'actionOk=false → ACTION_REAL_FAILURE/RE_EXECUTE');

// 网络 pending
r = vil.analyze({ beforeObservation: {}, afterObservation: { ...baseAfter, networkState: 'pending' }, expectedVerification: { type: 'text_present', expect: 'x' }, actionResult: { success: true } });
ok(r.failureType === 'EVENTUAL_CONSISTENCY' && r.decision === 'WAIT', 'networkState=pending → EVENTUAL_CONSISTENCY/WAIT');

// 加载未完
r = vil.analyze({ beforeObservation: {}, afterObservation: { ...baseAfter, loadingState: 'loading' }, expectedVerification: { type: 'text_present', expect: 'x' }, actionResult: { success: true } });
ok(r.failureType === 'OBSERVATION_DELAY' && r.decision === 'RETRY_VERIFY', 'loadingState=loading → OBSERVATION_DELAY/RETRY_VERIFY');

// DOM 变化
r = vil.analyze({ beforeObservation: {}, afterObservation: { ...baseAfter, previousObservationDiff: { domChanged: true } }, expectedVerification: { type: 'text_present', expect: 'x' }, actionResult: { success: true } });
ok(r.failureType === 'DOM_CHANGED' && r.decision === 'RETRY_VERIFY', 'domChanged → DOM_CHANGED/RETRY_VERIFY（Fresh Observation；前序已批准修复落地，断言同步）');

// 验证过严（期望文本实际存在）
r = vil.analyze({ beforeObservation: {}, afterObservation: { ...baseAfter, visibleText: 'Welcome to your dashboard' }, expectedVerification: { type: 'text_present', expect: 'dashboard' }, actionResult: { success: true } });
ok(r.failureType === 'VERIFICATION_TOO_STRICT' && r.decision === 'RETRY_VERIFY', '期望文本存在但规则未匹配 → VERIFICATION_TOO_STRICT/RETRY_VERIFY');

// login_state 脆弱 → TOO_STRICT
r = vil.analyze({ beforeObservation: {}, afterObservation: baseAfter, expectedVerification: { type: 'login_state' }, actionResult: { success: true } });
ok(r.failureType === 'VERIFICATION_TOO_STRICT', 'login_state 未匹配 → VERIFICATION_TOO_STRICT');

// 稳定无证据 → STATE_UNKNOWN（Phase 10.7 改为 RECHECK，不再直接放弃）
r = vil.analyze({ beforeObservation: {}, afterObservation: baseAfter, expectedVerification: { type: 'text_present', expect: 'zzz-no-such-text' }, actionResult: { success: true } });
ok(r.failureType === 'STATE_UNKNOWN' && r.decision === 'RECHECK_OBSERVATION', '稳定但无证据 → STATE_UNKNOWN/RECHECK_OBSERVATION（不再 HUMAN_ESCALATE）');

// ---------------------------------------------------------------
section('2. Resolver 多信号评分 + matchedBy');
function elem(over) { return Object.assign({ id: '', role: '', tag: 'input', type: 'text', name: '', cls: '', text: '', placeholder: '', label: '', ariaLabel: '', visible: true, state: {} }, over); }

// email：name=email
let cands = resolver.resolve({ field: 'email' }, { elements: [elem({ name: 'email', type: 'email', placeholder: 'Email' })] });
ok(cands.length && cands[0].matchedBy === 'attribute' && cands[0].score >= 0.95, 'email field → matchedBy=attribute (canonical, name 信号归一), high score');

// password：type=password + placeholder
cands = resolver.resolve({ field: 'password' }, { elements: [elem({ name: 'pwd', type: 'password', placeholder: 'Password' })] });
ok(cands.length && cands[0].matchedBy === 'attribute' && cands[0].score >= 0.95, 'password field → matchedBy=attribute (canonical, name 信号归一) (pwd token)');

// search：placeholder=Search
cands = resolver.resolve({ field: 'search' }, { elements: [elem({ placeholder: 'Search', type: 'search' })] });
ok(cands.length && cands[0].score >= 0.9, 'search field → placeholder matched, score>=0.9');

// dynamic table：输入在 table 内，靠 name 定位
cands = resolver.resolve({ field: 'quantity', semantic: 'quantity' }, { elements: [elem({ name: 'quantity', type: 'number' }), elem({ name: 'price', type: 'text' })] });
ok(cands.length && cands[0].matchedBy === 'attribute' && cands[0].selector && cands[0].selector.includes('name='), 'dynamic table → attribute 定位(name 信号归一) 且生成 name selector');

// SPA form：输入靠 aria-label 出现
cands = resolver.resolve({ field: 'email' }, { elements: [elem({ ariaLabel: 'email address', type: 'email' })] });
ok(cands.length && (cands[0].matchedBy === 'aria' || cands[0].score >= 0.9), 'SPA form → aria-label 命中');

// 无 field 纯 semantic
cands = resolver.resolve({ semantic: 'Submit' }, { elements: [elem({ tag: 'button', role: 'button', text: 'Submit', ariaLabel: 'Submit' })] });
ok(cands.length && cands[0].matchedBy === 'text', '纯语义但命中元素自身可见文本 Submit → matchedBy=text (canonical)');

// ---------------------------------------------------------------
section('3. Repair 路由（verifyFailed 按 failureType 分流）');
const submitBtn = { id: '', role: 'button', tag: 'button', type: '', name: 'submit', text: 'submit', placeholder: '', label: '', ariaLabel: '', cls: '', visible: true, state: {} };
// 重观察返回的「页面未变化」观察（与 before 一致即判定无 page_change；submit 仍在 → element_absent 不成立）。
const NOCHANGE_OBS = { url: 'http://x', textSummary: 'rechecked generic', elements: [submitBtn] };
function mockCtx(failureType, opts) {
  opts = opts || {};
  const calls = [];
  const reObs = opts.reObs || { url: 'http://x', textSummary: 'rechecked generic' };
  return {
    error: { failureType },
    observation: opts.beforeObs || null,
    runAction: async (a) => { calls.push(a.type); return { success: true, observation: reObs }; },
    calls,
  };
}
const step = { action: { type: 'click', target: { field: 'submit', semantic: 'submit' }, verification: { type: 'action_success' } } };

(async () => {
  // STATE_UNKNOWN：不再放弃——执行 wait + inspect（RECHECK）并重验证；此处 contract 失败 → ok:false
  let ctx = mockCtx('STATE_UNKNOWN', { beforeObs: NOCHANGE_OBS, reObs: NOCHANGE_OBS });
  // verification 必须是 step 的直接属性（与 runtime 中 step.verification 一致），且使重验证契约失败
  const stepSU = { action: { type: 'click', target: { field: 'submit', semantic: 'submit' } }, verification: { type: 'text_present', expect: 'nope' } };
  let out = await verifyFailed.execute({ task: {}, step: stepSU, ctx });
  ok(out.ok === false && ctx.calls.includes('wait') && ctx.calls.includes('inspect'), 'STATE_UNKNOWN → RECHECK（wait+inspect）重验证，未通过则 ok=false（不再 no_repair 放弃）');

  // OBSERVATION_DELAY：wait + inspect
  ctx = mockCtx('OBSERVATION_DELAY');
  out = await verifyFailed.execute({ task: {}, step, ctx });
  ok(out.ok === true && ctx.calls.includes('wait') && ctx.calls.includes('inspect'), 'OBSERVATION_DELAY → wait+inspect，ok=true');

  // EVENTUAL_CONSISTENCY：wait + inspect
  ctx = mockCtx('EVENTUAL_CONSISTENCY');
  out = await verifyFailed.execute({ task: {}, step, ctx });
  ok(out.ok === true && ctx.calls.includes('wait'), 'EVENTUAL_CONSISTENCY → wait+inspect，ok=true');

  // VERIFICATION_TOO_STRICT：wait + inspect
  ctx = mockCtx('VERIFICATION_TOO_STRICT');
  out = await verifyFailed.execute({ task: {}, step, ctx });
  ok(out.ok === true && ctx.calls.includes('wait'), 'VERIFICATION_TOO_STRICT → wait+inspect，ok=true');

  // ACTION_REAL_FAILURE：重执行原动作（targetObject 保留）
  ctx = mockCtx('ACTION_REAL_FAILURE');
  out = await verifyFailed.execute({ task: {}, step, ctx });
  const retry = out.actions.find((a) => a.tool === 'retry_verify');
  ok(out.ok === true && retry && retry.targetObject === true, 'ACTION_REAL_FAILURE → 重执行且 target 对象保留');

  // DOM_CHANGED：元素结构变化 → 语义重定位（reload + 重试）→ 重观察（wait + inspect）→ 真实重验证
  ctx = mockCtx('DOM_CHANGED', { beforeObs: NOCHANGE_OBS, reObs: NOCHANGE_OBS });
  const stepDC = { action: { type: 'click', target: { field: 'submit', semantic: 'submit' } }, verification: { type: 'text_present', expect: 'nope' } };
  out = await verifyFailed.execute({ task: {}, step: stepDC, ctx });
  ok(out.ok === false && ctx.calls.includes('reload') && ctx.calls.includes('inspect'), 'DOM_CHANGED → 语义重定位(reload) + 重观察(inspect) + 真实重验证（未通过则 ok=false，不 silent-pass）');

  console.log('\n---------------------------------------------------');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  console.log('---------------------------------------------------');
  process.exit(fail ? 1 : 0);
})();
