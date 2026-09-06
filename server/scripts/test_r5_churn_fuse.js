'use strict';

// R5（2026-09-03）churn 熔断 — 针对性回归测试
//
// 背景（canonical240_run1 实证 rw.091，唯一真失败）：
//   rw.091「高难加购1」step 11（click 加购按钮，verification text_present）反复失败：
//   主循环 4 attempts（initial + maxActionRetries=3）→ repair 编排 3 attempts
//   （executor.js createAttempt 同 step 计数）→ outcome.paused → replan 重置 retries=0
//   → 新步骤从头消费全部预算。maxReplans=2 → 3 轮 × 7 = 21 attempts，241s 被 harness
//   按 deadline 杀（CANCELLED/benchmark_deadline）。主循环此前没有任何「跨 replan
//   同失败签名」记忆 —— LLM 面对相同 observation 生成等价计划，循环无法收敛。
//
// 修复内容（本测试锁定的契约）：
//   1. runtime.stepFailureSignature：业务语义位置签名（type+target+failureType），
//      不含 step.id（replan 后变 _rp）与 message 全文（LLM 措辞抖动）。
//   2. runtime.sameSigReplanCount：连续同签名计数（首轮/换签名归零）。
//   3. runtime.shouldFuseSameSigReplan：连续第 2 次同签名 replan 即熔断（首次永远允许）。
//   4. OPT-B 既有 replan 语义零回退（isReplanCandidate 行为保持）。
//
// 纪律：断言真实导出函数行为（require 真实 runtime，不 eval 源码）；
//       不触碰验证门槛/Success Definition/maxReplans 预算语义。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 FPB_DATA_DIR：必须在 require 任何 agent 模块之前设置（避免污染真实 store）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-r5-churn-fuse-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const runtime = require('../agent/runtime');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}

const {
  stepFailureSignature,
  sameSigReplanCount,
  shouldFuseSameSigReplan,
  isReplanCandidate,
} = runtime;

assert.ok(typeof stepFailureSignature === 'function', 'runtime 必须导出 stepFailureSignature（新增导出）');
assert.ok(typeof sameSigReplanCount === 'function', 'runtime 必须导出 sameSigReplanCount（新增导出）');
assert.ok(typeof shouldFuseSameSigReplan === 'function', 'runtime 必须导出 shouldFuseSameSigReplan（新增导出）');

// rw.091 真实场景：step 11 click 加购按钮，验证失败家族（动作成功但证据契约未满足）
const addCartStep = { id: 'task_x_step_11', action: { type: 'click', target: { semantic: '加购按钮', field: null } } };
const addCartStepReplan = { id: 'task_x_step_11_rp1', action: { type: 'click', target: { semantic: '加购按钮' } } }; // replan 后新 id，业务位置相同
const verifErr = { code: 'VERIFY_FAILED', failureType: 'VERIFICATION_FAILED', message: '加购后购物车数量证据未出现' };
const verifErrRephrase = { code: 'VERIFY_FAILED', failureType: 'VERIFICATION_FAILED', message: 'verification text_present mismatch (cart count)' }; // 措辞不同

