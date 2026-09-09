'use strict';
// C105 真实站点 E2E 复跑驱动（授权执行）。
//
// 目的：M1–M3 的修复全部由本地 fixture 验证；本驱动在**真实 Webflow 联盟站点**
// 上复跑同一任务，检验「自洽」是否等于「可用」。
//
// 纪律（沿用历史红线）：
// - 入口必须是联盟链接 https://try.webflow.com/t0wz830c5n4y，不可直接开 webflow.com。
// - 真实支付，不绕 3DS / 不绕风控；autoPayment=false（支付步骤升级人工，对齐悬挂任务策略）。
// - 只观察与执行任务，不修改任何产品代码；失败即归因而非降阈值。
//
// 用法：server 已在 127.0.0.1:8787 运行时，node scripts/run_webflow_real_e2e.js

const fs = require('fs');
const path = require('path');

const BASE = process.env.FPB_BASE || 'http://127.0.0.1:8787';
const OUT_DIR = path.join(__dirname, '..', '..', '.benchmark');
const POLL_MS = 5000;
const MAX_WAIT_MS = Number(process.env.FPB_E2E_MAX_MS || 30 * 60 * 1000); // 30 分钟上限

const TASK_BODY = {
  name: 'Webflow 联盟注册 + 24 美金月度会员（C105 修复后复跑）',
  objective: '通过联盟推广链接完成 Webflow 会员注册并购买最便宜的月度会员',
  targetUrl: 'https://try.webflow.com/t0wz830c5n4y',
  profileId: 'p_mtts6di8i24m', // 环境 003（代理 rola socks5 + Windows/Chrome 指纹）
  executionMode: 'AUTONOMOUS',
  policy: {
    riskFloor: 'MEDIUM',
    autoPayment: false,          // 真实支付不自动放行：支付步骤升级人工（红线）
    maxActionRetries: 3,
    maxRepairAttempts: 3,
    maxReplans: 2,
    maxRecoveryTimeMs: 60000,
    taskTimeoutMs: 0,
  },
  constraints: [
    '必须且只能从 https://try.webflow.com/t0wz830c5n4y 进入，不能直接打开 webflow.com',
    '落地页点击注册入口后若跳转到官网首页，需继续点击 Get started 或 Start for free 进入注册表单',
    '使用环境凭据中的邮箱和密码完成注册',
    '若需账单地址，按 IP 所在国家生成合理的街道地址和邮编',
    '购买最便宜的月度会员（24美金/月），使用环境凭据中的卡支付',
  ],
  secretRefs: ['cred_email', 'cred_password', 'cred_card', 'cred_mttsa377nupr', 'cred_mttsa38pasau'],
};

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch (e) { /* 非 JSON */ }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${txt.slice(0, 300)}`);
  return json !== null ? json : txt;
}

const TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION', 'TIMEOUT'];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now();
  console.log('[e2e] base=' + BASE);

  const created = await api('POST', '/api/ai/tasks', TASK_BODY);
  const taskId = created.id;
  console.log('[e2e] task created: ' + taskId);

  let startRes = null;
  try {
    startRes = await api('POST', `/api/ai/tasks/${taskId}/start`);
    console.log('[e2e] started, execution=' + (startRes && startRes.executionId));
  } catch (e) {
    console.log('[e2e] start failed: ' + e.message);
  }

  const t0 = Date.now();
  let last = null;
  let status = null;
  while (Date.now() - t0 < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let t;
    try { t = await api('GET', `/api/ai/tasks/${taskId}`); } catch (e) { continue; }
    status = t.status;
    const line = `step=${t.currentStepId || '-'} status=${t.status} pending=${!!t.pendingApproval}`;
    if (line !== last) { console.log('[e2e] ' + line); last = line; }
    if (TERMINAL.includes(status)) break;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[e2e] terminal=${status} elapsed=${elapsed}s`);

  // 取证：任务全量 + 事件流 + 步骤尝试
  const out = { taskId, status, elapsed, startedAt: new Date(stamp).toISOString(), base: BASE };
  try { out.task = await api('GET', `/api/ai/tasks/${taskId}`); } catch (e) { out.taskErr = String(e.message); }
  try { out.execution = await api('GET', `/api/ai/tasks/${taskId}/execution`); } catch (e) { /* 可能无 */ }
  try { out.diagnosis = await api('GET', `/api/ai/tasks/${taskId}/diagnosis`); } catch (e) { /* 可能无 */ }

  const file = path.join(OUT_DIR, `real_webflow_e2e_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  // 事件流（server/data/aiEvents.json 落盘；store 根为 server/data）
  try {
    const evPath = path.join(__dirname, '..', 'data', 'aiEvents.json');
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8')).filter((e) => String(e.taskId) === taskId);
    const types = {};
    ev.forEach((e) => { types[e.type] = (types[e.type] || 0) + 1; });
    console.log('[e2e] events: ' + JSON.stringify(types));
    const bad = ev.filter((e) => /flapping_detected|replan_sanitized|escalat|failed/i.test(e.type));
    bad.slice(0, 12).forEach((e) => console.log('  ! ' + e.type + ' ' + JSON.stringify(e.payload || {}).slice(0, 160)));
    out.eventTypes = types;
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
  } catch (e) {
    console.log('[e2e] events read failed: ' + e.message);
  }

  console.log('[e2e] evidence: ' + file);
  process.exit(0);
})().catch((e) => { console.error('[e2e] FATAL ' + e.message); process.exit(1); });
