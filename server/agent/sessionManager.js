'use strict';

// AI Session：一次用户对话的容器，可挂载多个 Task。
// 结构：{ id, userMessages[], tasks[], context{profileId,site}, createdAt }
// 未来支持连续对话与多轮上下文。

const store = require('./store');

// ── C117 会话保留策略 ────────────────────────────────────────────────────────
// aiSessions 此前登记为 UNBOUNDED_ACCEPTED：每次 createSession insert 一条、无 TTL
// ⇒ 随对话量无界。与队列同源，都**不能**用按位置切分的 archiveOldest（它会把仍被引用的
// 记录移出主文件），必须按谓词切分。会话的谓词 = updatedAt 超龄 ∨ 超出封顶。
//
// 关键区别：队列项被归档后不改变任何行为（任务已终结），而会话是**用户可见且可回访**的
// 对象——归档若使 getSession 返回 null，index.js:511 会静默新建会话，用户「恢复旧对话」
// 就变成「对话历史消失」。故本模块配套「归档不改变可访问性」：getSession 主集合 miss 时
// 从归档原位恢复（见 getSession 注释）。
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const SESSION_MAX = 200;

function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 会话活跃时点：updatedAt 优先，回落 createdAt（早期记录可能只有后者）。
function sessionTouchTime(s) {
  if (Number.isFinite(s.updatedAt)) return s.updatedAt;
  if (Number.isFinite(s.createdAt)) return s.createdAt;
  return null;
}

function createSession({ userMessage, context, workspaceId, createdBy } = {}) {
  const session = {
    id: uid('session_'),
    userMessages: userMessage ? [{ role: 'user', content: String(userMessage).slice(0, 2000), timestamp: Date.now() }] : [],
    tasks: [],
    context: context || { profileId: '', site: '' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // C79：归属章（可选传入；由路由层从身份层取，模块不感知身份）。有章 = workspace-scoped
  // 资源（GET /sessions 按工作区过滤、/chat 复用时守卫）；无章 = legacy → 仅 local 用户可见。
  if (workspaceId) session.workspaceId = workspaceId;
  if (createdBy) session.createdBy = createdBy;
  store.insert('aiSessions', session);
  // C117：新建会话是唯一增长点 ⇒ 在同一自然写点上裁剪（唯一调用点）。刚建的会话
  // updatedAt = now，永不落在本次裁剪范围内。
  pruneSessions();
  return session;
}

// 归档 updatedAt 超龄（>30d）∨ 超出封顶（200 条）的会话。返回 { archived, remaining }。
// opts 仅用于测试注入（now / retentionMs / maxSessions），零时间等待。
function pruneSessions(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const retentionMs = Number.isFinite(opts.retentionMs) ? opts.retentionMs : SESSION_RETENTION_MS;
  const maxSessions = Number.isFinite(opts.maxSessions) ? opts.maxSessions : SESSION_MAX;

  const all = store.read('aiSessions', []);
  if (!Array.isArray(all) || all.length === 0) return { archived: 0, remaining: all || [] };

  const doomed = new Set();
  for (const s of all) {
    const t = sessionTouchTime(s);
    // 活跃时点缺失/非法 ⇒ 不动（判断不了的记录不该被静默扫走）
    if (t !== null && now - t > retentionMs) doomed.add(s.id);
  }
  // 封顶与年龄无关：活跃时点降序保留最新 maxSessions 条。
  const newestFirst = all.slice().sort((a, b) => (sessionTouchTime(b) || 0) - (sessionTouchTime(a) || 0));
  for (const s of newestFirst.slice(Math.max(0, maxSessions))) doomed.add(s.id);

  if (doomed.size === 0) return { archived: 0, remaining: all };

  try {
    const res = store.archiveWhere('aiSessions', (s) => doomed.has(s.id));
    return { archived: res.archived, remaining: res.remaining };
  } catch (e) {
    // 归档失败绝不阻断新建会话（磁盘卫生 ≠ 控制路径），但必须 loud。
    console.warn('[sessions] pruneSessions 归档失败(已忽略，会话功能不受影响):', String((e && e.message) || e).slice(0, 150));
    return { archived: 0, remaining: all };
  }
}

function getSession(id) {
  const hit = store.find('aiSessions', id);
  if (hit) return hit;
  // C117：归档不改变可访问性。被 TTL 归档的会话在**再次被访问时原位恢复**——
  // 否则本函数返回 null，而 index.js:511 (`sessionId ? getSession(sessionId) : null`)
  // 拿到 null 会直接 createSession：用户点开旧对话看到的是空白新会话，历史像是丢了，
  // 且全程无报错（静默行为破坏）。恢复后 upsert 回主集合，后续 addMessage/attachTask
  // 走既有路径，无需其他改动。
  if (typeof store.findInArchive !== 'function') return null; // 非 JSON 驱动：无归档概念
  const revived = store.findInArchive('aiSessions', id);
  if (!revived) return null;
  store.insert('aiSessions', revived);
  return revived;
}

function listSessions() {
  return store.read('aiSessions', []).sort((a, b) => b.updatedAt - a.updatedAt);
}

function addMessage(sessionId, role, content) {
  const s = getSession(sessionId);
  if (!s) return null;
  s.userMessages.push({ role, content: String(content).slice(0, 4000), timestamp: Date.now() });
  s.updatedAt = Date.now();
  store.upsert('aiSessions', s);
  return s;
}

function attachTask(sessionId, taskId) {
  const s = getSession(sessionId);
  if (!s) return null;
  if (!s.tasks.includes(taskId)) s.tasks.push(taskId);
  s.updatedAt = Date.now();
  store.upsert('aiSessions', s);
  return s;
}

function deleteSession(id) {
  store.remove('aiSessions', id);
}

module.exports = {
  createSession, getSession, listSessions, addMessage, attachTask, deleteSession,
  // C117：会话保留策略（导出供守护测试注入 now/retentionMs/maxSessions，零时间等待）
  pruneSessions, SESSION_RETENTION_MS, SESSION_MAX,
};
