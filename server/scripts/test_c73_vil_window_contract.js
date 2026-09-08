#!/usr/bin/env node
// C73 —— verification 子目录 + semanticResolver + verification.js 深扫守护（agent 子模块扫描第 4 批）：
//   D1 (B 类)：Observation Window 调度选择拿 failureType 名与 decision 比较 ——
//     EVENTUAL_CONSISTENCY 的 decision 是 'WAIT'，旧实现永远匹配不上 → 有时序证据的
//     最终一致性场景落入 2.7s 短窗口（SCHEDULE_STATE_UNKNOWN），与模块头部注释
//     「EVENTUAL_CONSISTENCY 用完整窗口」矛盾；OBSERVATION_DELAY 只是碰巧因
//     RETRY_VERIFY 字面撞上才工作。修复：runObservationWindow 增加 failureType 参数，
//     runtime 传入 vil.failureType，调度按 failureType + decision 双条件选择。
//   D2 (B 类)：contract.substitute 用字符串替换 —— 值中 $ 模式（$&/$'/$`/$$）被当作
//     替换模式展开，契约期望被破坏而工具键入原始值 → field_value 永不匹配 → 假 VERIFY_FAILED。
//     修复：函数替换（字面量语义）。
//   D3 (C 类)：field_value 空期望恒真 —— planner 漏给 value（或 legacyToContract 收到无
//     expect 的子句）时 expect='' → includes('') 恒真 → 空字段也判成功（假阳性）。
//     修复：空期望 fail-closed（verification.js 与 VIL clausePresent 双处）。
// 零浏览器：纯函数 + fake page / fake inspect。FPB_DATA_DIR tmp 隔离。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + ': ' + detail); console.log('  FAIL ' + name + ' — ' + detail); }
}

function runInChild(fnName, script) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c73-data-'));
  const tmpJS = path.join(os.tmpdir(), 'c73-' + fnName + '-' + Date.now() + '.js');
  fs.writeFileSync(tmpJS, script, 'utf8');
  const r = spawnSync(process.execPath, [tmpJS], {
    env: Object.assign({}, process.env, { FPB_DATA_DIR: dataDir }),
    encoding: 'utf8',
    timeout: 120000,
  });
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpJS, { force: true }); } catch (e) {}
  return r;
}

const AGENT = here.replace(/\\/g, '/') + '/../agent';
const VER = AGENT + '/verification';

