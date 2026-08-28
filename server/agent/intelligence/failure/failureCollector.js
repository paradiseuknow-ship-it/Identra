'use strict';

// Failure Collector（Phase 3.3）：修复结果落库为失败经验。
// 学习闭环：
//   Failure → Diagnosis → Repair → 结果 → 沉淀经验 → 下次提前预测
// 安全红线：受保护类别（HTTP_FORBIDDEN / SESSION_EXPIRED / CREDENTIAL_MISSING）
//   只存 REAUTH_OR_PAUSE（等待/换环境/人工），禁止任何自动绕过/撞库/自动支付。

const failureKnowledge = require('./failureKnowledge');
const siteMemory = require('../siteMemory');
const { normalizeUrlPattern, PROTECTED_CATEGORIES } = require('./schema');

// 记录一次修复结果
// opts: { site, category, errorType, url, actionType, pageState, element, strategy, steps, success, source, symptoms }
function recordRepair(opts) {
  if (!opts || !opts.site || !opts.category || !opts.errorType) return { ok: false, error: '参数不足' };
  let strategy = opts.strategy;
  let steps = opts.steps || [];

  // 安全红线：受保护类别只能等待/换环境/人工，绝不停靠自动绕过
  if (PROTECTED_CATEGORIES.includes(opts.category)) {
    strategy = 'REAUTH_OR_PAUSE';
    steps = ['检查代理出口与站点访问策略', '等待冷却或更换环境', '交由人工核实处理'];
  }

  const condition = {
    urlPattern: normalizeUrlPattern(opts.url || '/'),
    actionType: opts.actionType || '?',
    pageState: opts.pageState || '?',
    element: opts.element || undefined,
  };
  const evidence = { errorType: opts.errorType, lastAction: opts.actionType || '?' };

  const r = failureKnowledge.record(opts.site, opts.category, condition, evidence, { strategy, steps }, {
    source: opts.source || { type: 'repair_success' },
    symptoms: opts.symptoms || [],
  });
  if (!r.ok) return r;

  // 回写结果（更新 successRate / confidence / status）
  failureKnowledge.recordOutcome(r.fk.id, !!opts.success);

  // 聚合到 Site Memory 失败画像（供 chat 推荐 / 3.5 推荐引擎）
  try { siteMemory.recordFailureProfile(opts.site, { type: opts.category, success: !!opts.success }); } catch (e) {}

  return { ok: true, fk: r.fk, created: r.created };
}

// 便捷：修复成功
function recordSuccess(opts) { return recordRepair({ ...(opts || {}), success: true }); }
// 便捷：修复失败
function recordFailure(opts) { return recordRepair({ ...(opts || {}), success: false }); }

module.exports = { recordRepair, recordSuccess, recordFailure };
