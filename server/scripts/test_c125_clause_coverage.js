'use strict';

// C125 守护：业务子句覆盖面与跨层一致性。
//
// 守护对象：verification.js（验证引擎，最终判定权）与 verificationIntelligence.js
// （诊断层 clausePresent）对同一条 requiredEvidence 子句必须给出**同一答案**。
// C124 已修 element_present/element_absent/page_change 三处跨层分歧；本批修的是
// **覆盖面**：storage / url_pattern / login_state 在诊断层根本没有分支 ⇒ 落 default:false
// ⇒ 含它们的业务契约在诊断层结构性不可能成立 ⇒ 4b「其实已达成 ⇒ TOO_STRICT」永远走不到
// ⇒ 真实成功被 4c 判「证据不足」升级人工（HUMAN_ESCALATION 上升）。
//
// 最高价值的一条是 D 组：覆盖面自动对账。它把「两个 switch 的分支集合」做成断言，
// 今后任何新增子句类型只改一层都会红 —— 这是把本次事故模式固化成结构性护栏。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const vil = require('../agent/verification/verificationIntelligence.js');
const verification = require('../agent/verification.js');
const clause = require('../agent/verification/clause.js');
const contract = require('../agent/verification/contract.js');
const skillSchema = require('../agent/skill/skillSchema.js');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function afterObs(o) {
  const opts = o || {};
  return {
    url: opts.url || 'https://example.test/app',
    loadingState: 'complete',
    networkState: 'idle',
    textSummary: opts.textSummary || 'app shell rendered',
    visibleText: opts.textSummary || 'app shell rendered',
    roleText: opts.roleText || '',
    elements: opts.elements || [],
    contentLeaves: opts.contentLeaves || [],
    storage: opts.storage === undefined ? null : opts.storage,
  };
}

const DEFAULT_BEFORE = afterObs({ url: 'https://example.test/start', textSummary: 'app shell rendered' });

// 诊断层：走真实 analyze，用 4b 的 TOO_STRICT 作为「契约在观察中达成」的观测量。
function vilSaysPresent(evidenceClause, after, before) {
  const r = vil.analyze({
    beforeObservation: before || DEFAULT_BEFORE,
    afterObservation: after,
    expectedVerification: {
      businessState: {
        stateType: 'T',
        requiredEvidence: [evidenceClause],
        evidenceLogic: 'AND',
        forbiddenEvidence: [],
      },
    },
    actionResult: { success: true },
    action: { type: 'click', risk: 'LOW', target: { semantic: 'continue' } },
  });
  return r.failureType === 'VERIFICATION_TOO_STRICT';
}

// 验证引擎：走真实 verify（businessState 分支委托 contract.evaluateContract）。
function engineSaysPresent(evidenceClause, after, before) {
  const r = verification.verify({
    businessState: {
      stateType: 'T',
      requiredEvidence: [evidenceClause],
      evidenceLogic: 'AND',
      forbiddenEvidence: [],
    },
  }, after, before || DEFAULT_BEFORE);
  return !!r.success;
}

// ── A 组：跨层 parity（同一子句 + 同一观察，两层必须同答）─────────────────────
console.log('=== A 组：跨层 parity（诊断层 vs 验证引擎）===');
const STORE_OK = { localStorage: { authenticated: 'true' }, sessionStorage: {} };

