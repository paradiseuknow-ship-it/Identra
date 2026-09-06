'use strict';

// ② escalationSplit 统计口径修复 — 针对性回归测试（2026-08-31 P1 收口阶段）
//
// 锁定契约（用户指定覆盖项）：
//   T1. VERIFY_RETRY（验证重试升级，kind='verification'）→ 不属于 REAL
//   T2. CAPTCHA/OTP/真实业务拒绝 → 可属于 REAL（唯一计入 REAL 的类别）
//   T3. ENGINEERING_FAILURE（resolver/execution/recovery）→ 不属于 CREDIBLE_BUSINESS 也不属于 REAL
//   T4. CREDIBLE_BUSINESS：凭据/支付/审批门控（kind 或 codes/文本回退）
//   T5. TIMEOUT / CANCELLED / SUCCESS→null 边界
//   T6. 事件链可复核性：纯函数 —— 同一原始事件链输入结果恒定；不修改输入对象（frozen 验证）
//   T7. aggregate 聚合冒烟：escalationClasses 五分类齐全，escalationReal 只统计 REAL
//
// 纪律：只测统计层（escalationClass.js 纯模块 + phase10Benchmark.aggregate 冒烟），
//       不启动 benchmark、不跑任务、不需要真实 API KEY（仅 require 冒烟）。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 FPB_DATA_DIR：必须在 require 任何 agent 模块之前设置
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-esc-class-'));
process.env.FPB_DATA_DIR = tmpData;
// phase10Benchmark 顶层有无 KEY 守卫（禁止 mock 纪律）：require 冒烟用 dummy key，
// 只触发模块加载与 fetch 包装，不发起任何网络请求、不跑任何任务。
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'dummy-for-require-smoke-only';

const assert = require('assert');
const { classifyEscalation, CLASS_KEYS } = require('../scripts/escalationClass');
const phase10 = require('../scripts/phase10Benchmark');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' :: ' + String(e.message || e).slice(0, 200));
    console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 200));
  }
}

// 逐任务原始事件链构造器（形态对齐 runScenario 的 final + codes）
function taskFinal(over) {
  return Object.assign({ id: 't1', status: 'HUMAN_ESCALATION', error: '需人工介入', escalationKind: 'verification' }, over || {});
}

