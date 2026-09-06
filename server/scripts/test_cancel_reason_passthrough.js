'use strict';

// B 类口径修复 targeted test（2026-08-31 中途归因 #2）
//
// 背景（33-task 中途归因实证）：4 个 CANCELLED 全部 latency≈121-126s、error=「用户取消」
// —— 实为 phase10Benchmark per-task deadline（120s）到期后 harness 调 taskManager.cancel，
// 而 cancel 硬编码 error='用户取消'。真用户取消与 harness 超时取消在数据上不可区分，
// 且 CANCELLED 任务 taxonomy 被验证事件错标为 VERIFY_FAILED。
//
// 修复契约（本测试锁定）：
//   1. taskManager.cancel(id) 缺省 → error='用户取消'（向后兼容，既有测试不受影响）。
//   2. taskManager.cancel(id, reason) → error=reason（harness deadline 分支传 benchmark_deadline 标记）。
//   3. escalationClass.classifyEscalation：CANCELLED + benchmark_deadline → TIMEOUT；
//      CANCELLED 无标记 → CANCELLED（既有行为不变）。
//   4. phase10Benchmark.classifyTaxonomy：CANCELLED + benchmark_deadline → TIMEOUT。
//
// 纪律：不改 Success Definition；不降 timeout；不动用户取消语义；断言真实函数行为。

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-cancel-reason-'));
process.env.FPB_DATA_DIR = tmpData;
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-dummy-for-require';

const assert = require('assert');
const taskManager = require('../agent/taskManager');
const { classifyEscalation } = require('./escalationClass');
const P9 = require('./phase10Benchmark');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  PASS ' + name); runNext(); })
    .catch((e) => { fail++; failures.push(name + ' :: ' + String(e.message || e).slice(0, 220)); console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 220)); runNext(); });
}

const DEADLINE_REASON = '任务级超时：benchmark per-task deadline（120000ms）到期，由 harness 终止（benchmark_deadline，非用户取消）';

const tests = [

  () => check('T1: cancel(id) 缺省 → error=用户取消（向后兼容）', () => {
    const t = taskManager.createTask({ name: 'cancel-reason-default', objective: '测试', profileId: null, executionMode: 'ASSIST' });
    taskManager.start(t.id);
    const out = taskManager.cancel(t.id);
    assert.strictEqual(out.status, 'CANCELLED');
    assert.strictEqual(out.error, '用户取消');
  }),

  () => check('T2: cancel(id, deadlineReason) → error 透传 reason（含 benchmark_deadline 标记）', () => {
    const t = taskManager.createTask({ name: 'cancel-reason-deadline', objective: '测试', profileId: null, executionMode: 'ASSIST' });
    taskManager.start(t.id);
    const out = taskManager.cancel(t.id, DEADLINE_REASON);
    assert.strictEqual(out.status, 'CANCELLED');
    assert.ok(/benchmark_deadline/.test(String(out.error)), 'error 应含标记: ' + out.error);
    assert.ok(/非用户取消/.test(String(out.error)));
  }),

  () => check('T3: classifyEscalation — CANCELLED + benchmark_deadline → TIMEOUT', () => {
    const cls = classifyEscalation({ status: 'CANCELLED', error: DEADLINE_REASON }, []);
    assert.strictEqual(cls, 'TIMEOUT');
  }),

  () => check('T4: classifyEscalation — CANCELLED 无标记（用户取消）→ CANCELLED（不变）', () => {
    const cls = classifyEscalation({ status: 'CANCELLED', error: '用户取消' }, []);
    assert.strictEqual(cls, 'CANCELLED');
  }),

  () => check('T5: classifyTaxonomy — CANCELLED + benchmark_deadline → TIMEOUT（优先于验证事件 codes）', () => {
    // 复现归因现场：CANCELLED 任务 attempt codes 含 VERIF（被杀前在做验证），
    // 修复前被错标 VERIFY_FAILED，修复后 deadline 标记优先。
    const tax = P9.classifyTaxonomy(
      { status: 'CANCELLED', error: DEADLINE_REASON },
      ['VERIFICATION_FAILED', 'VERIFY_RETRY'],
      null,
    );
    assert.strictEqual(tax, 'TIMEOUT');
  }),

  () => check('T6: classifyTaxonomy — CANCELLED 用户取消 + VERIF codes → 仍 VERIFY_FAILED（既有行为不变）', () => {
    const tax = P9.classifyTaxonomy(
      { status: 'CANCELLED', error: '用户取消' },
      ['VERIFICATION_FAILED'],
      null,
    );
    assert.strictEqual(tax, 'VERIFY_FAILED');
  }),

  () => check('T7: escalationClass — HUMAN_ESCALATION kind=credential → CREDIBLE_BUSINESS（回归锚点）', () => {
    const cls = classifyEscalation({ status: 'HUMAN_ESCALATION', escalationKind: 'credential', error: '需凭据' }, []);
    assert.strictEqual(cls, 'CREDIBLE_BUSINESS');
  }),
];

let idx = 0;
function runNext() { if (idx < tests.length) { const t = tests[idx++]; t(); } else finish(); }
function finish() {
  console.log('\n=== 结果: ' + pass + ' pass / ' + fail + ' fail ===');
  if (failures.length) { console.log('失败项:\n - ' + failures.join('\n - ')); process.exit(1); }
  process.exit(0);
}
console.log('=== cancel reason 透传 targeted test ===');
runNext();
