'use strict';

// STEP 0.5 安全基线 + STEP 1 §7 Payment Policy 语义 —— 回归测试。
//
// 覆盖四项此前被 STEP 0 审计证实的高危问题：
//   1. 路径穿越（evidence.filePath 零校验 → 配合 sendFile 可远程读任意文件）
//   2. 匿名访问（所有 /api/* 无身份边界）
//   3. 脱敏失效（页内正则的反斜杠被模板字面量当转义序列吃掉 → 卡号/密码/CVV/Bearer
//      原样进入 observation 与 LLM 上下文）
//   4. Payment Policy 越权（autoPayment 可放行 delete / password_change）
//
// 设计原则：这里断言的是「不可再退化」的性质。任何一项翻转都意味着安全基线被破坏。

const assert = require('assert');
const path = require('path');

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' —— ' + e.message);
    console.log('  ✗ ' + name);
    console.log('      ' + String(e.message).split('\n')[0]);
  }
}

function fresh(modPath) {
  const abs = require.resolve(modPath);
  delete require.cache[abs];
  return require(abs);
}

// ------------------------------------------------------------------ §1 路径安全
console.log('\n§1 路径安全（safePath / evidence.filePath）');

const safePath = require('../security/safePath');

test('安全段名放行', () => {
  assert.strictEqual(safePath.assertSafeName('task-123'), 'task-123');
  assert.strictEqual(safePath.assertSafeName('a.png'), 'a.png');
  assert.strictEqual(safePath.isSafeName('p_abc123'), true);
});

test('穿越段名一律拒绝（../、绝对段、盘符、UNC、点段）', () => {
  for (const bad of ['..', '.', '../..', 'a/../../b', '/etc/passwd', 'C:\\windows', '\\\\host\\share', 'a\\b']) {
    assert.strictEqual(safePath.isSafeName(bad), false, `不应通过: ${bad}`);
  }
});

test('assertSafeName 抛错带 statusCode=400（供路由转 400 而非 500）', () => {
  try {
    safePath.assertSafeName('../evil');
    throw new Error('应当抛错却没有');
  } catch (e) {
    assert.strictEqual(e.statusCode, 400);
    assert.strictEqual(e.code, 'UNSAFE_PATH_SEGMENT');
  }
});

test('resolveWithin 阻断 ../ 逃逸', () => {
  const root = path.join(__dirname, '..', '..', 'data');
  assert.throws(() => safePath.resolveWithin(root, '..', '..', 'package.json'), /路径逃逸/);
  // 正常路径可解析
  const ok = safePath.resolveWithin(root, 'evidence', 'x.png');
  assert.ok(ok.startsWith(path.resolve(root)));
});

test('sanitizeSegment 把非法字符规整为安全名（写入侧不抛错）', () => {
  assert.strictEqual(safePath.sanitizeSegment('step 中文'), 'step');
  assert.strictEqual(safePath.sanitizeSegment('before_action'), 'before_action');
  for (const bad of ['../../etc', '..', 'a/b\\c', 'C:\\windows', '   ']) {
    const out = safePath.sanitizeSegment(bad);
    assert.ok(safePath.isSafeName(out), '规整后必须是安全名: ' + JSON.stringify(bad) + ' -> ' + out);
  }
});

const evidence = require('../agent/evidence');

test('evidence.filePath 拒绝 taskId 穿越（此前 path.join 不阻挡）', () => {
  assert.throws(() => evidence.filePath('../../..', 'package.json'), /不安全的路径段|路径逃逸/);
});

test('evidence.filePath 拒绝 file 穿越', () => {
  assert.throws(() => evidence.filePath('task-1', '../../../package.json'), /不安全的路径段|路径逃逸/);
});

test('evidence.filePath 正常路径仍可解析到快照目录内', () => {
  const p = evidence.filePath('task-1', 's1_before_123.png');
  assert.ok(p.startsWith(evidence.SNAP_DIR), '解析结果必须位于快照根目录内');
});

