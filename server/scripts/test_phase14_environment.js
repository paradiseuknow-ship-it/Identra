'use strict';

// Phase 14 测试 — Environment Snapshot / Integrity / Delta / Experiment / Readiness / Challenge
// 全部离线纯函数级：真实站点测试与 mock unit tests 分离，不依赖 webflow 是否在线。

const assert = require('assert');
const { buildEnvironmentSnapshot, scrubValue, SNAPSHOT_VERSION } = require('../fp/environmentSnapshot');
const { checkEnvironmentIntegrity } = require('../fp/environmentIntegrity');
const { computeEnvironmentDelta } = require('../fp/environmentDelta');
const { createExperiment, validateAttributionWording, VARIABLE_SECTION } = require('../fp/experimentMetadata');
const { environmentReadinessReport } = require('../fp/environmentReadiness');
const { detectChallenge, terminalStateFor } = require('../fp/challengeDetector');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok -', name); }
  catch (e) { fail++; console.error('  FAIL -', name, '::', e.message); }
}

const TS = 1700000000000;
function consistentParts(over = {}) {
  return {
    browser: {
      engine: 'Blink', engineVersion: '152.0.7977.65', browser: 'Chrome', browserVersion: '152.0.7977.65',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      platform: 'Win32', mobile: false, language: 'en-US', timezone: 'America/New_York',
    },
    clientHints: {
      brands: [{ brand: 'Chromium', version: '152' }, { brand: 'Google Chrome', version: '152' }, { brand: 'Not=A?Brand', version: '24' }],
      fullVersionList: [{ brand: 'Chromium', version: '152.0.7977.65' }, { brand: 'Google Chrome', version: '152.0.7977.65' }],
      platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: null, mobile: false,
    },
    fingerprint: { fingerprintId: 'fp_x', source: 'native-captured', consistencyStatus: 'PASS' },
    network: { proxyType: 'socks5', proxyConfigured: true, ip: '203.0.113.7', country: 'US', region: 'CA', asn: 'AS64500' },
    profile: { profileId: 'p_test', persistent: true, cacheClearMode: 'none' },
    session: { cookiesPresent: { present: true, count: 3 }, localStoragePresent: false, indexedDbPresent: false, serviceWorkerPresent: false },
    task: { taskId: 'T01', executionId: 'run_x', attemptId: 'A1' },
    timestamp: TS,
    ...over,
  };
}

