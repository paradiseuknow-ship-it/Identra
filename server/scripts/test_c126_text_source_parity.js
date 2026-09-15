'use strict';

// C126 守护：页面文本证据的**唯一口径**与跨层一致性。
//
// 守护对象：`text_present` / `text_absent` 的证据源。
// observation.js 产出两个文本字段，容量与构造完全不同：
//   textSummary = 前 120 个**筛选元素**的文本（h1..a/option/strong/em/code），空格连接，截断 5000
//   visibleText = 全页 body.innerText 去重行，换行连接，截断 8000
// 修复前：验证引擎只读 textSummary，诊断层读 visibleText ⇒
//   长页面上目标文本落在第 121 个元素之后时，验证引擎判「不包含」（**恒假**，真实成功被误判失败），
//   诊断层却判「包含」⇒ 跨层相反答案（与 C123 的 element_present 缺口同族）。
// 修复后：两侧都只能通过 clause.js 的 pageText / evalTextPresent / evalTextAbsent 消费文本。
//
// 最高价值在于 A 组（静态唯一性）与 C 组（跨层 parity）：前者堵住「再抄一份」，
// 后者堵住「同一份观察两层两个答案」。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const clause = require('../agent/verification/clause.js');
const verification = require('../agent/verification.js');
const vil = require('../agent/verification/verificationIntelligence.js');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function obs(o) {
  const opts = o || {};
  return {
    url: opts.url || 'https://example.test/app',
    loadingState: 'complete',
    networkState: 'idle',
    textSummary: opts.textSummary === undefined ? 'app shell rendered' : opts.textSummary,
    visibleText: opts.visibleText === undefined ? (opts.textSummary === undefined ? 'app shell rendered' : opts.textSummary) : opts.visibleText,
    roleText: opts.roleText || '',
    elements: opts.elements || [],
    contentLeaves: opts.contentLeaves || [],
    storage: opts.storage === undefined ? null : opts.storage,
  };
}

// 长页面：目标文本只存在于 visibleText 的后段（文本节点远超 textSummary 的 120 元素窗口）
const TAIL = 'target phrase here';
const longPage = obs({
  textSummary: 'header text only',
  visibleText: 'header text only\n' + 'filler '.repeat(1200) + '\n' + TAIL,
});
const shortPage = obs({ textSummary: 'welcome back, logout' });

function vilSaysPresent(evidenceClause, after, before) {
  const r = vil.analyze({
    beforeObservation: before || obs({ textSummary: 'header text only', visibleText: 'header text only' }),
    afterObservation: after,
    expectedVerification: {
      businessState: { stateType: 'T', requiredEvidence: [evidenceClause], evidenceLogic: 'AND', forbiddenEvidence: [] },
    },
    actionResult: { success: true },
    action: { type: 'click', risk: 'LOW', target: { semantic: 'continue' } },
  });
  return r.failureType === 'VERIFICATION_TOO_STRICT';
}

// ── A 组：唯一口径（静态）────────────────────────────────────────────────────
console.log('=== A 组：文本证据口径唯一性 ===');
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const vSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'verification.js'), 'utf8'));
const viSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'verification', 'verificationIntelligence.js'), 'utf8'));
const cSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'verification', 'clause.js'), 'utf8'));

ok(/evalTextPresent/.test(cSrc) && /evalTextAbsent/.test(cSrc) && /function pageText/.test(cSrc),
  'A1 pageText / evalTextPresent / evalTextAbsent 定义在 clause.js（唯一实现）');
