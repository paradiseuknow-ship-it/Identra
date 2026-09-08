'use strict';

// Agent Runtime：唯一 Agent 执行循环。
// API → TaskManager → Runtime → Tools → BrowserManager。禁止 runtime 直接 page.*。
// Loop: 读当前 Step → Observation → Provider(Planner) → Action → Schema → Policy
//      → Tool → Verify → Checkpoint → Next Step。

const browserManager = require('../browserManager');
const db = require('../db');
const taskManager = require('./taskManager');
const stepManager = require('./stepManager');
const tools = require('./tools');
const events = require('./events');
const checkpoint = require('./checkpoint');
const verification = require('./verification');
const observation = require('./observation');
const verificationIntelligence = require('./verification/verificationIntelligence');

// v0.2.2：孤儿收口守卫（Business Loop 专项 §十三~§十五）。任何 task 终态转换前，先把仍停在 RUNNING 的
// attempt 显式收口，杜绝 submit 等动作遗留的孤儿 attempt（历史数据中存在 19 个 submit RUNNING 孤儿）。
function finalizeOrphans(taskId) {
  try { stepManager.finalizeOrphanAttempts(taskId); } catch (e) { /* 守卫失败不影响主流程终态 */ }
}

// C69（2026-09-08）ghost runStep 守卫：STEP_TIMEOUT 的 Promise.race 只放弃等待、不取消底层
// 协程 —— tools.execute 可无限挂起（这正是超时机制存在的原因），挂起恢复后原协程会「迟到地」
// 写入终态：幽灵成功覆盖已失败/已修复的 step（假阳性 SUCCESS）、幽灵 escalate/pause 误转任务终态。
// 主循环顶部的 live-status 检查只防「重入已终态 step」，防不了幽灵对未终态 step 的迟到写。
// 机制：同 step 每次执行注册 token（后继执行覆盖之）；STEP_TIMEOUT 显式失效；幽灵所有
// step 状态 / 任务终态写之前检查 token 有效性，失效即只记录自身 attempt、不碰共享状态。
const activeStepRuns = new Map(); // stepId -> 最新一次执行的 token
function beginStepRun(stepId) {
  const token = 'sr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  activeStepRuns.set(stepId, token);
  return token;
}
function isStepRunActive(stepId, token) { return activeStepRuns.get(stepId) === token; }
function endStepRun(stepId, token) { if (activeStepRuns.get(stepId) === token) activeStepRuns.delete(stepId); }
function invalidateStepRun(stepId) { activeStepRuns.delete(stepId); }
const verificationWindow = require('./verification/verificationWindow');
const store = require('./store');
const recorder = require('./recorder');
const recoveryManager = require('./recovery/recoveryManager');
const repairManager = require('./repair/repairManager');
const { createProvider } = require('./provider');
require('./provider.mock'); // 注册 mock provider
require('./llm/providers/openai');  // 注册 openai provider（按需）
require('./llm/providers/deepseek'); // 注册 deepseek provider（按需）

// Phase 1.3：真实 Provider（env AI_PROVIDER=openai|deepseek，缺省 auto → 有 key 用真实，否则 mock）
let provider = createProvider(process.env.AI_PROVIDER || 'auto');
const planner = require('./planner');
const flowPlanner = require('./intelligence/flowPlanner');
const contextBuilder = require('./contextBuilder');
const memory = require('./memory');
const { DEFAULT_POLICY } = require('./policy');

function getTask(taskId) {
  return taskManager.getTask(taskId);
}

// 重试退避（Phase 12B §T14）：指数退避，避免高频重试对站点/浏览器造成压力。
function backoffSleep(attempt) {
  const base = 300;
  const cap = 5000;
  const ms = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  return new Promise((r) => setTimeout(r, ms));
}

// 确保 Profile 浏览器已启动（复用现有 launch，不走 route）
async function ensureBrowser(task) {
  if (!task.profileId) return { ok: false, error: '任务未绑定 Profile' };
  let session = browserManager.getSession(task.profileId);
  // Phase 5.8 防御：会话存在但 context 已断开/关闭（浏览器崩溃）→ 视为失效，重新 launch。
  if (session && session.context && (session.context._closed || (session.context.browser && !session.context.browser().isConnected()))) {
    session = null;
    try { await browserManager.close(task.profileId).catch(() => {}); } catch (e) {}
  }
  if (!session) {
    const profile = db.getProfile(task.profileId);
    if (!profile) return { ok: false, error: 'Profile 不存在: ' + task.profileId };
    // 有界重试：chromium 在 Windows 上启动偶发 "Target page, context or browser has been closed"，
    // 单次竞态不应污染整条生命周期验收链路（Benchmark 暴露）。最多 3 次，间隔递增。
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        session = await browserManager.launch(profile, db.getProxies());
        break;
      } catch (e) {
        lastErr = e;
        try { await browserManager.close(task.profileId).catch(() => {}); } catch (_) {}
        if (attempt < 2) {
          const end = Date.now() + (attempt + 1) * 300;
          while (Date.now() < end) { /* 微退避 */ }
        }
      }
    }
    if (!session) {
      return { ok: false, error: '浏览器启动失败(重试3次): ' + String(lastErr && lastErr.message || lastErr).slice(0, 300) };
    }
  }
  return { ok: true, session };
}

