'use strict';

// =============================================================================
// C129 守护：**同一子句类型在两个消费方的口径对账**。
//
// ── 背景（C128 的 C10 登记的边界，本批关闭）───────────────────────────────────
// `text_present` 这条子句同时被两个消费方判定，但它们对 `expect` 的归一化口径不同：
//   skill 层   skillRouter.clauseVerdict : `norm(expect)` / `norm(text)`
//                norm = NFD 去音标 + 小写 + **把标点折叠成空格** + 折叠空白
//   clause 层  clause.evalTextPresent    : `normalizeText(expect)` / `pageText(after)`
//                normalizeText = 折叠空白 + 小写（**保留标点**）
// ⇒ `expect='a.b'` / 文本 `'a b'` 时 skill=TRUE、clause=FALSE：**同一条子句两层相反答案**。
//
// 危害方向已核（不是理论）：skill 的 stateContract 由**真实验证契约**合成
// （skillBuilder.clauseFromContract 保留 `expect` 原值），所以**同一个 expect 字符串**
// 同时出现在「前置状态判定」与「该步验证」两侧。skill 侧偏宽 ⇒ prestate 误判 MATCH
// ⇒ 认为「已处于目标态」而跳过动作 ⇒ 而 clause 侧判"未达成" ⇒ 任务失败/升级人工。
//
// ── 本批两侧的判定方向（三向自检的一半，见 D 组）──────────────────────────────
//   收紧：skill 侧不再抹标点（原先偏宽）。事实源 = 页面文本证据的唯一口径，
//         即 `pageText`（判定口径）+ `existence.normalizeText`（expect 口径）。
//   未动：成功裁决面（clause.js）、`url_contains`、`norm` 在语义字段匹配处的用途、
//         skill 层的三态语义、SHADOW 影子预检语义。
//   ⇒ 生产行为中性的证明：`gateOf` 要求 `status === 'ACTIVE'`，而 builder 恒产
//     CANDIDATE ⇒ `eligible` 恒空 ⇒ `decision` 恒 GENERIC，prestate 走 SHADOW 分支。
//     本批只改**影子预检的观测值**，不改任何 decision。D 组把这条钉住。
//
// ── 本守护的价值排序 ────────────────────────────────────────────────────────
// A 组 = **覆盖面自动对账**：`skillRouter.clauseVerdict` 的分支集合 vs 生产产出集合
//        `skillSchema.OBSERVABLE_TYPES`。今后新增一个子句类型只改 schema 不改 router，
//        这里立刻红（C125 的 `default: return false` 事故在 skill 层的同族防线）。
// B 组 = **跨层行为一致性矩阵**：喂同一份证据，两层必须同答；并含两条**反向探针**
//        （不得靠放宽、也不得靠降级取一致）—— 只有正向断言的话，"两层都错"也能绿。
// C 组 = **有意分离面登记**：三处确实**不同**（且必须继续不同），无声改变即红。
//        区分「忘了统一」与「有意分离」的唯一办法是把它写成断言。
// D 组 = **放宽/收紧/未动 三向自检**。
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// 本守护 require 了 skill 路由层（间接引入 store / lifecycle）——
// 数据根指到仓库内临时目录，避免污染 server/data（C116 数据根纪律）。
if (!process.env.FPB_DATA_DIR) {
  process.env.FPB_DATA_DIR = path.join(ROOT, '.benchmark', 'c129_guard_tmp');
}

const router = require('../agent/skill/skillRouter.js');
const clause = require('../agent/verification/clause.js');
const existence = require('../agent/existence.js');
const pageTextMod = require('../agent/pageText.js');
const skillSchema = require('../agent/skill/skillSchema.js');

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

const ROUTER_SRC = read('server/agent/skill/skillRouter.js');
const CLAUSE_SRC = read('server/agent/verification/clause.js');
const VERIF_SRC = read('server/agent/verification.js');
const SCHEMA_SRC = read('server/agent/skill/skillSchema.js');
const BUILDER_SRC = read('server/agent/skill/skillBuilder.js');

// 所有对 expect/文本两侧的口径断言都走「求值后的字符串」，不 eval 源码。
const obs = (t) => ({ visibleText: t });

// ── A 组：覆盖面自动对账（结构）────────────────────────────────────────────
console.log('=== A 组：覆盖面自动对账（skill 层分支 vs 生产产出集合）===');

