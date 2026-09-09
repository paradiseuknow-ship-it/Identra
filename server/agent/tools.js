'use strict';

// Browser Tool Layer：AI/Browser 之间唯一入口。
// 禁止 runtime 直接 page.click() / page.evaluate()；一切浏览器操作必须经此层。
// 每个 Tool：validate Action → Policy Check → Resource Lock Check → browserManager/human API
//          → Recorder → Event → 返回统一结果 { success, result, observation, error }。

const browserManager = require('../browserManager');
// resolveUploadPath：upload 的文件路径白名单（schema 校验一次，这里是执行前的最后一道门）
const { validateAction, resolveUploadPath } = require('./schema/action');
const policy = require('./policy');
const lock = require('./lock');
const events = require('./events');
const recorder = require('./recorder');
const observation = require('./observation');
const semanticResolver = require('./semanticResolver');
const verification = require('./verification');
const pageStateClassifier = require('./pageStateClassifier');
const contextGuard = require('./contextGuard');
const pageReady = require('./pageReady');
const secretManager = require('./secretManager');
// CAP-L1：通用支付字段识别与取值（只有这里能决定「卡号的哪一段填进哪个框」）
const paymentField = require('./paymentField');
const elementMemory = require('./intelligence/elementMemory');
const taskManager = require('./taskManager');
const evidence = require('./evidence');
const fs = require('fs');
const path = require('path');

// 统一返回结构（Phase 3 契约）：{ success, result, observation, error, action, url, timestamp, screenshot }。
// 失败路径 error 必为结构化 { code, message }，且禁止 undefined（避免掩盖原始失败）。
const RESULT = {
  error: (code, message) => ({ success: false, result: null, observation: null, beforeObservation: null, error: { code, message }, action: null, url: null, timestamp: Date.now(), screenshot: null }),
  ok: (result, observation, beforeObservation) => ({ success: true, result, observation, beforeObservation: beforeObservation || null, error: null, action: null, url: null, timestamp: Date.now(), screenshot: null }),
};

// ---- 5.9-E3.1 浏览器工具调用边界防护 ----
// 目标（唯一）：任何单次浏览器工具调用发生异常 / 超时 / 上下文失效时，都必须能够
//   返回 Runtime，由既有 failure finalization（runtime.js 的 REPAIR_TIMEOUT / fail / escalate）收口，
//   绝不让一次 page.* / CDP 调用把整个 Runtime 永久悬挂在 RUNNING。
//
// 设计约束（来自授权边界，禁止用更多 JS timeout 掩盖冻结）：
//   1) 不靠 Promise.race([browserCall, timeout]) 去"杀掉" page.evaluate / page.type —— 若底层真冻结
//      事件循环，race 的 timer 自己也不调度，毫无意义。
//   2) 优先用 Playwright 自身 timeout + 上下文生命周期检测（page.isClosed() / session 是否已从
//      browserManager 移除）做"快速失败"，让异常正常回到 JS 调用方。
//   3) 仅对「自身含循环、可能无限 await」的拟人化函数（humanType/humanClick/humanScroll）加
//      纯 JS 总时长上限——这是能 throw 的边界，覆盖"慢调用但 event loop 仍可运行"场景。
//   4) 所有受保护调用的失败都归一成 TOOL_EXECUTION / BROWSER_CONTEXT_LOST / BROWSER_TIMEOUT，
//      由 runTool 的 try/catch 接住 → 回到 executor → repairManager → runtime.fail/escalate。

// 工具级操作超时：短于 Playwright 默认 30s 与 runtime REPAIR_TIMEOUT(90s)，
// 让浏览器层先于两者失败并回到 Runtime 收口。
// C100：默认 25s 会把 schema 导航族 30s（C100 action.js）拦腰截断 —— e2e 实证
// "navigate 超时（>25000ms）"先于动作自身超时触发，同一不一致性的第二层。
// 提升默认到 45s：> 导航族 30s 动作超时，< REPAIR_TIMEOUT(90s) 与动态步看门狗
// （max(30s, timeoutMs+25s) ≥ 55s）。env 仍可覆盖。
const TOOL_OP_TIMEOUT_MS = Number(process.env.TOOL_OP_TIMEOUT_MS) || 45000;

// 检测页面/上下文是否已失效：失效则立即抛，避免把请求发往已死的 CDP 连接（那是挂死高发区）。
function assertPageAlive(page) {
  let closed = false;
  try { if (page && typeof page.isClosed === 'function') closed = page.isClosed(); } catch (e) { closed = true; }
  if (closed) {
    const err = new Error('页面/上下文已关闭（渲染进程崩溃或浏览器断开）');
    err.code = 'BROWSER_CONTEXT_LOST';
    throw err;
  }
  // C71 D3：原此处有一段不可靠 session 探测死代码（const sess = ... 求值后即弃），
  // 求值恒 null 且无副作用 —— 删除；session 失效检测由 disconnected 守卫在 browserManager 层负责。
  return true;
}

