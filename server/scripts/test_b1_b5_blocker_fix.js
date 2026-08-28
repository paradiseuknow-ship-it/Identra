'use strict';

// B1–B5 阻塞修复：针对性 / 泛化测试套件（不依赖真实浏览器 / LLM / DB）。
// 运行：node server/scripts/test_b1_b5_blocker_fix.js
//
// 覆盖：
//  B1  action → 业务结果可靠闭环：所有关键动作推导真实业务态契约
//               （fill/select→field_value、check/uncheck→field_checked、click→page_change/element_absent、
//                navigate→url_contains、login→文本多信号）；敏感字段仅校验「是否已填写」(valueLength)，不比对明文。
//  B2  VERIFY_FAILED 真实归因：字段已定位但值为空 → ACTION_REAL_FAILURE/RE_EXECUTE（不 silent recheck）；
//               值已写入但验证失败 → VERIFICATION_TOO_STRICT/RETRY_VERIFY。
//  B4  VIL/Repair 业务恢复因果链：verifyFailed 使用 buildEffectiveVerification 推导的同一契约重验证。
//  B5  真实任务泛化：以一份合成「真实任务」观察集，验证多动作类型的契约均可正确判定业务结果。
//  B3  Success 单一权威口径：isBusinessSuccess 仅 status==='SUCCESS'；consistencyCheck harness/store 一致。

const assert = require('assert');
const verification = require('../agent/verification');
const vil = require('../agent/verification/verificationIntelligence');
const verifyFailed = require('../agent/repair/strategies/verifyFailed');
const successMetrics = require('../agent/successMetrics');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; fails.push(msg); console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n=== ' + name + ' ==='); }

// ---- 合成「真实任务」观察集 ----
function elem(over) {
  return Object.assign({ id: '', role: '', tag: 'input', type: 'text', name: '', cls: '', text: '', placeholder: '', label: '', ariaLabel: '', visible: true, state: {} }, over);
}
const EMAIL_EL = elem({ name: 'email', type: 'email', text: 'email', state: { value: 'a@b.com' } });
const PWD_EL = elem({ name: 'password', type: 'password', text: 'password', state: { sensitive: true, valueLength: 8 } });
const AGREE_EL = elem({ role: 'checkbox', tag: 'input', type: 'checkbox', name: 'agree', text: 'agree', state: { checked: true } });
const SUBMIT_EL = elem({ role: 'button', tag: 'button', name: 'submit', text: 'submit', state: {} });

const OBS_FORM = { url: 'https://app.example.com/form', textSummary: 'please fill the form', elements: [EMAIL_EL, PWD_EL, AGREE_EL, SUBMIT_EL] };
const OBS_DASH = { url: 'https://app.example.com/dashboard', textSummary: 'Welcome to your dashboard. Logout. results found', elements: [SUBMIT_EL] };

function expectBusinessState(step, label) {
  const eff = verification.buildEffectiveVerification(step);
  ok(eff && eff.businessState && eff.businessState.stateType, label + ' → 推导为业务态契约(stateType=' + (eff.businessState && eff.businessState.stateType) + ')');
  return eff;
}

