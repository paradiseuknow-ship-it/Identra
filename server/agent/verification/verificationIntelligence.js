'use strict';

// Verification Intelligence Layer (VIL) — v0.2.1。
//
// 职责（Phase 10.3）：在 verification.js 判定失败后，回答四个问题：
//   1) 为什么失败（failureType 分类）？
//   2) 是否应该等待（WAIT）？
//   3) 是否需要重新观察（RETRY_VERIFY）？
//   4) 是否需要重新执行（RE_EXECUTE）？
//
// 设计红线：
//   - 不替代 verification.js。verification.js 保留最终判定权（标准不变）。
//   - VIL 只做「诊断 + 决策建议」，不自行宣布成功，不降低验证标准。
//   - 输出纯函数，无副作用，可单测、可回放。
//
// 输入：
//   { beforeObservation, afterObservation, expectedVerification, actionResult }
// 输出：
//   { decision, failureType, confidence, evidence }

const semanticResolver = require('../semanticResolver');
// C125：storage / url_pattern / login_state 的判定与验证引擎共用同一份实现。
// 此前本文件的 clausePresent 缺这三个分支 ⇒ 落 default:false ⇒ 含它们的业务契约在
// 诊断层结构性不可能成立（与 C124 D1 同族），真实达成也无法识别 ⇒ 误升级人工。
const clause = require('./clause');
// C124：存在性裁决共用 verification.js 的同一份实现。
// 本文件此前自带一份（elements 池子串 / 裸 resolver），与 verification.js 在
// ① element_present 分支缺失（恒 false）② div/span 无存在性索引（假「已消失」）
// 两处分歧 —— 同一份语义两份答案是典型 L6 不对称。此后一律走共用原语。
const existence = require('../existence');
const elementExists = (after, expect, opts) => existence.elementExists(after, expect, semanticResolver.resolve, opts);

// failureType 枚举
const FAILURE_TYPES = {
  EVENTUAL_CONSISTENCY: 'EVENTUAL_CONSISTENCY', // 动作成功，页面异步状态延迟
  OBSERVATION_DELAY: 'OBSERVATION_DELAY',       // 观察过早，DOM/文本尚未出现
  VERIFICATION_TOO_STRICT: 'VERIFICATION_TOO_STRICT', // 条件无法匹配真实成功状态
  ACTION_REAL_FAILURE: 'ACTION_REAL_FAILURE',   // 动作本身失败
  STATE_UNKNOWN: 'STATE_UNKNOWN',               // 证据不足，无法判断
  DOM_CHANGED: 'DOM_CHANGED',                   // 原目标状态/结构变化
  SUBMIT_RESULT_UNKNOWN: 'SUBMIT_RESULT_UNKNOWN', // 提交动作成功但结果落点未确认（区别于泛化 STATE_UNKNOWN）
  ASYNC_PENDING: 'ASYNC_PENDING',               // 动作成功、页面稳定、验证未通过，但存在「异步处理中」证据（结果未定，非成功非失败）
};

// decision 枚举
const DECISIONS = {
  SUCCESS: 'SUCCESS',
  WAIT: 'WAIT',             // 等异步稳定后重观察（不重执行）
  RECHECK_OBSERVATION: 'RECHECK_OBSERVATION', // 重新观察（不重执行），用于证据不足时的再确认
  RETRY_VERIFY: 'RETRY_VERIFY', // 重新观察 + 重新验证（不重执行）
  RE_EXECUTE: 'RE_EXECUTE', // 重新执行原动作
  HUMAN_ESCALATE: 'HUMAN_ESCALATE',
};

// 哪些 decision 会进入「重观察 + 重验证」窗口（WAIT / RECHECK / RETRY_VERIFY 都不重执行原动作）。
// 用于 runtime 判断：是否运行 Observation Window 尝试时序/观察恢复。
function isReobservableDecision(decision) {
  return decision === DECISIONS.WAIT ||
    decision === DECISIONS.RECHECK_OBSERVATION ||
    decision === DECISIONS.RETRY_VERIFY;
}

