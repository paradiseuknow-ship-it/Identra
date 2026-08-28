'use strict';

// Verification Engine：关键操作后验证结果。
// 失败不代表任务失败 —— 由 Runtime 决定进入 STEP_FAILED/重试。此处只产出置信度与证据。

const semanticResolver = require('./semanticResolver');
const contract = require('./verification/contract');

// 关键业务动作：仅 action_success 不足以证明业务完成（Phase 11 P0）。
function isKeyBusiness(t) {
  return ['click', 'fill', 'submit', 'login', 'logout', 'select', 'check', 'purchase', 'payment', 'password_change', 'delete', 'update_account_settings'].includes(t);
}

const VERIFICATION_TYPES = [
  'url_contains', 'text_present', 'text_absent', 'element_present',
  'element_absent', 'login_state', 'page_change', 'field_value', 'field_checked',
  'action_success', 'none',
];

// 输入：{ verification: {type, expect}, after: observation, before?: observation }
// 输出：{ success, confidence, evidence[] }
function verify(v, after, before) {
  // Phase 11：ExpectedBusinessState 合约优先（验证业务结果，而非动作执行）。
  // 必须在 none 守卫之前判断，因为合约对象不带 type 字段。
  if (v && v.businessState) {
    const r = contract.evaluateContract(v.businessState, after, before, verify);
    return { success: r.success, confidence: r.confidence, evidence: r.evidence, contract: r, forbiddenHit: r.forbiddenHit, alternativesMatched: r.alternativesMatched };
  }
  if (!v || !v.type || v.type === 'none') {
    return { success: true, confidence: 0.5, evidence: ['未要求验证'] };
  }
  const type = v.type;
  const expect = v.expect;
  const evidence = [];
  const text = (after && after.textSummary) || '';
  const url = (after && after.url) || '';
  const elements = (after && after.elements) || [];

  switch (type) {
    case 'url_contains': {
      const ok = !!expect && url.includes(String(expect));
      evidence.push(`url=${url} ${ok ? '包含' : '不包含'} "${expect}"`);
      return { success: ok, confidence: ok ? 0.95 : 0.8, evidence };
    }
    case 'text_present': {
      const ok = !!expect && text.toLowerCase().includes(String(expect).toLowerCase());
      evidence.push(`页面文本${ok ? '包含' : '不包含'} "${expect}"`);
      return { success: ok, confidence: ok ? 0.9 : 0.7, evidence };
    }
    case 'text_absent': {
      const ok = !expect || !text.toLowerCase().includes(String(expect).toLowerCase());
      evidence.push(`页面文本${ok ? '未出现' : '出现'} "${expect}"`);
      return { success: ok, confidence: ok ? 0.85 : 0.6, evidence };
    }
    case 'element_present': {
      const cands = expect ? semanticResolver.resolve(expect, after) : [];
      const ok = cands.length > 0;
      evidence.push(ok ? `找到语义元素 "${expect}" (top=${cands[0].score})` : `未找到元素 "${expect}"`);
      return { success: ok, confidence: ok ? Math.min(0.95, 0.6 + cands[0].score * 0.4) : 0.7, evidence };
    }
    case 'element_absent': {
      const cands = expect ? semanticResolver.resolve(expect, after) : [];
      const ok = cands.length === 0;
      evidence.push(ok ? `元素 "${expect}" 不存在` : `元素 "${expect}" 仍存在`);
      return { success: ok, confidence: ok ? 0.85 : 0.6, evidence };
    }
    case 'field_value': {
      // B1：校验字段真实值（state.value），而非脆弱的 textSummary。
      // 敏感字段（密码等）仅校验「是否已填写」(valueLength>0)，不比对也绝不输出明文。
      const tgt = (v && v.target) || expect || '';
      const want = String(expect || '');
      const cands = tgt ? semanticResolver.resolve(tgt, after) : [];
      if (!cands.length) {
        evidence.push(`field_value: 未找到目标字段 "${tgt}"`);
        return { success: false, confidence: 0.5, evidence };
      }
      const st = cands[0].el.state || {};
      if (st.sensitive) {
        const ok = Number(st.valueLength || 0) > 0;
        evidence.push(`敏感字段(如密码)仅校验是否已填写(不比对明文): ${ok ? '已填写' : '为空'}`);
        return { success: ok, confidence: ok ? 0.8 : 0.4, evidence };
      }
      const actual = String(st.value || '');
      const ok = actual.trim().toLowerCase().includes(want.trim().toLowerCase());
      evidence.push(`字段值校验: 实际="${actual.slice(0, 40)}" 期望包含="${want.slice(0, 40)}" → ${ok ? '匹配' : '不匹配'}`);
      return { success: ok, confidence: ok ? 0.9 : 0.5, evidence };
    }
    case 'field_checked': {
      // B1：校验勾选/单选框真实勾选态（state.checked）。
      const tgt = (v && v.target) || expect || '';
      const want = String((v && v.expect) || 'checked');
      const cands = tgt ? semanticResolver.resolve(tgt, after) : [];
      if (!cands.length) {
        evidence.push(`field_checked: 未找到目标元素 "${tgt}"`);
        return { success: false, confidence: 0.5, evidence };
      }
      const st = cands[0].el.state || {};
      const checked = !!st.checked;
      const ok = (want === 'unchecked') ? !checked : checked;
      evidence.push(`勾选状态校验: checked=${checked} 期望=${want} → ${ok ? '匹配' : '不匹配'}`);
      return { success: ok, confidence: ok ? 0.85 : 0.5, evidence };
    }
    case 'login_state': {
      const loggedOut = /(sign in|log in|login|register|create account)/i.test(text);
      const loggedIn = /(logout|sign out|my account|dashboard|welcome|profile)/i.test(text);
      const ok = !loggedOut || loggedIn;
      evidence.push(`文本登录态线索: 未登录=${loggedOut} 已登录=${loggedIn}`);
      return { success: ok, confidence: ok ? 0.75 : 0.6, evidence };
    }
    case 'page_change': {
      if (!before) {
        // 无 before（如首步 navigate）：URL 已加载到 http(s) 即视为变化
        const ok = !!url && /^https?:\/\//.test(url);
        evidence.push(`无 before 观察，判定 URL 已加载: ${url} → ${ok ? '变化' : '未变化'}`);
        return { success: ok, confidence: ok ? 0.6 : 0.4, evidence };
      }
      const changed = (before.url !== url) || (before.textSummary !== text);
      evidence.push(`url 变化=${before.url !== url} 内容变化=${before.textSummary !== text}`);
      return { success: changed, confidence: changed ? 0.9 : 0.6, evidence };
    }
    case 'action_success': {
      // Phase 11 P0：关键业务动作禁止仅以 action_success 作为业务完成证据。
      if (v.insufficientOutcome) {
        evidence.push('action_success 不能作为业务完成的唯一证据：关键业务动作 ' + (v.actionType || '') + ' 缺少 outcome verification contract（应验证业务结果，而非动作执行）');
        return { success: false, confidence: 0.2, evidence };
      }
      // 语义：依赖工具自身成功即可。但必须要求修复动作后存在真实页面观察（after.observation），
      // 缺失则视为验证失败（防止工具成功但页面状态未真实改变时的 silent-pass）。
      if (!after || !after.url) {
        evidence.push('action_success 验证缺少有效页面观察（修复动作后快照缺失），视为验证失败');
        return { success: false, confidence: 0.3, evidence };
      }
      evidence.push(`action_success：工具执行成功且存在页面观察(url=${after.url})`);
      return { success: true, confidence: 0.85, evidence };
    }
    default:
      return { success: false, confidence: 0.3, evidence: ['未知验证类型，视为验证失败'] };
  }
}

