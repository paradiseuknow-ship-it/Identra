'use strict';

// P2 Verification Invalid-Evidence Guard — 针对性回归测试
//
// 背景（2026-08-31 run6 实证）：
//   mock 登录页 /saas/login.html 上，任务声明 url_contains "saas" —— 条件在动作前已成立，
//   错误凭据也被判 SUCCESS（假阳性）；另一任务 url_contains "dashboard" 但登录成功 URL 不变
//   （该条件永远无法成立，真实成功也会被误判失败）。
//
// 修复内容（本测试锁定的契约）：
//   1. verify() 的 url_contains / url_pattern：条件在 before 观察中已成立 → 无效证据，
//      判失败（invalidEvidence=precondition_true），evidence 说明原因。
//   2. 真实变化（before 不含、after 含）仍按原语义成功 —— 不降低门槛、不放水。
//   3. before 缺失（首步 navigate）保持既有行为。
//   4. 合约路径（evaluateContract 经 verify 回调）同样被守卫覆盖；
//      OR 逻辑下其它真实证据仍可独立证明成功。
//   5. 文本/element 业务证据按现有 contract 工作；正确登录与错误登录产生不同结果。
//
// 纪律：不 mock 引擎 —— 只构造真实形状的观察对象作为输入；
//       不改 Success Definition / benchmark / Runtime 语义。

const assert = require('assert');
const verification = require('../agent/verification');
const { verify, contract } = verification;

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

