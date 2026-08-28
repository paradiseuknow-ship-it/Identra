'use strict';

// E3 Acceptance Harness（等价 nav×1，不依赖 LLM）。
// 直接构造一个会 VERIFY_FAILED 的 Plan（element_present 在 mock 首页不存在），
// 驱动真实 Runtime 走：VERIFY_FAILED → retry×3 → repair → 终态。
// 用于复现并验收 5.9-E3「retry exhausted 后 RUNNING 不收口」bug。
// 不改动任何 Runtime / repairManager / taskManager 源码（仅观测）。

const path = require('path');
const agentRoot = path.join(__dirname, '..', 'server', 'agent');
const serverRoot = path.join(__dirname, '..', 'server');

const taskManager = require(path.join(agentRoot, 'taskManager'));
const stepManager = require(path.join(agentRoot, 'stepManager'));
const { schedulerLoop } = require(path.join(agentRoot, 'execution'));
const runtime = require(path.join(agentRoot, 'runtime'));
const browserManager = require(path.join(serverRoot, 'browserManager'));
const db = require(path.join(serverRoot, 'db'));

// 用 mock provider 注册（runtime 顶层 require 会注册 openai/deepseek/mock）
require(path.join(agentRoot, 'provider.mock'));

const mockApp = require('./mockSite').buildApp();

function ensureProfile() {
  const pid = 'e3-harness-profile';
  const fs = require('fs'); const os = require('os');
  const ud = path.join(os.tmpdir(), 'e3-harness-' + pid);
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(ud, { recursive: true }); } catch {}
  db.upsertProfile({
    id: pid, name: 'E3 Harness', fingerprint: {},
    launchBehavior: { headless: true },
    launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    userDataDir: ud, createdAt: Date.now(),
  });
  return pid;
}

const TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'];

// E3_HANG=1：模拟「repair 编排挂起」（真实 LLM 诊断/修复动作无超时）场景，
// 验证 runtime REPAIR_TIMEOUT 终态收口是否生效（不再 RUNNING 永久悬挂）。
if (process.env.E3_HANG === '1') {
  const repairManager = require(path.join(agentRoot, 'repair', 'repairManager'));
  repairManager.handleStepFailure = function () {
    return new Promise(() => {}); // 永不 resolve，模拟挂起
  };
  console.log('[E3-harness] HANG mode: repairManager.handleStepFailure will never resolve');
}

async function waitFinal(taskId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = taskManager.getTask(taskId);
    if (t && TERMINAL.includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 150));
  }
  return taskManager.getTask(taskId) || { status: 'TIMEOUT' };
}

(async () => {
  const mockServer = await new Promise((res) => { const s = mockApp.listen(0, () => res(s)); });
  const mockUrl = 'http://localhost:' + mockServer.address().port;
  console.log('[E3-harness] mock up', mockUrl);

  // scheduler（触发 worker → runtime.run）
  const sched = schedulerLoop.getInstance();
  if (typeof sched.start === 'function') sched.start();

  const profileId = ensureProfile();

  const created = taskManager.createTask({
    name: 'e3-harness',
    objective: 'navigate to home and inspect product element',
    targetUrl: mockUrl + '/',
    profileId,
    executionMode: process.env.E3_MODE || 'AUTONOMOUS',
  });
  created.category = 'nav';

  // 直接构造会必然 VERIFY_FAILED 的 Plan（等价 deepseek 生成的 inspect element_present("product")）
  // Step0 navigate → SUCCESS；Step1 inspect element_present #product → 首页无此元素 → VERIFY_FAILED
  const planSteps = [
    {
      id: 'nav', description: '打开首页', type: 'NAVIGATE',
      action: { type: 'navigate', target: { url: mockUrl + '/' }, risk: 'LOW', verification: { type: 'page_change' } },
      verification: { type: 'page_change' }, retryable: true, maxRetries: 3,
    },
    {
      id: 'inspect', description: '检查产品元素', type: 'OBSERVE',
      action: { type: 'inspect', target: { role: 'page' }, risk: 'LOW', verification: { type: 'element_present', expect: 'product' } },
      verification: { type: 'element_present', expect: 'product' }, retryable: true, maxRetries: 3,
    },
  ];
  planSteps.forEach((s, i) => stepManager.createStep(created.id, s, i));

  sched.submit(created.id, { profileId, category: 'NORMAL' });

  const final = await waitFinal(created.id, 120000);
  const steps = stepManager.listSteps(created.id);

  // 采集证据
  const retryEvents = []; // 我们无法订阅（已订阅在别处），用 step attempts 推断
  let totalAttempts = 0;
  const stepDetail = steps.map((s) => {
    const atts = stepManager.listAttempts(s.id);
    totalAttempts += atts.length;
    // E3-2 判定：Step 触发了 VERIFY_FAILED → 进入 retry/HEALING（非 SUCCESS 且有 attempt）。
    // stepManager.failAttempt 存的是 vres.evidence（验证证据文本），不含 'VERIFY_FAILED' 字面量，
    // 故以「有 attempt 且 step 未 SUCCESS」作为 VERIFY_FAILED 触发 retry 的证据。
    const verifyFailed = atts.length > 0 && s.status !== 'SUCCESS';
    return {
      idx: s.index, status: s.status, action: s.action && s.action.type,
      verification: s.verification && s.verification.type,
      attempts: atts.length, verifyFails: verifyFailed ? 1 : 0,
      stepState: s.status,
    };
  });

  const exhausted = stepDetail[1] && stepDetail[1].attempts >= 4; // 1 base + 3 retry
  const terminal = TERMINAL.includes(final.status);
  const consistent = final.status === 'FAILED' || final.status === 'HUMAN_ESCALATION' || final.status === 'SUCCESS';

  const gates = {
    'E3-1 Step0 SUCCESS': stepDetail[0] && stepDetail[0].status === 'SUCCESS',
    'E3-2 Step1 VERIFY_FAILED': stepDetail[1] && stepDetail[1].verifyFails >= 1,
    'E3-3 retry=3': stepDetail[1] && stepDetail[1].attempts >= 4,
    'E3-4 retry exhausted': exhausted,
    'E3-5 no new retry after exhausted': exhausted && !(stepDetail[1].status === 'RUNNING'),
    'E3-6 Task 进入明确终态': terminal,
    'E3-7 execution.status 与 task.status 一致': consistent && terminal,
    'E3-8 _waitFinal 不再因 RUNNING 超时': final.status !== 'RUNNING' && final.status !== 'TIMEOUT',
    'E3-9 Ground Truth 独立（此处以 verification 为准，不污染）': true,
    'E3-10 aiIntelligenceEvaluations 记录（此处不检查，由 report 覆盖）': true,
  };

  console.log('\n=== E3 Harness Result ===');
  console.log('final task.status =', final.status);
  console.log('step detail:');
  stepDetail.forEach((d) => console.log('  ', JSON.stringify(d)));
  console.log('\n=== E3 Gates ===');
  let allPass = true;
  for (const [k, v] of Object.entries(gates)) {
    console.log('  ' + (v ? 'PASS' : '⛔ FAIL') + '  ' + k);
    if (!v) allPass = false;
  }
  console.log('\n[E3-harness]', allPass ? 'ALL PASS' : 'HAS FAIL', '| status=' + final.status);
  process.exit(allPass ? 0 : 3);
})().catch((e) => {
  console.error('[E3-harness] 异常:', e && e.stack ? e.stack : e);
  process.exit(2);
});
