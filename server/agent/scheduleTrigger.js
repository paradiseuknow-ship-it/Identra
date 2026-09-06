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

// ---- 校验 ----
function _validateTemplate(input) {
  if (!input.objective && !input.targetUrl) throw bad(400, 'objective 或 targetUrl 必填');
  if (!Number.isInteger(input.intervalMs) || input.intervalMs < MIN_INTERVAL_MS) {
    throw bad(400, 'intervalMs 必须为整数且 >= ' + MIN_INTERVAL_MS);
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
    intervalMs: input.intervalMs,
    autoStart: input.autoStart !== false, // 默认触发即执行
    status: 'ACTIVE',
    // CAP-O1 归属：由服务端身份层盖章（HTTP 路径），模块直调允许显式传入（测试）
    workspaceId: (user && user.currentWorkspaceId) || input.workspaceId || null,
    createdBy: (user && user.id) || input.createdBy || null,
    nextRunAt: now + input.intervalMs,
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
  if (_UPDATABLE.some((k) => patch[k] !== undefined) || patch.intervalMs !== undefined) {
    _validateTemplate(Object.assign({}, sched, patch, { intervalMs: patch.intervalMs !== undefined ? patch.intervalMs : sched.intervalMs }));
  }
  for (const k of _UPDATABLE) {
    if (patch[k] !== undefined) sched[k] = patch[k];
  }
  if (patch.status !== undefined) sched.status = patch.status;
  if (patch.intervalMs !== undefined && patch.intervalMs !== sched.intervalMs) {
    sched.intervalMs = patch.intervalMs;
    // 周期变更 → 以最近一次运行为基准重算下一次（PAUSED 期间也成立）
    sched.nextRunAt = (sched.lastRunAt || sched.createdAt) + sched.intervalMs;
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
  const r = fireSchedule(sched, source || 'manual');
  sched.lastRunAt = Date.now();
  sched.runCount = (sched.runCount || 0) + 1;
  sched.nextRunAt = Date.now() + sched.intervalMs; // 手动触发也顺延周期（避免手动+到期双拍）
  sched.lastRunTaskIds = r.taskIds;
  sched.lastRunErrors = r.errors;
  store.upsert('aiSchedules', sched);
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
        const r = fireSchedule(s, 'tick');
        s.lastRunAt = Date.now();
        s.runCount = (s.runCount || 0) + 1;
        s.nextRunAt = Date.now() + s.intervalMs;
        s.lastRunTaskIds = r.taskIds;
        s.lastRunErrors = r.errors;
        store.upsert('aiSchedules', s);
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
  MIN_INTERVAL_MS, MAX_PROFILES_PER_SCHEDULE,
  router,
};
