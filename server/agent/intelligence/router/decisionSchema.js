'use strict';

// Decision Schema：约束 Intelligence Router 的输出结构与安全边界（Phase 3.5）。
// Router 只「决策 + 解释」，绝不执行浏览器动作；任何违反安全红线的策略必须被拒绝。

// 安全红线：Router 永远不得主动建议以下动作（与 Phase 3.1~3.4 一致）。
const FORBIDDEN_STRATEGIES = [
  'switch_ip',          // 自动换 IP 绕限制
  'bypass_captcha',     // 自动规避安全验证
  'bypass_2fa',         // 自动处理 OTP / 3DS
  'guess_password',     // 自动猜密码
  'auto_pay',           // 自动支付
  'auto_otp',           // 自动处理 OTP
  'auto_3ds',           // 自动处理 3DS
  'ignore_verification',// 跳过人工验证
];

// 决策策略的安全分级：Router 只可输出 SAFE，需人工确认的交由上层 Policy 门禁。
const SAFE_STRATEGY_VERBS = [
  'use_profile', 'use_flow', 'use_memory', 'require_llm', 'warn_overlay',
  'reuse_repair', 'manual_step', 'escalate',
];

function validateDecision(d) {
  const errs = [];
  if (!d || typeof d !== 'object') return { ok: false, errors: ['decision 必须是对象'] };
  if (!d.decision || typeof d.decision !== 'object') errs.push('decision 缺失');
  else {
    if (d.decision.profile && typeof d.decision.profile.id !== 'string') errs.push('profile.id 必须是字符串');
    if (d.decision.flow && typeof d.decision.flow.id !== 'string') errs.push('flow.id 必须是字符串');
    const strat = d.decision.strategy || {};
    if (strat.actions && !Array.isArray(strat.actions)) errs.push('strategy.actions 必须是数组');
    if (strat.actions) {
      for (const a of strat.actions) {
        if (FORBIDDEN_STRATEGIES.includes(a)) errs.push('安全红线：禁止策略 ' + a);
      }
    }
  }
  // expectedSuccess 必须在 [0,1]
  const es = d && d.decision && d.decision.strategy && d.decision.strategy.expectedSuccess;
  if (es != null && (typeof es !== 'number' || es < 0 || es > 1)) errs.push('expectedSuccess 必须在 [0,1]');
  return { ok: errs.length === 0, errors: errs };
}

// 在组装 strategy 阶段调用：过滤任何被禁止的动作，返回是否被净化。
function sanitizeActions(actions) {
  actions = actions || [];
  const clean = actions.filter((a) => !FORBIDDEN_STRATEGIES.includes(a));
  return { actions: clean, stripped: actions.length - clean.length };
}

module.exports = { FORBIDDEN_STRATEGIES, SAFE_STRATEGY_VERBS, validateDecision, sanitizeActions };
