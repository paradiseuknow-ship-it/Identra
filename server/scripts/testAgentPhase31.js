'use strict';

// Phase 3.1 验收：Memory Infrastructure + Element Memory。
// 覆盖：memoryRecord 基座 / elementMemory 模式演化 / resolveSelector 记忆优先 + 成功强化 /
//       Case1 首次 semanticResolver→保存 / Case2 第二次 Proceed 命中零推理 / Case3 低置信度降级 / 浏览器端到端。
// 注意：集成部分启动浏览器，必须**停止 server 进程**后独立运行。
// 用法：node server/scripts/testAgentPhase31.js

const db = require('../db');
const taskManager = require('../agent/taskManager');
const browserManager = require('../browserManager');
const store = require('../agent/store');
const tools = require('../agent/tools');
require('../agent/runtime');

const testSite = require('./_testSite');
const memoryRecord = require('../agent/intelligence/memoryRecord');
const elementMemory = require('../agent/intelligence/elementMemory');
const siteMemory = require('../agent/intelligence/siteMemory');
const semanticResolver = require('../agent/semanticResolver');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStatus(taskId, targets, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = taskManager.getTask(taskId);
    if (t && targets.includes(t.status)) return t;
    await sleep(600);
  }
  return taskManager.getTask(taskId);
}

const PROFILE = 'p_phase31_' + Date.now().toString(36);
async function makeProfile() {
  db.upsertProfile({
    id: PROFILE, name: 'p31', group: 'default', tags: [], notes: '', seed: 'p31',
    headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { cacheClearMode: 'none' }, fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });
}

function clearSiteMemory(site) {
  store.write('aiElementMemory', store.read('aiElementMemory', []).filter((r) => r.site !== site));
  store.write('aiSiteMemory', store.read('aiSiteMemory', []).filter((r) => r.site !== site));
}

