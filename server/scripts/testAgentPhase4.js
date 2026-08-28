'use strict';

// Phase 1.4 验收：Session / Chat / Plan Preview / Approval / Snapshot / LLM Stats。
// 依赖：后端已启动（PORT=7788）+ test-site（9555，自动拉起）。
// 用法：node server/scripts/testAgentPhase4.js

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const sessionManager = require('../agent/sessionManager');

const BASE = 'http://localhost:7788/api/ai';
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}
async function api(pathname, method = 'GET', body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error || res.statusText) + ' @' + pathname);
  return j;
}

let testSiteProc = null;
async function ensureTestSite() {
  if (await portOpen(9555)) return;
  testSiteProc = spawn(process.execPath, [path.join(__dirname, '..', 'test-site', 'server.js')], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) { if (await portOpen(9555)) return; await sleep(300); }
}

async function waitStatus(taskId, targets, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await api('/tasks/' + taskId);
    if (targets.includes(t.status)) return t;
    await sleep(1000);
  }
  return api('/tasks/' + taskId);
}

async function makeProfileSecret() {
  const pid = (await fetch('http://localhost:7788/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'p4', proxyMode: 'none', os: 'Windows', browser: 'Chrome', headless: true }) }).then((r) => r.json())).id;
  await fetch('http://localhost:7788/api/vault/' + pid, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'p4@test.local', password: 'P4#Secret' }) });
  const ref = await api('/secrets', 'POST', { profileId: pid, type: 'email_password', site: 'test.local', label: 'p4' });
  return { pid, refId: ref.id };
}

async function cleanupProfile(pid, refId) {
  try { await api('/secrets', 'GET'); } catch (e) {}
  const secs = await api('/secrets');
  for (const s of secs) if (s.id === refId) { try { await fetch(BASE + '/secrets/' + refId, { method: 'DELETE' }); } catch (e) {} }
  await fetch('http://localhost:7788/api/profiles/' + pid, { method: 'DELETE' }).catch(() => {});
}

async function main() {
  console.log('== Phase 1.4 AI Operator Console 验收 ==');
  await ensureTestSite();
  const { pid, refId } = await makeProfileSecret();

  // ---- 1) Session 单元 ----
  console.log('[session]');
  const s1 = sessionManager.createSession({ userMessage: '测试会话', context: { profileId: pid } });
  sessionManager.attachTask(s1.id, 'task_demo');
  sessionManager.addMessage(s1.id, 'ai', 'hello');
  ok(!!s1.id && s1.id.startsWith('session_'), '创建 Session');
  ok(sessionManager.getSession(s1.id).tasks.includes('task_demo'), 'Session 挂载 Task');
  ok(sessionManager.getSession(s1.id).userMessages.length === 2, 'Session 消息追加');

  // ---- 2) Chat → Plan Preview（不自动执行）----
  console.log('[chat]');
  const chatMsg = `注册 http://localhost:9555/form 使用 ${refId}`;
  const c = await api('/chat', 'POST', { message: chatMsg, profileId: pid, executionMode: 'AUTONOMOUS' });
  ok(!!c.taskId && c.taskId.startsWith('task_'), 'Chat 创建 Task', c.taskId || '');
  ok(!!c.plan && c.plan.steps.length >= 6, 'Chat 返回 Plan Preview', c.plan && String(c.plan.steps.length));
  const ctask = await api('/tasks/' + c.taskId);
  ok(ctask.status === 'PLANNING', 'Plan 生成后任务处于 PLANNING（未自动执行）', ctask.status);

  // ---- 3) 批准执行 → SUCCESS + Snapshots（1.4 默认 HIGH 需人工确认，先 pause 再 approve）----
  console.log('[execute]');
  await api('/tasks/' + c.taskId + '/start', 'POST');
  let r = await waitStatus(c.taskId, ['SUCCESS', 'FAILED', 'PAUSED_FOR_HUMAN'], 90000);
  if (r.status === 'PAUSED_FOR_HUMAN') {
    ok(true, 'HIGH 动作默认暂停等待人工确认');
    await api('/tasks/' + c.taskId + '/approve', 'POST');
    r = await waitStatus(c.taskId, ['SUCCESS', 'FAILED'], 90000);
  }
  ok(r.status === 'SUCCESS', '批准执行后 Task SUCCESS', r.error || '');
  const snaps = await api('/tasks/' + c.taskId + '/snapshots');
  ok(Array.isArray(snaps) && snaps.length >= 3, '执行过程产生 Snapshots', String(snaps.length));

  // ---- 4) LLM Stats ----
  console.log('[stats]');
  const st = await api('/llm/stats');
  ok(st && typeof st.today.calls === 'number' && st.today.tokens >= 0, 'LLM Stats 返回', JSON.stringify(st.today));

  // ---- 5) Approval 流程（ASSIST + floor MEDIUM → submit HIGH → PAUSED → approve → SUCCESS）----
  console.log('[approval]');
  const t2 = await api('/tasks', 'POST', {
    name: 'p4 approval', objective: '审批测试', targetUrl: 'http://localhost:9555/form',
    profileId: pid, executionMode: 'ASSIST', policy: { riskFloor: 'MEDIUM' }, secretRefs: [refId],
  });
  await api('/tasks/' + t2.id + '/start', 'POST');
  const paused = await waitStatus(t2.id, ['PAUSED_FOR_HUMAN', 'SUCCESS', 'FAILED'], 60000);
  ok(paused.status === 'PAUSED_FOR_HUMAN', 'HIGH 动作 → PAUSED_FOR_HUMAN', paused.error || '');
  const pd = await api('/tasks/' + t2.id);
  ok(!!pd.pendingApproval && pd.pendingApproval.action, '暂停时记录 pendingApproval 动作');
  await api('/tasks/' + t2.id + '/approve', 'POST');
  const done = await waitStatus(t2.id, ['SUCCESS', 'FAILED'], 60000);
  ok(done.status === 'SUCCESS', 'Approve 后继续执行 → SUCCESS', done.error || '');

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanupProfile(pid, refId);
  if (testSiteProc) { try { testSiteProc.kill(); } catch (e) {} }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); if (testSiteProc) { try { testSiteProc.kill(); } catch (x) {} } process.exit(1); });
