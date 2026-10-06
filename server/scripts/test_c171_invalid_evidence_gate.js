'use strict';

// C171 — 恒真证据（P2 invalidEvidence=precondition_true）不得进入「重试 → 重执行」循环。
//
// 触发事件（task_muwco0lhxif step_003，C169 首次真实任务 / 真实站点 / 真实 LLM）：
//   planner 判据 url_contains "/signup"，动作 click「Get Started」。第 1 次点击后页面异步跳转，
//   **第 3 次尝试时 before/after 均为 app.spocket.co/signup** ⇒ 谓词在动作执行前已成立。
//   裁决面（verification.js）正确地以 P2 判「恒真证据、与本次动作无因果」——**该守卫是对的，
//   本批绝不放宽**。问题在诊断/执行层：
//     ① 诊断层看不到 invalidEvidence（verification.js 已产出，从未传入 VIL）⇒ 被
//        networkState=pending 抢先归 EVENTUAL_CONSISTENCY → WAIT；
//     ② 观察窗口耗尽后，主循环的 canRetry **无条件重执行原动作** ⇒ 在注册页上重放同一个
//        click「Get Started」，而它在注册页是**提交按钮** ⇒ 空表单连提 4 次，
//        把站点逼出 hCaptcha 挑战（**自伤**，不是环境先决条件）。
//
// 修复（三层，缺一不可）：
//   L1 VIL：invalidEvidence 优先于 networkState / loadingState ⇒ INVALID_EVIDENCE + PLAN_STALE
//   L2 runtime 主循环：恒真失败不消耗重试预算（canRetry 短路）⇒ 不重放动作
//   L3 runtime 主循环：恒真失败直达 replan 门（基于实况重规划剩余步骤）；replan 不可用 →
//      显式升级人工，reason='INVALID_EVIDENCE'。**绝不因此判成功、绝不静默重放**。
//   顺带收口：replan 门（R5 熔断 + 预算 + tryReplan + 替换剩余步骤）原为两份逐字副本，
//      恒真入口使其变成三份 ⇒ 收口为 _replanGate 唯一实现。
//
// 纪律：断言真正执行的那份（真实调用 VIL，不 eval 源码）；源码断言只用于「位置/唯一性」这类
//       无法由纯函数表达的不变量；不放宽任何门禁；revert 对照必须红。

const os = require('os');
const path = require('path');
const fs = require('fs');

// ⚠️ 隔离必须在 require 任何 agent 模块之前（数据根为模块加载期解析）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c171-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const ROOT = path.join(__dirname, '..', '..');
const vil = require('../agent/verification/verificationIntelligence');
const errorClassifier = require('../agent/recovery/errorClassifier');

const RUNTIME_SRC = fs.readFileSync(path.join(__dirname, '..', 'agent', 'runtime.js'), 'utf-8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' :: ' + (e && e.message));
    console.log('  FAIL ' + name + ' :: ' + (e && e.message));
  }
}
function ok(cond, msg) { assert.ok(cond, msg); }

// ── 现场复刻：C169 step_003 第 3 次尝试 ──────────────────────────────────────
// before.url === after.url === 注册页，且 networkState=pending（正是让旧实现误归 EVENTUAL 的组合）
const SIGNUP = 'https://app.spocket.co/signup?spocket_language=en&utm_source=affiliate';
const beforeObs = () => ({ url: SIGNUP, networkState: 'idle', loadingState: 'complete' });
const afterObs = (extra) => Object.assign(
  { url: SIGNUP, networkState: 'pending', loadingState: 'complete', previousObservationDiff: {} }, extra || {});
const expectedVerification = { type: 'url_contains', expect: '/signup' };
const clickAction = { type: 'click', risk: 'MEDIUM', target: { semantic: 'Get Started' } };
const okResult = (obs) => ({ success: true, observation: obs });

const analyze = (opts) => vil.analyze(Object.assign({
  beforeObservation: beforeObs(),
  afterObservation: afterObs(),
  expectedVerification,
  actionResult: okResult(afterObs()),
  action: clickAction,
}, opts || {}));

