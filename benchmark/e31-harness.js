'use strict';

// E3.1-A Acceptance Harness（确定性，不依赖 LLM / 真实浏览器挂死）。
// 目标：验证「单次浏览器工具调用异常/超时/上下文失效 → 工具层拒绝 → executor 失败
//       → repairManager 失败 → runtime fail/escalate → 终态」，绝不让 Runtime 永久 RUNNING。
//
// 做法：在 browserManager 边界 monkey-patch humanType 模拟「CDP 调用永久不返回」（即诊断定位的冻结点），
// 再驱动 tools.execute(fill) 与真实 Runtime 的 ELEMENT_NOT_FOUND → AUTO_REPAIR 路径，
// 断言：工具层在 TOOL_OP_TIMEOUT_MS 内拒绝，且任务最终为终态而非 RUNNING。
//
// 红线：不改动 Planner / Plan Schema / verification / retry / GroundTruth / mockSite /
//       elementChanged 语义 / Plan Bridge。仅观测 + 边界 monkey-patch（测试替身）。

const path = require('path');
const agentRoot = path.join(__dirname, '..', 'server', 'agent');
const serverRoot = path.join(__dirname, '..', 'server');

const taskManager = require(path.join(agentRoot, 'taskManager'));
const stepManager = require(path.join(agentRoot, 'stepManager'));
const { schedulerLoop } = require(path.join(agentRoot, 'execution'));
const runtime = require(path.join(agentRoot, 'runtime'));
const browserManager = require(path.join(serverRoot, 'browserManager'));
const tools = require(path.join(agentRoot, 'tools'));
const db = require(path.join(serverRoot, 'db'));

require(path.join(agentRoot, 'provider.mock'));
const mockApp = require('./mockSite').buildApp();

const TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'];

// 模拟诊断定位的「冻结点」：CDP/浏览器调用永久不返回（page.evaluate / page.type 僵死）。
// 用 E31_FREEZE=1 开启。关闭时（默认）走正常 humanType（但本 harness 不需要真浏览器，
// 因为我们用 monkey-patch 的 fakePage + 替身 humanType，不启动真实 Chromium）。
let FREEZE = process.env.E31_FREEZE === '1';

// 替身 humanType：FREEZE 模式永不 resolve（模拟 CDP 挂死）；否则立即返回。
let humanTypeCalls = 0;
browserManager.humanType = async function fakeHumanType(page, selector, text, opts) {
  humanTypeCalls++;
  if (FREEZE) {
    // 模拟诊断定位的 page.keyboard.type 永久 pending（CDP 僵死）
    return new Promise(() => {});
  }
  return; // 正常返回
};

// 用一个 fakePage 驱动 tools.execute 的单测，避免启动真实浏览器。
// fakePage 暴露 tools.runTool 内用到的所有方法；FREEZE 时让 isClosed=false 但 humanType 挂死，
// 以验证「event loop 可运行但调用永久 pending」场景下工具层 timeout 能否收口。
function makeFakePage() {
  const closed = { v: false };
  const fakePage = {
    isClosed: () => closed.v,
    url: () => 'http://mock.local/',
    title: async () => 'mock',
    goto: async () => {},
    reload: async () => {},
    goBack: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => 'b64',
    keyboard: { press: async () => {}, type: async () => {} },
    mouse: { move: async () => {}, wheel: async () => {}, down: async () => {}, up: async () => {} },
    evaluate: async () => ({}),
    locator: () => ({ first: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }) }) }),
    check: async () => {},
    selectOption: async () => {},
    _markClosed: () => { closed.v = true; },
  };
  return fakePage;
}

// 把 fakePage 注入到 taskManager 的 session（tools.getPageFor 通过 browserManager.getSession）
// 但 tools 用 page 来自 resolved.page = session.page。我们改为直接调 tools.execute 的底层
// 需要 page 来自 getPageFor → taskManager.getTask(taskId).profileId → browserManager.getSession。
// 简化：直接给 browserManager.getSession 一个返回 fakePage 的替身（仅本 harness）。
const REAL_getSession = browserManager.getSession;
browserManager.getSession = function (profileId) {
  if (profileId === 'e31-fake-profile') {
    return { page: makeFakePage(), context: {}, fp: {}, proxy: null, profileId };
  }
  return REAL_getSession.call(this, profileId);
};

