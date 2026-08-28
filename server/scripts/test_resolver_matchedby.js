'use strict';

// Engineering Phase P1 — Resolver matchedBy 遥测归一化测试（零浏览器 / 零 store）。
//
// 验证 semanticResolver.resolve 的 matchedBy 归一到统一分类：
//   semantic / text / attribute / fallback
// 不改变选择算法，仅提升可观测性（供 4-task Gate 分析 resolver 泛化能力）。

const semanticResolver = require('../agent/semanticResolver');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n=== ' + name + ' ==='); }

// 构造最小 observation（只含必要的 elements 字段）
function obs(elems) { return { url: 'https://x/y', textSummary: '', elements: elems }; }

const TAXONOMY = ['semantic', 'text', 'attribute', 'fallback'];

section('Resolver matchedBy 四类归一');
{
  // 1) attribute：field=email + 元素 id=email（field 信号命中属性）
  const c1 = semanticResolver.resolve({ field: 'email' }, obs([{ id: 'email', tag: 'input', type: 'email', text: '', visible: true, role: '' }]));
  ok(c1.length > 0 && c1[0].matchedBy === 'attribute', 'field 命中元素属性(id=email) → matchedBy=attribute (got ' + (c1[0] && c1[0].matchedBy) + ')');

  // 2) text：semantic=登录 + 元素自身可见文本命中
  const c2 = semanticResolver.resolve({ semantic: '登录' }, obs([{ id: 'b1', tag: 'button', text: '登录', visible: true, role: 'button' }]));
  ok(c2.length > 0 && c2[0].matchedBy === 'text', 'semantic 命中元素自身可见文本 → matchedBy=text (got ' + (c2[0] && c2[0].matchedBy) + ')');

  // 3) semantic：semantic=login + 仅 aria-label 命中（非自身文本）
  const c3 = semanticResolver.resolve({ semantic: 'login' }, obs([{ id: 'b2', tag: 'button', text: '', ariaLabel: 'login', visible: true, role: 'button' }]));
  ok(c3.length > 0 && c3[0].matchedBy === 'semantic', 'semantic 经 aria-label 命中（非自身文本）→ matchedBy=semantic (got ' + (c3[0] && c3[0].matchedBy) + ')');

  // 4) fallback：动作语义按钮兜底（无 field/文本/属性命中，仅 role+动作语义）
  const c4 = semanticResolver.resolve({ semantic: 'submit' }, obs([{ id: 'b3', tag: 'button', text: '', visible: true, role: 'button' }]));
  ok(c4.length > 0 && c4[0].matchedBy === 'fallback', '动作语义按钮兜底 → matchedBy=fallback (got ' + (c4[0] && c4[0].matchedBy) + ')');

  // 5) 所有返回值均落在统一分类内
  const all = [].concat(c1, c2, c3, c4);
  ok(all.every((c) => TAXONOMY.includes(c.matchedBy)), '所有候选 matchedBy 均落在 {semantic,text,attribute,fallback} 内');
}

console.log('\n────────────────────────────────────────');
console.log('Resolver matchedBy 测试：' + pass + ' passed, ' + fail + ' failed');
console.log('────────────────────────────────────────');
process.exit(fail === 0 ? 0 : 1);