ok(/clause\.evalTextPresent\(after, expect\)/.test(vSrc), 'A2 验证引擎 text_present 委托唯一实现');
ok(/clause\.evalTextAbsent\(after, expect\)/.test(vSrc), 'A3 验证引擎 text_absent 委托唯一实现');
ok(/clause\.evalTextPresent\(after, cl\.expect\)/.test(viSrc), 'A4 诊断层 text_present 委托唯一实现');
ok(/clause\.evalTextAbsent\(after, cl\.expect\)/.test(viSrc), 'A5 诊断层 text_absent 委托唯一实现');
// 消费层不得再出现「把 textSummary 直接 includes」的文本判定
ok(!/textSummary[^\n]*\.includes\(/.test(vSrc), 'A6 验证引擎不得直读 textSummary 做文本包含判定');
ok(!/(visibleText \|\| .*textSummary)[^\n]*\.includes\(/.test(viSrc),
  'A7 诊断层不得再自行拼串做文本包含判定');
// 口径只允许在 clause.pageText 一处拼串
const pageTextDefs = (cSrc.match(/function pageText/g) || []).length;
ok(pageTextDefs === 1, 'A8 页面文本口径定义唯一', 'defs=' + pageTextDefs);

// ── B 组：长页面恒假修复（本批主修复）────────────────────────────────────────
console.log('=== B 组：长页面文本窗口外的恒假修复 ===');
ok(verification.verify({ type: 'text_present', expect: TAIL }, longPage, null).success === true,
  'B1 目标文本只在 visibleText 后段 ⇒ text_present 必须成立（修复前恒假）');
ok(clause.pageText(longPage).includes(TAIL),
  'B2 pageText 覆盖 textSummary + visibleText 两部分');
ok(verification.verify({ type: 'text_present', expect: 'header text only' }, longPage, null).success === true,
  'B3 textSummary 窗口内的文本仍成立（未破坏既有路径）');

// ── C 组：跨层 parity ────────────────────────────────────────────────────────
console.log('=== C 组：跨层 parity（诊断层 vs 验证引擎）===');
const parity = [
  ['长页后段文本', { type: 'text_present', expect: TAIL }, longPage, true],
  ['长页窗口内文本', { type: 'text_present', expect: 'header text only' }, longPage, true],
  ['短页存在文本', { type: 'text_present', expect: 'welcome' }, shortPage, true],
  ['短页不存在文本', { type: 'text_present', expect: 'checkout complete' }, shortPage, false],
  ['跨行相邻文本（折叠空白后命中）', { type: 'text_present', expect: 'header text only filler' }, longPage, true],
  ['text_absent 确不存在', { type: 'text_absent', expect: 'error' }, shortPage, true],
  ['text_absent 实际存在', { type: 'text_absent', expect: 'welcome' }, shortPage, false],
];
for (const [name, cl, after, want] of parity) {
  const e = verification.verify(cl, after, null).success;
  const v = vilSaysPresent(cl, after);
  ok(e === want, 'C 验证引擎 ' + name, 'got=' + e + ' want=' + want);
  ok(v === want, 'C 诊断层 ' + name, 'got=' + v + ' want=' + want);
  ok(v === e, 'C 两层同答 ' + name, 'vil=' + v + ' engine=' + e);
}

// ── D 组：证据层级（roleText 不进文本通道）───────────────────────────────────
console.log('=== D 组：证据层级 —— roleText 属元素证据 ===');
const roleOnly = obs({
  textSummary: 'plain page',
  visibleText: 'plain page',
  roleText: 'link: Delete account | button: Confirm',
});
ok(verification.verify({ type: 'text_present', expect: 'Delete account' }, roleOnly, null).success === false,
  'D1 仅存在于 roleText 的文本不得命中 text_present（aria-label 不是可见文本）');
ok(!/roleText/.test(vSrc), 'D2 验证引擎文本通道从不读 roleText（一致性基线）');
// D3 用**计数 + 位置**断言，而不是「有没有」：roleText 在诊断层只允许出现在 page_change 的
// 两侧构造函数 sideText 里（C124 D5 修的就是它——比较型谓词的两侧可以含 roleText，只要
// **两侧同口径**）。一旦其它通道又开始拼 roleText，计数会变，必须重新登记。
const roleTextHits = (viSrc.match(/roleText/g) || []).length;
ok(roleTextHits === 1, 'D3 诊断层 roleText 只用于 page_change 两侧构造（新用途需重新登记）', 'hits=' + roleTextHits);
ok(/const sideText = \(o\) => existence\.normalizeText\(\(o && \(o\.visibleText \|\| o\.textSummary\) \|\| ''\) \+ ' ' \+ \(o && o\.roleText \|\| ''\)\)/.test(viSrc),
  'D4 page_change 两侧仍用同一构造函数 sideText（C124 D5 不得回退）');

// ── E 组：fail-closed 与健壮性 ───────────────────────────────────────────────
console.log('=== E 组：fail-closed / 健壮性 ===');
const robust = [
  ['expect 为空串 → text_present 不成立', () => verification.verify({ type: 'text_present', expect: '' }, shortPage, null).success === false],
  ['expect 为空串 → text_absent 成立（无条件）', () => verification.verify({ type: 'text_absent', expect: '' }, shortPage, null).success === true],
  ['expect 为 undefined → text_present 不成立', () => verification.verify({ type: 'text_present' }, shortPage, null).success === false],
  ['after 文本字段全缺失 → 不抛异常', () => verification.verify({ type: 'text_present', expect: 'x' }, { url: 'u' }, null).success === false],
  ['after 为 null → 不抛异常', () => verification.verify({ type: 'text_present', expect: 'x' }, null, null).success === false],
  ['expect 含多空格 → 归一化后命中', () => verification.verify({ type: 'text_present', expect: 'app    shell' }, obs({ textSummary: 'app shell' }), null).success === true],
  ['expect 大小写不同 → 命中', () => verification.verify({ type: 'text_present', expect: 'WELCOME' }, shortPage, null).success === true],
];
for (const [name, fn] of robust) {
  let threw = null;
  let res = null;
  try { res = fn(); } catch (e) { threw = e; }
  ok(!threw && res === true, 'E ' + name, threw ? ('threw ' + threw.message) : ('res=' + res));
}
ok(clause.pageText(null) === '' && clause.pageText({}) === '',
  'E8 pageText 对 null / 空对象返回空串（不抛异常）');

// ── F 组：防空（断言有判别力，不是恒真）──────────────────────────────────────
console.log('=== F 组：防空断言 ===');
ok(verification.verify({ type: 'text_present', expect: 'nonexistent-zzz' }, longPage, null).success === false,
  'F1 长页面上不存在的文本仍须判不成立（不得为修 B1 而让 text_present 恒真）');
ok(clause.pageText(longPage) !== clause.pageText(shortPage),
  'F2 不同页面的文本证据不同（口径函数非常量）');
ok(verification.verify({ type: 'text_absent', expect: TAIL }, longPage, null).success === false,
  'F3 text_absent 与 text_present 共用同一证据源（不得一个宽一个窄，L6）');

console.log('\n=== C126 守护结果：通过 ' + pass + ' / 失败 ' + fail + ' ===');
process.exit(fail ? 1 : 0);
