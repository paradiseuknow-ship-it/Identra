'use strict';
/**
 * PHASE 17-D —— SkillRouter 五级判定 + 三态预检 + 影子模式契约守护（零浏览器、零 LLM）。
 *
 * 设计依据：.benchmark/PHASE17B_PROJECT_SKILL_ARCHITECTURE.md §9（Router）/ §25.1 / §25.2 / §25.3
 *
 * 本测试有四类断言，每一类都对应设计稿里一条**可被证伪**的承诺：
 *
 *  ① 三态预检（§9.2，C105 教训）—— T8 组
 *     MATCH / MISMATCH / INDETERMINATE 三态必须可分，且
 *     **「空集 ≠ 不存在」**：元素池为空时不得判 MISMATCH（那会重演 C105 F2 死亡螺旋）。
 *     FALSE 是**确定性否定**，必须优先于 INDETERMINATE（否则真不匹配会被误判成"不确定"）。
 *
 *  ② 影子模式（§25.2）—— E 组
 *     决策**不改变执行路径**；本模块结构上无执行入口（无 runTool / browserManager / page）。
 *     route() 是纯函数：同输入 → 同输出，且**不修改传入对象**。
 *
 *  ③ 平局拒绝（§9.4 第 5 条）—— K 组
 *     任何「同分默认取第一个」都是缺陷温床（C105 D-A）。四条决胜规则用尽仍相同 → 必须拒绝。
 *
 *  ④ 静态纪律 —— S 组
 *     零站点名字面量（不含任何站点白/黑名单）、零定位符持久化（不读 observation 元素的
 *     selector 字段）、集合注册齐全（FILES + AUTO_ARCHIVE_LIMITS）。
 *
 * ★ 隔离：与 17-C 同一纪律 —— **必须在 require 任何业务模块之前**设置 FPB_DATA_DIR，
 *   否则 store 会落到真实数据目录（17-C 已踩过）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = path.join(os.tmpdir(), 'c110_skill_router_' + Date.now());
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (e) { /* 已存在即可 */ }
process.env.FPB_DATA_DIR = TMP_DIR;

const router = require('../agent/skill/skillRouter');
const store = require('../agent/store');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}

const SKILL_DIR = path.join(__dirname, '..', 'agent', 'skill');
const ORIGIN = 'https://example.test';
const TASK = { id: 'task_t', objective: 'sign up for a free trial', targetUrl: ORIGIN + '/pricing' };

// ── fixture ────────────────────────────────────────────────────────────────
// 结构严格对齐 skillBuilder.build() 的真实产出（entryState='LANDING' 且其契约全 SOFT）。
function makeSkill(over) {
  const o = over || {};
  const entryClauses = o.entryClauses || [{ type: 'element_present', target: { field: 'email' }, weight: 'REQUIRED' }];
  return {
    id: o.id || 'skill_t',
    schemaVersion: 1,
    version: 1,
    status: o.status || 'CANDIDATE',
    capability: o.capability || 'SIGNUP',
    intent: o.intent || 'signup',
    environmentScope: Object.assign({
      originAnchor: ORIGIN, locale: '*', loginState: '*', profileClass: '*', viewportClass: '*',
    }, o.environmentScope || {}),
    states: o.states || [
      {
        id: 'LANDING', name: '落地页',
        stateContract: { observable: [{ type: 'url_pattern', expect: '/pricing', weight: 'SOFT' }], logic: 'AND', cooldownMs: 0 },
        actions: [],
      },
      {
        id: 'S01', name: '填写邮箱',
        stateContract: { observable: entryClauses, logic: o.logic || 'AND', cooldownMs: 0 },
        actions: [],
      },
      {
        id: 'CONFIRMED', name: '业务完成',
        stateContract: { observable: [], logic: 'AND', cooldownMs: 0 }, actions: [],
      },
    ],
    entryState: 'LANDING',
    terminalStates: ['CONFIRMED'],
    boundaries: { excludesPayment: true, involvesCredentials: false, involvesExternalOrigin: false, requiresHumanOn: ['SECURITY_CHALLENGE', 'MFA', '3DS'] },
    confidence: typeof o.confidence === 'number' ? o.confidence : 0,
    samples: { success: 0, failed: 0 },
    replays: 0, distinctSessions: 0,
    stats: Object.assign({
      hits: 0, prestatesPassed: 0, prestatesFailed: 0, midFailures: 0, fallbacks: 0,
      falsePromotions: 0, authorizationBlocks: 0, contractObservations: 0,
      // 晋升门禁依赖这两项（§11.4）→ 需要观测 "若门禁满足会怎样" 时必须显式注入
      evidenceComplete: false, evidenceMissing: 0,
    }, o.stats || {}),
    evidenceChainRef: null,
    lifecycle: { promotedAt: null, lastSuccessAt: o.lastSuccessAt === undefined ? null : o.lastSuccessAt, lastFailureAt: null, stalenessReasons: [], revalidateAttempts: 0, deprecatedReason: null },
    provenance: { sourceFlowId: null, sourceTaskIds: [], builderVersion: '1.0' },
    createdAt: 1, updatedAt: 1,
  };
}

