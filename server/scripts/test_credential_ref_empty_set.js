'use strict';

// P1 空集反向守卫 — 针对性回归测试（2026-08-31 最终 100-task 归因驱动）
//
// 背景：最终 100-task 中 19 个 CREDIBLE 人工升级全部源于同一副作用缺陷 ——
//   无凭据清单的任务（credReq=none）上 planner 照抄 prompt 输出示例 step_002
//   无条件生成 credentialRef → 执行期 tools.js credentialUnavailableError fail-closed
//   → CREDENTIAL_UNAVAILABLE 直送 HUMAN_ESCALATION（不进 repair）。
//   旧守卫 credentialContractViolations 只单向检查「有凭据清单时编造 value」，
//   对「无凭据清单却输出 credentialRef」完全不设防。
//
// 修复内容（本测试锁定的契约）：
//   1. credentialRefs.length === 0 ⇒ 任何步骤带 action.credentialRef 判违规（机械出口守卫，
//      不依赖 prompt 自觉；不分动作类型）。
//   2. planObjective 集成：违规计划被拒绝并回灌重试，error 按违规方向区分。
//   3. prompt 三处同步（求值后断言）：ACTION_CONSTRAINTS / 输出示例注释 / credentialBlock 空清单提示。
//   4. PLAN_STRICT_INSTRUCTIONS（strict path）与 deepseek.credentialSection 同一规则。
//   5. 有凭据清单的原有强制规则保持不变（不弱化）。
//   6. 有凭据清单 + 编造 password literal → schema 层（action.js 敏感字段守卫）机械拒绝。
//
// 覆盖用户指定的 7 项：
//   (1) 有 credentialRefs + email → credentialRef
//   (2) 有 credentialRefs + password → credentialRef
//   (3) 无 credentialRefs + 普通 email → literal value 合法
//   (4) 无 credentialRefs + LLM 生成 credentialRef → 出口守卫拒绝
//   (5) 有 credentialRefs + 编造 password → 必须拒绝
//   (6) strict / canonical 两条 planner 路径均覆盖
//   (7) ×2 幂等
//
// 纪律：断言真正会执行的那份东西（求值后字符串/真实函数行为），不 eval 源码。
//       不改 Success Definition / benchmark / Runtime 语义。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 FPB_DATA_DIR：必须在 require 任何 agent 模块之前设置（避免污染真实 store）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-cred-empty-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const planner = require('../agent/planner');
const secretManager = require('../agent/secretManager');
const {
  PLAN_STRICT_INSTRUCTIONS, normalizeStrictToCanonical,
} = require('../agent/schema/plan');
const { validatePlan } = require('../agent/schema/plan');
const { credentialSection } = require('../agent/llm/providers/deepseek');

// ---- monkeypatch secretManager（同 test_credential_contract.js 先例）----
const origGetByRef = secretManager.getByRef;
const origMaskedView = secretManager.maskedView;

function patchSecrets(available) {
  secretManager.getByRef = (ref) => ({ id: ref, type: 'email_password', site: 'saas', available });
  secretManager.maskedView = (rec) => ({
    id: rec.id, type: rec.type || 'email_password', site: rec.site || null,
    available: rec.available === true, maskedEmail: 'o***@cloudsaas.io',
  });
}
function restoreSecrets() {
  secretManager.getByRef = origGetByRef;
  secretManager.maskedView = origMaskedView;
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // 异步用例：串行等待，保持计数准确
      return r.then(() => {
        pass++;
        console.log('  PASS ' + name);
      }, (e) => {
        fail++;
        failures.push(name + ' :: ' + String(e.message || e).slice(0, 200));
        console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 200));
      });
    }
    pass++;
    console.log('  PASS ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' :: ' + String(e.message || e).slice(0, 200));
    console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 200));
  }
  return Promise.resolve();
}

