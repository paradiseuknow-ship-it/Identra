'use strict';

// STEP 3 —— Failure Diagnoser：统一失败诊断（纯函数，不执行任何动作）。
//
// 背景（STEP 0 取证）：
//   失败信息散落在 5 个互不相通的地方，没有任何一处能把它们拼成一个结论：
//     - errorClassifier：只看 error.code 字符串
//     - VIL（verificationIntelligence）：只看 DOM 差异，且 DOM_CHANGED ≠ 成功
//     - observation：只有 DOM，没有网络
//     - verify 恢复策略：`getPreActions() { return [] }` —— 零信息原样重试
//     - repairManager：3 次重试耗尽后才跑，且不带网络证据
//   后果：51.3% 的 VERIFY_FAILED 走的是「把同一个动作原样再执行一次」。
//
// 本模块把五路证据收敛成一个 Diagnosis：
//   { rootCause, category, confidence, retryPolicy, evidence[], findings[], summary }
//
// retryPolicy 语义（STEP 4 消费）：
//   'backoff'  —— 退避等待后重试同一动作（限流 / 5xx / 传输层失败）
//   'replan'   —— 换策略再试（换定位 / 重载 / 返回重进 / 修正输入 / 会话过期后重登）
//   'escalate' —— 继续尝试不可能成功，必须把「为什么失败」交给人
//                （验证码 / OTP / 权限 / 支付被拒 / 凭据错误 / 记录重复）
//   'none'     —— 无需重试（例如已明确成功的异步未决态）
//   'wait_only'—— CAP-L2 新增：只等待 + 重新观察，**绝不重放动作、绝不 reload**。
//                 专为「支付异步处理中」设计 —— 支付提交后重复提交 = 重复扣款，
//                 而 POST 之后 reload 会触发浏览器的「确认重新提交表单」对话框，
//                 一旦被自动确认就是第二次扣款。这是资金损失级风险，不是洁癖。
//
// 红线：
//   - 不判定成功，不修改 verification 结果，不动 success definition。
//   - 遇到验证码 / OTP / 风控一律 escalate，绝不产出任何绕过方案。
//   - 输入缺失时降级为保守策略（backoff/replan），绝不假装知道根因。

const detector = require('../network/businessErrorDetector');
// CAP-L2：支付五态（authorized / declined / 3ds_challenge / pending / failed）
const paymentStateClassifier = require('../paymentStateClassifier');

// 业务/HTTP 诊断码 → 重试策略
const RETRY_POLICY_BY_CODE = {
  BUSINESS_DUPLICATE_EMAIL: 'escalate',
  BUSINESS_DUPLICATE_RECORD: 'escalate',
  BUSINESS_INVALID_CREDENTIAL: 'escalate',
  BUSINESS_CAPTCHA_REQUIRED: 'escalate',
  BUSINESS_OTP_REQUIRED: 'escalate',
  BUSINESS_PAYMENT_FAILED: 'escalate',
  BUSINESS_PERMISSION_DENIED: 'escalate',
  BUSINESS_RATE_LIMITED: 'backoff',
  BUSINESS_SERVER_ERROR_MESSAGE: 'backoff',
  BUSINESS_VALIDATION_FAILED: 'replan',
  BUSINESS_SESSION_EXPIRED: 'replan',

  // Phase 15.0（GAP-1）：真实站点 challenge / 外部阻断 —— 一律升级人工，绝不绕过
  EXTERNAL_BLOCK: 'escalate',
  INTERACTIVE_CHALLENGE: 'escalate',

  HTTP_401_UNAUTHORIZED: 'replan',
  HTTP_403_FORBIDDEN: 'escalate',
  HTTP_404_NOT_FOUND: 'replan',
  HTTP_409_CONFLICT: 'escalate',
  HTTP_410_GONE: 'escalate',
  HTTP_419_SESSION_EXPIRED: 'replan',
  HTTP_422_VALIDATION_FAILED: 'replan',
  HTTP_429_RATE_LIMITED: 'backoff',
  HTTP_5XX_SERVER_ERROR: 'backoff',

  NETWORK_REQUEST_FAILED: 'backoff',
  JS_RUNTIME_ERROR: 'replan',
  NO_OBSERVABLE_EFFECT: 'replan',

  // ── CAP-L2 支付五态 ──
  // 取代单一的 BUSINESS_PAYMENT_FAILED 粗桶：四种结局的重试语义完全不同，
  // 压成一个桶会导致「还在处理中」被当成「必然失败」直接丢给人工。
  PAYMENT_AUTHORIZED: 'none',
  PAYMENT_DECLINED: 'escalate',
  PAYMENT_THREE_DS_CHALLENGE: 'escalate',   // 红线：绝不绕过 3DS / 风控
  PAYMENT_PENDING: 'wait_only',
  PAYMENT_FAILED: 'escalate',
};