// 获取/生成执行计划（唯一真实路径：ContextBuilder → Planner → provider.plan → Runtime）。
// 不变量（Phase 2 收口，禁止绕行）：
//   - 本函数不存在「bypass planner」：找不到任何内联/hidden 的 Plan 生成逻辑。
//   - 唯一的 Plan 来源是 planner.planObjective，其内部强制走 provider.plan（DeepSeek 等真实 LLM），
//     并经 schema/plan.js 校验；校验失败即拒绝，绝不静默通过。
//   - 下方「已有 steps 则直接返回」仅用于【断点续跑/恢复】（task 在 RUNNING 中被 resume/retry），
//     不是规划路径；新任务首次进入时 steps 为空，必然走到 planner 或 flow 重放（见下）。
//   - CAP-K1（2026-08-29）：高置信度历史 flow 可在此直接重放（跳过 LLM Planner）。
//     这不是 bypass：flow 重放计划必须先过 schema/plan.validatePlan（flowPlanner.tryFlowPlan
//     统一把关），执行仍走 policy / verification / tools；置信度不足或校验不过一律降级
//     planner.planObjective。失败反馈在 taskManager.fail/escalate（recordOutcomeFlow=false）。
//   - server/agent/index.js 的 /chat 创建任务路径同样复用 flowPlanner（planWithMemory），
//     两条路径读侧语义一致；差异仅在于 /chat 会 attachPlan 等待人工确认后执行。
// Phase 9 P4 — 规划前真实观察（Planner 契约编造修复，断裂点 1/3）
//
// 缺陷：resolvePlan 调用 contextBuilder.build 时从未传 observation，
//       使 ctx.context.page 恒为 null —— Planner 规划时看不到任何页面信息
//       （无 URL / 标题 / 可见文本 / 元素清单），只能从 objective 凭空推导
//       expectedBusinessState。而 planner.ACTION_CONSTRAINTS 又明文要求
//       「禁止凭空臆造预期结果」，二者直接冲突，模型必然违约。
//
// 证据（phase68 + Phase 9 20-task 回放，78 个失败 attempt 分型）：
//   - CONTRACT_SELECTOR_MISMATCH 38/78（48.7%）：Planner 写出的 element 标识在页面上不存在。
//     例如 scraping/list.html 真实 id 是 `list`，Planner 写出 `element_present="member-list"`；
//     saas/login.html 真实字段是 `email`，Planner 写出 `input[name='username']`。
//   - CONTRACT_TEXT_MISMATCH 17/78（21.8%）：期望文案（如「耳机」）不在页面真实内容里。
//
// 修复：规划前做一次真实导航 + 真实观察，把 observation 交给 ContextBuilder。
// 安全：本函数不抛异常，任一环节失败都返回 null，规划降级为既有行为 —— 不新增失败模式。
async function capturePlanningObservation(task) {
  try {
    if (!task || !task.targetUrl || !task.profileId) return null;
    const page = await browserManager.getPage(task.profileId);
    if (!page || typeof page.goto !== 'function') return null;
    let cur = '';
    try { cur = page.url() || ''; } catch (e) { cur = ''; }
    // 仅当页面尚未停在目标站点时才导航，避免对已就位的页面做无谓刷新。
    const samePage = cur && cur !== 'about:blank' && !/^data:/.test(cur);
    if (!samePage) {
      await page.goto(task.targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    const insp = await observation.inspect(page, {});
    if (!insp || !insp.ok) return null;
    return insp.observation;
  } catch (e) {
    console.warn('[runtime] 规划前观察失败（降级为无页面上下文规划）:', String((e && e.message) || e).slice(0, 160));
    return null;
  }
}

async function resolvePlan(task) {
  let steps = stepManager.listSteps(task.id);
  if (steps.length) return steps;

  // CAP-K1：flowMemory 读侧接入生产执行路径（此前写侧在 taskManager.complete、读侧只在
  // /chat 创建路径 —— 写与读永不相遇，经验永远不被复用）。命中即跳过规划前观察与 LLM：
  // 首步 navigate 本身就会导航，省一次规划观察；plan 已过 validatePlan，执行仍走
  // policy/verification/tools。任何异常都 fail-open 降级 LLM，不新增失败模式。
  let flowHit = null;
  try { flowHit = flowPlanner.tryFlowPlan(task.targetUrl, task.objective); } catch (e) { flowHit = null; }
  if (flowHit) {
    try {
      taskManager.markFlowUsed(task.id, flowHit.flowId, flowHit.confidence);
      events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'task.plan_from_flow', payload: { flowId: flowHit.flowId, confidence: flowHit.confidence } });
      steps = flowHit.plan.steps.map((s, i) => stepManager.createStep(task.id, s, i));
      if (steps.length) return steps;
    } catch (e) {
      // 建步失败（极罕见）：清掉半建步骤，降级 LLM
      try { store.write('aiSteps', store.read('aiSteps', []).filter((s) => s.taskId !== task.id)); } catch (_) {}
    }
  }

  // Observation → ContextBuilder → Planner：构建结构化上下文（objective/observation/steps/checkpoint/errorHistory/verification）
  const planningObs = await capturePlanningObservation(task);
  const ctx = {
    taskId: task.id,
    executionId: task.currentExecutionId,
    context: contextBuilder.build({
      task,
      observation: planningObs,
      steps,
      checkpoint: checkpoint.latest(task.id),
      errorHistory: store.findWhere('aiAttempts', (a) => a.taskId === task.id)
        .filter((a) => a && a.error)
        .slice(-10)
        .map((a) => ({ code: a.error.code, message: a.error.message, at: a.endAt || a.startedAt })),
      budgetCfg: { taskId: task.id },
    }),
  };
  const pr = await planner.planObjective({
    objective: task.objective,
    target: task.targetUrl,
    constraints: task.constraints || [],
    credentialRefs: task.secretRefs || [],
    executionMode: task.executionMode,
    provider,
    ctx,
  });
  if (!pr.ok) {
    if (pr.needsCredentials) {
      // B 类缺口修复（2026-08-31）：无凭据 + 敏感字段门确定性不可满足 → 业务升级（需凭据），
      // 非工程失败。带标记抛出，由 run() 的 resolvePlan 调用点路由到 escalate。
      const err = new Error(pr.error || '需要登录凭据');
      err.needsCredentials = true;
      throw err;
    }
    throw new Error(pr.error || '计划生成失败');
  }
  steps = pr.plan.steps.map((s, i) => stepManager.createStep(task.id, s, i));
  if (!steps.length) throw new Error('计划为空');
  return steps;
}

