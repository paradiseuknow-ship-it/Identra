'use strict';

// =============================================================================
// C130 守护：`url_contains` 子句的**大小写口径三层对账**。
//
// ── 与 C129 的关系（L15 的进一步形态）────────────────────────────────────────
// C129 处理的是 `text_present` 在 **两层**（skill 前置态 / clause 裁决）之间的口径分歧。
// C129 的 C4 断言当时把 `url_contains` 记为「两层同口径、本批未动」—— 但 C4 只比了
// **两层**（skillRouter vs 手写模拟的 verification），且那个「verification」是**手写
// `includes`**，不是真实调用。C130 侦察发现：`url_contains` 实际有 **三处**判定实现，
// 第三处（VIL）两侧都 .toLowerCase()，恰恰是 C4 的模拟**没有覆盖**的那一处。
//   ⇒ 教训（写进断言）：**覆盖面只按"我当时想到的消费方数量"划，必然漏掉新增的第 N 层**。
//     本守护把 C4 从两层升级为**三层**，且三层都走**真实调用**（不再手写模拟）。
//
// ── 事实链（改前）───────────────────────────────────────────────────────────
//   A `verification.js:70`            url.includes(String(expect))           大小写敏感
//   B `skillRouter.js:182`            url.includes(e)                        大小写敏感
//   C `verificationIntelligence.js`   两侧 .toLowerCase()                     大小写不敏感 ← 少数派
// RFC 3986 §6.2.2：scheme/host 不敏感、**path 敏感**；`clause.urlSurfaceKey` 已给出正确形态
// （host 折叠 + path 原样）；`planner.js` 权威措辞「expect 必须是动作执行前 URL 中不存在的
// 片段」且全文无 toLowerCase ⇒ 契约从未声明大小写无关 ⇒ VIL 比契约更宽 ⇒ 修 VIL。
//
// ── 组说明 ──────────────────────────────────────────────────────────────────
// A 组 = 三层**真实调用**行为矩阵（改前 6 例分歧 → 改后 0 例）
// B 组 = **反向探针**：不得靠"放宽"、也不得靠"降级"取一致
// C 组 = RFC 3986 依据登记：host 折叠/path 保留的**唯一正确形态**必须保持
// D 组 = 有意分离面登记（本批**未**统一的东西，无声改变即红）
// E 组 = 连带面 + 三向自检（放宽/收紧/未动）
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// 本守护 require 了 skill 路由层（间接引入 store / lifecycle）——
// 数据根指到仓库内临时目录，避免污染 server/data（C116 数据根纪律）。
if (!process.env.FPB_DATA_DIR) {
  process.env.FPB_DATA_DIR = path.join(ROOT, '.benchmark', 'c130_guard_tmp');
}

const vil = require('../agent/verification/verificationIntelligence.js');
const verification = require('../agent/verification.js');
const router = require('../agent/skill/skillRouter.js');
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
  return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');
const VERIF_SRC = read('server/agent/verification.js');
const ROUTER_SRC = read('server/agent/skill/skillRouter.js');
const CLAUSE_SRC = read('server/agent/verification/clause.js');
const PLANNER_SRC = read('server/agent/planner.js');