test('evidence.listForTask 拒绝 taskId 穿越（此前可列遍任意目录）', () => {
  assert.throws(() => evidence.listForTask('../../..'), /不安全的路径段|路径逃逸/);
});

// ------------------------------------------------------------------ §2 身份边界
console.log('\n§2 身份边界（auth）');

function mockReq(over) {
  const o = over || {};
  return {
    path: o.path || '/api/browser/list',
    baseUrl: '',
    headers: o.headers || {},
    query: o.query || {},
    socket: { remoteAddress: o.ip || '127.0.0.1' },
  };
}
function mockRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('本地模式：loopback 放行', () => {
  delete process.env.FPB_API_TOKEN;
  const auth = fresh('../auth');
  const res = mockRes();
  let nexted = false;
  auth.requireAuth(mockReq({ ip: '127.0.0.1' }), res, () => { nexted = true; });
  assert.strictEqual(nexted, true, 'loopback 应放行');
});

test('本地模式：非 loopback 一律 403（此前匿名可访问）', () => {
  delete process.env.FPB_API_TOKEN;
  const auth = fresh('../auth');
  const res = mockRes();
  let nexted = false;
  auth.requireAuth(mockReq({ ip: '203.0.113.9' }), res, () => { nexted = true; });
  assert.strictEqual(nexted, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'FORBIDDEN');
});

test('token 模式：无 token 一律 401（含 loopback）', () => {
  process.env.FPB_API_TOKEN = 'unit-test-token';
  const auth = fresh('../auth');
  const res = mockRes();
  let nexted = false;
  auth.requireAuth(mockReq({ ip: '127.0.0.1' }), res, () => { nexted = true; });
  assert.strictEqual(nexted, false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error, 'UNAUTHORIZED');
  delete process.env.FPB_API_TOKEN;
});

test('token 模式：Bearer / x-fpb-token / ?token= 三种承载方式均生效（SSE 需 query）', () => {
  process.env.FPB_API_TOKEN = 'unit-test-token';
  const auth = fresh('../auth');
  for (const shape of [
    { headers: { authorization: 'Bearer unit-test-token' } },
    { headers: { 'x-fpb-token': 'unit-test-token' } },
    { query: { token: 'unit-test-token' } },
  ]) {
    const res = mockRes();
    let nexted = false;
    auth.requireAuth(mockReq(shape), res, () => { nexted = true; });
    assert.strictEqual(nexted, true, '应放行的承载方式: ' + JSON.stringify(shape));
  }
  delete process.env.FPB_API_TOKEN;
});

test('token 模式：错误 token 拒绝', () => {
  process.env.FPB_API_TOKEN = 'unit-test-token';
  const auth = fresh('../auth');
  const res = mockRes();
  let nexted = false;
  auth.requireAuth(mockReq({ headers: { authorization: 'Bearer wrong-token' } }), res, () => { nexted = true; });
  assert.strictEqual(nexted, false);
  assert.strictEqual(res.statusCode, 401);
  delete process.env.FPB_API_TOKEN;
});

test('启动自检：匿名 + 绑定 0.0.0.0 = 非法组合（阻断匿名生产 API）', () => {
  delete process.env.FPB_API_TOKEN;
  const auth = fresh('../auth');
  const problems = auth.assertStartupSecurity({ bind: '0.0.0.0', corsWildcard: false });
  assert.ok(problems.length >= 1, '必须报出问题');
  assert.ok(/FPB_API_TOKEN/.test(problems[0]));
});

test('启动自检：本机绑定 + 无 token = 合法（单机主形态）', () => {
  delete process.env.FPB_API_TOKEN;
  const auth = fresh('../auth');
  assert.deepStrictEqual(auth.assertStartupSecurity({ bind: '127.0.0.1', corsWildcard: false }), []);
});