// 单步执行（含一次 Attempt + Verification）；actionOverride 用于确定性恢复的候选动作
// C69：真正的执行体在 runStepInner（_runToken = 幽灵守卫 token）；runStep 是注册/注销包装。
async function runStepInner(task, step, beforeObs, actionOverride, _runToken) {
  const _inert = () => !isStepRunActive(step.id, _runToken); // 幽灵判定：token 被后继执行覆盖/显式失效
  const executionId = task.currentExecutionId;
  const action = actionOverride || step.action;
  stepManager.setStepState(step.id, 'RUNNING'); // PENDING → RUNNING（状态机要求先转 RUNNING）
  const attempt = stepManager.createAttempt(step.id, executionId, action);
  events.emit({ taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id, type: 'task.step_started', payload: { description: step.description } });

  // DEBUG 模式：输出决策证据（decision/evidence/confidence，非 chain-of-thought）
  if (task.executionMode === 'DEBUG' && action) {
    events.emit({
      taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id, type: 'ai.thinking',
      payload: {
        decision: `执行 ${action.type}（目标: ${action.target && (action.target.semantic || action.target.field || 'auto')}）`,
        evidence: step.description || '',
        confidence: action.risk === 'LOW' ? 0.95 : action.risk === 'MEDIUM' ? 0.9 : 0.85,
      },
    });
  }

  // SIMULATION：只观察不执行（Case 5）
  if (task.executionMode === 'SIMULATION') {
    // Phase 9 P3 修复：getPage 是 async 函数，漏 await 会拿到 Promise（truthy 但无 evaluate），
    // 使 observation.inspect 返回 { ok:false, error:'page.evaluate is not a function' } 并被静默吞掉。
    const page = await browserManager.getPage(task.profileId);
    const obs = page ? await observation.inspect(page, { taskId: task.id }) : null;
    if (!_inert()) {
      stepManager.succeedAttempt(attempt.id);
      stepManager.setStepState(step.id, 'SUCCESS');
    }
    return { ok: true, simulated: true, abandoned: _inert(), observation: obs ? obs.observation : null };
  }

  // 执行 Action（Tools 内部已做 Schema/Policy/Lock + before/after 快照）
  const toolRes = await tools.execute({ action, taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id });

  // 持久化 resolver 命中信号（matchedBy）—— 填补此前 observability 缺口（Phase 12B §十四）。
  if (toolRes && toolRes.matchedBy) {
    try { stepManager.updateAttempt(attempt.id, { matchedBy: toolRes.matchedBy }); } catch (e) {}
  }

  if (toolRes && !toolRes.success) {
    const err = toolRes.error || { code: 'UNKNOWN', message: '工具执行失败' };
    // v0.2.3（Engineering Phase P1）：凭据不可用 → 直送人工处理，不进入 repair 重试循环
    // （避免 NO_VALUE → repair 的无效重试；不打印任何明文凭据）。
    // toolRes.error 由 RESULT.error 包裹为 { error:{code,message} }，故同时兼容顶层与嵌套 code。
    const errCode = (err && (err.code || (err.error && err.error.code))) || 'UNKNOWN';
    if (errCode === 'CREDENTIAL_UNAVAILABLE') {
      const failErr = { code: 'CREDENTIAL_UNAVAILABLE', message: (err.error && err.error.message) || err.message || '凭据不可用' };
      stepManager.failAttempt(attempt.id, failErr); // 幽灵只记自身 attempt（无害）；step 状态与任务终态写需 token 有效
      if (!_inert()) {
        stepManager.setStepState(step.id, 'FAILED');
        events.emit({ taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id, type: 'ai.warning', payload: { code: failErr.code, message: failErr.message } });
        taskManager.escalate(task.id, new Error('凭据不可用：' + failErr.message), { reason: 'CREDENTIAL_UNAVAILABLE' });
      }
      return { ok: false, escalated: !_inert(), abandoned: _inert(), error: failErr };
    }
    stepManager.failAttempt(attempt.id, err);
    if (err.code === 'ACTION_REQUIRES_APPROVAL') {
      // ASSIST 高风险 → PAUSED_FOR_HUMAN（Case 6）；携带待审批动作供 Approve/Modify
      if (!_inert()) {
        stepManager.setStepState(step.id, 'FAILED');
        events.emit({ taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id, type: 'ai.warning', payload: { code: err.code, message: err.message } });
        taskManager.pauseForHuman(task.id, err.message, { stepId: step.id, action: step.action });
      }
      return { ok: false, paused: !_inert(), abandoned: _inert(), error: err };
    }
    events.emit({ taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id, type: 'ai.warning', payload: { code: err.code, message: err.message } });
    return { ok: false, error: err, observation: toolRes.observation };
  }

  // 验证（v0.2.1：使用动作前/后真实快照作为 before/after）
  // Phase 11：使用 buildEffectiveVerification —— 优先 ExpectedBusinessState 合约（验证业务结果），
  // 关键业务动作禁止仅以 action_success 作为完成证据。
  const effV = verification.buildEffectiveVerification(step);
  if (effV && (effV.businessState || (effV.type && effV.type !== 'none'))) {
    const beforeActionObs = toolRes.beforeObservation || beforeObs;
    const vres = verification.verify(effV, toolRes.observation, beforeActionObs);
    events.emit({
      taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id, type: 'ai.verification.completed',
      payload: { type: effV.businessState ? ('businessState:' + effV.businessState.stateType) : effV.type, success: vres.success, confidence: vres.confidence, evidence: vres.evidence.slice(0, 3) },
    });
    if (!vres.success) {
      // Phase 10.7：Verification Intelligence 诊断 + 决策 + 观察窗口（完整闭环第一步）。
      const vil = verificationIntelligence.analyze({
        beforeObservation: beforeActionObs,
        afterObservation: toolRes.observation,
        expectedVerification: effV,
        actionResult: toolRes,
        action: step.action,
      });

      // 遥测 1：每一次 VIL decision 都记录（含 failureType / decision / confidence / evidence）
      events.emit({
        taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id,
        type: 'ai.verification.decision',
        payload: { failureType: vil.failureType, decision: vil.decision, confidence: vil.confidence, evidence: vil.evidence.slice(0, 3) },
      });

      // 重观察类决策（WAIT / RECHECK_OBSERVATION / RETRY_VERIFY）：运行 Observation Window，
      // 真正等待 + 重新 capture observation + 重新验证（绝不重执行原 action）。
      if (verificationIntelligence.isReobservableDecision(vil.decision)) {
        // Phase 9 P3 修复（关键）：此处漏 await 导致传入观察窗口的是 Promise 而非 Page，
        // 窗口内每次 observation.inspect 都失败于 `page.evaluate is not a function`，
        // 于是 VIL 的 WAIT/RECHECK/RETRY_VERIFY 恢复能力 100% 失效（窗口从不 recovered）。
        // Promise 恒为 truthy，故 `if (page)` 无法拦截，失败再被窗口内 catch 静默吞掉。
        const page = await browserManager.getPage(task.profileId);
        if (page) {
          const win = await verificationWindow.runObservationWindow({
            page, taskId: task.id,
            ctx: { taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id },
            verification: effV, beforeObservation: beforeActionObs,
            initialObservation: toolRes.observation, decision: vil.decision,
            // v0.2.2：传入动作完成时间，使窗口内重新 capture 的观察可被证明为 Fresh Observation。
            actionFinishedAt: (toolRes.observation && toolRes.observation.capturedAt) || toolRes.timestamp || undefined,
          });
          if (win.recovered) {
            // 遥测 2：VIL 恢复成功（区分 classify / decision_changed / recovered）
            events.emit({
              taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id,
              type: 'ai.verification.recovered',
              payload: {
                failureType: vil.failureType, decision: vil.decision,
                recoveryAction: 'OBSERVATION_WINDOW', observationCount: win.observationCount,
                elapsedMs: win.elapsedMs, stateChanged: win.stateChanged,
                verificationAttempts: win.verificationAttempts,
              },
            });
            toolRes.observation = win.finalObservation;
            // Phase 9 P3：VIL 观察窗口恢复 = 业务验证最终通过 → 确认记忆
            if (!_inert()) {
              if (toolRes && toolRes.memoryConfirmation) {
                try { require('./intelligence/elementMemory').confirmPendingSuccess(toolRes.memoryConfirmation); } catch (e) {}
              }
              stepManager.succeedAttempt(attempt.id);
              stepManager.setStepState(step.id, 'SUCCESS');
            }
            return { ok: true, observation: win.finalObservation, vil, abandoned: _inert() };
          }
          // 窗口耗尽：用最终观察覆盖，供后续重分类 / 升级判定
          toolRes.observation = win.finalObservation;
        }
      }

      // HUMAN_ESCALATE：VIL 直接决策升级人工（敏感/关键动作验证失败且证据不足）。
      // 真正参与 Runtime Decision —— 不进入自主重试/修复循环，直接转 HUMAN_ESCALATION 终态。
      if (vil.decision === verificationIntelligence.DECISIONS.HUMAN_ESCALATE) {
        if (!_inert()) {
          stepManager.setStepState(step.id, 'FAILED');
          events.emit({
            taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id,
            type: 'ai.warning', payload: { code: 'VIL_HUMAN_ESCALATE', message: vil.failureType + ' → ' + (vil.evidence[0] || '') },
          });
          taskManager.escalate(task.id, new Error(`VIL 升级人工：${vil.failureType} / ${(vil.evidence[0] || '').slice(0, 160)}`), { reason: 'VIL:' + vil.failureType });
        }
        return { ok: false, escalated: !_inert(), abandoned: _inert(), error: { code: 'HUMAN_ESCALATION', message: vil.failureType } };
      }

      // RE_EXECUTE：不在此内联重执行（避免绕过 retry/repair 架构与无限循环），
      // 仅记录决策并让 attempt 失败 → 由 repair/verifyFailed 在保留 target 对象的前提下重执行。
      // HUMAN_ESCALATE / 窗口耗尽：失败 → 由 runtime 的 retry → repair → escalate 终态链路收口。

      // 验证失败：保存 verification_failed 快照（自愈证据）
      try {
        const page = await browserManager.getPage(task.profileId);
        const snap = page ? await require('./evidence').saveSnapshot(page, task.id, step.id, 'verification_failed') : null;
        if (snap) events.emit({ taskId: task.id, executionId, stepId: step.id, type: 'ai.snapshot', payload: { label: 'verification_failed', file: snap } });
      } catch (e) {}
      // Phase 9 P6（记忆失败反馈）：业务验证最终失败时，惩罚本次解析使用的记忆候选。
      // P3 只做「不强化」（验证失败不确认记忆），但历史宽松验证时代积累的错误记忆
      // （smoke5 rw.094 铁证：语义「加购按钮」→ pattern「搜索」/16 次假成功，confidence=1）
      // 跨运行持续把 resolveSelector 引向错误元素，且失败永不衰减。
      // 与 confirmPendingSuccess 对称：验证通过 → 强化；验证失败 → falsePositive，
      // 成功率跌破阈值后由 getCandidate 的 MIN_CONFIDENCE 自动降级回 semanticResolver。
      if (toolRes && toolRes.memoryConfirmation) {
        try {
          const em = require('./intelligence/elementMemory');
          const mc = toolRes.memoryConfirmation;
          em.recordFailure(mc.site, mc.semantic, mc.context, mc.element ? em.patternOf(mc.element) : null);
        } catch (e) {}
      }
      const failErr = {
        code: 'VERIFY_FAILED',
        message: vres.evidence.join('; '),
        failureType: vil.failureType,
        confidence: vil.confidence,
        evidence: vil.evidence,
        observationBefore: beforeActionObs,
        observationAfter: toolRes.observation,
      };
      stepManager.failAttempt(attempt.id, failErr);
      return { ok: false, error: failErr, observation: toolRes.observation, vil };
    }

    // STEP 22 (V2)：persistAfterReload —— 显式 opt-in 的「持久化复验」。
    // 仅当 planner 声明的 expectedBusinessState 合约明确 persistAfterReload === true 时生效；
    // 推导合约从不携带该字段 → 默认 false，既有动作验证行为完全不变（默认路径零改动）。
    // 流程：首次验证成功 → 真实 reload → fresh observation（skipCache）→ 再次执行同一 contract 验证。
    // 红线：reload 后禁止复用旧 observation；reload 超时 / 状态丢失 → verification failure；
    //       payment/destructive/security-sensitive 动作不受此影响（本块只由显式合约声明触发）。
    if (effV.businessState && effV.businessState.persistAfterReload === true) {
      const reloadStart = Date.now();
      events.emit({ taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id, type: 'ai.verification.persist_reload', payload: { stage: 'start', firstVerification: 'passed' } });
      const page = await browserManager.getPage(task.profileId);
      let reloaded = false;
      if (page) {
        const rt = Number(effV.businessState.reloadTimeoutMs);
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: (Number.isFinite(rt) && rt > 0) ? Math.min(rt, 30000) : 15000 });
          reloaded = true;
        } catch (e) {
          events.emit({ taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id, type: 'ai.verification.persist_reload', payload: { stage: 'reload_failed', error: String(e.message || e).slice(0, 160) } });
        }
      }
      if (!reloaded) {
        const failErr = { code: 'VERIFY_FAILED', message: 'persistAfterReload 复验失败：reload 不可完成（页面缺失或超时）' };
        stepManager.failAttempt(attempt.id, failErr);
        return { ok: false, error: failErr, observation: toolRes.observation };
      }
      // fresh observation：capturedAt > reloadStart（fresh 血缘可证明），绝不复用 reload 前旧观察
      const insp = await require('./observation').inspect(page, {
        taskId: task.id, skipCache: true, source: 'persist_reload',
        actionFinishedAt: reloadStart, stepId: step.id, attemptId: attempt.id,
      });
      if (!insp || !insp.ok || !insp.observation) {
        const failErr = { code: 'VERIFY_FAILED', message: 'persistAfterReload 复验失败：reload 后页面观察失败' };
        stepManager.failAttempt(attempt.id, failErr);
        return { ok: false, error: failErr, observation: toolRes.observation };
      }
      const vres2 = verification.verify(effV, insp.observation, beforeActionObs);
      events.emit({
        taskId: task.id, executionId, stepId: step.id, attemptId: attempt.id, type: 'ai.verification.persist_reload',
        payload: { stage: 'reverified', success: vres2.success, observationId: insp.observation.observationId, fresh: insp.observation.fresh, evidence: (vres2.evidence || []).slice(0, 3) },
      });
      if (!vres2.success) {
        const failErr = { code: 'VERIFY_FAILED', message: 'persistAfterReload 复验失败（reload 后业务状态丢失）: ' + (vres2.evidence || []).join('; ').slice(0, 300) };
        stepManager.failAttempt(attempt.id, failErr);
        return { ok: false, error: failErr, observation: insp.observation };
      }
      toolRes.observation = insp.observation; // 后续 checkpoint / memory 消费 reload 后的真实状态
    }
  }

  // Phase 9 P3：业务验证通过 → 确认挂起的元素记忆（记忆只由业务结果强化，不再由动作机械成功强化）
  // C69：幽灵（token 失效）不得写 SUCCESS —— 这正是「幽灵成功覆盖已失败 step」的主现场
  if (!_inert()) {
    if (toolRes && toolRes.memoryConfirmation) {
      try { require('./intelligence/elementMemory').confirmPendingSuccess(toolRes.memoryConfirmation); } catch (e) {}
    }
    stepManager.succeedAttempt(attempt.id);
    stepManager.setStepState(step.id, 'SUCCESS');
  }
  return { ok: true, observation: toolRes.observation, abandoned: _inert() };
}