// 小工具：避免在断言里写裸字面（防「同一语义两处口径」）
function vot(name) { return vil.FAILURE_TYPES[name] || name; }

console.log('\n== A 组：诊断层归因优先级（真实调用 VIL，非源码字面）==');

check('A1 恒真 + networkState=pending ⇒ INVALID_EVIDENCE/PLAN_STALE（优先于 EVENTUAL_CONSISTENCY）', () => {
  const r = analyze({ invalidEvidence: 'precondition_true' });
  ok(r.failureType === vot('INVALID_EVIDENCE'), 'failureType=' + r.failureType + '（期望 INVALID_EVIDENCE）');
  ok(r.decision === 'PLAN_STALE', 'decision=' + r.decision + '（期望 PLAN_STALE）');
  ok(!r.evidence.join('').includes('异步一致性延迟'), '不应残留异步一致性归因');
});

check('A2 对照：不传 invalidEvidence ⇒ 原归因 EVENTUAL_CONSISTENCY（零副作用）', () => {
  const r = analyze({});
  ok(r.failureType === 'EVENTUAL_CONSISTENCY', 'failureType=' + r.failureType);
  ok(r.decision === 'WAIT', 'decision=' + r.decision);
});

check('A3 恒真 + 页面仍在加载 ⇒ 仍 PLAN_STALE（优先于 OBSERVATION_DELAY）', () => {
  const r = analyze({ afterObservation: afterObs({ networkState: 'idle', loadingState: 'loading' }), invalidEvidence: 'precondition_true' });
  ok(r.failureType === 'INVALID_EVIDENCE', 'failureType=' + r.failureType);
});

check('A4 PLAN_STALE 不进观察窗口（不白等一个完整窗口）', () => {
  ok(vil.isReobservableDecision('PLAN_STALE') === false, 'PLAN_STALE 不应被判为可重观察');
  ok(vil.isReobservableDecision('WAIT') === true, 'WAIT 应仍可重观察（既有行为不变）');
});

check('A5 动作本身失败优先（不掩盖真实动作失败）', () => {
  const r = analyze({ actionResult: { success: false }, invalidEvidence: 'precondition_true' });
  ok(r.failureType === 'ACTION_REAL_FAILURE', 'failureType=' + r.failureType);
  ok(r.decision === 'RE_EXECUTE', 'decision=' + r.decision);
});

check('A6 只认 precondition_true：其它 invalidEvidence 值不触发（不放宽）', () => {
  for (const v of ['precondition_false', 'unknown', '', null, undefined, true]) {
    const r = analyze({ invalidEvidence: v });
    ok(r.failureType === 'EVENTUAL_CONSISTENCY', 'invalidEvidence=' + String(v) + ' 误触发 ' + r.failureType);
  }
});

console.log('\n== B 组：runtime 主循环接线（位置 / 唯一性不变量）==');

check('B1 canRetry 受恒真信号约束（不消耗重试预算）', () => {
  ok(/const _invalidEvidence = !!\(r\.error && r\.error\.invalidEvidence === 'precondition_true'\)/.test(RUNTIME_SRC),
    '未按 precondition_true 求恒真信号');
  ok(/const canRetry = !_invalidEvidence && /.test(RUNTIME_SRC),
    'canRetry 未受 _invalidEvidence 约束');
});

check('B2 恒真短接块位于 repairManager.handleStepFailure 之前（不先走修复链）', () => {
  const gateIdx = RUNTIME_SRC.indexOf("if (r.error && r.error.invalidEvidence === 'precondition_true')");
  const repairIdx = RUNTIME_SRC.indexOf('repairManager.handleStepFailure');
  ok(gateIdx > 0, '未找到恒真短接块');
  ok(repairIdx > 0, '未找到 repair 调用点');
  ok(gateIdx < repairIdx, '恒真短接块必须位于 repair 之前（否则 repair 会先重执行）');
});

