'use strict';

// ============================================================================
// PHASE 17-C — Skill Lifecycle 阈值与纯判定（设计依据：§6 Lifecycle）
//
// 本模块把设计报告 §6.7 的阈值汇总表**代码化**，并只提供**纯函数**判定。
// 它**不做**状态转移 —— 转移的接线属 PHASE 17-D（SkillRouter）。
// 之所以在本阶段就落地：没有晋升谓词，「只产 CANDIDATE」这句话就是空的。
//
// 与现有实现的关系（§6.6 末尾的关键论证）：
//   runtime.FLAP_THRESHOLD = 4 管**单任务内同一动作**的重复；
//   本模块管**跨任务**的 Skill 复用有效性。两者作用域不同，**刻意不对齐**。
// ============================================================================

// ── Candidate → Active：≥2 次独立成功（G2 的解，§6.3）────────────────────────
const PROMOTION = {
  MIN_INDEPENDENT_SUCCESS: 2,   // 现状 flowMemory 曲线 1 次即 0.925 ≥ 0.85 → 单次即可复用（已证实危险）
  MIN_DISTINCT_SESSIONS: 2,     // 防「同会话连点两次」的假独立
  MIN_TIME_GAP_MS: 10 * 60 * 1000, // ≥1 次成功须落在晋升前的**不同时间窗**（>10min）
  MAX_FAILURES: 0,              // 候选期有失败 → 契约不稳定 → 不给晋升
  MIN_CONTRACT_OBSERVATIONS: 2, // stateContract 必须在 ≥2 次不同观察上成立
};

// ── Active → Stale：区分「结构性失效」与「偶发失败」（§6.4）───────────────────
const STALE = {
  CONTRACT_VIOLATION: 1,        // S1：STATE_MISMATCH 是结构性信号，C105 D-B 实证一次即 20+ 死循环
  CONSECUTIVE_FAILURES: 2,      // S2：单次可能是网络/挑战瞬时态
  IDLE_DAYS: 45,                // S3：必须**叠加**「站点近期有失败」，否则稳定站点被误降级
  SITE_RISK_HIGH: true,         // S4：复用 siteMemory.riskLevel
  MANUAL: true,                 // S5
};

// ── REVALIDATING 出口（§6.6）─────────────────────────────────────────────────
const REVALIDATION = {
  RECOVER_SUCCESSES: 1,         // 已有历史样本，恢复只需 1 次成功
  DEPRECATE_UNSATISFIABLE: 2,   // 契约不可满足 ×2
  DEPRECATE_FAILURES: 3,        // 累计失败 ×3
};

// ── ACTIVE → DEPRECATED（保持现有 memoryRecord 口径，不改）────────────────────
const DEPRECATION = {
  MIN_TOTAL: 5,
  MAX_RATE: 0.4,
};

// 授权阻断**不改变** Skill 状态（§6.5 末条：防止「为让 Skill 能用而弱化安全闸」的激励）
const AUTHORIZATION_BLOCK_AFFECTS_STATUS = false;

// 挑战引起的 STALE 与结构性失效应可区分（§16.2）
const STALE_REASONS = ['STATE_MISMATCH', 'CONSECUTIVE_FAILURES', 'IDLE_WITH_SITE_FAILURES', 'SITE_RISK_HIGH', 'SECURITY_CHALLENGE', 'MANUAL'];

// ── 纯判定 ──────────────────────────────────────────────────────────────────

// 独立成功计数：按 executionId 去重（同一 execution 只算一次），并单独统计独立会话数
// —— 设计要求「不同的 executionId **且** 不同的会话」，两者都必须独立（§6.3）。
// runs: [{ executionId, sessionId, ok, at }]
function independentSuccesses(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && r.ok);
  if (!list.length) return { count: 0, distinctSessions: 0, maxGapMs: 0 };

  const byExec = new Map(); // executionId → 首次成功时刻（同一 execution 多次成功只算一次）
  const sessions = new Set();
  list.forEach((r, i) => {
    const key = (r.executionId != null && r.executionId !== '')
      ? 'exe:' + String(r.executionId)
      : 'rowidx:' + i;
    if (!byExec.has(key)) byExec.set(key, Number(r.at) || 0);
    if (r.sessionId != null && r.sessionId !== '') sessions.add(String(r.sessionId));
  });

  const times = Array.from(byExec.values()).sort((a, b) => a - b);
  const maxGapMs = times.length >= 2 ? times[times.length - 1] - times[0] : 0;
  return { count: byExec.size, distinctSessions: sessions.size, maxGapMs };
}

