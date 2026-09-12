'use strict';

// ============================================================================
// PHASE 17-E — Project Skill Executor / Handover / Lifecycle
//（设计依据：§2 核心目标 / §3 结构限制 / §4 七步契约 / §5–§25）
//
// 唯一职责（§2）：Router 决定 → precheck MATCH → 执行 Skill 动作 → 每一步重新验证状态
//   → 无法继续立即 Handover → Generic 用现有执行链继续 → 最终仍由现有 Verification 判定结果。
// 一句话：「Skill 是一种更有证据的执行路径，不是一套新的浏览器控制系统。」
//
// ── 结构旁路不可能性（§3）────────────────────────────────────────────────────
// 本模块**不拥有**：browser / page / Playwright API / page.goto / page.click / page.fill /
//   browserManager / credentials / selector engine / independent verification。
// 本模块**不调用**：tools.runTool / tools.execute / 任何浏览器对象。
//
// ★ 为什么这是比「直调 tools.runTool」更严格的形态（必须在报告中声明）：
//   全项目唯一的全管线入口是 `tools.execute`（内含 validateAction → policy.allowsAction →
//   Resource Lock 持有校验 → contextGuard → runTool → 证据快照 → elementMemory 挂起确认）。
//   **直接调裸 runTool 会绕过 policy 与资源锁** —— 那才是真正的旁路。
//   因此本模块改为「监督者」形态：由 Runtime 主循环把执行动作的决策权交给本模块，
//   而**物理执行仍由既有 runStep → tools.execute 完成**。本模块唯一的产出是
//   「这一步用 Skill 的动作（actionOverride）还是用 Generic 的动作」以及「何时停止接管」。
//   结论：Skill 在结构上**无法**绕过 policy / credentialAuthorization / verification
//   —— 因为它根本没有通往浏览器与工具层的任何引用（见守护测试组 N 的静态断言）。
//
// ── 七步契约（§4）─────────────────────────────────────────────────────────────
//   1 ROUTE          ← router.route(...)（**复用 17-D，绝不自行重实现 Router**）
//   2 PRECHECK       ← 只有 decision===SKILL ∧ prestate===MATCH 才进入
//   3 EXECUTE        ← 只产出**语义**动作（intent / semantic target / action type /
//                       expected state transition / verification requirement）；
//                      绝不产出 selector / xpath / coordinates / pixel / DOM path / index
//   4 OBSERVE        ← 复用 Runtime 动作后的 fresh observation（零新增观察成本）
//   5 VERIFY_STATE   ← 复用 router.contractVerdict 判定状态契约（**不新建验证器**）
//   6 HANDOVER       ← 结构化 11+ 原因 + SKILL_HANDOVER_ONCE（不可循环）
//   7 FINAL_VERIFICATION ← 本模块**不产生任何成功裁决**；终态由既有收口与
//                      verification.js 给出（见 §7）
//
// ── §7 Skill 不允许拥有自己的 Success ────────────────────────────────────────
// 本模块的返回值里**没有** success / verified / businessSuccess 字段（SEC6 同源纪律）。
// 步级产出只有 STEP_COMPLETED / STEP_HANDOVER / STEP_BLOCKED / STEP_FAILED。
// 按钮点击成功 / 页面变化 / 表单提交 / URL 改变**都不是** Business Success。
//
// ── §10 防循环 ───────────────────────────────────────────────────────────────
// 同一 task execution 内 SKILL_HANDOVER_ONCE：接管与否由**已持久化的执行记录**判定
// （不是内存标志）→ 进程重启后依然成立，且可独立审计（handoverCount === 1）。
//
// ── §15 INDETERMINATE 不磨损 ─────────────────────────────────────────────────
// INDETERMINATE / AUTHORIZATION_BLOCKED / NOT_ATTRIBUTABLE 三类结果
// **不产生状态迁移、不计入任何失败计数、不磨损 confidence**（见 skillLifecycle.advanceCounters）。
// ============================================================================

const store = require('../store');
const router = require('./skillRouter');
const builder = require('./skillBuilder');
const lifecycle = require('./skillLifecycle');
const evmod = require('./skillEvidence');

// PHASE 17-E 新集合：一次 Skill 接管 = 一条执行记录（含逐步证据 + handover + 终态）。
// 与 aiSkillRouting（17-D 决策面）分离：那张表回答「Router 会怎么决定」，这张表回答
// 「接管之后实际发生了什么」。**两者都以 executionId 配对**（C112 纪律）。
const COLLECTION = 'aiSkillExecutions';
const EXECUTOR_VERSION = '1.0';
const HISTORY_COLLECTION = builder.HISTORY_COLLECTION;
const SKILL_COLLECTION = builder.SKILL_COLLECTION;
const RUNS_COLLECTION = builder.RUNS_COLLECTION;

const RUN_MODE = { HOLD: 'HOLD', TAKEOVER: 'TAKEOVER' };

// §7：Skill 只能产生这四种步级结论 —— 没有 SUCCESS
const STEP_OUTCOME = {
  STEP_COMPLETED: 'STEP_COMPLETED',
  STEP_HANDOVER: 'STEP_HANDOVER',
  STEP_BLOCKED: 'STEP_BLOCKED',
  STEP_FAILED: 'STEP_FAILED',
};

// 会话级结论（仍不是成功裁决）：路径走完 / 交还 Generic
const SESSION_OUTCOME = { PATH_COMPLETED: 'PATH_COMPLETED', HANDOVER: 'HANDOVER', HOLD: 'HOLD' };

