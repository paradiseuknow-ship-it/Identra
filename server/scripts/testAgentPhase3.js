'use strict';

// Phase 1.3 验收：LLM Provider / Parser / Planner / Plan Schema / ContextBuilder / Memory。
// 覆盖：
//   1. 自然语言 → Parser 解析（heuristic 确定性）
//   2. AI 生成 Plan（mock provider → planner → validatePlan 通过）
//   3. Runtime 执行 Plan → /form SUCCESS（全链路）
//   4. 非法 Plan 被拒绝
//   5. 非法 Action 被拒绝
//   6. LLM timeout 可恢复（flaky provider 首次失败重试成功）
//   7. ContextBuilder 脱敏 + Memory 建议
// 用法：node server/scripts/testAgentPhase3.js

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const db = require('../db');
const vault = require('../vault');
const taskManager = require('../agent/taskManager');
const secretManager = require('../agent/secretManager');
const browserManager = require('../browserManager');
const store = require('../agent/store');
require('../agent/runtime'); // 注册 executor + 加载 mock/openai/deepseek providers

const llm = require('../agent/llm/provider');
const parser = require('../agent/parser');
const planner = require('../agent/planner');
const { validatePlan } = require('../agent/schema/plan');
const { validateAction } = require('../agent/schema/action');
const contextBuilder = require('../agent/contextBuilder');
const memory = require('../agent/memory');
const budget = require('../agent/budget');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

let testSiteProc = null;
async function ensureTestSite() {
  if (await portOpen(9555)) return;
  testSiteProc = spawn(process.execPath, [path.join(__dirname, '..', 'test-site', 'server.js')], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) { if (await portOpen(9555)) return; await sleep(300); }
  throw new Error('test-site 启动失败');
}

async function waitForStatus(taskId, targets, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = taskManager.getTask(taskId);
    if (t && targets.includes(t.status)) return t;
    await sleep(500);
  }
  return taskManager.getTask(taskId);
}

const TEST_PROFILE = 'p_phase3_' + Date.now().toString(36);

