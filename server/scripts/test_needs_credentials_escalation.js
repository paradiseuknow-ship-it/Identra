'use strict';

// B 类缺口修复 targeted test（2026-08-31 中途归因 #1）
//
// 背景（33-task 中途归因实证）：88 个 none 任务中 20 个 fixture=login.html（23%），
// 任务语义是「登录后操作」。planner 必须先登录 → 无凭据 → 写明文 password →
// schema/action.js 敏感字段门确定性拒绝 → 重试 3 次逐字相同 → FAILED tax=OTHER。
// 7/7 失败任务同一错误文案，重试纯属烧 token。
//
// 修复契约（本测试锁定）：
//   1. planner.planObjective：凭据清单为空 + 全部阻断错误均为「敏感字段必须 credentialRef」
//      → 首次即收口 { ok:false, needsCredentials:true }，不再重试（provider 只调 1 次）。
//   2. 有凭据清单 / 混合错误 / 无敏感字段计划 → 不触发短路（不误伤）。
//   3. escalationClass：HUMAN_ESCALATION + escalationKind='credential' → CREDIBLE_BUSINESS。
//   4. taskManager.escalate(kind='credential') → task.escalationKind='credential'。
//
// 纪律：断言真正会执行的那份东西（真实 validatePlan + 真实 planObjective 行为），
//       不 eval 源码；不放宽 schema；不改任务池；不碰 Success Definition。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 FPB_DATA_DIR：必须在 require 任何 agent 模块之前设置（避免污染真实 store）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-needs-cred-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const planner = require('../agent/planner');
const { classifyEscalation } = require('./escalationClass');
const taskManager = require('../agent/taskManager');
const store = require('../agent/store');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  PASS ' + name); runNext(); })
    .catch((e) => { fail++; failures.push(name + ' :: ' + String(e.message || e).slice(0, 220)); console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 220)); runNext(); });
}

// ---- provider stub：structured 路径（canonical steps 直出）----

function strictSteps({ passwordValue }) {
  const steps = [
    { action: 'navigate', target: { url: '/saas/login.html' }, semantic: '打开登录页', expectedResult: '登录页加载完成', verification: { type: 'action_success' } },
  ];
  if (passwordValue !== null) {
    steps.push({
      action: 'fill', target: { field: 'password', semantic: '密码' },
      value: passwordValue, semantic: '填写密码',
      expectedResult: '密码输入框已填入', verification: { type: 'text_present', expect: '登录' },
    });
  }
  steps.push({
    action: 'click', target: { field: 'loginBtn', semantic: '登录按钮' }, semantic: '点击登录',
    expectedResult: '登录后进入工作台', verification: { type: 'url_contains', expect: 'dashboard' },
  });
  return steps;
}

function makeProvider(stepsFactory) {
  const provider = { kind: 'test' };
  provider.planCalls = 0;
  provider.plan = async () => { provider.planCalls++; return stepsFactory(); };
  return provider;
}

const CTX = { taskId: 't_test', executionId: 'e_test', context: { page: { url: '/saas/login.html', title: '登录' } } };

// ---- 测试 ----