// P3（Phase 2 Evidence Aggregation）：纯函数证据聚合层。
//
// 职责：把「前后两次观察 + 可选验证窗口」转成一份可解释加分（evidenceScore）。
// 严格限制：
//   - 不判定 SUCCESS，不修改任何既有 failureType / decision / repairAction。
//   - 只读取观察事实字段（previousObservationDiff / capturedAt / url），不引入 mock。
//   - 加权规则完全可解释（见下方 add 权重），仅做「证据多寡」的量化，供未来验证层使用。
//
// 输入：
//   beforeObservation, afterObservation：观察快照（含 previousObservationDiff / capturedAt / url）
//   verificationWindow（可选）：调用方传入的窗口重观察标记 { reobserved | observed | reObserve | verified }
// 输出：
//   { evidenceScore:number, evidenceReasons:[], evidenceSignals:{} }
function aggregateEvidence(beforeObservation, afterObservation, verificationWindow) {
  const before = beforeObservation || {};
  const after = afterObservation || {};
  const diff = after.previousObservationDiff || {};

  const toTs = (v) => {
    if (!v) return 0;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  };
  const beforeTs = toTs(before.capturedAt);
  const afterTs = toTs(after.capturedAt);

  // 信号（仅基于观察事实，不臆测 success）
  const urlChanged = !!(diff.urlChanged || (before.url && after.url && before.url !== after.url));
  const keyTextChanged = !!(diff.keyTextChanged || diff.textChanged);
  const elementStateChanged = !!diff.elementStateChanged;
  const pageStructureChanged = !!diff.pageStructureChanged;
  // freshObservation：after 观察较 before 更新（或 before 无时间戳），即是一份较新的观察。
  const freshObservation = !!(afterTs && (!beforeTs || afterTs > beforeTs));
  const observationAge = afterTs ? Math.max(0, Date.now() - afterTs) : null;
  // verificationWindowObserved：调用方传入的窗口重观察标记（可选；当前 runtime 尚未接入）。
  let verificationWindowObserved = false;
  if (verificationWindow) {
    verificationWindowObserved = !!(
      verificationWindow.reobserved ||
      verificationWindow.observed ||
      verificationWindow.reObserve ||
      verificationWindow.verified
    );
  }

  const signals = {
    urlChanged,
    keyTextChanged,
    elementStateChanged,
    pageStructureChanged,
    freshObservation,
    observationAge,
    verificationWindowObserved,
  };

  // 可解释加权：每个信号独立加分，不硬编码 SUCCESS。权重总和 1.00，仅防御性 clamp 到 [0,1]。
  const reasons = [];
  let score = 0;
  const add = (cond, w, reason) => {
    if (cond) { score += w; reasons.push(reason); }
  };
  add(keyTextChanged, 0.35, '关键文本出现/变化（+0.35）');
  add(urlChanged, 0.25, 'URL 进入变化/目标态（+0.25）');
  add(elementStateChanged, 0.15, '关键元素状态变化（+0.15）');
  add(pageStructureChanged, 0.10, '页面结构变化（+0.10）');
  add(freshObservation, 0.10, 'Fresh Observation（较新观察，+0.10）');
  add(verificationWindowObserved, 0.05, 'Verification Window 重新观察（+0.05）');
  if (score > 1) score = 1;
  if (score < 0) score = 0;

  return {
    evidenceScore: score,
    evidenceReasons: reasons,
    evidenceSignals: signals,
  };
}

// P4（Phase 2 ASYNC_PENDING）：纯函数，仅读 observation，识别「异步处理中」信号。
// 严格限制：不访问网络、不调用浏览器、不判定成功、不引入 mock。
// 最小关键词库，仅基于已有观察字段（visibleText / textSummary / url / elements）。
const ASYNC_TEXT_KEYWORDS = ['processing', 'pending', 'waiting', 'verifying', 'under review', 'generating', 'uploading'];
const ASYNC_URL_SEGMENTS = ['/processing', '/wait', '/pending'];