test('启动自检：token + 对外绑定 = 合法（共享部署形态）', () => {
  process.env.FPB_API_TOKEN = 'unit-test-token';
  const auth = fresh('../auth');
  assert.deepStrictEqual(auth.assertStartupSecurity({ bind: '0.0.0.0', corsWildcard: false }), []);
  delete process.env.FPB_API_TOKEN;
});

// ------------------------------------------------------------------ §3 脱敏
console.log('\n§3 敏感数据脱敏（observation.redact）');

function loadRedact() {
  // 从**模板字面量求值之后**的页内脚本里抽取，而不是从源码文件里抽取。
  //
  // 早前这里直接 readFileSync 源码再 eval —— 那会跳过模板字面量的转义处理：
  // 源码里写 \s，页内实际生效的是字母 s；而 eval 源码时却是正确的 \s。
  // 于是「源码看起来对 / 测试全绿」与「页内实际失效」可以同时成立 —— 观察层脱敏
  // 的 4/5 条规则因此长期失效却无人发现（2026-08-29 取证）。
  // 断言对象必须是**真正会在浏览器里执行的那份文本**。
  const src = require('../agent/observation').COLLECT_JS;
  const m = src.match(/const redact = \(s\) =>[\s\S]*?REDACTED'\);/);
  if (!m) throw new Error('未能从 COLLECT_JS（页内生效脚本）提取 redact 定义');
  // eslint-disable-next-line no-eval
  return eval(m[0].replace(/^const redact = /, ''));
}

test('脱敏规则在页内生效脚本里真实可用（模板字符串转义陷阱）', () => {
  const redact = loadRedact();
  assert.ok(!redact('password=abc123').includes('abc123'), '密码必须被脱敏');
  assert.ok(!redact('card 4111 1111 1111 1111').includes('4111'), '卡号必须被脱敏');
  assert.ok(!redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abc').includes('eyJhbGci'), 'Bearer 必须被脱敏');
  assert.ok(/REDACTED/.test(redact('cvc 123')), 'CVV（词在前）必须被脱敏');
});

test('卡号 / CVV / API key / session / Bearer 一律脱敏', () => {
  const redact = loadRedact();
  const cases = [
    ['password=Secret123', 'Secret123'],
    ['card 4111 1111 1111 1111 end', '4111'],
    ['amex 3782 822463 10005', '3782'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc', 'eyJhbGci'],
    ['session=abc123xyz', 'abc123xyz'],
    ['cookie: sid=9f8e7d6c5b', '9f8e7d6c5b'],
    ['api_key=sk_live_zzz', 'sk_live_zzz'],
    ['cvv 456 cvv', '456'],
  ];
  for (const [input, secret] of cases) {
    const out = redact(input);
    assert.ok(!out.includes(secret), `敏感值泄漏: ${input} -> ${out}`);
  }
});

test('正常业务文本不被误伤（高信息密度要求）', () => {
  const redact = loadRedact();
  assert.strictEqual(redact('欢迎来到我们的商店，今日共 128 件商品'), '欢迎来到我们的商店，今日共 128 件商品');
  assert.strictEqual(redact('Order total 89.50 USD'), 'Order total 89.50 USD');
});

// ------------------------------------------------------------------ §4 Payment Policy
console.log('\n§4 Payment Policy 语义（STEP 1 §7）');

const prevNodeEnv = process.env.NODE_ENV;
const prevAutopay = process.env.FPB_ALLOW_AUTOPAY;
process.env.NODE_ENV = 'test'; // autoPaymentAllowed 需要测试环境标记
delete process.env.FPB_ALLOW_AUTOPAY;
const policy = fresh('../agent/policy');

const autopayTask = { executionMode: 'AUTONOMOUS', policy: { autoPayment: true, riskFloor: 'MEDIUM' } };

test('autoPayment 放行支付动作 purchase / payment', () => {
  for (const t of ['purchase', 'payment']) {
    const r = policy.allowsAction({ type: t, target: { semantic: 'x' } }, autopayTask);
    assert.strictEqual(r.allowed, true, t + ' 应被 autoPayment 放行');
    assert.strictEqual(r.requiresApproval, false);
  }
});

test('autoPayment 绝不越权放行 delete（此前 PAYMENT_TYPES 含 delete）', () => {
  const r = policy.allowsAction({ type: 'delete', target: { semantic: 'x' } }, autopayTask);
  assert.strictEqual(r.allowed, false, 'delete 不得因 autoPayment 自动执行');
  assert.strictEqual(r.requiresApproval, true);
  assert.ok(/DESTRUCTIVE/.test(r.reason));
});

test('autoPayment 绝不越权放行 password_change（此前 PAYMENT_TYPES 含 password_change）', () => {
  const r = policy.allowsAction({ type: 'password_change', target: { semantic: 'x' } }, autopayTask);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.requiresApproval, true);
  assert.ok(/ACCOUNT_SECURITY/.test(r.reason));
});

test('autoPayment 不越权放行 update_account_settings', () => {
  const r = policy.allowsAction({ type: 'update_account_settings', target: { semantic: 'x' } }, autopayTask);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.requiresApproval, true);
});

test('未开 autoPayment 时，支付动作按风险门禁判定（默认 riskFloor=MEDIUM → 需审批）', () => {
  const noAutopay = { executionMode: 'AUTONOMOUS', policy: { riskFloor: 'MEDIUM' } };
  const r = policy.allowsAction({ type: 'purchase', target: { semantic: 'x' } }, noAutopay);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.requiresApproval, true);
  assert.ok(/riskFloor/.test(r.reason));
});

