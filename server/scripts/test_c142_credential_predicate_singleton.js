'use strict';

/**
 * test_c142_credential_predicate_singleton.js
 *
 * C142 守护：凭据动作判据必须是**单一事实源**，且收口必须**双向咬得住**。
 *
 * 缺陷背景（C142 全仓同名多实现横扫 + 1051 个真实 JSON 逐案对拍）：
 *   server/agent/repair/strategies/verifyFailed.js 自带**第二份**凭据判据，
 *   与事实源 server/agent/credentialAuthorization.js 双向分歧：
 *     漏判 15 项（事实源 true / 此处 false）—— email、credentialRef、username、user_id、
 *       passwd、pwd、cvc、securitycode、expiry、ssn、token、code、Password、CVV、验证码
 *       ⇒ 凭据动作失败被判为普通失败 ⇒ 走**自动重执行**（把凭据再填进可能已漂移的页面），
 *         正是 17-A 原始事故形态；
 *     过判 —— 其正则对动作类型不敏感，真实数据里「登录按钮」等 click 语义同样命中。
 *
 * 修复方向（C142-B）：委托事实源 + **逐字保留**原三项条件为显式登记项
 *   ⇒ 新行为是旧行为的**严格超集**（放宽面实测 0 / 10293 例电池）。
 *   实际归零 14/15；余下 1 项为**本地化语义词**（事实源是纯英文词表），登记待 C143。
 *
 * 守护策略（每条判据都配 revert 对照，防真空绿）：
 *   A 单一实现  —— 委托关系存在、本文件内不再有第二份词表判据、
 *                  事实源**只依赖白名单叶子模块**（防环）。C147 改锚：旧锚「事实源零 require」
 *                  只是「不引入环依赖」的**字面近似** —— URL 身份解析收口为唯一实现后，
 *                  事实源新增 3 处 `require('./urlIdentity')`（零依赖叶子）⇒ 近似失效、
 *                  不变量仍成立。新锚 = 白名单 + 叶子自校验（A4b）+ 双向对照（A4c）+ 反真空（A4d）。
 *   B revert    —— 把**改动前的旧实现原文**当负样本跑同一组静态断言，必须红
 *   C 真实行为  —— 经 verifyFailed.execute 真实调用面（不是复制逻辑）验证漏判面归零
 *   D 不得误伤  —— 普通控件（search / q / submitBtn / searchBtn）不得升级人工
 *   E 登记项    —— risk=CRITICAL / delete / 本地化子串必须仍然在场（删 = 放宽）
 *   F 防空断言  —— 证明判据不恒真、负样本非恒红、夹具真的构造出来了
 *   G 本地化面    —— 登记表按**当前行为**分组：已修面（C144 登记项 d 收紧，正向断言 + 归属断言
 *                    必须仍由本模块承担、事实源不得被越层修改）＋ 未锚定概念的登记缺口（仍缺口）
 *
 * ★ 自扫描纪律（C141 L29 同族）：本套件用**字面形状计数**判「是否还有第二份词表判据」，
 *   因此先剥注释再计数 —— 否则注释里的斜杠列表（如「a / b / c」）会被当成正则字面量边界，
 *   产生自咬假红。剥注释器对自身必须有效，见 F4。
 *
 * 隔离：FPB_DATA_DIR 指向 tmp 且置于**首个 require 之前**（模块加载期解析，晚于首个 require
 * 的隔离行只覆盖一半）。本套件零浏览器、零 LLM、零网络。
 */

// 数据根隔离必须早于任何 require（含 node 内置）。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c142_cred_pred_' + Date.now());

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VF_PATH = path.join(ROOT, 'server', 'agent', 'repair', 'strategies', 'verifyFailed.js');
const CA_PATH = path.join(ROOT, 'server', 'agent', 'credentialAuthorization.js');

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; fails.push(name); console.log('FAIL | ' + name + ' | ' + (detail === undefined ? '' : detail)); }
}

