'use strict';

// Task Queue：优先级调度（为多任务做准备）。
// 入队：{ taskId, priority, createdAt, deadline, profileId }
// 出队：priority 高优先；同优先级 deadline 早优先；均无则 FIFO。
// 同一 profileId 同时只能有一个任务出队执行（配合 Resource Lock）。

const store = require('./store');

function enqueue(entry) {
  const item = {
    id: entry.taskId, // 以 taskId 为队列项 id（天然唯一，且符合「同一 task 不重复入队」语义）
    taskId: entry.taskId,
    priority: Number.isInteger(entry.priority) ? entry.priority : 50,
    createdAt: entry.createdAt || Date.now(),
    deadline: entry.deadline || null,
    profileId: entry.profileId || null,
    status: 'PENDING', // PENDING/RUNNING/DONE/FAILED/CANCELLED
  };
  const existing = store.find('aiQueue', item.id);
  if (existing) {
    // 同 task 重复入队：更新优先级/状态，不重复插入
    existing.priority = item.priority;
    existing.profileId = item.profileId;
    if (existing.status === 'DONE' || existing.status === 'FAILED' || existing.status === 'CANCELLED') existing.status = 'PENDING';
    store.upsert('aiQueue', existing);
    return existing;
  }
  store.insert('aiQueue', item);
  return item;
}

function dequeue() {
  const queue = store.read('aiQueue', []);
  const pending = queue.filter((x) => x.status === 'PENDING');
  if (!pending.length) return null;
  pending.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority; // 高优先先出
    if (a.deadline && b.deadline) return a.deadline - b.deadline; // 同优先 deadline 早先出
    return a.createdAt - b.createdAt;                              // FIFO
  });
  const item = pending[0];
  item.status = 'RUNNING';
  store.upsert('aiQueue', item);
  return item;
}

function markDone(taskId, status = 'DONE') {
  const item = store.find('aiQueue', taskId);
  if (item) {
    item.status = status;
    store.upsert('aiQueue', item);
  }
}

function list() {
  return store.read('aiQueue', []);
}

function clear() {
  store.write('aiQueue', []);
}

module.exports = { enqueue, dequeue, markDone, list, clear };
