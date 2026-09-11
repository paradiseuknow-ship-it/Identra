'use strict';
/**
 * PHASE 17-C —— Skill Builder / Lifecycle / Evidence 守护（零浏览器、零 LLM）。
 *
 * 设计依据：.benchmark/PHASE17B_PROJECT_SKILL_ARCHITECTURE.md §6 / §7 / §11 / §17 / 附录 C
 *
 * 覆盖 T6–T10、T18–T20、T23、T24 中**本阶段可实现**的部分，外加三条「必须证明真正执行到了」：
 *   ★ 安全闸在**落库路径**上生效（不是只测 helper）—— 见 [GATE]
 *   ★ Builder 输出**结构上**不含任何定位符 —— 见 [T20]
 *   ★ 置信度公式**结构上**不再「单次成功即 ≥0.85」—— 见 [G2]
 *
 * 隔离：本测试在 require 业务模块**之前**把 FPB_DATA_DIR 指向临时目录，
 * 并断言真实数据目录未被写入（附录 C 的 T24）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 必须在 require 业务模块之前设置（store 单例在 require 时创建）──────────────
const TMP_DIR = path.join(os.tmpdir(), 'c109_skill_' + Date.now());
process.env.FPB_DATA_DIR = TMP_DIR;
const REAL_DATA_DIR = path.join(__dirname, '..', 'data');
const realSkillFile = path.join(REAL_DATA_DIR, 'aiSkill.json');
const realBefore = fs.existsSync(realSkillFile) ? fs.statSync(realSkillFile).mtimeMs : null;

const store = require('../agent/storage');
const schema = require('../agent/skill/skillSchema');
const evidence = require('../agent/skill/skillEvidence');
const lifecycle = require('../agent/skill/skillLifecycle');
const builder = require('../agent/skill/skillBuilder');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}

// ── fixture：一次「真实成功」的轨迹 ────────────────────────────────────────
const T1 = 'task_c109_a';
const TASK = {
  id: T1,
  targetUrl: 'https://shop.example.test/search',
  objective: '搜索商品',
  planGoal: 'search products',
  profileId: 'p_c109',
  currentExecutionId: 'exe_c109_1',
};

function step(id, index, type, description, action, status) {
  return { id: T1 + '_' + id, taskId: T1, index, type, description, risk: 'LOW', status: status || 'SUCCESS', action };
}

const STEPS = [
  // ① 导航步：url_contains 验证（真实契约）
  step('step_001', 0, 'NAVIGATE', '打开搜索页', {
    type: 'navigate',
    target: { url: 'https://shop.example.test/search' },
    verification: { type: 'url_contains', expect: '/search' },
  }),
  // ② 填充步：源 verification 里**带 CSS selector**（P1 污染源的真实形态）
  step('step_002', 1, 'ACT', '在搜索框输入关键词', {
    type: 'fill',
    target: { field: 'search', semantic: '搜索框' },
    value: 'shoes',
    verification: { type: 'element_present', target: { selector: '#results' } },
  }),
  // ③ 恢复噪声步：描述命中 reload 类噪声，且是「当年恰好恢复成功」的中间态
  step('step_003', 2, 'ACT', '重新加载页面', {
    type: 'click',
    target: { field: 'retryBtn' },
    verification: { type: 'element_present', target: { field: 'retryBtn' } },
  }),
  // ④ 提交步
  step('step_004', 3, 'ACT', '点击搜索按钮', {
    type: 'click',
    target: { field: 'searchBtn', semantic: '搜索按钮' },
    verification: { type: 'element_present', target: { field: 'searchBtn' } },
  }),
  // ⑤ 无状态区分度验证的步（action_success 不得构成状态特征）
  step('step_005', 4, 'ACT', '滚动到底部', {
    type: 'click',
    target: { field: 'scrollBtn' },
    verification: { type: 'action_success' },
  }),
  // ⑥ 未成功的步（不得入 Skill）
  step('step_006', 5, 'ACT', '点击促销弹窗', {
    type: 'click',
    target: { field: 'promoBtn' },
    verification: { type: 'element_present', target: { field: 'promoBtn' } },
  }, 'FAILED'),
];

function attemptOf(s) {
  return { id: 'att_' + s.id, stepId: s.id, taskId: T1, executionId: 'exe_c109_1', status: s.status, startedAt: 1000, endedAt: 2000 };
}
const ATTEMPTS = STEPS.map(attemptOf);

// ── P0 正向对照 ────────────────────────────────────────────────────────────
let candidate = null;
let chain = null;
let rejected = [];
{
  const r = builder.build({ task: TASK, steps: STEPS, attempts: ATTEMPTS });
  candidate = r.candidate; chain = r.chain; rejected = r.rejectedSteps || [];
  check('P0 build 成功产出候选', r.ok === true && !!candidate, r.ok ? '' : String(r.reason));
}

// ── ⑨ 恒为 CANDIDATE ───────────────────────────────────────────────────────
{
  check('T6 Builder 产出恒为 CANDIDATE（本阶段不接晋升）', candidate && candidate.status === 'CANDIDATE',
    candidate && candidate.status);
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'skill', 'skillBuilder.js'), 'utf8');
  check('T6b Builder 源码不存在把 ACTIVE 写入 status 的分支',
    src.indexOf("status: 'ACTIVE'") < 0 && src.indexOf('status = \'ACTIVE\'') < 0);
}

// ── ③ 轨迹规范化：噪声 / 非成功 / 无区分度验证剔除 ──────────────────────────
{
  const byId = new Map(rejected.map((x) => [x.stepId, x.reason]));
  check('N1 恢复噪声步被剔除（防线 P7）', byId.get(T1 + '_step_003') === 'NOISE_STEP', String(byId.get(T1 + '_step_003')));
  check('N2 非成功步被剔除（P5：假成功不入 Skill）', byId.get(T1 + '_step_006') === 'STEP_NOT_SUCCESS', String(byId.get(T1 + '_step_006')));
  check('N3 action_success 不构成状态特征，该步被剔除',
    byId.get(T1 + '_step_005') === 'NO_IDENTIFYING_VERIFICATION' || byId.get(T1 + '_step_005') === 'CONTRACT_NOT_IDENTIFYING',
    String(byId.get(T1 + '_step_005')));
}

// ── ④⑦ 状态机与状态契约 ───────────────────────────────────────────────────
{
  const ids = candidate.states.map((s) => s.id);
  check('S1 状态机含 LANDING 与 CONFIRMED', ids[0] === 'LANDING' && ids[ids.length - 1] === 'CONFIRMED', JSON.stringify(ids));
  check('S1b 保留步数 = 3 → 状态数 = 5', candidate.states.length === 5, 'n=' + candidate.states.length);
  check('S1c entryState/terminalStates 自洽',
    candidate.entryState === 'LANDING' && candidate.terminalStates[0] === 'CONFIRMED');
  const allClauses = candidate.states.flatMap((s) => s.stateContract.observable);
  check('S1d 状态契约只含存在性/文本/URL 类子句',
    allClauses.every((c) => schema.OBSERVABLE_TYPES.includes(c.type)), JSON.stringify(allClauses.map((c) => c.type)));
  check('S1e 子句权重只含 REQUIRED/SOFT',
    allClauses.every((c) => schema.OBSERVABLE_WEIGHTS.includes(c.weight)));
}

// ── ★ T20 结构性无水印：源 verification 带 #results，产物必须不含 ────────────
{
  const blob = JSON.stringify(candidate);
  const hits = ['"selector"', '"xpath"', '"coordinates"', '"offsetX"', '#results'].filter((k) => blob.indexOf(k) >= 0);
  check('T20a 候选不含任何定位符键（源 selector 未被搬运）', hits.length === 0, 'hits=' + JSON.stringify(hits));
  check('T20b 源 verification 确实带 selector（证明上面不是空断言）',
    JSON.stringify(STEPS[1].action.verification).indexOf('#results') >= 0);
}

// ── ⑤ 语义抽象（通用多语言词表，零站点名）───────────────────────────────────
{
  check('M1 英文搜索意图可抽象', builder.matchIntent('Search products') !== null
    && builder.matchIntent('Search products').intent === 'SEARCH_FIELD');
  check('M2 中文登录意图可抽象', builder.matchIntent('登录').intent === 'LOGIN_CTA');
  check('M3 法语注册意图可抽象（带音标归一化）', builder.matchIntent('Créer un compte gratuit').intent === 'SIGNUP_CTA');
  check('M4 德语注册意图可抽象', builder.matchIntent('Kostenlos registrieren').intent === 'SIGNUP_CTA');
  check('M5 抽象不出时不臆造（返回 null）', builder.matchIntent('zzz qqq') === null);
  check('M6 capability 分类走受控词表', builder.capabilityOf('sign up for free') === 'SIGNUP'
    && builder.capabilityOf('完全无关的文本') === 'NAVIGATE_GENERIC');
}

// ── P4：URL query 一律丢弃 ─────────────────────────────────────────────────
{
  check('P4a pathPattern 保留 pathname', builder.pathPatternFrom('https://a.test/orders/12345') === '/orders/:id',
    String(builder.pathPatternFrom('https://a.test/orders/12345')));
  check('P4b URL query 被丢弃（C105 D-C 同因）',
    builder.pathPatternFrom('https://a.test/x?pscd=other.example&q=1') === '/x',
    String(builder.pathPatternFrom('https://a.test/x?pscd=other.example&q=1')));
}

// ── ⑥ 证据链 ───────────────────────────────────────────────────────────────
{
  const comp = evidence.chainCompleteness(chain);
  check('E1 证据链迁移数 = 保留步数', chain.transitions.length === 3, 'n=' + chain.transitions.length);
  check('E2 证据链完整（五要素齐备）', comp.complete === true, JSON.stringify(comp.missing));
  check('E3 每个迁移有指向 aiAttempts 的引用（不依赖 aiEvents）',
    chain.transitions.every((t) => t.obsBeforeRef && t.obsAfterRef));
  check('E4 证据链不含定位符', JSON.stringify(chain).indexOf('"selector"') < 0 && JSON.stringify(chain).indexOf('#results') < 0);
  check('E5 证据链只存 valueSource 不存值',
    chain.transitions.every((t) => t.action.valueSource !== undefined && t.action.value === undefined)
    && JSON.stringify(chain).indexOf('"shoes"') < 0);
  check('E6 verification.result.ok 来自真实步状态', chain.transitions.every((t) => t.verification.result.ok === true));
}

// ── ★ [GATE] 安全闸在落库路径上生效 ────────────────────────────────────────
{
  const r = builder.build({ task: TASK, steps: STEPS, attempts: ATTEMPTS });
  const bad = r.candidate;
  bad.environmentScope.originAnchor = 'https://gate.example.test'; // 换 key，避免命中已有记录
  bad.states[1].name = 'solve captcha and continue';
  const before = store.findWhere('aiSkill', (x) => x && x.capability === bad.capability
    && x.environmentScope && x.environmentScope.originAnchor === 'https://gate.example.test').length;
  const p = builder.persist(bad, r.chain, TASK);
  const after = store.findWhere('aiSkill', (x) => x && x.capability === bad.capability
    && x.environmentScope && x.environmentScope.originAnchor === 'https://gate.example.test').length;
  check('[GATE] 违规候选落库被拒', p.ok === false && p.reason === 'SCHEMA_REJECTED', String(p.reason));
  check('[GATE] 被拒候选确实未写入 store（闸在写路径上，非仅 helper）', before === 0 && after === 0,
    'before=' + before + ' after=' + after);
  check('[GATE] 拒绝原因为 SEC1 绕过语义', (p.errors || []).some((e) => e.id === 'SEC1'),
    JSON.stringify((p.errors || []).map((e) => e.id)));
}

// ── 落库 + 幂等 + Profile 隔离 ─────────────────────────────────────────────
// observe() 走真实路径：从 store 读 aiSteps / aiAttempts（不是用内存 fixture）
STEPS.forEach((s) => store.insert('aiSteps', s));
ATTEMPTS.forEach((a) => store.insert('aiAttempts', a));
{
  const p = builder.observe(TASK);
  check('W1 observe 落库成功', p.ok === true, String(p.reason));
  check('W2 落库记录状态为 CANDIDATE', p.status === 'CANDIDATE', String(p.status));

  const stored = p.ok ? store.find('aiSkill', p.skillId) : null;
  check('W3 store 中可读回记录', !!stored);
  const v = schema.validateSkill(stored);
  check('W4 落库记录本身通过全部安全检查（SEC1–SEC8）', v.ok === true, JSON.stringify(v.errors));

  const ev = stored ? store.find('aiSkillEvidence', stored.evidenceChainRef) : null;
  check('W5 证据链独立落库（aiSkillEvidence）', !!ev && ev.transitions.length >= 3, ev ? String(ev.transitions.length) : 'missing');

  // 幂等：同一任务重复观察不得重复计数
  const p2 = builder.observe(TASK);
  const stored2 = p.ok ? store.find('aiSkill', p.skillId) : null;
  check('W6 重复观察幂等（samples.success 仍为 1）', !!stored2 && stored2.samples.success === 1,
    stored2 ? String(stored2.samples.success) : 'missing');
  const runs2 = p.ok ? store.findWhere('aiSkillRuns', (r) => r && r.skillId === p.skillId) : [];
  check('W7 重复观察幂等（runs 仍为 1）', runs2.length === 1, 'n=' + runs2.length);
  check('W8 重复观察不新建 Skill 记录', p.ok && store.findWhere('aiSkill', (r) => r && r.id === p.skillId).length === 1);
  check('W9 observe 返回 rejectedSteps 供审计', p2 && Array.isArray(p2.rejectedSteps) && p2.rejectedSteps.length === 3,
    'n=' + ((p2 && p2.rejectedSteps) || []).length);

  // T20 全量扫描：Skill Store + 证据链零定位符
  const skillBlob = JSON.stringify(store.read('aiSkill', [])).toLowerCase();
  const evBlob = JSON.stringify(store.read('aiSkillEvidence', [])).toLowerCase();
  const locators = ['"selector"', '"xpath"', '"offsetx"', 'document.queryselector', '#results'];
  check('T20c Skill Store 全量零定位符', locators.every((k) => skillBlob.indexOf(k) < 0),
    JSON.stringify(locators.filter((k) => skillBlob.indexOf(k) >= 0)));
  check('T20d 证据链全量零定位符', locators.every((k) => evBlob.indexOf(k) < 0),
    JSON.stringify(locators.filter((k) => evBlob.indexOf(k) >= 0)));

  // T23：清空 aiEvents 后证据链仍可解析（证明不依赖 500 条环形缓冲）
  store.write('aiEvents', []);
  const ev2 = stored ? store.find('aiSkillEvidence', stored.evidenceChainRef) : null;
  check('T23 aiEvents 清空后证据链仍可解析', !!ev2 && ev2.transitions.length >= 3);

  // 凭据/字面值只存来源，不存值
  const blob = JSON.stringify(store.read('aiSkill', []));
  check('W10 步内字面值不落库（只存 valueSource，不存 value）',
    blob.indexOf('"shoes"') < 0 && blob.indexOf('"value"') < 0,
    'shoes=' + (blob.indexOf('"shoes"') >= 0) + ' valueKey=' + (blob.indexOf('"value"') >= 0));
}

// ── ★ [G2] 置信度公式：单次成功不再跨过复用阈值 ────────────────────────────
{
  const c1 = lifecycle.skillConfidence({ independentSuccesses: 1, distinctSessions: 1, failed: 0 });
  const c2 = lifecycle.skillConfidence({ independentSuccesses: 1, distinctSessions: 2, failed: 0 });
  const c3 = lifecycle.skillConfidence({ independentSuccesses: 2, distinctSessions: 1, failed: 0 });
  const c4 = lifecycle.skillConfidence({ independentSuccesses: 2, distinctSessions: 2, failed: 0 });
  check('[G2] 1 次成功 / 1 会话 → 严格低于 0.85 复用阈值', c1 < 0.85, String(c1));
  check('[G2] 1 次成功 / 2 会话 → 仍低于 0.85（独立会话不能替代独立成功）', c2 < 0.85, String(c2));
  check('[G2] 2 次成功 / 1 会话 → 仍低于 0.85（独立会话是必需条件）', c3 < 0.85, String(c3));
  check('[G2] 2 次成功 / 2 会话 → 达到阈值', c4 >= 0.85, String(c4));
  check('[G2] 单调性：样本增加置信度不下降', c1 <= c2 && c2 <= c4 && c1 <= c3 && c3 <= c4);
  check('[G2] 现状缺陷不再可复现：flowMemory 口径下 1 次成功 = 0.925 ≥ 0.85，新公式必须 < 0.85', c1 < 0.85 && c1 !== 0.925);
  check('[G2] 候选期有失败 → 不给晋升',
    lifecycle.skillConfidence({ independentSuccesses: 2, distinctSessions: 2, failed: 1 }) < 0.85);
}

// ── 晋升门禁（≥2 次独立成功 · 独立会话 · 时间窗 · 证据完整）──────────────────
{
  const SK = { status: 'CANDIDATE', samples: { success: 2, failed: 0 } };
  const near = [
    { executionId: 'e1', sessionId: 's1', ok: true, at: 1000 },
    { executionId: 'e2', sessionId: 's2', ok: true, at: 1000 + 60 * 1000 },
  ];
  const far = [
    { executionId: 'e1', sessionId: 's1', ok: true, at: 1000 },
    { executionId: 'e2', sessionId: 's2', ok: true, at: 1000 + 20 * 60 * 1000 },
  ];
  const sameSession = [
    { executionId: 'e1', sessionId: 's1', ok: true, at: 1000 },
    { executionId: 'e2', sessionId: 's1', ok: true, at: 1000 + 20 * 60 * 1000 },
  ];
  const sameExec = [
    { executionId: 'e1', sessionId: 's1', ok: true, at: 1000 },
    { executionId: 'e1', sessionId: 's2', ok: true, at: 1000 + 20 * 60 * 1000 },
  ];

  const gFar = lifecycle.promotionGate({ skill: SK, evidenceComplete: true, contractObservations: 2, runs: far });
  const gNear = lifecycle.promotionGate({ skill: SK, evidenceComplete: true, contractObservations: 2, runs: near });
  const gSession = lifecycle.promotionGate({ skill: SK, evidenceComplete: true, contractObservations: 2, runs: sameSession });
  const gExec = lifecycle.promotionGate({ skill: SK, evidenceComplete: true, contractObservations: 2, runs: sameExec });
  const gNoEv = lifecycle.promotionGate({ skill: SK, evidenceComplete: false, contractObservations: 2, runs: far });
  const gFewObs = lifecycle.promotionGate({ skill: SK, evidenceComplete: true, contractObservations: 1, runs: far });

  check('G1 2 次独立成功 + 独立会话 + 时间窗 + 证据完整 → 可晋升', gFar.eligible === true, JSON.stringify(gFar.reasons));
  check('G1b 同一时间窗（间隔 1min）→ 不得晋升', gNear.eligible === false && gNear.reasons.some((r) => r.indexOf('时间窗') >= 0),
    JSON.stringify(gNear.reasons));
  check('G1c 同一会话（profile 相同）→ 不得晋升', gSession.eligible === false, JSON.stringify(gSession.reasons));
  check('G1d 同一 execution 内两次 → 不得晋升', gExec.eligible === false, JSON.stringify(gExec.reasons));
  check('G1e 证据链不完整 → 不得晋升', gNoEv.eligible === false, JSON.stringify(gNoEv.reasons));
  check('G1f 契约观察次数 < 2 → 不得晋升', gFewObs.eligible === false, JSON.stringify(gFewObs.reasons));
  check('G1g 已 ACTIVE 的记录不得重复走晋升', lifecycle.promotionGate({
    skill: { status: 'ACTIVE', samples: { success: 9, failed: 0 } }, evidenceComplete: true, contractObservations: 9, runs: far,
  }).eligible === false);
}

// ── 陈旧判定（S1–S5，区分结构与偶发）────────────────────────────────────────
{
  const skill = { lifecycle: { lastSuccessAt: Date.now() - 10 * 24 * 3600 * 1000 } };
  check('ST1a 1 次契约违反 → 立即 STALE（结构性信号）',
    lifecycle.staleDecision(skill, { contractViolations: 1 }).stale === true);
  check('ST1b 1 次瞬时失败 → 不降级',
    lifecycle.staleDecision(skill, { consecutiveFailures: 1 }).stale === false);
  check('ST1c 连续 2 次失败 → STALE', lifecycle.staleDecision(skill, { consecutiveFailures: 2 }).stale === true);
  check('ST1d 挑战页 → STALE 且原因可区分',
    lifecycle.staleDecision(skill, { challenge: true }).reasons.includes('SECURITY_CHALLENGE'));
  check('ST1e 站点风险 high → STALE', lifecycle.staleDecision(skill, { siteRiskLevel: 'high' }).stale === true);
  const old = { lifecycle: { lastSuccessAt: Date.now() - 60 * 24 * 3600 * 1000 } };
  check('ST1f 60 天空闲但站点无失败 → 不降级（纯时间衰减是假信号）',
    lifecycle.staleDecision(old, { siteHasRecentFailures: false }).stale === false);
  check('ST1g 60 天空闲 + 站点近期有失败 → STALE',
    lifecycle.staleDecision(old, { siteHasRecentFailures: true }).reasons.includes('IDLE_WITH_SITE_FAILURES'));
}

// ── 授权阻断不影响 Skill 状态（§6.5 末条）──────────────────────────────────
{
  check('A1 授权阻断不改变 Skill 状态（防「为过闸而弱化 Skill」的激励）',
    lifecycle.AUTHORIZATION_BLOCK_AFFECTS_STATUS === false);
}

// ── fail-open：任何异常都不得冒泡 ──────────────────────────────────────────
{
  let threw = false; let r1 = null; let r2 = null;
  try { r1 = builder.observe(null); } catch (e) { threw = true; }
  try { r2 = builder.observe({ id: 't_x', targetUrl: 'about:blank' }); } catch (e) { threw = true; }
  check('F1 observe(null) 不抛错且返回 ok:false', threw === false && r1 && r1.ok === false, r1 && r1.reason);
  check('F2 targetUrl 不可解析 → ORIGIN_ANCHOR_UNRESOLVABLE（不臆造）',
    r2 && r2.ok === false && r2.reason === 'ORIGIN_ANCHOR_UNRESOLVABLE', r2 && r2.reason);
}

// ── T24 Profile 隔离：真实数据目录未被写入 ────────────────────────────────
{
  check('T24a 已启用隔离数据目录', store.read('aiSkill', []).length > 0 && TMP_DIR.indexOf('c109_skill_') >= 0);
  check('T24b 隔离目录内确实落盘 aiSkill.json', fs.existsSync(path.join(TMP_DIR, 'aiSkill.json')));
  const realAfter = fs.existsSync(realSkillFile) ? fs.statSync(realSkillFile).mtimeMs : null;
  check('T24c 真实数据目录未被写入', realBefore === realAfter, 'before=' + realBefore + ' after=' + realAfter);
}

// ── 接线静态断言：taskManager.complete 的 fail-open 观察点 ──────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'taskManager.js'), 'utf8');
  const iFlow = src.indexOf('flowMemory.recordFlowFromTask(task)');
  const iSkill = src.indexOf("require('./skill/skillBuilder').observe(task)");
  check('X1 complete() 中已接 line skillBuilder.observe', iSkill > 0, 'at=' + iSkill);
  check('X2 与 flowMemory 并列消费（Skill 不替换 Flow，§7.4）', iFlow > 0 && iSkill > iFlow, 'flow=' + iFlow + ' skill=' + iSkill);
  const around = src.slice(Math.max(0, iSkill - 600), iSkill + 200);
  check('X3 观察点处于 try/catch 之内（fail-open，不影响任务结果）',
    around.indexOf('try {') >= 0 && around.indexOf('catch') >= 0);
}

// ── flowSchema 死护栏修正的回归守卫（顺带取证）─────────────────────────────
{
  const flowSchema = require('../agent/intelligence/flowSchema');
  const bad = flowSchema.validateFlow({ goal: 'x', states: [{ id: 'a', name: 'document.querySelector("#x")', next: 'DONE' }] });
  check('Y1 flowSchema 的 document.querySelector 护栏已不再恒真失效', bad.ok === false, JSON.stringify(bad.errors));
  const good = flowSchema.validateFlow({ goal: 'x', states: [{ id: 'a', name: '普通状态', next: 'DONE' }] });
  check('Y2 flowSchema 对合法 flow 仍放行（修正为纯收紧）', good.ok === true, JSON.stringify(good.errors));
}

// ── CH：证据链引用完整性（防悬挂引用）──────────────────────────────────────
// 背景（2026-09-11 核实的工作区既有修复，本次为其补守护断言）：
//   aiSkillEvidence 水位 3000 → 最老 1/3 被归档移出主文件。此后 persist 在
//   「existing 命中但 store.find(旧链) 返回 null」时会退回本次新链 ——
//   若不把 skill.evidenceChainRef 重指，Skill 记录就指向一条**解析不到的链**，
//   任何证据链消费者（如 17-D Router）都会 find 恒 null。
//   取证：当前真实数据 16 skill / 16 chain、悬挂 0 条 —— 缺陷真实但需达水位才触发。
//   行为中性验证：旧链存在时 useChain === prev，重指后 ref 值不变。
{
  const p1 = builder.observe(TASK);
  const rec1 = p1.ok ? store.find('aiSkill', p1.skillId) : null;
  check('CH0 基线：Skill 的 evidenceChainRef 可解析',
    !!rec1 && !!store.find('aiSkillEvidence', rec1.evidenceChainRef),
    rec1 ? 'ref=' + rec1.evidenceChainRef : 'no skill');

  if (rec1) {
    // 构造失联引用（模拟归档截尾后的状态）
    store.upsert('aiSkill', Object.assign({}, rec1, { evidenceChainRef: 'chain_archived_gone' }));
    check('CH1 前置条件成立：引用已失联',
      store.find('aiSkill', rec1.id).evidenceChainRef === 'chain_archived_gone');

    // 第二次观察：同 skillKey → existing 命中，且旧链解析不到
    const T1B = T1 + '_b';
    const task2 = Object.assign({}, TASK, { id: T1B, currentExecutionId: 'exe_c109_2' });
    const steps2 = STEPS.map((s) => Object.assign({}, s, { taskId: T1B }));
    const atts2 = ATTEMPTS.map((a) => Object.assign({}, a, { taskId: T1B }));
    const b2 = builder.build({ task: task2, steps: steps2, attempts: atts2 });
    const p2 = b2.ok ? builder.persist(b2.candidate, b2.chain, task2) : { ok: false, reason: b2.reason };
    const rec2 = p2.ok ? store.find('aiSkill', p2.skillId) : null;

    check('CH2 旧链失联时 persist 仍成功（不因证据链缺口整体失败）', !!(p2 && p2.ok), String(p2 && p2.reason));
    check('CH3 evidenceChainRef 已重指，不再悬挂', !!rec2 && rec2.evidenceChainRef !== 'chain_archived_gone',
      rec2 ? 'ref=' + rec2.evidenceChainRef : 'no skill');
    check('CH4 重指目标必须可在集合中解析', !!rec2 && !!store.find('aiSkillEvidence', rec2.evidenceChainRef));
  }
}

console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
