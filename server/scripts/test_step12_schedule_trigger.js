'use strict';

// STEP 12 — CAP-M1：定时触发 / 批量执行（browserless，纯逻辑 + 真实 store + HTTP e2e）。
// 覆盖：
//   Part 1 模块级：
//     A) 创建校验（objective/targetUrl、intervalMs 下限、profileIds 类型与上限、归属盖章、autoStart 默认）
//     B) fireSchedule 批量：每 profile 一个独立任务 + 归属继承 + scheduleId 落库 + 计数推进
//     C) autoStart=true → taskManager.start 直启路径（scheduler 非 RUNNING）
//     D) Scheduler RUNNING → queueManager.submit 入队路径（start 零调用）
//     E) tickSchedules：只触发到期；PAUSED 不触发；单 schedule 失败 fail-open 不影响其余
//     F) CRUD / 归属守卫（update 重算 nextRunAt、PAUSED 拒绝手动触发、403/列表过滤）
//   Part 2 HTTP e2e（子进程生产入口，模式 B）：schedules 全 CRUD + 触发 + 跨工作区拒绝矩阵
//   Part 3 红线扫描：无 siteType 判定、无硬编码 selector
// 用法：node server/scripts/test_step12_schedule_trigger.js

// 数据目录隔离：必须在 require 之前设置（store/identity 均在 require 时解析数据目录）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-m1-mod-'));
process.env.FPB_DATA_DIR = TMP1;

const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const events = require('../agent/events');
const identity = require('../identity');
const scheduleTrigger = require('../agent/scheduleTrigger');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }
function expectThrow(fn, needle, name) {
  try { fn(); fail++; console.log('  ✘ FAIL: ' + name + ' — 未抛异常'); }
  catch (e) {
    const msg = String(e.message || e) + ' [status=' + (e.status || '') + ']';
    if (!needle || msg.includes(needle)) { pass++; console.log('  ✔ ' + name); }
    else { fail++; console.log('  ✘ FAIL: ' + name + ' — 异常不匹配: ' + msg.slice(0, 120)); }
  }
}

const collected = { tasks: [], schedules: [] };
function trackTask(id) { collected.tasks.push(id); return id; }
function trackSched(id) { collected.schedules.push(id); return id; }

function cleanupPart1() {
  for (const id of collected.schedules) { try { scheduleTrigger.deleteSchedule(id); } catch (e) {} }
  for (const id of collected.tasks) { try { taskManager.deleteTask(id); } catch (e) {} }
}