const parityCases = [
  ['storage 键存在且等值 → 成立', { type: 'storage', storageType: 'localStorage', key: 'authenticated', equals: 'true' }, afterObs({ storage: STORE_OK }), true],
  ['storage 键存在但值不等 → 不成立', { type: 'storage', storageType: 'localStorage', key: 'authenticated', equals: 'false' }, afterObs({ storage: STORE_OK }), false],
  ['storage 键不存在 → 不成立', { type: 'storage', storageType: 'localStorage', key: 'nope' }, afterObs({ storage: STORE_OK }), false],
  ['storage exists:false 且键确实不存在 → 成立', { type: 'storage', storageType: 'localStorage', key: 'nope', exists: false }, afterObs({ storage: STORE_OK }), true],
  ['storage 观察层未采集 → fail-closed 不成立', { type: 'storage', key: 'authenticated' }, afterObs({ storage: null }), false],
  ['storage sessionStorage 隔离', { type: 'storage', storageType: 'sessionStorage', key: 'authenticated' }, afterObs({ storage: STORE_OK }), false],
  ['url_pattern 匹配 → 成立', { type: 'url_pattern', pattern: '/dashboard$' }, afterObs({ url: 'https://example.test/dashboard' }), true],
  ['url_pattern 不匹配 → 不成立', { type: 'url_pattern', pattern: '/login$' }, afterObs({ url: 'https://example.test/dashboard' }), false],
  ['url_pattern 非法正则 → fail-closed 不成立', { type: 'url_pattern', pattern: '[' }, afterObs({ url: 'https://example.test/dashboard' }), false],
  ['login_state 有登出线索无登录线索 → 不成立', { type: 'login_state' }, afterObs({ textSummary: 'sign in to continue' }), false],
  ['login_state 有登录后线索 → 成立', { type: 'login_state' }, afterObs({ textSummary: 'welcome back, logout' }), true],
];

for (const [name, cl, after, want] of parityCases) {
  const v = vilSaysPresent(cl, after);
  const e = engineSaysPresent(cl, after);
  ok(v === want, 'A 诊断层 ' + name, 'got=' + v + ' want=' + want);
  ok(e === want, 'A 验证引擎 ' + name, 'got=' + e + ' want=' + want);
  ok(v === e, 'A 两层同答 ' + name, 'vil=' + v + ' engine=' + e);
}

// ── B 组：P2 无效证据守卫（恒真证据不算存在，两层同口径）───────────────────────
console.log('=== B 组：P2 恒真证据守卫 ===');
const sameBefore = afterObs({ url: 'https://example.test/dashboard', textSummary: 'app shell rendered' });
const patPre = { type: 'url_pattern', pattern: '/dashboard$' };
ok(clause.evalUrlPattern(patPre, sameBefore, sameBefore).ok === false,
  'B1 url_pattern 在 before 已匹配 ⇒ 判不成立（恒真证据不证明本次动作）');
ok(clause.evalUrlPattern(patPre, sameBefore, sameBefore).invalidEvidence === 'precondition_true',
  'B2 守卫需带回 invalidEvidence 标记（上层据此拒绝而非静默失败）');
ok(clause.evalUrlPattern(patPre, afterObs({ url: 'https://example.test/dashboard' }), DEFAULT_BEFORE).ok === true,
  'B3 before 未匹配时正常成立（守卫不得反向放宽或误杀）');
// query 注入不构成「表面已存在」（C105 F3）
const injected = afterObs({ url: 'https://other.test/fr?pscd=example.test' });
ok(clause.evalUrlPattern({ type: 'url_pattern', pattern: 'example\\.test' }, injected, null).ok === true,
  'B4 url_pattern 在 query 上的命中不算「动作前已成立」（F3 表面键）');

// ── C 组：fail-closed 与不抛异常 ──────────────────────────────────────────────
console.log('=== C 组：fail-closed / 健壮性 ===');
const afterBase = afterObs({ url: 'https://example.test/app', storage: STORE_OK });
const robust = [
  ['clause 为 undefined', () => clause.evalStorage(undefined, afterBase).ok === false],
  ['clause 为 null', () => clause.evalUrlPattern(null, afterBase, null).ok === false],
  ['pattern 为空串', () => clause.evalUrlPattern({ type: 'url_pattern', pattern: '' }, afterBase, null).ok === false],
  ['pattern 超长(201)', () => clause.evalUrlPattern({ type: 'url_pattern', pattern: 'a'.repeat(201) }, afterBase, null).ok === false],
  ['pattern 刚好 200 且合法', () => clause.evalUrlPattern({ type: 'url_pattern', pattern: 'a'.repeat(200) }, afterBase, null).ok === false],
  ['storage 缺 key', () => clause.evalStorage({ type: 'storage' }, afterBase).ok === false],
  ['storage storageType 非法回退 localStorage', () => clause.evalStorage({ type: 'storage', storageType: 'bogus', key: 'authenticated' }, afterBase).ok === true],
  ['storage after 为 null', () => clause.evalStorage({ type: 'storage', key: 'k' }, null).ok === false],
  ['login_state 文本为 null', () => clause.evalLoginState(null).ok === true],
];
for (const [name, fn] of robust) {
  let threw = null;
  let res = null;
  try { res = fn(); } catch (e) { threw = e; }
  ok(!threw && res === true, 'C ' + name, threw ? ('threw ' + threw.message) : ('res=' + res));
}

