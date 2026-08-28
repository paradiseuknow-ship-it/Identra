'use strict';

// 修复策略：VERIFY_FAILED → 按 Verification Intelligence 分类（failureType）分流。
//
// Phase 10.7 重写：彻底消除"silent-pass"——任何分支在返回 ok:true 之前，必须用真实
// observation 重新运行 verification（含 allowedAlternativeStates），否则返回 ok:false 交上层升级。
//
// 路由矩阵（与 VIL 决策对齐）：
//   EVENTUAL_CONSISTENCY  → WAIT_STABLE + RECHECK_OBSERVATION（等异步/观察稳定，重观察重验证，不重执行）
//   OBSERVATION_DELAY     → WAIT + RECHECK_OBSERVATION
//   VERIFICATION_TOO_STRICT→ RECHECK_OBSERVATION + 替代验证态（allowedAlternativeStates，来自任务预定义 contract）
//   STATE_UNKNOWN         → RECHECK_OBSERVATION（重确认）→ 再分类 → 仍无证据则升级
//   ACTION_REAL_FAILURE   → RE_EXECUTE（重执行原动作，保留完整 target 对象）→ 真实重验证
//   DOM_CHANGED           → SEMANTIC_RELOCATE（语义重定位）→ 重观察 → 真实重验证
//
// 红线：
//   - 不重执行原 action 于 WAIT/RECHECK/RETRY_VERIFY 路径（这些只重观察 + 重验证）。
//   - 不降低 verification 标准；替代态必须来自任务预定义 contract。
//   - target 对象必须完整保留 { field, semantic, type, value, credentialRef }。
//   - RESOURCE_LOCK 不进入本策略（由 errorClassifier 走独立基础设施错误分支）。

const verification = require('../../verification');
const { verifyWithAlternatives } = require('../../verification/verificationWindow');
const elementChanged = require('./elementChanged');

// 同一 step 进入 verifyFailed 的次数（判断 plan 是否已过期：常规重定位/重试已连续失败）。
const _verifyFailCount = new Map();

// 提交结果落点是否明确指向错误页（供 SUBMIT_RESULT_UNKNOWN 分支判别）。
function looksLikeErrorPage(obs) {
  if (!obs) return false;
  if (Array.isArray(obs.errors) && obs.errors.length) return true;
  const t = ((obs.visibleText || obs.textSummary || '') + ' ' + (obs.url || '')).toLowerCase();
  return /(error|failed|invalid|forbidden|denied|try again|captcha|oops|exception|404|500|错误|失败|无效)/i.test(t);
}

// 凭证/支付/登录类动作（需人工，不可自动重规划）
function isCredentialAction(step) {
  const a = step && step.action;
  if (!a) return false;
  if (a.risk === 'CRITICAL') return true;
  if (['purchase', 'payment', 'password_change', 'delete', 'login'].includes(a.type)) return true;
  const f = String((a.target && (a.target.field || a.target.semantic)) || '');
  if (/password|card|cvv|otp|支付|付款|登录|密码|卡号/.test(f)) return true;
  return false;
}

// Plan 是否已过期（需 REPLAN）：连续 DOM_CHANGED / ACTION_REAL_FAILURE 且常规重定位/重试已失败。
function isStalePlan(step, ctx) {
  const e = ctx && ctx.error;
  if (e && e.stalePlan) return true;   // 测试/显式标记
  if (e && e.needsReplan) return true;
  const sid = step && step.id;
  if (sid) {
    const n = (_verifyFailCount.get(sid) || 0) + 1;
    _verifyFailCount.set(sid, n);
    if (n >= 2) return true;
  }
  return false;
}

function meta() {
  return {
    type: 'VERIFY_RETRY',
    risk: 'LOW',
    steps: [
      { type: 'wait_stable', description: '按 failureType 等待异步/观察稳定' },
      { type: 'recheck_observation', description: '重新观察（不重执行动作）' },
      { type: 'retry_verify', description: 'ACTION_REAL_FAILURE 时重执行原动作并验证' },
      { type: 'semantic_relocate', description: 'DOM_CHANGED 时元素重定位' },
    ],
    verification: { type: 'action_success' },
  };
}

