'use strict';

/**
 * test_c144_localized_credential_layer.js
 *
 * C144 守护：「凭据判据的**本地化写值语义面**」（server/agent/credentialRetryGuard.js 登记项 d）。
 *
 * ## 缺陷背景（C144 = C142/C143 登记的本地化缺口）
 *   事实源 `credentialAuthorization.CREDENTIAL_FIELDS` 是**纯英文**词表；登记项 c 的中文面
 *   只有 5 个词（支付/付款/登录/密码/卡号）。真实落盘数据（1051 JSON / 1263 动作形状 /
 *   101083 次出现）里，以中文命名的**凭据字段语义**在**写值动作**上 fail-open：
 *     · 无 field、仅 semantic 4 种取值共 148 例；中文落在 field 侧同样存在（用户名输入框 /
 *       用户名 / 邮箱 / 邮箱输入框 / 密码输入框 共 445 例）。
 *   后果与 17-A 同形态：凭据动作失败被当作普通失败 ⇒ 放回**自动重做**路径
 *   （把凭据再填进可能已漂移的页面）。
 *
 * ## 本守护的判据设计（每组都配 revert 对照，防真空绿）
 *   A 静态真实性 —— 词表**锚定**事实源已有概念、与登记项 c 的**子串面不相交**（防死条件）、
 *                    写值动作类型必须存在于 `schema/action.js:ACTION_TYPES`（L16 形状真实性）。
 *   B 行为面     —— 经 `isCredentialActionBlockingRetry` 真实调用（**不复制逻辑**）验证
 *                    本地化写值语义全部被挡住；并配「事实源侧仍为 false」的**归属断言**，
 *                    证明收紧来自登记项 d 而不是有人越层改授权闸的事实源。
 *   C 分层边界   —— 同一批词在**非写值动作**上必须**不动**（click 承载动作/区域，不是字段）。
 *   D 不得误伤   —— 普通语义、未锚定概念（手机号）不得被升级人工；
 *                    动作族（登录按钮）仍由**登记项 c** 承担（本批一格未动）。
 *   E 零放宽     —— 旧实现 `true ⇒` 新实现 `true`，逐形状核对（严格超集）。
 *   F 防空       —— 判据不恒真、负样本非恒红、夹具真的构造出来了（L30：构造失败转 FAIL）。
 *
 * ★ 负样本纪律：本守护含**旧实现原文**（C144 前的 guard 判据）逐字作 revert 夹具。
 *   该夹具内含凭据子串正则字面量，因此本文件**只能放在 server/scripts/**：
 *   `test_c143` 的 A 组只扫 `server/agent/**`（同族 L29 纪律），不会自咬。
 *
 * 隔离：FPB_DATA_DIR 指向 tmp 且置于**首个 require 之前**（模块加载期解析）。
 * 本套件零浏览器、零 LLM、零网络、零 git。
 */

// 数据根隔离必须早于任何 require（含 node 内置）。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c144_localized_' + Date.now());

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const GUARD_PATH = path.join(ROOT, 'server', 'agent', 'credentialRetryGuard.js');
const factSourcePath = path.join(ROOT, 'server', 'agent', 'credentialAuthorization.js');
const actionSchemaPath = path.join(ROOT, 'server', 'agent', 'schema', 'action.js');

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; fails.push(name); console.log('FAIL | ' + name + ' | ' + (detail === undefined ? '' : detail)); }
}

