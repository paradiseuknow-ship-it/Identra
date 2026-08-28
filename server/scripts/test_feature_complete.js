'use strict';

// Feature Complete 验证套件（Phase 12B §十七）。
// 覆盖 P0 关键闭合点：模块加载、action 类型、MUST_VERIFY 强制 outcome 契约、
// policy CRITICAL 环境护栏、VIL HUMAN_ESCALATE/RE_EXECUTE、验证窗口 allowedAlternatives 键修复、
// 锁清理、任务依赖、escalationKind 持久化、VIL/ESCALATION 时间线聚合。
// 不依赖真实浏览器（除 resolveSelector 使用合成 obs）。

const assert = require('assert');
const store = require('../agent/store');
let pass = 0, fail = 0;
const fails = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; fails.push(name + ' :: ' + e.message); console.log('  ✗ ' + name + ' :: ' + e.message); }
}

// --- 1. 模块加载 ---
test('所有核心模块加载', () => {
  require('../agent/verification/contract');
  require('../agent/verification');
  require('../agent/verification/verificationWindow');
  require('../agent/verification/verificationIntelligence');
  require('../agent/runtime');
  require('../agent/schema/action');
  require('../agent/planner');
  require('../agent/schema/plan');
  require('../agent/semanticResolver');
  require('../agent/taskManager');
  require('../agent/lock');
  require('../agent/observability/traceCollector');
});

// --- 2. uncheck action 类型 ---
const actionSchema = require('../agent/schema/action');
test('ACTION_TYPES 含 uncheck 且风险 MEDIUM', () => {
  assert.ok(actionSchema.ACTION_TYPES.includes('uncheck'), 'ACTION_TYPES 缺 uncheck');
  assert.strictEqual(actionSchema.TYPE_RISK_FLOOR.uncheck, 'MEDIUM', 'uncheck 风险级错误');
});

// --- 3. MUST_VERIFY 强制 outcome 契约（select/check/logout） ---
test('select 无 verification/businessState 被拒', () => {
  const r = actionSchema.validateAction({ type: 'select', target: { semantic: 'role' }, value: 'admin' });
  assert.strictEqual(r.ok, false, 'select 不应通过');
  assert.ok((r.errors || []).some((e) => /必须提供有意义的验证/.test(e)), '应提示需验证');
});
test('select 带 expectedBusinessState 通过', () => {
  const r = actionSchema.validateAction({
    type: 'select', target: { semantic: 'role' }, value: 'admin',
    expectedBusinessState: { stateType: 'SELECTED', requiredEvidence: [{ type: 'text_present', expect: 'admin' }] },
  });
  assert.strictEqual(r.ok, true, 'select+outcome 应通过: ' + JSON.stringify(r.errors));
});
test('check 无 verification/businessState 被拒', () => {
  const r = actionSchema.validateAction({ type: 'check', target: { semantic: 'agree' } });
  assert.strictEqual(r.ok, false, 'check 不应通过');
});

// --- 4. policy CRITICAL 环境护栏 ---
const policy = require('../agent/policy');
test('生产环境 autoPayment 不能绕过 CRITICAL 审批', () => {
  const prev = process.env.NODE_ENV;
  delete process.env.NODE_ENV; delete process.env.FPB_ALLOW_AUTOPAY;
  const r = policy.allowsAction({ type: 'payment', risk: 'CRITICAL' }, { executionMode: 'ASSIST', policy: { autoPayment: true } });
  assert.strictEqual(r.requiresApproval, true, '生产环境必须审批');
  if (prev !== undefined) process.env.NODE_ENV = prev;
});
test('测试环境 autoPayment 放行 CRITICAL', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const r = policy.allowsAction({ type: 'payment', risk: 'CRITICAL' }, { executionMode: 'ASSIST', policy: { autoPayment: true } });
  assert.strictEqual(r.allowed, true, '测试环境应放行');
  if (prev !== undefined) process.env.NODE_ENV = prev; else delete process.env.NODE_ENV;
});

// --- 5. VIL HUMAN_ESCALATE + RE_EXECUTE ---
const vil = require('../agent/verification/verificationIntelligence');
test('敏感动作验证失败且无证据 → HUMAN_ESCALATE', () => {
  const dec = vil.analyze({
    beforeObservation: { url: 'http://x', visibleText: '' },
    afterObservation: { url: 'http://x', loadingState: 'complete', visibleText: '', networkState: 'idle' },
    expectedVerification: { type: 'text_present', expect: 'Welcome' },
    actionResult: { success: true },
    action: { type: 'submit', risk: 'HIGH' },
  });
  assert.strictEqual(dec.decision, vil.DECISIONS.HUMAN_ESCALATE, '应升级人工: ' + dec.decision);
});
test('动作执行失败 → RE_EXECUTE', () => {
  const dec = vil.analyze({
    beforeObservation: {}, afterObservation: { loadingState: 'complete', visibleText: '' },
    expectedVerification: { type: 'text_present', expect: 'X' },
    actionResult: { success: false },
    action: { type: 'click' },
  });
  assert.strictEqual(dec.decision, vil.DECISIONS.RE_EXECUTE, '应重执行');
});
test('时序问题（网络 pending）→ WAIT', () => {
  const dec = vil.analyze({
    beforeObservation: {}, afterObservation: { networkState: 'pending', visibleText: '' },
    expectedVerification: { type: 'text_present', expect: 'X' }, actionResult: { success: true },
    action: { type: 'click' },
  });
  assert.strictEqual(dec.decision, vil.DECISIONS.WAIT, '应等待');
});