// 晋升门禁（纯函数）：返回 { eligible, reasons[], evidence }
// §11.4 也要求证据链完整与契约观察次数，这两项由调用方以参数注入（本函数不读 store）。
function promotionGate({ skill, evidenceComplete, contractObservations, runs } = {}) {
  const reasons = [];
  const s = skill || {};
  const ind = independentSuccesses(runs);
  const samples = (s.samples || {});
  const failed = Number(samples.failed || 0);

  if (s.status !== 'CANDIDATE') reasons.push('status 非 CANDIDATE: ' + String(s.status));
  if (ind.count < PROMOTION.MIN_INDEPENDENT_SUCCESS) {
    reasons.push('独立成功次数不足：' + ind.count + ' < ' + PROMOTION.MIN_INDEPENDENT_SUCCESS);
  }
  if (ind.distinctSessions < PROMOTION.MIN_DISTINCT_SESSIONS) {
    reasons.push('独立会话数不足：' + ind.distinctSessions + ' < ' + PROMOTION.MIN_DISTINCT_SESSIONS);
  }
  if (ind.count >= 2 && ind.maxGapMs <= PROMOTION.MIN_TIME_GAP_MS) {
    reasons.push('成功事件时间窗过近（' + ind.maxGapMs + 'ms ≤ ' + PROMOTION.MIN_TIME_GAP_MS + 'ms）');
  }
  if (failed > PROMOTION.MAX_FAILURES) reasons.push('候选期存在失败：' + failed);
  if (evidenceComplete !== true) reasons.push('证据链不完整');
  if (!(Number(contractObservations) >= PROMOTION.MIN_CONTRACT_OBSERVATIONS)) {
    reasons.push('状态契约观察次数不足：' + String(contractObservations) + ' < ' + PROMOTION.MIN_CONTRACT_OBSERVATIONS);
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    evidence: {
      independentSuccesses: ind.count,
      distinctSessions: ind.distinctSessions,
      maxGapMs: ind.maxGapMs,
      failures: failed,
      evidenceComplete: evidenceComplete === true,
      contractObservations: Number(contractObservations) || 0,
    },
  };
}

// 陈旧判定（纯函数）：返回 { stale, reasons[] }
// ctx: { contractViolations, consecutiveFailures, lastSuccessAt, siteHasRecentFailures, siteRiskLevel, challenge, manual }
function staleDecision(skill, ctx) {
  const c = ctx || {};
  const reasons = [];
  if (Number(c.contractViolations || 0) >= STALE.CONTRACT_VIOLATION) reasons.push('STATE_MISMATCH');
  if (Number(c.consecutiveFailures || 0) >= STALE.CONSECUTIVE_FAILURES) reasons.push('CONSECUTIVE_FAILURES');
  if (c.challenge === true) reasons.push('SECURITY_CHALLENGE');
  if (String(c.siteRiskLevel || '').toLowerCase() === 'high') reasons.push('SITE_RISK_HIGH');
  if (c.manual === true) reasons.push('MANUAL');

  // S3 时间陈旧：必须**叠加**站点近期失败信号，纯时间衰减是假信号
  const last = Number(c.lastSuccessAt || (skill && skill.lifecycle && skill.lifecycle.lastSuccessAt) || 0);
  if (last > 0 && c.siteHasRecentFailures === true) {
    const idleMs = Date.now() - last;
    if (idleMs >= STALE.IDLE_DAYS * 24 * 60 * 60 * 1000) reasons.push('IDLE_WITH_SITE_FAILURES');
  }
  return { stale: reasons.length > 0, reasons: reasons.filter((r) => STALE_REASONS.includes(r)) };
}