/** 剥注释（块注释 + 行注释）；行注释用 `(^|[^:])//` 以免吃掉 https:// 这类协议头。 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ══════════════════════════════════════════════════════════════════════
// 夹具：C142 改动前 verifyFailed 内那份判据的**完整声明原文**
//   （逐字来自 git HEAD，仅作**负样本**使用 —— 证明下面的断言真的有分辨力。
//     它不是生产路径，也不替代任何真实调用。）
// ══════════════════════════════════════════════════════════════════════
const OLD_IMPL_FIXTURE = [
  'function isCredentialAction(step) {',
  "  const a = step && step.action;",
  '  if (!a) return false;',
  "  if (a.risk === 'CRITICAL') return true;",
  "  if (['purchase', 'payment', 'password_change', 'delete', 'login'].includes(a.type)) return true;",
  "  const f = String((a.target && (a.target.field || a.target.semantic)) || '');",
  '  if (/password|card|cvv|otp|支付|付款|登录|密码|卡号/.test(f)) return true;',
  '  return false;',
  '}',
].join('\n');

const VF_SRC = fs.readFileSync(VF_PATH, 'utf8');
const CA_SRC = fs.readFileSync(CA_PATH, 'utf8');
const GUARD_PATH = path.join(ROOT, 'server', 'agent', 'credentialRetryGuard.js');
const GUARD_SRC = fs.readFileSync(GUARD_PATH, 'utf8');

// ── A 单一实现：静态委托关系 + 消费方零凭据词表判据 + 事实源零 require ──────
// 判据函数化：同一组断言要能同时作用于「生产源码」与「旧实现负样本」。
//
// ★ C143 锚点上移（判据随实现上移，且**更严**）：
//   登记项整体搬到 server/agent/credentialRetryGuard.js 后，verifyFailed **不再**
//   持有任何凭据词表正则 ⇒ A3 由「恰 1 处」收紧为「**0 处**」；新增 A3b（纯委托）、
//   A6/A8（登记项唯一副本在共享模块内且被真实引用）。
//   回退到 C142 状态（verifyFailed 自带常量）会让 A3/A3b/A6 至少两条红。
const CRED_TOKEN_RE = /(password|card|cvv|otp|密码|登录|支付|付款|卡号)/;
function countCredRegexLiterals(src) {
  const body = stripComments(src);
  return (body.match(/\/[^\n/]*(?:password|card|cvv|otp|密码|登录|支付|付款|卡号)[^\n/]*\/[gimsuy]*/g) || [])
    .filter((t) => CRED_TOKEN_RE.test(t));
}