// C69 ghost 守卫包装：token 注册/注销；finally 覆盖所有 return 点（正常完成即注销）。
async function runStep(task, step, beforeObs, actionOverride) {
  const token = beginStepRun(step.id);
  try {
    return await runStepInner(task, step, beforeObs, actionOverride, token);
  } finally {
    endStepRun(step.id, token);
  }
}

// 主循环
async function run(taskId) {
  let task = getTask(taskId);
  if (!task) return;
  if (!['RUNNING', 'BROWSER_READY'].includes(task.status)) return;

  try {
  // 确保浏览器
  const b = await ensureBrowser(task);
  if (!b.ok) {
    finalizeOrphans(taskId);
    return taskManager.fail(taskId, new Error(b.error));
  }

  // 恢复场景：从 checkpoint URL 导航回现场再继续（避免 relaunch 后页面空白）
  if (task.recoveryUrl) {
    try {
      await tools.execute({
        action: { type: 'navigate', target: { url: task.recoveryUrl }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 20000 },
        taskId: task.id, executionId: task.currentExecutionId, stepId: null, attemptId: null,
      });
      const t2 = getTask(taskId);
      if (t2) { t2.recoveryUrl = null; store.upsert('aiTasks', t2); }
    } catch (e) {
      console.warn('[runtime] 恢复导航失败(将重试):', String(e.message || e).slice(0, 120));
    }
  }

  let steps;
  try {
    steps = await resolvePlan(task);
  } catch (e) {
    if (e && e.needsCredentials) {
      // 规划确定性不可满足（页面需认证但凭据清单为空）→ CREDIBLE 业务升级（需用户提供凭据），
      // 不落 FAILED/OTHER 工程失败口径（B 类缺口修复 2026-08-31）。
      try { finalizeOrphans(taskId); } catch (_) {}
      return taskManager.escalate(taskId, e, { kind: 'credential', reason: 'credentials_required' });
    }
    throw e;
  }
  let beforeObs = null;
  let index = 0;
  let retries = 0;
  let pendingAction = null; // 恢复候选动作跨迭代保留
  // STEP 3/4 状态：统一诊断结论跨迭代保留（带入 repair 收口）。
  // 三者只在「同一个 step 内」有效，换步即失效（下方 step 变更时统一清理）。
  let pendingDiagnosis = null;      // 统一诊断结论
  let pendingDiagnosisStepId = null; // 该结论属于哪个 step
  let skipExecution = false;        // 诊断判定不可重试 → 下一次迭代不再执行动作
  let lastFailureResult = null;     // 跳过执行时复用的上一次失败结果
  // R5（2026-09-03）churn 熔断状态：跨 replan 的同失败签名记忆（canon240_run1 rw.091 实证：
  // replan 重置 retries 后新步骤从头消费全部预算，无跨轮记忆 → 3 轮 × 7 attempts 烧满 deadline）。
  let lastReplanSig = null;   // 上一次 replan 前的失败签名
  let sameSigReplanRun = 0;   // 连续同签名 replan 计数

  // Phase 12B §T13：任务级整体墙钟超时（默认关；policy.taskTimeoutMs 可开启）。
  // 防止「每步都很快但总步数无穷」导致任务永不终态。超时即收口为 FAILED。
  const taskStartedAt = Date.now();
  const taskTimeoutMs = (task.policy && task.policy.taskTimeoutMs) || DEFAULT_POLICY.taskTimeoutMs || 0;

  // Phase 5.8 防御（Finding #1 家族）：单步执行必须受墙钟约束，杜绝「浏览器崩溃/页面僵死」
  // 导致 tools.execute 永久挂起、进而 worker 永久 RUNNING 的悬挂缺陷。超时即视为步骤失败，
  // 交由既有 retry→escalate/fail 终态路径释放 worker、避免饿死。
  const STEP_TIMEOUT_MS = 30000;

  // 5.9-E3：修复编排（retry exhausted 后）终态超时。该阶段含真实 LLM 诊断 + 至多 3 次浏览器修复动作，
  // 任一环节无内部超时时必须在此收口，避免 task 永久 RUNNING。
  // 默认 90000 零变化；FPB_REPAIR_TIMEOUT_MS 显式覆盖（解析失败/0/负数一律回退默认）——
  // 240s task deadline 场景实证：修复编排（1 次 LLM 诊断 + 3 次浏览器修复动作）在 90s 内
  // 真实跑不完，REPAIR_TIMEOUT 会把可修复失败误收口为 FAILED（rw.026/046，dl240 基线）。
  const REPAIR_TIMEOUT_MS = resolveRepairTimeoutMs(process.env.FPB_REPAIR_TIMEOUT_MS);

  while (index < steps.length) {
    task = getTask(taskId); // 每次循环重读（可能被 pause/cancel）
    if (!task || task.status !== 'RUNNING') break;

    // 心跳：更新 lastActivityAt 供 stale-task 扫描（Phase 12B §I7）
    try { taskManager.touch(taskId); } catch (e) {}

    // 任务级整体超时检查
    if (taskTimeoutMs > 0 && Date.now() - taskStartedAt > taskTimeoutMs) {
      console.warn('[runtime] 任务级整体超时，收口 FAILED:', task.id, 'elapsed=' + (Date.now() - taskStartedAt) + 'ms');
      finalizeOrphans(taskId);
      return taskManager.fail(taskId, new Error(`任务级整体超时(>${taskTimeoutMs}ms)`));
    }

    const step = steps[index];
    // STEP 4 状态只在同一个 step 内有效；换步（含 replan 后 steps 被整体替换）立即失效，
    // 避免把上一步的「不可重试」结论误带到下一步，导致下一步被跳过执行。
    if (pendingDiagnosisStepId !== step.id) {
      pendingDiagnosis = null;
      pendingDiagnosisStepId = step.id;
      skipExecution = false;
      lastFailureResult = null;
    }
    // Phase 7 修复：以 store 权威状态为准做 SUCCESS 跳过判定。
    // 背景：repair 成功会把 step 置 SUCCESS（写入 store），但本地 steps[index] 快照可能已陈旧；
    // 主循环在 retry-exhausted 修复分支后不递增 index 会重入同一 step，若仍按陈旧本地状态重跑并失败，
    // 会再次 setStepState(HEALING) 与 store 的 SUCCESS 冲突 → 抛「非法 Step 状态转换: SUCCESS->HEALING」
    // 导致整个 task 崩溃为 FAILED。此处改读权威状态，已终态的 step 直接推进，避免非法转换与崩溃。
    const _liveStatus = (stepManager.getStep(step.id) || {}).status;
    if (_liveStatus === 'SUCCESS' || _liveStatus === 'SKIPPED') { pendingAction = null; index++; continue; }

    let r;
    if (skipExecution && lastFailureResult) {
      // STEP 4：上一次恢复已诊断出「继续重试不可能成功」——本次迭代**不再执行动作**，
      // 直接复用上一次失败结果进入修复/升级收口。
      // 为什么必须跳过而不是「少重试一次」：主循环是先执行、后判定重试预算，
      // 若只是把 retries 拉满，下一轮仍会先跑一次 runStep 才走到 repair ——
      // 那一次多余的执行在「记录已存在 / 支付被拒 / 验证码」场景下是有害的重复提交。
      r = lastFailureResult;
      skipExecution = false;
    } else {
      try {
        r = await Promise.race([
          runStep(task, step, beforeObs, pendingAction),
          new Promise((_, reject) => setTimeout(() => reject(new Error('STEP_TIMEOUT')), STEP_TIMEOUT_MS)),
        ]);
      } catch (stepHang) {
        // C69：显式杀死 ghost 注册 —— 重试耗尽走 repair 分支时不再起新 runStep，
        // 幽灵协程若靠「后继覆盖」失效就轮不到；超时点直接失效最确定。
        invalidateStepRun(step.id);
        r = { ok: false, error: { code: 'STEP_TIMEOUT', message: '单步执行超时(浏览器/页面无响应): ' + String(stepHang.message || stepHang).slice(0, 200) } };
      }
      lastFailureResult = (r && r.ok) ? null : r;
    }
    if (r.paused) return; // 等待人工恢复；resume 会重新触发 run
    // P0-6：取消中断——tools 在操作边界检测到 CANCELLED 并抛出，此处直接退出，
    // 不重试/不 escalate（task 已由 taskManager.cancel 置为 CANCELLED 终态）。
    if (r.error && r.error.code === 'CANCELLED') {
      return;
    }
    beforeObs = r.observation || beforeObs;

    if (r.ok) {
      // Checkpoint（每步成功后）
      const cp = checkpoint.save(task.id, {
        executionId: task.currentExecutionId, profileId: task.profileId,
        stepId: step.id, url: beforeObs ? beforeObs.url : null,
        lastVerifiedState: { stepId: step.id, simulated: r.simulated || false },
        lastSuccessfulAction: step.action,
      });
      task.checkpointId = cp.id;
      pendingAction = null;
      index++;
      retries = 0;
      continue;
    }

    // 失败：确定性恢复 + 有界重试（Phase 5.8 修复 task #115 无限重试）
    // 不变量：
    //  - retries 在【每一次】失败迭代都自增（无论 recoveryManager 是否抛异常），
    //    杜绝 recoveryManager 异常导致 attempts 不增长 → canRetry 永久为真 → 死循环。
    //  - 用 step.retryable 作为是否允许重试的总开关；默认允许（stepManager 已置 true）。
    //  - 每次重试落一条 Attempt 记录（带 attempt/reason/strategy/terminal），observability 可观测。
    const stepMax = step.maxRetries || (task.policy && task.policy.maxActionRetries) || 3;
    retries += 1;
    const attemptNo = retries;
    const retriesLeft = stepMax - retries;
    const canRetry = !!step.retryable && retries <= stepMax && retriesLeft >= 0;
    if (canRetry) {
      // Phase 7 防御：若 step 在 store 中已为终态（如 repair 已置 SUCCESS），不再尝试 HEALING（会触发非法状态转换），
      // 直接推进到下一 step，避免把已成功的 step 二次处理并崩溃整个 task。
      const _live = (stepManager.getStep(step.id) || {}).status;
      if (_live === 'SUCCESS' || _live === 'SKIPPED') { index++; pendingAction = null; continue; }
      stepManager.setStepState(step.id, 'HEALING');
      events.emit({
        taskId: task.id, executionId: task.currentExecutionId, stepId: step.id,
        type: 'agent.retrying',
        payload: {
          attempt: attemptNo, max: stepMax, reason: r.error && r.error.code,
          strategy: 'deterministic_recovery', timeoutMs: step.action && step.action.timeoutMs || 0,
          terminal: retriesLeft === 0, // 下一次即终态（fail/escalate）
        },
      });
      // 确定性恢复策略（元素重定位 / 等待 / 重载 / 返回），产出下一条候选动作
      try {
        // STEP 3：把现场观察交给统一诊断器（含 network / textSummary / previousObservationDiff），
        // 使恢复策略第一次拥有「为什么失败」的证据，而非只看 error.code 字符串。
        const rec = await recoveryManager.attempt(task, step, r.error, {
          executionId: task.currentExecutionId,
          observation: r.observation || beforeObs,
          vilFailureType: (r.error && r.error.failureType) || (r.vil && r.vil.failureType) || null,
          attempted: true,
          sinceTs: (r.observation && r.observation.capturedAt) || 0,
        });
        // STEP 4：诊断判定「继续重试不可能成功」（验证码 / OTP / 权限 / 支付被拒 /
        // 凭据错误 / 记录重复）→ 立刻耗尽重试预算，不再把必然失败的请求重发 N 遍，
        // 直接进入修复/升级收口，并把根因带给修复链路（repairManager 会据此短路 LLM）。
        if (rec.escalate && rec.diagnosis) {
          retries = stepMax;          // 下一次迭代 canRetry=false → 直落 repair 分支
          skipExecution = true;       // 下一次迭代不再执行动作（关键：不重复提交必然失败的请求）
          pendingDiagnosis = rec.diagnosis;
          pendingDiagnosisStepId = step.id;
          pendingAction = null;
          events.emit({
            taskId: task.id, executionId: task.currentExecutionId, stepId: step.id,
            type: 'agent.escalating',
            payload: {
              rootCause: rec.diagnosis.rootCause, retryPolicy: rec.diagnosis.retryPolicy,
              confidence: rec.diagnosis.confidence, evidence: rec.diagnosis.evidence.slice(0, 5),
            },
          });
        } else if (rec.action) {
          pendingAction = rec.action; // 下次 runStep 用候选动作
        }
        if (rec.crash) {
          // BROWSER_CRASH：关闭失效 session 并交 recoveryManager.recover 重建浏览器 + 导航回现场，
          // 由 recover 启动新 run 协程；当前 run 直接退出，避免双协程。
          try { await browserManager.close(task.profileId).catch(() => {}); } catch (e) {}
          return taskManager.recover(task.id);
        }
        memory.record({
          site: (beforeObs && beforeObs.url) || task.targetUrl,
          taskType: 'form', error: r.error && (r.error.code || rec.category) || 'UNKNOWN',
          strategy: rec.category, success: false,
        });
      } catch (e) {
        pendingAction = null;
        // 注意：异常只清空候选动作，retries 已在迭代开头自增，不会造成死循环。
      }
      await backoffSleep(retries); // 重试退避（Phase 12B §T14）
      continue; // 同一 step 再跑一次新 Attempt（带恢复候选动作）
    }

    // 重试耗尽：进入修复编排（Phase 2.3）。修复失败/需审批 → 升级为显式终态，杜绝悬挂。
    // 5.9-E3 修复：修复编排内部含「真实 LLM 诊断 + 至多 3 次浏览器修复动作」，任一环节若挂起
    // （LLM 调用无超时 / 浏览器操作僵死）会让 runtime 主循环裸 await 永久不返回 → task 停在 RUNNING 永久悬挂。
    // 此处施加终态超时保护：超时即视为修复失败，明确收口为 FAILED，保证「错误的 Plan → 正确地失败」，
    // 绝不让一个已耗尽重试的任务永远 RUNNING。不改动 verification 语义 / planner / Plan / mockSite 等。
    // Phase 7 防御：已为终态（如 repair 已置 SUCCESS）的 step 不再尝试 HEALING（会触发非法状态转换），直接推进避免崩溃。
    const _liveR = (stepManager.getStep(step.id) || {}).status;
    if (_liveR === 'SUCCESS' || _liveR === 'SKIPPED') { index++; pendingAction = null; continue; }
    stepManager.setStepState(step.id, 'HEALING');
    if (process.env.E4_DIAG) console.warn('[runtime][E4-DIAG] 进入 repair 分支 step=' + step.id + ' attemptNo=' + attemptNo + ' code=' + (r.error && r.error.code));

    // ── 5.9-E3.1-DIAG（仅诊断，纯日志，不改行为）──
    // 为每个 repair 实例生成唯一 repairAttemptId，串起 runtime→repairManager→executor 全链路。
    // 受 E3_1_DIAG=1 触发；只回答 4 个问题，不修改任何控制流/终态。
    const _diagId = process.env.E3_1_DIAG === '1' ? ('RA_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)) : null;
    let _wd = null;
    if (_diagId) {
      console.warn('[E3.1-DIAG] RACE_CREATED', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, attemptNo, code: r.error && r.error.code, timeoutMs: REPAIR_TIMEOUT_MS }));
      // 看门狗：每 10s 打一次心跳（不 await、不阻塞），确认事件循环是否还活着。
      // 若 90s 内仍无任何后续日志且进程未退出 → 事件循环被冻结（timer 不调度），非 race promise 问题。
      _wd = setInterval(() => {
        console.warn('[E3.1-DIAG] WATCHDOG', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, alive: true, t: Date.now() }));
      }, 10000);
      if (_wd.unref) _wd.unref();
    }

    let outcome;
    try {
      outcome = await Promise.race([
        (async () => {
          if (_diagId) console.warn('[E3.1-DIAG] HANDLE_STEP_FAILURE_ENTER', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id }));
          const _r = await repairManager.handleStepFailure({
            repairAttemptId: _diagId,
            task, step, error: r.error, observation: beforeObs,
            execution: task.currentExecutionId ? recorder.get(task.currentExecutionId) : null,
            provider,
            // STEP 4：带上统一诊断结论；repairManager 据此对「不可重试」失败短路 LLM 并直接升级。
            priorDiagnosis: pendingDiagnosis,
          });
          if (_diagId) console.warn('[E3.1-DIAG] HANDLE_STEP_FAILURE_RETURN', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, outcome: { ok: !!_r.ok, paused: !!_r.paused, category: _r.category || null } }));
          return _r;
        })(),
        new Promise((_, reject) => setTimeout(() => {
          if (_diagId) console.warn('[E3.1-DIAG] RACE_TIMEOUT', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, timeoutMs: REPAIR_TIMEOUT_MS }));
          reject(new Error('REPAIR_TIMEOUT'));
        }, REPAIR_TIMEOUT_MS)),
      ]);
      if (_diagId) console.warn('[E3.1-DIAG] RACE_RESOLVE', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, outcome: { ok: !!outcome.ok, paused: !!outcome.paused } }));
      if (_wd) { try { clearInterval(_wd); } catch (e) {} }
    } catch (repairHang) {
      if (_diagId) console.warn('[E3.1-DIAG] RACE_REJECT', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, reason: String(repairHang.message || repairHang).slice(0, 120) }));
      if (_wd) { try { clearInterval(_wd); } catch (e) {} }
      // 修复编排挂起/抛错：明确终态 FAILED（带重试上下文），绝不回到 RUNNING。
      console.warn('[runtime][5.9-E3] repair 编排超时/异常，收口 FAILED:', String(repairHang.message || repairHang).slice(0, 160));
      const err = new Error(`${step.description || step.id} 修复编排超时/异常（重试${attemptNo}次耗尽）: ${String(repairHang.message || repairHang).slice(0, 200)} [${r.error && r.error.code}]`);
      finalizeOrphans(taskId);
      return taskManager.fail(taskId, err);
    }
    // REPLAN 续跑：Plan 本身已过期（DOM 结构变化 / 真实动作失败 / 证据契约家族
    // VERIFICATION_FAILED·VERIFICATION_TOO_STRICT·STATE_UNKNOWN 的证据契约错配，
    // 且常规重定位与重试已耗尽）→ 基于当前 observation 让 planner 重新生成「剩余步骤」并替换，继续主循环；
    // 受 maxReplans 约束，耗尽后落入下方 escalate/fail 终态（绝不无限循环）。
    // STEP 4：诊断判定「不可重试」的失败（验证码/OTP/权限/支付被拒/凭据错误/记录重复）
    // 不允许走 replan —— 目标本身不可能达成，重新规划只会生成另一份不可能的计划。
    if (outcome.paused && !outcome.notRetriable && isReplanCandidate(r.error, step) && (task.replanCount || 0) < maxReplansFor(task)) {
      // R5 churn 熔断（2026-09-03）：同一业务位置连续 replan 且失败签名相同 → replan 无法收敛，
      // 继续循环只会烧满任务预算（rw.091 实证：21 attempts / 241s 被 harness 杀）。
      // 首次 replan 永远允许；连续第 2 次同签名即熔断 → 落入下方 outcome.paused → HUMAN_ESCALATION。
      const _r5sig = stepFailureSignature(step, r.error);
      const _r5cnt = sameSigReplanCount(_r5sig, lastReplanSig, sameSigReplanRun);
      if (shouldFuseSameSigReplan(_r5cnt)) {
        events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'agent.replan_fused', payload: { signature: _r5sig, sameSigReplans: _r5cnt, replanCount: task.replanCount || 0, errorCode: (r.error && r.error.code) || null } });
        console.warn('[runtime][R5] 同签名连续 replan 熔断，转显式升级:', task.id, _r5sig);
        // 不进入 replan；落入下方 escalate 终态
      } else {
        lastReplanSig = _r5sig;
        sameSigReplanRun = _r5cnt;
        const rp = await tryReplan(task, beforeObs, steps, index);
        if (rp && rp.ok) {
          task.replanCount = (task.replanCount || 0) + 1;
          try { store.upsert('aiTasks', task); } catch (e) {}
          steps = stepManager.listSteps(task.id);
          // 当前失败 step 已被新计划替换；从 index 处的新 step 继续（置 PENDING 确保重跑）
          if (steps[index]) { try { stepManager.setStepState(steps[index].id, 'PENDING'); } catch (e) {} }
          retries = 0;
          events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'agent.replan', payload: { replanCount: task.replanCount, reason: 'plan stale → regenerate remaining steps' } });
          continue;
        }
        // replan 失败 → 落入下方 escalate/fail 终态
      }
    }

    if (outcome.paused) {
      // 需人工：Phase 5.8 升级为 HUMAN_ESCALATION 显式终态（原 PAUSED_FOR_HUMAN 非终态，会永久悬挂）。
      const err = new Error(`${step.description || step.id} 需人工处理（重试${attemptNo}次耗尽）: ${outcome.reason || (r.error && r.error.message) || 'unknown'}`);
      if (_diagId) console.warn('[E3.1-DIAG] TASK_ESCALATE_ENTER', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, reason: outcome.reason || null }));
      finalizeOrphans(taskId);
    return taskManager.escalate(taskId, err, { reason: outcome.reason || null });
    }
    if (outcome.ok) {
      // 修复成功：step 已置 SUCCESS，checkpoint 后继续
      const cp = checkpoint.save(task.id, {
        executionId: task.currentExecutionId, profileId: task.profileId,
        stepId: step.id, url: beforeObs ? beforeObs.url : null,
        lastVerifiedState: { stepId: step.id, repaired: true },
        lastSuccessfulAction: step.action,
      });
      const t = getTask(taskId);
      if (t) { t.checkpointId = cp.id; store.upsert('aiTasks', t); }
      index++;
      retries = 0;
      continue;
    }
    // 修复亦失败：明确终态 FAILED（带重试上下文，便于诊断）。
    const err = new Error(`${step.description || step.id} 修复失败（重试${attemptNo}次耗尽）: ${(r.error && r.error.message) || '未知错误'} [${r.error && r.error.code}]`);
    if (_diagId) console.warn('[E3.1-DIAG] TASK_FAIL_ENTER', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, code: r.error && r.error.code }));
    finalizeOrphans(taskId);
    return taskManager.fail(taskId, err);
  }

  // 循环正常结束
  task = getTask(taskId);
  if (task && task.status === 'RUNNING') {
    const allSteps = stepManager.listSteps(task.id);
    const okSteps = allSteps.filter((s) => s.status === 'SUCCESS').length;
    const unfinished = allSteps.filter((s) => s.status !== 'SUCCESS' && s.status !== 'SKIPPED');
    if (unfinished.length) {
      // B.4：存在未真正完成的步骤（如停在 HEALING/PENDING/FAILED），不得标 SUCCESS。
      // 降级为 FAILED，携带未完成任务清单，避免 silent-pass 掩盖失败。
      const detail = unfinished.map((s) => `${s.id}(${s.status})`).join(', ');
      return taskManager.fail(taskId, new Error(`任务完成但存在未成功步骤 [${detail}]（${okSteps}/${allSteps.length} 成功）`));
    }
    finalizeOrphans(taskId);
    taskManager.complete(taskId, { completedSteps: okSteps, totalSteps: steps.length });
  }
  } catch (fatal) {
    // Phase 5.8 防御（Finding #1 家族）：任何未预期异常（含浏览器崩溃抛错）都必须落为显式终态，
    // 否则 task 会停在 RUNNING 永久悬挂、worker 占坑导致后续任务饿死。
    console.warn('[runtime] run 未捕获异常，转 FAILED 终态:', String(fatal && fatal.message || fatal).slice(0, 200));
    try {
      const t = getTask(taskId);
      if (t && !['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'].includes(t.status)) {
        taskManager.fail(taskId, new Error('runtime 执行异常: ' + String(fatal && fatal.message || fatal).slice(0, 200)));
      }
    } catch (e) {}
  }
}

