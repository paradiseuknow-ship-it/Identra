'use strict';
// Phase 11 — Historical Replay (STATIC, no API / no browser).
//
// Goal (§十四): re-evaluate Phase 9/10/10.9 failures under the NEW ExpectedBusinessState contract.
// We do NOT re-run the LLM. Instead we prove two things:
//   (A) COVERAGE — for every Phase 10.9 VERIFY_FAILED task, the new contract module can derive a
//       real OUTCOME contract (stateType + requiredEvidence + forbiddenEvidence) from the objective /
//       action. This shows the planner/runtime would now verify OUTCOME instead of a flaky check.
//   (B) BEHAVIOR — run the new contract against the 6 Phase-11 fixtures (real HTML) and confirm:
//       success pages PASS, failure pages with forbidden evidence HARD-FAIL, alternative states PASS.
//       This proves the contract catches/correctly rejects the historical failure archetypes WITHOUT
//       lowering the bar (forbidden evidence still blocks false success).

const fs = require('fs');
const contract = require('./server/agent/verification/contract');

const bench = JSON.parse(fs.readFileSync('.benchmark/phase10_1787763155065.json', 'utf8'));
const pt = bench.perTask;
const vf = pt.filter((r) => r.taxonomy === 'VERIFY_FAILED');

function verbToActionType(verb) {
  return ({ click: 'click', submit: 'submit', fill: 'fill', navigate: 'navigate', check: 'check', select: 'select', update: 'update' })[verb] || null;
}
function detectVerb(stepDesc) {
  if (/点击/.test(stepDesc)) return 'click';
  if (/提交/.test(stepDesc)) return 'submit';
  if (/输入|填入|填写/.test(stepDesc)) return 'fill';
  if (/打开|进入|导航/.test(stepDesc)) return 'navigate';
  if (/检查|确认|查看|定位|找到|提取|搜索结果|报表|列表|筛选/.test(stepDesc)) return 'check';
  if (/选择/.test(stepDesc)) return 'select';
  if (/修改|更新|改为|改|录入/.test(stepDesc)) return 'update';
  return 'other';
}

// ---------- (A) Coverage over the 58 VERIFY_FAILED ----------
let covered = 0, uncovered = 0;
const byStateType = {};
for (const r of vf) {
  const verb = detectVerb(r.error || r.objective || '');
  const at = verbToActionType(verb);
  const c = contract.contractFromObjective(r.objective || '', at ? { type: at } : {});
  if (c && c.stateType) { covered++; byStateType[c.stateType] = (byStateType[c.stateType] || 0) + 1; }
  else uncovered++;
}
console.log('=== (A) Outcome-contract coverage over ' + vf.length + ' VERIFY_FAILED ===');
console.log('  resolvable to real OUTCOME contract: ' + covered + '/' + vf.length + ' (' + Math.round(100 * covered / vf.length) + '%)');
console.log('  unresolved: ' + uncovered);
console.log('  by derived stateType: ' + JSON.stringify(byStateType));

// ---------- (B) Behavioral replay over fixtures ----------
function stripTags(html) { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function loadFixture(name) {
  const raw = fs.readFileSync('mock-site/phase11/' + name, 'utf8');
  return { text: stripTags(raw), url: 'http://127.0.0.1/mock/' + name };
}
function makeClauseVerify(after) {
  return (clause) => {
    const t = (after.text || '').toLowerCase();
    const type = clause.type, expect = clause.expect;
    if (type === 'text_present') {
      const ok = !!expect && t.includes(String(expect).toLowerCase());
      return { success: ok, confidence: ok ? 0.9 : 0.7, evidence: [ok ? 'text 含 "' + expect + '"' : 'text 不含 "' + expect + '"'] };
    }
    if (type === 'text_absent') {
      const ok = !expect || !t.includes(String(expect).toLowerCase());
      return { success: ok, confidence: ok ? 0.85 : 0.6, evidence: [ok ? 'text 未出现 "' + expect + '"' : 'text 出现 "' + expect + '"'] };
    }
    if (type === 'url_contains') {
      const ok = !!expect && after.url.includes(String(expect));
      return { success: ok, confidence: ok ? 0.95 : 0.8, evidence: ['url ' + (ok ? '含' : '不含') + ' "' + expect + '"'] };
    }
    return { success: false, confidence: 0.3, evidence: ['unsupported clause ' + type] };
  };
}

const cases = [
  { name: 'login-ok.html', actionType: 'login', contract: contract.deriveContract({ type: 'login' }), expectPass: true, note: '业务成功页应 PASS' },
  { name: 'login-fail.html', actionType: 'login', contract: contract.deriveContract({ type: 'login' }), expectPass: false, note: '含 invalid → forbidden 硬失败' },
  { name: 'search-results.html', actionType: 'search', contract: contract.deriveContract({ type: 'search' }), expectPass: true, note: '有结果页应 PASS' },
  { name: 'search-empty.html', actionType: 'search', contract: contract.deriveContract({ type: 'search' }), expectPass: false, note: 'no results → forbidden 硬失败' },
  { name: 'submit-ok.html', actionType: 'submit', contract: contract.deriveContract({ type: 'submit' }), expectPass: true, note: '提交成功页应 PASS' },
  { name: 'submit-fail.html', actionType: 'submit', contract: contract.deriveContract({ type: 'submit' }), expectPass: false, note: 'error → forbidden 硬失败' },
];

console.log('\n=== (B) Behavioral replay over fixtures ===');
let behaviorPass = 0, behaviorTotal = cases.length;
for (const c of cases) {
  const after = loadFixture(c.name);
  const r = contract.evaluateContract(c.contract, after, null, makeClauseVerify(after));
  const ok = r.success === c.expectPass;
  if (ok) behaviorPass++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + c.name + ' → ' + (r.success ? 'PASS' : 'FAIL') +
    ' (期望' + (c.expectPass ? 'PASS' : 'FAIL') + ') ' + c.note +
    ' | forbiddenHit=' + (!!r.forbiddenHit) + ' logic=' + r.logic + ' passed=' + r.passed + '/' + r.total);
}

const summary = {
  verifyFailedTotal: vf.length,
  outcomeContractCoverage: { covered, uncovered, pct: Math.round(100 * covered / vf.length), byStateType },
  behavioralReplay: { total: behaviorTotal, pass: behaviorPass },
  // Predicted effect on the §十五 gate (explained in report):
  //   partial-pass (vp>0) tasks had business state reached at least once → new OR multi-signal
  //   contract reliably PASSes them (state present) → these convert from VERIFY_FAILED to PASS.
  //   zero-pass (vp=0) tasks never reached state → remain FAIL (correct, bar not lowered).
};
fs.writeFileSync('replay_phase11.json', JSON.stringify(summary, null, 2));
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));
console.log('\n[replay] wrote replay_phase11.json');