// ============================================================================
// Part 1 — 模块级
// ============================================================================
function part1() {
  section('Part 1: 模块级（隔离 FPB_DATA_DIR）');

  // ---- A) 创建校验 ----
  section('A: 创建校验');
  expectThrow(() => scheduleTrigger.createSchedule({ intervalMs: 60000 }), 'objective', '缺 objective+targetUrl → 400');
  expectThrow(() => scheduleTrigger.createSchedule({ objective: 'x', intervalMs: 500 }), 'intervalMs', 'intervalMs < 1000 → 400');
  expectThrow(() => scheduleTrigger.createSchedule({ objective: 'x', intervalMs: 1.5 }), 'intervalMs', 'intervalMs 非整数 → 400');
  expectThrow(() => scheduleTrigger.createSchedule({ objective: 'x', intervalMs: 60000, profileIds: 'p1' }), 'profileIds', 'profileIds 非数组 → 400');
  expectThrow(() => scheduleTrigger.createSchedule({ objective: 'x', intervalMs: 60000, profileIds: new Array(51).fill('p') }), '上限', 'profileIds > 50 → 400');
  const before = Date.now();
  const sA = trackSched(scheduleTrigger.createSchedule({
    name: '每日签到', objective: '打开示例页读取标题', targetUrl: 'https://example.com',
    profileIds: ['p1', 'p2'], intervalMs: 86400000, workspaceId: 'ws_mod', createdBy: 'u_mod',
  }).id);
  const sARec = scheduleTrigger.getSchedule(sA);
  ok(sARec.status === 'ACTIVE', '默认 status ACTIVE');
  ok(sARec.autoStart === true, 'autoStart 默认 true');
  ok(Math.abs(sARec.nextRunAt - (before + 86400000)) < 3000, 'nextRunAt = 创建时刻 + intervalMs');
  ok(sARec.workspaceId === 'ws_mod' && sARec.createdBy === 'u_mod', '归属字段按传入盖章');
  ok(sARec.runCount === 0 && sARec.lastRunAt === null, '初始 runCount=0 / lastRunAt=null');
  for (const t of ['schedule.created', 'schedule.updated', 'schedule.deleted', 'schedule.triggered', 'schedule.fire_error', 'schedule.tick_error']) {
    ok(events.EVENT_TYPES.includes(t), '事件已登记: ' + t);
  }

  // ---- B) fireSchedule 批量 ----
  section('B: fireSchedule 批量（autoStart=false）');
  const sB = trackSched(scheduleTrigger.createSchedule({
    name: '批量采集', objective: '读取页面标题', targetUrl: 'https://example.com',
    profileIds: ['pa', 'pb', 'pc'], intervalMs: 60000, autoStart: false,
  }).id);
  const rB = scheduleTrigger.fireSchedule(scheduleTrigger.getSchedule(sB), 'test');
  ok(rB.taskIds.length === 3 && rB.errors.length === 0, '3 个 profile → 3 个任务，0 错误');
  const tasksB = rB.taskIds.map((id) => { trackTask(id); return taskManager.getTask(id); });
  ok(tasksB.every((t) => t && t.profileId && ['pa', 'pb', 'pc'].includes(t.profileId)), '每任务 profileId 一一对应');
  ok(tasksB.every((t) => t.scheduleId === sB), 'task.scheduleId 落库（来源可追溯）');
  ok(tasksB.every((t) => t.objective === '读取页面标题' && t.targetUrl === 'https://example.com'), 'objective/targetUrl 从模板继承');
  ok(scheduleTrigger.getSchedule(sB).runCount === 0, 'fireSchedule 纯原语：直调不推进 runCount（计数归 triggerOnce/tick）');
  // 计数推进由调度入口（triggerOnce）负责
  const rB1 = scheduleTrigger.triggerOnce(sB, undefined, 'test');
  const sBRec = scheduleTrigger.getSchedule(sB);
  ok(rB1.taskIds.length === 3 && sBRec.runCount === 1 && sBRec.lastRunAt !== null, 'triggerOnce：runCount=1 / lastRunAt 推进');
  ok(sBRec.nextRunAt === sBRec.lastRunAt + 60000, 'nextRunAt = lastRunAt + intervalMs');
  ok(Array.isArray(sBRec.lastRunTaskIds) && sBRec.lastRunTaskIds.length === 3, 'lastRunTaskIds 记录 3 个');
  // profileIds 为空 → 单任务（profileId null）
  const sB2 = trackSched(scheduleTrigger.createSchedule({ objective: '无 profile 模板', targetUrl: 'https://example.com', intervalMs: 60000, autoStart: false }).id);
  const rB2 = scheduleTrigger.fireSchedule(scheduleTrigger.getSchedule(sB2), 'test');
  ok(rB2.taskIds.length === 1 && taskManager.getTask(rB2.taskIds[0]).profileId === null, 'profileIds 空 → 单任务 profileId=null');

  // ---- C) autoStart=true → 直启路径 ----
  section('C: autoStart=true → taskManager.start 直启（scheduler 非 RUNNING）');
  const startCalls = [];
  const _realStart = taskManager.start;
  taskManager.start = (id) => { startCalls.push(id); return { task: {}, execution: { id: 'exec_fake' } }; };
  try {
    const sC = trackSched(scheduleTrigger.createSchedule({
      objective: '自动启动模板', targetUrl: 'https://example.com',
      profileIds: ['sx', 'sy'], intervalMs: 60000, autoStart: true,
    }).id);
    const rC = scheduleTrigger.fireSchedule(scheduleTrigger.getSchedule(sC), 'test');
    rC.taskIds.forEach((id) => collected.tasks.push(id));
    ok(startCalls.length === 2 && startCalls.every((id) => rC.taskIds.includes(id)), '每个任务各调用一次 taskManager.start（直启）');
  } finally {
    taskManager.start = _realStart;
  }
  ok(taskManager.start === _realStart, 'start spy 已还原');

  // ---- D) Scheduler RUNNING → 入队路径 ----
  section('D: Scheduler RUNNING → queueManager.submit 入队');
  const submitCalls = [];
  const schedLoopMod = require('../agent/execution/schedulerLoop');
  const queueManagerMod = require('../agent/execution/queueManager');
  const _realGetInstance = schedLoopMod.getInstance;
  const _realSubmit = queueManagerMod.submit;
  schedLoopMod.getInstance = () => ({ getStatus: () => ({ status: 'RUNNING' }) });
  queueManagerMod.submit = (taskId, opts) => { submitCalls.push(taskId); return { ok: true }; };
  try {
    const sD = trackSched(scheduleTrigger.createSchedule({
      objective: '入队模板', targetUrl: 'https://example.com',
      profileIds: ['q1', 'q2'], intervalMs: 60000, autoStart: true,
    }).id);
    const rD = scheduleTrigger.fireSchedule(scheduleTrigger.getSchedule(sD), 'test');
    rD.taskIds.forEach((id) => collected.tasks.push(id));
    ok(submitCalls.length === 2 && submitCalls.every((id) => rD.taskIds.includes(id)), 'RUNNING 时改走 queueManager.submit（2 次）');
    ok(startCalls.length === 2, 'RUNNING 时 taskManager.start 零调用（计数未从 C 的 2 增长）');
  } finally {
    schedLoopMod.getInstance = _realGetInstance;
    queueManagerMod.submit = _realSubmit;
  }

  // ---- E) tickSchedules ----
  section('E: tickSchedules（到期扫描 / PAUSED / fail-open）');
  const sDue = trackSched(scheduleTrigger.createSchedule({ name: '已到期', objective: '到期任务', targetUrl: 'https://example.com', profileIds: [], intervalMs: 60000, autoStart: false }).id);
  const sFut = trackSched(scheduleTrigger.createSchedule({ name: '未到期', objective: '未来任务', targetUrl: 'https://example.com', profileIds: [], intervalMs: 3600000, autoStart: false }).id);
  const dueRec = scheduleTrigger.getSchedule(sDue);
  dueRec.nextRunAt = Date.now() - 10;
  store.upsert('aiSchedules', dueRec);
  const rE = scheduleTrigger.tickSchedules(Date.now());
  ok(rE.fired.includes(sDue) && !rE.fired.includes(sFut), '只触发到期的 schedule（未到期不动）');
  ok(scheduleTrigger.getSchedule(sFut).runCount === 0, '未到期 runCount 仍为 0');
  // PAUSED 不触发
  scheduleTrigger.updateSchedule(sFut, { status: 'PAUSED' });
  const futRec = scheduleTrigger.getSchedule(sFut);
  futRec.nextRunAt = Date.now() - 10;
  store.upsert('aiSchedules', futRec);
  const rE2 = scheduleTrigger.tickSchedules(Date.now());
  ok(!rE2.fired.includes(sFut), 'PAUSED 到期也不触发');
  // fail-open：单 schedule 建任务失败不影响其余，本体不损坏
  const sErrA = trackSched(scheduleTrigger.createSchedule({ name: '坏模板', objective: 'OBJ_BREAK', targetUrl: 'https://example.com', profileIds: [], intervalMs: 60000, autoStart: false }).id);
  const sErrB = trackSched(scheduleTrigger.createSchedule({ name: '好模板', objective: 'OBJ_OK', targetUrl: 'https://example.com', profileIds: [], intervalMs: 60000, autoStart: false }).id);
  for (const id of [sErrA, sErrB]) {
    const r = scheduleTrigger.getSchedule(id);
    r.nextRunAt = Date.now() - 10;
    store.upsert('aiSchedules', r);
  }
  const _realCreate = taskManager.createTask;
  taskManager.createTask = (input) => {
    if (input && input.objective === 'OBJ_BREAK') throw new Error('模拟建任务失败');
    return _realCreate(input);
  };
  let rE3;
  try { rE3 = scheduleTrigger.tickSchedules(Date.now()); } finally { taskManager.createTask = _realCreate; }
  ok(rE3.fired.includes(sErrA) && rE3.fired.includes(sErrB), 'fail-open：坏模板不阻断 tick（两个 schedule 都被处理）');
  ok(scheduleTrigger.getSchedule(sErrA).lastRunErrors.length > 0, '坏模板错误记录进 lastRunErrors');
  ok(scheduleTrigger.getSchedule(sErrB).lastRunTaskIds.length === 1, '好模板正常建任务（1 个）');
  ok(scheduleTrigger.getSchedule(sErrA).nextRunAt > Date.now(), '坏模板 nextRunAt 仍正常顺延（schedule 不损坏）');
  // tick 幂等推进：已触发的不再重复（nextRunAt 已顺延）
  const rE4 = scheduleTrigger.tickSchedules(Date.now());
  ok(rE4.fired.length === 0, '同一 tick 窗口不重复触发');

  // ---- F) CRUD / 守卫 ----
  section('F: CRUD / 归属守卫');
  const sF = trackSched(scheduleTrigger.createSchedule({ objective: 'F 模板', targetUrl: 'https://example.com', profileIds: [], intervalMs: 60000, autoStart: false }).id);
  const firedOnce = scheduleTrigger.triggerOnce(sF, undefined, 'test');
  ok(firedOnce.taskIds.length === 1 && firedOnce.runCount === 1, 'triggerOnce 手动触发成功');
  const upd = scheduleTrigger.updateSchedule(sF, { intervalMs: 120000 });
  ok(upd.nextRunAt === upd.lastRunAt + 120000, 'intervalMs 变更 → nextRunAt = lastRunAt + 新周期');
  scheduleTrigger.updateSchedule(sF, { status: 'PAUSED' });
  expectThrow(() => scheduleTrigger.triggerOnce(sF, undefined, 'test'), 'PAUSED', 'PAUSED 手动触发 → 400');
  ok(scheduleTrigger.deleteSchedule(sF, undefined).id === sF, 'deleteSchedule 返回被删实体');
  ok(scheduleTrigger.getSchedule(sF) === null, '删除后不可查');
  expectThrow(() => scheduleTrigger.updateSchedule('sched_nope', {}, undefined), '不存在', 'update 不存在 → 404');
  expectThrow(() => scheduleTrigger.deleteSchedule('sched_nope', undefined), '不存在', 'delete 不存在 → 404');
  // 归属守卫：经 identity 真实用户/工作区（identity 存储与 agent store 分层，各自隔离于 FPB_DATA_DIR）
  const uOwner = identity.createUser({ username: 'guardowner', password: 'guardowner-pass' });
  const wsG = identity.createWorkspace(uOwner, '守卫工作区');
  const uOut = identity.createUser({ username: 'guardout', password: 'guardout-pass-1' });
  const sG = trackSched(scheduleTrigger.createSchedule({ objective: '守卫模板', targetUrl: 'https://example.com', intervalMs: 60000, workspaceId: wsG.id, createdBy: uOwner.id }).id);
  const ownerUser = { id: uOwner.id, status: 'active', currentWorkspaceId: wsG.id };
  const outUser = { id: uOut.id, status: 'active', currentWorkspaceId: null };
  ok(scheduleTrigger.listSchedules(ownerUser).some((x) => x.id === sG), '同工作区 OWNER 列表可见');
  ok(!scheduleTrigger.listSchedules(outUser).some((x) => x.id === sG), '跨工作区列表不可见');
  expectThrow(() => scheduleTrigger.updateSchedule(sG, { name: 'hack' }, outUser), '403', '跨工作区改 → 403');
  expectThrow(() => scheduleTrigger.triggerOnce(sG, outUser, 'test'), '403', '跨工作区触发 → 403');
  expectThrow(() => scheduleTrigger.updateSchedule(sG, { name: 'x' }, null), '401', '未登录（null）改 → 401');
  ok(scheduleTrigger.updateSchedule(sG, { name: '改名' }, ownerUser).name === '改名', 'OWNER 可改');
  // 模块直调（user===undefined）不启用守卫
  ok(scheduleTrigger.listSchedules().length >= 1, 'user===undefined → 守卫跳过（模块级/内部消费方语义）');

  cleanupPart1();
}