// 由 TaskManager 触发（start/resume/retry 后自动 kick）
taskManager.setExecutor(run);

// ---- REPLAN 支持（policy.maxReplans 约束，杜绝无限循环）----
function maxReplansFor(task) {
  const p = { ...DEFAULT_POLICY, ...((task && task.policy) || {}) };
  return (typeof p.maxReplans === 'number' && p.maxReplans >= 0) ? p.maxReplans : DEFAULT_POLICY.maxReplans;
}

// 凭证/支付/登录等需人工的动作：即便真实失败也不自动 REPLAN（交 HUMAN_ESCALATE）
function isCredentialishStep(step) {
  const a = step && step.action;
  if (!a) return false;
  if (a.risk === 'CRITICAL') return true;
  if (['purchase', 'payment', 'password_change', 'delete', 'login'].includes(a.type)) return true;
  const f = String((a.target && (a.target.field || a.target.semantic)) || '');
  if (/password|card|cvv|otp|支付|付款|登录|密码|卡号/.test(f)) return true;
  return false;
}

// 是否为「Plan 过期」信号（触发 REPLAN 的候选）：
//   - DOM_CHANGED：页面结构变化，原 plan 的元素定位已失效
//   - ACTION_REAL_FAILURE：真实动作失败（非凭证类），可能 plan 步骤本身不再适用
//   - 证据契约家族（OPT-B 2026-09-03）：VERIFICATION_FAILED / VERIFICATION_TOO_STRICT /
//     STATE_UNKNOWN —— VIL 判定「动作成功但预生成证据契约无法匹配真实成功状态」，
//     即 plan 的证据契约本身过期/错配。failureDiagnoser.POLICY 对三者既有声明均为
//     'replan'，但执行路径此前未兑现（B 类一致性缺陷）：VERIFY_RETRY 重观察重验证
//     耗尽后直接 HUMAN_ESCALATION（历史 store 111/446=24.9%，最大自动可恢复升级桶）。
//     现将其纳入 replan 候选：基于实况 observation 重生成剩余步骤，受 maxReplans 约束。
//     红线：不降低验证标准、不做替代验证态（OPT-C 禁）、凭证/支付/登录类不自动重规划、
//     notRetriable（验证码/OTP/支付被拒等 STEP 4 诊断）仍被主循环短路。
//   - 显式标记（verifyFailed 返回 error.needsReplan）
const EVIDENCE_CONTRACT_FAMILY = ['VERIFICATION_FAILED', 'VERIFICATION_TOO_STRICT', 'STATE_UNKNOWN'];
function isReplanCandidate(err, step) {
  if (!err) return false;
  if (err.needsReplan) return true;
  const ft = err.failureType;
  if (ft === 'DOM_CHANGED') return true;
  if (ft === 'ACTION_REAL_FAILURE') return !isCredentialishStep(step);
  if (EVIDENCE_CONTRACT_FAMILY.includes(ft)) return !isCredentialishStep(step);
  return false;
}

