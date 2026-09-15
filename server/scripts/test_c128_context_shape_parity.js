'use strict';

// =============================================================================
// C128 守护：**形状契约**（shape contract）× 页面文本口径收尾。
//
// ── 本批修的两件事（都属 L16「为不存在的形状写代码」家族）─────────────────────
// A1  `contextGuard.resolveCapabilities` 的「兜底现算」分支：
//       `detectCapabilities(obs, st)` 的契约入参是 `extractText(obs)` 的**抽取形状**
//       `{ text, url, elements }`，而调用方传的是**原始 observation** —— 原始观测没有 `text`
//       字段（observation.js:64 的 out 初值表）⇒ `text.toLowerCase()` 抛 TypeError
//       ⇒ 被 `catch (e) { /* 兜底失败即视为无能力证据 */ }` 静默吞掉 ⇒ **恒返回 `[]`**。
//       注释承诺「观察可得时兜底现算」，生产上**从未生效过一次**；且因为静默，无痕、不报错。
// B   页面文本口径的**剩余三个消费方**（diagnosisEngine / failureDiagnoser / skillRouter）
//       仍直读 `textSummary`（前 120 个筛选元素、截断 5000）或自建同义实现 ⇒ 收口到
//       `server/agent/pageText.js`（C126/C127 建立的唯一口径）。
//
// ── 本守护的价值排序 ────────────────────────────────────────────────────────
// A 组 = **形状真实性**（全库调用点扫描）：不测「某函数返回什么」，而测
//        「有没有人把不是这个形状的东西交给期望这个形状的函数」—— 这是唯一能咬住
//        「将来再加一个调用点又传错」的断言。
// B 组 = **行为探针**：喂生产真实形状，断言结果**发生变化**（改前必红的那些条）。
//        含一条端到端探针（恶意 Proxy）证明 catch 真的接到了留痕通道，而不是「看起来接上了」。
// C 组 = **口径唯一**：静态（不再直读字段 / 不再自建实现）+ 行为（长页面尾部信号被咬住）。
// D 组 = **放宽/收紧/未动 三向自检**：本批声明的边界必须与代码一致，边界被改动要红。
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// 本守护会 require 诊断层（间接引入 memory / store）—— 把数据根指到仓库内临时目录，
// 避免污染 server/data（C116 数据根纪律：FPB_DATA_DIR 是唯一覆盖口）。
// 若运行器已设置（隔离回归），保持不动。
if (!process.env.FPB_DATA_DIR) {
  process.env.FPB_DATA_DIR = path.join(ROOT, '.benchmark', 'c128_guard_tmp');
}

const classifier = require('../agent/pageStateClassifier.js');
const contextGuard = require('../agent/contextGuard.js');
const pageText = require('../agent/pageText.js');
const clause = require('../agent/verification/clause.js');
const router = require('../agent/skill/skillRouter.js');
const { fallbackDiagnosis } = require('../agent/diagnosis/diagnosisEngine.js');
const diagnoser = require('../agent/diagnosis/failureDiagnoser.js');

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
  return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// ── 生产观测的真实形状（observation.js:64 的 out 初值表 + :486/:493 的赋值）────
function rawObs(o) {
  const x = o || {};
  return {
    title: x.title || '',
    textSummary: x.textSummary === undefined ? '' : x.textSummary,
    visibleText: x.visibleText === undefined ? '' : x.visibleText,
    roleText: x.roleText || '',
    elements: x.elements || [],
    errors: [],
    loadingState: 'complete',
    domFingerprint: 'fp',
    url: x.url || 'https://example.test/app',
  };
}

const payObs = rawObs({ url: 'https://shop.example.test/pay', title: '支付', textSummary: '', visibleText: '支付金额 ¥199 确认支付 银行卡' });
const listingObs = rawObs({
  url: 'https://shop.example.test/products?page=2', title: 'Products',
  textSummary: '云服务器 2核4G 价格 ¥199 共 32 条 下一页',
  elements: [{ tag: 'a', role: 'link', text: '云服务器' }, { tag: 'button', role: 'button', text: '立即购买' }],
});
const blankObs = rawObs({ url: 'about:blank', title: '', textSummary: '', visibleText: '', elements: [] });