async function main() {
  // =====================================================================
  section('B1 — 动作 → 业务结果可靠闭环（契约推导）');
  // =====================================================================
  {
    const eff = expectBusinessState({ action: { type: 'fill', target: { semantic: 'email' }, value: 'a@b.com' } }, 'fill');
    const cl = eff.businessState.requiredEvidence[0];
    ok(cl.type === 'field_value' && cl.expect === 'a@b.com' && cl.target === 'email', 'fill → field_value(name=email, expect=value)');
  }
  {
    const eff = expectBusinessState({ action: { type: 'select', target: { semantic: 'role' }, value: 'admin' } }, 'select');
    const cl = eff.businessState.requiredEvidence[0];
    ok(cl.type === 'field_value' && cl.expect === 'admin', 'select → field_value(name=role, expect=value)');
  }
  {
    const eff = expectBusinessState({ action: { type: 'check', target: { semantic: 'agree' } } }, 'check');
    ok(eff.businessState.requiredEvidence[0].type === 'field_checked' && eff.businessState.requiredEvidence[0].expect === 'checked', 'check → field_checked(checked)');
  }
  {
    const eff = expectBusinessState({ action: { type: 'uncheck', target: { semantic: 'agree' } } }, 'uncheck');
    ok(eff.businessState.requiredEvidence[0].type === 'field_checked' && eff.businessState.requiredEvidence[0].expect === 'unchecked', 'uncheck → field_checked(unchecked)');
  }
  {
    const eff = expectBusinessState({ action: { type: 'click', target: { semantic: 'submit' }, verification: { type: 'action_success' } } }, 'click');
    const types = eff.businessState.requiredEvidence.map((c) => c.type);
    ok(types.includes('page_change') && types.includes('element_absent'), 'click → page_change + element_absent(OR)');
  }
  {
    const eff = expectBusinessState({ action: { type: 'navigate', target: { url: 'https://app.example.com/dashboard' } } }, 'navigate');
    ok(eff.businessState.requiredEvidence[0].type === 'url_contains' && /dashboard/.test(eff.businessState.requiredEvidence[0].expect), 'navigate → url_contains(dashboard)');
  }
  {
    const eff = expectBusinessState({ action: { type: 'login', target: { semantic: 'login' } } }, 'login');
    const types = eff.businessState.requiredEvidence.map((c) => c.type);
    ok(types.every((t) => t === 'text_present' || t === 'text_absent'), 'login → 文本多信号契约');
  }

  // B1：敏感字段仅校验「是否已填写」，不比对明文（安全）
  section('B1 — 敏感字段明文不泄漏（field_value 仅校验 valueLength）');
  {
    const eff = verification.buildEffectiveVerification({ action: { type: 'fill', target: { semantic: 'password' }, value: 'secret123' } });
    const r = verification.verify(eff, OBS_FORM, OBS_FORM);
    ok(r.success === true, '敏感字段仅在 valueLength>0 时判定已填写 → 成功（不比对明文 secret123）');
    const OBS_EMPTY_PWD = { url: 'https://x', textSummary: 'x', elements: [elem({ name: 'password', type: 'password', state: { sensitive: true, valueLength: 0 } })] };
    const reff = verification.buildEffectiveVerification({ action: { type: 'fill', target: { semantic: 'password' }, value: 'whatever' } });
    const r2 = verification.verify(reff, OBS_EMPTY_PWD, OBS_EMPTY_PWD);
    ok(r2.success === false, '敏感字段 valueLength=0 → 判定未填写 → 失败（不比对明文）');
  }

  // =====================================================================
  section('B5 — 真实任务泛化（合成观察集多动作判定）');
  // =====================================================================
  {
    const eff = verification.buildEffectiveVerification({ action: { type: 'fill', target: { semantic: 'email' }, value: 'a@b.com' } });
    ok(verification.verify(eff, OBS_FORM, OBS_FORM).success === true, 'B5: fill(email=a@b.com) 命中 → 业务完成');
    const effWrong = verification.buildEffectiveVerification({ action: { type: 'fill', target: { semantic: 'email' }, value: 'WRONG' } });
    ok(verification.verify(effWrong, OBS_FORM, OBS_FORM).success === false, 'B5: fill(email=WRONG) 未命中 → 业务未完成（不 silent-pass）');
  }
  {
    const eff = verification.buildEffectiveVerification({ action: { type: 'check', target: { semantic: 'agree' } } });
    ok(verification.verify(eff, OBS_FORM, OBS_FORM).success === true, 'B5: check(agree) 已勾选 → 业务完成');
  }
  {
    const eff = verification.buildEffectiveVerification({ action: { type: 'navigate', target: { url: 'https://app.example.com/dashboard' } } });
    ok(verification.verify(eff, OBS_DASH, OBS_DASH).success === true, 'B5: navigate(dashboard) url 命中 → 业务完成');
  }
  {
    const eff = verification.buildEffectiveVerification({ action: { type: 'click', target: { semantic: 'submit' }, verification: { type: 'action_success' } } });
    ok(verification.verify(eff, OBS_DASH, OBS_FORM).success === true, 'B5: click 后 url 变化 → page_change 命中 → 业务完成');
    ok(verification.verify(eff, OBS_FORM, OBS_FORM).success === false, 'B5: click 后页面无变化 → 业务未完成（不 silent-pass）');
  }
  {
    const eff = verification.buildEffectiveVerification({ action: { type: 'login', target: { semantic: 'login' } } });
    ok(verification.verify(eff, OBS_DASH, OBS_DASH).success === true, 'B5: login → dashboard 文本命中 → 业务完成');
  }

  // =====================================================================
  section('B2 — VERIFY_FAILED 真实归因（差异化 recovery，不 silent-pass）');
  // =====================================================================
  {
    // 字段已定位但值为空（值未写入）→ 真实动作失败，应 RE_EXECUTE / ACTION_REAL_FAILURE（不归为验证/观察问题）
    const after = { url: 'https://x', textSummary: 'x', elements: [elem({ name: 'email', type: 'email', text: 'email', state: { value: '' } })] };
    const fillAction = { type: 'fill', target: { semantic: 'email' }, value: 'a@b.com' };
    const eff = verification.buildEffectiveVerification({ action: fillAction });
    const r = vil.analyze({ beforeObservation: {}, afterObservation: after, expectedVerification: eff, actionResult: { success: true }, action: fillAction });
    ok(r.failureType === 'ACTION_REAL_FAILURE' || r.failureType === 'RE_EXECUTE' || r.decision === 'RE_EXECUTE', 'B2: 字段空（值未写入）→ ACTION_REAL_FAILURE/RE_EXECUTE（不 silent recheck）');
  }
  {
    // 值已写入（field_value 命中）但验证仍报告失败 → 验证过严（RETRY_VERIFY），非动作失败
    const eff = verification.buildEffectiveVerification({ action: { type: 'fill', target: { semantic: 'email' }, value: 'a@b.com' } });
    const after = { url: 'https://x', textSummary: 'x', elements: [elem({ name: 'email', type: 'email', text: 'email', state: { value: 'a@b.com' } })] };
    const r = vil.analyze({ beforeObservation: {}, afterObservation: after, expectedVerification: eff, actionResult: { success: true } });
    ok(r.failureType === 'VERIFICATION_TOO_STRICT' && r.decision === 'RETRY_VERIFY', 'B2: 值已写入但验证失败 → VERIFICATION_TOO_STRICT/RETRY_VERIFY（差异化 recovery）');
  }

  // =====================================================================
  section('B4 — VIL/Repair 业务恢复因果链（verifyFailed 用同一推导契约重验证）');
  // =====================================================================
  {
    const step = { action: { type: 'fill', target: { semantic: 'email' }, value: 'a@b.com' } };
    const beforeObs = { url: 'https://x', textSummary: 'x', elements: [] };
    const afterObs = { url: 'https://x', textSummary: 'x', elements: [elem({ name: 'email', type: 'email', text: 'email', state: { value: 'a@b.com' } })] };
    const calls = [];
    const ctx = {
      error: { failureType: 'STATE_UNKNOWN' },
      observation: beforeObs,
      runAction: async (a) => { calls.push(a.type); return { success: true, observation: afterObs }; },
      calls,
    };
    const out = await verifyFailed.execute({ task: {}, step, ctx });
    ok(out.ok === true, 'B4: repair 重验证复用推导契约 → fill 值已写入 → 恢复成功（因果链闭合）');
    ok(calls.includes('inspect'), 'B4: repair 执行了真实重观察(inspect)');
  }

  // =====================================================================
  section('B3 — Success 单一权威口径（harness/store/report 一致）');
  // =====================================================================
  {
    const tSuccess = { id: '1', status: 'SUCCESS' };
    const tRunning = { id: '2', status: 'RUNNING' };
    ok(successMetrics.isBusinessSuccess(tSuccess) === true, 'B3: status===SUCCESS → 业务成功');
    ok(successMetrics.isBusinessSuccess(tRunning) === false, 'B3: status!==SUCCESS → 非业务成功（动作成功≠业务成功）');
    const harness = [tSuccess, tRunning];
    const store = [{ id: '1', status: 'SUCCESS' }, { id: '2', status: 'RUNNING' }];
    const cc = successMetrics.consistencyCheck(harness, store);
    ok(cc && cc.consistent === true && cc.mismatch.length === 0, 'B3: harness 与 store 口径一致 → 无 mismatch');
    const storeBad = [{ id: '1', status: 'SUCCESS' }, { id: '2', status: 'SUCCESS' }];
    const cc2 = successMetrics.consistencyCheck(harness, storeBad);
    ok(cc2 && cc2.consistent === false && cc2.mismatch.length >= 1, 'B3: harness/store 口径不一致 → 检出 mismatch');
  }

  console.log('\n---------------------------------------------------');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  if (fail) console.log('FAILURES:\n' + fails.map((f) => ' - ' + f).join('\n'));
  console.log('---------------------------------------------------');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', (e && e.stack) || e); process.exit(1); });