// ── D 组：覆盖面自动对账（本批最高价值 —— 把事故模式固化成结构性护栏）───────────
console.log('=== D 组：两层 switch 覆盖面自动对账 ===');
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function casesOf(file, marker) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const i = src.indexOf(marker);
  if (i < 0) return null;
  const seg = src.slice(i);
  const set = new Set();
  const re = /case\s+'([a-zA-Z_]+)'\s*:/g;
  let m = null;
  while ((m = re.exec(seg))) set.add(m[1]);
  return set;
}
const engineCases = casesOf(path.join(ROOT, 'server', 'agent', 'verification.js'), 'switch (type) {');
const vilCases = casesOf(path.join(ROOT, 'server', 'agent', 'verification', 'verificationIntelligence.js'), 'switch (cl.type) {');
ok(!!engineCases && engineCases.size > 0, 'D0 解析到验证引擎 switch 分支集', 'size=' + (engineCases ? engineCases.size : 'null'));
ok(!!vilCases && vilCases.size > 0, 'D0 解析到诊断层 switch 分支集', 'size=' + (vilCases ? vilCases.size : 'null'));

// 登记式差集守护：诊断层缺失的类型必须**显式登记并给出理由**；未登记即红。
// action_success：语义是「动作执行成功」。诊断层只在「动作已成功但仍验证失败」时被调用，
//   此时它恒真 ⇒ 会把任何失败都解释成 TOO_STRICT（谎报达成）。故**有意不覆盖**。
// （none 不在此表：它不是 switch 分支，验证引擎在进入 switch 之前就短路处理，见 D5。）
const REGISTERED_GAPS = {
  action_success: '诊断层有意不覆盖：动作已成功时该子句恒真，覆盖会把一切失败解释成验证过严',
};
const missing = [...engineCases].filter((t) => !vilCases.has(t));
const unregistered = missing.filter((t) => !Object.prototype.hasOwnProperty.call(REGISTERED_GAPS, t));
ok(unregistered.length === 0, 'D1 诊断层不得出现**未登记**的覆盖面缺口', 'unregistered=[' + unregistered.join(',') + ']');
ok(missing.length === Object.keys(REGISTERED_GAPS).length,
  'D2 差集必须与登记表完全一致（登记表过期也要红）',
  'missing=[' + missing.join(',') + '] registered=[' + Object.keys(REGISTERED_GAPS).join(',') + ']');
for (const t of missing) {
  ok(!!REGISTERED_GAPS[t], 'D3 缺口 ' + t + ' 已登记理由', REGISTERED_GAPS[t] || '(无)');
}
ok(!engineCases.has('none'),
  'D5 none 不进入分支集（验证引擎在 switch 之前短路；若它变成 case 则说明结构变了，需重新登记）',
  'engineCases=[' + [...engineCases].join(',') + ']');
// 曾真实缺失的三个类型必须在案（防止有人整体删掉分支）
for (const t of ['storage', 'url_pattern', 'login_state']) {
  ok(vilCases.has(t), 'D4 诊断层必须覆盖 ' + t + '（C125 修复项，删则红）');
}