function detectAsyncPending(beforeObservation, afterObservation) {
  const after = afterObservation || {};
  const signals = [];
  const text = ((after.visibleText || '') + ' ' + (after.textSummary || '')).toLowerCase();
  const url = (after.url || '').toLowerCase();
  const elements = after.elements || [];

  // 文本信号：出现处理中/等待中等关键词
  const hitText = ASYNC_TEXT_KEYWORDS.filter((k) => text.includes(k));
  if (hitText.length) signals.push('processing_text:' + hitText.join('|'));

  // URL 信号：处于处理/等待类路径
  const hitUrl = ASYNC_URL_SEGMENTS.some((s) => url.includes(s));
  if (hitUrl) signals.push('pending_url');

  // 状态信号：disabled submit button / loading spinner / progress indicator
  const statusHit = elements.some((e) => {
    const et = ((e.text || '') + ' ' + (e.semantic || '') + ' ' + (e.role || '')).toLowerCase();
    const disabled = !!(e.state && e.state.disabled);
    const isSubmit = /submit|confirm|pay|登录|提交/.test(et);
    const looksLoading = /loading|spinner|progress|loader|加载|处理中/.test(et);
    if (disabled && isSubmit) return true; // disabled submit button
    if (looksLoading) return true;        // loading spinner / progress indicator
    return false;
  });
  if (statusHit) signals.push('loading_indicator');

  if (!signals.length) {
    return { pending: false, signals: [], confidence: 0 };
  }
  // 可解释置信度：文本命中 0.6 基线，URL/状态各 +0.15，封顶 0.95。
  let confidence = 0.6;
  if (hitUrl) confidence += 0.15;
  if (statusHit) confidence += 0.15;
  if (confidence > 0.95) confidence = 0.95;
  return { pending: true, signals, confidence };
}

// 轻量：从观察结果判断「期望验证目标」是否真实存在（用于区分 TOO_STRICT vs UNKNOWN）
// C132：本函数与 clausePresent 是 4b `targetPresent` **同一个变量的两支**（见 _analyze
// :420-423 的三元式）⇒ 两者必须同口径；否则同一逻辑场景仅因「planner 是否给出
// verification」这一个无关差异，就得到相反诊断。故 url_contains 分支改为委托
// clause.evalUrlContains（唯一实现，含 P2），签名相应补 beforeObservation。
function expectedActuallyPresent(expectedVerification, afterObservation, beforeObservation) {
  if (!expectedVerification || !afterObservation) return false;
  const type = expectedVerification.type;
  const expect = expectedVerification.expect;
  // C130：URL 判定**不再整体 lowerCase** —— 大小写口径须与成功裁决面
  // （verification.js:70 裸 includes）逐字一致（L15：同一份证据多消费方 ⇒ 口径唯一）。
  // RFC 3986 §6.2.2：scheme/host 大小写不敏感，**path 大小写敏感**；整体 toLowerCase
  // 会同时折叠 host（该折叠）与 path（不该折叠）—— 对哪条规则都是错的。
  // 正确形态见 clause.urlSurfaceKey（对 host 单独折叠、path 原样），本文件不另造一份。
  const url = String(afterObservation.url || '');
  if (type === 'text_present' && expect) {
    // C126：走与验证引擎同一份文本证据口径（clause.js）。此前这里读 visibleText 而
    // 验证引擎读 textSummary ⇒ 长页面上「验证说过严、其实没漏」的误判。
    return clause.evalTextPresent(afterObservation, expect).ok;
  }
  if (type === 'url_contains' && expect) {
    // C130：expect 侧不 lowercase（原样字面片段，与契约一致）。
    // C132：**委托唯一实现**。改前本行是一份内联裸 `url.includes(String(expect))`，**无 P2**
    // —— before.url 已含 expect 时仍判 true ⇒ 4b 报 VERIFICATION_TOO_STRICT + RETRY_VERIFY，
    // 把「无真实跳转」的真实失败说成「其实已达成」，而裁决面判 false 且
    // invalidEvidence=precondition_true ⇒ 跨支/跨层相反。
    // ★ 危害面与 C131 同源，但属**另一支**：P1（businessState 形态）走 clausePresent
    //   （C131 已含 P2）；P2（planner 给了裸 verification 的形态）走本函数 ⇒ C131 只修了一支。
    // 契约依据 planner.js:79/86：「expect 必须是动作执行前 URL 中不存在的片段，若入口 URL
    // 已包含该片段，验证将被判为无效证据而失败」⇒ P2 是子句语义的一部分。
    return clause.evalUrlContains({ type, expect }, afterObservation, beforeObservation).ok;
  }
  if (type === 'element_present' && expect) {
    // C124：改走共用原语的 loose 档。
    // loose 是**有意的**更宽口径 —— 本函数回答的是「页面上有没有字面痕迹（说明验证规则写得过严）」，
    // 不是「元素存在与否」的成功裁决，所以允许单元素字段子串这种弱信号。
    // 但必须走同一份实现：旧的代码在这里把整页 elements 的所有字段串成一条字符串再 includes，
    // 语义作用域是「整页面」而不是「某个元素」，且逐字 includes 不折叠空白 —— 元素文本自带
    // 换行/多空格时，视觉上完全相同的 expect 反而匹配不上。共用原语改为按单元素各自拼接
    // 并统一折叠空白，同时补上 contentLeaves 存在性索引。
    // 注（核查结论，勿夸大成 bug）：旧口径的元素间接缝恒含 ≥6 个空白，要跨元素误命中须 expect
    // 自带同样长的空白串，现实不可达 —— 所以本批**不声称**修掉了跨元素假阳性。
    return elementExists(afterObservation, expect, { loose: true }).found;
  }
  // businessState 契约：委托 businessStatePresent 做精准判定（B2 真实归因）。
  // C132：传 beforeObservation 而非 null。★该分支在**当前唯一调用点**下**结构上不可达**
  // （_analyze :428 的三元式已用 businessState 作判别，本函数只在 else 支被调用；且本函数
  // 未导出）⇒ 本次改动**零行为变更**。保留并补齐口径，是为了不留下第二份「无 before」的
  // 形态：将来若新增调用方，口径与主路径天然一致（L16 的反面用法 —— 不留幽灵形态）。
  if (expectedVerification.businessState) {
    return businessStatePresent(expectedVerification.businessState, afterObservation, beforeObservation);
  }
  // 其它类型（login_state/page_change/action_success）不直接判断"存在性"
  return false;
}

