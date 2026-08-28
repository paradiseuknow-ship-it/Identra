'use strict';

// Verification Observation Window（Phase 10.7）。
//
// 职责：在 verification.js 判定失败后，按 VIL 决策进入「重观察 + 重验证」窗口，
// 真正捕获异步一致性 / 观察过早 / 验证过严（替代态）三类可恢复失败。
//
// 设计红线（来自用户约束）：
//   - WAIT / RECHECK_OBSERVATION / RETRY_VERIFY 只重观察 + 重验证，**绝不重执行原 action**。
//   - 有界超时：到达 maxMs 仍未验证成功 → 明确返回 recovered:false（绝不无限等待）。
//   - 每次 WAIT（等待）与 RECHECK（重新 capture observation）都发事件，供审计精确计数。
//   - 替代验证态必须来自任务预定义的 verification contract（allowedAlternatives），
//     不允 LLM 自行宣布成功。
//
// 纯函数友好：verifyFn / inspectFn 可注入（测试用），默认走真实 observation + verification。

const verification = require('../verification');
const contractLib = require('./contract');
const events = require('../events');

// 观察窗口时间表（ms）。初始观察已在 runStep 取过（即 afterObservation），窗口从第一次等待开始。
// STATE_UNKNOWN（无时序证据）用较短窗口，降低静态页面真失败的耗时；
// EVENTUAL_CONSISTENCY / OBSERVATION_DELAY（有时序证据）用完整窗口，充分等待异步稳定。
const SCHEDULE_STATE_UNKNOWN = [300, 800, 1600];     // 累计 ~2.7s 上限封顶
const SCHEDULE_TIMING = [250, 600, 1200, 2200];      // 累计 ~4.3s 上限封顶
const DEFAULT_MAX_MS = Number(process.env.VIL_WINDOW_MAX_MS) || 5200;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 解析真实业务态契约：effV 可能是 { businessState: contract } 包裹，也可能直接是 contract。
function resolveBusinessContract(v) {
  return (v && v.businessState) ? v.businessState : v;
}

// 替代验证：先试主验证，再依次试 contract.allowedAlternatives（任务预定义合法态）。
// 无替代态时仅返回主验证结果。绝不"看起来成功就算成功"。
function verifyWithAlternatives(contract, after, before) {
  const primary = verification.verify(contract, after, before);
  if (primary.success) return { success: true, used: 'primary', result: primary };
  // 真实契约可能包裹在 businessState 下；从内层读取替代态（兼容 allowedAlternatives / allowedAlternativeStates 两种键名）。
  const inner = resolveBusinessContract(contract);
  const alts = (inner && (inner.allowedAlternatives || inner.allowedAlternativeStates)) || [];
  for (let i = 0; i < alts.length; i++) {
    const a = alts[i];
    // 替代态可能是「裸 clause」（含 type/expect，无 requiredEvidence）或「完整契约」：
    //  - 裸 clause 用 legacyToContract 包成单子句契约，避免被 normalize 视为空 requiredEvidence 而真空成功；
    //  - 完整契约（含 requiredEvidence / stateType）直接透传，走 evaluateContract（含 forbidden / AND-OR 语义）。
    const altContract = (a && (a.requiredEvidence || a.stateType)) ? a : contractLib.legacyToContract(a);
    const r = contractLib.evaluateContract(altContract, after, before, verification.verify);
    if (r && r.success) return { success: true, used: 'alternative', index: i, alt: a, result: r };
  }
  return { success: false, used: 'primary', result: primary };
}

