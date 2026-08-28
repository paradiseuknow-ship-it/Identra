'use strict';
// Phase 9.2 — Real World Benchmark Runner（v0.1-alpha 冻结版真实验证）
// 复用真实链路：Objective → DeepSeek provider.plan → Runtime → Browser → Verification → Recovery。
// 严禁 mock / simulation / attachPlan / fallback（与 realBenchmark.js 一致）。
// 差异：100 真实世界任务池（server/scenarios/real-world/）+ 凭据播种 + 升级拆分 + 失败分类 + 修复归因。

const path = require('path');
const fs = require('fs');
const http = require('http');

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('[phase9] 缺少 DEEPSEEK_API_KEY：要求真实 DeepSeek，禁止回退 mock。');
  process.exit(2);
}
if (process.env.AI_PROVIDER === 'mock') { console.error('[phase9] 检测到 AI_PROVIDER=mock，终止。'); process.exit(2); }
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';
require('../agent/llm/providers/deepseek');
require('../agent/llm/providers/openai');

const _origFetch = (typeof global.fetch === 'function') ? global.fetch.bind(global) : null;
const DEEPSEEK_HOST = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
let curPrompt = 0, curCompletion = 0, totPrompt = 0, totCompletion = 0;
if (_origFetch) {
  global.fetch = async (...args) => {
    const res = await _origFetch(...args);
    try {
      const url = String(args[0] || '');
      if (url.includes(DEEPSEEK_HOST)) {
        const clone = res.clone();
        const body = await clone.json().catch(() => null);
        const u = body && body.usage;
        if (u && u.total_tokens) { curPrompt += (u.prompt_tokens || 0); curCompletion += (u.completion_tokens || 0); }
      }
    } catch (e) {}
    return res;
  };
}

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); if (i < 0) return def; const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) return true; return n; }
const MAX = parseInt(arg('--max', '0'), 10) || 0;
const PER_TASK_TIMEOUT = parseInt(arg('--timeout', '120000'), 10) || 120000;

const db = require('../db');
const store = require('../agent/store');
const agentScore = require('../agentScore');
const vault = require('../vault');
const secretManager = require('../agent/secretManager');
// B3：单一权威「业务成功」口径（harness / store / report 同源派生）。
const { isBusinessSuccess, businessSuccess, consistencyCheck } = require('../agent/successMetrics');

process.on('unhandledRejection', (e) => { console.error('[phase9][unhandledRejection]', (e && e.stack) || e); });