// 错误类别（errorClassifier 产出）→ 兜底策略
const RETRY_POLICY_BY_CATEGORY = {
  ELEMENT_NOT_FOUND: 'replan',
  ELEMENT_NOT_INTERACTABLE: 'replan',
  ELEMENT_CHANGED: 'replan',
  TIMEOUT: 'backoff',
  PAGE_NOT_READY: 'backoff',
  NETWORK_ERROR: 'backoff',
  SERVER_ERROR: 'backoff',
  NAVIGATION_FAILED: 'replan',
  VERIFICATION_FAILED: 'replan',
  ASYNC_PENDING: 'backoff',
  SUBMIT_RESULT_UNKNOWN: 'replan',
  EVENTUAL_CONSISTENCY: 'backoff',
  OBSERVATION_DELAY: 'backoff',
  VERIFICATION_TOO_STRICT: 'replan',
  STATE_UNKNOWN: 'replan',
  ACTION_REAL_FAILURE: 'replan',
  BROWSER_CRASH: 'replan',
  CREDENTIAL_MISSING: 'escalate',
  APPROVAL_REQUIRED: 'escalate',
  SESSION_EXPIRED: 'replan',
  HTTP_FORBIDDEN: 'escalate',
  OBSTRUCTION: 'replan',
  DOM_CHANGED: 'replan',
  UNKNOWN: 'replan',
};

const POLICY_CONFIDENCE = { escalate: 0.9, backoff: 0.75, replan: 0.6, none: 0.5, wait_only: 0.7 };

const POLICY_LABEL = {
  backoff: '退避后重试同一动作',
  replan: '换策略重试',
  escalate: '升级人工',
  none: '不重试',
  wait_only: '仅等待后重新观察（不重放动作、不 reload）',
};

// retryPolicy → 恢复策略的「动作前序列」表（STEP 4 消费，单一真源）。
// runPreAction 支持：wait / waitLong / reload / back / back+reload。
//
// 设计原则：前置动作必须是「能改变失败前提」的动作，而不是仪式性地等一下再原样重打。
const PRE_ACTIONS_BY_POLICY = {
  // 限流 / 5xx / 传输层：等待是唯一有意义的动作，立刻重打只会再撞一次墙
  backoff: ['waitLong', 'waitLong', 'reload'],
  // 上下文失效 / 点空 / 定位漂移 / 会话过期：先给异步留时间，再重载读服务端权威状态。
  // 刻意不使用 back：验证失败时动作可能已经提交成功，回退浏览历史会把已完成的业务操作撤销，
  // 这比「重试失败」严重得多。重载只会重新读取服务端状态，不会撤销已提交的数据。
  replan: ['waitLong', 'reload'],
  // 继续重试不可能成功（验证码 / OTP / 权限 / 支付被拒 / 凭据错误 / 记录重复）
  // → 不做任何前置动作，由 runtime 直接收口升级，把「为什么失败」交给人。
  escalate: [],
  none: [],
  // CAP-L2：支付异步处理中。刻意**只有等待、没有 reload** ——
  // 支付 POST 之后 reload 会触发「确认重新提交表单」，一旦被自动确认即重复扣款。
  // 也不放 waitLong 两次：唯一有意义的动作是给异步结果留出时间，然后重新观察。
  wait_only: ['waitLong'],
};

function pickFromFindings(detection) {
  const blocking = detection.findings.filter((f) => f.severity === 'blocking');
  const pool = blocking.length ? blocking : detection.findings;
  if (!pool.length) return null;
  // 优先级：网络状态码 > 响应体 > 传输层失败 > JS 异常 > 页面文本 > 观察 diff
  // （HTTP 状态码是最客观的证据，不受文案翻译/措辞影响）
  //
  // 注意：此处**不能**写 `order[s] || 9` —— 排名 0 是 falsy，会把最客观的状态码证据
  // 排到全场最后（低于页面文本与 diff），使诊断优先采信最不可靠的证据源。
  const order = { 'network.status': 0, 'network.body': 1, 'network.failed': 2, 'page.pageerror': 3, 'page.text': 4, 'observation.diff': 5 };
  const rank = (s) => (Object.prototype.hasOwnProperty.call(order, s) ? order[s] : 9);
  return pool.slice().sort((a, b) => rank(a.source) - rank(b.source))[0];
}

