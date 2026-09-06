'use strict';

// Phase 15.1/15.3/15.5 —— RealSiteContract 单元测试（纯函数，零 IO）
//
// 覆盖：
//   A. validateRealSiteTask：R01-R10 全量合法 + 各非法形态拒绝
//   B. resolveTaskUrl：path + baseUrl 参数化（无站点专用逻辑）
//   C. computeTaskReadiness：四项门 + challenge 门 + ALLOW 快照
//   D. classifyRealSiteFailure：15.5 分类清单全覆盖 + 403 三层证据（observed/inferred）
//   E. expectedFailureOutcome：R09 CORRECT_FAIL 判定
//   F. 红线：契约层无站点专用分支字段语义（site 仅 metadata，不参与任何判定）

const assert = require('assert');
const {
  validateRealSiteTask, resolveTaskUrl, computeTaskReadiness,
  classifyRealSiteFailure, expectedFailureOutcome, REAL_SITE_TERMINAL_STATES,
} = require('../agent/realSiteContract');
const { detectChallenge } = require('../fp/challengeDetector');

let pass = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + ' :: ' + e.message); }
}

const TASKS = require('../scenarios/real-site/phase15_tasks.json');
const BLOCK = detectChallenge({ status: 403, html: 'denied by perimeterx', title: 'Access Denied' });
const INTERACTIVE = detectChallenge({ status: 200, html: '', title: 'x', challengeVisible: true });
const PASS_INTEGRITY = { status: 'PASS', checks: [] };