async function cleanup(ids) {
  try { browserManager.close(PROFILE).catch(() => {}); } catch (e) {}
  for (const id of ids) { try { taskManager.cancel(id); } catch (e) {} store.remove('aiTasks', id); }
  store.write('aiSteps', store.read('aiSteps', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiAttempts', store.read('aiAttempts', []).filter((a) => { const st = store.find('aiSteps', a.stepId); return st && !ids.includes(st.taskId); }));
  store.write('aiQueue', store.read('aiQueue', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiExecutions', store.read('aiExecutions', []).filter((e) => !ids.includes(e.taskId)));
  clearSiteMemory('localhost');
  db.deleteProfile(PROFILE);
  testSite.cleanup();
}

async function main() {
  console.log('== Phase 3.1 Memory Infrastructure + Element Memory 验收 ==');

  // ---- 1) memoryRecord 基座 ----
  console.log('[memory-record]');
  const mr = memoryRecord;
  let rec = mr.createBase({ prefix: 't', source: { type: 'human' } });
  ok(rec.status === 'ACTIVE' && rec.version === 1 && rec.confidence === 0 && rec.samples.success === 0 && rec.source.type === 'human', '统一字段: version/status/confidence/samples/source');
  mr.recordOutcome(rec, true);
  ok(rec.samples.success === 1 && rec.successRate === 1 && rec.confidence >= 0.8, '1 次成功 → 置信度 ≥0.8', String(rec.confidence));
  for (let i = 0; i < 5; i++) mr.recordOutcome(rec, false);
  ok(rec.status === 'DEPRECATED' && rec.confidence < 0.4, '长期失败自动 DEPRECATED（旧经验保留不消费）', String(rec.status));

  // ---- 2) siteMemory ----
  console.log('[site-memory]');
  clearSiteMemory('u4.test'); // 防上次运行残留
  siteMemory.recordTaskResult('u4.test', { ok: true, flowName: 'signup', avgSteps: 6 });
  siteMemory.recordTaskResult('u4.test', { ok: true, flowName: 'signup' });
  siteMemory.recordTaskResult('u4.test', { ok: false, failureType: 'ELEMENT_NOT_FOUND' });
  const s = siteMemory.getSite('u4.test');
  ok(s.history.successTasks === 2 && s.history.failedTasks === 1, '站点成功/失败统计');
  ok(s.commonFlows.signup.successRate === 1 && s.commonFlows.signup.samples === 2, '流程成功率聚合');
  ok(s.frequentFailures.includes('ELEMENT_NOT_FOUND'), '高频失败记录');

  // ---- 3) Element Memory：Case1/2/3（spy semanticResolver）----
  console.log('[element-memory]');
  clearSiteMemory('u1.test'); clearSiteMemory('u3.test');
  let spyCount = 0;
  const origResolve = semanticResolver.resolve;
  semanticResolver.resolve = function (...a) { spyCount++; return origResolve.apply(this, a); };

  const act = { type: 'click', target: { semantic: 'submit' } };
  const obs1 = { url: 'http://u1.test/form', elements: [{ id: 'b1', role: 'button', tag: 'button', text: 'Continue', visible: true }] };

  // Case1：记忆为空 → semanticResolver → 成功后保存
  const r1 = await tools.resolveSelector(act, obs1);
  ok(r1 && r1.selector && r1.fromMemory === false, 'Case1 首次走 semanticResolver', r1 && JSON.stringify(r1));
  ok(spyCount === 1, 'Case1 调用 semanticResolver 一次', String(spyCount));
  elementMemory.recordSuccess('u1.test', 'submit', r1.pattern, { type: 'ai_success' });
  ok(elementMemory.getRecord('u1.test', 'submit').patterns.length === 1, 'Case1 成功后保存 pattern');

  // Case2：按钮变成 Proceed → 记忆(Continue)不匹配 → semanticResolver → 新 pattern 演化
  const obs2 = { url: 'http://u1.test/form', elements: [{ id: 'b1', role: 'button', tag: 'button', text: 'Proceed', visible: true }] };
  const r2 = await tools.resolveSelector(act, obs2);
  ok(r2 && r2.selector && r2.fromMemory === false, 'Case2 Proceed 未命中记忆 → semanticResolver');
  elementMemory.recordSuccess('u1.test', 'submit', r2.pattern, { type: 'ai_success' });
  const rec2 = elementMemory.getRecord('u1.test', 'submit');
  ok(rec2.version === 2 && rec2.patterns.length === 2, 'Case2 pattern 演化（version 2，Continue 旧经验保留）', 'version=' + rec2.version);

  // Case2-hit：再次 Proceed → 命中记忆，不调用 semanticResolver（零推理）
  spyCount = 0;
  const r3 = await tools.resolveSelector(act, obs2);
  ok(r3 && r3.selector && r3.fromMemory === true, 'Case2 命中 Memory');
  ok(spyCount === 0, '命中 Memory 不调用 semanticResolver', String(spyCount));

  // Case3：低置信度记忆 → 自动降级 semanticResolver
  elementMemory.recordSuccess('u3.test', 'submit', { text: 'Continue', role: 'button' }, { type: 'ai_success' });
  for (let i = 0; i < 5; i++) elementMemory.recordFailure('u3.test', 'submit');
  const raw3 = elementMemory.listAll().find((x) => x.site === 'u3.test' && x.semantic === 'submit');
  ok(raw3 && raw3.confidence < 0.8 && (raw3.status === 'DEPRECATED' || raw3.status === 'ACTIVE'), 'Case3 低置信度', raw3 ? String(raw3.confidence) + '/' + raw3.status : '无记录');
  spyCount = 0;
  const obs3 = { url: 'http://u3.test/form', elements: [{ id: 'b1', role: 'button', tag: 'button', text: 'Continue', visible: true }] };
  const r4 = await tools.resolveSelector(act, obs3);
  ok(r4 && r4.fromMemory === false && spyCount >= 1, 'Case3 低置信度自动降级 semanticResolver', 'fromMemory=' + (r4 && r4.fromMemory));

  semanticResolver.resolve = origResolve;

  // ---- 4) 端到端：/evolve 三次执行，第三次命中记忆零推理 ----
  console.log('[integration] /evolve Continue→Proceed 三次执行');
  await testSite.ensure();
  await makeProfile();
  clearSiteMemory('localhost');
  semanticResolver.resolve = function (...a) { spyCount++; return origResolve.apply(this, a); };

  const runEvolve = async (name) => {
    const t = taskManager.createTask({ name, objective: 'x', targetUrl: 'http://localhost:9555/evolve', profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' } });
    taskManager.attachPlan(t.id, {
      goal: name, steps: [
        { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: { type: 'navigate', target: { url: 'http://localhost:9555/evolve' }, risk: 'LOW', verification: { type: 'page_change' } } },
        { id: 'click', type: 'ACT', description: '点击 continue', expectedOutcome: 'o', risk: 'MEDIUM', action: { type: 'click', target: { semantic: 'submit' }, risk: 'MEDIUM', verification: { type: 'page_change' } } },
      ],
    });
    taskManager.start(t.id);
    const r = await waitStatus(t.id, ['SUCCESS', 'FAILED', 'PAUSED_FOR_HUMAN'], 90000);
    return { t, r };
  };

  const a = await runEvolve('p31 a');
  ok(a.r.status === 'SUCCESS', 'Task1 成功（Continue，走语义解析）', a.r.error || '');
  ok(elementMemory.getRecord('localhost', 'submit').patterns.length === 1, 'Task1 保存 Continue pattern');

  const b = await runEvolve('p31 b');
  ok(b.r.status === 'SUCCESS', 'Task2 成功（Proceed，走语义解析）', b.r.error || '');
  const recB = elementMemory.getRecord('localhost', 'submit');
  ok(recB.patterns.length === 2 && recB.version >= 2, 'Task2 积累 Proceed pattern（Continue 保留）');

  spyCount = 0;
  const c = await runEvolve('p31 c');
  ok(c.r.status === 'SUCCESS', 'Task3 成功（Proceed）', c.r.error || '');
  ok(spyCount === 0, 'Task3 命中 Memory，零 semanticResolver 调用', String(spyCount));
  ok(elementMemory.getRecord('localhost', 'submit').samples.success >= 3, 'Task3 强化成功计数');

  semanticResolver.resolve = origResolve;

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup([a.t.id, b.t.id, c.t.id]);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); semanticResolver.resolve = semanticResolver.resolve; try { testSite.cleanup(); } catch (x) {} process.exit(1); });
