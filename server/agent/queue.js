'use strict';

// Task Queue：优先级调度（为多任务做准备）。
// 入队：{ taskId, priority, createdAt, deadline, profileId }
// 出队：priority 高优先；同优先级 deadline 早优先；均无则 FIFO。
// 同一 profileId 同时只能有一个任务出队执行（配合 Resource Lock）。

const store = require('./store');

// ── C117 终态保留策略 ────────────────────────────────────────────────────────
// aiQueue 此前登记为 UNBOUNDED_ACCEPTED：markDone 只改 status、终态记录永久残留
// ⇒ 随任务量无界（每次写都要全量 read + write，aiAttempts 42MB 事故同款成因）。
//
// 为什么不能直接用既有 archiveOldest：它按「数组头部 + count」切分（data.slice(0, count)），
// 对「主文件即工作集」的队列是行为破坏——会把仍在 PENDING 的任务移出主文件，而
// dequeue() 只读主文件 ⇒ **任务静默不执行**（比无界增长更糟）。正解 = 按谓词切分：
// 只归档**已终结**的记录，PENDING/RUNNING 永不触碰。
//
// 双条件（纯 TTL 挡不住突发积压；纯封顶挡不住长尾）：
//   ① 超龄：终态且 age > QUEUE_TERMINAL_RETENTION_MS
//   ② 封顶：终态项按 createdAt 降序只保留最新 QUEUE_TERMINAL_MAX 条
const QUEUE_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const QUEUE_TERMINAL_MAX = 500;
const QUEUE_TERMINAL_STATES = ['DONE', 'FAILED', 'CANCELLED'];

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
  let result;
  if (existing) {
    // 同 task 重复入队：更新优先级/状态，不重复插入
    existing.priority = item.priority;
    existing.profileId = item.profileId;
    if (QUEUE_TERMINAL_STATES.indexOf(existing.status) >= 0) existing.status = 'PENDING';
    store.upsert('aiQueue', existing);
    result = existing;
  } else {
    store.insert('aiQueue', item);
    result = item;
  }
  // C117：入队是队列唯一的增长点 ⇒ 在同一个自然写点上顺带裁剪终态（唯一调用点，
  // 避免两处 return 各调一次而将来漂移）。两条路径返回的项都必为 PENDING（上面已保证），
  // 因此永远不可能被本次裁剪归档。
  pruneTerminal();
  return result;
}

// 归档终态且（超龄 ∨ 超出封顶）的队列项。PENDING/RUNNING 永不归档。
// 返回 { archived, remaining }；opts 仅用于测试注入（now / retentionMs / maxTerminal）。
function pruneTerminal(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const retentionMs = Number.isFinite(opts.retentionMs) ? opts.retentionMs : QUEUE_TERMINAL_RETENTION_MS;
  const maxTerminal = Number.isFinite(opts.maxTerminal) ? opts.maxTerminal : QUEUE_TERMINAL_MAX;

  const all = store.read('aiQueue', []);
  if (!Array.isArray(all) || all.length === 0) return { archived: 0, remaining: all || [] };

  const terminals = all.filter((x) => x && QUEUE_TERMINAL_STATES.indexOf(x.status) >= 0);
  if (terminals.length === 0) return { archived: 0, remaining: all };

  const doomed = new Set();
  for (const x of terminals) {
    // 年龄基准取 createdAt（markDone 只改 status、不落终态时间戳）⇒ 用「入队时刻」
    // 只会偏保守（更晚判超龄），绝不早判。createdAt 缺失/非法的记录**不动**：
    // 判断不了的记录不该被静默扫走。
    if (Number.isFinite(x.createdAt) && now - x.createdAt > retentionMs) doomed.add(x.id);
  }
  // 封顶与年龄无关：终态行数本身就是无界的直接来源，超出即归档（最老优先）。
  const newestFirst = terminals.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const x of newestFirst.slice(Math.max(0, maxTerminal))) doomed.add(x.id);

  if (doomed.size === 0) return { archived: 0, remaining: all };

  try {
    const res = store.archiveWhere('aiQueue', (x) => doomed.has(x.id));
    return { archived: res.archived, remaining: res.remaining };
  } catch (e) {
    // 归档失败绝不阻断入队：裁剪只是磁盘卫生，入队是控制路径。但必须 loud——
    // 静默失败会把「有界」变成假陈述（C58 D2「重复/静默漂移」教训）。
    // 返回 pre-prune 的 remaining（最坏情况是记录重复留在归档与主文件，不是丢失）。
    console.warn('[queue] pruneTerminal 归档失败(已忽略，队列行为不受影响):', String((e && e.message) || e).slice(0, 150));
    return { archived: 0, remaining: all };
  }
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

module.exports = {
  enqueue, dequeue, markDone, list, clear,
  // C117：终态保留策略（导出供守护测试注入 now/retentionMs/maxTerminal，零时间等待）
  pruneTerminal, QUEUE_TERMINAL_RETENTION_MS, QUEUE_TERMINAL_MAX, QUEUE_TERMINAL_STATES,
};
