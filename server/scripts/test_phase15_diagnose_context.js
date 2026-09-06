'use strict';

// Phase 15 诊断上下文守卫测试（2026-09-04）：凭据类 page.text 证据的动作一致性校验。
// 背景（run5 rw.026 误标实证）：登录 4 步全 SUCCESS 后 session 丢失回登录页，
// 与认证无关的导出确认步骤 VERIFY_FAILED 被误升级 BUSINESS_INVALID_CREDENTIAL（escalate），
// hint「更换凭据/找回密码」误导人工处置。守卫：凭据类 page.text 证据仅在「本步动作指向
// 认证表单」时保留；network 等客观证据不受影响。

const assert = require('assert');
const { diagnose } = require('../agent/diagnosis/failureDiagnoser');

const pass = [];
const failures = [];
async function t(name, fn) {
  try { await fn(); pass.push(name); console.log('  ok - ' + name); }
  catch (e) { failures.push(name + ': ' + e.message); console.log('  FAIL - ' + name + ' :: ' + e.message); }
}

// rw.026 复放输入：登录页静态文本 + 导出确认步骤失败
const LOGIN_PAGE_TEXT = 'CloudSaaS 控制台登录 企业邮箱 密码 登录 忘记密码？测试演示横幅：邮箱或密码错误，请重试';
const EXPORT_FAIL_ERROR = {
  code: 'VERIFY_FAILED',
  message: 'required unmet: text_present="report_2024.csv" → 页面文本不包含 "report_2024.csv"',
  failureType: 'EVENTUAL_CONSISTENCY',
  confidence: 0.8,
};

function baseInput() {
  return {
    error: EXPORT_FAIL_ERROR,
    category: 'VERIFY_FAILED',
    network: null,
    pageText: LOGIN_PAGE_TEXT,
    attempted: true,
  };
}

async function main() {
  console.log('\n===== test_phase15_diagnose_context =====');

  await t('1. rw.026 复放：非认证动作 + 登录页凭据文案 → 不误判 BUSINESS_INVALID_CREDENTIAL', () => {
    const r = diagnose(Object.assign(baseInput(), {
      currentAction: { type: 'click', target: { semantic: '导出按钮', field: 'exportBtn' } },
    }));
    assert.notStrictEqual(r.rootCause, 'BUSINESS_INVALID_CREDENTIAL', '误标复发: ' + r.rootCause);
    assert.ok(
      r.evidence.some((e) => e.includes('actionContextMismatch')),
      'evidence 应记录降级原因（可溯审计）'
    );
  });

  await t('2. 认证动作（fill password）→ 凭据判定保留（真实凭据错误路径不受影响）', () => {
    const r = diagnose(Object.assign(baseInput(), {
      currentAction: { type: 'fill', target: { field: 'password', semantic: '密码输入框' } },
    }));
    assert.strictEqual(r.rootCause, 'BUSINESS_INVALID_CREDENTIAL');
    assert.strictEqual(r.retryPolicy, 'escalate');
  });

  await t('3. 认证动作（click/submit 登录按钮）→ 凭据判定保留', () => {
    const r = diagnose(Object.assign(baseInput(), {
      currentAction: { type: 'submit', target: { semantic: '登录按钮' } },
    }));
    assert.strictEqual(r.rootCause, 'BUSINESS_INVALID_CREDENTIAL');
  });

  await t('4. fill 邮箱字段 → 认证动作（凭据判定保留）', () => {
    const r = diagnose(Object.assign(baseInput(), {
      currentAction: { type: 'fill', target: { field: 'email', semantic: '企业邮箱输入框' } },
    }));
    assert.strictEqual(r.rootCause, 'BUSINESS_INVALID_CREDENTIAL');
  });

  await t('5. 未传 currentAction（旧调用方契约）→ 保持原判定（A2/A6 兼容，不降级）', () => {
    const r = diagnose(baseInput());
    assert.strictEqual(r.rootCause, 'BUSINESS_INVALID_CREDENTIAL');
    assert.ok(!r.evidence.some((e) => e.includes('actionContextMismatch')));
  });

  await t('5b. 显式传 currentAction=null（无动作 step）→ 保守降级（执行路径安全侧）', () => {
    const r = diagnose(Object.assign(baseInput(), { currentAction: null }));
    assert.notStrictEqual(r.rootCause, 'BUSINESS_INVALID_CREDENTIAL');
    assert.ok(r.evidence.some((e) => e.includes('actionContextMismatch')));
  });

  await t('6. network 客观证据不受守卫影响（network.body 凭据文案 + 非认证动作 → 保留）', () => {
    const r = diagnose({
      error: { code: 'VERIFY_FAILED', message: 'submit 后页面无变化' },
      category: 'VERIFY_FAILED',
      pageText: LOGIN_PAGE_TEXT,
      attempted: true,
      currentAction: { type: 'click', target: { semantic: '导出按钮' } },
      network: {
        counts: { requests: 1 },
        apiResponses: [{ status: 200, url: 'http://x/api/export', method: 'POST', bodyPreview: 'error: invalid password for user' }],
      },
    });
    // network.body 来源的凭据证据不受「动作上下文守卫」过滤（守卫只针对 page.text 静态文案）
    assert.strictEqual(r.rootCause, 'BUSINESS_INVALID_CREDENTIAL', 'network 证据被守卫误伤: ' + r.rootCause);
    assert.ok(!r.evidence.some((e) => e.includes('actionContextMismatch')));
  });

  await t('6b. network 401 状态码 + 非认证动作 → HTTP_401_UNAUTHORIZED（凭据语义保留）', () => {
    const r = diagnose({
      error: { code: 'VERIFY_FAILED', message: 'submit 后页面无变化' },
      category: 'VERIFY_FAILED',
      pageText: '',
      attempted: true,
      currentAction: { type: 'click', target: { semantic: '导出按钮' } },
      network: {
        counts: { requests: 1 },
        failures: [{ status: 401, url: 'http://x/api/data', method: 'GET' }],
      },
    });
    assert.strictEqual(r.rootCause, 'HTTP_401_UNAUTHORIZED');
  });

  await t('7. 无凭据文案的正常页面 → 守卫不产生任何降级 evidence', () => {
    const r = diagnose({
      error: { code: 'VERIFY_FAILED', message: '页面文本不包含 report_2024.csv' },
      category: 'VERIFY_FAILED',
      pageText: '仪表盘 数据概览 导出记录 报表中心',
      attempted: true,
      currentAction: { type: 'click', target: { semantic: '导出按钮' } },
    });
    assert.ok(!r.evidence.some((e) => e.includes('actionContextMismatch')));
  });

  console.log('\n===== test_phase15_diagnose_context =====');
  console.log('PASS=' + pass.length + ' FAIL=' + failures.length);
  if (failures.length) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
