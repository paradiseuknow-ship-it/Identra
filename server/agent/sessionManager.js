'use strict';

// AI Session：一次用户对话的容器，可挂载多个 Task。
// 结构：{ id, userMessages[], tasks[], context{profileId,site}, createdAt }
// 未来支持连续对话与多轮上下文。

const store = require('./store');

function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function createSession({ userMessage, context } = {}) {
  const session = {
    id: uid('session_'),
    userMessages: userMessage ? [{ role: 'user', content: String(userMessage).slice(0, 2000), timestamp: Date.now() }] : [],
    tasks: [],
    context: context || { profileId: '', site: '' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.insert('aiSessions', session);
  return session;
}

function getSession(id) {
  return store.find('aiSessions', id);
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

module.exports = { createSession, getSession, listSessions, addMessage, attachTask, deleteSession };
