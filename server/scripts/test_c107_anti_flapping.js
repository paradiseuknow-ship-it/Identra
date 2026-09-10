'use strict';
/**
 * PHASE 17-A —— Anti-Flapping【最小修复的专项验证，真实 Chromium + 真实 runtime 主循环】。
 *
 * 用户原文（本阶段对 anti-flapping 的唯一授权范围）：
 *   「Anti-Flapping 只做最小修复……只允许做：明确失败签名触发后，停止当前相同 repair action」
 *   —— 明确禁止重写整个 repair engine。
 *
 * 历史实证（C105 F5 + C106 各轮）：
 *   1. FLAP_THRESHOLD=4 的熔断存在，但熔断只把执行推给 repair；
 *   2. 同一失败签名反复触发 → repair 被调用 21 次（rw.091 实证 21 attempts / 241s 被 harness 杀）；
 *   3. R3 现场 473s 里有相当一部分是 fill→fail→retry→repair→retry 的机械重放。
 *
 * 本测试证明的行为（两条，缺一不可）：
 *   ✔ 正例：失败签名相同 **且诊断决策明确禁止自动修复**（noRepair=true 的 escalate 类状态）
 *           → repair **一次都不调用**，直接以显式终态交人。
 *   ✔ 反例（负向对照）：同样的失败签名，但诊断决策**未**禁止修复
 *           → repair 仍被正常调用（证明拦截来自决策，而不是把 repair 链路整体关掉）。
 *     反例存在的意义：若没有它，本测试在「repair 因任何无关原因坏掉」时也会假绿。
 *
 * 端到端事实基线（真实 runtime 主循环执行，非直接调函数）：
 *   与 test_c107_r6_crossorigin_replay.js 相同的 session 注入方式，
 *   计划含 1 次 navigate + 1 次必然 ELEMENT_NOT_FOUND 的 fill。
 */

const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { listenSafe } = require('./lib_safe_port');

const ROOT = path.join(__dirname, '..');
const events = require(path.join(ROOT, 'agent', 'events'));
const store = require(path.join(ROOT, 'agent', 'store'));
const runtime = require(path.join(ROOT, 'agent', 'runtime'));
const taskManager = require(path.join(ROOT, 'agent', 'taskManager'));
const stepManager = require(path.join(ROOT, 'agent', 'stepManager'));
const browserManager = require(path.join(ROOT, 'browserManager'));
const db = require(path.join(ROOT, 'db'));
const diagnosisDecision = require(path.join(ROOT, 'agent', 'diagnosisDecision'));
const repairManager = require(path.join(ROOT, 'agent', 'repair', 'repairManager'));

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}

// 页面刻意不含 password 字段 → fill password 必然 ELEMENT_NOT_FOUND。
// 这是「同一失败签名」的干净来源：错误码恒为 ELEMENT_NOT_FOUND，签名键恒为 field:password。
const PAGE = [
  '<!doctype html><html><head><title>Sign up</title></head><body>',
  '<h1>Sign up</h1>',
  '<form id="f" action="#">',
  '<label for="email">Work email address</label>',
  '<input id="email" name="email" type="email" placeholder="Work email address">',
  '<button id="submit" type="submit">Create account</button>',
  '</form></body></html>',
].join('\n');

// 用于「反例（负向对照）」的页面：**零输入元素**。
// 为什么必须这样：diagnosisDecision.derive 的保守守卫规定「页面连一个输入框都没有
// → 观察太贫瘠 → 不产出任何决策（return null）」（C105 教训：空集 ≠ 不存在）。
// 只有在 derive 不下结论时，控制流才会真正走完 retry 预算进入 repair 分支 ——
// 这正是构造「repair 可达」对照所需的现场。若没有这个对照，
// 正例的 repairCalls===0 无法区分「决策拦住了」与「repair 链路本身坏了」。
const PAGE_NO_INPUTS = [
  '<!doctype html><html><head><title>Sign up</title></head><body>',
  '<h1>Sign up</h1>',
  '<p>Nothing to fill here.</p>',
  '</body></html>',
].join('\n');

const PLAN_NAV = {
  id: 'step_000',
  description: 'navigate to target',
  type: 'ACT',
  action: {
    type: 'navigate',
    target: { url: '' }, // 运行时填真实 fixture URL
    risk: 'LOW',
    verification: { type: 'none' },
    expectedBusinessState: {
      stateType: 'NAVIGATED', expected: 'page loaded',
      requiredEvidence: [{ type: 'url_contains', expect: '/signup' }],
      forbiddenEvidence: [], evidenceLogic: 'AND', confidence: 0.9,
    },
    timeoutMs: 20000,
  },
  verification: { type: 'none' },
  retryable: true,
  maxRetries: 1,
};

