'use strict';
/**
 * C113 —— PHASE 17-E SkillExecutor / Handover / Lifecycle 守护套件（零浏览器、零 LLM）。
 *
 * 目标（用户 §26）：**不是堆数量，而是让 17-E 的每一个不变量都有一个明确的守护断言。**
 *   A Executor contract  B MATCH execution  C MISMATCH handover  D INDETERMINATE handover
 *   E State drift        F Handover once    G Lifecycle            H Promotion independence
 *   I STALE·REVALIDATING J Credential Auth   K Verification authority
 *   L No-selector persistence                M Evidence chain      N No execution bypass
 *
 * 三条硬纪律（与 17-A/17-C/17-D 同一口径）：
 *   ① 断言「真正会执行的那份东西」：动作由**真实** buildActionFromStep 产出，状态判定由
 *      **真实** router.contractVerdict 产出，测试不重实现任何被守护逻辑。
 *   ② 静态断言一律 stripComments 后扫描；**测试自身的拒绝清单允许出现这些词**
 *      （不重复制造 17-D S1/S2 式假阳性）。
 *   ③ 隔离：require 业务模块前把 FPB_DATA_DIR 指向临时目录，并断言真实数据目录零污染。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = path.join(os.tmpdir(), 'c113_skill_executor_' + Date.now());
process.env.FPB_DATA_DIR = TMP_DIR;
process.env.AI_PROVIDER = 'mock';
const REAL_DATA_DIR = path.join(__dirname, '..', 'data');
const REAL_FILES = ['aiSkill.json', 'aiSkillExecutions.json', 'aiSkillEvidence.json', 'aiSkillRuns.json', 'aiSkillHistory.json'];
const realBefore = {};
for (const f of REAL_FILES) {
  const p = path.join(REAL_DATA_DIR, f);
  realBefore[f] = fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
}

const store = require('../agent/storage');
const builder = require('../agent/skill/skillBuilder');
const router = require('../agent/skill/skillRouter');
const lifecycle = require('../agent/skill/skillLifecycle');
const evmod = require('../agent/skill/skillEvidence');
const x = require('../agent/skill/skillExecutor');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}

// ── 源码读取（静态断言用）────────────────────────────────────────────────────
const SRC = {};
const AGENT_DIR = path.join(__dirname, '..', 'agent');
for (const rel of ['skill/skillExecutor.js', 'skill/skillBuilder.js', 'skill/skillRouter.js',
  'skill/skillSchema.js', 'skill/skillLifecycle.js', 'skill/skillEvidence.js', 'runtime.js', 'taskManager.js']) {
  SRC[rel] = fs.readFileSync(path.join(AGENT_DIR, rel), 'utf8');
}
function stripComments(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// ── fixture：用**真实 Builder** 造一个 17-C 形状的 Skill（不是手搓结构）─────────
const ORIGIN = 'https://shop.example.test/search';
const TASK_ID = 'tsk_c113_a';

function mkTask(id, execId, url) {
  return {
    id: id, targetUrl: url || ORIGIN, objective: '搜索商品', planGoal: 'search products',
    profileId: 'p_c113', currentExecutionId: execId || 'exec_A',
  };
}

function mkSteps(taskId) {
  return [
    {
      id: taskId + '_s1', taskId: taskId, type: 'ACT', description: '点击搜索按钮',
      expectedOutcome: '', status: 'SUCCESS', risk: 'MEDIUM',
      action: {
        type: 'click',
        target: { field: 'q', semantic: 'search', role: 'button' },
        verification: { type: 'element_present', expect: 'q', target: { field: 'q' } },
        risk: 'MEDIUM',
      },
    },
    {
      id: taskId + '_s2', taskId: taskId, type: 'ACT', description: '点击结果项',
      expectedOutcome: '', status: 'SUCCESS', risk: 'MEDIUM',
      action: {
        type: 'click',
        target: { field: 'results', semantic: 'results', role: 'button' },
        verification: { type: 'text_present', expect: '搜索结果' },
        risk: 'MEDIUM',
      },
    },
  ];
}

// 造一个真实 CANDIDATE（走 builder.build + persist 全链），再按需提升为 ACTIVE。
function makeRealSkill(taskId, url) {
  const task = mkTask(taskId, 'exec_build', url);
  const r = builder.build({ task: task, steps: mkSteps(taskId), attempts: [] });
  if (!r.ok) throw new Error('fixture build 失败: ' + r.reason);
  return { task: task, built: r };
}

const fx = makeRealSkill(TASK_ID);
const persistRes = builder.persist(fx.built.candidate, fx.built.chain, fx.task);
check('FX0 真实 builder 产出可落库的 CANDIDATE', persistRes.ok === true, JSON.stringify(persistRes.reason || persistRes.skillId));

// 结构惰性锚点：新产出的 Skill 恒为 CANDIDATE（否则 17-E 的门禁不成立）
const builtSkill = store.find(builder.SKILL_COLLECTION, persistRes.skillId);
check('FX1 builder 恒产 CANDIDATE（结构性惰性的根据）', builtSkill && builtSkill.status === 'CANDIDATE', String(builtSkill && builtSkill.status));
check('FX2 状态机形状：LANDING(SOFT) + 2 个 REQUIRED 状态 + CONFIRMED',
  builtSkill.states.length === 4
  && builtSkill.states[0].stateContract.observable.every((c) => c.weight === 'SOFT')
  && builtSkill.states[1].stateContract.observable[0].weight === 'REQUIRED'
  && builtSkill.states[3].id === 'CONFIRMED',
  JSON.stringify(builtSkill.states.map((s) => s.id)));

// 提升为 ACTIVE（17-E 的执行前提）。
// ★ 独立性fixture必须**自洽**：给 2 条真·独立 run（不同 execution / 不同会话 / 时间差 >10min），
//   这样 confidence 由 17-C 公式算出即为 1.0 —— 后续任何一次合法的重算都不会把它打到阈值以下，
//   否则「夹具自身不满足它声称满足的公式」会制造假红。
const FAR0 = 20 * 60 * 1000;
const NOW0 = Date.now();
store.insert(builder.RUNS_COLLECTION, { id: 'srun_fx1', skillId: persistRes.skillId, taskId: TASK_ID, executionId: 'exec_FX1', sessionId: 'sess:FX1', ok: true, at: NOW0 - FAR0 * 2 });
store.insert(builder.RUNS_COLLECTION, { id: 'srun_fx2', skillId: persistRes.skillId, taskId: TASK_ID, executionId: 'exec_FX2', sessionId: 'sess:FX2', ok: true, at: NOW0 - FAR0 });
const fxRuns = store.findWhere(builder.RUNS_COLLECTION, (r) => r && r.skillId === persistRes.skillId && r.ok);
const fxInd = lifecycle.independentSuccesses(fxRuns);
const fxConf = lifecycle.skillConfidence({ independentSuccesses: fxInd.count, distinctSessions: fxInd.distinctSessions, failed: 0 });
const ACTIVE_SKILL = Object.assign({}, builtSkill, {
  status: 'ACTIVE',
  confidence: fxConf,
  replays: fxInd.count,
  distinctSessions: fxInd.distinctSessions,
  lifecycle: Object.assign({}, builtSkill.lifecycle, { lastSuccessAt: Date.now(), promotedAt: Date.now() }),
});
store.upsert(builder.SKILL_COLLECTION, ACTIVE_SKILL);
check('FX3 ACTIVE 夹具自洽：独立性 ≥2 且 confidence ≥ 0.85（阈值原样）',
  fxInd.count >= 2 && fxInd.distinctSessions >= 2 && fxConf >= 0.85,
  JSON.stringify({ count: fxInd.count, sess: fxInd.distinctSessions, conf: fxConf }));

// 夹具复位（组间隔离）：状态机/生命周期的真实行为由 G / I / K7 单独守护，
// 其余各组按需在**干净的 ACTIVE 夹具**上运行 —— 避免前组的（正确）状态推进污染后组断言。
const ACTIVE_SNAPSHOT = JSON.parse(JSON.stringify(ACTIVE_SKILL));
function restoreActive() {
  store.upsert(builder.SKILL_COLLECTION, JSON.parse(JSON.stringify(ACTIVE_SNAPSHOT)));
  return currentSkill();
}

function obs(o) {
  return Object.assign({
    url: ORIGIN, loadingState: 'idle', elements: [{ name: 'q', visible: true }], textSummary: '', capturedAt: Date.now(),
  }, o || {});
}
// ★ 复位必须回到**完整的** ACTIVE 快照：前组的正确推进会把 confidence 打下来
//   （K6 的一次 STATE_MISMATCH 使 failed=1 → 2/3 = 0.667 < 0.85），若只复位 status
//   而留下被正确磨损的 confidence，后组的 HOLD 就不是被测行为而是夹具残留。
function reloadActive(over) {
  const base = Object.assign({}, JSON.parse(JSON.stringify(ACTIVE_SNAPSHOT)), over || {});
  store.upsert(builder.SKILL_COLLECTION, base);
  return base;
}
function currentSkill() { return store.find(builder.SKILL_COLLECTION, ACTIVE_SKILL.id); }
function execRows() { return store.read(x.COLLECTION, []) || []; }
function execOf(taskId, execId) {
  return execRows().find((r) => r && r.taskId === taskId
    && String(r.executionId == null ? '' : r.executionId) === String(execId == null ? '' : execId)) || null;
}
// 伪运行时：只做「语义动作 → 观察结果」的确定性映射，**不做任何浏览器动作**。
function fakeRunner(script) {
  const calls = [];
  return {
    calls: calls,
    run: function (action) {
      calls.push(action);
      const s = script.shift() || { ok: false, error: { code: 'NO_SCRIPT' } };
      return s;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// A — Executor contract（E1）
// ══════════════════════════════════════════════════════════════════════════
check('A1a 导出面含 openSession / onTaskTerminal / applyLifecycleOutcome',
  typeof x.openSession === 'function' && typeof x.onTaskTerminal === 'function' && typeof x.applyLifecycleOutcome === 'function', '');
check('A1b 导出面含进阶判定纯函数（planSequence / buildActionFromStep / validateStateContract / classifyStepResult）',
  typeof x.planSequence === 'function' && typeof x.buildActionFromStep === 'function'
  && typeof x.validateStateContract === 'function' && typeof x.classifyStepResult === 'function', '');

const SEQ = x.planSequence(ACTIVE_SKILL);
check('A2 planSequence 产出 2 步且指向 CONFIRMED 前的状态',
  SEQ.steps.length === 2 && SEQ.entryStateId === 'LANDING'
  && SEQ.steps[0].from === 'LANDING' && SEQ.steps[1].from === SEQ.steps[0].to,
  JSON.stringify(SEQ.steps.map((s) => [s.stepId, s.from, s.to, s.actionType])));

// §9 指定的 11 条原因必须逐条存在于受控词表
const REQ9 = ['PRECHECK_MISMATCH', 'PRECHECK_INDETERMINATE', 'STATE_MISMATCH', 'TARGET_NOT_GROUNDED',
  'TARGET_AMBIGUOUS', 'ACTION_PRECONDITION_FAILED', 'POST_ACTION_STATE_MISMATCH', 'SKILL_STEP_FAILED',
  'SKILL_STALE', 'AUTHORIZATION_BLOCKED', 'VERIFICATION_MISMATCH'];
const missing9 = REQ9.filter((r) => x.HANDOVER_REASONS[r] !== r);
check('A3 §9 的 11 条结构化 handover 原因逐条在册', missing9.length === 0, missing9.join(','));

// 禁止占位式原因
const reasonBlob = JSON.stringify(x.HANDOVER_REASONS).toLowerCase();
check('A4 不存在占位式原因（something went wrong / skill failed / unknown error）',
  !/something went wrong|skill failed|unknown error/.test(reasonBlob), '');

// §7：导出面不得出现任何成功裁决字段
const exeSrc = SRC['skill/skillExecutor.js'];
const exeCode = stripComments(exeSrc);
check('A5 executor 可执行体不含裁决型成功断言（success:true / verified / businessSuccess）',
  !/"success"\s*:\s*true/.test(exeCode) && !/["']?verified["']?\s*:/.test(exeCode)
  && !/businessSuccess/.test(exeCode), '');
check('A6 executor 无 success 判定 API（无 declareSuccess / markSuccess / setSuccess）',
  !/declareSuccess|markSuccess|setSuccess|reportSuccess/.test(exeCode), '');

// 七步契约在源码中被显式标注（防「契约只存在于文档」）
const hasStep = (n, kw) => new RegExp('\\b' + n + '\\b[^\\n]*' + kw).test(exeSrc) || new RegExp(kw + '[^\\n]*\\b' + n + '\\b').test(exeSrc);
check('A7 七步契约在源码中逐条可定位（1 ROUTE ~ 7 FINAL_VERIFICATION）',
  hasStep(1, 'ROUTE') && hasStep(2, 'PRECHECK') && hasStep(3, 'EXECUTE') && hasStep(4, 'OBSERVE')
  && hasStep(5, 'VERIFY_STATE') && hasStep(6, 'HANDOVER') && hasStep(7, 'FINAL_VERIFICATION'), '');

// ══════════════════════════════════════════════════════════════════════════
// B — MATCH execution（E2）
// ══════════════════════════════════════════════════════════════════════════
const bTask = mkTask('tsk_c113_b', 'exec_B');
const pre = x.eligible(bTask);
check('B1 0 级预闸：存在 ACTIVE 候选（纯元数据，零浏览器）', pre.any === true, JSON.stringify(pre));

const bOpen = x.openSession({ task: bTask, observation: obs() });
check('B2 openSession 接管成功（decision=SKILL ∧ prestate=MATCH）',
  bOpen.taken === true && bOpen.mode === x.RUN_MODE.TAKEOVER && !!bOpen.session, JSON.stringify(bOpen.reason));
const bSess = bOpen.session;

const bRun = fakeRunner([
  { ok: true, observation: obs({ textSummary: '' }) },
  { ok: true, observation: obs({ textSummary: '搜索结果 耳机' }) },
]);
const d1 = bSess.beforeStep({ stepId: 'g1', observation: obs(), genericAction: { type: 'click' } });
check('B3 步 1 接管且产出语义动作（type=click，无定位符）',
  d1.takeover === true && d1.action.type === 'click'
  && d1.action.target.field === 'q' && d1.action.target.selector === undefined
  && d1.action.target.xpath === undefined && d1.action.target.index === undefined,
  JSON.stringify(d1.action));
const r1 = bRun.run(d1.action);
const a1 = bSess.afterStep({ stepId: 'g1', result: r1, observation: r1.observation });
check('B4 步 1 动作后状态契约 MATCH → 继续', a1.continued === true && a1.handover === false, JSON.stringify(a1));

const d2 = bSess.beforeStep({ stepId: 'g2', observation: obs(), genericAction: { type: 'click' } });
check('B5 步 2 重新 Observe 后再接管（cursor 已前移，契约取自上一步 to 状态）',
  d2.takeover === true && d2.action.target.field === 'results', JSON.stringify(d2.action));
const r2 = bRun.run(d2.action);
const a2 = bSess.afterStep({ stepId: 'g2', result: r2, observation: r2.observation });
check('B6 路径走完 → PATH_COMPLETED（不是成功裁决）',
  a2.completed === true && bSess.read().sessionOutcome === x.SESSION_OUTCOME.PATH_COMPLETED, JSON.stringify(bSess.read().sessionOutcome));

const bState = bSess.read();
check('B7 两步均为 STEP_COMPLETED，且**没有任何** success 字段',
  bState.steps.length === 2 && bState.steps.every((s) => s.stepOutcome === x.STEP_OUTCOME.STEP_COMPLETED)
  && !/success|verified/i.test(JSON.stringify(bState.steps)), JSON.stringify(bState.steps));
check('B8 动作经 buildActionFromStep 产出（真实语义动作，值只以 credentialRef 引用）',
  bRun.calls.length === 2 && bRun.calls.every((a) => typeof a.type === 'string' && a.value === undefined), '');
bSess.finish();
// 延迟确认（17-B 纪律）：Skill 路线走完**不等于**成功 —— 只有既有口径判成功后才结算。
const bTerm = x.onTaskTerminal(bTask, 'SUCCESS');
const bRecAfter = execOf('tsk_c113_b', 'exec_B');
check('B9 既有口径判成功后延迟确认给分（PATH_COMPLETED + SUCCESS → VERIFIED_SUCCESS）',
  bTerm.ok === true && !!bRecAfter && bRecAfter.outcome === lifecycle.OUTCOME.VERIFIED_SUCCESS
  && bRecAfter.terminal === 'SUCCESS', JSON.stringify(bRecAfter && { o: bRecAfter.outcome, t: bRecAfter.terminal }));

// ══════════════════════════════════════════════════════════════════════════
// C — MISMATCH handover（E3）
// ══════════════════════════════════════════════════════════════════════════
const cTask = mkTask('tsk_c113_c', 'exec_C');
const cSess = x.openSession({ task: cTask, observation: obs({ elements: [{ name: 'keyword', visible: true }] }) });
check('C1 precheck=MISMATCH → **不进入** Skill（HOLD + PRECHECK_MISMATCH）',
  cSess.taken === false && cSess.reason === x.HANDOVER_REASONS.PRECHECK_MISMATCH, JSON.stringify(cSess.reason));
check('C2 MISMATCH 路径下 session 不存在 → SkillExecutor 未执行任何动作',
  cSess.session === null, '');
check('C3 MISMATCH 不产生 Skill 失败记录（无 execution 记录 / 不记任何失败）',
  execOf('tsk_c113_c', 'exec_C') === null, JSON.stringify(execOf('tsk_c113_c', 'exec_C')));
const cSkillAfter = currentSkill();
check('C4 MISMATCH 不磨损 Skill 状态与置信度',
  cSkillAfter.status === 'ACTIVE' && cSkillAfter.confidence === ACTIVE_SKILL.confidence, JSON.stringify({ s: cSkillAfter.status, c: cSkillAfter.confidence }));

// ══════════════════════════════════════════════════════════════════════════
// D — INDETERMINATE handover（E4）★与 17-D §9.2 完全一致：不记 Skill 失败
// ══════════════════════════════════════════════════════════════════════════
const dTask = mkTask('tsk_c113_d', 'exec_D');
const dEmpty = x.openSession({ task: dTask, observation: obs({ elements: [] }) });
check('D1 元素池为空（空集 ≠ 不存在）→ HOLD + PRECHECK_INDETERMINATE',
  dEmpty.taken === false && dEmpty.reason === x.HANDOVER_REASONS.PRECHECK_INDETERMINATE, JSON.stringify(dEmpty.reason));
const dLoad = x.openSession({ task: mkTask('tsk_c113_d2', 'exec_D2'), observation: obs({ loadingState: 'loading' }) });
check('D2 页面仍在导航 → HOLD + PRECHECK_INDETERMINATE',
  dLoad.taken === false && dLoad.reason === x.HANDOVER_REASONS.PRECHECK_INDETERMINATE, JSON.stringify(dLoad.reason));
const dNoUrl = x.openSession({ task: mkTask('tsk_c113_d3', 'exec_D3'), observation: obs({ url: '' }) });
check('D3 origin/URL 不可解析 → HOLD + PRECHECK_INDETERMINATE',
  dNoUrl.taken === false && dNoUrl.reason === x.HANDOVER_REASONS.PRECHECK_INDETERMINATE, JSON.stringify(dNoUrl.reason));
check('D4 INDETERMINATE 全程零 Skill 失败记录',
  execOf('tsk_c113_d', 'exec_D') === null && execOf('tsk_c113_d2', 'exec_D2') === null && execOf('tsk_c113_d3', 'exec_D3') === null, '');
const dSkill = currentSkill();
check('D5 INDETERMINATE 不改变状态 / 不累计契约违反 / 不磨损 confidence',
  dSkill.status === 'ACTIVE'
  && Number(dSkill.lifecycle.contractViolations || 0) === 0
  && dSkill.confidence === ACTIVE_SKILL.confidence,
  JSON.stringify({ c: dSkill.confidence, cv: dSkill.lifecycle.contractViolations }));

// ══════════════════════════════════════════════════════════════════════════
// E — State drift（E5）★C105 stale selector / reload 死循环的核心修复纪律
// ══════════════════════════════════════════════════════════════════════════
const eTask = mkTask('tsk_c113_e', 'exec_E');
const eOpen = x.openSession({ task: eTask, observation: obs() });
const eSess = eOpen.session;
const eRun = fakeRunner([
  // 动作成功，但页面已漂移：input 变成了没有 'q' 语义的 textarea
  { ok: true, observation: obs({ elements: [{ tag: 'textarea', name: 'message', visible: true }] }) },
]);
const ed1 = eSess.beforeStep({ stepId: 'g1', observation: obs(), genericAction: { type: 'click' } });
check('E0 漂移前仍正常接管', ed1.takeover === true, JSON.stringify(ed1.reason));
const er1 = eRun.run(ed1.action);
const ea1 = eSess.afterStep({ stepId: 'g1', result: er1, observation: er1.observation });
check('E1 动作后状态漂移 → POST_ACTION_STATE_MISMATCH → HANDOVER',
  ea1.handover === true && ea1.reason === x.HANDOVER_REASONS.POST_ACTION_STATE_MISMATCH, JSON.stringify(ea1.reason));
check('E2 漂移后**不再接管**（session 已终结，beforeStep 不允许继续执行旧 Skill step）',
  eSess.beforeStep({ stepId: 'g2', observation: obs() }).takeover === false, '');
check('E3 旧 Skill step 未被继续执行（只执行了漂移前的那一次动作）', eRun.calls.length === 1, String(eRun.calls.length));
const eRec = execOf('tsk_c113_e', 'exec_E');
check('E4 handover 记录结构化且可审计（reason/stepIndex/lastSuccessfulStep/currentObservationRef）',
  !!eRec && !!eRec.handover
  && eRec.handover.handoverReason === x.HANDOVER_REASONS.POST_ACTION_STATE_MISMATCH
  && eRec.handover.stepIndex === 0
  && eRec.handover.currentObservationRef != null
  && eRec.handover.lastSuccessfulStep === null,
  JSON.stringify(eRec && eRec.handover));
check('E5 漂移被归类为结构性信号 STATE_MISMATCH（唯一会推动 ACTIVE→REVALIDATING 的信号）',
  eRec.outcome === lifecycle.OUTCOME.STATE_MISMATCH, String(eRec.outcome));
eSess.finish();

// ══════════════════════════════════════════════════════════════════════════
// F — Handover once（E6）★禁止 Skill → Generic → Skill 无限循环
// ══════════════════════════════════════════════════════════════════════════
check('F1 handoverCount === 1（一次性，不可循环）', eRec.handoverCount === 1, String(eRec.handoverCount));
const fAgain = x.openSession({ task: eTask, observation: obs() });
check('F2 同一 (task, execution) 再次尝试接管 → HOLD + HANDOVER_ONCE',
  fAgain.taken === false && fAgain.reason === x.HANDOVER_REASONS.HANDOVER_ONCE, JSON.stringify(fAgain.reason));
const fNewExec = x.openSession({ task: mkTask('tsk_c113_e', 'exec_E2'), observation: obs() });
check('F3 新 execution 不受旧 execution 的一次性闸影响（闸按 execution 隔离）',
  fNewExec.taken === true, JSON.stringify(fNewExec.reason));
if (fNewExec.session) fNewExec.session.finish();
const fReuse = x.openSession({ task: mkTask('tsk_c113_b', 'exec_B'), observation: obs() });
check('F4 已接管过的 execution 不重复接管（skillExecutionCount ≤ 1）',
  fReuse.taken === false && fReuse.reason === x.HANDOVER_REASONS.EXECUTION_ALREADY_ATTEMPTED, JSON.stringify(fReuse.reason));

// ══════════════════════════════════════════════════════════════════════════
// G — Lifecycle 状态机（E8）
// ══════════════════════════════════════════════════════════════════════════
check('G1 迁移表与 §12 一致（CANDIDATE→ACTIVE→REVALIDATING→STALE→DEPRECATED；ARCHIVED 终态）',
  JSON.stringify(lifecycle.LIFECYCLE_TRANSITIONS.CANDIDATE) === JSON.stringify(['ACTIVE'])
  && lifecycle.LIFECYCLE_TRANSITIONS.ACTIVE.includes('REVALIDATING')
  && lifecycle.LIFECYCLE_TRANSITIONS.REVALIDATING.includes('ACTIVE')
  && lifecycle.LIFECYCLE_TRANSITIONS.REVALIDATING.includes('STALE')
  && JSON.stringify(lifecycle.LIFECYCLE_TRANSITIONS.STALE) === JSON.stringify(['DEPRECATED'])
  && lifecycle.LIFECYCLE_TRANSITIONS.DEPRECATED.length === 0,
  JSON.stringify(lifecycle.LIFECYCLE_TRANSITIONS));

const candSkill = { id: 'skill_c113_cand', status: 'CANDIDATE', samples: { success: 1, failed: 0 }, lifecycle: {} };
const g1 = lifecycle.nextStatus({ skill: candSkill, outcome: lifecycle.OUTCOME.VERIFIED_SUCCESS, runs: [], evidenceComplete: true, contractObservations: 2 });
check('G2 CANDIDATE + 1 次成功 → 仍 CANDIDATE，理由含 NOT_INDEPENDENT（§13）',
  g1.to === 'CANDIDATE' && g1.changed === false && g1.reasons.includes('NOT_INDEPENDENT'), JSON.stringify(g1.reasons));

const activeSkill = { id: 'skill_c113_act', status: 'ACTIVE', samples: { success: 5, failed: 0 }, lifecycle: {} };
const g3 = lifecycle.nextStatus({ skill: activeSkill, outcome: lifecycle.OUTCOME.VERIFIED_SUCCESS, runs: [], evidenceComplete: true, contractObservations: 2 });
check('G3 ACTIVE + 成功 → 保持 ACTIVE', g3.to === 'ACTIVE' && g3.changed === false, JSON.stringify(g3.reasons));
const g4 = lifecycle.nextStatus({ skill: activeSkill, outcome: lifecycle.OUTCOME.VERIFIED_FAILURE, lifecycle: { consecutiveFailures: 1 } });
check('G4 ACTIVE + 单次失败 → 仍 ACTIVE（§15 不一失败就 STALE）',
  g4.to === 'ACTIVE' && g4.reasons.includes('SINGLE_FAILURE_TOLERATED'), JSON.stringify(g4.reasons));

const g5 = lifecycle.nextStatus({ skill: candSkill, outcome: lifecycle.OUTCOME.STATE_MISMATCH });
check('G5 CANDIDATE 上的契约违反不晋升（停在 CANDIDATE 并留痕）',
  g5.to === 'CANDIDATE' && g5.reasons.includes('CANDIDATE_CONTRACT_VIOLATION'), JSON.stringify(g5.reasons));
const g6 = lifecycle.nextStatus({ skill: { status: 'DEPRECATED' }, outcome: lifecycle.OUTCOME.VERIFIED_SUCCESS });
check('G6 DEPRECATED 为终态（任何结果都不再迁移）',
  g6.to === 'DEPRECATED' && g6.changed === false && g6.reasons.includes('TERMINAL_STATE'), JSON.stringify(g6.reasons));
check('G7 AUTHORIZATION_BLOCK_AFFECTS_STATUS === false 原样保留（§11）',
  lifecycle.AUTHORIZATION_BLOCK_AFFECTS_STATUS === false, '');

// ══════════════════════════════════════════════════════════════════════════
// H — Promotion gate / 独立性程序化判定（E9）
// ══════════════════════════════════════════════════════════════════════════
const NOW = Date.now();
const FAR = 20 * 60 * 1000;
const cand = { id: 'skill_c113_p', status: 'CANDIDATE', samples: { success: 2, failed: 0 }, lifecycle: {} };
// runs 构造：把每个成功的时刻**真**分散到 20min 间隔（否则 maxGapMs ≤ 10min 会正确拒绝）
function runs(rows) {
  return rows.map((r, i) => Object.assign({ ok: true, at: NOW - FAR * (rows.length - i), sessionId: 'sess:' + i }, r));
}

const h1 = lifecycle.promotionGate({
  skill: cand, evidenceComplete: true, contractObservations: 2,
  runs: runs([{ executionId: 'e1' }, { executionId: 'e1' }]),
});
check('H1 同一 execution 两次成功 → 只算 1 次独立 → 不晋升（executionId 去重）',
  h1.eligible === false && h1.evidence.independentSuccesses === 1, JSON.stringify(h1.evidence));

const h2 = lifecycle.promotionGate({
  skill: cand, evidenceComplete: true, contractObservations: 2,
  runs: runs([{ executionId: 'e1', sessionId: 'sess:X' }, { executionId: 'e2', sessionId: 'sess:X' }]),
});
check('H2 同会话两次成功 → 独立会话数不足 → 不晋升（防同会话连点两次的假独立）',
  h2.eligible === false && h2.evidence.distinctSessions === 1, JSON.stringify(h2.evidence));

const h3 = lifecycle.promotionGate({
  skill: cand, evidenceComplete: true, contractObservations: 2,
  runs: [{ ok: true, executionId: 'e1', sessionId: 's1', at: NOW }, { ok: true, executionId: 'e2', sessionId: 's2', at: NOW + 1000 }],
});
check('H3 两次成功但时间窗过近（≤10min）→ 不晋升',
  h3.eligible === false && h3.reasons.some((r) => r.indexOf('时间窗过近') >= 0), JSON.stringify(h3.reasons));

const h4 = lifecycle.promotionGate({
  skill: { id: 'p', status: 'CANDIDATE', samples: { success: 2, failed: 1 }, lifecycle: {} },
  evidenceComplete: true, contractObservations: 2,
  runs: runs([{ executionId: 'e1' }, { executionId: 'e2' }]),
});
check('H4 候选期存在失败 → 不晋升', h4.eligible === false && h4.reasons.some((r) => r.indexOf('候选期存在失败') >= 0), JSON.stringify(h4.reasons));

const h5 = lifecycle.promotionGate({ skill: cand, evidenceComplete: false, contractObservations: 2, runs: runs([{ executionId: 'e1' }, { executionId: 'e2' }]) });
check('H5 证据链不完整 → 不晋升（§11.4）', h5.eligible === false && h5.reasons.includes('证据链不完整'), JSON.stringify(h5.reasons));
const h6 = lifecycle.promotionGate({ skill: cand, evidenceComplete: true, contractObservations: 1, runs: runs([{ executionId: 'e1' }, { executionId: 'e2' }]) });
check('H6 状态契约观察次数不足 → 不晋升（§6.3）', h6.eligible === false, JSON.stringify(h6.reasons));
const h7 = lifecycle.promotionGate({ skill: cand, evidenceComplete: true, contractObservations: 2, runs: runs([{ executionId: 'e1' }, { executionId: 'e2' }]) });
check('H7 2 次真·独立成功 + 证据完整 + 契约观察 ≥2 → 晋升',
  h7.eligible === true && h7.evidence.independentSuccesses === 2 && h7.evidence.distinctSessions === 2, JSON.stringify(h7.evidence));

// ── G/H 端到端：applyLifecycleOutcome 真实落库（CANDIDATE → ACTIVE）──────────
// ★ 必须用**独立 origin**，否则 skillKey(origin|capability|intent) 与上面的人工 ACTIVE
//   夹具撞键，persist 会命中同一条记录 —— 那样测的就不是晋升而是噪声。
const PROMO_ORIGIN = 'https://promo.example.test/search';
const promoTask = mkTask('tsk_c113_promo', 'exec_P1', PROMO_ORIGIN);
const promoBuild = makeRealSkill('tsk_c113_promo', PROMO_ORIGIN);
const promoPersist = builder.persist(promoBuild.built.candidate, promoBuild.built.chain, promoBuild.task);
check('H8 晋升 fixture 落库为 CANDIDATE', promoPersist.ok === true, String(promoPersist.reason || ''));
const promoSkillId = promoPersist.skillId;
// 预置 2 条真·独立 run（不同 execution、不同会话、时间差 > 10min）
store.insert(builder.RUNS_COLLECTION, { id: 'srun_p1', skillId: promoSkillId, taskId: 'tsk_c113_promo', executionId: 'exec_P0', sessionId: 'sess:PX', ok: true, at: NOW - FAR });
store.insert(builder.RUNS_COLLECTION, { id: 'srun_p2', skillId: promoSkillId, taskId: 'tsk_c113_promo', executionId: 'exec_PZ', sessionId: 'sess:PY', ok: true, at: NOW });
store.upsert(builder.SKILL_COLLECTION, Object.assign(store.find(builder.SKILL_COLLECTION, promoSkillId), {
  stats: Object.assign({}, store.find(builder.SKILL_COLLECTION, promoSkillId).stats, { evidenceComplete: true, contractObservations: 2 }),
}));
const promoRes = x.applyLifecycleOutcome({ skillId: promoSkillId, task: promoTask, executionId: 'exec_P3', outcome: lifecycle.OUTCOME.VERIFIED_SUCCESS });
check('H9 applyLifecycleOutcome：CANDIDATE → ACTIVE（唯一合法晋升路径）',
  promoRes.ok === true && promoRes.statusFrom === 'CANDIDATE' && promoRes.statusTo === 'ACTIVE' && promoRes.changed === true,
  JSON.stringify(promoRes));
check('H10 晋升写版本快照（aiSkillHistory，可回溯）',
  (store.read(builder.HISTORY_COLLECTION, []) || []).some((h) => h && h.skillId === promoSkillId && h.statusTo === 'ACTIVE'), '');
check('H11 晋升靠的是**真·独立成功**，且 confidence 走 17-C 公式（阈值 0.85 未改）',
  promoRes.confidence >= 0.85, String(promoRes.confidence));

// ══════════════════════════════════════════════════════════════════════════
// I — STALE / REVALIDATING（E10）
// ══════════════════════════════════════════════════════════════════════════
const iAct = { id: 'skill_i', status: 'ACTIVE', samples: { success: 8, failed: 0 }, lifecycle: {} };
const i1 = lifecycle.nextStatus({ skill: iAct, outcome: lifecycle.OUTCOME.STATE_MISMATCH, lifecycle: { contractViolations: 1, consecutiveFailures: 1 } });
check('I1 ACTIVE + 契约违反 → REVALIDATING（**不是** STALE；STALE.CONTRACT_VIOLATION=1 只触发漂移处理）',
  i1.to === 'REVALIDATING' && i1.reasons.includes('EVIDENCE_DRIFT:CONTRACT_VIOLATION'), JSON.stringify(i1.reasons));
const i2 = lifecycle.nextStatus({ skill: Object.assign({}, iAct, { status: 'REVALIDATING' }), outcome: lifecycle.OUTCOME.VERIFIED_SUCCESS, lifecycle: { revalidateSuccesses: 1 } });
check('I2 REVALIDATING + 验证成功 → 恢复 ACTIVE', i2.to === 'ACTIVE' && i2.changed === true, JSON.stringify(i2.reasons));
const i3 = lifecycle.nextStatus({ skill: Object.assign({}, iAct, { status: 'REVALIDATING' }), outcome: lifecycle.OUTCOME.VERIFIED_FAILURE, lifecycle: { revalidateFailures: 2, consecutiveFailures: 2 } });
check('I3 REVALIDATING + 重复失败（≥2）→ STALE', i3.to === 'STALE' && i3.reasons.includes('UNSATISFIABLE_CONTRACT'), JSON.stringify(i3.reasons));
const i4 = lifecycle.nextStatus({ skill: Object.assign({}, iAct, { status: 'REVALIDATING' }), outcome: lifecycle.OUTCOME.VERIFIED_FAILURE, lifecycle: { revalidateFailures: 1, consecutiveFailures: 1 } });
check('I4 REVALIDATING + 单次失败 → 仍 REVALIDATING（§15）', i4.to === 'REVALIDATING', JSON.stringify(i4.reasons));

// 非磨损清单：计数与状态都不动
const wearBefore = lifecycle.advanceCounters({ skill: iAct, outcome: lifecycle.OUTCOME.INDETERMINATE });
check('I5 INDETERMINATE 的计数增量是「原样返回」（wore=false → 零磨损）',
  wearBefore.wore === false && Number(wearBefore.contractViolations || 0) === 0 && Number(wearBefore.consecutiveFailures || 0) === 0,
  JSON.stringify(wearBefore));
const wearAuth = lifecycle.advanceCounters({ skill: iAct, outcome: lifecycle.OUTCOME.AUTHORIZATION_BLOCKED });
check('I6 AUTHORIZATION_BLOCKED 的计数增量同样零磨损', wearAuth.wore === false, JSON.stringify(wearAuth));
check('I7 非磨损清单内容正确（INDETERMINATE / AUTHORIZATION_BLOCKED / NOT_ATTRIBUTABLE）',
  JSON.stringify(lifecycle.NON_WEARING_OUTCOMES.slice().sort())
  === JSON.stringify(['AUTHORIZATION_BLOCKED', 'INDETERMINATE', 'NOT_ATTRIBUTABLE']), JSON.stringify(lifecycle.NON_WEARING_OUTCOMES));

// 迁移合法性守卫（非法迁移不产生）
const i8 = lifecycle.nextStatus({ skill: { status: 'CANDIDATE', samples: { success: 0, failed: 0 } }, outcome: lifecycle.OUTCOME.VERIFIED_SUCCESS, runs: [], evidenceComplete: true, contractObservations: 2, ctx: { manual: true } });
check('I8 CANDIDATE 上的人工 STALE 不产生非法迁移（CANDIDATE→STALE 不在白名单）',
  i8.to === 'CANDIDATE' && i8.reasons.some((r) => r.indexOf('NOT_APPLICABLE') >= 0), JSON.stringify(i8.reasons));

// ══════════════════════════════════════════════════════════════════════════
// J — Credential Authorization（E11）★17-A 安全红线原样保留
// ══════════════════════════════════════════════════════════════════════════
// J1：凭据动作只能以 credentialRef 形式构造，绝不携带明文值
const fillStep = {
  actionType: 'fill', targetSemantic: { field: 'password', roleHint: 'textbox' },
  valueSource: 'CREDENTIAL_REF', credentialRef: 'vault:site_login', verification: { type: 'element_present', target: { field: 'password' } }, risk: 'HIGH',
};
const fillAction = x.buildActionFromStep(fillStep);
check('J1 凭据动作：携带 credentialRef，**不含**任何明文值',
  fillAction.credentialRef === 'vault:site_login' && fillAction.value === undefined
  && JSON.stringify(fillAction).indexOf('vault:site_login') >= 0, JSON.stringify(fillAction));

// J2：工具层安全闸拒绝 → STEP_BLOCKED + AUTHORIZATION_BLOCKED（不重试/不 repair/不 reload）
const jBlocked = x.classifyStepResult({ ok: false, error: { code: 'CREDENTIAL_ACTION_BLOCKED', message: 'x' } });
check('J2 CREDENTIAL_ACTION_BLOCKED → STEP_BLOCKED + AUTHORIZATION_BLOCKED',
  jBlocked.step === x.STEP_OUTCOME.STEP_BLOCKED && jBlocked.reason === x.HANDOVER_REASONS.AUTHORIZATION_BLOCKED,
  JSON.stringify(jBlocked));
const jOrigin = x.classifyStepResult({ ok: false, error: { code: 'ORIGIN_NOT_AUTHORIZED' } });
check('J3 外部 origin 未授权 → 同一安全分类 AUTHORIZATION_BLOCKED',
  jOrigin.reason === x.HANDOVER_REASONS.AUTHORIZATION_BLOCKED, JSON.stringify(jOrigin));

// J4：会话级——授权阻断后 Skill 状态与 confidence **完全不变**
const jTask = mkTask('tsk_c113_j', 'exec_J');
const jOpen = x.openSession({ task: jTask, observation: obs() });
check('J0 授权测试前置：接管成功', jOpen.taken === true, JSON.stringify(jOpen.reason));
const jSess = jOpen.session;
const jd = jSess.beforeStep({ stepId: 'g1', observation: obs(), genericAction: { type: 'click' } });
const jRes = jSess.afterStep({ stepId: 'g1', result: { ok: false, error: { code: 'CREDENTIAL_ACTION_BLOCKED', message: 'blocked' } } });
check('J4 授权阻断 → 立即 handover（不继续执行）',
  jRes.handover === true && jRes.reason === x.HANDOVER_REASONS.AUTHORIZATION_BLOCKED, JSON.stringify(jRes.reason));
const jRec = execOf('tsk_c113_j', 'exec_J');
check('J5 授权阻断被归类为 AUTHORIZATION_BLOCKED（不磨损）',
  !!jRec && jRec.outcome === lifecycle.OUTCOME.AUTHORIZATION_BLOCKED, String(jRec && jRec.outcome));
jSess.finish();
const jApplied = x.applyLifecycleOutcome({ skillId: ACTIVE_SKILL.id, task: jTask, executionId: 'exec_J', outcome: lifecycle.OUTCOME.AUTHORIZATION_BLOCKED });
const jSkill = currentSkill();
check('J6 授权阻断后 Skill 状态与 confidence 未变（§11：不制造「弱化安全闸」的激励）',
  jApplied.ok === true && jApplied.changed === false && jSkill.status === 'ACTIVE'
  && jSkill.confidence === ACTIVE_SKILL.confidence, JSON.stringify({ s: jSkill.status, c: jSkill.confidence }));

// J7：executor 绝不自行判定授权（无 authorizedOrigins / 域名相似判定 / 跨 origin 继承）
check('J7 executor 不自行判定授权关系（无授权 origin 白名单 / 无域名子串判定 / 无同站判定）',
  !/authorizedOrigins|allowedOrigins|whitelist/i.test(exeCode)
  && !/origin[A-Za-z]*\s*\.\s*(includes|indexOf|startsWith|endsWith)\s*\(/i.test(exeCode)
  && !/\b(host|hostname|href|url)\s*\.\s*(includes|indexOf)\s*\(/i.test(exeCode)
  && !/isSameSite/.test(exeCode) && !/endsWith\(\s*['"]\.['"]\s*\)/.test(exeCode), '');
check('J9 origin 比较一律精确相等（=== 锚点匹配，绝非字符串相似）',
  /originAnchor\s*\)\s*\|\|\s*''\s*\)\s*===\s*anchor/.test(exeCode) || /===\s*anchor/.test(exeCode), '');
check('J8 executor 不携带任何凭据明文/授权扩展字段（无 password / secret / authorizedOrigin 变量）',
  !/\bpassword\b\s*[:=]|authorizedOrigins\s*[:=]|credentialValue/.test(exeCode), '');

// ══════════════════════════════════════════════════════════════════════════
// K — Verification authority（E12）★硬 Guard：动作成功但业务验证失败 ≠ SUCCESS
// ══════════════════════════════════════════════════════════════════════════
const kTask = mkTask('tsk_c113_k', 'exec_K');
const kOpen = x.openSession({ task: kTask, observation: obs() });
const kSess = kOpen.session;
const kd = kSess.beforeStep({ stepId: 'g1', observation: obs(), genericAction: { type: 'click' } });
check('K0 动作已产出（即将执行）', kd.takeover === true, '');
const kRes = kSess.afterStep({ stepId: 'g1', result: { ok: false, error: { code: 'VERIFY_FAILED', message: 'business verification failed' } } });
check('K1 动作机械成功但业务验证失败 → STEP_FAILED + VERIFICATION_MISMATCH（绝不标成功）',
  kRes.handover === true && kRes.reason === x.HANDOVER_REASONS.VERIFICATION_MISMATCH, JSON.stringify(kRes.reason));
const kRec = execOf('tsk_c113_k', 'exec_K');
check('K2 该执行**没有任何**成功裁决（无 success 字段 / 无 PATH_COMPLETED）',
  !!kRec && kRec.sessionOutcome === x.SESSION_OUTCOME.HANDOVER
  && !/success|verified/i.test(JSON.stringify(kRec.steps)), JSON.stringify(kRec.sessionOutcome));
check('K3 分类为 VERIFIED_FAILURE（会被累计，不冒充成功）',
  kRec.outcome === lifecycle.OUTCOME.VERIFIED_FAILURE, String(kRec.outcome));
kSess.finish();

// K4：既有口径判失败 → Skill 不晋升（用**独立夹具**，避免污染 ACTIVE 夹具的置信度）
const K4_ORIGIN = 'https://k4.example.test/search';
const k4Task = mkTask('tsk_c113_k4', 'exec_K4', K4_ORIGIN);
const k4Build0 = makeRealSkill('tsk_c113_k4', K4_ORIGIN);
const k4Persist = builder.persist(k4Build0.built.candidate, k4Build0.built.chain, k4Build0.task);
const k4Applied = x.applyLifecycleOutcome({ skillId: k4Persist.skillId, task: k4Task, executionId: 'exec_K4', outcome: lifecycle.OUTCOME.VERIFIED_FAILURE });
const k4Skill = store.find(builder.SKILL_COLLECTION, k4Persist.skillId);
check('K4 既有口径判失败 → CANDIDATE 不晋升，且如实累计失败样本',
  k4Applied.ok === true && k4Applied.changed === false && k4Skill.status === 'CANDIDATE'
  && Number(k4Skill.samples.failed || 0) === 1,
  JSON.stringify({ s: k4Skill.status, f: k4Skill.samples.failed, reasons: k4Applied.reasons }));
check('K5 executor 源码不含任何成功裁决（静态硬 Guard）',
  !/"success"\s*:\s*true/.test(exeCode) && !/return\s*\{\s*ok:\s*true,\s*success/.test(exeCode), '');

// K6：`onTaskTerminal` 的延迟确认 —— handover 过的执行即使任务成功也不给成功分
const k6Task = mkTask('tsk_c113_k6', 'exec_K6');
const k6Open = x.openSession({ task: k6Task, observation: obs() });
check('K6a 归因测试前置：接管成功', k6Open.taken === true, JSON.stringify({ reason: k6Open.reason, status: currentSkill().status, conf: currentSkill().confidence }));
if (!k6Open.session) { console.log('FAIL | K6 前置失败，后续断言跳过'); fail += 1; }
const k6Sess = k6Open.session;
const k6d = k6Sess ? k6Sess.beforeStep({ stepId: 'g1', observation: obs(), genericAction: { type: 'click' } }) : null;
if (k6Sess) {
  k6Sess.afterStep({
    stepId: 'g1',
    result: { ok: true, observation: obs({ elements: [{ tag: 'textarea', name: 'message' }] }) },
    observation: obs({ elements: [{ tag: 'textarea', name: 'message' }] }),
  });
  k6Sess.finish();
}
const k6T = k6Sess ? x.onTaskTerminal(k6Task, 'SUCCESS') : { ok: false };
const k6Rec = execOf('tsk_c113_k6', 'exec_K6');
check('K6 handover 过的执行即使任务成功也**不给成功分**（归因纪律：Generic 的成功不是 Skill 的成功）',
  !!k6Rec && k6T.ok === true && k6Rec.terminal === 'SUCCESS' && k6Rec.outcome === lifecycle.OUTCOME.STATE_MISMATCH,
  JSON.stringify(k6Rec && { outcome: k6Rec.outcome, terminal: k6Rec.terminal }));

// ★ K6 的漂移结算把 ACTIVE 夹具**正确地**推进到了 REVALIDATING —— 这本身是一条生命周期断言：
check('K7 漂移结算把 ACTIVE 推进到 REVALIDATING（§12：ACTIVE --validation failure--> REVALIDATING，非直接 STALE）',
  currentSkill().status === lifecycle.LIFECYCLE_STATUS.REVALIDATING
  && Number(currentSkill().lifecycle.contractViolations || 0) >= 1,
  JSON.stringify({ s: currentSkill().status, cv: currentSkill().lifecycle.contractViolations }));
// 组间隔离：为 N 组恢复一个干净的 ACTIVE 夹具（状态机本身已由 G/I 组单独守护，
// 这里不重复断言 —— 只保证后续组不被前组的（正确）状态推进污染）。
reloadActive({
  status: 'ACTIVE',
  lifecycle: Object.assign({}, currentSkill().lifecycle, {
    consecutiveFailures: 0, contractViolations: 0, revalidateFailures: 0,
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// L — No selector persistence（E14）
// ══════════════════════════════════════════════════════════════════════════
const FORBIDDEN = ['selector', 'selectors', 'xpath', 'coordinates', 'coords', 'coordinate', 'pixel', 'offsetX', 'offsetY'];
const FORBIDDEN_HINTS = ['xpath=', 'css=', 'document.querySelector'];
// 静态扫描口径：只扫**数据产出模块**的可执行体；技能词汇表/拒绝清单定义之前的段落允许出现这些词。
const DATA_MODULES = ['skill/skillExecutor.js', 'skill/skillBuilder.js', 'skill/skillRouter.js'];
const staticViolations = [];
for (const rel of DATA_MODULES) {
  const code = stripComments(SRC[rel]);
  for (const k of FORBIDDEN) {
    if (code.indexOf('"' + k + '"') >= 0 || code.indexOf("'" + k + "'") >= 0) staticViolations.push(rel + ':' + k);
  }
  for (const h of FORBIDDEN_HINTS) if (code.toLowerCase().indexOf(h.toLowerCase()) >= 0) staticViolations.push(rel + ':' + h);
}
check('L1 数据产出模块可执行体零定位符字段（selector/xpath/坐标/pixel/offset）',
  staticViolations.length === 0, staticViolations.join(','));

const lAction = x.buildActionFromStep(SEQ.steps[0]);
const lActionBlob = JSON.stringify(lAction).toLowerCase();
check('L2 运行时产出的 action 不含任何定位符字段/值形态',
  FORBIDDEN.every((k) => lActionBlob.indexOf('"' + k.toLowerCase() + '"') < 0)
  && FORBIDDEN_HINTS.every((h) => lActionBlob.indexOf(h.toLowerCase()) < 0), lActionBlob);

const lExecBlob = JSON.stringify(execRows()).toLowerCase();
check('L3 持久化的 execution 记录不含任何定位符字段',
  FORBIDDEN.every((k) => lExecBlob.indexOf('"' + k.toLowerCase() + '"') < 0), '');
const lChainBlob = JSON.stringify(store.read(evmod.COLLECTION, [])).toLowerCase();
check('L4 证据链记录不含任何定位符字段（摘要 + 引用，不存全文/定位符/值）',
  FORBIDDEN.every((k) => lChainBlob.indexOf('"' + k.toLowerCase() + '"') < 0), '');
check('L5 execution 记录不含凭据明文（只留 credentialRefUsed 布尔标记）',
  !/vault:[a-z0-9_]+["']?\s*,\s*["']?value/.test(JSON.stringify(execRows())) && !/"value"\s*:\s*"[^"]+"/.test(JSON.stringify(execRows())), '');
check('L6 17-C schema 的拒绝清单仍原样在位（SEC7 未被 17-E 削弱）',
  /FORBIDDEN_KEYS\s*=\s*\[[^\]]*'selector'/.test(SRC['skill/skillSchema.js'])
  && /SEC7/.test(SRC['skill/skillSchema.js']), '');

// ══════════════════════════════════════════════════════════════════════════
// M — Evidence chain（E13）
// ══════════════════════════════════════════════════════════════════════════
const bRecFinal = execOf('tsk_c113_b', 'exec_B');
check('M1 execution 记录携带 skillId / skillVersion / executionId（可追溯到 Skill 版本）',
  !!bRecFinal && bRecFinal.skillId === ACTIVE_SKILL.id && bRecFinal.skillVersion === ACTIVE_SKILL.version
  && bRecFinal.executionId === 'exec_B', JSON.stringify(bRecFinal && { s: bRecFinal.skillId, v: bRecFinal.skillVersion }));
const bChain = bRecFinal && bRecFinal.chainId ? store.find(evmod.COLLECTION, bRecFinal.chainId) : null;
check('M2 execution 记录 chainId 指向真实存在的证据链', !!bChain, String(bRecFinal && bRecFinal.chainId));
check('M3 链的 transitions 数与完成步数一致，且携带 skillId / skillVersion',
  !!bChain && bChain.transitions.length === 2 && bChain.skillId === ACTIVE_SKILL.id && bChain.skillVersion === ACTIVE_SKILL.version,
  JSON.stringify(bChain && { t: bChain.transitions.length, s: bChain.skillId }));
const tr = (bChain && bChain.transitions[0]) || {};
check('M4 每条迁移五要素齐备（obsBefore / target / action / obsAfter / verification）',
  !!tr.obsBeforeDigest && !!tr.obsAfterDigest && !!(tr.target && (tr.target.intent || tr.target.field))
  && !!(tr.action && tr.action.type) && !!(tr.verification && tr.verification.contract && tr.verification.result),
  JSON.stringify(tr));
const bStep = (bRecFinal.steps[0]) || {};
const trace = {
  skillId: bRecFinal.skillId, skillVersion: bRecFinal.skillVersion, executionId: bRecFinal.executionId,
  stepId: bStep.stepId, obsBeforeDigest: bStep.obsBeforeDigest, obsAfterDigest: bStep.obsAfterDigest,
  actionType: bStep.actionType, verificationContract: bStep.verificationContract,
  chainId: bRecFinal.chainId, terminal: bRecFinal.terminal,
};
check('M5 可独立追溯 Skill → Version → Execution → Step → Observation → Action → PostObservation → Verification → Terminal',
  Object.keys(trace).every((k) => trace[k] !== undefined && trace[k] !== null), JSON.stringify(trace));
check('M6 执行记录独立持久化（不依赖 aiEvents 环形缓冲）',
  x.COLLECTION === 'aiSkillExecutions' && (store.read(x.COLLECTION, []) || []).length > 0, '');
check('M7 新集合已注册水位（防重演 aiAttempts 42MB 事故）',
  /aiSkillExecutions:\s*2000/.test(SRC['taskManager.js'].length ? fs.readFileSync(path.join(__dirname, '..', 'agent', 'storage', 'jsonStore.js'), 'utf8') : ''), '');

// ══════════════════════════════════════════════════════════════════════════
// N — No execution bypass / Generic continuation（E15 / E7）
// ══════════════════════════════════════════════════════════════════════════
check('N1 executor 无浏览器/工具层引用（无 browserManager / page. / runTool( / tools.execute / credentialAuthorization）',
  !/browserManager/.test(exeCode) && !/\bpage\s*\./.test(exeCode) && !/runTool\s*\(/.test(exeCode)
  && !/tools\s*\.\s*execute/.test(exeCode) && !/credentialAuthorization/.test(exeCode)
  && !/\.goto\s*\(/.test(exeCode) && !/\.click\s*\(/.test(exeCode) && !/\.fill\s*\(/.test(exeCode), '');
check('N2 executor 只依赖既有纯逻辑层（store / skillRouter / skillBuilder / skillLifecycle / skillEvidence）',
  /require\('\.\.\/store'\)/.test(exeCode) && /require\('\.\/skillRouter'\)/.test(exeCode)
  && /require\('\.\/skillBuilder'\)/.test(exeCode) && /require\('\.\/skillLifecycle'\)/.test(exeCode), '');
check('N3 executor 无 selector engine / 无 resolution 入口（不调用 resolveSelector / semanticResolver 直接解析）',
  !/resolveSelector|semanticResolver/.test(exeCode), '');

// Generic continuation：handover 之后 Runtime 必须回到 Generic 的动作
const nTask = mkTask('tsk_c113_n', 'exec_N');
const nOpen = x.openSession({ task: nTask, observation: obs() });
const nSess = nOpen.session;
const nd = nSess.beforeStep({ stepId: 'g1', observation: obs(), genericAction: { type: 'click' } });
nSess.afterStep({
  stepId: 'g1',
  result: { ok: true, observation: obs({ elements: [{ name: 'gone' }] }) },
  observation: obs({ elements: [{ name: 'gone' }] }),
});
const nd2 = nSess.beforeStep({ stepId: 'g2', observation: obs(), genericAction: { type: 'click' } });
check('N4 handover 后 Generic 继续：session 不再接管，Runtime 回落到 Generic 自身动作',
  nd.takeover === true && nd2.takeover === false && nd2.handover === true, JSON.stringify(nd2));
nSess.finish();
const rtCode = stripComments(SRC['runtime.js']);
check('N5 Runtime 接线锚点：0 级预闸 + 步内 beforeStep/afterStep + 退出时 finish',
  /skillExecutor\.eligible\(task\)/.test(rtCode)
  && /skillSession\.beforeStep\(/.test(rtCode) && /skillSession\.afterStep\(/.test(rtCode)
  && /skillSession\.finish\(\)/.test(rtCode), '');
check('N6 Runtime 主循环回落口径未被改写（_skillOverride || pendingAction → Generic 的恢复候选优先）',
  /runStep\(task, step, beforeObs, _skillOverride \|\| pendingAction\)/.test(rtCode), '');
check('N7 taskManager 终态接线为 fail-open 包装（不改变任务结果）',
  /function recordSkillTerminal\(task, outcome\)\s*\{[\s\S]{0,300}catch \(e\)/.test(stripComments(SRC['taskManager.js'])), '');
check('N8 既有验证链未被 17-E 改写（verification.verify 调用点仍在 runtime 且未被替换）',
  /verification\.verify\(effV, toolRes\.observation, beforeActionObs\)/.test(rtCode), '');

// ★ 零新增导航成本（17-D 立下的纪律，17-E 必须继承）：
//   Skill 预检**复用** resolvePlan 已采集的规划期观察，绝不自行再采集一次。
check('N11 17-E 未给 runtime 增加第二次规划期观察（capturePlanningObservation 调用点仍只有 1 处）',
  (rtCode.match(/capturePlanningObservation\s*\(/g) || []).length === 2, // 1 处定义 + 1 处调用
  String((rtCode.match(/capturePlanningObservation\s*\(/g) || []).length));
check('N12 预闸位置在 resolvePlan 之后（放在之前会引入 flowMemory 本可避免的导航）',
  rtCode.indexOf('takePlanningObs(task.id)') > rtCode.indexOf('await resolvePlan(task)')
  && rtCode.indexOf('skillExecutor.eligible(task)') > rtCode.indexOf('await resolvePlan(task)'), '');
check('N13 观察缓存消费即取走（每 run 至多驻留一条，异常路径亦有容量兜底）',
  /_planningObsByTask\.delete\(taskId\)/.test(rtCode) && /_planningObsByTask\.size > 64/.test(rtCode), '');

// 生产结构惰性：真实新技能恒 CANDIDATE ⇒ eligible 恒假 ⇒ SkillExecutor 结构不进入
// （独立 origin，确保这是一条**全新**的 CANDIDATE，而不是撞上人工 ACTIVE 夹具的键）
const INERT_ORIGIN = 'https://inert.example.test/search';
const inertTask = mkTask('tsk_c113_inert', 'exec_INERT', INERT_ORIGIN);
const inertBuild = makeRealSkill('tsk_c113_inert', INERT_ORIGIN);
builder.persist(inertBuild.built.candidate, inertBuild.built.chain, inertBuild.task);
const inertOpen = x.openSession({ task: inertTask, observation: obs({ url: INERT_ORIGIN }) });
check('N9 生产结构惰性：builder 恒产 CANDIDATE ⇒ 恒 HOLD，SkillExecutor 不进入执行路径',
  inertOpen.taken === false && inertOpen.reason === x.HANDOVER_REASONS.NO_ACTIVE_CANDIDATE,
  JSON.stringify(inertOpen.reason));
check('N10 结构惰性下的 0 级预闸为纯元数据（无观察、无浏览器动作）',
  typeof x.eligible === 'function' && x.eligible(inertTask).any === false, '');

// ══════════════════════════════════════════════════════════════════════════
// T24 隔离零污染
// ══════════════════════════════════════════════════════════════════════════
const polluted = REAL_FILES.filter((f) => {
  const p = path.join(REAL_DATA_DIR, f);
  const after = fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
  return after !== realBefore[f];
});
check('T24 真实数据目录零污染', polluted.length === 0, polluted.join(',') || JSON.stringify(realBefore));

console.log('\n=== C113 汇总 ===');
console.log('PASS=' + pass + ' FAIL=' + fail);
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* tmp 自愈 */ }
process.exit(fail === 0 ? 0 : 1);