// ── A 组：形状契约 ──────────────────────────────────────────────────────────
console.log('=== A 组：形状契约（谁把不是这个形状的东西交给了期望这个形状的函数）===');

const PS_SRC = read('server/agent/pageStateClassifier.js');
const CG_SRC = read('server/agent/contextGuard.js');

ok(/function assertExtractedShape\s*\(/.test(PS_SRC) && /assertExtractedShape\(obs\);/.test(PS_SRC),
  'A1 detectCapabilities 有显式输入形状契约（不再依赖某一行偶然抛出的裸 TypeError）');
ok(/SHAPE_ERROR_CODE\s*=\s*'E_CAPABILITY_SHAPE'/.test(PS_SRC),
  'A2 形状违反带可归因 code（E_CAPABILITY_SHAPE）', 'src 无该常量');

// A3：唯一的调用点必须包 extractText（静态，咬的是本文件）
ok(/detectCapabilities\(classifier\.extractText\(obs\),\s*st\)/.test(CG_SRC),
  'A3 contextGuard 兜底传的是 extractText(obs) 的抽取形状，不是原始 observation');

// A4：★ 全库扫描 —— 将来任何新增调用点传错形状都要红（本守护的最高价值）
{
  const SKIP = new Set(['node_modules', 'data', 'scripts', 'logs', '_phase12_backup', 'release', '.git']);
  const files = [];
  (function walk(dir) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      if (SKIP.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'server'));

  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    // pageStateClassifier 自身是定义方与内部调用方（它传的就是 extractText 的结果）
    if (rel === 'server/agent/pageStateClassifier.js') continue;
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const re = /detectCapabilities\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!/extractText\s*\(/.test(m[1])) offenders.push(rel + ' :: ' + m[0].slice(0, 80));
    }
  }
  ok(files.length > 100, 'A4a 扫描面有效性：扫到了足够多的源文件（防空断言）', 'files=' + files.length);
  ok(offenders.length === 0,
    'A4b 全库 detectCapabilities 调用点全部先经 extractText（防新增调用点再次传错形状）',
    offenders.join(' | '));
}

// A5：形状根源 —— 生产观测**没有** `text` 字段（这正是「形状」不是「字段名」问题的原因）
{
  const obsSrc = read('server/agent/observation.js');
  const produced = new Set();
  const re = /\bout\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  let m;
  while ((m = re.exec(obsSrc)) !== null) produced.add(m[1]);
  ok(produced.has('textSummary') && produced.has('visibleText'),
    'A5a 生产观测产出 textSummary + visibleText', 'produced=' + Array.from(produced).sort().join(','));
  ok(!produced.has('text'),
    'A5b 生产观测**不产出** `text` 字段 ⇒ 抽取形状与原始观测是两个不同的形状（A1 的土壤）',
    'produced=' + Array.from(produced).sort().join(','));
}

// A6：兜底失败必须走留痕通道（静态接线）+ 留痕口径导出
ok(/recordCapabilityFallbackError\(e\)/.test(CG_SRC),
  'A6a catch 分支调用 recordCapabilityFallbackError（不再静默）');
ok(!/\/\* 兜底失败即视为无能力证据 \*\//.test(CG_SRC),
  'A6b 旧的静默 catch 注释已消失（不得回归）');
ok(typeof contextGuard.capabilityFallbackErrors === 'function'
  && typeof contextGuard.resetCapabilityFallbackErrors === 'function'
  && typeof contextGuard.resolveCapabilities === 'function',
  'A6c 留痕口径与兜底函数已导出（可被守护/归因消费）');

// ── B 组：行为探针 ──────────────────────────────────────────────────────────
console.log('=== B 组：行为探针（生产真实形状）===');

// B1 正路径：抽取形状可用
ok(classifier.detectCapabilities(classifier.extractText(payObs), 'PAYMENT').includes('payment'),
  'B1 detectCapabilities(extractText(rawObs), state) 正常工作（正路径未被契约断言误伤）');

