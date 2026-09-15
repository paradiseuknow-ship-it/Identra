'use strict';

// =============================================================================
// C133 守护：契约求值的**唯一实现**收口（VIL 的 `businessStatePresent` 缺 forbidden 通道）。
//
// ── 事实链 ──────────────────────────────────────────────────────────────────
// 契约语义此前有**两份实现**：
//   A 裁决面  verification.js:verify → contract.evaluateContract（唯一实现）
//       :260-267 第 1 步查 forbiddenEvidence：任一命中 ⇒ 硬失败
//                （注释逐字："ANY match => hard fail (never override)"，confidence 0.95）
//       requiredEvidence 只是**第 2 步**。
//   C 诊断面  verificationIntelligence.js:businessStatePresent（第二份实现）
//       逐条 requiredEvidence 按 evidenceLogic 组合，**全文无 forbidden 概念**。
// ⇒ 同一份合约 + 同一对 before/after：A 判「硬失败（禁止证据命中）」，
//   C 判「期望业务结果其实已达成」⇒ 4b VERIFICATION_TOO_STRICT + RETRY_VERIFY
//   —— 把「页面出现错误信号」的真实失败说成「验证规则太严」，并交给 repair 找替代态。
//
// ── 实测（c133_reach.js，改前）──────────────────────────────────────────────
//   S1 submit / S2 login / S3 search / S4 logout 全部 A=false+forbiddenHit 且
//   C=VERIFICATION_TOO_STRICT+RETRY_VERIFY ⇒ 相反答案 4 / 4。
//
// ── 面基数（非边角）────────────────────────────────────────────────────────
//   DERIVABLE 10 个动作类型中 **4 个带 forbiddenEvidence**（login/logout/search/submit）
//   ⇒ 带 forbidden 的契约 100% 落在分歧面内。
//
// ── 权威依据（消费方契约，由代码自身声明）──────────────────────────────────
//   verification/verificationWindow.js:47「完整契约（含 requiredEvidence / stateType）
//   直接透传，走 evaluateContract（**含 forbidden / AND-OR 语义**）」；
//   contract.js:5-6 自述 "The single source of truth for 'did the BUSINESS outcome complete'"。
//
// ── 修法（方向 = 收紧）─────────────────────────────────────────────────────
//   `businessStatePresent` 委托 `contractLib.evaluateContract(contract, after, before, clauseVerify)`，
//   clauseVerify 注入本文件 `clausePresent`（**保留诊断层逐子句的第二意见**，
//   element_present 沿用 requireActionable:false，与裁决面 clausePresent 支同口径）。
//
// ── 组说明 ──────────────────────────────────────────────────────────────────
// A 组 = **真实入口**跨层对账（4 场景；改前 4/4 相反）
// B 组 = **反向探针**：分支活性（反真空）+ 收敛点归因 + 不得靠放宽取一致
// C 组 = **静态委托**（L15：宽窄类 no-op 不红「同答」⇒ 须有静态证据）+ L17 双向咬（含分辨力自证）
// D 组 = 登记面：收口**顺带继承**的两条路径（normalizeContract filter / allowedAlternatives
//        递归 OR）在诊断层**结构性不可达**——写成可回归断言，而非只写在注释里（L16 反面）
// E 组 = 三向自检 + 生产可达性 + **全库调用点扫描**（L16：新守护同样是被扫面）
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// 本守护 require 了 VIL / 裁决面（间接引入 store / lifecycle）——
// 数据根指到仓库内临时目录，避免污染 server/data（C116 数据根纪律）。
if (!process.env.FPB_DATA_DIR) {
  process.env.FPB_DATA_DIR = path.join(ROOT, '.benchmark', 'c133_guard_tmp');
}

const clause = require('../agent/verification/clause.js');
const contract = require('../agent/verification/contract.js');
const vil = require('../agent/verification/verificationIntelligence.js');
const verification = require('../agent/verification.js');

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

// ── 统一夹具（形状必须穿过 _analyze 的 1/2/3/4a 短路抵达 4b）─────────────────
// ⚠️ actionResult 字段是 **success**（不是 ok）；观测字段是 loadingState / networkState；
//    previousObservationDiff 必须显式给，否则 4a domChanged 短路（C131 §3 陷阱 2）。
function obs(url, textSummary) {
  return {
    url,
    textSummary,
    visibleText: textSummary,
    elements: [],
    contentLeaves: [],
    storage: null,
    loadingState: 'complete',
    networkState: 'idle',
    previousObservationDiff: {},
  };
}