// 有效观察：含一个 email 输入 → 与默认 entryClauses（element_present:email）匹配
function obsWithEmail(over) {
  return Object.assign({
    observationId: 'obs_t',
    url: ORIGIN + '/pricing',
    textSummary: 'Create your free account today',
    visibleText: 'Create your free account today',
    elements: [
      { name: 'email', id: 'email', tag: 'input', role: 'textbox', visible: true, state: { value: '' }, placeholder: 'you@example.com' },
      { name: 'submit', tag: 'button', role: 'button', visible: true, state: {} },
    ],
    loadingState: 'idle',
    capturedAt: Date.now(),
  }, over || {});
}

// ══════════════════════════════════════════════════════════════════════════
// P0 —— 正向对照：没有它，"恒返回 INDETERMINATE" 之类的空实现也会看起来全绿
// ══════════════════════════════════════════════════════════════════════════
{
  const d = router.route({ task: TASK, observation: obsWithEmail(), skills: [makeSkill({ status: 'ACTIVE', confidence: 1 })] });
  check('P0 route 返回 ok', d && d.ok === true, 'ok=' + (d && d.ok));
  check('P0 五级留痕齐全', Array.isArray(d.stages) && d.stages.length === 5 && d.stages.map((s) => s.n).join(',') === '1,2,3,4,5', 'stages=' + (d.stages || []).length);
  check('P0 正向对照必须命中 SKILL（防空实现）', d.decision === 'SKILL' && d.prestate === 'MATCH', 'decision=' + d.decision + ' prestate=' + d.prestate + ' reason=' + d.reason);
  check('P0 命中时给出 skillId', d.skillId === 'skill_t', 'skillId=' + d.skillId);
}

// ══════════════════════════════════════════════════════════════════════════
// T8 —— 三态预检（§9.2）
// ══════════════════════════════════════════════════════════════════════════
{
  const active = makeSkill({ status: 'ACTIVE', confidence: 1 });
  const d1 = router.route({ task: TASK, observation: obsWithEmail(), skills: [active] });
  check('T8a 有效观察 + 契约全真 → MATCH', d1.prestate === 'MATCH', 'prestate=' + d1.prestate);

  const d2 = router.route({ task: TASK, observation: obsWithEmail({ elements: [{ name: 'phone', tag: 'input', visible: true, state: {} }] }), skills: [active] });
  check('T8b 有效观察 + 元素不匹配 → MISMATCH', d2.prestate === 'MISMATCH' && d2.decision === 'GENERIC', 'prestate=' + d2.prestate);

  const d3 = router.route({ task: TASK, observation: null, skills: [active] });
  check('T8c 观察缺失 → INDETERMINATE', d3.prestate === 'INDETERMINATE' || d3.reason === 'INDETERMINATE:NO_OBSERVATION', 'prestate=' + d3.prestate + ' reason=' + d3.reason);

  const d4 = router.route({ task: TASK, observation: obsWithEmail({ url: 'about:blank' }), skills: [active] });
  check('T8d about:blank → INDETERMINATE', d4.observationUsable === false && d4.reason === 'INDETERMINATE:BLANK_PAGE', 'reason=' + d4.reason);

  const d5 = router.route({ task: TASK, observation: obsWithEmail({ url: 'data:text/html,<p>x</p>' }), skills: [active] });
  check('T8e data: URL（origin 不可解析）→ INDETERMINATE', d5.observationUsable === false && d5.reason === 'INDETERMINATE:OPAQUE_ORIGIN', 'reason=' + d5.reason);

  // ★ C105 核心：空元素池 ≠ 不存在
  const d6 = router.route({ task: TASK, observation: obsWithEmail({ elements: [] }), skills: [active] });
  check('T8f 元素池为空 → INDETERMINATE（★空集≠不存在）', d6.prestate === 'INDETERMINATE' && d6.decision === 'GENERIC', 'prestate=' + d6.prestate + ' reason=' + d6.reason);
  check('T8f-2 空元素池**不得**判 MISMATCH', d6.prestate !== 'MISMATCH', 'prestate=' + d6.prestate);

  const d7 = router.route({ task: TASK, observation: obsWithEmail({ loadingState: 'loading' }), skills: [active] });
  check('T8g 页面仍在导航 → INDETERMINATE', d7.observationUsable === false && d7.reason === 'INDETERMINATE:PAGE_STILL_NAVIGATING', 'reason=' + d7.reason);

  // 延时挂载场景（C105 F2 复现形态）：元素池空 + 有 REQUIRED element_present
  const delayed = makeSkill({ status: 'ACTIVE', confidence: 1, entryClauses: [{ type: 'element_present', target: { field: 'continue' }, weight: 'REQUIRED' }] });
  const d8 = router.route({ task: TASK, observation: obsWithEmail({ elements: [] }), skills: [delayed] });
  check('T8h C105 延时挂载形态 → INDETERMINATE（非 MISMATCH）', d8.prestate === 'INDETERMINATE', 'prestate=' + d8.prestate);
}