// 运行观察窗口。
// 入参：
//   page                 — Playwright page（真实浏览器）
//   taskId / ctx         — 遥测上下文 { taskId, executionId, stepId, attemptId }
//   verification          — step.verification（含 allowedAlternativeStates）
//   beforeObservation     — 动作前观察（供 page_change 判定）
//   initialObservation    — 动作后首次观察（已验证失败）
//   decision              — VIL 决策（决定用哪套时间表）
//   verifyFn / inspectFn  — 可注入（默认 verifyWithAlternatives / observation.inspect）
//   emit                 — 事件发射器（默认 events.emit）
// 返回：
//   { recovered, finalObservation, observationCount, elapsedMs, stateChanged,
//     verificationAttempts, schedule, windowEvents }
async function runObservationWindow({
  page, taskId, ctx = {}, verification: v, beforeObservation, initialObservation,
  decision, verifyFn, inspectFn, emit, actionFinishedAt,
} = {}) {
  const doVerify = verifyFn || verifyWithAlternatives;
  // v0.2.2：窗口内每次重新 capture 的观察都标注来源 + actionFinishedAt，使「Fresh Observation」
  // 可被证明（capturedAt > actionFinishedAt）。这是 DOM_CHANGED→Fresh Observation→Re-Verification 闭环的关键。
  const doInspect = inspectFn || ((p, o) => require('../observation').inspect(p, Object.assign({
    taskId, skipCache: true, source: 'verification_window',
    actionFinishedAt: (typeof actionFinishedAt === 'number') ? actionFinishedAt : undefined,
    stepId: (ctx && ctx.stepId) || undefined,
    attemptId: (ctx && ctx.attemptId) || undefined,
  }, o)));
  const doEmit = emit || ((e) => events.emit(e));

  const schedule = decision === 'EVENTUAL_CONSISTENCY' || decision === 'OBSERVATION_DELAY' || decision === 'RETRY_VERIFY'
    ? SCHEDULE_TIMING
    : SCHEDULE_STATE_UNKNOWN;
  const maxMs = DEFAULT_MAX_MS;

  const start = Date.now();
  let observationCount = 1;
  let verificationAttempts = 1;
  let stateChanged = false;
  let current = initialObservation;
  const windowEvents = [];

  const tryVerify = (obs) => doVerify(v, obs, beforeObservation);
  // 初始观察已验证失败（调用方已确认），直接进入等待循环
  for (const waitMs of schedule) {
    if (Date.now() - start > maxMs) break;
    await sleep(waitMs);
    let insp = null;
    try { insp = await doInspect(page, {}); } catch (e) { insp = null; }
    observationCount += 1;
    // Phase 9 P3：观察成功与否必须可观测。
    // 原逻辑在 inspect 失败（ok=false）时既不报错也不更新 current，外部完全无法区分
    // 「页面真的没变化」与「根本没观察到」—— getPage 漏 await 这类缺陷因此被长期隐藏。
    // 此处仅新增遥测字段，不改变任何判定与恢复语义。
    const observationOk = !!(insp && insp.ok);
    if (observationOk) {
      if (current && insp.observation.domFingerprint !== current.domFingerprint) stateChanged = true;
      current = insp.observation;
    }
    const vres = await tryVerify(current);
    verificationAttempts += 1;
    const ev = {
      iteration: observationCount, waitMs, observationCount, verificationSuccess: vres.success,
      used: vres.used || 'primary', stateChanged, elapsedMs: Date.now() - start,
      observationOk, observationError: (insp && insp.error) ? String(insp.error).slice(0, 160) : null,
    };
    windowEvents.push(ev);
    // 遥测：每次 WAIT + RECHECK 都显式记录，供审计精确计数（WAIT=等待次数，RECHECK=重新观察次数）
    doEmit(Object.assign({}, ctx, {
      type: 'ai.verification.window',
      payload: ev,
    }));
    if (vres.success) {
      return {
        recovered: true, finalObservation: current, observationCount, elapsedMs: Date.now() - start,
        stateChanged, verificationAttempts, schedule, windowEvents,
      };
    }
  }
  return {
    recovered: false, finalObservation: current, observationCount, elapsedMs: Date.now() - start,
    stateChanged, verificationAttempts, schedule, windowEvents,
  };
}

module.exports = { runObservationWindow, verifyWithAlternatives, SCHEDULE_STATE_UNKNOWN, SCHEDULE_TIMING, DEFAULT_MAX_MS };
