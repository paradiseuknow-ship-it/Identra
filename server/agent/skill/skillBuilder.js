'use strict';

// ============================================================================
// PHASE 17-C — Skill Builder（设计依据：§7 Skill Builder）
//
// 流水线（§7.1）：
//   ① Generic Agent Execution Trace   ← aiSteps + aiAttempts（现有）
//   ② Successful Evidence             ← 只消费 taskManager.complete 的路径
//   ③ Trace Normalization             ← 剔除重试/恢复/reload/replan 中间态（防线 P7）
//   ④ State / Transition Extraction   ← 从步骤序列抽取状态边界
//   ⑤ Semantic Abstraction            ← 文本 → 意图标识（本阶段**确定性词表**，见下）
//   ⑥ Verification Extraction         ← 取**真实通过了**的 verification 契约
//   ⑦ State Contract Synthesis        ← 由该步的验证契约合成 stateContract
//   ⑧ Evidence Chain 完整性检查        ← 缺环 → 停在 CANDIDATE
//   ⑨ Skill Candidate                 ← **恒为 CANDIDATE**；晋升判定属 17-D
//
// 关于「不用 LLM」（与设计报告 §7.3 的一处刻意偏差，须记录）：
//   报告设想「LLM 只做语义抽象」。本阶段**刻意改为确定性多语言词表**，理由三条：
//   ① 17-C 的门禁是「Schema + 静态断言」，引入 LLM 会让门禁不确定、不可复现、且需真 key；
//   ② 词表是**通用动词/名词**，不含任何站点名（§14 禁止站点专用词表）；
//   ③ 抽象不出意图时**不做兜底臆造** —— 该步整步丢弃并记入 rejectedSteps（诚实优于补全）。
//   LLM 语义抽象可在 17-D 以「可注入的 abstractor」形式接入，不改变本文件契约。
//
// 绝不固化六个污染源（§7.2 P1–P6）与本模块的对应防线：
//   P1 定位符冻结       → 本模块**从不读取** action.target 上的 selector 字段（连读都不读）
//   P2 单次 DOM         → stateContract 由**真实验证契约**合成，不推断页面结构
//   P3 随机文本         → lexicalEvidence 只存归一化 token，且**不参与匹配**
//   P4 URL query        → pathPatternFrom 一律丢弃 query/hash（C105 D-C 同因）
//   P5 假成功           → 只消费 complete() 路径 + 要求该步真实 SUCCESS + 必须有验证契约
//   P6 凭据明文         → 只存 valueSource / credentialRef 引用（SEC5 双保险）
// ============================================================================

const store = require('../store');
const schema = require('./skillSchema');
const evidence = require('./skillEvidence');
const lifecycle = require('./skillLifecycle');
const { normalizeGoal } = require('../intelligence/flowSchema');

const SKILL_COLLECTION = 'aiSkill';
const HISTORY_COLLECTION = 'aiSkillHistory';
const RUNS_COLLECTION = 'aiSkillRuns';
const BUILDER_VERSION = '1.0';

// ── 噪声剔除（防线 P7）───────────────────────────────────────────────────────
// 命中即视为「那次恰好恢复成功」的中间态，不是 Skill 的一部分。
const NOISE_STEP_RE = /reload|refresh|刷新|重新加载|retry|重试|recover|恢复|repair|修复|等待|wait|poll|轮询|health|健康检查/i;
const KEPT_STEP_TYPES = ['NAVIGATE', 'ACT', 'EXTRACT'];

// 不构成「状态可识别特征」的验证类型（C105 已证实其恒真/无区分度）
const NON_IDENTIFYING_VERIFICATIONS = new Set(['none', 'action_success', 'page_change', 'storage', 'login_state']);