// ── 三层真实调用适配器（不是手写模拟 —— C129 C4 的教训）────────────────────
// 层 A：成功裁决面。走 verification.verify，含 P2 无效证据守卫。
function layerA(expect, url, beforeUrl) {
  const r = verification.verify({ type: 'url_contains', expect }, { url }, { url: beforeUrl || 'https://entry.example/' });
  return r.success;
}
// 层 B：skill 前置态（三态 → 二态归一）。
function layerB(expect, url) {
  return router.clauseVerdict({ type: 'url_contains', expect }, { url }) === 'TRUE';
}
// 层 C：VIL 诊断层。经 analyze 的 4b 路径（expectedActuallyPresent）
//     + businessState 路径（clausePresent）。两条路径都必须被覆盖 ——
//     它们改前是**两处独立的 .toLowerCase()**，只测一条会漏掉另一条。
function layerC_expected(expect, url) {
  const r = vil.analyze({
    beforeObservation: { url: 'https://entry.example/', textSummary: 'entry' },
    afterObservation: { url, textSummary: 'stable', loadingState: 'complete', previousObservationDiff: {} },
    expectedVerification: { type: 'url_contains', expect },
    actionResult: { success: true },
    action: { type: 'click' },
  });
  return r.failureType === 'VERIFICATION_TOO_STRICT';
}
function layerC_clause(expect, url) {
  const r = vil.analyze({
    beforeObservation: { url: 'https://entry.example/', textSummary: 'entry' },
    afterObservation: { url, textSummary: 'stable', loadingState: 'complete', previousObservationDiff: {} },
    expectedVerification: {
      businessState: {
        stateType: 'GENERIC_STATE',
        requiredEvidence: [{ type: 'url_contains', expect }],
        evidenceLogic: 'AND',
      },
    },
    actionResult: { success: true },
    action: { type: 'click' },
  });
  return r.failureType === 'VERIFICATION_TOO_STRICT';
}
// C 层 = 两条路径的并集（任一命中即视为 VIL 判「已达成」）
function layerC(expect, url) {
  return layerC_expected(expect, url) || layerC_clause(expect, url);
}
// C 层两条路径必须同答 —— 否则只测一条会漏
function bothCPaths(expect, url) {
  if (layerC_expected(expect, url) !== layerC_clause(expect, url)) {
    fail++;
    console.log('  FAIL [内部] VIL 两条路径不同答 :: expect=' + expect + ' url=' + url);
    return null;
  }
  return layerC_expected(expect, url);
}

// ── A 组：三层真实调用行为矩阵 ─────────────────────────────────────────────
console.log('=== A 组：三层真实调用行为矩阵（同证据同答案）===');

const MATRIX = [
  // [expect, url, 说明]
  ['HTTPS', 'https://a.com/', 'scheme 大小写（RFC 不敏感 —— 但三方原样比较时一致为"不命中"）'],
  ['https', 'HTTPS://a.com/', 'scheme 大小写反向'],
  ['/Dashboard', 'https://a.com/dashboard', '★ path 大小写敏感（RFC 3986 §6.2.2.1）'],
  ['/dashboard', 'https://a.com/Dashboard', '★ path 大小写敏感反向'],
  ['/SIGNUP', 'https://a.com/signup', '★ path 大小写敏感（真实站点高频：/SignUp vs /signup）'],
  ['/dashboard', 'https://a.com/dashboard', 'no-op 面：完全一致必须命中'],
  ['a.com', 'https://a.com/dashboard', 'host 片段命中'],
  ['/settings', 'https://a.com/settings?tab=2', 'query 不参与（命中）'],
];

{
  const bad = [];
  for (const [e, u, why] of MATRIX) {
    const a = layerA(e, u);
    const b = layerB(e, u);
    const c = bothCPaths(e, u);
    if (c === null) continue;
    if (a !== b || a !== c) bad.push(e + ' @ ' + u + ' → A=' + a + ' B=' + b + ' C=' + c + '  [' + why + ']');
  }
  ok(bad.length === 0,
    'A1 ★ 三层对账：' + MATRIX.length + ' 例上 verification(裁决) / skillRouter(前置态) / VIL(诊断) 三层同答'
    + '（改前 6 例分歧，VIL 侧偏宽）',
    bad.join(' | '));
}

// A2 防空断言：矩阵必须有真阳性与真阴性各 ≥1（否则「全都 false」也能绿）
{
  const pos = MATRIX.filter(([e, u]) => layerA(e, u)).length;
  const neg = MATRIX.filter(([e, u]) => !layerA(e, u)).length;
  ok(pos >= 1 && neg >= 1,
    'A2 防空断言：矩阵含真阳性 ' + pos + ' 例 / 真阴性 ' + neg + ' 例（全 false 的退化矩阵不得变绿）');
}

