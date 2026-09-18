'use strict';

/**
 * test_c143_credential_family_singleton.js
 *
 * C143 守护：「凭据动作 ⇒ 阻断自动重做」族必须**全仓唯一实现**，两个消费方**同口径**。
 *
 * ## 缺陷背景（C143 = 补 C142 的结构性遗漏）
 *   C142 修掉了 `repair/strategies/verifyFailed.js` 内的第二份凭据判据，并把全仓
 *   「同名多实现」扫了一遍。但 `server/agent/runtime.js` 的 `isCredentialishStep` 是
 *   同一实现的**逐字副本**，只是**函数名不同** ⇒ C142 的扫描器按**函数名**分组，
 *   对**异名同义**结构性漏检。后果：runtime 侧仍漏判同一批 15 项凭据动作，
 *   凭据动作失败仍会进自动 REPLAN（把凭据重填进可能已漂移的页面）。
 *
 * ## 本守护的判据设计（比 C142 更宽的口径，专治异名同义）
 *   A 族级唯一定位 —— **不按名字**，改为按「凭据子串词表**正则字面量**」在
 *     `server/agent/**`（生产面）里的出现次数定位。异名同义无论如何改名都躲不过。
 *   B 纯委托     —— 两个消费方的判据函数体必须是**单行委托**，无本地分支残留。
 *   C 行为面     —— 经 runtime.isReplanCandidate 真实调用面验证 15 项漏判归零
 *                    （不复制逻辑；runtime 未导出私有判据，故只能走公开入口）。
 *   D revert     —— 把**旧实现原文**当负样本跑同一组行为断言，必须大面积失手。
 *   E 两消费方同答 —— verifyFailed.execute 与 runtime.isReplanCandidate 在同一电池上
 *                    必须给出**互补一致**的结果（这是本次收口的直接目的）。
 *   F 防空断言   —— 判据不恒真、负样本非恒红、电池非空。
 *
 * ★ 自扫描纪律（L29）：本守护内含**旧实现原文**作负样本（其中有凭据词表正则字面量），
 *   因此 A 组只扫 `server/agent/**`，**绝不扫 server/scripts/**，否则会自咬假红。
 *
 * 隔离：FPB_DATA_DIR 指向 tmp 且置于**首个 require 之前**（模块加载期解析）。
 * 本套件零浏览器、零 LLM、零网络。
 */

// 数据根隔离必须早于任何 require（含 node 内置）。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c143_cred_family_' + Date.now());

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const AGENT_DIR = path.join(ROOT, 'server', 'agent');
const GUARD_REL = 'credentialRetryGuard.js';

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
// A 族级唯一定位：按「凭据子串词表正则字面量」扫生产面
//   —— 不按函数名 ⇒ 异名同义躲不过（这正是 C142 漏检的根因）
// ══════════════════════════════════════════════════════════════════════
const CRED_RE_LITERAL = /\/[^\n/]*(?:password|card|cvv|otp|密码|登录|支付|付款|卡号)[^\n/]*\/[gimsuy]*/g;

// ⚠️ 判据必须双向标定：仅凭「正则里含某个凭据词」会把**无关用途**的正则一起算进来
//    （实测 server/agent 有 23 个文件的正则含「密码/登录/支付」等词，其中 planner.js
//     的 12 处是 **prompt 文本**、observation.js 的 5 处是**页面文本匹配**）。
//   进一步实测：按「token 数 ≥ 4」过滤仍剩 7 个文件（observation.js / pageStateClassifier.js /
//    skillBuilder.js 等的文本匹配正则也含 4–7 个词）⇒ 计数阈值**不足以区分**。
//   真正可区分的特征是「**同时枚举全部 9 个 token**」（与顺序无关）——
//   这是历史两份副本的独有形状，也是本判据能咬住「异名同义」的原因。
const CRED_TOKENS = ['password', 'card', 'cvv', 'otp', '支付', '付款', '登录', '密码', '卡号'];
function isCredentialSubstringTable(reLiteral) {
  return CRED_TOKENS.every((t) => reLiteral.indexOf(t) >= 0);
}

