'use strict';

// Verification Engine：关键操作后验证结果。
// 失败不代表任务失败 —— 由 Runtime 决定进入 STEP_FAILED/重试。此处只产出置信度与证据。

const semanticResolver = require('./semanticResolver');
const contract = require('./verification/contract');
// C124：存在性裁决的唯一实现下沉到共用原语（避免验证层与诊断层各留一份同义实现）。
// verification.js 只保留调用点；新增/修改这里必然同步 test_c124 的跨层 parity 断言。
const { matchContentLeaf } = require('./existence');
// C125：业务子句判定（storage / url_pattern / login_state）的唯一实现下沉到共用模块。
// 此前 verification.js 与 verificationIntelligence.js 各有一份 switch，覆盖面不一致：
// 三个类型在诊断层落 default ⇒ 恒假 ⇒ 含这些子句的业务契约在诊断层结构性不可能成立。
// 置信度随判定一并返回（它是裁决的一部分，分开摆必然再次各自漂移）。
const clause = require('./verification/clause');

// 关键业务动作：仅 action_success 不足以证明业务完成（Phase 11 P0）。
function isKeyBusiness(t) {
  return ['click', 'fill', 'submit', 'login', 'logout', 'select', 'check', 'purchase', 'payment', 'password_change', 'delete', 'update_account_settings'].includes(t);
}

const VERIFICATION_TYPES = [
  'url_contains', 'url_pattern', 'text_present', 'text_absent', 'element_present',
  'element_absent', 'login_state', 'page_change', 'field_value', 'field_checked',
  'storage', 'action_success', 'none',
];

// C105 F3：URL 恒真判定的「表面键」——只取 host + pathname，query 一律不参与。
// 背景与语义见 server/agent/verification/clause.js（C125 起唯一实现在此处委托）。
const { urlSurfaceKey, surfaceContains } = clause;