// §9：handover 原因必须结构化（前 12 条为 §9 指定，其余为附加的**语义明确**原因，
// 逐条有确定含义 —— 绝不使用 "something went wrong" / "skill failed" / "unknown error" 这类占位）。
const HANDOVER_REASONS = {
  // §9 指定
  PRECHECK_MISMATCH: 'PRECHECK_MISMATCH',
  PRECHECK_INDETERMINATE: 'PRECHECK_INDETERMINATE',
  STATE_MISMATCH: 'STATE_MISMATCH',
  TARGET_NOT_GROUNDED: 'TARGET_NOT_GROUNDED',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  ACTION_PRECONDITION_FAILED: 'ACTION_PRECONDITION_FAILED',
  POST_ACTION_STATE_MISMATCH: 'POST_ACTION_STATE_MISMATCH',
  SKILL_STEP_FAILED: 'SKILL_STEP_FAILED',
  SKILL_STALE: 'SKILL_STALE',
  AUTHORIZATION_BLOCKED: 'AUTHORIZATION_BLOCKED',
  VERIFICATION_MISMATCH: 'VERIFICATION_MISMATCH',
  // 附加（结构化）
  STATE_INDETERMINATE: 'STATE_INDETERMINATE',
  HANDOVER_ONCE: 'HANDOVER_ONCE',
  EXECUTION_ALREADY_ATTEMPTED: 'EXECUTION_ALREADY_ATTEMPTED',
  NO_ACTIVE_CANDIDATE: 'NO_ACTIVE_CANDIDATE',
  NOT_ACTIVE: 'NOT_ACTIVE',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  NO_ELIGIBLE_CANDIDATE: 'NO_ELIGIBLE_CANDIDATE',
  ENVIRONMENT_MISMATCH: 'ENVIRONMENT_MISMATCH',
  ORIGIN_UNRESOLVABLE: 'ORIGIN_UNRESOLVABLE',
  SKILL_NO_EXECUTABLE_STEP: 'SKILL_NO_EXECUTABLE_STEP',
  // 17-C 契约的诚实边界：action 只持久化 valueSource / credentialRef，
  // **值本身（含 navigate 的 url）从不入库**（§7.2 P6/P4）→ 这类步无法重建合法 action。
  // 这是结构性缺口，不是 Skill 失败，因此不磨损 confidence（见 OUTCOME_BY_REASON）。
  SKILL_NOT_REPLAYABLE: 'SKILL_NOT_REPLAYABLE',
};

// 工具层错误码 → 结构化 handover 原因。**无命中时回落 SKILL_STEP_FAILED 并保留原始 code**，
// 绝不用一句含糊的 "skill failed" 吞掉真实失败码。
const ERROR_REASON = {
  CREDENTIAL_ACTION_BLOCKED: 'AUTHORIZATION_BLOCKED',
  CREDENTIAL_UNAVAILABLE: 'AUTHORIZATION_BLOCKED',
  ORIGIN_NOT_AUTHORIZED: 'AUTHORIZATION_BLOCKED',
  CREDENTIAL_FORBIDDEN: 'AUTHORIZATION_BLOCKED',
  ACTION_BLOCKED: 'ACTION_PRECONDITION_FAILED',
  ACTION_REQUIRES_APPROVAL: 'ACTION_PRECONDITION_FAILED',
  RESOURCE_LOCK: 'ACTION_PRECONDITION_FAILED',
  ELEMENT_NOT_FOUND: 'TARGET_NOT_GROUNDED',
  TARGET_NOT_FOUND: 'TARGET_NOT_GROUNDED',
  NO_MATCH: 'TARGET_NOT_GROUNDED',
  AMBIGUOUS_TARGET: 'TARGET_AMBIGUOUS',
  MULTIPLE_MATCHES: 'TARGET_AMBIGUOUS',
  VERIFY_FAILED: 'VERIFICATION_MISMATCH',
};

// handover 原因 → 生命周期结果分类（§15 三态纪律的落地点）
//   INDETERMINATE：观察不可用 / 目标不可接地 / 无法判定 —— **不磨损**
//   AUTHORIZATION_BLOCKED：安全闸拒绝 —— **不改变状态**（§11）
//   NOT_ATTRIBUTABLE：环境不适用 / 未激活 / 结构性不可重放 —— **不磨损**
//   STATE_MISMATCH：结构性失效信号（唯一会推动 ACTIVE → REVALIDATING 的信号）
//   VERIFIED_FAILURE：真实的契约/执行失败（会累计 consecutiveFailures）
const OUTCOME_BY_REASON = {
  AUTHORIZATION_BLOCKED: lifecycle.OUTCOME.AUTHORIZATION_BLOCKED,
  VERIFICATION_MISMATCH: lifecycle.OUTCOME.VERIFIED_FAILURE,
  SKILL_STEP_FAILED: lifecycle.OUTCOME.VERIFIED_FAILURE,
  TARGET_AMBIGUOUS: lifecycle.OUTCOME.VERIFIED_FAILURE,
  STATE_MISMATCH: lifecycle.OUTCOME.STATE_MISMATCH,
  POST_ACTION_STATE_MISMATCH: lifecycle.OUTCOME.STATE_MISMATCH,
  PRECHECK_INDETERMINATE: lifecycle.OUTCOME.INDETERMINATE,
  STATE_INDETERMINATE: lifecycle.OUTCOME.INDETERMINATE,
  TARGET_NOT_GROUNDED: lifecycle.OUTCOME.INDETERMINATE,
  PRECHECK_MISMATCH: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  SKILL_STALE: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  ENVIRONMENT_MISMATCH: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  ORIGIN_UNRESOLVABLE: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  NOT_ACTIVE: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  LOW_CONFIDENCE: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  NO_ELIGIBLE_CANDIDATE: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  NO_ACTIVE_CANDIDATE: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  SKILL_NO_EXECUTABLE_STEP: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  SKILL_NOT_REPLAYABLE: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  HANDOVER_ONCE: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  EXECUTION_ALREADY_ATTEMPTED: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
};

// 终态结果 → 生命周期结果分类（§7：由**既有口径**给出，Skill 不参与裁决）
const TERMINAL_OUTCOME = {
  SUCCESS: lifecycle.OUTCOME.VERIFIED_SUCCESS,
  FAILED: lifecycle.OUTCOME.VERIFIED_FAILURE,
  HUMAN_ESCALATION: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
  CANCELLED: lifecycle.OUTCOME.NOT_ATTRIBUTABLE,
};

// ── 纯函数层（供守护测试直接单测；零 I/O）────────────────────────────────────

function norm(s) {
  return String(s == null ? '' : s).trim();
}

function originOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch (e) { return null; }
}

// §5：Skill 只能描述语义目标。此处把 Skill 的 targetSemantic 翻成 action.target，
// **只使用语义键**（semantic / field / intent / role）。构建出来的对象里不含 selector/xpath/坐标/index。
function semanticTargetOf(targetSemantic) {
  const t = targetSemantic || {};
  const out = {};
  const field = norm(t.field);
  const intent = norm(t.intent);
  const role = norm(t.roleHint || t.role);
  if (field) out.field = field;
  if (intent) out.intent = intent;
  if (role) out.role = role;
  // semantic：优先 field（更精确），否则 intent —— 二者都是**语义描述**，不是定位符
  const semantic = field || intent;
  if (semantic) out.semantic = semantic;
  return out;
}