function walkJs(dir, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|\.git$|data$|profiles$/.test(e.name)) continue;
      walkJs(p, acc);
    } else if (/\.js$/i.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

const agentFiles = walkJs(AGENT_DIR, []);
const located = [];      // 凭据**子串词表**（同时枚举全部 9 个 token）
const nearMiss = [];     // 含部分凭据词的**无关**正则（留档，用于证明判据确实有分辨力）
for (const f of agentFiles) {
  const rel = path.relative(AGENT_DIR, f).replace(/\\/g, '/');
  const body = stripComments(fs.readFileSync(f, 'utf8'));
  const ms = body.match(CRED_RE_LITERAL) || [];
  const tables = ms.filter(isCredentialSubstringTable);
  const others = ms.filter((m) => !isCredentialSubstringTable(m));
  if (tables.length) located.push({ file: rel, ms: tables });
  if (others.length) {
    nearMiss.push({ file: rel, n: others.length, max: Math.max(...others.map((m) => CRED_TOKENS.filter((t) => m.indexOf(t) >= 0).length)) });
  }
}

check('A1 生产面(server/agent)凭据**子串词表**恰好 1 处（族级唯一，按字面量形状定位）',
  located.length === 1 && located[0].file === GUARD_REL,
  located.length ? located.map((x) => x.file + '(' + x.ms.length + ')').join(' , ') : 'count=0');
check('A2 该唯一处位于共享模块内且只出现 1 次',
  located.length === 1 && located[0].ms.length === 1,
  located.length === 1 ? 'n=' + located[0].ms.length : 'located=' + located.length);
{
  // 逐字比对：共享模块内该正则必须与「已知旧实现副本」逐字相同（防被悄悄改宽/改窄）
  const expected = '/password|card|cvv|otp|支付|付款|登录|密码|卡号/';
  const actual = located.length === 1 ? located[0].ms[0].replace(/[gimsuy]+$/, '') : '';
  check('A3 该正则逐字等于历史两份副本的内容（既未放宽也未收紧）', actual === expected,
    'actual=' + JSON.stringify(actual));
}
// ★ 双向标定（L28 同族）：证明判据**真的把无关正则排除在外**，而不是「恰好都没命中」。
//   被排除项必须存在（否则判据可能对任何输入都返回 0）且必须**不全含 9 个 token**。
check('A3b 判据有分辨力：确有被排除的无关正则，且它们不全含词表 token',
  nearMiss.length > 0 && nearMiss.every((x) => x.max < CRED_TOKENS.length),
  'nearMiss 文件数=' + nearMiss.length
  + ' 其最大 token 数=' + (nearMiss.length ? Math.max(...nearMiss.map((x) => x.max)) : 0)
  + ' 词表 token 数=' + CRED_TOKENS.length);
check('A4 扫描面非空且确实扫到了 agent 目录（防「目录名写错 ⇒ 恒 0 命中」真空绿）',
  agentFiles.length >= 30, 'files=' + agentFiles.length);

// ══════════════════════════════════════════════════════════════════════
// B 纯委托：两个消费方的判据函数体不得有本地分支
// ══════════════════════════════════════════════════════════════════════
{
  const rtSrc = stripComments(fs.readFileSync(path.join(AGENT_DIR, 'runtime.js'), 'utf8'));
  const vfSrc = stripComments(fs.readFileSync(path.join(AGENT_DIR, 'repair', 'strategies', 'verifyFailed.js'), 'utf8'));
  const pureDelegate = (src, fn, param) => new RegExp(
    'function ' + fn + '\\s*\\(\\s*' + param + '\\s*\\)\\s*\\{\\s*return credentialRetryGuard\\.isCredentialActionBlockingRetry\\('
    + param + '\\s*&&\\s*' + param + '\\.action\\);\\s*\\}').test(src);

  check('B1 runtime.isCredentialishStep 是纯委托（无本地分支残留）',
    pureDelegate(rtSrc, 'isCredentialishStep', 'step'));
  check('B2 verifyFailed.isCredentialAction 是纯委托（无本地分支残留）',
    pureDelegate(vfSrc, 'isCredentialAction', 'step'));
  // revert 对照：旧写法（带 if 分支）必须不被判为纯委托
  check('B3 纯委托判据对旧写法（含分支）会红（断言有分辨力）',
    !pureDelegate('function isCredentialishStep(step) {\n const a = step && step.action;\n if (!a) return false;\n return true;\n}', 'isCredentialishStep', 'step'));
}

// ══════════════════════════════════════════════════════════════════════
// C/E 行为面：两个消费方真实调用（不复制逻辑）
// ══════════════════════════════════════════════════════════════════════
const runtime = require(path.join(AGENT_DIR, 'runtime.js'));
const verifyFailed = require(path.join(AGENT_DIR, 'repair', 'strategies', 'verifyFailed.js'));

/** runtime 侧：该 action 失败后**是否可自动 REPLAN**（true = 可，未被凭据判据挡住）。 */
function replannable(action) {
  return runtime.isReplanCandidate(
    { code: 'ELEMENT_NOT_FOUND', message: '未找到元素' },
    { action: Object.assign({ verification: { type: 'none' } }, action) });
}
/** verifyFailed 侧：该 action 真实失败后**是否需人工审批**（true = 被凭据判据挡住）。 */
async function needsApproval(action) {
  const step = {
    id: 'c143_step',
    action: Object.assign({ verification: { type: 'none' } }, action),
    verification: { type: 'none' },
  };
  const res = await verifyFailed.execute({
    task: {},
    step,
    ctx: {
      error: { failureType: 'ACTION_REAL_FAILURE' },
      observation: null,
      calls: [],
      runAction: async () => ({ success: true, observation: null }),
    },
  });
  return !!(res && res.needsApproval === true && res.strategy === 'REAUTH_OR_PAUSE');
}

// 15 项漏判清单（逐字来自 C142 探针实测输出；runtime 侧历史漏判同一清单）
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
  { label: 'type=password_change（凭据类动作类型）', action: { type: 'password_change', target: {} } },
];

