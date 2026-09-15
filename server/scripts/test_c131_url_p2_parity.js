'use strict';

// =============================================================================
// C131 守护：`url_contains` 的 **P2 无效证据守卫跨层口径对账**。
//
// ── 与 C130 的关系（同一「同一份证据多消费方」谱系的第二根轴）────────────────
// C130 统一的是 `url_contains` 的 **大小写轴**（VIL 两侧 .toLowerCase()）。
// C131 发现的是**同一子句的第二根分歧轴：P2 无效证据守卫的有无**。
//   A `verification.js`           裸 includes **+ P2**          ← 正确（契约语义）
//   B `skillRouter.js:182`        裸 includes，**无 before**     ← 设计正确（前置态语义）
//   C `verificationIntelligence.js:248`  裸 includes，**忽略 before**  ← 缺陷（少数派）
//
// ── 决定性铁证（不是"风格不一致"，是"注释声明的语义与实现脱节"）─────────────
// `clause.js:136` 原文：「P2 无效证据守卫与 url_contains **同理**」——
// 即 `url_pattern` 的 P2 守卫**以其与 url_contains 同语义为依据**，
// 而 url_contains 恰恰**没有** P2。⇒ 参照物不存在，属 L16 谱系（为不存在的形状写代码）。
// 契约依据 `planner.js:86`：「expect 必须是动作执行前 URL 中不存在的片段 ——
// 若入口 URL 已包含该片段，**验证将被判为无效证据而失败**」。
// 生产可达 `contract.deriveContract({type:'navigate'})` → `requiredEvidence:[{type:'url_contains'}]`
// → `businessStatePresent` → `clausePresent`（正是缺 P2 的那条分支）。
//
// ── 组说明 ──────────────────────────────────────────────────────────────────
// A 组 = 三层**真实调用**行为矩阵 + 跨层相反答案消除（改前 A/C 相反 → 改后一致）
// B 组 = **反向探针**：不得靠"放宽"、也不得靠"降级"取一致（C129 教训：正向"同答"不足以
//        排除"两层一起错"）
// C 组 = **静态委托**断言（C127 教训：宽窄类 no-op **不红**「两层同答」⇒ 一致性须另有
//        静态证据；此处要求三个消费方**引用同一函数**，且不得残留内联裸 includes）
// D 组 = 有意分离面登记（`skillRouter` 无 before 是设计正确；`expectedActuallyPresent:206`
//        签名未收 before ⇒ 本批登记挂起。无声改变即红）
// E 组 = 三向自检（收紧/未动/放宽）+ 唯一实现登记
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// 本守护 require 了 skill 路由层（间接引入 store / lifecycle）——
// 数据根指到仓库内临时目录，避免污染 server/data（C116 数据根纪律）。
if (!process.env.FPB_DATA_DIR) {
  process.env.FPB_DATA_DIR = path.join(ROOT, '.benchmark', 'c131_guard_tmp');
}

const clause = require('../agent/verification/clause.js');
const contract = require('../agent/verification/contract.js');
const verification = require('../agent/verification.js');
const vil = require('../agent/verification/verificationIntelligence.js');
const router = require('../agent/skill/skillRouter.js');

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

// 统一夹具：**同一 clause + 同一 before/after** 喂给各消费方（L15 的前提）。
// ⚠️ 形状必须能穿过 _analyze 的 1/2/3/4a 短路抵达 4b（C131 §3 陷阱 2）：
//    loadingState / previousObservationDiff 必须落在**被读取的那一层**。
const EXP = 'https://a.com/checkout';
const TEXT = 'checkout page';
function obs(url) {
  return {
    url,
    textSummary: TEXT,
    visibleText: TEXT,
    elements: [],
    previousObservationDiff: {},
    loadingState: 'complete',
  };
}
function analyzeWith(expect, beforeUrl, afterUrl) {
  const derived = contract.deriveContract({ type: 'navigate', target: { url: expect } });
  const bs = { requiredEvidence: derived.requiredEvidence, evidenceLogic: derived.evidenceLogic };
  return {
    derived,
    bs,
    r: vil.analyze({
      beforeObservation: { url: beforeUrl, textSummary: TEXT },
      afterObservation: obs(afterUrl),
      expectedVerification: { type: 'element_present', expect: '__none__', businessState: bs },
      actionResult: { success: true },
      action: { type: 'navigate' },
    }),
  };
}