/**
 * 统一诊断。
 *
 * @param {object} input
 *   error          { code, message }（可空）
 *   category       errorClassifier 产出的类别（可空；缺省时对 error.code 做一次兜底映射）
 *   network        networkObserver.snapshot 输出（可空）
 *   pageText       页面可见文本（可空）
 *   pageState      pageStateClassifier 输出（可空）
 *   diff           observation.previousObservationDiff（可空）
 *   attempted      是否刚执行过动作（默认 true）
 *   sinceTs        只看该时间之后的证据
 *   stateResetByRepair 本 step 恢复链中是否发生过 reload/back（状态重置型 repair）；
 *                  为 true 时 page.text 类 blocking 证据降级（次生文案不作为业务判定）
 *   vilFailureType VIL 的 failureType（可空，仅作证据补充）
 * @returns {{ rootCause, category, confidence, retryPolicy, evidence: string[], findings: Array, summary: string, silentFailure: boolean }}
 */
function diagnose(input = {}) {
  const error = input.error || null;
  const category = input.category || null;
  const vilFailureType = input.vilFailureType || null;

  // 诊断是「增强能力」，绝不能成为新的故障源：网络快照来自浏览器事件回调，
  // 结构上不可完全信任（page 被关闭 / getter 抛错 / 循环引用）。任何异常都降级为
  // 「无网络证据」，退回按错误码的保守推断 —— 绝不把调用方（恢复链路）带崩。
  let detection = { findings: [], primary: null, hasBlockingError: false, silentFailure: false, summary: '诊断不可用' };
  try {
    detection = detector.detect({
      network: input.network || null,
      pageText: input.pageText || '',
      attempted: input.attempted !== false,
      sinceTs: input.sinceTs || 0,
      diff: input.diff || null,
    });
  } catch (e) {
    detection = { findings: [], primary: null, hasBlockingError: false, silentFailure: false, summary: '网络证据不可用：' + String(e.message || e).slice(0, 80) };
  }

  const evidence = [];
  if (error && error.code) evidence.push('动作错误码=' + error.code);
  if (category) evidence.push('错误类别=' + category);
  if (vilFailureType) evidence.push('VIL 失败类型=' + vilFailureType);
  if (input.pageState && input.pageState.state) {
    evidence.push('页面状态=' + input.pageState.state
      + ((input.pageState.capabilities || []).length ? ' 能力=[' + input.pageState.capabilities.join(',') + ']' : ''));
  }

  let pick = pickFromFindings(detection);
  if (pick) evidence.push('检测到 ' + pick.code + '（来源 ' + pick.source + '）：' + pick.hint);

  // ── stateResetByRepair 证据降级（2026-08-31，分类纯度修复）──
  // 背景（run9 rw.001 实证）：replan 恢复链的 reload 会清空未提交的表单（浏览器标准行为），
  // 重试的提交动作实际是「空表单重提交」，站点随后显示的错误文案（如「邮箱或密码错误」）
  // 是 repair 自身制造的次生结果，不是对原始凭据/原始提交的业务判定。
  // 若此时采信 page.text 类 blocking 证据 → 工程失败（VERIFY_FAILED）被误升级为
  // BUSINESS_INVALID_CREDENTIAL（可信升级）→ POLICY_BLOCK 污染分类口径。
  // 降级规则：本 step 恢复链中发生过 reload/back（状态重置型 repair）时，page.text 来源的
  // blocking 证据不作为业务性「不可重试」判定依据；network/pageerror 等客观证据不受影响。
  // 关键性质：真实凭据错误在第一次失败时（reload 尚未发生）即正常升级 —— 本规则不影响该路径。
  // 降级方向是「多走一轮重试」而非「转 SUCCESS」，不触碰验证门槛。
  if (pick && input.stateResetByRepair === true && pick.source === 'page.text' && pick.severity === 'blocking') {
    evidence.push('证据降级: stateResetByRepair —— 该页面文案出现于 repair（reload/back）重置页面状态之后，可能为空表单重新提交的次生结果，不作为业务性不可重试判定依据');
    const rest = detection.findings.filter((f) => f !== pick);
    pick = pickFromFindings({ findings: rest });
  }

  // ── 动作上下文守卫（2026-09-04，run5 rw.026 实证）：凭据类 page.text 证据的动作一致性校验 ──
  // 背景：任务此前已认证成功（登录 4 步全 SUCCESS），session 丢失回登录页后 pageText 含
  // 凭据类文案（登录表单标签/横幅）；与认证无关的步骤（导出确认）失败被误升级
  // BUSINESS_INVALID_CREDENTIAL（retryPolicy=escalate），hint「更换凭据/找回密码」误导人工处置。
  // 规则：凭据类 page.text blocking 证据仅在「本步动作确实指向认证表单」（fill 密码/邮箱字段、
  // click/submit 登录按钮）时保留；其余动作上下文一律降级 —— 与 stateResetByRepair 同构，
  // 降级方向是「多走一轮重试」而非「转 SUCCESS」，不触碰验证门槛/成功定义。
  // network/pageerror 等客观证据不受影响（真实 401/403 响应仍可正常升级）。
  const isAuthAction = (() => {
    const a = input.currentAction;
    if (!a || typeof a !== 'object') return false;
    const t = a.target || {};
    const sem = String(t.semantic || t.field || t.selector || t.role || '').toLowerCase();
    const desc = String(t.description || '').toLowerCase();
    if (a.type === 'fill') {
      return /pass(word|wd)?|pwd|e-?mail|user(name)?|account|账号|密码|邮箱|用户名/.test(sem)
        || /pass(word|wd)?|pwd|e-?mail|user(name)?/.test(desc);
    }
    if (a.type === 'submit' || a.type === 'click') {
      return /log[-_ ]?in|sign[-_ ]?in|登录|登入|签入/.test(sem) || /log[-_ ]?in|sign[-_ ]?in|登录|登入|签入/.test(desc);
    }
    return false;
  })();
  if (pick && pick.code === 'BUSINESS_INVALID_CREDENTIAL' && pick.source === 'page.text'
    && ('currentAction' in input) && input.currentAction !== undefined && !isAuthAction) {
    // 兼容契约（test_state_reset_evidence_guard A2/A6）：未提供 currentAction 的旧调用方
    // 保持原判定不降级 —— 守卫只作用于「显式提供动作上下文且与认证无关」的真实执行路径
    // （recoveryManager 唯一诊断入口总是传 step.action）。
    evidence.push('证据降级: actionContextMismatch —— 凭据类文案来自页面静态文本，而本步动作（'
      + ((input.currentAction && input.currentAction.type) || '?') + '）与认证表单无关；更可能是会话丢失回到登录页而非凭据错误');
    const rest = detection.findings.filter((f) => f !== pick);
    pick = pickFromFindings({ findings: rest });
  }

  // ── Phase 15.0（GAP-1）：真实站点 challenge / 外部阻断证据接入 ──
  // 来源：observation.challenge（Phase 14 challengeDetector 三层判定，observation.inspect
  // Node 侧携带）。只识别、不处理 —— externalBlock / interactiveChallenge 一律 escalate
  // （HUMAN_ESCALATION），绝不产出绕过方案、绝不换环境重试（Phase 14/15 硬边界）。
  // 优先级刻意最高（比 HTTP_403_FORBIDDEN 更具体）：403 + 页面/厂商特征 = 观测级
  // 外部阻断；challenge 证据来自页面与网络实测，属 Observed 层，非 Inferred/Unknown。
  // 403 但无任何 challenge 特征时 challenge.challenge=false，此处不接管，仍由
  // HTTP_403_FORBIDDEN 兜底 —— 不把「无特征 403」伪造成已归因结论（保留三层证据）。
  const challenge = input.challenge || null;
  if (challenge && challenge.challenge) {
    const isBlock = challenge.externalBlock && !challenge.interactive;
    pick = {
      code: isBlock ? 'EXTERNAL_BLOCK' : 'INTERACTIVE_CHALLENGE',
      severity: 'blocking',
      source: 'challenge.detection',
      hint: isBlock
        ? '外部硬阻断（阻断状态码 × WAF/风控特征），继续自动操作无意义，必须转人工；禁止换 IP/指纹重试绕过'
        : '页面出现交互式人机验证，需人工完成；系统绝不尝试绕过验证',
    };
    evidence.push('Challenge=' + pick.code + '（kind=' + (challenge.kind || 'unknown') + '，来源=页面/网络实测 observed）: '
      + (challenge.evidence || []).slice(0, 4).join('; '));
  }

  // ── CAP-L2：把粗粒度的 BUSINESS_PAYMENT_FAILED 细分成支付五态 ──
  // 触发条件刻意保守：只在「完全没有其它证据」或「唯一证据就是那个粗支付桶」时生效，
  // 绝不覆盖更客观的证据（HTTP 状态码 / 验证码 / OTP / 权限）。
  // 目的不是抢诊断权，而是补上此前完全缺失的「付没付成」判定 ——
  // 改造前「支付还在处理中」与「卡被拒付」共用同一个 escalate，两者处置方式完全不同。
  let paymentState = null;
  try {
    paymentState = paymentStateClassifier.classify({
      network: input.network || null,
      pageText: input.pageText || '',
    });
  } catch (e) { paymentState = null; }
  if (paymentState && paymentState.state !== 'unknown') {
    evidence.push('支付状态=' + paymentState.state + '（来源 ' + paymentState.source + '）：' + paymentState.hint);
  }
  if (paymentState && paymentState.state !== 'unknown' && (!pick || pick.code === 'BUSINESS_PAYMENT_FAILED')) {
    pick = {
      code: paymentStateClassifier.codeOf(paymentState.state),
      severity: paymentState.state === 'authorized' ? 'info' : 'blocking',
      source: paymentState.source,
      hint: paymentState.hint,
    };
  }

  const rootCause = pick ? pick.code : (category || (error && error.code) || 'UNKNOWN');
  const retryPolicy = (pick && RETRY_POLICY_BY_CODE[pick.code])
    || (category && RETRY_POLICY_BY_CATEGORY[category])
    || 'replan';

  // 置信度：有网络/运行时证据 > 只有错误码
  let confidence = POLICY_CONFIDENCE[retryPolicy] || 0.5;
  if (pick && pick.source && pick.source.startsWith('network')) confidence = Math.min(0.97, confidence + 0.15);
  if (!pick) confidence = Math.min(confidence, 0.55);

  const summary = pick
    ? `${rootCause}：${pick.hint}（建议：${POLICY_LABEL[retryPolicy] || retryPolicy}）`
    : `${rootCause}：无网络/运行时证据，按错误类别保守推断（建议：${POLICY_LABEL[retryPolicy] || retryPolicy}）`;

  return {
    rootCause,
    category: category || 'UNKNOWN',
    confidence: Number(confidence.toFixed(2)),
    retryPolicy,
    evidence,
    findings: detection.findings,
    silentFailure: detection.silentFailure,
    // CAP-L2：支付五态（未检测到时为 unknown）。审计与前端时间线消费，
    // 不改变任何既有判定，只是把此前丢失的「付没付成」信息暴露出来。
    paymentState: paymentState ? paymentState.state : 'unknown',
    summary,
  };
}

