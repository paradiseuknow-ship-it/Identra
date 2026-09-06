#!/usr/bin/env node
// R8 targeted test：泛化容器标签证据守卫（Fix A2）+ 契约三处同步。
// 零运行时验证语义改动——全部为生成期（规划/schema 层）防线。
const assert = require('assert');
const { cssEvidenceViolations } = require('../agent/schema/plan');
const { R8_CONTRACT } = require('../agent/plannerContractText');
const plannerSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'agent', 'planner.js'), 'utf8');
const deepseekSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'agent', 'llm', 'providers', 'deepseek.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' :: ' + e.message); }
}

// —— 构造最小 strict step 工具 ——
function stepWith(over) {
  return Object.assign({
    action: 'click',
    semantic: '点击导出按钮',
    target: { field: 'exportBtn', semantic: '导出按钮' },
    verification: { type: 'element_present', expect: '导出按钮' },
  }, over);
}

// A 组：schema 拒绝泛化容器裸词
check('A1 verification element_present "body" 被拒', () => {
  const errs = cssEvidenceViolations(stepWith({ verification: { type: 'element_present', expect: 'body' } }));
  assert.ok(errs.length === 1 && /泛化容器/.test(errs[0]), JSON.stringify(errs));
});
check('A2 requiredEvidence "body" 被拒', () => {
  const s = stepWith({ expectedBusinessState: { requiredEvidence: [{ type: 'element_present', expect: 'Body' }] } });
  const errs = cssEvidenceViolations(s);
  assert.ok(errs.length === 1 && /requiredEvidence\[0\]/.test(errs[0]), JSON.stringify(errs));
});
check('A3 大小写变体 html/DIV 被拒', () => {
  for (const e of ['HTML', 'DIV', 'Html']) {
    const errs = cssEvidenceViolations(stepWith({ verification: { type: 'element_present', expect: e } }));
    assert.ok(errs.length === 1, e + ' 未被拒: ' + JSON.stringify(errs));
  }
});
check('A4 element_absent "body" 同口径被拒', () => {
  const errs = cssEvidenceViolations(stepWith({ verification: { type: 'element_absent', expect: 'body' } }));
  assert.ok(errs.length === 1 && /泛化容器/.test(errs[0]), JSON.stringify(errs));
});
check('A5 黑名单覆盖 p/span/table 等常见泛化词', () => {
  for (const e of ['p', 'span', 'table', 'main', 'header', 'nav']) {
    const errs = cssEvidenceViolations(stepWith({ verification: { type: 'element_present', expect: e } }));
    assert.ok(errs.length === 1, e + ' 未被拒');
  }
});

// B 组：合法路径零误伤
check('B1 合法业务语义（导出按钮）不拦', () => {
  const errs = cssEvidenceViolations(stepWith({}));
  assert.ok(errs.length === 0, JSON.stringify(errs));
});
check('B2 合法 CSS 形态（.list/#id 单一 simple）不拦', () => {
  for (const e of ['.result-list', '#exportBtn']) {
    const errs = cssEvidenceViolations(stepWith({ verification: { type: 'element_present', expect: e } }));
    assert.ok(errs.length === 0, e + ' 被误拦: ' + JSON.stringify(errs));
  }
});
check('B2b tag.class 复合（div.foo）被既有 Fix A 拒——R8 零行为变化（不改 Fix A 口径）', () => {
  for (const e of ['div.foo', 'input#q']) {
    const errs = cssEvidenceViolations(stepWith({ verification: { type: 'element_present', expect: e } }));
    assert.ok(errs.length === 1 && /CSS 选择器形态但语法非法/.test(errs[0]), e + ' 行为异常: ' + JSON.stringify(errs));
  }
});
check('B3 合法裸业务 tag（h2/button/form）不拦（BARE_TAGS 家族）', () => {
  for (const e of ['h2', 'button', 'form', 'label']) {
    const errs = cssEvidenceViolations(stepWith({ verification: { type: 'element_present', expect: e } }));
    assert.ok(errs.length === 0, e + ' 被误拦: ' + JSON.stringify(errs));
  }
});
check('B4 Fix A 原守卫零回退（id=regForm 仍被拒）', () => {
  const errs = cssEvidenceViolations(stepWith({ verification: { type: 'element_present', expect: 'id=regForm' } }));
  assert.ok(errs.length === 1 && /CSS 选择器形态但语法非法/.test(errs[0]), JSON.stringify(errs));
});

// C 组：契约三处同步（P5.2 模式纪律）
check('C1 R8_CONTRACT 非空且含禁令关键词', () => {
  assert.ok(R8_CONTRACT.length > 100 && /泛化容器/.test(R8_CONTRACT) && /element_present/.test(R8_CONTRACT));
});
check('C2 planner.js 引用 R8_CONTRACT（structured fallback 路径）', () => {
  assert.ok(/R8_CONTRACT/.test(plannerSrc) && !/R8_CONTRACT\s*=/.test(plannerSrc), '应 require 引用而非本地定义');
});
check('C3 deepseek.js system prompt 拼接 R8_CONTRACT（真实执行路径）', () => {
  assert.ok(/R8_CONTRACT \+ ';/.test(deepseekSrc.replace(/\s*\+\s*'\n' \+ R8_CONTRACT/g, "R8_CONTRACT +';")) || /\+ R8_CONTRACT/.test(deepseekSrc), 'deepseek system 未拼接 R8_CONTRACT');
});

console.log(`\n结果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
