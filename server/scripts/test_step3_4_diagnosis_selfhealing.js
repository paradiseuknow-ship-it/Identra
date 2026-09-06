'use strict';
// test_step3_4_diagnosis_selfhealing.js — STEP 3 统一诊断器 + STEP 4 自愈接线专项测试
//
// 背景（STEP 0 运行时取证）：
//   失败证据散落在 5 个互不相通的地方（error.code / VIL failureType / 观察 diff / 页面文本 / 网络），
//   没有任何一处把它们拼成一个结论。于是 recovery/strategies/verify.js 的
//   `getPreActions() { return [] }` 让 51.3% 的 VERIFY_FAILED 走「零信息原样重试」——
//   页面明明写着「该邮箱已被注册」，系统却把同一个注册请求又发了 3 遍。
//
// 本测试锁定四件事：
//   1. 诊断器能从「HTTP 200 + 业务错误体」里读出真根因，并给出正确的 retryPolicy
//   2. 诊断器在没有证据时**降级**，不假装知道根因（置信度封顶）
//   3. verify/generic 策略真的按诊断决定前置动作（不再是恒返回 [] 的空壳）
//   4. 接线：recoveryManager / runtime / repairManager 真的消费诊断，且 escalate 时
//      **不再重复执行动作**、**不再走 replan** 、**不再花一次 LLM 去重分类**
//
// 红线断言：验证码 / OTP / 支付被拒 / 凭据错误 一律 escalate，
//          且源码中不得出现任何绕过验证码 / 3DS / 风控的实现。

const fs = require('fs');
const path = require('path');

const diagnoser = require('../agent/diagnosis/failureDiagnoser');
const detector = require('../agent/network/businessErrorDetector');
const verifyStrategy = require('../agent/recovery/strategies/verify');
const genericStrategy = require('../agent/recovery/strategies/generic');
const recoveryManager = require('../agent/recovery/recoveryManager');
const tools = require('../agent/tools');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
const srcOf = (rel) => fs.readFileSync(path.join(__dirname, '..', 'agent', rel), 'utf8');

// ── 网络快照夹具（结构与 networkObserver.snapshot 输出一致）──────────────────
function net(over = {}) {
  return Object.assign({
    attached: true, pending: 0, sinceTs: 0,
    counts: { requests: 1, completed: 1, failures: 0, api: 1, status4xx: 0, status5xx: 0, consoleErrors: 0, consoleWarnings: 0, pageErrors: 0 },
    failures: [], apiResponses: [], console: [], pageErrors: [],
    lastRequestAt: Date.now(), lastResponseAt: Date.now(),
  }, over);
}
const apiRes = (status, body) => ({
  method: 'POST', url: 'https://api.example.com/v1/submit', resourceType: 'fetch',
  postPreview: null, at: Date.now(), status, failed: false, failureText: null,
  contentType: 'application/json', bodyPreview: body, ms: 120,
});
const noDiff = {
  domChanged: false, textChanged: false, elementStateChanged: false,
  keyTextChanged: false, pageStructureChanged: false, urlChanged: false,
};