// 登记项（C142 三项，删除任一 = 放宽）
const REGISTERED = [
  { label: '登记项 a: risk=CRITICAL', action: { type: 'fill', target: { field: 'q' }, risk: 'CRITICAL' } },
  { label: '登记项 b: type=delete', action: { type: 'delete', target: {} } },
  { label: '登记项 c: 子串 cardExpiry（事实源全等不覆盖）', action: { type: 'fill', target: { field: 'cardExpiry' } } },
];

// 不得误伤（真实数据高频普通控件）
const NON_CRED = [
  { label: 'field=search', action: { type: 'fill', target: { field: 'search' } } },
  { label: 'field=q', action: { type: 'fill', target: { field: 'q' } } },
  { label: 'click + field=submitBtn', action: { type: 'click', target: { field: 'submitBtn' } } },
  // ⚠️ C144 更新夹具（**不变量不变**）：原为 semantic=注册邮箱输入框，C144 起该语义
  //    已正确判为凭据动作 ⇒ 不再是「普通控件」。换成真中性语义以保住 C104 A1 的不变量。
  { label: 'fill + semantic=产品搜索框（普通控件；C104 A1 契约，必须仍可 REPLAN）',
    action: { type: 'fill', target: { semantic: '产品搜索框' } } },
];

// C144 收紧面（登记项 d：本地化**写值**语义）—— 旧行为放行、新行为必须挡住。
// 这批形状在 C144 前是 C104 A1 的夹具，故其「被挡住」正是 C144 的行为证据。
const C144_TIGHTENED = [
  { label: 'C144 fill + semantic=注册邮箱输入框（原 C104 A1 夹具）',
    action: { type: 'fill', target: { semantic: '注册邮箱输入框' } } },
  { label: 'C144 fill + semantic=用户名输入框（真实数据 42 例）',
    action: { type: 'fill', target: { semantic: '用户名输入框' } } },
  { label: 'C144 fill + field=邮箱（真实数据 7 例）',
    action: { type: 'fill', target: { field: '邮箱' } } },
  { label: 'C144 fill + semantic=验证码', action: { type: 'fill', target: { semantic: '验证码' } } },
];