check('B3 恒真失败直达 replan 门；replan 不可用 → 显式升级（不静默、不判成功）', () => {
  const gateIdx = RUNTIME_SRC.indexOf("if (r.error && r.error.invalidEvidence === 'precondition_true')");
  const block = RUNTIME_SRC.slice(gateIdx, gateIdx + 1600);
  ok(/await _replanGate\(/.test(block), '恒真块未走 replan 门');
  ok(/reason: 'INVALID_EVIDENCE'/.test(block), '升级 fallback 缺失或 reason 未标记');
  ok(/taskManager\.escalate\(/.test(block), 'replan 不可用时未显式升级人工');
  ok(!/setStepState\(step\.id, 'SUCCESS'\)/.test(block), '恒真块不得把本步置 SUCCESS（禁伪成功）');
  ok(!/succeedAttempt\(/.test(block), '恒真块不得直接确认成功');
});

check('B4 恒真块不自行重执行动作（无 tools.execute / runTool 直调）', () => {
  const gateIdx = RUNTIME_SRC.indexOf("if (r.error && r.error.invalidEvidence === 'precondition_true')");
  const block = RUNTIME_SRC.slice(gateIdx, gateIdx + 1600);
  ok(!/tools\.execute\(/.test(block), '恒真块内出现直接执行动作');
  ok(!/tools\.runTool\(/.test(block), '恒真块内出现工具直调（绕过 runStep）');
});

console.log('\n== C 组：replan 门唯一实现（三份 → 一份）==');

check('C1 tryReplan 调用点唯一', () => {
  const n = (RUNTIME_SRC.match(/await tryReplan\(/g) || []).length;
  ok(n === 1, 'await tryReplan( 出现 ' + n + ' 次（期望 1：唯一实现收口）');
});

check('C2 R5 熔断判定唯一', () => {
  const n = (RUNTIME_SRC.match(/if \(shouldFuseSameSigReplan\(/g) || []).length;
  ok(n === 1, 'shouldFuseSameSigReplan 调用 ' + n + ' 次（期望 1）');
});

check('C3 _replanGate 定义一次、三处调用', () => {
  const defs = (RUNTIME_SRC.match(/const _replanGate = async \(reason\) =>/g) || []).length;
  const calls = (RUNTIME_SRC.match(/await _replanGate\(/g) || []).length;
  ok(defs === 1, '_replanGate 定义 ' + defs + ' 次（期望 1）');
  ok(calls === 3, '_replanGate 调用 ' + calls + ' 次（期望 3：恒真 / 修复超时兜底 / 常规 plan-stale）');
});

check('C4 预算与熔断约束仍全部在门内（收口未削弱约束）', () => {
  const defIdx = RUNTIME_SRC.indexOf('const _replanGate = async (reason) =>');
  const def = RUNTIME_SRC.slice(defIdx, defIdx + 1400);
  ok(/maxReplansFor\(task\)/.test(def), '门内缺 maxReplans 预算约束');
  ok(/shouldFuseSameSigReplan\(/.test(def), '门内缺 R5 熔断约束');
  ok(/isReplanCandidate\(r\.error, step\)/.test(RUNTIME_SRC), '候选门缺失');
});

console.log('\n== D 组：错误类别字典闭合（新增 failureType 必须可被分类）==');

check('D1 VIL 全部 failureType 均在 errorClassifier.RECOVERY_CATEGORIES', () => {
  for (const t of Object.values(vil.FAILURE_TYPES)) {
    ok(errorClassifier.RECOVERY_CATEGORIES.includes(t), 'RECOVERY_CATEGORIES 缺 ' + t);
  }
});

check('D2 classifyVerificationFailure 认得 INVALID_EVIDENCE', () => {
  const r = errorClassifier.classifyVerificationFailure('INVALID_EVIDENCE');
  ok(r.recognized === true, '未登记 INVALID_EVIDENCE（会被降级为 UNKNOWN 兜底）');
  ok(r.category === 'INVALID_EVIDENCE', 'category=' + r.category);
});

console.log('\n==== C171 结果：' + pass + ' passed, ' + fail + ' failed ====');
console.log('C171 invalid-evidence gate: PASS=' + pass + ' FAIL=' + fail);
if (fail) {
  console.log('失败项：');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
