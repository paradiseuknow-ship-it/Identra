'use strict';

// Event Hub + EventStore。
// 原则：SSE 只负责实时推送，不负责状态；真实状态以持久化存储为准（GET /api/ai/tasks/:id）。
// EventID 全局单调唯一；客户端重连带 Last-Event-ID，服务端回放增量，避免重复渲染。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

// 取证扩容（真实站点阶段）：aiEvents 500 条环形缓冲在长跑批/高事件率下相互覆盖
// （run6 实证：早期任务事件被驱逐，失败变体证据丢失）。FPB_EVENTS_DIR 设置时，
// 每条事件额外按 taskId 增量落 JSONL（<dir>/<taskId>.jsonl，无 taskId 归 _global.jsonl），
// 只增不改、失败静默（取证落盘绝不能拖垮主链路）。零默认行为改动。
function persistPerTask(evt) {
  const dir = process.env.FPB_EVENTS_DIR;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = String(evt.taskId || '_global').replace(/[^\w.-]/g, '_').replace(/\.{2,}/g, '__');
    fs.appendFileSync(path.join(dir, name + '.jsonl'), JSON.stringify(evt) + '\n', 'utf8');
  } catch (e) { /* 取证失败不影响推送与存储 */ }
}

let seq = 0;

function nextEventId() {
  seq += 1;
  return 'evt_' + Date.now().toString(36) + '_' + seq.toString(36);
}

// 事件类型枚举（保持单一来源，前端 timeline 据此渲染）
const EVENT_TYPES = [
  'task.created', 'task.planned', 'task.started', 'task.step_started',
  'agent.observing', 'agent.planning', 'agent.tool_called', 'agent.tool_result',
  'agent.diagnosing', 'agent.repairing', 'agent.retrying', 'agent.recovered',
  // C105 F4/F5：replan selector 接地净化与同签名 flapping 熔断观测
  'agent.replan_sanitized', 'agent.flapping_detected',
  // STEP 3/4：统一诊断与升级观测（agent.diagnosed 带 rootCause/retryPolicy；
  // agent.escalating 表示诊断判定「不可重试」，已停止消耗剩余重试次数）
  'agent.diagnosed', 'agent.escalating',
  // C106 F15：分步表单推进（目标字段尚未出现 → 点前进控件后重查；带 term/selector/advanced 取证）
  'agent.staged_form_advance',
  'task.paused', 'task.resumed', 'task.completed', 'task.failed', 'task.cancelled',
  // A 类 cancel deadline（2026-08-31）：cancel 收尾链任一环节超时/异常时的审计事件
  'task.cancel_timeout',
  // Phase 5.8：显式人工升级终态（taskManager.escalate 发出；此前漏登记，每次触发都报「非标准事件类型」）
  'task.escalated',
  'execution.created', 'execution.crash_detected', 'execution.recovered',
  // Phase 1.4：更细粒度事件
  'ai.thinking', 'ai.plan.created', 'ai.action.started', 'ai.action.completed',
  'ai.verification.completed', 'ai.warning', 'ai.needApproval', 'ai.failed',
  // STEP 22 (V2)：persistAfterReload 复验事件族（start / reload_failed / reverified）
  'ai.verification.persist_reload',
  'ai.approved', 'ai.rejected', 'ai.modified', 'ai.snapshot',
  // Phase 4.3：Scheduler / Dispatch 观测事件（供 4.6 Observability 消费）
  'scheduler.started', 'scheduler.stopped', 'scheduler.tick', 'scheduler.paused',
  'scheduler.resumed', 'scheduler.draining',
  'dispatch.selected', 'dispatch.assigned', 'dispatch.rejected',
  'worker.capacity.full',
  // CAP-M1（STEP 12）：定时触发 / 批量执行观测事件
  'schedule.created', 'schedule.updated', 'schedule.deleted',
  'schedule.triggered', 'schedule.fire_error', 'schedule.tick_error',
  // C11（2026-09-06）事件注册表对账：以下 10 类生产在发但此前漏登记
  //（smoke6 实证每次运行刷「非标准事件类型」警告）——补登记消除漂移。
  // planner：Flow Memory 命中回放与融合规划
  'task.plan_from_flow', 'agent.replan', 'agent.replan_fused',
  // 验证窗口 / 决策 / 恢复（verification 族，与 persist_reload 同族）
  'ai.verification.window', 'ai.verification.decision', 'ai.verification.recovered',
  // 守护规则通过（policy guard）
  'ai.guard.passed',
  // policy 决策（守护层拦截/自动支付裁定，policy.js）
  'ai.policy.autoPayment', 'ai.policy.blocked',
  // 观测面（observability 模块）
  'observability.metrics.tick', 'observability.trace.stage',
  // scheduler 僵尸进程回收
  'scheduler.reaped',
];