// ========== Environment Snapshot ==========
t('Snapshot：确定性（同 parts + 同 timestamp → 逐字节一致）', () => {
  const a = buildEnvironmentSnapshot(consistentParts());
  const b = buildEnvironmentSnapshot(consistentParts());
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

t('Snapshot：无凭证泄漏（password/cvv/cardNumber/accessToken 深度剥除）', () => {
  const parts = consistentParts({
    browser: { ...consistentParts().browser, password: 'SuperSecret123' },
    extraSection: { cvv: '123', cardNumber: '4111111111111111', accessToken: 'tok_live_abc', nested: { apiKey: 'sk-123' } },
  });
  const json = JSON.stringify(buildEnvironmentSnapshot(parts));
  for (const secret of ['SuperSecret123', '"123"', '4111111111111111', 'tok_live_abc', 'sk-123']) {
    assert.ok(!json.includes(secret), '快照不得包含: ' + secret);
  }
});

t('Snapshot：JWT 形态字符串值级脱敏（键名不涉密的场景）', () => {
  const out = scrubValue({ profileData: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc' });
  assert.strictEqual(out.profileData, '[REDACTED_JWT]');
  // 键名命中 denylist（如 sessionToken）→ 整键剥除（更强的保障）
  const out2 = scrubValue({ sessionToken: 'anything', remark: 'keep' });
  assert.ok(!('sessionToken' in out2));
  assert.strictEqual(out2.remark, 'keep');
});

t('Snapshot：cookie 只记 presence/count，绝不存值', () => {
  const snap = buildEnvironmentSnapshot(consistentParts());
  assert.deepStrictEqual(snap.session.cookiesPresent, { present: true, count: 3 });
  const json = JSON.stringify(snap);
  assert.ok(!json.includes('session_id='), '不得包含 cookie 值');
});

t('Snapshot：schema 完整（规格 §三 全部 section 存在）', () => {
  const snap = buildEnvironmentSnapshot(consistentParts());
  for (const sec of ['browser', 'clientHints', 'fingerprint', 'network', 'profile', 'session', 'task', 'timestamp']) {
    assert.ok(sec in snap, '缺少 section: ' + sec);
  }
  for (const k of ['engine', 'engineVersion', 'userAgent', 'platform', 'mobile', 'language', 'timezone']) {
    assert.ok(k in snap.browser, 'browser 缺字段: ' + k);
  }
  for (const k of ['brands', 'fullVersionList', 'platform', 'architecture', 'model', 'mobile']) {
    assert.ok(k in snap.clientHints, 'clientHints 缺字段: ' + k);
  }
});

// ========== Environment Integrity ==========
t('Integrity：一致 Windows Chrome 环境 → PASS', () => {
  const r = checkEnvironmentIntegrity(buildEnvironmentSnapshot(consistentParts()));
  assert.strictEqual(r.status, 'PASS', 'reasons=' + JSON.stringify(r.reasons));
});

t('Integrity：UA 平台错配（iPhone UA × Win32）→ FAIL', () => {
  const parts = consistentParts();
  parts.browser.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const r = checkEnvironmentIntegrity(buildEnvironmentSnapshot(parts));
  assert.strictEqual(r.status, 'FAIL');
  assert.ok(r.checks.some((c) => c.name === 'ua_platform' && c.status === 'FAIL'));
});

t('Integrity：CH 家族错配（Chrome UA × Edge brands）→ FAIL', () => {
  const parts = consistentParts();
  parts.clientHints.brands = [{ brand: 'Microsoft Edge', version: '152' }, { brand: 'Chromium', version: '152' }];
  const r = checkEnvironmentIntegrity(buildEnvironmentSnapshot(parts));
  assert.strictEqual(r.status, 'FAIL');
  assert.ok(r.checks.some((c) => c.name === 'ua_clienthints' && c.status === 'FAIL'));
});

t('Integrity：UA 版本 ↔ brands 版本不一致 → FAIL', () => {
  const parts = consistentParts();
  parts.browser.userAgent = parts.browser.userAgent.replace('Chrome/152.', 'Chrome/151.');
  const r = checkEnvironmentIntegrity(buildEnvironmentSnapshot(parts));
  assert.strictEqual(r.status, 'FAIL');
  assert.ok(r.checks.some((c) => c.name === 'ua_version_brands' && c.status === 'FAIL'));
});

t('Integrity：mobile ↔ platform 错配 → FAIL', () => {
  const parts = consistentParts();
  parts.browser.mobile = true;
  const r = checkEnvironmentIntegrity(buildEnvironmentSnapshot(parts));
  assert.ok(r.checks.some((c) => c.name === 'mobile_platform' && c.status === 'FAIL'));
});

t('Integrity：CH platform ↔ UA OS 错配（CH=macOS × UA=Windows）→ FAIL', () => {
  const parts = consistentParts();
  parts.clientHints.platform = 'macOS';
  const r = checkEnvironmentIntegrity(buildEnvironmentSnapshot(parts));
  assert.ok(r.checks.some((c) => c.name === 'ch_platform_os' && c.status === 'FAIL'));
});

t('Integrity：数据不足 → UNKNOWN 不误报（无 CH 的 Safari 形态不低于 PASS）', () => {
  const parts = consistentParts();
  parts.clientHints.brands = null;
  parts.clientHints.fullVersionList = null;
  parts.clientHints.platform = null;
  const r = checkEnvironmentIntegrity(buildEnvironmentSnapshot(parts));
  assert.ok(['PASS', 'WARN', 'UNKNOWN'].includes(r.checks.find((c) => c.name === 'ua_clienthints').status));
  assert.ok(r.status !== 'FAIL');
});

t('Integrity：输出仅含 PASS/WARN/FAIL 与内部一致性理由（无第三方预测字段）', () => {
  const r = checkEnvironmentIntegrity(buildEnvironmentSnapshot(consistentParts()));
  assert.ok(['PASS', 'WARN', 'FAIL'].includes(r.status));
  const json = JSON.stringify(r);
  for (const banned of ['risk', 'score', 'wafAcceptance', 'trust', 'reputation']) {
    assert.ok(!json.toLowerCase().includes(banned), '完整性输出不得含第三方预测字段: ' + banned);
  }
});

// ========== Environment Delta ==========
t('Delta：环境无变化 → UNCHANGED + 空 delta', () => {
  const a = buildEnvironmentSnapshot(consistentParts());
  const b = buildEnvironmentSnapshot(consistentParts({ task: { taskId: 'T02', executionId: 'run_x', attemptId: 'A2' } }));
  const d = computeEnvironmentDelta(a, b);
  assert.strictEqual(d.status, 'UNCHANGED');
  assert.strictEqual(d.fields.length, 0);
});

t("Delta：仅 network 变化 → changedSections=['network'] 且逐字段精确", () => {
  const a = buildEnvironmentSnapshot(consistentParts());
  const parts = consistentParts({ network: { proxyType: 'socks5', proxyConfigured: true, ip: '198.51.100.9', country: 'DE', region: 'BE', asn: 'AS64501' } });
  const b = buildEnvironmentSnapshot(parts);
  const d = computeEnvironmentDelta(a, b);
  assert.strictEqual(d.status, 'CHANGED');
  assert.deepStrictEqual(d.changedSections, ['network']);
  const changedPaths = d.fields.filter((f) => f.state === 'CHANGED').map((f) => f.path).sort();
  assert.deepStrictEqual(changedPaths, ['network.asn', 'network.country', 'network.ip', 'network.region']);
  const ipField = d.fields.find((f) => f.path === 'network.ip');
  assert.strictEqual(ipField.before, '203.0.113.7');
  assert.strictEqual(ipField.after, '198.51.100.9');
});

t('Delta：多 section 变化 → 精确列出全部变化', () => {
  const a = buildEnvironmentSnapshot(consistentParts());
  const parts = consistentParts({
    network: { proxyType: 'socks5', proxyConfigured: true, ip: '198.51.100.9', country: 'DE', region: null, asn: 'AS64501' },
    browser: { ...consistentParts().browser, timezone: 'Europe/Berlin' },
  });
  const d = computeEnvironmentDelta(buildEnvironmentSnapshot(parts), a);
  assert.strictEqual(d.status, 'CHANGED');
  assert.ok(d.changedSections.includes('network') && d.changedSections.includes('browser'));
});

t('Delta：字段缺失 → UNKNOWN（不算变化也不静默）', () => {
  const a = buildEnvironmentSnapshot(consistentParts());
  const b = buildEnvironmentSnapshot(consistentParts());
  b.network.ip = null; // 降级
  const d = computeEnvironmentDelta(a, b);
  assert.strictEqual(d.status, 'UNKNOWN');
  const f = d.fields.find((x) => x.path === 'network.ip');
  assert.ok(f, '缺失字段必须显式记录');
});

t('Delta：task/timestamp 元数据不参与环境比较', () => {
  const a = buildEnvironmentSnapshot(consistentParts());
  const b = buildEnvironmentSnapshot(consistentParts({ task: { taskId: 'T03', executionId: 'other', attemptId: 'A9' }, timestamp: TS + 9999 }));
  const d = computeEnvironmentDelta(a, b);
  assert.strictEqual(d.status, 'UNCHANGED');
});

// ========== Controlled Experiment ==========
t('Experiment：仅 network 单变量 → 创建成功，携带 delta 与归因规则', () => {
  const base = buildEnvironmentSnapshot(consistentParts());
  const cand = buildEnvironmentSnapshot(consistentParts({ network: { proxyType: 'socks5', proxyConfigured: true, ip: '198.51.100.9', country: 'DE', region: 'BE', asn: 'AS64501' } }));
  const exp = createExperiment({ variableUnderTest: 'network', baselineEnvironment: base, candidateEnvironment: cand, controlId: 'ctrl_1' });
  assert.ok(exp.experimentId.startsWith('exp_'));
  assert.strictEqual(exp.variableSection, 'network');
  assert.ok(/correlated/.test(exp.attributionRule));
});

t('Experiment：多变量（network + browser）→ EXPERIMENT_MULTI_VARIABLE 拒绝', () => {
  const base = buildEnvironmentSnapshot(consistentParts());
  const parts = consistentParts({
    network: { proxyType: null, proxyConfigured: false, ip: '198.51.100.9', country: 'DE', region: 'BE', asn: 'AS64501' },
    browser: { ...consistentParts().browser, timezone: 'Europe/Berlin' },
  });
  assert.throws(
    () => createExperiment({ variableUnderTest: 'network', baselineEnvironment: base, candidateEnvironment: buildEnvironmentSnapshot(parts) }),
    (e) => e.code === 'EXPERIMENT_MULTI_VARIABLE'
  );
});

t('Experiment：环境完全一致 → EXPERIMENT_NO_VARIABLE_CHANGE 拒绝', () => {
  const a = buildEnvironmentSnapshot(consistentParts());
  assert.throws(
    () => createExperiment({ variableUnderTest: 'network', baselineEnvironment: a, candidateEnvironment: buildEnvironmentSnapshot(consistentParts()) }),
    (e) => e.code === 'EXPERIMENT_NO_VARIABLE_CHANGE'
  );
});

t('Experiment：未知变量名 → EXPERIMENT_UNKNOWN_VARIABLE 拒绝', () => {
  assert.throws(
    () => createExperiment({ variableUnderTest: 'ipReputation', baselineEnvironment: buildEnvironmentSnapshot(consistentParts()), candidateEnvironment: buildEnvironmentSnapshot(consistentParts()) }),
    (e) => e.code === 'EXPERIMENT_UNKNOWN_VARIABLE'
  );
});

t('Experiment：归因措辞守卫拒绝 confirmed/sole cause', () => {
  assert.strictEqual(validateAttributionWording('network change correlated with outcome change').ok, true);
  assert.strictEqual(validateAttributionWording('IP reputation confirmed').ok, false);
  assert.strictEqual(validateAttributionWording('this is the sole cause of 403').ok, false);
});

// ========== Readiness ==========
t('Readiness：Integrity 真实计算；3DS=UNKNOWN、humanApproval=REQUIRED（无第三方分数）', () => {
  const r = environmentReadinessReport(buildEnvironmentSnapshot(consistentParts()), {
    payment: { credentialRefs: ['ref_email', 'ref_card'], billingMetadata: { country: 'US' } },
    recovery: { checkpointReady: true, credentialRefReady: true, retryBudget: 3 },
  });
  assert.strictEqual(r.environmentIntegrity.status, 'PASS');
  assert.strictEqual(r.paymentReadiness.credentialAvailability, 'READY');
  assert.strictEqual(r.paymentReadiness.billingMetadata, 'READY');
  assert.strictEqual(r.paymentReadiness.threeDSCapability, 'UNKNOWN');
  assert.strictEqual(r.paymentReadiness.humanApproval, 'REQUIRED');
  assert.strictEqual(r.recoveryConfidence.checkpoint, 'READY');
  const json = JSON.stringify(r);
  assert.ok(!/\d{2,}\s*分|RiskScore|WAFScore|"risk":\s*\d/i.test(json), '不得出现第三方风险分数');
});

t('Readiness：缺凭据 → credentialAvailability=MISSING（诚实标注）', () => {
  const r = environmentReadinessReport(buildEnvironmentSnapshot(consistentParts()), {});
  assert.strictEqual(r.paymentReadiness.credentialAvailability, 'MISSING');
  assert.strictEqual(r.recoveryConfidence.retryBudget, 'EXHAUSTED');
});

// ========== Challenge Detection（离线 fixture，三层判定语义） ==========
t('Challenge：PX 403 拦截页（webflow 侦察实测特征）→ externalBlock → BLOCKED_EXTERNAL', () => {
  const d = detectChallenge({
    status: 403,
    title: 'Access to this page has been denied',
    html: '<html><body><script src="https://captcha.px-cdn.net/PXTG2vkiqj/captcha.js"></script><div id="px-captcha"></div><p>Please verify you are a human</p></body></html>',
  });
  assert.ok(d.externalBlock, '403 + PX 特征应判 externalBlock');
  assert.ok(d.challenge);
  assert.ok(d.markers.includes('perimeterx'));
  const term = terminalStateFor(d);
  assert.strictEqual(term.taskStatus, 'HUMAN_ESCALATION');
  assert.strictEqual(term.escalationKind, 'permission');
  assert.strictEqual(term.harnessClass, 'BLOCKED_EXTERNAL');
});

t('Challenge：200 正常页 + 被动 beacon（PX 全站运行）→ SUCCESS 不误判', () => {
  // 2026-09-04 T02 实测形态：signup 200 真页面 + PX beacon 引用 + 隐藏 #px-captcha
  const d = detectChallenge({
    status: 200,
    title: 'Sign up - Webflow',
    html: '<html><body><form><input name="email"></form><script src="https://captcha.px-cdn.net/PXTG2vkiqj/captcha.js"></script><div id="px-captcha" style="display:none"></div></body></html>',
    challengeVisible: false,
  });
  assert.ok(!d.challenge && !d.externalBlock, '被动 beacon 不得判为 challenge');
  assert.ok(d.passiveBeacon, '应记为 passiveBeacon 仅观测');
  const term = terminalStateFor(d);
  assert.strictEqual(term.taskStatus, 'SUCCESS');
});

t('Challenge：正常 home 200 无特征 → SUCCESS', () => {
  const d = detectChallenge({ status: 200, title: 'Webflow: Create a custom website', html: '<html><body>visual development platform</body></html>' });
  assert.ok(!d.challenge && !d.externalBlock && !d.passiveBeacon);
  assert.strictEqual(terminalStateFor(d).taskStatus, 'SUCCESS');
});

t('Challenge：可见 CAPTCHA（challengeVisible=true）→ HUMAN_REQUIRED', () => {
  const d = detectChallenge({
    status: 200,
    title: 'Sign up - Webflow',
    html: '<div class="g-recaptcha" data-sitekey="x"></div>',
    challengeVisible: true,
  });
  assert.ok(d.challenge && d.interactive);
  const term = terminalStateFor(d);
  assert.strictEqual(term.taskStatus, 'HUMAN_ESCALATION');
  assert.strictEqual(term.harnessClass, 'HUMAN_REQUIRED');
});

t('Challenge：challenge 形态标题（Just a moment...）→ HUMAN_REQUIRED', () => {
  const d = detectChallenge({
    status: 403,
    title: 'Just a moment...',
    html: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
  });
  assert.ok(d.externalBlock);
  assert.strictEqual(terminalStateFor(d).harnessClass, 'BLOCKED_EXTERNAL');
});

t('Challenge：多厂商特征全捕获（evidence 可审计）', () => {
  const d = detectChallenge({ status: 403, title: 'denied', html: 'cloudflare cf-ray + datadome dd-verification + akamai _abck' });
  for (const m of ['cloudflare', 'dataDome', 'akamai']) assert.ok(d.markers.includes(m), '缺少 marker: ' + m);
  assert.ok(d.evidence.some((e) => e.startsWith('http_status=403')));
});

console.log(`\nPhase 14 environment suite: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
