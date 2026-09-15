'use strict';

// =============================================================================
// C132 守护：4b `targetPresent` **两支**的口径对账（`expectedActuallyPresent` 的 P2 缺失）。
//
// ── 与 C131 的关系（C131 只修了同一变量的**一支**）──────────────────────────
// `verificationIntelligence.js` 的 4b 是**一个变量、两条分支**：
//     const targetPresent = effV.businessState
//       ? businessStatePresent(effV.businessState, after, before)   // ← P1：C131 已含 P2
//       : expectedActuallyPresent(effV, after);                     // ← P2：C132 前**无 before**
// 两条分支进的是同一条 `if (targetPresent)`、同一个 `VERIFICATION_TOO_STRICT` 返回。
//
// 走哪一支**只由「planner 是否给出 verification」这一个无关差异**决定
// （`buildEffectiveVerification` step 3：`if (hasRealPlannerVerif) return v;` ⇒ 裸 v，无 businessState）：
//     navigate + planner 给 {type:'url_contains'}  ⇒ 裸 v            ⇒ P2 支
//     navigate + planner 不给                      ⇒ {businessState} ⇒ P1 支
// 而 `isKeyBusiness('navigate') === false`、`navigate ∈ DERIVABLE` ⇒ **两条都真实可达**。
//
// ── 危害（实测，c132_reach.log）──────────────────────────────────────────────
// 场景 before.url = after.url = targetUrl（进入目标页但**无真实跳转**）：
//     P1 → STATE_UNKNOWN / RECHECK_OBSERVATION（诚实：「证据不足」）
//     P2 → VERIFICATION_TOO_STRICT / RETRY_VERIFY（**把真实失败说成「其实已达成」**）
// ⇒ 同一逻辑场景、同一变量、两种形状给**相反诊断**（成功率虚高方向）。
//
// ── 修法（方向 = 收紧，与 C131 同口径）──────────────────────────────────────
// `expectedActuallyPresent` 补 `beforeObservation` 形参，url_contains 分支**委托**
// `clause.evalUrlContains`（唯一实现，含 P2）；4b 调用点传 `before`。
//
// ── 组说明 ──────────────────────────────────────────────────────────────────
// A 组 = **真实入口**行为矩阵：两支同答（改前 P1/P2 相反）
// B 组 = **反向探针**：不得靠"放宽"（永远不报 TOO_STRICT）、也不得靠"降级"取一致
// C 组 = **静态委托**（C127 教训：宽窄类 no-op 不红「同答」⇒ 须有静态证据）+ L17 双向咬
// D 组 = 登记面（有意分离/未动的东西，无声改变即红）
// E 组 = 三向自检 + 生产可达性 + **全库调用点扫描**（L16：新守护同样是被扫面）
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// 本守护 require 了 VIL / 裁决面（间接引入 store / lifecycle）——
// 数据根指到仓库内临时目录，避免污染 server/data（C116 数据根纪律）。
if (!process.env.FPB_DATA_DIR) {
  process.env.FPB_DATA_DIR = path.join(ROOT, '.benchmark', 'c132_guard_tmp');
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

// ── 统一夹具 ────────────────────────────────────────────────────────────────
// ⚠️ 形状必须能穿过 _analyze 的 1/2/3/4a 短路抵达 4b（C131 §3 陷阱 2）：
//    actionResult 字段是 **success**（不是 ok）；观测字段是 loadingState / networkState；
//    previousObservationDiff 必须显式给，否则 4a domChanged 短路。
const TEXT = 'checkout page';
function obs(url) {
  return {
    url,
    textSummary: TEXT,
    visibleText: TEXT,
    elements: [],
    previousObservationDiff: {},
    loadingState: 'complete',
    networkState: 'idle',
  };
}

// P1 支：业务态契约形态（deriveContract 产出）⇒ businessStatePresent → clausePresent
function analyzeBusinessState(expect, beforeUrl, afterUrl) {
  const derived = contract.deriveContract({ type: 'navigate', target: { url: expect } });
  const bs = { requiredEvidence: derived.requiredEvidence, evidenceLogic: derived.evidenceLogic };
  return vil.analyze({
    beforeObservation: { url: beforeUrl, textSummary: TEXT },
    afterObservation: obs(afterUrl),
    expectedVerification: { type: 'element_present', expect: '__none__', businessState: bs },
    actionResult: { success: true },
    action: { type: 'navigate' },
  });
}

// P2 支：裸 verification 形态（**与 buildEffectiveVerification 的真实产出逐字一致**，见 A2）
function analyzeBare(expect, beforeUrl, afterUrl) {
  return vil.analyze({
    beforeObservation: { url: beforeUrl, textSummary: TEXT },
    afterObservation: obs(afterUrl),
    expectedVerification: { type: 'url_contains', expect },
    actionResult: { success: true },
    action: { type: 'navigate' },
  });
}

console.log('=== C132 守护：4b targetPresent 两支口径对账（expectedActuallyPresent 的 P2）===\n');

// ── A 组：真实入口行为矩阵（两支同答）──────────────────────────────────────
console.log('── A 组：真实入口（buildEffectiveVerification → analyze）──');
{
  const TARGET = 'https://a.com/checkout';

  // A1：**生产形态可达性**——planner 给出 url_contains 时，effV 是**裸 v**（无 businessState）
  const effWith = verification.buildEffectiveVerification({
    action: { type: 'navigate', target: { url: TARGET }, verification: { type: 'url_contains', expect: TARGET } },
  });
  ok(effWith && !effWith.businessState && effWith.type === 'url_contains',
    'A1 生产形态：navigate + planner 给 verification ⇒ effV 为**裸 url_contains**（无 businessState）⇒ 必走 P2 支',
    JSON.stringify(effWith));

  // A2：planner 不给时 ⇒ businessState 形态 ⇒ 走 P1 支
  const effWithout = verification.buildEffectiveVerification({
    action: { type: 'navigate', target: { url: TARGET } },
  });
  ok(effWithout && effWithout.businessState && effWithout.businessState.stateType === 'NAVIGATED',
    'A2 生产形态：navigate + planner 不给 ⇒ effV 为 businessState(NAVIGATED) ⇒ 走 P1 支',
    JSON.stringify(effWithout && effWithout.businessState && effWithout.businessState.stateType));

  // A2b：P2 支的夹具与真实产出**逐字同形**（防"夹具按代码分支写"的假守护，L16）
  ok(JSON.stringify(effWith) === JSON.stringify({ type: 'url_contains', expect: TARGET }),
    'A2b 夹具同形：A3/A4 使用的裸 verification 夹具与 buildEffectiveVerification 产出逐字一致',
    JSON.stringify(effWith));

  // A3：★ 本批修复点 —— 同一场景（before=after=target，无真实跳转）两支必须同答
  const p1 = analyzeBusinessState(TARGET, TARGET, TARGET);
  const p2 = analyzeBare(TARGET, TARGET, TARGET);
  ok(p1.failureType === p2.failureType,
    'A3 ★ 两支同答：同一 before/after，businessState 支与裸 verification 支给出**相同 failureType**'
    + '（改前 P1=STATE_UNKNOWN vs P2=VERIFICATION_TOO_STRICT —— 相反诊断）',
    'P1=' + p1.failureType + ' P2=' + p2.failureType);

  // A4：且都**不得**是 VERIFICATION_TOO_STRICT（真实失败不得被说成「其实已达成」）
  ok(p1.failureType !== 'VERIFICATION_TOO_STRICT' && p2.failureType !== 'VERIFICATION_TOO_STRICT',
    'A4 ★ 两支都不报 VERIFICATION_TOO_STRICT（P2 生效：恒真证据不算「已达成」）',
    'P1=' + p1.failureType + ' P2=' + p2.failureType);

  // A5：与裁决面一致（A 面在两种形态下都判失败）
  const vBare = verification.verify({ type: 'url_contains', expect: TARGET }, obs(TARGET), obs(TARGET));
  ok(vBare.success === false,
    'A5 跨层同答：裁决面在同场景判 success=false（诊断面不再说「其实已达成」）',
    JSON.stringify({ success: vBare.success, invalidEvidence: vBare.invalidEvidence }));

  // A6：诊断面与**唯一实现**同答（口径唯一性的直接证据）
  const u = clause.evalUrlContains({ type: 'url_contains', expect: TARGET }, obs(TARGET), obs(TARGET));
  ok(u.ok === false && u.invalidEvidence === 'precondition_true',
    'A6 委托生效：clause.evalUrlContains 在该场景判 false/invalidEvidence=precondition_true',
    JSON.stringify(u));
}

// ── B 组：反向探针（不得靠「放宽」/「降级」取一致）──────────────────────────
console.log('\n── B 组：反向探针（一致性不得靠放宽或降级换来）──');
{
  // B1：★ 关键反向 —— 若 before **不含** expect（真实跳转），两支都必须报 TOO_STRICT。
  //     若有人把修复做成"永远不报 TOO_STRICT"（降级），此处必红。
  const E2 = 'https://a.com/done';
  const B_BEFORE = 'https://a.com/entry';
  const b1p1 = analyzeBusinessState(E2, B_BEFORE, E2);
  const b1p2 = analyzeBare(E2, B_BEFORE, E2);
  ok(b1p1.failureType === 'VERIFICATION_TOO_STRICT' && b1p2.failureType === 'VERIFICATION_TOO_STRICT',
    'B1 反向：before 不含 expect（真实跳转）⇒ 两支**仍报** VERIFICATION_TOO_STRICT（修复是收紧而非降级）',
    'P1=' + b1p1.failureType + ' P2=' + b1p2.failureType);

  // B2：P2 只在**表面（host+pathname）**判定 —— query 注入不得把真证据误判为恒真（C105 F3）
  const surf = clause.evalUrlContains(
    { type: 'url_contains', expect: 'u_token' },
    obs('https://a.com/ok?u_token=1'),
    obs('https://a.com/entry'),
  );
  ok(surf.ok === true && !surf.invalidEvidence,
    'B2 表面规则：expect 仅出现在 before 的 query ⇒ P2 **不**触发（host+pathname 表面判定）',
    JSON.stringify(surf));

  // B3：无 before（前置态/单快照调用）时不得触发 P2 —— 否则会把正常判定恒假
  const noBefore = clause.evalUrlContains({ type: 'url_contains', expect: 'checkout' }, obs('https://a.com/checkout'), null);
  ok(noBefore.ok === true,
    'B3 无 before 不触发 P2：缺少 before 观察时按裸命中判定（fail-open 仅限"无归因依据"）',
    JSON.stringify(noBefore));

  // B4：缺 expect ⇒ fail-closed（不得因修复而放宽）
  const noExpect = clause.evalUrlContains({ type: 'url_contains' }, obs('https://a.com/checkout'), obs('https://a.com/entry'));
  ok(noExpect.ok === false,
    'B4 fail-closed：缺 expect 判定为不成立（修复不得放宽此边界）',
    JSON.stringify(noExpect));
}

// ── C 组：静态委托 + L17 双向咬 ─────────────────────────────────────────────
console.log('\n── C 组：静态委托断言（L17：shape 与 revert 双向咬）──');
{
  const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');

  // C1：函数体作用域内已委托唯一实现（防"回到内联第二份实现"）
  const eapBody = (VIL_SRC.match(/function expectedActuallyPresent\([\s\S]*?\n\}/) || [''])[0];
  ok(/clause\.evalUrlContains\(/.test(eapBody),
    'C1 委托：expectedActuallyPresent 的 url_contains 判定调用 clause.evalUrlContains（唯一实现）');

  // C2：函数体内不得残留 url_contains 的**裸 includes 判定**
  ok(!/(?:url|String\(afterObservation\.url\))[\s\S]{0,40}?\.includes\(String\(expect\)\)/.test(eapBody),
    'C2 无第二份实现：expectedActuallyPresent 函数体内不得残留裸 `url.includes(String(expect))`');

  // C3：函数体内无大小写折叠（C130 成果不得回流）
  ok(!/toLowerCase\(/.test(eapBody),
    'C3 大小写：expectedActuallyPresent 函数体内无 toLowerCase（C130 收紧成果不得回流）');

  // C4：签名已收 beforeObservation
  ok(/function\s+expectedActuallyPresent\s*\(\s*expectedVerification\s*,\s*afterObservation\s*,\s*beforeObservation\s*\)/.test(VIL_SRC),
    'C4 签名：expectedActuallyPresent 三参（含 beforeObservation）');

  // C5：4b 调用点已传 before（防"改了签名忘改调用点"）
  ok(/expectedActuallyPresent\(expectedVerification, after, before\)/.test(VIL_SRC),
    'C5 调用点：4b 已把 before 传给 expectedActuallyPresent（两支同参）');

  // C6（L17 反向）：**不得**回到修复前的两参/裸 includes 形态
  const EAP_REVERT_SIG = /function\s+expectedActuallyPresent\s*\(\s*expectedVerification\s*,\s*afterObservation\s*\)/;
  const EAP_REVERT_CALL = /expectedActuallyPresent\(expectedVerification, after\)/;
  const EAP_REVERT_BODY = /if \(type === 'url_contains' && expect\) \{[\s\S]{0,200}?url\.includes\(String\(expect\)\)/;
  ok(!EAP_REVERT_SIG.test(VIL_SRC) && !EAP_REVERT_CALL.test(VIL_SRC) && !EAP_REVERT_BODY.test(VIL_SRC),
    'C6 回退探针：不得残留任何修复前形态（两参签名 / 两参调用 / 裸 includes 判定）',
    JSON.stringify({
      sig: EAP_REVERT_SIG.test(VIL_SRC), call: EAP_REVERT_CALL.test(VIL_SRC), body: EAP_REVERT_BODY.test(VIL_SRC),
    }));
}

// ── D 组：登记面（本批**未动**的东西，无声改变即红）──────────────────────────
console.log('\n── D 组：登记面（有意分离 / 本批未动）──');
{
  const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');
  const ROUTER_SRC = read('server/agent/skill/skillRouter.js');

  // D1：skillRouter 的 clauseVerdict **必须**保持无 before —— 前置态语义，不是因果归因。
  //     （与 C131 D1 同一条；本批未动，重复登记防"顺手统一"）
  ok(/function\s+clauseVerdict\s*\(\s*clause\s*,\s*obs\s*\)/.test(ROUTER_SRC)
    && !/clauseVerdict\s*\(\s*clause\s*,\s*obs\s*,\s*before/.test(ROUTER_SRC),
    'D1 登记：skillRouter.clauseVerdict(clause, obs) 保持两参（前置态语义，无因果归因）');

  // D2：`expectedActuallyPresent` 的 businessState 分支**结构性不可达**
  //     （唯一调用点 4b 的三元式已用 businessState 作判别；本函数未导出）。
  //     本批仍给它补齐 before 口径（零行为变更）—— 此处登记该事实，
  //     以防将来有人误以为它是一条活路径（L16：不为不存在的形状写代码）。
  ok(/if \(expectedVerification\.businessState\) \{[\s\S]{0,200}?businessStatePresent\(expectedVerification\.businessState, afterObservation, beforeObservation\)/.test(VIL_SRC),
    'D2 死分支登记：expectedActuallyPresent 内的 businessState 分支已统一传 beforeObservation'
    + '（结构上不可达；补口径以防未来调用方拿到"无 before"形态）');
  // D2b 反真空：把"不可达"的**判据本身**写成断言 —— 否则 D2 只是复述注释。
  //   判据 = ① 4b 的三元式以 businessState 作判别（故 else 支必然 businessState 为空）；
  //          ② expectedActuallyPresent **未出现在 module.exports** ⇒ 无外部调用方。
  const exportedText = VIL_SRC.slice(VIL_SRC.lastIndexOf('module.exports'));
  ok(/expectedVerification\.businessState[\s\S]{0,160}?expectedActuallyPresent\(/.test(VIL_SRC)
    && exportedText.length > 0
    && !/expectedActuallyPresent/.test(exportedText),
    'D2b 死分支判据自证：4b 三元式以 businessState 判别 + 本函数未导出 ⇒ 该分支恒不可达',
    JSON.stringify({ ternaryOk: /expectedVerification\.businessState[\s\S]{0,160}?expectedActuallyPresent\(/.test(VIL_SRC), exported: !!exportedText.length }));

  // D3：A 裁决面在两种 effV 形态下的 `invalidEvidence` **差异**（本批未动，登记）
  //     businessState 契约失败时 A 面不报 invalidEvidence；裸 verification 时报 precondition_true。
  //     结论一致（都 false），归因不一致 ⇒ 登记为待定级项，不在本批扩大战线。
  const vBare = verification.verify({ type: 'url_contains', expect: 'https://a.com/checkout' }, obs('https://a.com/checkout'), obs('https://a.com/checkout'));
  ok(vBare.invalidEvidence === 'precondition_true',
    'D3 登记：A 面裸 verification 形态下 invalidEvidence=precondition_true（businessState 形态下为空 —— 归因差异已登记，本批未动）');
}

// ── E 组：三向自检 + 可达性 + 全库扫描 ──────────────────────────────────────
console.log('\n── E 组：三向自检 / 可达性 / 全库调用点扫描 ──');
{
  const VIL_SRC = read('server/agent/verification/verificationIntelligence.js');
  const CLAUSE_SRC = read('server/agent/verification/clause.js');

  // E1：唯一实现仍在（本批依赖它）
  ok(/function evalUrlContains\(cl, after, before\)/.test(CLAUSE_SRC),
    'E1 唯一实现登记：clause.evalUrlContains(cl, after, before) 存在');

  // E2：VIL 中 url_contains 的**判定**必须都走委托（仅允许 detectAsyncPending 的关键词扫描）
  const bareJudgements = (VIL_SRC.match(/url\.includes\(String\(/g) || []).length;
  ok(bareJudgements === 0,
    'E2 无残留裸判定：VIL 全文不得有 `url.includes(String(` 形式的 url_contains 判定',
    'count=' + bareJudgements);

  // E3：可达性（端到端，真实入口）——必须**真的**走到 expectedActuallyPresent 且触发过 4b
  const E3T = 'https://a.com/checkout';
  const viaBare = analyzeBare(E3T, E3T, E3T);
  ok(viaBare.evidence.length > 0 && viaBare.decision !== undefined,
    'E3 可达性：裸 verification 形态确实穿过 1/2/3/4a 到达 4b 并产出 decision',
    JSON.stringify({ decision: viaBare.decision, failureType: viaBare.failureType }));

  // E4 三向自检 —— 收紧 1 处（唯一行为变更：P2 在 P2 支生效）
  ok(viaBare.failureType !== 'VERIFICATION_TOO_STRICT',
    'E4a 收紧 1 处：P2 支不再报 VERIFICATION_TOO_STRICT（本批唯一行为变更）');

  // E5：全库调用点扫描（L16：新守护同样是被扫面）——
  //     除 clause.js 外，**生产模块**不得再有内联 url_contains 裸 includes 判定。
  //     ★ 扫描面 = `server/agent/**`（生产实现）。**有意排除** `server/scripts/**`：
  //       守护测试自身必须写出"缺陷形状"的字面量才能做反向探针（本文件即含该字面量），
  //       把它算进来只会得到"守护扫自己"的假红（L11：新守护同样是被扫面）。
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'data' || e.name === 'node_modules') continue;   // 禁扫 server/data（§4）
        walk(p);
      } else if (e.name.endsWith('.js')) {
        const src = stripComments(fs.readFileSync(p, 'utf8'));
        if (/url\.includes\(String\(/.test(src)) hits.push(path.relative(ROOT, p));
      }
    }
  })(path.join(ROOT, 'server', 'agent'));
  ok(hits.length === 0,
    'E5 全库扫描：server/agent 下无任何内联 `url.includes(String(` 的 url_contains 判定（实现面唯一）',
    JSON.stringify(hits));

  // E5b 反真空：确认扫描面非空（否则 E5 会因"没扫到任何文件"而真空绿）
  let scanned = 0;
  (function count(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'data' && e.name !== 'node_modules') count(p); }
      else if (e.name.endsWith('.js')) scanned++;
    }
  })(path.join(ROOT, 'server', 'agent'));
  ok(scanned > 20,
    'E5b 反真空：E5 的扫描面确有文件（否则"0 命中"毫无意义）',
    'scanned=' + scanned);

  // E6 反真空：以上三条"不得"类断言必须建立在**确有被扫面**之上
  const hasEap = /function expectedActuallyPresent\(/.test(VIL_SRC);
  const hasDelegate = /clause\.evalUrlContains\(/.test(CLAUSE_SRC + VIL_SRC);
  ok(hasEap && hasDelegate,
    'E6 反真空：被扫面存在（expectedActuallyPresent 定义 + evalUrlContains 委托均在位）',
    JSON.stringify({ hasEap, hasDelegate }));
}

console.log('\n=== C132 结果：' + pass + ' / ' + (pass + fail) + ' ===');
if (fail > 0) process.exitCode = 1;
