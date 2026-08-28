'use strict';

// Repair Plan Schema：所有 Repair Plan 必须经此校验，非法拒绝。
// 结构：{ diagnosisId, strategy, strategyType, confidence, risk, steps[], verification, maxAttempts }

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const REPAIR_STRATEGIES = [
  'SEMANTIC_RELOCATE',   // 元素缺失/变化：语义重新定位
  'WAIT_RETRY_RELOAD',   // 超时：等待→重试→重载→返回重载
  'DISMISS_OVERLAY',     // 弹窗/遮挡：检测→关闭→继续
  'RELOAD_OR_BACK',      // 导航失败：重载→返回重载
  'REAUTH_OR_PAUSE',     // 会话过期：人工或既有登录流程
  'GENERIC_RETRY',       // 兜底
  'VERIFY_RETRY',        // 验证失败：等待稳定→重观察→重试验证→语义重定位（Phase 7 Step 5）
  'REPLAN',              // Plan 本身过期（结构变化/真实动作失败且常规重定位重试已耗尽）：基于当前观察重生成剩余步骤
];

function validate(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['Repair Plan 必须是对象'] };
  if (typeof raw.strategy !== 'string' || !raw.strategy.trim()) errors.push('strategy 缺失');
  else if (!REPAIR_STRATEGIES.includes(raw.strategy)) errors.push(`strategy 非法: ${raw.strategy}`);
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) errors.push('confidence 必须为 0~1');
  if (!RISK_LEVELS.includes(raw.risk)) errors.push(`risk 非法: ${String(raw.risk)}`);
  if (!Array.isArray(raw.steps) || !raw.steps.length) errors.push('steps 必须是非空数组');
  else {
    raw.steps.forEach((s, i) => {
      if (!s || typeof s !== 'object' || typeof s.type !== 'string' || typeof s.description !== 'string') {
        errors.push(`steps[${i}] 需要 {type, description}`);
      }
    });
  }
  if (raw.maxAttempts !== undefined && (!Number.isInteger(raw.maxAttempts) || raw.maxAttempts < 1 || raw.maxAttempts > 10)) {
    errors.push('maxAttempts 必须为 1~10 的整数');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    plan: {
      diagnosisId: raw.diagnosisId || null,
      strategy: raw.strategy,
      strategyType: raw.strategyType || '',
      confidence: Math.round(Math.min(1, Math.max(0, raw.confidence)) * 100) / 100,
      risk: raw.risk,
      steps: raw.steps.map((s) => ({ type: String(s.type), description: String(s.description).slice(0, 200) })),
      verification: raw.verification || { type: 'action_success' },
      maxAttempts: raw.maxAttempts || 3,
    },
  };
}

module.exports = { validate, REPAIR_STRATEGIES, RISK_LEVELS };
