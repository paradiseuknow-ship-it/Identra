'use strict';

// CAP-M1（STEP 12）：定时触发 / 批量执行。
//
// 审计结论（2026-08-30）：仓库内 schedulerLoop 只是「派遣调度器」（Queue→Worker→Runtime），
// 不存在任何时间表触发实体 —— 定时创建任务 / 一个目标跑多 Profile 的批量执行完全缺失。
//
// 设计（最小可商业化闭环，与既定纪律一致）：
//  - 实体 aiSchedules（JSON store，与 aiTasks 同层）：任务模板 + profileIds[]（批量维度）+ intervalMs（周期）。
//  - tick 循环（1s，unref，惰性启动）只扫描「到期」的 ACTIVE schedule 并触发；绝不改任务业务状态、
//    不参与 Agent 推理 —— 派遣语义仍归 schedulerLoop / taskManager。
//  - 每次触发 = 每个 profileId 建一个独立 AI Task（同 objective），归属继承 schedule 的
//    workspaceId/createdBy（服务端继承，不信任调用方）；Profile 锁（lock.acquire）天然保证同 Profile 互斥。
//  - 执行链决策与 POST /execution/submit 完全一致：Scheduler RUNNING → queueManager.submit 入队；
//    否则 taskManager.start 直启（绝不卡死 QUEUED）。
//  - fail-open：单 schedule / 单 task 触发失败不影响其余；tick 异步不阻塞退出（unref）。
//  - 身份：HTTP 层经 identity.assertCanAccessResource（task:create / task:read）；
//    模块级直调（user===undefined）不启用守卫，供测试与既有内部消费方使用。

const store = require('./store');
const events = require('./events');
const taskManager = require('./taskManager');
const identity = require('../identity');
const { cronNext } = require('./cronExpr'); // C21：cron 模式（可选，优先于 intervalMs）