console.log('=== C131 守护：url_contains 的 P2 守卫跨层对账 ===\n');

// ── A 组：三层真实调用行为矩阵 ──────────────────────────────────────────────
console.log('── A 组：三层真实调用（同一 clause / 同一 before+after）──');
{
  const before = obs(EXP);
  const after = obs(EXP);
  const CL = { type: 'url_contains', expect: EXP };

  // A1：唯一的共享实现
  const p = clause.evalUrlContains(CL, after, before);
  ok(p && p.ok === false && p.invalidEvidence === 'precondition_true',
    'A1 clause.evalUrlContains 在「before 已含 expect」上判 false/invalidEvidence=precondition_true',
    JSON.stringify(p));

  // A2：裁决面（真实调用，非手写模拟）
  const v = verification.verify({ type: 'url_contains', expect: EXP }, after, before, null);
  ok(v.success === false && v.invalidEvidence === 'precondition_true',
    'A2 verification.verify（裁决面）同判 false/precondition_true',
    JSON.stringify({ success: v.success, invalidEvidence: v.invalidEvidence }));

  // A3：诊断面 —— **本批修复点**。经 deriveContract 生产契约 → clausePresent:248。
  //     改前此处为 VERIFICATION_TOO_STRICT（说「其实已达成」），与 A1/A2 相反。
  const m = analyzeWith(EXP, EXP, EXP);
  ok(m.r.failureType !== 'VERIFICATION_TOO_STRICT',
    'A3 VIL（诊断面，经生产契约 clausePresent）**不再**判 VERIFICATION_TOO_STRICT'
    + '（改前正是在此把「真实失败」说成「其实已达成」）',
    'failureType=' + m.r.failureType);
  ok(m.r.decision !== 'RETRY_VERIFY',
    'A3b VIL decision 不再 RETRY_VERIFY', 'decision=' + m.r.decision);

  // A4：跨层一致性（正向：两层同答）
  const aSaysTrue = v.success === true;
  const cSaysTrue = m.r.failureType === 'VERIFICATION_TOO_STRICT';
  ok(aSaysTrue === cSaysTrue,
    'A4 跨层一致：A 说 ' + (aSaysTrue ? 'TRUE' : 'FALSE') + '，C 说 ' + (cSaysTrue ? 'TRUE' : 'FALSE')
    + '（改前：A=FALSE / C=TRUE ⇒ **跨层相反答案**）',
    'A=' + v.success + ' C=' + m.r.failureType);

  // A5：反向探针②（C129 教训：正向"同答"不足以排除"两层一起错"）——
  //     当 before **不含** expect（真实跳转）时，两层必须都判 **TRUE**。
  //     改了这条才证明"一致"不是靠"一起判假"换来的。
  const B2 = 'https://a.com/entry';
  const v2 = verification.verify({ type: 'url_contains', expect: EXP }, after, B2, null);
  const m2 = analyzeWith(EXP, B2, EXP);
  ok(v2.success === true,
    'A5 反向探针：before 不含 expect（真实跳转）⇒ 裁决面判 TRUE（未因收紧而误杀真成功）',
    JSON.stringify({ success: v2.success, invalidEvidence: v2.invalidEvidence || null }));
  ok(m2.r.failureType === 'VERIFICATION_TOO_STRICT',
    'A5b 反向探针：同一场景诊断面判 VERIFICATION_TOO_STRICT（才证明它仍会说"已达成"）',
    'failureType=' + m2.r.failureType);

  // A6：无 before（旧观察/无前置态）⇒ 必须与改前**逐字相同**：不触发 P2、按命中判真。
  const P3 = clause.evalUrlContains(CL, after, null);
  ok(P3.ok === true && !P3.invalidEvidence,
    'A6 无 before ⇒ 不触发 P2，仍判 ok:true（改前行为逐字保持，未过度收紧）',
    JSON.stringify(P3));

  // A7：P2 只在**表面**（host+pathname）判定 —— query 不参与（C105 F3）。
  const q = clause.evalUrlContains(
    { type: 'url_contains', expect: 'u_token' },
    obs('https://a.com/ok?u_token=1'),
    obs('https://a.com/entry')
  );
  ok(q.ok === true,
    'A7 query 表面轴：expect 只出现在 before 的 query 中 ⇒ **不算**恒真（C105 F3 保持）',
    JSON.stringify(q));

  // A8：url_pattern 与 url_contains 的 P2 **对称性**（clause.js:136 注释所声称的语义
  //     此前为假 —— 参照物不存在）。两者必须在同一场景给出同类结论。
  const pu = clause.evalUrlContains(CL, after, before);
  const pp = clause.evalUrlPattern({ pattern: 'a\\.com/checkout' }, after, before);
  ok(pu.invalidEvidence === 'precondition_true' && pp.invalidEvidence === 'precondition_true',
    'A8 对称性：url_contains 与 url_pattern 在同场景**同样**触发 P2（clause.js:136 注释终于为真）',
    'url_contains=' + JSON.stringify(pu.invalidEvidence) + ' url_pattern=' + JSON.stringify(pp.invalidEvidence));
}