async function main() {
  // ── A. 契约校验 ──
  await t('A1 R01-R10 全部通过契约校验', () => {
    for (const tk of TASKS.tasks) {
      const v = validateRealSiteTask(tk);
      assert.strictEqual(v.ok, true, tk.taskId + ': ' + v.errors.join('; '));
    }
  });
  await t('A2 非法 taskId 拒绝', () => {
    const v = validateRealSiteTask({ ...TASKS.tasks[0], taskId: 'T01' });
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('R\\d{2}') || e.includes('taskId')));
  });
  await t('A3 未定义终态拒绝（防止随意扩终态枚举）', () => {
    const v = validateRealSiteTask({ ...TASKS.tasks[0], expectedTerminalStates: ['ENVIRONMENT_BAD'] });
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('ENVIRONMENT_BAD')));
  });
  await t('A4 执行期：credentialsRequired 无 credentialRef → validateForExecution 拒绝（fail-closed）', () => {
    const { validateForExecution } = require('../agent/realSiteContract');
    const r05 = TASKS.tasks.find((x) => x.taskId === 'R05');
    assert.strictEqual(validateRealSiteTask(r05).ok, true, '定义期允许缺省（凭据执行期注入）');
    const v = validateForExecution(r05);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('credentialRef')));
    // 注入 credentialRef 后放行
    assert.strictEqual(validateForExecution({ ...r05, credentialRef: 'cred_xxx' }).ok, true);
  });
  await t('A5 invalidCredentials=true 合法（R09 专用无效测试凭据）', () => {
    const r09 = TASKS.tasks.find((x) => x.taskId === 'R09');
    assert.strictEqual(validateRealSiteTask(r09).ok, true);
  });
  await t('A6 站点路径必须以 / 开头', () => {
    const v = validateRealSiteTask({ ...TASKS.tasks[0], path: 'https://evil.example/path' });
    assert.strictEqual(v.ok, false);
  });

  // ── B. URL 解析 ──
  await t('B1 path + baseUrl → 绝对 URL', () => {
    assert.strictEqual(resolveTaskUrl(TASKS.tasks[0], 'https://webflow.com'), 'https://webflow.com/');
    assert.strictEqual(resolveTaskUrl(TASKS.tasks[1], 'https://webflow.com'), 'https://webflow.com/signup');
  });
  await t('B2 换 baseUrl 语义不变（site 仅 metadata，generic）', () => {
    assert.strictEqual(resolveTaskUrl(TASKS.tasks[1], 'https://example.test'), 'https://example.test/signup');
  });
  await t('B3 非法 baseUrl 抛错', () => {
    assert.throws(() => resolveTaskUrl(TASKS.tasks[0], 'not-a-url'));
  });

  // ── C. Task Readiness ──
  await t('C1 全绿 → ALLOW + readiness 快照', () => {
    const r = computeTaskReadiness({ integrity: PASS_INTEGRITY, credentialsRequired: false, challenge: null, policyDecision: { decision: 'ALLOW' } });
    assert.strictEqual(r.decision, 'ALLOW');
    assert.strictEqual(r.readiness.environmentIntegrity, 'PASS');
    assert.strictEqual(r.readiness.credential, 'NOT_REQUIRED');
    assert.strictEqual(r.readiness.riskPolicy, 'ALLOW');
  });
  await t('C2 Integrity FAIL → BLOCK（不执行）', () => {
    const r = computeTaskReadiness({ integrity: { status: 'FAIL' }, credentialsRequired: false });
    assert.strictEqual(r.decision, 'BLOCK');
    assert.ok(r.blockers.some((b) => b.code === 'ENVIRONMENT_INTEGRITY_FAIL'));
  });
  await t('C3 Integrity MISSING → BLOCK（fail-closed）', () => {
    const r = computeTaskReadiness({ integrity: null, credentialsRequired: false });
    assert.strictEqual(r.decision, 'BLOCK');
  });
  await t('C4 需凭据但凭据未就绪 → BLOCK（STOP R05-R08 语义）', () => {
    const r = computeTaskReadiness({ integrity: PASS_INTEGRITY, credentialsRequired: true, credentialReady: false });
    assert.strictEqual(r.decision, 'BLOCK');
    assert.ok(r.blockers.some((b) => b.code === 'CREDENTIAL_NOT_READY'));
  });
  await t('C5 已检测到 challenge → BLOCK（不继续自动操作）', () => {
    const r = computeTaskReadiness({ integrity: PASS_INTEGRITY, credentialsRequired: false, challenge: BLOCK });
    assert.strictEqual(r.decision, 'BLOCK');
    assert.ok(r.blockers.some((b) => b.code === 'EXTERNAL_CHALLENGE_PRESENT'));
  });
  await t('C6 challenge=null（未知）→ 不据此拦截', () => {
    const r = computeTaskReadiness({ integrity: PASS_INTEGRITY, credentialsRequired: false, challenge: null });
    assert.strictEqual(r.decision, 'ALLOW');
  });
  await t('C7 Policy 非 ALLOW → BLOCK', () => {
    const r = computeTaskReadiness({ integrity: PASS_INTEGRITY, credentialsRequired: false, policyDecision: { decision: 'BLOCK' } });
    assert.strictEqual(r.decision, 'BLOCK');
    assert.ok(r.blockers.some((b) => b.code === 'POLICY_NOT_ALLOWED'));
  });

  // ── D. 失败分类（15.5 清单全覆盖）──
  await t('D1 403 + challenge 特征 → EXTERNAL_BLOCK / observed', () => {
    const c = classifyRealSiteFailure({ diagnosis: { rootCause: 'HTTP_403_FORBIDDEN' }, challenge: BLOCK });
    assert.strictEqual(c.classification, 'EXTERNAL_BLOCK');
    assert.strictEqual(c.evidenceTier, 'observed');
  });
  await t('D2 403 无特征 → EXTERNAL_BLOCK / inferred（不伪归因 IP）', () => {
    const c = classifyRealSiteFailure({ diagnosis: { rootCause: 'HTTP_403_FORBIDDEN', category: null, findings: [{ source: 'network.status' }] } });
    assert.strictEqual(c.classification, 'EXTERNAL_BLOCK');
    assert.strictEqual(c.evidenceTier, 'inferred');
  });
  await t('D3 challenge 交互式 → INTERACTIVE_CHALLENGE / observed', () => {
    const c = classifyRealSiteFailure({ diagnosis: { rootCause: 'VERIFY_FAILED' }, challenge: INTERACTIVE });
    assert.strictEqual(c.classification, 'INTERACTIVE_CHALLENGE');
    assert.strictEqual(c.evidenceTier, 'observed');
  });
  await t('D4 分类清单映射全覆盖', () => {
    const cases = [
      ['BUSINESS_INVALID_CREDENTIAL', 'AUTH_INVALID_CREDENTIAL'],
      ['ELEMENT_NOT_FOUND', 'ELEMENT_NOT_FOUND'],
      ['PAGE_NOT_READY', 'PAGE_NOT_READY'],
      ['NAVIGATION_FAILED', 'NAVIGATION_FAILURE'],
      ['STEP_TIMEOUT', 'TIMEOUT'],
      ['VERIFY_FAILED', 'VERIFICATION_FAILED'],
      ['STATE_UNKNOWN', 'VERIFICATION_FAILED'],
    ];
    for (const [rc, expect] of cases) {
      const c = classifyRealSiteFailure({ diagnosis: { rootCause: rc } });
      assert.strictEqual(c.classification, expect, rc + ' → ' + expect);
    }
  });
  await t('D5 无任何证据 → UNKNOWN / unknown（不猜）', () => {
    const c = classifyRealSiteFailure({});
    assert.strictEqual(c.classification, 'UNKNOWN');
    assert.strictEqual(c.evidenceTier, 'unknown');
  });
  await t('D6 分类值全部属于 15.5 定义清单', () => {
    const allowed = new Set(['AUTH_INVALID_CREDENTIAL', 'ELEMENT_NOT_FOUND', 'PAGE_NOT_READY', 'NAVIGATION_FAILURE', 'EXTERNAL_BLOCK', 'INTERACTIVE_CHALLENGE', 'TIMEOUT', 'VERIFICATION_FAILED', 'UNKNOWN']);
    for (const v of Object.values(require('../agent/realSiteContract').FAILURE_CLASSIFICATION_MAP)) {
      assert.ok(allowed.has(v), '非法分类值: ' + v);
    }
  });

  // ── E. R09 期望失败 ──
  await t('E1 无效凭据正确诊断 → CORRECT_FAIL', () => {
    const o = expectedFailureOutcome({ expectedFailure: true, classification: 'AUTH_INVALID_CREDENTIAL' });
    assert.strictEqual(o.terminal, 'CORRECT_FAIL');
  });
  await t('E2 登录页被阻断 → BLOCKED_EXTERNAL（有效结果，未发送凭据）', () => {
    const o = expectedFailureOutcome({ expectedFailure: true, classification: 'EXTERNAL_BLOCK' });
    assert.strictEqual(o.terminal, 'BLOCKED_EXTERNAL');
  });
  await t('E3 意外分类 → null（需人工审查）', () => {
    assert.strictEqual(expectedFailureOutcome({ expectedFailure: true, classification: 'ELEMENT_NOT_FOUND' }), null);
    assert.strictEqual(expectedFailureOutcome({ expectedFailure: false, classification: 'AUTH_INVALID_CREDENTIAL' }), null);
  });

  // ── F. 红线 ──
  await t('F1 终态词汇不超集（复用现有 vocabulary）', () => {
    assert.deepStrictEqual(REAL_SITE_TERMINAL_STATES.sort(), ['BLOCKED_EXTERNAL', 'CANCELLED', 'CORRECT_FAIL', 'FAILED', 'HUMAN_ESCALATION', 'SUCCESS']);
  });
  await t('F2 site 字段不参与任何判定（改 site 结果不变）', () => {
    const a = classifyRealSiteFailure({ diagnosis: { rootCause: 'HTTP_403_FORBIDDEN' }, challenge: BLOCK });
    const b = classifyRealSiteFailure({ diagnosis: { rootCause: 'HTTP_403_FORBIDDEN' }, challenge: BLOCK, site: 'webflow' });
    assert.deepStrictEqual(a, b);
  });
  await t('F3 任务定义文件无站点专用执行字段', () => {
    for (const tk of TASKS.tasks) {
      for (const key of Object.keys(tk)) {
        assert.ok(!/selector|script|bypass|captchaSolution|proxy/i.test(key), '任务定义不得携带执行特化字段: ' + key);
      }
    }
  });

  console.log('\n===== test_phase15_contract =====');
  console.log('PASS=' + pass + ' FAIL=' + failures.length);
  if (failures.length) { console.log('FAILED: ' + failures.join(', ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
