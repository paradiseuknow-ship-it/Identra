'use strict';
// Repair 策略回归测试 —— 覆盖 verifyFailed（VERIFY_RETRY 策略）与 repair 归因链路。
//
// ⚠️ 历史断层说明（务必先读，避免被"修回去"）：
//   本文件原为 Phase 7 时代测试，断言「VERIFY_FAILED → 先 wait 再**重执行原动作**」。
//   Phase 10.7 重写 verifyFailed.js 后该行为被**刻意移除**——新设计的红线是：
//     「WAIT / RECHECK_OBSERVATION / RETRY_VERIFY 只重观察 + 重验证，绝不重执行原 action」
//   （见 server/agent/repair/strategies/verifyFailed.js 头部红线，及
//    verificationWindow.js 头部「设计红线」）。重执行的唯一合法入口是 failureType
//    === 'ACTION_REAL_FAILURE'。
//   因此本文件 §1 已按 Phase 10.7 语义重写，并**新增一条反向红线断言**
//   （断言业务动作在重观察路径上「从未被执行」），比原断言更强。
//
// 覆盖：
//   1) EVENTUAL_CONSISTENCY / OBSERVATION_DELAY → WAIT + RECHECK + RETRY_VERIFY 成功，
//      且**不重执行业务动作**（Phase 10.7 红线）
//   1b) ACTION_REAL_FAILURE → 重执行原动作，且保留完整 target 对象 {field, semantic}
//   2) 重观察成功但重验证不通过 → ok:false（不可恢复 → 升级路径，不擅自成功）
//   3) repairPlanner 路由：VERIFICATION_FAILED→VERIFY_RETRY / ELEMENT_NOT_FOUND→SEMANTIC_RELOCATE
//   4) errorClassifier：RESOURCE_LOCK 不会变成 VERIFICATION_FAILED（锁处理不被破坏）
//   5) reconcileRepair 纯函数归因
//
// 用法：node test_repair_step5.js
//
// 契约形状备忘（改本文件时不要凭记忆）：
//   · verification.verify 的 text 取自 observation.textSummary（不是 visibleTexts）
//   · buildEffectiveVerification() 对关键业务动作（submit/click/fill/...）会包成
//     { type, expect, allowedAlternativeStates: [derived] } 形式
//   · verifyWithAlternatives(contract, after, before) 先试主验证，再试替代态

const assert = require('assert');
const verifyFailed = require('./server/agent/repair/strategies/verifyFailed');
const repairPlanner = require('./server/agent/repair/repairPlanner');
const errorClassifier = require('./server/agent/recovery/errorClassifier');
const { reconcileRepair } = require('./server/agent/repair/repairAttempts');

let pass = 0, fail = 0;
const _pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      _pending.push(r.then(() => { pass++; console.log('  ✅ ' + name); }).catch((e) => { fail++; console.log('  ❌ ' + name + ' :: ' + e.message); }));
      return;
    }
    pass++; console.log('  ✅ ' + name);
  } catch (e) { fail++; console.log('  ❌ ' + name + ' :: ' + e.message); }
}

console.log('\n=== Repair 策略回归测试（Phase 10.7 语义）===\n');