// 解析 step 的有效验证对象（Phase 11）：
// 1) 优先使用 planner/schema 显式声明的 expectedBusinessState 合约；
// 2) 否则从 action.type 自动推导 outcome 合约（login/search/submit/fill/...）；
// 3) 否则保留既有真实 verification(type≠action_success)；
// 4) 关键业务动作若仅有 action_success 且无 outcome 合约 => 标记 insufficientOutcome，
//    验证将明确失败（动作成功 ≠ 业务完成）。
function buildEffectiveVerification(step) {
  const action = step && step.action;
  // 规范运行时 step.verification 是 step 的兄弟字段；部分结构（如测试/旧 schema）把 verification
  // 放在 action 下。两者都识别，避免遗漏关键业务动作的 outcome 合约。
  const v = (step && step.verification) || (action && action.verification) || null;

  // 1) 优先使用 planner/schema 显式声明的 expectedBusinessState 合约（理想路径）。
  if (action && action.expectedBusinessState && action.expectedBusinessState.stateType) {
    return { businessState: action.expectedBusinessState };
  }
  if (v && v.businessState && v.businessState.stateType) return v;

  // 2) Phase 11 P0（§九/§十）：关键业务动作必须由「业务结果」验证，而非动作执行或脆弱单信号。
  //    - 若 planner 已给出真实 verification（非 none/非 action_success），对「非关键动作」保留其意图；
  //      对「关键业务动作」则强制用从 action.type 自动推导的 outcome 合约覆盖之——
  //      这正是 Phase 10.9 中 79% VERIFY_FAILED 的根因（脆弱/抖动单信号验证）。
  //    - 该覆盖不降低验证门槛：outcome 合约仍要求真实业务态证据（多信号 OR）+ forbidden 硬失败。
  const hasRealPlannerVerif = !!(v && v.type && v.type !== 'none' && v.type !== 'action_success');
  const derived = action ? contract.deriveContract(action) : null;

  if (derived && isKeyBusiness(action.type)) {
    // 关键业务动作：业务结果必须可验证（杜绝仅 action 执行即判定成功）。
    // - planner 未给真实验证 → 以推导的 outcome 契约（page_change / element_absent 等）为主契约；
    // - planner 已给真实验证 → 以其为「主验证」（保留业务语义与其替代态），并把推导的 outcome
    //   契约作为 OR 替代态兜底：既验证真实业务结果，又避免脆弱单信号验证导致 false VERIFY_FAILED，
    //   也避免 click 跳到错误页（page_change 命中）误判成功时丢弃 planner 的具体意图。
    //   注意：主验证以「裸 verification」返回（由 verify 的 switch 干净失败），使 verifyWithAlternatives
    //   自身的替代态循环能正确上报 used='alternative'（而非被 evaluateContract 内部吞掉）。
    if (!hasRealPlannerVerif) return { businessState: derived };
    const businessState = Object.assign({}, v, {
      allowedAlternativeStates: (Array.isArray(v.allowedAlternativeStates) ? v.allowedAlternativeStates : [])
        .concat(Array.isArray(v.allowedAlternatives) ? v.allowedAlternatives : [])
        .concat([derived]),
    });
    return businessState;
  }

  // 非关键动作且可推导合约：planner 未给真实验证 → 用推导出的业务结果合约。
  if (derived && !hasRealPlannerVerif) return { businessState: derived };

  // 3) 非关键动作，或不可推导的关键动作（purchase/delete/...）且 planner 给了真实 verification → 保留。
  if (hasRealPlannerVerif) return v;

  // 4) 关键业务动作仅有 action_success（无 outcome 合约）→ 明确不足，验证失败（动作成功 ≠ 业务完成）。
  if (action && isKeyBusiness(action.type) && v && v.type === 'action_success') {
    return { type: 'action_success', insufficientOutcome: true, actionType: action.type };
  }
  return v || { type: 'none' };
}

module.exports = { verify, VERIFICATION_TYPES, buildEffectiveVerification, contract, isKeyBusiness };