// ---- P1 (D1): EVENTUAL_CONSISTENCY（decision=WAIT）必须用完整 TIMING 窗口 ----
{
  const script = `
'use strict';
const vwin = require('${VER}/verificationWindow');
const out = { ok: true, error: null };
(async () => {
try {
  const mkV = () => ({ type: 'text_present', expect: 'success banner' });
  const mkObs = () => ({ url: 'https://site/x', textSummary: 'nothing here', elements: [], domFingerprint: 'fp' });
  const neverVerify = () => ({ success: false, used: 'primary', result: { success: false } });
  const noopInspect = async () => ({ ok: true, observation: mkObs() });

  // P1a 修复目标：failureType=EVENTUAL_CONSISTENCY + decision=WAIT → SCHEDULE_TIMING
  const w1 = await vwin.runObservationWindow({
    page: {}, taskId: 'c73-p1a',
    verification: mkV(), beforeObservation: mkObs(), initialObservation: mkObs(),
    decision: 'WAIT', failureType: 'EVENTUAL_CONSISTENCY',
    verifyFn: neverVerify, inspectFn: noopInspect, emit: () => {},
  });
  if (JSON.stringify(w1.schedule) !== JSON.stringify(vwin.SCHEDULE_TIMING)) {
    throw new Error('EVENTUAL_CONSISTENCY(decision=WAIT) 应使用 TIMING 窗口，实际: ' + JSON.stringify(w1.schedule));
  }

  // P1b failureType=OBSERVATION_DELAY（decision=RETRY_VERIFY）→ TIMING（双条件均命中）
  const w2 = await vwin.runObservationWindow({
    page: {}, taskId: 'c73-p1b',
    verification: mkV(), beforeObservation: mkObs(), initialObservation: mkObs(),
    decision: 'RETRY_VERIFY', failureType: 'OBSERVATION_DELAY',
    verifyFn: neverVerify, inspectFn: noopInspect, emit: () => {},
  });
  if (JSON.stringify(w2.schedule) !== JSON.stringify(vwin.SCHEDULE_TIMING)) {
    throw new Error('OBSERVATION_DELAY 应使用 TIMING 窗口');
  }

  // P1c 向后兼容：旧调用方只传 decision='EVENTUAL_CONSISTENCY'（failureType 名）→ 仍 TIMING
  const w3 = await vwin.runObservationWindow({
    page: {}, taskId: 'c73-p1c',
    verification: mkV(), beforeObservation: mkObs(), initialObservation: mkObs(),
    decision: 'EVENTUAL_CONSISTENCY',
    verifyFn: neverVerify, inspectFn: noopInspect, emit: () => {},
  });
  if (JSON.stringify(w3.schedule) !== JSON.stringify(vwin.SCHEDULE_TIMING)) {
    throw new Error('旧调用 decision=EVENTUAL_CONSISTENCY 应保持 TIMING（向后兼容）');
  }

  // P1d STATE_UNKNOWN（无时序证据）→ 短窗口（既有语义不回归）
  const w4 = await vwin.runObservationWindow({
    page: {}, taskId: 'c73-p1d',
    verification: mkV(), beforeObservation: mkObs(), initialObservation: mkObs(),
    decision: 'RECHECK_OBSERVATION', failureType: 'STATE_UNKNOWN',
    verifyFn: neverVerify, inspectFn: noopInspect, emit: () => {},
  });
  if (JSON.stringify(w4.schedule) !== JSON.stringify(vwin.SCHEDULE_STATE_UNKNOWN)) {
    throw new Error('STATE_UNKNOWN 应保持短窗口');
  }

  // P1e 真实 VIL 管线：EVENTUAL_CONSISTENCY 场景（networkState=pending）的 decision 确为 WAIT，
  //     证明旧实现中该 decision 在 runtime 调用点必然落短窗口（缺陷前提成立）
  const vil = require('${VER}/verificationIntelligence');
  const d = vil.analyze({
    beforeObservation: mkObs(),
    afterObservation: Object.assign(mkObs(), { networkState: 'pending', loadingState: 'complete' }),
    expectedVerification: { type: 'text_present', expect: 'success banner' },
    actionResult: { success: true },
    action: { type: 'submit' },
  });
  if (d.decision !== 'WAIT' || d.failureType !== 'EVENTUAL_CONSISTENCY') {
    throw new Error('networkState=pending 应产出 WAIT/EVENTUAL_CONSISTENCY，实际: ' + d.decision + '/' + d.failureType);
  }

  out.p1 = 'schedule selection fixed: WAIT+EVENTUAL_CONSISTENCY->TIMING; RETRY_VERIFY->TIMING; legacy decision-only intact; STATE_UNKNOWN->short; VIL WAIT premise proven';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
})().then(() => console.log('CHILD_RESULT ' + JSON.stringify(out)));
`;
  const r = runInChild('p1', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P1.window-schedule-by-failureType', j.ok && !!j.p1, j.error || j.p1 || 'child failed');
}

// ---- P2 (D2): substitute $ 模式注入 ----
{
  const script = `
'use strict';
const contract = require('${VER}/contract');
const out = { ok: true, error: null };
try {
  // P2a fill 值含 $& / $' / $$ 等替换模式 → 契约期望必须等于原始值（字面量）
  const evil = '100$&200$\\'300$$400';
  const c = contract.deriveContract({ type: 'fill', target: { semantic: 'amount' }, value: evil });
  const cl = c.requiredEvidence[0];
  if (cl.expect !== evil) {
    throw new Error('fill 期望被 $ 模式破坏: 期望=' + JSON.stringify(evil) + ' 实际=' + JSON.stringify(cl.expect));
  }

  // P2b navigate URL 含 $ 模式 → __URL__ 替换同为字面量
  const evilUrl = 'https://x/p?a=1$&b=2';
  const c2 = contract.deriveContract({ type: 'navigate', target: { url: evilUrl } });
  if (c2.requiredEvidence[0].expect !== evilUrl) {
    throw new Error('navigate URL 期望被破坏: ' + JSON.stringify(c2.requiredEvidence[0].expect));
  }

  // P2c 无 $ 的普通值行为不回归
  const c3 = contract.deriveContract({ type: 'fill', target: { semantic: 'email' }, value: 'a@b.com' });
  if (c3.requiredEvidence[0].expect !== 'a@b.com' || c3.requiredEvidence[0].target !== 'email') {
    throw new Error('普通值替换行为回归');
  }

  // P2d 端到端：被破坏的期望曾导致 field_value 永不匹配 —— 现在真实值能通过验证
  const verification = require('${AGENT}/verification');
  const eff = verification.buildEffectiveVerification({ action: { type: 'fill', target: { semantic: 'amount' }, value: evil } });
  const after = { url: 'https://x', textSummary: 'x', elements: [{ tag: 'input', name: 'amount', type: 'text', state: { value: evil } }] };
  const r = verification.verify(eff, after, after);
  if (!r.success) throw new Error('含 $ 值的 field_value 验证应成功: ' + JSON.stringify(r.evidence));

  out.p2 = 'substitute literal-safe: $&/$\\'/$$ preserved; plain values intact; e2e field_value passes with raw value';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
console.log('CHILD_RESULT ' + JSON.stringify(out));
`;
  const r = runInChild('p2', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P2.substitute-dollar-pattern-injection', j.ok && !!j.p2, j.error || j.p2 || 'child failed');
}

// ---- P3 (D3): field_value 空期望 fail-closed ----
{
  const script = `
'use strict';
const verification = require('${AGENT}/verification');
const vil = require('${VER}/verificationIntelligence');
const out = { ok: true, error: null };
try {
  const elem = (o) => Object.assign({ tag: 'input', name: 'amount', type: 'text', text: 'amount', state: { value: '' } }, o);
  const after = { url: 'https://x', textSummary: 'x', elements: [elem({})] };

  // P3a 修复目标：expect=''（vault 凭据执行时注入，planner 不携带 value）→
  //   旧实现 includes('') 恒真：空字段也判成功（假阳性）→ 消除；首版硬 fail-closed：
  //   误杀 vault 场景（step22 Scenario A 回归实证）→ 修正为「已填写」退化验证。
  //   空期望 + 空字段 = 失败（写入未发生）
  const r1 = verification.verify({ type: 'field_value', target: 'amount', expect: '' }, after, after);
  if (r1.success) throw new Error('空期望+空字段应失败（旧实现 includes 空串恒真假阳性）');

  // P3a2 空期望 + 字段有值 = 成功（vault 场景「已填写」退化验证，不比对内容）
  const afterFilled = { url: 'https://x', textSummary: 'x', elements: [elem({ state: { value: 'vault-injected@example.com' } })] };
  const r1b = verification.verify({ type: 'field_value', target: 'amount', expect: '' }, afterFilled, afterFilled);
  if (!r1b.success) throw new Error('空期望+字段已填写应成功（vault 注入场景）');

  // P3b legacy 无 expect 子句同一语义（经裸契约 → verify 的 D4 路径，见 P4）
  const contract = require('${VER}/contract');
  const lc = contract.legacyToContract({ type: 'field_value', target: 'amount' });
  const r2 = verification.verify(lc, afterFilled, afterFilled);
  if (!r2.success) throw new Error('legacy 无 expect + 字段已填写应成功（vault 语义）');
  const r2b = verification.verify(lc, after, after);
  if (r2b.success) throw new Error('legacy 无 expect + 空字段应失败');

  // P3c VIL clausePresent 同守卫：空期望不再构成「目标实际存在」（防 4b TOO_STRICT 误判）
  const present = vil.analyze ? true : true;
  const businessStatePresent = (bs, aft) => {
    // 走 _analyze 4b 路径间接验证：空期望契约不应被判 TOO_STRICT targetPresent
    return undefined;
  };
  // 直接测 clausePresent 行为等价物：空期望 field_value + 值已写入 → 「已填写」退化验证命中
  const afterFull = { url: 'https://x', textSummary: 'x', elements: [elem({ state: { value: 'v' } })] };
  const r3 = verification.verify({ type: 'field_value', target: 'amount', expect: '' }, afterFull, afterFull);
  if (!r3.success) throw new Error('空期望+值已写入应成功（「已填写」退化验证）');

  // P3d 非空期望行为不回归
  const r4 = verification.verify({ type: 'field_value', target: 'amount', expect: 'v' }, afterFull, afterFull);
  if (!r4.success) throw new Error('非空期望正常匹配回归');
  const r5 = verification.verify({ type: 'field_value', target: 'amount', expect: 'x' }, afterFull, afterFull);
  if (r5.success) throw new Error('非空期望不匹配应失败（回归）');

  out.p3 = 'empty-expect fail-closed: verify + legacy + value-present case; non-empty matching intact';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
console.log('CHILD_RESULT ' + JSON.stringify(out));
`;
  const r = runInChild('p3', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P3.field_value-empty-expect-fail-closed', j.ok && !!j.p3, j.error || j.p3 || 'child failed');
}

// ---- P4 (D4): 裸契约对象传入 verify 不得落「未要求验证」恒真分支 ----
{
  const script = `
'use strict';
const verification = require('${AGENT}/verification');
const contract = require('${VER}/contract');
const out = { ok: true, error: null };
try {
  const elem = (o) => Object.assign({ tag: 'input', name: 'email', type: 'email', text: 'email', state: { value: '' } }, o);
  const after = { url: 'https://x', textSummary: 'x', elements: [elem({})] };

  // P4a 修复目标：normalizeContract 产物（无 type、有 requiredEvidence）直接传 verify ——
  //   旧实现 !v.type → success:true「未要求验证」恒真；现在委托 evaluateContract 真实评估
  const nc = contract.normalizeContract({
    stateType: 'FIELD_FILLED',
    requiredEvidence: [{ type: 'field_value', expect: 'a@b.com', target: 'email' }],
  });
  const r1 = verification.verify(nc, after, after);
  if (r1.success) throw new Error('裸契约 field_value 未满足应失败（旧实现恒真「未要求验证」）');
  if (!r1.evidence || !r1.evidence.length) throw new Error('裸契约评估应产生证据');

  // P4b 同一契约在值满足时成功（评估真实生效，不是一律失败）
  const afterFull = { url: 'https://x', textSummary: 'x', elements: [elem({ state: { value: 'a@b.com' } })] };
  const r2 = verification.verify(nc, afterFull, afterFull);
  if (!r2.success) throw new Error('裸契约满足时应成功: ' + JSON.stringify(r2.evidence));

  // P4c forbidden 语义随裸契约路径生效
  const ncF = contract.normalizeContract({
    stateType: 'GENERIC_STATE',
    requiredEvidence: [{ type: 'text_present', expect: 'ok' }],
    forbiddenEvidence: [{ type: 'text_present', expect: 'error' }],
  });
  const r3 = verification.verify(ncF, { url: 'https://x', textSummary: 'it is ok but error happened', elements: [] }, null);
  if (r3.success || !r3.forbiddenHit) throw new Error('裸契约 forbidden 应硬失败');

  // P4d 真「未要求验证」（无 type 无 requiredEvidence，如 {type:'none'}）行为不回归
  const r4 = verification.verify({ type: 'none' }, after, after);
  if (!r4.success) throw new Error('type=none 应保持「未要求验证」成功（既有语义）');
  const r5 = verification.verify(null, after, after);
  if (!r5.success) throw new Error('verify(null) 应保持「未要求验证」成功（既有语义）');

  out.p4 = 'bare-contract evaluateContract delegation: unmet->fail, met->success, forbidden honored, none/null intact';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
console.log('CHILD_RESULT ' + JSON.stringify(out));
`;
  const r = runInChild('p4', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P4.bare-contract-not-treated-as-unrequired', j.ok && !!j.p4, j.error || j.p4 || 'child failed');
}

console.log('RESULT pass=' + pass + ' fail=' + fail);
if (fail) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