// ── 置信度公式（G2 的解：**改动集中在公式，不动阈值**）────────────────────────
//
// 现状缺陷（§6.2 实证）：flowMemory.flowConfidence 以**样本总数**算成熟度
//   maturity = min(1, total/2) → 1 次成功 = rate 1 × (0.85+0.15×0.5) = **0.925 ≥ 0.85 阈值**
//   → 「单次成功即触发复用」。这是已证实危险的（投毒事件需要 208 次假成功才被注意到）。
//
// 本公式的唯一改变：**成熟度的唯一来源改为「独立成功次数 × 独立会话数」**，
// 并以 0.84 为未达标天花板 —— 与 0.85 复用阈值保持**严格小于**的关系。
// 阈值 0.85 **原样保留**（不降阈值，避免「为让测试变绿而放宽」的嫌疑）。
//
//   1 次成功 / 1 会话  → 0.300
//   1 次成功 / 2 会话  → 0.400
//   2 次成功 / 1 会话  → 0.500
//   2 次成功 / 2 会话  → 1.000（此时才跨过 0.85）
function skillConfidence({ independentSuccesses, distinctSessions, failed } = {}) {
  const ind = Math.max(0, Number(independentSuccesses) || 0);
  const sess = Math.max(0, Number(distinctSessions) || 0);
  const fail = Math.max(0, Number(failed) || 0);

  const gatePassed = ind >= PROMOTION.MIN_INDEPENDENT_SUCCESS
    && sess >= PROMOTION.MIN_DISTINCT_SESSIONS
    && fail <= PROMOTION.MAX_FAILURES;

  if (!gatePassed) {
    const partial = Math.min(1, ind / PROMOTION.MIN_INDEPENDENT_SUCCESS) * 0.4
      + Math.min(1, sess / PROMOTION.MIN_DISTINCT_SESSIONS) * 0.2;
    return Math.round(Math.min(0.84, Math.max(0, partial)) * 1000) / 1000;
  }
  const rate = ind / (ind + fail);
  return Math.round(Math.min(1, Math.max(0, rate)) * 1000) / 1000;
}

// ============================================================================
// PHASE 17-E — 生命周期状态机（设计依据：§6 Lifecycle / §12 状态机）
//
// 本段**只做纯判定**：给定「当前状态 + 一次执行结果分类 + 生命周期计数」，
// 返回「下一个状态 + 理由 + 证据」。**不写库**（持久化在 skillExecutor）。
//
// 状态机（§12 原文）：
//   CANDIDATE --promotion gate--> ACTIVE
//   ACTIVE --evidence drift / validation failure--> REVALIDATING
//   REVALIDATING --verified success--> ACTIVE
//   REVALIDATING --repeated failure--> STALE
//   STALE --> DEPRECATED （ARCHIVED 为既有词表内的终态，不变）
//
// ★ 两条纪律的落地点，必须逐条对照：
//   §15「STALE 不应该一失败就发生」：
//     单次失败**不**直接 STALE。ACTIVE 上的一次契约违反只进 **REVALIDATING**（观察期）；
//     只有 REVALIDATING 内的**重复**失败（≥ REVALIDATION.DEPRECATE_UNSATISFIABLE）才落 STALE。
//     `STALE.CONTRACT_VIOLATION = 1` 的语义因此被精确定义为「1 次违反足以触发漂移处理」，
//     而不是「1 次违反即 STALE」—— 阈值数值**未改动**。
//   §11「INDETERMINATE 不能直接磨损 confidence」/ 17-B「CREDENTIAL_ACTION_BLOCKED ≠ Skill failure」：
//     这两类结果**不产生任何状态迁移，也不计入任何失败计数**。
// ============================================================================

const LIFECYCLE_STATUS = {
  CANDIDATE: 'CANDIDATE', ACTIVE: 'ACTIVE', REVALIDATING: 'REVALIDATING',
  STALE: 'STALE', DEPRECATED: 'DEPRECATED', ARCHIVED: 'ARCHIVED',
};