// --- 6. verificationWindow allowedAlternatives 键修复 ---
const vw = require('../agent/verification/verificationWindow');
const verification = require('../agent/verification');
test('businessState 契约尊重 allowedAlternatives（替代态）', () => {
  const contract = {
    stateType: 'SELECTED',
    requiredEvidence: [{ type: 'text_present', expect: 'PrimaryMissing' }],
    allowedAlternatives: [{ stateType: 'SELECTED', requiredEvidence: [{ type: 'text_present', expect: 'AltPresent' }] }],
  };
  // 真实运行时 effV = { businessState: contract }，verify 经 evaluateContract 内部 OR 替代态。
  // 主证据缺失但替代态命中 → 应判定成功（键修复：正确读取 allowedAlternatives）。
  const after = { textSummary: 'AltPresent page' };
  const r = verification.verify({ businessState: contract }, after, {});
  assert.strictEqual(r.success, true, '主证据缺失时应由替代态命中');
  // 无替代态命中时应失败（不误判）
  const r2 = verification.verify({ businessState: contract }, { textSummary: 'Something else' }, {});
  assert.strictEqual(r2.success, false, '无命中时应失败');
});

// --- 7. lock pruneExpired ---
const lock = require('../agent/lock');
test('过期 active 锁被 pruneExpired 清理', () => {
  const key = 'profile:__fctest_' + Date.now();
  lock.acquire(key, { executionId: 'ex1', taskId: 't1' }, { ttlMs: 1 });
  assert.ok(lock.isHeld(key), '应持有');
  // 强制过期
  const cur = lock.getOwner(key); cur.acquiredAt = Date.now() - 100000;
  const n = lock.pruneExpired(Date.now());
  assert.ok(n >= 1, '应清理至少 1 个');
  assert.strictEqual(lock.isHeld(key), false, '应已释放');
  lock.release(key, 'ex1');
});

// --- 8. 任务依赖（dependsOn） ---
const tm = require('../agent/taskManager');
test('依赖未完成时 start 抛错', () => {
  const dep = tm.createTask({ name: 'dep', objective: 'd', profileId: 'pf_dep_test' });
  const t = tm.createTask({ name: 'child', objective: 'c', profileId: 'pf_dep_test', dependsOn: [dep.id] });
  let threw = false;
  try { tm.start(t.id); } catch (e) { threw = /依赖/.test(e.message); }
  assert.ok(threw, '应因依赖未完成抛错');
  // 清理
  try { tm.deleteTask(dep.id); } catch (e) {}
  try { tm.deleteTask(t.id); } catch (e) {}
});

// --- 9. escalationKind 持久化 ---
test('escalate 持久化 escalationKind', () => {
  const t = tm.createTask({ name: 'esc', objective: 'e', profileId: 'pf_esc_test' });
  // escalate 仅允许从运行态转入终态（状态机约束）；测试中手动置 RUNNING 后升级
  const tk = tm.getTask(t.id); tk.status = 'RUNNING'; store.upsert('aiTasks', tk);
  tm.escalate(t.id, new Error('VIL 升级人工'), { reason: 'VIL:STATE_UNKNOWN', kind: 'verification' });
  const after = tm.getTask(t.id);
  assert.strictEqual(after.status, 'HUMAN_ESCALATION', '应终态升级');
  assert.strictEqual(after.escalationKind, 'verification', 'escalationKind 应持久化');
  try { tm.deleteTask(t.id); } catch (e) {}
});

// --- 10. traceCollector 聚合 VIL / ESCALATION ---
const traceCollector = require('../agent/observability/traceCollector');
test('buildTimeline 聚合 VIL 与 ESCALATION 节点', () => {
  const id = 'task_fc_trace_' + Date.now();
  store.insert('aiTasks', { id, status: 'HUMAN_ESCALATION', createdAt: Date.now(), objective: 'o', targetUrl: 'u' });
  store.insert('aiEvents', { taskId: id, type: 'ai.verification.decision', ts: Date.now(), stepId: 's1', attemptId: 'a1', payload: { decision: 'HUMAN_ESCALATE', failureType: 'STATE_UNKNOWN', confidence: 0.5 } });
  store.insert('aiEvents', { taskId: id, type: 'task.escalated', ts: Date.now() + 1, payload: { reason: 'VIL', escalationKind: 'verification' } });
  const nodes = traceCollector.buildTimeline(id);
  const kinds = nodes.map((n) => n.kind);
  assert.ok(kinds.includes('VIL'), '应包含 VIL 节点');
  assert.ok(kinds.includes('ESCALATION'), '应包含 ESCALATION 节点');
  store.remove('aiTasks', id);
  store.write('aiEvents', store.read('aiEvents', []).filter((e) => e.taskId !== id));
});

console.log('\n=== test_feature_complete: ' + pass + ' pass, ' + fail + ' fail ===');
if (fail) { console.log('FAILURES:\n' + fails.map((f) => ' - ' + f).join('\n')); process.exit(1); }
process.exit(0);