// ---------------------------------------------------------------------------
// 1) EVENTUAL_CONSISTENCY / OBSERVATION_DELAY → 重观察 + 重验证成功
//    且绝不重执行业务动作（Phase 10.7 核心红线）
// ---------------------------------------------------------------------------
console.log('[1] 异步一致性 → WAIT + RECHECK_OBSERVATION + RETRY_VERIFY（不重执行动作）');
test('verifyFailed 对异步一致性：重观察后验证通过 → ok=true', async () => {
  const step = {
    id: 'step_x',
    verification: { type: 'text_present', expect: '机械键盘' },
    action: {
      type: 'submit',
      target: { field: 'search', semantic: '搜索框', type: 'input' },
      value: '机械键盘',
      verification: { type: 'text_present', expect: '机械键盘' },
    },
  };
  const called = [];
  const ctx = {
    error: { failureType: 'EVENTUAL_CONSISTENCY' },
    runAction: async (action) => {
      called.push(action.type);
      if (action.type === 'wait') return { success: true };
      if (action.type === 'inspect') {
        // 模拟异步渲染完成后的真实重观察（textSummary 是 verify 的唯一文本来源）
        return { success: true, observation: { textSummary: '购物车：机械键盘 x1', url: 'https://shop.test/cart' } };
      }
      return { success: false };
    },
  };
  const out = await verifyFailed.execute({ task: {}, step, ctx });
  assert.strictEqual(out.ok, true, '应返回 ok=true');
  const waitStep = out.actions.find((a) => a.tool === 'wait_stable');
  assert.ok(waitStep && waitStep.ok, '应包含 wait_stable 且成功');
  const recheck = out.actions.find((a) => a.tool === 'recheck_observation');
  assert.ok(recheck && recheck.ok, '应包含 recheck_observation 且成功');
  const retryStep = out.actions.find((a) => a.tool === 'retry_verify');
  assert.ok(retryStep && retryStep.ok, '应包含 retry_verify 且成功');
  assert.ok(!called.includes('submit'),
    'Phase 10.7 红线：WAIT/RECHECK/RETRY_VERIFY 路径不得重执行业务动作（实际调用：' + called.join(',') + '）');
});

// ---------------------------------------------------------------------------
// 1b) ACTION_REAL_FAILURE → 重执行原动作，且必须保留完整 target 对象
// ---------------------------------------------------------------------------
console.log('[1b] ACTION_REAL_FAILURE → 重执行原动作 + 完整 target 对象');
test('verifyFailed 对真实动作失败：重执行并验证通过，target 保留 {field,semantic}', async () => {
  const step = {
    id: 'step_x2',
    verification: { type: 'text_present', expect: '机械键盘' },
    action: {
      type: 'submit',
      target: { field: 'search', semantic: '搜索框', type: 'input' },
      value: '机械键盘',
      verification: { type: 'text_present', expect: '机械键盘' },
    },
  };
  let retrySeenAction = null;
  const ctx = {
    error: { failureType: 'ACTION_REAL_FAILURE' },
    runAction: async (action) => {
      if (action.type === 'submit') {
        retrySeenAction = action; // 捕获重执行实际携带的动作
        return { success: true, observation: { textSummary: '搜索结果：机械键盘', url: 'https://shop.test/s?q=' } };
      }
      return { success: false };
    },
  };
  const out = await verifyFailed.execute({ task: {}, step, ctx });
  assert.strictEqual(out.ok, true, '重执行后验证通过应返回 ok=true');
  const retryStep = out.actions.find((a) => a.tool === 'retry_verify');
  assert.ok(retryStep && retryStep.ok, '应包含 retry_verify 且成功');
  assert.strictEqual(retryStep.targetObject, true, 'RETRY_VERIFY 的 target 必须保留 field（未退化成字符串）');
  assert.ok(retrySeenAction && retrySeenAction.target
    && retrySeenAction.target.field === 'search'
    && retrySeenAction.target.semantic === '搜索框',
    '重试动作必须携带完整 target 对象 {field,semantic}');
});

