'use strict';

// ============================================================================
// 4-task Gate Runner —— 不修改任何 agent 实现代码，仅 require 并调用现有 API。
//
// 前置（在你自己的运行环境）：
//   1) 已运行 credential_reseed.js（Vault 解锁 + 真实凭据 resolved=true）
//   2) 真实任务配置：GATE_TASKS_FILE 指向一个 JSON 数组（见 gate_tasks.example.json）
//   3) 运行环境具备：DEEPSEEK_API_KEY、Chromium、真实网络出口
//
// 运行：
//   export GATE_TASKS_FILE="/secure/path/gate_tasks.json"
//   node server/scripts/run_4task_gate.js
//
// 说明：
//   * 这 4 个任务不是追求 4/4 成功，而是验证整条 Business Loop：
//       Planner → Resolver → Action → After Observation → Verification → Business Outcome
//       以及 VERIFY_FAILED → Fresh Observation → Re-Verification → Repair → Business Recovery
//   * 本脚本只产出「5 个指标 + 2/4 业务闭环」数据，不自动放行 100-task（由人判断）。
//   * 不补 Failure Taxonomy、不升级 Trace、不跑 100-task。
// ============================================================================

const fs = require('fs');
const path = require('path');

require('./server/agent/runtime'); // 必须：注册 executor 钩子，否则任务永远 RUNNING
const db = require('./server/db');
const tm = require('./server/agent/taskManager');
const sc = require('./server/scenarios');
const store = require('./server/agent/store');
const sm = require('./server/agent/secretManager');

const TASK_TIMEOUT_MS = Number(process.env.GATE_TASK_TIMEOUT_MS || 180000);
const POLL_MS = 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getErrMsg(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (x.message) return x.message;
  if (x.code) return x.code;
  return JSON.stringify(x);
}

function resolveSecretRefs(task) {
  if (Array.isArray(task.secretRefs)) return task.secretRefs;
  const credsPath = path.join(__dirname, 'gate_creds.json');
  const refs = [];
  if (fs.existsSync(credsPath)) {
    const c = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    if (c.profileId === task.profileId && Array.isArray(c.refs)) refs.push(...c.refs);
  }
  if (refs.length === 0 && task.profileId) {
    const masked = (sm.listMasked ? sm.listMasked() : []).filter((m) => m.profileId === task.profileId);
    masked.forEach((m) => refs.push(m.id));
  }
  return refs;
}

function ensureProfile(profileId) {
  if (!profileId) return;
  const existing = db.getProfile(profileId);
  if (existing) return;
  db.upsertProfile({
    id: profileId, name: 'gate-' + profileId, headless: true, proxyMode: 'none', fingerprint: null, createdAt: Date.now(),
  });
}

function loadTasks() {
  if (process.env.GATE_TASKS_FILE) {
    return JSON.parse(fs.readFileSync(process.env.GATE_TASKS_FILE, 'utf8'));
  }
  // 默认：内置 scenario smoke（真实 Gate 必须用 GATE_TASKS_FILE 提供真实站点）
  const ids = (process.env.GATE_TASK_IDS || 'saas.login,ecommerce.add_to_cart,data_entry.basic,real-world.rw.001').split(',');
  return ids.map((id) => {
    let s = null; try { s = sc.get(id); } catch (e) { s = null; }
    return {
      name: id,
      objective: s ? s.objective : ('Run scenario ' + id),
      targetUrl: (process.env.GATE_MOCK_BASE || 'http://localhost:3000') + (s && s.fixture ? s.fixture : '/'),
      profileId: 'p_gate_' + id.replace(/\W/g, ''),
      scenarioId: id,
    };
  });
}

async function runOne(task) {
  ensureProfile(task.profileId);
  const secretRefs = resolveSecretRefs(task);
  const created = tm.createTask({
    name: task.name || 'gate-task',
    objective: task.objective,
    targetUrl: task.targetUrl,
    profileId: task.profileId,
    executionMode: 'AUTONOMOUS',
    policy: { riskFloor: 'HIGH' },
    secretRefs,
    budget: task.budget || null,
    priority: 50,
  });
  const taskId = created.id;
  tm.start(taskId);

  let final = null;
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    final = tm.getTask(taskId);
    if (final && ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(final.status)) break;
    await sleep(POLL_MS);
  }
  if (!final) final = tm.getTask(taskId);
  return { taskId, name: task.name, final };
}

function eventTaskId(e) {
  return e.taskId || (e.payload && e.payload.taskId) || (e.ctx && e.ctx.taskId);
}

