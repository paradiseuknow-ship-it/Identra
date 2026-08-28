'use strict';

// Mock Provider：Phase 1.2 用，不接真实 LLM。
// 目标：test-site/form —— navigate → inspect → fill(email) → fill(password, credentialRef)
//      → submit → verify(text_present "success") → SUCCESS。

const provider = require('./provider');

function planForTask(task) {
  const url = task.targetUrl || 'http://localhost:9555/form';
  const ref = (task.secretRefs && task.secretRefs[0]) || null;
  const steps = [
    {
      id: 'step_nav', description: `打开 ${url}`, type: 'NAVIGATE',
      action: { type: 'navigate', target: { url }, risk: 'LOW', verification: { type: 'page_change' } },
      verification: { type: 'page_change' }, retryable: true, maxRetries: 3,
    },
    {
      id: 'step_obs', description: '观察页面结构', type: 'OBSERVE',
      action: { type: 'inspect', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' } },
      verification: { type: 'none' }, retryable: true, maxRetries: 3,
    },
    {
      id: 'step_email', description: '填写邮箱', type: 'ACT',
      action: { type: 'fill', target: { field: 'email' }, value: 'demo@test.local', risk: 'MEDIUM', verification: { type: 'element_present', expect: 'email' } },
      verification: { type: 'element_present', expect: 'email' }, retryable: true, maxRetries: 3,
    },
    {
      id: 'step_pwd', description: '填写密码', type: 'ACT',
      action: { type: 'fill', target: { field: 'password' }, credentialRef: ref, risk: 'MEDIUM', verification: { type: 'none' } },
      verification: { type: 'none' }, retryable: true, maxRetries: 3,
    },
    {
      id: 'step_submit', description: '提交表单', type: 'ACT',
      action: { type: 'submit', target: { semantic: 'submit' }, risk: 'HIGH', verification: { type: 'page_change' } },
      verification: { type: 'page_change' }, retryable: true, maxRetries: 3,
    },
    {
      id: 'step_verify', description: '验证注册结果', type: 'VERIFY',
      action: { type: 'extract', target: { role: 'body' }, risk: 'LOW', verification: { type: 'text_present', expect: 'success' } },
      verification: { type: 'text_present', expect: 'success' }, retryable: true, maxRetries: 3,
    },
  ];
  return steps;
}

function mockFactory(config) {
  return {
    name: 'mock',
    async chat(messages, opts) {
      return { content: '[mock] 无真实模型', role: 'assistant' };
    },
    async structured(system, prompt, schema) {
      return { ok: true };
    },
    async plan(task) {
      // Phase 5.8 修复（Finding #2 一部分）：planner.planObjective 期望 provider.plan 返回
      // 步骤【数组】，而非 {steps:[...]} 对象——旧格式会被 planner 判为「未返回步骤数组」而拒绝。
      // 此处返回合法数组，使 planner 契约正确；仅覆盖 form 站目标（复杂 Objective 仍需 bridge/LLM）。
      return planForTask(task);
    },
    async diagnose(context) {
      const category = (context && context.error && context.error.type) || 'UNKNOWN';
      return {
        category,
        facts: [context && context.error && context.error.message].filter(Boolean),
        evidence: [],
        inference: '（mock 诊断）依据 error 分类，无外部证据',
        repairable: true,
        confidence: 0.5,
      };
    },
    async repair(diagnosis, context) {
      return { strategy: 'mock_retry', risk: 'LOW', confidence: 0.5, expectedResult: '重试一次' };
    },
  };
}

provider.register('mock', mockFactory);
module.exports = { mockFactory, planForTask };
