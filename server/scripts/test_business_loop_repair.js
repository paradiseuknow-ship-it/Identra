'use strict';

// Business Loop 最小修复专项 — 测试套件（专项 §二十 / §二十一）。
//
// 设计：纯逻辑 + 静态扫描，无需真实浏览器 / 不污染 server/data。
// 覆盖 Case 1-8 的核心回归：
//   Case 1：DOM_CHANGED 必须路由到「重新观察 + 重新验证」（RETRY_VERIFY），而非直接 RE_EXECUTE/VERIFY_FAILED。
//   Case 2：Verification Window 真实 re-observe（多次 capture observation + 重新验证），fresh observation 命中即 recovered。
//   Case 3：submit 孤儿防护 —— 终态转换前必须收口 RUNNING attempt（静态断言 finalizeOrphans 已接入 + createAttempt 存 taskId）。
//   Case 5：Fresh Observation 规则（capturedAt > actionFinishedAt 才 fresh，无 actionFinishedAt 不得假装 fresh）。
//   Case 6：Observation lineage（observationId / parentObservationId / source / taskId）。
//   Case 7：Resolver telemetry（matchedBy）存在。
//   Case 8：Orphan 防护以 ORPHAN_ATTEMPT 显式收口。
//
// 运行：node server/scripts/test_business_loop_repair.js

const fs = require('fs');
const path = require('path');

const vil = require('../agent/verification/verificationIntelligence');
const verificationWindow = require('../agent/verification/verificationWindow');
const observation = require('../agent/observation');
const semanticResolver = require('../agent/semanticResolver');
const stepManager = require('../agent/stepManager');
const stepManagerSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'stepManager.js'), 'utf8');
const runtimeSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'runtime.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n=== ' + name + ' ==='); }

function domChangedInput({ domChanged = true, expect = 'welcome', actionType = 'click' } = {}) {
  return {
    beforeObservation: { domFingerprint: 'fp_before', url: 'https://x/login', textSummary: 'login', loadingState: 'complete', networkState: 'idle' },
    afterObservation: { domFingerprint: domChanged ? 'fp_after' : 'fp_before', url: 'https://x/dash', textSummary: 'welcome', loadingState: 'complete', networkState: 'idle', previousObservationDiff: { domChanged } },
    expectedVerification: { type: 'text_present', expect },
    actionResult: { success: true },
    action: { type: actionType },
  };
}

function mockPage(textSummary) {
  return {
    on() {}, url() { return 'https://x/dash'; },
    evaluate() {
      return { title: 'D', textSummary, visibleText: textSummary, roleText: '', elements: [], errors: [], loadingState: 'complete', domFingerprint: 'fp' + Math.random() };
    },
  };
}

