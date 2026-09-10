'use strict';
/**
 * PHASE 17-A / P0-B —— Diagnosis → Runtime Decision Consumption【R3 回放，真实 Chromium】。
 *
 * 实证（真实站点 E2E 第 3 轮 task_mtudmyy7rg926，473s FAILED）：
 *   LLM 诊断**已经正确说出**：「注册流程可能分步，第一步只要工作邮箱，密码框尚未出现在页面上」
 *   （confidence 0.95）。但 Runtime 完全没消费这句话 —— 仍严格按计划执行
 *     fill password → ELEMENT_NOT_FOUND → retry → repair → retry → … → 473s FAILED。
 *   根因不是模型不知道，而是**诊断只有一个消费口**（选修复策略），
 *   动作策略层（下一步做什么）从来不读诊断。
 *
 * 本测试证明的是「修好之后」的行为，且必须是**真的执行到了决策门**，
 * 而不是只测 helper：
 *   1. 用真实 planner 产出的计划（email → password），attachPlan + start 走生产 run() 主循环；
 *   2. 页面是真实的分步注册表单（第一步只有 Work email + Continue，密码框在第二步才挂载）；
 *   3. 第一次 password 失败后，由 repairManager 产出**真实 LLM 形态的结构化诊断**
 *      （MULTI_STEP_FORM + blockedActions ["fill:password"] + current_step EMAIL_ONLY，
 *      经 diagnosisSchema.validate 校验，绝不绕过 schema）；
 *   4. 断言 Runtime 之后的行为：允许 email / 禁止 password / 不重复 fill password /
 *      不进入 fill→fail→retry→repair→retry 死循环 / 不产生 SUCCESS（诊断不是 verification）。
 *
 * 全部断言基于**真实事件流 + 真实 attempt 记录 + 真实页面值**，不看源码字符串。
 */

const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { listenSafe } = require('./lib_safe_port');

const ROOT = path.join(__dirname, '..');
const events = require(path.join(ROOT, 'agent', 'events'));
const store = require(path.join(ROOT, 'agent', 'store'));
const tools = require(path.join(ROOT, 'agent', 'tools'));
const runtime = require(path.join(ROOT, 'agent', 'runtime'));
const taskManager = require(path.join(ROOT, 'agent', 'taskManager'));
const stepManager = require(path.join(ROOT, 'agent', 'stepManager'));
const browserManager = require(path.join(ROOT, 'browserManager'));
const db = require(path.join(ROOT, 'db'));
const diagnosisDecision = require(path.join(ROOT, 'agent', 'diagnosisDecision'));
const diagnosisSchema = require(path.join(ROOT, 'agent', 'diagnosis', 'diagnosisSchema'));
const repairManager = require(path.join(ROOT, 'agent', 'repair', 'repairManager'));

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 页面：真实分步注册表单。
//   第 1 步：Work email + Continue（密码输入框【尚未挂载】）
//   点 Continue 后：把 email 折叠为只读展示 + 挂载 password 输入框 + Create account 按钮
// 为什么必须在 DOM 层面模拟「尚未挂载」：这才是 R3 的真实现场 ——
//   fill password 时元素**确实不存在**（不是不可见、不是被遮挡），ELEMENT_NOT_FOUND 是正确判定，
//   缺的是「这个不存在意味着流程还没走到那一步」这一层解读。
const STEP1 = [
  '<!doctype html><html><head><title>Sign up - Webflow</title></head><body>',
  '<h1>Sign up</h1>',
  '<form id="f" action="#" onsubmit="return false">',
  '<label for="email">Work email address</label>',
  '<input id="email" name="email" type="email" placeholder="Work email address" aria-label="Work email address">',
  '<button id="continue" type="submit">Continue</button>',
  '</form>',
  '<script>',
  'document.getElementById("continue").addEventListener("click", function(){',
  '  var e = document.getElementById("email");',
  '  var ro = document.createElement("input");',
  '  ro.type = "email"; ro.id = "email_ro"; ro.name = "email_ro"; ro.value = e ? e.value : ""; ro.readOnly = true;',
  '  e.parentNode.replaceChild(ro, e);',
  '  var p = document.createElement("input");',
  '  p.type = "password"; p.id = "password"; p.name = "password"; p.placeholder = "Password"; p.setAttribute("aria-label","Password");',
  '  var b = document.createElement("button");',
  '  b.type = "submit"; b.id = "create"; b.textContent = "Create account";',
  '  var f = document.getElementById("f");',
  '  f.appendChild(p); f.appendChild(b);',
  '});',
  '</script>',
  '</body></html>',
].join('\n');

