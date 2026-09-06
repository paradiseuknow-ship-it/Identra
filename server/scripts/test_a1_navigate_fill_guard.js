'use strict';

// Fix A1：navigate 冒充 fill 守卫 — 针对性回归测试
//
// 背景（Final100 P2 taxonomy A1 / rw.099 铁证）：step 描述「在搜索框中输入商品关键词」
// 但 action=navigate，verification=element_present input#q（输入框存在即过，值从未输入）
// → step_002 点击搜索时 q 为空 → text_present 恒假 → VERIFY_FAILED ×4。
// 守卫契约（本测试锁定）：
//   1. action=navigate 且 semantic/expectedResult 命中「输入/填写动词短语 + 字段名词」
//      的确定性模式（在…框中输入 / 输入…到…框 / 填写…表单|字段 / 英文 fill/enter + noun）
//      → validatePlanStrict 拒绝并要求拆为 navigate + fill 两步。
//   2. part 级导航宾语逃逸（网址/地址栏/URL/页面/访问/打开）：语义含导航宾语的 part
//      不参与判定——「输入网址」「在地址栏输入网址并访问」等合法导航零误伤；
//      semantic 的导航词不遮蔽 expectedResult 的 fill 语义（part 级独立判定）。
//   3. 「输入框正常展示」类结果描述（无输入动词短语）不命中（保守窄口径）。
//   4. 仅 navigate 受限：fill/click 步骤的输入描述完全不受影响。
//   5. 三处 prompt 同源：schema PLAN_STRICT_INSTRUCTIONS + planner ACTION_CONSTRAINTS
//      （求值后字符串）+ deepseek system prompt（源文件文本）。
//
// 纪律：只收紧（新增拒绝路径），不放宽任何既有校验；不触碰验证语义/Success Definition。

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-a1-guard-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const plan = require('../agent/schema/plan');
const plannerMod = require('../agent/planner');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}

// 最小合法 navigate strict step（通过既有全部校验）
function navStep(semantic, expectedResult) {
  return {
    action: 'navigate',
    target: { url: 'https://example.test/page.html' },
    semantic,
    expectedResult: expectedResult == null ? '页面已打开' : expectedResult,
  };
}

function strictPlan(steps) { return { goal: '测试目标', steps }; }

function errsOf(steps) {
  const r = plan.validatePlanStrict(strictPlan(steps));
  return { ok: r.ok, errors: r.errors || [] };
}