// ---- canonical（运行时/structured 路径）步骤构造器 ----
function canonFill(field, opts) {
  const o = opts || {};
  return {
    id: o.id || 'step_002', type: 'ACT',
    description: o.desc || ('填写 ' + field),
    expectedOutcome: '目标输入框已填入',
    risk: 'MEDIUM',
    action: {
      type: 'fill',
      target: { field, semantic: o.semantic || ('输入框 ' + field) },
      value: o.value !== undefined ? o.value : null,
      credentialRef: o.credentialRef || null,
      risk: 'MEDIUM',
      verification: { type: 'text_present', expect: '提交' },
    },
  };
}
function canonNavigate(url) {
  return {
    id: 'step_001', type: 'NAVIGATE', description: '打开页面',
    expectedOutcome: '页面加载完成', risk: 'LOW',
    action: { type: 'navigate', target: { url: url || '/index.html' }, value: null, credentialRef: null, risk: 'LOW', verification: { type: 'action_success' } },
  };
}

// ---- 严格 plan（provider.plan 路径）步骤构造器 ----
function strictFill(field, opts) {
  const o = opts || {};
  const s = {
    action: 'fill', target: { field, semantic: o.semantic || ('输入框 ' + field) },
    semantic: '填写 ' + field, expectedResult: '输入框已填入',
    verification: { type: 'text_present', expect: '提交' },
  };
  if (o.value !== undefined) s.value = o.value;
  if (o.credentialRef) s.credentialRef = o.credentialRef;
  return s;
}