// C123：存在性索引（observation.contentLeaves）匹配。
// ── C124 起实现移入 server/agent/existence.js ──────────────────────────────
// 原因：同一份「存在性语义」在 verificationIntelligence.js 里还有第二份实现（clausePresent /
// expectedActuallyPresent），它没有 contentLeaves 回落、也缺 element_present 分支 ⇒
// 验证层说「存在」、诊断层说「不存在」。修法是抽共用原语而非在第二个文件里再抄一遍。
// element_present 与 element_absent 必须共用同一函数 —— 只给其中一个回落，就会制造
// 「present 说在、absent 也说不在」的形式矛盾（L6：绝不留第二份同义实现）。
// 索引按**叶子文本元素**粒度采集（observation.js），因此这是元素级证据，
// 不是「整页文本 substring」那种退化判定。

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
    // C73 D4：契约形态对象（含 requiredEvidence、无 type，如 normalizeContract/legacyToContract
    // 产物未经 businessState 包裹直接传入）不能落进「未要求验证」恒真分支 —— 那会把
    // 「本应评估的业务合约」静默判成 success:true（假阳性）。fail-closed：委托合约评估。
    if (v && Array.isArray(v.requiredEvidence) && v.requiredEvidence.length) {
      const r = contract.evaluateContract(v, after, before, verify);
      return { success: r.success, confidence: r.confidence, evidence: r.evidence, contract: r, forbiddenHit: r.forbiddenHit, alternativesMatched: r.alternativesMatched };
    }
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
      // P2 无效证据守卫：URL 条件若在动作执行前（before 观察）已经成立，
      // 则它是「恒真证据」——与本次动作的因果无关，不能单独作为本动作成功的证明。
      // 背景（2026-08-31 run6 实证）：/saas/login.html 上 url_contains "saas" 恒真，
      // 错误凭据也被判 SUCCESS（假阳性）。守卫只拒绝「无效证据」，不改变 Success Definition。
      // C105 F3：恒真判定只在 URL 表面（host+pathname）上进行，query 不参与 ——
      // pscd=try.webflow.com 这类第三方注入的 query 参数不能把真导航证据误判为恒真。
      if (ok && before && before.url && surfaceContains(before.url, expect)) {
        evidence.push('P2 无效证据守卫: url 条件在动作执行前已成立（before url 表面=' + (urlSurfaceKey(before.url) || String(before.url)) + ' 已包含 "' + String(expect) + '"，恒真证据与本次动作无因果），不能作为本动作成功的证明');
        return { success: false, confidence: 0.8, evidence, invalidEvidence: 'precondition_true' };
      }
      evidence.push(`url=${url} ${ok ? '包含' : '不包含'} "${expect}"`);
      return { success: ok, confidence: ok ? 0.95 : 0.8, evidence };
    }
    case 'text_present': {
      // C126：证据源从 `textSummary`（前 120 个筛选元素，截断 5000）改为**可见文本全量**
      // （textSummary + visibleText）。此前长页面上目标文本落在第 121 个元素之后时
      // 判定恒假 —— 真实成功被误判失败，且与诊断层（读 visibleText）结论相反。
      // 判定与口径见 clause.js（唯一实现）。
      const r = clause.evalTextPresent(after, expect);
      evidence.push(r.reason);
      return { success: r.ok, confidence: r.confidence, evidence };
    }
    case 'text_absent': {
      // C126：与 text_present 共用同一份页面文本口径（L6：同一后果面不得两条路径不一致）。
      // 方向说明：证据源变宽使 text_absent **更严**（更不容易误判「已消失」）—— 与
      // 「不设伪成功」一致。
      const r = clause.evalTextAbsent(after, expect);
      evidence.push(r.reason);
      return { success: r.ok, confidence: r.confidence, evidence };
    }
    case 'element_present': {
      const cands = expect ? semanticResolver.resolve(expect, after) : [];
      let ok = cands.length > 0;
      if (ok) {
        evidence.push(`找到语义元素 "${expect}" (top=${cands[0].score})`);
      } else {
        // C123 回落：elements[] 是 semanticResolver 的唯一候选池，但它刻意不含
        // div/span/p（observation.js 的容量取舍），页面上真实存在的展示性条目
        // （榜单项、价格、状态文本）因此恒被判「未找到元素」。这里按元素级证据确认存在。
        const lf = matchContentLeaf(after, expect);
        if (lf) {
          ok = true;
          evidence.push(`找到内容元素 "${expect}"（存在性索引 <${lf.tag}${lf.cls ? '.' + String(lf.cls).split(/\s+/)[0] : ''}>："${String(lf.text).slice(0, 40)}"）`);
        } else {
          evidence.push(`未找到元素 "${expect}"`);
        }
      }
      const conf = ok ? (cands.length ? Math.min(0.95, 0.6 + cands[0].score * 0.4) : 0.75) : 0.7;
      return { success: ok, confidence: conf, evidence };
    }
    case 'element_absent': {
      // C105 M3：同 element_present，存在性通道不施加可操作性否决。
      const cands = expect ? semanticResolver.resolve(expect, after, { requireActionable: false }) : [];
      // 与 element_present 共用同一存在性索引：只因 elements[] 池不含展示性元素就判
      // 「不存在」，会和 present 通道的 C123 回落互相矛盾。
      const lf = cands.length ? null : matchContentLeaf(after, expect);
      const ok = cands.length === 0 && !lf;
      evidence.push(ok ? `元素 "${expect}" 不存在` : (lf ? `元素 "${expect}" 仍存在（存在性索引命中："${String(lf.text).slice(0, 40)}"）` : `元素 "${expect}" 仍存在`));
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
      // C73 D3（vault 注入修正）：expect 为空 = 期望值未知（vault 凭据执行时才注入，
      // planner 声明时不携带 value）→ 退化为「已填写」验证（与敏感字段 valueLength>0 同级）。
      // 旧实现 includes('') 恒真 —— 空字段也判成功（假阳性）；首版修复硬 fail-closed
      // 误杀 vault 场景（step22 Scenario A 回归实证）。两者都不对：期望未知时验证「写入发生」。
      const ok = actual.trim().length > 0 &&
        (!want.trim() || actual.trim().toLowerCase().includes(want.trim().toLowerCase()));
      if (!want.trim()) evidence.push('field_value: 期望值为空（vault 凭据执行时注入），退化为「已填写」验证');
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
      // C125：判定下沉到 clause.js（诊断层共用同一份），此处只组装证据。
      const r = clause.evalLoginState(text);
      evidence.push(r.reason);
      return { success: r.ok, confidence: r.confidence, evidence };
    }
    case 'storage': {
      // STEP 22 (V1)：真实页面 Web Storage 证据（登录态 / 业务状态持久化断言）。
      // 数据来自 observation.storage（页内只读真实采集），绝不从任务元数据推断成功。
      // 判定与 fail-closed 语义见 clause.js（C125 起唯一实现，诊断层共用）。
      const r = clause.evalStorage(v, after);
      evidence.push(r.reason);
      return { success: r.ok, confidence: r.confidence, evidence };
    }
    case 'url_pattern': {
      // STEP 22 (V1)：基于真实 page.url() 的正则匹配（业务导航状态断言）。
      // 非法 pattern → 验证失败（fail-closed），绝不抛异常崩 Runtime。
      // 不改动既有 url_contains 行为；仅当 contract 显式声明本类型时生效。
      // 判定、长度上限、非法正则 fail-closed、P2 无效证据守卫全部见 clause.js（C125 起唯一实现）。
      const r = clause.evalUrlPattern(v, after, before);
      evidence.push(r.reason);
      const out = { success: r.ok, confidence: r.confidence, evidence };
      if (r.invalidEvidence) out.invalidEvidence = r.invalidEvidence;
      return out;
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
