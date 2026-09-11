'use strict';

// ============================================================================
// PHASE 17-D — Skill Router（设计依据：§9 Skill Router / §25.1「Router + 预检」）
//
// 五级判定（§9.1）：
//   ① Intent 归一化        normalizeGoal(objective) → intent
//   ② Capability 匹配      通用词表分类（复用 builder.capabilityOf，零站点名）
//   ③ Environment 适用性   originAnchor / locale / loginState / profileClass / viewportClass
//                          （**不匹配 → 不选它，但不是失败**）
//   ④ 置信度 / 陈旧过滤    status=ACTIVE ∧ confidence ≥ 阈值 ∧ 未陈旧
//   ⑤ State Contract 预检  ★G1 —— 对**当前 observation** 判定 stateContract，
//                          判定目标是「第一个可执行状态」（见 executableStateOf 的说明）
//
// ★ 本阶段是【影子模式】：只产出「决策 + 证据」，**决策结果不改变执行路径**（§25.2）。
//   这是项目一贯纪律的直接继承 —— 对照 intelligenceRouter.js:4
//   「不执行任何浏览器动作，只回答『完成这个任务，当前最佳策略是什么』」。
//   本模块**不导出任何执行入口**：没有 runTool / 没有 browserManager / 没有 page 操作，
//   因此「Skill 绕过 Phase 17-A 凭据闸」在结构上不可能发生（§8.2）。
//
// ★ 三态预检（§9.2，C105 教训的强制落地）：
//   MATCH          ≥1 个候选的 stateContract REQUIRED 子句全真
//   MISMATCH       观察有效，但无候选匹配
//   INDETERMINATE  观察失败 / 元素为空 / origin 不可解析 / 页面仍在导航
//   「空集 ≠ 不存在」—— 快照分不清「尚未挂载 / 不在视口」与「永久不可用」。
//   把 INDETERMINATE 当成 MISMATCH，就会重演 C105 F2 首版：
//   延时挂载的按钮被解析成合成 id → 30s 超时 → reload → BLANK 页死亡螺旋。
//
// ★ 平局拒绝（§9.4 第 5 条）：任何「同分默认取第一个」的规则都是缺陷温床
//   （C105 D-A：同分按 DOM 顺序决胜 → 永远点第一个 button）。Skill 层**显式拒绝平局**。
//
// ★ 语义接地而非选择器匹配：observation.elements[] 的语义标识是
//   name / id / placeholder / label / ariaLabel / autocomplete / testId / text，
//   **没有**任何被持久化的定位符参与判定 —— 与「Skill 绝不持久化定位器」纪律一致。
//   本模块**从不读取** observation 元素上的 selector 字段（连读都不读）。
// ============================================================================

const store = require('../store');
const lifecycle = require('./skillLifecycle');
const builder = require('./skillBuilder');
const { normalizeGoal } = require('../intelligence/flowSchema');

const ROUTING_COLLECTION = 'aiSkillRouting';
const SKILL_COLLECTION = builder.SKILL_COLLECTION;
const RUNS_COLLECTION = builder.RUNS_COLLECTION;
const ROUTER_VERSION = '1.0';

// 与 flowMatcher.LOAD_THRESHOLD 同一数值 —— §9.3：复用既有阈值，**不新增调参维度**
const ROUTER_MIN_CONFIDENCE = 0.85;

const DECISION = { SKILL: 'SKILL', GENERIC: 'GENERIC' };
const PRESTATE = { MATCH: 'MATCH', MISMATCH: 'MISMATCH', INDETERMINATE: 'INDETERMINATE' };
// ELIGIBLE = 通过全部前置级的候选；SHADOW = 未过 ④ 但被保留用于观测的候选
const PRESTATE_SCOPE = { ELIGIBLE: 'ELIGIBLE', SHADOW: 'SHADOW' };
const CLAUSE_VERDICT = { TRUE: 'TRUE', FALSE: 'FALSE', INDETERMINATE: 'INDETERMINATE' };