async function main() {
  const nf = plan.navigateFillViolations;
  assert.strictEqual(typeof nf, 'function', 'navigateFillViolations 必须导出');

  // ---------- A 组：命中拒绝 ----------
  await ok('A1 rw.099 铁证重放：在搜索框中输入商品关键词 + navigate → 拒绝', () => {
    const errs = nf(navStep('在搜索框中输入商品关键词'));
    assert.strictEqual(errs.length, 1, '应恰好 1 条错误: ' + JSON.stringify(errs));
    assert.ok(/navigate/.test(errs[0]), '错误文案必须点名 navigate');
    assert.ok(/fill/.test(errs[0]), '错误文案必须给出 fill 替代方案');
  });

  await ok('A2 输入…到…框 形态：把关键词输入到搜索框 → 拒绝', () => {
    assert.strictEqual(nf(navStep('把关键词输入到搜索框')).length, 1);
  });

  await ok('A3 填写…表单/字段 形态：填写注册表单中的邮箱字段 → 拒绝', () => {
    assert.strictEqual(nf(navStep('填写注册表单中的邮箱字段')).length, 1);
  });

  await ok('A4 英文 fill + 字段名词：fill in the search box → 拒绝', () => {
    assert.strictEqual(nf(navStep('fill in the search box')).length, 1);
  });

  await ok('A5 英文 enter…in…form：enter your username in the login form → 拒绝', () => {
    assert.strictEqual(nf(navStep('enter your username in the login form')).length, 1);
  });

  await ok('A6 validatePlanStrict 接线：A1 步骤整 plan 校验 ok=false 且错误含 fill 指引', () => {
    const r = errsOf([navStep('在搜索框中输入商品关键词')]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((x) => /navigate/.test(x) && /fill/.test(x)), 'errors=' + JSON.stringify(r.errors));
  });

  await ok('A7 part 级独立判定：semantic 含导航词不遮蔽 expectedResult 的 fill 语义', () => {
    const errs = nf(navStep('打开搜索页', '把关键词输入到搜索框'));
    assert.strictEqual(errs.length, 1, 'expectedResult 的 fill 语义必须独立命中: ' + JSON.stringify(errs));
  });

  await ok('A8 多错误共存：A1 守卫与 Fix A CSS 守卫互不挤占', () => {
    const s = navStep('在搜索框中输入商品关键词');
    s.verification = { type: 'element_present', expect: 'id=regForm' };
    const r = errsOf([s]);
    assert.strictEqual(r.ok, false);
    const joined = r.errors.join('\n');
    assert.ok(/navigate/.test(joined) && /CSS 选择器形态但语法非法/.test(joined),
      '两条守卫错误必须同时出现: ' + joined);
  });

  // ---------- B 组：合法形态零误伤 ----------
  await ok('B1 输入网址（URL 宾语逃逸）→ 放行', () => {
    assert.strictEqual(nf(navStep('输入网址 https://example.test/search.html')).length, 0);
  });

  await ok('B2 在地址栏输入网址并访问（地址栏/网址逃逸）→ 放行', () => {
    assert.strictEqual(nf(navStep('在地址栏输入网址并访问')).length, 0);
  });

  await ok('B3 纯导航 打开登录页（无输入动词短语）→ 放行', () => {
    assert.strictEqual(nf(navStep('打开登录页', '登录页已加载')).length, 0);
  });

  await ok('B4 访问商品列表页面 → 放行', () => {
    assert.strictEqual(nf(navStep('访问商品列表页面', '商品列表页面已展示')).length, 0);
  });

  await ok('B5 「输入框正常展示」类结果描述（无输入动词短语）→ 放行', () => {
    assert.strictEqual(nf(navStep('打开登录页', '登录页与账号输入框正常展示')).length, 0);
  });

  await ok('B6 仅 navigate 受限：fill 动作的输入描述不受守卫影响', () => {
    const s = navStep('在搜索框中输入商品关键词');
    s.action = 'fill';
    s.target = { field: 'search', semantic: '搜索框' };
    assert.strictEqual(nf(s).length, 0);
  });

  await ok('B7 validatePlanStrict 合法 navigate plan → ok=true', () => {
    const r = errsOf([
      navStep('打开搜索页', '搜索页已加载'),
      navStep('输入网址 https://example.test/list.html'),
    ]);
    assert.strictEqual(r.ok, true, 'errors=' + JSON.stringify(r.errors));
  });

  await ok('B8 导航动词开头 描述 → 放行', () => {
    assert.strictEqual(nf(navStep('导航到商品详情页', '详情页已打开')).length, 0);
  });

  // ---------- C 组：prompt 同源 + 既有校验零回归 ----------
  await ok('C1 PLAN_STRICT_INSTRUCTIONS（求值后）含 navigate 冒充 fill 禁令', () => {
    assert.ok(/navigate 只用于打开页面/.test(plan.PLAN_STRICT_INSTRUCTIONS),
      'schema 指令必须含 navigate 契约文本');
    assert.ok(/拆为 navigate（打开页面）\+ fill（输入值）两步/.test(plan.PLAN_STRICT_INSTRUCTIONS));
  });

  await ok('C2 planner ACTION_CONSTRAINTS（求值后）含同源禁令', () => {
    const ac = plannerMod.ACTION_CONSTRAINTS;
    const text = typeof ac === 'string' ? ac : JSON.stringify(ac);
    assert.ok(/navigate 冒充 fill 禁令/.test(text), 'ACTION_CONSTRAINTS 必须含 navigate 契约文本');
    assert.ok(/拆为 navigate（打开页面）\+ fill（输入值/.test(text));
  });

  await ok('C3 deepseek system prompt（源文件文本）含同源禁令', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'llm', 'providers', 'deepseek.js'), 'utf8');
    assert.ok(/navigate 只用于打开页面，永远不会输入值/.test(src), 'deepseek.js 必须含 navigate 契约文本');
  });

  await ok('C4 既有校验零混入：MUST_VERIFY 缺 verification 仍被拒绝', () => {
    const r = errsOf([{
      action: 'click',
      target: { field: 'btn', semantic: '按钮' },
      semantic: '点击按钮',
      expectedResult: '已点击',
      // verification 缺失 → 既有路径拒绝
    }]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((x) => /必须提供有意义的 verification/.test(x)),
      'errors=' + JSON.stringify(r.errors));
  });

  await ok('C5 纯函数边界：semantic/expectedResult 非字符串或缺失不崩溃', () => {
    assert.strictEqual(nf({ action: 'navigate' }).length, 0);
    assert.strictEqual(nf({ action: 'navigate', semantic: 123, expectedResult: null }).length, 0);
    assert.strictEqual(nf({ action: 'navigate', semantic: '', expectedResult: '  ' }).length, 0);
  });

  console.log(`\nA1 navigate-fill guard: ${passed} passed, ${process.exitCode ? 'FAILED' : 'all green'}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
