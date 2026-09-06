'use strict';

// OPT-B（2026-09-03）证据契约家族 → 执行期 REPLAN — 针对性回归测试
//
// 背景：failureDiagnoser.POLICY 对 VERIFICATION_FAILED / VERIFICATION_TOO_STRICT /
//       STATE_UNKNOWN 的既有声明均为 'replan'，但执行路径未兑现（B 类一致性缺陷）：
//       runtime.isReplanCandidate 只认 DOM_CHANGED / ACTION_REAL_FAILURE / 显式
//       needsReplan → 证据契约家族在 VERIFY_RETRY 重观察重验证耗尽后直接
//       HUMAN_ESCALATION（历史 store 111/446=24.9%，最大自动可恢复升级桶）。
//
// 修复内容（本测试锁定的契约）：
//   1. runtime.isReplanCandidate：证据契约家族三类型纳入 replan 候选（非凭证类）。
//   2. 凭证/支付/登录类步骤（isCredentialishStep）证据失败仍不自动重规划。
//   3. 排除面保持：EVENTUAL_CONSISTENCY / OBSERVATION_DELAY（时序类，等待+重观察
//      是正解）、SUBMIT_RESULT_UNKNOWN（防重复提交红线）不触发 replan。
//   4. failureDiagnoser.POLICY 与执行路径一致性：声明 'replan' 的三类型确实被
//      isReplanCandidate 接受（声明-执行对齐，P4/P5 双路径同步同构问题）。
//
// 纪律：断言真实导出函数行为（require 真实 runtime，不 eval 源码）；
//       不触碰验证门槛/Success Definition/replan 预算（maxReplans）语义。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 FPB_DATA_DIR：必须在 require 任何 agent 模块之前设置（避免污染真实 store）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-optb-replan-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const runtime = require('../agent/runtime');
const diagnoser = require('../agent/diagnosis/failureDiagnoser');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}

const isReplanCandidate = runtime.isReplanCandidate;
assert.ok(typeof isReplanCandidate === 'function', 'runtime 必须导出 isReplanCandidate（新增导出）');

const normalStep = { id: 's1', action: { type: 'click', target: { semantic: '搜索按钮' } } };
const credStepRisk = { id: 's2', action: { type: 'click', risk: 'CRITICAL', target: { semantic: '提交订单' } } };
const credStepType = { id: 's3', action: { type: 'payment', target: { semantic: '收银台' } } };
const credStepField = { id: 's4', action: { type: 'fill', target: { field: 'password' } } };
const credStepCjk = { id: 's5', action: { type: 'fill', target: { field: '支付密码' } } };

(async () => {
  // ── 既有行为保持（回归守卫）──
  await ok('A1 DOM_CHANGED → replan（既有）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'DOM_CHANGED' }, normalStep), true);
  });
  await ok('A2 ACTION_REAL_FAILURE 非凭证 → replan（既有）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'ACTION_REAL_FAILURE' }, normalStep), true);
  });
  await ok('A3 ACTION_REAL_FAILURE 凭证类(risk=CRITICAL) → 不 replan（既有）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'ACTION_REAL_FAILURE' }, credStepRisk), false);
  });
  await ok('A4 ACTION_REAL_FAILURE 凭证类(field=password) → 不 replan（既有）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'ACTION_REAL_FAILURE' }, credStepField), false);
  });
  await ok('A5 显式 needsReplan → replan（既有）', () => {
    assert.strictEqual(isReplanCandidate({ needsReplan: true }, credStepRisk), true);
  });
  await ok('A6 err=null → false（既有）', () => {
    assert.strictEqual(isReplanCandidate(null, normalStep), false);
  });

  // ── OPT-B 新契约：证据契约家族 ──
  await ok('B1 VERIFICATION_TOO_STRICT 非凭证 → replan（新）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'VERIFICATION_TOO_STRICT' }, normalStep), true);
  });
  await ok('B2 STATE_UNKNOWN 非凭证 → replan（新）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'STATE_UNKNOWN' }, normalStep), true);
  });
  await ok('B3 VERIFICATION_FAILED 非凭证 → replan（新）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'VERIFICATION_FAILED' }, normalStep), true);
  });
  await ok('B4 VERIFICATION_TOO_STRICT 凭证类(risk=CRITICAL) → 不 replan（新守卫）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'VERIFICATION_TOO_STRICT' }, credStepRisk), false);
  });
  await ok('B5 STATE_UNKNOWN 凭证类(type=payment) → 不 replan（新守卫）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'STATE_UNKNOWN' }, credStepType), false);
  });
  await ok('B6 VERIFICATION_FAILED 凭证类(field=password) → 不 replan（新守卫）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'VERIFICATION_FAILED' }, credStepField), false);
  });
  await ok('B7 VERIFICATION_TOO_STRICT 凭证类(中文支付语义) → 不 replan（新守卫）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'VERIFICATION_TOO_STRICT' }, credStepCjk), false);
  });

  // ── 排除面保持（有意不纳入 replan 的家族）──
  await ok('C1 EVENTUAL_CONSISTENCY → 不 replan（时序类，等待+重观察是正解）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'EVENTUAL_CONSISTENCY' }, normalStep), false);
  });
  await ok('C2 OBSERVATION_DELAY → 不 replan（时序类）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'OBSERVATION_DELAY' }, normalStep), false);
  });
  await ok('C3 SUBMIT_RESULT_UNKNOWN → 不 replan（防重复提交红线）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'SUBMIT_RESULT_UNKNOWN' }, normalStep), false);
  });
  await ok('C4 未知 failureType → 不 replan（保守兜底不变）', () => {
    assert.strictEqual(isReplanCandidate({ failureType: 'SOMETHING_ELSE' }, normalStep), false);
  });

  // ── 声明-执行一致性（本修复的核心动机）──
  await ok('D1 failureDiagnoser.RETRY_POLICY_BY_CATEGORY 声明 replan 的证据家族与执行路径对齐', () => {
    const POLICY = diagnoser.RETRY_POLICY_BY_CATEGORY;
    assert.ok(POLICY, 'failureDiagnoser 必须导出 RETRY_POLICY_BY_CATEGORY');
    for (const ft of ['VERIFICATION_FAILED', 'VERIFICATION_TOO_STRICT', 'STATE_UNKNOWN']) {
      assert.strictEqual(POLICY[ft], 'replan', 'POLICY[' + ft + '] 应声明为 replan');
      assert.strictEqual(isReplanCandidate({ failureType: ft }, normalStep), true,
        'POLICY 声明 replan 的 ' + ft + ' 必须被 isReplanCandidate 接受（声明-执行对齐）');
    }
  });

  console.log('\n=== 结果: ' + passed + ' 通过 / ' + (18 - passed) + ' 失败 ===');
  if (passed !== 18) process.exitCode = 1;
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