// ── 载入（失败必须转 FAIL，不得静默零信号）────────────────────────────────
let guard = null;
let factSource = null;
let actionSchema = null;
let loadErr = null;
try {
  guard = require(GUARD_PATH);
  factSource = require(factSourcePath);
  actionSchema = require(actionSchemaPath);
  if (typeof guard.isCredentialActionBlockingRetry !== 'function') throw new Error('guard 未导出判据函数');
} catch (e) { loadErr = e && e.message ? e.message : String(e); }
check('Z0 被测模块全部载入成功（含共享模块加载期锚定断言）', !loadErr, loadErr || 'ok');
if (loadErr) {
  console.log('\n被测模块不可用 ⇒ 其后断言无意义，终止。');
  console.log('C144 结果：PASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
}

const BLOCK = (a) => guard.isCredentialActionBlockingRetry(a);
const GATE = (a) => factSource.isCredentialAction(a);
const ACTION_TYPES = new Set(actionSchema.ACTION_TYPES);
const CRED_FIELDS = new Set(factSource.CREDENTIAL_FIELDS);

const WORDS = guard.LOCALIZED_CREDENTIAL_FIELD_WORDS;
const WRITE_TYPES = guard.LOCALIZED_WRITE_ACTION_TYPES;
const COMPAT_RE = guard.CREDENTIAL_SUBSTRING_COMPAT_RE;

// ══════════════════════════════════════════════════════════════════════
// A 静态真实性（L16）
// ══════════════════════════════════════════════════════════════════════
const unanchored = WORDS.filter((x) => !CRED_FIELDS.has(x.concept));
check('A1 每个本地化词都锚定事实源 `CREDENTIAL_FIELDS` 里已有的概念（不扩概念）',
  WORDS.length > 0 && unanchored.length === 0,
  'n=' + WORDS.length + (unanchored.length ? ' 未锚定=' + unanchored.map((x) => x.word + '→' + x.concept).join(',') : ''));

const deadWords = WORDS.filter((x) => COMPAT_RE.test(x.word));
check('A2 每个本地化词都与登记项 c 的**子串面不相交**（否则该条是死条件）',
  WORDS.length > 0 && deadWords.length === 0,
  deadWords.length ? '死条件=' + deadWords.map((x) => x.word).join(',') : 'n=' + WORDS.length);

const badTypes = WRITE_TYPES.filter((t) => !ACTION_TYPES.has(t));
check('A3 写值动作类型全部存在于 `schema/action.js:ACTION_TYPES`（形状真实性）',
  WRITE_TYPES.length > 0 && badTypes.length === 0,
  'declared=' + JSON.stringify(WRITE_TYPES) + (badTypes.length ? ' 非法=' + badTypes.join(',') : ''));

check('A4 写值动作范围显式且保守（当前恰为 [fill]；press/select 实测等价故不纳入）',
  WRITE_TYPES.length === 1 && WRITE_TYPES[0] === 'fill', JSON.stringify(WRITE_TYPES));

// ══════════════════════════════════════════════════════════════════════
// B 行为面 + 归属
// ══════════════════════════════════════════════════════════════════════
const LOCALIZED_CASES = [
  { label: 'fill + field=用户名输入框（真实数据 30 例）', action: { type: 'fill', target: { field: '用户名输入框' } } },
  { label: 'fill + field=用户名（真实数据 14 例）', action: { type: 'fill', target: { field: '用户名' } } },
  { label: 'fill + field=邮箱（真实数据 7 例）', action: { type: 'fill', target: { field: '邮箱' } } },
  { label: 'fill + semantic=用户名输入框（真实数据 42 例）', action: { type: 'fill', target: { semantic: '用户名输入框' } } },
  { label: 'fill + semantic=邮箱输入框（真实数据 35 例）', action: { type: 'fill', target: { semantic: '邮箱输入框' } } },
  { label: 'fill + semantic=注册邮箱输入框（原 C104 A1 夹具）', action: { type: 'fill', target: { semantic: '注册邮箱输入框' } } },
  { label: 'fill + semantic=邮箱', action: { type: 'fill', target: { semantic: '邮箱' } } },
  { label: 'fill + semantic=验证码', action: { type: 'fill', target: { semantic: '验证码' } } },
  { label: 'fill + semantic=企业邮箱输入框（复合词）', action: { type: 'fill', target: { semantic: '企业邮箱输入框' } } },
];

const notBlocked = LOCALIZED_CASES.filter((c) => !BLOCK(c.action));
check('B1 本地化写值语义全部**不可自动重做**（登记项 d 生效）',
  notBlocked.length === 0, notBlocked.length ? '未挡住 → ' + notBlocked.map((c) => c.label).join(' / ') : 'n=' + LOCALIZED_CASES.length);

const gateTrue = LOCALIZED_CASES.filter((c) => GATE(c.action));
check('B2 归属断言：上述形状在**授权闸事实源**上必须仍为 false（收紧只能来自本模块，不得越层）',
  gateTrue.length === 0, gateTrue.length ? '事实源已被改（越层）→ ' + gateTrue.map((c) => c.label).join(' / ') : '');

// ══════════════════════════════════════════════════════════════════════
// C 分层边界：同一批词在非写值动作上必须不动
// ══════════════════════════════════════════════════════════════════════
const NON_WRITE_CASES = [
  { label: 'click + semantic=邮箱注册按钮', action: { type: 'click', target: { semantic: '邮箱注册按钮' } } },
  { label: 'click + semantic=用户名可用提示', action: { type: 'click', target: { semantic: '用户名可用提示' } } },
  { label: 'wait + semantic=等待邮箱验证码到达', action: { type: 'wait', target: { semantic: '等待邮箱验证码到达' } } },
  { label: 'inspect + semantic=邮箱字段状态', action: { type: 'inspect', target: { semantic: '邮箱字段状态' } } },
  { label: 'getUrl + field=邮箱', action: { type: 'getUrl', target: { field: '邮箱' } } },
  { label: 'select + semantic=邮箱类型（写值但不在 allow-list，本批显式不纳入）', action: { type: 'select', target: { semantic: '邮箱类型' } } },
];
const overTriggered = NON_WRITE_CASES.filter((c) => BLOCK(c.action));
check('C1 非写值动作（并且 select 亦不在 allow-list）上本地化层**不生效**（仍可自动重做）',
  overTriggered.length === 0, overTriggered.length ? '误升级人工 → ' + overTriggered.map((c) => c.label).join(' / ') : 'n=' + NON_WRITE_CASES.length);

// 双向标定：同一批词换到写值动作上必须生效（否则 C1 可能因「词表为空」而恒真）
const sameWordsOnWrite = [
  { action: { type: 'fill', target: { semantic: '邮箱注册按钮' } } },
  { action: { type: 'fill', target: { semantic: '等待邮箱验证码到达' } } },
];
check('C2 分层双向标定：同一批词改到 `fill` 上必须被判为凭据动作',
  sameWordsOnWrite.every((c) => BLOCK(c.action)));

// ══════════════════════════════════════════════════════════════════════
// D 不得误伤 / 未纳入概念
// ══════════════════════════════════════════════════════════════════════
const HARM_CASES = [
  { label: 'fill + field=search', action: { type: 'fill', target: { field: 'search' } } },
  { label: 'fill + field=q', action: { type: 'fill', target: { field: 'q' } } },
  { label: 'fill + semantic=产品搜索框', action: { type: 'fill', target: { semantic: '产品搜索框' } } },
  { label: 'fill + semantic=收货地址', action: { type: 'fill', target: { semantic: '收货地址' } } },
  { label: 'click + semantic=提交按钮', action: { type: 'click', target: { semantic: '提交按钮' } } },
];
const harmed = HARM_CASES.filter((c) => BLOCK(c.action));
check('D1 普通控件不得被升级人工', harmed.length === 0, harmed.length ? '误伤 → ' + harmed.map((c) => c.label).join(' / ') : '');

check('D2 未锚定概念「手机号」**有意不纳入**（扩概念，登记缺口，仍可自动重做）',
  BLOCK({ type: 'fill', target: { semantic: '手机号输入框' } }) === false
  && BLOCK({ type: 'fill', target: { field: '手机号' } }) === false);

// 动作族仍由登记项 c 承担（本批一格未动）：断言其 true 的来源是 compat 子串面，而非本地化层
const actionFamily = [
  { label: 'click + semantic=登录按钮', action: { type: 'click', target: { semantic: '登录按钮' } } },
  { label: 'click + semantic=待支付订单', action: { type: 'click', target: { semantic: '待支付订单' } } },
];
check('D3 动作族 click 语义仍由**登记项 c** 承担（本批未动，非本地化层贡献）',
  actionFamily.every((c) => BLOCK(c.action) === true
    && COMPAT_RE.test(String((c.action.target && (c.action.target.field || c.action.target.semantic)) || ''))
    && c.action.type !== 'fill'));

// ══════════════════════════════════════════════════════════════════════
// E 零放宽：旧实现 true ⇒ 新实现 true（逐形状核对，严格超集）
// ══════════════════════════════════════════════════════════════════════
// 旧实现原文（**负样本夹具**，逐字取自 C144 前的 credentialRetryGuard.js 判据函数；
// 不是生产路径，只用于证明断言有分辨力）。依赖以参数注入，避免夹具内出现 require。
const OLD_IMPL_FIXTURE = [
  'function isCredentialActionBlockingRetry(action) {',
  '  const a = action || {};',
  '  if (gate.isCredentialAction(a)) return true;',
  "  if (a.risk === 'CRITICAL') return true;",
  "  if (a.type === 'delete') return true;",
  "  const f = String((a.target && (a.target.field || a.target.semantic)) || '');",
  '  if (compatRe.test(f)) return true;',
  '  return false;',
  '}',
].join('\n');

let oldFn = null;
let fixtureErr = null;
try {
  oldFn = new Function('gate', 'compatRe', 'return (' + OLD_IMPL_FIXTURE + ');')(factSource, COMPAT_RE);
  if (typeof oldFn !== 'function') throw new Error('构造结果非函数');
} catch (e) { fixtureErr = e && e.message ? e.message : String(e); }
check('F5 旧实现夹具构造成功（完整声明，非裸块 —— L30）', typeof oldFn === 'function', fixtureErr || 'ok');

if (typeof oldFn === 'function') {
  const revertMiss = LOCALIZED_CASES.filter((c) => !oldFn(c.action)).length;
  check('E1 [revert] 旧实现在本地化写值形状上全部漏判（B1 断言咬得住）',
    revertMiss === LOCALIZED_CASES.length, '旧实现漏判=' + revertMiss + '/' + LOCALIZED_CASES.length);

  const SUPERSET_BATTERY = [].concat(
    LOCALIZED_CASES.map((c) => c.action),
    NON_WRITE_CASES.map((c) => c.action),
    HARM_CASES.map((c) => c.action),
    actionFamily.map((c) => c.action),
    [{ type: 'fill', target: { field: '邮箱' } }, { type: 'fill', target: { semantic: '手机号输入框' } },
      { type: 'fill', target: { field: 'password' } }, { type: 'fill', target: { credentialRef: 'c1' } },
      { type: 'login', target: {} }, { type: 'delete', target: {} },
      { type: 'fill', target: { field: 'q' }, risk: 'CRITICAL' },
      { type: 'fill', target: { field: 'cardExpiry' } }, { type: 'fill', target: { field: 'cardholder' } },
      { type: 'fill', target: { semantic: '待支付订单' } }, { type: 'fill', target: { field: 'loginBtn' } },
      { type: 'fill', target: {} }, { type: 'click', target: {} },
      { type: 'fill', target: { field: 'billing.card' } }, { type: 'fill', target: { semantic: 'billing.qty' } },
      { type: 'fill', target: { field: '邮箱' }, risk: 'LOW' }]);

  const loosened = SUPERSET_BATTERY.filter((a) => oldFn(a) === true && BLOCK(a) === false);
  check('E2 零放宽：旧实现为 true 的形状，新实现必须**全部仍为 true**（严格超集）',
    loosened.length === 0,
    loosened.length ? '放宽 ' + loosened.length + ' 形状 → ' + loosened.slice(0, 5).map((a) => JSON.stringify(a)).join(' / ')
      : 'n=' + SUPERSET_BATTERY.length);
} else {
  check('E1 [revert] 旧实现在本地化写值形状上全部漏判（B1 断言咬得住）', false, '夹具不可用');
  check('E2 零放宽：旧实现为 true 的形状，新实现必须**全部仍为 true**（严格超集）', false, '夹具不可用');
}

// ══════════════════════════════════════════════════════════════════════
// F 防空（判据不恒真 / 有分辨力）
// ══════════════════════════════════════════════════════════════════════
check('F1 判据不恒真（普通语义为 false，防「全真」真空绿）',
  BLOCK({ type: 'fill', target: { semantic: '产品搜索框' } }) === false
  && BLOCK({ type: 'fill', target: {} }) === false);

check('F2 不相交判据有分辨力（正向：compat 覆盖词「密码」必须被判为相交）',
  COMPAT_RE.test('密码') === true && COMPAT_RE.test('password') === true
  && COMPAT_RE.test('邮箱') === false);

check('F3 锚定判据有分辨力（反向：不在事实源词表的 concept 必须被判为未锚定）',
  CRED_FIELDS.has('email') === true && CRED_FIELDS.has('phone') === false
  && CRED_FIELDS.has('mobile') === false);

check('F4 动作类型对拍有分辨力（正向：真实类型在闭集内；反向：臆造类型不在）',
  ACTION_TYPES.has('fill') === true && ACTION_TYPES.has('select') === true
  && ACTION_TYPES.has('fillX') === false);

console.log('\n---------------------------------------------------');
console.log('C144 结果：PASS ' + pass + ' / FAIL ' + fail);
if (fail) console.log('FAILURES:\n' + fails.map((f) => ' - ' + f).join('\n'));
console.log('---------------------------------------------------');
process.exit(fail ? 1 : 0);