// ============================================================================
// Part 2 — HTTP e2e（子进程生产入口，模式 B）
// ============================================================================
function part2(onDone) {
  section('Part 2: HTTP e2e（子进程生产入口，模式 B）');
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-m1-e2e-'));
  const PORT2 = 18793;
  const BASE = 'http://127.0.0.1:' + PORT2;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT2), FPB_BIND: '127.0.0.1', FPB_API_TOKEN: 'm1-machine-token', FPB_DATA_DIR: TMP2 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const _childOut = [];
  child.stdout.on('data', (d) => _childOut.push(String(d)));
  child.stderr.on('data', (d) => _childOut.push(String(d)));

  async function waitReady() {
    for (let i = 0; i < 60; i++) {
      try {
        // 模式 B 下 health 挂在 requireAuth 之后 → 401 也证明服务已存活
        const r = await fetch(BASE + '/api/ai/health', { signal: AbortSignal.timeout(1000) });
        if (r.status === 200 || r.status === 401) return true;
      } catch (e) { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }
  async function api(method, p, token, body) {
    const r = await fetch(BASE + p, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { /* 非 JSON */ }
    return { status: r.status, json: j };
  }

  (async () => {
    const ready = await waitReady();
    ok(ready, '生产 server 子进程启动成功（模式 B）');
    if (!ready) {
      console.error('--- 子进程输出 ---\n' + _childOut.join('').slice(-3000));
      part3(); return;
    }

    // 匿名 → 401（requireAuth 覆盖 schedules 路由）
    ok((await api('GET', '/api/ai/schedules')).status === 401, '无凭据 GET /schedules → 401');
    ok((await api('POST', '/api/ai/schedules', null, { objective: 'x', intervalMs: 60000 })).status === 401, '无凭据 POST /schedules → 401');

    for (const [u, p] of [['alice3', 'alice3-pass-1'], ['bob3', 'bob3-pass-12']]) {
      await api('POST', '/api/auth/register', null, { username: u, password: p });
    }
    const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).json;
    const A = await login('alice3', 'alice3-pass-1');
    const B = await login('bob3', 'bob3-pass-12');

    // 参数校验
    ok((await api('POST', '/api/ai/schedules', A.token, { targetUrl: 'https://example.com', intervalMs: 500 })).status === 400, 'intervalMs < 1000 → 400');
    ok((await api('POST', '/api/ai/schedules', A.token, { intervalMs: 60000 })).status === 400, '缺 objective+targetUrl → 400');

    // 创建（归属盖章）
    const created = await api('POST', '/api/ai/schedules', A.token, {
      name: '每日巡检', objective: '打开示例页读取标题', targetUrl: 'https://example.com',
      profileIds: [], intervalMs: 86400000, autoStart: false,
    });
    const sched = created.json.schedule;
    ok(created.status === 200 && sched && sched.status === 'ACTIVE', '创建 schedule → ACTIVE');
    ok(sched.workspaceId === A.workspaceId && sched.createdBy === A.user.id, '创建 → 盖 workspaceId/createdBy');

    // 列表归属过滤
    const listA = (await api('GET', '/api/ai/schedules', A.token)).json.schedules;
    const listB = (await api('GET', '/api/ai/schedules', B.token)).json.schedules;
    ok(listA.some((x) => x.id === sched.id), '同 OWNER 列表可见');
    ok(!listB.some((x) => x.id === sched.id), '跨工作区列表不可见');
    ok((await api('GET', '/api/ai/schedules/' + sched.id, B.token)).status === 403, '跨工作区读 → 403');

    // 手动触发（autoStart=false 模板 → 只建任务不执行）
    const trig = await api('POST', '/api/ai/schedules/' + sched.id + '/trigger', A.token);
    ok(trig.status === 200 && trig.json.taskIds.length === 1, '手动触发 → 1 个任务');
    ok((await api('POST', '/api/ai/schedules/' + sched.id + '/trigger', B.token)).status === 403, '跨工作区触发 → 403');
    const t = (await api('GET', '/api/ai/tasks/' + trig.json.taskIds[0], A.token)).json;
    ok(t && t.scheduleId === sched.id, 'e2e：task.scheduleId 落库');
    ok(t && t.workspaceId === A.workspaceId && t.createdBy === A.user.id, 'e2e：task 归属继承 schedule');
    const schedAfter = (await api('GET', '/api/ai/schedules/' + sched.id, A.token)).json.schedule;
    ok(schedAfter.runCount === 1 && schedAfter.nextRunAt === schedAfter.lastRunAt + 86400000, 'e2e：runCount/nextRunAt 推进');

    // PUT：周期变更重算 + PAUSED 拒绝触发
    const upd = (await api('PUT', '/api/ai/schedules/' + sched.id, A.token, { intervalMs: 7200000 })).json.schedule;
    ok(upd.nextRunAt === upd.lastRunAt + 7200000, 'e2e：intervalMs 变更 → nextRunAt 重算');
    await api('PUT', '/api/ai/schedules/' + sched.id, A.token, { status: 'PAUSED' });
    ok((await api('POST', '/api/ai/schedules/' + sched.id + '/trigger', A.token)).status === 400, 'e2e：PAUSED 触发 → 400');

    // DELETE
    ok((await api('DELETE', '/api/ai/schedules/' + sched.id, A.token)).status === 200, 'OWNER 删除 → 200');
    ok((await api('GET', '/api/ai/schedules/' + sched.id, A.token)).status === 404, '删除后 → 404');

    part3();
  })().catch((e) => {
    console.error('e2e 异常:', e && e.message);
    ok(false, 'e2e 未抛异常', String(e && e.message));
    part3();
  });

  function part3() {
    try { child.kill(); } catch (e) { /* 已退出 */ }
    setTimeout(() => {
      try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (e) {}
      section('Part 3: 红线扫描');
      const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'scheduleTrigger.js'), 'utf8');
      ok(!/siteType\s*===/.test(src), 'scheduleTrigger 不引入 siteType 判定');
      ok(!/(querySelector|css\s*[:=]\s*['"]#)/.test(src), 'scheduleTrigger 无硬编码 selector');
      console.log('\n===== STEP 12 结果: ' + pass + ' passed, ' + fail + ' failed =====');
      try { fs.rmSync(TMP1, { recursive: true, force: true }); } catch (e) {}
      process.exit(fail ? 1 : 0);
    }, 500);
  }
}

part1();
part2();
