'use strict';

// Phase 4.4 Browser Resource Pool 验收测试。
// 核心目标：100 个任务下，资源不发生「重复占用 / 幽灵锁 / 重复执行」。
// 不启动真实浏览器（沙箱无 chromium）；本层管理「资源实体状态 + 互斥闸门」。

const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const execution = require('../agent/execution');
const browserPool = execution.browser.browserResourcePool;
const profileBinding = execution.browser.profileBinding;
const browserResource = execution.browser.browserResource;
const resourceRecovery = execution.browser.resourceRecovery;
const { STATUS: RES } = execution.browser.resourceState;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + JSON.stringify(extra) + ']' : '')); }
}

try { require('../agent/runtime'); } catch (e) { /* 浏览器缺失可忽略 */ }

let _pseq = 0;
function clean() {
  store.write('aiBrowserResources', []);
  store.write('aiProfileBindings', []);
  store.write('aiWorkers', []);
  store.write('aiDispatchExecutions', []);
  store.write('aiQueue', []);
  store.write('aiTasks', store.read('aiTasks', []).filter((t) => !(t.id || '').startsWith('p44_')));
  store.write('aiEvents', store.read('aiEvents', []).filter((e) => !(e.taskId || '').startsWith('p44_')));
}
function makeTask(profileId) {
  _pseq += 1;
  const t = taskManager.createTask({
    name: 'p44', objective: 'test', targetUrl: 'https://example.com',
    profileId: profileId || ('p44_p' + _pseq), executionMode: 'SIMULATION',
  });
  return t;
}

console.log('Phase 4.4 Browser Resource Pool 测试');

// Case1：一个 Profile → 一个 Browser → 一个 Task（资源可成功占用，BUSY）
console.log('Case1 一Profile一Browser一Task');
clean();
{
  const t = makeTask('p44_prof1');
  const acq = browserPool.acquireResource('p44_prof1', { taskId: t.id, workerId: 'w1' });
  ok(acq.ok, 'acquire 成功', acq.reason);
  ok(acq.resource && acq.resource.status === RES.BUSY, 'BrowserResource → BUSY', acq.resource && acq.resource.status);
  ok(profileBinding.isBound('p44_prof1'), 'Profile 被绑定');
  ok(profileBinding.getOwner('p44_prof1').taskId === t.id, '绑定 owner = task');
  browserPool.releaseResource('p44_prof1', { taskId: t.id });
  ok(!profileBinding.isBound('p44_prof1'), '释放后 Profile 解绑');
  const res = browserResource.getByProfile('p44_prof1');
  ok(res.status === RES.IDLE, '释放后 BrowserResource → IDLE（可复用）', res && res.status);
}

// Case2：两个 Task 抢同 Profile → 第二个 RESOURCE_BUSY
console.log('Case2 抢同 Profile → RESOURCE_BUSY');
clean();
{
  const t1 = makeTask('p44_prof2');
  const t2 = makeTask('p44_prof2'); // 同 Profile
  const a1 = browserPool.acquireResource('p44_prof2', { taskId: t1.id, workerId: 'w1' });
  ok(a1.ok, '第一个 acquire 成功', a1.reason);
  const a2 = browserPool.acquireResource('p44_prof2', { taskId: t2.id, workerId: 'w2' });
  ok(!a2.ok && a2.reason === 'RESOURCE_BUSY: profile p44_prof2 已被 task ' + t1.id + ' 占用', '第二个 RESOURCE_BUSY', a2.reason);
  // 资源层阻断（不是等 Browser 报错）——资源仍是 t1 的
  ok(profileBinding.getOwner('p44_prof2').taskId === t1.id, 'Profile 仍归 t1');
  browserPool.releaseResource('p44_prof2', { taskId: t1.id });
  // 释放后 t2 可占用
  const a3 = browserPool.acquireResource('p44_prof2', { taskId: t2.id, workerId: 'w2' });
  ok(a3.ok, '释放后 t2 可占用', a3.reason);
  browserPool.releaseResource('p44_prof2', { taskId: t2.id });
}

