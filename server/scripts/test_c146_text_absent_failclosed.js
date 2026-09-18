'use strict';

// C146 守护：文本判定器在「子句缺参」时的方向必须 **fail-closed**（不可评估 ⇒ 不成立）。
//
// 守护对象：`clause.js` 里 `text_absent` 的缺 expect 分支。
// 改前（实测，真实调用，非手写模拟）：
//   `evalTextAbsent(page, '')` → `{ ok: true, confidence: 0.85, reason: '…无 expect（无条件成立）' }`
// 即 **畸形子句 = 无条件成立**。它同时是：
//   ① 该模块 6 个判定器里**唯一**的 fail-open（text_present / storage / url_contains /
//      url_pattern 的缺参分支全部 fail-closed）；
//   ② 与 `test_c126` 守护**自身声明的组名**（「E 组：fail-closed / 健壮性」）相反 ——
//      该组里紧邻的姊妹条目（text_present 同形状）期望「不成立」，本条却期望「成立」。
//
// 为什么「不加固」在 JS 上必然 fail-open：`''.includes('')` 恒为 true，
// 于是朴素实现两侧都恒真 —— C126 只给 `text_present` 加了 fail-closed 守卫，
// 它的姊妹 `text_absent`（同一文本源、同一归一化、相邻定义、同一批消费者）被漏掉（L6）。
//
// 危害**双向**，同一根因，来自同一份畸形子句（真实 `evaluateContract` 调用取证）：
//   ① 落在 requiredEvidence 槽 ⇒ 契约无条件满足（success=true / conf 0.85 / evidence 为空）
//      ⇒ 伪成功通道（与「不设伪成功」纪律冲突）；
//   ② 落在 forbiddenEvidence 槽 ⇒ `evaluateContract` 第 1 步「ANY match ⇒ hard fail」
//      无条件命中 ⇒ 真实成功被恒判失败（conf 0.95）。
//   同一份子句在两个槽位产生**相反极性**，两者都错 —— 根因都是「畸形 ⇒ 无条件」。
//
// 方向 = **收紧**（更不容易误判成功），与 C131 的 P2 同向；**不改 Success Definition**
// （良构计划零影响：真实语料 text_absent 子句总数 = 0，内部构造点全部带 expect）。
//
// 覆盖面按「内容形状」判定（不按函数名枚举）：断言本模块内**不存在任何**
// 「缺参 ⇒ ok:true」的守卫 —— 新增判定器自动被覆盖，不会出现覆盖面漂移。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const clause = require('../agent/verification/clause.js');
const verification = require('../agent/verification.js');
const actionSchema = require('../agent/schema/action.js');
const contract = require('../agent/verification/contract.js');
const vil = require('../agent/verification/verificationIntelligence.js');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
const j = (x) => { try { return JSON.stringify(x); } catch (e) { return String(x); } };

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CLAUSE_SRC = stripComments(fs.readFileSync(
  path.join(ROOT, 'server', 'agent', 'verification', 'clause.js'), 'utf8'));

function obs(o) {
  const opts = o || {};
  return {
    url: opts.url || 'https://example.test/app',
    loadingState: 'complete',
    networkState: 'idle',
    textSummary: opts.textSummary === undefined ? 'welcome back, logout' : opts.textSummary,
    visibleText: opts.visibleText === undefined ? (opts.textSummary === undefined ? 'welcome back, logout' : opts.textSummary) : opts.visibleText,
    roleText: opts.roleText || '',
    elements: opts.elements || [],
    contentLeaves: opts.contentLeaves || [],
    storage: opts.storage === undefined ? null : opts.storage,
  };
}
const page = obs({ textSummary: 'welcome back, logout' });
const MAL = { type: 'text_absent', expect: '' };