// 真实「重观察 + 重验证」：等待 → 重新 capture observation → 用 contract（含替代态）验证。
// 返回 { verified, observation, actions }；绝不 silent-pass。
async function recheckAndVerify({ ctx, verificationContract, beforeObs }) {
  const actions = [];
  // 1) WAIT_STABLE（给异步/渲染一点时间）
  try {
    const w = await ctx.runAction({ type: 'wait', target: { role: 'page' }, timeoutMs: 800, verification: { type: 'none' }, risk: 'LOW' });
    actions.push({ tool: 'wait_stable', ok: !!w.success, reason: 'recheck-wait' });
  } catch (e) { actions.push({ tool: 'wait_stable', ok: false }); }

  // 2) RECHECK_OBSERVATION（重新 capture，不重执行业务动作）
  let obs = null;
  try {
    const reObs = await ctx.runAction({ type: 'inspect', target: { role: 'page' }, verification: { type: 'none' }, risk: 'LOW' });
    actions.push({ tool: 'recheck_observation', ok: !!(reObs && reObs.success), reason: '重新观察以重验证（不重执行动作）' });
    obs = (reObs && reObs.observation) || null;
  } catch (e) { actions.push({ tool: 'recheck_observation', ok: false }); }

  if (!obs) return { verified: false, observation: null, actions };

  // 3) 真实重验证（主验证 + 任务预定义替代态）
  const vres = verifyWithAlternatives(verificationContract, obs, beforeObs);
  actions.push({ tool: 'retry_verify', ok: vres.success, used: vres.used || 'primary', reason: '重验证' + (vres.used === 'alternative' ? '（替代态）' : '') });
  return { verified: vres.success, observation: obs, actions };
}