// §9.4 决胜规则（按序应用；全部相同 → 拒绝平局）
const TIE_BREAK_RULES = [
  'ENV_SPECIFICITY',   // environmentScope 特异性高者优先（locale 精确 > '*'）
  'CONFIDENCE_DESC',   // confidence 高者优先
  'LAST_SUCCESS_DESC', // lastSuccessAt 新者优先
  'REQUIRED_CLAUSES_DESC', // REQUIRED 子句更多者优先（更严格 = 更可能正确）
  'REFUSE',            // 仍相同 → 放弃匹配，走 Generic（宁可不用，不要不确定地用）
];

// ── 基础工具（与 builder 同一套归一化口径）──────────────────────────────────
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function originOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch (e) { return null; }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname || '/';
  } catch (e) { return null; }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// pathname 模式匹配：':id' 段匹配任一非空单段（与 builder.pathPatternFrom 的产出对齐）
function patternMatches(expect, pathname) {
  const e = String(expect == null ? '' : expect).trim();
  const p = String(pathname == null ? '' : pathname);
  if (!e) return false;
  if (!p) return false;
  const body = e.split('/').map((seg) => (seg === ':id' ? '[^/]+' : escapeRe(seg))).join('/');
  try {
    return new RegExp('^' + body + '/?$').test(p) || new RegExp('^' + body + '/').test(p);
  } catch (err) { return false; }
}

// ── 观察可用性（整体层面，先于任何子句判定）────────────────────────────────────
// 这是 INDETERMINATE 的第一来源：观察本身不成立时，**任何**候选都不该被判 MISMATCH。
function observationUsable(obs) {
  if (!obs || typeof obs !== 'object') return { usable: false, reason: 'NO_OBSERVATION' };
  const url = String(obs.url || '').trim();
  if (!url) return { usable: false, reason: 'NO_URL' };
  if (/^about:blank$/i.test(url)) return { usable: false, reason: 'BLANK_PAGE' };
  if (/^(data|blob):/i.test(url)) return { usable: false, reason: 'OPAQUE_ORIGIN' };
  if (!/^https?:/i.test(url)) return { usable: false, reason: 'NON_HTTP_ORIGIN' };
  if (!Array.isArray(obs.elements)) return { usable: false, reason: 'NO_ELEMENT_POOL' };
  const ls = String(obs.loadingState || '').toLowerCase();
  if (ls === 'loading') return { usable: false, reason: 'PAGE_STILL_NAVIGATING' };
  return { usable: true, reason: 'OK' };
}

// ── 元素语义接地（**不使用任何定位符**）──────────────────────────────────────
function elementTokens(el) {
  if (!el || typeof el !== 'object') return [];
  const fields = [el.name, el.id, el.placeholder, el.label, el.ariaLabel,
    el.autocomplete, el.testId, el.text, el.roleText, el.innerText];
  const out = [];
  for (const f of fields) {
    if (typeof f !== 'string' || !f) continue;
    const n = norm(f);
    if (!n) continue;
    out.push(n);
    for (const t of n.split(/[\s\-_|:.]+/)) if (t) out.push(t);
  }
  return out;
}

// field 是**语义字段名**（如 email / search / password），不是定位符。
// 保守方向：宽匹配 → 更容易 TRUE（不误判为「不存在」，对齐 C105「空集 ≠ 不存在」）。
function elementMatchesField(el, field) {
  const f = norm(field);
  if (!f || !el) return false;
  if (!(el.visible !== false)) return false;
  const toks = elementTokens(el);
  for (const t of toks) {
    if (t === f) return true;
    if (t.includes(f)) return true;
  }
  return false;
}

