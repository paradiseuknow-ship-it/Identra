'use strict';

// Phase 2.2 验收：AI Diagnosis Layer。
// 覆盖：diagnosisSchema / fallbackDiagnosis 4 Case / FailureSnapshot / runtime 集成（真实失败产生诊断）。
// 注意：集成部分启动浏览器，必须**停止 server 进程**后独立运行。
// 用法：node server/scripts/testAgentPhase22.js

const db = require('../db');
const taskManager = require('../agent/taskManager');
const browserManager = require('../browserManager');
const store = require('../agent/store');
require('../agent/runtime'); // executor + diagnosis 集成
const testSite = require('./_testSite'); // 带版本探针的 test-site 助手

const diagnosisSchema = require('../agent/diagnosis/diagnosisSchema');
const diagnosisEngine = require('../agent/diagnosis/diagnosisEngine');
const failureSnapshot = require('../agent/recovery/failureSnapshot');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureTestSite = () => testSite.ensure();
async function waitStatus(taskId, targets, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = taskManager.getTask(taskId);
    if (t && targets.includes(t.status)) return t;
    await sleep(600);
  }
  return taskManager.getTask(taskId);
}

function hasFourLayers(d) {
  return d && Array.isArray(d.facts) && Array.isArray(d.evidence) && typeof d.inference === 'string' && typeof d.recommendation === 'string';
}