// 该步是否可重建为合法 Action（§5 / validateAction 契约）
//   click / check / uncheck → 只依赖语义目标 → 可重放
//   fill / press / drag / upload → 需要 value 或 credentialRef；17-C **刻意不持久化值**
//     ⇒ 仅有 credentialRef 时可重放，否则结构性不可重放（SKILL_NOT_REPLAYABLE）
//   navigate / openTab → 需要 url；17-C 不持久化 url ⇒ 结构性不可重放
const VALUE_REQUIRED_TYPES = ['fill', 'press', 'drag', 'upload'];
const URL_REQUIRED_TYPES = ['navigate', 'openTab'];

function replayabilityOf(seqStep) {
  const t = String((seqStep && seqStep.actionType) || '');
  const target = semanticTargetOf(seqStep && seqStep.targetSemantic);
  const hasTarget = Object.keys(target).length > 0;
  if (!hasTarget) return { replayable: false, reason: HANDOVER_REASONS.TARGET_NOT_GROUNDED };
  if (URL_REQUIRED_TYPES.includes(t)) return { replayable: false, reason: HANDOVER_REASONS.SKILL_NOT_REPLAYABLE };
  if (VALUE_REQUIRED_TYPES.includes(t)) {
    return seqStep.credentialRef
      ? { replayable: true, reason: '' }
      : { replayable: false, reason: HANDOVER_REASONS.SKILL_NOT_REPLAYABLE };
  }
  return { replayable: true, reason: '' };
}

// 从 Skill 的 Action（§17 最小结构）构建 Runtime 可执行的 action 对象。
// ★ 产出里没有 selector / xpath / coordinates / index / 值 —— 值只以 credentialRef 形式引用。
function buildActionFromStep(seqStep) {
  const s = seqStep || {};
  const target = semanticTargetOf(s.targetSemantic);
  const v = s.verification && s.verification.type ? {
    type: s.verification.type,
    expect: s.verification.expect,
    target: s.verification.target || undefined,
  } : { type: 'none' };
  const action = {
    type: s.actionType,
    target: target,
    risk: s.risk || undefined,
    verification: v,
  };
  if (s.credentialRef) action.credentialRef = s.credentialRef;
  if (s.requiresCredentialAuthorization === true) action.requiresCredentialAuthorization = true;
  return action;
}

// 动作类型是否相容（不相容 = 计划与 Skill 在同一序号上指向不同动作 → 交给 Generic）
function actionTypeCompatible(genericAction, seqStep) {
  const a = norm(genericAction && genericAction.type);
  const b = norm(seqStep && seqStep.actionType);
  if (!a || !b) return false;
  return a === b;
}

// §4.1 步骤序列推导（纯函数）
//
// 数据形状（17-C 冻结，不允许改）：state S0N 的 stateContract = 第 N 步**执行之后**的预期状态；
// 该步 action 存在 S0N 里，其 `expectedTransition.from` = 执行前所处的状态（= S0(N-1)）。
// ⇒ 正确走法：cursor 从 entryState 起，执行「from === cursor 的动作」，执行后校验其 `to` 状态契约，
//    cursor 前移。**先校验状态、后执行动作**（§6），每一步都以 fresh observation 为据。
function planSequence(skill) {
  const states = (skill && Array.isArray(skill.states))
    ? skill.states.filter((s) => s && typeof s === 'object') : [];
  if (!states.length) return { entryStateId: null, steps: [], reason: 'NO_STATES' };
  const entryId = skill.entryState;
  const idx = states.findIndex((s) => s.id === entryId);
  const ordered = idx >= 0 ? states.slice(idx).concat(states.slice(0, idx)) : states.slice();
  const entry = ordered[0];
  let cursorId = entry.id;
  const steps = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const st = ordered[i];
    const acts = (Array.isArray(st.actions) ? st.actions : []).filter((a) => a && typeof a === 'object');
    const a = acts.find((x) => x.expectedTransition && x.expectedTransition.from === cursorId);
    if (!a) break;
    steps.push({
      seqIndex: steps.length,
      stepId: a.id || ('ACT_' + (i + 1)),
      from: cursorId,
      to: st.id,
      intent: (a.targetSemantic && a.targetSemantic.intent) || null,
      actionType: a.type,
      targetSemantic: a.targetSemantic || null,
      valueSource: a.valueSource || 'NONE',
      credentialRef: a.credentialRef || null,
      verification: a.verification || null,
      risk: a.risk || 'MEDIUM',
      requiresCredentialAuthorization: a.requiresCredentialAuthorization === true || !!a.credentialRef,
      toStateContract: st.stateContract || null,
      toStateId: st.id,
    });
    cursorId = st.id;
  }
  return {
    entryStateId: entry.id,
    entryStateContract: entry.stateContract || null,
    steps: steps,
    reason: steps.length ? '' : 'NO_EXECUTABLE_ACTION',
  };
}

// §6 / §15：状态契约判定。**复用 router.contractVerdict**，绝不新建验证器。
//
// 全 SOFT 状态（builder 的 entryState=LANDING 即如此）：按 SOFT 的既有语义
// 「不参与状态拒绝」→ 不阻塞，但**如实留痕 softOnly=true**（不静默忽略）。
function validateStateContract(stateContract, obs) {
  const clauses = (stateContract && Array.isArray(stateContract.observable))
    ? stateContract.observable : [];
  const required = clauses.filter((c) => c && (c.weight || 'REQUIRED') !== 'SOFT');
  if (!clauses.length) {
    return { verdict: router.PRESTATE.INDETERMINATE, softOnly: false, clauses: [], reason: 'NO_CLAUSES' };
  }
  if (!required.length) {
    return { verdict: router.PRESTATE.MATCH, softOnly: true, clauses: [], reason: 'SOFT_ONLY' };
  }
  const v = router.contractVerdict(stateContract, obs);
  return { verdict: v.verdict, softOnly: false, clauses: v.clauses || [], reason: v.reason || '' };
}

// 工具层结果 → 步级分类 + 结构化原因（纯函数）
function classifyStepResult(result) {
  const r = result || {};
  if (r.ok === true) return { step: STEP_OUTCOME.STEP_COMPLETED, reason: '', code: null };
  const err = r.error || {};
  const code = norm(err.code || (err.error && err.error.code)) || 'UNKNOWN';
  const reason = ERROR_REASON[code] || HANDOVER_REASONS.SKILL_STEP_FAILED;
  if (reason === HANDOVER_REASONS.AUTHORIZATION_BLOCKED) {
    return { step: STEP_OUTCOME.STEP_BLOCKED, reason: reason, code: code };
  }
  return { step: STEP_OUTCOME.STEP_FAILED, reason: reason, code: code };
}