// ── 单子句判定：TRUE / FALSE / INDETERMINATE ─────────────────────────────────
function clauseVerdict(clause, obs) {
  if (!clause || typeof clause !== 'object') return CLAUSE_VERDICT.INDETERMINATE;
  const type = clause.type;
  const url = String((obs && obs.url) || '');

  if (type === 'url_pattern') {
    const p = pathOf(url);
    if (!p) return CLAUSE_VERDICT.INDETERMINATE;
    return patternMatches(clause.expect, p) ? CLAUSE_VERDICT.TRUE : CLAUSE_VERDICT.FALSE;
  }

  if (type === 'url_contains') {
    if (!url) return CLAUSE_VERDICT.INDETERMINATE;
    const e = String(clause.expect == null ? '' : clause.expect);
    if (!e) return CLAUSE_VERDICT.INDETERMINATE;
    return url.includes(e) ? CLAUSE_VERDICT.TRUE : CLAUSE_VERDICT.FALSE;
  }

  if (type === 'text_present') {
    const text = [obs && obs.textSummary, obs && obs.visibleText].filter((x) => typeof x === 'string' && x).join(' ');
    if (!text.trim()) return CLAUSE_VERDICT.INDETERMINATE;
    const e = norm(clause.expect);
    if (!e) return CLAUSE_VERDICT.INDETERMINATE;
    return norm(text).includes(e) ? CLAUSE_VERDICT.TRUE : CLAUSE_VERDICT.FALSE;
  }

  if (type === 'element_present' || type === 'element_absent') {
    const field = clause.target && clause.target.field;
    if (!field) return CLAUSE_VERDICT.INDETERMINATE;
    const els = obs && obs.elements;
    if (!Array.isArray(els)) return CLAUSE_VERDICT.INDETERMINATE;
    // ★「空集 ≠ 不存在」：元素池为空 → 无法区分「尚未挂载」与「不存在」
    if (!els.length) return CLAUSE_VERDICT.INDETERMINATE;
    const found = els.some((e) => elementMatchesField(e, field));
    if (type === 'element_present') return found ? CLAUSE_VERDICT.TRUE : CLAUSE_VERDICT.FALSE;
    return found ? CLAUSE_VERDICT.FALSE : CLAUSE_VERDICT.TRUE;
  }

  if (type === 'field_value') {
    const field = clause.target && clause.target.field;
    if (!field) return CLAUSE_VERDICT.INDETERMINATE;
    const els = obs && obs.elements;
    if (!Array.isArray(els) || !els.length) return CLAUSE_VERDICT.INDETERMINATE;
    const hit = els.find((e) => elementMatchesField(e, field));
    if (!hit) return CLAUSE_VERDICT.INDETERMINATE;
    const val = hit.state && hit.state.value;
    if (val == null) return CLAUSE_VERDICT.INDETERMINATE;
    return String(val) === String(clause.expect) ? CLAUSE_VERDICT.TRUE : CLAUSE_VERDICT.FALSE;
  }

  return CLAUSE_VERDICT.INDETERMINATE;
}

// ── stateContract 判定（三态）───────────────────────────────────────────────
// 语义：FALSE 是**确定性否定**，优先于 INDETERMINATE；
//       只有「无 FALSE 且存在 INDETERMINATE」时才整体判 INDETERMINATE。
function contractVerdict(stateContract, obs) {
  const clauses = (stateContract && Array.isArray(stateContract.observable)) ? stateContract.observable : [];
  const logic = (stateContract && stateContract.logic) === 'OR' ? 'OR' : 'AND';
  const required = clauses.filter((c) => c && (c.weight || 'REQUIRED') !== 'SOFT');

  if (!required.length) return { verdict: PRESTATE.INDETERMINATE, clauses: [], reason: 'NO_REQUIRED_CLAUSE' };

  const detail = required.map((c) => ({ clause: c, verdict: clauseVerdict(c, obs) }));
  const anyFalse = detail.some((d) => d.verdict === CLAUSE_VERDICT.FALSE);
  const anyIndet = detail.some((d) => d.verdict === CLAUSE_VERDICT.INDETERMINATE);
  const allTrue = detail.every((d) => d.verdict === CLAUSE_VERDICT.TRUE);

  let verdict;
  if (logic === 'OR') {
    if (allTrue || detail.some((d) => d.verdict === CLAUSE_VERDICT.TRUE)) verdict = PRESTATE.MATCH;
    else if (anyFalse) verdict = PRESTATE.MISMATCH;
    else verdict = PRESTATE.INDETERMINATE;
  } else {
    if (anyFalse) verdict = PRESTATE.MISMATCH;
    else if (anyIndet) verdict = PRESTATE.INDETERMINATE;
    else verdict = allTrue ? PRESTATE.MATCH : PRESTATE.MISMATCH;
  }
  return { verdict, clauses: detail, reason: '' };
}