// ---------------------------------------------------------------------------
// 2) 重观察成功但重验证不通过 → ok:false（升级路径，不擅自成功）
// ---------------------------------------------------------------------------
console.log('[2] 持续失败 → ok:false（不可恢复 → 升级路径）');
test('verifyFailed 对持续失败：重观察成功但重验证未通过 → ok=false', async () => {
  // 注意：这里刻意使用**非关键业务动作**类型 extract。
  // 若用 click/fill/submit 等关键动作，buildEffectiveVerification 会把 deriveContract 派生的
  // outcome 契约挂进 allowedAlternativeStates；而该派生契约含 page_change 子句，
  // 在 before 观察缺失时会空过（verification.js:111-116「URL 已加载即视为变化」），
  // 导致本用例无法稳定断言 ok=false。该空过本身是真实缺陷，见 §2b 用例。
  const step = {
    id: 'step_y',
    verification: { type: 'text_present', expect: '支付成功' },
    action: { type: 'extract', target: { role: 'page' }, verification: { type: 'none' } },
  };
  const ctx = {
    error: { failureType: 'OBSERVATION_DELAY' },
    runAction: async (action) => {
      if (action.type === 'wait') return { success: true };
      if (action.type === 'inspect') {
        // 页面一直停在加载中：重观察成功，但业务证据始终缺失
        return { success: true, observation: { textSummary: '处理中，请稍候…', url: 'https://shop.test/pay' } };
      }
      return { success: false };
    },
  };
  const out = await verifyFailed.execute({ task: {}, step, ctx });
  assert.strictEqual(out.ok, false, '重验证未通过时必须返回 ok=false（交由上层升级，不擅自成功）');
  const waitStep = out.actions.find((a) => a.tool === 'wait_stable');
  assert.ok(waitStep && waitStep.ok, '应执行 wait_stable');
  const recheck = out.actions.find((a) => a.tool === 'recheck_observation');
  assert.ok(recheck && recheck.ok, '应执行 recheck_observation');
  const retryStep = out.actions.find((a) => a.tool === 'retry_verify');
  assert.ok(retryStep && retryStep.ok === false, 'retry_verify 应失败');
});

// ---------------------------------------------------------------------------
// 2b) 【已知缺陷标记】before 观察缺失 → 派生契约的 page_change 子句空过 → silent-pass
//
// 这不是期望行为，是把当前真实行为固化下来，使缺陷在测试输出中可见、可追踪。
// 修复后请连同本用例一起更新（届时断言应翻转为 ok === false）。
//
// 缺陷链路（已核实）：
//   executor.js:58   传给策略的 ctx 不含 observation
//     → verifyFailed.js:112  beforeObs = null
//     → verifyWithAlternatives 主验证失败后回退 allowedAlternativeStates
//     → deriveContract 派生的 outcome 契约含 {type:'page_change'}
//     → verification.js:111-116  before 缺失时「URL 已加载即视为变化」→ true
//     → 判定为替代态命中 → ok = true（一个真实失败被报成修复成功）
// 违反 verifyFailed.js 头部红线：「彻底消除 silent-pass」。
// ---------------------------------------------------------------------------
console.log('[2b] 【已知缺陷标记】before 缺失 → page_change 空过');
test('【已知缺陷】before 观察缺失时，关键动作的主验证失败会空过为 ok=true（不应如此）', async () => {
  const step = {
    id: 'step_y2',
    verification: { type: 'text_present', expect: '支付成功' },
    action: { type: 'click', target: { field: 'payBtn', semantic: '支付按钮', type: 'button' }, verification: { type: 'none' } },
  };
  const ctx = {
    error: { failureType: 'OBSERVATION_DELAY' },
    // 刻意不提供 ctx.observation —— 与 executor.js:58 的生产行为一致
    runAction: async (action) => {
      if (action.type === 'wait') return { success: true };
      if (action.type === 'inspect') {
        return { success: true, observation: { textSummary: '处理中，请稍候…', url: 'https://shop.test/pay' } };
      }
      return { success: false };
    },
  };
  const out = await verifyFailed.execute({ task: {}, step, ctx });
  // 当前（缺陷）行为：不含「支付成功」，但仍被判为 ok
  assert.strictEqual(out.ok, true, '缺陷标记：当前实现在 before 缺失时空过；若此处变为 false，说明缺陷已修复，请同步更新本用例与 PRODUCT_CORE_ROADMAP');
});

