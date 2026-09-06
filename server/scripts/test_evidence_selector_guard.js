'use strict';

// Fix A：element 证据 expect 的 CSS 形态语法守卫 — 针对性回归测试
//
// 背景（Final100 P2 taxonomy A3）：LLM 臆造非法 CSS 形态（rw.065 `id=regForm` 缺 #/
// 前缀）作为 element_present expect → 执行期语义匹配必然落空 → VERIFY_FAILED。
// 守卫契约（本测试锁定）：
//   1. 「长得像 CSS」的 element_present/element_absent expect 必须通过保守 CSS 语法校验
//      （validatePlanStrict 层拒绝 → planner 重试 hint 自动携带该错误）。
//   2. 语义中文 expect 完全不受限（semanticResolver 合法路径）——守卫不能一刀切禁 CJK。
//   3. [attr='值'] 属性值内允许非 ASCII（[aria-label='商品列表'] 合法）。
//   4. ' >> ' 跨 frame 前缀逐段校验（与 tools.makeLocator 同一寻址方案）。
//   5. 三处 prompt 同源：schema PLAN_STRICT_INSTRUCTIONS + planner ACTION_CONSTRAINTS
//      均含 element 证据 expect 契约文本（断言求值后字符串，不 eval 源码）。
//
// 纪律：只收紧（新增拒绝路径），不放宽任何既有校验；不触碰验证语义/Success Definition。

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-css-guard-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const plan = require('../agent/schema/plan');
const schemaAction = require('../agent/schema/action');
const { looksLikeCss } = require('../agent/selectorFallback');
const plannerMod = require('../agent/planner');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}

// 构造最小合法 strict step（通过既有全部校验），仅替换 element 证据 expect
function stepWith(expect, opts = {}) {
  const v = opts.verificationType ? { type: opts.verificationType, expect }
    : { type: 'element_present', expect };
  const s = {
    action: 'click',
    target: { field: 'submitBtn', semantic: '提交按钮' },
    semantic: '点击提交按钮',
    expectedResult: '表单已提交',
    verification: opts.noVerification ? undefined : v,
    expectedBusinessState: {
      stateType: 'FORM_SUBMIT_SUCCESS',
      expected: '提交成功',
      requiredEvidence: opts.requiredEvidence !== undefined ? opts.requiredEvidence : [{ type: 'text_present', expect: '成功' }],
      forbiddenEvidence: opts.forbiddenEvidence !== undefined ? opts.forbiddenEvidence : [{ type: 'text_present', expect: '错误' }],
    },
  };
  if (opts.ebsRequired !== undefined) s.expectedBusinessState.requiredEvidence = opts.ebsRequired;
  return s;
}

function errsOf(step) {
  const r = plan.validatePlanStrict({ goal: 'g', steps: [step] });
  return { ok: r.ok, errors: r.errors || [] };
}