// ── ①②③ 候选收窄 ──────────────────────────────────────────────────────────
function environmentApplies(skill, ctx) {
  const scope = (skill && skill.environmentScope) || {};
  const wild = (v) => v == null || v === '' || v === '*';
  if (!wild(scope.originAnchor) && scope.originAnchor !== ctx.originAnchor) {
    return { ok: false, reason: 'ORIGIN_ANCHOR_MISMATCH' };
  }
  if (!wild(scope.locale) && ctx.locale && scope.locale !== ctx.locale && !wild(ctx.locale)) {
    return { ok: false, reason: 'LOCALE_MISMATCH' };
  }
  if (!wild(scope.loginState) && ctx.loginState && scope.loginState !== ctx.loginState && !wild(ctx.loginState)) {
    return { ok: false, reason: 'LOGIN_STATE_MISMATCH' };
  }
  if (!wild(scope.profileClass) && ctx.profileClass && scope.profileClass !== ctx.profileClass && !wild(ctx.profileClass)) {
    return { ok: false, reason: 'PROFILE_CLASS_MISMATCH' };
  }
  if (!wild(scope.viewportClass) && ctx.viewportClass && scope.viewportClass !== ctx.viewportClass && !wild(ctx.viewportClass)) {
    return { ok: false, reason: 'VIEWPORT_CLASS_MISMATCH' };
  }
  return { ok: true, reason: '' };
}

// 环境特异性得分（决胜规则 1）：非通配维度数越多越特异；locale 精确额外加权
function envSpecificity(skill, ctx) {
  const scope = (skill && skill.environmentScope) || {};
  let n = 0;
  if (scope.locale && scope.locale !== '*' && ctx.locale && scope.locale === ctx.locale) n += 2;
  if (scope.loginState && scope.loginState !== '*' && ctx.loginState && scope.loginState === ctx.loginState) n += 1;
  if (scope.profileClass && scope.profileClass !== '*' && ctx.profileClass && scope.profileClass === ctx.profileClass) n += 1;
  if (scope.viewportClass && scope.viewportClass !== '*' && ctx.viewportClass && scope.viewportClass === ctx.viewportClass) n += 1;
  return n;
}

// ★ 预检的判定目标不是「入口状态」，而是**第一个可执行状态**。
//
// 为什么（真实数据形状决定，不是偏好）：
//   builder 产出的 `entryState = 'LANDING'`，其 stateContract 只有
//   `url_pattern … weight:'SOFT'`（§A/B 测试与多入口下路径可能不同，
//   刻意设为 SOFT「不参与状态拒绝」）。若直接对入口状态做预检，
//   **任何** Skill 都会得到 NO_REQUIRED_CLAUSE → INDETERMINATE —— 预检形同虚设。
//
//   而设计稿 §9.2 的语义是「stateContract 的 **REQUIRED 子句**全真」，
//   POC-1 变体 C（把 input 换成 textarea → MISMATCH）针对的也是**可执行状态**的契约。
//   因此从入口状态起，取第一个含 REQUIRED 子句的状态。
//
// 若整条 Skill 只有 SOFT 子句 → 如实返回 INDETERMINATE(NO_REQUIRED_CLAUSE)：
// 这不是降级，是**诚实**（没有 REQUIRED 契约就没有可判定的状态断言）。
function executableStateOf(skill) {
  const states = (skill && Array.isArray(skill.states)) ? skill.states.filter((s) => s && typeof s === 'object') : [];
  if (!states.length) return { state: null, reason: 'NO_STATES' };
  const entryId = skill && skill.entryState;
  const idx = states.findIndex((s) => s.id === entryId);
  const ordered = idx >= 0 ? states.slice(idx).concat(states.slice(0, idx)) : states;
  for (const s of ordered) {
    const clauses = (s.stateContract && Array.isArray(s.stateContract.observable)) ? s.stateContract.observable : [];
    if (clauses.some((c) => c && (c.weight || 'REQUIRED') !== 'SOFT')) return { state: s, reason: '' };
  }
  return { state: ordered[0] || null, reason: 'NO_REQUIRED_CLAUSE' };
}

function requiredClauseCount(skill) {
  const picked = executableStateOf(skill);
  if (!picked.state || !picked.state.stateContract) return 0;
  const obs = Array.isArray(picked.state.stateContract.observable) ? picked.state.stateContract.observable : [];
  return obs.filter((c) => c && (c.weight || 'REQUIRED') !== 'SOFT').length;
}