// 真实入口：A 裁决面 + C 诊断面 同场对照（不 eval 源码）
function runPair(label, actionType, before, after) {
  const eff = verification.buildEffectiveVerification({ action: { type: actionType } });
  const a = verification.verify(eff, after, before);
  const c = vil.analyze({
    beforeObservation: before,
    afterObservation: after,
    expectedVerification: eff,
    actionResult: { success: true },
    action: { type: actionType },
  });
  return { label, eff, a, c };
}

// ── 4 个真实场景（与侦察探针同夹具）────────────────────────────────────────
// 每个场景：静态页**同时**含「required 侧命中词」与「forbidden 侧命中词」
// ⇒ required 侧可满足（故改前 C 判「已达成」），forbidden 侧命中（故 A 判硬失败）。
const SCENARIOS = [
  {
    label: 'S1 submit',
    actionType: 'submit',
    url: 'https://shop.example.com/checkout',
    text: 'Required fields are marked * Thank you for contacting us',
    forbiddenWord: 'required',
  },
  {
    label: 'S2 login',
    actionType: 'login',
    url: 'https://shop.example.com/login',
    text: 'Sign in  Profile  Terms  Error codes',
    forbiddenWord: 'error',
  },
  {
    label: 'S3 search',
    actionType: 'search',
    url: 'https://shop.example.com/search?q=a',
    text: 'Search results  No results  Not found  Try again',
    forbiddenWord: 'no results',
  },
  {
    label: 'S4 logout',
    actionType: 'logout',
    url: 'https://shop.example.com/home',
    text: 'Log in  Register  Logout  My account',
    forbiddenWord: 'logout',
  },
];

console.log('=== C133 守护：契约求值唯一实现收口（businessStatePresent 缺 forbidden 通道）===\n');

// ── A 组：真实入口跨层对账 ──────────────────────────────────────────────────
console.log('── A 组：真实入口（buildEffectiveVerification → verify / analyze）──');
const PAIRS = [];
{
  for (const s of SCENARIOS) {
    const o = obs(s.url, s.text);
    PAIRS.push(runPair(s.label, s.actionType, o, o));
  }

  // A1：生产形态可达性 —— 关键业务动作且 planner 未给真实验证 ⇒ effV 为 businessState 契约形态
  //     ⇒ 4b 走 `businessStatePresent`（本批修复点）。若形状变化（如 planner 强制给裸 verification）
  //     本断言即红 —— 防「夹具按代码分支写」的假守护（L16）。
  const shapeOk = PAIRS.every((p) => p.eff && p.eff.businessState && p.eff.businessState.stateType
    && Array.isArray(p.eff.businessState.forbiddenEvidence) && p.eff.businessState.forbiddenEvidence.length > 0);
  ok(shapeOk,
    'A1 生产形态：4 个场景的 effV 均为 businessState 契约形态且**含 forbiddenEvidence**（⇒ 必走 businessStatePresent）',
    JSON.stringify(PAIRS.map((p) => (p.eff.businessState ? p.eff.businessState.stateType + ':' + p.eff.businessState.forbiddenEvidence.length : '?')).join(',')));

  // A2：A 裁决面确实因 forbidden 命中而硬失败（本批的「真实答案」）
  const aFail = PAIRS.every((p) => p.a && p.a.success === false && !!p.a.forbiddenHit);
  ok(aFail,
    'A2 裁决面：4 个场景均判 success=false 且给出 forbiddenHit（hard fail，never override）',
    JSON.stringify(PAIRS.map((p) => (p.a.forbiddenHit ? p.a.forbiddenHit.type + '="' + p.a.forbiddenHit.expect + '"' : '-')).join(' | ')));

  // A3：★ 本批修复点 —— 诊断面**不得**再说「期望业务结果其实已达成」
  const cWrong = PAIRS.filter((p) => p.c.failureType === 'VERIFICATION_TOO_STRICT');
  ok(cWrong.length === 0,
    'A3 ★ 诊断面：4 个场景**均不得**报 VERIFICATION_TOO_STRICT（改前 4/4 全报 —— 跨层相反答案）',
    '仍报=[' + cWrong.map((p) => p.label).join(',') + ']');

  // A4：跨层相反答案计数归零（改前 = 4 / 4）
  const opposite = PAIRS.filter((p) => p.a.success === false && !!p.a.forbiddenHit
    && p.c.failureType === 'VERIFICATION_TOO_STRICT').length;
  ok(opposite === 0,
    'A4 相反答案计数：A 判硬失败(forbidden) 且 C 判 TOO_STRICT 的场景数 = 0 / 4（改前 = 4 / 4）',
    'count=' + opposite);

  // A5：诊断面仍产出**可解释**结论（不是抛异常/空对象）——防「修成不判」的伪修复
  const cAlive = PAIRS.every((p) => p.c && typeof p.c.failureType === 'string' && p.c.failureType.length > 0
    && p.c.decision && Array.isArray(p.c.evidence) && p.c.evidence.length > 0);
  ok(cAlive,
    'A5 诊断面仍有结论：4 个场景均产出 failureType + decision + evidence（未被修成恒空）',
    JSON.stringify(PAIRS.map((p) => p.label + '=' + p.c.failureType + '/' + p.c.decision).join(' ')));
}