function runSuite(tag) {
  console.log('=== suite ' + tag + ' ===');

  // ---- 1. url_contains 恒真守卫 ----
  check('url_contains: before 已含 expect → 无效证据，判失败', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '邮箱或密码错误', elements: [] };
    const r = verify({ type: 'url_contains', expect: 'saas' }, after, before);
    assert.strictEqual(r.success, false, '恒真证据不得判成功');
    assert.strictEqual(r.invalidEvidence, 'precondition_true');
    assert.ok(r.evidence.join(' ').indexOf('动作执行前已成立') >= 0, 'evidence 应说明恒真原因');
  });

  check('url_contains: 真实变化（before 不含、after 含）→ 成功', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/dashboard.html', textSummary: '工作台', elements: [] };
    const r = verify({ type: 'url_contains', expect: 'dashboard' }, after, before);
    assert.strictEqual(r.success, true, '真实 URL 变化证据必须保持原语义成功');
    assert.strictEqual(r.invalidEvidence, undefined);
  });

  check('url_contains: after 不含 expect → 原失败语义不变', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const r = verify({ type: 'url_contains', expect: 'dashboard' }, after, before);
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.invalidEvidence, undefined);
  });

  check('url_contains: 无 before（首步）→ 保持既有行为', () => {
    const after = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const r = verify({ type: 'url_contains', expect: 'saas' }, after, undefined);
    assert.strictEqual(r.success, true, '无 before 无法判恒真，保持既有行为');
    assert.strictEqual(r.invalidEvidence, undefined);
  });

  // ---- 2. url_pattern 恒真守卫 ----
  check('url_pattern: before 已匹配 → 无效证据，判失败', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '错误', elements: [] };
    const r = verify({ type: 'url_pattern', pattern: '/saas/' }, after, before);
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.invalidEvidence, 'precondition_true');
  });

  check('url_pattern: 真实变化 → 成功', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/dashboard', textSummary: '工作台', elements: [] };
    const r = verify({ type: 'url_pattern', pattern: '/dashboard$' }, after, before);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.invalidEvidence, undefined);
  });

  // ---- 3. 合约路径覆盖（evaluateContract 经 verify 回调 = verification.js 实际调用方式）----
  check('contract: 单一恒真 url_contains 子句（AND）→ 契约失败', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const c = {
      stateType: 'LOGIN_SUCCESS', expected: '登录成功',
      requiredEvidence: [{ type: 'url_contains', expect: 'saas' }],
      forbiddenEvidence: [], evidenceLogic: 'AND',
    };
    const r = contract.evaluateContract(c, after, before, verify);
    assert.strictEqual(r.success, false, '恒真子句不得证明业务成功');
    assert.ok(r.evidence.join(' ').indexOf('动作执行前已成立') >= 0);
  });

  check('contract: OR 逻辑下恒真子句不加分，其它真实证据仍可独立证明', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录 Please sign in', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录成功 welcome back，Welcome，ops@cloudsaas.io', elements: [] };
    const c = {
      stateType: 'LOGIN_SUCCESS', expected: '登录成功',
      requiredEvidence: [
        { type: 'url_contains', expect: 'saas' },        // 恒真 → 守卫判失败，不加分
        { type: 'text_present', expect: 'welcome back' }, // 真实业务文本证据
      ],
      forbiddenEvidence: [],
      evidenceLogic: 'OR',
    };
    const r = contract.evaluateContract(c, after, before, verify);
    assert.strictEqual(r.success, true, 'OR 下真实证据仍应成立: ' + JSON.stringify(r.evidence));
    assert.strictEqual(r.passed, 1, '恒真子句不得计入 passed');
  });

  // ---- 4. 正确登录 vs 错误登录必须产生不同结果（login 推导合约，真实引擎）----
  check('contract: 正确登录（dashboard 文本 + page_change）→ LOGIN_SUCCESS', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '企业工作台 登录 Please sign in', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/dashboard.html', textSummary: '工作台 welcome 项目概览', elements: [] };
    // login 的推导合约（contract.deriveContract('login')）：多信号 OR + forbidden
    const c = contract.deriveContract({ type: 'login' });
    const r = contract.evaluateContract(c, after, before, verify);
    assert.strictEqual(r.success, true, '正确登录应达成业务合约: ' + JSON.stringify(r.evidence));
  });

  check('contract: 错误登录（invalid 错误文案）→ forbidden 硬失败', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录 Please sign in', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录 Invalid email or password', elements: [] };
    const c = contract.deriveContract({ type: 'login' });
    const r = contract.evaluateContract(c, after, before, verify);
    assert.strictEqual(r.success, false, '错误登录必须失败');
    assert.ok(r.forbiddenHit, '应命中 forbiddenEvidence');
  });

  check('contract: 错误登录 + 恒真 url_contains 兜底也不得救回（假阳性关闭）', () => {
    // run6 rw.005 形态：错误凭据 + 恒真 URL 条件 —— 修复前会被判 SUCCESS
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录 Please sign in', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录 Invalid email or password', elements: [] };
    const c = {
      stateType: 'LOGIN_SUCCESS', expected: '登录成功',
      requiredEvidence: [{ type: 'url_contains', expect: 'saas' }],
      forbiddenEvidence: [],
      evidenceLogic: 'OR',
    };
    const r = contract.evaluateContract(c, after, before, verify);
    assert.strictEqual(r.success, false, '恒真子句是唯一证据时，错误登录不得判成功');
  });

  // ---- 5. 文本/element 证据按现有 contract 工作（不受守卫影响）----
  check('text_present / element_present 语义不变', () => {
    const after = { url: 'http://127.0.0.1:PORT0/saas/dashboard.html', textSummary: '工作台 welcome', elements: [{ text: '项目概览', role: 'heading' }] };
    assert.strictEqual(verify({ type: 'text_present', expect: 'welcome' }, after, null).success, true);
    assert.strictEqual(verify({ type: 'text_present', expect: 'not-exist-text' }, after, null).success, false);
    assert.strictEqual(verify({ type: 'element_present', expect: '项目概览' }, after, null).success, true);
  });

  check('page_change 既有 before 语义不变', () => {
    const before = { url: 'http://127.0.0.1:PORT0/saas/login.html', textSummary: '登录', elements: [] };
    const after = { url: 'http://127.0.0.1:PORT0/saas/dashboard.html', textSummary: '工作台', elements: [] };
    assert.strictEqual(verify({ type: 'page_change' }, after, before).success, true);
    assert.strictEqual(verify({ type: 'page_change' }, before, before).success, false);
  });

  // ---- 6. planner prompt 引导（求值后字符串）----
  check('planner prompt: url_contains 引导要求 expect 为动作前不存在的片段', () => {
    const planner = require('../agent/planner');
    const s = planner.plannerInstructions();
    assert.ok(s.indexOf('动作执行前 URL 中不存在的片段') >= 0, '应含 url_contains 恒真引导');
    assert.ok(s.indexOf('不得在动作前已匹配') >= 0, '应含 url_pattern 恒真引导');
  });
}

runSuite('run-1');
runSuite('run-2');

console.log('');
console.log('=== P2 Verification Invalid-Evidence Guard: ' + pass + ' passed, ' + fail + ' failed ===');
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