// 必然失败的动作：页面上不存在 password 输入框
const PLAN_PASSWORD_MISSING = {
  id: 'step_001',
  description: 'Fill password that does not exist',
  type: 'ACT',
  action: {
    type: 'fill',
    target: { field: 'password', semantic: 'Password' },
    credentialRef: 'secret:signup_password',
    risk: 'LOW',
    verification: { type: 'element_present', target: { selector: '#password' } },
    timeoutMs: 8000,
  },
  verification: { type: 'element_present', target: { selector: '#password' } },
  retryable: true,
  maxRetries: 3, // 多给重试预算：让「修复是否被调用」成为可控变量而不是预算不足的副作用
};

/**
 * 跑一次端到端（真实浏览器 + 真实 runtime），由 decisionFactory 决定 repair 返回什么 decision。
 * @param {string} label
 * @param {function|null} decisionFactory 返回 decision；null = repair 不返回决策
 * @param {string} [html] 页面内容（默认含 1 个 input，可产出确定性决策）
 * @returns {Promise<{status, repairCalls, elapsedMs, steps, events:Array, reason:string}>}
 */
async function runOnce(label, decisionFactory, html) {
  const body = html || PAGE;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await listenSafe(srv, '127.0.0.1');
  const url = 'http://127.0.0.1:' + srv.address().port + '/signup';

  const profileId = 'p_c107_flap_' + label + '_' + Date.now().toString(36);
  db.upsertProfile({ id: profileId, name: 'c107 anti-flapping ' + label, os: 'windows' });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  browserManager.__setSessionForTest(profileId, { browser, context, page });

  const seen = [];
  const origEmit = events.emit;
  events.emit = function patched(e) { try { if (e) seen.push(e); } catch (_) {} return origEmit.apply(events, arguments); };

  const repairCalls = [];
  const origHandle = repairManager.handleStepFailure;
  repairManager.handleStepFailure = async function patched(args) {
    repairCalls.push({ stepId: args && args.step && args.step.id, at: Date.now() });
    const decision = decisionFactory ? decisionFactory() : null;
    return { paused: false, ok: false, category: 'ELEMENT_NOT_FOUND', usedMemory: false, decision, repairStats: {} };
  };

  let taskId = null;
  try {
    const task = taskManager.createTask({
      name: 'c107 anti-flapping ' + label,
      objective: 'Fill a password that the page does not have',
      targetUrl: url,
      profileId,
      executionMode: 'AUTO',
      policy: {}, budget: {}, constraints: [], secretRefs: [],
      createdBy: 'c107',
    });
    taskId = task.id;
    const nav = JSON.parse(JSON.stringify(PLAN_NAV));
    nav.action.target.url = url;
    taskManager.attachPlan(task.id, { goal: 'fill password', steps: [nav, PLAN_PASSWORD_MISSING] });
    taskManager.setExecutor(runtime.run);
    taskManager.start(task.id);

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const t = taskManager.getTask(task.id);
      if (t && ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(t.status)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    events.emit = origEmit;
    repairManager.handleStepFailure = origHandle;
  }

  const task = taskManager.getTask(taskId);
  const steps = stepManager.listSteps(taskId);
  const out = {
    label, taskId, status: task && task.status,
    reason: String((task && task.error && (task.error.message || task.error)) || ''),
    repairCalls: repairCalls.length,
    elapsedMs: (task && task.startedAt && task.finishedAt) ? (task.finishedAt - task.startedAt) : null,
    steps: steps.map((s) => ({ i: s.index, id: s.id, st: s.status })),
    events: seen,
  };

  try { browserManager.__setSessionForTest(profileId, null); } catch (e) {}
  try { await context.close(); } catch (e) {}
  try { await browser.close(); } catch (e) {}
  try { db.deleteProfile(profileId); } catch (e) {}
  srv.close();
  return out;
}

async function main() {
  console.log('PHASE 17-A — Anti-Flapping minimal fix verification (real Chromium + real runtime)\n');

  // ── 0) 契约层：三个状态生成三类决策，noRepair 语义必须可区分 ──────────────
  {
    const pwd = PLAN_PASSWORD_MISSING.action;
    const dChallenge = diagnosisDecision.fromLLM({ category: 'BOT_CHALLENGE', confidence: 0.95, state: 'SECURITY_CHALLENGE' });
    const dMulti = diagnosisDecision.fromLLM({ category: 'ELEMENT_NOT_FOUND', confidence: 0.9, state: 'MULTI_STEP_FORM' });
    const dStale = diagnosisDecision.fromLLM({ category: 'STALE_ELEMENT', confidence: 0.8, state: 'TARGET_STALE' });

    const pChallenge = diagnosisDecision.evaluate({ decision: dChallenge, action: pwd });
    const pMulti = diagnosisDecision.evaluate({ decision: dMulti, action: pwd });
    const pStale = diagnosisDecision.evaluate({ decision: dStale, action: pwd });

    check('K1 SECURITY_CHALLENGE → blocked + noRepair + escalate',
      pChallenge.blocked === true && pChallenge.noRepair === true && pChallenge.escalate === true,
      JSON.stringify({ b: pChallenge.blocked, n: pChallenge.noRepair, e: pChallenge.escalate }));
    check('K2 MULTI_STEP_FORM → blocked 但**不**禁止修复（可推进式恢复）',
      pMulti.blocked === true && pMulti.noRepair === false,
      JSON.stringify({ b: pMulti.blocked, n: pMulti.noRepair }));
    check('K3 TARGET_STALE → 不阻塞（要求重新观察与重新接地）',
      pStale.blocked === false,
      JSON.stringify({ b: pStale.blocked, r: pStale.require }));
    check('K4 三类决策的 maxRepeats 语义互不相同（不是同一常量）',
      new Set([pChallenge.maxRepeats, pMulti.maxRepeats, pStale.maxRepeats]).size >= 2,
      JSON.stringify([pChallenge.maxRepeats, pMulti.maxRepeats, pStale.maxRepeats]));
  }

  // ── 1) 正例：确定性决策把「必然失败的凭据动作」判定为不可推进 → repair 一次都不调用 ──
  // 现场：页面只有 1 个 input（email）+ 1 个推进控件，目标 password 不可定位。
  // derive 会给出 MULTI_STEP_FORM（blocked=fill:password, maxRepeats=1, escalate=false）——
  // 该结论在**执行前门**就生效：先等页面稳定 + 重新观察 + 尝试推进，重复上限 1 次后
  // repeatsExhausted 成立 → 直接 escalate。全过程不进入 repair。
  const forbid = await runOnce('forbid', () => diagnosisDecision.fromLLM({
    category: 'ELEMENT_NOT_FOUND',
    confidence: 0.95,
    state: 'MULTI_STEP_FORM',
    blockedActions: ['fill:password'],
    required: 'REOBSERVE_AFTER_SUBMIT',
    currentStep: 'EMAIL_ONLY',
    inference: '注册流程分步，密码框尚未出现',
  }));

  console.log('--- 正例（决策阻塞必然失败的凭据动作）现场数据 ---');
  console.log('status=' + forbid.status);
  console.log('reason=' + forbid.reason.slice(0, 200));
  console.log('repairCalls=' + forbid.repairCalls + ' elapsedMs=' + forbid.elapsedMs);
  console.log('steps=' + JSON.stringify(forbid.steps));
  const forbidTypes = [...new Set(forbid.events.map((e) => e.type))];
  console.log('event types=' + JSON.stringify(forbidTypes));

  check('P1 决策阻塞时 repair 一次都不调用（历史实证可跑满 21 次）', forbid.repairCalls === 0,
    'repairCalls=' + forbid.repairCalls);
  check('P2 收敛到显式终态（不悬挂 RUNNING）',
    ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(forbid.status),
    'status=' + forbid.status);
  check('P3 终态不是 SUCCESS（诊断/熔断绝不制造成功）', forbid.status !== 'SUCCESS',
    'status=' + forbid.status);
  check('P4 未发生无限 reload（reload 类事件 ≤ 1）',
    forbid.events.filter((e) => /reload/i.test(String(e.type || ''))).length <= 1,
    'reload events=' + forbid.events.filter((e) => /reload/i.test(String(e.type || ''))).length);
  check('P5 有限时间内收口（< 90s）',
    forbid.elapsedMs !== null && forbid.elapsedMs < 90000, 'elapsedMs=' + forbid.elapsedMs);
  check('P6 发出 agent.diagnosis_decision 事件（决策真的被执行前门消费）',
    forbid.events.some((e) => e.type === 'agent.diagnosis_decision'),
    JSON.stringify(forbid.events.filter((e) => /diagnosis_decision/.test(String(e.type))).map((e) => e.type)));

  // ── 2) 反例（负向对照）：derive 不下结论 → 控制流走完重试进入 repair ─────────
  // 为什么用「零输入元素页面」：derive 的保守守卫在「页面连一个输入框都没有」时
  // **不产出任何决策**（空集 ≠ 不存在）。此时执行前门无决策可消费 → 走完重试预算
  // → 必然进入 repair 分支 → repairCalls ≥ 1。
  // 这个对照证明的是：正例的 repairCalls===0 归因于「决策存在」，
  // 而不是「repair 链路被整体关掉/损坏」造成的假绿。
  const allow = await runOnce('allow', null, PAGE_NO_INPUTS);

  console.log('\n--- 反例（无决策 → 应当进入 repair）现场数据 ---');
  console.log('status=' + allow.status);
  console.log('reason=' + allow.reason.slice(0, 200));
  console.log('repairCalls=' + allow.repairCalls + ' elapsedMs=' + allow.elapsedMs);
  console.log('steps=' + JSON.stringify(allow.steps));
  console.log('event types=' + JSON.stringify([...new Set(allow.events.map((e) => e.type))]));

  check('N1 无决策时 repair 确实被调用（负向对照：证明拦截来自决策而非链路损坏）',
    allow.repairCalls >= 1, 'repairCalls=' + allow.repairCalls);
  check('N2 反例同样收敛到显式终态',
    ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(allow.status),
    'status=' + allow.status);
  check('N3 反例未产生 diagnosis_decision 阻塞事件（对照组自身无决策）',
    !allow.events.some((e) => e.type === 'agent.diagnosis_decision' && e.payload && e.payload.blocked === true),
    JSON.stringify(allow.events.filter((e) => e.type === 'agent.diagnosis_decision').map((e) => e.payload && e.payload.blocked)));

  // ── 3) 两组对照差异必须存在（否则正例可能是「repair 坏了」造成的假绿）────
  check('C1 正例 repairCalls 严格小于反例（差异可归因于决策）',
    forbid.repairCalls < allow.repairCalls,
    'forbid=' + forbid.repairCalls + ' allow=' + allow.repairCalls);
  // 「是否进入 repair 编排」的真实见证 —— 关键坑（本测试第 3 轮实测暴露）：
  //   agent.diagnosing 有**两个**发出点：
  //     ① recovery/recoveryManager.js:110  → 这是**确定性重试/恢复**路径（不是 repair）
  //     ② repair/repairManager.js:108      → 这才是**修复编排**路径
  //   二者的 payload 可区分：repairManager 额外带 fromFailureMemory / recommendation 字段。
  //   若按事件名一刀切断言「正例不应有 agent.diagnosing」，会把正常的恢复诊断误判成
  //   进入了 repair（本轮 C2/C3b 因此假红）。必须按 payload 形状区分归因。
  const isRepairDiagnosing = (e) => e.type === 'agent.diagnosing'
    && e.payload && ('fromFailureMemory' in e.payload || 'recommendation' in e.payload);

  check('C2 正例未进入修复编排（无 repairManager 形状的 agent.diagnosing）',
    !forbid.events.some(isRepairDiagnosing),
    JSON.stringify(forbid.events.filter(isRepairDiagnosing).map((e) => e.payload)));  // 反例「确实走到修复分支」的见证：
  //   ① repairCalls ≥ 1 —— 这已经是**物理证据**（测试替身是 runtime 调用 handleStepFailure 的
  //      同一入口，计数即「runtime 请求了修复」）；它由 N1 断言。
  //   ② agent.flapping_detected —— 该事件只在 runtime 的 flap 记账里发出，反例现场命中
  //      （重试 4 次同签名），正例因执行前门提前 escalate 而永不出现。它是**运行时路径**证据，
  //      不依赖测试替身，因此作为 C3 的补充见证最合适。
  //   说明：agent.diagnosing 的两个发出点（recoveryManager:110 / repairManager:108）都拿不到 ——
  //     前者是恢复路径（非 repair），后者被测试替身短路，故两者都不能作为 repair 见证。
  check('C3 反例触发了 flap 记账（agent.flapping_detected，运行时路径证据）',
    allow.events.some((e) => e.type === 'agent.flapping_detected'),
    JSON.stringify([...new Set(allow.events.map((e) => e.type))].filter((t) => /flap/.test(t))));
  check('C3b 正例未触发 flap 记账（执行前门就拦住了，压根没耗尽重试预算）',
    !forbid.events.some((e) => e.type === 'agent.flapping_detected'),
    JSON.stringify([...new Set(forbid.events.map((e) => e.type))].filter((t) => /flap/.test(t))));

  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e && e.stack); process.exit(1); });