/**
 * 从「一次失败动作的现场」直接产出 Diagnosis。
 * 这是 runtime/recoveryManager 的唯一入口：调用方不必知道证据散落在 observation 的哪些字段里。
 *
 * @param {object|null} error       工具/验证错误（可含 failureType）
 * @param {string|null} category    errorClassifier 产出的类别
 * @param {object|null} observation 动作后的观察快照（含 network / textSummary / previousObservationDiff）
 * @param {object} extra            { vilFailureType, pageState, diff, attempted, sinceTs }
 */
function fromObservation(error, category, observation, extra = {}) {
  const obs = observation || {};
  return diagnose({
    error,
    category,
    vilFailureType: extra.vilFailureType || (error && error.failureType) || null,
    network: obs.network || null,
    // Phase 15.0（GAP-1）：observation.inspect 携带的 challenge 检测结果
    challenge: obs.challenge || null,
    pageText: obs.textSummary || obs.visibleText || '',
    pageState: extra.pageState || null,
    diff: obs.previousObservationDiff || extra.diff || null,
    attempted: extra.attempted !== false,
    sinceTs: extra.sinceTs || 0,
    stateResetByRepair: extra.stateResetByRepair === true,
    // 动作上下文守卫输入：保持「未传」语义（undefined）—— undefined=旧调用方保持原判定；
    // 显式 null（recoveryManager：step.action 为空）= 动作未知，保守降级
    currentAction: extra.currentAction === undefined ? undefined : (extra.currentAction || null),
  });
}

module.exports = {
  diagnose,
  fromObservation,
  PRE_ACTIONS_BY_POLICY,
  RETRY_POLICY_BY_CODE,
  RETRY_POLICY_BY_CATEGORY,
};
