#!/usr/bin/env node
'use strict';
// C13 守护：模板「未约束」语义（null）在 updateTemplate 合并路径下必须可用。
// 缺陷背景：createTemplate 把未约束的 os/browser 归一化为 null；updateTemplate 合并
// tpl 旧值时把 null 带回 validateTemplateInput，而校验只豁免 undefined →
// 凡创建时未约束 os/browser 的模板，任何编辑更新永远 400「browser 必须是字符串」。
// 修复：validateTemplateInput 对 os/browser 豁免 null（null === 不约束）。

const fpTemplates = require('../fpTemplates');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg); }
  else { fail++; console.error('  ✘ ' + msg); }
}
function mustNotThrow(fn, msg) {
  try { fn(); ok(true, msg); }
  catch (e) { ok(false, msg + '（实际抛出: ' + e.message + '）'); }
}

console.log('\n== C13 模板 null 约束语义守护 ==');

// T1: 创建未约束模板 → os/browser = null
const tpl = fpTemplates.createTemplate({ name: 'c13-null-guard' });
ok(tpl.os === null && tpl.browser === null, 'T1 未约束创建 → os/browser 归一化为 null');

// T2: 缺陷回归主体——对 null 约束模板做最小编辑（仅改 name）不得 400
mustNotThrow(() => fpTemplates.updateTemplate(tpl, { name: 'c13-null-guard-v2' }),
  'T2 未约束模板（null）最小编辑不抛 400');

// T3: 编辑后保留未约束语义
ok(tpl.os === null && tpl.browser === null, 'T3 编辑后 os/browser 仍为 null（不约束）');

// T4: 显式 null 传入同样放行（UI 清空约束场景）
mustNotThrow(() => fpTemplates.updateTemplate(tpl, { os: null, browser: null }),
  'T4 显式 null 更新（UI 清空约束）不抛 400');

// T5: 类型错误仍被拦截（null 豁免不放走非法类型）
let threw = false;
try { fpTemplates.updateTemplate(tpl, { os: 123 }); } catch (e) { threw = /os 必须是字符串/.test(e.message); }
ok(threw, 'T5 os 数字类型仍 400');

// T6: 合法约束模板编辑不受影响（原语义保持）
const tpl2 = fpTemplates.createTemplate({ name: 'c13-constrained', os: 'windows', browser: 'chrome' });
mustNotThrow(() => fpTemplates.updateTemplate(tpl2, { name: 'c13-constrained-v2' }),
  'T6 已约束模板编辑不抛 400');
ok(tpl2.os === 'windows' && tpl2.browser === 'chrome', 'T6b 编辑后约束值保留');

console.log('\n================ 汇总 ================');
console.log('PASS=' + pass + '  FAIL=' + fail);
process.exit(fail ? 1 : 0);