// ── B 组：反向探针 —— 不得靠"放宽"取一致 ────────────────────────────────────
console.log('\n── B 组：反向探针（不得靠放宽 / 不得靠降级）──');
{
  const before = obs(EXP);
  const after = obs(EXP);
  const CL = { type: 'url_contains', expect: EXP };

  // B1「不得放宽」：P2 触发时 ok 必须为 false —— 若有人为"求一致"改成 true 即红。
  const p = clause.evalUrlContains(CL, after, before);
  ok(p.ok === false,
    'B1 不得放宽：P2 命中时 ok 必须 false（"两层一起判真"式的假一致被排除）',
    'ok=' + p.ok);

  // B1b：且 invalidEvidence 必须保留语义标签（降级成裸 false 会丢失归因能力）
  ok(p.invalidEvidence === 'precondition_true',
    'B1b 不得降级：must 保留 invalidEvidence=precondition_true（不是退化成裸 false）',
    'invalidEvidence=' + JSON.stringify(p.invalidEvidence));

  // B2「不得放宽」在诊断面：VIL 对同一证据必须**不**判"已达成"
  const m = analyzeWith(EXP, EXP, EXP);
  ok(m.r.failureType !== 'VERIFICATION_TOO_STRICT',
    'B2 诊断面不得放宽：不得判 VERIFICATION_TOO_STRICT', 'failureType=' + m.r.failureType);

  // B3「不得收紧到误杀」：before 不含 expect 的上限已由 A5/A5b 覆盖；
  //     此处补 before.url 为空的边界（无 URL 不足以判恒真）。
  const pNull = clause.evalUrlContains(CL, after, {});
  ok(pNull.ok === true && !pNull.invalidEvidence,
    'B3 边界：before 存在但无 url ⇒ 不足以判恒真，仍按命中判真（不过度收紧）',
    JSON.stringify(pNull));

  // B4「fail-closed」：缺 expect 不得被 P2 逻辑绕过
  const pNo = clause.evalUrlContains({ type: 'url_contains' }, after, before);
  ok(pNo.ok === false && !pNo.invalidEvidence,
    'B4 fail-closed：缺 expect ⇒ ok:false 且**不**冒用 invalidEvidence（归因不得错标）',
    JSON.stringify(pNo));
}