// ── E 组：唯一实现（不得复活第二份同义实现，L6）────────────────────────────────
console.log('=== E 组：唯一实现与委托 ===');
const vSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'verification.js'), 'utf8'));
const viSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'verification', 'verificationIntelligence.js'), 'utf8'));
ok(/require\('\.\/verification\/clause'\)/.test(vSrc), 'E1 验证引擎委托 clause.js');
ok(/require\('\.\/clause'\)/.test(viSrc), 'E2 诊断层委托 clause.js');
// 判定核心不得在消费层复写：hasOwnProperty + storage 取值、new RegExp、登录态正则
ok(!/hasOwnProperty\.call\(store/.test(vSrc) && !/hasOwnProperty\.call\(store/.test(viSrc),
  'E3 storage 取值判定只在 clause.js（消费层不得复写）');
// 登录态正则字面量只能有一处
const loginReCount = (vSrc.match(/sign in\|log in\|login\|register\|create account/g) || []).length
  + (viSrc.match(/sign in\|log in\|login\|register\|create account/g) || []).length;
ok(loginReCount === 0, 'E4 登录态正则字面量不在消费层（唯一实现在 clause.js）', 'count=' + loginReCount);
ok((vSrc.match(/new RegExp\(/g) || []).length === 0, 'E5 url_pattern 编译不在消费层', 'count=' + (vSrc.match(/new RegExp\(/g) || []).length);

// E6/E7：skill 层的 url_pattern 用 **expect** 字段且只匹配 path（skillRouter.clauseVerdict，
// 三值裁决），验证引擎用 **pattern** 字段且匹配完整 url —— 这是两层的字段与语义约定不同，
// **不得顺手做 expect 兜底**：skillBuilder.js:369 的默认模式是 '/'，正则 '/' 在任意 url 上
// 都命中 ⇒ 一旦兼容就会把恒假翻成恒真（伪造成功）。故登记为有意不兼容，并守护住。
//
// ⚠️ C131 修订：原断言是**全文件** `!/v\.expect/`。C131 新增 `evalUrlContains(cl,...)`
//    后该断言变**过宽**并假红 —— `url_contains` 子句的字段名**本来就叫 `expect`**
//    （契约 `{type:'url_contains', expect}`，见 deriveContract / planner.js:86），
//    与 skill 层 url_pattern 的 `expect` 是**同名字段、不同子句**。
//    ⇒ 锚定到**该断言真正要守的那一个函数体**（evalUrlPattern），判据不变、作用域收敛：
//    禁止的是「url_pattern 兼容 expect」，不是「全文件出现 expect 字样」。
//    防真空：E7 仍要求 url_pattern 只读 pattern；此处另加「evalUrlContains 必须读 expect」
//    的**正向**断言，确保收敛不是靠删代码达成。
const clauseSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'verification', 'clause.js'), 'utf8'));
const clauseFnBody = (name) => {
  const m = clauseSrc.match(new RegExp('function\\s+' + name + '\\b[\\s\\S]*?\\n\\}'));
  return m ? m[0] : '';
};
const urlPatternBody = clauseFnBody('evalUrlPattern');
ok(urlPatternBody.length > 0, 'E6a 锚点定位：clause.js 的 evalUrlPattern 函数体已定位到（锚点失配即红）');
ok(!/v\.expect|cl\.expect/.test(urlPatternBody),
  'E6 clause.js 的 **url_pattern** 不得兼容 skill 层的 expect 字段'
  + '（skill 默认模式 "/" 会让 url_pattern 恒真）',
  'bodyHasExpect=' + /v\.expect|cl\.expect/.test(urlPatternBody));
ok(/v\.expect/.test(clauseFnBody('evalUrlContains')),
  'E6c 正向：clause.js 的 evalUrlContains **必须**读 expect 字段'
  + '（url_contains 的契约字段名就是 expect；防 E6 收敛后因删字段而真空成立）');
ok(/v\.pattern/.test(clauseSrc), 'E7 url_pattern 只读 pattern 字段（字段约定与 skill 层有意分离）');

// ── F 组：主链路实证（这些类型真的会被产出，不是纸面类型）───────────────────────
console.log('=== F 组：主链路实证 ===');
ok(skillSchema.OBSERVABLE_TYPES.includes('url_pattern'),
  'F1 skill 契约的可观测类型含 url_pattern（skillBuilder 会产出该子句）');
const plannerSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'planner.js'), 'utf8'));
for (const t of ['storage', 'login_state', 'url_pattern']) {
  ok(plannerSrc.includes(t), 'F2 planner 契约文本引导 LLM 产出 ' + t + '（缺口落在主链路）');
}
// 真实推导契约：任一 action 的推导契约若含这三类子句，诊断层必须能判真
let derivedHit = 0;
let derivedTotal = 0;
for (const act of [
  { type: 'navigate', target: { url: 'https://example.test/landing' } },
  { type: 'click', target: { semantic: 'go' } },
  { type: 'search', target: { semantic: 'q' } },
  { type: 'login', target: {} },
  { type: 'fill', target: { semantic: 'email' } },
]) {
  let d = null;
  try { d = contract.deriveContract(act); } catch (e) { d = null; }
  if (!d) continue;
  for (const ev of (d.requiredEvidence || [])) {
    if (['storage', 'url_pattern', 'login_state'].includes(ev.type)) {
      derivedTotal++;
      const after = ev.type === 'url_pattern'
        ? afterObs({ url: 'https://example.test/landing' })
        : afterObs({ storage: STORE_OK, textSummary: 'welcome back, logout' });
      if (vilSaysPresent(ev, after)) derivedHit++;
    }
  }
}
ok(derivedTotal === 0 || derivedHit > 0,
  'F3 真实推导契约若含这三类子句，诊断层必须能判真（不恒假）',
  'total=' + derivedTotal + ' hit=' + derivedHit);