// Case3：两个不同 Profile → 可并行
console.log('Case3 不同 Profile 可并行');
clean();
{
  const t1 = makeTask('p44_profA');
  const t2 = makeTask('p44_profB');
  const a1 = browserPool.acquireResource('p44_profA', { taskId: t1.id, workerId: 'w1' });
  const a2 = browserPool.acquireResource('p44_profB', { taskId: t2.id, workerId: 'w1' });
  ok(a1.ok && a2.ok, '两个不同 Profile 同时占用成功', { a1: a1.ok, a2: a2.ok });
  ok(profileBinding.isBound('p44_profA') && profileBinding.isBound('p44_profB'), '两 Profile 均绑定');
  browserPool.releaseResource('p44_profA', { taskId: t1.id });
  browserPool.releaseResource('p44_profB', { taskId: t2.id });
}

// Case4：Task 完成 → Browser/Profile 正确释放（幂等，多次释放安全）
console.log('Case4 完成释放幂等');
clean();
{
  const t = makeTask('p44_prof4');
  browserPool.acquireResource('p44_prof4', { taskId: t.id, workerId: 'w1' });
  const r1 = browserPool.releaseResource('p44_prof4', { taskId: t.id });
  ok(r1.ok && r1.released, '首次释放成功', r1);
  const r2 = browserPool.releaseResource('p44_prof4', { taskId: t.id }); // 重复释放
  ok(r2.ok && !r2.released, '二次释放幂等（不报错、不重复释放）', r2);
  // 非持有者释放被忽略（防误释放他人锁）
  const tOther = makeTask('p44_prof4');
  const r3 = browserPool.releaseResource('p44_prof4', { taskId: tOther.id });
  ok(r3.ok && !r3.released, '非持有者释放被忽略', r3);
}

// Case5：Browser crash → Resource DEAD → Recovery 重建
console.log('Case5 Browser crash → DEAD → 重建');
clean();
{
  const t = makeTask('p44_prof5');
  browserPool.acquireResource('p44_prof5', { taskId: t.id, workerId: 'w1' });
  const res = browserResource.getByProfile('p44_prof5');
  browserResource.markDead(res.id, 'browser_crash');
  ok(browserResource.get(res.id).status === RES.DEAD, 'Resource → DEAD', browserResource.get(res.id).status);
  // 重建（同 Profile 新建 CREATED 资源）
  const fresh = resourceRecovery.rebuildBrowser('p44_prof5');
  ok(fresh.status === RES.CREATED, '重建 → CREATED', fresh.status);
  // 重建后应释放 Profile 绑定（旧 Browser 死，锁让出），可重新占用（模拟新任务）
  const t2 = makeTask('p44_prof5');
  const acq = browserPool.acquireResource('p44_prof5', { taskId: t2.id, workerId: 'w2' });
  ok(acq.ok, '重建后可重新占用（绑定已让出）', acq.reason);
  browserPool.releaseResource('p44_prof5', { taskId: t2.id });
}

// Case6：Worker DEAD → Browser/Task 不产生重复执行（Profile 锁保持，防抢占）
console.log('Case6 Worker DEAD 不重复执行');
clean();
{
  const t = makeTask('p44_prof6');
  browserPool.acquireResource('p44_prof6', { taskId: t.id, workerId: 'w_dead' });
  // 模拟 Worker DEAD：资源仍 BUSY，Profile 仍绑定（保持锁防重复执行）
  const info = resourceRecovery.onWorkerDead('w_dead');
  ok(info.bindings.length === 1 && info.bindings[0].taskId === t.id, 'Worker DEAD 记录到其绑定（未释放锁）', info.bindings);
  // 此时另一 task 抢同 Profile 应 RESOURCE_BUSY（不可抢占）
  const t2 = makeTask('p44_prof6');
  const acq = browserPool.acquireResource('p44_prof6', { taskId: t2.id, workerId: 'w_other' });
  ok(!acq.ok && acq.reason === 'RESOURCE_BUSY: profile p44_prof6 已被 task ' + t.id + ' 占用', '不可抢占 → QUEUED 而非重复执行', acq.reason);
  // 原 task 恢复重派时应幂等复用（同 taskId 重占，仍是该 task 的绑定，不产生重复执行）
  const acq2 = browserPool.acquireResource('p44_prof6', { taskId: t.id, workerId: 'w_new' });
  ok(acq2.ok && acq2.reused && profileBinding.getOwner('p44_prof6').taskId === t.id, '原 task 重派幂等复用（reused，锁仍归原 task）', acq2);
  browserPool.releaseResource('p44_prof6', { taskId: t.id });
}

