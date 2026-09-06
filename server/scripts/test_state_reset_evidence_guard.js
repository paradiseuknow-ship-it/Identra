'use strict';

// stateResetByRepair 证据降级 + planner URL 证据引导 — 针对性回归测试
//
// 背景（2026-08-31 run9 1×5 小样本真实事件链实证，rw.001 截图证据）：
//   1. replan 恢复链的 reload 清空未提交表单（浏览器标准行为）→ 重试 click = 空表单重提交
//      → 站点显示「邮箱或密码错误」→ businessErrorDetector 从 page.text 匹配凭据文案
//      → 工程失败（VERIFY_FAILED）被误升级为 BUSINESS_INVALID_CREDENTIAL（可信升级）
//      → POLICY_BLOCK 污染分类口径（违反「工程失败与可信升级严格区分」纪律）。
//      截图证据：第一次 click 后「数据看板」已显示（登录真实成功），错误文案只在
//      reload 之后才出现。
//   2. planner 为登录 click 生成 url_contains "dashboard"，但 fixture 是 URL 不变的
//      SPA（登录成功原地展开面板）→ 证据恒假 → 真成功判 VERIFY_FAILED。
//
// 修复内容（本测试锁定的契约）：
//   1. recoveryManager：runPreAction 执行 reload/back 后按 executionId::stepId 标记
//      状态重置；诊断时作为 stateResetByRepair 信号传入 failureDiagnoser。
//   2. failureDiagnoser：stateResetByRepair=true 时 page.text 类 blocking 证据降级，
//      不作为业务性「不可重试」判定依据；network 等客观证据不受影响。
//      关键性质：真实凭据错误在第一次失败时（reload 未发生）即正常升级，不受影响。
//   3. planner prompt（求值后）：url_contains/url_pattern 仅限「确信 URL 会跳转」；
//      输出示例 step_003 不再示范 url_contains dashboard（改 element_present）。
//
// 纪律：断言真正会执行的那份东西（求值后字符串/真实函数行为），不 eval 源码。
//       降级方向是「多走一轮重试」而非「转 SUCCESS」，不触碰验证门槛/Success Definition。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 FPB_DATA_DIR：必须在 require 任何 agent 模块之前设置（避免污染真实 store）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-state-reset-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const diagnoser = require('../agent/diagnosis/failureDiagnoser');
const recovery = require('../agent/recovery/recoveryManager');
const tools = require('../agent/tools');
const planner = require('../agent/planner');

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  PASS ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' :: ' + String(e.message || e).slice(0, 220));
    console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 220));
  }
}

const CRED_PAGE_TEXT = 'CloudSaaS 控制台 企业邮箱 密码 登录 邮箱或密码错误';