async function waitFinal(taskId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = taskManager.getTask(taskId);
    if (t && TERMINAL.includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  return taskManager.getTask(taskId) || { status: 'TIMEOUT' };
}

(async () => {
  console.log('[E31-harness] start; FREEZE=' + FREEZE);
  const results = [];
  const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log('  ' + (pass ? 'PASS' : '⛔ FAIL') + '  ' + name + (detail ? '  ' + detail : '')); };

  // ---------- 单测 1：tools.runTool(fill) 直接走冻结 humanType，验证 withBrowserOp 在 TOOL_OP_TIMEOUT 内拒绝 ----------
  {
    const TOOL_OP_TIMEOUT_MS = Number(process.env.TOOL_OP_TIMEOUT_MS) || 25000;
    const fakePage = makeFakePage();
    const t0 = Date.now();
    let r;
    try {
      // runTool 内部走 resolveSelector（fakePage 无元素 → 命中语义路径需 observation.inspect(fakePage) 返回空 →
      // resolveSelector 返回 null → 直接 RESULT.error ELEMENT_NOT_FOUND，不进 humanType）。
      // 为强制进入 humanType，给它一个显式 selector 绕过语义解析。
      r = await tools.runTool(
        { type: 'fill', target: { selector: '#s', field: 'q' }, value: 'test', risk: 'LOW' },
        { page: fakePage },
        { taskId: 'x' }
      );
    } catch (e) {
      r = { success: false, error: { code: e.code || 'THROW', message: String(e.message || e).slice(0, 120) } };
    }
    const elapsed = Date.now() - t0;
    const failed = !r.success;
    const within = elapsed < TOOL_OP_TIMEOUT_MS + 3000;
    if (FREEZE) {
      // 冻结模式：断言工具层拒绝且归类为超时/上下文失效
      record('E31-1-A tools.runTool.fill 冻结下返回失败(非挂死)', failed, 'success=' + r.success + ' code=' + (r.error && r.error.code));
      record('E31-1-B tools.runTool.fill 在 TOOL_OP_TIMEOUT 内返回', within, 'elapsed=' + elapsed + 'ms limit=' + TOOL_OP_TIMEOUT_MS);
      record('E31-1-C 冻结调用被归类为超时/上下文失效', ['BROWSER_TIMEOUT', 'BROWSER_CONTEXT_LOST', 'TOOL_EXECUTION'].includes(r.error && r.error.code), 'code=' + (r.error && r.error.code));
    } else {
      // 非冻结模式：断言工具层正常成功且快速返回（无回归）
      record('E31-1-A tools.runTool.fill 正常下成功', r.success, 'success=' + r.success);
      record('E31-1-B tools.runTool.fill 快速返回(无回归)', within, 'elapsed=' + elapsed + 'ms');
    }
  }

  // ---------- 单测 2：task 维度 ELEMENT_NOT_FOUND → AUTO_REPAIR → 终态（不 RUNNING）----------
  {
    const mockServer = await new Promise((res) => { const s = mockApp.listen(0, () => res(s)); });
    const mockUrl = 'http://localhost:' + mockServer.address().port;
    const sched = schedulerLoop.getInstance();
    if (typeof sched.start === 'function') sched.start();

    const profileId = 'e31-fake-profile'; // 走 fakePage 替身
    const created = taskManager.createTask({
      name: 'e31-harness',
      objective: 'fill search box then submit',
      targetUrl: mockUrl + '/',
      profileId,
      executionMode: 'AUTONOMOUS',
    });
    created.category = 'search';

    // Step0 navigate（fakePage 永远成功）；Step1 fill（触发 ELEMENT_NOT_FOUND → AUTO_REPAIR → humanType 冻结）
    // 用真实 Plan: fill 动作 + element_present 验证（mock 首页无此元素 → ELEMENT_NOT_FOUND）
    const planSteps = [
      {
        id: 'nav', description: '打开首页', type: 'NAVIGATE',
        action: { type: 'navigate', target: { url: mockUrl + '/' }, risk: 'LOW', verification: { type: 'page_change' } },
        verification: { type: 'page_change' }, retryable: true, maxRetries: 3,
      },
      {
        id: 'fill', description: '填写搜索框', type: 'INPUT',
        action: { type: 'fill', target: { field: 'q', semantic: '搜索输入框' }, value: 'hello', risk: 'LOW', verification: { type: 'element_present', expect: 'q' } },
        verification: { type: 'element_present', expect: 'q' }, retryable: true, maxRetries: 3,
      },
    ];
    planSteps.forEach((s, i) => stepManager.createStep(created.id, s, i));
    sched.submit(created.id, { profileId, category: 'NORMAL' });

    const final = await waitFinal(created.id, 120000);
    const terminal = TERMINAL.includes(final.status);
    const notRunning = final.status !== 'RUNNING' && final.status !== 'TIMEOUT';
    record('E31-2-A ELEMENT_NOT_FOUND→AUTO_REPAIR→终态', terminal, 'status=' + final.status);
    record('E31-2-B runtimeStatus ≠ RUNNING', notRunning, 'status=' + final.status);
    record('E31-2-C 终态 ∈ {FAILED,HUMAN_ESCALATION,SUCCESS}', ['FAILED', 'HUMAN_ESCALATION', 'SUCCESS'].includes(final.status), 'status=' + final.status);
    mockServer.close();
  }

  const allPass = results.every((r) => r.pass);
  console.log('\n[E31-harness]', allPass ? 'ALL PASS ✅' : 'HAS FAIL ⛔', '| FREEZE=' + FREEZE);
  process.exit(allPass ? 0 : 3);
})().catch((e) => {
  console.error('[E31-harness] 异常:', e && e.stack ? e.stack : e);
  process.exit(2);
});