// ── 通用多语言意图词表（§14：**非站点专用**，只用通用动词/名词）────────────────
// 归一化（去音标/小写）后做子串匹配。匹配结果只进 intent / lexicalEvidence，**不参与定位**。
const INTENT_LEXICON = {
  SIGNUP_CTA: [
    { t: 'sign up', l: 'en' }, { t: 'signup', l: 'en' }, { t: 'sign-up', l: 'en' },
    { t: 'get started', l: 'en' }, { t: 'start free', l: 'en' }, { t: 'free trial', l: 'en' },
    { t: 'create account', l: 'en' }, { t: 'register', l: 'en' },
    { t: '注册', l: 'zh' }, { t: '免费开始', l: 'zh' }, { t: '免费试用', l: 'zh' }, { t: '立即注册', l: 'zh' },
    { t: 'inscri', l: 'fr' }, { t: 'commencer', l: 'fr' }, { t: 'gratuit', l: 'fr' },
    { t: 'creer un compte', l: 'fr' }, { t: 'creer un compte gratuit', l: 'fr' },
    { t: 'registrieren', l: 'de' }, { t: 'kostenlos', l: 'de' }, { t: 'konto erstellen', l: 'de' },
  ],
  LOGIN_CTA: [
    { t: 'log in', l: 'en' }, { t: 'login', l: 'en' }, { t: 'sign in', l: 'en' }, { t: 'signin', l: 'en' },
    { t: '登录', l: 'zh' }, { t: '登陆', l: 'zh' },
    { t: 'connexion', l: 'fr' }, { t: 'se connecter', l: 'fr' },
    { t: 'anmelden', l: 'de' }, { t: 'einloggen', l: 'de' },
  ],
  SEARCH_FIELD: [
    { t: 'search', l: 'en' }, { t: 'query', l: 'en' },
    { t: '搜索', l: 'zh' }, { t: '检索', l: 'zh' },
    { t: 'recherche', l: 'fr' }, { t: 'rechercher', l: 'fr' },
    { t: 'suche', l: 'de' }, { t: 'suchen', l: 'de' },
  ],
  EMAIL_FIELD: [
    { t: 'email', l: 'en' }, { t: 'e-mail', l: 'en' }, { t: 'mail address', l: 'en' },
    { t: '邮箱', l: 'zh' }, { t: '电子邮件', l: 'zh' },
    { t: 'courriel', l: 'fr' }, { t: 'adresse mail', l: 'fr' },
    { t: 'e-mail-adresse', l: 'de' },
  ],
  SUBMIT_CTA: [
    { t: 'submit', l: 'en' }, { t: 'continue', l: 'en' }, { t: 'next', l: 'en' }, { t: 'confirm', l: 'en' },
    { t: '提交', l: 'zh' }, { t: '继续', l: 'zh' }, { t: '下一步', l: 'zh' }, { t: '确认', l: 'zh' },
    { t: 'continuer', l: 'fr' }, { t: 'suivant', l: 'fr' }, { t: 'confirmer', l: 'fr' },
    { t: 'weiter', l: 'de' }, { t: 'bestaetigen', l: 'de' },
  ],
  CART_CTA: [
    { t: 'add to cart', l: 'en' }, { t: 'cart', l: 'en' }, { t: 'buy', l: 'en' },
    { t: '加入购物车', l: 'zh' }, { t: '购物车', l: 'zh' }, { t: '购买', l: 'zh' },
    { t: 'panier', l: 'fr' }, { t: 'ajouter', l: 'fr' },
    { t: 'warenkorb', l: 'de' },
  ],
  DOWNLOAD_CTA: [
    { t: 'download', l: 'en' }, { t: '下载', l: 'zh' },
    { t: 'telecharger', l: 'fr' }, { t: 'herunterladen', l: 'de' },
  ],
};

// 目标能力分类（同样只用通用词，零站点名）
const CAPABILITY_LEXICON = [
  { cap: 'SIGNUP', re: /sign.?up|register|注册|inscri|registrieren|create account|creer un compte/i },
  { cap: 'LOGIN', re: /log.?in|sign.?in|登录|登陆|connexion|anmelden|einloggen/i },
  { cap: 'SEARCH', re: /search|搜索|检索|recherche|suche/i },
  { cap: 'ADD_TO_CART', re: /add to cart|加入购物车|购物车|panier|warenkorb/i },
  { cap: 'CHECKOUT', re: /checkout|结算|支付|付款|\bpay\b|paiement|bezahl/i },
  { cap: 'CREATE_PROJECT', re: /create project|new project|新建项目|创建项目/i },
  { cap: 'DOWNLOAD', re: /download|下载|telecharger|herunterladen/i },
  { cap: 'CONTACT', re: /contact|联系|kontakt/i },
  { cap: 'SUBSCRIBE', re: /subscribe|订阅|abonn|abonnieren/i },
];