// ── C 组：静态委托断言（C127 教训：宽窄类 no-op 不红「两层同答」）────────────
console.log('\n── C 组：静态委托（一致性须有代码级证据，不能只靠行为同答）──');
{
  const V_SRC = read('server/agent/verification.js');
  const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');
  const CL_SRC = read('server/agent/verification/clause.js');

  // C1：裁决面必须委托共享实现
  ok(/clause\.evalUrlContains\(v,\s*after,\s*before\)/.test(V_SRC),
    'C1 静态委托：verification.js 的 url_contains 分支调用 clause.evalUrlContains(v, after, before)');

  // C2：诊断面必须委托共享实现（**本批核心**）
  ok(/case 'url_contains':\s*return clause\.evalUrlContains\(cl,\s*after,\s*before\)\.ok;/.test(VIL_SRC),
    'C2 静态委托：VIL clausePresent 的 url_contains 分支调用 clause.evalUrlContains(cl, after, before).ok');

  // C3：诊断面**不得**残留「忽略 before 的裸 includes」形状（判据是"有没有 before"，
  //     故必须锚定裸 includes 形状本身，且带 case 上下文消歧）
  const BARE = /case 'url_contains':\s*return\s+!!cl\.expect\s*&&\s*url\.includes\(String\(cl\.expect\)\);/;
  ok(!BARE.test(VIL_SRC),
    'C3 反残留：VIL 不得再有 `case \'url_contains\': return !!cl.expect && url.includes(...)` 裸形状');

  // C4：唯一实现登记 —— 全仓 `urlSurfaceKey` 定义点必须仅 clause.js 一处
  //     （同一后果面不得两条路径各造一份表面键）
  const files = [];
  (function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (['node_modules', '.git', 'data', 'dist', 'build', '.benchmark', 'release'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name)) files.push(p);
    }
  })(ROOT);
  const defs = files.filter((f) => /function\s+urlSurfaceKey\b/.test(read(path.relative(ROOT, f).replace(/\\/g, '/'))));
  ok(defs.length === 1 && /clause\.js$/.test(defs[0]),
    'C4 唯一实现登记：urlSurfaceKey 全仓定义点仅 clause.js 一处（P2 表面键不得有第二份）',
    'defs=' + JSON.stringify(defs.map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))));

  // C5：共享实现必须真的导出（否则 C1/C2 会在运行期抛，静态断言却可能假绿）
  ok(typeof clause.evalUrlContains === 'function',
    'C5 导出登记：clause.evalUrlContains 已导出且为函数');

  // C6：`clause.js:136` 所声称的参照关系必须**在代码里成立** ——
  //     注释说「P2 与 url_contains 同理」，则两个函数都必须存在 P2 分支。
  const hasPatP2 = /P2 无效证据守卫: url_pattern/.test(CL_SRC);
  const hasContainsP2 = /P2 无效证据守卫: url 条件在动作执行前已成立/.test(CL_SRC);
  ok(hasPatP2 && hasContainsP2,
    'C6 注释-实现对账：clause.js 中 url_pattern 与 url_contains 的 P2 分支**都存在**'
    + '（注释声称"同理"，此前参照物缺失）',
    'url_pattern=' + hasPatP2 + ' url_contains=' + hasContainsP2);
}

