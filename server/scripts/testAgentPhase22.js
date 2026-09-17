'use strict';

// Phase 2.2 验收：AI Diagnosis Layer。
// 覆盖：diagnosisSchema / fallbackDiagnosis 4 Case / FailureSnapshot / runtime 集成（真实失败产生诊断）。
// 注意：集成部分启动浏览器，必须**停止 server 进程**后独立运行。
// 用法：node server/scripts/testAgentPhase22.js

// ★ C135 数据根隔离：本套件此前直接读写真实 server/data
//   （回归扫描面缺口使「已隔离」这一入集前提从未被施加）。必须在 require 任何业务模块
//   **之前**设置 —— 否则 store 单例已按真实根建好。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c135_p22_' + Date.now());

const db = require('../db');
const taskManager = require('../agent/taskManager');
const browserManager = require('../browserManager');
const store = require('../agent/store');
require('../agent/runtime'); // executor + diagnosis 集成
const testSite = require('./_testSite'); // 带版本探针的 test-site 助手

const diagnosisSchema = require('../agent/diagnosis/diagnosisSchema');
const diagnosisEngine = require('../agent/diagnosis/diagnosisEngine');
const failureSnapshot = require('../agent/recovery/failureSnapshot');
// C140：等待「终态」必须用生产的**真终态集合**（唯一事实源），不得手写字面清单 —— 旧清单混入非终态
// `PAUSED_FOR_HUMAN`（不在 TASK_TERMINAL 内，是被 replan 带回去继续执行的中间态）⇒ waitStatus 会提前
// 返回，断言随之变成「中间态是否恰好可观测」的竞态依赖。同族实证见 testAgentPhase23.js §7 注释。
const { TASK_TERMINAL } = require('../agent/taskStateManager');

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
  // ★ C127：此 fixture 此前是 `observation: { textSummary: ['Login', 'Proceed'] }` —— **数组**。
  // 生产观测（observation.js:486/493）的 textSummary 是**字符串**、页面文本另有 visibleText；
  // 这个不存在的形状让 failureSnapshot.js 为一个**永不可达**的 `Array.isArray(textSummary)` 分支
  // 写了代码（且拉高了对「可见文本」的信任）。现对齐生产形状，并把断言从「是数组」加强为
  // 「确实是页面文本行」——守护必须测生产真实存在的形态。
  const snap = await failureSnapshot.create({ taskId: 'task_demo', stepId: 's1', url: 'http://x', errorType: 'ELEMENT_NOT_FOUND', confidence: 0.9, lastAction: { type: 'click', target: { semantic: 'Continue' } }, observation: { textSummary: 'Login', visibleText: 'Login\nProceed' } });
  ok(!!snap.id && snap.errorType === 'ELEMENT_NOT_FOUND' && Array.isArray(snap.visibleTexts) && snap.visibleTexts.join(' ').includes('Proceed'), 'FailureSnapshot 结构化落库（可见文本行取自真实字段）');
  ok(failureSnapshot.latestForTask('task_demo').id === snap.id, 'latestForTask 可取回');

  // ---- 4) 集成：真实失败 → 诊断（Phase 2.3 后修复耗尽 → HUMAN_ESCALATION）----
  console.log('[integration] /empty 点击不存在元素 → 修复耗尽 → 诊断 + 人工');
  await ensureTestSite();
  await makeProfile();
  // C140：**显式关闭 replan**（maxReplans=0）—— 否则「修复耗尽」的归宿取决于 replan 能否收敛
  // （LLM 可用性）：探针实测放开 replan 时 /empty 会被重规划收敛为 SUCCESS，断言随之漂移。
  const t1 = taskManager.createTask({ name: 'p22', objective: 'x', targetUrl: 'http://localhost:9555/empty', profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH', maxReplans: 0 } });
  taskManager.attachPlan(t1.id, {
    goal: 'diag', steps: [
      { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: { type: 'navigate', target: { url: 'http://localhost:9555/empty' }, risk: 'LOW', verification: { type: 'page_change' } } },
      // C140 同源缺陷修复：原为 `verification: { type: 'none' }` —— `click` 在 schema/action.js 的
      // MUST_VERIFY 名单内，tools.execute 第 171-172 行对每个动作再校验一次 ⇒ 本动作恒被判
      // ACTION_INVALID，**根本没点出去**。断言不依赖点击成功（只判终态/诊断），故该缺陷长期隐身，
      // 但用例自称的「点击不存在元素 → ELEMENT_NOT_FOUND → 诊断」从未被真正执行。
      // 改为 page_change（点击的真实效果，也是 §7/Phase5 同款）；真实成功门仍是 executor 的 step.verification。
      { id: 'click', type: 'ACT', description: '点击 xyzzy', expectedOutcome: 'o', risk: 'MEDIUM', action: { type: 'click', target: { semantic: 'xyzzy' }, risk: 'MEDIUM', verification: { type: 'page_change' } }, maxRetries: 2 },
    ],
  });
  taskManager.start(t1.id);
  // C140：等待目标 = 生产真终态集合（唯一事实源）；断言锚**具体终态 + 根因文案**，不接受中间态。
  const r1 = await waitStatus(t1.id, TASK_TERMINAL, 120000);
  ok(r1.status === 'HUMAN_ESCALATION' && /需人工处理/.test(String(r1.error || '')),
    '修复耗尽后离开重试循环并交人工（非无限循环，带根因）', r1.status + ' ' + (r1.error || ''));
  const final = taskManager.getTask(t1.id);
  ok(!!final.lastDiagnosis && hasFourLayers(final.lastDiagnosis), '失败后生成结构化诊断（四层）', JSON.stringify(final.lastDiagnosis || {}).slice(0, 200));
  const diagResp = (() => { const fs = require('../agent/recovery/failureSnapshot'); return fs.listForTask(t1.id); })();
  ok(diagResp.length >= 1, '产生 FailureSnapshot 记录', String(diagResp.length));

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup([t1.id]);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); testSite.cleanup(); process.exit(1); });