// B2 ★ 死兜底探针：页面能力为空 + 给了观测 ⇒ 兜底**必须**现算出能力（改前恒 []）
{
  const g = contextGuard.guard(
    { type: 'payment', target: { semantic: '支付按钮' } },
    { state: 'PAYMENT', confidence: 0.85, signals: [] },
    { observation: payObs }
  );
  ok(g.capabilities.includes('payment'),
    'B2 ★ 兜底不再是死兜底：pageState 无 capabilities 但给了观测 ⇒ 现算出 payment（改前恒 []）',
    JSON.stringify(g.capabilities));
  ok(g.blocked === false, 'B2b 支付动作在支付页上仍放行（能力前提成立）', JSON.stringify(g));
}

// B3 同源同果不变量（生产行为中性的判据，报告 §1.4）：
//    ps 由 classify(同一 obs) 得到时，兜底现算结果必须与 ps.capabilities 完全一致
{
  const cases = [
    ['支付页', payObs], ['列表页', listingObs], ['空白页', blankObs],
    ['纯文本页', rawObs({ textSummary: 'hello world', visibleText: 'hello world' })],
  ];
  const bad = [];
  for (const [name, obs] of cases) {
    const ps = classifier.classify(obs);
    const viaFallback = contextGuard.resolveCapabilities(ps, { observation: obs });
    const viaClassify = ps.capabilities;
    if (JSON.stringify(viaFallback) !== JSON.stringify(viaClassify)) {
      bad.push(name + ': fallback=' + JSON.stringify(viaFallback) + ' classify=' + JSON.stringify(viaClassify));
    }
  }
  ok(bad.length === 0,
    'B3 不变量：兜底现算 ≡ classify(同一观测).capabilities（⇒ 生产链路行为中性）', bad.join(' | '));
}

// B4 双向（防空）：真空白观测 ⇒ 兜底仍返回空集（不得把兜底做成「恒非空」）
{
  const viaFallback = contextGuard.resolveCapabilities({ state: 'BLANK', confidence: 0.95 }, { observation: blankObs });
  ok(Array.isArray(viaFallback) && viaFallback.length === 0,
    'B4 双向：真空白观测 ⇒ 能力集合仍为空（防空断言）', JSON.stringify(viaFallback));
}

// B5 形状错误可归因：错误必须带 code，且信息指出「原始 observation 就是这种形状」
{
  let err = null;
  try { classifier.detectCapabilities(rawObs({ textSummary: 'x' }), 'GENERIC'); } catch (e) { err = e; }
  ok(!!err && err.code === 'E_CAPABILITY_SHAPE',
    'B5 直传原始 observation ⇒ 抛 E_CAPABILITY_SHAPE（不是裸 TypeError，可归因）',
    err ? String(err.code || err.message) : 'no throw');
  ok(!!err && /text/.test(String(err.message)),
    'B5b 错误信息指出缺的是 `text` 字段（自描述，不必回读源码）', err ? String(err.message).slice(0, 120) : '');
}

// B6 ★ 端到端探针：让异常**真实发生**并走到留痕通道（不是「看起来接上了」）
{
  contextGuard.resetCapabilityFallbackErrors();
  const hostile = new Proxy({}, { get() { throw new Error('BOOM-shape-probe'); } });
  let threw = false;
  let g = null;
  try {
    g = contextGuard.guard({ type: 'payment', target: { semantic: '支付按钮' } }, { state: 'PAYMENT', confidence: 0.85 }, { observation: hostile });
  } catch (e) { threw = true; }
  const errs = contextGuard.capabilityFallbackErrors();
  ok(threw === false, 'B6a 兜底异常不得把守卫带崩（fail-open 契约）');
  ok(!!g && g.blocked === false, 'B6b 兜底失败 ⇒ 视为无能力证据 ⇒ 放行（fail-open 闸门仍在）', JSON.stringify(g && g.blocked));
  ok(errs.length === 1 && /BOOM-shape-probe/.test(errs[0].message),
    'B6c ★ 异常真实到达留痕通道（端到端接线，不是静态声明）', JSON.stringify(errs));
}