// Case7：Node restart → Resource 状态恢复，不产生幽灵锁
console.log('Case7 Node restart 无幽灵锁');
clean();
{
  // 模拟重启前残留：一个 BUSY 资源 + 活跃绑定，但 task 已不存在（幽灵）
  const ghostTaskId = 'p44_ghost_missing';
  browserResource.create({ profileId: 'p44_prof7', capacity: 1 });
  const res = browserResource.getByProfile('p44_prof7');
  browserResource.markBusy(res.id, { taskId: ghostTaskId, workerId: 'w1' });
  profileBinding.acquire('p44_prof7', { taskId: ghostTaskId, workerId: 'w1' });
  ok(profileBinding.isBound('p44_prof7'), '重启前 Profile 被幽灵 task 占用');
  // restart 恢复：task 不存在 → 解除幽灵绑定
  const r = resourceRecovery.recover({
    now: Date.now(),
    taskExists: (id) => id !== ghostTaskId, // ghost 不存在
    taskIsTerminal: () => false,
  });
  ok(!profileBinding.isBound('p44_prof7'), 'restart 后幽灵锁被解除', profileBinding.get('p44_prof7'));
  ok(r.actions.some((a) => a.type === 'profile.unbound' && a.reason === 'stale_binding'), '产生 stale_binding 解除动作', r.actions);
}

// Case8：100 个任务 / 少量 Profile → 正确排队，绝不重复占用 Profile
console.log('Case8 100 任务 / 3 Profile 正确排队');
clean();
{
  const profiles = ['p44_rp1', 'p44_rp2', 'p44_rp3'];
  const tasks = [];
  for (let i = 0; i < 100; i++) {
    const t = makeTask(profiles[i % profiles.length]); // 轮询绑定到 3 个 Profile
    tasks.push(t);
    browserPool.acquireResource(t.profileId, { taskId: t.id, workerId: 'w' + i });
  }
  // 同一时刻，每个 Profile 最多 1 个 BUSY 绑定（绝不重复占用）
  for (const p of profiles) {
    const bound = profileBinding.list({ activeOnly: true }).filter((b) => b.profileId === p);
    ok(bound.length === 1, 'Profile ' + p + ' 同时仅 1 个占用（不重复）', bound.length);
    const busyRes = browserResource.list({ status: RES.BUSY, profileId: p });
    ok(busyRes.length === 1, 'Profile ' + p + ' 同时仅 1 个 BUSY 资源（不重复）', busyRes.length);
  }
  // 统计：100 次 acquire 中，仅 3 次成功（每 Profile 首占），其余 97 次必须 RESOURCE_BUSY 被拒（不重复占用）
  let succeeded = 0, rejected = 0;
  for (const t of tasks) {
    const a = browserPool.acquireResource(t.profileId, { taskId: t.id, workerId: 'w' + Math.floor(Math.random()*9e6) });
    if (a.ok) succeeded++; else if (a.reason && a.reason.indexOf('RESOURCE_BUSY') === 0) rejected++;
  }
  ok(succeeded === 3, '恰好 3 个任务成功占用（3 Profile 各 1）', succeeded);
  ok(rejected === 97, '97 个任务被 RESOURCE_BUSY 正确拒绝（无重复占用）', rejected);
  // 释放全部 100 次（仅 3 持有者真正释放，97 次幂等 no-op）
  let released = 0;
  for (const t of tasks) { const r = browserPool.releaseResource(t.profileId, { taskId: t.id }); if (r.released) released++; }
  ok(released === 3, '仅 3 个真实持有者被释放（97 次幂等 no-op）', released);
  // 释放后无幽灵锁：3 个 Profile 全部可重新被新任务占用
  let reAcqOk = 0;
  for (const p of profiles) {
    const tNew = makeTask(p);
    const a = browserPool.acquireResource(p, { taskId: tNew.id, workerId: 'w_re' });
    if (a.ok) reAcqOk++;
    browserPool.releaseResource(p, { taskId: tNew.id });
  }
  ok(reAcqOk === 3, '释放后 3 个 Profile 全部可重新占用（无幽灵锁）', reAcqOk);
}

console.log('\nPhase 4.4 结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