// 合法迁移表（**白名单**：不在表内的迁移一律不产生，并留痕 ILLEGAL_TRANSITION）
const LIFECYCLE_TRANSITIONS = {
  CANDIDATE: ['ACTIVE'],
  ACTIVE: ['REVALIDATING', 'STALE', 'DEPRECATED'],
  REVALIDATING: ['ACTIVE', 'STALE'],
  STALE: ['DEPRECATED'],
  DEPRECATED: [],
  ARCHIVED: [],
};

// 执行结果分类（由 skillExecutor 归类，本模块只按分类判定）
//   VERIFIED_SUCCESS       任务以**既有 Verification** 判定为业务成功（延迟确认后才给分）
//   VERIFIED_FAILURE       任务以既有口径失败，且本 Skill 参与了本 execution
//   STATE_MISMATCH         执行期检测到状态漂移（结构性信号）
//   INDETERMINATE          无法判定（观察不可用 / 空元素池 / 页面仍在导航）—— 不磨损
//   AUTHORIZATION_BLOCKED  被既有安全闸拒绝 —— **不改变状态**（§11 防「弱化安全闸」激励）
//   NOT_ATTRIBUTABLE       人工升级 / 取消 / 环境不适用 —— 不归因到 Skill（不磨损）
const OUTCOME = {
  VERIFIED_SUCCESS: 'VERIFIED_SUCCESS',
  VERIFIED_FAILURE: 'VERIFIED_FAILURE',
  STATE_MISMATCH: 'STATE_MISMATCH',
  INDETERMINATE: 'INDETERMINATE',
  AUTHORIZATION_BLOCKED: 'AUTHORIZATION_BLOCKED',
  NOT_ATTRIBUTABLE: 'NOT_ATTRIBUTABLE',
};

// 不产生任何状态迁移 / 不磨损 confidence 的结果分类
const NON_WEARING_OUTCOMES = [OUTCOME.INDETERMINATE, OUTCOME.AUTHORIZATION_BLOCKED, OUTCOME.NOT_ATTRIBUTABLE];

function isNonWearing(outcome) {
  return NON_WEARING_OUTCOMES.includes(String(outcome || ''));
}

// 生命周期计数（全部可增量维护，缺省 0）—— 与 skill.lifecycle 同源
function lifecycleCounters(skill, extra) {
  const lc = Object.assign({}, (skill && skill.lifecycle) || {}, extra || {});
  return {
    consecutiveFailures: Number(lc.consecutiveFailures || 0),
    contractViolations: Number(lc.contractViolations || 0),
    revalidateFailures: Number(lc.revalidateFailures || 0),
    revalidateSuccesses: Number(lc.revalidateSuccesses || 0),
    lastSuccessAt: lc.lastSuccessAt == null ? null : lc.lastSuccessAt,
    lastFailureAt: lc.lastFailureAt == null ? null : lc.lastFailureAt,
  };
}