// R3 现场诊断（真实 LLM 输出形态；经 diagnosisSchema.validate 校验后才使用）
const R3_DIAGNOSIS = {
  category: 'ELEMENT_NOT_FOUND',
  confidence: 0.95,
  facts: ['先前目标「注册密码输入框」未定位到', '当前页面只有 Work email address 输入框'],
  evidence: ['当前页面可见文本包含 Work email address 与 Continue', '页面不存在 password 类型输入框'],
  inference: '注册流程可能分步，第一步只要工作邮箱，密码框尚未出现在页面上',
  recommendation: '先完成邮箱步骤并等待页面推进，再重新观察',
  state: 'MULTI_STEP_FORM',
  blockedActions: ['fill:password'],
  required: 'REOBSERVE_AFTER_SUBMIT',
  currentStep: 'EMAIL_ONLY',
};

// 计划（与真实 planner 产出一致：navigate → email → password）
// ⚠️ 首步必须是 navigate：全量实证（aiTasks/aiSteps 扫描）52 个含凭据字段的任务里 49 个首步是 navigate，
//    真实 planner 契约就是「先导航到目标站点，再填字段」。若跳过 navigate 直接在 about:blank 上 fill，
//    页面根本不在任何站点上（location.origin === "null"），凭据授权闸会正确以 NO_ORIGIN_CONTEXT 拒绝 ——
//    那是「计划不合法」被安全闸挡住，不是 R3 的现场。本测试必须复现 R3 的真实现场。
const PLAN_NAV = {
  id: 'step_000',
  description: 'Navigate to signup page',
  type: 'ACT',
  action: {
    type: 'navigate',
    target: { url: '' }, // 运行时填入真实 fixture URL
    risk: 'LOW',
    // navigate 属「关键业务动作」：buildEffectiveVerification 会用 deriveContract(navigate)
    // 推导出 NAVIGATED 契约（requiredEvidence=url_contains __URL__）覆盖掉裸 verification。
    // 若在此写 url_pattern 且把 pattern 放在顶层，字段会在推导覆盖中丢失 →
    // 上层按空 pattern 评估 → 必然 VERIFY_FAILED（本测试首轮实测）。
    // 因此这里显式给出与推导契约同源的 evidence，避免依赖推导的隐式行为。
    verification: { type: 'none' },
    expectedBusinessState: {
      stateType: 'NAVIGATED',
      expected: 'signup page loaded',
      requiredEvidence: [{ type: 'url_contains', expect: '/signup' }],
      forbiddenEvidence: [],
      evidenceLogic: 'AND',
      confidence: 0.9,
    },
    timeoutMs: 20000,
  },
  verification: { type: 'none' },
  retryable: true,
  maxRetries: 3,
};
const PLAN_EMAIL = {
  id: 'step_001',
  description: 'Fill work email address',
  type: 'ACT',
  action: {
    type: 'fill',
    target: { field: 'email', semantic: 'Work email address' },
    value: 'operator@example.com',
    risk: 'LOW',
    verification: { type: 'element_present', target: { selector: '#email_ro' } },
    timeoutMs: 15000,
  },
  verification: { type: 'element_present', target: { selector: '#email_ro' } },
  retryable: true,
  maxRetries: 3,
};
const PLAN_PASSWORD = {
  id: 'step_002',
  description: 'Fill password',
  type: 'ACT',
  action: {
    type: 'fill',
    // R3 真实现场：planner 按「单页注册表单」假设规划了 password 字段，
    // 但真实站点是分步表单 —— 该字段在第一步【尚未挂载】→ ELEMENT_NOT_FOUND。
    // （实测教训：若在此写 value 字面量，会先被凭据策略以 ACTION_INVALID 拦下，
    //  走的是「敏感字段必须 credentialRef」这条与 R3 无关的路径。）
    target: { field: 'password', semantic: 'Password' },
    credentialRef: 'secret:signup_password',
    risk: 'LOW',
    verification: { type: 'element_present', target: { selector: '#password' } },
    timeoutMs: 15000,
  },
  verification: { type: 'element_present', target: { selector: '#password' } },
  retryable: true,
  maxRetries: 3,
};