// 包裹一次浏览器调用：先判定上下文是否存活，再用「操作超时」约束。
// 注意：这里的 timeout 用于"慢调用但 event loop 仍可运行"场景；真冻结时它无效（用户已明确：
//   Promise.race 无法杀掉冻结 event loop），但上下文检测（assertPageAlive）能在进入前快速失败，
//   大幅降低冻结概率。对"event loop 仍存活但调用永久 pending"的慢挂死，此 timeout 负责收口。
// 重要：timeout timer 不可 unref —— 否则当它是唯一存活句柄时 Node 会直接退出（已踩坑验证），
//   且 unref 会削弱其"强制超时"语义。成功路径需 clearTimeout 避免空转。
// 取消支持（P0-6）：taskId 传入时，每个操作边界检查任务是否已 CANCELLED，立即中断当前操作，
// 避免取消后浏览器动作继续跑完。不依赖 race 杀冻结 event loop，仅作操作边界的快速失败。
// 注意：调用方统一为 (label, page, taskId, opFn) —— opFn 为真实浏览器操作函数，taskId 为字符串。
// 以下参数顺序必须与调用方一致（历史曾写反 opFn/taskId，导致真实操作从不执行、并抛
// "Cannot read properties of undefined (reading 'observation')" 掩盖原始错误）。
async function withBrowserOp(label, page, taskId, taskFn) {
  if (taskId) {
    const t = taskManager.getTask(taskId);
    if (t && t.status === 'CANCELLED') {
      const e = new Error('任务已取消，中断浏览器操作');
      e.code = 'CANCELLED';
      throw e;
    }
  }
  assertPageAlive(page); // 进入前快速失败（上下文已失效时不会发往 CDP）
  let timer = null;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} 超时（>${TOOL_OP_TIMEOUT_MS}ms）`);
      e.code = 'BROWSER_TIMEOUT';
      reject(e);
    }, TOOL_OP_TIMEOUT_MS);
  });
  try {
    // 二次检测：进入实际调用前再判一次，避免 race 间隙内上下文刚好失效
    assertPageAlive(page);
    return await Promise.race([Promise.resolve().then(taskFn), timeoutP]);
  } catch (e) {
    // 无论超时还是调用抛错，统一再判一次上下文：若已关闭则归类为 BROWSER_CONTEXT_LOST
    let closed = false;
    try { if (page && typeof page.isClosed === 'function') closed = page.isClosed(); } catch (_) {}
    if (closed && e.code !== 'BROWSER_CONTEXT_LOST') {
      const ne = new Error('页面/上下文在操作期间关闭（渲染进程崩溃）');
      ne.code = 'BROWSER_CONTEXT_LOST';
      throw ne;
    }
    const ne = new Error(`[${label}] ${e.message || e}`);
    ne.code = e.code || 'TOOL_EXECUTION';
    throw ne;
  } finally {
    if (timer) clearTimeout(timer);
  }
}


// Phase 9 P2 — 可触发控件判定（最小 executable precondition：可触发 + 未禁用）。
//
// 数据依据（phase68 100-task）：7 个任务（rw.035/042/045/076/080/092/099）对
// ecommerce/search.html 执行 submit，该页面搜索由 button#searchBtn 的 click 处理器触发。
// 但语义排序把 input#q（field='search' 精确命中 id='q' → 1.0）排在
// button#searchBtn（0.95）之前，agent 于是「点击了输入框」，页面从未渲染结果，
// 后续 text_present 验证正确失败并被记为「动作成功但目标未观察到」。
// 这是排序缺口（候选都存在、排序选错），不是验证过严 —— 因此修排序，不动验证阈值。
//
// 作用域仅限 submit/login/logout 这类「必须触发一个控件」的动作；
// 且只在「已发现的候选」内部重排，不做新发现、不做重试、不做兜底猜测。
function isActionableControl(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.state && el.state.disabled === true) return false; // enabled
  const tag = String(el.tag || '').toLowerCase();
  const role = String(el.role || '').toLowerCase();
  const type = String(el.type || '').toLowerCase();
  if (tag === 'button' || role === 'button') return true;
  if (tag === 'input' && ['submit', 'button', 'image'].includes(type)) return true;
  if (role === 'submit' || role === 'link' || tag === 'a') return true;
  if (tag === 'summary' || role === 'menuitem' || role === 'tab') return true;
  return false;
}

// 从 URL 提取站点（hostname），用于记忆键控
function siteFromUrl(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch (e) { return null; }
}

function getPageFor(taskId) {
  const task = taskManager.getTask(taskId);
  if (!task || !task.profileId) return { error: '任务未绑定 Profile' };
  const session = browserManager.getSession(task.profileId);
  if (!session) return { error: 'Profile 浏览器未运行（任务未启动或被关闭）' };
  return { task, session, page: session.page };
}

// 统一的执行管线
async function execute(input) {
  const { action: rawAction, taskId, executionId } = input;

  // 1) Action 校验（防御性二次校验）
  const v = validateAction(rawAction);
  if (!v.ok) return RESULT.error('ACTION_INVALID', v.errors.join('; '));

  const task = taskManager.getTask(taskId);
  if (!task) return RESULT.error('TASK_NOT_FOUND', '任务不存在');

  // 2) Policy Check
  const decision = policy.allowsAction(v.action, task);
  if (!decision.allowed) {
    if (decision.requiresApproval) {
      // 通知 pause 由 runtime 处理；此处返回需审批信号
      return RESULT.error('ACTION_REQUIRES_APPROVAL', decision.reason);
    }
    return RESULT.error('ACTION_BLOCKED', decision.reason);
  }

  // 3) Resource Lock Check
  if (task.profileId) {
    const key = lock.resourceKeyForProfile(task.profileId);
    const owner = lock.getOwner(key);
    if (!owner || owner.executionId !== executionId) {
      return RESULT.error('RESOURCE_LOCK', '当前 execution 未持有 Profile 锁');
    }
  }

  // 4) 解析页面
  const resolved = getPageFor(taskId);
  if (resolved.error) return RESULT.error('NO_BROWSER', resolved.error);

  const startTs = Date.now();

  // 4.5) Phase 6.2 动作上下文守卫：仅阻止「明显错误上下文」执行，绝不自动判成功（fail-open）。
  {
    let pageStateObs = null;
    try {
      pageStateObs = await withBrowserOp('guard.inspect', resolved.page, taskId, () => observation.inspect(resolved.page, { taskId, skipCache: true }));
    } catch (e) { pageStateObs = null; }
    if (pageStateObs && pageStateObs.observation) {
      const ps = pageStateClassifier.classify(pageStateObs.observation);
      // STEP 1 去站点化：守卫不再接收「期望站点」，只接收可观察的页面能力。
      // 动作目标（upload/download/payment/auth/registration）由动作本身推导，属通用 Web 语义。
      const actionGoal = contextGuard.deriveActionGoal(v.action);
      const g = contextGuard.guard(v.action, ps, { observation: pageStateObs.observation });
      // 只读 telemetry：守卫决策留痕，供归因分析（不改变任何行为语义）。
      const guardTelemetry = {
        pageState: ps.state,
        pageStateConfidence: ps.confidence,
        pageCapabilities: ps.capabilities || [],
        actionGoal,
        guardMode: g.guardMode || (g.blocked ? 'blocked' : 'pass'),
        goal: g.goal || null,
        evidence: g.evidence || null,
      };
      if (g.blocked) {
        recorder.recordAction(executionId, {
          stepId: input.stepId, attemptId: input.attemptId, action: v.action,
          status: 'BLOCKED', error: g.reason, durationMs: Date.now() - startTs,
        });
        events.emit({ taskId, executionId, stepId: input.stepId, attemptId: input.attemptId, type: 'ai.action.completed', payload: { ok: false, error: g.code, guard: { ...guardTelemetry, blocked: true } } });
        return RESULT.error(g.code, g.reason);
      }
      events.emit({ taskId, executionId, stepId: input.stepId, attemptId: input.attemptId, type: 'ai.guard.passed', payload: { ...guardTelemetry, blocked: false } });
    }
  }
  events.emit({ taskId, executionId, stepId: input.stepId, attemptId: input.attemptId, type: 'ai.action.started', payload: { tool: v.action.type, risk: v.action.risk } });

  // Snapshot：动作后证据（非阻塞）
  let snapBefore = null;
  try { snapBefore = await evidence.saveSnapshot(resolved.page, taskId, input.stepId || 'step', 'before_action'); } catch (e) {}

  // runTool 返回完整 RESULT 对象 { success, result, observation, error }
  const meta = { taskId, executionId, selFromMemory: false, selPattern: null };
  let toolOut = null;
  try {
    toolOut = await runTool(v.action, resolved, meta);
  } catch (e) {
    const err = { code: 'TOOL_EXECUTION', message: String(e.message || e).slice(0, 300) };
    recorder.recordAction(executionId, {
      stepId: input.stepId, attemptId: input.attemptId, action: v.action,
      status: 'FAILED', error: err.message, durationMs: Date.now() - startTs,
    });
    events.emit({ taskId, executionId, stepId: input.stepId, attemptId: input.attemptId, type: 'ai.action.completed', payload: { ok: false, error: err.code } });
    const urlErr = (resolved.page && typeof resolved.page.url === 'function') ? resolved.page.url() : null;
    return { ...RESULT.error(err.code, err.message), observation: null, action: v.action || null, url: urlErr, timestamp: Date.now(), evidenceRef: { before: snapBefore, after: null } };
  }
  const observationRes = toolOut.observation;
  // 透传 resolver 命中信号（matchedBy），供 observability 持久化与取证（Phase 12B §十四）。
  if (meta && meta.matchedBy) toolOut.matchedBy = meta.matchedBy;

  // v0.2.2：为 before/after 观察补齐血缘 + Fresh 标记（Business Loop 专项 §五/§七）。
  // after-observation 在动作完成后立即采集，确为 Fresh Observation；before-observation 标记来源便于血缘链。
  const _enrich = (obs, source) => {
    if (!obs) return;
    obs.taskId = obs.taskId || input.taskId || null;
    obs.stepId = obs.stepId || input.stepId || null;
    obs.attemptId = obs.attemptId || input.attemptId || null;
    obs.source = obs.source || source;
    if (source === 'after_action') {
      obs.actionFinishedAt = obs.capturedAt || obs.timestamp || null;
      obs.fresh = true; // 动作完成后立即采集，确为 fresh
    }
  };
  // C71 D4：inspect/开合标签类工具把同一 observation 对象同时作为 before/after 返回
  //（同引用）。此时 before enrich 会先写入 source='before_action'，随后 after enrich 的
  // `obs.source || 'after_action'` 不再覆盖 —— 最终血缘矛盾（source=before_action 但 fresh=true）。
  // 同引用时只做 after enrich（该对象本质就是动作后的 fresh 观察）。
  if (toolOut.beforeObservation && toolOut.beforeObservation !== observationRes) {
    _enrich(toolOut.beforeObservation, 'before_action');
  }
  _enrich(observationRes, 'after_action');
  toolOut.finishedAt = (observationRes && (observationRes.capturedAt || observationRes.timestamp)) || Date.now();

  // Snapshot：动作后证据（非阻塞）
  let snapAfter = null;
  try { snapAfter = await evidence.saveSnapshot(resolved.page, taskId, input.stepId || 'step', 'after_action'); } catch (e) {}
  if (snapAfter) events.emit({ taskId, executionId, stepId: input.stepId, type: 'ai.snapshot', payload: { label: 'after_action', file: snapAfter } });

  // Element Memory：动作成功后【挂起待确认】，不再立即强化。
  // Phase 9 P3（记忆污染治理）：toolOut.success = 动作机械成功，而业务验证在其之后发生。
  //   实测「点击 input#q」机械成功 → 记忆记 +1，随后 text_present 验证失败 → 记忆既不撤销也不扣减，
  //   于是在 127.0.0.1|搜索表单 上累积出 confidence=1 / success=208 / failed=0 的【假成功记忆】，
  //   反过来持续把后续 submit 指错目标。element-level success ≠ business success。
  // 修法：此处只准备确认所需的信息，真正落库由 runtime 在【业务验证通过后】执行；
  //   验证失败则完全不强化（不改变验证语义本身，verification.verify 照旧调用）。
  let memoryConfirmation = null;
  if (toolOut.success && toolOut.result && toolOut.result.element) {
    try {
      const t = v.action.target || {};
      const semantic = t.semantic || t.field || t.text;
      const site = siteFromUrl(observationRes && observationRes.url);
      if (semantic && site) {
        memoryConfirmation = {
          site, semantic,
          element: toolOut.result.element,
          meta: { type: 'ai_success' },
          context: elementMemory.contextOf(observationRes),
          actionType: v.action.type,
          selector: (toolOut.result && toolOut.result.selector) || null,
        };
      }
    } catch (e) {}
  }
  // Element Memory：记忆命中却失败 → 误报统计（不绕过 policy/verification）
  if (!toolOut.success && meta.selFromMemory && observationRes) {
    try {
      const t = v.action.target || {};
      const semantic = t.semantic || t.field || t.text;
      const site = siteFromUrl(observationRes && observationRes.url);
      if (semantic && site) elementMemory.recordFailure(site, semantic, null, meta.selPattern);
    } catch (e) {}
  }

  recorder.recordAction(executionId, {
    stepId: input.stepId, attemptId: input.attemptId, action: v.action,
    status: toolOut.success ? 'SUCCESS' : 'FAILED', error: toolOut.error ? toolOut.error.message : null,
    durationMs: Date.now() - startTs,
  });
  events.emit({ taskId, executionId, stepId: input.stepId, attemptId: input.attemptId, type: 'ai.action.completed', payload: { ok: toolOut.success, tool: v.action.type } });
  const urlOut = (observationRes && observationRes.url) || (toolOut.result && toolOut.result.url) || null;
  return { ...toolOut, observation: observationRes, action: v.action || null, url: urlOut, timestamp: Date.now(), evidenceRef: { before: snapBefore, after: snapAfter }, memoryConfirmation };
}

// 将带 iframe 前缀的 selector（"iframe:nth-of-type(1) >> css=..."）解析为 Playwright Locator 链。
// 仅当 selector 含 " >> " 时才启用 frame 链路；普通主文档 selector 直接返回 page.locator（不影响单页路径）。
function makeLocator(page, selector) {
  const parts = String(selector).split(' >> ').map((s) => s.trim()).filter(Boolean);
  let cur = page;
  for (const part of parts) {
    if (part.startsWith('iframe')) cur = cur.frameLocator(part);
    else cur = cur.locator(part);
  }
  return cur;
}

// 带自超时的 locator 计数。探测类调用一律走这里：它们失败只应导致"退化到下一个候选"，
// 绝不能把 Runtime 挂住 —— 因此刻意不用 withBrowserOp（它超时会抛，
// 会把"没有增强信息"变成"动作失败"，与 fail-open 原则相反）。
async function probeCount(page, selector, ms = 3000) {
  let timer = null;
  const bail = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probeCount 探测超时')), ms); });
  try {
    return await Promise.race([page.locator(selector).count(), bail]);
  } catch (e) {
    return 0; // 选择器语法非法 / 超时 → 记为未命中
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// drag 的放置目标（action.value）：模型可能给 CSS 选择器、语义描述、或干脆给可见文字。
// 三级兜底，逐级放宽：
//   ① CSS 选择器 —— 最精确，模型直接给出时优先用；
//   ② 语义解析（复用 semanticResolver）—— 观察集里有该元素时可用；
//   ③ 文本引擎 —— 放置区常常是纯 <div> 容器，不可交互、无 role，observation 采不到
//      （即便已把 draggable="true" 收进来，放置区通常也不 draggable），
//      于是 ② 必然落空。而"拖到写着「回收站」的那块地方"恰恰是模型最自然的表达，
//      必须有出路。
async function resolveDropTarget(page, obs, value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  if ((await probeCount(page, v)) > 0) return v;
  const cands = semanticResolver.resolve({ semantic: v, text: v }, obs);
  if (cands && cands.length) return cands[0].selector;
  const textSel = 'text=' + v;
  if ((await probeCount(page, textSel)) > 0) return textSel;
  return null;
}

async function runTool(action, resolved, meta) {
  const { page } = resolved;

  switch (action.type) {
    case 'navigate': {
      const url = action.target.url || (action.target.semantic || '');
      if (!url) return RESULT.error('NO_URL', 'navigate 缺少 url');
      const beforeObs = await withBrowserOp('navigate.before', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      await withBrowserOp('navigate', page, meta.taskId, () => page.goto(url, { timeout: Math.min(action.timeoutMs || 30000, TOOL_OP_TIMEOUT_MS), waitUntil: 'domcontentloaded' }));
      await withBrowserOp('navigate.wait', page, meta.taskId, () => page.waitForTimeout(300));
      // Phase 6.4（E2）：等待 SPA 挂载/页面就绪后再采集 after-observation，避免空白页误判。
      await pageReady.waitForPageReady(page, { taskId: meta.taskId, timeoutMs: 8000 }).catch(() => {});
      const obs = await withBrowserOp('navigate.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ url: page.url() }, obs.observation, beforeObs.ok ? beforeObs.observation : null);
    }
    case 'inspect': {
      const obs = await withBrowserOp('inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      return RESULT.ok({ elementCount: (obs.observation && obs.observation.elements || []).length, cached: obs.cached }, obs.observation, obs.observation);
    }
    case 'wait': {
      await withBrowserOp('wait', page, meta.taskId, () => page.waitForTimeout(action.timeoutMs));
      return RESULT.ok({ waitedMs: action.timeoutMs }, null, null);
    }
    case 'scroll': {
      const deltaY = Number(action.value) || 400;
      // STEP 7：scroll 此前完全忽略 action.target，只滚主文档。
      // 真实站点上"把 iframe 里的列表/表单滚到可见"是刚需，而 schema 又强制要求 target ——
      // 于是 target 是个死参数。现在解析出目标就滚目标（frame 内用 scrollIntoViewIfNeeded，
      // 普通元素用 scrollBy），解析不出就退回原来的滚页面，既有行为不退化。
      let scrolled = 'page';
      const hasEl = Object.keys(action.target || {}).length > 0;
      if (hasEl) {
        const obs = await withBrowserOp('scroll.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
        const sel = await resolveSelector(action, obs.observation, meta, page);
        if (sel) {
          scrolled = sel.selector.indexOf(' >> ') >= 0 ? 'frame' : 'element';
          if (scrolled === 'frame') {
            await withBrowserOp('scroll.frame', page, meta.taskId, () => makeLocator(page, sel.selector).scrollIntoViewIfNeeded({ timeout: Math.min(action.timeoutMs || 15000, TOOL_OP_TIMEOUT_MS) }));
          } else {
            await withBrowserOp('scroll.element', page, meta.taskId, () => page.locator(sel.selector).evaluate((el, dy) => { if (el && typeof el.scrollBy === 'function') el.scrollBy(0, dy); }, deltaY));
          }
        }
      }
      if (scrolled === 'page') {
        await withBrowserOp('scroll', page, meta.taskId, () => browserManager.humanScroll(page, deltaY, {}));
      }
      const obsS = await withBrowserOp('scroll.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ deltaY, scrolled }, obsS.observation, null);
    }
    case 'press': {
      const key = action.value || 'Enter';
      // STEP 7：press 此前同样忽略 target，直接 page.keyboard.press() —— 键盘事件只发给当前焦点，
      // 因此「在 iframe 内的搜索框里按回车 / 在指定输入框里按 Tab」根本无法实现。
      // 现在先按 target 聚焦（跨 frame 走 makeLocator，与 click/fill 同一套寻址），
      // 解析不出来就退回全局按键，保证既有行为不退化。
      const obs = await withBrowserOp('press.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (sel) {
        await withBrowserOp('press.focus', page, meta.taskId, () => makeLocator(page, sel.selector).focus({ timeout: Math.min(action.timeoutMs || 10000, TOOL_OP_TIMEOUT_MS) }));
      }
      await withBrowserOp('press', page, meta.taskId, () => page.keyboard.press(key));
      await withBrowserOp('press.wait', page, meta.taskId, () => page.waitForTimeout(300));
      const obsP = await withBrowserOp('press.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ key, focused: sel ? sel.selector : null }, obsP.observation, obs.ok ? obs.observation : null);
    }
    case 'screenshot': {
      const b64 = await withBrowserOp('screenshot', page, meta.taskId, () => page.screenshot({ encoding: 'base64' }));
      return RESULT.ok({ screenshot: b64 }, null, null);
    }
    case 'getUrl':
      return RESULT.ok({ url: page.url() }, null, null);
    case 'getTitle':
      return RESULT.ok({ title: await page.title().catch(() => '') }, null, null);
    case 'extract': {
      const obs = await withBrowserOp('extract.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const cands = semanticResolver.resolve(action.target, obs.observation);
      return RESULT.ok({ extracted: cands[0] ? { selector: cands[0].selector, text: cands[0].el.text, score: cands[0].score } : null }, obs.observation, obs.observation);
    }
    case 'click': {
      const obs = await withBrowserOp('click.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const beforeObs = obs.ok ? obs.observation : null;
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到目标元素: ' + (action.target.semantic || action.target.field || action.target.text || '?'));
      await withBrowserOp('click', page, meta.taskId, () => {
        if (sel.selector.indexOf(' >> ') >= 0) return makeLocator(page, sel.selector).click();
        return browserManager.humanClick(page, sel.selector, {});
      });
      await withBrowserOp('click.wait', page, meta.taskId, () => page.waitForTimeout(300));
      const after = await withBrowserOp('click.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ clicked: sel.selector, element: sel.pattern }, after.observation, beforeObs);
    }
    // STEP 7 / CAP-F2：悬浮。真实网站大量导航在 mouseover 才展开（多级菜单、表格行操作、
    // 卡片 hover 按钮）。没有 hover 时，模型唯一的替代是去 click 一个尚未存在的元素，
    // 直接得到 ELEMENT_NOT_FOUND —— 这不是模型笨，是动作集缺了一半。
    case 'hover': {
      const obs = await withBrowserOp('hover.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const beforeObs = obs.ok ? obs.observation : null;
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到悬浮目标: ' + (action.target.semantic || action.target.text || '?'));
      // 统一走 makeLocator：跨 frame 的 ' >> ' 选择器同样可悬浮，不需另写分支
      await withBrowserOp('hover', page, meta.taskId, () => makeLocator(page, sel.selector).hover({ timeout: Math.min(action.timeoutMs || 15000, TOOL_OP_TIMEOUT_MS) }));
      // 悬浮的唯一目的是"把隐藏内容显示出来"，因此必须等一拍再采集：
      // 立刻 inspect 会抓到菜单展开前的中间态，等于这一步白做，后续 click 依旧找不到元素。
      await withBrowserOp('hover.wait', page, meta.taskId, () => page.waitForTimeout(400));
      const after = await withBrowserOp('hover.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ hovered: sel.selector, element: sel.pattern }, after.observation, beforeObs);
    }
    // STEP 7 / CAP-F2：拖拽。看板挪卡片、拖拽排序、拖拽上传区、滑块验证码后的排序题，
    // 都是"必须 drag 否则做不了"的场景。
    case 'drag': {
      const obs = await withBrowserOp('drag.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const beforeObs = obs.ok ? obs.observation : null;
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到拖拽源: ' + (action.target.semantic || action.target.text || '?'));
      const dst = await resolveDropTarget(page, obs.observation, action.value);
      if (!dst) return RESULT.error('DROP_TARGET_NOT_FOUND', '未找到拖拽放置目标: ' + String(action.value || '').slice(0, 120));
      // locator.dragTo(locator) 同时支持普通选择器与跨 frame 的 ' >> ' 选择器；
      // 不用 page.dragAndDrop，因为它只吃字符串选择器，跨 frame 必然失效。
      await withBrowserOp('drag', page, meta.taskId, () => makeLocator(page, sel.selector)
        .dragTo(makeLocator(page, dst), { timeout: Math.min(action.timeoutMs || 15000, TOOL_OP_TIMEOUT_MS) }));
      await withBrowserOp('drag.wait', page, meta.taskId, () => page.waitForTimeout(300));
      const after = await withBrowserOp('drag.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ dragged: sel.selector, droppedOn: dst, element: sel.pattern }, after.observation, beforeObs);
    }
    case 'reload': {
      const beforeObs = await withBrowserOp('reload.before', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      await withBrowserOp('reload', page, meta.taskId, () => page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(action.timeoutMs || 30000, TOOL_OP_TIMEOUT_MS) }));
      await withBrowserOp('reload.wait', page, meta.taskId, () => page.waitForTimeout(300));
      const obsR = await withBrowserOp('reload.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ reloaded: true }, obsR.observation, beforeObs.ok ? beforeObs.observation : null);
    }
    case 'back': {
      const beforeObs = await withBrowserOp('back.before', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      await withBrowserOp('back', page, meta.taskId, () => page.goBack({ waitUntil: 'domcontentloaded', timeout: Math.min(action.timeoutMs || 30000, TOOL_OP_TIMEOUT_MS) }).catch(() => {}));
      await withBrowserOp('back.wait', page, meta.taskId, () => page.waitForTimeout(300));
      const obsB = await withBrowserOp('back.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ back: true }, obsB.observation, beforeObs.ok ? beforeObs.observation : null);
    }
    case 'forward': {
      const beforeObs = await withBrowserOp('forward.before', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      await withBrowserOp('forward', page, meta.taskId, () => page.goForward({ waitUntil: 'domcontentloaded', timeout: Math.min(action.timeoutMs || 30000, TOOL_OP_TIMEOUT_MS) }).catch(() => {}));
      await withBrowserOp('forward.wait', page, meta.taskId, () => page.waitForTimeout(300));
      const obsF = await withBrowserOp('forward.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ forward: true }, obsF.observation, beforeObs.ok ? beforeObs.observation : null);
    }
    case 'openTab': {
      const url = (action.target && action.target.url) || '';
      const newPage = await browserManager.openPage(resolved.session.profileId, url);
      if (!newPage) return RESULT.error('TAB_OPEN_FAILED', '无法打开新标签页');
      const after = await withBrowserOp('openTab.inspect', newPage, meta.taskId, () => observation.inspect(newPage, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ opened: true, url: newPage.url(), pageCount: browserManager.getPages(resolved.session.profileId).length }, after.observation, after.observation);
    }
    case 'closeTab': {
      const t = action.target || {};
      const by = (typeof t.index === 'number') ? t.index : (t.url || null);
      const okClose = await browserManager.closePage(resolved.session.profileId, by);
      if (!okClose) return RESULT.error('TAB_CLOSE_FAILED', '无法关闭标签页');
      const activePage = await browserManager.getPage(resolved.session.profileId);
      const after = await withBrowserOp('closeTab.inspect', activePage || page, meta.taskId, () => observation.inspect(activePage || page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ closed: true, pageCount: browserManager.getPages(resolved.session.profileId).length }, after.observation, after.observation);
    }
    case 'switchTab': {
      const t = action.target || {};
      const by = (typeof t.index === 'number') ? t.index : (t.url || null);
      const sp = await browserManager.switchToPage(resolved.session.profileId, by);
      if (!sp) return RESULT.error('TAB_SWITCH_FAILED', '无法切换到目标标签页');
      const after = await withBrowserOp('switchTab.inspect', sp, meta.taskId, () => observation.inspect(sp, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ switched: true, url: sp.url(), pageCount: browserManager.getPages(resolved.session.profileId).length }, after.observation, after.observation);
    }
    case 'delete':
    case 'update_account_settings':
    case 'purchase':
    case 'payment':
    case 'password_change': {
      // 高风险业务触发动作：语义定位目标按钮/链接 → 拟人点击进入下一步。
      // schema 已强制这些类型必须提供有意义的 verification（防止盲执行）。
      const obs = await withBrowserOp('action.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const beforeObs = obs.ok ? obs.observation : null;
      let sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) {
        const semantic = action.target.semantic || action.target.field || action.target.text || action.type;
        const cands = semanticResolver.resolve(action.target, obs.observation);
        if (cands.length) { sel = { selector: cands[0].selector, pattern: elementMemory.patternOf(cands[0].el), semantic, fromMemory: false }; }
      }
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到动作目标: ' + (action.target.semantic || action.target.text || action.type));
      await withBrowserOp('action.click', page, meta.taskId, () => browserManager.humanClick(page, sel.selector, {}));
      await withBrowserOp('action.wait', page, meta.taskId, () => page.waitForTimeout(400));
      const after = await withBrowserOp('action.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ acted: action.type, selector: sel.selector, element: sel.pattern }, after.observation, beforeObs);
    }
    case 'fill': {
      const obs = await withBrowserOp('fill.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const beforeObs = obs.ok ? obs.observation : null;
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到输入目标: ' + (action.target.field || action.target.semantic || '?'));
      const fillCtx = { signals: await elementSignals(page, sel.selector) };
      const filled = await resolveFill(action, fillCtx);
      if (filled.value === null) {
        const credErr = credentialUnavailableError(action);
        if (credErr) return credErr; // 凭据不可用 → CREDENTIAL_UNAVAILABLE（转人工，不进 repair）
        if (filled.missingPaymentField) {
          // 凭据存在但缺这一段（例如存了卡号没存 CVV）→ 明确报错，绝不静默填空串
          return RESULT.error('CREDENTIAL_FIELD_MISSING',
            '凭据缺少支付字段 ' + filled.missingPaymentField + '（vault 未存该项），转人工处理');
        }
        return RESULT.error('NO_VALUE', 'fill 缺少 value 且 credentialRef 不可用');
      }
      const value = filled.value;
      await withBrowserOp('fill.type', page, meta.taskId, () => {
        if (sel.selector.indexOf(' >> ') >= 0) return makeLocator(page, sel.selector).fill(value);
        return browserManager.humanType(page, sel.selector, value, { baseDelay: 30, randomDelay: 60 });
      });
      // 凭据使用记录（不存值）—— 追溯"哪个账号用了哪个凭据"
      if (action.credentialRef) {
        try {
          secretManager.recordUsage({
            taskId: meta.taskId, credentialId: action.credentialRef,
            site: page.url(), fields: [action.target.field || 'unknown'], result: 'SUCCESS',
          });
        } catch (e) {}
      }
      const after = await withBrowserOp('fill.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ filled: sel.selector, element: sel.pattern }, after.observation, beforeObs);
    }
    case 'select': {
      const obs = await withBrowserOp('select.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const beforeObs = obs.ok ? obs.observation : null;
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到 select: ' + (action.target.field || '?'));
      await withBrowserOp('select', page, meta.taskId, () => {
        if (sel.selector.indexOf(' >> ') >= 0) return makeLocator(page, sel.selector).selectOption(action.value);
        return page.selectOption(sel.selector, action.value);
      });
      const after = await withBrowserOp('select.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ selected: sel.selector, element: sel.pattern }, after.observation, beforeObs);
    }
    case 'check': {
      const obs = await withBrowserOp('check.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const beforeObs = obs.ok ? obs.observation : null;
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到勾选目标');
      await withBrowserOp('check', page, meta.taskId, () => {
        if (sel.selector.indexOf(' >> ') >= 0) return makeLocator(page, sel.selector).check();
        return page.check(sel.selector);
      });
      const after =       await withBrowserOp('check.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ checked: sel.selector, element: sel.pattern }, after.observation, beforeObs);
    }
    case 'uncheck': {
      const obs = await withBrowserOp('uncheck.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const beforeObs = obs.ok ? obs.observation : null;
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到取消勾选目标');
      await withBrowserOp('uncheck', page, meta.taskId, () => {
        if (sel.selector.indexOf(' >> ') >= 0) return makeLocator(page, sel.selector).uncheck();
        return page.uncheck(sel.selector);
      });
      const after = await withBrowserOp('uncheck.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ unchecked: sel.selector, element: sel.pattern }, after.observation, beforeObs);
    }
    case 'upload': {
      // schema 已校验过白名单，这里再校验一次并顺带把相对路径解析成绝对路径。
      // 不能假设上游一定走了 schema：tools 是浏览器操作前的最后一道门，
      // 而 upload 是本产品里唯一"把本机文件内容送到远端"的动作，不可信输入必须拦在最后一刻。
      const up = resolveUploadPath((action.target && action.target.url) || action.value);
      if (!up.ok) return RESULT.error('UPLOAD_PATH_REJECTED', up.error);
      const filePath = up.abs;
      const obs = await withBrowserOp('upload.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到文件输入: ' + (action.target.field || action.target.semantic || '?'));
      await withBrowserOp('upload', page, meta.taskId, () => {
        if (sel.selector.indexOf(' >> ') >= 0) return makeLocator(page, sel.selector).setInputFiles(filePath);
        return page.locator(sel.selector).setInputFiles(filePath);
      });
      const after = await withBrowserOp('upload.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ uploaded: sel.selector, filePath, element: sel.pattern }, after.observation, obs.ok ? obs.observation : null);
    }
    case 'download': {
      const obs = await withBrowserOp('download.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const sel = await resolveSelector(action, obs.observation, meta, page);
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到下载触发元素');
      const downloadDir = path.join(__dirname, '..', 'data', 'downloads');
      try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (e) {}
      const timeout = Math.min(action.timeoutMs || 30000, TOOL_OP_TIMEOUT_MS);
      const downloadEvent = page.waitForEvent('download', { timeout });
      // C71 D2（B 类）：入口抛错守卫 —— 若外层 withBrowserOp('download.wait') 在入口就被
      // 拒绝（任务 CANCELLED / 页面已死），下方 taskFn 永不执行 → Promise.all 从未创建，
      // 这两个 promise 成浮动拒绝（Node 15+ unhandledRejection 默认崩溃整个 server 进程）。
      // 此处只挂「观察者 catch」打标已处理；原 promise 传入 Promise.all 的语义不变
      //（Promise.all 仍会收到真实拒绝并走 DOWNLOAD_FAILED 错误路径）。
      downloadEvent.catch(() => {});
      const trigger = withBrowserOp('download.trigger', page, meta.taskId, () => {
        if (sel.selector.indexOf(' >> ') >= 0) return makeLocator(page, sel.selector).click();
        return browserManager.humanClick(page, sel.selector, {});
      });
      trigger.catch(() => {});
      let download;
      try {
        [ download ] = await withBrowserOp('download.wait', page, meta.taskId, () => Promise.all([downloadEvent, trigger]));
      } catch (e) {
        return RESULT.error('DOWNLOAD_FAILED', '等待下载事件失败: ' + String(e.message || e).slice(0, 200));
      }
      let filePath = null, fileName = null;
      try {
        const suggested = download.suggestedFilename ? download.suggestedFilename() : 'download';
        fileName = String(suggested).replace(/[^\w.\-]+/g, '_');
        // C71 D5（hardening）：清洗后残留 '..' / '.' 会把 saveAs 指到下载目录外或目录本身
        if (!fileName || fileName === '.' || fileName === '..') fileName = 'download-' + Date.now();
        filePath = path.join(downloadDir, fileName);
        await withBrowserOp('download.save', page, meta.taskId, () => download.saveAs(filePath));
      } catch (e) {
        return RESULT.error('DOWNLOAD_SAVE_FAILED', '下载保存失败: ' + String(e.message || e).slice(0, 200));
      }
      const after = await withBrowserOp('download.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ downloaded: true, filePath, fileName, element: sel.pattern }, after.observation, obs.ok ? obs.observation : null);
    }
    case 'dialog': {
      const intent = (action.target && action.target.intent) || 'dismiss';
      const res = intent === 'accept'
        ? await browserManager.acceptDialog(page, action.value)
        : await browserManager.dismissDialog(page);
      if (!res || !res.ok) return RESULT.error('NO_DIALOG', (res && res.error) || '当前没有待处理的对话框（可能已被自动 dismiss）');
      return RESULT.ok({ handled: intent, dialogType: res.type, message: res.message }, null, null);
    }
    case 'submit':
    case 'login':
    case 'logout': {
      // 提交/登录/登出 = 语义定位按钮 → 拟人点击（Phase 1.2 最小实现）
      const obs = await withBrowserOp('action.inspect', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId }));
      const beforeObs = obs.ok ? obs.observation : null;
      let sel = await resolveSelector(action, obs.observation, meta, page, { prefer: isActionableControl });
      if (!sel) {
        const semantic = action.target.semantic || action.target.field || action.target.text || (action.type === 'submit' ? 'submit' : action.type);
        const cands = semanticResolver.resolve(action.target, obs.observation);
        // Phase 9 P2：同 prefer 语义 —— 跳过纯输入类候选，落在真正可触发的控件上。
        const pick = (cands || []).find((c) => isActionableControl(c.el)) || (cands || [])[0];
        if (pick) { sel = { selector: pick.selector, pattern: elementMemory.patternOf(pick.el), semantic, fromMemory: false }; if (meta) { meta.selFromMemory = false; meta.selPattern = null; } }
      }
      if (!sel) return RESULT.error('ELEMENT_NOT_FOUND', '未找到动作按钮: ' + (action.target.semantic || action.type));
      await withBrowserOp('action.click', page, meta.taskId, () => browserManager.humanClick(page, sel.selector, {}));
      // 结果落点窗口（Business Capability P1）：提交/登录/登出后等待页面沉降，使 after-observation
      // 反映真实提交结果（成功提示 / 跳转 / 错误页），而非点击瞬间的中间态。
      // 上限 ~3s，不阻塞、不降低成功定义、绝不 silent-pass。降级：网络空闲超时则固定短等。
      let landed = false;
      try {
        await withBrowserOp('action.land', page, meta.taskId, () => page.waitForLoadState('networkidle', { timeout: 3000 }));
        landed = true;
      } catch (e) { /* SPA 长轮询常见：退化为固定短等 */ }
      if (!landed) {
        await withBrowserOp('action.wait', page, meta.taskId, () => page.waitForTimeout(600));
      }
      const after = await withBrowserOp('action.inspect2', page, meta.taskId, () => observation.inspect(page, { taskId: meta.taskId, skipCache: true }));
      return RESULT.ok({ acted: action.type, selector: sel.selector, element: sel.pattern, landed }, after.observation, beforeObs);
    }
    default:
      return RESULT.error('UNSUPPORTED_TOOL', '未实现工具: ' + action.type);
  }
}

// 语义/字段 → { selector, pattern, semantic, fromMemory }。
// 查询顺序（降本）：显式 selector → Element Memory（confidence≥0.8 且 pattern 命中）→ semanticResolver。
// 记忆只产出候选，不直接执行；低置信度自动降级 semanticResolver。
// meta：透传 selFromMemory / selPattern 供 execute 层统计与误报追踪。
async function resolveSelector(action, obs, meta, page, opts) {
  const t = action.target || {};
  // Phase 9 P2：opts.prefer 为「在已发现候选内部优先挑选」的谓词（如 submit 需可触发控件）。
  // 仅在候选存在时改变挑选顺序；不做新发现、不重试、不改变候选生成与评分。
  const prefer = (opts && typeof opts.prefer === 'function') ? opts.prefer : null;
  const pickFrom = (cands) => {
    if (!cands || !cands.length) return null;
    if (prefer) {
      const hit = cands.find((c) => prefer(c.el));
      if (hit) { if (meta) meta.preferApplied = true; return hit; }
    }
    return cands[0];
  };
  // C105 F2（回归修订 R-F2，step22 Scenario E 实证）：显式 selector 新鲜度判定降级为
  // 【可观测标记，不做弃用】。原设计「不接地即弃用、落语义新鲜解析」存在架构性误伤：
  // 观察快照无法区分「selector 过期（永不存在）」与「目标尚未挂载（延时出现）」——
  // step22 Scenario E 延时按钮在 step 起始观察中不存在 → #continue 被误判过期弃用 →
  // 语义兜底解析出 observation 合成 id（#el-N，不在真实 DOM）→ locator 30s 超时 →
  // TIMEOUT 诊断 → reload → BLANK 页 → CONTEXT_NOT_READY 死亡螺旋 → HUMAN_ESCALATION。
  // D-B 死循环的真正防护由 F5（同签名熔断阈值 4）+ F5b（reload 每 step 上限 1 次）
  // + repair/escalate 有界收口承担；此处只留接地疑点标记供诊断与可观测性。
  // selector-only target（无语义键可回退）保持既有行为：交 Phase 6.3 CSS fallback 路径。
  if (t.selector) {
    const hasSemanticKey = !!(t.semantic || t.field || t.text);
    if (hasSemanticKey && !semanticResolver.selectorGrounded(t.selector, obs)) {
      if (meta) { meta.staleSelectorSuspected = true; } // 接地疑点：目标可能过期或尚未挂载（诊断标记，不弃用）
    }
    if (meta) { meta.selFromMemory = false; meta.matchedBy = 'explicit_selector'; }
    return { selector: t.selector, pattern: null, semantic: t.selector, fromMemory: false };
  }
  const semantic = t.semantic || t.field || t.text;
  if (!semantic) return null;
  const site = siteFromUrl(obs && obs.url);

  // 1) Element Memory 命中（零语义推理）。
  // Phase 9 P2：记忆只提供候选，不对动作目标拥有一票否决权 —— 当 prefer 约束存在且记忆候选都不满足时，
  // getCandidate 返回 null，流程继续走 semanticResolver（详见 elementMemory.getCandidate 注释）。
  if (site) {
    const mem = elementMemory.getCandidate(site, semantic, obs, null, { prefer });
    if (mem) { if (meta) { meta.selFromMemory = true; meta.selPattern = mem.pattern; meta.matchedBy = 'element_memory'; } return { selector: mem.selector, pattern: mem.pattern, semantic, fromMemory: true }; }
    if (prefer && meta) meta.memoryDeclinedByPrefer = true; // 记忆因不满足动作约束被放弃（诊断用，不改变流程）
  }

  // 2) semanticResolver（多信号评分；传入完整 target 对象以启用 field 权威键）
  const cands = semanticResolver.resolve(t, obs);
  if (cands.length) {
    const best = pickFrom(cands);
    const out = { selector: best.selector, pattern: elementMemory.patternOf(best.el), semantic, fromMemory: false };
    if (meta) {
      meta.selFromMemory = false; meta.selPattern = null;
      meta.matchedBy = best.matchedBy || 'semantic';
      try { elementMemory.noteSemanticFallback(site, semantic); } catch (e) {}
    }
    return out;
  }

  // 3) Phase 6.4（E2/E4）：解析失败且持有 page 时，等待页面/元素就绪后重试一次（不自动判成功）。
  if (page && action.type !== 'navigate') {
    try {
      const readyObs = await pageReady.waitForElement(page, t, { timeoutMs: Math.min(action.timeoutMs || 4000, 4000), taskId: meta && meta.taskId });
      if (readyObs) {
        const fresh = semanticResolver.resolve(t, readyObs);
        if (fresh.length) {
          const best2 = pickFrom(fresh);
          const out = { selector: best2.selector, pattern: elementMemory.patternOf(best2.el), semantic, fromMemory: false };
          if (meta) {
            meta.selFromMemory = false; meta.selPattern = null;
            meta.matchedBy = best2.matchedBy || 'semantic';
            try { elementMemory.noteSemanticFallback(site, semantic); } catch (e) {}
          }
          return out;
        }
      }
    } catch (e) { /* 等待失败交还既有 ELEMENT_NOT_FOUND 路径 */ }
  }

  if (meta) { meta.selFromMemory = false; meta.selPattern = null; meta.matchedBy = null; }
  return null;
}

// CAP-L1 —— 读取目标输入框的真实信号，供支付字段识别使用。
//
// 为什么必须真读 DOM：resolveSelector 返回的只是一个 CSS 选择器字符串，
// 而「这个框到底要卡号还是 CVV」的**唯一可判定信号**是站点自声明的 autocomplete
// （W3C 标准：cc-number / cc-exp / cc-csc）。target.field 由模型给出，可以为空、
// 可以是驼峰、也可以与页面命名完全不同 —— 只信它会重演「resolveFillValue 只认
// email/password」的断点。
//
// 降级原则：探测是**增强**，绝不能成为新的故障源。iframe 选择器（含 ' >> '）不探测、
// 任何异常返回 null，交由 target.field 兜底判定。
async function elementSignals(page, selector) {
  if (!page || !selector || typeof selector !== 'string') return null;
  if (selector.indexOf(' >> ') >= 0) return null; // 跨 frame 选择器无法直接 $eval
  try {
    // 自带超时：探测是增强能力，绝不能因为一次 $eval 卡住而挂死 Runtime。
    // 刻意不用 withBrowserOp —— 它超时会 throw，而这里必须 fail-open（降级为只按
    // target.field 判定），不能让「拿不到增强信息」变成「动作失败」。
    const probe = page.$eval(selector, (el) => ({
      autocomplete: (el.getAttribute && el.getAttribute('autocomplete')) || null,
      name: (el.getAttribute && el.getAttribute('name')) || null,
      id: el.id || null,
      placeholder: (el.getAttribute && el.getAttribute('placeholder')) || null,
      ariaLabel: (el.getAttribute && el.getAttribute('aria-label')) || null,
      type: (el.getAttribute && el.getAttribute('type')) || null,
      // input.maxLength 未设置时返回 -1（规范值），必须过滤，否则有效期会被截成 1 位
      maxlength: (Number.isInteger(el.maxLength) && el.maxLength > 0 && el.maxLength < 1000) ? el.maxLength : null,
    }));
    let timer = null;
    const bail = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('elementSignals 探测超时')), 3000);
    });
    try {
      return await Promise.race([probe, bail]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    return null; // 探测失败 = 没有增强信息，按 target.field 兜底
  }
}

// 解析 fill 值：credentialRef → secretManager；否则返回 value（非敏感）。
//
// 返回 { value, kind, missingPaymentField }。value===null 表示取不到值。
// ⚠️ 红线：value 只流向输入层（humanType / locator.fill），
//    绝不写入 result / observation / 事件 / 日志 —— 明文卡号/CVV 不得离开浏览器。
async function resolveFill(action, ctx) {
  const field = (action.target && action.target.field) || '';
  if (!action.credentialRef) {
    const v = (action.value !== undefined && action.value !== null) ? String(action.value) : null;
    return { value: v, kind: null, missingPaymentField: null };
  }
  const resolved = secretManager.resolve(action.credentialRef);
  if (!resolved) return { value: null, kind: null, missingPaymentField: null };
  const s = resolved.secrets || {};
  const signals = Object.assign({}, (ctx && ctx.signals) || null, { field: field || null });
  const c = paymentField.classify(signals);
  if (c && paymentField.PAYMENT_KINDS.has(c.kind)) {
    const card = s.card || null;
    const v = paymentField.formatValue(c.kind, card, { maxlength: signals.maxlength });
    // card 存在但这一段缺失 → 与「整个凭据不可用」区分开，给人工一个准确的说法
    return { value: v, kind: c.kind, missingPaymentField: (v === null && card) ? c.kind : null };
  }
  const f = String(field).toLowerCase();
  if (f.includes('email')) return { value: s.email || null, kind: 'email', missingPaymentField: null };
  if (f.includes('password')) return { value: s.password || null, kind: 'password', missingPaymentField: null };
  // C71 D1（B 类·凭据卫生）：非 email/password 字段绝不回退到密码 —— 只存密码无 email 的凭据
  // 会把明文密码打进 username/phone 等 type=text 明文输入框（回显/浏览器自动保存/页面脚本皆可读取）。
  // 未知字段只回退 email（用户名语义的安全上界）；密码唯一出口 = field 含 'password'。
  return { value: s.email || null, kind: null, missingPaymentField: null };
}

// v0.2.3（Engineering Phase P1）：凭据不可用诊断（绝不打印明文/敏感信息）。
// 当 action.credentialRef 已设置，但凭据注册表显示不可用（未注册 / vault 未解密 / 解析失败）时，
// 返回 CREDENTIAL_UNAVAILABLE 错误，使上层直送人工处理，而非进入「NO_VALUE → repair 重试」错误链。
// 若凭据可用（resolve 成功）则返回 null，交由 resolveFill 正常取值（字段缺失仍走 NO_VALUE）。
function credentialUnavailableError(action) {
  if (!action || !action.credentialRef) return null;
  let available = false;
  try {
    const rec = secretManager.getByRef(action.credentialRef);
    available = !!(rec && rec.available) && !!secretManager.resolve(action.credentialRef);
  } catch (e) { available = false; }
  if (!available) {
    return RESULT.error('CREDENTIAL_UNAVAILABLE', 'credentialRef 不可用（未注册或 vault 未解密），转人工处理');
  }
  return null;
}

module.exports = {
  execute, runTool, resolveSelector, credentialUnavailableError, RESULT, isActionableControl,
  // 导出 makeLocator：' >> ' 跨 frame 选择器只有它能正确解析
  // （实测 page.locator('iframe >> input') 在本版本不穿透 frame，恒为 0）。
  // 测试必须用它来验证 observation 产出的选择器，否则「看起来对」与「能用」无法区分。
  makeLocator,
};
