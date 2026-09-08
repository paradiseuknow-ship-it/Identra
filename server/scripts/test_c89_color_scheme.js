'use strict';
// C89 守护测试（回填）—— 原生 select 下拉弹层亮色不可读（color-scheme: dark 全局收口）。
// 缺陷背景（commit 0c17356 修复，本测试回填守护层）：
//   C86 新 IA 深色 UI 下，原生 <select> 弹出层（option 列表/日期/滚动条）由 OS 按
//   浅色 color-scheme 渲染 —— 白底白字不可读。修复：html 根声明 color-scheme: dark
//   + select option 显式落色兜底 Windows Chromium（UA 对 option 背景不总是跟随根 scheme）。
// 本测试两层（文件断言，CSS 无运行时 SSR 面）：
//   P1 html 根 color-scheme: dark 必须存在且位于 @layer base；
//   P2 select option 显式 background-color + color 兜底必须存在；
//   P3 全文件 color-scheme 声明唯一性/一致性（不得出现 light 或相互冲突的多处声明）。

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

const cssPath = path.join(ROOT, 'client', 'src', 'index.css');
const raw = fs.readFileSync(cssPath, 'utf8');
// CSS 注释剥离（保留声明块结构）
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

// P1: html 根规则含 color-scheme: dark，且位于 @layer base 内
const baseLayer = css.match(/@layer\s+base\s*\{[\s\S]*?\n\}/);
chk('P1a @layer base 块存在', !!baseLayer, 'missing @layer base in index.css');
const htmlRule = baseLayer ? (baseLayer[0].match(/html\s*\{[^}]*\}/) || [])[0] : null;
chk('P1b html 根规则存在', !!htmlRule, 'missing html rule in @layer base');
chk('P1c html 根声明 color-scheme: dark（原生弹层/日期/滚动条按暗色渲染）',
  !!htmlRule && /color-scheme\s*:\s*dark/.test(htmlRule), 'color-scheme: dark missing on html');

// P2: select option 显式落色兜底（Windows Chromium UA 不总跟随根 scheme）
const optRule = css.match(/select\s+option\s*\{[^}]*\}/);
chk('P2a select option 兜底规则存在', !!optRule, 'missing "select option" rule');
chk('P2b select option 显式 background-color + color（暗底亮字）',
  !!optRule && /background-color\s*:/.test(optRule[0]) && /(^|[^-])color\s*:/.test(optRule[0]),
  'option rule must pin background-color AND color');

// P3: 全文件 color-scheme 声明一致性（唯一 dark，无 light/冲突覆盖）
const schemeDecls = css.match(/color-scheme\s*:\s*[^;}]+/g) || [];
chk('P3a color-scheme 声明数 >= 1', schemeDecls.length >= 1, 'no color-scheme declaration found');
chk('P3b 全部 color-scheme 声明均为 dark（无 light/冲突覆盖）',
  schemeDecls.every((d) => /color-scheme\s*:\s*dark\s*$/.test(d.trim())),
  'decls=' + JSON.stringify(schemeDecls));

// 汇总
console.log('\nRESULT pass=' + pass + ' fail=' + fail);
if (fail) { console.log('FAILURES:\n' + failures.join('\n')); process.exit(1); }
