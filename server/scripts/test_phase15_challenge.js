'use strict';

// Phase 15.0（GAP-1）—— challengeDetector 接入 runtime 诊断主路径 单元测试
//
// 覆盖：
//   A. challengeDetector 三层判定回归（externalBlock / interactive / passiveBeacon / 无特征 403）
//   B. observation.inspect 携带 challenge 字段（fake page，含主文档 403 网络快照推导）
//   C. failureDiagnoser.diagnose 消费 challenge → EXTERNAL_BLOCK / INTERACTIVE_CHALLENGE
//      + retryPolicy=escalate + evidence 带 observed 标记
//   D. challenge=null 时诊断行为不变（向后兼容护栏）
//   E. fromObservation 从 observation.challenge 传播
//   F. 安全：challenge.evidence 不含凭据明文形态
//
// 纪律：断言真实模块行为（直接调用函数），不 eval 源码。

const assert = require('assert');
const { detectChallenge, terminalStateFor } = require('../fp/challengeDetector');
const diagnoser = require('../agent/diagnosis/failureDiagnoser');
const observation = require('../agent/observation');

let pass = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + ' :: ' + e.message); }
}

async function main() {
// ── A. challengeDetector 三层判定 ──
t('A1 403 + PX 特征 → externalBlock', () => {
  const d = detectChallenge({ status: 403, html: 'access denied by perimeterx _pxAppId=PXTG', title: 'Access Denied' });
  assert.strictEqual(d.challenge, true);
  assert.strictEqual(d.externalBlock, true);
  assert.strictEqual(d.interactive, false);
});
t('A2 403 无任何特征 → challenge=false（不伪归因）', () => {
  const d = detectChallenge({ status: 403, html: 'some plain error page', title: 'Error' });
  assert.strictEqual(d.challenge, false);
  assert.strictEqual(d.externalBlock, false);
});
t('A3 200 + 可见 challenge → interactive', () => {
  const d = detectChallenge({ status: 200, html: '', title: 'Security Check', challengeVisible: true });
  assert.strictEqual(d.challenge, true);
  assert.strictEqual(d.interactive, true);
  assert.strictEqual(d.externalBlock, false);
});
t('A4 200 + 仅厂商 beacon → passiveBeacon（不判拦截）', () => {
  const d = detectChallenge({ status: 200, html: '<script src="https://captcha.px-cdn.net/a.js"></script>', title: 'Welcome' });
  assert.strictEqual(d.challenge, false);
  assert.strictEqual(d.passiveBeacon, true);
});
t('A5 终态映射：externalBlock → HUMAN_ESCALATION / BLOCKED_EXTERNAL', () => {
  const term = terminalStateFor(detectChallenge({ status: 403, html: 'denied perimeterx', title: 'Denied' }));
  assert.strictEqual(term.taskStatus, 'HUMAN_ESCALATION');
  assert.strictEqual(term.harnessClass, 'BLOCKED_EXTERNAL');
  assert.strictEqual(term.escalationKind, 'permission');
});
t('A6 终态映射：interactive → HUMAN_ESCALATION / HUMAN_REQUIRED', () => {
  const term = terminalStateFor(detectChallenge({ status: 200, html: '', title: 'x', challengeVisible: true }));
  assert.strictEqual(term.taskStatus, 'HUMAN_ESCALATION');
  assert.strictEqual(term.harnessClass, 'HUMAN_REQUIRED');
});

// ── B. observation.inspect 携带 challenge ──
function fakePage({ title, text, docStatus }) {
  const requests = docStatus
    ? [{ method: 'GET', url: 'https://example.test/x', resourceType: 'document', at: Date.now(), status: docStatus, failed: false, failureText: null, bodyPreview: null, contentType: 'text/html', ms: 10 }]
    : [];
  return {
    url: () => 'https://example.test/x',
    evaluate: async () => ({
      title: title || '',
      textSummary: text || '',
      visibleText: text || '',
      elements: [],
      errors: [],
      loadingState: 'complete',
      domFingerprint: 'abc12345',
      storage: { localStorage: {}, sessionStorage: {} },
    }),
    __fpbNetwork: { requests, console: [], pageErrors: [], pending: 0, pendingMap: new Map() },
  };
}

await t('B1 主文档 403 + denied 文案 → observation.challenge.externalBlock=true', async () => {
  const insp = await observation.inspect(
    fakePage({ title: 'Access Denied', text: 'Your access to this page has been denied. perimeterx', docStatus: 403 }),
    { skipCache: true },
  );
  assert.strictEqual(insp.ok, true);
  const c = insp.observation.challenge;
  assert.ok(c, 'challenge 字段必须存在');
  assert.strictEqual(c.externalBlock, true);
  assert.strictEqual(c.kind, 'perimeterx');
});
await t('B2 无网络快照 → challenge 检测不崩溃、challenge=false', async () => {
  const insp = await observation.inspect(fakePage({ title: 'Normal Page', text: 'hello world' }), { skipCache: true });
  assert.strictEqual(insp.ok, true);
  assert.ok(insp.observation.challenge);
  assert.strictEqual(insp.observation.challenge.challenge, false);
});
await t('B3 正常页面 200 → 无 challenge，不影响观察结构', async () => {
  const insp = await observation.inspect(fakePage({ title: 'Home', text: 'welcome to example', docStatus: 200 }), { skipCache: true });
  assert.strictEqual(insp.ok, true);
  assert.strictEqual(insp.observation.challenge.challenge, false);
  assert.ok(Array.isArray(insp.observation.elements));
});

// ── C. failureDiagnoser 消费 challenge ──
const BLOCK = detectChallenge({ status: 403, html: 'denied by perimeterx', title: 'Access Denied' });
const INTERACTIVE = detectChallenge({ status: 200, html: '', title: 'x', challengeVisible: true });

await t('C1 challenge.externalBlock → rootCause=EXTERNAL_BLOCK + escalate + observed 标记', () => {
  const d = diagnoser.diagnose({ error: { code: 'VERIFY_FAILED', message: 'x' }, challenge: BLOCK, pageText: '' });
  assert.strictEqual(d.rootCause, 'EXTERNAL_BLOCK');
  assert.strictEqual(d.retryPolicy, 'escalate');
  assert.ok(d.evidence.some((e) => e.includes('EXTERNAL_BLOCK') && e.includes('observed')), 'evidence 必须带 observed 归因标记');
  assert.ok(d.evidence.some((e) => e.includes('http_status=403')), 'evidence 必须保留状态码证据');
});
await t('C2 challenge.interactive → rootCause=INTERACTIVE_CHALLENGE + escalate', () => {
  const d = diagnoser.diagnose({ error: { code: 'VERIFY_FAILED', message: 'x' }, challenge: INTERACTIVE, pageText: '' });
  assert.strictEqual(d.rootCause, 'INTERACTIVE_CHALLENGE');
  assert.strictEqual(d.retryPolicy, 'escalate');
});
await t('C3 challenge 优先于网络状态码证据（更具体）', () => {
  const d = diagnoser.diagnose({
    error: { code: 'VERIFY_FAILED', message: 'x' },
    challenge: BLOCK,
    network: { counts: { requests: 1 }, failures: [{ url: 'https://x/', status: 403 }], apiResponses: [], pageErrors: [] },
    pageText: '',
  });
  assert.strictEqual(d.rootCause, 'EXTERNAL_BLOCK');
});
await t('C4 无特征 403（challenge=false）→ 不接管，仍 HTTP_403_FORBIDDEN（不伪归因）', () => {
  const plain403 = detectChallenge({ status: 403, html: 'plain', title: 'Error' });
  assert.strictEqual(plain403.challenge, false);
  const d = diagnoser.diagnose({
    error: { code: 'VERIFY_FAILED', message: 'x' },
    challenge: plain403,
    network: { counts: { requests: 1 }, failures: [{ url: 'https://x/', status: 403 }], apiResponses: [], pageErrors: [] },
    pageText: '',
  });
  assert.strictEqual(d.rootCause, 'HTTP_403_FORBIDDEN');
  assert.strictEqual(d.retryPolicy, 'escalate');
});
await t('C5 challenge=null → 诊断行为不变（向后兼容）', () => {
  const d = diagnoser.diagnose({
    error: { code: 'VERIFY_FAILED', message: 'x' },
    network: { counts: { requests: 1 }, failures: [{ url: 'https://x/', status: 403 }], apiResponses: [], pageErrors: [] },
    pageText: '',
  });
  assert.strictEqual(d.rootCause, 'HTTP_403_FORBIDDEN');
  const d2 = diagnoser.diagnose({ error: { code: 'ELEMENT_NOT_FOUND', message: 'x' } });
  assert.strictEqual(d2.retryPolicy, 'replan');
});

// ── D/E. fromObservation 传播 ──
await t('D fromObservation 从 observation.challenge 传播 → EXTERNAL_BLOCK', () => {
  const d = diagnoser.fromObservation({ code: 'VERIFY_FAILED', message: 'x' }, null, {
    challenge: BLOCK,
    network: null,
    textSummary: '',
  });
  assert.strictEqual(d.rootCause, 'EXTERNAL_BLOCK');
  assert.strictEqual(d.retryPolicy, 'escalate');
});
await t('D2 fromObservation 无 challenge → 原行为', () => {
  const d = diagnoser.fromObservation({ code: 'VERIFY_FAILED', message: 'x' }, null, { network: null, textSummary: '' });
  assert.notStrictEqual(d.rootCause, 'EXTERNAL_BLOCK');
  assert.notStrictEqual(d.rootCause, 'INTERACTIVE_CHALLENGE');
});

// ── F. 安全 ──
await t('F challenge 输出不含凭据明文形态', () => {
  const d = detectChallenge({ status: 403, html: 'denied', title: 'Denied', challengeVisible: false });
  const blob = JSON.stringify(d);
  assert.ok(!/password\s*[:=]\s*['"]?[^\s"',}]+/i.test(blob), 'evidence 不得携带 password=xxx 形态');
  assert.ok(!/\bBearer\s+[A-Za-z0-9.\-_]+/i.test(blob), 'evidence 不得携带 Bearer token');
});

