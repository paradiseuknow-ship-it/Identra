'use strict';
// Step 2 契约回归：target 对象必须贯穿「LLM 输出 → Schema 校验 → Planner 规范化 → Resolver 评分」。
// 直接验证用户的两个核心诉求：
//   (1) target 经过所有模块后仍未压扁成字符串（field 不丢失）
//   (2) verification 透传，绝不静默补 none；缺 verification 的 MUST_VERIFY 步骤被 Schema 拒绝
const { validatePlanStrict, normalizeStrictToCanonical } = require('./server/agent/schema/plan');
const resolver = require('./server/agent/semanticResolver');

function el(o) {
  return Object.assign({
    id: null, role: 'input', tag: 'input', type: 'text', name: null, cls: null,
    text: '', placeholder: null, label: null, ariaLabel: null, visible: true,
    innerText: '', roleText: '',
  }, o);
}
const obs = {
  url: 'http://x/login',
  elements: [
    el({ id: 'emailIn', name: 'email', type: 'email', placeholder: '邮箱', label: '邮箱' }),
    el({ id: 'pwIn', name: 'password', type: 'password', placeholder: '密码', label: '密码' }),
  ],
};

let pass = 0, fail = 0;
const rows = [];
function check(name, cond, detail) {
  if (cond) { pass++; rows.push('✅ ' + name); }
  else { fail++; rows.push('❌ ' + name + ' :: ' + detail); }
}

// ---- 模拟 DeepSeek 真实输出（双键 target + verification）----
const deepseekStep = {
  action: 'fill',
  target: { field: 'email', semantic: '邮箱' },
  semantic: '填写邮箱',
  expectedResult: '邮箱输入框已填',
  verification: { type: 'element_present' },
  credentialRef: 'cred_demo',
};
const vr = validatePlanStrict({ steps: [deepseekStep] });
check('DeepSeek 输出经 validatePlanStrict 通过', vr.ok, JSON.stringify(vr.errors));

if (vr.ok) {
  // Schema 层：target 仍对象 + 含 field
  check('validatePlanStrict 后 step.target 仍为对象且含 field=email',
    vr.plan.steps[0].target && typeof vr.plan.steps[0].target === 'object' && vr.plan.steps[0].target.field === 'email',
    JSON.stringify(vr.plan.steps[0].target));

  // Planner 规范化层：透传
  const canonical = normalizeStrictToCanonical({ steps: vr.plan.steps }, '登录任务');
  const act = canonical.steps[0].action;
  check('规范化后 action.target 仍含 field=email（未压扁为字符串）',
    act.target && typeof act.target === 'object' && act.target.field === 'email', JSON.stringify(act.target));
  check('规范化后 action.target.semantic=邮箱 仍在', act.target && act.target.semantic === '邮箱', JSON.stringify(act.target));
  check('verification 透传（type=element_present，非 none）',
    act.verification && act.verification.type === 'element_present', JSON.stringify(act.verification));

  // Resolver 层：把 action.target 直接喂给 resolver（模拟 tools.js resolveSelector）
  const cands = resolver.resolve(act.target, obs);
  check('resolver 收到完整 target 并命中 emailIn', cands[0] && cands[0].elementId === 'emailIn', cands[0] && cands[0].elementId);
  check('resolver 评分理由含 field 信号（证明 field 参与评分）',
    cands[0] && /field/.test(cands[0].reason), cands[0] && cands[0].reason);
}

// ---- 反向：缺 verification 的 MUST_VERIFY 步骤必须被 Schema 拒绝（杜绝自动补 none）----
const badStep = {
  action: 'fill',
  target: { field: 'email', semantic: '邮箱' },
  semantic: '填写邮箱',
  expectedResult: '邮箱输入框已填',
  // 故意缺 verification
};
const vr2 = validatePlanStrict({ steps: [badStep] });
check('缺 verification 的 fill 步骤被 validatePlanStrict 拒绝（不静默补 none）',
  !vr2.ok && /verification/i.test((vr2.errors || []).join(' ')), JSON.stringify(vr2.errors));

console.log('Step 2 契约回归：target 贯穿 + verification 透传');
console.log('='.repeat(60));
rows.forEach((r) => console.log(r));
console.log('='.repeat(60));
console.log(`PASS: ${pass}  FAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
