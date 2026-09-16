'use strict';
/**
 * C135 —— LLM 调用事件语义 与 调度终态结构守卫 双向咬
 * （零浏览器、零网络、零真实 LLM；不 spawn 任何子进程）。
 *
 * 缺陷背景（C135 §A 取证，A 类真缺陷）：
 *   server/agent/llm/provider.js 在 track() 的 finally 里发：
 *       type: ok ? 'agent.tool_result' : 'task.failed'
 *   —— 把**一次 LLM 调用**的成败，编码进了**任务生命周期事件类型**。
 *   'task.failed' 是任务终态事件，被 schedulerLoop._ensureListening 的进程内监听消费：
 *       无 payload 守卫 ⇒ 一次 LLM 调用失败，就会把**仍在执行**的任务当终态处理：
 *       dispatch 被 finish 成 FAILED、Worker 被 pool.onTaskFinished **提前释放**。
 *   （aiEvents 中已实证 2 例：task_mu3ajlrr36uw9 / task_mu3apcnzcml59，其 task.failed
 *     payload 为 {llm:true, provider:'deepseek', type:'structured', ok:false, ...}。）
 *
 * 修复形态（两层）：
 *   ① provider 收口为单一遥测类型 'agent.llm.call'（ok 是 payload **属性**，不是事件类型）；
 *   ② schedulerLoop 加**结构**守卫：事件类型属终态类 **∧** aiTasks 中该任务确为终态，
 *      才允许驱动 dispatch 收尾 —— 事实源是 TaskManager 的持久化状态，而非事件名。
 *
 * 守护策略（双向咬）：
 *   A 静态：provider 不再复用生命周期类型；新类型已登记白名单
 *   B ★ 行为：失败与成功**都**落进同一类型（单漏斗），绝不出现 task.failed / agent.tool_result
 *   C ★ 行为：伪终态事件被结构守卫丢弃（不触发收尾）+ **反向**真实终态照常触发（非恒拒）
 *   D 静态：结构守卫仍在（防被"简化"回去）
 *   E 隔离零污染
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c135_llm_event_' + Date.now());
// 显式固化：本套件绝不触真实 LLM（provider 由 register() 注入桩）
process.env.AI_PROVIDER = 'mock';

const events = require('../agent/events');
const taskManager = require('../agent/taskManager');
const { createProvider, register } = require('../agent/llm/provider');
const { SchedulerLoop } = require('../agent/execution/schedulerLoop');

const PROVIDER_PATH = path.join(__dirname, '..', 'agent', 'llm', 'provider.js');
const SCHED_PATH = path.join(__dirname, '..', 'agent', 'execution', 'schedulerLoop.js');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只剥整行注释：内联注释里提到旧事件名是合法文档，不算"仍在复用"
const stripLineComments = (s) => s.split('\n').filter((l) => {
  const t = l.trim();
  return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
}).join('\n');

(async () => {
  // ════════════════════════════════════════════════════════════════════════════
  // A 静态：provider 不得再复用生命周期事件类型
  // ════════════════════════════════════════════════════════════════════════════
  const pnc = stripLineComments(fs.readFileSync(PROVIDER_PATH, 'utf8'));
  check('A1 provider.js 不再发出 task.failed', pnc.indexOf("'task.failed'") < 0,
    (pnc.match(/.*task\.failed.*/) || [''])[0].slice(0, 90));
  check('A2 provider.js 不再发出 agent.tool_result', pnc.indexOf("'agent.tool_result'") < 0,
    (pnc.match(/.*agent\.tool_result.*/) || [''])[0].slice(0, 90));
  check('A3 provider.js 发出 agent.llm.call', pnc.indexOf("'agent.llm.call'") >= 0, '');
  check('A4 agent.llm.call 已登记在 events.js 白名单',
    events.EVENT_TYPES.includes('agent.llm.call'), 'n=' + events.EVENT_TYPES.length);

  // ════════════════════════════════════════════════════════════════════════════
  // B ★ 行为：成功与失败**都**落进同一遥测类型（单漏斗）
  // ════════════════════════════════════════════════════════════════════════════
  const host = taskManager.createTask({
    name: 'c135 llm probe', objective: 'x', targetUrl: 'http://probe.test/',
    profileId: null, executionMode: 'AUTONOMOUS',
  });
  const ctx = { taskId: host.id };

  const captured = [];
  const warns = [];
  const origWarn = console.warn;
  const off = events.on((e) => captured.push(e));
  console.warn = (...a) => { warns.push(a.map(String).join(' ')); };

  register('c135_probe_fail', () => ({
    name: 'c135_probe_fail', model: 'probe-1',
    async chat() { throw new Error('probe failure'); },
  }));
  register('c135_probe_ok', () => ({
    name: 'c135_probe_ok', model: 'probe-1',
    async chat() { return { content: '{}', usage: { total_tokens: 7 } }; },
  }));

  let threw = false;
  let okContent = null;
  try { await createProvider('c135_probe_fail').chat(ctx, [{ role: 'user', content: 'x' }]); } catch (e) { threw = true; }
  try { okContent = await createProvider('c135_probe_ok').chat(ctx, [{ role: 'user', content: 'x' }]); } catch (e) { okContent = 'THREW:' + e.message; }

  console.warn = origWarn;
  off();

  check('B1 探针有效：失败调用确实上抛', threw === true, '');
  check('B2 探针有效：成功调用返回内容', okContent === '{}', String(okContent));
  check('B3 两次调用各产生 1 条遥测事件', captured.length === 2, 'n=' + captured.length);
  check('B4 ★ 遥测事件全部为 agent.llm.call（成功/失败同漏斗）',
    captured.length > 0 && captured.every((e) => e.type === 'agent.llm.call'),
    JSON.stringify(captured.map((e) => e.type)));
  check('B5 ★ 绝不出现 task.failed（旧缺陷形态）',
    !captured.some((e) => e.type === 'task.failed'),
    JSON.stringify(captured.filter((e) => e.type === 'task.failed').length));
  check('B6 ★ 绝不出现 agent.tool_result（语义错配）',
    !captured.some((e) => e.type === 'agent.tool_result'), '');
  {
    const okEvt = captured.find((e) => e.payload && e.payload.ok === true);
    const failEvt = captured.find((e) => e.payload && e.payload.ok === false);
    check('B7 ok 是 payload 属性（成功/失败由它区分，不再另开事件类型）',
      !!okEvt && !!failEvt, 'ok=' + !!okEvt + ' fail=' + !!failEvt);
    check('B8 遥测保留取证字段 llm/provider/type/durationMs/tokens',
      !!okEvt && okEvt.payload.llm === true && !!okEvt.payload.provider && !!okEvt.payload.type
      && typeof okEvt.payload.durationMs === 'number' && typeof okEvt.payload.tokens === 'number',
      JSON.stringify(okEvt && okEvt.payload));
    check('B9 taskId 正确透传', captured.every((e) => e.taskId === host.id), '');
  }
  check('B10 无「非标准事件类型」告警（白名单登记确实生效）',
    warns.filter((w) => /非标准事件类型/.test(w)).length === 0, JSON.stringify(warns.slice(0, 3)));

  // ════════════════════════════════════════════════════════════════════════════
  // C ★ 行为：schedulerLoop 结构守卫（双向）
  // ════════════════════════════════════════════════════════════════════════════
  const loop = new SchedulerLoop({ maxWorkers: 1 });
  const done = [];
  loop._onTaskDone = (id, st) => done.push([id, st]);
  loop._ensureListening();

  const pending = taskManager.createTask({
    name: 'c135 guard probe', objective: 'x', targetUrl: 'http://guard.test/',
    profileId: null, executionMode: 'AUTONOMOUS',
  });
  const statusBefore = taskManager.getTask(pending.id).status;
  check('C1 前置：探针任务确实处于非终态（守卫丢弃的理由真实存在）',
    statusBefore === 'PENDING' && !taskManager.isTaskTerminal(statusBefore), statusBefore);

  const w2 = [];
  console.warn = (...a) => { w2.push(a.map(String).join(' ')); };
  events.emit({ taskId: pending.id, type: 'task.failed', payload: { llm: true, ok: false } });
  await sleep(10);
  console.warn = origWarn;

  check('C2 ★ 伪终态被结构守卫丢弃：未触发 dispatch 收尾 / 未释放 Worker',
    done.length === 0, JSON.stringify(done));
  check('C3 丢弃时留下可见告警（不静默吞掉）',
    w2.some((x) => /伪终态/.test(x)), JSON.stringify(w2.slice(0, 2)));
  check('C4 丢弃未改动任务状态',
    taskManager.getTask(pending.id).status === 'PENDING', taskManager.getTask(pending.id).status);

  // 反向咬：真实终态必须**照常**驱动（守卫不是恒拒）
  taskManager.cancel(pending.id, 'c135 guard probe');
  await sleep(10);
  check('C5 ★ 真实任务终态照常驱动收尾（守卫非恒拒）',
    done.length === 1 && done[0][0] === pending.id && done[0][1] === 'CANCELLED', JSON.stringify(done));

  // 反向咬 2：伪终态的另一支（agent.tool_result 形态）也不得触发
  done.length = 0;
  const pending2 = taskManager.createTask({
    name: 'c135 guard probe2', objective: 'x', targetUrl: 'http://guard2.test/',
    profileId: null, executionMode: 'AUTONOMOUS',
  });
  events.emit({ taskId: pending2.id, type: 'task.completed', payload: { llm: true, ok: true } });
  await sleep(10);
  check('C6 ★ 伪 task.completed（成功侧同形缺陷）同样被丢弃',
    done.length === 0, JSON.stringify(done));
  taskManager.cancel(pending2.id, 'c135 guard probe2');

  if (loop._unsub) { try { loop._unsub(); } catch (e) { /* 收尾失败不影响判定 */ } }

  // ════════════════════════════════════════════════════════════════════════════
  // D 静态：结构守卫仍在（防被"简化"回无守卫四分支）
  // ════════════════════════════════════════════════════════════════════════════
  const snc = stripLineComments(fs.readFileSync(SCHED_PATH, 'utf8'));
  check('D1 schedulerLoop 保留结构守卫（查落库状态 + isTaskTerminal）',
    /store\.find\('aiTasks'/.test(snc) && /isTaskTerminal\(/.test(snc), '');
  check('D2 已无「无守卫的四分支直连」形态',
    !/else if \(evt\.type === 'task\.failed'\) self\._onTaskDone/.test(snc), '');

  // ════════════════════════════════════════════════════════════════════════════
  // E 隔离零污染
  // ════════════════════════════════════════════════════════════════════════════
  check('E1 FPB_DATA_DIR 落在系统临时目录内（隔离）',
    path.normalize(process.env.FPB_DATA_DIR).indexOf(path.normalize(os.tmpdir())) === 0,
    process.env.FPB_DATA_DIR);

  console.log('\n===== C135 LLM EVENT SUMMARY: ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
