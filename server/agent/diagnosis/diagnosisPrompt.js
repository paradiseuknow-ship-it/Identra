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

  return parts.join('\n');
}

module.exports = { buildSystem, buildUser };
