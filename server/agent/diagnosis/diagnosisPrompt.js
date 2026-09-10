'use strict';

// Diagnosis Prompt：构建 LLM 诊断输入（脱敏 + 限长）。
// 输入 FailureSnapshot + Observation + History + Memory 建议。

const context = require('../context');
const { INSTRUCTIONS } = require('./diagnosisSchema');

// 兼容 error：旧格式为字符串，Phase 3 后为结构化 {code,message}。
// 统一渲染为 "CODE: message"，避免 [object Object]。
function fmtErr(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return `${e.code || 'ERR'}: ${e.message || ''}`.trim();
  return String(e);
}

function buildSystem() {
  return `你是浏览器自动化诊断专家。只基于给出的事实与证据做诊断，禁止无证据推测（例如"IP 被封""被风控""账号异常"）。
只输出符合 Schema 的 JSON，不要输出其它内容。
${INSTRUCTIONS}`;
}

function buildUser({ failure, observation, execution, memorySuggestion, classifier }) {
  const red = context.redactString;
  const parts = [];
  parts.push('【失败信息】');
  parts.push(`- 错误类型: ${failure.errorType}（分类置信度 ${failure.confidence != null ? failure.confidence : '-'}）`);
  if (classifier && classifier.evidence && classifier.evidence.length) {
    parts.push(`- 分类证据: ${classifier.evidence.slice(0, 3).join('; ')}`);
  }
  parts.push(`- 最后动作: ${failure.lastAction ? (failure.lastAction.type + ' ' + (failure.lastAction.target && (failure.lastAction.target.semantic || failure.lastAction.target.field || failure.lastAction.target.url || ''))) : '-'}`);
  parts.push(`- URL: ${red(failure.url || '')}`);
  parts.push(`- 页面标题: ${red(failure.title || '')}`);

  parts.push('【页面可见文本（已脱敏）】');
  const texts = failure.visibleTexts || [];
  parts.push(texts.length ? red(texts.slice(0, 20).join(' · ')).slice(0, 1500) : '（无）');

  parts.push('【观察元素】');
  if (observation && observation.elements && observation.elements.length) {
    const els = observation.elements.slice(0, 25).map((e) => `${e.role || e.tag || '?'}:${red(e.text || e.name || e.placeholder || '').slice(0, 60)}`).join(', ');
    parts.push(els.slice(0, 1200));
  } else {
    parts.push('（无）');
  }

  parts.push('【最近动作历史】');
  if (execution && execution.actions && execution.actions.length) {
    parts.push(execution.actions.slice(-8).map((a) => `${a.tool}→${a.status}${a.error ? '✘' + red(fmtErr(a.error)).slice(0, 80) : ''}`).join(' | ').slice(0, 1200));
  } else {
    parts.push('（无）');
  }

  if (memorySuggestion) {
    parts.push('【历史经验】');
    parts.push(`该站点该错误的历史成功策略: ${memorySuggestion.strategy}（成功率 ${memorySuggestion.successRate}，样本 ${memorySuggestion.samples}）`);
  }

  // PHASE 17-A P0-B：让诊断把「下一步该不该继续」说成结构化结论，而不是一段文字。
  // 只在证据充分时输出；诊断绝不判定成功，也绝不产出任何绕过验证码/风控的方案。
  parts.push('【决策字段（可选，证据充分时才给）】');
  parts.push('- state: TARGET_NOT_PRESENT_YET（目标尚未出现，当前页可能是合法中间态，例如分步表单只到邮箱步）/ MULTI_STEP_FORM（分步表单，禁止提前执行后续字段）/ NAVIGATION_IN_PROGRESS（导航或提交未完成）/ CROSS_ORIGIN_DRIFT（已漂移到第三方域）/ SECURITY_CHALLENGE（人机验证或风控挑战）/ TARGET_STALE（目标定位已失效）');
  parts.push('- blockedActions: 形如 ["fill:password"]，列出当前**已知不可能成功**的动作；为空数组表示不特指');
  parts.push('- required: REOBSERVE_AFTER_SUBMIT / WAIT_AND_REOBSERVE / REAUTH_CONTEXT / HUMAN / FRESH_OBSERVE_AND_REGROUND');
  parts.push('- 严禁编造：没把握就不要给 state。严禁给出任何绕过人机验证/风控/跨域授权的方案。');

  return parts.join('\n');
}

module.exports = { buildSystem, buildUser };