// 纯判定入口
// input: {
//   skill,                       // 当前 Skill 记录（读 status / samples / lifecycle）
//   outcome,                     // OUTCOME.*
//   runs,                        // aiSkillRuns 全量（独立性判定用；promotionGate 的唯一数据源）
//   evidenceComplete,            // aiSkillEvidence 链完整性（§11.4）
//   contractObservations,        // stateContract 成立过的不同观察次数（§6.3）
//   ctx: { manual, siteRiskLevel, challenge, siteHasRecentFailures }
// }
// 返回 { from, to, changed, reasons[], evidence{} }
function nextStatus(input) {
  const opts = input || {};
  const skill = opts.skill || {};
  const from = String(skill.status || LIFECYCLE_STATUS.CANDIDATE);
  const outcome = String(opts.outcome || '');
  const ctx = opts.ctx || {};
  const counters = lifecycleCounters(skill, opts.lifecycle);
  const reasons = [];

  const result = (to, why) => ({
    from: from,
    to: to,
    changed: to !== from,
    legal: to === from || (LIFECYCLE_TRANSITIONS[from] || []).includes(to),
    reasons: why || [],
    counters: counters,
  });

  // 终态：任何结果都不再迁移
  if (from === LIFECYCLE_STATUS.DEPRECATED || from === LIFECYCLE_STATUS.ARCHIVED) {
    return result(from, ['TERMINAL_STATE']);
  }

  // ★ §11：授权阻断**不改变** Skill 状态（AUTHORIZATION_BLOCK_AFFECTS_STATUS === false）。
  // ★ §15：无法判定 / 不归因的结果不做任何磨损 —— 连计数都不动（计数由调用方按同样的
  //   非磨损清单决定是否增量，本函数只保证不迁移）。
  if (AUTHORIZATION_BLOCK_AFFECTS_STATUS === false && outcome === OUTCOME.AUTHORIZATION_BLOCKED) {
    return result(from, ['AUTHORIZATION_BLOCK_DOES_NOT_AFFECT_STATUS']);
  }
  if (isNonWearing(outcome)) {
    return result(from, ['NON_WEARING_OUTCOME:' + (outcome || 'UNKNOWN')]);
  }

  // 结构性信号（与失败计数无关，独立优先）：人工 / 站点风险 / 安全挑战 → STALE
  if (ctx.manual === true) {
    return (LIFECYCLE_TRANSITIONS[from] || []).includes(LIFECYCLE_STATUS.STALE)
      ? result(LIFECYCLE_STATUS.STALE, ['MANUAL'])
      : result(from, ['MANUAL_NOT_APPLICABLE_FROM_' + from]);
  }
  if (ctx.challenge === true) {
    return (LIFECYCLE_TRANSITIONS[from] || []).includes(LIFECYCLE_STATUS.STALE)
      ? result(LIFECYCLE_STATUS.STALE, ['SECURITY_CHALLENGE'])
      : result(from, ['CHALLENGE_NOT_APPLICABLE_FROM_' + from]);
  }
  if (String(ctx.siteRiskLevel || '').toLowerCase() === 'high') {
    return (LIFECYCLE_TRANSITIONS[from] || []).includes(LIFECYCLE_STATUS.STALE)
      ? result(LIFECYCLE_STATUS.STALE, ['SITE_RISK_HIGH'])
      : result(from, ['SITE_RISK_NOT_APPLICABLE_FROM_' + from]);
  }

  if (from === LIFECYCLE_STATUS.CANDIDATE) {
    if (outcome !== OUTCOME.VERIFIED_SUCCESS) {
      // 候选期失败 / 漂移：**停在 CANDIDATE**（不晋升），如实留痕
      return result(from, [outcome === OUTCOME.STATE_MISMATCH ? 'CANDIDATE_CONTRACT_VIOLATION' : 'CANDIDATE_NO_PROMOTION']);
    }
    const gate = promotionGate({
      skill: skill,
      evidenceComplete: opts.evidenceComplete,
      contractObservations: opts.contractObservations,
      runs: opts.runs,
    });
    if (!gate.eligible) {
      // §13：数据无法证明独立性 → NOT_INDEPENDENT，**不得晋升**
      const ev = gate.evidence || {};
      const notIndependent = Number(ev.independentSuccesses || 0) < PROMOTION.MIN_INDEPENDENT_SUCCESS
        || Number(ev.distinctSessions || 0) < PROMOTION.MIN_DISTINCT_SESSIONS;
      return result(from, (notIndependent ? ['NOT_INDEPENDENT'] : []).concat(gate.reasons));
    }
    return result(LIFECYCLE_STATUS.ACTIVE, ['PROMOTION_GATE_PASSED']);
  }

  if (from === LIFECYCLE_STATUS.ACTIVE) {
    // 契约违反（结构性）→ 观察期，**不是**立即 STALE（§15）
    if (outcome === OUTCOME.STATE_MISMATCH || counters.contractViolations >= STALE.CONTRACT_VIOLATION) {
      return result(LIFECYCLE_STATUS.REVALIDATING, ['EVIDENCE_DRIFT:CONTRACT_VIOLATION']);
    }
    if (outcome === OUTCOME.VERIFIED_FAILURE
      && counters.consecutiveFailures >= STALE.CONSECUTIVE_FAILURES) {
      return result(LIFECYCLE_STATUS.REVALIDATING, ['CONSECUTIVE_FAILURES']);
    }
    // 单次失败 / 成功：保持 ACTIVE
    return result(from, [outcome === OUTCOME.VERIFIED_FAILURE ? 'SINGLE_FAILURE_TOLERATED' : 'NO_CHANGE']);
  }

  if (from === LIFECYCLE_STATUS.REVALIDATING) {
    if (outcome === OUTCOME.VERIFIED_SUCCESS
      && counters.revalidateSuccesses >= REVALIDATION.RECOVER_SUCCESSES) {
      return result(LIFECYCLE_STATUS.ACTIVE, ['REVALIDATED_RECOVERED']);
    }
    if (counters.revalidateFailures >= REVALIDATION.DEPRECATE_UNSATISFIABLE) {
      return result(LIFECYCLE_STATUS.STALE, ['UNSATISFIABLE_CONTRACT']);
    }
    if (outcome === OUTCOME.VERIFIED_FAILURE
      && counters.consecutiveFailures >= REVALIDATION.DEPRECATE_FAILURES) {
      return result(LIFECYCLE_STATUS.STALE, ['REVALIDATION_FAILURES']);
    }
    return result(from, ['REVALIDATION_PENDING']);
  }

  if (from === LIFECYCLE_STATUS.STALE) {
    const samples = skill.samples || {};
    const total = Number(samples.success || 0) + Number(samples.failed || 0);
    const rate = total > 0 ? Number(samples.success || 0) / total : 1;
    if (counters.consecutiveFailures >= REVALIDATION.DEPRECATE_FAILURES) {
      return result(LIFECYCLE_STATUS.DEPRECATED, ['DEPRECATE_FAILURES']);
    }
    if (total >= DEPRECATION.MIN_TOTAL && rate <= DEPRECATION.MAX_RATE) {
      return result(LIFECYCLE_STATUS.DEPRECATED, ['DEPRECATE_LOW_RATE']);
    }
    return result(from, ['STALE_PENDING_DEPRECATION']);
  }

  return result(from, ['UNKNOWN_STATUS_NO_TRANSITION']);
}