async function execute({ task, step, ctx }) {
  const actions = [];
  const originalAction = (step && step.action) || null;
  const target = (originalAction && originalAction.target) || {};
  const targetLabel = target.semantic || target.field || '';
  const failureType = (ctx && ctx.error && ctx.error.failureType) || null;
  // B4 因果链修复：恢复重验证必须使用与「主验证路径」完全一致的权威 contract
  // （buildEffectiveVerification 推导出的业务结果契约），而非裸 step.verification（旧脆弱验证）。
  // 否则恢复重验证会重复用已损坏的旧验证 → 永远无法通过 → VIL/Repair Recovery = 0。
  const verificationContract = verification.buildEffectiveVerification(step) || { type: 'none' };
  const beforeObs = (ctx && ctx.observation) || null;

  // 凭证/支付/登录类「真实失败」：需人工（REAUTH_OR_PAUSE / HUMAN_ESCALATE），不自动重规划。
  if (failureType === 'ACTION_REAL_FAILURE' && isCredentialAction(step)) {
    return { ok: false, needsApproval: true, strategy: 'REAUTH_OR_PAUSE', reason: '凭证/支付类动作失败，需人工处理', actions: [{ tool: 'reauth_pause', ok: false }] };
  }

  // Plan 已过期（连续 DOM_CHANGED / ACTION_REAL_FAILURE，常规重定位与重试已耗尽）→ 触发 REPLAN。
  if ((failureType === 'DOM_CHANGED' || failureType === 'ACTION_REAL_FAILURE') && isStalePlan(step, ctx)) {
    return { ok: false, needsReplan: true, needsApproval: true, strategy: 'REPLAN', reason: 'plan stale → needs replan', actions: [{ tool: 'replan', ok: false }] };
  }

  // 防御：无原始动作则直接兜底语义重定位
  if (!originalAction) {
    const ec = await elementChanged.execute({ task, step, ctx });
    ec.actions.forEach((a) => actions.push({ tool: 'semantic_relocate:' + (a.tool || ''), ok: a.ok, target: a.target, reason: a.reason }));
    return { ok: ec.ok, actions };
  }

  // ACTION_REAL_FAILURE：重执行原动作（保留完整 target 对象）→ 真实重验证
  if (failureType === 'ACTION_REAL_FAILURE') {
    const retryAction = { ...originalAction, verification: { type: 'none' } };
    const res = await ctx.runAction(retryAction);
    actions.push({
      tool: 'retry_verify',
      target: targetLabel,
      ok: !!res.success,
      targetObject: !!(retryAction.target && (retryAction.target.field || retryAction.target.semantic)),
    });
    if (res.success && res.observation) {
      const v = verifyWithAlternatives(verificationContract, res.observation, beforeObs);
      actions.push({ tool: 'retry_verify_verify', ok: v.success, used: v.used || 'primary' });
      if (v.success) return { ok: true, actions };
    }
    // 重执行仍失败/未通过验证 → 兜底语义重定位（也需验证，不 silent-pass）
    const ec = await elementChanged.execute({ task, step, ctx });
    ec.actions.forEach((a) => actions.push({ tool: 'semantic_relocate:' + (a.tool || ''), ok: a.ok, target: a.target, reason: a.reason }));
    return { ok: false, actions };
  }

  // DOM_CHANGED：元素结构变化 → 语义重定位 → 重观察 → 真实重验证
  if (failureType === 'DOM_CHANGED') {
    const ec = await elementChanged.execute({ task, step, ctx });
    ec.actions.forEach((a) => actions.push({ tool: 'semantic_relocate:' + (a.tool || ''), ok: a.ok, target: a.target, reason: a.reason }));
    // 重定位后重观察 + 真实重验证（不 silent-pass）
    const rk = await recheckAndVerify({ ctx, verificationContract, beforeObs });
    rk.actions.forEach((a) => actions.push(a));
    return { ok: rk.verified, actions };
  }

  // SUBMIT_RESULT_UNKNOWN：提交结果落点不确定 → 先「查询结果」(重观察+真实重验证)；
  // 明确错误页 → 非敏感动作可重执行（保留完整 target），敏感动作升级人工；
  // 仍不确定 → 升级人工（绝不 silent-pass，绝不明目重提交导致重复提交）。
  if (failureType === 'SUBMIT_RESULT_UNKNOWN') {
    const rk = await recheckAndVerify({ ctx, verificationContract, beforeObs });
    rk.actions.forEach((a) => actions.push(a));
    if (rk.verified) return { ok: true, actions };
    const aft = rk.observation;
    if (aft && looksLikeErrorPage(aft)) {
      if (isCredentialAction(step)) {
        return { ok: false, needsApproval: true, strategy: 'REAUTH_OR_PAUSE', reason: 'submit 结果落点为错误页，敏感动作需人工', actions: [{ tool: 'escalate_err', ok: false }] };
      }
      const retryAction = { ...originalAction, verification: { type: 'none' } };
      const res = await ctx.runAction(retryAction);
      if (res && res.success && res.observation) {
        const v = verifyWithAlternatives(verificationContract, res.observation, beforeObs);
        if (v.success) return { ok: true, actions: [{ tool: 'retry_verify', ok: true, reason: '错误页后重执行并验证通过' }] };
      }
      return { ok: false, actions: [{ tool: 'retry_failed', ok: false }], reason: 'submit 结果落点为错误页，重执行仍失败' };
    }
    // 仍不确定：升级人工（不盲目重提交）
    return { ok: false, needsApproval: true, strategy: 'REAUTH_OR_PAUSE', reason: 'submit 结果落点不确定（无明确成功/错误信号），升级人工', actions: [{ tool: 'escalate_indeterminate', ok: false }] };
  }

  // EVENTUAL_CONSISTENCY / OBSERVATION_DELAY / VERIFICATION_TOO_STRICT / STATE_UNKNOWN
  // → 重观察 + 真实重验证（含替代态）。窗口内仍不通过 → 返回 ok:false，由上层正确升级。
  const rk = await recheckAndVerify({ ctx, verificationContract, beforeObs });
  rk.actions.forEach((a) => actions.push(a));
  return { ok: rk.verified, actions };
}

module.exports = { meta, execute };