test('AUTONOMOUS + riskFloor=HIGH 仍不放行 payment（CRITICAL 不受 riskFloor 提升影响）', () => {
  const highFloor = { executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' } };
  const r = policy.allowsAction({ type: 'payment', target: { semantic: 'x' } }, highFloor);
  assert.strictEqual(r.allowed, false, 'CRITICAL 动作不得因 riskFloor 提升而自动执行');
  assert.ok(/CRITICAL/.test(r.reason));
});

test('能力分类正确（autoPayment 只认 PAYMENT）', () => {
  assert.strictEqual(policy.capabilityOf('purchase'), 'PAYMENT');
  assert.strictEqual(policy.capabilityOf('payment'), 'PAYMENT');
  assert.strictEqual(policy.capabilityOf('delete'), 'DESTRUCTIVE');
  assert.strictEqual(policy.capabilityOf('password_change'), 'ACCOUNT_SECURITY');
  assert.strictEqual(policy.capabilityOf('update_account_settings'), 'ACCOUNT_SECURITY');
  assert.strictEqual(policy.capabilityOf('click'), 'GENERAL');
});

test('人工审批仍可放行破坏性动作（不阻塞正当业务）', () => {
  const approved = {
    executionMode: 'AUTONOMOUS',
    policy: { autoPayment: true, riskFloor: 'MEDIUM' },
    approvedActions: [{ type: 'delete', semantic: '删除账号' }],
  };
  const r = policy.allowsAction({ type: 'delete', target: { semantic: '删除账号' } }, approved);
  assert.strictEqual(r.allowed, true, '已人工审批的 delete 应放行');
});

test('SIMULATION 模式依旧禁止一切动作类', () => {
  const sim = { executionMode: 'SIMULATION', policy: {} };
  for (const t of ['click', 'fill', 'purchase', 'delete']) {
    const r = policy.allowsAction({ type: t, target: { semantic: 'x' } }, sim);
    assert.strictEqual(r.allowed, false, t + ' 在 SIMULATION 下必须被拒');
  }
});

process.env.NODE_ENV = prevNodeEnv;
if (prevAutopay !== undefined) process.env.FPB_ALLOW_AUTOPAY = prevAutopay;

// ------------------------------------------------------------------ 汇总
console.log('\n' + '='.repeat(60));
console.log(`PASS=${pass} FAIL=${fail}`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