// ══════════════════════════════════════════════════════════════════════════
// T8b 组 —— 子句逻辑：FALSE 优先于 INDETERMINATE；OR / AND 语义
// ══════════════════════════════════════════════════════════════════════════
{
  const obs = obsWithEmail();
  const indClause = { type: 'element_present', target: { field: 'absent_field' }, weight: 'REQUIRED' };
  const trueClause = { type: 'url_contains', expect: '/pricing', weight: 'REQUIRED' };

  // 一条 TRUE + 一条 FALSE（AND）→ 确定性否定优先 → MISMATCH
  const both = router.contractVerdict({ observable: [trueClause, indClause], logic: 'AND' }, obs);
  check('T8i AND：一真一假（假为确定性否定）→ MISMATCH', both.verdict === 'MISMATCH', 'verdict=' + both.verdict);

  // 一条 TRUE + 一条因信息不足而 INDETERMINATE：契约本身含 element_present 才会受影响
  const mixed = router.contractVerdict({ observable: [{ type: 'element_present', target: { field: 'email' }, weight: 'REQUIRED' }], logic: 'AND' }, obsWithEmail({ elements: null }));
  check('T8j AND：元素池缺失（null，非空数组）→ INDETERMINATE', mixed.verdict === 'INDETERMINATE', 'verdict=' + mixed.verdict);

  const or1 = router.contractVerdict({ observable: [{ type: 'url_pattern', expect: '/nope', weight: 'REQUIRED' }, trueClause], logic: 'OR' }, obs);
  check('T8k OR：一真一假 → MATCH', or1.verdict === 'MATCH', 'verdict=' + or1.verdict);

  const or2 = router.contractVerdict({ observable: [{ type: 'url_pattern', expect: '/nope', weight: 'REQUIRED' }], logic: 'OR' }, obs);
  check('T8l OR：单条假 → MISMATCH', or2.verdict === 'MISMATCH', 'verdict=' + or2.verdict);

  const softOnly = router.contractVerdict({ observable: [{ type: 'url_pattern', expect: '/pricing', weight: 'SOFT' }], logic: 'AND' }, obs);
  check('T8m 仅 SOFT 子句 → INDETERMINATE（无可判定断言，诚实返回）', softOnly.verdict === 'INDETERMINATE', 'verdict=' + softOnly.verdict);
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 预检目标 = 第一个可执行状态（真实数据形状决定的修正）
// ══════════════════════════════════════════════════════════════════════════
{
  const s = makeSkill();
  const picked = router.executableStateOf(s);
  check('X1 预检跳过全 SOFT 的 LANDING，取第一个可执行状态', picked.state && picked.state.id === 'S01', 'stateId=' + (picked.state && picked.state.id));
  check('X2 requiredClauseCount 对齐同一状态', router.requiredClauseCount(s) === 1, 'count=' + router.requiredClauseCount(s));

  const onlySoft = makeSkill({
    entryClauses: [{ type: 'url_pattern', expect: '/pricing', weight: 'SOFT' }],
    states: [
      { id: 'LANDING', name: 'l', stateContract: { observable: [{ type: 'url_pattern', expect: '/pricing', weight: 'SOFT' }], logic: 'AND', cooldownMs: 0 }, actions: [] },
      { id: 'CONFIRMED', name: 'c', stateContract: { observable: [], logic: 'AND', cooldownMs: 0 }, actions: [] },
    ],
  });
  const pv = router.prestateOf(onlySoft, obsWithEmail());
  check('X3 全 SOFT 的 Skill → INDETERMINATE(NO_REQUIRED_CLAUSE) 而非伪 MATCH', pv.verdict === 'INDETERMINATE' && pv.reason === 'NO_REQUIRED_CLAUSE', 'verdict=' + pv.verdict + ' reason=' + pv.reason);
}

// ══════════════════════════════════════════════════════════════════════════
// ①②③④ 逐级判定
// ══════════════════════════════════════════════════════════════════════════
{
  const obs = obsWithEmail();

  const d = router.route({ task: TASK, observation: obs, skills: [] });
  check('G1a 无任何 Skill → GENERIC / NO_CAPABILITY_MATCH', d.decision === 'GENERIC' && d.reason === 'NO_CAPABILITY_MATCH', 'reason=' + d.reason);

  const dCap = router.route({ task: { id: 't', objective: 'download the report', targetUrl: ORIGIN + '/x' }, observation: obs, skills: [makeSkill({ status: 'ACTIVE', confidence: 1, capability: 'SIGNUP' })] });
  check('G1b capability 不同 → 不收候选', dCap.candidateCount === 0, 'candidateCount=' + dCap.candidateCount);

  const dEnv = router.route({ task: TASK, observation: obs, skills: [makeSkill({ status: 'ACTIVE', confidence: 1, environmentScope: { originAnchor: 'https://other.test' } })] });
  check('G1c originAnchor 不同 → ③ 级剔除', dEnv.candidateCount === 0 && dEnv.stages[2].pass === false, 'candidateCount=' + dEnv.candidateCount);

  const dNoOrigin = router.route({ task: { id: 't', objective: 'sign up', targetUrl: 'about:blank' }, observation: obs, skills: [] });
  check('G1d origin 不可解析 → ok:false / ORIGIN_ANCHOR_UNRESOLVABLE', dNoOrigin.ok === false && dNoOrigin.reason === 'ORIGIN_ANCHOR_UNRESOLVABLE', 'reason=' + dNoOrigin.reason);

  // ④ 门禁三态理由
  const cand = router.route({ task: TASK, observation: obs, skills: [makeSkill({ status: 'CANDIDATE', confidence: 0.3 })] });
  const blocked = cand.candidates[0] && cand.candidates[0].blockedBy;
  check('G1e CANDIDATE → blockedBy 含 NOT_ACTIVE', Array.isArray(blocked) && blocked.includes('NOT_ACTIVE'), 'blockedBy=' + JSON.stringify(blocked));
  check('G1e-2 低置信度 → blockedBy 含 LOW_CONFIDENCE', Array.isArray(blocked) && blocked.includes('LOW_CONFIDENCE'), 'blockedBy=' + JSON.stringify(blocked));

  const lowConf = router.route({ task: TASK, observation: obs, skills: [makeSkill({ status: 'ACTIVE', confidence: 0.5 })] });
  check('G1f ACTIVE 但低于阈值 → 不可用', lowConf.eligibleCount === 0 && lowConf.decision === 'GENERIC', 'eligible=' + lowConf.eligibleCount);

  // ★ 空集 ≠ 不存在（候选侧 C105 纪律）：被 ④ 过滤的候选**必须保留并标注原因**，不得静默丢弃
  check('G1g 被 ④ 过滤的候选仍保留在 candidates[]（空集≠不存在）', cand.candidateCount === 1 && cand.candidates.length === 1, 'candidateCount=' + cand.candidateCount);
  check('G1g-2 该候选带 blockedBy 说明（有据可查，非静默丢弃）', blocked && blocked.length > 0, 'blockedBy=' + JSON.stringify(blocked));

  // ★ 17-C 现状的结构性事实：恒产 CANDIDATE → 决策必然 GENERIC；但**影子预检仍产出有效信号**
  const shadowDecision = router.route({ task: TASK, observation: obs, skills: [makeSkill({ status: 'CANDIDATE', confidence: 0.3 })] });
  check('G1h 未晋升候选 → decision=GENERIC / NO_ELIGIBLE_CANDIDATE', shadowDecision.decision === 'GENERIC' && shadowDecision.reason === 'NO_ELIGIBLE_CANDIDATE', 'reason=' + shadowDecision.reason);
  check('G1h-2 但仍产出预检信号（prestateScope=SHADOW，同一次观察）', shadowDecision.prestate === 'MATCH' && shadowDecision.prestateScope === 'SHADOW', 'prestate=' + shadowDecision.prestate + ' scope=' + shadowDecision.prestateScope);
}

// ══════════════════════════════════════════════════════════════════════════
// K 组 —— §9.4 决胜规则 + 平局拒绝
// ══════════════════════════════════════════════════════════════════════════
{
  const obs = obsWithEmail();
  const mk = (id, over) => makeSkill(Object.assign({ id: id, status: 'ACTIVE', confidence: 1, lastSuccessAt: 1000 }, over || {}));

  // 完全同分 → 必须拒绝（第 5 条规则）
  const tieD = router.route({ task: TASK, observation: obs, skills: [mk('skill_a'), mk('skill_b')] });
  check('K1 四条规则用尽仍同分 → 拒绝平局', tieD.tie === true && tieD.decision === 'GENERIC' && tieD.reason === 'TIE_REFUSED', 'tie=' + tieD.tie + ' reason=' + tieD.reason);
  check('K1-2 拒绝时不给 skillId（宁可不用，不要不确定地用）', tieD.skillId === null, 'skillId=' + tieD.skillId);
  check('K1-3 记录的决胜规则为 REFUSE', tieD.tieRuleApplied === 'REFUSE', 'rule=' + tieD.tieRuleApplied);
  // ★ 决策字段与观测字段必须分离（否则「拒绝」会被误读成「选了某一个」）
  check('K1-4 平局拒绝时 skillId=null（决策语义）', tieD.skillId === null, 'skillId=' + tieD.skillId);
  check('K1-5 observedSkillId 仍如实记录被观测的候选（观测语义）', !!tieD.observedSkillId, 'observedSkillId=' + tieD.observedSkillId);

  // 规则 1：环境特异性（需要 task 侧 locale 才能比较「精确 vs 通配」）
  const spec = router.route({
    task: Object.assign({}, TASK, { locale: 'en' }), observation: obs,
    skills: [mk('skill_a'), mk('skill_b', { environmentScope: { locale: 'en' } })],
  });
  check('K2 规则1 环境特异性（locale 精确 > *）', spec.skillId === 'skill_b' && spec.tieRuleApplied === 'ENV_SPECIFICITY', 'skillId=' + spec.skillId + ' rule=' + spec.tieRuleApplied);
  const specScore = router.envSpecificity(mk('skill_b', { environmentScope: { locale: 'en' } }), { originAnchor: ORIGIN, locale: null });
  check('K2-2 无 task.locale 时特异性恒为 0（不臆造特异性）', specScore === 0, 'score=' + specScore);

  // 规则 2：confidence（mk 默认 confidence=1，故这里压低 skill_a）
  const byConf = router.route({ task: TASK, observation: obs, skills: [mk('skill_a', { confidence: 0.9 }), mk('skill_b')] });
  check('K3 规则2 confidence 高者优先', byConf.skillId === 'skill_b' && byConf.tieRuleApplied === 'CONFIDENCE_DESC', 'skillId=' + byConf.skillId + ' rule=' + byConf.tieRuleApplied);

  // 规则 3：lastSuccessAt
  const byTime = router.route({ task: TASK, observation: obs, skills: [mk('skill_a', { lastSuccessAt: 1000 }), mk('skill_b', { lastSuccessAt: 9999 })] });
  check('K4 规则3 lastSuccessAt 新者优先', byTime.skillId === 'skill_b' && byTime.tieRuleApplied === 'LAST_SUCCESS_DESC', 'skillId=' + byTime.skillId + ' rule=' + byTime.tieRuleApplied);

  // 规则 4：REQUIRED 子句更多者优先（更严格 = 更可能正确）
  const strict = makeSkill({
    id: 'skill_b', status: 'ACTIVE', confidence: 1, lastSuccessAt: 1000,
    entryClauses: [
      { type: 'element_present', target: { field: 'email' }, weight: 'REQUIRED' },
      { type: 'element_present', target: { field: 'submit' }, weight: 'REQUIRED' },
    ],
  });
  const byStrict = router.route({ task: TASK, observation: obs, skills: [mk('skill_a'), strict] });
  check('K5 规则4 更严格的契约优先', byStrict.skillId === 'skill_b' && byStrict.tieRuleApplied === 'REQUIRED_CLAUSES_DESC', 'skillId=' + byStrict.skillId + ' rule=' + byStrict.tieRuleApplied);

  // 只有 1 个命中 → 不触发决胜
  const single = router.route({ task: TASK, observation: obs, skills: [mk('skill_a')] });
  check('K6 单候选不触发决胜', single.skillId === 'skill_a' && single.tie === false, 'skillId=' + single.skillId);
}

// ══════════════════════════════════════════════════════════════════════════
// E 组 —— 影子模式：决策不改变执行路径；route 是纯函数
// ══════════════════════════════════════════════════════════════════════════
{
  // E1 纯函数性：同输入 → 同输出，且不修改传入对象
  const s = makeSkill({ status: 'ACTIVE', confidence: 1 });
  const snapshot = JSON.stringify({ task: TASK, skill: s });
  const o = obsWithEmail();
  const a = router.route({ task: TASK, observation: o, skills: [s], now: 12345 });
  const b = router.route({ task: TASK, observation: o, skills: [s], now: 12345 });
  check('E1 route 是纯函数（同输入同输出）', JSON.stringify(a) === JSON.stringify(b), 'len=' + JSON.stringify(a).length);
  check('E1-2 route 不修改传入的 task / skill', JSON.stringify({ task: TASK, skill: s }) === snapshot, 'mutated=' + (JSON.stringify({ task: TASK, skill: s }) !== snapshot));

  // E2 无执行入口（结构性保证，§8.2）
  const modExports = Object.keys(router);
  const execLike = modExports.filter((k) => /runTool|execute|goto|navigate|newPage|click|fill|browser/i.test(k));
  check('E2 skillRouter 不导出任何执行入口', execLike.length === 0, 'execLike=' + JSON.stringify(execLike));

  // E3 route 的返回值不产生任何持久化副作用
  const before = (store.read(router.ROUTING_COLLECTION, []) || []).length;
  router.route({ task: TASK, observation: obsWithEmail(), skills: [makeSkill({ status: 'ACTIVE', confidence: 1 })] });
  const after = (store.read(router.ROUTING_COLLECTION, []) || []).length;
  check('E3 route 零持久化副作用（决策 ≠ 落库）', before === after, before + ' -> ' + after);

  // E4 shadow 落一条影子记录，且 actual 为空（等待终态回填）
  const task4 = { id: 'task_shadow_1', objective: TASK.objective, targetUrl: TASK.targetUrl, currentExecutionId: 'exec_1' };
  store.insert('aiSkill', makeSkill({ id: 'skill_shadow', status: 'CANDIDATE', confidence: 0.3 }));
  const sh = router.shadow(task4, obsWithEmail());
  check('E4 shadow 返回 ok 且带 routingId', sh.ok === true && !!sh.routingId, JSON.stringify(sh));
  const rows = store.findWhere(router.ROUTING_COLLECTION, (r) => r && r.taskId === task4.id);
  check('E4-2 影子记录已落库', rows.length === 1, 'rows=' + rows.length);
  check('E4-3 初始 actual=null（等待终态回填）', rows.length === 1 && rows[0].actual === null, 'actual=' + (rows[0] && rows[0].actual));
  check('E4-4 记录了五级留痕与观察元信息', rows.length === 1 && Array.isArray(rows[0].stages) && rows[0].stages.length === 5 && !!rows[0].observationMeta, 'stages=' + (rows[0] && rows[0].stages && rows[0].stages.length));

  // ★ 观察元信息不得携带页面正文（体积 + 隐私）
  check('E4-5 observationMeta 不含页面正文（只留元信息）', rows.length === 1 && rows[0].observationMeta && rows[0].observationMeta.textSummary === undefined, 'keys=' + JSON.stringify(Object.keys((rows[0] || {}).observationMeta || {})));
  check('E4-6 observationMeta 记录元素池规模', rows.length === 1 && rows[0].observationMeta.elementCount === 2, 'elementCount=' + (rows[0] && rows[0].observationMeta && rows[0].observationMeta.elementCount));

  // E5 终态回填（影子闭环的另一半）
  const ra = router.recordActual(task4.id, 'SUCCESS');
  check('E5 recordActual 回填成功', ra.ok === true && ra.updated === 1, JSON.stringify(ra));
  const back = store.findWhere(router.ROUTING_COLLECTION, (r) => r && r.taskId === task4.id)[0];
  check('E5-2 actual 已写入 SUCCESS', back && back.actual === 'SUCCESS' && !!back.actualAt, 'actual=' + (back && back.actual));
  const ra2 = router.recordActual(task4.id, 'FAILED');
  check('E5-3 同一任务不重复回填（幂等）', ra2.ok === false && ra2.reason === 'NO_PENDING_ROUTING', JSON.stringify(ra2));
  check('E5-4 回填后仍为首次值（未被覆盖）', store.findWhere(router.ROUTING_COLLECTION, (r) => r && r.taskId === task4.id)[0].actual === 'SUCCESS', 'actual=' + store.findWhere(router.ROUTING_COLLECTION, (r) => r && r.taskId === task4.id)[0].actual);

  // E6 fail-open：非法输入不抛
  let threw = false;
  try { router.shadow(null, null); router.shadow({}, null); router.recordActual(null, null); } catch (e) { threw = true; }
  check('E6 fail-open：非法输入不抛异常', threw === false, 'threw=' + threw);
  check('E6-2 shadow(null) 返回 ok:false', router.shadow(null, null).ok === false, JSON.stringify(router.shadow(null, null)));
}

// ══════════════════════════════════════════════════════════════════════════
// T9 —— INDETERMINATE 不污染统计（§9.2 末条 / 风险 M4）
// ══════════════════════════════════════════════════════════════════════════
{
  const s = makeSkill({ id: 'skill_stat', status: 'ACTIVE', confidence: 1 });
  store.insert('aiSkill', s);
  const before = JSON.stringify(store.find('aiSkill', 'skill_stat'));

  // 观察缺失 → INDETERMINATE
  const d1 = router.route({ task: TASK, observation: null, skills: [s] });
  check('T9a 观察缺失 → INDETERMINATE 且回落 Generic', d1.prestate === 'INDETERMINATE' && d1.decision === 'GENERIC', 'prestate=' + d1.prestate);

  // 空元素池 → INDETERMINATE
  const d2 = router.route({ task: TASK, observation: obsWithEmail({ elements: [] }), skills: [s] });
  check('T9b 空元素池 → INDETERMINATE 且回落 Generic', d2.prestate === 'INDETERMINATE' && d2.decision === 'GENERIC', 'prestate=' + d2.prestate);

  // 关键：以上两次都**不得**触碰 Skill 统计
  const after = JSON.stringify(store.find('aiSkill', 'skill_stat'));
  check('T9c INDETERMINATE 不修改 Skill 记录（不污染 samples.failed）', before === after, 'changed=' + (before !== after));

  const stat = store.find('aiSkill', 'skill_stat');
  check('T9d samples.failed 保持 0', stat.samples && stat.samples.failed === 0, 'failed=' + (stat && stat.samples && stat.samples.failed));
  check('T9e stats.prestatesFailed 保持 0', stat.stats && stat.stats.prestatesFailed === 0, 'prestatesFailed=' + (stat && stat.stats && stat.stats.prestatesFailed));

  // 对照组：真实 MISMATCH 也**不**由 Router 落统计（统计写入属 17-E 的代价）
  const d3 = router.route({ task: TASK, observation: obsWithEmail({ elements: [{ name: 'zzz', tag: 'input', visible: true, state: {} }] }), skills: [s] });
  check('T9f MISMATCH 时 Router 同样不落统计（决策 ≠ 记账）', d3.prestate === 'MISMATCH' && JSON.stringify(store.find('aiSkill', 'skill_stat')) === before, 'prestate=' + d3.prestate);
}

// ══════════════════════════════════════════════════════════════════════════
// G2 —— 独立性判定进入路由（aiSkillRuns 是唯一数据源）
// ══════════════════════════════════════════════════════════════════════════
{
  // 证据链完整 + 契约观察 ≥2（§11.4 的两项前置）→ 让门禁的**唯一**差距落在独立性上
  const s = makeSkill({ id: 'skill_ind', status: 'CANDIDATE', confidence: 0.3, stats: { evidenceComplete: true, contractObservations: 2 } });
  const runs1 = [{ skillId: s.id, ok: true, executionId: 'e1', sessionId: 's1', at: 1 }];
  const d1 = router.route({ task: TASK, observation: obsWithEmail(), skills: [s], runsBySkill: { [s.id]: runs1 } });
  check('G2a 1 次独立成功 → wouldPromote=false', d1.candidates[0].wouldPromote === false, 'wouldPromote=' + d1.candidates[0].wouldPromote);
  check('G2a-2 独立性计数进入候选记录', d1.candidates[0].independence.successes === 1 && d1.candidates[0].independence.distinctSessions === 1, JSON.stringify(d1.candidates[0].independence));

  const runs2 = runs1.concat([{ skillId: s.id, ok: true, executionId: 'e2', sessionId: 's2', at: 1 + 20 * 60 * 1000 }]);
  const d2 = router.route({ task: TASK, observation: obsWithEmail(), skills: [s], runsBySkill: { [s.id]: runs2 } });
  check('G2b 2 次独立成功（不同 exec + 不同会话 + 时间窗）→ wouldPromote=true', d2.candidates[0].wouldPromote === true, 'wouldPromote=' + d2.candidates[0].wouldPromote + ' reasons=' + JSON.stringify(d2.candidates[0].wouldPromoteReasons));

  // 同 execution 两次 → 仍不算独立
  const runs3 = [
    { skillId: s.id, ok: true, executionId: 'e1', sessionId: 's1', at: 1 },
    { skillId: s.id, ok: true, executionId: 'e1', sessionId: 's2', at: 2 },
  ];
  const d3 = router.route({ task: TASK, observation: obsWithEmail(), skills: [s], runsBySkill: { [s.id]: runs3 } });
  check('G2c 同一 execution 多次 → 仍不可晋升（不虚增独立性）', d3.candidates[0].independence.successes === 1 && d3.candidates[0].wouldPromote === false, JSON.stringify(d3.candidates[0].independence));

  check('G2d 影子记录暴露 wouldPromote 供晋升前观测', typeof d2.candidates[0].wouldPromote === 'boolean' && Array.isArray(d2.candidates[0].wouldPromoteReasons), 'reasons=' + JSON.stringify(d2.candidates[0].wouldPromoteReasons));
}

// ══════════════════════════════════════════════════════════════════════════
// S 组 —— 静态纪律
// ══════════════════════════════════════════════════════════════════════════
{
  const files = fs.readdirSync(SKILL_DIR).filter((f) => f.endsWith('.js'));
  const blobs = {};
  for (const f of files) blobs[f] = fs.readFileSync(path.join(SKILL_DIR, f), 'utf8');

  const read = (f) => fs.readFileSync(path.join(SKILL_DIR, f), 'utf8');
  // 剥离注释后再扫描：注释里对「被禁止的 API」的**说明性提及**不构成违规
  // （skillRouter / index 的文件头必须能写明「没有 runTool / 没有 browserManager」，
  //   否则「无执行旁路」这条结构性保证就无法被阅读者验证）。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  // S1 零站点名字面量（口径与 17-C 严格对齐：SEC8 这条检查**本身必须知道**要拒绝哪些站点名）
  const banned = ['webflow', 'github.com', 'google.com', 'apple.com'];
  for (const f of ['skillLifecycle.js', 'skillEvidence.js', 'skillBuilder.js', 'skillRouter.js', 'index.js']) {
    if (!fs.existsSync(path.join(SKILL_DIR, f))) continue;
    const hits = banned.filter((w) => read(f).toLowerCase().indexOf(w) >= 0);
    check('S1 ' + f + ' 无站点名字面量', hits.length === 0, hits.length ? 'hits=' + JSON.stringify(hits) : '');
  }
  const schemaSrc = read('skillSchema.js');
  const sec8At = schemaSrc.indexOf("id: 'SEC8'");
  const leaked = banned.filter((w) => schemaSrc.slice(0, Math.max(0, sec8At)).toLowerCase().indexOf(w) >= 0);
  check('S1b 站点名字面量只允许出现在 skillSchema 的 SEC8 定义内（不得硬编码进通用模型）',
    sec8At > 0 && leaked.length === 0, leaked.length ? 'leaked=' + JSON.stringify(leaked) : '');

  // S2 零定位符持久化（污染源 P1 的结构性防线）
  // 口径同 17-C：只扫**数据产出模块**。skillSchema 的 SEC7 是「定位符形态的拒绝清单」——
  // 它**必须**知道要拒绝哪些形态，那属于安全闸定义，不是违规。
  const locators = [];
  for (const f of ['skillBuilder.js', 'skillRouter.js']) {
    for (const tok of ['.selector', 'xpath', 'offsetX']) if (read(f).indexOf(tok) >= 0) locators.push(f + ':' + tok);
  }
  check('S2 数据产出模块不触碰任何定位符字段（selector / xpath / 坐标）',
    locators.length === 0, locators.length ? locators.join(', ') : '');

  // S3 无执行旁路（§8.2 结构保证：Skill 层不可能绕过 17-A 凭据闸）
  const bypass = [];
  for (const f of files) {
    const src = stripComments(read(f));
    for (const tok of ['tools.runTool', 'browserManager', 'newPage(', 'page.goto(']) {
      if (src.indexOf(tok) >= 0) bypass.push(f + ':' + tok);
    }
  }
  check('S3 Skill 域无执行旁路（剥离注释后扫描）', bypass.length === 0, bypass.length ? bypass.join(', ') : '');

  // S4 集合注册齐全（新集合必须**同时**进 FILES + AUTO_ARCHIVE_LIMITS —— 缺前者硬抛错，缺后者重演 42MB 事故）
  const jsonStore = fs.readFileSync(path.join(__dirname, '..', 'agent', 'storage', 'jsonStore.js'), 'utf8');
  const inFiles = jsonStore.includes('aiSkillRouting:');
  const hasWatermark = /aiSkillRouting:\s*\d+/.test(jsonStore);
  check('S4 aiSkillRouting 已注册到 FILES', inFiles, inFiles ? '' : 'missing');
  check('S4-2 aiSkillRouting 已配置 AUTO_ARCHIVE_LIMITS 水位', hasWatermark, hasWatermark ? '' : 'missing');

  // S5 影子接入点在 runtime，且**不参与**返回值（结构性证据：源码层）
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'agent', 'runtime.js'), 'utf8');
  check('S5 runtime 存在 shadow 接入点', runtime.includes("require('./skill/skillRouter').shadow("), 'missing');
  const shadowCallLine = runtime.split('\n').find((l) => l.includes("skillRouter').shadow("));
  check('S5-2 shadow 调用出现在 try 块中（fail-open）', !!shadowCallLine && shadowCallLine.trim().startsWith('try {'), 'line=' + String(shadowCallLine).trim().slice(0, 80));
  check('S5-3 shadow 的返回值未被赋给任何变量（不改执行路径）', !!shadowCallLine && !/=\s*(await\s+)?require\(.*shadow\(/.test(shadowCallLine), 'line=' + String(shadowCallLine).trim().slice(0, 120));

  // S6 终态回填接入 taskManager（影子闭环的另一半）
  const tm = fs.readFileSync(path.join(__dirname, '..', 'agent', 'taskManager.js'), 'utf8');
  check('S6 taskManager 存在 recordRoutingActual 定义', tm.includes('function recordRoutingActual('), 'missing');
  const callCount = (tm.match(/^\s*recordRoutingActual\(task,/gm) || []).length; // 行首调用，排除函数定义
  check('S6-2 complete / fail / escalate 三处均回填', callCount >= 3, 'count=' + callCount);
}

console.log('');
console.log('结果: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
