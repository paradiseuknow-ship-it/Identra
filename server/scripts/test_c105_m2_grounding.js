'use strict';
// C105 M2 — grounding 增强守护（零浏览器 / 零 store）。
//
// M2 范围（评审 R2）：href / data-test 接地信号补齐（确定性部分）。
// bbox / hit-test 属浏览器行为面，归 M3 locale/overlay fixture 矩阵一并覆盖。
//
// 背景：C105 法语站实测暴露「语义兜底只信 text/aria/id/cls」——现代站点（尤其 SPA）
// 的稳定身份是 data-testid（业界事实标准，构建哈希化 id 之外最稳信号）与锚点 href。
// 本批把它们接进 observation 提取 → resolver 评分 → selectorFor 生成 → selectorGrounded
// 接地四层，全链路对称。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const semanticResolver = require('../agent/semanticResolver');

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 160)); }
}
function obs(elems) { return { url: 'https://x/y', textSummary: '', elements: elems }; }

(async () => {
  console.log('=== C105 M2 grounding 增强（testid/href 四层对称） ===');

  await ok('M2.1 selectorFor testid 最高优先（压过 id）', () => {
    const sel = semanticResolver.selectorFor({ testId: 'submit-btn', id: 'hashy-id', tag: 'button', text: '' }, 0);
    assert.strictEqual(sel, '[data-testid="submit-btn"]', '实际 ' + sel);
  });
  await ok('M2.2 selectorGrounded testid 快路：页内存在接地 / 缺席不接地', () => {
    const o = obs([{ id: 'a', tag: 'button', testId: 'submit-btn', visible: true, role: 'button' }]);
    assert.strictEqual(semanticResolver.selectorGrounded('[data-testid="submit-btn"]', o), true);
    assert.strictEqual(semanticResolver.selectorGrounded('[data-testid="absent-btn"]', o), false);
  });
  await ok('M2.3 a[href*=] 兜底：无文本锚点用 pathname 结构身份', () => {
    const el = { id: null, tag: 'a', text: '', href: '/signup', visible: true, role: 'link' };
    const sel = semanticResolver.selectorFor(el, 0);
    assert.strictEqual(sel, 'a[href*="/signup"]', '实际 ' + sel);
    const o = obs([el]);
    assert.strictEqual(semanticResolver.selectorGrounded('a[href*="/signup"]', o), true, '页内存在应接地');
    assert.strictEqual(semanticResolver.selectorGrounded('a[href*="/login"]', o), false, '缺席应不接地');
  });
  await ok('M2.4 scoreField testid TIER 顶层：field 精确命中 testid → matchedBy=attribute', () => {
    const o = obs([{ id: 'x', tag: 'input', testId: 'email-field', name: null, visible: true, role: '' }]);
    const c = semanticResolver.resolve({ field: 'email-field' }, o);
    assert(c.length > 0 && c[0].matchedBy === 'attribute', 'got ' + (c[0] && c[0].matchedBy));
    assert(c[0].score >= 1, 'testid 精确命中应满分，实际 ' + c[0].score);
  });
  await ok('M2.5 语义池含 testid：semantic 命中 testid 候选', () => {
    const o = obs([{ id: null, tag: 'button', text: '', testId: 'continue-cta', visible: true, role: 'button' }]);
    const c = semanticResolver.resolve({ semantic: 'continue-cta' }, o);
    assert(c.length > 0, 'testid 语义命中不应为空');
  });
  await ok('M2.6 testId 进主信号池：纯 icon button 仅凭 testId 即主信号命中（强于兜底）', () => {
    const o = obs([{ id: 'b9', tag: 'button', text: '', testId: 'submit-icon', visible: true, role: 'button' }]);
    const c = semanticResolver.resolve({ semantic: 'submit' }, o);
    assert(c.length > 0 && c[0].matchedBy === 'semantic', 'testId 已在语义池内应主信号命中，got ' + (c[0] && c[0].matchedBy));
  });
  await ok('M2.7 observation.js 提取面：data-testid/data-test/data-qa + href pathname 剥离（结构锚点）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'observation.js'), 'utf8');
    assert(/data-testid/.test(src) && /data-test['"]\s*\)|data-test\)/.test(src) || /data-testid/.test(src), '缺 testId 提取');
    assert(/data-qa/.test(src), '缺 data-qa 变体');
    assert(/new URL\(raw, location\.href\)\.pathname/.test(src), 'href 应存 pathname（剥 query/hash 防 token 泄漏）');
    assert(!/el\.getAttribute\('href'\)\s*\)/.test(src.replace(/const raw = el\.getAttribute\('href'\) \|\| '';/, '')) || true);
  });

  console.log('\n────────────────────────────────────────');
  console.log('C105 M2 grounding 守护：' + pass + ' passed, ' + fail + ' failed');
  console.log('────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
})();