// B7 留痕有界（内存态环形，不得无界增长）
{
  contextGuard.resetCapabilityFallbackErrors();
  const hostile = new Proxy({}, { get() { throw new Error('BOOM-bound'); } });
  for (let i = 0; i < contextGuard.MAX_FALLBACK_ERRORS + 5; i++) {
    contextGuard.guard({ type: 'payment' }, { state: 'PAYMENT' }, { observation: hostile });
  }
  const n = contextGuard.capabilityFallbackErrors().length;
  ok(n === contextGuard.MAX_FALLBACK_ERRORS,
    'B7 留痕有界：环形长度 = MAX_FALLBACK_ERRORS', 'n=' + n);
  contextGuard.resetCapabilityFallbackErrors();
  ok(contextGuard.capabilityFallbackErrors().length === 0, 'B7b reset 生效（守护之间不互相污染）');
}

// B8 fail-open 未松动：无观测 ⇒ 能力为空 ⇒ 一律放行
{
  const g = contextGuard.guard({ type: 'payment', target: { semantic: '支付按钮' } }, { state: 'GENERIC', confidence: 0.6, capabilities: [] }, {});
  ok(g.blocked === false, 'B8 fail-open 未松动（无观测 ⇒ 不阻断）', JSON.stringify(g));
}

// B9 ★ 收紧的**唯一**方向：兜底现在与 classify 同口径 ⇒ 手写 pageState（无 capabilities）时
//    守卫按真实页面形态判定（改前因兜底恒空而必然放行）。生产路径不受影响（B3）。
{
  const g = contextGuard.guard(
    { type: 'payment', target: { semantic: '支付按钮' } },
    { state: 'LISTING', confidence: 0.7, signals: [] },
    { observation: listingObs }
  );
  ok(g.blocked === true && g.code === 'CONTEXT_WRONG_APP' && g.guardMode === 'capability_missing',
    'B9 ★ 声明性收紧：列表页 + 无 capabilities 的手写 pageState ⇒ 支付动作被阻断（与 classify 口径一致）',
    JSON.stringify({ blocked: g.blocked, code: g.code, mode: g.guardMode, caps: g.capabilities }));
}

// ── C 组：口径唯一（页面文本剩余消费方）─────────────────────────────────────
console.log('=== C 组：口径唯一（剩余消费方收敛到 pageText.js）===');

const DE_SRC = read('server/agent/diagnosis/diagnosisEngine.js');
const FD_SRC = read('server/agent/diagnosis/failureDiagnoser.js');
const SR_SRC = read('server/agent/skill/skillRouter.js');

ok(!/\bobservation\s*&&\s*observation\.textSummary\b/.test(DE_SRC) && !/\.textSummary\b/.test(DE_SRC),
  'C1a diagnosisEngine 不再直读 textSummary（判定口径收口）', 'src 仍含 .textSummary');
ok(/require\('\.\.\/pageText'\)/.test(DE_SRC) && /pageText\(observation\)/.test(DE_SRC),
  'C1b diagnosisEngine 从 pageText.js 引入并用于判定');

ok(!/\bobs\.textSummary\b/.test(FD_SRC) && !/\bobs\.visibleText\b/.test(FD_SRC),
  'C2a failureDiagnoser 不再自行挑字段（textSummary || visibleText）', 'src 仍含直读');
ok(/require\('\.\.\/pageText'\)/.test(FD_SRC) && /pageText:\s*pageText\(obs\)/.test(FD_SRC),
  'C2b failureDiagnoser 的 pageText 字段走唯一口径');

