'use strict';

// Diagnosis Engine：回答"为什么失败"（不执行修复，只产建议）。
// 输入：ErrorClassifier 结果 + FailureSnapshot + Observation + History + Memory。
// 真实 Provider 存在 → LLM 结构化诊断；否则确定性启发式兜底。

const errorClassifier = require('../recovery/errorClassifier');
const failureSnapshot = require('../recovery/failureSnapshot');
const memory = require('../memory');
const diagnosisSchema = require('./diagnosisSchema');
const diagnosisPrompt = require('./diagnosisPrompt');

// 确定性兜底：基于分类 + 观察文本的启发式（保证无 key 也可用）
function fallbackDiagnosis({ classifier, failure, observation, step }) {
  const text = (observation && observation.textSummary) || '';
  const low = text.toLowerCase();
  const url = failure.url || '';
  let category = classifier.type;
  const facts = [];
  const evidence = [];
  let inference = '';
  let recommendation = '';
  let conf = classifier.confidence || 0.6;

  // C77 D1：403 匹配收紧为独立 token（\b403\b），与 C76 D2（errorClassifier）同族对齐——
  // 页面全文中出现数字子串 403（价格 $1403、编号 40321）此前会被误判 HTTP_FORBIDDEN，
  // 而 HTTP_FORBIDDEN 的 retryPolicy=escalate，即随机文案导致任务误升级人工。
  if (/\b403\b|forbidden|access denied/i.test(low) || /forbidden/i.test(url)) {
    category = 'HTTP_FORBIDDEN';
    facts.push('页面/响应出现 403 或 Access denied');
    evidence.push('可见文本包含 403/forbidden');
    inference = '服务端拒绝访问（具体策略未知，需人工核实）';
    recommendation = '检查代理出口与站点访问策略；禁止无证据断言"被封"';
  } else if (/session expired|please login|please sign in|log in again|login again|your session/i.test(low)) {
    category = 'SESSION_EXPIRED';
    facts.push('页面出现登录/会话失效提示');
    evidence.push(`可见文本片段: ${text.slice(0, 100)}`);
    inference = '会话已过期，需要重新登录';
    recommendation = '若已配置凭据，执行重新登录后回到目标页';
  } else if (/cookie|consent|accept all|reject all|accept cookies/i.test(low)) {
    category = 'OBSTRUCTION';
    facts.push('页面出现 Cookie 同意/弹窗');
    evidence.push('可见文本包含 consent/cookie 关键词');
    inference = '弹窗遮挡页面交互';
    recommendation = '按站点规则处理弹窗（accept/reject）后重试';
    conf = 0.9; // 关键词命中较可靠，满足 Repair Policy MEDIUM 自动阈值
  } else if (classifier.type === 'ELEMENT_NOT_FOUND' || classifier.type === 'ELEMENT_NOT_INTERACTABLE') {
    const t = (step && step.action && step.action.target) || {};
    const target = t.semantic || t.field || '';
    if (target) {
      facts.push(`先前目标 "${target}" 未定位到`);
      if (low) evidence.push(`当前页面可见文本片段: ${low.slice(0, 140)}`);
      inference = '目标可能被改名/移动/隐藏，或页面处于不同状态';
      recommendation = '重新观察并运行语义匹配（含同义词探测）';
      category = classifier.type === 'ELEMENT_NOT_FOUND' ? 'ELEMENT_CHANGED' : 'ELEMENT_NOT_INTERACTABLE';
    } else {
      inference = '目标元素未找到';
      recommendation = '重新观察页面结构';
    }
  } else {
    inference = classifier.evidence.join('; ') || '未知原因';
    recommendation = '按错误类型执行确定性恢复（等待/重载/返回/重试）';
  }

  if (!facts.length) facts.push(`错误码: ${classifier.type}`);
  if (!evidence.length) evidence.push(`分类证据: ${classifier.evidence.join('; ') || '无'}`);
  return {
    category,
    confidence: Math.round(Math.min(1, Math.max(0, conf)) * 100) / 100,
    facts: facts.slice(0, 6),
    evidence: evidence.slice(0, 6),
    inference,
    recommendation,
  };
}

async function runDiagnosis({ task, step, error, observation, execution, provider, ctx }) {
  const classifier = errorClassifier.classify(error, { url: observation && observation.url });

  // 1) 结构化 FailureSnapshot
  const failure = await failureSnapshot.create({
    taskId: task.id,
    stepId: step && step.id,
    url: (observation && observation.url) || task.targetUrl || '',
    title: observation && observation.title,
    errorType: classifier.type,
    confidence: classifier.confidence,
    lastAction: (step && step.action) || null,
    observation,
    executionId: task.currentExecutionId,
  });

  // 2) 历史经验
  let mem = null;
  try { mem = memory.suggest((observation && observation.url) || task.targetUrl, classifier.type); } catch (e) {}

  // 3) LLM 诊断（真实 provider）；失败回退确定性
  let fromLLM = false;
  let diag = null;
  if (provider && provider.kind && provider.kind !== 'mock') {
    try {
      diag = await provider.structured(ctx, {
        system: diagnosisPrompt.buildSystem(),
        prompt: diagnosisPrompt.buildUser({ failure, observation, execution, memorySuggestion: mem, classifier }),
        schema: { validate: diagnosisSchema.validate, instructions: diagnosisSchema.INSTRUCTIONS },
        maxRetries: 1,
        label: 'diagnosis',
      });
      fromLLM = true;
    } catch (e) {
      diag = null;
    }
  }
  if (!diag) diag = fallbackDiagnosis({ classifier, failure, observation, step });

  return { ok: true, fromLLM, diagnosis: diag, failureSnapshot: failure, classifier };
}

module.exports = { runDiagnosis, fallbackDiagnosis };