// A3 ★ 覆盖面自动对账：`url_contains` 的判定实现必须**恰好三处** ——
//    且这三处的源码都不许再出现 url 面的 toLowerCase。
//    口径同 C129 A2：新增第 4 个消费方（或有人往回调 lowercase）即红。
//
// ⚠️ 扫描必须**逐条锚点定位**，不能整文件正则 —— VIL 里 `detectAsyncPending` 的
//    `const url = (after.url || '').toLowerCase();` 是**有意保留**的关键词语义（D3 登记），
//    整文件正则会把 D3 误判成口径回退（本轮实测：第一版正是这么红的）。
//    正解 = 只扫**本批相关的 4 个判定点所在的行**（url 变量声明 + includes 调用）。
{
  // 每条 = {file, 该文件里 url 面判定点的"必须不含 lowercase"锚点行}
  // ★★ 每条锚点必须**同时**给两个正则，且它们必须落在**同一行**：
  //    `shape` = 本批**期望的正确形状**（改后形态；回退即失配 ⇒ A3a 红）
  //    `revert` = 本批**修复前的形状**（original 形态；命中即回退 ⇒ A3a 红）
  //    ⇒ 两个方向都在 A3a 里咬住，A3b 只作为「形状对但多了 lowercase」的补充网。
  //
  // ⚠️ no-op 实测发现的原缺陷（已修）：**旧版 A3a 只写 `shape`**，于是回退时
  //    `missing` 非空、`bad` 为空 ⇒ A3a 红但 A3b **真空绿**（没有片段可扫）。
  //    「锚点失配」与「锚点命中但片段含 lowercase」是**两个方向**，只测一个方向时
  //    另一个变成真空通过 —— 这正是 C128 L14「有没有」与「怎么构造」的分工（L12/L14）。
  const ANCHORS = [
    {
      f: 'server/agent/verification.js', name: 'A 裁决面',
      shape: /case 'url_contains':[\s\S]{0,120}?url\.includes\(/,
      revert: null, // 本批一字未改 ⇒ 无回退形态
    },
    {
      f: 'server/agent/skill/skillRouter.js', name: 'B skill 前置态',
      shape: /if \(type === 'url_contains'\)[\s\S]{0,220}?url\.includes\(e\)/,
      revert: null, // 本批一字未改 ⇒ 无回退形态
    },
    {
      f: 'server/agent/verification/verificationIntelligence.js', name: 'C1 VIL url 声明',
      shape: /const url = String\(afterObservation\.url \|\| ''\);/,
      revert: /const url = \(afterObservation\.url \|\| ''\)\.toLowerCase\(\);/,
    },
    {
      f: 'server/agent/verification/verificationIntelligence.js', name: 'C2 VIL expect 判定',
      shape: /if \(type === 'url_contains' && expect\) \{[\s\S]{0,80}?url\.includes\(String\(expect\)\)/,
      revert: /if \(type === 'url_contains' && expect\) \{[\s\S]{0,80}?url\.includes\(String\(expect\)\.toLowerCase\(\)\)/,
    },
    {
      f: 'server/agent/verification/verificationIntelligence.js', name: 'C3 VIL clausePresent url 声明',
      // ★★ 必须带**上下文**消歧：C3 的 original 形态与 D3 登记面（detectAsyncPending，:150）
      //    逐字相同（都是 `const url = (after.url || '').toLowerCase();`）！
      //    首版 revert 正则不带上下文 ⇒ 在**已修复**的文件上也命中 :150 ⇒ **假红**
      //    （本轮实测：恢复后 A3a0/E6 各报 1 处 false positive）。
      //    消歧依据 = 紧随其后的下一个声明：C3 是 `const els =`、D3 是 `const elements =`。
      //    ⇒ 用 `[\s\S]{0,40}?const els =` 把锚点锁到 C3 那一处。
      shape: /const url = String\(\(after && after\.url\) \|\| ''\);[\s\S]{0,20}?const els =/,
      revert: /const url = \(after\.url \|\| ''\)\.toLowerCase\(\);[\s\S]{0,20}?const els =/,
    },
    {
      f: 'server/agent/verification/verificationIntelligence.js', name: 'C4 VIL clausePresent 判定',
      shape: /case 'url_contains': return !!cl\.expect && url\.includes\(String\(cl\.expect\)\);/,
      revert: /case 'url_contains': return !!cl\.expect && url\.includes\(String\(cl\.expect\)\.toLowerCase\(\)\);/,
    },
  ];
  const bad = [];
  const missing = [];
  const reverted = [];
  for (const a of ANCHORS) {
    const src = read(a.f);
    if (a.revert && a.revert.test(src)) { reverted.push(a.name + '(' + a.f + ')'); continue; }
    const m = src.match(a.shape);
    if (!m) { missing.push(a.name + '(' + a.f + ')'); continue; }
    if (/toLowerCase/.test(m[0])) bad.push(a.name + ' 命中片段含 toLowerCase');
  }
  ok(reverted.length === 0,
    'A3a0 ★ 回退探针：6 个锚点都**不得**出现修复前的形状'
    + '（C1–C4 各自的 original 形态各写一条 revert 正则；命中即红 —— 这是 no-op 实测补上的方向）',
    'reverted=' + JSON.stringify(reverted));
  ok(missing.length === 0,
    'A3a ★ 覆盖面自动对账：6 个判定锚点全部定位到'
    + '（A 裁决面 / B skill 前置态 / C1·C2·C3·C4 VIL 四处）——锚点失配即红，防"正则静默不匹配"',
    'missing=' + JSON.stringify(missing));
  ok(bad.length === 0,
    'A3b ★ 6 个锚点片段内不得出现 toLowerCase（口径回退即红；D3 登记的关键词语义不在锚点内）',
    bad.join(' | '));
  ok(ANCHORS.filter((a) => /verificationIntelligence/.test(a.f)).length === 4,
    'A3c VIL 的 4 个判定点必须全部在扫面内（改前是两处独立的 toLowerCase，只扫两处会漏）');
}

// A4 planner 无 lowercase（契约措辞依据：expect = 原样字面片段）
ok(!/toLowerCase/.test(PLANNER_SRC),
  'A4 planner.js 全文无 toLowerCase ⇒ url_contains 的 expect 契约 = 原样字面片段（本批的事实源判据）');

// ── B 组：反向探针 ─────────────────────────────────────────────────────────
console.log('=== B 组：反向探针（不得靠"放宽"、也不得靠"降级"取一致）===');

// B1 反向探针①（咬住"放宽"）：仅大小写不同 ⇒ 三层都必须**不命中**。
//    任何一层把大小写抹平（回到旧的 VIL 实现）都会让它变 true。
{
  const cases = [
    ['/Dashboard', 'https://a.com/dashboard'],
    ['/dashboard', 'https://a.com/Dashboard'],
    ['/SIGNUP', 'https://a.com/signup'],
  ];
  const bad = [];
  for (const [e, u] of cases) {
    const a = layerA(e, u), b = layerB(e, u), c = bothCPaths(e, u);
    if (c === null) continue;
    if (a || b || c) bad.push(e + ' @ ' + u + ' → A=' + a + ' B=' + b + ' C=' + c);
  }
  ok(bad.length === 0,
    'B1 反向探针①：仅大小写不同 ⇒ 三层都不命中（咬住"把某层改成大小写不敏感"的伪一致）',
    bad.join(' | '));
}

// B2 反向探针②（咬住"降级"）：完全一致 ⇒ 三层都必须**命中**。
//    若有人为了取一致把某层改成恒 false，这里红。
{
  const cases = [
    ['/dashboard', 'https://a.com/dashboard'],
    ['/signup', 'https://signup.example.com/'],
    ['a.com', 'https://a.com/dashboard'],
  ];
  const bad = [];
  for (const [e, u] of cases) {
    const a = layerA(e, u), b = layerB(e, u), c = bothCPaths(e, u);
    if (c === null) continue;
    if (!a || !b || !c) bad.push(e + ' @ ' + u + ' → A=' + a + ' B=' + b + ' C=' + c);
  }
  ok(bad.length === 0,
    'B2 反向探针②：完全一致时必须仍命中 ⇒ 咬住"把某层改成恒 false"的伪一致',
    bad.join(' | '));
}

// B3 反向探针③：VIL 两条独立路径（expectedActuallyPresent / clausePresent）
//    必须同答 —— 改前它们是**两处独立的 .toLowerCase()**，只修一处会在这里红。
{
  const bad = [];
  for (const [e, u] of [['/Dashboard', 'https://a.com/dashboard'], ['/dashboard', 'https://a.com/dashboard'], ['HTTPS', 'https://a.com/']]) {
    const p1 = layerC_expected(e, u);
    const p2 = layerC_clause(e, u);
    if (p1 !== p2) bad.push(e + ' @ ' + u + ' → expected=' + p1 + ' clause=' + p2);
  }
  ok(bad.length === 0,
    'B3 反向探针③：VIL 的 expectedActuallyPresent 与 clausePresent 两条独立路径同答'
    + '（改前两处各自 lowercase，只修一处即红）',
    bad.join(' | '));
}

// ── C 组：RFC 3986 依据登记（唯一正确形态必须保持）────────────────────────
console.log('=== C 组：RFC 3986 依据登记（host 折叠 / path 保留）===');

// C1 clause.urlSurfaceKey 必须**只折叠 host**、path 原样 —— 这是三处判定应当对齐的形态
ok(/\(\(p\.hostname \|\| ''\)\.toLowerCase\(\)\) \+ \(p\.pathname \|\| '\/'\)/.test(CLAUSE_SRC),
  'C1a 登记：clause.urlSurfaceKey = host 折叠 + path 原样（RFC 3986 §6.2.2 的正确形态）');
{
  const k1 = clause.urlSurfaceKey('https://A.COM/Dashboard');
  const k2 = clause.urlSurfaceKey('https://a.com/Dashboard');
  ok(k1 === k2 && /Dashboard/.test(k1),
    'C1b 行为探针：surfaceKey 折叠 host 但**保留 path 大小写**（/Dashboard 仍是 /Dashboard）',
    'k1=' + k1 + ' k2=' + k2);
}

// C2 surfaceContains（P2 恒真守卫）必须保持裸 includes（大小写敏感）——
//    它是「动作前是否已成立」的守卫，放宽会让真导航证据被误拒（C105 F3 实锤的反面）
ok(/return surface\.includes\(e\);/.test(CLAUSE_SRC),
  'C2a 登记：clause.surfaceContains 的片段比较用裸 includes（大小写敏感，不得放宽）');
ok(/const \{ urlSurfaceKey, surfaceContains \} = clause;/.test(VERIF_SRC),
  'C2b 登记：verification.js 的 P2 守卫委托 clause.surfaceContains（唯一实现，未另造一份）');

// C3 url_pattern 的大小写由 **pattern 作者**决定（无隐式折叠）—— 与 url_contains 的分离是有意的
ok(/re = new RegExp\(pat\);/.test(CLAUSE_SRC) && !/new RegExp\(pat, 'i'\)/.test(CLAUSE_SRC),
  'C3 登记：url_pattern 用 new RegExp(pat) 无隐式 /i ⇒ 大小写策略由 pattern 作者决定（有意分离）');

// ── D 组：有意分离面登记（无声改变即红）────────────────────────────────────
console.log('=== D 组：有意分离面登记（本批未统一的东西）===');

// D1 skill 层 url_pattern 与 verification 层 url_pattern 确实不同（C129 C2 的延续，本批不动）
ok(/patternMatches\(clause\.expect, p\)/.test(ROUTER_SRC),
  'D1a 登记：skill 层 url_pattern 读 expect 且只匹配 path（本批未动）');
ok(/v\.pattern/.test(CLAUSE_SRC),
  'D1b 登记：verification 层 url_pattern 读 pattern 且匹配完整 url（本批未动）');

// D2 三态 vs 二态的有意差异必须保持（skill 空 url ⇒ INDETERMINATE）
{
  const v = router.clauseVerdict({ type: 'url_contains', expect: 'x' }, { url: '' });
  ok(v === 'INDETERMINATE',
    'D2 登记有意差异：skill 层空 url ⇒ INDETERMINATE（三态），而裁决层无 url ⇒ 不命中 —— 两者都必须保持',
    'skill=' + v);
}

// D3 VIL 的关键词类 url 判定**有意**大小写不敏感（本批不得顺手改）
ok(/const url = \(after\.url \|\| ''\)\.toLowerCase\(\);/.test(VIL_SRC)
  && /ASYNC_URL_SEGMENTS/.test(VIL_SRC),
  'D3 登记：detectAsyncPending 的 url 仍 lowercase（**关键词命中**语义：/processing、/wait 这类路径特征'
  + '有意大小写不敏感 —— 与 url_contains 子句判定不是同一件事，本批一字不改）');

// D4 文本/字段通道的 lowercase 未动
ok(/const text = String\(\(after && after\.textSummary\) \|\| ''\)\.toLowerCase\(\)/.test(VIL_SRC),
  'D4a 登记：VIL login_state 的文本通道仍 lowercase（文本口径，非 URL 口径）');
ok(/actual\.toLowerCase\(\)\.includes\(want\.toLowerCase\(\)\)/.test(VIL_SRC),
  'D4b 登记：VIL field_value 仍大小写不敏感（结果容差校验，C129 C1 已登记）');

// ── E 组：连带面 + 三向自检 ────────────────────────────────────────────────
console.log('=== E 组：连带面与放宽/收紧/未动 三向自检 ===');

// E1 page_change 连带面：`url` 变量被 `b.url !== url` 复用 —— 原样比较才认得出
//    「仅大小写不同的真实跳转」。旧实现（lowercase）会吞掉这类变化。
function pageChangeHit(bUrl, aUrl) {
  const r = vil.analyze({
    beforeObservation: { url: bUrl, textSummary: 'same text' },
    afterObservation: { url: aUrl, textSummary: 'same text', loadingState: 'complete', previousObservationDiff: {} },
    expectedVerification: {
      businessState: {
        stateType: 'GENERIC_STATE',
        requiredEvidence: [{ type: 'page_change' }],
        evidenceLogic: 'AND',
      },
    },
    actionResult: { success: true },
    action: { type: 'click' },
  });
  return r.failureType === 'VERIFICATION_TOO_STRICT';
}
ok(pageChangeHit('https://a.com/Dashboard', 'https://a.com/dashboard') === true,
  'E1a 连带面：仅大小写不同的 url 变化（/Dashboard → /dashboard）被认作 page_change（旧实现吞掉）');
ok(pageChangeHit('https://a.com/dashboard', 'https://a.com/dashboard') === false,
  'E1b 连带面反向：url 完全相同不得判 page_change（防空断言：否则上一条恒真）');
ok(pageChangeHit('https://a.com/a', 'https://a.com/b') === true,
  'E1c 连带面 no-op：路径真变化仍判 page_change（未因本批退化）');

// E2 未动：成功裁决面（verification.js:70 的裸 includes 公式）
ok(/const ok = !!expect && url\.includes\(String\(expect\)\);/.test(VERIF_SRC),
  'E2a 未动：verification.js url_contains 的判定公式本批一字未改');

// E3 未动：skill 层 url_contains 的判定公式
ok(/return url\.includes\(e\) \? CLAUSE_VERDICT\.TRUE : CLAUSE_VERDICT\.FALSE;/.test(ROUTER_SRC),
  'E3a 未动：skillRouter url_contains 的判定公式本批一字未改');

// E4 收紧登记：VIL 侧四处改动都必须是"去 lowercase"，不得出现别的形状
ok(/const url = String\(afterObservation\.url \|\| ''\);/.test(VIL_SRC),
  'E4a 收紧：expectedActuallyPresent 的 url 改为原样 String(...)');
ok(/return url\.includes\(String\(expect\)\);/.test(VIL_SRC),
  'E4b 收紧：expectedActuallyPresent 的 expect 侧不再 toLowerCase');
ok(/const url = String\(\(after && after\.url\) \|\| ''\);/.test(VIL_SRC),
  'E4c 收紧：clausePresent 的 url 改为原样 String(...)');
ok(/case 'url_contains': return !!cl\.expect && url\.includes\(String\(cl\.expect\)\);/.test(VIL_SRC),
  'E4d 收紧：clausePresent 的 expect 侧不再 toLowerCase');

// E5 未动：decision / failureType 取值集合未变（本批不动决策路径）
{
  const decisions = Object.keys(vil.DECISIONS).sort().join(',');
  ok(decisions.includes('RETRY_VERIFY') && decisions.includes('RECHECK_OBSERVATION') && decisions.includes('HUMAN_ESCALATE'),
    'E5 未动：DECISIONS 取值集合未变（本批只改判定口径，不动决策路径）', decisions);
  ok(vil.FAILURE_TYPES.VERIFICATION_TOO_STRICT === 'VERIFICATION_TOO_STRICT',
    'E5b 未动：VERIFICATION_TOO_STRICT 仍存在（本批收紧其**触发条件**，不删该分类）');
}

// E6 放宽面 = 0：本批不得出现任何"新增 true"的形状。
//
// ★★ no-op 实测发现的原缺陷（已修）：旧版这里是 `ok(true, ...)` —— **硬编码常量**，
//    任何情况下都绿（C128「为不存在的形状写代码」的同族：**为不存在的失败写断言**）。
//    改法 = 把判据做成**真计算**：拿"改后源码形状"与"改前源码形状"两个集合做差，
//    差的交集必须为空。判据用的是**从源码抽出来的行为**，不是人工常量。
//
//    判据：本批只有"去 lowercase"一种形状变化，且方向恒为**收紧**。
//    ⇒ 任何一处出现 `String(...).toLowerCase()`（即 expect 侧仍被折叠）都是**放宽残留**。
//    反向：`String(...)` 原样形态必须 4 处齐全，否则是漏改（E4a–E4d 已分别断言）。
{
  // 放宽形状 = 仍有"把 url/expect 折叠大小写"的调用于 url_contains 判定路径。
  // 逐点扫（同 A3 的锚点法，避免 detectAsyncPending 的 D3 登记面误报）。
  // ⚠️ C3 的 loosening 形状与 D3 登记面（:150 detectAsyncPending）**逐字相同** ⇒
  //    必须带上下文消歧（紧随 `const els =`），否则在已修复的文件上假红（本轮实测）。
  const LOOSEN_SHAPES = [
    /url\.includes\(String\(expect\)\.toLowerCase\(\)\)/,           // C2 expect 侧折叠
    /url\.includes\(String\(cl\.expect\)\.toLowerCase\(\)\)/,      // C4 expect 侧折叠
    /const url = \(afterObservation\.url \|\| ''\)\.toLowerCase\(\)/,   // C1 url 侧折叠
    /const url = \(after\.url \|\| ''\)\.toLowerCase\(\);[\s\S]{0,20}?const els =/, // C3 url 侧折叠（带上下文）
  ];
  const loosened = LOOSEN_SHAPES.filter((re) => re.test(VIL_SRC));
  ok(loosened.length === 0,
    'E6 三向自检：放宽 0 处 —— VIL 的 4 个 url_contains 判定点都不得残留任何"折叠大小写"形状'
    + '（旧版此断言是 ok(true) 硬编码恒真，no-op 实测暴露；现改为**从源码实测** 4 条 loosening 形状）',
    'loosened=' + loosened.length);

  // E6b 反向：4 条收紧形状必须齐全（否则是漏改，而不是"放宽 0"）
  const TIGHT_SHAPES = [
    /const url = String\(afterObservation\.url \|\| ''\);/,
    /return url\.includes\(String\(expect\)\);/,
    /const url = String\(\(after && after\.url\) \|\| ''\);/,
    /case 'url_contains': return !!cl\.expect && url\.includes\(String\(cl\.expect\)\);/,
  ];
  const tightOk = TIGHT_SHAPES.filter((re) => re.test(VIL_SRC)).length;
  ok(tightOk === 4,
    'E6b 三向自检：收紧 4/4 齐全（防"放宽 0 处"因**漏改**而真空成立）',
    'tight=' + tightOk + '/4');
}

console.log('\n=== C130 结果：' + pass + ' / ' + (pass + fail) + ' ===');
if (fail > 0) process.exitCode = 1;
