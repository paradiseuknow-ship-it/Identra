#!/usr/bin/env node
// C69 —— runtime ghost runStep 守护（agent 子模块深扫第 2 批，runtime.js 55KB 深扫）：
//   D1 (B 类竞态)：run() 的 STEP_TIMEOUT 用 Promise.race 只放弃等待、不取消底层协程 ——
//     tools.execute 可无限挂起（这正是超时机制存在的原因）。挂起恢复后，原 runStep 协程
//     （幽灵）会「迟到地」写终态：幽灵成功覆盖已失败/已修复的 step（假阳性 SUCCESS，骗过
//     B.4 收口守卫）、幽灵 escalate/pauseForHuman 误转任务终态。主循环顶部 live-status 检查
//     只防「重入已终态 step」，防不了幽灵对未终态 step 的迟到写。
//   修复：per-step token 注册表（后继执行覆盖 token）+ STEP_TIMEOUT 显式 invalidate +
//     幽灵所有 step 状态/任务终态写之前的 _inert() 守卫（幽灵只允许记自身 attempt 记录）。
// 零浏览器零网络；FPB_DATA_DIR tmp 隔离（jsonStore 路径模块加载时解析，需子进程 env 注入）；
// tools.execute 用同模块对象属性补丁模拟挂起/失败/成功，真实 store / 状态机全程参与。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + ': ' + detail); console.log('  FAIL ' + name + ' — ' + detail); }
}

function runInChild(fnName, script) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c69-data-'));
  const tmpJS = path.join(os.tmpdir(), 'c69-' + fnName + '-' + Date.now() + '.js');
  fs.writeFileSync(tmpJS, script, 'utf8');
  const r = spawnSync(process.execPath, [tmpJS], {
    env: Object.assign({}, process.env, { FPB_DATA_DIR: dataDir, AI_PROVIDER: 'mock' }),
    encoding: 'utf8',
    timeout: 60000,
  });
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpJS, { force: true }); } catch (e) {}
  return r;
}

const BASE = here.replace(/\\/g, '/') + '/../agent';