const MIN_INTERVAL_MS = 1000;       // 理论下限；产品建议 >= 60s
const MAX_PROFILES_PER_SCHEDULE = 50; // 单 schedule 批量上限（防滥用）
const TICK_MS = 1000;

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function bad(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
// 模块级直调（user===undefined）不启用守卫；HTTP 层恒传 req.identityUser（null → 401）
function guard(user, resource, permission) {
  if (user === undefined) return true;
  return identity.assertCanAccessResource(user, resource, permission);
}

// C56：周期推进永不抛错（防重复触发风暴）。
// cronNext 无匹配（视界 366 天，如闰日 cron 触发当日之后）或表达式损坏时，旧实现在
// fireSchedule 之后抛错 → nextRunAt 不推进不落盘 → 下一 tick（1s）重新到期 → 每秒重复触发风暴。
// 修复：先推进（纯计算、绝不抛）再触发；cron 失败退避而非中断；interval 非法落 MIN 下限而非 ||0（+0 = 每秒到期）。
const CRON_FAILURE_BACKOFF_MS = 60000;
function _advanceNextRun(sched, fromMs) {
  if (sched.cron) {
    try {
      const nx = cronNext(sched.cron, new Date(fromMs));
      if (Number.isFinite(nx)) return nx;
    } catch (e) { /* 视界内无匹配 / 表达式损坏 → 退避 */ }
    return fromMs + CRON_FAILURE_BACKOFF_MS;
  }
  const iv = Number(sched.intervalMs);
  return fromMs + (Number.isInteger(iv) && iv >= MIN_INTERVAL_MS ? iv : MIN_INTERVAL_MS);
}

// ---- 校验 ----
// C21 起支持双周期模式：cron（可选字段，优先）或 intervalMs（缺省路径，向后兼容）。
// cron 提供时 intervalMs 可省略；两者都缺 → 400。
function _validateTemplate(input) {
  if (!input.objective && !input.targetUrl) throw bad(400, 'objective 或 targetUrl 必填');
  if (input.cron !== undefined && input.cron !== null && input.cron !== '') {
    try { cronNext(String(input.cron).trim(), Date.now()); } // 解析 + 至少存在一个未来触发点（二月 31 日类直接 400）
    catch (e) { throw bad(400, 'cron 非法: ' + String(e.message || e).slice(0, 150)); }
    return; // cron 模式不要求 intervalMs
  }
  if (!Number.isInteger(input.intervalMs) || input.intervalMs < MIN_INTERVAL_MS) {
    throw bad(400, 'intervalMs 必须为整数且 >= ' + MIN_INTERVAL_MS + '（或提供合法 cron 表达式）');
  }
  if (input.profileIds !== undefined) {
    if (!Array.isArray(input.profileIds) || input.profileIds.some((p) => typeof p !== 'string')) {
      throw bad(400, 'profileIds 必须为字符串数组');
    }
    if (input.profileIds.length > MAX_PROFILES_PER_SCHEDULE) {
      throw bad(400, 'profileIds 超过单 schedule 上限 ' + MAX_PROFILES_PER_SCHEDULE);
    }
  }
}

// ---- CRUD ----
function createSchedule(input, user) {
  _validateTemplate(input || {});
  const now = Date.now();
  const sched = {
    id: uid('sched_'),
    name: String((input || {}).name || '定时任务').slice(0, 120),
    objective: input.objective || '',
    targetUrl: input.targetUrl || '',
    profileIds: Array.isArray(input.profileIds) ? input.profileIds.slice(0, MAX_PROFILES_PER_SCHEDULE) : [],
    executionMode: input.executionMode || 'ASSIST',
    constraints: Array.isArray(input.constraints) ? input.constraints : [],
    priority: Number.isInteger(input.priority) ? input.priority : 50,
    intervalMs: input.intervalMs !== undefined && input.intervalMs !== null ? input.intervalMs : null,
    cron: (input.cron !== undefined && input.cron !== null && input.cron !== '') ? String(input.cron).trim() : null, // C21
    autoStart: input.autoStart !== false, // 默认触发即执行
    status: 'ACTIVE',
    // CAP-O1 归属：由服务端身份层盖章（HTTP 路径），模块直调允许显式传入（测试）
    workspaceId: (user && user.currentWorkspaceId) || input.workspaceId || null,
    createdBy: (user && user.id) || input.createdBy || null,
    nextRunAt: (input.cron ? cronNext(String(input.cron).trim(), new Date(now)) : now + input.intervalMs),
    lastRunAt: null,
    runCount: 0,
    lastRunTaskIds: [],
    lastRunErrors: [],
    createdAt: now,
    updatedAt: now,
  };
  store.insert('aiSchedules', sched);
  events.emit({ type: 'schedule.created', payload: { scheduleId: sched.id, name: sched.name, intervalMs: sched.intervalMs, profiles: sched.profileIds.length, at: now } });
  return sched;
}

function getSchedule(id) {
  return store.find('aiSchedules', id);
}

function listSchedules(user) {
  const list = store.read('aiSchedules', []);
  if (user === undefined) return list;
  return identity.filterByWorkspace(list, user);
}

const _UPDATABLE = ['name', 'objective', 'targetUrl', 'profileIds', 'executionMode', 'constraints', 'priority', 'autoStart'];
function updateSchedule(id, patch, user) {
  const sched = getSchedule(id);
  if (!sched) throw bad(404, 'schedule 不存在');
  guard(user, sched, 'task:create');
  patch = patch || {};
  if (patch.status !== undefined && !['ACTIVE', 'PAUSED'].includes(patch.status)) throw bad(400, '非法状态');
  if (_UPDATABLE.some((k) => patch[k] !== undefined) || patch.intervalMs !== undefined || patch.cron !== undefined) {
    _validateTemplate(Object.assign({}, sched, patch, {
      intervalMs: patch.intervalMs !== undefined ? patch.intervalMs : sched.intervalMs,
      cron: patch.cron !== undefined ? patch.cron : sched.cron,
    }));
  }
  for (const k of _UPDATABLE) {
    if (patch[k] !== undefined) sched[k] = patch[k];
  }
  if (patch.status !== undefined) sched.status = patch.status;
  if (patch.cron !== undefined) {
    sched.cron = (patch.cron === null || patch.cron === '') ? null : String(patch.cron).trim();
  }
  const intervalChanged = patch.intervalMs !== undefined && patch.intervalMs !== sched.intervalMs;
  if (intervalChanged) sched.intervalMs = patch.intervalMs;
  // 周期/cron 任一变更 → 立即重算下一次（cron 模式从当下起算；interval 模式以最近一次运行为基准，PAUSED 期间也成立）
  if (patch.cron !== undefined || intervalChanged) {
    // C56：先落下限再计算（旧顺序 intervalMs||0 先算，+0 = 立即既往到期）；cron 侧推进绝不抛错
    if (!sched.cron && !Number.isInteger(sched.intervalMs)) sched.intervalMs = MIN_INTERVAL_MS;
    sched.nextRunAt = sched.cron
      ? _advanceNextRun(sched, Date.now())
      : (sched.lastRunAt || sched.createdAt) + (sched.intervalMs || MIN_INTERVAL_MS);
  }
  sched.updatedAt = Date.now();
  store.upsert('aiSchedules', sched);
  events.emit({ type: 'schedule.updated', payload: { scheduleId: sched.id, status: sched.status, intervalMs: sched.intervalMs, at: sched.updatedAt } });
  return sched;
}

function deleteSchedule(id, user) {
  const sched = getSchedule(id);
  if (!sched) throw bad(404, 'schedule 不存在');
  guard(user, sched, 'task:create');
  store.remove('aiSchedules', id);
  events.emit({ type: 'schedule.deleted', payload: { scheduleId: sched.id, at: Date.now() } });
  return sched;
}

// ---- 触发 ----
// 执行链决策与 POST /execution/submit 完全一致（绝不卡死 QUEUED）。
// 惰性 require schedulerLoop：模块级单测打桩（patch getInstance）不需要预加载全链。
function _startCreated(taskId) {
  try {
    const loop = require('./execution/schedulerLoop').getInstance();
    if (loop && typeof loop.getStatus === 'function' && loop.getStatus().status === 'RUNNING') {
      require('./execution/queueManager').submit(taskId, {});
      return { mode: 'queued' };
    }
  } catch (e) { /* scheduler 不可用 → 直启（唯一执行链兜底） */ }
  taskManager.start(taskId);
  return { mode: 'direct' };
}

function fireSchedule(sched, source) {
  const profiles = Array.isArray(sched.profileIds) && sched.profileIds.length ? sched.profileIds : [null];
  const taskIds = [];
  const errors = [];
  for (const pid of profiles) {
    try {
      const t = taskManager.createTask({
        name: sched.name + ' · ' + new Date().toISOString().replace('T', ' ').slice(0, 19),
        objective: sched.objective,
        targetUrl: sched.targetUrl,
        profileId: pid,
        executionMode: sched.executionMode,
        constraints: sched.constraints,
        priority: sched.priority,
        scheduleId: sched.id,
        // 归属继承 schedule（服务端提供），不接受调用方伪造
        workspaceId: sched.workspaceId,
        createdBy: sched.createdBy,
      });
      taskIds.push(t.id);
      if (sched.autoStart !== false) {
        try { _startCreated(t.id); } catch (e) { errors.push('start ' + t.id + ': ' + String(e.message || e).slice(0, 120)); }
      }
    } catch (e) {
      errors.push(String(e.message || e).slice(0, 160));
    }
  }
  events.emit({
    type: errors.length ? 'schedule.fire_error' : 'schedule.triggered',
    payload: { scheduleId: sched.id, source: source || 'manual', taskIds, errors, at: Date.now() },
  });
  return { taskIds, errors };
}

function triggerOnce(id, user, source) {
  const sched = getSchedule(id);
  if (!sched) throw bad(404, 'schedule 不存在');
  guard(user, sched, 'task:create');
  if (sched.status !== 'ACTIVE') throw bad(400, 'schedule 已暂停（PAUSED），请先恢复');
  // C56：先推进周期并落盘，再触发 —— 即使触发过程或记录落盘抛错，nextRunAt 已推进，绝不重复触发
  sched.lastRunAt = Date.now();
  sched.runCount = (sched.runCount || 0) + 1;
  sched.nextRunAt = _advanceNextRun(sched, Date.now()); // 手动触发也顺延周期（避免手动+到期双拍）
  store.upsert('aiSchedules', sched);
  let r;
  try { r = fireSchedule(sched, source || 'manual'); }
  catch (e) { r = { taskIds: [], errors: [String(e.message || e).slice(0, 160)] }; }
  sched.lastRunTaskIds = r.taskIds;
  sched.lastRunErrors = r.errors;
  try { store.upsert('aiSchedules', sched); } catch (e) { /* 记录型落盘失败不影响防风暴（周期已落盘） */ }
  return Object.assign({ ok: true, scheduleId: sched.id, runCount: sched.runCount }, r);
}

// ---- tick 循环 ----
let _ticking = false;
function tickSchedules(now) {
  if (_ticking) return { ok: true, skipped: true }; // 重入守卫
  _ticking = true;
  try {
    const due = (now || Date.now());
    const fired = [];
    for (const s of store.read('aiSchedules', [])) {
      try {
        if (s.status !== 'ACTIVE') continue;
        if (!(Number(s.nextRunAt) <= due)) continue;
        // C56：先推进周期并落盘，再触发 —— 即使触发或记录落盘抛错，nextRunAt 已推进，绝不重复触发风暴
        s.lastRunAt = Date.now();
        s.runCount = (s.runCount || 0) + 1;
        s.nextRunAt = _advanceNextRun(s, due); // C21：cron 模式严格按表，不漂移；失败退避
        store.upsert('aiSchedules', s);
        let r;
        try { r = fireSchedule(s, 'tick'); }
        catch (e) { r = { taskIds: [], errors: [String(e.message || e).slice(0, 160)] }; }
        s.lastRunTaskIds = r.taskIds;
        s.lastRunErrors = r.errors;
        try { store.upsert('aiSchedules', s); } catch (e) { /* 记录型落盘失败不影响防风暴 */ }
        fired.push(s.id);
      } catch (e) {
        // fail-open：单 schedule 失败不影响其余，schedule 本体不损坏
        events.emit({ type: 'schedule.tick_error', payload: { scheduleId: s.id, error: String(e.message || e).slice(0, 200), at: Date.now() } });
      }
    }
    return { ok: true, fired };
  } finally {
    _ticking = false;
  }
}

let _loopTimer = null;
function startTriggerLoop() {
  if (_loopTimer) return { ok: true, note: 'already started' };
  _loopTimer = setInterval(() => { try { tickSchedules(); } catch (e) { /* 循环永不因异常中断 */ } }, TICK_MS);
  if (_loopTimer.unref) _loopTimer.unref(); // 不阻塞进程退出
  return { ok: true, tickMs: TICK_MS };
}
function stopTriggerLoop() {
  if (_loopTimer) { clearInterval(_loopTimer); _loopTimer = null; }
  return { ok: true };
}

// ---- HTTP 路由（挂 /api/ai/schedules；req.identityUser 由全局 identityResolver 提供） ----
const router = require('express').Router();
router.use((req, res, next) => { req._user = req.identityUser; next(); });

function _send(res, fn) {
  try { res.json(fn()); }
  catch (e) { res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
}

router.post('/', (req, res) => {
  _send(res, () => ({ ok: true, schedule: createSchedule(req.body || {}, req._user) }));
});
router.get('/', (req, res) => {
  _send(res, () => ({ ok: true, schedules: listSchedules(req._user) }));
});
router.get('/:id', (req, res) => {
  _send(res, () => {
    const s = getSchedule(req.params.id);
    if (!s) throw bad(404, 'schedule 不存在');
    if (req._user !== undefined) identity.assertCanAccessResource(req._user, s, 'task:read');
    return { ok: true, schedule: s };
  });
});
router.put('/:id', (req, res) => {
  _send(res, () => ({ ok: true, schedule: updateSchedule(req.params.id, req.body || {}, req._user) }));
});
router.delete('/:id', (req, res) => {
  _send(res, () => ({ ok: true, deleted: deleteSchedule(req.params.id, req._user).id }));
});
router.post('/:id/trigger', (req, res) => {
  _send(res, () => triggerOnce(req.params.id, req._user, 'manual'));
});

module.exports = {
  createSchedule, getSchedule, listSchedules, updateSchedule, deleteSchedule,
  triggerOnce, fireSchedule, tickSchedules, startTriggerLoop, stopTriggerLoop,
  MIN_INTERVAL_MS, MAX_PROFILES_PER_SCHEDULE, CRON_FAILURE_BACKOFF_MS,
  router,
};