// ── A 组：缺参守卫的方向（内容形状，剥注释后判定）───────────────────────────
console.log('=== A 组：缺参守卫方向（静态形状，自动对账）===');
// 形状：一个「取反参数判断」后面紧跟返回 ok:true 的守卫。描述性表述，不在此处写锚形文本。
// 带 g 的用于 match/matchAll 计数；不带 g 的用于 test —— `.test()` 在 g 标志下有 lastIndex
// 残留（有状态 ⇒ 同一断言第二次调用结果不同），必须分开，避免判据自己变成不定式。
const FAIL_OPEN_COUNT = /if\s*\(\s*![\w.]+\s*\)\s*(?:\{\s*)?return\s*\{\s*ok:\s*true/gs;
const FAIL_OPEN_TEST = /if\s*\(\s*![\w.]+\s*\)\s*(?:\{\s*)?return\s*\{\s*ok:\s*true/;
const ANY_GUARD_COUNT = /if\s*\(\s*![\w.]+\s*\)\s*(?:\{\s*)?return\s*\{\s*ok:/gs;
const ANY_GUARD_TEST = /if\s*\(\s*![\w.]+\s*\)\s*(?:\{\s*)?return\s*\{\s*ok:/;
const openHits = CLAUSE_SRC.match(FAIL_OPEN_COUNT) || [];
const allGuards = CLAUSE_SRC.match(ANY_GUARD_COUNT) || [];
ok(openHits.length === 0,
  'A1 clause.js 内不存在「缺参 ⇒ ok:true」守卫（覆盖面按形状，非按函数名）',
  'hits=' + openHits.length + ' ' + j(openHits));
ok(allGuards.length >= 4,
  'A2 反真空：该模块确实存在缺参守卫（否则 A1 对空文件也通过）',
  'guards=' + allGuards.length);
{
  // A3 覆盖面自动对账：把每个缺参守卫的参数名与方向打出来，要求全部为 ok:false
  const dir = [...CLAUSE_SRC.matchAll(/if\s*\(\s*!([\w.]+)\s*\)\s*(?:\{\s*)?return\s*\{\s*ok:\s*(true|false)/g)]
    .map((m) => m[1] + '→' + m[2]);
  ok(dir.length >= 4 && dir.every((d) => d.endsWith('→false')),
    'A3 全部缺参守卫方向 = fail-closed（新增判定器自动纳入）', j(dir));
}

// ── B 组：真实调用 —— 引擎面缺参矩阵 + 良构语义保留（双向）──────────────────
console.log('\n=== B 组：真实 verify 调用的缺参矩阵与良构对照 ===');
const vv = (cl, after) => verification.verify(cl, after || page, null).success;
ok(vv({ type: 'text_absent' }) === false, 'B1 缺 expect（undefined）⇒ 不成立');
ok(vv({ type: 'text_absent', expect: '' }) === false, 'B2 expect 为空串 ⇒ 不成立');
ok(vv({ type: 'text_absent', expect: '   ' }) === false, 'B3 expect 仅空白（归一化后为空）⇒ 不成立');
ok(vv({ type: 'text_absent', expect: 'error' }) === true, 'B4 良构：页面无该文本 ⇒ 成立（既有语义保留）');
ok(vv({ type: 'text_absent', expect: 'welcome' }) === false, 'B5 良构：页面有该文本 ⇒ 不成立（既有语义保留）');
ok(clause.evalTextAbsent({}, 'x').ok === true,
  'B6 良构 + 空观察 ⇒ 成立（C127 E5 既有语义保留，本批不得改）');
ok(vv({ type: 'text_present', expect: '' }) === false, 'B7 姊妹 text_present 同形状 ⇒ 不成立（同口径对照）');
{
  const matrix = [
    ['text_present', { type: 'text_present' }, false],
    ['text_absent', { type: 'text_absent' }, false],
    ['storage', { type: 'storage', storageType: 'localStorage' }, false],
    ['url_contains', { type: 'url_contains' }, false],
    ['url_pattern', { type: 'url_pattern' }, false],
  ].map(([n, cl, want]) => n + '=' + (vv(cl) === want));
  ok(matrix.every((s) => s.endsWith('=true')), 'B8 五类必填参数全缺 ⇒ 全部 fail-closed', j(matrix));
}

// ── C 组：两个槽位的极性（真实 evaluateContract 调用）───────────────────────
console.log('\n=== C 组：requiredEvidence / forbiddenEvidence 两槽位的极性 ===');
{
  const asRequired = contract.evaluateContract(
    { stateType: 'GENERIC_STATE', requiredEvidence: [MAL], forbiddenEvidence: [], evidenceLogic: 'AND' },
    page, null, verification.verify);
  ok(asRequired.success === false,
    'C1 畸形子句在必填槽 ⇒ 契约不成立（改前无条件满足 success=true）',
    'success=' + asRequired.success + ' conf=' + asRequired.confidence + ' evidence=' + j(asRequired.evidence));

  const asForbidden = contract.evaluateContract(
    { stateType: 'GENERIC_STATE', requiredEvidence: [{ type: 'text_present', expect: 'welcome' }], forbiddenEvidence: [MAL], evidenceLogic: 'AND' },
    page, null, verification.verify);
  ok(asForbidden.success === true && !asForbidden.forbiddenHit,
    'C2 畸形子句在禁止槽 ⇒ 契约成立（改前被无条件 hard fail conf 0.95）',
    'success=' + asForbidden.success + ' hit=' + j(asForbidden.forbiddenHit));

  const realForbidden = contract.evaluateContract(
    { stateType: 'GENERIC_STATE', requiredEvidence: [{ type: 'text_present', expect: 'welcome' }], forbiddenEvidence: [{ type: 'text_present', expect: 'welcome' }], evidenceLogic: 'AND' },
    page, null, verification.verify);
  ok(realForbidden.success === false && !!realForbidden.forbiddenHit,
    'C3 防空：真正命中的 forbidden 仍须 hard fail（保障 C2 不是把禁止检查弄瘫）',
    'success=' + realForbidden.success + ' hit=' + j(realForbidden.forbiddenHit));

  const wellRequired = contract.evaluateContract(
    { stateType: 'GENERIC_STATE', requiredEvidence: [{ type: 'text_absent', expect: 'error' }], forbiddenEvidence: [], evidenceLogic: 'AND' },
    page, null, verification.verify);
  ok(wellRequired.success === true,
    'C4 防空：良构 text_absent 在必填槽仍能成立（收紧不得误伤良构）',
    'success=' + wellRequired.success);
}

// ── D 组：两消费层同答（引擎 vs 诊断层）─────────────────────────────────────
console.log('\n=== D 组：跨层同答（引擎 / 诊断层）===');
function diagnosticTooStrict(evidenceClause, after) {
  const r = vil.analyze({
    beforeObservation: obs({ textSummary: 'welcome back, logout' }),
    afterObservation: after || page,
    expectedVerification: {
      businessState: { stateType: 'T', requiredEvidence: [evidenceClause], evidenceLogic: 'AND', forbiddenEvidence: [] },
    },
    actionResult: { success: true },
    action: { type: 'click', risk: 'LOW', target: { semantic: 'continue' } },
  });
  // FAILURE_TYPES 是**对象映射**（不是数组）—— 直接 .includes 会抛 TypeError，
  // 而崩溃会把「其后所有组从未执行」伪装成「小面积红」（C145 已记的同族事故）。
  // 因此这里做双向兼容 + null 守卫，任何异常都退化成一次干净的 FAIL，不中断套件。
  let failureType = null;
  let isKnown = false;
  try {
    failureType = (r && r.failureType) || null;
    const ft = vil.FAILURE_TYPES;
    isKnown = Array.isArray(ft) ? ft.includes(failureType)
      : !!(ft && typeof ft === 'object' && Object.prototype.hasOwnProperty.call(ft, failureType));
    if (!ft) isKnown = failureType !== null;
  } catch (e) {
    isKnown = false;
  }
  return { tooStrict: failureType === 'VERIFICATION_TOO_STRICT', failureType, isKnown, ran: !!r };
}
{
  const d = diagnosticTooStrict(MAL);
  ok(vv(MAL) === false, 'D1 引擎：畸形子句 ⇒ 不成立');
  ok(d.tooStrict === false,
    'D2 诊断层：不再把畸形子句当作「业务其实已达成」（改前 TOO_STRICT ⇒ 建议 RETRY_VERIFY）',
    'failureType=' + d.failureType);
  ok(d.isKnown === true && d.ran === true,
    'D3 反真空：诊断层确实执行并给出确定 failureType（不是抛错/未定义）',
    'ran=' + d.ran + ' failureType=' + d.failureType + ' isKnown=' + d.isKnown);
}

// ── E 组：可达性 + 真实语料收紧面 ──────────────────────────────────────────
console.log('\n=== E 组：可达性与真实语料收紧面 ===');
ok(actionSchema.VERIFICATION_TYPES.includes('text_absent'),
  'E1 text_absent 在计划校验词表内 ⇒ 计划可达（判定器必须兜底）');
{
  let va = null;
  try {
    va = actionSchema.validateAction({
      type: 'click', risk: 'MEDIUM', target: { semantic: 'Continue' }, verification: { type: 'text_absent' },
    });
  } catch (e) { va = { ok: false, errors: ['THREW:' + e.message] }; }
  ok(!!va && va.ok === true,
    'E2 真实调用：缺 expect 的 text_absent 仍通过 action 校验（⇒ 畸形输入确实可达执行链）',
    'ok=' + (va && va.ok) + ' errors=' + j(va && va.errors));
  ok(typeof actionSchema.validateAction === 'function',
    'E3 反真空：被调用的校验入口在位');
}
{
  const ROOTS = [['server', 'data'], ['.step22-e2e']];
  const rec = { total: 0, withExpect: 0, emptyExpect: 0, missingExpect: 0, files: [] };
  function walk(dir, depth) {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!f.endsWith('.json') || st.size > 12 * 1024 * 1024) continue;
      let js; try { js = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
      let hit = 0;
      const dive = (x, d) => {
        if (!x || typeof x !== 'object' || d > 14) return;
        if (Array.isArray(x)) { x.forEach((y) => dive(y, d + 1)); return; }
        if (x.type === 'text_absent' && !Array.isArray(x.requiredEvidence)) {
          rec.total++; hit++;
          if (x.expect === undefined) rec.missingExpect++;
          else if (String(x.expect).trim() === '') rec.emptyExpect++;
          else rec.withExpect++;
        }
        Object.keys(x).forEach((k) => dive(x[k], d + 1));
      };
      dive(js, 0);
      if (hit) rec.files.push(path.relative(ROOT, p) + ':' + hit);
    }
  }
  ROOTS.forEach((r) => walk(path.join(ROOT, ...r), 0));
  ok(rec.emptyExpect === 0 && rec.missingExpect === 0,
    'E4 真实语料无「空/缺 expect」的 text_absent 子句（⇒ 本批收紧面对落盘数据为 0）', j(rec));
  ok(rec.total === rec.withExpect,
    'E5 真实语料若含 text_absent，必须全部带 expect（形状真实性）', j(rec));
}
{
  // 内部构造点：派生契约里出现的 text_absent 必须带 expect（收紧不得误伤内部产物）
  const rows = [];
  for (const c of [contract.deriveContract('login'), contract.deriveContract('search'), contract.deriveContract('submit')]) {
    for (const e of ((c && c.requiredEvidence) || [])) {
      if (e && e.type === 'text_absent') rows.push(e.expect === undefined ? 'MISSING' : String(e.expect));
    }
  }
  ok(rows.every((s) => s !== 'MISSING' && s.trim() !== ''),
    'E6 内部派生契约的 text_absent 子句全部带非空 expect', j(rows));
}

// ── F 组：判据分辨力（改前原文夹具自证，不是注释）───────────────────────────
console.log('\n── F 组：判据分辨力（防空）──');
{
  // 改前原文片段（逐字取自 C146 改动前的版本，用于证明形状判据有分辨力）
  const OLD_SNIPPET = "if (!e) return { ok: true, confidence: 0.85, reason: 'text_absent: 子句无 expect（无条件成立）' };";
  const R1 = FAIL_OPEN_TEST;
  ok(R1.test(OLD_SNIPPET) && !R1.test(CLAUSE_SRC),
    'F1 分辨力：形状判据命中改前原文、不命中现行');
  // F2 正向对照：同一扫描器对「确有其物」的良构守卫必须命中 —— 否则 F1 的「不命中」
  // 可能只是扫描器恒假（真空绿）。
  const WELL_FORMED_GUARD = "if (!e) return { ok: false, confidence: 0.7, reason: 'text_present: 子句缺少 expect' };";
  ok(ANY_GUARD_TEST.test(WELL_FORMED_GUARD) && ANY_GUARD_TEST.test(CLAUSE_SRC),
    'F2 正向对照：扫描器对良构失败守卫命中（改前原文与现行都命中）',
    'wellFormed=' + ANY_GUARD_TEST.test(WELL_FORMED_GUARD) + ' current=' + ANY_GUARD_TEST.test(CLAUSE_SRC));
  const NEG = 'C146_NEGATIVE_CONTROL_MUST_NOT_EXIST';
  ok(CLAUSE_SRC.indexOf(NEG) < 0, 'F3 负向对照：伪造锚点在源码中不存在（扫描器有分辨力）');
  ok(/function\s+evalTextAbsent\s*\(/.test(CLAUSE_SRC) && /pageText\(after\)\.includes\(e\)/.test(CLAUSE_SRC),
    'F4 反真空：被扫面（evalTextAbsent 与其良构判定）仍在位');
}

console.log('\n=== C146 守护结果：通过 ' + pass + ' / 失败 ' + fail + ' ===');
process.exit(fail ? 1 : 0);