function runSuite(tag) {
  console.log('=== suite ' + tag + ' ===');

  // ---- T1: VERIFY_RETRY 不属于 REAL ----
  check('T1: kind=verification（验证重试升级）→ VERIFY_RETRY，不属于 REAL', () => {
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: 'verification' }), []), 'VERIFY_RETRY');
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: 'verification', error: '验证重试次数耗尽: VERIFY_FAILED' }), ['VERIFY_FAILED']), 'VERIFY_RETRY');
  });

  check('T1: 回退路径 codes 含 VERIF（无持久化 kind）→ VERIFY_RETRY', () => {
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: undefined }), ['VERIFICATION_FAILED']), 'VERIFY_RETRY');
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: null, error: '验证未通过：requiredEvidence 不满足' }), []), 'VERIFY_RETRY');
  });

  // ---- T2: 真实业务拒绝 → REAL ----
  check('T2: CAPTCHA/验证码/OTP/风控 → REAL（即使 kind=verification）', () => {
    assert.strictEqual(classifyEscalation(taskFinal({ error: '页面出现 CAPTCHA，需人工通过' }), []), 'REAL');
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: 'verification', error: '验证码输入需要人工' }), []), 'REAL');
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: 'credential', error: 'OTP 校验失败需人工介入' }), []), 'REAL');
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: 'execution', error: '触发风控拦截' }), []), 'REAL');
  });

  // ---- T3: 工程型失败不属于 CREDIBLE 也不属于 REAL ----
  check('T3: resolver/execution/recovery → ENGINEERING_FAILURE（不属 CREDIBLE/REAL）', () => {
    for (const kind of ['resolver', 'execution', 'recovery', 'unknown_kind']) {
      assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: kind }), []), 'ENGINEERING_FAILURE', 'kind=' + kind);
    }
  });

  // ---- T4: CREDIBLE_BUSINESS ----
  check('T4: credential/payment/permission/CRITICAL kind → CREDIBLE_BUSINESS', () => {
    for (const kind of ['credential', 'payment', 'permission', 'CRITICAL']) {
      assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: kind }), []), 'CREDIBLE_BUSINESS', 'kind=' + kind);
    }
  });

  check('T4: 回退路径 codes CREDENTIAL / 文本凭据门控 → CREDIBLE_BUSINESS', () => {
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: undefined }), ['CREDENTIAL_UNAVAILABLE']), 'CREDIBLE_BUSINESS');
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: null, error: '支付需要人工确认' }), []), 'CREDIBLE_BUSINESS');
    assert.strictEqual(classifyEscalation(taskFinal({ escalationKind: null, error: '需要审批' }), []), 'CREDIBLE_BUSINESS');
  });

  // ---- T5: 边界 ----
  check('T5: CANCELLED/TIMEOUT/SUCCESS 边界', () => {
    assert.strictEqual(classifyEscalation(taskFinal({ status: 'CANCELLED' }), []), 'CANCELLED');
    assert.strictEqual(classifyEscalation(taskFinal({ status: 'TIMEOUT', escalationKind: undefined }), []), 'TIMEOUT');
    assert.strictEqual(classifyEscalation(taskFinal({ status: 'FAILED', escalationKind: undefined, error: '执行崩溃' }), []), 'ENGINEERING_FAILURE');
    assert.strictEqual(classifyEscalation({ status: 'SUCCESS' }, []), null);
    assert.strictEqual(classifyEscalation(null, []), null);
  });

  // ---- T6: 事件链可复核性（纯函数）----
  check('T6: 纯函数 —— 同一事件链输入两次结果恒定，且不修改输入（frozen）', () => {
    const codes = ['VERIFY_FAILED', 'ELEMENT_NOT_FOUND'];
    const final = Object.freeze(taskFinal({ escalationKind: 'verification', error: '验证重试耗尽' }));
    const r1 = classifyEscalation(final, Object.freeze(codes.slice()));
    const r2 = classifyEscalation(final, Object.freeze(codes.slice()));
    assert.strictEqual(r1, r2);
    assert.strictEqual(r1, 'VERIFY_RETRY');
    // 输入对象未被修改（可由外部事件链重放）
    assert.strictEqual(final.status, 'HUMAN_ESCALATION');
    assert.strictEqual(final.escalationKind, 'verification');
    assert.deepStrictEqual(codes, ['VERIFY_FAILED', 'ELEMENT_NOT_FOUND']);
  });

  check('T6: 分类只依赖 status/escalationKind/error/codes —— 与旧口径差异可由事件链解释', () => {
    // 旧 escalationSplit：kind=verification + codes 无 CREDENTIAL + 文本无凭据词 → 'REAL'（误计）
    // 新口径：同一事件链 → VERIFY_RETRY（不再计入 REAL），且判定材料完全来自同一份原始事件链
    const final = taskFinal({ escalationKind: 'verification', error: '验证未通过' });
    assert.strictEqual(classifyEscalation(final, []), 'VERIFY_RETRY');
    assert.notStrictEqual(classifyEscalation(final, []), 'REAL');
    assert.notStrictEqual(classifyEscalation(final, []), 'CREDIBLE_BUSINESS');
  });

  // ---- T7: aggregate 聚合冒烟 ----
  check('T7: CLASS_KEYS 六类齐全；aggregate([]) 返回含 escalationClasses 零值结构', () => {
    assert.deepStrictEqual(
      [...CLASS_KEYS].sort(),
      ['CANCELED' === 'x' ? 'x' : 'CANCELLED', 'CREDIBLE_BUSINESS', 'ENGINEERING_FAILURE', 'REAL', 'TIMEOUT', 'VERIFY_RETRY'].sort(),
    );
    const agg = phase10.aggregate([]);
    assert.ok(agg.escalationClasses, 'aggregate 应返回 escalationClasses');
    CLASS_KEYS.forEach((k) => assert.strictEqual(agg.escalationClasses[k], 0, '空结果时 ' + k + ' 应为 0'));
    assert.strictEqual(agg.escalationReal, 0);
    assert.strictEqual(agg.escalationCredible, 0);
  });

  check('T7: aggregate 对混合结果按 escalationClass 正确聚合（REAL 不含 VERIFY_RETRY）', () => {
    const results = [
      { status: 'SUCCESS', stepCount: 3, attemptCount: 3, successAttempts: 3, verificationTotal: 2, verificationPassed: 2, retries: 0, repairCount: 0, repairSuccess: 0, tokensPrompt: 0, tokensCompletion: 0, plannerOk: true, taxonomy: null, escalated: false, escalationKind: null, escalationClass: null, scores: {} },
      { status: 'HUMAN_ESCALATION', stepCount: 2, attemptCount: 4, successAttempts: 2, verificationTotal: 3, verificationPassed: 1, retries: 2, repairCount: 1, repairSuccess: 0, tokensPrompt: 0, tokensCompletion: 0, plannerOk: true, taxonomy: 'VERIFY_FAILED', escalated: true, escalationKind: 'REAL', escalationClass: 'VERIFY_RETRY', scores: {} },
      { status: 'HUMAN_ESCALATION', stepCount: 2, attemptCount: 2, successAttempts: 1, verificationTotal: 1, verificationPassed: 0, retries: 0, repairCount: 0, repairSuccess: 0, tokensPrompt: 0, tokensCompletion: 0, plannerOk: true, taxonomy: 'POLICY_BLOCK', escalated: true, escalationKind: 'CREDIBLE', escalationClass: 'CREDIBLE_BUSINESS', scores: {} },
      { status: 'CANCELLED', stepCount: 1, attemptCount: 1, successAttempts: 0, verificationTotal: 0, verificationPassed: 0, retries: 0, repairCount: 0, repairSuccess: 0, tokensPrompt: 0, tokensCompletion: 0, plannerOk: false, taxonomy: null, escalated: false, escalationKind: null, escalationClass: 'CANCELLED', scores: {} },
    ];
    const agg = phase10.aggregate(results);
    assert.strictEqual(agg.escalationClasses.VERIFY_RETRY, 1);
    assert.strictEqual(agg.escalationClasses.CREDIBLE_BUSINESS, 1);
    assert.strictEqual(agg.escalationClasses.CANCELLED, 1);
    assert.strictEqual(agg.escalationClasses.REAL, 0, 'VERIFY_RETRY 不得计入 REAL');
    assert.strictEqual(agg.escalationReal, 0, 'escalationReal（门槛消费字段）只统计 REAL');
    assert.strictEqual(agg.escalationCredible, 1);
  });
}

// ---- ×2 幂等 ----
runSuite('run-1');
runSuite('run-2');

console.log('');
console.log('=== Escalation Class Statistics: ' + pass + ' passed, ' + fail + ' failed ===');
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