(async () => {
  console.log('== A. 非法 CSS 形态必须拒绝 ==');

  const rejects = [
    ['A1 id=regForm（rw.065 实证形态，缺 # 前缀）', 'id=regForm'],
    ['A2 class=foo（裸等号）', 'class=foo'],
    ['A3 括号不平衡', "input[name='q"],
    ['A4 属性名含 CJK（括号外无 CJK 豁免）', 'div[中文]'],
    ['A5 双点 ..a', '..a'],
    ['A6 裸 #', '#'],
    ['A7 引号残留（Playwright 专有伪类，语义匹配器不支持）', 'button:has-text("提交")'],
    ['A8 空段 >>', 'iframe >> '],
    ['A9 属性子句缺属性名', "[='x']"],
  ];
  for (const [name, expect] of rejects) {
    await ok(name, () => {
      assert.ok(looksLikeCss(expect), '前置：该形态应命中 looksLikeCss 启发式');
      const { ok: isOk, errors } = errsOf(stepWith(expect));
      assert.strictEqual(isOk, false, '应被 validatePlanStrict 拒绝');
      assert.ok(errors.join('\n').includes('CSS 选择器形态但语法非法'), '错误应携带 CSS 守卫文案: ' + errors.join('; '));
    });
  }

  await ok('A10 requiredEvidence 内的非法 CSS 形态同样拒绝', () => {
    const { ok: isOk, errors } = errsOf(stepWith('点击按钮', {
      ebsRequired: [{ type: 'element_present', expect: 'id=regForm' }],
    }));
    assert.strictEqual(isOk, false);
    assert.ok(errors.join('\n').includes('requiredEvidence[0]'));
  });

  await ok('A11 forbiddenEvidence 内的 element_absent 非法形态同样拒绝', () => {
    const { ok: isOk } = errsOf(stepWith('点击按钮', {
      forbiddenEvidence: [{ type: 'element_absent', expect: 'class=error' }],
    }));
    assert.strictEqual(isOk, false);
  });

  console.log('== B. 合法形态与语义路径必须放行（只收紧不误伤）==');

  const accepts = [
    ['B1 #id', '#q'],
    ['B2 tag[attr=value]', 'button[type=submit]'],
    ['B3 tag[attr=\'value\']', "input[name='q']"],
    ['B4 属性值含 CJK（合法）', "[aria-label='商品列表']"],
    ['B5 类组合器', '.list .item'],
    ['B6 子组合器 + 伪类', 'div > span:first-child'],
    ['B7 跨 frame 前缀', 'iframe >> #inner'],
    ['B8 属性含操作符', "a[href$='.pdf']"],
    ['B9 通配', '*'],
  ];
  for (const [name, expect] of accepts) {
    await ok(name, () => {
      const { ok: isOk, errors } = errsOf(stepWith(expect));
      assert.strictEqual(isOk, true, '合法选择器不得被拒绝: ' + errors.join('; '));
    });
  }

  await ok('B10 纯中文语义 expect（非 CSS 形态）不受限', () => {
    const { ok: isOk, errors } = errsOf(stepWith('商品列表容器'));
    assert.strictEqual(isOk, true, '语义路径不得被 CSS 守卫误伤: ' + errors.join('; '));
  });

  await ok('B11 text_present 中文 expect 完全不受限', () => {
    const { ok: isOk } = errsOf(stepWith('注册成功', { verificationType: 'text_present' }));
    assert.strictEqual(isOk, true);
  });

  await ok('B12 element_absent 合法 CSS 形态放行', () => {
    const { ok: isOk, errors } = errsOf(stepWith('.error-banner', { verificationType: 'element_absent' }));
    assert.strictEqual(isOk, true, errors.join('; '));
  });

  await ok('B13 expect 非字符串/为空 → 守卫跳过（不误伤既有校验路径）', () => {
    assert.deepStrictEqual(plan.cssEvidenceViolations({ verification: { type: 'element_present', expect: '' } }), []);
    assert.deepStrictEqual(plan.cssEvidenceViolations({ verification: { type: 'element_present', expect: 123 } }), []);
    assert.deepStrictEqual(plan.cssEvidenceViolations({}), []);
  });

  console.log('== C. 契约回归：isValidCssSelectorShape 纯函数 + prompt 同源 ==');

  await ok('C1 isValidCssSelectorShape 直接断言（接受/拒绝边界）', () => {
    for (const good of ['#q', "input[name='q']", "[aria-label='中文']", 'iframe >> #inner', 'div > span']) {
      assert.ok(plan.isValidCssSelectorShape(good), '应合法: ' + good);
    }
    for (const bad of ['id=regForm', '', "input[name='q", 'div 中文', '..a']) {
      assert.strictEqual(plan.isValidCssSelectorShape(bad), false, '应非法: ' + bad);
    }
  });

  await ok('C2 PLAN_STRICT_INSTRUCTIONS（求值后）含 element 证据 expect 契约', () => {
    const t = plan.PLAN_STRICT_INSTRUCTIONS;
    assert.ok(t.includes('element 证据 expect 契约'), 'schema 指令应含守卫契约');
    assert.ok(t.includes('id=regForm'), '应点名非法示例');
  });

  await ok('C3 planner ACTION_CONSTRAINTS（求值后）含 element 证据 expect 契约', () => {
    const t = typeof plannerMod.ACTION_CONSTRAINTS === 'string'
      ? plannerMod.ACTION_CONSTRAINTS : JSON.stringify(plannerMod.ACTION_CONSTRAINTS);
    assert.ok(t.includes('P2 element 证据 expect 契约'), 'planner 约束应含守卫契约');
    assert.ok(t.includes('禁止臆造'), '应含臆造禁令');
  });

  await ok('C4 守卫仅收紧：不含 element 证据的既有非法 plan 仍按原样拒绝（无守卫文案混入）', () => {
    // 既有校验路径回归：缺 verification 的 MUST_VERIFY 动作仍被原样拒绝
    const s = stepWith('#q');
    s.verification = { type: 'none' };
    const { ok: isOk, errors } = errsOf(s);
    assert.strictEqual(isOk, false);
    assert.ok(!errors.join('\n').includes('CSS 选择器形态但语法非法'), '不得混入 CSS 守卫文案');
  });

  await ok('C5 schema/action.js 与守卫同源（VERIFICATION_TYPES 含 element 类，未改动作 schema）', () => {
    assert.ok(schemaAction.VERIFICATION_TYPES.includes('element_present'));
    assert.ok(schemaAction.VERIFICATION_TYPES.includes('element_absent'));
  });

  console.log(passed + ' passed' + (process.exitCode ? '（存在失败）' : ''));
})();