// ④ 前置门禁：status / confidence / 陈旧 三条独立理由，逐条留痕（不合并成一句「不匹配」）
function gateOf(skill, nowMs) {
  const blockedBy = [];
  const status = String((skill && skill.status) || 'CANDIDATE');
  if (status !== 'ACTIVE') blockedBy.push('NOT_ACTIVE');
  const conf = Number((skill && skill.confidence) || 0);
  if (!(conf >= ROUTER_MIN_CONFIDENCE)) blockedBy.push('LOW_CONFIDENCE');
  const stale = lifecycle.staleDecision(skill, {
    lastSuccessAt: skill && skill.lifecycle && skill.lifecycle.lastSuccessAt,
    siteHasRecentFailures: false,
    contractViolations: 0,
    consecutiveFailures: 0,
  });
  if (stale.stale) blockedBy.push('STALE:' + stale.reasons.join('+'));
  return { eligible: blockedBy.length === 0, blockedBy, status, confidence: conf, staleReasons: stale.reasons, at: nowMs };
}

// ── ⑤ 预检：对候选的**第一个可执行状态**做三态判定 ──────────────────────────
function prestateOf(skill, obs) {
  const picked = executableStateOf(skill);
  if (!picked.state) return { verdict: PRESTATE.INDETERMINATE, clauses: [], reason: picked.reason || 'NO_STATES', stateId: null };
  if (picked.reason === 'NO_REQUIRED_CLAUSE') {
    return { verdict: PRESTATE.INDETERMINATE, clauses: [], reason: 'NO_REQUIRED_CLAUSE', stateId: picked.state.id || null };
  }
  return Object.assign(contractVerdict(picked.state.stateContract, obs), { stateId: picked.state.id || null });
}

// ── §9.4 决胜（含显式拒绝平局）──────────────────────────────────────────────
function breakTie(list, ctx) {
  if (list.length <= 1) return { winner: list[0] || null, applied: null, refused: false };
  const score = (c) => [
    envSpecificity(c.skill, ctx),
    Number(c.skill.confidence || 0),
    Number((c.skill.lifecycle && c.skill.lifecycle.lastSuccessAt) || 0),
    requiredClauseCount(c.skill),
  ];
  let pool = list.slice();
  for (let i = 0; i < 4; i += 1) {
    const vals = pool.map((c) => score(c)[i]);
    const best = Math.max.apply(null, vals);
    const next = pool.filter((c) => score(c)[i] === best);
    if (next.length === 1) return { winner: next[0], applied: TIE_BREAK_RULES[i], refused: false };
    if (next.length < pool.length) pool = next;
  }
  // 走到这里 = 四条规则全部无法区分 → **显式拒绝平局**（宁可不用，不要不确定地用）
  return { winner: null, applied: TIE_BREAK_RULES[4], refused: true };
}