const tests = [

  () => check('T1: 空清单 + 纯敏感字段门错误 → 首次短路 needsCredentials（provider 只调 1 次）', async () => {
    const provider = makeProvider(() => strictSteps({ passwordValue: 'Secret#1' }));
    const r = await planner.planObjective({
      objective: '进入设置关闭邮件通知', target: '/saas/login.html',
      credentialRefs: [], provider, ctx: CTX,
    });
    assert.strictEqual(r.ok, false, '应规划失败');
    assert.strictEqual(r.needsCredentials, true, '应带 needsCredentials 标记');
    assert.strictEqual(provider.planCalls, 1, '应首次短路不再重试，实际调用 ' + provider.planCalls + ' 次');
    assert.ok(/凭据/.test(String(r.error)), '错误应说明需凭据: ' + String(r.error).slice(0, 80));
  }),

  () => check('T2: 有凭据清单 + password 字面量 → 不短路（走既有重试耗尽，无 needsCredentials）', async () => {
    const provider = makeProvider(() => strictSteps({ passwordValue: 'Secret#1' }));
    const r = await planner.planObjective({
      objective: '进入设置关闭邮件通知', target: '/saas/login.html',
      credentialRefs: ['cred_test_1'], provider, ctx: CTX,
    });
    assert.strictEqual(r.ok, false);
    assert.notStrictEqual(r.needsCredentials, true, '有凭据清单时不得触发 needsCredentials 短路');
    assert.strictEqual(provider.planCalls, 3, '应走满 3 次重试');
  }),

  () => check('T3: 空清单 + 混合错误（敏感字段 + 非法 action type）→ 不短路（其他错误可修正）', async () => {
    const provider = makeProvider(() => {
      const s = strictSteps({ passwordValue: 'Secret#1' });
      s[2].action.type = 'teleport'; // 追加一个非敏感字段类 schema 错误
      return s;
    });
    const r = await planner.planObjective({
      objective: '进入设置关闭邮件通知', target: '/saas/login.html',
      credentialRefs: [], provider, ctx: CTX,
    });
    assert.strictEqual(r.ok, false);
    assert.notStrictEqual(r.needsCredentials, true, '混合错误不得短路（可能可修正）');
    assert.strictEqual(provider.planCalls, 3);
  }),

  () => check('T4: 空清单 + 合法计划（无敏感字段）→ 正常通过（守卫不误伤）', async () => {
    const provider = makeProvider(() => strictSteps({ passwordValue: null }));
    const r = await planner.planObjective({
      objective: '在搜索框输入耳机并搜索', target: '/ecommerce/search.html',
      credentialRefs: [], provider, ctx: CTX,
    });
    assert.strictEqual(r.ok, true, '合法计划应通过: ' + String(r.error || '').slice(0, 120));
  }),

  () => check('T5: escalationClass — HUMAN_ESCALATION + kind=credential → CREDIBLE_BUSINESS', () => {
    const cls = classifyEscalation({ status: 'HUMAN_ESCALATION', escalationKind: 'credential', error: '需要用户提供站点凭据' }, []);
    assert.strictEqual(cls, 'CREDIBLE_BUSINESS');
  }),

  () => check('T6: taskManager.escalate(kind=credential) → escalationKind 持久化为 credential', () => {
    const t = taskManager.createTask({ name: 'needs-cred-escalate', objective: '测试升级', profileId: null, executionMode: 'ASSIST' });
    taskManager.start(t.id);
    const out = taskManager.escalate(t.id, new Error('任务页面需要认证但凭据清单为空'), { kind: 'credential', reason: 'credentials_required' });
    assert.strictEqual(out.status, 'HUMAN_ESCALATION');
    assert.strictEqual(out.escalationKind, 'credential');
  }),

  () => check('T7: runtime 路由布线存在（resolvePlan 调用点捕获 needsCredentials → escalate）', () => {
    // 静态布线检查（行为面已由 T1/T5/T6 分别锁定）：确认 run() 的 resolvePlan 调用点
    // 确实按 needsCredentials 标记路由到 taskManager.escalate(kind=credential)。
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'runtime.js'), 'utf8').replace(/\s+/g, ' ');
    const at = src.indexOf('e.needsCredentials');
    assert.ok(at > 0, 'runtime.js 应包含 e.needsCredentials 路由判断');
    const after = src.slice(at, at + 400);
    assert.ok(/escalate\(taskId, e, \{ kind: 'credential', reason: 'credentials_required' \}/.test(after),
      'needsCredentials 分支应路由到 escalate(kind=credential)');
    assert.ok(/finalizeOrphans\(taskId\)/.test(after), '升级前应收口孤儿步骤');
  }),
];

let idx = 0;
function runNext() { if (idx < tests.length) { const t = tests[idx++]; t(); } else finish(); }
function finish() {
  console.log('\n=== 结果: ' + pass + ' pass / ' + fail + ' fail ===');
  if (failures.length) { console.log('失败项:\n - ' + failures.join('\n - ')); process.exit(1); }
  process.exit(0);
}
console.log('=== needsCredentials 升级路径 targeted test ===');
runNext();
