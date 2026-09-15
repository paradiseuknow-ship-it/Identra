'use strict';

// =============================================================================
// C127 守护：页面文本通道的**字段名真实性**与**唯一口径**。
//
// ── 本批修的事故模式（比 C126 更隐蔽）────────────────────────────────────────
// 页面文本有四个消费方，其中两个（pageReady.textOf / pageStateClassifier.extractText）
// 优先读取 `visibleTexts`（**复数**）—— 而生产观测（observation.js:64/486/493）只产出
// `textSummary`(string) + `visibleText`(string) + `roleText`(string)，**从不产出复数名**。
// 于是「优先分支」永不可达、恒静默回落窄口径 textSummary（前 120 个筛选元素、截断 5000）。
// 同时 failureSnapshot.js 为 `Array.isArray(observation.textSummary)`（textSummary 是**字符串**）
// 写了第二个永不可达的分支。而这两个不存在的形状**只活在测试 fixture 里**
// （test_phase6.js 全用 `{visibleTexts:[...]}`；testAgentPhase22.js 用 `textSummary:[...]`）
// ⇒ 守护全绿、生产带伤。
//
// 因此本守护的最高价值是 **A 组（字段名真实性）**：它不测「某个函数返回什么」，
// 而是测「消费者读的字段名是否真的会被上游产出」—— 这是 L2「隔离测试盲区」的通用护栏，
// 也是唯一能咬住「为 fixture 而写的分支」的断言。
//
// A 组 = 结构性（读生产源码的产出集合 vs 消费集合）
// B/D 组 = 行为探针（喂**生产真实形状**，断言结果变化）
// C 组 = 唯一口径（同一函数引用 + 消费方不得直读字段）
// E 组 = fail-closed / 防空（避免把「恒不成立」写成新默认）
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const pageText = require('../agent/pageText.js');
const pageReady = require('../agent/pageReady.js');
const classifier = require('../agent/pageStateClassifier.js');
const clause = require('../agent/verification/clause.js');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const OBS_SRC = stripComments(read('server/agent/observation.js'));
const PR_SRC = stripComments(read('server/agent/pageReady.js'));
const PS_SRC = stripComments(read('server/agent/pageStateClassifier.js'));
const FS_SRC = stripComments(read('server/agent/recovery/failureSnapshot.js'));
const CL_SRC = stripComments(read('server/agent/verification/clause.js'));
const PT_SRC = stripComments(read('server/agent/pageText.js'));

// 文本通道相关字段名（全库范围）
const TEXT_FIELDS = ['textSummary', 'visibleText', 'visibleTexts', 'roleText', 'contentLeaves'];

// 非法读取：`obs.<field>` / `o.<field>` / `after.<field>` 这类直接取字段
function directReads(src) {
  const found = new Set();
  for (const f of TEXT_FIELDS) {
    const re = new RegExp('\\b(after|obs|o|observation)\\s*&&\\s*\\1\\.' + f + '\\b|\\b(after|obs|o|observation)\\.' + f + '\\b', 'g');
    if (re.test(src)) found.add(f);
  }
  return found;
}

// ── A 组：字段名真实性（本守护的核心）────────────────────────────────────────
console.log('=== A 组：消费方读取的字段名必须在生产产出集合内 ===');

// A1：生产产出集合（observation.js 里 out.<field> = ... 的赋值）
const produced = new Set();
{
  const re = /\bout\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  let m;
  while ((m = re.exec(OBS_SRC)) !== null) produced.add(m[1]);
}
ok(produced.has('textSummary') && produced.has('visibleText'),
  'A1 observation.js 必须产出 textSummary + visibleText（生产观测的真实形状）',
  'produced=' + Array.from(produced).sort().join(','));
ok(!produced.has('visibleTexts'),
  'A2 observation.js **不得**产出 visibleTexts（复数）—— 该形状只属于失败快照',
  'produced=' + Array.from(produced).sort().join(','));
ok(produced.has('roleText'), 'A3 observation.js 产出 roleText（元素级证据，不进文本通道）');

// A4：文本通道消费方不得再直接读 `visibleTexts`（复数）—— 一律经 pageText 兼容
for (const [name, src] of [['pageReady.js', PR_SRC], ['pageStateClassifier.js', PS_SRC], ['clause.js', CL_SRC]]) {
  ok(!/\bvisibleTexts\b/.test(src), 'A4 ' + name + ' 不再直接读 visibleTexts（复数名），改走 pageText 唯一通道');
}
ok(/\bvisibleTexts\b/.test(PT_SRC) && /\bvisibleTexts\b/.test(FS_SRC),
  'A5 visibleTexts 只允许出现在 pageText.js（兼容层）与 failureSnapshot.js（写入方）');

