'use strict';

// Phase 5.9-E4 — Plan Semantic Compatibility Smoke (11×1)
//
// 授权目标（用户裁定，2026-08-24）：
//   研究 Real LLM Planner 生成的 Plan 与真实页面/任务环境之间的「语义兼容性」。
//   不是提高 D' 成功率。
//
// 纪律红线（本轮绝对不能）：
//   ❌ 修改 task.verify / Ground Truth / element_present 定义 / retry 次数
//   ❌ 为 LLM Plan 注入答案 / 给 Planner 偷塞正确 selector / 修改 mockSite
//   ❌ 重新启用 Plan Bridge / 把 Deterministic Plan 当 fallback
//   ❌ 因失败自动修改 Plan / 修改 elementChanged 语义来提高成功率
//   ❌ 运行 100×3 / 提前启动 D' / 根据结果临时修改任务
//   ❌ 尤其：elementChanged → email/password 错配必须保持原样进入实验（这正是 E4 要测的对象）
//
// 本模块纯粹「采集 + 归因 + 记录 FINDING」，不做任何行为修改。
// 发现 Observation 缺失 / selector 错 / verification 错 / semantic resolver 错 / elementChanged 错
//   → 统一记录为 FINDING，然后冻结当前 E4，不在实验过程中修问题。
//
// semanticCompatibility 分类（不二元化成 Success%）：
//   VALID_EXECUTABLE              schema 合法 且 目标在页面真实存在 且 执行成功
//   VALID_BUT_SEMANTICALLY_MISMATCHED  schema 合法 但 目标在页面不存在/错配(臆测)
//   INVALID_SCHEMA                Plan 未通过 schema 校验
//   EXECUTION_FAILURE             执行动作失败（ELEMENT_NOT_FOUND/ACTION_FAILED 等）
//   VERIFICATION_FAILURE          action 执行了但 verification 失败
//   RECOVERY_FAILURE              触发了 recovery/repair 但最终未恢复
//
// 输出层级：
//   Schema Validity → Semantic Compatibility → Executable Compatibility → GroundTruth Outcome

const fs = require('fs');
const path = require('path');

const SEMANTIC_CLASSES = [
  'VALID_EXECUTABLE',
  'VALID_BUT_SEMANTICALLY_MISMATCHED',
  'INVALID_SCHEMA',
  'EXECUTION_FAILURE',
  'VERIFICATION_FAILURE',
  'RECOVERY_FAILURE',
];

// 从 step 的 action.target 抽取用于 grounding 校验的「目标描述」
function extractTargetProbe(target) {
  if (!target) return null;
  // 优先 selector（若存在，直接在 DOM 查）
  if (typeof target.selector === 'string' && target.selector.trim()) {
    return { kind: 'selector', value: target.selector.trim() };
  }
  // semantic 描述：用词匹配页面 text/aria
  if (typeof target.semantic === 'string' && target.semantic.trim()) {
    return { kind: 'semantic', value: target.semantic.trim() };
  }
  if (typeof target.field === 'string' && target.field.trim()) {
    return { kind: 'field', value: target.field.trim() };
  }
  if (typeof target.role === 'string' && target.role.trim()) {
    return { kind: 'role', value: target.role.trim() };
  }
  if (typeof target.text === 'string' && target.text.trim()) {
    return { kind: 'semantic', value: target.text.trim() };
  }
  if (typeof target.url === 'string' && target.url.trim()) {
    return { kind: 'url', value: target.url.trim() };
  }
  return null;
}

