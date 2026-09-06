'use strict';

// P1 Credential Field Contract — 针对性回归测试
//
// 背景（2026-08-31 run6/run7 真实事件链实证）：
//   planner 对 email 等身份字段编造 literal value（admin@cloudsaas.com），
//   而场景真值在凭据库（ops@cloudsaas.io）→ 登录真失败 → HUMAN_ESCALATION。
//   另发现 DeepSeek 严格 plan 路径（deepseekPlan）完全看不到凭据清单（task.secretRefs 被丢弃）。
//
// 修复内容（本测试锁定的契约）：
//   1. planner.credentialContractViolations：任务挂载可用凭据时，fill 身份字段
//      （email/username/账号等）禁止 literal value，必须 credentialRef。
//   2. planObjective 集成：违规计划被拒绝并回灌重试（error 含「凭据字段契约违规」）。
//   3. planner prompt（求值后）：不再示范 value 填 email；新增身份字段 credentialRef 规则。
//   4. PLAN_STRICT_INSTRUCTIONS 同步。
//   5. deepseek.credentialSection：严格 plan 路径注入脱敏凭据清单。
//
// 纪律：断言真正会执行的那份东西（求值后字符串/真实函数行为），不 eval 源码。
//       不改 Success Definition / benchmark / Runtime 语义。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 FPB_DATA_DIR：必须在 require 任何 agent 模块之前设置（避免污染真实 store）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-cred-contract-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const planner = require('../agent/planner');
const secretManager = require('../agent/secretManager');
const { PLAN_STRICT_INSTRUCTIONS } = require('../agent/schema/plan');
const { credentialSection, buildContextSection } = require('../agent/llm/providers/deepseek');

// ---- monkeypatch secretManager（同 test_credential_unavailable.js 先例）----
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
    fn();
    pass++;
    console.log('  PASS ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' :: ' + String(e.message || e).slice(0, 200));
    console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 200));
  }
}

// ---- 严格 plan 步骤构造器（provider.plan 路径产出形状）----
function strictLoginSteps(emailFill) {
  const emailStep = {
    action: 'fill', target: { field: 'email', semantic: '企业邮箱' },
    semantic: '填写邮箱', expectedResult: '邮箱输入框已填入登录用户名',
    verification: { type: 'text_present', expect: '登录' },
  };
  if (emailFill === 'literal') emailStep.value = 'admin@cloudsaas.com';
  else if (emailFill === 'ref') emailStep.credentialRef = 'cred_test_1';
  return [
    { action: 'navigate', target: { url: '/saas/login.html' }, semantic: '打开登录页', expectedResult: '登录页加载完成', verification: { type: 'action_success' } },
    emailStep,
    { action: 'fill', target: { field: 'password', semantic: '密码' }, credentialRef: 'cred_test_1', semantic: '填写密码', expectedResult: '密码输入框已填入凭据中的密码', verification: { type: 'text_present', expect: '登录' } },
    { action: 'click', target: { field: 'loginBtn', semantic: '登录按钮' }, semantic: '点击登录', expectedResult: '登录后进入工作台', verification: { type: 'url_contains', expect: 'dashboard' } },
  ];
}

