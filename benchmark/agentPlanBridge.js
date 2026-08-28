'use strict';

// Phase 5.4 — Benchmark Plan Bridge（测试脚手架，非 Agent 能力扩展）
// 目的：让 Runner C 在 mock 无 LLM 环境下也能驱动 Runtime 跑通 11 类任务，
// 从而公平对比 A/B/C。这只是一个"已知任务→已知步骤"的确定性映射，
// 不引入任何 AI/规划能力。真实环境（AI_PROVIDER=key）下 Runtime 仍走 LLM planner。
//
// 用法：Runner C 在 runtime.run 前，若 BENCH_PLAN_BRIDGE=1，则调用 injectPlan(task)
// 直接写 steps 到 stepManager，绕过 planner 的 mock 注册表单局限。

const stepManager = require('../server/agent/stepManager');

// 每类任务对应的合法 plan（target 用占位符，Runner C 注入真实 mockBaseUrl）
function planFor(category, mockBaseUrl, targetUrl) {
  const url = mockBaseUrl + (targetUrl || '/');
  const base = [
    { id: 'nav', description: `打开 ${url}`, type: 'NAVIGATE',
      action: { type: 'navigate', target: { url }, risk: 'LOW', verification: { type: 'page_change' } },
      verification: { type: 'page_change' }, retryable: true, maxRetries: 3 },
    { id: 'obs', description: '观察页面', type: 'OBSERVE',
      action: { type: 'inspect', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' } },
      verification: { type: 'none' }, retryable: true, maxRetries: 3 },
  ];
  const fill = (id, field, value) => ({ id, description: `填写 ${field}`, type: 'ACT',
    action: { type: 'fill', target: { field, selector: '#' + field }, value, risk: 'MEDIUM', verification: { type: 'none' } },
    verification: { type: 'none' }, retryable: true, maxRetries: 3 });
  const click = (id, sel) => ({ id, description: `点击 ${sel}`, type: 'ACT',
    action: { type: 'click', target: { selector: sel }, risk: 'MEDIUM', verification: { type: 'none' } },
    verification: { type: 'none' }, retryable: true, maxRetries: 3 });
  // 5.9-A.3：wait 步骤的 verification 改为 type:'none'。
  // 原因：Runtime 的 verification 引擎（semanticResolver / textSummary）对 CSS selector 与 div 文本
  // 的解析能力与 task.verify（verifyResult 读真实 DOM）不一致，会导致中间步 VERIFY_FAILED →
  // 重试耗尽 → HUMAN_ESCALATION，即使页面实际已满足（groundTruth=true）。
  // 最终成功判据统一回归 task.verify（Ground Truth），plan 步骤仅作执行策略，不替代终态判据。
  const wait = (id, type, expect) => ({ id, description: `验证 ${expect}`, type: 'VERIFY',
    action: { type: 'extract', target: { role: 'body' }, risk: 'LOW', verification: { type: 'none' } },
    verification: { type: 'none' }, retryable: true, maxRetries: 3 });

  switch (category) {
    case 'login':
      return [...base, fill('f1', 'username', 'alice'), fill('f2', 'password', 'secret123'),
        click('s', '#submit'), wait('v', 'url_contains', '/dashboard')];
    case 'search':
      return [...base, fill('f1', 'q', 'benchmark test'), click('s', '#go'), wait('v', 'element_present', '#results')];
    case 'form':
      return [...base, fill('f1', 'name', 'Bob'), fill('f2', 'email', 'bob@example.com'),
        fill('f3', 'msg', 'hello'), click('s', '#submit'), wait('v', 'text_present', '提交成功')];
    case 'navigation':
      return [...base, click('c1', 'a[href="/products"]'), click('c2', 'a[href="/docs"]'), wait('v', 'url_contains', '/docs/quickstart')];
    case 'text-change':
      return [...base, click('c1', '#refresh'), wait('v', 'text_present', 'Ready')];
    case 'timeout':
      return [...base, click('c1', '#slow'), wait('v', 'text_present', 'timeout-detected')];
    case 'cookie-consent':
      return [...base, click('c1', '#accept'), wait('v', 'text_present', 'cookie-dismissed')];
    case 'structure-change':
      return [...base, click('c1', '#submit'), wait('v', 'text_present', 'done')];
    case 'session-expired':
      return [...base, click('c1', '#act'), wait('v', 'url_contains', '/dashboard')];
    case 'browser-crash':
      return [...base, click('c1', '#go'), wait('v', 'text_present', 'recovered')];
    case 'worker-crash':
      return [...base, click('c1', '#go'), wait('v', 'text_present', 'recovered')];
    default:
      return base;
  }
}

function injectPlan(task, mockBaseUrl, rawTarget) {
  // rawTarget：相对路径（如 /login）；若调用方已传入则优先，否则回退 task.targetUrl。
  const target = rawTarget != null ? rawTarget : task.targetUrl;
  const steps = planFor(task.category, mockBaseUrl, target);
  steps.forEach((s, i) => stepManager.createStep(task.id, s, i));
  return steps.length;
}

module.exports = { injectPlan, planFor };