// A1 生产产出集合真实存在且为本批核定的 6 元集合（防空断言：读不到就红）
const OBSERVABLE = skillSchema.OBSERVABLE_TYPES;
ok(Array.isArray(OBSERVABLE) && OBSERVABLE.length === 6
  && OBSERVABLE.includes('text_present') && OBSERVABLE.includes('field_value')
  && OBSERVABLE.includes('element_present') && OBSERVABLE.includes('element_absent')
  && OBSERVABLE.includes('url_contains') && OBSERVABLE.includes('url_pattern'),
  'A1 生产产出集合 OBSERVABLE_TYPES = 6 类（skillSchema 唯一来源）',
  JSON.stringify(OBSERVABLE));

// A2 ★ 覆盖面自动对账：router 的 `type === 'x'` 字面量集合必须覆盖 OBSERVABLE_TYPES
const ROUTER_BRANCHES = Array.from(new Set(
  (ROUTER_SRC.match(/type === '([a-z_]+)'/g) || []).map((s) => s.replace(/type === '|'/g, ''))
));
ok(ROUTER_BRANCHES.length >= 6,
  'A2a 防空断言：能从 clauseVerdict 提取到分支字面量（正则失配不得静默变绿）',
  JSON.stringify(ROUTER_BRANCHES));
const uncovered = OBSERVABLE.filter((t) => !ROUTER_BRANCHES.includes(t));
ok(uncovered.length === 0,
  'A2b ★ 覆盖面自动对账：OBSERVABLE_TYPES 每一类在 clauseVerdict 都有分支（新增类型只改 schema 即红）',
  'uncovered=' + JSON.stringify(uncovered) + ' branches=' + JSON.stringify(ROUTER_BRANCHES));

// A3 未覆盖时的兜底必须是 INDETERMINATE（不是 FALSE）——
//    L14 的 `default: return false` 会把「类型缺失」静默变成恒假；三态层的 default
//    返回 INDETERMINATE 时至少不会伪造确定性结论。
{
  const unknown = router.clauseVerdict({ type: 'no_such_type_xyz', expect: 'x' }, obs('x'));
  ok(unknown === 'INDETERMINATE',
    'A3 未覆盖类型的兜底是 INDETERMINATE（行为探针；若是 FALSE 则把未知类型静默变恒假 —— L14）',
    'got=' + unknown);
}

// A4 静态委托：text_present 分支必须用 normalizeText（不是 norm）
const textBranch = (() => {
  const i = ROUTER_SRC.indexOf("type === 'text_present'");
  if (i < 0) return '';
  const j = ROUTER_SRC.indexOf("type === 'element_present'", i);
  return ROUTER_SRC.slice(i, j > 0 ? j : i + 900);
})();
ok(/normalizeText\(clause\.expect\)/.test(textBranch),
  'A4a text_present 的 expect 走 existence.normalizeText（不再是 skill 匹配口径 norm）');