async function main() {
  console.log('== Phase 1.3 LLM / Parser / Planner 验收 ==');

  // ---- 1) Parser 自然语言 ----
  console.log('[parser]');
  const parsed = parser.heuristicParse('帮我打开 https://example.com 注册一个账号，使用 cred_001，不要使用我的真实邮箱');
  ok(parsed.target === 'https://example.com', '解析出 target URL', parsed.target);
  ok(parsed.credentialRefs.includes('cred_001'), '解析出 credentialRef', parsed.credentialRefs.join(','));
  ok(parsed.constraints.length >= 1, '解析出约束', JSON.stringify(parsed.constraints));
  ok(parsed.objective.length > 0, '解析出 objective', parsed.objective);

  // ---- 2) Planner 生成 Plan（mock provider → validatePlan 通过）----
  console.log('[planner]');
  const prov = llm.createProvider('mock');
  const pr = await planner.planObjective({
    objective: '注册并验证', target: 'http://localhost:9555/form',
    credentialRefs: ['cred_test'], executionMode: 'AUTONOMOUS', provider: prov, ctx: {},
  });
  ok(pr.ok === true, 'Planner 生成 Plan 成功', pr.error || '');
  ok(pr.ok && pr.plan.steps.length >= 6, 'Plan 步骤数 >= 6', pr.ok ? String(pr.plan.steps.length) : '');
  ok(pr.ok && pr.plan.steps.every((s) => s.action), '每个步骤都带 Action');

  // ---- 3) 非法 Plan 被拒绝 ----
  console.log('[plan-schema]');
  ok(!validatePlan({ goal: '', steps: [] }).ok, '空 goal/空 steps 被拒');
  ok(!validatePlan({ goal: 'x', steps: [{ id: 's', type: 'BAD', description: 'd', risk: 'UNKNOWN' }] }).ok, '非法 type/risk 被拒');
  ok(!validatePlan({ goal: 'x', steps: [{ id: 's', type: 'ACT', description: 'd', risk: 'LOW', action: { type: 'goto' } }] }).ok, '非法 action 被拒');

  // ---- 4) 非法 Action 被拒绝 ----
  console.log('[action-schema]');
  ok(!validateAction({ type: 'click', target: {} }).ok, '缺 target 被拒');
  ok(!validateAction({ type: 'fill', target: { field: 'password' }, value: 'x' }).ok, '敏感字段 value 被拒');
  ok(validateAction({ type: 'click', target: { semantic: 'x' }, risk: 'LOW', verification: { type: 'page_change' } }).ok, '合法 click 通过');

  // ---- 5) LLM timeout 可恢复（flaky provider 首次失败→重试成功）----
  console.log('[llm-retry]');
  llm.register('flaky', () => {
    let calls = 0;
    return {
      name: 'flaky', model: 'flaky',
      async chat(messages, opts) {
        calls++;
        if (calls === 1) { const e = new Error('LLM timeout'); e.code = 'TIMEOUT'; throw e; }
        return { content: '{"ok":true}', usage: { total_tokens: 10 } };
      },
    };
  });
  const flaky = llm.createProvider('flaky');
  const sSchema = {
    instructions: '输出 {"ok":true}',
    validate: (o) => (o && o.ok === true) ? { ok: true, plan: o } : { ok: false, errors: ['not ok'] },
  };
  budget.createBudget('t_flaky', { maxLLMCalls: 10, maxTokens: 1000, maxCost: 1 });
  const sres = await flaky.structured({ taskId: 't_flaky', executionId: null }, { system: 's', prompt: 'p', schema: sSchema, maxRetries: 2 });
  ok(sres && sres.ok === true, 'LLM 首次 timeout 后重试成功');

  // ---- 6) ContextBuilder 脱敏 ----
  console.log('[context]');
  const ctx = contextBuilder.build({
    task: { id: 't1', objective: 'x', targetUrl: 'http://a.com', executionMode: 'AUTONOMOUS', status: 'RUNNING' },
    observation: {
      url: 'http://a.com', title: 'T', textSummary: 'Password: hunter2 token=abc card 1234 5678 9012 3456',
      elements: [{ role: 'input', tag: 'input', type: 'password', text: 'pw' }], errors: [],
    },
    execution: { actions: [{ tool: 'fill', status: 'SUCCESS', actionSummary: { type: 'fill', target: { field: 'password' } }, error: null }] },
    budgetCfg: { taskId: 't1' },
  });
  const ctxStr = JSON.stringify(ctx);
  ok(!/hunter2|1234 5678 9012|token=abc/.test(ctxStr), 'Context 无明文密码/卡号/token', ctxStr.slice(0, 160));

  // ---- 7) Memory 建议 ----
  console.log('[memory]');
  memory.record({ site: 'http://localhost:9555', error: 'ELEMENT_NOT_FOUND', strategy: 'wait_then_resolve', success: true });
  memory.record({ site: 'http://localhost:9555', error: 'ELEMENT_NOT_FOUND', strategy: 'wait_then_resolve', success: true });
  memory.record({ site: 'http://localhost:9555', error: 'ELEMENT_NOT_FOUND', strategy: 'retry', success: false });
  const sug = memory.suggest('http://localhost:9555', 'ELEMENT_NOT_FOUND');
  ok(!!sug && sug.strategy === 'wait_then_resolve' && sug.successRate === 1, 'Memory 推荐成功率最高策略', JSON.stringify(sug));

  // ---- 8) Runtime 执行 Plan → /form SUCCESS ----
  console.log('[integration] /form → SUCCESS');
  await ensureTestSite();
  db.upsertProfile({
    id: TEST_PROFILE, name: 'phase3', group: 'default', tags: [], notes: '', seed: 'phase3',
    headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { cacheClearMode: 'none' }, fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });
  vault.setProfileSecrets(TEST_PROFILE, { email: 'phase3@test.local', password: 'Phase3#Secret' });
  const ref = secretManager.createSecret({ profileId: TEST_PROFILE, type: 'email_password', site: 'test.local', label: 'p3' }).id;
  const task = taskManager.createTask({
    name: 'phase3 integration', objective: '打开表单并完成注册', targetUrl: 'http://localhost:9555/form',
    profileId: TEST_PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' }, secretRefs: [ref],
  });
  taskManager.start(task.id);
  const r = await waitForStatus(task.id, ['SUCCESS', 'FAILED'], 90000);
  ok(r.status === 'SUCCESS', 'Runtime 执行 Plan 完成 /form', r.error || '');

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup();
  process.exit(fail ? 1 : 0);
}

async function cleanup() {
  try { browserManager.close(TEST_PROFILE).catch(() => {}); } catch (e) {}
  const ids = taskManager.listTasks().filter((x) => x.name && x.name.startsWith('phase3')).map((x) => x.id);
  for (const id of ids) { try { taskManager.cancel(id); } catch (e) {} store.remove('aiTasks', id); }
  store.write('aiSteps', store.read('aiSteps', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiAttempts', store.read('aiAttempts', []).filter((a) => { const st = store.find('aiSteps', a.stepId); return st && !ids.includes(st.taskId); }));
  store.write('aiQueue', store.read('aiQueue', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiCredentials', store.read('aiCredentials', []).filter((x) => x.profileId !== TEST_PROFILE));
  store.write('aiKnowledge', store.read('aiKnowledge', []).filter((x) => !x.site || x.site.indexOf('9555') === -1));
  vault.deleteProfileSecrets(TEST_PROFILE);
  db.deleteProfile(TEST_PROFILE);
  if (testSiteProc) { try { testSiteProc.kill(); } catch (e) {} }
}

main().catch((e) => { console.error('测试异常:', e); cleanup(); process.exit(1); });