// A6：消费方不得再直读 textSummary / visibleText 做文本构造
ok(!directReads(PR_SRC).has('textSummary') && !directReads(PR_SRC).has('visibleText'),
  'A6 pageReady 不直读 textSummary/visibleText', 'reads=' + Array.from(directReads(PR_SRC)).join(','));
ok(!directReads(PS_SRC).has('textSummary') || !/extractText[\s\S]{0,400}?\.textSummary/.test(PS_SRC),
  'A7 pageStateClassifier.extractText 不直读 textSummary/visibleText',
  'reads=' + Array.from(directReads(PS_SRC)).join(','));

// A8：死分支不得回归（为「不存在的形状」写分支）
ok(!/Array\.isArray\([^)]*textSummary/.test(FS_SRC),
  'A8 failureSnapshot 不得再为 Array.isArray(textSummary) 写分支（textSummary 恒为字符串）');
ok(!/Array\.isArray\([^)]*textSummary/.test(PS_SRC) && !/Array\.isArray\([^)]*textSummary/.test(PR_SRC),
  'A9 pageStateClassifier / pageReady 不得为数组型 textSummary 写分支');

// A10：守护 fixture 自身必须用生产形状（源头防再犯）
{
  // 剥注释后再查（本批的修复说明里会引用旧形态；静态断言必须 stripComments，见 L3）
  const p6 = stripComments(read('server/scripts/test_phase6.js'));
  const p22 = stripComments(read('server/scripts/testAgentPhase22.js'));
  ok(!/textSummary\s*:\s*\[/.test(p22), 'A10 testAgentPhase22 的 fixture 不得再用数组型 textSummary（对齐生产形状）');
  ok(/visibleText\s*:/.test(p22), 'A10b testAgentPhase22 的 fixture 必须覆盖 visibleText（生产真实字段）');
  ok(/\bvisibleTexts\b/.test(p6),
    'A10c test_phase6 继续用 visibleTexts 时，其语义只能是「失败快照的历史形状」（本轮已登记，见报告 §6）');
}

// ── B 组：行为探针（生产形状：textSummary 为空、visibleText 有内容）──────────
console.log('=== B 组：行为探针（生产真实形状）===');
const pureTextPage = { textSummary: '', visibleText: '正文内容仅存在于未被采集的文本节点' };
ok(pageReady.isPageReady(pureTextPage) === true,
  'B1 文本只在 visibleText ⇒ isPageReady 必须为 true（修复前恒 false，8s 就绪等待被耗尽）');
ok(pageReady.isPageReady({ textSummary: '', visibleText: '   ' }) === false,
  'B2 双向：真正空白页仍判未就绪（防空断言，避免把修复做成恒真）');
ok(classifier.classify({ textSummary: '', visibleText: '未找到相关商品' }).state === 'EMPTY_RESULT',
  'B3 空结果信号只在 visibleText ⇒ 不得再误判 BLANK(0.95)');
ok(classifier.classify({ textSummary: '', visibleText: '支付金额 确认支付' }).state === 'PAYMENT',
  'B4 支付信号只在 visibleText ⇒ 状态与能力标签必须取到');
ok(classifier.classify({ textSummary: '', visibleText: '支付金额' }).capabilities.includes('payment'),
  'B5 能力标签（contextGuard 动作前提校验的输入）不再因窄口径缺失');
ok(classifier.classify({ textSummary: '', visibleText: '' }).state === 'BLANK',
  'B6 双向：真空白仍判 BLANK（防空）');
ok(classifier.classify({ textSummary: '正文', visibleText: '正文' }).state !== 'BLANK',
  'B7 双向：有文本恒不判 BLANK');
// 长页面尾部信号（textSummary 窗口外）
{
  const long = { textSummary: 'header', visibleText: 'header\n' + 'filler '.repeat(1200) + '\n支付金额' };
  ok(classifier.classify(long).state === 'PAYMENT', 'B8 长页面尾部信号（120 元素窗口外）必须被取到');
}

// ── C 组：唯一口径（不留第二份实现）─────────────────────────────────────────
console.log('=== C 组：唯一口径 ===');
ok(clause.pageText === pageText.pageText,
  'C1 clause.pageText 与 pageText.pageText 是同一函数引用（不是同义副本）');
ok(/require\('\.\.\/pageText'\)/.test(CL_SRC), 'C2 clause.js 从 pageText.js 引入（下沉，不是复制）');
ok(/require\('\.\/pageText'\)/.test(PR_SRC) && /require\('\.\/pageText'\)/.test(PS_SRC),
  'C3 pageReady / pageStateClassifier 从同一模块引入');
ok(/require\('\.\.\/pageText'\)/.test(FS_SRC), 'C4 failureSnapshot 从同一模块引入');
{
  // ★ 注意必须用 \b：`function pageTextLines` 也以 `function pageText` 开头，
  //   少了词边界会把 pageTextLines 误计为第二份口径实现（首版守护即踩此坑）。
  const defs = (CL_SRC.match(/function\s+pageText\b/g) || []).length + (PT_SRC.match(/function\s+pageText\b/g) || []).length;
  ok(defs === 1, 'C5 全库 pageText 定义唯一（clause.js ∪ pageText.js）', 'defs=' + defs);
}
ok(!/'visibleText'/.test(CL_SRC) && !/'textSummary'/.test(CL_SRC),
  'C6 clause.js 不再自行拼串（文本构造已下沉）');

// ── D 组：证据层级与快照语义 ────────────────────────────────────────────────
console.log('=== D 组：证据层级与快照语义 ===');
ok(!pageText.pageText({ roleText: 'aria-label-secret' }).includes('aria-label-secret'),
  'D1 roleText 不得进入文本通道（元素级证据，混入会造成 text_present 假阳性）');
ok(!pageText.pageText({ textSummary: '', visibleText: '', roleText: 'only-role' }).includes('only-role'),
  'D2 roleText 单独存在时文本通道仍为空');
{
  const lines = pageText.pageTextLines({ textSummary: 'Login', visibleText: 'Login\nProceed\nLogin' });
  ok(Array.isArray(lines) && lines.length === 2 && lines.includes('Proceed'),
    'D3 pageTextLines 输出真实行 + 去重', JSON.stringify(lines));
  ok(pageText.pageTextLines({ visibleText: 'lineA\nlineB' }).some((l) => /[A-Z]/.test(l)),
    'D4 取证行保留原始大小写（诊断 prompt 可读性）');
  ok(pageText.pageText({ visibleText: 'LineA' }) === 'linea',
    'D5 判定文本走小写归一化（与子句 expect 同口径）');
  ok(JSON.stringify(pageText.pageTextLines({ visibleTexts: ['x', 'y'] })) === JSON.stringify(['x', 'y']),
    'D6 快照历史形状（visibleTexts 数组）仍被兼容');
}
{
  // 快照写入侧：真实行而非单块 2000 字符
  const snapSrc = FS_SRC;
  ok(/pageTextLines\(observation/.test(snapSrc), 'D7 failureSnapshot 用 pageTextLines 生成 visibleTexts');
  ok(/MAX_SNAPSHOT_TEXT_CHARS/.test(snapSrc), 'D8 快照有明确体积上限（有界集合的存储约束）');
}

// ── E 组：fail-closed / 防空 ────────────────────────────────────────────────
console.log('=== E 组：fail-closed / 防空 ===');
ok(pageText.pageText(null) === '' && pageText.pageText({}) === '' && pageText.pageText(undefined) === '',
  'E1 pageText 对 null / undefined / {} 返回空串（不抛异常）');
ok(Array.isArray(pageText.pageTextLines(null)) && pageText.pageTextLines(null).length === 0,
  'E2 pageTextLines 对 null 返回空数组');
ok(pageText.pageText({ textSummary: null, visibleText: undefined }) === '',
  'E3 非字符串字段不得变成 "null"/"undefined" 文本');
ok(clause.evalTextPresent({}, 'x').ok === false,
  'E4 空观察下 text_present 仍 fail-closed（不成立）');
ok(clause.evalTextAbsent({}, 'x').ok === true,
  'E5 空观察下 text_absent 仍成立（既有语义不变）');
{
  const long = 'z'.repeat(pageText.MAX_CHARS + 1000);
  const lines = pageText.pageTextLines({ visibleText: long });
  ok(lines.join('').length === pageText.MAX_CHARS,
    'E6 单段超长文本必须被截到上限 —— 不得因「超限即 break」返回空数组（本批实测的真实回归）',
    'got=' + lines.join('').length);
}
{
  const short = pageText.pageTextLines({ visibleText: 'a\nb\nc' }, { maxChars: 2 });
  ok(short.join('|') === 'a|b', 'E7 maxChars 选项生效', JSON.stringify(short));
}
ok(pageText.pageText(pageText.pageText({}) === '' ? null : null) === '', 'E8 幂等：空输入恒空');
{
  const p = { textSummary: 'A', visibleText: 'B' };
  ok(pageText.pageText(p) === pageText.pageText(p), 'E9 纯函数：同输入同输出');
}

console.log('\n=== C127 结果：' + pass + ' / ' + (pass + fail) + ' ===');
if (fail > 0) process.exitCode = 1;