// ── 主决策入口（**纯函数**：不写库、不改任何状态）────────────────────────────
// input: { task, observation, skills?, runsBySkill?, now? }
// 返回决策与逐级留痕；调用方（shadow）负责落库。
function route(input) {
  const opts = input || {};
  const task = opts.task || {};
  const obs = opts.observation || null;
  const nowMs = Number(opts.now) || Date.now();
  const stages = [];

  // ① Intent 归一化
  const goalText = task.planGoal || task.objective || '';
  const intent = normalizeGoal(goalText) || null;
  stages.push({ n: 1, name: 'intent', pass: !!intent || !!goalText, detail: { intent: intent, goal: String(goalText).slice(0, 120) } });

  // ② Capability 匹配
  const capability = builder.capabilityOf(goalText);
  stages.push({ n: 2, name: 'capability', pass: true, detail: { capability: capability } });

  // ③ Environment 适用性
  const originAnchor = originOf(task.targetUrl);
  const envCtx = {
    originAnchor: originAnchor,
    locale: task.locale || null,
    loginState: task.loginState || null,
    profileClass: task.profileClass || null,
    viewportClass: task.viewportClass || null,
  };
  if (!originAnchor) {
    stages.push({ n: 3, name: 'environment', pass: false, detail: { reason: 'ORIGIN_ANCHOR_UNRESOLVABLE' } });
    return {
      ok: false,
      decision: DECISION.GENERIC,
      reason: 'ORIGIN_ANCHOR_UNRESOLVABLE',
      intent: intent, capability: capability, originAnchor: null,
      candidates: [], eligibleCount: 0, candidateCount: 0,
      prestate: null, prestateScope: null, skillId: null, observedSkillId: null, observedStateId: null, tie: false,
      stages: stages,
      observationMeta: summarizeObservation(obs),
      routerVersion: ROUTER_VERSION,
    };
  }

  const all = Array.isArray(opts.skills) ? opts.skills.filter((s) => s && typeof s === 'object') : [];
  const scanned = all.filter((s) => {
    const cap = String(s.capability || '');
    const sc = (s.environmentScope || {});
    return cap === capability && (sc.originAnchor == null || sc.originAnchor === originAnchor);
  });
  const envPassed = scanned.filter((s) => environmentApplies(s, envCtx).ok);
  stages.push({
    n: 3, name: 'environment', pass: envPassed.length > 0,
    detail: { scanned: scanned.length, applicable: envPassed.length, originAnchor: originAnchor },
  });

  // ④ 置信度 / 陈旧过滤（**不丢弃**被过滤的候选 —— 空集 ≠ 不存在，全部带 blockedBy 保留）
  const runsOf = (skillId) => {
    if (opts.runsBySkill && Array.isArray(opts.runsBySkill[skillId])) return opts.runsBySkill[skillId];
    return [];
  };
  const candidates = envPassed.map((s) => {
    const g = gateOf(s, nowMs);
    const runs = runsOf(s.id);
    const ind = lifecycle.independentSuccesses(runs);
    const wouldPromote = lifecycle.promotionGate({
      skill: s,
      evidenceComplete: (s.stats && s.stats.evidenceComplete) === true,
      contractObservations: (s.stats && s.stats.contractObservations) || 0,
      runs: runs,
    });
    return {
      skill: s,
      skillId: s.id,
      capability: s.capability,
      intent: s.intent,
      status: g.status,
      confidence: g.confidence,
      eligible: g.eligible,
      blockedBy: g.blockedBy,
      gate: g,
      independence: { successes: ind.count, distinctSessions: ind.distinctSessions },
      wouldPromote: wouldPromote.eligible,
      wouldPromoteReasons: wouldPromote.reasons,
      prestate: null,
      prestateReason: '',
      prestateStateId: null,
      matchedClauses: [],
      verdictDetail: [],
    };
  });
  const eligible = candidates.filter((c) => c.eligible);
  stages.push({
    n: 4, name: 'gate', pass: eligible.length > 0,
    detail: {
      evaluated: candidates.length,
      eligible: eligible.length,
      blockedBy: candidates.filter((c) => !c.eligible).map((c) => ({ skillId: c.skillId, reasons: c.blockedBy })),
    },
  });

  // ⑤ State Contract 预检
  const usable = observationUsable(obs);
  const prestateInputs = eligible.length ? eligible : candidates; // 无合格候选时对保留候选做影子预检
  const scope = eligible.length ? PRESTATE_SCOPE.ELIGIBLE : PRESTATE_SCOPE.SHADOW;
  for (const c of prestateInputs) {
    const pv = prestateOf(c.skill, obs);
    c.prestate = pv.verdict;
    c.verdictDetail = pv.clauses;
    c.matchedClauses = pv.clauses.filter((d) => d.verdict === CLAUSE_VERDICT.TRUE).length;
    c.prestateReason = pv.reason || '';
    c.prestateStateId = pv.stateId || null;
  }

  let decision = DECISION.GENERIC;
  let winner = null;
  let tieRefused = false;
  let tieApplied = null;
  let reason = '';

  if (!candidates.length) {
    reason = 'NO_CAPABILITY_MATCH';
  } else if (!eligible.length) {
    reason = 'NO_ELIGIBLE_CANDIDATE';
  } else if (!usable.usable) {
    // ★ 观察不成立 → INDETERMINATE → Generic，且**不记录任何 Skill 失败**（§9.2）
    reason = 'INDETERMINATE:' + usable.reason;
  } else {
    const matched = eligible.filter((c) => c.prestate === PRESTATE.MATCH);
    if (matched.length) {
      const t = breakTie(matched, envCtx);
      tieApplied = t.applied;
      if (t.winner) {
        winner = t.winner;
        decision = DECISION.SKILL;
        reason = 'PRESTATE_MATCH';
      } else {
        tieRefused = true;
        reason = 'TIE_REFUSED';
      }
    } else if (eligible.some((c) => c.prestate === PRESTATE.INDETERMINATE)) {
      reason = 'INDETERMINATE:' + (eligible.find((c) => c.prestate === PRESTATE.INDETERMINATE).prestateReason || 'CLAUSE_INDETERMINATE');
    } else {
      reason = 'PRESTATE_MISMATCH';
    }
  }

  // ★ 两个字段必须分开，否则「决策」与「观测」会互相污染：
  //   skillId          —— **仅**当 decision=SKILL 时非空（Router 决定用哪个 Skill）
  //   observedSkillId  —— 本次预检**实际判定**的那个候选（含影子观测；decision=GENERIC 时也可能是非空）
  //   平局拒绝时 skillId 必须为 null：拒绝的语义就是「不确定，不用任何 Skill」。
  let outPrestate = null;
  let outPrestateScope = null;
  let outSkillId = null;
  let outObservedSkillId = null;
  let outObservedStateId = null;
  if (winner) {
    outPrestate = winner.prestate;
    outPrestateScope = PRESTATE_SCOPE.ELIGIBLE;
    outSkillId = winner.skillId;
    outObservedSkillId = winner.skillId;
    outObservedStateId = winner.prestateStateId || null;
  } else if (prestateInputs.length) {
    const best = prestateInputs.slice().sort((a, b) => (b.matchedClauses - a.matchedClauses) || (b.confidence - a.confidence))[0];
    outPrestate = best.prestate;
    outPrestateScope = scope;
    outObservedSkillId = best.skillId;
    outObservedStateId = best.prestateStateId || null;
  }

  const matchedCount = (winner ? [winner] : prestateInputs.filter((c) => c.prestate === PRESTATE.MATCH)).length;
  stages.push({
    n: 5, name: 'prestate', pass: decision === DECISION.SKILL,
    detail: {
      observationUsable: usable.usable, observationReason: usable.reason,
      scope: outPrestateScope, verdict: outPrestate, matchedCount: matchedCount,
      observedSkillId: outObservedSkillId, observedStateId: outObservedStateId,
      tieRefused: tieRefused, tieApplied: tieApplied,
    },
  });

  return {
    ok: true,
    decision: decision,
    reason: reason,
    intent: intent,
    capability: capability,
    originAnchor: originAnchor,
    candidates: candidates.map((c) => ({
      skillId: c.skillId, capability: c.capability, intent: c.intent,
      status: c.status, confidence: c.confidence,
      eligible: c.eligible, blockedBy: c.blockedBy,
      prestate: c.prestate, prestateReason: c.prestateReason, prestateStateId: c.prestateStateId,
      matchedClauses: c.matchedClauses,
      independence: c.independence, wouldPromote: c.wouldPromote, wouldPromoteReasons: c.wouldPromoteReasons,
    })),
    eligibleCount: eligible.length,
    candidateCount: candidates.length,
    prestate: outPrestate,
    prestateScope: outPrestateScope,
    skillId: outSkillId,
    observedSkillId: outObservedSkillId,
    observedStateId: outObservedStateId,
    tie: tieRefused,
    tieRuleApplied: tieApplied,
    observationUsable: usable.usable,
    observationReason: usable.reason,
    stages: stages,
    observationMeta: summarizeObservation(obs),
    routerVersion: ROUTER_VERSION,
  };
}