// 内存客户端集合（SSE 连接）
const clients = new Set(); // { res, taskId|null, executionId|null }

// 进程内轻量订阅（供 Scheduler Loop 等业务模块监听终态事件，区别于 SSE 客户端推送）。
const listeners = new Set(); // fn(evt)

function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function normalize(partial) {
  return {
    eventId: nextEventId(),
    taskId: partial.taskId || null,
    executionId: partial.executionId || null,
    stepId: partial.stepId || null,
    attemptId: partial.attemptId || null,
    type: partial.type,
    timestamp: Date.now(),
    payload: partial.payload || {},
  };
}

function emit(partial) {
  if (!EVENT_TYPES.includes(partial.type)) {
    // 允许自定义扩展类型，但打日志提示
    console.warn('[agent.events] 非标准事件类型:', partial.type);
  }
  const evt = normalize(partial);
  try {
    store.appendEvent(evt);
  } catch (e) {
    // 持久化失败不影响推送
  }
  persistPerTask(evt);
  broadcast(evt);
  // 进程内 listener（捕获异常，避免单个 listener 拖垮事件总线）
  for (const fn of listeners) {
    try { fn(evt); } catch (e) { console.error('[agent.events] listener error:', e && e.message); }
  }
  return evt;
}

function broadcast(evt) {
  for (const c of clients) {
    if (c.taskId && c.taskId !== evt.taskId) continue;
    if (c.executionId && c.executionId !== evt.executionId) continue;
    try {
      c.res.write(`id: ${evt.eventId}\ndata: ${JSON.stringify(evt)}\n\n`);
    } catch (e) {
      clients.delete(c);
    }
  }
}

// SSE 挂载：设置 headers + 心跳；返回 unsubscribe 函数
function subscribe(res, filters = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\n\n`);
  const client = { res, taskId: filters.taskId || null, executionId: filters.executionId || null };
  clients.add(client);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 15000);
  const unsubscribe = () => {
    clearInterval(heartbeat);
    clients.delete(client);
  };
  reqOnClose(res, unsubscribe);
  return unsubscribe;
}

function reqOnClose(res, fn) {
  try {
    res.on('close', fn);
    res.on('error', fn);
  } catch (e) {}
}

// 重连回放：返回 lastEventId 之后的事件（已持久化）
function replaySince(lastEventId, filters = {}) {
  let events = [];
  try { events = store.eventsSince(lastEventId); } catch (e) { events = []; }
  if (filters.taskId) events = events.filter((e) => e.taskId === filters.taskId);
  if (filters.executionId) events = events.filter((e) => e.executionId === filters.executionId);
  return events;
}

function recent(taskId, limit = 200) {
  let events = [];
  try { events = store.read('aiEvents', []); } catch (e) { events = []; }
  if (taskId) events = events.filter((e) => e.taskId === taskId);
  return events.slice(-limit);
}

module.exports = { emit, on, subscribe, replaySince, recent, EVENT_TYPES, nextEventId };