// C144 有意**不**动的面（分层边界，动了就是错）：
//   · 非写值动作 × 本地化词 —— click 承载「动作/区域」而非字段
//   · 未锚定概念（手机号）—— 扩概念，登记缺口
const C144_UNTOUCHED = [
  { label: 'click + semantic=邮箱注册按钮（同一词、非写值动作 ⇒ 本层不生效）',
    action: { type: 'click', target: { semantic: '邮箱注册按钮' } } },
  { label: 'wait + semantic=等待邮箱验证码加载（非写值动作）',
    action: { type: 'wait', target: { semantic: '等待邮箱验证码加载' } } },
  { label: 'fill + semantic=手机号输入框（未锚定概念，登记缺口）',
    action: { type: 'fill', target: { semantic: '手机号输入框' } } },
];

// 旧 runtime 实现原文（**负样本夹具**，逐字取自 C143 改动前的 runtime.js；
// 不是生产路径，只用于证明下面的行为断言有分辨力）
const OLD_RUNTIME_IMPL = [
  'function isCredentialishStep(step) {',
  '  const a = step && step.action;',
  '  if (!a) return false;',
  "  if (a.risk === 'CRITICAL') return true;",
  "  if (['purchase', 'payment', 'password_change', 'delete', 'login'].includes(a.type)) return true;",
  "  const f = String((a.target && (a.target.field || a.target.semantic)) || '');",
  '  if (/password|card|cvv|otp|支付|付款|登录|密码|卡号/.test(f)) return true;',
  '  return false;',
  '}',
].join('\n');

let oldFn = null;
let fixtureErr = null;
try {
  oldFn = new Function('return (' + OLD_RUNTIME_IMPL + ')')();
  if (typeof oldFn !== 'function') throw new Error('构造结果非函数');
} catch (e) { fixtureErr = e.message; }
check('F1 旧实现夹具构造成功（完整声明，非裸块）', typeof oldFn === 'function', fixtureErr || 'ok');