// 判定单个业务态 clause 在 after 中是否真实存在（B2：精准归因 VERIFICATION_TOO_STRICT）。
function clausePresent(cl, after, before) {
  if (!cl || !cl.type) return false;
  // C126：文本证据一律走 clause.js 的唯一口径（textSummary + visibleText 全量），
  // 不再在本文件里各自拼串。roleText 是**元素级**证据（交互元素角色名 / aria-label），
  // 不参与文本通道 —— 否则「视觉上没有这段文字」的元素属性会命中 text_present（假阳性），
  // 且制造与验证引擎的口径分歧（它从来不读 roleText）。
  // login_state 与验证引擎同源（textSummary）：该正则本就脆弱（_analyze 4c 有专属兜底），
  // 证据源越宽越容易把「未登录」判成「已登录」，故向验证引擎口径收敛而非反向放宽。
  const text = String((after && after.textSummary) || '').toLowerCase();
  // C130：url 恢复**原样**（不再整体 lowerCase）。该变量有两个消费点，方向一致：
  //   ① case 'url_contains' —— 与裁决面同口径（本批目标，方向=收紧）；
  //   ② case 'page_change' 的 `b.url !== url`（**差值比较**，不是包含判定）——
  //      原样比较才认得出「仅大小写不同的真实跳转」（/Dashboard → /dashboard）；
  //      旧实现把这类变化吞掉，是同一处 lowercase 的连带副作用。
  const url = String((after && after.url) || '');
  const els = after.elements || [];
  switch (cl.type) {
    case 'text_present': return clause.evalTextPresent(after, cl.expect).ok;
    case 'text_absent': return clause.evalTextAbsent(after, cl.expect).ok;
    // C131：P2 无效证据守卫与 url_pattern 同口径（本文件内此前**不对称**，L6）——
    // 改前本行是裸 `url.includes(String(cl.expect))`，彻底忽略 before：同一 clause、同一
    // before/after，verification.js（裁决面）判 false/invalidEvidence=precondition_true，
    // 而本函数判 true ⇒ 4b「期望业务结果其实已达成」误报 VERIFICATION_TOO_STRICT
    // ⇒ RETRY_VERIFY，与裁决面的失败结论**跨层相反**（L15）。
    // 契约依据：planner.js:79/86「expect 必须是动作执行前 URL 中不存在的片段 ——
    // 若入口 URL 已包含该片段，验证将被判为无效证据而失败」。P2 是子句语义的一部分，
    // 不是某个消费方的局部加固；因此诊断面**必须**同口径。
    // 方向=收紧（更不容易把这算成「已达成」，与「不设伪成功」一致）。
    case 'url_contains': return clause.evalUrlContains(cl, after, before).ok;
    case 'page_change': {
      // C124 D5：两侧必须**同口径构造**。旧实现 after 侧是
      // `(visibleText||textSummary) + ' ' + (roleText||'')`、before 侧是不带 roleText 的裸串 ——
      // roleText 为空时 after 恒比 before 多一个尾随空格 ⇒ 两侧永不可能相等 ⇒
      // 只要 before 的文本非空，page_change 子句**恒真** ⇒ 任何含该子句的 OR 契约都被判「已达成」
      // ⇒ VIL 恒谎报业务结果达成。同一组完全相同的观察，verification.js 判「未变化」而 VIL 判
      // 「已变化」—— 与本次 D1/D2 同源的跨层口径分歧。
      // 这里两侧都按同一构造函数 + 同一归一化（折叠空白并去首尾）后再比较。
      const b = before || {};
      const sideText = (o) => existence.normalizeText((o && (o.visibleText || o.textSummary) || '') + ' ' + (o && o.roleText || ''));
      const bText = sideText(b);
      const aText = sideText(after);
      return (b.url && b.url !== url) || (!!bText && bText !== aText);
    }
    // C124 D1：此前**没有** element_present 分支 ⇒ default 返回 false ⇒
    // 任何 requiredEvidence 含 element_present 的业务契约在 VIL 里结构性不可能成立。
    // 而 planner 契约文本（planner.js P3/P6）明确鼓励把 element_present 写进 requiredEvidence，
    // contract.deriveContract 对 SEARCH_SUCCESS 也直接产出该子句 —— 缺口落在主链路上。
    // 存在性通道不得施加可操作性否决（C105 M3），故 requireActionable:false。
    case 'element_present': {
      const t = cl.expect || '';
      return !!t && elementExists(after, t, { requireActionable: false }).found;
    }
    // C124 D2/D4：原实现是 semanticResolver.resolve(t, after).length === 0 —— 两份缺陷叠加：
    //   ① 缺 contentLeaves ⇒ 目标以 div/span 形态**仍在页面上**时判「已消失」，
    //      于是 TOO_STRICT 误判为「业务结果其实达成了」（假阳性成功证据）；
    //   ② 存在性通道施加了 actionable 否决（C105 M3 明令禁止），进一步放大 ①。
    // 必须与 verification.js 的 element_absent 同口径：共用原语 + requireActionable:false。
    case 'element_absent': {
      const t = cl.expect || '';
      return !!t && !elementExists(after, t, { requireActionable: false }).found;
    }
    case 'field_value': {
      const tgt = cl.target || cl.expect || '';
      const cands = tgt ? semanticResolver.resolve(tgt, after) : [];
      if (!cands.length) return false;
      const st = cands[0].el.state || {};
      if (st.sensitive) return Number(st.valueLength || 0) > 0;
      // C73 D3（vault 注入修正，与 verification.js 同语义）：空期望 = 期望值未知（凭据执行时
      // 注入）→ 退化为「已填写」验证；includes('') 恒真（假阳性）与硬 fail-closed（误杀 vault）
      // 都不对。期望未知时验证「写入发生」。
      const want = String(cl.expect || '').trim();
      const actual = String(st.value || '').trim();
      if (!want) return actual.length > 0;
      return actual.toLowerCase().includes(want.toLowerCase());
    }
    case 'field_checked': {
      const tgt = cl.target || cl.expect || '';
      const cands = tgt ? semanticResolver.resolve(tgt, after) : [];
      if (!cands.length) return false;
      const st = cands[0].el.state || {};
      const want = String(cl.expect || 'checked');
      const checked = !!st.checked;
      return (want === 'unchecked') ? !checked : checked;
    }
    // C125：以下三个分支此前缺失 ⇒ 落 default:false（恒假）。
    // 危害方向：businessStatePresent 用于 4b「期望业务结果其实已达成 ⇒ TOO_STRICT」，
    // 恒假 ⇒ AND 契约只要含其中任一条就永远走不到 4b ⇒ 真实成功被 4c 判「证据不足」
    // 升级人工（HUMAN_ESCALATION 上升）。与 C124 D1（element_present 恒假）完全同族。
    // 主链路实证：planner 契约文本明确引导 LLM 产出 storage/login_state/url_pattern
    // （planner.js:86/103）；skillBuilder.js:284/369 直接产出 url_pattern 作为 observable。
    // 注意：login_state 的 4c 兜底只覆盖 expectedVerification.type 这一条路径，
    // businessState.requiredEvidence 里的 login_state 到不了 4c —— 同文件内的不对称（L6）。
    case 'login_state': return clause.evalLoginState(text).ok;
    case 'storage': return clause.evalStorage(cl, after).ok;
    // before 一并传入 ⇒ P2 无效证据守卫（动作前已匹配的恒真证据不算存在）与验证引擎同口径。
    case 'url_pattern': return clause.evalUrlPattern(cl, after, before).ok;
    default: return false;
  }
}