// 观察摘要：只留**元信息**，不留页面内容（体积与隐私双重考虑）
function summarizeObservation(obs) {
  if (!obs || typeof obs !== 'object') return { present: false };
  const els = Array.isArray(obs.elements) ? obs.elements : [];
  return {
    present: true,
    url: String(obs.url || '').slice(0, 200),
    elementCount: els.length,
    textLength: String(obs.textSummary || '').length,
    capturedAt: Number(obs.capturedAt || obs.timestamp) || null,
  };
}

// ── 影子落库（fail-open；**绝不改变调用方的控制流**）─────────────────────────
function shadow(task, observation, opts) {
  try {
    if (!task || !task.id) return { ok: false, reason: 'NO_TASK' };
    const o = opts || {};
    let skills = o.skills;
    if (!Array.isArray(skills)) skills = store.read(SKILL_COLLECTION, []) || [];
    const runsBySkill = {};
    if (!o.runsBySkill) {
      const runs = store.read(RUNS_COLLECTION, []) || [];
      for (const r of runs) {
        if (!r || !r.skillId) continue;
        if (!runsBySkill[r.skillId]) runsBySkill[r.skillId] = [];
        runsBySkill[r.skillId].push(r);
      }
    }
    const decision = route({ task: task, observation: observation, skills: skills, runsBySkill: o.runsBySkill || runsBySkill, now: o.now });
    const rec = {
      id: 'srt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      routerVersion: ROUTER_VERSION,
      taskId: task.id,
      executionId: task.currentExecutionId || null,
      at: Date.now(),
      decision: decision.decision,
      reason: decision.reason,
      prestate: decision.prestate,
      prestateScope: decision.prestateScope,
      skillId: decision.skillId,
      observedSkillId: decision.observedSkillId || null,
      observedStateId: decision.observedStateId || null,
      tie: decision.tie,
      tieRuleApplied: decision.tieRuleApplied || null,
      intent: decision.intent,
      capability: decision.capability,
      originAnchor: decision.originAnchor,
      eligibleCount: decision.eligibleCount,
      candidateCount: decision.candidateCount,
      observationUsable: decision.observationUsable,
      observationReason: decision.observationReason,
      observationMeta: decision.observationMeta,
      candidates: (decision.candidates || []).slice(0, 8),
      stages: decision.stages,
      // 影子闭环：由 recordActual 回填（用于「Router 会怎么决定」vs 实际结果 的比对）
      actual: null,
      actualAt: null,
    };
    store.insert(ROUTING_COLLECTION, rec);
    return { ok: true, routingId: rec.id, decision: rec.decision, prestate: rec.prestate, reason: rec.reason };
  } catch (e) {
    return { ok: false, reason: 'SHADOW_ERROR:' + String((e && e.message) || e) };
  }
}