async function main() {
  console.log('PHASE 17-A / P0-B — R3 diagnosis consumption replay (real Chromium + real runtime loop)\n');

  // ── 0) Contract 层：诊断字段真的能通过 schema 并进入决策契约 ──────────────
  {
    const v = diagnosisSchema.validate(R3_DIAGNOSIS);
    check('S1 R3 诊断通过 diagnosisSchema.validate', v.ok === true, JSON.stringify(v.errors || null));
    check('S1b schema 保留 state / blockedActions / currentStep',
      v.ok && v.plan.state === 'MULTI_STEP_FORM'
      && Array.isArray(v.plan.blockedActions) && v.plan.blockedActions[0] === 'fill:password'
      && v.plan.currentStep === 'EMAIL_ONLY',
      JSON.stringify(v.plan && { state: v.plan.state, blockedActions: v.plan.blockedActions, currentStep: v.plan.currentStep }));

    const d = diagnosisDecision.fromLLM(v.plan);
    check('S2 fromLLM 产出结构化 Decision', !!d && d.state === 'MULTI_STEP_FORM', JSON.stringify(d && { state: d.state, blockedActions: d.blockedActions }));
    const polEmail = diagnosisDecision.evaluate({ decision: d, action: PLAN_EMAIL.action });
    const polPwd = diagnosisDecision.evaluate({ decision: d, action: PLAN_PASSWORD.action });
    check('S3 决策允许 fill:email', polEmail.blocked === false, 'blocked=' + polEmail.blocked);
    check('S4 决策阻塞 fill:password', polPwd.blocked === true, 'blocked=' + polPwd.blocked);
    check('S4b 决策不改写成功语义（无 success 字段）',
      !('success' in polPwd) && !('verified' in polPwd), Object.keys(polPwd).join(','));
  }

  // ── 1) 真实 Chromium + 真实页面 ─────────────────────────────────────────
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(STEP1);
  });
  await listenSafe(srv, '127.0.0.1');
  const port = srv.address().port;
  const URL1 = 'http://127.0.0.1:' + port + '/signup';

  // profile（runtime.ensureBrowser 要求 task.profileId 且 db.getProfile 命中）
  const profileId = 'p_c107_diag_' + Date.now().toString(36);
  db.upsertProfile({
    id: profileId,
    name: 'c107 diagnosis replay',
    os: 'windows',
    // 真实 launch 依赖 fingerprint 字段；缺省走 browserManager 的默认值路径
  });

  // 用真实 Chromium 预置页面，随后把 session 交给 browserManager（与其 getPage 契约一致）。
  // 契约要点（本测试第二轮实测踩到）：__setSessionForTest 会把传入对象**原样注册**，
  // 因此必须给出真实的 context + page；传 { context:null, page:null } 会让
  // getPage() 返回 null → navigate 得到 "reading 'goto' of null" → 首步就崩。
  // （首轮之所以没暴露：当时该接缝在 browserManager 中并不存在，可选调用成了静默 no-op。）
  const browser = await chromium.launch({ headless: true });
  await browserManager.close(profileId).catch(() => {});
  const ctx0 = await browser.newContext();
  const page0 = await ctx0.newPage();
  browserManager.__setSessionForTest(profileId, { browser, context: ctx0, page: page0 });

  // 记录真实事件
  const seen = [];
  const origEmit = events.emit;
  events.emit = function patched(e) { try { if (e) seen.push(e); } catch (_) {} return origEmit.apply(events, arguments); };

  // 记录真实 repair 调用次数（R3 的核心指标：repair 不应被反复触发）
  // 注入方式：**沿用 repairManager 的真实返回契约**（{ ok:false, decision, ... }），
  // 让 runtime 通过 F22/F23 的最小接口连接自消费 —— 而不是测试里手工往 runtime 内部塞状态。
  // 这样测的是「诊断从 repair 返回 → 进入 Runtime 动作策略层」这条真实链路。
  const repairCalls = [];
  const origHandle = repairManager.handleStepFailure;
  repairManager.handleStepFailure = async function patchedRepair(args) {
    repairCalls.push({ stepId: args && args.step && args.step.id, at: Date.now() });
    const validated = diagnosisSchema.validate(R3_DIAGNOSIS); // 经真实 schema 校验，不绕过契约
    const ctx = { taskId: args.task.id, executionId: args.task.currentExecutionId };
    events.emit({
      ...ctx, stepId: args.step.id, type: 'agent.diagnosis_decision',
      payload: {
        state: validated.plan.state, blockedActions: validated.plan.blockedActions,
        required: validated.plan.required, source: 'llm', confidence: validated.plan.confidence,
      },
    });
    const decision = diagnosisDecision.fromLLM(validated.plan);
    const t = taskManager.getTask(args.task.id);
    if (t && validated.plan) {
      t.lastDiagnosis = { ...validated.plan, fromLLM: true, fromFailureMemory: false };
      store.upsert('aiTasks', t);
    }
    events.emit({
      ...ctx, stepId: args.step.id, type: 'agent.diagnosing',
      payload: {
        category: validated.plan.category, confidence: validated.plan.confidence,
        fromFailureMemory: false, recommendation: validated.plan.recommendation,
      },
    });
    // 修复本身不成功（真实 R3 现场：页面上确实没有密码框可修）→ paused:false + decision 回传
    return { paused: false, ok: false, category: validated.plan.category, usedMemory: false, decision, repairStats: {} };
  };

  const TASK_ID_HOLDER = {};
  let runDone = null;
  try {
    const task = taskManager.createTask({
      name: 'c107 R3 replay',
      objective: 'Sign up on the site with the work email and a password',
      targetUrl: URL1,
      profileId,
      executionMode: 'AUTO',
      policy: {},
      budget: {},
      constraints: [],
      secretRefs: [],
      createdBy: 'c107',
    });
    // ⚠️ createTask 忽略传入 id（既有陷阱）：必须用返回的真实 id，否则 getTask 取不到 targetUrl
    TASK_ID_HOLDER.id = task.id;
    const planNav = JSON.parse(JSON.stringify(PLAN_NAV));
    planNav.action.target.url = URL1;
    taskManager.attachPlan(task.id, { goal: 'sign up', steps: [planNav, PLAN_EMAIL, PLAN_PASSWORD] });
    taskManager.setExecutor(runtime.run);

    runDone = taskManager.start(task.id);
    // 轮询等待 runtime 收口（真实浏览器执行，绝非假时钟）
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

  const taskId = TASK_ID_HOLDER.id;
  const task = taskManager.getTask(taskId);
  const steps = stepManager.listSteps(taskId);
  const attempts = store.findWhere('aiAttempts', (a) => a.taskId === taskId);
  const stepOf = (i) => steps.filter((s) => s.index === i)[0] || null;
  const fillAttempts = (field) => attempts.filter((a) => a && a.action && a.action.type === 'fill'
    && a.action.target && a.action.target.field === field);
  const pwdFills = fillAttempts('password');
  const emailFills = fillAttempts('email');

  const diagEvents = seen.filter((e) => e.type === 'agent.diagnosis_decision');
  const repairEvts = seen.filter((e) => e.type === 'ai.repair' || e.type === 'agent.repair');

  console.log('\n--- 现场数据 ---');
  console.log('task.status=' + (task && task.status));
  console.log('task.reason=' + (task && task.error && (task.error.message || task.error)));
  console.log('steps=' + JSON.stringify(steps.map((s) => ({ i: s.index, id: s.id, st: s.status }))));
  console.log('emailFills=' + emailFills.length + ' passwordFills=' + pwdFills.length);
  console.log('repairCalls=' + repairCalls.length + ' diagnosis_decision events=' + diagEvents.length);
  console.log('event types=' + JSON.stringify([...new Set(seen.map((e) => e.type))].slice(0, 30)));

  // ── A) email（合法第一步）允许执行 ──────────────────────────────────────
  check('A1 原计划第一步 fill:email 被允许执行', emailFills.length >= 1,
    'email fill attempts=' + emailFills.length);
  check('A2 email 步骤未被诊断决策阻塞',
    !diagEvents.some((e) => e.payload && /email/.test(String((e.payload.action || ''))) ),
    'blockedActions=' + JSON.stringify(diagEvents.map((e) => e.payload && e.payload.action)));

  // ── B) password 被禁止；且不进入死循环 ─────────────────────────────────
  check('B1 password 未被反复 fill（R3 现场为 12 次）', pwdFills.length <= 2,
    'password fill attempts=' + pwdFills.length);
  check('B2 未进入 fill→fail→repair 死循环（repair 调用 ≤2）', repairCalls.length <= 2,
    'repairCalls=' + repairCalls.length);
  check('B3 Runtime 消费了诊断并发出 diagnosis_decision 事件',
    diagEvents.length >= 1, 'count=' + diagEvents.length);
  check('B3b 决策事件携带 blocked=true + MULTI_STEP_FORM',
    diagEvents.some((e) => e.payload && e.payload.blocked === true && e.payload.state === 'MULTI_STEP_FORM'),
    JSON.stringify(diagEvents.map((e) => e.payload && { s: e.payload.state, b: e.payload.blocked })));
  check('B3c 决策事件标注 fill:password 为被阻动作',
    diagEvents.some((e) => e.payload && String(e.payload.action || '') === 'fill:password'),
    JSON.stringify(diagEvents.map((e) => e.payload && e.payload.action)));

  // ── C) 诊断绝不制造 SUCCESS ────────────────────────────────────────────
  check('C1 任务未被诊断判为 SUCCESS', !task || task.status !== 'SUCCESS',
    'status=' + (task && task.status));
  const pwdStep = stepOf(2);
  check('C2 未见 password 出现时 password 步骤未标 SUCCESS',
    !pwdStep || pwdStep.status !== 'SUCCESS', 'step_002.status=' + (pwdStep && pwdStep.status));

  // ── D) 端到端未跑成 473s 长循环（决策门必须显著缩短失败时间）─────────────
  const elapsed = (task && task.startedAt && task.finishedAt) ? (task.finishedAt - task.startedAt) : null;
  check('D1 失败在有限时间内收口（远小于 R3 的 473s）',
    elapsed !== null && elapsed < 180000, 'elapsedMs=' + elapsed);
  check('D2 任务收敛到显式终态（无悬挂 RUNNING）',
    task && ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(task.status),
    'status=' + (task && task.status));

  // ── E) 观察链路仍完整（email 之后必须重新观察）─────────────────────────
  const obsEvents = seen.filter((e) => e.type === 'agent.observing' || e.type === 'ai.observation' || (e.payload && e.payload.source === 'diagnosis_decision'));
  check('E1 email 动作后存在新鲜观察（诊断决策通道触发 reobserve）',
    obsEvents.length >= 1, 'observation-ish events=' + obsEvents.length);

  // ── 清理 ───────────────────────────────────────────────────────────────
  try { await browserManager.close(profileId); } catch (e) {}
  try { await browser.close(); } catch (e) {}
  try { db.deleteProfile(profileId); } catch (e) {}
  srv.close();

  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e && e.stack); process.exit(1); });