// 业务态契约是否在 after 中真实达成（按 evidenceLogic OR/AND 组合 requiredEvidence）。
function businessStatePresent(contract, after, before) {
  if (!contract || !after) return false;
  const clauses = contract.requiredEvidence || [];
  if (!clauses.length) return false;
  const logic = contract.evidenceLogic === 'OR' ? 'OR' : 'AND';
  let matched = 0;
  for (const cl of clauses) if (clausePresent(cl, after, before)) matched++;
  return logic === 'OR' ? matched > 0 : matched === clauses.length;
}

// B2：动作成功但目标字段为空（值未真正写入）→ 真实动作失败，应 RE_EXECUTE 而非 RECHECK。
function fieldExistsButEmpty(contract, after, action) {
  if (!contract || !action) return false;
  if (!['fill', 'select'].includes(action.type)) return false;
  const t = action.target || {};
  const tgt = t.semantic || t.field || t.text || '';
  if (!tgt) return false;
  const cands = semanticResolver.resolve(tgt, after);
  if (!cands.length) return false; // 元素都找不到 → 归 DOM_CHANGED 更合适
  const st = cands[0].el.state || {};
  if (st.sensitive) return Number(st.valueLength || 0) === 0;
  return !st.value || String(st.value).trim().length === 0;
}