(async () => {
  // ── C runtime 侧行为面：15 项漏判归零（不可 REPLAN = 被挡住）──
  const stillLeaking = [];
  for (const c of LEAK_CASES) {
    if (replannable(c.action)) stillLeaking.push(c.label);
  }
  check('C1 [runtime] 15 项凭据动作全部不可自动 REPLAN（漏判归零）', stillLeaking.length === 0,
    stillLeaking.length ? '仍漏判=' + stillLeaking.length + ' → ' + stillLeaking.join(' / ') : '');

  // ── C2 revert 对照：旧实现必须在同 15 项上大面积失手 ──
  if (typeof oldFn === 'function') {
    const oldMiss = LEAK_CASES.filter((c) => !oldFn({ action: c.action })).length;
    check('C2 [revert] 旧 runtime 实现在同 15 项上必须漏判 ≥12（断言咬得住）', oldMiss >= 12,
      '旧实现漏判=' + oldMiss + '/15');
  } else {
    check('C2 [revert] 旧 runtime 实现在同 15 项上必须漏判 ≥12（断言咬得住）', false, '夹具不可用');
  }

  // ── C3 登记项在 runtime 侧同样在场 ──
  const missReg = REGISTERED.filter((r) => !(!replannable(r.action)));
  check('C3 [runtime] 三项登记项全部在场（删除任一 = 放宽）', missReg.length === 0,
    missReg.length ? '缺失 → ' + missReg.map((x) => x.label).join(' / ') : '');

  // ── C4 不得误伤（C104 A1 契约：非凭据普通控件仍可 REPLAN）──
  const hurt = NON_CRED.filter((c) => !replannable(c.action));
  check('C4 [runtime] 普通控件仍可自动 REPLAN（含 C104 A1「普通语义字段」契约）',
    hurt.length === 0, hurt.length ? '误伤 → ' + hurt.map((x) => x.label).join(' / ') : '');

  // ── C5 C144 收紧面：本地化**写值**语义必须被挡住（登记项 d）──
  const notTightened = C144_TIGHTENED.filter((c) => replannable(c.action));
  check('C5 [runtime] C144 本地化写值语义全部不可自动 REPLAN（收紧面到位）',
    notTightened.length === 0,
    notTightened.length ? '未收紧 → ' + notTightened.map((x) => x.label).join(' / ') : '');

  // ── C5b revert 对照：旧实现必须在同一批形状上全部漏判（证明 C5 有分辨力）──
  if (typeof oldFn === 'function') {
    const oldMiss = C144_TIGHTENED.filter((c) => !oldFn({ action: c.action })).length;
    check('C5b [revert] 旧实现对本批形状全部漏判（C5 断言咬得住）',
      oldMiss === C144_TIGHTENED.length,
      '旧实现漏判=' + oldMiss + '/' + C144_TIGHTENED.length);
  } else {
    check('C5b [revert] 旧实现对本批形状全部漏判（C5 断言咬得住）', false, '夹具不可用');
  }

  // ── C6 C144 分层边界：非写值动作 / 未锚定概念必须**原样不动**（仍可 REPLAN）──
  const movedBoundary = C144_UNTOUCHED.filter((c) => !replannable(c.action));
  check('C6 [runtime] C144 边界面未被误扩（非写值动作 + 未锚定概念仍可 REPLAN）',
    movedBoundary.length === 0,
    movedBoundary.length ? '边界被误扩 → ' + movedBoundary.map((x) => x.label).join(' / ') : '');

  // ── E 两消费方同答（本次收口的直接目的）──
  const BATTERY = [].concat(LEAK_CASES, REGISTERED, NON_CRED, C144_TIGHTENED, C144_UNTOUCHED);
  const mismatch = [];
  for (const c of BATTERY) {
    const vf = await needsApproval(c.action);   // true = 需人工
    const rt = replannable(c.action);           // true = 可 REPLAN
    if (vf !== !rt) mismatch.push(c.label + '(vf=' + vf + ', replannable=' + rt + ')');
  }
  check('E1 两个消费方在同一电池上互补一致（verifyFailed 需人工 ⟺ runtime 不可 REPLAN）',
    mismatch.length === 0,
    mismatch.length ? '不一致 ' + mismatch.length + ' 项 → ' + mismatch.slice(0, 5).join(' / ') : '');
  check('E2 电池非空（防「空电池 ⇒ 恒一致」真空绿）', BATTERY.length >= 20, 'n=' + BATTERY.length);

  // ── F 防空 ──
  check('F2 A 组判据不恒真（对不含凭据正则的源码为 0 命中）',
    (stripComments('const x = 1;').match(CRED_RE_LITERAL) || []).length === 0);
  check('F3 A 组判据对含凭据正则的源码为 1 命中（正向对照）',
    (stripComments('const R = /password|card|密码/;').match(CRED_RE_LITERAL) || []).length === 1);

  try { fs.rmSync(process.env.FPB_DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }

  console.log('\n---------------------------------------------------');
  console.log('C143 结果：PASS ' + pass + ' / FAIL ' + fail);
  if (fail) console.log('FAILURES:\n' + fails.map((f) => ' - ' + f).join('\n'));
  console.log('---------------------------------------------------');
  process.exit(fail ? 1 : 0);
})();
