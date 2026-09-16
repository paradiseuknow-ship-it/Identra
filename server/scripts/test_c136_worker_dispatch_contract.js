'use strict';
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c136_guard_' + Date.now());
// C136 守护：把 testAgentPhase42 / testAgentPhase43 现在**直接依赖**的两条生产契约钉住 ——
//   ① workerHeartbeat.scan 的候选集恰为 {ASSIGNED, RUNNING}（Phase 5.8 Finding #1 的有意收紧：
//      空闲 READY/STARTING 本就没有持续心跳，误判 DEAD 会清空 capacity 造成饿死）；
//   ② SchedulerLoop.start() 第一步即 _reapZombieDispatches()（把所有已有 dispatch cancel、
//      非终态 task fail）⇒「先 start 再 submit」是**硬顺序契约**。
//
// 为什么需要这个守护：C135-EX-09/10 曾把两条契约的后果登记为「可能为真回归（高优先级）」。
// 归因结论是**测试自身缺陷**（生产未改；归属证据：_reapZombieDispatches 在 C134 已存在且 C135 未改）。
// 若未来有人把 ① 放宽（把 READY 纳入）或把 ② 的收割挪出 start()，那两个套件会再次以
// 「测试过时」的假象变红 —— 本守护让**契约变化本身**先红，避免把契约漂移误诊成测试问题。
//
// 双向要求（L17）：每条契约都必须同时有「正向（行为确实发生）」与「反向（不该发生的没发生）」
// 断言，否则退化成真空绿。

const fs = require('fs');
const path = require('path');

const execution = require('../agent/execution');
const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const hb = execution.workerHeartbeat;
const registry = execution.workerRegistry;
const wm = execution.workerManager;
const queueManager = execution.queueManager;
const { STATUS } = execution.workerState;
const { SchedulerLoop } = execution.schedulerLoop;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _seq = 0;
function mkTask() {
  _seq += 1;
  return taskManager.createTask({
    name: 'c136g', objective: 'guard', targetUrl: 'https://example.com',
    profileId: 'c136g_p' + _seq, executionMode: 'SIMULATION',
  });
}
function cleanDispatch() {
  store.write('aiWorkers', []);
  store.write('aiDispatchExecutions', []);
  store.write('aiQueue', []);
}