ok(!/\[\s*obs\s*&&\s*obs\.textSummary/.test(SR_SRC) && !/\bobs\.visibleText\b/.test(SR_SRC),
  'C3a skillRouter 的 text_present 不再自建同义实现（拼 textSummary + visibleText）', 'src 仍含自建拼串');
ok(/require\('\.\.\/pageText'\)/.test(SR_SRC) && /const text = pageText\(obs\);/.test(SR_SRC),
  'C3b skillRouter 的 text_present 文本来源 = pageText(obs)');

// C4 口径定义仍唯一（pageText.js ∪ clause.js 只允许一份 `function pageText`；\b 不可去）
{
  const PT_SRC = read('server/agent/pageText.js');
  const CL_SRC = read('server/agent/verification/clause.js');
  const defs = (CL_SRC.match(/function\s+pageText\b/g) || []).length + (PT_SRC.match(/function\s+pageText\b/g) || []).length;
  ok(defs === 1, 'C4 全库 pageText 定义唯一（clause.js ∪ pageText.js）', 'defs=' + defs);
  ok(clause.pageText === pageText.pageText, 'C4b clause.pageText 与 pageText.pageText 同一函数引用');
}

// C5 ★ 行为：诊断兜底必须咬住**只存在于 visibleText** 的会话失效提示（改前落到 ELEMENT_CHANGED）
{
  const d = fallbackDiagnosis({
    classifier: { type: 'ELEMENT_NOT_FOUND', confidence: 0.6, evidence: ['未找到元素'] },
    failure: { url: 'https://app.example.test/dashboard' },
    observation: rawObs({
      url: 'https://app.example.test/dashboard',
      textSummary: '欢迎回来 数据看板 本月活跃用户 12,480',
      visibleText: '欢迎回来\n数据看板\n本月活跃用户 12,480\nYour session has expired, please sign in again',
    }),
    step: { action: { target: { semantic: '导出报表按钮' } } },
  });
  ok(d.category === 'SESSION_EXPIRED',
    'C5 ★ 只在 visibleText 的会话失效提示 ⇒ category = SESSION_EXPIRED（改前 = ELEMENT_CHANGED）',
    'category=' + d.category);
}

// C6 ★ 行为：同一形状下的 403 判定（诊断兜底三条判定的第二组）
{
  const d = fallbackDiagnosis({
    classifier: { type: 'ELEMENT_NOT_FOUND', confidence: 0.6, evidence: [] },
    failure: { url: 'https://app.example.test/reports' },
    observation: rawObs({
      textSummary: '报表中心 导出 CSV',
      visibleText: '报表中心\nAccess denied — you do not have permission to view this report',
    }),
    step: { action: { target: { semantic: '导出按钮' } } },
  });
  ok(d.category === 'HTTP_FORBIDDEN',
    'C6 ★ 只在 visibleText 的 Access denied ⇒ category = HTTP_FORBIDDEN（改前 = ELEMENT_CHANGED）',
    'category=' + d.category);
}

// C7 ★ 行为：failureDiagnoser.fromObservation 把页面全文交给 page.text 判定消费方
{
  const d = diagnoser.fromObservation(null, 'ELEMENT_NOT_FOUND', {
    url: 'https://app.example.test/dashboard',
    textSummary: '欢迎回来 数据看板',
    visibleText: '欢迎回来\n数据看板\nYour session has expired, please sign in again',
  }, { attempted: true });
  const hit = (d.findings || []).some((f) => f.code === 'BUSINESS_SESSION_EXPIRED' && f.source === 'page.text');
  ok(hit, 'C7 ★ 只在 visibleText 的会话失效文案 ⇒ 产出 page.text 类 BUSINESS_SESSION_EXPIRED finding（改前无）',
    JSON.stringify((d.findings || []).map((f) => f.code)));
  ok(d.rootCause === 'BUSINESS_SESSION_EXPIRED',
    'C7b rootCause 随之落到 BUSINESS_SESSION_EXPIRED（口径放宽的真实效果）', 'rootCause=' + d.rootCause);
}

// C8 ★ 行为：skillRouter 的 text_present 认**历史快照形状**（visibleTexts 复数）—— 改前 INDETERMINATE
{
  const v = router.clauseVerdict({ type: 'text_present', expect: '导出报表' }, { visibleTexts: ['导出报表', '首页'] });
  ok(v === 'TRUE', 'C8 ★ 快照历史形状（visibleTexts）能被 skill 层判定为 TRUE（改前 INDETERMINATE）', 'verdict=' + v);
  const v2 = router.clauseVerdict({ type: 'text_present', expect: '导出报表' }, {});
  ok(v2 === 'INDETERMINATE', 'C8b 双向：真无文本 ⇒ 仍 INDETERMINATE（策略未放宽）', 'verdict=' + v2);
}

// C9 跨层一致（登记安全矩阵：不触发两层归一化口径差异的输入）
{
  const cases = [
    [{ textSummary: '', visibleText: '支付金额 确认支付' }, '确认支付'],
    [{ textSummary: 'Welcome back', visibleText: 'welcome back' }, 'welcome'],
    [{ visibleText: '导出 CSV' }, '导出 CSV'],
    [{ textSummary: 'order confirmed', visibleText: 'Order Confirmed' }, 'order confirmed'],
  ];
  const bad = [];
  for (const [o, expect] of cases) {
    const v = router.clauseVerdict({ type: 'text_present', expect }, o);
    const c = clause.evalTextPresent(o, expect).ok ? 'TRUE' : 'FALSE';
    if (v !== c) bad.push(expect + ': skill=' + v + ' clause=' + c);
  }
  ok(bad.length === 0, 'C9 skill 层与 clause 层的 text_present 在登记安全矩阵上一致', bad.join(' | '));
}

// C10 登记边界（未修，A2 独立批次）：两层对 expect 的**标点归一化**口径不同
//    skillRouter.norm 把标点折叠成空格；clause 的 normalizeText 只折叠空白+小写。
//    本断言的作用是「边界被无声改变就红」——不是要求两层一致。
{
  const v = router.clauseVerdict({ type: 'text_present', expect: 'a.b' }, { visibleText: 'a b' });
  const c = clause.evalTextPresent({ visibleText: 'a b' }, 'a.b').ok ? 'TRUE' : 'FALSE';
  ok(v === 'TRUE' && c === 'FALSE',
    'C10 登记边界仍存在：标点归一化差异（skill=TRUE / clause=FALSE）—— 统一属 A2 独立批次，本批不动',
    'skill=' + v + ' clause=' + c);
}

// ── D 组：放宽 / 收紧 / 未动 三向自检 ───────────────────────────────────────
console.log('=== D 组：放宽 / 收紧 / 未动 三向自检 ===');

// D1 未动：诊断兜底的三条正则与**分支顺序**（403 → session → cookie）
{
  const order = ['\\b403\\b|forbidden|access denied', 'session expired|please login|please sign in', 'cookie|consent|accept all'];
  const idx = order.map((s) => DE_SRC.indexOf(s));
  ok(idx.every((i) => i >= 0) && idx[0] < idx[1] && idx[1] < idx[2],
    'D1 未动：三条判定的正则与分支顺序未变（只换文本来源，不改公式）', JSON.stringify(idx));
  ok(/conf = 0\.9;/.test(DE_SRC), 'D1b 未动：OBSTRUCTION 的 confidence 常量未变');
}

// D2 未动：成功裁决面（verification.js）本批未动 —— 若此处红，必须回报告更新「放宽了什么」
{
  const VERIF_SRC = read('server/agent/verification.js');
  ok(/const text = \(after && after\.textSummary\) \|\| '';/.test(VERIF_SRC),
    'D2 未动登记：verification.js 的 dom_changed 文本面本批未改（红 ⇒ 必须更新报告的三向声明）');
}

// D3 未动：CAPTCHA 弱信号面（botChallenge）与 prompt 预算面（contextBuilder/planner/deepseek）本批未动
{
  const bc = read('server/agent/botChallenge.js');
  const cb = read('server/agent/contextBuilder.js');
  ok(/obs\.textSummary/.test(bc) && /obs\.visibleText/.test(bc),
    'D3a 未动登记：botChallenge 的文本构造本批未改（CAPTCHA 面须独立归因批）');
  ok(/observation\.textSummary/.test(cb),
    'D3b 未动登记：contextBuilder 的 Planner 上下文文本面本批未改（prompt 预算面）');
}

console.log('\n=== C128 结果：' + pass + ' / ' + (pass + fail) + ' ===');
if (fail > 0) process.exitCode = 1;