// ── B 组：反向探针（一致性不得靠放宽 / 降级换来）────────────────────────────
console.log('\n── B 组：反向探针（分支活性 / 收敛点归因 / 不得放宽）──');
{
  // B1 ★ 分支活性（反真空）：若 `businessStatePresent` 被修成**恒 false**，A3/A4 也会全绿。
  //     ⇒ 必须证明 4b 的 TOO_STRICT 分支**仍能触发**（required 满足 + 无 forbidden 命中）。
  //    ⚠️ 诚实声明：该输入在生产下 A 面同样判成功 ⇒ VIL **不会被调用**；
  //       此断言只用于证明分支活性（非恒 false），不声称它在生产可达。
  const bsAlive = {
    stateType: 'GENERIC_STATE',
    requiredEvidence: [{ type: 'text_present', expect: 'hello' }],
    forbiddenEvidence: [],
    evidenceLogic: 'AND',
  };
  const alive = vil.analyze({
    beforeObservation: obs('https://a.com/p', 'hello'),
    afterObservation: obs('https://a.com/p', 'hello'),
    expectedVerification: { businessState: bsAlive },
    actionResult: { success: true },
    action: { type: 'click' },
  });
  ok(alive.failureType === 'VERIFICATION_TOO_STRICT' && alive.decision === 'RETRY_VERIFY',
    'B1 分支活性（反真空）：required 满足且**无 forbidden 命中** ⇒ 4b 仍报 VERIFICATION_TOO_STRICT / RETRY_VERIFY',
    JSON.stringify({ failureType: alive.failureType, decision: alive.decision }));

  // B2 ★ 收敛点归因：forbidden 通道是**唯一**分歧源 ——
  //    对同一合约、同一 before/after，仅把 forbiddenEvidence 置空：
  //      带 forbidden ⇒ evaluateContract.success = false（A2 已证）
  //      去 forbidden ⇒ evaluateContract.success = true （⇒ required 侧确实可满足，改前 C 才判「已达成」）
  //    用具名 clauseVerify = verification.verify（裁决面口径）；两行只差一个字段，
  //    排除「required 侧本身没满足、C 只是瞎报」的可能。
  const onlyForbidden = [];
  for (const s of SCENARIOS) {
    const bs = verification.buildEffectiveVerification({ action: { type: s.actionType } }).businessState;
    const o = obs(s.url, s.text);
    const stripped = Object.assign({}, bs, { forbiddenEvidence: [] });
    const r = contract.evaluateContract(stripped, o, o, verification.verify);
    onlyForbidden.push({ label: s.label, noFb: r.success });
  }
  ok(onlyForbidden.every((x) => x.noFb === true),
    'B2 收敛点归因：仅移除 forbiddenEvidence ⇒ evaluateContract.success 翻为 true（⇒ forbidden 通道是唯一分歧源）',
    JSON.stringify(onlyForbidden));

  // B2b ★ 最紧的一条：**用诊断面自己的 clauseVerify 口径**，同一批子句去掉 forbidden ⇒
  //     VIL 立刻报「已达成」。⇒ 证明收口**精确地补上了 forbidden 通道**，
  //     且**未改动 required 侧口径**（否则本条会失配）。
  const vilNoFb = [];
  for (const s of SCENARIOS) {
    const eff = verification.buildEffectiveVerification({ action: { type: s.actionType } });
    const stripped = Object.assign({}, eff.businessState, { forbiddenEvidence: [] });
    const o = obs(s.url, s.text);
    const c = vil.analyze({
      beforeObservation: o,
      afterObservation: o,
      expectedVerification: { businessState: stripped },
      actionResult: { success: true },
      action: { type: s.actionType },
    });
    vilNoFb.push({ label: s.label, ft: c.failureType });
  }
  ok(vilNoFb.every((x) => x.ft === 'VERIFICATION_TOO_STRICT'),
    'B2b 症状对消：diagnostic 层面仅去掉 forbiddenEvidence ⇒ 4 场景**全部**回到 VERIFICATION_TOO_STRICT'
    + '（⇒ required 侧口径未变，变化只来自 forbidden 通道）',
    JSON.stringify(vilNoFb));

  // B3：不得靠放宽取一致 —— required **未**满足且无 forbidden 命中 ⇒ 不得报 TOO_STRICT
  const bsUnsatisfied = {
    stateType: 'GENERIC_STATE',
    requiredEvidence: [{ type: 'text_present', expect: '__definitely_absent__' }],
    forbiddenEvidence: [],
    evidenceLogic: 'AND',
  };
  const unsat = vil.analyze({
    beforeObservation: obs('https://a.com/p', 'nothing here'),
    afterObservation: obs('https://a.com/p', 'nothing here'),
    expectedVerification: { businessState: bsUnsatisfied },
    actionResult: { success: true },
    action: { type: 'click' },
  });
  ok(unsat.failureType !== 'VERIFICATION_TOO_STRICT',
    'B3 不得放宽：required 未满足（无 forbidden 命中）⇒ 不得报 VERIFICATION_TOO_STRICT',
    JSON.stringify({ failureType: unsat.failureType, decision: unsat.decision }));

  // B4：forbidden 命中 + required **未**满足 ⇒ 同样不得报 TOO_STRICT
  //     （收口后 forbidden 优先于 required，与裁决面 :260-267 的「第 1 步」语义一致）
  const bsBoth = {
    stateType: 'GENERIC_STATE',
    requiredEvidence: [{ type: 'text_present', expect: '__definitely_absent__' }],
    forbiddenEvidence: [{ type: 'text_present', expect: 'error' }],
    evidenceLogic: 'AND',
  };
  const both = vil.analyze({
    beforeObservation: obs('https://a.com/p', 'error page'),
    afterObservation: obs('https://a.com/p', 'error page'),
    expectedVerification: { businessState: bsBoth },
    actionResult: { success: true },
    action: { type: 'click' },
  });
  ok(both.failureType !== 'VERIFICATION_TOO_STRICT',
    'B4 forbidden 优先：forbidden 命中且 required 未满足 ⇒ 不得报 TOO_STRICT（与裁决面第 1 步语义一致）',
    JSON.stringify({ failureType: both.failureType, decision: both.decision }));

  // B5：与子句唯一实现同答（口径唯一性的直接证据）—— forbidden 词在 after 文本中确实成立
  const fbHit = clause.evalTextPresent(obs('https://a.com/p', 'Required fields are marked *'), 'required').ok;
  ok(fbHit === true,
    'B5 子句层同答：clause.evalTextPresent 对 forbidden 词 "required" 判 true（⇒ A2 的 forbiddenHit 有实据）',
    'ok=' + fbHit);
}