// 支付/金融类动作（CRITICAL 子集，与 policy.js 保持一致）。验证失败时优先升级人工而非自主重试。
const SENSITIVE_TYPES = new Set(['purchase', 'payment', 'password_change', 'delete', 'update_account_settings', 'submit', 'login', 'logout']);

// 主分析函数（内部实现，外部统一经 analyze 包装以附加 verificationEvidence）
function _analyze({ beforeObservation, afterObservation, expectedVerification, actionResult, action } = {}) {
  const after = afterObservation || {};
  const before = beforeObservation || {};
  const actionOk = !!(actionResult && actionResult.success);
  const evidence = [];
  const loading = after.loadingState; // 'complete' | 'interactive' | 'loading' | undefined
  const net = after.networkState;     // 'idle' | 'pending' | undefined
  const diff = after.previousObservationDiff || {};
  const domChanged = !!diff.domChanged;
  // 敏感动作：CRITICAL 风险或命中敏感类型，验证失败时优先升级人工（避免自主重执行高风险动作）。
  const isSensitive = !!(action && (action.risk === 'CRITICAL' || SENSITIVE_TYPES.has(action.type)));

  // 1) 动作本身失败 → 真实失败
  if (!actionOk) {
    evidence.push('动作执行返回失败（actionResult.success=false），判定为真实动作失败');
    return {
      decision: DECISIONS.RE_EXECUTE,
      failureType: FAILURE_TYPES.ACTION_REAL_FAILURE,
      confidence: 0.9,
      evidence,
    };
  }

  // 2) 网络仍在进行 → 最终一致性（等）
  if (net === 'pending') {
    evidence.push('观察时刻仍有未完成网络请求（networkState=pending），判定为异步一致性延迟');
    return {
      decision: DECISIONS.WAIT,
      failureType: FAILURE_TYPES.EVENTUAL_CONSISTENCY,
      confidence: 0.8,
      evidence,
    };
  }

  // 3) 页面仍在加载 → 观察过早
  if (loading && loading !== 'complete') {
    evidence.push('页面加载状态=' + loading + '（非 complete），观察可能过早，建议重观察');
    return {
      decision: DECISIONS.RETRY_VERIFY,
      failureType: FAILURE_TYPES.OBSERVATION_DELAY,
      confidence: 0.78,
      evidence,
    };
  }

  // 4) 页面已稳定，动作成功，但验证失败 → 进入「结构/验证」判别
  // 4a) DOM 结构相比动作前发生显著变化 → 结构变化
  // 专项 §四：DOM_CHANGED 绝不≡SUCCESS，只表示「页面已变化」。正确闭环是
  // ACTION → DOM_CHANGED → Fresh Observation → Verification Contract → Re-evaluate，
  // 而非「直接重执行原动作 / 直接判 VERIFY_FAILED」。故此处返回 RECHECK/RETRY 类决策，
  // 让 runtime 进入内联 Observation Window（真实重新 capture observation + 重新验证，不重执行原动作）。
  // 仅当窗口内的 Fresh Observation 仍验证失败，才由上层 repair 兜底（含语义重定位）。
  if (domChanged) {
    evidence.push('动作后 DOM 指纹相对动作前发生显著变化（domChanged=true）→ 进入 Fresh Observation + Re-Verification（不重执行原动作）');
    return {
      decision: DECISIONS.RETRY_VERIFY,
      failureType: FAILURE_TYPES.DOM_CHANGED,
      confidence: 0.72,
      evidence,
    };
  }

  // 4b) 期望目标其实存在（只是验证规则未匹配）→ 验证过严
  // C132：★本三元式的两支是**同一个变量**，必须同口径 —— 左支业务态契约（C131 已含 P2），
  // 右支裸 verification。改前右支漏传 before ⇒ 同一逻辑场景仅因 planner 是否给出
  // verification 就得到相反诊断（实测：STATE_UNKNOWN vs VERIFICATION_TOO_STRICT）。
  const targetPresent = expectedVerification && expectedVerification.businessState
    ? businessStatePresent(expectedVerification.businessState, after, before)
    : expectedActuallyPresent(expectedVerification, after, before);
  if (targetPresent) {
    evidence.push('期望业务结果在观察中实际存在，但 verification 规则未匹配，判定为验证过严（可尝试替代状态判定）');
    return {
      decision: DECISIONS.RETRY_VERIFY,
      failureType: FAILURE_TYPES.VERIFICATION_TOO_STRICT,
      confidence: 0.68,
      evidence,
    };
  }

  // 4c) 稳定、动作成功、目标不存在、结构未变 → 证据不足，交由人工
  //     特殊：login_state 这类脆弱正则易误判，归为 TOO_STRICT 给 repair 一次替代机会，而非直接升级。
  if (expectedVerification && expectedVerification.type === 'login_state') {
    evidence.push('login_state 正则脆弱且未匹配，归为验证过严，交由 repair 替代态判定');
    return {
      decision: DECISIONS.RETRY_VERIFY,
      failureType: FAILURE_TYPES.VERIFICATION_TOO_STRICT,
      confidence: 0.6,
      evidence,
    };
  }

  evidence.push('页面稳定、动作成功、目标未观察到、结构未变 —— 证据不足以判定成功');

  // P4（Phase 2 ASYNC_PENDING）：页面稳定、动作成功、验证未通过，但存在「异步处理中」证据 →
  // 标记为 ASYNC_PENDING（业务结果尚未确定，但非失败、非成功）。不改变既有 SUCCESS/FAILURE 优先级，
  // 仅在「无成功、无真实失败」之后、UNKNOWN 之前插入此中间态，用于提高验证解释能力。
  // 安全：敏感动作（payment/financial/security）即使检测到 pending 也只升级人工（HUMAN_ESCALATE），
  // 绝不自动继续操作 / 重提交 / 付款。
  const asyncPending = detectAsyncPending(before, after);
  if (asyncPending.pending) {
    evidence.push('观察到异步处理中证据（' + asyncPending.signals.join('、') + '）—— 业务结果尚未确定，标记 ASYNC_PENDING');
    if (isSensitive) {
      return { decision: DECISIONS.HUMAN_ESCALATE, failureType: FAILURE_TYPES.ASYNC_PENDING, confidence: asyncPending.confidence, evidence };
    }
    return { decision: DECISIONS.RECHECK_OBSERVATION, failureType: FAILURE_TYPES.ASYNC_PENDING, confidence: asyncPending.confidence, evidence };
  }

  // 提交类动作：动作成功、页面稳定、业务态未确认、结构未变 → 标记为「提交结果未知」（SUBMIT_RESULT_UNKNOWN），
  // 区别于泛化 STATE_UNKNOWN。交由 repair / 升级层「查询结果落点」（URL/文本/后端态）而非盲目重提交。
  // 安全：敏感动作仍走 HUMAN_ESCALATE（不自主重提交），仅 failureType 更精确。
  if (action && action.type === 'submit') {
    evidence.push('提交动作成功、页面稳定、业务态未确认 —— 提交结果未知，需查询结果落点（URL/文本/后端态）');
    if (isSensitive) {
      return { decision: DECISIONS.HUMAN_ESCALATE, failureType: FAILURE_TYPES.SUBMIT_RESULT_UNKNOWN, confidence: 0.55, evidence };
    }
    return { decision: DECISIONS.RECHECK_OBSERVATION, failureType: FAILURE_TYPES.SUBMIT_RESULT_UNKNOWN, confidence: 0.5, evidence };
  }

  // B2：动作成功但目标字段为空（值未真正写入）→ 真实动作失败，应重执行而非重观察
  if (fieldExistsButEmpty(expectedVerification && expectedVerification.businessState, after, action)) {
    evidence.push('动作成功但目标字段为空（值未真正写入），判定为真实动作失败（需重执行）');
    return {
      decision: DECISIONS.RE_EXECUTE,
      failureType: FAILURE_TYPES.ACTION_REAL_FAILURE,
      confidence: 0.8,
      evidence,
    };
  }
  // 敏感/关键动作：不自主重试，直接升级人工（由人工判断是否重执行）。
  if (isSensitive) {
    evidence.push('动作属于敏感/关键类型，验证失败且证据不足，升级人工而非自主重执行');
    return {
      decision: DECISIONS.HUMAN_ESCALATE,
      failureType: FAILURE_TYPES.STATE_UNKNOWN,
      confidence: 0.55,
      evidence,
    };
  }
  // 设计红线（Phase 10.7）：STATE_UNKNOWN ≠ ACTION_REAL_FAILURE，不能直接放弃。
  // 先 RECHECK_OBSERVATION（重观察 + 重验证，不重执行），若窗口内仍无证据，再由上层升级人工。
  return {
    decision: DECISIONS.RECHECK_OBSERVATION,
    failureType: FAILURE_TYPES.STATE_UNKNOWN,
    confidence: 0.5,
    evidence,
  };
}

// 对外统一入口：在既有 _analyze 决策（failureType/decision 完全不变）之上，
// 仅附加 verificationEvidence（证据聚合），不修改任何既有返回字段。
function analyze(opts) {
  const result = _analyze(opts || {});
  result.verificationEvidence = aggregateEvidence(
    (opts || {}).beforeObservation,
    (opts || {}).afterObservation,
    (opts || {}).verificationWindow
  );
  return result;
}

module.exports = { analyze, aggregateEvidence, detectAsyncPending, FAILURE_TYPES, DECISIONS, isReobservableDecision };