(async () => {
  // ───────────────────────────────────────────────────────
  section('Case 1  诊断器：读出「HTTP 200 里的真实业务失败」');
  {
    // 1.1 核心场景：注册接口返回 200 + {"error":"email already registered"}
    const d = diagnoser.diagnose({
      error: { code: 'VERIFY_FAILED', message: 'required unmet: text_present' },
      category: 'VERIFICATION_FAILED',
      network: net({ apiResponses: [apiRes(200, '{"error":"email already registered"}')] }),
    });
    ok('1.1 根因识别为邮箱重复', d.rootCause === 'BUSINESS_DUPLICATE_EMAIL', d.rootCause);
    ok('1.2 重试策略 = escalate（不可能靠重试成功）', d.retryPolicy === 'escalate', d.retryPolicy);
    ok('1.3 网络证据提升置信度 > 0.9', d.confidence > 0.9, String(d.confidence));
    ok('1.4 evidence 含来源标注', d.evidence.some((e) => e.includes('network.body')), JSON.stringify(d.evidence));
    ok('1.5 summary 可被人读懂', /邮箱已被注册/.test(d.summary), d.summary);

    // 1.6 支付被拒
    // CAP-L2（2026-08-29）：原先这里断言粗桶 BUSINESS_PAYMENT_FAILED。支付五态上线后，
    // 粗桶被细分为 PAYMENT_DECLINED —— 这正是 CAP-L2 的目的（拒付/3DS/处理中/失败
    // 四种结局的处置方式完全不同，压成一个桶会让「还在处理中」被误判成必然失败）。
    // 断言改为「必须是 PAYMENT_* 且仍为 escalate」，既锁住升级语义，又允许后续继续细化。
    const p = diagnoser.diagnose({ category: 'VERIFICATION_FAILED', network: net({ apiResponses: [apiRes(200, '{"error":"card_declined"}')] }) });
    ok('1.6 支付被拒 → PAYMENT_DECLINED/escalate',
      p.rootCause === 'PAYMENT_DECLINED' && p.retryPolicy === 'escalate', p.rootCause + '/' + p.retryPolicy);

    // 1.7 记录重复（通用语义，非站点特定）
    const dup = diagnoser.diagnose({ category: 'UNKNOWN', network: net({ apiResponses: [apiRes(200, '{"message":"record already exists"}')] }) });
    ok('1.7 记录已存在 → escalate', dup.rootCause === 'BUSINESS_DUPLICATE_RECORD' && dup.retryPolicy === 'escalate', dup.rootCause + '/' + dup.retryPolicy);
  }

  // ───────────────────────────────────────────────────────
  section('Case 2  诊断器：HTTP 状态码语义 → 正确的重试策略');
  {
    const cases = [
      [429, 'HTTP_429_RATE_LIMITED', 'backoff', '限流应退避而非换策略'],
      [503, 'HTTP_5XX_SERVER_ERROR', 'backoff', '5xx 应退避'],
      [401, 'HTTP_401_UNAUTHORIZED', 'replan', '未授权应换路径（重新登录）'],
      [404, 'HTTP_404_NOT_FOUND', 'replan', '404 应重新定位入口'],
      [422, 'HTTP_422_VALIDATION_FAILED', 'replan', '校验失败应修正输入'],
      [403, 'HTTP_403_FORBIDDEN', 'escalate', '无权限重试无意义'],
      [409, 'HTTP_409_CONFLICT', 'escalate', '冲突（已存在）重试无意义'],
    ];
    let i = 0;
    for (const [status, code, policy, why] of cases) {
      i += 1;
      const d = diagnoser.diagnose({
        category: 'UNKNOWN',
        network: net({ counts: Object.assign(net().counts, { failures: 1 }), failures: [apiRes(status, null)] }),
      });
      ok(`2.${i} ${status} → ${code}/${policy}（${why}）`, d.rootCause === code && d.retryPolicy === policy, d.rootCause + '/' + d.retryPolicy);
    }
  }

  // ───────────────────────────────────────────────────────
  section('Case 3  诊断器：无证据时必须降级，不假装知道根因');
  {
    const d = diagnoser.diagnose({ error: { code: 'VERIFY_FAILED' }, category: 'VERIFICATION_FAILED' });
    ok('3.1 无网络证据时退化为错误码兜底', d.rootCause === 'VERIFICATION_FAILED', d.rootCause);
    ok('3.2 置信度封顶 0.55（不得高置信度编造根因）', d.confidence <= 0.55, String(d.confidence));
    ok('3.3 无证据时策略保守 = replan', d.retryPolicy === 'replan', d.retryPolicy);
    ok('3.4 summary 明确声明无证据', /无网络\/运行时证据/.test(d.summary), d.summary);

    const empty = diagnoser.diagnose();
    ok('3.5 空输入不崩溃', empty && empty.rootCause === 'UNKNOWN' && empty.retryPolicy === 'replan', JSON.stringify(empty.rootCause));

    // 网络层本身抛错时不得把恢复链路带崩
    const evil = new Proxy({}, { get() { throw new Error('boom'); } });
    const d2 = diagnoser.diagnose({ category: 'VERIFICATION_FAILED', network: evil });
    ok('3.6 网络对象异常时诊断器不抛错', d2 && typeof d2.retryPolicy === 'string', String(d2 && d2.retryPolicy));
  }

  // ───────────────────────────────────────────────────────
  section('Case 4  诊断器：静默失败（点了空气）');
  {
    const d = diagnoser.diagnose({
      category: 'VERIFICATION_FAILED',
      network: net({ counts: Object.assign(net().counts, { requests: 0, completed: 0, api: 0 }), apiResponses: [], lastRequestAt: null, lastResponseAt: null }),
      diff: noDiff, attempted: true,
    });
    ok('4.1 识别为无可见效果', d.rootCause === 'NO_OBSERVABLE_EFFECT', d.rootCause);
    ok('4.2 策略 = replan（换目标，不是再点一次）', d.retryPolicy === 'replan', d.retryPolicy);
    ok('4.3 silentFailure 标记为真', d.silentFailure === true, String(d.silentFailure));

    const withEffect = diagnoser.diagnose({
      category: 'VERIFICATION_FAILED',
      network: net({ apiResponses: [apiRes(200, '{"ok":true}')] }),
      diff: Object.assign({}, noDiff, { textChanged: true }), attempted: true,
    });
    ok('4.4 有网络活动 + DOM 变化时不误判为静默失败', withEffect.silentFailure === false, String(withEffect.silentFailure));
  }

  // ───────────────────────────────────────────────────────
  section('Case 5  红线：人机验证 / OTP 一律 escalate');
  {
    const cap = diagnoser.diagnose({ category: 'VERIFICATION_FAILED', network: net(), pageText: '请完成人机验证后继续', attempted: true });
    ok('5.1 人机验证 → escalate', cap.rootCause === 'BUSINESS_CAPTCHA_REQUIRED' && cap.retryPolicy === 'escalate', cap.rootCause + '/' + cap.retryPolicy);
    ok('5.2 升级原因里写明需人工介入', /人工/.test(cap.summary), cap.summary);

    const otp = diagnoser.diagnose({ category: 'VERIFICATION_FAILED', network: net(), pageText: '请输入短信验证码', attempted: true });
    ok('5.3 OTP → escalate', otp.rootCause === 'BUSINESS_OTP_REQUIRED' && otp.retryPolicy === 'escalate', otp.rootCause + '/' + otp.retryPolicy);

    // 未执行动作时不得把静态文案误判成错误（页面上有「验证码」字样 ≠ 需要验证）
    const idle = diagnoser.diagnose({ category: 'TIMEOUT', network: net(), pageText: '请输入短信验证码', attempted: false });
    ok('5.4 未执行动作时不扫描页面文本（避免误判静态文案）', idle.rootCause !== 'BUSINESS_OTP_REQUIRED', idle.rootCause);

    // [误升级防护] 「发送验证码」是登录页上最常见的按钮标签，绝不能据此升级人工
    let n = 4;
    for (const label of ['发送验证码', '获取验证码', '使用验证码登录', '验证码登录', 'Send verification code']) {
      n += 1;
      const fp = diagnoser.diagnose({ category: 'VERIFICATION_FAILED', network: net(), pageText: label, attempted: true });
      ok(`5.${n} 按钮标签「${label}」不得误判为需要 OTP`, fp.rootCause !== 'BUSINESS_OTP_REQUIRED', fp.rootCause);
    }
    // 真正的「被要求输入」必须能识别
    for (const label of ['请输入短信验证码', '验证码已发送，请查收', 'Verification code is invalid', 'Enter the one-time code']) {
      n += 1;
      const tp = diagnoser.diagnose({ category: 'VERIFICATION_FAILED', network: net(), pageText: label, attempted: true });
      ok(`5.${n} 要求句式「${label}」必须识别为 OTP`, tp.rootCause === 'BUSINESS_OTP_REQUIRED', tp.rootCause);
    }
  }

  // ───────────────────────────────────────────────────────
  section('Case 2b 证据优先级：状态码 > 响应体 > 传输层 > JS > 页面文本 > diff');
  {
    // 回归防线：`order[s] || 9` 的 falsy-0 陷阱曾把最客观的状态码证据排到全场最后。
    const d = diagnoser.diagnose({
      category: 'VERIFICATION_FAILED',
      network: net({
        apiResponses: [apiRes(429, '{"error":"rate limited"}')],
        pageErrors: [{ message: 'x is not a function', at: Date.now() }],
      }),
      pageText: '服务器错误',
      diff: noDiff,
      attempted: true,
    });
    ok('2b.1 状态码证据优先于响应体语义', d.rootCause === 'HTTP_429_RATE_LIMITED', d.rootCause);
    ok('2b.2 状态码证据优先于页面文本', d.findings[0].source === 'network.status', d.findings[0].source);
    ok('2b.3 状态码 0 号排名未被 falsy 陷阱吞掉',
      Object.values({ 'network.status': 0 }).length === 1 && (0 || 9) === 9 && d.rootCause === 'HTTP_429_RATE_LIMITED');
  }

  // ───────────────────────────────────────────────────────
  section('Case 6  fromObservation：从现场观察自动取证据（调用方不必知道字段位置）');
  {
    const observation = {
      url: 'https://example.com/signup',
      textSummary: '注册',
      network: net({ apiResponses: [apiRes(429, '{"error":"rate limited"}')] }),
      previousObservationDiff: Object.assign({}, noDiff, { textChanged: true }),
    };
    const d = diagnoser.fromObservation(
      { code: 'VERIFY_FAILED', failureType: 'EVENTUAL_CONSISTENCY' },
      'VERIFICATION_FAILED',
      observation,
      { attempted: true },
    );
    ok('6.1 抽出网络证据', d.rootCause === 'HTTP_429_RATE_LIMITED', d.rootCause);
    ok('6.2 抽出 VIL failureType 作为证据', d.evidence.some((e) => e.includes('EVENTUAL_CONSISTENCY')), JSON.stringify(d.evidence));
    ok('6.3 抽出错误码与类别', d.evidence.some((e) => e.includes('VERIFY_FAILED')) && d.evidence.some((e) => e.includes('VERIFICATION_FAILED')));

    const d2 = diagnoser.fromObservation({ code: 'ELEMENT_NOT_FOUND' }, 'ELEMENT_NOT_FOUND', null, {});
    ok('6.4 observation 缺失时不崩溃', d2 && d2.retryPolicy === 'replan', String(d2 && d2.retryPolicy));
  }

  // ───────────────────────────────────────────────────────
  section('Case 7  策略：前置动作由诊断驱动（不再是恒返回 [] 的空壳）');
  {
    ok('7.1 无诊断时向后兼容返回 []', verifyStrategy.getPreActions(1).length === 0);
    ok('7.2 escalate 不做任何前置动作（等着重试毫无意义）',
      verifyStrategy.getPreActions(1, { diagnosis: { retryPolicy: 'escalate' } }).length === 0);
    ok('7.3 backoff 首选实质等待而非 800ms 形式等待',
      verifyStrategy.getPreActions(1, { diagnosis: { retryPolicy: 'backoff' } })[0] === 'waitLong',
      JSON.stringify(verifyStrategy.getPreActions(1, { diagnosis: { retryPolicy: 'backoff' } })));

    const replanSeq = verifyStrategy.getPreActions(1, { diagnosis: { retryPolicy: 'replan' } });
    ok('7.4 replan 序列非空', replanSeq.length > 0, JSON.stringify(replanSeq));
    ok('7.5 [安全性] replan 序列绝不含 back —— 验证失败时动作可能已提交成功，'
      + '回退浏览历史会撤销已完成的业务操作，比重试失败严重得多',
      !replanSeq.some((s) => String(s).startsWith('back')), JSON.stringify(replanSeq));

    ok('7.6 generic 策略同样消费诊断（UNKNOWN 不代表没证据）',
      genericStrategy.getPreActions(1, { diagnosis: { retryPolicy: 'backoff' } })[0] === 'waitLong');
    ok('7.7 generic 无诊断时保持原行为', genericStrategy.getPreActions(1).length === 0);

    const table = diagnoser.PRE_ACTIONS_BY_POLICY;
    ok('7.8 策略表覆盖四种 retryPolicy',
      ['backoff', 'replan', 'escalate', 'none'].every((k) => Array.isArray(table[k])));
    ok('7.9 [安全性] escalate 的前置动作恒为空', table.escalate.length === 0);
    ok('7.10 所有前置动作都是 runPreAction 支持的 token',
      Object.values(table).flat().every((t) => ['wait', 'waitLong', 'reload', 'back', 'back+reload'].includes(t)),
      JSON.stringify(Object.values(table).flat()));
  }

  // ───────────────────────────────────────────────────────
  section('Case 8  接线：recoveryManager 真的消费诊断（非空壳）');
  {
    const origExec = tools.execute;
    let calls = [];
    tools.execute = async (args) => { calls.push(args); return { success: true }; };

    const task = { id: 'T_DIAG', currentExecutionId: 'E_DIAG' };
    const step = { id: 'S_DIAG', action: { type: 'click', target: { semantic: 'submit' }, risk: 'LOW' } };

    try {
      // 8.1 escalate 场景：邮箱重复
      calls = [];
      const r1 = await recoveryManager.attempt(task, step, { code: 'VERIFY_FAILED', message: 'x' }, {
        executionId: 'E_DIAG',
        observation: { network: net({ apiResponses: [apiRes(200, '{"error":"email already registered"}')] }), textSummary: '', previousObservationDiff: noDiff },
        attempted: true,
      });
      ok('8.1 attempt 返回 diagnosis（诊断被真实执行）', !!r1.diagnosis, JSON.stringify(r1).slice(0, 120));
      ok('8.2 escalate 门生效', r1.escalate === true, JSON.stringify({ escalate: r1.escalate }));
      ok('8.3 escalate 时不产出候选动作', r1.action === null, JSON.stringify(r1.action));
      ok('8.4 escalate 时 recoverable=false', r1.recoverable === false, String(r1.recoverable));
      ok('8.5 escalate 时不执行任何前置动作（不在必然失败前做无用功）', calls.length === 0, JSON.stringify(calls.map((c) => c.action.type)));
      ok('8.6 escalate 时证据里带上根因', r1.evidence.some((e) => e.includes('BUSINESS_DUPLICATE_EMAIL')), JSON.stringify(r1.evidence));

      // 8.7 backoff 场景：真的执行了「实质等待」
      calls = [];
      const r2 = await recoveryManager.attempt(task, step, { code: 'VERIFY_FAILED', message: 'x' }, {
        executionId: 'E_DIAG',
        observation: { network: net({ apiResponses: [apiRes(429, '{"error":"rate limited"}')] }), previousObservationDiff: noDiff },
        attempted: true,
      });
      ok('8.7 诊断出限流', r2.diagnosis && r2.diagnosis.rootCause === 'HTTP_429_RATE_LIMITED', r2.diagnosis && r2.diagnosis.rootCause);
      ok('8.8 backoff 时真的执行了前置动作', calls.length === 1, JSON.stringify(calls.map((c) => c.action.type)));
      ok('8.9 前置动作是 wait 且时长为 3000ms（实质等待，非形式等待）',
        calls.length === 1 && calls[0].action.type === 'wait' && calls[0].action.timeoutMs === 3000,
        JSON.stringify(calls[0] && calls[0].action));
      ok('8.10 非 escalate 时仍产出候选动作', !!r2.action, JSON.stringify(r2.action));

      // 8.11 诊断器抛错不得阻塞恢复链路
      calls = [];
      const evilObs = new Proxy({}, { get() { throw new Error('boom'); } });
      const r3 = await recoveryManager.attempt(task, step, { code: 'VERIFY_FAILED', message: 'x' }, {
        executionId: 'E_DIAG', observation: evilObs, attempted: true,
      });
      ok('8.11 诊断异常时恢复链路不中断', r3 && r3.category === 'VERIFICATION_FAILED' && !r3.escalate, JSON.stringify(r3 && r3.category));

      // 8.12 无观察输入时（老调用方）行为不变
      calls = [];
      const r4 = await recoveryManager.attempt(task, step, { code: 'VERIFY_FAILED', message: 'x' }, { executionId: 'E_DIAG' });
      ok('8.12 无观察输入时保持向后兼容（不 escalate）', r4 && !r4.escalate && !!r4.action, JSON.stringify({ esc: r4 && r4.escalate }));

      // 8.13 浏览器崩溃路径不受影响
      calls = [];
      const r5 = await recoveryManager.attempt(task, step, { code: 'BROWSER_CRASH', message: 'target closed' }, { executionId: 'E_DIAG' });
      ok('8.13 BROWSER_CRASH 仍走原路径', r5.crash === true, JSON.stringify(r5));
    } finally {
      tools.execute = origExec;
    }
  }

  // ───────────────────────────────────────────────────────
  section('Case 9  接线：runtime 在 escalate 时不再重复执行动作');
  {
    const rt = srcOf('runtime.js');
    ok('9.1 runtime 把现场观察传给 recoveryManager（诊断有输入）',
      /observation:\s*r\.observation \|\| beforeObs/.test(rt));
    ok('9.2 runtime 传 VIL failureType 给诊断器',
      /vilFailureType:[\s\S]{0,120}failureType/.test(rt));
    ok('9.3 escalate 时置 skipExecution（下一次迭代不执行动作）',
      /skipExecution = true/.test(rt));
    ok('9.4 存在「跳过执行、复用上次失败结果」分支',
      /if \(skipExecution && lastFailureResult\)/.test(rt));
    ok('9.5 跳过执行的理由被写进注释（防后人移除）',
      /不再执行动作/.test(rt) && /有害的重复提交/.test(rt));
    ok('9.6 STEP4 状态按 step 隔离（换步即失效）',
      /pendingDiagnosisStepId !== step\.id/.test(rt));
    ok('9.7 诊断结论带入 repair 链路', /priorDiagnosis: pendingDiagnosis/.test(rt));
    ok('9.8 notRetriable 时禁止 replan（不可能达成的目标不重新规划）',
      /!outcome\.notRetriable/.test(rt));
  }

  // ───────────────────────────────────────────────────────
  section('Case 10 接线：repairManager 对「不可重试」短路 LLM 并直接升级');
  {
    const rm = srcOf('repair/repairManager.js');
    ok('10.1 handleStepFailure 接收 priorDiagnosis', /priorDiagnosis/.test(rm));
    ok('10.2 escalate 时短路（跳过 LLM 重分类）', /priorDiagnosis\.retryPolicy === 'escalate'/.test(rm));
    ok('10.3 返回 notRetriable 标记', /notRetriable: true/.test(rm));
    ok('10.4 短路点位于 LLM 诊断之前（不浪费一次调用）',
      rm.indexOf('priorDiagnosis.retryPolicy') < rm.indexOf('diagnosisEngine.runDiagnosis'));
    ok('10.5 短路点位于任何修复动作之前（不在风控页面上乱点）',
      rm.indexOf('priorDiagnosis.retryPolicy') < rm.indexOf('executor.executePlan'));
    ok('10.6 短路时把根因写进 task.lastDiagnosis（可观测）',
      /fromUnifiedDiagnosis: true/.test(rm));
  }

  // ───────────────────────────────────────────────────────
  section('Case 11 [红线] 通用 Web：不得出现站点/品类特定逻辑');
  {
    const files = {
      'diagnosis/failureDiagnoser.js': srcOf('diagnosis/failureDiagnoser.js'),
      'recovery/strategies/verify.js': srcOf('recovery/strategies/verify.js'),
      'recovery/strategies/generic.js': srcOf('recovery/strategies/generic.js'),
      'recovery/recoveryManager.js': srcOf('recovery/recoveryManager.js'),
      'network/businessErrorDetector.js': srcOf('network/businessErrorDetector.js'),
    };
    const banned = [
      ['saas', /saas/i], ['cloudsaas', /cloudsaas/i],
      ['mock 品牌 戴尔', /戴尔/], ['mock 品牌 飞利浦', /飞利浦/],
      ['mock 品牌 华硕', /华硕/], ['mock 品牌 明基', /明基/],
      ['siteType 判定', /siteType/], ['expectedSite 判定', /expectedSite/],
      ['SITE_CONFLICT', /SITE_CONFLICT/],
      ['电商桶硬编码', /电商商品列表页/],
    ];
    let i = 0;
    for (const [file, src] of Object.entries(files)) {
      for (const [name, re] of banned) {
        i += 1;
        ok(`11.${i} ${file} 不含 ${name}`, !re.test(src), '命中：' + (src.match(re) || [])[0]);
      }
    }
  }

  // ───────────────────────────────────────────────────────
  section('Case 12 [红线] 绝不绕过验证码 / 3DS / 风控');
  {
    const all = [
      srcOf('diagnosis/failureDiagnoser.js'),
      srcOf('recovery/strategies/verify.js'),
      srcOf('recovery/strategies/generic.js'),
      srcOf('recovery/recoveryManager.js'),
      srcOf('network/businessErrorDetector.js'),
    ].join('\n');
    const bypass = [
      ['solveCaptcha', /solveCaptcha|solve_captcha/i],
      ['bypass 语义', /\bbypass\w*(captcha|3ds|otp|risk)/i],
      ['验证码破解/识别求解', /破解验证码|识别验证码|打码平台|ocr.{0,6}(captcha|验证码)/i],
      ['自动化过 3DS', /auto.{0,8}3ds|3ds.{0,8}(bypass|skip)/i],
    ];
    let i = 0;
    for (const [name, re] of bypass) {
      i += 1;
      ok(`12.${i} 源码不含 ${name}`, !re.test(all), '命中：' + (all.match(re) || [])[0]);
    }
  }

  // ───────────────────────────────────────────────────────
  section('Case 13 [红线] 不动成功判定 / 验证阈值');
  {
    const rt = srcOf('runtime.js');
    ok('13.1 runtime 仍以 verification.verify 的返回为准', /const vres = verification\.verify\(/.test(rt));
    ok('13.2 诊断只影响「失败后怎么办」，不影响「是否成功」',
      /if \(!vres\.success\)/.test(rt) && !/diagnos\w*[^\n]{0,40}vres\.success\s*=/.test(rt));
    ok('13.3 DOM_CHANGED ≠ SUCCESS 的严格语义未被放宽',
      !/domChanged\s*&&\s*.*success\s*=\s*true/i.test(rt));
  }

  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