// ── G 组：防空断言（证明断言有判别力，不是恒真）────────────────────────────────
console.log('=== G 组：防空断言 ===');
// G1：修复前 storage 恒假 —— 用一个「只有 storage 成立」的 AND 契约证明现在能判真
const onlyStorage = afterObs({ storage: STORE_OK, textSummary: 'app shell rendered' });
ok(vilSaysPresent({ type: 'storage', key: 'authenticated', equals: 'true' }, onlyStorage) === true,
  'G1 仅 storage 成立的契约必须被诊断层识别为已达成（修复前恒假）');
// G2：反方向不得为修 G1 而放宽 —— 不成立时仍须判不成立
ok(vilSaysPresent({ type: 'storage', key: 'authenticated', equals: 'nope' }, onlyStorage) === false,
  'G2 storage 不成立时不得谎报达成（反向守卫）');
// G3：AND 组合下，storage 与 element_present 同时成立才算成立
const bothAfter = afterObs({
  storage: STORE_OK,
  contentLeaves: [{ tag: 'div', cls: 'c', id: null, text: 'Dashboard' }],
});
const andContract = {
  businessState: {
    stateType: 'T',
    requiredEvidence: [
      { type: 'storage', key: 'authenticated', equals: 'true' },
      { type: 'element_present', expect: 'Dashboard' },
    ],
    evidenceLogic: 'AND',
    forbiddenEvidence: [],
  },
};
const andRes = vil.analyze({
  beforeObservation: DEFAULT_BEFORE,
  afterObservation: bothAfter,
  expectedVerification: andContract,
  actionResult: { success: true },
  action: { type: 'click', risk: 'LOW', target: { semantic: 'continue' } },
});
ok(andRes.failureType === 'VERIFICATION_TOO_STRICT',
  'G3 AND 契约（storage + element_present）全部成立 ⇒ 诊断层判已达成',
  'failureType=' + andRes.failureType);
// G4：AND 组合缺一条即不成立（不得因补齐覆盖面而把 AND 变成 OR）
const partialRes = vil.analyze({
  beforeObservation: DEFAULT_BEFORE,
  afterObservation: afterObs({ storage: STORE_OK, contentLeaves: [] }),
  expectedVerification: andContract,
  actionResult: { success: true },
  action: { type: 'click', risk: 'LOW', target: { semantic: 'continue' } },
});
ok(partialRes.failureType !== 'VERIFICATION_TOO_STRICT',
  'G4 AND 契约只满足一条 ⇒ 不得判已达成（组合语义未被破坏）',
  'failureType=' + partialRes.failureType);

console.log('\n=== C125 守护结果：通过 ' + pass + ' / 失败 ' + fail + ' ===');
process.exit(fail ? 1 : 0);