// 计数增量（纯）：给定当前计数 + 结果分类，返回新的计数。
// ★ 非磨损清单（INDETERMINATE / AUTHORIZATION_BLOCKED / NOT_ATTRIBUTABLE）**原样返回**。
function advanceCounters(input) {
  const opts = input || {};
  const c = lifecycleCounters(opts.skill, opts.lifecycle);
  const outcome = String(opts.outcome || '');
  const now = Number(opts.now) || Date.now();
  if (isNonWearing(outcome)) return Object.assign({}, c, { at: now, wore: false });

  const next = Object.assign({}, c);
  if (outcome === OUTCOME.VERIFIED_SUCCESS) {
    next.consecutiveFailures = 0;
    next.revalidateSuccesses = c.revalidateSuccesses + 1;
    next.lastSuccessAt = now;
    if (String((opts.skill && opts.skill.status) || '') === LIFECYCLE_STATUS.REVALIDATING) next.revalidateFailures = 0;
  } else if (outcome === OUTCOME.STATE_MISMATCH) {
    next.contractViolations = c.contractViolations + 1;
    next.consecutiveFailures = c.consecutiveFailures + 1;
    next.lastFailureAt = now;
    if (String((opts.skill && opts.skill.status) || '') === LIFECYCLE_STATUS.REVALIDATING) next.revalidateFailures = c.revalidateFailures + 1;
  } else if (outcome === OUTCOME.VERIFIED_FAILURE) {
    next.consecutiveFailures = c.consecutiveFailures + 1;
    next.lastFailureAt = now;
    if (String((opts.skill && opts.skill.status) || '') === LIFECYCLE_STATUS.REVALIDATING) next.revalidateFailures = c.revalidateFailures + 1;
  }
  next.at = now;
  next.wore = true;
  return next;
}

module.exports = {
  PROMOTION, STALE, REVALIDATION, DEPRECATION,
  AUTHORIZATION_BLOCK_AFFECTS_STATUS, STALE_REASONS,
  independentSuccesses, promotionGate, staleDecision, skillConfidence,
  // PHASE 17-E
  LIFECYCLE_STATUS, LIFECYCLE_TRANSITIONS, OUTCOME, NON_WEARING_OUTCOMES,
  isNonWearing, nextStatus, advanceCounters,
};