const PAYMENT_RE = /card|cvv|cvc|cc-|支付|信用卡|卡号|billing|payment/i;

// ── 基础工具 ────────────────────────────────────────────────────────────────

function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // 去音标：créer → creer
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(s) {
  const t = normalizeText(s).replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '_').replace(/^_+|_+$/g, '');
  return (t || 'x').slice(0, 28);
}

function originOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch (e) { return null; }
}

// P4：只取 origin + pathname 模式；**query / hash 一律丢弃**
// （C105 D-C：URL query 曾污染 host 级判定 —— 那次误判的来源就是一个把域名塞进 query 的跳转）
function pathPatternFrom(url, anchor) {
  try {
    const u = new URL(url, anchor || undefined);
    let p = u.pathname || '/';
    p = p.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/:id');
    return p;
  } catch (e) { return null; }
}

function matchIntent(text) {
  const t = normalizeText(text);
  if (!t) return null;
  for (const intent of Object.keys(INTENT_LEXICON)) {
    for (const entry of INTENT_LEXICON[intent]) {
      if (t.includes(entry.t)) return { intent, locale: entry.l, hit: entry.t };
    }
  }
  return null;
}

function capabilityOf(text) {
  const t = String(text || '');
  for (const e of CAPABILITY_LEXICON) if (e.re.test(t)) return e.cap;
  return 'NAVIGATE_GENERIC';
}

function groupAttempts(attempts) {
  const map = new Map();
  for (const a of (Array.isArray(attempts) ? attempts : [])) {
    if (!a || !a.stepId) continue;
    if (!map.has(a.stepId)) map.set(a.stepId, []);
    map.get(a.stepId).push(a);
  }
  for (const list of map.values()) list.sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
  return map;
}

// ── ③ 轨迹规范化：单步是否可入 Skill ────────────────────────────────────────
function normalizeStep(step, attemptsByStep) {
  if (!step || typeof step !== 'object') return { keep: false, reason: 'STEP_NOT_OBJECT' };
  if (!KEPT_STEP_TYPES.includes(step.type)) return { keep: false, reason: 'STEP_TYPE_NOT_BINDING:' + String(step.type) };
  const a = step.action;
  if (!a || !schema.ACTION_TYPES.includes(a.type)) return { keep: false, reason: 'ACTION_MISSING_OR_INVALID' };
  if (NOISE_STEP_RE.test(String(step.description || '') + ' ' + String(step.expectedOutcome || ''))) {
    return { keep: false, reason: 'NOISE_STEP' };
  }
  // P5：只保留**真实成功**的步
  const atts = attemptsByStep.get(step.id) || [];
  const ok = atts.length ? atts.some((x) => x.status === 'SUCCESS') : step.status === 'SUCCESS';
  if (!ok) return { keep: false, reason: 'STEP_NOT_SUCCESS' };

  // ⑥ 验证契约必须真实存在且具状态区分度
  const v = verificationContractOf(a);
  if (!v) return { keep: false, reason: 'NO_IDENTIFYING_VERIFICATION' };

  return { keep: true, step, action: a, verification: v, attempts: atts };
}

// 验证契约来源：action.verification（非 none）→ 回退 expectedBusinessState.requiredEvidence
// **不臆造**：两者都没有就判定该步不可入 Skill。
function verificationContractOf(action) {
  const v = action && action.verification;
  if (v && v.type && !NON_IDENTIFYING_VERIFICATIONS.has(v.type)) {
    return { type: v.type, expect: v.expect, target: v.target || null };
  }
  const ebs = action && action.expectedBusinessState;
  const req = ebs && Array.isArray(ebs.requiredEvidence) ? ebs.requiredEvidence : null;
  if (req && req.length) {
    const c = req.find((r) => r && r.type && !NON_IDENTIFYING_VERIFICATIONS.has(r.type)
      && schema.OBSERVABLE_TYPES.includes(r.type));
    if (c) return { type: c.type, expect: c.expect, target: c.target || null };
  }
  return null;
}

