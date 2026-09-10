'use strict';

// Mock Provider：Phase 1.2 用，不接真实 LLM。
// 目标：test-site/form —— navigate → inspect → fill(email) → fill(password, credentialRef)
//      → submit → verify(text_present "success") → SUCCESS。
//
// C108（2026-09-10）planForTask 契约修复：planner.planObjective 对 provider.plan capability
// 的产出按「严格 Step 契约」消费（normalizeStrictToCanonical：顶层 action=动作字符串、
// semantic/expectedResult 承载描述与验证依据）。本文件此前返回的是规范化运行时 Step
// （action 为对象、顶层 type: 'NAVIGATE'）→ 被当 strict 输入归一后全部步骤退化为
// ACT/空 action/空描述 → validatePlan 恒拒绝 → mock planObjective 恒失败：
//   - /chat 在 mock 模式恒 400（session 创建后规划阶段失败，C79 归因实证）；
//   - runtime REPLAN 恒 fail-fast（恢复链「意外地快」是死路径的副作用，不是性能）。
// 修复后 mock 与真实 LLM provider（deepseekPlan）同走 validatePlanStrict 自校验，fail-loud——
// 契约漂移在生成期炸掉，而不是在 planner 校验层静默重试三次后 400。
// 附带时序影响（C79/C108 实证）：mock REPLAN 变为真实可用 → step22 受控失败注入场景
// （F1/F2）恢复链多走「重规划→执行→再失败→升级」全程，suite 总时长 70–94s → ~200–260s，
// runRegression 对该套件启用专属超时覆盖（断言口径零变化，仅执行时间窗对齐真实恢复链成本）。

const provider = require('./provider');
const { validatePlanStrict } = require('./schema/plan');

function planForTask(task) {
  const url = task.targetUrl || 'http://localhost:9555/form';
  const ref = (task.secretRefs && task.secretRefs.filter(Boolean)[0]) || null;
  // 凭据契约（与 planner.credentialContractViolations / PLAN_STRICT_INSTRUCTIONS 同源语义）：
  //   - 有凭据引用 → email/password 身份字段一律 credentialRef（禁止 value 编造）；
  //   - 无凭据引用 → 禁止任何 credentialRef（空集反向守卫），且敏感字段（password）动作不规划。
  const emailStep = ref
    ? {
        action: 'fill', target: { field: 'email', semantic: 'email 输入框' },
        credentialRef: ref,
        semantic: '填写邮箱（凭据引用）',
        expectedResult: '邮箱输入框已填入凭据中的邮箱',
        verification: { type: 'element_present', expect: 'email' },
      }
    : {
        action: 'fill', target: { field: 'email', semantic: 'email 输入框' },
        value: 'demo@test.local',
        semantic: '填写邮箱',
        expectedResult: '邮箱输入框已填入 demo@test.local',
        verification: { type: 'element_present', expect: 'email' },
      };
  const steps = [
    {
      action: 'navigate', target: { url },
      semantic: `打开 ${url}`,
      expectedResult: '页面加载完成，目标表单可见',
      verification: { type: 'page_change' },
    },
    {
      action: 'inspect', target: { role: 'page' },
      semantic: '观察页面结构',
      expectedResult: '页面元素结构可读',
    },
    emailStep,
  ];
  if (ref) {
    steps.push({
      action: 'fill', target: { field: 'password', semantic: 'password 输入框' },
      credentialRef: ref,
      semantic: '填写密码（凭据引用）',
      expectedResult: '密码输入框已填入凭据中的密码',
      verification: { type: 'element_present', expect: 'password' },
    });
  }
  steps.push(
    {
      action: 'submit', target: { semantic: 'submit' },
      semantic: '提交表单',
      expectedResult: '表单提交成功，页面进入成功态',
      verification: { type: 'page_change' },
    },
    {
      action: 'extract', target: { role: 'body' },
      semantic: '验证注册结果',
      expectedResult: '页面出现 success 文本',
      verification: { type: 'text_present', expect: 'success' },
    },
  );
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
      // C108：产出严格 Step 契约格式，并先经 validatePlanStrict 自校验（fail-loud）。
      // planner.planObjective 会对本返回值走 normalizeStrictToCanonical → validatePlan，
      // 与真实 LLM provider 完全同一条校验链。
      const steps = planForTask(task);
      const vr = validatePlanStrict({ steps });
      if (!vr.ok) {
        throw new Error('mock plan 违反 strict 契约（fail-loud）: ' + (vr.errors || []).slice(0, 3).join('; '));
      }
      return vr.plan.steps;
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