// R5（2026-09-03）churn 熔断纯函数（canonical240_run1 rw.091 实证，可测试）。
// 签名 = 业务语义位置（action.type + target.semantic/field/selector）+ 失败类型。
// 刻意不含 step.id（replan 后变 _rp 序号，业务位置不变）、不含 error.message 全文（LLM 措辞抖动）。
function stepFailureSignature(step, err) {
  const a = step && step.action;
  if (!a || !a.type) return null;
  const t = a.target || {};
  const target = String(t.semantic || t.field || t.selector || '');
  const ft = (err && (err.failureType || err.code)) || 'UNKNOWN';
  return a.type + '|' + target + '|' + ft;
}

// 连续同签名 replan 计数：与上一轮 replan 前签名相同 → prev+1；不同或首轮 → 0。
function sameSigReplanCount(sig, lastSig, prevCount) {
  if (!sig || !lastSig) return 0;
  return sig === lastSig ? (prevCount || 0) + 1 : 0;
}

// 阈值 0：连续第 2 次同签名 replan 即熔断（首次 replan 永远允许 —— 给收敛一次机会）。
// rw.091 场景收益：21 attempts/241s 被外力杀 → 14 attempts/~160s 显式 HUMAN_ESCALATION。
const R5_MAX_SAME_SIG_REPLANS = 0;
function shouldFuseSameSigReplan(count) { return (count || 0) > R5_MAX_SAME_SIG_REPLANS; }