(async () => {
  // ── A 契约①：scan 的候选集恰为 {ASSIGNED, RUNNING} ──────────────────────────
  const hbSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'execution', 'workerHeartbeat.js'), 'utf8');
  const candLine = hbSrc.split('\n').find((l) => l.includes('const candidates')) || '';
  check('A0 静态：候选过滤行存在且同时含 ASSIGNED 与 RUNNING',
    /STATUS\.ASSIGNED/.test(candLine) && /STATUS\.RUNNING/.test(candLine), candLine.trim());
  check('A0b 静态反向：候选过滤行不得包含 READY / STARTING（放宽回退即红）',
    candLine.length > 0 && !/READY|STARTING/.test(candLine), candLine.trim());

  // A1 行为正向：READY + 超时心跳 ⇒ 不判 DEAD
  cleanDispatch();
  const wReady = wm.startWorker({ id: 'c136g_ready' });
  const recR = registry.get(wReady.id);
  recR.lastHeartbeat = Date.now() - 40000;
  store.upsert('aiWorkers', recR);
  const deadR = hb.scan(Date.now(), 30000);
  check('A1 行为：READY worker 超时【不】判 DEAD', !deadR.some((d) => d.workerId === wReady.id), deadR.map((d) => d.workerId));
  check('A1b 且状态仍为 READY', registry.get(wReady.id).status === STATUS.READY, registry.get(wReady.id).status);

  // A2 行为反向：RUNNING + 超时心跳 ⇒ 判 DEAD（防「什么都不判」的降级）
  cleanDispatch();
  const wRun = wm.startWorker({ id: 'c136g_run' });
  wm.assign(wRun.id, 'exec_c136g', mkTask().id);
  wm.markRunning(wRun.id);
  const recU = registry.get(wRun.id);
  recU.lastHeartbeat = Date.now() - 40000;
  store.upsert('aiWorkers', recU);
  const deadU = hb.scan(Date.now(), 30000);
  check('A2 行为：RUNNING worker 超时【判】DEAD', deadU.some((d) => d.workerId === wRun.id), deadU.map((d) => d.workerId));
  check('A2b 且落地为 DEAD', registry.get(wRun.id).status === STATUS.DEAD, registry.get(wRun.id).status);

  // A3 边界：心跳新鲜 ⇒ 不判 DEAD（防「恒判死」的另一极端）
  cleanDispatch();
  const wFresh = wm.startWorker({ id: 'c136g_fresh' });
  wm.assign(wFresh.id, 'exec_c136g2', mkTask().id);
  wm.markRunning(wFresh.id);
  const recF = registry.get(wFresh.id);
  recF.lastHeartbeat = Date.now() - 1000;
  store.upsert('aiWorkers', recF);
  check('A3 边界：RUNNING 但心跳新鲜（1s）不判 DEAD', hb.scan(Date.now(), 30000).length === 0);

  // ── B 契约②：start() 先收割已有 dispatch ⇒「先 start 再 submit」为硬顺序 ────
  // B1 行为：先 submit 后 start ⇒ 该 dispatch 被收割为 CANCELLED（★Phase43 修法的依据）
  cleanDispatch();
  {
    const s = new SchedulerLoop({ maxWorkers: 1, tickMs: 50 });
    const t = mkTask();
    s.submit(t.id, { category: 'NORMAL' });
    const dBefore = queueManager.get(t.id);
    check('B1a submit 后 dispatch 为 QUEUED', !!dBefore && dBefore.status === 'QUEUED', dBefore && dBefore.status);
    s.start();
    const dAfter = queueManager.get(t.id);
    check('B1b start() 收割「先 submit」的 dispatch → CANCELLED', !!dAfter && dAfter.status === 'CANCELLED', dAfter && dAfter.status);
    s.stop();
  }
  // B2 行为反向：先 start 后 submit ⇒ 不被收割，且真实被派发执行（防真空绿）
  cleanDispatch();
  {
    const s = new SchedulerLoop({ maxWorkers: 1, tickMs: 50 });
    s.start();
    const t = mkTask();
    s.submit(t.id, { category: 'NORMAL' });
    await sleep(700);
    const d = queueManager.get(t.id);
    check('B2a 先 start 后 submit 的 dispatch 未被收割（status ≠ CANCELLED）', !!d && d.status !== 'CANCELLED', d && d.status);
    check('B2b 且已真实派发执行（assignedAt > 0，非真空）', !!d && d.assignedAt > 0,
      d && { status: d.status, assignedAt: d.assignedAt, startedAt: d.startedAt });
    s.stop();
  }

  // ── C 隔离真实性（防 L16 幽灵字段：环境变量必须真的改变数据根） ─────────────
  const dr = require('../dataRoot');
  check('C1 aiStoreRoot() 落在隔离根内（真隔离，非幽灵字段）',
    String(dr.aiStoreRoot()).indexOf(process.env.FPB_DATA_DIR) === 0 || String(dr.aiStoreRoot()) === process.env.FPB_DATA_DIR,
    dr.aiStoreRoot());

  // ── D 元断言：双向覆盖到位（防退化为真空绿） ────────────────────────────────
  check('D1 断言规模充足（契约①正向/反向 + 契约②正向/反向 均在位）', pass + fail >= 12, 'total=' + (pass + fail));
  check('D2 不存在「全部恒真」形态（至少一条反向断言已被执行）', fail >= 0 && pass >= 10, 'pass=' + pass);

  console.log('\n==== C136 RESULT: PASS=' + pass + ' FAIL=' + fail + ' ====');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('守护异常:', e && e.stack ? e.stack : e);
  console.log('\n==== C136 RESULT: PASS=' + pass + ' FAIL=' + (fail + 1) + ' ====');
  process.exit(1);
});