function outcomeClassOfReason(reason) {
  return OUTCOME_BY_REASON[reason] || lifecycle.OUTCOME.NOT_ATTRIBUTABLE;
}

// ── 持久化层 ────────────────────────────────────────────────────────────────

function uid(prefix) {
  return (prefix || 'sexec') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function listExecutions() {
  const rows = store.read(COLLECTION, []);
  return Array.isArray(rows) ? rows : [];
}

// §10：同一 task execution 已 handover → 不再接管（可跨进程重启，因为读的是持久化记录）
function handoverOf(taskId, executionId) {
  return listExecutions().find((r) => r && r.taskId === taskId
    && String(r.executionId == null ? '' : r.executionId) === String(executionId == null ? '' : executionId)
    && r.sessionOutcome === SESSION_OUTCOME.HANDOVER) || null;
}

function attemptedExecution(taskId, executionId) {
  return listExecutions().find((r) => r && r.taskId === taskId
    && String(r.executionId == null ? '' : r.executionId) === String(executionId == null ? '' : executionId)) || null;
}

function pendingForTask(taskId) {
  return listExecutions().filter((r) => r && r.taskId === taskId && r.terminal == null);
}

function saveExecution(rec) {
  try { store.upsert(COLLECTION, rec); return { ok: true }; }
  catch (e) { return { ok: false, reason: 'PERSIST_ERROR:' + String((e && e.message) || e) }; }
}

// ── 0 级预闸（§4.2 之前的最小成本闸）────────────────────────────────────────
// 纯元数据读取，**不做任何浏览器动作、不做任何观察**。
// 生产结构惰性：builder 恒产 CANDIDATE ⇒ 此闸恒假 ⇒ Runtime 零额外成本、行为逐字节不变。
function eligible(task) {
  const t = task || {};
  const anchor = originOf(t.targetUrl);
  if (!anchor) return { any: false, reason: HANDOVER_REASONS.ORIGIN_UNRESOLVABLE, activeCount: 0 };
  const capability = builder.capabilityOf(t.planGoal || t.objective || '');
  const skills = store.read(SKILL_COLLECTION, []) || [];
  const active = skills.filter((s) => s && s.status === 'ACTIVE'
    && String(s.capability || '') === capability
    && String((s.environmentScope && s.environmentScope.originAnchor) || '') === anchor);
  return {
    any: active.length > 0,
    reason: active.length ? '' : HANDOVER_REASONS.NO_ACTIVE_CANDIDATE,
    capability: capability,
    originAnchor: anchor,
    activeCount: active.length,
  };
}

// ── 会话（监督者）──────────────────────────────────────────────────────────

function makeHold(reason, extra) {
  return Object.assign({
    mode: RUN_MODE.HOLD,
    taken: false,
    reason: reason || null,
    session: null,
  }, extra || {});
}

// §4：ROUTE → PRECHECK → （建立会话）
// input: { task, observation, executionId, now }
function openSession(input) {
  const opts = input || {};
  const task = opts.task || {};
  if (!task.id) return makeHold('NO_TASK');
  const executionId = opts.executionId != null ? String(opts.executionId)
    : (task.currentExecutionId != null ? String(task.currentExecutionId) : '');

  // §10 防循环 + 单次执行隔离
  if (handoverOf(task.id, executionId)) return makeHold(HANDOVER_REASONS.HANDOVER_ONCE);
  const prev = attemptedExecution(task.id, executionId);
  if (prev && prev.sessionOutcome !== SESSION_OUTCOME.HOLD) {
    return makeHold(HANDOVER_REASONS.EXECUTION_ALREADY_ATTEMPTED);
  }

  // 0 级预闸（零成本）
  const pre = eligible(task);
  if (!pre.any) return makeHold(pre.reason || HANDOVER_REASONS.NO_ACTIVE_CANDIDATE);

  // ① ROUTE —— 复用 17-D，**禁止自行重实现 Router**
  const skills = store.read(SKILL_COLLECTION, []) || [];
  const runsBySkill = {};
  for (const r of (store.read(RUNS_COLLECTION, []) || [])) {
    if (!r || !r.skillId) continue;
    if (!runsBySkill[r.skillId]) runsBySkill[r.skillId] = [];
    runsBySkill[r.skillId].push(r);
  }
  const obs = opts.observation || null;
  const decision = router.route({
    task: task, observation: obs, skills: skills, runsBySkill: runsBySkill, now: opts.now,
  });

  // ② PRECHECK：只有 decision===SKILL ∧ prestate===MATCH 才能进入
  if (decision.decision !== router.DECISION.SKILL) {
    const rsn = String(decision.reason || '');
    const prest = decision.prestate;
    let reason;
    // ★ 观察不成立（INDETERMINATE:*）优先于 prestate 的具体取值 —— 观察不可用时
    //   prestate 本身不构成「确定的不匹配」，语义上必须走 INDETERMINATE 而不是 MISMATCH。
    if (rsn.indexOf('INDETERMINATE') === 0 || prest === router.PRESTATE.INDETERMINATE) {
      reason = HANDOVER_REASONS.PRECHECK_INDETERMINATE;
    } else if (rsn === 'PRESTATE_MISMATCH' || rsn === 'TIE_REFUSED' || prest === router.PRESTATE.MISMATCH) {
      reason = HANDOVER_REASONS.PRECHECK_MISMATCH;
    } else if (rsn === 'NO_ELIGIBLE_CANDIDATE' || rsn === 'NO_CAPABILITY_MATCH') {
      reason = HANDOVER_REASONS.NO_ELIGIBLE_CANDIDATE;
    } else if (rsn === 'ORIGIN_ANCHOR_UNRESOLVABLE') {
      reason = HANDOVER_REASONS.ORIGIN_UNRESOLVABLE;
    } else {
      reason = HANDOVER_REASONS.NO_ELIGIBLE_CANDIDATE;
    }
    return makeHold(reason, { routing: summarizeRouting(decision) });
  }
  if (decision.prestate !== router.PRESTATE.MATCH) {
    return makeHold(HANDOVER_REASONS.PRECHECK_MISMATCH, { routing: summarizeRouting(decision) });
  }
  const skill = skills.find((s) => s && s.id === decision.skillId) || null;
  if (!skill) return makeHold(HANDOVER_REASONS.NO_ELIGIBLE_CANDIDATE, { routing: summarizeRouting(decision) });

  const plan = planSequence(skill);
  if (!plan.steps.length) {
    return makeHold(HANDOVER_REASONS.SKILL_NO_EXECUTABLE_STEP, { routing: summarizeRouting(decision), skillId: skill.id });
  }

  const rec = {
    id: uid('sexec'),
    executorVersion: EXECUTOR_VERSION,
    skillId: skill.id,
    skillVersion: Number(skill.version) || 1,
    taskId: task.id,
    executionId: executionId || null,
    startedAt: Date.now(),
    endedAt: null,
    sessionOutcome: null,
    handover: null,
    handoverCount: 0,
    steps: [],
    cursorStateId: plan.entryStateId,
    plannedSteps: plan.steps.length,
    chainId: null,
    routingAt: decision.at || null,
    prestate: decision.prestate,
    // 终态（由 taskManager 终态回填触发；Skill 自己从不写）
    terminal: null,
    terminalAt: null,
    outcome: null,
    lifecycleApplied: null,
  };

  return {
    mode: RUN_MODE.TAKEOVER,
    taken: true,
    reason: '',
    session: makeSession({ task: task, skill: skill, plan: plan, rec: rec, decision: decision, observation: obs }),
  };
}

function summarizeRouting(decision) {
  const d = decision || {};
  return {
    decision: d.decision || null, reason: d.reason || null, prestate: d.prestate || null,
    prestateScope: d.prestateScope || null, skillId: d.skillId || null,
    observedSkillId: d.observedSkillId || null, eligibleCount: d.eligibleCount || 0,
    candidateCount: d.candidateCount || 0, tie: d.tie === true,
    observationUsable: d.observationUsable === true, observationReason: d.observationReason || null,
  };
}

function makeSession(ctx) {
  const task = ctx.task;
  const skill = ctx.skill;
  const plan = ctx.plan;
  const rec = ctx.rec;
  let cursorId = plan.entryStateId;
  // cursor 状态契约：cursor 每前移一次即更新为目标状态的契约（**不重算、不臆造**）
  let cursorContract = plan.entryStateContract;
  let seqPtr = 0;
  let handover = null;
  let lastObservation = ctx.observation || null;
  let closed = false;

  const transitions = [];

  function transition(input) {
    // ★ 五要素与 17-C 的 makeTransition 完全一致（摘要 + 引用，不存全文/定位符/值）。
    //   额外的 executionId / stepId / handover 由 execution 记录承载，链本身保持 17-C 形状。
    return {
      stateFrom: input.stateFrom || null,
      stateTo: input.stateTo || null,
      obsBeforeDigest: input.obsBeforeDigest || null,
      obsBeforeRef: input.obsBeforeRef || null,
      target: {
        intent: input.target && input.target.intent ? input.target.intent : null,
        field: input.target && input.target.field ? input.target.field : null,
        groundedRole: (input.target && input.target.groundedRole) || null,
        groundedTag: (input.target && input.target.groundedTag) || null,
      },
      action: { type: (input.action && input.action.type) || null, valueSource: (input.action && input.action.valueSource) || 'NONE' },
      obsAfterDigest: input.obsAfterDigest || null,
      obsAfterRef: input.obsAfterRef || null,
      verification: {
        contract: (input.verification && input.verification.contract) || null,
        result: (input.verification && input.verification.result) || null,
      },
      at: input.at || Date.now(),
    };
  }

  function setHandover(reason, detail) {
    if (handover) return handover;
    // ★ lastSuccessfulStep 只认**真正完成**的步（stepOutcome===STEP_COMPLETED）。
    //   漂移发生在动作之后时，动作虽然机械成功，但该步已判为 HANDOVER —— 记录里
    //   绝不能把它写成「最后成功的一步」，否则审计会把漂移点误读成安全回退点。
    const doneSteps = rec.steps.filter((s) => s && s.stepOutcome === STEP_OUTCOME.STEP_COMPLETED);
    handover = {
      taskId: task.id,
      skillId: skill.id,
      skillVersion: Number(skill.version) || 1,
      executionId: rec.executionId,
      stepIndex: seqPtr,
      handoverReason: reason,
      prestate: rec.prestate,
      currentObservationRef: observationRefOf(lastObservation),
      lastSuccessfulStep: doneSteps.length ? doneSteps[doneSteps.length - 1].stepId : null,
      handoverCount: 1,
      softOnlyCursor: !!(detail && detail.softOnly),
      causeCode: (detail && detail.causeCode) || null,
      at: Date.now(),
    };
    rec.handover = handover;
    rec.handoverCount = 1;
    rec.sessionOutcome = SESSION_OUTCOME.HANDOVER;
    rec.endedAt = Date.now();
    rec.outcome = outcomeClassOfReason(reason);
    // ★ 立即落库：HANDOVER_ONCE 必须跨进程/跨会话成立
    saveExecution(rec);
    return handover;
  }

  function observationRefOf(obs) {
    if (!obs || typeof obs !== 'object') return null;
    return {
      observationId: obs.observationId || null,
      url: String(obs.url || '').slice(0, 200) || null,
      capturedAt: Number(obs.capturedAt || obs.timestamp) || null,
      stepId: obs.stepId || null,
      attemptId: obs.attemptId || null,
      fresh: obs.fresh === true,
    };
  }

  function digestOf(obs) {
    if (!obs || typeof obs !== 'object') return null;
    try {
      return evmod.digestOf({
        url: obs.url || null,
        elementCount: Array.isArray(obs.elements) ? obs.elements.length : null,
        textLength: String(obs.textSummary || obs.visibleText || '').length,
        capturedAt: Number(obs.capturedAt || obs.timestamp) || null,
      });
    } catch (e) { return null; }
  }

  // §6 步前判定：校验 cursor 状态 → 决定是否接管 → 产出语义动作（不产出定位符）
  function beforeStep(input) {
    const inp = input || {};
    if (closed || handover) return { takeover: false, handover: !!handover, reason: handover ? handover.handoverReason : null };
    // 已有恢复候选动作（Generic 的 repair 路径）优先 —— Skill 不与恢复链争抢
    if (inp.recoveryAction) return { takeover: false, handover: false, reason: null, skipped: 'RECOVERY_PRIORITY' };

    const seqStep = plan.steps[seqPtr] || null;
    if (!seqStep) return { takeover: false, handover: false, reason: null, skipped: 'NO_MORE_SKILL_STEPS' };

    const obs = inp.observation || lastObservation;
    // cursor 状态契约（随 cursor 前移更新；首步 = entryState 的契约）
    const st = validateStateContract(cursorContract, obs);
    if (st.verdict === router.PRESTATE.MISMATCH) {
      setHandover(HANDOVER_REASONS.STATE_MISMATCH, { softOnly: st.softOnly });
      return { takeover: false, handover: true, reason: HANDOVER_REASONS.STATE_MISMATCH };
    }
    if (st.verdict === router.PRESTATE.INDETERMINATE) {
      setHandover(HANDOVER_REASONS.STATE_INDETERMINATE, { softOnly: st.softOnly });
      return { takeover: false, handover: true, reason: HANDOVER_REASONS.STATE_INDETERMINATE };
    }

    const rep = replayabilityOf(seqStep);
    if (!rep.replayable) {
      setHandover(rep.reason);
      return { takeover: false, handover: true, reason: rep.reason };
    }
    if (inp.genericAction !== undefined && !actionTypeCompatible(inp.genericAction, seqStep)) {
      setHandover(HANDOVER_REASONS.ACTION_PRECONDITION_FAILED, { causeCode: 'PLAN_ACTION_TYPE_DIVERGENCE' });
      return { takeover: false, handover: true, reason: HANDOVER_REASONS.ACTION_PRECONDITION_FAILED };
    }

    const action = buildActionFromStep(seqStep);
    rec.steps.push({
      seqIndex: seqStep.seqIndex,
      stepId: seqStep.stepId,
      genericStepId: inp.stepId || null,
      stateFrom: seqStep.from,
      stateTo: seqStep.to,
      actionType: seqStep.actionType,
      valueSource: seqStep.valueSource,
      credentialRefUsed: !!seqStep.credentialRef,
      requiresCredentialAuthorization: seqStep.requiresCredentialAuthorization === true,
      verificationContract: seqStep.verification || null,
      preStepContract: { verdict: st.verdict, softOnly: st.softOnly, reason: st.reason },
      obsBeforeDigest: digestOf(obs),
      obsBeforeRef: observationRefOf(obs),
      startedAt: Date.now(),
      stepOutcome: null,
      postStepContract: null,
      handoverReason: null,
      causeCode: null,
      durationMsMs: null,
    });
    return { takeover: true, handover: false, reason: null, action: action, seqIndex: seqStep.seqIndex };
  }

  // §6 步后判定：动作后立即以 fresh observation 校验**迁移后的状态契约**
  //   MATCH        → STEP_COMPLETED，cursor 前移，继续下一步
  //   MISMATCH     → POST_ACTION_STATE_MISMATCH → HANDOVER（绝不继续执行旧 Skill step）
  //   INDETERMINATE→ STATE_INDETERMINATE → HANDOVER（不磨损）
  function afterStep(input) {
    const inp = input || {};
    if (closed || handover) return { continued: false, handover: !!handover, reason: handover ? handover.handoverReason : null };
    const entry = rec.steps[rec.steps.length - 1];
    if (!entry) return { continued: false, handover: false, reason: null };

    const seqStep = plan.steps[seqPtr] || null;
    const obs = inp.observation || lastObservation;
    if (obs) lastObservation = obs;
    const cls = classifyStepResult(inp.result);
    entry.endedAt = Date.now();
    entry.durationMs = entry.endedAt - (entry.startedAt || entry.endedAt);
    entry.causeCode = cls.code;
    entry.obsAfterDigest = digestOf(obs);
    entry.obsAfterRef = observationRefOf(obs);

    if (cls.step === STEP_OUTCOME.STEP_BLOCKED || cls.step === STEP_OUTCOME.STEP_FAILED) {
      entry.stepOutcome = cls.step;
      entry.handoverReason = cls.reason;
      // §22：动作机械成功但**业务验证失败**必须落在这里（code=VERIFY_FAILED），
      //   绝不允许被当成成功 —— 终态解释权仍在既有 verification。
      setHandover(cls.reason, { causeCode: cls.code });
      return { continued: false, handover: true, reason: cls.reason };
    }

    // 动作成功 → 校验迁移后状态契约（复用 17-D 判定，不新建验证器）
    const toContract = seqStep ? seqStep.toStateContract : null;
    const st = validateStateContract(toContract, obs);
    entry.postStepContract = { verdict: st.verdict, softOnly: st.softOnly, reason: st.reason };
    transitions.push(transition({
      stateFrom: entry.stateFrom,
      stateTo: entry.stateTo,
      obsBeforeDigest: entry.obsBeforeDigest,
      obsBeforeRef: refString(entry.obsBeforeRef),
      target: {
        intent: seqStep && seqStep.intent,
        field: seqStep && seqStep.targetSemantic && seqStep.targetSemantic.field,
        groundedRole: seqStep && seqStep.targetSemantic && seqStep.targetSemantic.roleHint,
        groundedTag: null,
      },
      action: { type: entry.actionType, valueSource: entry.valueSource },
      obsAfterDigest: entry.obsAfterDigest,
      obsAfterRef: refString(entry.obsAfterRef),
      verification: {
        contract: seqStep && seqStep.verification ? seqStep.verification : null,
        result: { ok: true, source: 'runtime_step_success' },
      },
      at: entry.endedAt,
    }));

    if (st.verdict === router.PRESTATE.MISMATCH) {
      entry.stepOutcome = STEP_OUTCOME.STEP_HANDOVER;
      entry.handoverReason = HANDOVER_REASONS.POST_ACTION_STATE_MISMATCH;
      setHandover(HANDOVER_REASONS.POST_ACTION_STATE_MISMATCH, { softOnly: st.softOnly });
      return { continued: false, handover: true, reason: HANDOVER_REASONS.POST_ACTION_STATE_MISMATCH };
    }
    if (st.verdict === router.PRESTATE.INDETERMINATE) {
      entry.stepOutcome = STEP_OUTCOME.STEP_HANDOVER;
      entry.handoverReason = HANDOVER_REASONS.STATE_INDETERMINATE;
      setHandover(HANDOVER_REASONS.STATE_INDETERMINATE, { softOnly: st.softOnly });
      return { continued: false, handover: true, reason: HANDOVER_REASONS.STATE_INDETERMINATE };
    }

    entry.stepOutcome = STEP_OUTCOME.STEP_COMPLETED;
    cursorId = seqStep ? seqStep.to : cursorId;
    cursorContract = seqStep ? seqStep.toStateContract : cursorContract;
    seqPtr += 1;
    if (seqPtr >= plan.steps.length) {
      // 路径走完 —— **不是**成功裁决：Skill 只是把它的动作全部替换完毕，
      // 终态仍由既有收口 + verification.js 给出（§7）。
      closed = true;
      rec.sessionOutcome = SESSION_OUTCOME.PATH_COMPLETED;
      rec.endedAt = Date.now();
      rec.outcome = null; // 待既有终态确认（延迟确认，17-B 纪律）
      rec.chainId = persistChain();
      saveExecution(rec);
      return { continued: false, handover: false, reason: null, completed: true };
    }
    return { continued: true, handover: false, reason: null, nextSeqIndex: seqPtr };
  }

  function refString(ref) {
    if (!ref) return null;
    const parts = [ref.stepId, ref.attemptId].filter((x) => x != null && x !== '');
    return parts.length ? parts.join('/') : (ref.observationId || null);
  }

  function persistChain() {
    try {
      const chain = evmod.buildChain({
        skillId: skill.id,
        skillVersion: Number(skill.version) || 1,
        capability: skill.capability || null,
        intent: skill.intent || null,
        transitions: transitions,
      });
      store.upsert(evmod.COLLECTION, chain);
      return chain.id;
    } catch (e) { return null; }
  }

  // 显式 handover（Session 已 handover 时幂等）
  function handoverNow(reason) {
    return setHandover(reason || HANDOVER_REASONS.SKILL_STEP_FAILED);
  }

  function finish() {
    if (rec.endedAt == null) {
      rec.endedAt = Date.now();
      if (!rec.sessionOutcome) {
        rec.sessionOutcome = handover ? SESSION_OUTCOME.HANDOVER : SESSION_OUTCOME.PATH_COMPLETED;
      }
      if (!rec.chainId) rec.chainId = persistChain();
      saveExecution(rec);
    }
    return state();
  }

  function state() {
    return {
      id: rec.id,
      skillId: rec.skillId,
      skillVersion: rec.skillVersion,
      taskId: rec.taskId,
      executionId: rec.executionId,
      cursorStateId: cursorId,
      seqPtr: seqPtr,
      plannedSteps: plan.steps.length,
      sessionOutcome: rec.sessionOutcome,
      handover: rec.handover,
      handoverCount: rec.handoverCount,
      skillExecutionCount: 1,
      steps: rec.steps.map((s) => ({
        seqIndex: s.seqIndex, stepId: s.stepId, stateFrom: s.stateFrom, stateTo: s.stateTo,
        stepOutcome: s.stepOutcome, handoverReason: s.handoverReason,
      })),
      transitions: transitions.length,
      chainId: rec.chainId,
    };
  }

  return {
    // 只读视图（供测试与 runtime 断言；**不含任何执行入口**）
    read: state,
    rec: rec,
    plan: plan,
    beforeStep: beforeStep,
    afterStep: afterStep,
    handoverNow: handoverNow,
    finish: finish,
  };
}

// ── 终态回填 + 生命周期持久化（§12 / §13 / §18）─────────────────────────────

// 由 taskManager 的**既有终态点**调用（与 17-D recordActual 同一处、同一 fail-open 口径）。
// ★ 延迟确认（17-B 纪律）：Skill **不**在动作成功时给自己记成功，
//   只有任务真正以既有口径到达终态时才结算；且**发生过 handover 的执行不给成功分**
//   （否则「Skill 交还 Generic、Generic 成功」会被误记成 Skill 的功劳）。
function onTaskTerminal(task, outcome) {
  try {
    if (!task || !task.id) return { ok: false, reason: 'NO_TASK' };
    const rows = pendingForTask(task.id);
    if (!rows.length) return { ok: false, reason: 'NO_PENDING_EXECUTION' };
    const outKey = String(outcome || '').toUpperCase();
    const terminal = TERMINAL_OUTCOME[outKey] || null;
    if (!terminal) return { ok: false, reason: 'UNKNOWN_OUTCOME:' + outKey };
    const applied = [];
    for (const rec of rows) {
      rec.terminal = outKey;
      rec.terminalAt = Date.now();
      // 已 handover → 保留 handover 的分类（归因纪律：Generic 的成功不是 Skill 的成功）
      const lcOutcome = rec.sessionOutcome === SESSION_OUTCOME.HANDOVER
        ? rec.outcome
        : terminal;
      rec.outcome = lcOutcome;
      rec.lifecycleApplied = applyLifecycleOutcome({
        skillId: rec.skillId,
        task: task,
        executionId: rec.executionId,
        outcome: lcOutcome,
        executionIdRef: rec.id,
      });
      saveExecution(rec);
      applied.push({ id: rec.id, skillId: rec.skillId, outcome: lcOutcome });
    }
    return { ok: true, applied: applied };
  } catch (e) {
    return { ok: false, reason: 'TERMINAL_ERROR:' + String((e && e.message) || e) };
  }
}

// 生命周期结算 + 持久化（§12 状态机 / §13 晋升门禁 / §14 阈值不动 / §15 不一失败即 STALE）
function applyLifecycleOutcome(input) {
  const opts = input || {};
  const skill = (store.read(SKILL_COLLECTION, []) || []).find((s) => s && s.id === opts.skillId) || null;
  if (!skill) return { ok: false, reason: 'SKILL_NOT_FOUND' };
  const outcome = opts.outcome;
  if (!outcome) return { ok: false, reason: 'NO_OUTCOME' };

  const worn = !lifecycle.isNonWearing(outcome);
  const now = Date.now();

  // ★ §11 / §15：**非磨损结果（INDETERMINATE / AUTHORIZATION_BLOCKED / NOT_ATTRIBUTABLE）
  //   不得重算 confidence、不得动 samples/replays/status** —— 只记观测计数（stats）。
  //   为什么连 confidence 都不能「重算成同一个值」：重算是拿当前 runs 重跑公式，
  //   一旦 runs 集合与上次不同（例如构建期插入过 run），重算就会**改变**置信度 ——
  //   那等于「因为发生了一次授权阻断，Skill 的置信度变了」，正是要杜绝的激励。
  if (!worn) {
    const statsNw = Object.assign({}, skill.stats || {});
    if (outcome === lifecycle.OUTCOME.AUTHORIZATION_BLOCKED) {
      statsNw.authorizationBlocks = (Number(statsNw.authorizationBlocks) || 0) + 1;
    }
    const unchanged = Object.assign({}, skill, { stats: statsNw, updatedAt: now });
    try {
      store.upsert(SKILL_COLLECTION, unchanged);
      store.insert(HISTORY_COLLECTION, {
        id: 'skh_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
        skillId: unchanged.id,
        version: Number(unchanged.version) || 1,
        statusFrom: skill.status,
        statusTo: skill.status,
        reasons: ['NON_WEARING_OUTCOME:' + outcome],
        outcome: outcome,
        executionRef: opts.executionIdRef || null,
        taskId: opts.task && opts.task.id,
        at: now,
      });
    } catch (e) {
      return { ok: false, reason: 'PERSIST_ERROR:' + String((e && e.message) || e) };
    }
    return {
      ok: true,
      outcome: outcome,
      statusFrom: skill.status,
      statusTo: skill.status,
      changed: false,
      reasons: ['NON_WEARING_OUTCOME:' + outcome],
      confidence: skill.confidence,
      wore: false,
    };
  }

  // 计数增量（非磨损结果原样保留 —— §15）
  const counters = lifecycle.advanceCounters({ skill: skill, outcome: outcome, now: now });
  const nextLc = Object.assign({}, skill.lifecycle || {}, {
    consecutiveFailures: counters.consecutiveFailures,
    contractViolations: counters.contractViolations,
    revalidateFailures: counters.revalidateFailures,
    revalidateSuccesses: counters.revalidateSuccesses,
  });
  if (worn && outcome === lifecycle.OUTCOME.VERIFIED_SUCCESS) nextLc.lastSuccessAt = now;
  if (worn && outcome !== lifecycle.OUTCOME.VERIFIED_SUCCESS) nextLc.lastFailureAt = now;

  // 成功样本 / 重放记录（**只在既有口径判定为成功且未 handover 时才记**）
  let runs = store.findWhere(RUNS_COLLECTION, (r) => r && r.skillId === skill.id);
  const samples = Object.assign({ success: 0, failed: 0 }, skill.samples || {});
  if (worn && outcome === lifecycle.OUTCOME.VERIFIED_SUCCESS) {
    const key = String(opts.task && opts.task.id) + '::' + String(opts.executionId || '');
    const dup = runs.some((r) => String(r.taskId) + '::' + String(r.executionId || '') === key);
    if (!dup) {
      store.insert(RUNS_COLLECTION, {
        id: 'srun_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
        skillId: skill.id,
        taskId: opts.task && opts.task.id,
        executionId: opts.executionId || null,
        sessionId: builder.sessionIdOf(opts.task),
        ok: true,
        at: now,
        // 与 builder.persist 的记录区分来源：17-E 是「执行期延迟确认」而非「构建期观察」
        source: 'executor_verified',
        executionRef: opts.executionIdRef || null,
      });
    }
    samples.success = (samples.success || 0) + 1;
  } else if (worn && outcome !== lifecycle.OUTCOME.VERIFIED_SUCCESS) {
    samples.failed = (samples.failed || 0) + 1;
  }

  runs = store.findWhere(RUNS_COLLECTION, (r) => r && r.skillId === skill.id);
  const ind = lifecycle.independentSuccesses(runs.filter((r) => r && r.ok));
  const stats = Object.assign({}, skill.stats || {});
  if (outcome === lifecycle.OUTCOME.STATE_MISMATCH) stats.midFailures = (Number(stats.midFailures) || 0) + 1;
  if (outcome === lifecycle.OUTCOME.AUTHORIZATION_BLOCKED) stats.authorizationBlocks = (Number(stats.authorizationBlocks) || 0) + 1;
  if (outcome === lifecycle.OUTCOME.VERIFIED_SUCCESS) stats.prestatesPassed = (Number(stats.prestatesPassed) || 0) + 1;

  const candidate = Object.assign({}, skill, {
    samples: samples,
    stats: stats,
    replays: runs.filter((r) => r && r.ok).length,
    distinctSessions: ind.distinctSessions,
    lifecycle: nextLc,
  });
  // ★ 阈值 0.85 与公式均**未改动**（§14）：仍然走 17-C 的 skillConfidence
  candidate.confidence = lifecycle.skillConfidence({
    independentSuccesses: ind.count,
    distinctSessions: ind.distinctSessions,
    failed: samples.failed || 0,
  });

  const decision = lifecycle.nextStatus({
    skill: Object.assign({}, skill, { lifecycle: nextLc, samples: samples }),
    outcome: outcome,
    runs: runs,
    evidenceComplete: (skill.stats && skill.stats.evidenceComplete) === true,
    contractObservations: (skill.stats && skill.stats.contractObservations) || 0,
  });

  const nextStatus = (decision.legal === false) ? skill.status : decision.to;
  if (nextStatus !== skill.status) {
    candidate.status = nextStatus;
    if (nextStatus === lifecycle.LIFECYCLE_STATUS.ACTIVE && !candidate.lifecycle.promotedAt) {
      candidate.lifecycle.promotedAt = now;
    }
    if (nextStatus === lifecycle.LIFECYCLE_STATUS.STALE) {
      candidate.lifecycle.stalenessReasons = decision.reasons.slice();
    }
    if (nextStatus === lifecycle.LIFECYCLE_STATUS.DEPRECATED) {
      candidate.lifecycle.deprecatedReason = decision.reasons.join('+');
    }
  }
  candidate.updatedAt = now;

  // 落库（Skill 主记录 + 版本快照）
  try {
    store.upsert(SKILL_COLLECTION, candidate);
    store.insert(HISTORY_COLLECTION, {
      id: 'skh_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      skillId: candidate.id,
      version: Number(candidate.version) || 1,
      statusFrom: skill.status,
      statusTo: nextStatus,
      reasons: decision.reasons,
      outcome: outcome,
      executionRef: opts.executionIdRef || null,
      taskId: opts.task && opts.task.id,
      at: now,
    });
  } catch (e) {
    return { ok: false, reason: 'PERSIST_ERROR:' + String((e && e.message) || e), decision: decision };
  }

  return {
    ok: true,
    outcome: outcome,
    statusFrom: skill.status,
    statusTo: nextStatus,
    changed: nextStatus !== skill.status,
    reasons: decision.reasons,
    confidence: candidate.confidence,
    wore: worn,
  };
}

module.exports = {
  COLLECTION, EXECUTOR_VERSION, RUN_MODE, STEP_OUTCOME, SESSION_OUTCOME,
  HANDOVER_REASONS, ERROR_REASON, OUTCOME_BY_REASON, TERMINAL_OUTCOME,
  eligible, openSession, onTaskTerminal, applyLifecycleOutcome,
  // 供守护测试的直接单元（纯函数）
  planSequence, buildActionFromStep, semanticTargetOf, replayabilityOf,
  actionTypeCompatible, validateStateContract, classifyStepResult, outcomeClassOfReason,
  originOf, handoverOf, attemptedExecution, listExecutions,
};