// 用真实页面 observation 只读校验 target 是否存在（不反喂 planner）
function groundTarget(probe, observation) {
  if (!probe) return { grounded: null, reason: 'no-target' };
  if (!observation || !observation.ok) return { grounded: null, reason: 'no-observation' };

  const obs = observation.observation || {};
  const elements = obs.elements || [];
  const textSummary = (obs.textSummary || '').toLowerCase();

  if (probe.kind === 'selector') {
    // selector 校验：若 observation 未提供 raw selector 匹配，退化为语义关键词比对
    // 注意：observation.inspect 不输出每个元素的 CSS selector，仅输出 role/tag/text。
    // 因此对 selector 我们不能直接查 DOM，改为：把 selector 末段作为关键词在 elements 文本中比对。
    const kw = probe.value.split(/[ .>#\[\]=:"']+/).filter(Boolean).pop() || probe.value;
    const hit = elements.some((e) =>
      (e.text || '').toLowerCase().includes(kw.toLowerCase()) ||
      (e.label || '').toLowerCase().includes(kw.toLowerCase()) ||
      (e.placeholder || '').toLowerCase().includes(kw.toLowerCase()) ||
      (e.ariaLabel || '').toLowerCase().includes(kw.toLowerCase()) ||
      (e.id || '').toLowerCase() === kw.toLowerCase());
    return { grounded: hit, reason: hit ? 'selector-keyword-in-dom' : 'selector-keyword-absent' };
  }
  if (probe.kind === 'semantic' || probe.kind === 'field' || probe.kind === 'role') {
    const kw = probe.value.toLowerCase();
    const hit = elements.some((e) =>
      (e.text || '').toLowerCase().includes(kw) ||
      (e.label || '').toLowerCase().includes(kw) ||
      (e.placeholder || '').toLowerCase().includes(kw) ||
      (e.ariaLabel || '').toLowerCase().includes(kw)) ||
      textSummary.includes(kw);
    return { grounded: hit, reason: hit ? 'keyword-in-dom' : 'keyword-absent' };
  }
  if (probe.kind === 'url') {
    return { grounded: true, reason: 'url-target(navigate)' };
  }
  return { grounded: null, reason: 'unknown-probe' };
}

// 逐步语义兼容性归因
function classifyStepCompat(step, grounding) {
  const status = step.status;
  const action = step.action;
  const failureLayer = step.failureLayer;

  // schema 非法：step 无 action 或 action.type 缺失
  if (!action || !action.type) {
    return { cls: 'INVALID_SCHEMA', note: 'step 无合法 action' };
  }
  // 触发了 recovery 但未成功（RECOVERY_FAILURE 优先于单纯执行失败）
  if (step.recoveryTriggered && !step.recoverySuccess) {
    return { cls: 'RECOVERY_FAILURE', note: 'recovery/repair 触发但未恢复' };
  }
  if (status === 'SUCCESS') {
    // 执行成功：看 grounding
    if (grounding && grounding.grounded === true) {
      return { cls: 'VALID_EXECUTABLE', note: 'schema 合法 + 目标真实存在 + 执行成功' };
    }
    if (grounding && grounding.grounded === false) {
      // 执行成功但目标在页面不存在（可能是 navigate 类或 verify 宽松）
      return { cls: 'VALID_EXECUTABLE', note: '执行成功(目标 grounding 缺失，可能 navigate/verify 宽松)' };
    }
    return { cls: 'VALID_EXECUTABLE', note: '执行成功(无法 grounding 校验)' };
  }
  if (status === 'FAILED' || status === 'HEALING' || status === 'PENDING') {
    if (failureLayer === 'Verification') {
      return { cls: 'VERIFICATION_FAILURE', note: step.lastError || 'verification 失败' };
    }
    if (failureLayer === 'Action' || /ELEMENT_NOT_FOUND|ACTION_INVALID|ACTION_FAILED/.test(step.lastError || '')) {
      // 区分：语义错配（grounding=false）vs 执行环境失败（grounding=null/true）
      if (grounding && grounding.grounded === false) {
        return { cls: 'VALID_BUT_SEMANTICALLY_MISMATCHED', note: 'schema 合法但目标在页面不存在(臆测): ' + (step.lastError || '') };
      }
      return { cls: 'EXECUTION_FAILURE', note: step.lastError || 'action 执行失败' };
    }
    return { cls: 'EXECUTION_FAILURE', note: step.lastError || 'step 失败(非 SUCCESS)' };
  }
  return { cls: 'EXECUTION_FAILURE', note: '未归类 status=' + status };
}

// 主入口：跑 11×1，逐任务/逐步采集
// opts.limit：限制任务数（用于 3-task smoke 验证隔离后连续进入）
async function runE4Smoke(opts = {}) {
  const limit = (typeof opts.limit === 'number' && opts.limit > 0) ? opts.limit : 11;
  const taskIds = Array.isArray(opts.taskIds) ? opts.taskIds : null;
  const dProvider = process.env.BENCH_D_PROVIDER || process.env.AI_PROVIDER || 'deepseek';
  const keyEnv = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[dProvider] || 'AI_API_KEY';
  if (dProvider !== 'mock' && !process.env[keyEnv]) {
    console.error(`\n[E4] ⛔ 护栏拦截：真实 LLM provider="${dProvider}" 需要 ${keyEnv}，未设置。`);
    process.exit(2);
  }

  const AgentRunner = require('./runners/agentRunner').AgentRunner;
  const { allTasks } = require('./tasks');
  const plannerMod = require('./../server/agent/planner');
  const observation = require('./../server/agent/observation');
  const browserManager = require('./../server/browserManager');
  const taskManager = require('./../server/agent/taskManager');

  // ── 纯观测 wrap（不改行为）：记录 planner 实际看到的输入来源 ──
  // E4-1 核心证据：observation 是否进入 Planner 上下文。
  //
  // E4-Collector-Instrumentation 修正（2026-08-24）：
  //   旧方案 plannerCalled = plannerProbe.called > 0 存在三类缺陷：
  //     (1) runtime.resolvePlan 的 `if (steps.length) return steps` 缓存短路 → planner 不被调用，probe 不计数；
  //     (2) 多 collector 对同一 plannerMod.planObjective 嵌套 wrap → 计数语义混乱；
  //     (3) 同进程状态污染（重跑同 task_id 命中历史 aiSteps）。
  //   新方案：plannerProbe 仍保留作为「直接观测交叉验证」，但 plannerCalled 的权威来源改为
  //     task-scoped 排除法（见下方 per-task invocationRecord）：
  //       在「新 task_id + BENCH_PLAN_BRIDGE=false + 启动前无历史 aiSteps」受控前提下，
  //       run 后 stepManager 存在该 task 的 aiSteps 且非 Bridge 注入 → 只能来自 runtime 真实调用 planner
  //       （CACHE/BRIDGE 均被排除）。这构成可审计的 REAL_LLM invocation 证据，而非 monkey-patch 单点计数。
  //   若连排除法也无法可靠证明（例如无法确认 bridge 状态/历史残留），则明确记录 UNOBSERVABLE，不推断。
  const plannerProbe = { called: 0, calls: [], perTask: Object.create(null) };
  const origPlanObjective = plannerMod.planObjective;
  plannerMod.planObjective = async function wrappedPlanObjective(...args) {
    plannerProbe.called++;
    const a0 = args[0] || {};
    const hasObservation = !!(
      a0.observation ||
      (a0.ctx && a0.ctx.observation) ||
      a0.pageSnapshot ||
      (a0.ctx && a0.ctx.pageSnapshot)
    );
    const rec = {
      objective: (a0.objective || '').slice(0, 120),
      target: a0.target || '',
      providerKind: a0.provider && a0.provider.kind,
      observationPassed: hasObservation,
      observationTokens: hasObservation ? 'n/a' : 0,
      observationSummary: hasObservation ? '(passed)' : '(NOT passed to planner)',
      ctxKeys: a0.ctx ? Object.keys(a0.ctx) : [],
    };
    plannerProbe.calls.push(rec);
    // 按 objective 关键字粗略分桶（同一次 run 内单 task，足够区分）
    const key = (a0.objective || '').slice(0, 40);
    plannerProbe.perTask[key] = (plannerProbe.perTask[key] || 0) + 1;
    console.error(`[E4-observe] planner#${plannerProbe.called} observationPassed=${hasObservation} ctxKeys=${JSON.stringify(rec.ctxKeys)} objective="${rec.objective.slice(0, 60)}"`);
    return origPlanObjective.apply(this, args);
  };

  // ── mock site ──
  const mockApp = require('./mockSite').buildApp();
  const mockServer = await new Promise((res) => { const s = mockApp.listen(0, () => res(s)); });
  const mockPort = mockServer.address().port;
  const mockUrl = `http://localhost:${mockPort}`;
  console.log('[E4] mock site up', mockUrl);
  const runOpts = { mockBaseUrl: mockUrl };

  let tasks = allTasks();
  if (taskIds) tasks = tasks.filter((t) => taskIds.includes(t.id));
  tasks = tasks.slice(0, limit); // 默认 11，smoke 可 limit
  console.log(`\n[E4] ${(taskIds ? taskIds.join('+') : (limit === 11 ? '11×1' : limit + '-task'))} Smoke 启动：provider=${dProvider}  tasks=${tasks.length}  PlanBridge=OFF(真实 Planner)\n`);

  const findings = [];
  const taskReports = [];

  // 只读引用 stepManager（仅用于 run 前后对比某 task 的 aiSteps 数，区分 REAL_LLM 落库 vs 历史残留）
  const stepManager = require('./../server/agent/stepManager');

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    // 独立 id（避免 store 串扰）。
    // 若调用方显式指定 clean taskId（opts.cleanTaskIds），则优先用原始 task id 作为 E4 任务 id，
    // 确保「新 task_id + 无历史 aiSteps」受控前提（Plan cache 污染隔离）。
    const cleanId = (opts.cleanTaskIds && opts.cleanTaskIds[t.id]) || null;
    const taskE4Id = cleanId || `E4-${t.id}#${i}`;
    const taskInst = Object.assign({}, t, { id: taskE4Id, _baseId: t.id });
    console.log(`\n[E4] ── 任务 ${i + 1}/${tasks.length}: ${t.id} (e4Id=${taskE4Id}, category=${t.category}) ──`);

    // Plan Bridge 状态（harness 控制，决定 planOrigin 权威判定）：
    //   - 若 this.planBridgeOverride 显式设置 → 用其值；
    //   - 否则走全局 env BENCH_PLAN_BRIDGE。
    // collector 不修改此行为，仅读取以判定 planOrigin。
    const bridgeActive = !!process.env.BENCH_PLAN_BRIDGE;

    // run 前：记录该 task 的历史 aiSteps（用于检测 cache 污染 / 历史残留）
    let preSteps = 0;
    try { preSteps = stepManager.listSteps(taskE4Id).length; } catch (_) {}

    const runner = new AgentRunner(runOpts);
    let row;
    try {
      row = await runner.run(taskInst);
    } catch (e) {
      console.error(`[E4] 任务 ${t.id} 运行异常:`, String(e.message || e).slice(0, 200));
      row = { success: false, error: String(e.message || e).slice(0, 200), raw: {} };
    }

    const r = row.raw || {};
    const trace = r.trace || {};
    const steps = trace.steps || [];

    // run 后：实际落库的 aiSteps（权威 planStepCount 来源）
    let postSteps = 0;
    try { postSteps = stepManager.listSteps(taskE4Id).length; } catch (_) {}

    // planner 输入（取最近一次对本 task 的调用，按序取最后一个 probe）
    const pp = plannerProbe.calls[plannerProbe.calls.length - 1] || { observationPassed: false, ctxKeys: [] };
    // 直接观测交叉验证：plannerProbe 在本进程内为单一 wrap（无嵌套），若捕获到调用则为真直接证据
    const directProbeHit = plannerProbe.called > 0 && plannerProbe.calls.some((c) => (c.objective || '').startsWith((t.objective || '').slice(0, 40)));

    // 事后只读 grounding 校验：用真实页面 observation 校验每步 target
    // E4-Harness-Isolation：用本任务独立 profileId 取 session（不反喂 planner）
    let pageObs = null;
    try {
      const profileId = r.profileId;
      const session = profileId ? browserManager.getSession(profileId) : null;
      if (session && session.page && typeof session.page.isClosed === 'function' && !session.page.isClosed()) {
        pageObs = await observation.inspect(session.page, { taskId: taskInst.id, skipCache: true });
      } else {
        pageObs = { ok: false, error: 'no-live-session(profile=' + (profileId || 'n/a') + ')' };
      }
    } catch (oe) {
      pageObs = { ok: false, error: String(oe.message || oe).slice(0, 120) };
    }

    // 逐步语义兼容性
    const stepReports = steps.map((s) => {
      const probe = extractTargetProbe(s.action && s.action.target);
      const grounding = groundTarget(probe, pageObs);
      const compat = classifyStepCompat(s, grounding);
      return {
        index: s.index,
        action: s.action ? s.action.type : null,
        target: s.action ? s.action.target : null,
        verification: s.verification,
        selector: probe ? probe.value : null,
        targetExists: grounding.grounded,
        groundingReason: grounding.reason,
        executionResult: s.status,
        failureCode: s.failureLayer,
        lastError: s.lastError,
        retryCount: s.attemptCount ? s.attemptCount - 1 : 0,
        repairStrategy: (trace.recovery && trace.recovery.recoveryTypes) || [],
        semanticCompatibility: compat.cls,
        semanticNote: compat.note,
      };
    });

    // 任务级语义兼容性聚合
    const clsCounts = {};
    SEMANTIC_CLASSES.forEach((c) => (clsCounts[c] = 0));
    stepReports.forEach((sr) => { clsCounts[sr.semanticCompatibility] = (clsCounts[sr.semanticCompatibility] || 0) + 1; });

    const planGenerated = (trace.planStepCount || steps.length) > 0;
    const planSchemaValid = planGenerated;
    const semanticMismatchCount = clsCounts.VALID_BUT_SEMANTICALLY_MISMATCHED;
    const execFailureCount = clsCounts.EXECUTION_FAILURE;
    const verifyFailureCount = clsCounts.VERIFICATION_FAILURE;
    const recoveryFailureCount = clsCounts.RECOVERY_FAILURE;

    // ── E4-Collector-Instrumentation 修正：task-scoped planner invocation 权威判定 ──
    // 受控前提（由 clean task 验收脚本保证）：
    //   - 新 task_id（无历史 aiSteps）→ 排除 CACHE 短路
    //   - BENCH_PLAN_BRIDGE=false    → 排除 BRIDGE 注入
    // 在此前提下：
    //   postSteps > 0 且 preSteps === 0  → aiSteps 由本次 run 的 runtime 写入 → 只能来自 REAL_LLM planner invocation
    //   postSteps > 0 且 preSteps > 0     → 命中历史残留（cache contamination），标记 INCONCLUSIVE
    //   postSteps === 0                  → 无 plan 落地（planner 失败或未调用）
    // 同时用 plannerProbe 直接观测作交叉验证（单一 wrap，无嵌套）。
    // 若连排除法也无法可靠证明 bridge/历史状态 → plannerInvocationEvidence = 'UNOBSERVABLE'（不推断）。
    let plannerInvocationEvidence = 'UNOBSERVABLE';
    let planOrigin = 'UNKNOWN';
    let plannerSource = 'UNKNOWN';
    let plannerCalled = false;
    if (bridgeActive) {
      // Plan Bridge 启用：steps 来自注入，非真实 planner
      planOrigin = 'BRIDGE';
      plannerSource = 'BRIDGE';
      plannerInvocationEvidence = (postSteps > 0) ? 'BRIDGE_INJECTED' : 'BRIDGE_NONE';
      plannerCalled = false;
    } else if (preSteps > 0) {
      // 历史残留：无法区分本次是否真实调用 planner（cache contamination）
      planOrigin = 'CACHE_OR_PRIOR';
      plannerSource = 'UNKNOWN';
      plannerInvocationEvidence = 'CACHE_CONTAMINATION';
      plannerCalled = false;
    } else if (postSteps > 0) {
      // 受控前提满足（无 bridge、无历史残留、有 steps 落地）→ 必然是 runtime 真实调用 planner
      planOrigin = 'REAL_LLM';
      plannerSource = 'REAL_LLM';
      if (directProbeHit) {
        plannerInvocationEvidence = 'DIRECT_PROBE+INFERRED_REAL_LLM';
        plannerCalled = true;
      } else {
        plannerInvocationEvidence = 'INFERRED_REAL_LLM';
        plannerCalled = true;
      }
    } else {
      planOrigin = 'NONE';
      plannerSource = 'NONE';
      plannerInvocationEvidence = 'NO_PLAN';
      plannerCalled = false;
    }

    const invocationRecord = {
      taskId: taskE4Id,
      baseTaskId: t.id,
      executionId: r.executionId,
      invocationCount: directProbeHit ? (plannerProbe.perTask[(t.objective || '').slice(0, 40)] || 0) : 0,
      invoked: plannerCalled,
      source: plannerSource,
      plannerInvocationEvidence,
      planOrigin,
      planStepCount: postSteps || (trace.planStepCount || steps.length),
      preExistingSteps: preSteps,
      postSteps,
      bridgeActive,
      timestamp: Date.now(),
    };

    const report = {
      task: t.id,
      e4TaskId: taskE4Id,
      category: t.category,
      // 旧字段保留（plannerCalled 现由权威判定驱动，而非单一 monkey-patch 计数）
      plannerCalled,
      plannerInvocationEvidence,
      planOrigin,
      plannerSource,
      llmCalls: row.llmCalls || (trace.intelligence && trace.intelligence.llmCalls) || 0,
      observationPassed: pp.observationPassed,
      observationTokens: pp.observationTokens,
      observationSummary: pp.observationSummary,
      planGenerated,
      planSchemaValid,
      planStepCount: invocationRecord.planStepCount,
      invocationRecord,
      stepCompat: clsCounts,
      semanticMismatchCount,
      execFailureCount,
      verifyFailureCount,
      recoveryFailureCount,
      groundingRate: (() => {
        const g = stepReports.filter((s) => s.targetExists !== null);
        if (!g.length) return null;
        return g.filter((s) => s.targetExists === true).length / g.length;
      })(),
      runtimeStatus: r.runtimeStatus,
      groundTruth: r.groundTruth,
      intelligenceEvaluation: !!(r.intelligenceRecorded),
      terminalStatus: r.runtimeStatus,
      steps: stepReports,
    };
    taskReports.push(report);

    // FINDING 规则（只记录，不修改）
    if (!pp.observationPassed) {
      findings.push({ task: t.id, type: 'OBSERVATION_MISSING', severity: 'HIGH',
        detail: 'Planner 生成 Plan 时未收到页面 observation（ctx 仅含 ' + JSON.stringify(pp.ctxKeys) + '）。LLM 凭 objective 臆测页面结构。' });
    }
    if (semanticMismatchCount > 0) {
      findings.push({ task: t.id, type: 'SEMANTIC_MISMATCH', severity: 'HIGH',
        detail: `${semanticMismatchCount} 步 schema 合法但目标在真实页面不存在（臆测 selector/target）。` });
    }
    if (recoveryFailureCount > 0) {
      findings.push({ task: t.id, type: 'RECOVERY_FAILURE', severity: 'MED',
        detail: `${recoveryFailureCount} 步触发 recovery 但未恢复。` });
    }

    console.log(`[E4]   plannerCalled=${report.plannerCalled} invocationEvidence=${report.plannerInvocationEvidence} planOrigin=${report.planOrigin} source=${report.plannerSource}`);
    console.log(`[E4]   obsPassed=${report.observationPassed} preSteps=${preSteps} postSteps=${postSteps} planSchemaValid=${report.planSchemaValid} steps=${report.planStepCount}`);
    console.log(`[E4]   compat=${JSON.stringify(clsCounts)} grounding=${report.groundTruth ? 'GT=Y' : 'GT=N'} terminal=${report.terminalStatus}`);
  }

  await new Promise((res) => mockServer.close(() => res()));

  // ── 聚合指标（不以 Success% 为主）──
  const agg = {
    tasks: taskReports.length,
    observationCoverage: taskReports.filter((r) => r.observationPassed).length / taskReports.length,
    planSchemaValidRate: taskReports.filter((r) => r.planSchemaValid).length / taskReports.length,
    planSemanticCompatRate: (() => {
      const mism = taskReports.reduce((a, r) => a + r.semanticMismatchCount, 0);
      const total = taskReports.reduce((a, r) => a + r.planStepCount, 0);
      return total ? 1 - mism / total : null;
    })(),
    targetGroundingRate: (() => {
      const all = taskReports.flatMap((r) => r.steps).filter((s) => s.targetExists !== null);
      return all.length ? all.filter((s) => s.targetExists === true).length / all.length : null;
    })(),
    verificationCompatRate: (() => {
      const vf = taskReports.reduce((a, r) => a + r.verifyFailureCount, 0);
      const total = taskReports.reduce((a, r) => a + r.planStepCount, 0);
      return total ? 1 - vf / total : null;
    })(),
    firstStepCompatRate: (() => {
      const fs0 = taskReports.map((r) => r.steps[0]).filter(Boolean);
      if (!fs0.length) return null;
      const ok = fs0.filter((s) => s.semanticCompatibility === 'VALID_EXECUTABLE' || s.semanticCompatibility === 'VALID_BUT_SEMANTICALLY_MISMATCHED').length;
      return ok / fs0.length;
    })(),
    semanticFailureAttribution: {
      VALID_EXECUTABLE: taskReports.reduce((a, r) => a + r.stepCompat.VALID_EXECUTABLE, 0),
      VALID_BUT_SEMANTICALLY_MISMATCHED: taskReports.reduce((a, r) => a + r.stepCompat.VALID_BUT_SEMANTICALLY_MISMATCHED, 0),
      INVALID_SCHEMA: taskReports.reduce((a, r) => a + r.stepCompat.INVALID_SCHEMA, 0),
      EXECUTION_FAILURE: taskReports.reduce((a, r) => a + r.stepCompat.EXECUTION_FAILURE, 0),
      VERIFICATION_FAILURE: taskReports.reduce((a, r) => a + r.stepCompat.VERIFICATION_FAILURE, 0),
      RECOVERY_FAILURE: taskReports.reduce((a, r) => a + r.stepCompat.RECOVERY_FAILURE, 0),
    },
    terminalFinalizationRate: taskReports.filter((r) => ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(r.terminalStatus)).length / taskReports.length,
    groundTruthPassRate: taskReports.filter((r) => r.groundTruth === true).length / taskReports.length,
  };

  return {
    phase: '5.9-E4',
    note: '11×1 Smoke — Plan Semantic Compatibility research (NOT success-rate optimization)',
    discipline: 'no verify/GroundTruth/element_present/retry/mockSite/PlanBridge change; findings-only, FROZEN after run',
    provider: dProvider,
    planBridge: 'OFF',
    aggregate: agg,
    findings,
    tasks: taskReports,
    status: 'FROZEN_PENDING_USER', // E4 发现问题即冻结，不自动修
  };
}

module.exports = { runE4Smoke, SEMANTIC_CLASSES };