// 基于当前观察重生成「剩余步骤」并替换原 plan 中从 index 起的部分。
// 防御：任何失败返回 { ok:false } → 调用方降级为 escalate/fail（不静默通过）。
async function tryReplan(task, observation, steps, index) {
  try {
    const pr = await planner.replan(task, observation, steps.slice(index), provider);
    if (!pr || !pr.ok || !Array.isArray(pr.steps) || !pr.steps.length) {
      return { ok: false, error: (pr && pr.error) || 'replan 无步骤' };
    }
    // 删除旧剩余步骤（index 起），写入新生成的剩余步骤
    steps.slice(index).forEach((s) => { try { store.remove('aiSteps', s.id); } catch (e) {} });
    // B1 修复（2026-09-01）：replan 的 plan 步骤被 normalizeStrictToCanonical 统一重编号为
    // step_001..N，直接挂载必与旧 SUCCESS 步骤 id 冲突 → getStep 命中旧步骤 → 主循环
    // 「已终态跳过」逻辑误跳过 replan 新步骤 → B.4 收口守卫以 PENDING 残留判 FAILED
    // （Final100 实证 rw.005/060/061/075）。挂载前分配无冲突 id（_rp 序号），原 id 语义保留。
    pr.steps.forEach((s, i) => {
      const clone = Object.assign({}, s);
      clone.id = stepManager.uniqueStepId(task.id, s.id);
      stepManager.createStep(task.id, clone, index + i);
    });
    return { ok: true };
  } catch (e) {
    console.warn('[runtime] replan 生成失败，降级 escalate:', String((e && e.message) || e).slice(0, 160));
    return { ok: false };
  }
}

// v0.2.1：轻量等待（用于 VIL 内联验证重试，不阻塞事件循环）
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 修复编排超时解析（纯函数，run() 每次调用时求值）：FPB_REPAIR_TIMEOUT_MS 显式覆盖，
// 解析失败/0/负数一律回退 90000 默认（默认路径语义零变化）。
function resolveRepairTimeoutMs(v) {
  const n = parseInt(v || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 90000;
}

module.exports = { run, ensureBrowser, resolvePlan, runStep, tryReplan, resolveRepairTimeoutMs, isReplanCandidate, stepFailureSignature, sameSigReplanCount, shouldFuseSameSigReplan, isStepRunActive, invalidateStepRun };