// ── 加载 100 真实世界任务 ──
function loadTasks() {
  const dir = path.resolve(__dirname, '..', 'scenarios', 'real-world');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  let list = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  list = list.sort((a, b) => a.id.localeCompare(b.id));
  return MAX > 0 ? list.slice(0, MAX) : list;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startMockServer() {
  const root = path.resolve(__dirname, '..', '..', 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.statusCode = 403; res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.end('not found'); return; }
      const ext = path.extname(file);
      const ct = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript' : 'text/plain';
      res.setHeader('Content-Type', ct);
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const TERMINAL = ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'];

async function runScenario(scn, baseUrl) {
  const taskManager = require('../agent/taskManager');
  const browserManager = require('../browserManager');
  require('../agent/runtime');

  curPrompt = 0; curCompletion = 0;
  const PROFILE_ID = 'p9_' + scn.id.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now().toString(36);
  const profile = {
    id: PROFILE_ID, name: 'P9-' + scn.id, group: 'default', tags: [], notes: '',
    seed: 'bench-seed', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  };
  db.upsertProfile(profile);

  // ── 凭据播种（仅 required 类）──
  let credRefHint = '';
  if (scn.credentialRequirement === 'required' && scn.credentialValue) {
    try {
      vault.setProfileSecrets(PROFILE_ID, scn.credentialValue);
      const type = (scn.credentialValue.card) ? 'payment' : 'email_password';
      const rec = secretManager.createSecret({ profileId: PROFILE_ID, type, site: scn.category, label: scn.credentialRef || scn.id });
      credRefHint = '（使用凭据引用 ' + rec.id + ' 完成认证/支付）';
    } catch (e) { console.error('[phase9] 凭据播种失败', scn.id, e.message); }
  }
  // 降低并发锁竞争（C1）：串行执行已天然限并发；此处仅确保 profile 唯一。

  const targetUrl = baseUrl + '/' + (scn.fixture || 'search.html');
  const objective = scn.objective + credRefHint;
  const task = taskManager.createTask({
    name: 'P9 ' + scn.name,
    objective,
    targetUrl,
    profileId: PROFILE_ID,
    executionMode: 'AUTONOMOUS',
    constraints: [],
    policy: { riskFloor: 'HIGH' },
  });

  taskManager.start(task.id);
  const end = Date.now() + PER_TASK_TIMEOUT;
  let final = null;
  while (Date.now() < end) {
    final = taskManager.getTask(task.id);
    if (final && TERMINAL.includes(final.status)) break;
    await sleep(500);
  }
  if (!final || !TERMINAL.includes(final.status)) {
    try { taskManager.cancel(task.id); } catch (e) {}
    final = taskManager.getTask(task.id) || { id: task.id, status: 'TIMEOUT' };
  }

  // ── 聚合（纯读 store）──
  const allSteps = store.read('aiSteps', []);
  const stepIds = new Set(allSteps.filter((s) => s.taskId === task.id).map((s) => s.id));
  const steps = allSteps.filter((s) => stepIds.has(s.id));
  const attempts = store.read('aiAttempts', []).filter((a) => stepIds.has(a.stepId));
  const retries = store.read('aiEvents', []).filter((e) => e.taskId === task.id && e.type === 'agent.retrying').length;
  const repairs = store.read('aiRepairAttempts', []).filter((r) => r.taskId === task.id);
  const repairCount = repairs.length;
  const repairSuccess = repairs.filter((r) => r.status === 'SUCCESS').length;
  const snapshots = store.read('aiFailureSnapshots', []).filter((s) => s.taskId === task.id);
  const verifEvents = store.read('aiEvents', []).filter((e) => e.taskId === task.id && e.type === 'ai.verification.completed');

  totPrompt += curPrompt; totCompletion += curCompletion;

  const plannerOk = steps.length > 0;
  const codes = attempts.map((a) => a.error && a.error.code).filter(Boolean)
    .concat(snapshots.map((s) => s.errorType).filter(Boolean));
  const escalated = final.status === 'HUMAN_ESCALATION';
  const escalationKind = escalated ? escalationSplit(codes, final) : null;
  const taxonomy = classifyTaxonomy(final, codes, escalationKind);

  try { taskManager.cancel(task.id); } catch (e) {}
  try { browserManager.close(PROFILE_ID).catch(() => {}); } catch (e) {}
  try { db.deleteProfile(PROFILE_ID); } catch (e) {}

  return {
    id: scn.id, category: scn.category, name: scn.name, difficulty: scn.difficulty,
    objective: scn.objective, fixture: scn.fixture,
    credentialRequirement: scn.credentialRequirement, riskLevel: scn.riskLevel,
    targetUrl,
    status: final.status,
    error: (final.error && (final.error.message || String(final.error))) || (typeof final.error === 'string' ? final.error : null),
    stepCount: steps.length,
    attemptCount: attempts.length,
    successAttempts: attempts.filter((a) => a.status === 'SUCCESS').length,
    retries, repairCount, repairSuccess,
    verificationTotal: verifEvents.length,
    verificationPassed: verifEvents.filter((e) => e.payload && e.payload.success).length,
    latencyMs: (final.startedAt && final.finishedAt) ? final.finishedAt - final.startedAt : null,
    tokensPrompt: curPrompt, tokensCompletion: curCompletion,
    plannerOk, hasVerification: steps.some((s) => s.verification && s.verification.type && s.verification.type !== 'none'),
    taxonomy, escalated, escalationKind,
    scores: agentScore.compute({ steps, attempts: attempts.map((a) => ({ stepId: a.stepId, status: a.status, isError: a.status !== 'SUCCESS' && !!a.error })), retries, repairs: repairCount, escalated, status: final.status }),
  };
}

function classifyTaxonomy(final, codes, escalationKind) {
  if (final.status === 'SUCCESS') return null;
  // 升级且属预期安全门控（凭据/支付）→ 归为 POLICY_BLOCK，避免污染真实能力统计
  if (final.status === 'HUMAN_ESCALATION' && escalationKind === 'CREDIBLE') return 'POLICY_BLOCK';
  if (codes.some((c) => /ELEMENT_NOT_FOUND/.test(c))) return 'ELEMENT_NOT_FOUND';
  if (codes.some((c) => /VERIF|VERIFICATION/.test(c))) return 'VERIFY_FAILED';
  if (codes.some((c) => /CREDENTIAL|POLICY|BLOCK|APPROVAL/.test(c))) return 'POLICY_BLOCK';
  if (codes.some((c) => /RESOURCE_LOCK/.test(c))) return 'RESOURCE_LOCK';
  if (codes.some((c) => /NETWORK|ECONN|ENOTFOUND|timeout|TIMEOUT/i.test(c))) return final.status === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK';
  if (final.status === 'TIMEOUT') return 'TIMEOUT';
  return 'OTHER';
}

function escalationSplit(codes, final) {
  const credible = codes.some((c) => /CREDENTIAL|POLICY|BLOCK|APPROVAL/.test(c)) || /凭据|凭证|审批|支付.*需/.test(String(final.error || ''));
  return credible ? 'CREDIBLE' : 'REAL';
}

function aggregate(results) {
  const total = results.length;
  const success = businessSuccess(results).success;
  const esc = results.filter((r) => r.status === 'HUMAN_ESCALATION');
  const failed = results.filter((r) => r.status === 'FAILED' || r.status === 'HUMAN_ESCALATION').length;

  const escalationCredible = esc.filter((r) => r.escalationKind === 'CREDIBLE').length;
  const escalationReal = esc.filter((r) => r.escalationKind === 'REAL').length;

  const avgSteps = total ? +(results.reduce((a, r) => a + r.stepCount, 0) / total).toFixed(2) : 0;
  const avgRecovery = total ? +(results.reduce((a, r) => a + (r.retries + r.repairCount), 0) / total).toFixed(2) : 0;
  const lat = results.filter((r) => r.latencyMs != null).map((r) => r.latencyMs);
  const avgLatency = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;

  const tasksWithPlan = results.filter((r) => r.plannerOk).length;
  const plannerSuccessRate = total ? +(tasksWithPlan / total).toFixed(4) : null;

  const totalAttempts = results.reduce((a, r) => a + r.attemptCount, 0);
  const successAttempts = results.reduce((a, r) => a + r.successAttempts, 0);
  const executionSuccessRate = totalAttempts ? +(successAttempts / totalAttempts).toFixed(4) : null;

  const totalVerif = results.reduce((a, r) => a + r.verificationTotal, 0);
  const passedVerif = results.reduce((a, r) => a + r.verificationPassed, 0);
  const verificationAccuracy = totalVerif ? +(passedVerif / totalVerif).toFixed(4) : null;

  const neededRecovery = results.filter((r) => r.retries + r.repairCount > 0);
  const recovered = neededRecovery.filter((r) => r.status === 'SUCCESS').length;
  const recoverySuccessRate = neededRecovery.length ? +(recovered / neededRecovery.length).toFixed(4) : null;

  // Repair 归因成功率（Step5 口径）
  const repairTotal = results.reduce((a, r) => a + r.repairCount, 0);
  const repairOk = results.reduce((a, r) => a + r.repairSuccess, 0);
  const repairSuccessRate = repairTotal ? +(repairOk / repairTotal).toFixed(4) : null;

  const totPrompt = results.reduce((a, r) => a + r.tokensPrompt, 0);
  const totCompletion = results.reduce((a, r) => a + r.tokensCompletion, 0);
  const totTokens = totPrompt + totCompletion;
  const estUSD = totPrompt * 0.27e-6 + totCompletion * 1.10e-6;
  const avgCostUSD = total ? +(estUSD / total).toFixed(4) : null;

  // Failure taxonomy
  const tax = {};
  ['ELEMENT_NOT_FOUND', 'VERIFY_FAILED', 'POLICY_BLOCK', 'RESOURCE_LOCK', 'TIMEOUT', 'NETWORK', 'OTHER'].forEach((k) => { tax[k] = 0; });
  results.forEach((r) => { if (r.taxonomy) tax[r.taxonomy] = (tax[r.taxonomy] || 0) + 1; });

  const scoreAgg = agentScore.aggregate(results.map((r) => r.scores));

  return {
    totalTasks: total, successRate: total ? +(success / total).toFixed(4) : null,
    humanEscalationRate: total ? +(esc.length / total).toFixed(4) : null,
    escalationCredibleRate: total ? +(escalationCredible / total).toFixed(4) : null,
    escalationRealRate: total ? +(escalationReal / total).toFixed(4) : null,
    avgSteps, avgRecovery, avgLatency,
    plannerSuccessRate, executionSuccessRate, verificationAccuracy,
    recoverySuccessRate, repairSuccessRate,
    repairTotal, repairOk,
    averageCost: { totalTokens: totTokens, promptTokens: totPrompt, completionTokens: totCompletion, estUSD: +estUSD.toFixed(4), avgUSDPerTask: avgCostUSD },
    averageDurationMs: avgLatency,
    agentScore: scoreAgg, failureTaxonomy: tax,
    escalationCredible, escalationReal,
  };
}

function verdict(agg) {
  const s = agg.successRate, realEsc = agg.escalationRealRate, rec = agg.repairSuccessRate, enf = agg.failureTaxonomy.ELEMENT_NOT_FOUND;
  const enfRate = agg.totalTasks ? enf / agg.totalTasks : 0;
  const reasons = [];
  const pass = [];
  if (s != null && s >= 0.7) pass.push('Completion ≥ 70%'); else reasons.push('Completion ' + ((s || 0) * 100).toFixed(0) + '% < 70%');
  if (realEsc != null && realEsc <= 0.3) pass.push('Real escalation ≤ 30%'); else reasons.push('Real escalation ' + ((realEsc || 0) * 100).toFixed(0) + '% > 30%');
  if (rec != null && rec >= 0.85) pass.push('Recovery ≥ 85%'); else reasons.push('Recovery ' + ((rec || 0) * 100).toFixed(0) + '% < 85%');
  if (enfRate <= 0.02) pass.push('ELEMENT_NOT_FOUND ≈ 0'); else reasons.push('ELEMENT_NOT_FOUND ' + (enfRate * 100).toFixed(0) + '% > 0');
  const v02 = pass.length === 4;
  return { v02, pass, reasons };
}

function generateReport(out, agg, v) {
  const pct = (x) => (x == null ? '-' : (x * 100).toFixed(1) + '%');
  const L = [];
  L.push('# Phase 9 真实世界验证报告（v0.1-alpha）');
  L.push('');
  L.push('> 生成时间：' + out.generatedAt);
  L.push('> 模式：**真实 DeepSeek**（禁止 mock / fallback / attachPlan）');
  L.push('> Provider：`' + out.provider + '` ｜ Model：`' + (out.model || 'deepseek-chat') + '`');
  L.push('> 任务来源：`server/scenarios/real-world/`（100 真实世界任务）');
  L.push('');
  L.push('## 1. Executive Summary');
  L.push('');
  L.push('**v0.2.0 候选判定：** ' + (v.v02 ? '✅ 达到候选标准' : '⚠️ 继续 Alpha Hardening'));
  L.push('');
  v.pass.forEach((p) => L.push('- ✅ ' + p));
  v.reasons.forEach((r) => L.push('- ❌ ' + r));
  L.push('');
  L.push('## 2. Completion Rate');
  L.push('');
  L.push('- 总任务：' + agg.totalTasks);
  L.push('- 成功（终态 SUCCESS）：' + pct(agg.successRate));
  L.push('- 失败/升级：' + (agg.totalTasks - Math.round(agg.successRate * agg.totalTasks)));
  L.push('- Planner 成功率（计划生成）：' + pct(agg.plannerSuccessRate));
  L.push('');
  L.push('## 3. Human Escalation');
  L.push('');
  L.push('| 类型 | 数量 | 占比 |');
  L.push('| --- | --- | --- |');
  L.push('| 总计 | ' + (agg.escalationCredible + agg.escalationReal) + ' | ' + pct(agg.humanEscalationRate) + ' |');
  L.push('| Credible（凭据/支付门控，预期安全行为） | ' + agg.escalationCredible + ' | ' + pct(agg.escalationCredibleRate) + ' |');
  L.push('| Real（验证/解析/锁等真实弱点） | ' + agg.escalationReal + ' | ' + pct(agg.escalationRealRate) + ' |');
  L.push('');
  L.push('## 4. Recovery Analysis');
  L.push('');
  L.push('- 触发 repair 总数：' + agg.repairTotal);
  L.push('- repair 成功（归因）：' + agg.repairOk);
  L.push('- Repair Success Rate：' + (agg.repairSuccessRate == null ? 'N/A' : pct(agg.repairSuccessRate)));
  L.push('- 恢复成功率（触发恢复的任务最终 SUCCESS）：' + (agg.recoverySuccessRate == null ? 'N/A' : pct(agg.recoverySuccessRate)));
  L.push('');
  L.push('## 5. Failure Taxonomy');
  L.push('');
  L.push('| 类别 | 数量 |');
  L.push('| --- | --- |');
  ['ELEMENT_NOT_FOUND', 'VERIFY_FAILED', 'POLICY_BLOCK', 'RESOURCE_LOCK', 'TIMEOUT', 'NETWORK', 'OTHER'].forEach((k) => {
    L.push('| ' + k + ' | ' + (agg.failureTaxonomy[k] || 0) + ' |');
  });
  L.push('');
  L.push('## 6. Performance');
  L.push('');
  L.push('- 平均时长：' + (agg.averageDurationMs == null ? '-' : (agg.averageDurationMs / 1000).toFixed(1) + ' s / 任务'));
  L.push('- 平均成本：' + (agg.averageCost.avgUSDPerTask == null ? '-' : '$' + agg.averageCost.avgUSDPerTask + ' / 任务') + '（估算，共 ' + agg.averageCost.totalTokens + ' tokens）');
  L.push('- 平均步骤数：' + agg.avgSteps);
  L.push('- Agent Score：' + JSON.stringify(agg.agentScore));
  L.push('');
  L.push('## 7. Phase 6 / 7 / 9 对比');
  L.push('');
  L.push('| 指标 | Phase 6/7 (30) | Phase 9 (100) |');
  L.push('| --- | --- | --- |');
  L.push('| Completion Rate | 40.0% (Phase7 含污染) | ' + pct(agg.successRate) + ' |');
  L.push('| Planner Success | 1.0 (A1 修复后) | ' + pct(agg.plannerSuccessRate) + ' |');
  L.push('| Execution Success | 64.7% | ' + pct(agg.executionSuccessRate) + ' |');
  L.push('| Verification Coverage | 100% | ' + (agg.verificationAccuracy == null ? '-' : pct(agg.verificationAccuracy)) + ' (accuracy) |');
  L.push('| Recovery (repair) | 92% (归因) | ' + (agg.repairSuccessRate == null ? 'N/A' : pct(agg.repairSuccessRate)) + ' |');
  L.push('| ELEMENT_NOT_FOUND | 0% | ' + (agg.failureTaxonomy.ELEMENT_NOT_FOUND === 0 ? '0%' : (agg.failureTaxonomy.ELEMENT_NOT_FOUND + ' 任务')) + ' |');
  L.push('| Human Escalation | 46.7% | ' + pct(agg.humanEscalationRate) + ' (Real ' + pct(agg.escalationRealRate) + ') |');
  L.push('');
  L.push('## 8. 逐任务结果');
  L.push('');
  L.push('| 任务 | 类别 | 终态 | 步数 | 验证 | repair | taxonomy |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  out.perTask.forEach((r) => {
    L.push('| ' + r.id + ' | ' + r.category + ' | ' + r.status + ' | ' + r.stepCount + ' | ' + r.verificationPassed + '/' + r.verificationTotal + ' | ' + r.repairSuccess + '/' + r.repairCount + ' | ' + (r.taxonomy || '-') + ' |');
  });
  L.push('');
  L.push('---');
  L.push('数据来源：`.benchmark/phase10_' + (out.runId || 'real') + '.json`');
  return L.join('\n');
}

async function main() {
  let list = loadTasks();
  console.log('== Phase 9 Real World Benchmark ==');
  console.log('[phase9] provider =', process.env.AI_PROVIDER, '| model =', process.env.DEEPSEEK_MODEL || 'deepseek-chat');
  console.log('[phase9] 真实任务数 =', list.length, MAX > 0 ? '(抽样 --max ' + MAX + ')' : '');

  const mock = await startMockServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;

  const results = [];
  for (const scn of list) {
    process.stdout.write(`[phase9] 「${scn.name}」(${scn.id}) ... `);
    let rec;
    try { rec = await runScenario(scn, baseUrl); }
    catch (e) {
      rec = { id: scn.id, name: scn.name, category: scn.category, status: 'RUNNER_ERROR', error: String((e && e.message) || e),
        stepCount: 0, attemptCount: 0, successAttempts: 0, retries: 0, repairCount: 0, repairSuccess: 0, verificationTotal: 0, verificationPassed: 0,
        latencyMs: null, tokensPrompt: 0, tokensCompletion: 0, taxonomy: 'OTHER', escalated: false, escalationKind: null,
        scores: agentScore.compute({ steps: [], attempts: [], retries: 0, repairs: 0, escalated: false, status: 'RUNNER_ERROR' }) };
    }
    results.push(rec);
    console.log(`status=${rec.status} steps=${rec.stepCount} ok=${rec.successAttempts}/${rec.attemptCount} verif=${rec.verificationPassed}/${rec.verificationTotal} repair=${rec.repairSuccess}/${rec.repairCount} tax=${rec.taxonomy || '-'} score=${rec.scores.overall}`);
  }

  const agg = aggregate(results);
  // B3 一致性断言：harness 派生 success 必须与原始 aiTasks 终态派生一致（同源口径）。
  const storeTasks = store.read('aiTasks', []);
  const cc = consistencyCheck(results, storeTasks);
  if (!cc.consistent) {
    console.warn('[B3][WARN] harness/store success 口径不一致:', JSON.stringify(cc));
  } else {
    console.log('[B3] consistency OK: harness='+cc.harnessSuccess+' store='+cc.storeSuccess);
  }
  const v = verdict(agg);
  const runId = Date.now();
  const out = { generatedAt: new Date().toISOString(), runId, simulated: false, provider: process.env.AI_PROVIDER, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', summary: agg, verdict: v, perTask: results, successConsistency: cc };

  const dir = path.resolve(__dirname, '..', '..', '.benchmark');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  fs.writeFileSync(path.join(dir, 'phase10_' + runId + '.json'), JSON.stringify(out, null, 2), 'utf8');
  const reportFile = path.resolve(__dirname, '..', '..', 'PHASE10_RAW_RESULT.md');
  fs.writeFileSync(reportFile, generateReport(out, agg, v), 'utf8');

  console.log('\n================ PHASE 10 REAL WORLD BENCHMARK (v0.2.1) ================');
  console.log('总任务数        :', agg.totalTasks);
  console.log('Completion      :', pct(agg.successRate));
  console.log('Planner         :', pct(agg.plannerSuccessRate));
  console.log('Exec            :', pct(agg.executionSuccessRate));
  console.log('Verif accuracy  :', agg.verificationAccuracy == null ? '-' : pct(agg.verificationAccuracy));
  console.log('Repair success  :', agg.repairSuccessRate == null ? 'N/A' : pct(agg.repairSuccessRate));
  console.log('Escalation total:', pct(agg.humanEscalationRate), '(Credible', pct(agg.escalationCredibleRate), '/ Real', pct(agg.escalationRealRate), ')');
  console.log('ELEMENT_NOT_FOUND:', agg.failureTaxonomy.ELEMENT_NOT_FOUND);
  console.log('Avg cost        : $' + (agg.averageCost.avgUSDPerTask || 0) + ' / 任务');
  console.log('Avg duration    :', agg.averageDurationMs == null ? '-' : (agg.averageDurationMs / 1000).toFixed(1) + ' s');
  console.log('Agent Score     :', JSON.stringify(agg.agentScore));
  console.log('v0.2.1 判定     :', v.v02 ? '✅ 达到候选标准' : '⚠️ 继续 Alpha Hardening');
  console.log('JSON            :', path.join(dir, 'phase9_' + runId + '.json'));
  console.log('Report          :', reportFile);
  console.log('=============================================================');

  try { mock.server.close(); } catch (e) {}
  process.exit(0);
}

function pct(x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; }

// Phase 11: expose internals for the balanced 20-task runner (phase11_benchmark20.js)
// without changing behavior when run directly.
module.exports = { runScenario, aggregate, startMockServer, generateReport, verdict, loadTasks };

if (require.main === module) {
  main().catch((e) => { console.error('[phase9] 异常:', (e && e.stack) || e); process.exit(1); });
}
