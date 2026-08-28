'use strict';

// Business Capability Phase 2 — A 类 P1+P2 单元测试（无浏览器，纯逻辑）。
// 覆盖：
//   P2 observation diff 细分（keyTextChanged / elementStateChanged / pageStructureChanged）
//   P1 VIL 对 submit 动作产出 SUBMIT_RESULT_UNKNOWN（区别于泛化 STATE_UNKNOWN）
//   P1 verifyFailed 的 SUBMIT_RESULT_UNKNOWN 分支（查询结果落点 → 成功 / 错误页重执行 / 不确定升级）
// 运行：node server/scripts/test_submit_result_landing.js

const assert = require('assert');
const vil = require('../agent/verification/verificationIntelligence');
const verifyFailed = require('../agent/repair/strategies/verifyFailed');
const observation = require('../agent/observation');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n=== ' + name + ' ==='); }

async function main() {
  // ---------------------------------------------------------------
  section('P2: observation diff 细分辅助函数');
  {
    const e1 = [{ state: { disabled: false, value: 'a', checked: false } }];
    const e2 = [{ state: { disabled: false, value: 'abc', checked: false } }];
    ok(observation.elementStateSig(e1) !== observation.elementStateSig(e2), '元素值长度不同 → elementStateSig 不同（可检测 elementStateChanged）');
    const d1 = [{ state: { disabled: false, value: '', checked: false } }];
    const d2 = [{ state: { disabled: true, value: '', checked: false } }];
    ok(observation.elementStateSig(d1) !== observation.elementStateSig(d2), 'disabled 翻转 → elementStateSig 不同');
    const s1 = [{ tag: 'input', id: 'a', role: 'input', selector: 'input#a', type: 'text' }];
    const s2 = [{ tag: 'input', id: 'b', role: 'input', selector: 'input#b', type: 'text' }];
    ok(observation.elementStructSig(s1) !== observation.elementStructSig(s2), '元素 id 不同 → elementStructSig 不同（可检测 pageStructureChanged）');
    ok(observation.elementStateSig([]) === observation.elementStateSig([]), '空列表签名稳定');
  }

  // ---------------------------------------------------------------
  section('P1: VIL submit → SUBMIT_RESULT_UNKNOWN');
  const stableAfter = {
    url: 'http://x/step', textSummary: 'x', visibleText: 'x', domFingerprint: 'f1',
    loadingState: 'complete', networkState: 'idle', previousObservationDiff: { domChanged: false },
  };
  const baseInput = {
    beforeObservation: { url: 'http://x/step', textSummary: 'x', visibleText: 'x', domFingerprint: 'f1' },
    afterObservation: stableAfter,
    expectedVerification: { type: 'text_present', expect: 'zzz-not-present' },
    actionResult: { success: true },
  };
  {
    const r = vil.analyze(Object.assign({}, baseInput, { action: { type: 'submit' } }));
    ok(r.failureType === 'SUBMIT_RESULT_UNKNOWN', 'submit 稳定+业务态未确认 → SUBMIT_RESULT_UNKNOWN（得到 ' + r.failureType + '）');
  }
  {
    const r = vil.analyze(Object.assign({}, baseInput, { action: { type: 'click' } }));
    ok(r.failureType === 'STATE_UNKNOWN', '非 submit（click）→ 仍是 STATE_UNKNOWN（回归守卫，得到 ' + r.failureType + '）');
  }

  // ---------------------------------------------------------------
  section('P1: verifyFailed SUBMIT_RESULT_UNKNOWN 分支');
  function makeObs(text, errs) {
    return { success: true, observation: { visibleText: text, textSummary: text, url: 'http://x', domFingerprint: 'fp', previousObservationDiff: {}, errors: errs || [] } };
  }
  function buildCtx(currentText, errorPage, sensitive) {
    return {
      error: { failureType: 'SUBMIT_RESULT_UNKNOWN' },
      observation: null,
      runAction: async (a) => {
        if (a.type === 'inspect') return makeObs(currentText, errorPage ? ['页面文本包含疑似错误关键词'] : []);
        if (a.type === 'search' || a.type === 'purchase') return makeObs('DONE received'); // 重执行路径
        return { success: true };
      },
    };
  }
  function step(actionType) {
    return {
      id: 's1',
      action: { type: actionType, expectedBusinessState: { stateType: 'DONE', requiredEvidence: [{ type: 'text_present', expect: 'DONE' }] } },
    };
  }

  // 1) 重观察重验证确认 → 成功
  {
    const ctx = buildCtx('DONE received', false);
    const res = await verifyFailed.execute({ task: { id: 't1' }, step: step('search'), ctx });
    ok(res.ok === true, '落点窗口捕获到 DONE → 验证通过 ok=true（得到 ' + res.ok + '）');
  }
  // 2) 错误页（非敏感）→ 重执行并验证通过
  {
    const ctx = buildCtx('error occurred', true);
    const res = await verifyFailed.execute({ task: { id: 't1' }, step: step('search'), ctx });
    ok(res.ok === true, '错误页→非敏感动作重执行并验证通过 ok=true（得到 ' + res.ok + '）');
  }
  // 3) 仍不确定（非敏感）→ 升级人工（不 silent-pass，不盲目重提交）
  {
    const ctx = buildCtx('neutral page, no signal', false);
    const res = await verifyFailed.execute({ task: { id: 't1' }, step: step('search'), ctx });
    ok(res.ok === false && res.needsApproval === true && /不确定/.test(res.reason || ''), '落点不确定→升级人工（needsApproval + reason 含「不确定」）');
  }
  // 4) 错误页 + 敏感动作 → REAUTH_OR_PAUSE（不自主重提交）
  {
    const ctx = buildCtx('payment error', true);
    const res = await verifyFailed.execute({ task: { id: 't1' }, step: step('purchase'), ctx });
    ok(res.ok === false && res.strategy === 'REAUTH_OR_PAUSE' && res.needsApproval === true, '敏感动作错误页→REAUTH_OR_PAUSE 升级人工（不自主重提交）');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