function runSuite(tag) {
  console.log('=== suite ' + tag + ' ===');

  // ---- 1. 守卫单元：credentialContractViolations ----
  check('guard: email+value+可用凭据 → 违规', () => {
    patchSecrets(true);
    try {
      const steps = [{
        id: 'step_002', type: 'ACT', action: {
          type: 'fill', target: { field: 'email', semantic: 'x' }, value: 'admin@cloudsaas.com', credentialRef: null,
        },
      }];
      const bad = planner.credentialContractViolations(steps, ['cred_test_1']);
      assert.ok(Array.isArray(bad) && bad.length === 1, '应报 1 条违规，实际: ' + JSON.stringify(bad));
      assert.ok(bad[0].indexOf('step_002') >= 0 && bad[0].indexOf('email') >= 0, '违规描述应含 step id 与字段名');
    } finally { restoreSecrets(); }
  });

  check('guard: email+credentialRef → 通过', () => {
    patchSecrets(true);
    try {
      const steps = [{
        id: 'step_002', type: 'ACT', action: {
          type: 'fill', target: { field: 'email', semantic: 'x' }, value: null, credentialRef: 'cred_test_1',
        },
      }];
      assert.deepStrictEqual(planner.credentialContractViolations(steps, ['cred_test_1']), []);
    } finally { restoreSecrets(); }
  });

  check('guard: 无凭据任务 value 编造 → 不约束（不误伤）', () => {
    patchSecrets(true);
    try {
      const steps = [{
        id: 'step_002', type: 'ACT', action: {
          type: 'fill', target: { field: 'email', semantic: 'x' }, value: 'a@b.com', credentialRef: null,
        },
      }];
      assert.deepStrictEqual(planner.credentialContractViolations(steps, []), []);
    } finally { restoreSecrets(); }
  });

  check('guard: 凭据全部不可用 → 不约束', () => {
    patchSecrets(false);
    try {
      const steps = [{
        id: 'step_002', type: 'ACT', action: {
          type: 'fill', target: { field: 'email', semantic: 'x' }, value: 'a@b.com', credentialRef: null,
        },
      }];
      assert.deepStrictEqual(planner.credentialContractViolations(steps, ['cred_test_1']), []);
    } finally { restoreSecrets(); }
  });

  check('guard: 身份字段变体（username/userName/account/邮箱）均命中', () => {
    patchSecrets(true);
    try {
      const fields = ['username', 'userName', 'user_name', 'account', 'accountName', 'loginName', 'userEmail', '邮箱'];
      for (const f of fields) {
        const steps = [{
          id: 's1', type: 'ACT', action: {
            type: 'fill', target: { field: f, semantic: 'x' }, value: 'literal', credentialRef: null,
          },
        }];
        const bad = planner.credentialContractViolations(steps, ['cred_test_1']);
        assert.ok(bad.length === 1, 'field=' + f + ' 应命中守卫');
      }
    } finally { restoreSecrets(); }
  });

  check('guard: 非身份字段（search/message/qty）不误伤', () => {
    patchSecrets(true);
    try {
      const fields = ['search', 'message', 'qty', 'note', 'title'];
      for (const f of fields) {
        const steps = [{
          id: 's1', type: 'ACT', action: {
            type: 'fill', target: { field: f, semantic: 'x' }, value: 'literal', credentialRef: null,
          },
        }];
        assert.deepStrictEqual(planner.credentialContractViolations(steps, ['cred_test_1']), [], 'field=' + f + ' 不应命中');
      }
    } finally { restoreSecrets(); }
  });

  check('guard: 非身份字段分工 —— password+value 由 schema 层拦截，不由本守卫', () => {
    patchSecrets(true);
    try {
      const steps = [{
        id: 's1', type: 'ACT', action: {
          type: 'fill', target: { field: 'password', semantic: 'x' }, value: 'Secret#1', credentialRef: null,
        },
      }];
      assert.deepStrictEqual(planner.credentialContractViolations(steps, ['cred_test_1']), [],
        'password+value 属 schema SENSITIVE_FIELDS 守卫职责，本守卫不重复');
    } finally { restoreSecrets(); }
  });

  // ---- 2. planObjective 集成：违规拒绝 + 回灌重试 ----
  check('planObjective: 违规计划被拒绝（error 含「凭据字段契约违规」）', async () => {
    patchSecrets(true);
    try {
      let calls = 0;
      const provider = {
        kind: 'test',
        plan: async () => { calls++; return strictLoginSteps('literal'); },
      };
      const r = await planner.planObjective({
        objective: '登录 SaaS 工作台',
        target: '/saas/login.html',
        credentialRefs: ['cred_test_1'],
        provider,
        ctx: {},
      });
      assert.strictEqual(r.ok, false, '违规计划必须被拒绝');
      assert.ok(String(r.error).indexOf('凭据字段契约违规') >= 0, 'error 应含契约违规说明: ' + String(r.error).slice(0, 120));
      assert.strictEqual(calls, 3, '应重试 3 次全部被拒，实际: ' + calls);
    } finally { restoreSecrets(); }
  });

  check('planObjective: 合规计划（email 走 credentialRef）通过且 ref 透传', async () => {
    patchSecrets(true);
    try {
      const provider = {
        kind: 'test',
        plan: async () => strictLoginSteps('ref'),
      };
      const r = await planner.planObjective({
        objective: '登录 SaaS 工作台',
        target: '/saas/login.html',
        credentialRefs: ['cred_test_1'],
        provider,
        ctx: {},
      });
      assert.strictEqual(r.ok, true, '合规计划应通过: ' + String(r.error || '').slice(0, 200));
      const emailStep = r.plan.steps.find((s) => s.action && s.action.target && s.action.target.field === 'email');
      assert.ok(emailStep, '计划应含 email 步骤');
      assert.strictEqual(emailStep.action.credentialRef, 'cred_test_1', 'email 步骤应保留 credentialRef');
      assert.strictEqual(emailStep.action.value, null, 'email 步骤 value 应为 null');
    } finally { restoreSecrets(); }
  });

  check('planObjective: 无凭据任务 value 编造不被拒绝', async () => {
    patchSecrets(true);
    try {
      const provider = { kind: 'test', plan: async () => strictLoginSteps('literal').filter((s) => !(s.action === 'fill' && s.target.field === 'password')) };
      const r = await planner.planObjective({
        objective: '登录 SaaS 工作台',
        target: '/saas/login.html',
        credentialRefs: [],
        provider,
        ctx: {},
      });
      assert.strictEqual(r.ok, true, '无凭据任务不应被守卫拦截: ' + String(r.error || '').slice(0, 200));
    } finally { restoreSecrets(); }
  });

  // ---- 3. prompt 契约（求值后字符串断言）----
  check('planner prompt: 不再示范 value 填 email（user@example.com 移除）', () => {
    const s = planner.plannerInstructions();
    assert.ok(s.indexOf('user@example.com') < 0, 'prompt 示例不得再示范 value 填 email');
    const s2 = JSON.stringify(planner.plannerInstructions());
    assert.ok(s2.indexOf('user@example.com') < 0);
  });

  check('planner prompt: 含 P1 身份字段 credentialRef 规则', () => {
    const s = planner.plannerInstructions();
    assert.ok(s.indexOf('P1 凭据字段契约') >= 0, '应含 P1 规则行');
    assert.ok(s.indexOf('身份类字段') >= 0 && s.indexOf('credentialRef') >= 0, '应含身份字段 credentialRef 要求');
    assert.ok(s.indexOf('禁止自行编造 value') >= 0, '应含禁止编造 value');
  });

  check('PLAN_STRICT_INSTRUCTIONS: 同步身份字段规则', () => {
    assert.ok(PLAN_STRICT_INSTRUCTIONS.indexOf('身份类字段') >= 0, '应含身份类字段规则');
    assert.ok(PLAN_STRICT_INSTRUCTIONS.indexOf('禁止编造 value') >= 0, '应含禁止编造 value');
    assert.ok(PLAN_STRICT_INSTRUCTIONS.indexOf('user@example.com') < 0, '不得示范编造 email');
  });

  check('deepseek credentialSection: 注入脱敏清单 + 身份字段规则', () => {
    patchSecrets(true);
    try {
      const s = credentialSection(['cred_test_1']);
      assert.ok(s.indexOf('cred_test_1') >= 0, '应含凭据 ref 原样 id');
      assert.ok(s.indexOf('maskedEmail') >= 0 && s.indexOf('o***@cloudsaas.io') >= 0, '应含脱敏邮箱视图');
      assert.ok(s.indexOf('身份类字段') >= 0, '应含身份字段规则');
      assert.ok(s.indexOf('禁止用 value 编造') >= 0, '应含禁止编造');
      assert.ok(s.indexOf('available=true') >= 0, '应含可用性标记');
    } finally { restoreSecrets(); }
  });

  check('deepseek credentialSection: 无凭据 → 注入空集禁令（P1 反向守卫 prompt 同步）', () => {
    const s1 = credentialSection([]);
    const s2 = credentialSection(null);
    for (const s of [s1, s2]) {
      assert.ok(String(s).indexOf('未提供任何凭据清单') >= 0, '应含空集禁令，实际: ' + String(s).slice(0, 80));
      assert.ok(String(s).indexOf('credentialRef') >= 0, '应点名 credentialRef');
    }
  });

  check('deepseek credentialSection: 凭据不可用 → available=false 且规则仍提示转人工', () => {
    patchSecrets(false);
    try {
      const s = credentialSection(['cred_test_1']);
      assert.ok(s.indexOf('available=false') >= 0);
      assert.ok(s.indexOf('人工') >= 0);
    } finally { restoreSecrets(); }
  });

  check('buildContextSection: 不泄露凭据明文（回归确认）', () => {
    const ctx = { context: { task: { objective: 'x' }, credentials: [{ id: 'c1', password: 'SuperSecret#1' }] } };
    const s = buildContextSection(ctx);
    assert.ok(s.indexOf('SuperSecret#1') < 0, '上下文序列化不得包含明文密码');
  });
}

// ---- ×2 幂等 ----
runSuite('run-1');
runSuite('run-2');

console.log('');
console.log('=== P1 Credential Field Contract: ' + pass + ' passed, ' + fail + ' failed ===');
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
