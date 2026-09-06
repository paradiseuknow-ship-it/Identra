'use strict';
// test_phase8_planner_retry.js — Phase 8 planner 韧性修复（重试环）单测
// 覆盖：JSON/structured 失败重试、重试耗尽终止、schema 校验仍生效（安全不变）。
const assert = require('assert');
const { planObjective } = require('../agent/planner');

// 合法规范化 step（经 validatePlan 校验通过）
function validPlan() {
  return {
    goal: '测试目标',
    steps: [{
      id: 'step_001', type: 'NAVIGATE', description: '打开页面',
      expectedOutcome: '页面加载', risk: 'LOW',
      action: { type: 'navigate', target: { url: '/' }, risk: 'LOW', verification: { type: 'url_contains', expect: '' } },
    }],
  };
}

function ctx() { return { context: { task: { objective: '测试目标' }, page: { url: 'http://x/' }, steps: [] } }; }

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }

(async () => {
  // 1) structured 第 1、2 次抛错，第 3 次返回合法 plan → 重试后成功
  {
    let calls = 0;
    const provider = {
      kind: 'deepseek',
      structured: async () => {
        calls++;
        if (calls < 3) throw new Error('规划失败(structured): JSON 解析失败 (mock transient)');
        return { steps: validPlan().steps };
      },
    };
    const r = await planObjective({ objective: '测试目标', target: '/', provider, ctx: ctx() });
    ok('A. structured 重试2次后第3次成功', r.ok === true && calls === 3);
  }

  // 2) structured 持续抛错 → 最多重试 MAX_PLANNER_ATTEMPTS(3) 次后终止，不无限循环
  {
    let calls = 0;
    const provider = {
      kind: 'deepseek',
      structured: async () => { calls++; throw new Error('规划失败(structured): 持续失败 (mock)'); },
    };
    const r = await planObjective({ objective: '测试目标', target: '/', provider, ctx: ctx() });
    ok('B. 持续失败重试耗尽终止(无死循环)', r.ok === false && calls === 3);
    ok('B. 错误信息保留', /持续失败/.test(r.error || ''));
  }

  // 3) plan 能力缺失(CAPABILITY_RE) → 降级 structured 且重试正常
  {
    let calls = 0;
    const provider = {
      kind: 'deepseek',
      plan: async () => { calls++; throw new Error('raw.plan is not a function (mock capability)'); },
      structured: async () => { return { steps: validPlan().steps }; },
    };
    const r = await planObjective({ objective: '测试目标', target: '/', provider, ctx: ctx() });
    ok('C. plan 能力缺失降级 structured 成功', r.ok === true && calls === 1);
  }

  // 4) password 用 value 字面量（安全违规）→ 重试后仍被拒绝，证明安全拦截未被绕过
  {
    let calls = 0;
    const badPlan = {
      goal: 'g',
      steps: [{
        id: 's1', type: 'ACT', description: 'd', expectedOutcome: 'o', risk: 'MEDIUM',
        action: {
          type: 'fill', target: { field: 'password' }, value: 'secret123', risk: 'MEDIUM',
          verification: { type: 'text_present', expect: 'x' },
          expectedBusinessState: { stateType: 'FIELD_FILLED', expected: 'e', requiredEvidence: [{ type: 'text_present', expect: 'x' }], forbiddenEvidence: [], evidenceLogic: 'AND' },
        },
      }],
    };
    const provider = {
      kind: 'deepseek',
      structured: async () => { calls++; return { steps: badPlan.steps }; },
    };
    const r = await planObjective({ objective: '测试目标', target: '/', provider, ctx: ctx() });
    // 2026-08-31 B 类缺口修复后契约更新：空凭据清单 + 纯敏感字段门错误 = 确定性不可满足，
    // 首次即短路 needsCredentials（不再空转 3 次重试）。安全属性不变：计划仍被拒绝、永不执行。
    ok('D. password 字面量仍被拒(安全不变) + 确定性短路', r.ok === false && calls === 1 && r.needsCredentials === true);
  }

  console.log(`\nPhase8 planner-retry: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