function obsFromAttempt(a) {
  const out = [];
  const keys = ['observationBefore', 'observationAfter', 'beforeObservation', 'afterObservation'];
  keys.forEach((k) => { if (a && a[k] && typeof a[k] === 'object') out.push(a[k]); });
  if (a && a.error) keys.forEach((k) => { if (a.error[k] && typeof a.error[k] === 'object') out.push(a.error[k]); });
  return out;
}

function computeMetrics(runResults) {
  const taskIds = runResults.map((r) => r.taskId).filter(Boolean);
  const tasks = store.read('aiTasks', []).filter((t) => taskIds.includes(t.id));
  const attempts = store.read('aiAttempts', []).filter((a) => taskIds.includes(a.taskId));
  const events = store.read('aiEvents', []).filter((e) => taskIds.includes(eventTaskId(e)));

  const term = new Set(['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED']);
  const taskStatus = {};
  tasks.forEach((t) => { taskStatus[t.id] = t.status; });

  // M1: Assignment to constant variable（应为 0）
  let constViolation = 0;
  const constDetail = [];
  attempts.forEach((a) => {
    if (getErrMsg(a.error).includes('Assignment to constant variable')) { constViolation++; constDetail.push(a.id); }
  });
  tasks.forEach((t) => { if (getErrMsg(t.error).includes('Assignment to constant variable')) constViolation++; });

  // M2: Credential NO_VALUE（需要凭据的任务应为 0）
  const noValue = attempts.filter((a) => (a.error || {}).code === 'NO_VALUE');

  // M3: Orphan Attempt（应为 0）
  const orphan = attempts.filter((a) => a.status === 'RUNNING' && term.has(taskStatus[a.taskId]));

  // M4: Action 后 Fresh Observation（目标 100%）
  let actionObs = 0;
  let freshAfter = 0;
  attempts.forEach((a) => {
    obsFromAttempt(a).forEach((o) => {
      if (o.source === 'after_action') { actionObs++; if (o.fresh === true) freshAfter++; }
    });
  });

  // M5: Verification Window 真实 re-observation（目标 >0 真实发生）
  const windowEvents = events.filter((e) => e.type === 'ai.verification.window');
  const recoveredEvents = events.filter((e) => e.type === 'ai.verification.recovered');

  // Business Outcome
  const successTasks = tasks.filter((t) => t.status === 'SUCCESS');
  const verifyFailed = attempts.filter((a) => (a.error || {}).failureType === 'VERIFY_FAILED' || (a.error || {}).code === 'VERIFY_FAILED');

  return {
    constViolation,
    constDetail,
    noValueCount: noValue.length,
    orphanCount: orphan.length,
    orphanDetail: orphan.map((a) => a.id),
    actionObs,
    freshAfter,
    freshPct: actionObs ? Math.round((100 * freshAfter) / actionObs) : null,
    windowEventCount: windowEvents.length,
    recoveredEventCount: recoveredEvents.length,
    successCount: successTasks.length,
    totalTasks: tasks.length,
    verifyFailedCount: verifyFailed.length,
    tasks: tasks.map((t) => ({ id: t.id, name: t.name, status: t.status, errorCode: (t.error || {}).code || null, errorMessage: getErrMsg(t.error).slice(0, 200) })),
  };
}

async function main() {
  const tasks = loadTasks();
  console.log('4-task Gate: 准备运行', tasks.length, '个任务');
  const results = [];
  for (const task of tasks) {
    try {
      const r = await runOne(task);
      results.push(r);
      console.log(`- ${r.name}: ${r.final ? r.final.status : 'TIMEOUT'}`);
    } catch (e) {
      console.error(`- ${task.name}: 运行异常 ${e.message}`);
      results.push({ taskId: null, name: task.name, final: null });
    }
  }

  const valid = results.filter((r) => r.taskId);
  const m = computeMetrics(valid);

  console.log('\n===== 4-TASK GATE REPORT =====');
  console.log(JSON.stringify(m, null, 2));
  console.log('\n判定提示（由人判断，脚本不自动放行 100-task）：');
  console.log(`  Assignment to constant variable = ${m.constViolation} (目标 0)`);
  console.log(`  Credential NO_VALUE            = ${m.noValueCount} (目标 0)`);
  console.log(`  Orphan Attempt                 = ${m.orphanCount} (目标 0)`);
  console.log(`  Fresh Observation after Action = ${m.freshAfter}/${m.actionObs} (${m.freshPct}%, 目标 100%)`);
  console.log(`  Verification Window re-obs     = ${m.windowEventCount} 次 (目标 >0 真实发生)`);
  console.log(`  Business Outcome SUCCESS       = ${m.successCount}/${m.totalTasks} (目标 >=2/4)`);
  console.log('\n把上面这段贴回给审核人，由其判断是否值得解除冻结跑 100-task。');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