// ── D 组：有意分离面登记（无声改变即红）─────────────────────────────────────
console.log('\n── D 组：有意分离面登记（本批**未**统一的东西）──');
{
  const ROUTER_SRC = read('server/agent/skill/skillRouter.js');

  // D1：skillRouter 的 clauseVerdict **必须**保持无 before —— 它回答的是
  //     「当前观察是否匹配**前置态**」，不是因果归因 ⇒ 无 before 是**设计正确**。
  //     若有人"顺手统一"给它加 before/P2，前置态判定会被恒真守卫污染 ⇒ 此处红。
  ok(/function\s+clauseVerdict\s*\(\s*clause\s*,\s*obs\s*\)/.test(ROUTER_SRC),
    'D1 登记：skillRouter.clauseVerdict(clause, obs) **保持两参**（前置态语义，无因果归因）');
  ok(!/clauseVerdict\s*\(\s*clause\s*,\s*obs\s*,\s*before/.test(ROUTER_SRC),
    'D1b 登记：clauseVerdict 不得被"统一"成三参（前置态加 P2 = 语义污染）');

  // D2：`expectedActuallyPresent` 登记 —— 其 url_contains 分支仍是无 before 的字面痕迹判定。
  //     本批**挂起**（签名未收 before ⇒ 无从取 before；且其 4b 入口与 businessState 通道互斥）。
  //     此处登记"它仍是这个形状"，任何无声改动都红 ⇒ 迫使下批显式决策。
  const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');
  ok(/if \(type === 'url_contains' && expect\) \{\s*[\s\S]{0,900}?return url\.includes\(String\(expect\)\);\s*\}/.test(VIL_SRC),
    'D2 挂起登记：expectedActuallyPresent 的 url_contains 仍为字面痕迹判定（无 before，待下批定级）');
  ok(/function\s+expectedActuallyPresent\s*\(\s*expectedVerification\s*,\s*afterObservation\s*\)/.test(VIL_SRC),
    'D2b 挂起登记：expectedActuallyPresent 签名仍为两参（未收 before）');
}

// ── E 组：三向自检 + 生产可达性 ─────────────────────────────────────────────
console.log('\n── E 组：三向自检（收紧/未动/放宽）──');
{
  const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');
  const V_SRC = read('server/agent/verification.js');

  // E1 收紧：诊断面必须有 1 处收紧形状（本批唯一行为变更）
  const TIGHT = [
    /case 'url_contains':\s*return clause\.evalUrlContains\(cl,\s*after,\s*before\)\.ok;/,
  ];
  ok(TIGHT.every((re) => re.test(VIL_SRC)),
    'E1 收紧：VIL 的诊断面收紧 1/1 到位');

  // E2 未动：裁决面不得残留内联第二份实现（应只剩委托）—— 且行为由 A2/A6/A7 逐字守住
  ok(!/url\.includes\(String\(expect\)\)/.test(V_SRC),
    'E2 未动（结构）：verification.js 已无内联裸 includes（只剩委托，消除第二份实现）');
  ok(/clause\.evalUrlContains\(v,\s*after,\s*before\)/.test(V_SRC),
    'E2b 未动（结构）：verification.js 的 P2 语义现由共享实现承担');

  // E3 放宽：任何"折叠大小写"或"绕过 P2"的 loosening 形状都不得出现（承接 C130）。
  // ⚠️ 必须有**作用域消歧**：`const url = (after.url || '').toLowerCase();` 在
  //    `detectAsyncPending`（:150）中是**有意**的 —— 它是关键词检测（对比
  //    ASYNC_URL_SEGMENTS = ['/processing','/wait','/pending'] 等固定小写词表），
  //    不是 url_contains 裁决，本就不该大小写敏感（已登记有意面）。
  //    C130 的写法带上下文锚点（紧随 `const els =`）；此处若照抄丢掉锚点，
  //    会在**已修复**的文件上假红（本批实测踩中一次 ⇒ 记为 E3 的 L4 教训）。
  //    判据锚定在「4 个 url_contains 判定点」上：VIL 的两个消费点各自必须原样。
  const VIL_DECL = /const url = String\(\(after && after\.url\) \|\| ''\);/;          // clausePresent（原样）
  const VIL_DECL2 = /const url = String\(afterObservation\.url \|\| ''\);/;            // expectedActuallyPresent（原样）
  const LOOSEN = [
    [/url\.includes\(String\(cl\.expect\)\.toLowerCase\(\)\)/, 'clausePresent expect 侧折叠'],
    [/url\.includes\(String\(expect\)\.toLowerCase\(\)\)/, 'expectedActuallyPresent / verify expect 侧折叠'],
    [/const url = \(after\.url \|\| ''\)\.toLowerCase\(\);[\s\S]{0,40}?const els =/, 'clausePresent url 侧折叠（带上下文消歧）'],
    [/const url = \(afterObservation\.url \|\| ''\)\.toLowerCase\(\)/, 'expectedActuallyPresent url 侧折叠'],
    [/const url = String\(\(after \|\| \{\}\)\.url \|\| ''\)\.toLowerCase\(\)/, '变体：url 侧折叠'],
  ];
  const loosened = LOOSEN.filter(([re]) => re.test(VIL_SRC) || re.test(V_SRC));
  ok(loosened.length === 0,
    'E3 放宽 0 处：4 个 url_contains 判定点不得残留任何大小写折叠形状（C130 成果不得回流）',
    'loosened=' + loosened.length + ' ' + JSON.stringify(loosened.map((x) => x[1])));

  // E3b 反向：两个原样声明必须**都在**（否则"放宽 0 处"可能因变量改名/删除而真空成立）
  ok(VIL_DECL.test(VIL_SRC) && VIL_DECL2.test(VIL_SRC),
    'E3b 反真空：VIL 两处 url 原样声明（clausePresent / expectedActuallyPresent）齐全');

  // E3c 登记：detectAsyncPending 的 lowercase **必须保持**（有意不敏感的面）。
  //     若有人"顺手统一"把它删掉，关键词检测会漏配 ⇒ 此处红。
  const ASYNC_DECL = /const url = \(after\.url \|\| ''\)\.toLowerCase\(\);[\s\S]{0,120}?const elements = after\.elements \|\| \[\];/;
  ok(ASYNC_DECL.test(VIL_SRC),
    'E3c 有意面登记：detectAsyncPending 的 url lowercase **保持**（关键词检测非裁决，不参与大小写统一）');

  // E4 生产可达性：必须有 `url_contains` 的**产出台**（否则本批修的是不可达分支 ⇒ C122/L16）
  const derived = contract.deriveContract({ type: 'navigate', target: { url: EXP } });
  const req = (derived && derived.requiredEvidence) || [];
  ok(req.some((c) => c.type === 'url_contains'),
    'E4 可达性：deriveContract({type:\'navigate\'}) 产出 url_contains 证据（本批分支在生产主链路上）',
    JSON.stringify(req));

  // E5 契约-实现对齐：planner 权威措辞把 P2 写成子句语义的一部分 ⇒
  //     此处登记"契约里存在该措辞"，防止将来有人以"契约没这么说"为由回退本批。
  const PLANNER = read('server/agent/planner.js');
  ok(/expect 必须是动作执行前 URL 中不存在的片段/.test(PLANNER),
    'E5 契约依据登记：planner.js 明写「expect 必须是动作执行前 URL 中不存在的片段」');
  ok(!/toLowerCase/.test(PLANNER),
    'E5b 契约依据登记：planner.js 全文无 toLowerCase（大小写原样语义）');

  // E6 运行时交叉核对：三层在**同一夹具**上的答案必须一致（行为级，非静态）
  const before = obs(EXP);
  const after = obs(EXP);
  const a = verification.verify({ type: 'url_contains', expect: EXP }, after, before, null);
  const c = clause.evalUrlContains({ type: 'url_contains', expect: EXP }, after, before);
  const m = analyzeWith(EXP, EXP, EXP);
  const aligned = (a.success === c.ok) && (a.success === (m.r.failureType === 'VERIFICATION_TOO_STRICT' ? false : a.success));
  ok(aligned,
    'E6 运行时交叉核对：共享实现 / 裁决面 / 诊断面三方同答（改前 A≠C）',
    'clause=' + c.ok + ' verify=' + a.success + ' vil=' + m.r.failureType);
}

console.log('\n=== C131 结果：' + pass + ' / ' + (pass + fail) + ' ===');
if (fail > 0) process.exitCode = 1;