// ── G. PX press-and-hold 变体（R09 真实复放回归） ──
await t('G1 PX press-and-hold（200/无标准 DOM）→ interactive + HUMAN_REQUIRED', () => {
  const page = "Confirm you're not a bot Before we continue, press and hold the button to confirm you're human. Нажмите и удерживайте";
  const d = detectChallenge({ status: null, html: page, title: "Confirm you're not a bot" });
  assert.strictEqual(d.challenge, true);
  assert.strictEqual(d.interactive, true);
  assert.strictEqual(d.externalBlock, false);
  const t2 = terminalStateFor(d);
  assert.strictEqual(t2.taskStatus, 'HUMAN_ESCALATION');
  assert.strictEqual(t2.harnessClass, 'HUMAN_REQUIRED');
});
await t('G2 正常页面 vendor beacon 仍不判拦截（防误报不回归）', () => {
  const d = detectChallenge({ status: 200, html: 'signup form _pxAppId script', title: 'Signup' });
  assert.strictEqual(d.challenge, false);
});
await t('G3 业务文案含 bot 字样不误判', () => {
  const d = detectChallenge({ status: 200, html: 'Our platform blocks bots automatically', title: 'Pricing' });
  assert.strictEqual(d.challenge, false);
});

}

main().then(() => {
  console.log('\n===== test_phase15_challenge =====');
  console.log('PASS=' + pass + ' FAIL=' + failures.length);
  if (failures.length) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
  process.exit(0);
});