async function runSuite(tag) {
  console.log('=== suite ' + tag + ' ===');

  // ---- (4) 空集反向守卫：单元级 ----
  await check('(4) guard: 无凭据清单 + fill 带 credentialRef → 违规', () => {
    const steps = [canonNavigate(), canonFill('search', { credentialRef: 'cred_hallucinated' })];
    const bad = planner.credentialContractViolations(steps, []);
    assert.ok(Array.isArray(bad) && bad.length === 1, '应报 1 条违规，实际: ' + JSON.stringify(bad));
    assert.ok(bad[0].indexOf('step_002') >= 0, '应含步骤 id');
    assert.ok(bad[0].indexOf('cred_hallucinated') >= 0, '应含编造的 ref');
    assert.ok(bad[0].indexOf('未提供任何凭据清单') >= 0, '应说明空集禁令');
  });

  await check('(4) guard: 空集禁令不分动作类型（click 带 credentialRef 同样违规）', () => {
    const steps = [{
      id: 'step_003', type: 'ACT', description: '点击', expectedOutcome: 'x', risk: 'MEDIUM',
      action: { type: 'click', target: { field: 'btn', semantic: '按钮' }, value: null, credentialRef: 'cred_x', risk: 'MEDIUM', verification: { type: 'action_success' } },
    }];
    const bad = planner.credentialContractViolations(steps, []);
    assert.ok(bad.length === 1, 'click 带 credentialRef 也应违规: ' + JSON.stringify(bad));
  });

  await check('(4) guard: credentialRef=null（schema 归一化默认）不误伤', () => {
    const steps = [canonNavigate(), canonFill('search', { value: '关键词' })];
    assert.deepStrictEqual(planner.credentialContractViolations(steps, []), []);
  });

  // ---- (3) 无凭据 + 普通 email literal → 合法（不误伤）----
  await check('(3) guard: 无凭据 + email literal value → 合法（不误伤普通任务）', () => {
    const steps = [canonFill('email', { value: 'a@b.com' })];
    assert.deepStrictEqual(planner.credentialContractViolations(steps, []), []);
  });

  // ---- (1)(2) 有凭据清单：原有强制规则保持 ----
  await check('(1) guard: 有凭据 + email literal → 仍违规（正向规则未弱化）', () => {
    patchSecrets(true);
    try {
      const steps = [canonFill('email', { value: 'admin@cloudsaas.com' })];
      const bad = planner.credentialContractViolations(steps, ['cred_test_1']);
      assert.ok(bad.length === 1, '正向规则应保持: ' + JSON.stringify(bad));
    } finally { restoreSecrets(); }
  });

  await check('(2) guard: 有凭据 + email/password 用 credentialRef → 通过', () => {
    patchSecrets(true);
    try {
      const steps = [canonFill('email', { credentialRef: 'cred_test_1' }), canonFill('password', { credentialRef: 'cred_test_1' })];
      assert.deepStrictEqual(planner.credentialContractViolations(steps, ['cred_test_1']), []);
    } finally { restoreSecrets(); }
  });

  // ---- (5) 有凭据 + 编造 password literal → schema 机械拒绝 ----
  await check('(5) schema: 有凭据任务 fill password+value 字面量 → validatePlan 拒绝', () => {
    const plan = {
      goal: 'x',
      steps: [canonNavigate(), canonFill('password', { value: 'SuperSecret#1' })],
    };
    const vr = validatePlan(plan);
    assert.strictEqual(vr.ok, false, '敏感字段 literal 必须被 schema 门拒绝');
    const joined = (vr.errors || []).join('; ');
    assert.ok(/credentialRef/.test(joined), '错误应指向 credentialRef 契约: ' + joined.slice(0, 160));
  });

  // ---- (4) planObjective 集成：structured 路径违规被拒绝 + 回灌 3 次 ----
  await check('(4) planObjective: 无凭据 + structured 产出 credentialRef → 拒绝且 error 按空集方向表述', async () => {
    let calls = 0;
    const provider = {
      kind: 'test',
      structured: async () => { calls++; return { steps: [canonNavigate(), canonFill('email', { credentialRef: 'cred_xxx' })] }; },
    };
    const r = await planner.planObjective({
      objective: '在站点搜索年报',
      target: '/search.html',
      credentialRefs: [],
      provider,
      ctx: {},
    });
    assert.strictEqual(r.ok, false, '空集 credentialRef 计划必须被拒绝');
    assert.ok(String(r.error).indexOf('凭据字段契约违规') >= 0, 'error 应含契约违规: ' + String(r.error).slice(0, 120));
    assert.ok(String(r.error).indexOf('未提供任何凭据清单') >= 0, 'error 应按空集方向表述: ' + String(r.error).slice(0, 200));
    assert.strictEqual(calls, 3, '应回灌重试 3 次全部被拒，实际: ' + calls);
  });

  // ---- (4) planObjective 集成：plan（strict→canonical）路径同样被拒绝 ----
  await check('(4) planObjective: 无凭据 + plan 路径产出 credentialRef → 拒绝', async () => {
    const provider = {
      kind: 'test',
      plan: async () => [
        { action: 'navigate', target: { url: '/search.html' }, semantic: '打开页', expectedResult: '加载完成', verification: { type: 'action_success' } },
        strictFill('search', { credentialRef: 'cred_xxx' }),
      ],
    };
    const r = await planner.planObjective({
      objective: '在站点搜索年报',
      target: '/search.html',
      credentialRefs: [],
      provider,
      ctx: {},
    });
    assert.strictEqual(r.ok, false, 'strict→canonical 路径同样必须被拒绝');
    assert.ok(String(r.error).indexOf('未提供任何凭据清单') >= 0, 'error 应按空集方向表述');
  });

  // ---- (4) planObjective 集成：无凭据合规计划（value）正常通过 ----
  await check('(4) planObjective: 无凭据 + 全 value 计划 → 通过（守卫不误伤）', async () => {
    const provider = {
      kind: 'test',
      structured: async () => ({ steps: [canonNavigate(), canonFill('search', { value: '年度报告' })] }),
    };
    const r = await planner.planObjective({
      objective: '在站点搜索年报',
      target: '/search.html',
      credentialRefs: [],
      provider,
      ctx: {},
    });
    assert.strictEqual(r.ok, true, '合规无凭据计划应通过: ' + String(r.error || '').slice(0, 200));
  });

  // ---- (6) 双路径 prompt 契约（求值后字符串断言）----
  await check('(6) prompt: ACTION_CONSTRAINTS 求值后含空集禁令', () => {
    const s = String(planner.ACTION_CONSTRAINTS);
    assert.ok(s.indexOf('凭据清单为空时，禁止在任何步骤输出 credentialRef') >= 0, 'ACTION_CONSTRAINTS 应含空集禁令');
  });

  await check('(6) prompt: planObjective structured prompt 实际下发内容含空集禁令 + 示例条件说明', async () => {
    // 纪律：断言真正会执行的那份东西 —— 示例条件说明位于 buildStructuredOpts 组装的
    // prompt（planObjective → provider.structured 第二参数），不在 plannerInstructions() 里。
    // 通过捕获 provider.structured 实际收到的 opts 验证。
    let captured = null;
    const provider = {
      kind: 'test',
      structured: async (ctx, opts) => {
        captured = opts;
        return { steps: [canonNavigate(), canonFill('search', { value: '年度报告' })] };
      },
    };
    const r = await planner.planObjective({
      objective: '在站点搜索年报', target: '/search.html', credentialRefs: [],
      provider, ctx: {},
    });
    assert.strictEqual(r.ok, true);
    assert.ok(captured && typeof captured.prompt === 'string', '应捕获到 structured opts.prompt');
    assert.ok(captured.prompt.indexOf('凭据清单为空时，禁止在任何步骤输出 credentialRef') >= 0,
      '实际下发 prompt 应含空集禁令');
    assert.ok(captured.prompt.indexOf('仅在任务提供了凭据清单时才允许存在') >= 0,
      '实际下发 prompt 的输出示例应标注条件适用');
    assert.ok(captured.prompt.indexOf('cred_xxx') >= 0, '示例照旧存在（条件说明已随附）');
  });

  await check('(6) prompt: PLAN_STRICT_INSTRUCTIONS（strict path）含同一空集禁令', () => {
    assert.ok(PLAN_STRICT_INSTRUCTIONS.indexOf('禁止在任何步骤输出 credentialRef') >= 0,
      'strict 契约应含空集禁令（两条 planner 路径统一规则）');
  });

  await check('(6) prompt: credentialBlock([]) 空清单显式禁止（不再静默）', () => {
    const s = planner.credentialBlock([]);
    assert.ok(String(s).indexOf('禁止在任何步骤输出 credentialRef') >= 0, '空清单应注入禁令，实际: ' + String(s).slice(0, 80));
  });

  await check('(6) prompt: deepseek credentialSection([]) 空清单禁令（strict 路径第二序列化点）', () => {
    const s = credentialSection([]);
    assert.ok(String(s).indexOf('禁止在任何步骤输出 credentialRef') >= 0, 'deepseek 空清单应注入禁令');
  });

  // ---- (6) strict→canonical 归一化后守卫仍命中（双路径单元级）----
  await check('(6) normalizeStrictToCanonical: 严格步骤 credentialRef 透传且空集下被拦', () => {
    const strictPlan = {
      steps: [
        { action: 'navigate', target: { url: '/search.html' }, semantic: '打开页', expectedResult: '加载完成', verification: { type: 'action_success' } },
        strictFill('search', { credentialRef: 'cred_xxx' }),
      ],
    };
    const canonical = normalizeStrictToCanonical(strictPlan, '搜索');
    assert.strictEqual(canonical.steps[1].action.credentialRef, 'cred_xxx', '归一化应透传 credentialRef');
    const bad = planner.credentialContractViolations(canonical.steps, []);
    assert.ok(bad.length === 1, 'canonical 形状在空集下应被拦: ' + JSON.stringify(bad));
    // 注：strict 原始形状（action 为字符串）不直接进 ccv —— planObjective 的 plan 路径
    // 先 normalizeStrictToCanonical 再守卫，该链路已由上方 planObjective 集成用例端到端覆盖。
  });
}

// ---- (7) ×2 幂等 ----
(async () => {
  await runSuite('run-1');
  await runSuite('run-2');

  console.log('');
  console.log('=== P1 Empty-Set Reverse Guard: ' + pass + ' passed, ' + fail + ' failed ===');
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
})();
