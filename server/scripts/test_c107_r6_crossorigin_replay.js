'use strict';
/**
 * PHASE 17-A / P0-A —— R6 跨域凭据外泄【端到端回放，真实 Chromium + 真实 runtime 主循环】。
 *
 * R6 真实现场（真实站点 E2E 第 6 轮）：
 *   任务目标 = 某个 SaaS 站点的注册流程（锚点 origin = 主站）。
 *   执行期 Agent 误点第三方授权入口 → 页面导航到第三方 OAuth 登录域
 *     （URL 形如 https://<third-party>/login?client_id=…&return_to=/login/oauth/authorize…）
 *   → planner 继续按原目标生成 fill email/password
 *   → Agent 把**环境凭据**连续 4 次填进第三方登录框（凭据外泄，不是普通失败）。
 *
 * 本测试要证明的**用户原文要求**：
 *   「当 current origin = 第三方域且没有 explicit authorization：
 *     任何主站 credential：禁止 fill；产生安全 evidence（CREDENTIAL_ACTION_BLOCKED，
 *     reason=CROSS_ORIGIN_UNAUTHORIZED 同族）；
 *     禁止：继续尝试 / 继续 repair / 继续 fill / 无限 reload」
 *
 * 与 test_c107_credential_boundary_fixture.js 的分工：
 *   后者证明**闸门本身**（直接调 tools.runTool，19 个用例覆盖 A1–N1）；
 *   本测试证明**闸门嵌进真实 Runtime 之后的行为收口** —— 这是之前缺的那一段：
 *   Runtime 收到 CREDENTIAL_ACTION_BLOCKED 后必须不 retry、不 repair、不 reload，
 *   直接以显式终态交人。若只测 helper，无法证明这一点。
 *
 * 断言全部基于真实事件流 + 真实 attempt 记录 + 真实页面值 + 真实 task 终态。
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
const credentialAuthorization = require(path.join(ROOT, 'agent', 'credentialAuthorization'));

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}

// ── 主站（锚点）页面：真实注册表单 ─────────────────────────────────────────
const MAIN_PAGE = [
  '<!doctype html><html><head><title>Sign up</title></head><body>',
  '<h1>Sign up</h1>',
  '<form id="f" action="#">',
  '<label for="email">Work email address</label>',
  '<input id="email" name="email" type="email" placeholder="Work email address">',
  '<button id="submit" type="submit">Create account</button>',
  '</form></body></html>',
].join('\n');

// ── 第三方 OAuth 授权页：结构上是普通登录表单（正是危险之处 —— 看起来一样）──
// 关键：表单里也有 email / password 输入框，DOM 层面与主站几乎无法区分。
// 「能不能填」只能由授权上下文决定，绝不能靠页面长相判断。
const OAUTH_PAGE = [
  '<!doctype html><html><head><title>Sign in</title></head><body>',
  '<h1>Sign in to continue</h1>',
  '<form id="f" action="#">',
  '<label for="email">Email</label>',
  '<input id="email" name="email" type="email" placeholder="Email">',
  '<label for="password">Password</label>',
  '<input id="password" name="password" type="password" placeholder="Password">',
  '<button id="login" type="submit">Sign in</button>',
  '</form></body></html>',
].join('\n');

// 计划：精确编码 R6 的时间线 ——
//   step_000 navigate 到主站（锚点，唯一被授权 origin）
//   step_001 navigate 到**第三方 OAuth 授权域**（= Agent 误点第三方授权入口后的真实 URL）
//   step_002 fill 主站的 email（planner 仍按原目标生成，页面已漂移）
//   step_003 fill 主站的 password（credentialRef，真实凭据）
// 关键：step_002/003 的 fill 动作**与主站任务完全一致**，只是执行时页面已不在主站 ——
// 这正是 R6 的危险之处：凭据动作本身合法，不合法的是它落地的 origin。
// 靠「能不能填」判定，只能由授权上下文给出，不能靠动作长相。
function mkNav(id, url, urlEvidence) {
  return {
    id,
    description: 'navigate to ' + url,
    type: 'ACT',
    action: {
      type: 'navigate',
      target: { url },
      risk: 'LOW',
      // navigate 是「关键业务动作」：buildEffectiveVerification 会用 deriveContract(navigate)
      // 覆盖裸 verification，故这里直接给出与推导契约同源的 requiredEvidence。
      verification: { type: 'none' },
      expectedBusinessState: {
        stateType: 'NAVIGATED',
        expected: 'page loaded',
        requiredEvidence: [{ type: 'url_contains', expect: urlEvidence }],
        forbiddenEvidence: [],
        evidenceLogic: 'AND',
        confidence: 0.9,
      },
      timeoutMs: 20000,
    },
    verification: { type: 'none' },
    retryable: true,
    maxRetries: 1, // 刻意压低：若安全闸失效，本测试会通过 repair/retry 次数暴露出来
  };
}

// fill 步骤必须给出「有意义的验证」（schema/action.js 强制），否则在进入安全闸之前
// 就被 ACTION_INVALID 拦下 —— 那样测的是 schema，不是安全边界。
// 用 element_present 作为业务完成证据：元素在跨域页面上确实存在（同名 #email/#password），
// 因此「拦截」只能来自安全闸，不可能被 verification 失败掩蔽。
const PLAN_EMAIL = {
  id: 'step_002',
  description: 'Fill work email on current page',
  type: 'ACT',
  action: {
    type: 'fill',
    target: { field: 'email', semantic: 'Email' },
    value: 'operator@example.com',
    risk: 'LOW',
    verification: { type: 'element_present', target: { selector: '#email' } },
    timeoutMs: 12000,
  },
  verification: { type: 'element_present', target: { selector: '#email' } },
  retryable: true,
  maxRetries: 1,
};

const PLAN_PASSWORD = {
  id: 'step_003',
  description: 'Fill password on current page',
  type: 'ACT',
  action: {
    type: 'fill',
    // 真实凭据（credentialRef 表达）：R6 外泄的正是这一类。
    target: { field: 'password', semantic: 'Password' },
    credentialRef: 'secret:signup_password',
    risk: 'LOW',
    verification: { type: 'element_present', target: { selector: '#password' } },
    timeoutMs: 12000,
  },
  verification: { type: 'element_present', target: { selector: '#password' } },
  retryable: true,
  maxRetries: 1,
};

async function main() {
  console.log('PHASE 17-A / P0-A — R6 cross-origin credential exfiltration replay (real Chromium + real runtime)\n');

  // ── 0) 契约层：先证明闸门对 R6 场景的判定与归因（单元级，零浏览器）────────
  {
    const ANCHOR = 'https://app.example.com/signup';
    const ctx = credentialAuthorization.createContext({
      task: { id: 't_contract', targetUrl: ANCHOR },
      executionId: 'exe_contract',
    });
    const pwd = PLAN_PASSWORD.action;
    const v = credentialAuthorization.authorize({
      context: ctx,
      pageUrl: 'https://idp.example.net/login?client_id=Iv1.abc&return_to=%2Flogin%2Foauth%2Fauthorize',
      action: pwd,
      challenge: null,
    });
    check('S1 跨域第三方授权面 → 不允许', v.allowed === false, JSON.stringify(v.reason));
    check('S1b 归因=THIRD_PARTY_AUTH_SURFACE_UNAUTHORIZED（不继承主站凭据授权）',
      v.reason === 'THIRD_PARTY_AUTH_SURFACE_UNAUTHORIZED', 'reason=' + v.reason);
    check('S1c 判定携带证据说明', Array.isArray(v.evidence) && v.evidence.length > 0, JSON.stringify(v.evidence));
    // 同域（锚点）必须放行 —— 安全闸不得把正常工作流一起挡死
    const ok = credentialAuthorization.authorize({
      context: ctx, pageUrl: ANCHOR, action: pwd, challenge: null,
    });
    check('S2 锚点 origin 上同一凭据动作仍放行（无误杀）', ok.allowed === true, JSON.stringify(ok.reason));
    // 非 OAuth 特征但确属跨注册域 → 仍必须拒绝（不能让「不是 OAuth 面」成为缺口）
    const cross = credentialAuthorization.authorize({
      context: ctx, pageUrl: 'https://other-brand.example.org/login', action: pwd, challenge: null,
    });
    check('S3 无 OAuth 特征的另一注册域 → 仍拒绝（ORIGIN_NOT_AUTHORIZED）',
      cross.allowed === false && cross.reason === 'ORIGIN_NOT_AUTHORIZED', 'reason=' + cross.reason);
    credentialAuthorization.resetContexts();
  }

  // ── 1) 真实双 origin 服务：主站 + 第三方 OAuth 域（端口不同 = origin 不同）──
  const srvMain = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(MAIN_PAGE);
  });
  const srvIdp = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(OAUTH_PAGE);
  });
  await listenSafe(srvMain, '127.0.0.1');
  await listenSafe(srvIdp, '127.0.0.1');
  const portMain = srvMain.address().port;
  const portIdp = srvIdp.address().port;
  const MAIN_URL = 'http://127.0.0.1:' + portMain + '/signup';
  // 第三方授权面：真实 OAuth 特征查询串（client_id + return_to 指回 oauth/authorize）
  const IDP_URL = 'http://127.0.0.1:' + portIdp
    + '/login?client_id=Iv1.abcdef&return_to=%2Flogin%2Foauth%2Fauthorize%3Fclient_id%3DIv1.abcdef';

  // ── 2) 真实 Chromium + session 注入（真实 runtime 主循环）────────────────
  const profileId = 'p_c107_r6_' + Date.now().toString(36);
  db.upsertProfile({ id: profileId, name: 'c107 R6 replay', os: 'windows' });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  browserManager.__setSessionForTest(profileId, { browser, context, page });

  const seen = [];
  const origEmit = events.emit;
  events.emit = function patched(e) { try { if (e) seen.push(e); } catch (_) {} return origEmit.apply(events, arguments); };

  // repair 调用计数：R6 要求「禁止继续 repair」。真实 repairManager 会被调用（这是生产链路），
  // 但 runtime 必须在安全闸拒绝后**不进入** repair 分支 —— 计数器就是这句断言的证据。
  const repairCalls = [];
  const repairManager = require(path.join(ROOT, 'agent', 'repair', 'repairManager'));
  const origHandle = repairManager.handleStepFailure;
  repairManager.handleStepFailure = async function patched(args) {
    repairCalls.push({ stepId: args && args.step && args.step.id, at: Date.now() });
    return { paused: false, ok: false, category: 'CREDENTIAL_ACTION_BLOCKED', usedMemory: false, repairStats: {} };
  };

  const holder = {};
  try {
    const task = taskManager.createTask({
      name: 'c107 R6 cross-origin replay',
      objective: 'Sign up on the site with the work email and a password',
      targetUrl: MAIN_URL, // 锚点 = 主站（唯一被授权的 origin）
      profileId,
      executionMode: 'AUTO',
      policy: {},
      budget: {},
      constraints: [],
      secretRefs: [],
      createdBy: 'c107',
      // 刻意不声明任何额外授权：R6 的定义就是「没有 explicit authorization」
    });
    holder.id = task.id; // ⚠️ createTask 忽略传入 id：必须用返回的真实 id

    taskManager.attachPlan(task.id, {
      goal: 'sign up',
      steps: [
        mkNav('step_000', MAIN_URL, '/signup'),
        mkNav('step_001', IDP_URL, '/login'), // 误点第三方授权入口后的真实漂移
        PLAN_EMAIL,
        PLAN_PASSWORD,
      ],
    });
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

  const taskId = holder.id;
  const task = taskManager.getTask(taskId);
  const steps = stepManager.listSteps(taskId);
  const attempts = store.findWhere('aiAttempts', (a) => a.taskId === taskId);
  const fillsOf = (field) => attempts.filter((a) => a && a.action && a.action.type === 'fill'
    && a.action.target && a.action.target.field === field);
  const emailFills = fillsOf('email');
  const pwdFills = fillsOf('password');

  const blockedEvents = seen.filter((e) => e.type === 'agent.credential_action_blocked');
  const reloadEvents = seen.filter((e) => /reload/i.test(String(e.type || ''))
    || (e.payload && /reload/i.test(String(e.payload.strategy || e.payload.action || ''))));

  const pageVal = async (sel) => {
    try { return await page.evaluate((s) => (document.querySelector(s) || {}).value, sel); } catch (e) { return '<err>'; }
  };
  const pwdInPage = await pageVal('#password');
  const emailInPage = await pageVal('#email');

  console.log('\n--- 现场数据 ---');
  console.log('task.status=' + (task && task.status));
  console.log('task.reason=' + (task && task.error && (task.error.message || task.error)));
  console.log('steps=' + JSON.stringify(steps.map((s) => ({ i: s.index, id: s.id, st: s.status }))));
  console.log('emailFills=' + emailFills.length + ' passwordFills=' + pwdFills.length);
  console.log('repairCalls=' + repairCalls.length + ' blockedEvents=' + blockedEvents.length + ' reloadEvents=' + reloadEvents.length);
  console.log('finalUrl=' + (page && page.url && page.url()));
  console.log('passwordFieldValue=' + JSON.stringify(pwdInPage));
  console.log('blocked reasons=' + JSON.stringify(blockedEvents.map((e) => e.payload && e.payload.reason)));
  console.log('event types=' + JSON.stringify([...new Set(seen.map((e) => e.type))].slice(0, 30)));

  // ── A) 产生安全 evidence（CREDENTIAL_ACTION_BLOCKED + 跨域未授权归因）──────
  check('A1 产生 agent.credential_action_blocked 安全事件', blockedEvents.length >= 1,
    'count=' + blockedEvents.length);
  check('A1b 事件归因为跨域未授权族（THIRD_PARTY_AUTH_SURFACE_UNAUTHORIZED / ORIGIN_NOT_AUTHORIZED）',
    blockedEvents.some((e) => e.payload && /THIRD_PARTY_AUTH_SURFACE_UNAUTHORIZED|ORIGIN_NOT_AUTHORIZED/.test(String(e.payload.reason))),
    JSON.stringify(blockedEvents.map((e) => e.payload && e.payload.reason)));
  check('A1c 事件记录当前页 origin 与锚点 origin（可追溯）',
    blockedEvents.some((e) => e.payload && e.payload.pageOrigin && e.payload.anchorOrigin
      && e.payload.pageOrigin !== e.payload.anchorOrigin),
    JSON.stringify(blockedEvents.map((e) => e.payload && { p: e.payload.pageOrigin, a: e.payload.anchorOrigin })));
  const blocks = (task && task.securityBlocks) || [];
  check('A2 落库安全证据 task.securityBlocks（kind=CREDENTIAL_ACTION_BLOCKED）',
    blocks.length >= 1 && blocks[blocks.length - 1].kind === 'CREDENTIAL_ACTION_BLOCKED',
    'blocks=' + JSON.stringify(blocks.slice(-2)));
  check('A2b 安全证据不含任何凭据值',
    !/operator@example\.com|S3cret/.test(JSON.stringify(blocks)), JSON.stringify(blocks.slice(-1)));

  // ── B) 凭据未落入第三方域输入框（核心安全断言）───────────────────────────
  check('B1 第三方域页面上 password 输入框为空（凭据未外泄）',
    pwdInPage === '' || pwdInPage === undefined || pwdInPage === null,
    'value=' + JSON.stringify(pwdInPage));
  check('B2 第三方域页面上 email 输入框为空（闸门对 email 同样生效）',
    emailInPage === '' || emailInPage === undefined || emailInPage === null,
    'value=' + JSON.stringify(emailInPage));

  // ── C) 禁止继续尝试 / 继续 fill（attempt 计数就是「尝试」的物理证据）────────
  check('C1 password fill 未继续尝试（R6 现场为 4 次）', pwdFills.length <= 2,
    'password fill attempts=' + pwdFills.length);
  check('C1b 跨域 email fill 未被反复尝试', emailFills.length <= 2,
    'email fill attempts=' + emailFills.length);
  check('C1c 未发生同一凭据动作的重复提交（attempt ≤ 步数×2）',
    pwdFills.length + emailFills.length <= 4,
    'total fill attempts=' + (pwdFills.length + emailFills.length));

  // ── D) 禁止继续 repair（runtime 必须在安全闸拒绝后立刻收口）──────────────
  check('D1 未进入 repair 编排（CREDENTIAL_ACTION_BLOCKED 不走 repair）', repairCalls.length === 0,
    'repairCalls=' + repairCalls.length);

  // ── E) 禁止无限 reload ─────────────────────────────────────────────────
  check('E1 未发生无限 reload 循环（reload 事件 ≤ 1）', reloadEvents.length <= 1,
    'reload-ish events=' + reloadEvents.length);

  // ── F) 显式终态交人（不是悬挂 RUNNING，也不是 SUCCESS）───────────────────
  check('F1 任务收敛到显式终态（无悬挂 RUNNING）',
    task && ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(task.status),
    'status=' + (task && task.status));
  check('F2 安全阻断不被判为 SUCCESS', !task || task.status !== 'SUCCESS',
    'status=' + (task && task.status));
  check('F3 终态归因指向凭据安全闸',
    !!task && /CREDENTIAL_ACTION_BLOCKED|凭据安全闸/.test(String((task.error && (task.error.message || task.error)) || '')),
    'reason=' + String((task.error && (task.error.message || task.error)) || '').slice(0, 200));

  // ── G) 有限时间内收口（R6 现场为长循环）────────────────────────────────
  const elapsed = (task && task.startedAt && task.finishedAt) ? (task.finishedAt - task.startedAt) : null;
  check('G1 在有限时间内收口（< 120s，远小于 R6 长循环）',
    elapsed !== null && elapsed < 120000, 'elapsedMs=' + elapsed);

  // ── 清理 ───────────────────────────────────────────────────────────────
  try { browserManager.__setSessionForTest(profileId, null); } catch (e) {}
  try { await context.close(); } catch (e) {}
  try { await browser.close(); } catch (e) {}
  try { db.deleteProfile(profileId); } catch (e) {}
  credentialAuthorization.resetContexts();
  srvMain.close();
  srvIdp.close();

  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e && e.stack); process.exit(1); });