// 任务结束时回填实际结果（影子比对用）。同一任务只回填一次；fail-open。
// ★ C112 配对守卫：调用方可传 opts.executionId（= 终态时的 task.currentExecutionId），
//   此时**只回填同一 execution 的待回填记录**（executionId 为 null 的旧记录仍兼容回填）。
//   为什么：cancel()/进程硬杀不回填 → 影子记录以 actual=null 残留；retry() 复用同一
//   taskId 二次影子落库后，若按 taskId-only 回填，attempt-1 的决策会被 attempt-2 的
//   实际结果污染（跨 execution 决策/实际错配，决策质量统计失真）。宁可少记不误记。
function recordActual(taskId, actual, opts) {
  try {
    if (!taskId || !actual) return { ok: false, reason: 'BAD_INPUT' };
    const wantExec = (opts && opts.executionId) ? String(opts.executionId) : null;
    const rows = store.findWhere(ROUTING_COLLECTION, (r) => r && r.taskId === taskId && r.actual == null
      && (!wantExec || r.executionId == null || r.executionId === wantExec));
    if (!rows.length) return { ok: false, reason: 'NO_PENDING_ROUTING' };
    const now = Date.now();
    for (const r of rows) {
      r.actual = String(actual).toUpperCase();
      r.actualAt = now;
      store.upsert(ROUTING_COLLECTION, r);
    }
    return { ok: true, updated: rows.length };
  } catch (e) {
    return { ok: false, reason: 'RECORD_ACTUAL_ERROR:' + String((e && e.message) || e) };
  }
}

module.exports = {
  ROUTING_COLLECTION, ROUTER_VERSION, ROUTER_MIN_CONFIDENCE,
  DECISION, PRESTATE, PRESTATE_SCOPE, CLAUSE_VERDICT, TIE_BREAK_RULES,
  route, shadow, recordActual,
  // 供测试的直接单元
  norm, originOf, pathOf, patternMatches, observationUsable,
  elementMatchesField, clauseVerdict, contractVerdict,
  environmentApplies, envSpecificity, gateOf, prestateOf, breakTie, summarizeObservation,
  executableStateOf, requiredClauseCount,
};
