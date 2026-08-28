'use strict';

// Phase 1.1 基础设施测试（直接调用模块，无需启动服务）。
// 覆盖：Schema 校验 / Policy 决策 / Task 状态流转 / Lock 冲突 / Secret 脱敏 / Budget 上限 /
//       Queue 优先级 / ObservationCache 命中 / SSE EventStore 回放 / Checkpoint。
// 用法：node server/scripts/testAgentInfra.js

const schema = require('../agent/schema/action');
const policy = require('../agent/policy');
const tsm = require('../agent/taskStateManager');
const lock = require('../agent/lock');
const budget = require('../agent/budget');
const queue = require('../agent/queue');
const obsCache = require('../agent/observationCache');
const events = require('../agent/events');
const checkpoint = require('../agent/checkpoint');
const taskManager = require('../agent/taskManager');
const secretManager = require('../agent/secretManager');
const vault = require('../vault');
const store = require('../agent/store');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name); }
}

const TEST_PROFILE = 'p_infra_test_' + Date.now().toString(36);

async function main() {
  console.log('== Phase 1.1 基础设施测试 ==');

  // 1) Schema 校验
  console.log('[schema]');
  let r = schema.validateAction({ type: 'click', target: { semantic: 'Continue' }, risk: 'LOW', verification: { type: 'page_change' } });
  ok(r.ok, '合法 click 通过');
  ok(r.ok && policy.effectiveRisk(r.action) === 'MEDIUM', 'click 自报 LOW 经 Policy 校准为 MEDIUM');
  r = schema.validateAction({ type: 'fill', target: { field: 'password' }, value: 'secret' });
  ok(!r.ok, '敏感字段 password 用 value 字面量被拒绝');
  r = schema.validateAction({ type: 'fill', target: { field: 'password' }, credentialRef: 'cred_001' });
  ok(r.ok, '敏感字段走 credentialRef 通过');
  r = schema.validateAction({ type: 'goto' });
  ok(!r.ok, '非法 type 被拒绝');
  r = schema.validateAction({ type: 'submit', target: { semantic: 'submit' } });
  ok(!r.ok, 'submit 缺 verification 被拒绝');
  r = schema.validateAction({ type: 'click', target: {} });
  ok(!r.ok, '缺 target 定位线索被拒绝');

  // 2) Policy
  console.log('[policy]');
  const mockTask = { executionMode: 'SIMULATION' };
  r = schema.validateAction({ type: 'click', target: { semantic: 'x' }, risk: 'LOW', verification: { type: 'page_change' } });
  ok(!policy.allowsAction(r.action, mockTask).allowed, 'SIMULATION 禁止 click');
  r = schema.validateAction({ type: 'inspect', target: { role: 'page' } });
  ok(policy.allowsAction(r.action, mockTask).allowed, 'SIMULATION 允许 inspect');
  r = schema.validateAction({ type: 'payment', target: { semantic: 'pay' }, risk: 'CRITICAL', verification: { type: 'page_change' } });
  let d = policy.allowsAction(r.action, { executionMode: 'AUTONOMOUS' });
  ok(!d.allowed && d.requiresApproval, 'CRITICAL payment 默认需人工审批');
  d = policy.allowsAction(r.action, { executionMode: 'AUTONOMOUS', policy: { autoPayment: true } });
  ok(d.allowed, '测试环境 autoPayment=true 放行支付');
  r = schema.validateAction({ type: 'click', target: { semantic: 'x' }, risk: 'LOW', verification: { type: 'page_change' } });
  d = policy.allowsAction(r.action, { executionMode: 'ASSIST', policy: { riskFloor: 'MEDIUM' } });
  ok(d.allowed, 'ASSIST click(MEDIUM) 放行');

  // 3) 状态机
  console.log('[state-machine]');
  ok(tsm.transitionTask('PENDING', 'PLANNING') === 'PLANNING', 'PENDING→PLANNING 合法');
  let threw = false;
  try { tsm.transitionTask('SUCCESS', 'RUNNING'); } catch (e) { threw = true; }
  ok(threw, 'SUCCESS→RUNNING 非法被拦截');

  // 4) Task 创建 + 启动 + 状态流转
  console.log('[task]');
  const task = taskManager.createTask({
    name: 'infra 测试', objective: '跑通基础设施', targetUrl: 'https://example.com',
    profileId: TEST_PROFILE, executionMode: 'AUTONOMOUS', priority: 90,
  });
  ok(task.status === 'PENDING', '创建后 PENDING');
  ok(task.executionMode === 'AUTONOMOUS', 'executionMode 生效');
  const started = taskManager.start(task.id);
  ok(started.task.status === 'RUNNING', 'start 后 RUNNING');
  ok(!!started.execution.id, '创建了 Execution');
  ok(lock.isHeld(lock.resourceKeyForProfile(TEST_PROFILE)), 'Profile Lock 已持有');

  // 5) Lock 冲突：第二个任务抢同一 profile 必须失败
  console.log('[lock]');
  const task2 = taskManager.createTask({ name: '抢占', objective: 'x', profileId: TEST_PROFILE });
  let lockErr = null;
  try { taskManager.start(task2.id); } catch (e) { lockErr = e.message; }
  ok(!!lockErr && lockErr.includes('RESOURCE_BUSY'), '同 profile 第二任务被 RESOURCE_BUSY 拒绝');

  // 6) Secret 脱敏
  console.log('[secret]');
  vault.setProfileSecrets(TEST_PROFILE, { email: 'infra@test.com', password: 's3cret!' });
  const sec = secretManager.createSecret({ profileId: TEST_PROFILE, type: 'email_password', site: 'example.com', label: 'infra' });
  const masked = secretManager.maskedView(sec);
  ok(masked.available === true, 'secret available=true');
  ok(!!masked.maskedEmail && !masked.maskedEmail.includes('infra@'), 'maskedEmail 脱敏');
  ok(JSON.stringify(masked).indexOf('s3cret!') === -1, '脱敏视图无明文密码');
  const resolved = secretManager.resolve(sec.id);
  ok(!!resolved && resolved.secrets.email === 'infra@test.com', 'resolve 能取到明文（仅执行层可用）');

  // 7) Budget
  console.log('[budget]');
  budget.createBudget(task.id, { maxTokens: 100, maxLLMCalls: 3, maxCost: 1 });
  budget.spend(task.id, { tokens: 60, calls: 2 });
  ok(budget.check(task.id).ok, '预算内 ok');
  budget.spend(task.id, { tokens: 60, calls: 1 });
  ok(!budget.check(task.id).ok, 'token 超限被拦截');

  // 8) Queue 优先级
  console.log('[queue]');
  queue.clear();
  queue.enqueue({ taskId: 't_low', priority: 10 });
  queue.enqueue({ taskId: 't_high', priority: 100 });
  queue.enqueue({ taskId: 't_mid', priority: 50 });
  const first = queue.dequeue();
  ok(first.taskId === 't_high', '高优先级先出队: ' + first.taskId);
  queue.clear();

  // 9) ObservationCache
  console.log('[observation-cache]');
  const c1 = obsCache.get(task.id, 'https://a.com', 'hello world', [{ id: 1, role: 'button', text: 'Go' }]);
  obsCache.set(task.id, 'https://a.com', c1.contentHash, { url: 'https://a.com', title: 'A' });
  const c2 = obsCache.get(task.id, 'https://a.com', 'hello world', [{ id: 1, role: 'button', text: 'Go' }]);
  ok(c2.hit === true, '同内容命中缓存');
  const c3 = obsCache.get(task.id, 'https://a.com', 'DIFFERENT', [{ id: 1, role: 'button', text: 'Go' }]);
  ok(c3.hit === false, '内容变化未命中');

  // 10) EventStore 回放
  console.log('[events]');
  const e1 = events.emit({ taskId: task.id, type: 'agent.observing', payload: { n: 1 } });
  const e2 = events.emit({ taskId: task.id, type: 'agent.tool_called', payload: { tool: 'click' } });
  const after = events.replaySince(e1.eventId, {});
  ok(after.length === 1 && after[0].eventId === e2.eventId, 'replaySince 只返回增量');
  const recent = events.recent(task.id, 10);
  ok(recent.length >= 2, 'recent 含事件');

  // 11) Checkpoint
  console.log('[checkpoint]');
  const cp = checkpoint.save(task.id, {
    executionId: started.execution.id, profileId: TEST_PROFILE,
    url: 'https://example.com', lastVerifiedState: { step: 'started' },
  });
  const latestCp = checkpoint.latest(task.id);
  ok(latestCp.id === cp.id && latestCp.url === 'https://example.com', 'checkpoint 保存并可取回');

  // 12) Cancel 释放锁
  console.log('[cancel]');
  taskManager.cancel(task.id);
  ok(!lock.isHeld(lock.resourceKeyForProfile(TEST_PROFILE)), 'cancel 后锁释放');
  taskManager.cancel(task2.id);

  // 13) 清理测试数据
  store.remove('aiTasks', task.id);
  store.remove('aiTasks', task2.id);
  store.write('aiCheckpoints', store.read('aiCheckpoints', []).filter((x) => x.taskId === task.id));
  store.write('aiEvents', store.read('aiEvents', []).filter((x) => x.taskId !== task.id));
  store.write('aiCredentials', store.read('aiCredentials', []).filter((x) => x.profileId !== TEST_PROFILE));
  vault.deleteProfileSecrets(TEST_PROFILE);

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