async function main() {
  // ---- Case 1 ----
  section('Case 1: DOM_CHANGED → Fresh Observation + Re-Verification (RETRY_VERIFY)');
  {
    const r = vil.analyze(domChangedInput({ domChanged: true }));
    ok(r.failureType === 'DOM_CHANGED', 'failureType === DOM_CHANGED (got ' + r.failureType + ')');
    ok(r.decision === vil.DECISIONS.RETRY_VERIFY, 'decision === RETRY_VERIFY（进入观察窗口重新验证），而非 RE_EXECUTE (got ' + r.decision + ')');
    ok(vil.isReobservableDecision(r.decision) === true, 'isReobservableDecision(RETRY_VERIFY) === true → runtime 会进入 Observation Window');
    const r2 = vil.analyze(domChangedInput({ domChanged: false }));
    ok(r2.failureType !== 'DOM_CHANGED', 'DOM 未变时不应归类 DOM_CHANGED (got ' + r2.failureType + ')');
  }

  // ---- Case 2 (含真实窗口 sleep，需 await) ----
  section('Case 2: Verification Window 真实 re-observe（恢复 fresh observation 即成功）');
  {
    let inspectCalls = 0;
    const inspectFn = async () => {
      inspectCalls += 1;
      if (inspectCalls === 1) {
        return { ok: true, observation: { url: 'https://x/dash', textSummary: 'loading', domFingerprint: 'fp1', loadingState: 'complete', networkState: 'idle', capturedAt: Date.now(), source: 'verification_window' } };
      }
      return { ok: true, observation: { url: 'https://x/dash', textSummary: 'welcome', domFingerprint: 'fp2', loadingState: 'complete', networkState: 'idle', capturedAt: Date.now(), source: 'verification_window', fresh: true } };
    };
    const verifyFn = async (v, obs) => ({ success: /welcome/.test(obs.textSummary || ''), used: 'primary', result: {} });
    const win = await verificationWindow.runObservationWindow({
      page: {}, taskId: 't_test', ctx: { taskId: 't_test' },
      verification: { type: 'text_present', expect: 'welcome' },
      beforeObservation: { textSummary: 'login' },
      initialObservation: { textSummary: 'loading', domFingerprint: 'fp1' },
      decision: 'RETRY_VERIFY', verifyFn, inspectFn,
    });
    ok(win.recovered === true, '窗口在 fresh observation 命中后 recovered=true');
    ok(inspectCalls >= 2, '窗口真实重新 capture observation（inspect 调用 ' + inspectCalls + ' 次 ≥ 2）');
    ok(win.observationCount >= 2, 'observationCount=' + win.observationCount + ' ≥ 2（重新观察）');
  }

  // ---- Case 3 ----
  section('Case 3: submit 孤儿防护（终态前收口 RUNNING attempt）');
  {
    const hasFailGuard = /finalizeOrphans\(taskId\);\s*\n\s*return taskManager\.fail\(taskId/.test(runtimeSrc);
    const hasEscalateGuard = /finalizeOrphans\(taskId\);\s*\n\s*return taskManager\.escalate\(taskId/.test(runtimeSrc);
    const hasCompleteGuard = /finalizeOrphans\(taskId\);\s*\n\s*taskManager\.complete\(taskId/.test(runtimeSrc);
    ok(hasFailGuard, 'taskManager.fail 前调用 finalizeOrphans（收口孤儿）');
    ok(hasEscalateGuard, 'taskManager.escalate 前调用 finalizeOrphans（覆盖 19 submit 孤儿主路径 HUMAN_ESCALATION）');
    ok(hasCompleteGuard, 'taskManager.complete 前调用 finalizeOrphans');
    ok(/taskId:\s*\(step && step\.taskId\)/.test(stepManagerSrc), 'createAttempt 存储 taskId（血缘 lineage）');
    ok(/finalizeOrphanAttempts/.test(stepManagerSrc), 'stepManager 导出 finalizeOrphanAttempts');
    ok(/ORPHAN_ATTEMPT/.test(stepManagerSrc), '孤儿以 ORPHAN_ATTEMPT code 显式收口（Case 8）');
  }

  // ---- Case 3b ----
  section('Case 3b: submit 孤儿精确分类 SUBMIT_RESULT_UNKNOWN（P0-3）');
  {
    ok(stepManager.orphanCodeFor({ action: { type: 'submit' } }) === 'SUBMIT_RESULT_UNKNOWN',
      'submit 孤儿 → SUBMIT_RESULT_UNKNOWN（区分于泛化 ORPHAN_ATTEMPT）');
    ok(stepManager.orphanCodeFor({ action: { type: 'click' } }) === 'ORPHAN_ATTEMPT',
      '非 submit 孤儿 → ORPHAN_ATTEMPT（其余动作沿用原分类）');
    ok(stepManager.orphanCodeFor({}) === 'ORPHAN_ATTEMPT', '无 action 兜底 → ORPHAN_ATTEMPT');
    ok(stepManager.orphanCodeFor({ action: null }) === 'ORPHAN_ATTEMPT', 'action=null 兜底 → ORPHAN_ATTEMPT');
  }

  // ---- Case 5 ----
  section('Case 5: Fresh Observation 规则（capturedAt > actionFinishedAt 才 fresh）');
  {
    const r1 = await observation.inspect(mockPage('welcome'), { taskId: 't_fresh_1', skipCache: true, source: 'after_action', actionFinishedAt: Date.now() - 5000 });
    ok(r1.ok && r1.observation.fresh === true, 'after_action 且 capturedAt>actionFinishedAt → fresh=true');
    const r2 = await observation.inspect(mockPage('welcome'), { taskId: 't_fresh_2', skipCache: true });
    ok(r2.ok && r2.observation.fresh === null, '无 actionFinishedAt 时 fresh=null（禁止假装 fresh）');
  }

  // ---- Case 6 ----
  section('Case 6: Observation lineage（observationId / parentObservationId / source / taskId）');
  {
    const a = await observation.inspect(mockPage('welcome'), { taskId: 't_line', skipCache: true, source: 'after_action', actionFinishedAt: Date.now() - 1000 });
    const b = await observation.inspect(mockPage('welcome'), { taskId: 't_line', skipCache: true, source: 'verification_window', actionFinishedAt: Date.now() - 1000 });
    ok(a.ok && typeof a.observation.observationId === 'string' && a.observation.observationId.length > 0, 'observation 带 observationId');
    ok(a.ok && a.observation.source === 'after_action', 'source=after_action');
    ok(b.ok && b.observation.parentObservationId === a.observation.observationId, '第二次观察的 parentObservationId 指向第一次（血缘链成立）');
    ok(b.ok && b.observation.source === 'verification_window', '窗口重观察 source=verification_window');
  }

  // ---- Case 7 ----
  section('Case 7: Resolver telemetry（matchedBy）存在');
  {
    const obs = {
      url: 'https://x/login', textSummary: 'sign in',
      elements: [{ id: 'e1', role: 'button', tag: 'button', text: '登录|Sign In|login', placeholder: null, label: null, ariaLabel: null, visible: true, state: {}, selector: 'button#e1' }],
    };
    const cands = semanticResolver.resolve({ semantic: '登录', field: 'login' }, obs);
    ok(Array.isArray(cands) && cands.length > 0, 'semanticResolver 命中登录按钮');
    ok(cands.length === 0 || typeof cands[0].matchedBy === 'string', 'resolve 结果含 matchedBy 遥测字段');
  }

  console.log('\n────────────────────────────────────────');
  console.log('Business Loop Repair 测试：' + pass + ' passed, ' + fail + ' failed');
  console.log('────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试运行异常:', e); process.exit(2); });