(async () => {
  console.log('=== stateResetByRepair 证据降级 + planner URL 证据引导 ===');

  // ---- A. failureDiagnoser.diagnose 单元 ----

  await check('A1: stateResetByRepair=true → page.text 凭据文案降级（不 escalate）', () => {
    const d = diagnoser.diagnose({
      error: { code: 'VERIFY_FAILED', message: 'required unmet: url_contains' },
      category: 'VERIFICATION_FAILED',
      pageText: CRED_PAGE_TEXT,
      stateResetByRepair: true,
    });
    assert.strictEqual(d.rootCause, 'VERIFICATION_FAILED',
      'rootCause 应回落 category，实际: ' + d.rootCause);
    assert.notStrictEqual(d.retryPolicy, 'escalate',
      '降级后不得 escalate，实际: ' + d.retryPolicy);
    assert.ok(d.evidence.some((e) => e.indexOf('证据降级') >= 0),
      'evidence 应含降级说明: ' + JSON.stringify(d.evidence));
  });

  await check('A2: 无 stateResetByRepair（默认）→ 凭据文案正常判 CREDIBLE 升级（原路径保持）', () => {
    const d = diagnoser.diagnose({
      error: { code: 'VERIFY_FAILED', message: 'required unmet: url_contains' },
      category: 'VERIFICATION_FAILED',
      pageText: CRED_PAGE_TEXT,
    });
    assert.strictEqual(d.rootCause, 'BUSINESS_INVALID_CREDENTIAL',
      '原路径 rootCause 应为 BUSINESS_INVALID_CREDENTIAL，实际: ' + d.rootCause);
    assert.strictEqual(d.retryPolicy, 'escalate', '原路径应 escalate');
    assert.ok(!d.evidence.some((e) => e.indexOf('证据降级') >= 0), '原路径不应有降级说明');
  });

  await check('A3: stateResetByRepair=true → network 客观证据不降级（HTTP 401 仍 blocking）', () => {
    const d = diagnoser.diagnose({
      error: { code: 'VERIFY_FAILED', message: 'required unmet' },
      category: 'VERIFICATION_FAILED',
      pageText: CRED_PAGE_TEXT,
      network: { counts: { requests: 2 }, apiResponses: [{ status: 401, url: '/api/login', method: 'POST', ts: Date.now() }], lastRequestAt: Date.now() },
      stateResetByRepair: true,
    });
    assert.strictEqual(d.rootCause, 'HTTP_401_UNAUTHORIZED',
      'network 401 不得被降级，实际: ' + d.rootCause);
    assert.strictEqual(d.retryPolicy, 'replan',
      'HTTP_401_UNAUTHORIZED 的既有 retryPolicy 为 replan（failureDiagnoser.js:51），实际: ' + d.retryPolicy);
  });

  await check('A4: stateResetByRepair=true + 页面无业务错误文案 → 无降级说明、按 category 保守推断', () => {
    const d = diagnoser.diagnose({
      error: { code: 'VERIFY_FAILED', message: 'required unmet' },
      category: 'VERIFICATION_FAILED',
      pageText: 'CloudSaaS 控制台 企业邮箱 密码 登录',
      stateResetByRepair: true,
    });
    assert.ok(!d.evidence.some((e) => e.indexOf('证据降级') >= 0), '无 blocking pick 时不应有降级说明');
    assert.strictEqual(d.retryPolicy, 'replan', '应按 category 保守 replan，实际: ' + d.retryPolicy);
  });

  await check('A5: fromObservation 透传 stateResetByRepair（真实入口）', () => {
    const d = diagnoser.fromObservation(
      { code: 'VERIFY_FAILED', message: 'required unmet' },
      'VERIFICATION_FAILED',
      { textSummary: CRED_PAGE_TEXT },
      { stateResetByRepair: true },
    );
    assert.strictEqual(d.rootCause, 'VERIFICATION_FAILED',
      'fromObservation 路径应降级，实际: ' + d.rootCause);
    assert.ok(d.evidence.some((e) => e.indexOf('证据降级') >= 0), 'evidence 应含降级说明');
  });

  await check('A6: fromObservation 未传 stateResetByRepair → 保持原判定（不误降级）', () => {
    const d = diagnoser.fromObservation(
      { code: 'VERIFY_FAILED', message: 'required unmet' },
      'VERIFICATION_FAILED',
      { textSummary: CRED_PAGE_TEXT },
      {},
    );
    assert.strictEqual(d.rootCause, 'BUSINESS_INVALID_CREDENTIAL',
      '未标记时不得降级，实际: ' + d.rootCause);
  });

  await check('A7: 降级说明文案不含「凭据/凭证/审批/支付需」字样（防 escalationSplit 文本误匹配）', () => {
    const d = diagnoser.diagnose({
      error: { code: 'VERIFY_FAILED', message: 'x' },
      category: 'VERIFICATION_FAILED',
      pageText: CRED_PAGE_TEXT,
      stateResetByRepair: true,
    });
    const demotedLine = d.evidence.find((e) => e.indexOf('证据降级') >= 0) || '';
    assert.ok(!/凭据|凭证|审批|支付.*需/.test(demotedLine),
      '降级说明不得含触发 CREDIBLE 文本匹配的词: ' + demotedLine);
    // summary/rootCause 也不得含（final.error 会进 escalationSplit 的文本匹配）
    assert.ok(!/凭据|凭证|审批/.test(String(d.summary)), 'summary 不得含 CREDIBLE 触发词: ' + d.summary);
  });

  // ---- B. recoveryManager 状态重置跟踪 ----

  await check('B1: runPreAction(reload) → 该 step 被标记 stateReset', async () => {
    const task = { id: 'task_sr_a', currentExecutionId: 'exe_sr_a' };
    const step = { id: 'step_sr_a' };
    const origExecute = tools.execute;
    tools.execute = async () => ({ ok: true });
    try {
      await recovery.runPreAction(task, step, 2, ['waitLong', 'reload']);
      assert.strictEqual(recovery.hasStateResetRepair(task, step), true,
        'reload 后应标记 stateReset');
    } finally { tools.execute = origExecute; }
  });

  await check('B2: runPreAction(waitLong) → 不标记（wait 不重置页面状态）', async () => {
    const task = { id: 'task_sr_b', currentExecutionId: 'exe_sr_b' };
    const step = { id: 'step_sr_b' };
    const origExecute = tools.execute;
    tools.execute = async () => ({ ok: true });
    try {
      await recovery.runPreAction(task, step, 1, ['waitLong', 'reload']);
      assert.strictEqual(recovery.hasStateResetRepair(task, step), false,
        'waitLong 不是状态重置型 repair');
    } finally { tools.execute = origExecute; }
  });

  await check('B3: runPreAction(back+reload) → 标记；不同 step 互不影响', async () => {
    const task = { id: 'task_sr_c', currentExecutionId: 'exe_sr_c' };
    const stepA = { id: 'step_sr_c_1' };
    const stepB = { id: 'step_sr_c_2' };
    const origExecute = tools.execute;
    tools.execute = async () => ({ ok: true });
    try {
      await recovery.runPreAction(task, stepA, 2, ['waitLong', 'back+reload']);
      assert.strictEqual(recovery.hasStateResetRepair(task, stepA), true, 'back+reload 应标记');
      assert.strictEqual(recovery.hasStateResetRepair(task, stepB), false, '其它 step 不受影响');
    } finally { tools.execute = origExecute; }
  });

  // ---- C. planner prompt（求值后字符串断言）----

  await check('C1: plannerInstructions 含 URL 跳转确认引导（url_contains 恒假陷阱）', () => {
    const s = planner.plannerInstructions();
    assert.ok(s.indexOf('确信动作成功后浏览器会跳转到新 URL') >= 0,
      '应含「确信 URL 跳转才用 url_contains」引导');
    assert.ok(s.indexOf('禁止凭猜测写 url_contains') >= 0,
      '应含禁止猜测 url_contains 引导');
    assert.ok(s.indexOf('单页应用') >= 0, '应含 SPA 场景说明');
  });

  await check('C2: planObjective 输出示例（求值后 prompt）不再示范 url_contains dashboard', async () => {
    let capturedPrompt = '';
    const provider = {
      kind: 'test',
      structured: async (ctx, opts) => {
        capturedPrompt = String((opts && opts.prompt) || '');
        return {
          goal: '登录',
          steps: [{
            id: 'step_001', type: 'ACT', description: '点击登录', risk: 'MEDIUM',
            action: {
              type: 'click', target: { field: 'loginBtn', semantic: '登录按钮' }, risk: 'MEDIUM',
              verification: { type: 'element_present', expect: '看板' },
            },
          }],
        };
      },
    };
    const r = await planner.planObjective({
      objective: '登录系统并查看看板',
      target: '/saas/login.html',
      credentialRefs: [],
      provider,
      ctx: {},
    });
    assert.strictEqual(r.ok, true, '计划应通过: ' + String(r.error || '').slice(0, 150));
    assert.ok(capturedPrompt.length > 100, '应捕获到求值后 prompt');
    assert.ok(capturedPrompt.indexOf('"type":"url_contains","expect":"dashboard"') < 0
      && capturedPrompt.indexOf('"type": "url_contains","expect": "dashboard"') < 0,
      '输出示例不得再示范 url_contains dashboard');
    assert.ok(capturedPrompt.indexOf('"type":"element_present","expect":"dashboard"') >= 0,
      '输出示例 step_003 应为 element_present');
  });

  // ---- D. LOGIN_SUCCESS 仅 URL 证据守卫（run10 实证驱动）----

  await check('D1: urlOnlyEvidenceViolations — 单条 url_contains 判违规', () => {
    const steps = [{
      id: 'step_003', type: 'ACT',
      action: {
        type: 'click', target: { field: 'loginBtn' }, risk: 'MEDIUM',
        expectedBusinessState: {
          stateType: 'LOGIN_SUCCESS', expected: '登录成功',
          requiredEvidence: [{ type: 'url_contains', expect: 'dashboard' }],
          evidenceLogic: 'AND',
        },
      },
    }];
    const bad = planner.urlOnlyEvidenceViolations(steps);
    assert.ok(Array.isArray(bad) && bad.length === 1, '应报 1 条违规: ' + JSON.stringify(bad));
    assert.ok(bad[0].indexOf('step_003') >= 0 && bad[0].indexOf('url_contains') >= 0);
  });

  await check('D2: OR 混合信号（URL + 内容类）放行', () => {
    const steps = [{
      id: 'step_003', type: 'ACT',
      action: {
        type: 'click', target: { field: 'loginBtn' }, risk: 'MEDIUM',
        expectedBusinessState: {
          stateType: 'LOGIN_SUCCESS', expected: '登录成功',
          requiredEvidence: [
            { type: 'url_contains', expect: 'dashboard' },
            { type: 'text_present', expect: '数据看板' },
          ],
          evidenceLogic: 'OR',
        },
      },
    }];
    assert.deepStrictEqual(planner.urlOnlyEvidenceViolations(steps), [], 'OR 混合信号不应拦截');
  });

  await check('D3: 纯内容类证据放行', () => {
    const steps = [{
      id: 'step_003', type: 'ACT',
      action: {
        type: 'click', target: { field: 'loginBtn' }, risk: 'MEDIUM',
        expectedBusinessState: {
          stateType: 'LOGIN_SUCCESS', expected: '登录成功',
          requiredEvidence: [{ type: 'element_present', expect: 'dashboard' }],
        },
      },
    }];
    assert.deepStrictEqual(planner.urlOnlyEvidenceViolations(steps), []);
  });

  await check('D4: 非 LOGIN_SUCCESS 的 URL-only 证据不拦（范围最小化，实证驱动）', () => {
    const steps = [{
      id: 'step_001', type: 'ACT',
      action: {
        type: 'navigate', target: { url: '/x' }, risk: 'LOW',
        expectedBusinessState: {
          stateType: 'NAVIGATED', expected: '到达',
          requiredEvidence: [{ type: 'url_contains', expect: '/x' }],
        },
      },
    }];
    assert.deepStrictEqual(planner.urlOnlyEvidenceViolations(steps), []);
  });

  await check('D5: planObjective 集成 — URL-only 登录证据被拒绝并回灌重试', async () => {
    let calls = 0;
    const mkSteps = () => [{
      id: 'step_001', type: 'ACT', description: '点击登录', risk: 'MEDIUM',
      action: {
        type: 'click', target: { field: 'loginBtn', semantic: '登录按钮' }, risk: 'MEDIUM',
        verification: { type: 'element_present', expect: '看板' },
        expectedBusinessState: {
          stateType: 'LOGIN_SUCCESS', expected: '登录成功',
          requiredEvidence: [{ type: 'url_contains', expect: 'dashboard' }],
          evidenceLogic: 'AND',
        },
      },
    }];
    // structured 路径直接产出 canonical Step（plan 路径要求严格 Step，经 normalizeStrictToCanonical）
    const provider = {
      kind: 'test',
      structured: async (ctx2, opts) => { calls++; return { goal: '登录', steps: mkSteps() }; },
    };
    const r = await planner.planObjective({
      objective: '登录系统并查看看板',
      target: '/saas/login.html',
      credentialRefs: [],
      provider,
      ctx: {},
    });
    assert.strictEqual(r.ok, false, 'URL-only 登录证据必须被拒绝');
    assert.ok(String(r.error).indexOf('登录证据契约违规') >= 0,
      'error 应含登录证据契约违规: ' + String(r.error).slice(0, 150));
    assert.strictEqual(calls, 3, '应重试 3 次全部被拒，实际: ' + calls);
  });

  await check('D6: planObjective 集成 — 合规 OR 证据通过', async () => {
    const provider = {
      kind: 'test',
      structured: async (ctx2, opts) => ({
        goal: '登录',
        steps: [{
          id: 'step_001', type: 'ACT', description: '点击登录', risk: 'MEDIUM',
          action: {
            type: 'click', target: { field: 'loginBtn', semantic: '登录按钮' }, risk: 'MEDIUM',
            verification: { type: 'element_present', expect: '看板' },
            expectedBusinessState: {
              stateType: 'LOGIN_SUCCESS', expected: '登录成功',
              requiredEvidence: [
                { type: 'url_contains', expect: 'dashboard' },
                { type: 'text_present', expect: '数据看板' },
              ],
              evidenceLogic: 'OR',
            },
          },
        }],
      }),
    };
    const r = await planner.planObjective({
      objective: '登录系统并查看看板',
      target: '/saas/login.html',
      credentialRefs: [],
      provider,
      ctx: {},
    });
    assert.strictEqual(r.ok, true, '合规 OR 证据应通过: ' + String(r.error || '').slice(0, 150));
  });

  await check('D7: plannerInstructions 含 P3 登录证据契约规则行', () => {
    const s = planner.plannerInstructions();
    assert.ok(s.indexOf('P3 登录证据契约') >= 0, '应含 P3 规则行');
    assert.ok(s.indexOf('禁止全部为 URL 类证据') >= 0, '应含禁止规则');
  });

  console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
  if (failures.length) {
    console.log('失败明细:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