const PROFILE = 'p_phase22_' + Date.now().toString(36);
async function makeProfile() {
  db.upsertProfile({
    id: PROFILE, name: 'p22', group: 'default', tags: [], notes: '', seed: 'p22',
    headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { cacheClearMode: 'none' }, fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });
}
async function cleanup(ids) {
  try { browserManager.close(PROFILE).catch(() => {}); } catch (e) {}
  for (const id of ids) { try { taskManager.cancel(id); } catch (e) {} store.remove('aiTasks', id); }
  store.write('aiSteps', store.read('aiSteps', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiAttempts', store.read('aiAttempts', []).filter((a) => { const st = store.find('aiSteps', a.stepId); return st && !ids.includes(st.taskId); }));
  store.write('aiQueue', store.read('aiQueue', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiFailureSnapshots', store.read('aiFailureSnapshots', []).filter((x) => !ids.includes(x.taskId)));
  db.deleteProfile(PROFILE);
  testSite.cleanup();
}

async function main() {
  console.log('== Phase 2.2 AI Diagnosis 验收 ==');

  // ---- 1) diagnosisSchema ----
  console.log('[diagnosis-schema]');
  ok(diagnosisSchema.validate({ category: 'ELEMENT_CHANGED', confidence: 0.91, facts: ['a'], evidence: ['b'], inference: 'i', recommendation: 'r' }).ok, '合法诊断通过');
  ok(!diagnosisSchema.validate({ category: 'X', confidence: 2, facts: ['a'], evidence: [], inference: 'i', recommendation: 'r' }).ok, '非法 category/confidence 被拒');
  ok(!diagnosisSchema.validate({ category: 'ELEMENT_CHANGED', confidence: 0.9, facts: 'not-array', evidence: [], inference: '', recommendation: '' }).ok, 'facts 非数组/inference 缺失被拒');

  // ---- 2) fallbackDiagnosis 4 Case ----
  console.log('[fallback]');
  const fb = diagnosisEngine.fallbackDiagnosis;
  const step = { action: { type: 'click', target: { semantic: 'Continue' } } };

  // Case 1: 按钮变化 Continue→Proceed
  let d = fb({ classifier: { type: 'ELEMENT_NOT_FOUND', confidence: 0.85, evidence: [] }, failure: { url: 'http://x' }, observation: { textSummary: 'Login Proceed Signup' }, step });
  ok(d.category === 'ELEMENT_CHANGED' && hasFourLayers(d), 'Case1 按钮变化 → ELEMENT_CHANGED + 四层', JSON.stringify(d));

  // Case 2: 403
  d = fb({ classifier: { type: 'NAVIGATION_FAILED', confidence: 0.8, evidence: [] }, failure: { url: 'http://x' }, observation: { textSummary: '403 Forbidden Access denied' }, step });
  ok(d.category === 'HTTP_FORBIDDEN' && hasFourLayers(d), 'Case2 403 → HTTP_FORBIDDEN + 四层', JSON.stringify(d));

  // Case 3: 登录失效
  d = fb({ classifier: { type: 'UNKNOWN', confidence: 0.6, evidence: [] }, failure: { url: 'http://x' }, observation: { textSummary: 'Please login again to continue' }, step });
  ok(d.category === 'SESSION_EXPIRED' && hasFourLayers(d), 'Case3 登录失效 → SESSION_EXPIRED + 四层', JSON.stringify(d));

  // Case 4: 弹窗
  d = fb({ classifier: { type: 'ELEMENT_NOT_INTERACTABLE', confidence: 0.8, evidence: [] }, failure: { url: 'http://x' }, observation: { textSummary: 'Accept Cookies Reject All' }, step });
  ok(d.category === 'OBSTRUCTION' && hasFourLayers(d), 'Case4 弹窗 → OBSTRUCTION + 四层', JSON.stringify(d));

  // 无证据禁止断言"被封"
  ok(!JSON.stringify(d).includes('被封') && !JSON.stringify(d).toLowerCase().includes('ip 被封'), '诊断不含无证据的"被封"断言');

  // ---- 3) FailureSnapshot ----
  console.log('[failure-snapshot]');
  const snap = await failureSnapshot.create({ taskId: 'task_demo', stepId: 's1', url: 'http://x', errorType: 'ELEMENT_NOT_FOUND', confidence: 0.9, lastAction: { type: 'click', target: { semantic: 'Continue' } }, observation: { textSummary: ['Login', 'Proceed'] } });
  ok(!!snap.id && snap.errorType === 'ELEMENT_NOT_FOUND' && Array.isArray(snap.visibleTexts), 'FailureSnapshot 结构化落库');
  ok(failureSnapshot.latestForTask('task_demo').id === snap.id, 'latestForTask 可取回');

  // ---- 4) 集成：真实失败 → 诊断（Phase 2.3 后修复耗尽 → PAUSED_FOR_HUMAN）----
  console.log('[integration] /empty 点击不存在元素 → 修复耗尽 → 诊断 + 人工');
  await ensureTestSite();
  await makeProfile();
  const t1 = taskManager.createTask({ name: 'p22', objective: 'x', targetUrl: 'http://localhost:9555/empty', profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' } });
  taskManager.attachPlan(t1.id, {
    goal: 'diag', steps: [
      { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: { type: 'navigate', target: { url: 'http://localhost:9555/empty' }, risk: 'LOW', verification: { type: 'page_change' } } },
      { id: 'click', type: 'ACT', description: '点击 xyzzy', expectedOutcome: 'o', risk: 'MEDIUM', action: { type: 'click', target: { semantic: 'xyzzy' }, risk: 'MEDIUM', verification: { type: 'none' } }, maxRetries: 2 },
    ],
  });
  taskManager.start(t1.id);
  const r1 = await waitStatus(t1.id, ['SUCCESS', 'FAILED', 'PAUSED_FOR_HUMAN'], 90000);
  ok(r1.status === 'PAUSED_FOR_HUMAN', '修复耗尽后进入人工审批（非无限循环）', r1.error || '');
  const final = taskManager.getTask(t1.id);
  ok(!!final.lastDiagnosis && hasFourLayers(final.lastDiagnosis), '失败后生成结构化诊断（四层）', JSON.stringify(final.lastDiagnosis || {}).slice(0, 200));
  const diagResp = (() => { const fs = require('../agent/recovery/failureSnapshot'); return fs.listForTask(t1.id); })();
  ok(diagResp.length >= 1, '产生 FailureSnapshot 记录', String(diagResp.length));

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup([t1.id]);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); testSite.cleanup(); process.exit(1); });