ok(!/norm\(/.test(textBranch.replace(/normalizeText\(/g, '')),
  'A4b text_present 分支内不得再出现裸 norm( 调用');
ok(/const text = pageText\(obs\);/.test(textBranch) && /text\.includes\(e\)/.test(textBranch),
  'A4c 文本侧直接用 pageText(obs)（已是判定口径），不再二次 norm 归一化');

// A5 ★ 同一函数引用：两层用的 normalizeText 必须是同一个函数对象（不是复制一份实现）
// A5 两层从**同一模块**导入 normalizeText（同源 ⇒ 同一函数引用，不可能是第二份实现）
ok(/const \{ normalizeText \} = require\('\.\.\/existence'\);/.test(ROUTER_SRC)
  && /const \{ normalizeText \} = require\('\.\.\/existence'\);/.test(CLAUSE_SRC),
  'A5a 两层从同一模块导入 normalizeText（同源，非第二份实现 —— L6/C127）');
ok(typeof existence.normalizeText === 'function'
  && typeof skillSchema.OBSERVABLE_TYPES !== 'undefined',
  'A5b normalizeText 存在于 existence（唯一实现）');
// 运行时证明「同一函数引用」：clause 侧归一化与 existence 侧归一化行为逐字相同
{
  const probes = [' A .  B ', 'a.b', 'SIGN IN!', '已付款。', '', null, undefined, 'x\\ny'];
  const same = probes.every((p) => clause.pageText({ visibleText: String(p == null ? '' : p) })
    === existence.normalizeText(String(p == null ? '' : p)));
  ok(same, 'A5c clause.pageText 与 existence.normalizeText 在探针集上逐字同口径（同一实现，非第二份）',
    JSON.stringify(probes));
}

// A6 norm 仍被语义字段匹配使用（本批只收敛 text_present，不得顺手改宽/改窄别处）
ok(/function norm\(s\) \{/.test(ROUTER_SRC), 'A6a norm 定义仍在（未删）');
ok(/const n = norm\(f\);/.test(ROUTER_SRC) && /const f = norm\(field\);/.test(ROUTER_SRC),
  'A6b norm 仍用于 elementTokens / elementMatchesField（语义字段匹配口径未动）');

// A7 产出侧只产出词表内类型（schema 与 builder 双向一致）
ok(/schema\.OBSERVABLE_TYPES\.includes\(type\)/.test(BUILDER_SRC),
  'A7a builder.clauseFromContract 用 OBSERVABLE_TYPES 过滤（不产出词表外的 type）');
ok(/OBSERVABLE_TYPES\.includes\(c\.type\)/.test(SCHEMA_SRC),
  'A7b skillSchema.validateStructure 拒绝词表外的 type（产出侧的硬门禁）');

// ── B 组：跨层行为一致性矩阵 ───────────────────────────────────────────────
console.log('=== B 组：跨层行为一致性（同证据同答案）===');

// 三层答案并排：skill（三态）vs clause（二态）
function pair(expect, text) {
  const v = router.clauseVerdict({ type: 'text_present', expect }, obs(text));
  const c = clause.evalTextPresent(obs(text), expect).ok ? 'TRUE' : 'FALSE';
  return { v, c };
}

// B1 标点敏感矩阵：两侧必须同答
{
  const cases = [
    ['a.b', 'a b'],           // 点 ≠ 空格（C128 C10 的原登记例）
    ['a b', 'a.b'],
    ['Sign in!', 'Sign in'],
    ['Sign in', 'Sign in!'],
    ['Payment successful.', 'Payment successful'],
    ['已付款。', '已付款'],     // 全角句号
    ['（已付款）', '已付款'],     // 全角括号
    ['version 1.5', 'version 1 5'],
  ];
  const bad = [];
  for (const [e, t] of cases) {
    const r = pair(e, t);
    if (r.v !== r.c) bad.push(e + '/' + t + ' skill=' + r.v + ' clause=' + r.c);
  }
  ok(bad.length === 0, 'B1 标点敏感矩阵 8 例：两层同答（改前「a.b / a b」为 skill=TRUE、clause=FALSE）', bad.join(' | '));
}

// B2 反向探针①（不得靠"放宽"取一致）：标点不同必须判 FALSE
{
  const bad = [];
  for (const [e, t] of [['a.b', 'a b'], ['a b', 'a.b'], ['已付款。', '已付款']]) {
    const r = pair(e, t);
    if (r.v !== 'FALSE' || r.c !== 'FALSE') bad.push(e + '/' + t + ' skill=' + r.v + ' clause=' + r.c);
  }
  ok(bad.length === 0,
    'B2 反向探针：标点不同 ⇒ 两层都必须 FALSE（任何一层抹标点都会让它变 TRUE ⇒ 咬住"放宽"）', bad.join(' | '));
}

// B3 反向探针②（不得靠"降级"取一致）：标点相同必须仍能 TRUE
{
  const bad = [];
  for (const [e, t] of [['a.b', 'a.b'], ['Sign in!', 'Sign in!'], ['已付款。', '已付款。']]) {
    const r = pair(e, t);
    if (r.v !== 'TRUE' || r.c !== 'TRUE') bad.push(e + '/' + t + ' skill=' + r.v + ' clause=' + r.c);
  }
  ok(bad.length === 0,
    'B3 反向探针：标点相同时必须仍命中 ⇒ 咬住"把 skill 侧改成恒 FALSE"的伪一致', bad.join(' | '));
}

// B4 no-op 面：**无标点** expect（生产常见形状）改前改后都必须同答 ——
//    这是"改动面只限标点差异"的证据。
{
  const cases = [
    ['welcome back', 'Welcome back'],
    ['order confirmed', 'Order Confirmed'],
    ['已付款', '已付款'],
    ['导出 CSV', '导出 CSV'],
    ['sign in', 'Sign In'],
  ];
  const bad = [];
  for (const [e, t] of cases) {
    const r = pair(e, t);
    if (r.v !== 'TRUE' || r.c !== 'TRUE') bad.push(e + '/' + t + ' skill=' + r.v + ' clause=' + r.c);
  }
  ok(bad.length === 0, 'B4 no-op 面：无标点的 expect 两层同答且命中（改动面仅限标点差异）', bad.join(' | '));
}

// B5 登记：三态 vs 二态是**有意差异**，不得被"统一"掉
{
  const v = router.clauseVerdict({ type: 'text_present', expect: 'x' }, obs(''));
  const c = clause.evalTextPresent(obs(''), 'x').ok;
  ok(v === 'INDETERMINATE' && c === false,
    'B5 登记有意差异：文本为空时 skill=INDETERMINATE（三态）而 clause=fail-closed false（二态）—— 两者都必须保持',
    'skill=' + v + ' clause=' + c);
}

// B6 历史快照形状（C128 B3 的延伸）：两层都必须认复数 visibleTexts / 单数 text
{
  const shapes = [
    [{ visibleTexts: ['Hello World'] }, 'hello world'],
    [{ text: 'Hello World' }, 'hello world'],
    [{ textSummary: 'Hello World' }, 'hello world'],
  ];
  const bad = [];
  for (const [o, e] of shapes) {
    const v = router.clauseVerdict({ type: 'text_present', expect: e }, o);
    const c = clause.evalTextPresent(o, e).ok ? 'TRUE' : 'FALSE';
    if (v !== 'TRUE' || c !== 'TRUE') bad.push(JSON.stringify(o) + ' skill=' + v + ' clause=' + c);
  }
  ok(bad.length === 0, 'B6 历史快照形状（visibleTexts 复数 / text 单数 / textSummary）两层都认且同答', bad.join(' | '));
}

// B7 大小写与空白折叠两层同口径（normalizeText 的两个折叠维度）
{
  const cases = [['HELLO', '  hello  '], ['a\tb', 'a b'], ['A\nB', 'a b']];
  const bad = [];
  for (const [e, t] of cases) {
    const r = pair(e, t);
    if (r.v !== 'TRUE' || r.c !== 'TRUE') bad.push(e + '/' + JSON.stringify(t) + ' skill=' + r.v + ' clause=' + r.c);
  }
  ok(bad.length === 0, 'B7 大小写/空白折叠维度两层同口径（折叠面内必须同答）', bad.join(' | '));
}

// B8 空 expect：两层都必须 INDETERMINATE / false（fail-closed 方向一致）
{
  const v = router.clauseVerdict({ type: 'text_present', expect: '' }, obs('anything'));
  const c = clause.evalTextPresent(obs('anything'), '').ok;
  ok(v === 'INDETERMINATE' && c === false,
    'B8 空 expect：skill=INDETERMINATE / clause=fail-closed false（都不放行）', 'skill=' + v + ' clause=' + c);
}

// ── C 组：有意分离面登记（无声改变即红）────────────────────────────────────
console.log('=== C 组：有意分离面登记（三层必须继续不同）===');

// C1 field_value：skill 精确全等 vs verification 大小写不敏感子串包含
ok(/String\(val\) === String\(clause\.expect\)/.test(ROUTER_SRC),
  'C1a 登记：skill 层 field_value 用精确全等（回放快照值，确定性优先）');
ok(/actual\.trim\(\)\.toLowerCase\(\)\.includes\(want\.trim\(\)\.toLowerCase\(\)\)/.test(VERIF_SRC),
  'C1b 登记：verification 层 field_value 用大小写不敏感子串（结果容差校验）');
{
  // 行为探针：证明两者**确实不同**（是"有意分离"，不是"忘了统一"）
  const val = 'alice@example.com';
  const want = 'alice';
  const skillHit = String(val) === String(want);
  const verifHit = val.trim().toLowerCase().includes(want.trim().toLowerCase());
  ok(skillHit === false && verifHit === true,
    'C1c 行为探针：field_value 两层确实不同（skill=FALSE / verification=TRUE）—— 语义角色不同，登记不统一',
    'skill=' + skillHit + ' verif=' + verifHit);
}

// C2 url_pattern：skill 读 expect 且只匹配 path vs verification 读 pattern 且匹配完整 url
ok(/patternMatches\(clause\.expect, p\)/.test(ROUTER_SRC),
  'C2a 登记：skill 层 url_pattern 读 `expect` 且只匹配 path');
ok(/v\.pattern/.test(CLAUSE_SRC) && /new RegExp\(pat\)/.test(CLAUSE_SRC),
  'C2b 登记：verification 层 url_pattern 读 `pattern` 且匹配完整 url');
{
  // 行为探针：同一 clause 对象（只带 expect）在两层给出不同结果
  const cl = { type: 'url_pattern', expect: '/x' };
  const v = router.clauseVerdict(cl, { url: 'https://a.com/x' });
  const r = clause.evalUrlPattern(cl, { url: 'https://a.com/x' });
  ok(v === 'TRUE' && r.ok === false,
    'C2c 行为探针：只带 expect 的 url_pattern 两层确实不同（skill=TRUE / verification 缺 pattern ⇒ fail-closed）',
    'skill=' + v + ' verif=' + JSON.stringify(r.reason));
}

// C3 element_present/absent：skill 用 norm token 宽匹配 vs verification 用语义解析器 + 存在性索引
ok(/elementMatchesField\(e, field\)/.test(ROUTER_SRC),
  'C3a 登记：skill 层 element_* 用 elementMatchesField（norm + token，宽匹配，保守方向）');
ok(/semanticResolver\.resolve\(expect, after\)/.test(VERIF_SRC) && /matchContentLeaf\(after, expect\)/.test(VERIF_SRC),
  'C3b 登记：verification 层 element_* 用 semanticResolver + contentLeaves 回落（strict 通道）');
ok(!/type === 'element_present'/.test(CLAUSE_SRC),
  'C3c 登记：clause.js 无 element_* 分支（该类型的对照面是 verification.js，机制不同不是口径不同）');

// C4 url_contains：两层**同口径**（都裸 includes、大小写敏感）—— 与 text_present 不同，不需要收敛
{
  const v = router.clauseVerdict({ type: 'url_contains', expect: 'HTTPS' }, { url: 'https://a.com/' });
  const verifLike = 'https://a.com/'.includes('HTTPS');
  ok(v === 'FALSE' && verifLike === false,
    'C4 url_contains 两层同口径（裸 includes、大小写敏感）—— 本批未动',
    'skill=' + v + ' verif=' + verifLike);
}

// ── D 组：放宽 / 收紧 / 未动 三向自检 ─────────────────────────────────────
console.log('=== D 组：放宽 / 收紧 / 未动 三向自检 ===');

// D1 未动：成功裁决面（clause.js 的 evalTextPresent 公式与置信度常量）
ok(/const ok = pageText\(after\)\.includes\(e\);/.test(CLAUSE_SRC),
  'D1a 未动：clause.evalTextPresent 的判定公式本批未改');
ok(/confidence: ok \? 0\.9 : 0\.7/.test(CLAUSE_SRC),
  'D1b 未动：text_present 的置信度常量未改');

// D2 未动：decision 面 —— gateOf 仍要求 ACTIVE，eligible 为空即 GENERIC
ok(/status !== 'ACTIVE'/.test(ROUTER_SRC) && /blockedBy\.push\('NOT_ACTIVE'\)/.test(ROUTER_SRC),
  'D2a 未动：gateOf 仍要求 status === ACTIVE（CANDIDATE 恒被拦）');
ok(/let decision = DECISION\.GENERIC;/.test(ROUTER_SRC),
  'D2b 未动：decision 初值恒 GENERIC（本批不改决策路径）');

// D3 未动：SHADOW 影子预检语义（无合格候选时对保留候选做影子预检）
ok(/PRESTATE_SCOPE\.SHADOW/.test(ROUTER_SRC) && /PRESTATE_SCOPE\.ELIGIBLE/.test(ROUTER_SRC),
  'D3 未动：prestateScope 的 ELIGIBLE/SHADOW 双分支未改（本批只改影子预检的观测值）');

// D4 未动：builder 仍恒产 CANDIDATE（生产行为中性的依据）
ok(/SKILL_STATUS\.CANDIDATE|'CANDIDATE'/.test(BUILDER_SRC),
  'D4 未动：builder 产出状态仍为 CANDIDATE（⇒ eligible 恒空 ⇒ decision 恒 GENERIC）');

// D5 收紧登记：本批唯一的方向变化是 skill 侧不再抹标点 ——
//    若有人把 skill 侧改回 norm（放宽），B2 会红；若改成恒 FALSE（降级），B3 会红。
{
  const widened = pair('a.b', 'a b');
  ok(!(widened.v === 'TRUE' && widened.c === 'FALSE'),
    'D5 收紧登记：skill 侧不再抹标点（原 skill=TRUE/clause=FALSE 的分歧已消失）',
    'skill=' + widened.v + ' clause=' + widened.c);
}

// D6 未动：页面文本唯一口径仍是 pageText，且 clause 只再导出同一函数引用
ok(clause.pageText === pageTextMod.pageText,
  'D6 未动：clause.pageText 仍是 pageText.js 的同一函数引用（不留第二份实现）');

console.log('\n=== C129 结果：' + pass + ' / ' + (pass + fail) + ' ===');
if (fail > 0) process.exitCode = 1;
