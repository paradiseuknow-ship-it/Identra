'use strict';

// Event Hub + EventStore。
// 原则：SSE 只负责实时推送，不负责状态；真实状态以持久化存储为准（GET /api/ai/tasks/:id）。
// EventID 全局单调唯一；客户端重连带 Last-Event-ID，服务端回放增量，避免重复渲染。

const crypto = require('crypto');
const store = require('./store');

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
  'task.paused', 'task.resumed', 'task.completed', 'task.failed', 'task.cancelled',
  'execution.created', 'execution.crash_detected', 'execution.recovered',
  // Phase 1.4：更细粒度事件
  'ai.thinking', 'ai.plan.created', 'ai.action.started', 'ai.action.completed',
  'ai.verification.completed', 'ai.warning', 'ai.needApproval', 'ai.failed',
  'ai.approved', 'ai.rejected', 'ai.modified', 'ai.snapshot',
  // Phase 4.3：Scheduler / Dispatch 观测事件（供 4.6 Observability 消费）
  'scheduler.started', 'scheduler.stopped', 'scheduler.tick', 'scheduler.paused',
  'scheduler.resumed', 'scheduler.draining',
  'dispatch.selected', 'dispatch.assigned', 'dispatch.rejected',
  'worker.capacity.full',
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
