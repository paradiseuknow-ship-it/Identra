'use strict';
// Step 2-D Credential 分级回归：凭据安全门控行为验证。
// 预期：
//   login + credentialRef  → schema 接受 + policy AUTO（不升级）
//   login 无 credentialRef → schema 拒绝（SENSITIVE_FIELDS）→ 走 NO_VALUE→CREDENTIAL_MISSING
//   payment               → policy CRITICAL，需人工审批（不降级）
//   password_change       → policy CRITICAL，需人工审批
// 关键：不削弱 password 风险等级、不自动猜 credential、不把失败改 SUCCESS。
const { validateAction } = require('./server/agent/schema/action');
const policy = require('./server/agent/policy');
let ecClassify = null;
try { ecClassify = require('./server/agent/recovery/errorClassifier').classify; } catch (e) {}

let pass = 0, fail = 0;
const rows = [];
function check(name, cond, detail) {
  if (cond) { pass++; rows.push('✅ ' + name); }
  else { fail++; rows.push('❌ ' + name + ' :: ' + detail); }
}

// ---- Schema 层：敏感字段门控 ----
const noCred = validateAction({ type: 'fill', target: { field: 'password', semantic: '密码' } });
check('fill password 无 credentialRef → schema 拒绝', !noCred.ok, JSON.stringify(noCred.errors));

const litVal = validateAction({ type: 'fill', target: { field: 'password', semantic: '密码' }, value: 'secret123' });
check('fill password 用 value 字面量 → schema 拒绝（安全约束，禁止明文）', !litVal.ok, JSON.stringify(litVal.errors));

const withCred = validateAction({
  type: 'fill', target: { field: 'password', semantic: '密码' }, credentialRef: 'cred_x', verification: { type: 'element_present' },
});
check('fill password 带 credentialRef → schema 接受', withCred.ok, JSON.stringify(withCred.errors));

const loginCred = validateAction({
  type: 'login', target: { field: 'loginBtn', semantic: '登录按钮' }, credentialRef: 'cred_x', verification: { type: 'url_contains', expect: 'dashboard' },
});
check('login 带 credentialRef → schema 接受', loginCred.ok, JSON.stringify(loginCred.errors));

// ---- Policy 层：风险分级 ----
const taskAssist = { executionMode: 'ASSIST', policy: {}, approvedActions: [] };
const fillAct = { type: 'fill', target: { field: 'password', semantic: '密码' }, credentialRef: 'cred_x', risk: 'MEDIUM', verification: { type: 'element_present' } };
const pFill = policy.allowsAction(fillAct, taskAssist);
check('fill (MEDIUM) → 自动放行 AUTO（不升级）', pFill.allowed && !pFill.requiresApproval, JSON.stringify(pFill));

const payAct = { type: 'payment', target: { field: 'payBtn', semantic: '支付按钮' }, risk: 'CRITICAL', verification: { type: 'action_success' } };
const pPay = policy.allowsAction(payAct, taskAssist);
check('payment (CRITICAL) → 需人工审批（非 AUTO，不降级）', !pPay.allowed && pPay.requiresApproval, JSON.stringify(pPay));

const pcAct = { type: 'password_change', target: { field: 'pwBtn', semantic: '改密按钮' }, risk: 'CRITICAL', verification: { type: 'action_success' } };
const pPc = policy.allowsAction(pcAct, taskAssist);
check('password_change (CRITICAL) → 需人工审批', !pPc.allowed && pPc.requiresApproval, JSON.stringify(pPc));

// ---- 升级映射保持：NO_VALUE → CREDENTIAL_MISSING (HIGH) ----
if (ecClassify) {
  const cls = ecClassify({ code: 'NO_VALUE' });
  check('NO_VALUE → CREDENTIAL_MISSING (HIGH) 升级映射保持（不静默吞掉）', cls && cls.type === 'CREDENTIAL_MISSING', JSON.stringify(cls));
} else {
  rows.push('⚠️ errorClassifier 未加载，跳过映射断言（非阻塞）');
}

console.log('Step 2-D Credential 分级回归');
console.log('='.repeat(60));
rows.forEach((r) => console.log(r));
console.log('='.repeat(60));
console.log(`PASS: ${pass}  FAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