// ⑦ stateContract 合成：把验证契约翻译为**不持久化定位器**的可观察子句
//   element_present/absent → { target: { field } }（**丢弃 expect 里的 CSS 值**，靠运行时 fresh grounding）
//   text/url 类              → 保留 expect（真实页面文本/URL 片段）
function clauseFromContract(v, action) {
  const type = v && v.type;
  if (!schema.OBSERVABLE_TYPES.includes(type)) return null;
  const field = (action && action.target && action.target.field) || null;
  if (type === 'element_present' || type === 'element_absent') {
    if (!field) return null; // 无 field 时无法在不持久化 selector 的前提下表达存在性
    return { type, target: { field }, weight: 'REQUIRED' };
  }
  const expect = typeof v.expect === 'string' && v.expect.trim() ? v.expect.trim() : null;
  if (!expect) return null;
  return { type, expect, weight: 'REQUIRED' };
}

function transitionKindFor(action, anchor) {
  if (!action || action.type !== 'navigate') return 'UNKNOWN';
  const url = action.target && (action.target.url || action.target.semantic);
  const o = originOf(url ? url : '');
  if (!o) return 'UNKNOWN';
  return o === anchor ? 'SAME_ORIGIN' : 'EXTERNAL_ORIGIN';
}

function valueSourceOf(action) {
  if (action && action.credentialRef) return 'CREDENTIAL_REF';
  if (action && typeof action.value === 'string' && action.value.length) return 'LITERAL';
  return 'NONE';
}

