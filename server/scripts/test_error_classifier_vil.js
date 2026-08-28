'use strict';

// P5（Phase 2 ErrorClassifier 对齐）测试：VIL 验证层 failureType 与 errorClassifier 类别字典闭合。
// 不触碰 classify()（动作层 error.code 分类）与 STRATEGY_FOR_CATEGORY（retry 策略映射）。

const ec = require('../agent/recovery/errorClassifier');
const vil = require('../agent/verification/verificationIntelligence');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; fails.push(msg); console.log('  ✗ FAIL: ' + msg); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// VIL 全量 failureType（除 SUCCESS 外，VIL 只产出失败/中间态类）
const VIL_TYPES = [
  'EVENTUAL_CONSISTENCY', 'OBSERVATION_DELAY', 'VERIFICATION_TOO_STRICT',
  'ACTION_REAL_FAILURE', 'STATE_UNKNOWN', 'DOM_CHANGED', 'SUBMIT_RESULT_UNKNOWN', 'ASYNC_PENDING',
];

section('P5.1 classifyVerificationFailure 映射正确');
for (const t of VIL_TYPES) {
  const r = ec.classifyVerificationFailure(t);
  ok(r.category === t, t + ' → category=' + t);
  ok(r.recognized === true, t + ' → recognized=true');
  ok(typeof r.confidence === 'number' && r.confidence > 0, t + ' → confidence=' + r.confidence);
  ok(Array.isArray(r.evidence) && r.evidence.length >= 1, t + ' → evidence 非空');
}

section('P5.2 敏感动作标记');
{
  const r = ec.classifyVerificationFailure('ASYNC_PENDING', { isSensitive: true });
  ok(r.sensitive === true, 'sensitive=true');
  ok(r.evidence.join('').includes('仅升级人工'), '证据含「仅升级人工」提示（不自动操作）');
}

section('P5.3 未登记类型 → recognized=false（不静默误判）');
{
  const r = ec.classifyVerificationFailure('SOME_FUTURE_TYPE');
  ok(r.recognized === false, '未登记类型 recognized=false');
  ok(r.category === 'SOME_FUTURE_TYPE', '原样透传类别');
}

section('P5.4 类别字典闭合：RECOVERY_CATEGORIES 覆盖 VIL 全量类型');
for (const t of VIL_TYPES) {
  ok(ec.RECOVERY_CATEGORIES.includes(t), 'RECOVERY_CATEGORIES 含 ' + t);
}
ok(ec.RECOVERY_CATEGORIES.includes('ELEMENT_NOT_FOUND'), '原有动作层类别仍保留');
ok(ec.RECOVERY_CATEGORIES.includes('VERIFICATION_FAILED'), '原有验证失败类别仍保留');

section('P5.5 classify()（动作层）行为未被破坏');
{
  const C = (err) => ec.classify(err).type;
  ok(C({ code: 'ELEMENT_NOT_FOUND' }) === 'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_FOUND 仍正确');
  ok(C({ code: 'VERIFY_FAILED' }) === 'VERIFICATION_FAILED', 'VERIFICATION_FAILED 仍正确');
  ok(C({ code: 'X', message: 'random noise' }) === 'UNKNOWN', 'unknown 仍正确');
}

console.log('\n==== 结果：' + pass + ' passed, ' + fail + ' failed ====');
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