// ---------------------------------------------------------------------------
// 3) repairPlanner 路由
// ---------------------------------------------------------------------------
console.log('\n[3] repairPlanner 策略路由');
test('VERIFICATION_FAILED → VERIFY_RETRY / verifyFailed', () => {
  const pr = repairPlanner.planFromDiagnosis({ diagnosis: { category: 'VERIFICATION_FAILED', confidence: 0.8 } });
  assert.ok(pr.ok, 'plan 应合法: ' + (pr.error || ''));
  assert.strictEqual(pr.plan.strategy, 'VERIFY_RETRY', 'strategy 应为 VERIFY_RETRY');
  assert.strictEqual(pr.plan.strategyType, 'verifyFailed', 'strategyType 应为 verifyFailed');
});
test('ELEMENT_NOT_FOUND → SEMANTIC_RELOCATE / elementChanged（保持原行为）', () => {
  const pr = repairPlanner.planFromDiagnosis({ diagnosis: { category: 'ELEMENT_NOT_FOUND', confidence: 0.8 } });
  assert.ok(pr.ok, 'plan 应合法');
  assert.strictEqual(pr.plan.strategy, 'SEMANTIC_RELOCATE');
  assert.strictEqual(pr.plan.strategyType, 'elementChanged');
});
test('VERIFY_RETRY 已注册进 REPAIR_STRATEGIES', () => {
  const sch = require('./server/agent/repair/repairSchema');
  assert.ok(sch.REPAIR_STRATEGIES.includes('VERIFY_RETRY'), 'REPAIR_STRATEGIES 应包含 VERIFY_RETRY');
});

// ---------------------------------------------------------------------------
// 4) errorClassifier：RESOURCE_LOCK 不应变成 VERIFICATION_FAILED
// ---------------------------------------------------------------------------
console.log('\n[4] errorClassifier 红线');
test('RESOURCE_LOCK 不被归类为 VERIFICATION_FAILED（锁处理不被破坏）', () => {
  const c = errorClassifier.classify({ code: 'RESOURCE_LOCK' });
  assert.notStrictEqual(c.type, 'VERIFICATION_FAILED', '锁错误不得误用验证修复策略');
});
test('VERIFY_FAILED 仍归类为 VERIFICATION_FAILED（回归守卫）', () => {
  const c = errorClassifier.classify({ code: 'VERIFY_FAILED' });
  assert.strictEqual(c.type, 'VERIFICATION_FAILED');
});

// ---------------------------------------------------------------------------
// 5) reconcileRepair 纯函数归因
// ---------------------------------------------------------------------------
console.log('\n[5] reconcileRepair 归因纯函数');
test('FAILED + 后续 SUCCESS attempt → 归因为 SUCCESS', () => {
  const repair = { id: 'r1', repairId: 'repair_r1', status: 'FAILED', createdAt: 1000 };
  const attempts = [
    { id: 'a1', status: 'FAILED', startedAt: 900 },
    { id: 'a2', status: 'SUCCESS', startedAt: 1500 }, // 在 repair 之后成功
  ];
  const r = reconcileRepair(repair, attempts);
  assert.strictEqual(r.status, 'SUCCESS', '应归因为 SUCCESS');
  assert.deepStrictEqual(r.attributedAttemptIds, ['a2']);
});
test('FAILED + 无 SUCCESS attempt → 保持 FAILED', () => {
  const repair = { id: 'r2', repairId: 'repair_r2', status: 'FAILED', createdAt: 1000 };
  const attempts = [{ id: 'a1', status: 'FAILED', startedAt: 1500 }];
  const r = reconcileRepair(repair, attempts);
  assert.strictEqual(r.status, 'FAILED');
  assert.strictEqual(r.attributedAttemptIds.length, 0);
});
test('FAILED + SUCCESS 但早于 repair → 不归因', () => {
  const repair = { id: 'r3', repairId: 'repair_r3', status: 'FAILED', createdAt: 2000 };
  const attempts = [{ id: 'a1', status: 'SUCCESS', startedAt: 1500 }]; // 早于 repair
  const r = reconcileRepair(repair, attempts);
  assert.strictEqual(r.status, 'FAILED');
});
test('已 SUCCESS 的 repair → 原样返回（不重复处理）', () => {
  const repair = { id: 'r4', repairId: 'repair_r4', status: 'SUCCESS', createdAt: 1000 };
  const r = reconcileRepair(repair, [{ id: 'a1', status: 'SUCCESS', startedAt: 1500 }]);
  assert.strictEqual(r.status, 'SUCCESS');
  assert.strictEqual(r.attributedAttemptIds.length, 0);
});

// ---------------------------------------------------------------------------
(async () => {
  if (_pending.length) await Promise.all(_pending);
  console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})();