// ── ④⑤⑥⑦ 提炼 ──────────────────────────────────────────────────────────────
function build({ task, steps, attempts } = {}) {
  const rejectedSteps = [];
  if (!task || typeof task !== 'object') return { ok: false, reason: 'NO_TASK', rejectedSteps };

  const anchor = originOf(task.targetUrl);
  if (!anchor) return { ok: false, reason: 'ORIGIN_ANCHOR_UNRESOLVABLE', rejectedSteps };

  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return { ok: false, reason: 'NO_STEPS', rejectedSteps };

  const byStep = groupAttempts(attempts);
  const kept = [];
  for (const s of list) {
    const r = normalizeStep(s, byStep);
    if (!r.keep) { rejectedSteps.push({ stepId: s && s.id, reason: r.reason }); continue; }
    const clause = clauseFromContract(r.verification, r.action);
    if (!clause) { rejectedSteps.push({ stepId: s.id, reason: 'CONTRACT_NOT_IDENTIFYING' }); continue; }
    kept.push(Object.assign({}, r, { clause }));
  }
  if (!kept.length) return { ok: false, reason: 'ALL_STEPS_REJECTED', rejectedSteps };

  // 状态机：LANDING → …（每步一个状态）→ CONFIRMED
  const states = [];
  const locales = new Set();
  const aliases = [];
  let involvesCredentials = false;
  let involvesPayment = false;
  let involvesExternalOrigin = false;

  const landingPath = pathPatternFrom(task.targetUrl, undefined);
  states.push({
    id: 'LANDING',
    name: '落地页',
    stateContract: {
      // SOFT：A/B test 与多入口下路径可能不同，不参与状态拒绝
      observable: landingPath ? [{ type: 'url_pattern', expect: landingPath, weight: 'SOFT' }] : [],
      logic: 'AND',
      cooldownMs: 0,
    },
    actions: [],
  });

  const transitions = [];
  const chainTransitions = [];
  let prevStateId = 'LANDING';

  kept.forEach((k, i) => {
    const st = k.step;
    const a = k.action;
    const stateId = 'S' + String(i + 1).padStart(2, '0') + '_' + slug(
      String(a.type) + '_' + ((a.target && (a.target.field || a.target.semantic || a.target.url)) || 'step'),
    );
    const textForIntent = (a.target && (a.target.semantic || a.target.text)) || st.description || '';
    const hit = matchIntent(textForIntent);
    if (hit) { locales.add(hit.locale); if (aliases.length < 12) aliases.push(normalizeText(textForIntent).slice(0, 60)); }

    const kind = transitionKindFor(a, anchor);
    if (kind === 'EXTERNAL_ORIGIN') involvesExternalOrigin = true;

    const fieldKey = a.target && a.target.field ? String(a.target.field) : '';
    if (a.credentialRef || /pass|pwd|密码|cvv|card|otp|token/i.test(fieldKey)) involvesCredentials = true;
    if (PAYMENT_RE.test(fieldKey + ' ' + String(textForIntent))) involvesPayment = true;

    states.push({
      id: stateId,
      name: String(st.description || a.type || 'step').slice(0, 80),
      stateContract: { observable: [k.clause], logic: 'AND', cooldownMs: 0 },
      actions: [{
        id: 'ACT_' + String(i + 1),
        type: a.type,
        targetSemantic: {
          intent: hit ? hit.intent : null,
          field: fieldKey || null,
          roleHint: (a.target && a.target.role) || null,
          variants: hit ? [{ locale: hit.locale, lexicalEvidence: [hit.hit] }] : [],
        },
        valueSource: valueSourceOf(a),
        credentialRef: a.credentialRef || null,
        preconditions: a.type === 'fill' && a.credentialRef
          ? [{ type: 'ORIGIN_AUTHORIZED', by: 'credentialAuthorization.authorize' }]
          : [],
        expectedTransition: {
          from: prevStateId,
          to: stateId,
          kind,
          // §5.5 固定值：跨域一律不继承凭据授权（SEC4）
          authorizationCarryOver: schema.AUTHORIZATION_CARRY_OVER,
        },
        verification: { type: k.clause.type, expect: k.clause.expect, target: k.clause.target },
        risk: String(st.risk || 'MEDIUM'),
        requiresCredentialAuthorization: !!a.credentialRef,
      }],
    });

    transitions.push({ from: prevStateId, to: stateId, trigger: 'ACT_' + String(i + 1), confirmBy: 'verification', kind });
    chainTransitions.push({
      stateFrom: prevStateId,
      stateTo: stateId,
      obsBeforeRef: k.attempts.length ? k.attempts[0].id : null,
      obsAfterRef: k.attempts.length ? k.attempts[k.attempts.length - 1].id : null,
      target: {
        intent: hit ? hit.intent : null,
        field: fieldKey || null,
        groundedRole: (a.target && a.target.role) || null,
        groundedTag: null,
      },
      action: { type: a.type, valueSource: valueSourceOf(a) },
      verification: {
        contract: { type: k.clause.type, expect: k.clause.expect, target: k.clause.target },
        result: { ok: true, source: 'step_status' },
      },
      at: (k.attempts.length ? k.attempts[k.attempts.length - 1].endedAt : null) || Date.now(),
    });

    prevStateId = stateId;
  });

  states.push({
    id: 'CONFIRMED',
    name: '业务完成',
    stateContract: { observable: [{ type: 'url_pattern', expect: pathPatternFrom(task.targetUrl, anchor) || '/', weight: 'SOFT' }], logic: 'AND', cooldownMs: 0 },
    actions: [],
  });
  transitions.push({ from: prevStateId, to: 'CONFIRMED', trigger: null, confirmBy: 'verification', kind: 'UNKNOWN' });

  const goalText = task.planGoal || task.objective || '';
  const capability = capabilityOf(goalText);

  const skill = {
    id: null, // 由 persist 决定（沿用既有 id 或新建）
    schemaVersion: schema.SCHEMA_VERSION,
    version: 1,
    status: 'CANDIDATE', // ⑨ 恒为 CANDIDATE
    capability,
    intent: normalizeGoal(goalText) || capability.toLowerCase(),
    intentAliases: aliases,
    environmentScope: {
      originAnchor: anchor,
      locale: locales.size ? Array.from(locales).sort() : '*',
      loginState: '*',
      profileClass: '*',
      viewportClass: '*',
    },
    states,
    transitions,
    entryState: 'LANDING',
    terminalStates: ['CONFIRMED'],
    boundaries: {
      excludesPayment: !involvesPayment,
      involvesCredentials,
      involvesExternalOrigin,
      requiresHumanOn: schema.REQUIRES_HUMAN_ON.slice(), // §16.1 固定不可配置
    },
    confidence: 0,
    samples: { success: 0, failed: 0 },
    replays: 0,
    distinctSessions: 0,
    stats: {
      hits: 0, prestatesPassed: 0, prestatesFailed: 0, midFailures: 0,
      fallbacks: 0, falsePromotions: 0, authorizationBlocks: 0, contractObservations: 0,
    },
    evidenceChainRef: null,
    lifecycle: {
      promotedAt: null, lastSuccessAt: null, lastFailureAt: null,
      stalenessReasons: [], revalidateAttempts: 0, deprecatedReason: null,
    },
    provenance: { sourceFlowId: task.flowUsedId || null, sourceTaskIds: [], builderVersion: BUILDER_VERSION },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const chain = evidence.buildChain({
    skillId: null,
    skillVersion: 1,
    capability,
    intent: skill.intent,
    transitions: chainTransitions,
  });
  skill.evidenceChainRef = chain.id;

  return { ok: true, candidate: skill, chain, rejectedSteps, target: { taskId: task.id, anchor, capability } };
}

// ── 落库（⑧ 证据链完整性 + 安全闸 + 恒 CANDIDATE）──────────────────────────
function skillKey(skill) {
  const s = skill || {};
  return String((s.environmentScope && s.environmentScope.originAnchor) || '') + '|'
    + String(s.capability || '') + '|' + String(s.intent || '');
}

function sessionIdOf(task) {
  if (!task) return null;
  if (task.sessionId) return 'sess:' + String(task.sessionId);
  // 保守口径（§6.3「不同会话」）：profile 相同即视为同一会话 —— 宁可少算，不可虚增独立性
  if (task.profileId) return 'profile:' + String(task.profileId);
  return 'exec:' + String(task.currentExecutionId || task.id || '');
}

function persist(candidate, chain, task) {
  const key = skillKey(candidate);
  const existing = store.findWhere(SKILL_COLLECTION, (r) => r && skillKey(r) === key)[0] || null;

  const now = Date.now();
  const firstObservation = !existing || !(existing.provenance && (existing.provenance.sourceTaskIds || []).includes(task.id));

  let skill;
  if (existing) {
    skill = Object.assign({}, existing);
    skill.updatedAt = now;
  } else {
    skill = Object.assign({}, candidate);
    skill.id = 'skill_' + now.toString(36) + Math.random().toString(36).slice(2, 6);
    skill.createdAt = now;
  }

  // 证据链：既有则追加（append-only 的迁移记录），否则新建
  let useChain = chain;
  if (existing) {
    const prev = store.find(evidence.COLLECTION, existing.evidenceChainRef);
    if (prev) {
      useChain = prev;
      evidence.appendTransitions(useChain, chain.transitions);
    }
    // else：旧链已被归档截尾（aiSkillEvidence 水位 3000，最老 1/3 移出主文件）或历史 Skill
    // 无 ref —— 此时 useChain 保持为本次观察的新链。**必须**把 skill.evidenceChainRef
    // 重指到新链 id，否则引用悬挂：Skill 记录指向一条已不在集合里的链，
    // 17-D Router 消费证据链时 find 恒 null（C111 实锤并修复）。
    // 注：旧链的历史迁移记录仍在 archive 归档文件中可查证，此处不伪造「完整」。
  }
  useChain.skillId = skill.id;
  skill.evidenceChainRef = useChain.id;
  useChain.skillVersion = skill.version;

  // provenance：任务只计一次（幂等）
  skill.provenance = Object.assign({}, skill.provenance || {});
  const srcTasks = Array.isArray(skill.provenance.sourceTaskIds) ? skill.provenance.sourceTaskIds.slice() : [];
  if (!srcTasks.includes(task.id)) srcTasks.push(task.id);
  skill.provenance.sourceTaskIds = srcTasks;
  skill.provenance.builderVersion = BUILDER_VERSION;
  if (!skill.provenance.sourceFlowId && task.flowUsedId) skill.provenance.sourceFlowId = task.flowUsedId;

  if (firstObservation) {
    skill.samples = Object.assign({ success: 0, failed: 0 }, skill.samples);
    skill.samples.success = (skill.samples.success || 0) + 1;
    skill.stats = Object.assign({}, skill.stats);
    // 状态契约观察次数（§6.3：契约必须在 ≥2 次不同观察上成立）
    skill.stats.contractObservations = (skill.stats.contractObservations || 0) + 1;
  }

  // 独立重放记录（§6.3 独立性判定的唯一数据源）
  const runs = store.findWhere(RUNS_COLLECTION, (r) => r && r.skillId === skill.id);
  const runKey = String(task.id) + '::' + String(task.currentExecutionId || '');
  if (!runs.some((r) => String(r.taskId) + '::' + String(r.executionId || '') === runKey)) {
    store.insert(RUNS_COLLECTION, {
      id: evidence.uid('srun'),
      skillId: skill.id,
      taskId: task.id,
      executionId: task.currentExecutionId || null,
      sessionId: sessionIdOf(task),
      ok: true,
      at: now,
    });
  }
  const allRuns = store.findWhere(RUNS_COLLECTION, (r) => r && r.skillId === skill.id && r.ok);
  const ind = lifecycle.independentSuccesses(allRuns);
  skill.replays = allRuns.length;
  skill.distinctSessions = ind.distinctSessions;
  skill.confidence = lifecycle.skillConfidence({
    independentSuccesses: ind.count,
    distinctSessions: ind.distinctSessions,
    failed: (skill.samples && skill.samples.failed) || 0,
  });
  skill.lifecycle = Object.assign({}, skill.lifecycle || {}, { lastSuccessAt: now });

  // ⑧ 证据链完整性（如实在 stats 中暴露）
  const comp = evidence.chainCompleteness(useChain);
  skill.stats.evidenceComplete = comp.complete;
  skill.stats.evidenceMissing = comp.missing.length;

  // 安全闸：**落库前**必须全绿（SEC1–SEC8 + 结构）
  const v = schema.validateSkill(skill);
  if (!v.ok) {
    return { ok: false, reason: 'SCHEMA_REJECTED', errors: v.errors, chainId: useChain.id };
  }

  store.upsert(SKILL_COLLECTION, skill);
  if (useChain) store.upsert(evidence.COLLECTION, useChain);

  return {
    ok: true,
    skillId: skill.id,
    status: skill.status,
    key,
    confidence: skill.confidence,
    samples: skill.samples,
    evidenceChainId: useChain.id,
    evidenceComplete: comp.complete,
    evidenceMissing: comp.missing,
    rejectedSteps: [],
  };
}

// ── 对外入口：taskManager.complete 的 fail-open 观察点（§7.4）────────────────
// 绝不抛错、绝不改变任务结果、绝不接执行 —— 失败只返回 {ok:false, reason}。
function observe(task) {
  try {
    if (!task || !task.id) return { ok: false, reason: 'NO_TASK' };
    if (!originOf(task.targetUrl)) return { ok: false, reason: 'ORIGIN_ANCHOR_UNRESOLVABLE' };
    const stepManager = require('../stepManager');
    const steps = stepManager.listSteps(task.id);
    const attempts = store.findWhere('aiAttempts', (a) => a && a.taskId === task.id);
    const r = build({ task, steps, attempts });
    if (!r.ok) return { ok: false, reason: r.reason, rejectedSteps: r.rejectedSteps };
    const p = persist(r.candidate, r.chain, task);
    if (!p.ok) return Object.assign({}, p, { rejectedSteps: r.rejectedSteps });
    return Object.assign({}, p, { rejectedSteps: r.rejectedSteps });
  } catch (e) {
    return { ok: false, reason: 'OBSERVE_ERROR:' + String((e && e.message) || e) };
  }
}

module.exports = {
  SKILL_COLLECTION, HISTORY_COLLECTION, RUNS_COLLECTION, BUILDER_VERSION,
  observe, build, persist, skillKey, sessionIdOf,
  // 供测试的直接单元
  normalizeText, matchIntent, capabilityOf, pathPatternFrom, originOf,
  normalizeStep, verificationContractOf, clauseFromContract, transitionKindFor, valueSourceOf,
  NOISE_STEP_RE, INTENT_LEXICON, CAPABILITY_LEXICON,
};