// ---- P1: 后继执行覆盖 token → 幽灵迟到成功必须失效（最强实证：假阳性 SUCCESS 不复存在）----
{
  const script = `
'use strict';
const runtime = require('${BASE}/runtime');
const stepManager = require('${BASE}/stepManager');
const tools = require('${BASE}/tools');
const out = { ok: true, error: null };
(async () => {
try {
  let mode = 'hang', release = null;
  tools.execute = async () => {
    if (mode === 'hang') return new Promise((res) => { release = res; });
    if (mode === 'fail') return { success: false, error: { code: 'X', message: 'x-fail' } };
    return { success: true, observation: { url: 'https://x/' } };
  };
  const task = { id: 'c69t1', currentExecutionId: 'exec-c69-1', profileId: 'p-c69', executionMode: 'NORMAL' };
  const step = stepManager.createStep(task.id, { description: 's', action: { type: 'click', risk: 'LOW', verification: { type: 'none' } } }, 0);

  // 执行 #1：tools 挂起（= STEP_TIMEOUT 场景中仍在跑的底层协程）
  const p1 = runtime.runStep(task, step, null);
  await new Promise((r) => setImmediate(r));
  if (!release) throw new Error('tools.execute 未被调用（harness 断）');

  // 执行 #2（模拟超时后主循环重试）：token 覆盖 → #1 成为幽灵；#2 真实失败
  mode = 'fail';
  const r2 = await runtime.runStep(task, step, null);
  if (r2.ok !== false) throw new Error('#2 应失败');
  if (stepManager.getStep(step.id).status === 'SUCCESS') throw new Error('#2 失败后 step 不应为 SUCCESS');

  // 释放幽灵且它「成功」：守卫必须拦下对 step 的迟到 SUCCESS 写
  mode = 'success';
  release({ success: true, observation: { url: 'https://x/' } });
  const r1 = await p1;
  if (r1.abandoned !== true) throw new Error('幽灵返回未标记 abandoned: ' + JSON.stringify(r1));
  if (stepManager.getStep(step.id).status === 'SUCCESS') throw new Error('幽灵迟到成功仍污染了 step 状态（守卫未生效）');
  const atts = stepManager.listAttempts(step.id);
  if (atts.length !== 2) throw new Error('应有 2 条 attempt，实得 ' + atts.length);
  if (atts.some((a) => a.status === 'SUCCESS')) throw new Error('幽灵不得把自身 attempt 记为 SUCCESS');
  const att2 = atts.find((a) => a.status === 'FAILED');
  if (!att2) throw new Error('#2 的 attempt 应为 FAILED');

  out.p1 = 'ghost success inert; step untainted; attempts ' + atts.map((a) => a.status).join('/');
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
})().then(() => console.log('CHILD_RESULT ' + JSON.stringify(out)));
`;
  const r = runInChild('p1', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P1.ghost-success-inert', j.ok && !!j.p1, j.error || j.p1 || 'child failed');
}

// ---- P2: 正常单次成功路径零变化（守卫不误伤）----
{
  const script = `
'use strict';
const runtime = require('${BASE}/runtime');
const stepManager = require('${BASE}/stepManager');
const tools = require('${BASE}/tools');
const out = { ok: true, error: null };
(async () => {
try {
  tools.execute = async () => ({ success: true, observation: { url: 'https://ok/' } });
  const task = { id: 'c69t2', currentExecutionId: 'exec-c69-2', profileId: 'p-c69', executionMode: 'NORMAL' };
  const step = stepManager.createStep(task.id, { description: 's2', action: { type: 'click', risk: 'LOW', verification: { type: 'none' } } }, 0);
  const r = await runtime.runStep(task, step, null);
  if (!r.ok) throw new Error('正常执行应成功: ' + JSON.stringify(r.error || r));
  if (r.abandoned) throw new Error('正常执行不得标记 abandoned');
  if (stepManager.getStep(step.id).status !== 'SUCCESS') throw new Error('step 应为 SUCCESS');
  const att = stepManager.listAttempts(step.id)[0];
  if (!att || att.status !== 'SUCCESS') throw new Error('attempt 应为 SUCCESS');
  out.p2 = 'normal success path unchanged';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
})().then(() => console.log('CHILD_RESULT ' + JSON.stringify(out)));
`;
  const r = runInChild('p2', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P2.normal-path-unchanged', j.ok && !!j.p2, j.error || j.p2 || 'child failed');
}

// ---- P3: invalidateStepRun（run() STEP_TIMEOUT 显式失效路径）→ 幽灵失效 ----
{
  const script = `
'use strict';
const runtime = require('${BASE}/runtime');
const stepManager = require('${BASE}/stepManager');
const tools = require('${BASE}/tools');
const out = { ok: true, error: null };
(async () => {
try {
  let release = null;
  tools.execute = async () => new Promise((res) => { release = res; });
  const task = { id: 'c69t3', currentExecutionId: 'exec-c69-3', profileId: 'p-c69', executionMode: 'NORMAL' };
  const step = stepManager.createStep(task.id, { description: 's3', action: { type: 'click', risk: 'LOW', verification: { type: 'none' } } }, 0);
  const p = runtime.runStep(task, step, null);
  await new Promise((r) => setImmediate(r));
  runtime.invalidateStepRun(step.id); // run() 的 STEP_TIMEOUT catch 所做的同一动作
  release({ success: true, observation: { url: 'https://x/' } });
  const r = await p;
  if (r.abandoned !== true) throw new Error('invalidate 后幽灵应标记 abandoned');
  if (stepManager.getStep(step.id).status === 'SUCCESS') throw new Error('invalidate 后幽灵不得写 SUCCESS');
  if (stepManager.listAttempts(step.id).some((a) => a.status === 'SUCCESS')) throw new Error('invalidate 后幽灵 attempt 不得 SUCCESS');
  out.p3 = 'invalidate path kills ghost';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
})().then(() => console.log('CHILD_RESULT ' + JSON.stringify(out)));
`;
  const r = runInChild('p3', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P3.invalidate-kills-ghost', j.ok && !!j.p3, j.error || j.p3 || 'child failed');
}

// ---- P4: 幽灵 escalate 分支失效 —— CREDENTIAL_UNAVAILABLE 迟到不得误转真实任务终态 ----
{
  const script = `
'use strict';
const runtime = require('${BASE}/runtime');
const taskManager = require('${BASE}/taskManager');
const stepManager = require('${BASE}/stepManager');
const tools = require('${BASE}/tools');
const out = { ok: true, error: null };
(async () => {
try {
  taskManager.setExecutor(null); // 不真跑 runtime
  let release = null;
  tools.execute = async () => new Promise((res) => { release = res; });
  const t = taskManager.createTask({ name: 'c69t4', objective: 'obj', profileId: 'p-c69' });
  const statusBefore = taskManager.getTask(t.id).status;
  const task = Object.assign({}, taskManager.getTask(t.id), { currentExecutionId: 'exec-c69-4' });
  const step = stepManager.createStep(t.id, { description: 's4', action: { type: 'click', risk: 'LOW', verification: { type: 'none' } } }, 0);
  const p = runtime.runStep(task, step, null);
  await new Promise((r) => setImmediate(r));
  runtime.invalidateStepRun(step.id); // 模拟 STEP_TIMEOUT 后的显式失效
  release({ success: false, error: { code: 'CREDENTIAL_UNAVAILABLE', error: { message: 'late ghost' } } });
  const r = await p;
  if (r.escalated !== false) throw new Error('幽灵不得触发 escalate，实得 escalated=' + r.escalated);
  if (r.abandoned !== true) throw new Error('应标记 abandoned');
  const now = taskManager.getTask(t.id).status;
  if (now !== statusBefore) throw new Error('幽灵迟到 escalate 污染任务终态: ' + statusBefore + ' -> ' + now);
  out.p4 = 'ghost escalate inert; task status ' + now;
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
})().then(() => console.log('CHILD_RESULT ' + JSON.stringify(out)));
`;
  const r = runInChild('p4', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P4.ghost-escalate-inert', j.ok && !!j.p4, j.error || j.p4 || 'child failed');
}

console.log('RESULT pass=' + pass + ' fail=' + fail);
if (fail) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
