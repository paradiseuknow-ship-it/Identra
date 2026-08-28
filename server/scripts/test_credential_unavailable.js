'use strict';

// Engineering Phase P1 — Credential UNAVAILABLE 流回归测试（零浏览器 / 零 store 污染）。
//
// 验证：
//   1) 当 action.credentialRef 已设置但凭据不可用（未注册 / vault 未解密 / 解析失败）时，
//      tools.credentialUnavailableError 返回 CREDENTIAL_UNAVAILABLE（而非泛化 NO_VALUE）。
//   2) 当凭据可用时返回 null（交由 resolveFillValue 正常取值，字段缺失才走 NO_VALUE）。
//   3) 无 credentialRef 时返回 null（不影响普通 fill）。
//   4) 错误文案不含任何明文凭据（安全约束）。
//   5) runtime.js 在 CREDENTIAL_UNAVAILABLE 时直送 escalate（人工），不进 repair 重试。

const fs = require('fs');
const path = require('path');
const tools = require('../agent/tools');
const secretManager = require('../agent/secretManager');
const runtimeSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'runtime.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n=== ' + name + ' ==='); }

// 保存原始实现，测试后还原（保持 suite 隔离）
const _getByRef = secretManager.getByRef;
const _resolve = secretManager.resolve;

function setCredentialState(state) {
  // state: 'unavailable' | 'available' | 'none'
  if (state === 'unavailable') {
    secretManager.getByRef = () => ({ id: 'c1', available: false });
    secretManager.resolve = () => null;
  } else if (state === 'available') {
    secretManager.getByRef = () => ({ id: 'c1', available: true });
    secretManager.resolve = () => ({ profileId: 'p1', type: 'email_password', secrets: { email: 'a@b.com', password: 'x' } });
  } else {
    secretManager.getByRef = () => null;
    secretManager.resolve = () => null;
  }
}

console.log('\n=== Engineering Phase P1: Credential UNAVAILABLE ===');

section('1) 凭据不可用 → CREDENTIAL_UNAVAILABLE');
{
  setCredentialState('unavailable');
  const r = tools.credentialUnavailableError({ credentialRef: 'c1' });
  ok(r && r.error && r.error.code === 'CREDENTIAL_UNAVAILABLE', 'credentialRef 不可用 → error.code=CREDENTIAL_UNAVAILABLE (got ' + (r && r.error && r.error.code) + ')');
  ok(r && typeof r.error.message === 'string' && !/password|email|@|\d{4}/.test(r.error.message), '错误文案不含明文凭据/邮箱/卡号片段（安全约束）');
}

section('2) 凭据可用 → null（正常取值路径）');
{
  setCredentialState('available');
  const r = tools.credentialUnavailableError({ credentialRef: 'c1' });
  ok(r === null, '凭据可用 → 返回 null（交由 resolveFillValue 取值，不误报 CREDENTIAL_UNAVAILABLE）');
}

section('3) 无 credentialRef → null（不影响普通 fill）');
{
  setCredentialState('none');
  const r = tools.credentialUnavailableError({ value: 'hello' });
  ok(r === null, '无 credentialRef → 返回 null（走普通 value / NO_VALUE 判定）');
}

section('4) runtime 路由：CREDENTIAL_UNAVAILABLE → escalate（人工，不进 repair）');
{
  const hasBranch = /errCode === 'CREDENTIAL_UNAVAILABLE'/.test(runtimeSrc) && /taskManager\.escalate\(task\.id,[\s\S]*?reason: 'CREDENTIAL_UNAVAILABLE'/.test(runtimeSrc);
  ok(hasBranch, 'runtime.js 在 CREDENTIAL_UNAVAILABLE 时直送 escalate（reason=CREDENTIAL_UNAVAILABLE），绕过 repair 重试');
}

// 还原
secretManager.getByRef = _getByRef;
secretManager.resolve = _resolve;

console.log('\n────────────────────────────────────────');
console.log('Credential UNAVAILABLE 测试：' + pass + ' passed, ' + fail + ' failed');
console.log('────────────────────────────────────────');
process.exit(fail === 0 ? 0 : 1);