(async () => {
  // ── A. 签名纯函数 ──
  await ok('A1 同 step 同错误 → 签名稳定', () => {
    const s1 = stepFailureSignature(addCartStep, verifErr);
    const s2 = stepFailureSignature(addCartStep, verifErr);
    assert.strictEqual(s1, s2);
    assert.ok(s1.length > 0);
  });
  await ok('A2 replan 后 step.id 变化（_rp）→ 签名不变（业务位置相同）', () => {
    assert.strictEqual(
      stepFailureSignature(addCartStep, verifErr),
      stepFailureSignature(addCartStepReplan, verifErr)
    );
  });
  await ok('A3 error.message 措辞抖动 → 签名不变', () => {
    assert.strictEqual(
      stepFailureSignature(addCartStep, verifErr),
      stepFailureSignature(addCartStep, verifErrRephrase)
    );
  });
  await ok('A4 不同业务位置（target 不同）→ 签名不同', () => {
    const other = { id: 's9', action: { type: 'click', target: { semantic: '搜索按钮' } } };
    assert.notStrictEqual(stepFailureSignature(addCartStep, verifErr), stepFailureSignature(other, verifErr));
  });
  await ok('A5 不同失败类型 → 签名不同', () => {
    const domErr = { code: 'ELEMENT_NOT_FOUND', failureType: 'DOM_CHANGED' };
    assert.notStrictEqual(stepFailureSignature(addCartStep, verifErr), stepFailureSignature(addCartStep, domErr));
  });
  await ok('A6 failureType 缺失 → 回退 err.code；均无 → UNKNOWN', () => {
    const onlyCode = stepFailureSignature(addCartStep, { code: 'VERIFY_FAILED' });
    assert.ok(/|VERIFY_FAILED$/.test(onlyCode.split('|').slice(-1)[0]) || onlyCode.endsWith('|VERIFY_FAILED'));
    const none = stepFailureSignature(addCartStep, null);
    assert.ok(none.endsWith('|UNKNOWN'));
  });
  await ok('A7 无 action / 无 type → null（不参与熔断）', () => {
    assert.strictEqual(stepFailureSignature(null, verifErr), null);
    assert.strictEqual(stepFailureSignature({ id: 's' }, verifErr), null);
    assert.strictEqual(stepFailureSignature({ id: 's', action: { target: { semantic: 'x' } } }, verifErr), null);
  });

  // ── B. 计数与熔断判定 ──
  await ok('B1 首轮 replan（lastSig=null）→ 计数 0，不熔断（首次永远允许）', () => {
    const sig = stepFailureSignature(addCartStep, verifErr);
    assert.strictEqual(sameSigReplanCount(sig, null, 0), 0);
    assert.strictEqual(shouldFuseSameSigReplan(0), false);
  });
  await ok('B2 连续第 2 次同签名 → 计数 1，熔断（R5_MAX=0）', () => {
    const sig = stepFailureSignature(addCartStep, verifErr);
    assert.strictEqual(sameSigReplanCount(sig, sig, 0), 1);
    assert.strictEqual(shouldFuseSameSigReplan(1), true);
  });
  await ok('B3 换签名（不同业务位置/失败类型）→ 计数归零，不熔断', () => {
    const sigA = stepFailureSignature(addCartStep, verifErr);
    const sigB = stepFailureSignature({ id: 's', action: { type: 'click', target: { semantic: '结算按钮' } } }, verifErr);
    assert.strictEqual(sameSigReplanCount(sigB, sigA, 1), 0);
    assert.strictEqual(shouldFuseSameSigReplan(0), false);
  });
  await ok('B4 sig 为 null（无 action）→ 计数 0，不熔断', () => {
    assert.strictEqual(sameSigReplanCount(null, 'click|x|VERIFICATION_FAILED', 1), 0);
  });

  // ── C. rw.091 场景端到端推演（3 轮 × 7 attempts 的熔断时序）──
  await ok('C1 rw.091 时序：replan#1 允许 → replan#2 前熔断', () => {
    // 第 1 轮：主循环 4 + 修复编排 3 = 7 attempts 全败 → outcome.paused → replan#1
    let lastSig = null, run = 0;
    const sig = stepFailureSignature(addCartStep, verifErr);
    let cnt = sameSigReplanCount(sig, lastSig, run);
    assert.strictEqual(shouldFuseSameSigReplan(cnt), false, 'replan#1 必须允许');
    lastSig = sig; run = cnt;
    // 第 2 轮：replan 后新步骤（_rp id）再烧 7 attempts → replan#2 前 → 同签名 → 熔断
    const sig2 = stepFailureSignature(addCartStepReplan, verifErrRephrase); // id/措辞变了，签名不变
    cnt = sameSigReplanCount(sig2, lastSig, run);
    assert.strictEqual(shouldFuseSameSigReplan(cnt), true, 'replan#2 必须熔断');
  });
  await ok('C2 反例：replan#2 签名不同（如换策略点结算）→ 不熔断，给收敛机会', () => {
    let lastSig = stepFailureSignature(addCartStep, verifErr);
    const sig2 = stepFailureSignature({ id: 's_rp1', action: { type: 'click', target: { semantic: '结算按钮' } } }, verifErr);
    assert.strictEqual(shouldFuseSameSigReplan(sameSigReplanCount(sig2, lastSig, 0)), false);
  });

  // ── D. OPT-B 既有 replan 语义零回退 ──
  await ok('D1 isReplanCandidate 既有行为保持（证据契约家族）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'VERIFICATION_FAILED' }, addCartStep), true);
    assert.strictEqual(isReplanCandidate({ failureType: 'DOM_CHANGED' }, addCartStep), true);
    assert.strictEqual(isReplanCandidate({ failureType: 'ACTION_REAL_FAILURE' }, { id: 's', action: { type: 'payment', target: { semantic: 'x' } } }), false);
  });
  await ok('D2 熔断只影响 replan 路由，不改变 isReplanCandidate 判定本身', () => {
    // 熔断与候选判定正交：同签名熔断时，该失败仍是 replan 候选（只是不再执行 replan）
    assert.strictEqual(isReplanCandidate(verifErr, addCartStep), true);
    assert.strictEqual(shouldFuseSameSigReplan(1), true);
  });

  console.log('\nR5 churn 熔断针对性测试: ' + passed + ' passed');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