/** 对「消费方文件」的静态判据：只允许**纯委托**该族唯一实现，不得自带词表正则。 */
function consumerDelegationVerdict(src) {
  const body = stripComments(src);
  return {
    hasRequire: /require\(\s*['"][^'"]*credentialRetryGuard['"]\s*\)/.test(body),
    callsGuard: /credentialRetryGuard\s*\.\s*isCredentialActionBlockingRetry\s*\(/.test(body),
    credRegexCount: countCredRegexLiterals(src).length,
  };
}

const prod = consumerDelegationVerdict(VF_SRC);
check('A1 verifyFailed 引入该族唯一实现（credentialRetryGuard）', prod.hasRequire === true);
check('A2 verifyFailed 调用唯一实现（不是只 require 不用）', prod.callsGuard === true);
check('A3 verifyFailed 内**0 处**凭据词表正则（C143 后登记项已上移）', prod.credRegexCount === 0,
  'count=' + prod.credRegexCount);
check('A3b verifyFailed 的判据函数是纯委托（无本地分支残留）',
  /function isCredentialAction\(step\)\s*\{\s*return credentialRetryGuard\.isCredentialActionBlockingRetry\(step && step\.action\);\s*\}/.test(stripComments(VF_SRC)));
// ── C147 改锚：A4 由「零 require」→「只依赖白名单叶子模块」────────────────────
// 旧锚锚的是**字面近似**；被锚定的**真实不变量**是「不引入环依赖 / 不依赖产品逻辑」。
// C147 把本文件自带的 hostOf / originOf / isOriginlessLocalContext 三份同义实现收口为
// `require('./urlIdentity')` 委托（URL 身份解析**唯一实现**，见 server/agent/urlIdentity.js）
// —— 该目标是**零依赖叶子模块**（自身零 require），环风险为 0，**不变量仍成立**，旧近似失效。
// 新锚比旧锚**更本质**：旧锚无法区分「安全叶子依赖」与「环依赖」，新锚可以。
// 归属取证（禁手写模拟）：`git show HEAD:server/agent/credentialAuthorization.js` 原件
//   requireCount=0（A4 绿）；C147 后 requireCount=3（全部 `./urlIdentity`）；叶子自身 0。
//   ① A4  每个 require 目标必须 ∈ 白名单（白名单 = 经校验零依赖的叶子模块）
//   ② A4b 白名单成员**自身零 require**（动态校验 ⇒ 叶子论证成立；叶子被加依赖即红）
//   ③ A4c 判据逻辑**双向对照**（叶子放行 / 非叶子拒绝）—— 防单向恒真
//   ④ A4d 反真空：事实源确有被校验的依赖（防 `[].every()` 恒真的空集真空绿）
const CA_BODY = stripComments(CA_SRC);
const LEAF_WHITELIST = ['./urlIdentity'];
const caRequireTargets = [...CA_BODY.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const leafVerdict = (targets) => targets.every((t) => LEAF_WHITELIST.includes(t));
check('A4 事实源只依赖白名单叶子模块（不引入环依赖）', leafVerdict(caRequireTargets),
  'targets=' + JSON.stringify(caRequireTargets));
check('A4b 白名单成员自身零 require（叶子论证成立）',
  LEAF_WHITELIST.every((t) => !/require\s*\(/.test(stripComments(
    fs.readFileSync(path.join(ROOT, 'server', 'agent', t.replace(/^\.\//, '') + '.js'), 'utf8')))),
  'leafs=' + JSON.stringify(LEAF_WHITELIST));
check('A4c 判据逻辑双向对照（叶子放行 / 非叶子拒绝）',
  leafVerdict(['./urlIdentity']) === true && leafVerdict(['./runtime']) === false);
check('A4d 反真空：事实源确有被校验的依赖（非空集恒真）', caRequireTargets.length > 0,
  'count=' + caRequireTargets.length);
check('A5 事实源导出面含判据（委托目标真实存在）',
  /module\.exports\s*=[\s\S]*isCredentialAction/.test(CA_SRC));
// 登记项 c 必须是**全仓唯一副本**，且被真实引用（防「只声明不使用」的假在场）
check('A6 共享模块内恰 1 处凭据词表正则（登记项唯一副本）',
  countCredRegexLiterals(GUARD_SRC).length === 1,
  'count=' + countCredRegexLiterals(GUARD_SRC).length);
check('A7 共享模块的登记项常量被真实引用（非死代码）',
  /CREDENTIAL_SUBSTRING_COMPAT_RE\s*\.\s*test\s*\(/.test(GUARD_SRC));
check('A8 共享模块导出该族唯一实现与登记项常量',
  /module\.exports\s*=[\s\S]*isCredentialActionBlockingRetry[\s\S]*CREDENTIAL_SUBSTRING_COMPAT_RE/.test(GUARD_SRC));
// ⚠️ 判据必须先剥注释：本模块的**设计文档就写在文件头注释里**，
//    注释中包含 `require('./credentialAuthorization')` 原文 ⇒ 不剥会虚高计数（L20 同族）。
check('A9 共享模块只依赖事实源（无环）',
  (stripComments(GUARD_SRC).match(/require\s*\(/g) || []).length === 1
  && /require\(\s*['"]\.\/credentialAuthorization['"]\s*\)/.test(stripComments(GUARD_SRC)),
  'count=' + (stripComments(GUARD_SRC).match(/require\s*\(/g) || []).length);

// ── B revert 对照：旧实现必须让 A1–A3 至少两条红 ───────────────────────
{
  const old = consumerDelegationVerdict(OLD_IMPL_FIXTURE);
  const reds = [!old.hasRequire, !old.callsGuard, old.credRegexCount !== 0].filter(Boolean).length;
  check('B1 同一组静态断言作用于旧实现必须红（断言有分辨力）', reds >= 2,
    '旧实现命中数=' + reds + ' require=' + old.hasRequire + ' call=' + old.callsGuard);
}

// ── 夹具构造（防空：构造失败必须转成 FAIL，不得静默零信号）────────────
let oldFn = null;
let fixtureErr = null;
try {
  oldFn = new Function('return (' + OLD_IMPL_FIXTURE + ')')();
  if (typeof oldFn !== 'function') throw new Error('构造结果非函数');
} catch (e) { fixtureErr = e.message; }
check('F1 旧实现夹具构造成功（完整声明，非裸块）', typeof oldFn === 'function', fixtureErr || 'ok');

// ── 真实调用面：verifyFailed.execute（不复制逻辑，直接跑生产函数）──────
const verifyFailed = require(path.join(ROOT, 'server', 'agent', 'repair', 'strategies', 'verifyFailed'));
const credentialAuthorization = require(CA_PATH);

// ── A7 口径对称性不变量（C142-A）────────────────────────────────────
// field 与 semantic 承载同一语义概念，必须**同口径**（同一归一函数）。
// 回退到 C142 之前的写法（field 做「小写+点号尾段」、semantic 只做「小写+全等」）
// 会让下面两条断言变红 —— 这是本组断言唯一的分辨力来源。
// ⚠️ 诚实声明：真实落盘数据（1051 个 JSON）中 semantic 的点号形态为 **0 例**
//    （c142_shape_census 实测），故这是**形式不变量**，不是可达行为断言。
check('A7 口径对称性：带点号形态在 field / semantic 两侧同答（形式，真实数据 0 例）',
  credentialAuthorization.isCredentialAction({ type: 'fill', target: { field: 'billing.card' } }) === true
  && credentialAuthorization.isCredentialAction({ type: 'fill', target: { semantic: 'billing.card' } }) === true,
  'field=' + credentialAuthorization.isCredentialAction({ type: 'fill', target: { field: 'billing.card' } })
  + ' semantic=' + credentialAuthorization.isCredentialAction({ type: 'fill', target: { semantic: 'billing.card' } }));
check('A7b 非凭据形态在两侧同答（防「对称化」被做成恒真）',
  credentialAuthorization.isCredentialAction({ type: 'fill', target: { field: 'billing.qty' } }) === false
  && credentialAuthorization.isCredentialAction({ type: 'fill', target: { semantic: 'billing.qty' } }) === false);

function makeCtx(failureType) {
  return {
    error: { failureType },
    observation: null,
    calls: [],
    runAction: async () => { return { success: true, observation: null }; },
  };
}
async function isCredentialViaExecute(action) {
  const step = {
    id: 'c142_step',
    action: Object.assign({ verification: { type: 'none' } }, action),
    verification: { type: 'none' },
  };
  const res = await verifyFailed.execute({ task: {}, step, ctx: makeCtx('ACTION_REAL_FAILURE') });
  return !!(res && res.needsApproval === true && res.strategy === 'REAUTH_OR_PAUSE');
}

// ── C 漏判面（清单逐字来自 .benchmark/tools/c142_cred_probe.js 实测输出）──
// 14 项英文/归一形态，C142-B 后必须全部判为凭据动作。
const LEAK_CASES = [
  { label: 'field=email（17-A 原始事故字段）', action: { type: 'fill', target: { field: 'email' } } },
  { label: '仅 credentialRef', action: { type: 'fill', target: { credentialRef: 'c1' } } },
  { label: 'field=username', action: { type: 'fill', target: { field: 'username' } } },
  { label: 'field=user_id', action: { type: 'fill', target: { field: 'user_id' } } },
  { label: 'field=passwd', action: { type: 'fill', target: { field: 'passwd' } } },
  { label: 'field=pwd', action: { type: 'fill', target: { field: 'pwd' } } },
  { label: 'field=cvc', action: { type: 'fill', target: { field: 'cvc' } } },
  { label: 'field=securitycode', action: { type: 'fill', target: { field: 'securitycode' } } },
  { label: 'field=expiry', action: { type: 'fill', target: { field: 'expiry' } } },
  { label: 'field=ssn', action: { type: 'fill', target: { field: 'ssn' } } },
  { label: 'field=token', action: { type: 'fill', target: { field: 'token' } } },
  { label: 'field=code', action: { type: 'fill', target: { field: 'code' } } },
  { label: 'field=Password（大小写）', action: { type: 'fill', target: { field: 'Password' } } },
  { label: 'field=CVV（大小写）', action: { type: 'fill', target: { field: 'CVV' } } },
];

// ── G 本地化语义面：C144 修好了「写值动作」那一半，登记表随之**分类**（不是缩水）──
//    事实源是纯英文词表；登记项 c 的中文面只有 5 个词（支付/付款/登录/密码/卡号）；
//    C144 新增登记项 d「本地化写值语义面」补齐了**写值动作**上的邮箱 / 用户名 / 验证码。
//    ⇒ 原登记的 5 项本地化缺口按**当前行为**一分为二：
//       · LOCALIZED_FIXED（4 项）：C144 后已判为凭据动作 ⇒ 断言**正向**（必须 true），
//         并配「事实源侧仍为 false」的**归属断言**：证明收紧来自本模块的登记项 d，
//         而不是有人把中文词塞进了授权闸的事实源（那会违反闸门红线第 1 条，不得误伤普通控件）。
//       · LOCALIZED_GAPS（1 项：手机号）：**未锚定任何英文概念** = 扩概念，
//         属产品决策，C144 有意不纳入，登记口径仍是 NOT_CREDENTIAL。
//    ⇒ 两组合计仍为 5 项，登记表规模不缩水（G3 按合计口径守，防「悄悄删登记」）。
const LOCALIZED_FIXED = [
  { label: '语义=邮箱（email 的中文形态）', action: { type: 'fill', target: { semantic: '邮箱' } } },
  { label: '语义=验证码（otp/code 的中文形态）', action: { type: 'fill', target: { semantic: '验证码' } } },
  { label: '语义=用户名输入框（真实数据 42 例）', action: { type: 'fill', target: { semantic: '用户名输入框' } } },
  { label: '语义=邮箱输入框（真实数据 35 例）', action: { type: 'fill', target: { semantic: '邮箱输入框' } } },
];
const LOCALIZED_GAPS = [
  { label: '语义=手机号输入框（未锚定英文概念 = 扩概念，待产品决策）', action: { type: 'fill', target: { semantic: '手机号输入框' } } },
];

// ── E 登记项（删除任一 = 放宽，必须仍在场）────────────────────────────
const REGISTERED_TERMS = [
  { label: '登记项 a: risk=CRITICAL', action: { type: 'fill', target: { field: 'q' }, risk: 'CRITICAL' } },
  { label: '登记项 b: type=delete', action: { type: 'delete', target: {} } },
  { label: '登记项 c: 子串 cardExpiry（合法凭据，事实源全等不覆盖）', action: { type: 'fill', target: { field: 'cardExpiry' } } },
  { label: '登记项 c: 中文词 支付', action: { type: 'fill', target: { semantic: '待支付订单' } } },
  { label: '登记项 c: 子串 cardholder（事实源全等不覆盖）', action: { type: 'fill', target: { field: 'cardholder' } } },
];

// ── D 不得误伤（真实数据高频普通控件）────────────────────────────────
const NON_CRED_CASES = [
  { label: 'field=search', action: { type: 'fill', target: { field: 'search' } } },
  { label: 'field=q', action: { type: 'fill', target: { field: 'q' } } },
  { label: 'field=submitBtn', action: { type: 'click', target: { field: 'submitBtn' } } },
  { label: 'field=searchBtn', action: { type: 'click', target: { field: 'searchBtn' } } },
  { label: 'semantic=提交按钮', action: { type: 'click', target: { semantic: '提交按钮' } } },
  { label: 'semantic=登录按钮（已知过判，登记项 c 行为，本批不修）', action: { type: 'click', target: { semantic: '登录按钮' } }, registeredOverjudge: true },
  { label: 'field=loginBtn（click 语义，登记项 c 行为，本批不修）', action: { type: 'click', target: { field: 'loginBtn' } }, registeredOverjudge: true },
];

(async () => {
  // ── C 行为面 ────────────────────────────────────────────────────────
  const stillLeaking = [];
  for (const c of LEAK_CASES) {
    if (!(await isCredentialViaExecute(c.action))) stillLeaking.push(c.label);
  }
  check('C1 漏判面归零（14 项英文/归一形态全部判为凭据动作）', stillLeaking.length === 0,
    '仍漏判=' + stillLeaking.length + (stillLeaking.length ? ' → ' + stillLeaking.join(' / ') : ''));

  // ── G 已修面：4 项本地化写值语义必须为 true，且**归属本模块**（不污染事实源）──
  const stillOpen = [];
  const misAttributed = [];
  for (const g of LOCALIZED_FIXED) {
    if (!(await isCredentialViaExecute(g.action))) stillOpen.push(g.label);
    if (credentialAuthorization.isCredentialAction(g.action)) misAttributed.push(g.label);
  }
  check('G1 已修面：4 项本地化写值语义判为凭据动作（C144 登记项 d 收紧面）',
    stillOpen.length === 0, stillOpen.length ? '仍未修 → ' + stillOpen.join(' / ') : '');
  check('G1b 归属断言：收紧必须来自本模块登记项 d —— 事实源侧仍为 false（不得越层改授权闸口径）',
    misAttributed.length === 0,
    misAttributed.length ? '事实源已被改（越层）→ ' + misAttributed.join(' / ') : '');

  // ── G 登记缺口：未锚定概念（手机号）仍为 NOT_CREDENTIAL ─────────────
  const gapDrift = [];
  for (const g of LOCALIZED_GAPS) {
    if (await isCredentialViaExecute(g.action)) gapDrift.push(g.label);
  }
  check('G2 登记缺口行为与登记声明一致（未锚定概念仍不判为凭据动作）', gapDrift.length === 0,
    gapDrift.length ? '登记表已过期（以下已被修好，请更新登记）→ ' + gapDrift.join(' / ') : '');
  check('G3 登记表规模不缩水（归组合计 ≥ 原登记 5 项，防「悄悄删登记」）',
    LOCALIZED_FIXED.length + LOCALIZED_GAPS.length >= 5 && LOCALIZED_FIXED.length === 4,
    'fixed=' + LOCALIZED_FIXED.length + ' gap=' + LOCALIZED_GAPS.length);

  // ── E 登记项在场 ────────────────────────────────────────────────────
  const missingTerms = [];
  for (const t of REGISTERED_TERMS) {
    if (!(await isCredentialViaExecute(t.action))) missingTerms.push(t.label);
  }
  check('E1 三项登记项全部在场（删除任一 = 放宽）', missingTerms.length === 0,
    missingTerms.length ? '缺失 → ' + missingTerms.join(' / ') : '');

  // ── D 不得误伤 ──────────────────────────────────────────────────────
  const hurt = [];
  for (const c of NON_CRED_CASES) {
    if ((await isCredentialViaExecute(c.action)) && !c.registeredOverjudge) hurt.push(c.label);
  }
  check('D1 普通控件不被误升级人工', hurt.length === 0,
    hurt.length ? '误伤 → ' + hurt.join(' / ') : '');

  // ── C2 revert 对照：旧实现必须在同 14 项上大面积失手 ─────────────────
  if (typeof oldFn === 'function') {
    const oldMiss = LEAK_CASES.filter((c) => !oldFn({ action: c.action })).length;
    check('C2 revert 对照：旧实现在同 14 项上必须漏判 ≥10（断言咬得住）', oldMiss >= 10,
      '旧实现漏判=' + oldMiss + '/14');
  } else {
    check('C2 revert 对照：旧实现在同 14 项上必须漏判 ≥10（断言咬得住）', false, '夹具不可用');
  }

  // ── F 防空断言 ──────────────────────────────────────────────────────
  check('F2 电池非空且互斥（漏判 14 / 已修面 4 / 缺口 1 / 登记项 5 / 反面 7）',
    LEAK_CASES.length === 14 && LOCALIZED_FIXED.length === 4 && LOCALIZED_GAPS.length === 1
    && REGISTERED_TERMS.length === 5 && NON_CRED_CASES.length === 7,
    [LEAK_CASES.length, LOCALIZED_FIXED.length, LOCALIZED_GAPS.length,
      REGISTERED_TERMS.length, NON_CRED_CASES.length].join('/'));
  {
    const fake = consumerDelegationVerdict('const x = 1;');
    check('F3 静态判据不是恒真（对空源码会红）',
      fake.hasRequire === false && fake.callsGuard === false && fake.credRegexCount === 0,
      JSON.stringify(fake));
  }
  {
    // F4 剥注释器对自身有效：造一个「注释里写斜杠列表」的样本，剥后不得再计数
    const bait = '// a / b / cd / ef\nconst k = 1;\n';
    check('F4 剥注释器有效（注释里的斜杠列表不参与字面形状计数）',
      countCredRegexLiterals(bait).length === 0
      && countCredRegexLiterals('/password|card|密码/').length === 1,
      'bait=' + countCredRegexLiterals(bait).length);
  }

  // ── 清理 ────────────────────────────────────────────────────────────
  try { fs.rmSync(process.env.FPB_DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }

  console.log('\n---------------------------------------------------');
  console.log('C142 结果：PASS ' + pass + ' / FAIL ' + fail);
  if (fail) console.log('FAILURES:\n' + fails.map((f) => ' - ' + f).join('\n'));
  console.log('---------------------------------------------------');
  process.exit(fail ? 1 : 0);
})();
