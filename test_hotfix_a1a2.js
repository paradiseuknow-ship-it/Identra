'use strict';
// Phase 8.1 Hotfix 回归测试：A1 schema field:null + A2 repair attribution
// 运行：node test_hotfix_a1a2.js

const assert = require('assert');
const { validateAction } = require('./server/agent/schema/action');
const { validatePlanStrict } = require('./server/agent/schema/plan');
const { reconcileRepair } = require('./server/agent/repair/repairAttempts');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  \u2705 ' + name); }
  catch (e) { fail++; console.log('  \u274c ' + name + ' :: ' + e.message); }
}

console.log('=== A1: schema field:null 不再 reject ===');

// A1-1: DeepSeek 合法 target {field:null, semantic} 应通过
test('A1 field:null + semantic PASS', () => {
  const a = {
    type: 'fill',
    target: { field: null, semantic: '邮箱' },
    value: { credentialRef: 'user.email' },
    verification: { type: 'element_present' },
  };
  const r = validateAction(a);
  assert.ok(r.ok, 'field:null 不应导致拒绝: ' + JSON.stringify(r.errors));
});

// A1-2: 经 validatePlanStrict 整计划也通过（双键 target 保留）
test('A1 field:null 经 validatePlanStrict PASS', () => {
  const plan = {
    objective: '登录',
    steps: [{
      action: 'fill',
      target: { field: null, semantic: '密码' },
      semantic: '填写密码',
      expectedResult: '密码框已填充',
      credentialRef: 'user.pwd',
      verification: { type: 'element_present' },
    }],
  };
  const r = validatePlanStrict(plan);
  assert.ok(r.ok, 'validatePlanStrict 应接受 field:null: ' + JSON.stringify(r.errors));
});

// A1-3: field:"" 空串同样视为未提供，通过
test('A1 field:"" PASS', () => {
  const r = validateAction({ type: 'click', target: { field: '', semantic: '搜索按钮' }, verification: { type: 'element_present' } });
  assert.ok(r.ok, 'field:"" 不应拒绝: ' + JSON.stringify(r.errors));
});

// A1-4: 仍保留 target object（field:null 不丢失）
test('A1 target object 保留 field 键', () => {
  const a = { type: 'click', target: { field: null, semantic: '提交' }, verification: { type: 'element_present' } };
  validateAction(a);
  assert.strictEqual(a.target.field, null, 'target.field 应保留为 null');
  assert.strictEqual(a.target.semantic, '提交');
});

console.log('=== A1: 安全/强校验不降低 ===');

// A1-5: 非法 type 仍 FAIL
test('A1 非法 action type 仍 FAIL', () => {
  const r = validateAction({ type: 'explode', target: { semantic: 'x' } });
  assert.ok(!r.ok, '非法 type 必须拒绝');
});

// A1-6: MUST_VERIFY 动作缺 verification 仍 FAIL（强校验保留）
test('A1 click 缺 verification 仍 FAIL', () => {
  const r = validateAction({ type: 'click', target: { semantic: '按钮' } });
  assert.ok(!r.ok, '缺 verification 的 click 必须拒绝');
});

// A1-7: 敏感字段明文 value 仍 FAIL（安全校验保留）
test('A1 fill password 明文 value 仍 FAIL', () => {
  const r = validateAction({
    type: 'fill',
    target: { field: 'password', semantic: '密码' },
    value: 'secret123',
    verification: { type: 'element_present' },
  });
  assert.ok(!r.ok, '敏感字段明文 value 必须拒绝');
});

// A1-8: field 为非字符串有值（如数字）仍判非法
test('A1 field:123 仍 FAIL', () => {
  const r = validateAction({ type: 'click', target: { field: 123, semantic: 'x' }, verification: { type: 'element_present' } });
  assert.ok(!r.ok, 'field 为非字符串应拒绝');
});

console.log('=== A2: repair attribution ===');

// A2-1: FAILED repair + 后续 SUCCESS attempt → SUCCESS + 绑定 repairId
test('A2 FAILED repair + SUCCESS retry → SUCCESS 并绑定', () => {
  const repair = { repairId: 'rp_1', status: 'FAILED', createdAt: 1000 };
  const attempts = [
    { id: 'a1', status: 'FAILED', startedAt: 900 },
    { id: 'a2', status: 'SUCCESS', startedAt: 1200 }, // repair 之后成功
  ];
  const r = reconcileRepair(repair, attempts);
  assert.strictEqual(r.status, 'SUCCESS', '应归因为 SUCCESS');
  assert.strictEqual(r.repairId, 'rp_1');
  assert.deepStrictEqual(r.attributedAttemptIds, ['a2']);
});

// A2-2: FAILED repair + 无后续 SUCCESS → 保持 FAILED
test('A2 FAILED repair 无 SUCCESS retry → 保持 FAILED', () => {
  const repair = { repairId: 'rp_2', status: 'FAILED', createdAt: 1000 };
  const attempts = [
    { id: 'a1', status: 'FAILED', startedAt: 1100 },
    { id: 'a2', status: 'FAILED', startedAt: 1300 },
  ];
  const r = reconcileRepair(repair, attempts);
  assert.strictEqual(r.status, 'FAILED');
  assert.strictEqual(r.attributedAttemptIds.length, 0);
});

// A2-3: 已是 SUCCESS 的 repair 不被覆盖
test('A2 已 SUCCESS repair 不被重算', () => {
  const repair = { repairId: 'rp_3', status: 'SUCCESS', createdAt: 1000 };
  const r = reconcileRepair(repair, [{ id: 'a9', status: 'SUCCESS', startedAt: 2000 }]);
  assert.strictEqual(r.status, 'SUCCESS');
  assert.strictEqual(r.attributedAttemptIds.length, 0);
});

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