// ── C 组：静态委托（L15）+ L17 双向咬（含分辨力自证）────────────────────────
console.log('\n── C 组：静态委托断言（L15 / L17：shape 与 revert 双向咬）──');
{
  const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');
  const body = (VIL_SRC.match(/function businessStatePresent\([\s\S]*?\n\}/) || [''])[0];

  // 反向夹具：**改前**形态（逐字复刻改前源码，去掉缩进外壳）。
  // 用途①：作为「回退探针」的阳性样本（证明 revert 正则确实咬得住缺陷形状）；
  // 用途②：作为「shape 正则」的阴性样本（证明 shape 正则不是恒真）。
  const PREFIX_FIXTURE = [
    'function businessStatePresent(contract, after, before) {',
    '  if (!contract || !after) return false;',
    '  const clauses = contract.requiredEvidence || [];',
    '  if (!clauses.length) return false;',
    "  const logic = contract.evidenceLogic === 'OR' ? 'OR' : 'AND';",
    '  let matched = 0;',
    '  for (const cl of clauses) if (clausePresent(cl, after, before)) matched++;',
    "  return logic === 'OR' ? matched > 0 : matched === clauses.length;",
    '}',
  ].join('\n');

  const SHAPE_DELEGATE = /const r = contractLib\.evaluateContract\(contract, after, before,/;
  const REVERT_GUARD = /const clauses = contract\.requiredEvidence \|\| \[\];/;
  const REVERT_LOGIC = /const logic = contract\.evidenceLogic === 'OR' \? 'OR' : 'AND';/;
  const REVERT_COMBINE = /for \(const cl of clauses\) if \(clausePresent\(cl, after, before\)\) matched\+\+;/;

  // C1：函数体作用域内已委托唯一实现
  ok(body.length > 0 && SHAPE_DELEGATE.test(body),
    'C1 委托：businessStatePresent 体内调用 contractLib.evaluateContract（唯一实现）',
    body ? 'bodyLen=' + body.length : 'BODY_NOT_FOUND');

  // C2：函数体内**不得**残留改前的第二份组合逻辑（三项 revert 正则全部失配）
  ok(body.length > 0 && !REVERT_GUARD.test(body) && !REVERT_LOGIC.test(body) && !REVERT_COMBINE.test(body),
    'C2 无第二份实现：businessStatePresent 体内不残留 requiredEvidence 手写组合（守卫生效）',
    JSON.stringify({ g: REVERT_GUARD.test(body), l: REVERT_LOGIC.test(body), c: REVERT_COMBINE.test(body) }));

  // C3：require 指向同一模块（同一函数引用链，而非「另一份 contract」）
  ok(/const contractLib = require\('\.\/contract'\);/.test(VIL_SRC),
    'C3 同一模块：contractLib 由 ./contract require（与 verification.js / verificationWindow.js 同一实现）');

  // C4 ★ L17 分辨力自证（防真空绿）——shape 正则对**改前夹具**必须失配，
  //    revert 正则对**改前夹具**必须命中。否则「C1 绿」可能只因正则恒真。
  const shapeOnFixture = SHAPE_DELEGATE.test(PREFIX_FIXTURE);
  const revertOnFixture = REVERT_GUARD.test(PREFIX_FIXTURE) && REVERT_LOGIC.test(PREFIX_FIXTURE) && REVERT_COMBINE.test(PREFIX_FIXTURE);
  ok(shapeOnFixture === false && revertOnFixture === true,
    'C4 ★ 分辨力自证：shape 正则对改前夹具**失配**、revert 正则对改前夹具**命中**（⇒ 探针能分辨两个形状）',
    JSON.stringify({ shapeOnFixture, revertOnFixture }));

  // C5 ★ L17 反向（真回退必红）：shape 正则对**当前**函数体命中，且 revert 三项对它失配
  ok(SHAPE_DELEGATE.test(body) === true && !(REVERT_GUARD.test(body) || REVERT_LOGIC.test(body) || REVERT_COMBINE.test(body)),
    'C5 ★ L17 双向咬：shape 对当前体命中 + revert 对当前体失配（改后形状与改前形状互斥）');
}

// ── D 组：登记面（收口**顺带继承**的路径 —— 写成可回归断言）──────────────────
console.log('\n── D 组：登记面（normalizeContract / allowedAlternatives / 使用面）──');
{
  // D1：`normalizeContract:217` 会把**无 type 的子句 filter 掉**，而改前 VIL 直接吃 raw 数组
  //     ⇒ 两者原则上可在「AND 模式下含无 type 项」处分歧（改后更宽）。
  //     **本断言把「该分歧在生产契约上不可达」写成可回归事实**：
  //     全部 DERIVABLE 派生契约的 requiredEvidence 100% 带 type。
  let totalClauses = 0;
  let missingType = 0;
  for (const t of contract.DERIVABLE) {
    const d = contract.deriveContract({ type: t, value: 'v', target: { semantic: 's', url: 'https://a.com/x' } });
    if (!d) continue;
    for (const c of (d.requiredEvidence || [])) { totalClauses++; if (!c || !c.type) missingType++; }
  }
  ok(totalClauses > 0 && missingType === 0,
    'D1 不可达登记：DERIVABLE 派生契约的 requiredEvidence 全部带 type（normalizeContract 的 filter 对其无实际作用）'
    + ' ⇒ 收口不引入放宽',
    'total=' + totalClauses + ' missingType=' + missingType);

  // D2：派生契约的 allowedAlternatives 恒为空 ⇒ `evaluateContract` 的**递归 OR 兜底**
  //     对诊断层是**新增能力**但**不可达**（step 3 只在 required 失败后触发，且 alternatives 为空）。
  let altTotal = 0;
  for (const t of contract.DERIVABLE) {
    const d = contract.deriveContract({ type: t, value: 'v', target: { semantic: 's', url: 'https://a.com/x' } });
    if (d && Array.isArray(d.allowedAlternatives)) altTotal += d.allowedAlternatives.length;
  }
  ok(altTotal === 0,
    'D2 新增能力登记：派生契约的 allowedAlternatives 恒为 0 ⇒ 递归 OR 兜底在诊断层不可达（诚实声明：非等价，但对派生契约无效果）',
    'altTotal=' + altTotal);

  // D3：**使用面 ⊆ 定义面** —— ACTION_TO_STATE 用到的子句类型必须全部落在
  //     VIL `clausePresent` 的 case 集合内（否则收口后 required 侧会结构性恒假）。
  //     ★ 与 C125 的 D1/D2「定义面差集 = 登记表」互补：C125 管**有没有实现**，
  //       本条管**生产契约用不用得到那个缺口**。C125 已把 `action_success` 登记为有意缺口。
  const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');
  const vilSwitch = (VIL_SRC.match(/switch \(cl\.type\) \{[\s\S]*?\n  \}/) || [''])[0];
  const vilCases = new Set((vilSwitch.match(/case '([a-z_]+)'/g) || []).map((s) => s.replace(/case '|'/g, '')));
  const usedTypes = new Set();
  for (const t of contract.DERIVABLE) {
    const d = contract.deriveContract({ type: t, value: 'v', target: { semantic: 's', url: 'https://a.com/x' } });
    for (const c of ((d && d.requiredEvidence) || [])) if (c && c.type) usedTypes.add(c.type);
    for (const c of ((d && d.forbiddenEvidence) || [])) if (c && c.type) usedTypes.add(c.type);
  }
  const uncovered = [...usedTypes].filter((t) => !vilCases.has(t));
  ok(usedTypes.size > 0 && vilCases.size > 0 && uncovered.length === 0,
    'D3 使用面 ⊆ 定义面：派生契约用到的子句类型全部落在 VIL clausePresent 的 case 集合内',
    JSON.stringify({ used: [...usedTypes].sort(), uncovered }));
  ok(!usedTypes.has('action_success'),
    'D3b 缺口不在使用面：`action_success` 不被任何派生契约使用 ⇒ C125 登记的有意缺口不落主链路',
    JSON.stringify([...usedTypes]));

  // D4：畸形契约（空 / 全无 type 的 requiredEvidence）下**两层同答** ——
  //     evaluateContract 与 VIL 都判「已达成」。而 A 面同判 true ⇒ **VIL 生产不会被调用**
  //     ⇒ 该放宽路径生产不可达。（写成断言：若将来 A 面变成 false，本条即红，须重新定级。）
  const malformed = [
    { label: 'requiredEvidence=[]', c: { stateType: 'GENERIC_STATE', requiredEvidence: [], evidenceLogic: 'AND', forbiddenEvidence: [] } },
    { label: 'required=[无type项]', c: { stateType: 'GENERIC_STATE', requiredEvidence: [{ expect: 'x' }], evidenceLogic: 'AND', forbiddenEvidence: [] } },
  ];
  const mal = malformed.map((m) => {
    const o = obs('https://a.com/p', 'home');
    const a = contract.evaluateContract(m.c, o, o, verification.verify);
    const cc = vil.analyze({
      beforeObservation: o, afterObservation: o,
      expectedVerification: { businessState: m.c },
      actionResult: { success: true }, action: { type: 'click' },
    });
    return { label: m.label, aSuccess: a.success, cType: cc.failureType };
  });
  ok(mal.every((m) => m.aSuccess === true && m.cType === 'VERIFICATION_TOO_STRICT'),
    'D4 放宽路径不可达：畸形契约下裁决面亦判 success=true ⇒ 诊断面同答「已达成」'
    + ' ⇒ 该输入到达不了 VIL（VIL 只在裁决面失败后运行）',
    JSON.stringify(mal));
}

// ── E 组：三向自检 + 可达性 + 全库扫描 ─────────────────────────────────────
console.log('\n── E 组：三向自检 / 可达性 / 全库调用点扫描 ──');
{
  const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');
  const CONTRACT_SRC = read('server/agent/verification/contract.js');

  // E1：唯一实现仍在（本批依赖它）
  ok(/function evaluateContract\(contract, after, before, clauseVerify\)/.test(CONTRACT_SRC),
    'E1 唯一实现登记：contract.evaluateContract(contract, after, before, clauseVerify) 存在');

  // E2：forbidden 通道仍在 A 面**第一位**（防有人把 forbidden 挪到 required 之后 —— 语义反转）
  const bodyEc = (CONTRACT_SRC.match(/function evaluateContract\([\s\S]*?\n\}/) || [''])[0];
  const iFb = bodyEc.indexOf('forbiddenEvidence');
  const iReq = bodyEc.indexOf('const clauses = c.requiredEvidence');
  ok(iFb > -1 && iReq > -1 && iFb < iReq,
    'E2 forbidden 优先：evaluateContract 体内 forbidden 通道在 requiredEvidence 之前（第 1 步语义）',
    JSON.stringify({ iFb, iReq }));

  // E3：可达性（端到端，真实入口）——必须**真的**到达 4b 并产出 decision
  const reach = vil.analyze({
    beforeObservation: obs('https://a.com/p', 'hello'),
    afterObservation: obs('https://a.com/p', 'hello'),
    expectedVerification: { businessState: { stateType: 'GENERIC_STATE', requiredEvidence: [{ type: 'text_present', expect: 'hello' }], forbiddenEvidence: [], evidenceLogic: 'AND' } },
    actionResult: { success: true }, action: { type: 'click' },
  });
  ok(reach.decision !== undefined && reach.evidence.length > 0,
    'E3 可达性：真实入口确实穿过 1/2/3/4a 到达 4b 并产出 decision',
    JSON.stringify({ decision: reach.decision, failureType: reach.failureType }));

  // E4：全库扫描（L16：新守护同样是被扫面）——
  //     `server/agent/**` 内**代码级**契约组合 idiom `evidenceLogic === 'OR'` 只允许出现在
  //     contract.js（唯一实现）。★ 扫描面**有意排除** `server/scripts/**`：
  //     本守护自身必须写出改前形态的字面量才能做反向探针，把它算进来只会得到
  //     「守护扫自己」的假红（L11）。也排除 `server/data/**`（§4 禁扫）。
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'data' || e.name === 'node_modules') continue;
        walk(p);
      } else if (e.name.endsWith('.js')) {
        const src = stripComments(fs.readFileSync(p, 'utf8'));
        if (/evidenceLogic\s*===\s*'OR'/.test(src)) hits.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    }
  })(path.join(ROOT, 'server', 'agent'));
  ok(hits.length === 1 && hits[0] === 'server/agent/verification/contract.js',
    'E4 全库扫描：`evidenceLogic === \'OR\'` 组合 idiom 在 server/agent 下**仅**出现在 contract.js（实现面唯一）',
    JSON.stringify(hits));

  // E4b 反真空：确认扫描面非空（否则 E4 会因「没扫到任何文件」而真空绿）
  let scanned = 0;
  (function count(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'data' && e.name !== 'node_modules') count(p); }
      else if (e.name.endsWith('.js')) scanned++;
    }
  })(path.join(ROOT, 'server', 'agent'));
  ok(scanned > 20,
    'E4b 反真空：E4 的扫描面确有文件（否则「仅命中 1 处」毫无意义）',
    'scanned=' + scanned);

  // E5：VIL 全文（去注释）不得再出现改前的组合形状（`clauses.length` 比较组合）
  const combineLeft = (VIL_SRC.match(/matched === clauses\.length/g) || []).length;
  ok(combineLeft === 0,
    'E5 无残留组合：VIL 全文（去注释）不含 `matched === clauses.length` 形式的手写组合',
    'count=' + combineLeft);

  // E6：调用点扫描 —— businessStatePresent 只允许被 4b 与 expectedActuallyPresent 调用。
  //     新增消费方若绕过 evaluateContract，本断言即红。
  const callSites = (VIL_SRC.match(/businessStatePresent\(/g) || []).length;
  ok(callSites === 3,
    'E6 调用点登记：businessStatePresent 全文件出现 3 次（定义 1 + 调用 2：4b / expectedActuallyPresent 的不可达分支）',
    'count=' + callSites);
}

console.log('\n=== C133 结果：' + pass + ' / ' + (pass + fail) + ' ===');
if (fail > 0) process.exitCode = 1;
