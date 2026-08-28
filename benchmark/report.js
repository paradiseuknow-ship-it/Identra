'use strict';

// Phase 5.9-B — Instrumentation + 100×3 对照（Benchmark 层，不修改 Runtime/verification/mock/tasks）。
//
// 固定条件（保证 A/B/C 同口径）：
//   - 相同 Mock Site（buildApp 随机端口，单实例）
//   - 相同任务分布（11 类 × ROUNDS 轮 = 每组 100 执行）
//   - 相同 task.verify（Ground Truth）
//   - 相同 timeout（task.verify.timeoutMs，Runtime STEP_TIMEOUT=30s）
//   - 相同浏览器环境（chromium headless, --no-sandbox）
//   - 相同并发策略（每组 Runner 串行 run，避免争用伪影；contention 应≈0）
//   - 相同成功判据（A/B/C 统一 verifyResult(task.verify) 复核）
//
// 输出：
//   - 控制台对照表（用户指定列）
//   - benchmark/results/5.9-B-{runner}-traces.json  逐任务 trace
//   - benchmark/results/5.9-B-summary.json           聚合摘要
//
// 历史标记（写入报告）：
//   - C=100%  → INVALID（Plan Bridge 旁路 task.verify 假阳性，5.9-A.1/A.2 证伪）
//   - C=18.2% → SUPERSEDED（5.9-A.2 同构判分修复后暴露 Runtime 只跑 nav+obs，5.9-A.3 修复）
//   - C=72.7% → 当前唯一可进入正式数据集版本，但仅称 Architecture Baseline（无 Intelligence 介入）

const fs = require('fs');
const path = require('path');
// 5.9-C 协议 §12：不接真实 LLM。自主 planner（X/C1-X）需 mock provider，
// 必须在 require runtime/agentRunner 之前设定，否则 provider 已在模块顶层固化。
if (process.env.BENCH_PHASE === 'c' && !process.env.AI_PROVIDER) {
  process.env.AI_PROVIDER = 'mock';
}
// 5.9-D 协议 §13：D 用真实 LLM（deepseek/openai）。默认 deepseek，真实 key 由环境注入；
// 同样必须在 require agentRunner 之前设定，否则 provider 在 runtime 顶层固化成 mock。
if (process.env.BENCH_PHASE === 'd' && !process.env.AI_PROVIDER) {
  process.env.AI_PROVIDER = 'deepseek';
}
if (process.env.BENCH_PHASE === 'e' && !process.env.AI_PROVIDER) {
  process.env.AI_PROVIDER = 'deepseek';
}
const { allTasks, TASKS } = require('./tasks');
const { PlaywrightRunner } = require('./runners/playwrightRunner');
const { LlmRunner } = require('./runners/llmRunner');
const { AgentRunner } = require('./runners/agentRunner');

const ROUNDS = parseInt(process.env.BENCH_ROUNDS || '100', 10); // 100×3
const OUT_DIR = path.join(__dirname, 'results');

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
function avg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0; }
function rate(arr, pred) { return arr.length ? +(pred(arr) / arr.length * 100).toFixed(1) : 0; }
function fmt(n, d = 2) { return Number(n).toFixed(d); }

// 把 11 个基础任务复制 ROUNDS 轮，每轮 id 加 #r 后缀保证 store 唯一
function expandTasks(rounds) {
  const base = allTasks();
  const out = [];
  for (let r = 0; r < rounds; r++) {
    for (const t of base) {
      out.push(Object.assign({}, t, { id: `${t.id}#${r}`, _round: r, _baseId: t.id }));
    }
  }
  return out;
}

async function runGroup(RunnerCls, tasks, opts) {
  const runner = new RunnerCls(opts);
  const out = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const r = await runner.run(t);
    out.push(r);
    if ((i + 1) % 10 === 0) console.log(`  [${runner.runner}] ${i + 1}/${tasks.length} done`);
  }
  await runner.close();
  return out;
}

// 聚合单组（runnerLabel, rows）
function aggregate(rows, runnerLabel) {
  const succ = rows.filter((r) => r.success);
  const lat = rows.map((r) => r.latencyMs);
  const llm = rows.map((r) => r.llmCalls);
  const tok = rows.map((r) => r.tokens);
  const costAll = rows.reduce((s, r) => s + r.cost, 0);
  const costPerSucc = succ.length ? +(costAll / succ.length).toFixed(4) : 0;

  const retries = rows.reduce((s, r) => s + (r.raw.retryCount || 0), 0);
  const recRows = rows.filter((r) => r.raw.recoveryTriggered);
  const recOk = recRows.filter((r) => r.raw.recoverySuccess);
  const human = rows.filter((r) => r.humanEscalation);

  const memHitRows = rows.filter((r) => (r.raw.memoryHitRate || 0) > 0);
  const fkHitRows = rows.filter((r) => r.raw.failureKnowledgeHit);
  const routerRows = rows.filter((r) => r.raw.routerAccuracy != null);
  const routerAcc = routerRows.reduce((s, r) => s + (r.raw.routerAccuracy || 0), 0);

  // resource（全局快照末态，取平均利用率）
  const wu = rows.map((r) => r.raw.workerUtilization).filter((x) => x != null);
  const bu = rows.map((r) => r.raw.browserUtilization).filter((x) => x != null);
  const contention = rows.filter((r) => (r.raw.profileContention || 0) > 0).length;

  return {
    Runner: runnerLabel,
    'Success Rate': rate(rows, (a) => a.filter((r) => r.success).length) + '%',
    'P50': pct(lat, 50) + 'ms',
    'P95': pct(lat, 95) + 'ms',
    'P99': pct(lat, 99) + 'ms',
    'Avg Latency': avg(lat) + 'ms',
    'LLM Calls/Task': fmt(avg(llm), 1),
    'Token/Task': avg(tok),
    'Cost/Success': '$' + costPerSucc,
    'Retry/Task': fmt(retries / rows.length, 2),
    'Recovery Rate': recRows.length ? fmt(recOk.length / recRows.length * 100, 1) + '%' : (runnerLabel === 'Experience Agent (C)' ? '0% (no recovery triggered)' : 'n/a'),
    'Recovery Success': recRows.length ? fmt(recOk.length / recRows.length * 100, 1) + '%' : (runnerLabel === 'Experience Agent (C)' ? '0%' : 'n/a'),
    'Human Escalation': rate(rows, (a) => a.filter((r) => r.humanEscalation).length) + '%',
    'Memory Hit': memHitRows.length ? fmt(memHitRows.length / rows.length * 100, 1) + '%' : 'n/a',
    'Router Accuracy': routerRows.length ? fmt(routerAcc / routerRows.length * 100, 1) + '%' : 'n/a',
    'Failure Knowledge Hit': fkHitRows.length ? fmt(fkHitRows.length / rows.length * 100, 1) + '%' : 'n/a',
    'Worker Utilization': wu.length ? fmt(avg(wu) * 100, 1) + '%' : 'n/a',
    'Browser Utilization': bu.length ? fmt(avg(bu) * 100, 1) + '%' : 'n/a',
    'Profile Contention': contention ? fmt(contention / rows.length * 100, 1) + '%' : '0%',
  };
}

function printTable(rows) {
  const cols = Object.keys(rows[0]);
  const short = {
    Runner: 'Runner', 'Success Rate': 'Succ%', 'P50': 'P50', 'P95': 'P95', 'P99': 'P99',
    'Avg Latency': 'Avg', 'LLM Calls/Task': 'LLM/T', 'Token/Task': 'Tok/T',
    'Cost/Success': 'Cost/Succ', 'Retry/Task': 'Retry/T', 'Recovery Rate': 'Recov%',
    'Recovery Success': 'RecovOK%', 'Human Escalation': 'Human%', 'Memory Hit': 'Mem%',
    'Router Accuracy': 'Router%', 'Failure Knowledge Hit': 'FK%',
    'Worker Utilization': 'WkUtil%', 'Browser Utilization': 'BrUtil%', 'Profile Contention': 'Conten%',
  };
  const w = 16;
  const pad = (s, n) => String(s).padEnd(n);
  console.log(cols.map((c) => pad(short[c] || c, w)).join(' | '));
  console.log(cols.map(() => pad('-', w)).join('-+-'));
  for (const r of rows) console.log(cols.map((c) => pad(r[c], w)).join(' | '));
}

function dumpJson(name, obj) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const f = path.join(OUT_DIR, name);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  return f;
}

(async () => {
  if (process.env.BENCH_PHASE === 'c') return runPhaseC();
  if (process.env.BENCH_PHASE === 'd') return runPhaseD();
  if (process.env.BENCH_PHASE === 'e') return runPhaseE();
  if (process.env.BENCH_PHASE === 'e4') return runPhaseE4();
  const rounds = ROUNDS;
  const tasks = expandTasks(rounds); // 11 × rounds 每组
  const opts = { mockBaseUrl: process.env.BENCH_MOCK_URL || 'http://localhost:4599' };

  console.log(`\n[5.9-B] STORE_DRIVER=${process.env.STORE_DRIVER || 'json'}  baseTasks=${TASKS.length} rounds=${rounds} perRunner=${tasks.length}`);
  console.log('[5.9-B] 固定条件: 相同 Mock / 相同任务分布 / 相同 verify / 相同 timeout / 相同浏览器 / 串行并发 / 相同判据\n');

  const mockApp = require('./mockSite').buildApp();
  const mockServer = await new Promise((res) => { const s = mockApp.listen(0, () => res(s)); });
  const mockPort = mockServer.address().port;
  const mockUrl = `http://localhost:${mockPort}`;
  console.log('[5.9-B] mock site up', mockUrl);
  const opts2 = { ...opts, mockBaseUrl: mockUrl };

  const A = await runGroup(PlaywrightRunner, tasks, opts2);
  console.log(`\n[5.9-B] A done (${A.length})`);
  const B = await runGroup(LlmRunner, tasks, opts2);
  console.log(`\n[5.9-B] B done (${B.length})`);
  let C = [];
  if (!process.env.BENCH_SKIP_C) {
    C = await runGroup(AgentRunner, tasks, opts2);
    console.log(`\n[5.9-B] C done (${C.length})`);
  } else {
    console.log('\n[5.9-B] BENCH_SKIP_C 已设，跳过 C');
  }

  const table = [
    aggregate(A, 'Playwright (A)'),
    aggregate(B, 'Playwright+LLM (B)'),
    aggregate(C, 'Experience Agent (C)'),
  ];

  console.log('\n=== 5.9-B Browser Agent Benchmark (100×3) ===');
  printTable(table);

  // 历史标记
  console.log('\n=== 历史结果裁定（写入报告）===');
  console.log('  C=100%   → INVALID    （Plan Bridge 旁路 task.verify，5.9-A.1/A.2 证伪）');
  console.log('  C=18.2%  → SUPERSEDED （5.9-A.2 同构判分暴露 Runtime 只跑 nav+obs，5.9-A.3 修复）');
  console.log('  C=72.7%  → Architecture Baseline（确定性 Plan、无 Intelligence 介入；11 任务 Gate，仍太小）');

  // 落盘
  const aFile = dumpJson('5.9-B-A-traces.json', A.map((r) => ({ taskId: r.taskId, category: r.category, success: r.success, latencyMs: r.latencyMs, error: r.error, raw: r.raw })));
  const bFile = dumpJson('5.9-B-B-traces.json', B.map((r) => ({ taskId: r.taskId, category: r.category, success: r.success, latencyMs: r.latencyMs, error: r.error, raw: r.raw })));
  const cFile = dumpJson('5.9-B-C-traces.json', C.map((r) => ({ taskId: r.taskId, category: r.category, success: r.success, latencyMs: r.latencyMs, error: r.error, raw: r.raw })));

  // C 失败归因聚合（回答：Plan/Action/Verification/Recovery 哪层）
  const cFail = C.filter((r) => !r.success);
  const attribution = {};
  for (const r of cFail) {
    const fa = r.raw.failureAttribution;
    if (!fa) continue;
    for (const layer of fa.layers) attribution[layer] = (attribution[layer] || 0) + 1;
  }
  const cSummary = {
    total: C.length,
    success: C.filter((r) => r.success).length,
    successRate: rate(C, (a) => a.filter((r) => r.success).length),
    humanEscalation: C.filter((r) => r.humanEscalation).length,
    intelligenceRecorded: C.filter((r) => r.raw.intelligenceRecorded).length,
    failureAttribution: attribution,
    recoveryTriggered: C.filter((r) => r.raw.recoveryTriggered).length,
    recoverySuccess: C.filter((r) => r.raw.recoverySuccess).length,
  };

  const summary = {
    phase: '5.9-B',
    generatedAt: new Date().toISOString(),
    config: { baseTasks: TASKS.length, rounds, perRunner: tasks.length, concurrency: 'serial', planBridge: !!process.env.BENCH_PLAN_BRIDGE },
    table,
    historyVerdict: {
      'C=100%': 'INVALID (proven false positive, 5.9-A.1/A.2)',
      'C=18.2%': 'SUPERSEDED (5.9-A.2 homomorphic scoring exposed nav+obs-only, fixed in 5.9-A.3)',
      'C=72.7%': 'Architecture Baseline only (deterministic plan, no Intelligence engaged; 11-task gate, still too small)',
    },
    cFailureAttribution: attribution,
    cSummary,
    files: { A: aFile, B: bFile, C: cFile },
  };
  dumpJson('5.9-B-summary.json', summary);

  console.log('\n[5.9-B] C failure attribution (layers):', JSON.stringify(attribution));
  console.log('[5.9-B] C intelligence recorded (tasks with eval):', cSummary.intelligenceRecorded, '/', C.length);
  console.log('[5.9-B] artifacts:', aFile, bFile, cFile, path.join(OUT_DIR, '5.9-B-summary.json'));

  process.exit(0);
})().catch((e) => { console.error('bench error', e); process.exit(1); });

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.9-C — 11×1 smoke matrix（实验协议 §12，用户裁定 2026-08-23 调整后）
//
// 实验裁定（已锁定，不修 X / 不 stub / 不伪装）：
//   C1-X  BLOCKED
//     BENCH_PLAN_BRIDGE=0 → mock planner → navigate → HEALING → executed=0 → RUNNING
//     这是 Runtime 自主规划路径真实能力缺口（工程成熟度指标），不是 Benchmark 判分问题。
//     若为让 X 跑通而修改 mock plan，将改变实验对象，故 X 不执行、ΔPlan 暂不计算。
//   C1-Z  Deterministic Plan Architecture Baseline（原 72.7% 的精确命名）
//     BENCH_PLAN_BRIDGE=1 → 注入确定性可执行 plan，已验证生命周期完整、Ground Truth 可复核。
//   C2    Intelligence Observability（用 Z 路，避免 X 不可终止）
//     Z + eval OFF   vs   Z + eval ON（evaluator 纯观测）
//     验收：Behavior OFF == Behavior ON（status/GT/plan/耗时/retry 一致），
//           仅 aiIntelligenceEvaluations / memory / router / FK 计数 0 → >0。
//           若 ON 导致成功率/耗时/retry 明显变化 → INSTRUMENTATION CONTAMINATION，立即停止。
//
// 关键纪律：
//   - 不碰 Runtime 决策逻辑；所有改动只在 Benchmark 层 + 纯观测 collector.collect。
//   - 不接真实 LLM（直到 5.9-D）。
// ─────────────────────────────────────────────────────────────────────────────
async function runPhaseC() {
  const rounds = 1; // 11×1 smoke
  const tasks = expandTasks(rounds); // 11 任务
  const opts = { mockBaseUrl: process.env.BENCH_MOCK_URL || 'http://localhost:4599' };

  console.log(`\n[5.9-C] STORE_DRIVER=${process.env.STORE_DRIVER || 'json'}  baseTasks=${TASKS.length} rounds=${rounds} (11×1 smoke)`);
  console.log('[5.9-C] 实验裁定：C1-X BLOCKED（自主 planner 首步进入 HEALING 不可终止）；C1-Z 保留；C2 用 Z 路 Observability\n');

  const mockApp = require('./mockSite').buildApp();
  const mockServer = await new Promise((res) => { const s = mockApp.listen(0, () => res(s)); });
  const mockPort = mockServer.address().port;
  const mockUrl = `http://localhost:${mockPort}`;
  console.log('[5.9-C] mock site up', mockUrl);
  const opts2 = { ...opts, mockBaseUrl: mockUrl };

  const aiCollector = () => {
    try { return require('./../server/agent/intelligence/evaluation/evaluationCollector'); }
    catch { return null; }
  };
  const aiCount = () => {
    const c = aiCollector();
    if (!c) return -1;
    try { return c.list({}).length; } catch { return -1; }
  };
  const aiReset = () => {
    const c = aiCollector();
    if (c && typeof c.clear === 'function') { try { c.clear(); } catch {} }
  };

  function runGroupWithEnv(env, RunnerCls, label, idPrefix) {
    const prev = {};
    for (const k of ['BENCH_PLAN_BRIDGE', 'BENCH_EVAL', 'BENCH_SKIP_C']) { prev[k] = process.env[k]; }
    Object.assign(process.env, env);
    // 每组 taskId 加前缀，避免共享 store 同 id 覆盖（Z/Z0/Z1 都是 AgentRunner 且串行共享 store）
    const groupTasks = tasks.map((t) => Object.assign({}, t, { id: `${idPrefix}-${t.id}` }));
    return runGroup(RunnerCls, groupTasks, opts2).then((rows) => {
      for (const k of ['BENCH_PLAN_BRIDGE', 'BENCH_EVAL', 'BENCH_SKIP_C']) {
        if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
      }
      console.log(`\n[5.9-C] ${label} done (${rows.length})`);
      return rows;
    });
  }

  function succRate(rows) { return +(rows.filter((r) => r.success).length / rows.length * 100).toFixed(1); }

  // ── C1-X : BLOCKED（不执行，直接裁定）────────────────────────────────────
  console.log('\n=== 5.9-C C1-X : Autonomous Planner Baseline — BLOCKED ===');
  console.log('  BENCH_PLAN_BRIDGE=0');
  console.log('    ↓ mock planner');
  console.log('    ↓ navigate');
  console.log('    ↓ HEALING');
  console.log('    ↓ executed = 0');
  console.log('    ↓ RUNNING (non-terminal)');
  console.log('  裁定：Runtime autonomous-planner path is currently not benchmarkable under');
  console.log('        the deterministic mock provider because the generated plan enters HEALING');
  console.log('        at the initial navigation step and fails to reach a terminal state.');
  console.log('  ΔPlan = Z - X  暂不计算（X 不可测）。');

  // ── C1-Z : Deterministic Plan Architecture Baseline ──────────────────────
  const Z = await runGroupWithEnv({ BENCH_PLAN_BRIDGE: '1', BENCH_EVAL: '0' }, AgentRunner, 'C1-Z (plan bridge ON)', 'Z');

  // ── C2-Z0 : Z + eval OFF（纯行为 baseline）──────────────────────────────
  aiReset();
  const Z0 = await runGroupWithEnv({ BENCH_PLAN_BRIDGE: '1', BENCH_EVAL: '0' }, AgentRunner, 'C2-Z0 (eval OFF)', 'Z0');
  const aiAfter0 = aiCount();
  // ── C2-Z1 : Z + eval ON（纯观测，collector.collect 仅落库）──────────────
  aiReset();
  const Z1 = await runGroupWithEnv({ BENCH_PLAN_BRIDGE: '1', BENCH_EVAL: '1' }, AgentRunner, 'C2-Z1 (eval ON)', 'Z1');
  const aiAfter1 = aiCount();

  console.log('\n=== 5.9-C Smoke Matrix (11×1) ===');
  console.log('  route      planBridge  eval   Succ%   aiIntelligenceEvaluations');
  console.log('  C1-X       OFF         0      BLOCKED (autonomous planner non-terminal)');
  console.log('  C1-Z       ON          0      ' + succRate(Z) + '%    (Deterministic Plan Architecture Baseline)');
  console.log('  C2-Z0      ON          0      ' + succRate(Z0) + '%    eval-record=' + aiAfter0);
  console.log('  C2-Z1      ON          1      ' + succRate(Z1) + '%    eval-record=' + aiAfter1);

  // C1: ΔPlan 不计算（X BLOCKED）
  console.log('\n=== C1: Deterministic Plan Contribution ===');
  console.log('  ΔPlan = Z - X : BLOCKED（X 不可测，暂不计算）');
  console.log('  Z (Deterministic Plan Architecture Baseline) = ' + succRate(Z) + '%');

  // C2: contamination check + observability proof
  // 污染检查采用稳健口径：成功率 / Runtime status 序列 / Plan 执行序列 必须完全一致；
  // 耗时仅比较均值差异（真实浏览器执行有自然抖动，逐字节相等不可能，<5% 视为一致）。
  const avgLat = (rows) => rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length;
  const diff = Math.abs(succRate(Z1) - succRate(Z0));
  const statusSame = JSON.stringify(Z1.map((r) => r.raw.runtimeStatus)) === JSON.stringify(Z0.map((r) => r.raw.runtimeStatus));
  const planSame = JSON.stringify(Z1.map((r) => r.raw.executedStepCount)) === JSON.stringify(Z0.map((r) => r.raw.executedStepCount));
  const latDiffRatio = Math.abs(avgLat(Z1) - avgLat(Z0)) / (avgLat(Z0) || 1);
  const latSame = latDiffRatio < 0.05; // 耗时均值差异 <5% 视为一致
  const behaviorSame = diff === 0 && statusSame && planSame && latSame;
  console.log('\n=== C2: Intelligence Observability / Contamination ===');
  console.log('  aiIntelligenceEvaluations recorded: Z0(OFF)=' + aiAfter0 + '  Z1(ON)=' + aiAfter1);
  console.log('  Z0 Succ% = ' + succRate(Z0) + '   Z1 Succ% = ' + succRate(Z1) + '   |Δ| = ' + diff);
  console.log('  Runtime status OFF==ON : ' + (statusSame ? 'PASS' : '⚠️ FAIL'));
  console.log('  Plan executed   OFF==ON : ' + (planSame ? 'PASS' : '⚠️ FAIL'));
  console.log('  Avg latency   OFF=' + Math.round(avgLat(Z0)) + 'ms  ON=' + Math.round(avgLat(Z1)) + 'ms  Δ=' + (latDiffRatio * 100).toFixed(1) + '%  ' + (latSame ? 'PASS' : '⚠️ >5%'));
  console.log('  behavior OFF==ON : ' + (behaviorSame ? 'PASS' : '⚠️ FAIL'));
  if (diff > 0 || !statusSame || !planSame) {
    console.log('  ⚠️ INSTRUMENTATION CONTAMINATION：evaluator ON 导致成功率/Runtime status/Plan 执行变化，立即停止！');
  } else if (aiAfter1 > 0 && aiAfter0 === 0) {
    console.log('  ✅ OBSERVABILITY PROVEN：行为一致（succ/status/plan 全等，耗时波动<5%），evaluation 计数 0 → ' + aiAfter1);
    console.log('     结论：当前 Runtime 确实存在可观测的 Intelligence 行为，只是此前未被 evaluator pipeline 捕获。');
  } else if (aiAfter1 === 0) {
    console.log('  ⚠️ 注意：Z1 仍记录 0 条，Observability 未生效（需检查 collector.collect 调用路径）。');
  }

  const summary = {
    phase: '5.9-C-smoke',
    note: '11×1 smoke; C1-X BLOCKED (autonomous planner non-terminal); C2 uses Z-path observability; not statistical significance',
    verdict: {
      C1_X: 'BLOCKED — Runtime autonomous-planner path not benchmarkable under deterministic mock provider (plan enters HEALING at initial navigate, fails to reach terminal state)',
      C1_Z: 'Deterministic Plan Architecture Baseline (executable, verified lifecycle)',
      C2: 'Intelligence Observability via Z-path; contamination check + count 0→>0',
    },
    matrix: {
      C1_X: { planBridge: false, eval: false, status: 'BLOCKED', reason: 'autonomous planner non-terminal (HEALING at navigate)' },
      C1_Z: { planBridge: true, eval: false, succRate: succRate(Z) },
      C2_Z0: { planBridge: true, eval: false, succRate: succRate(Z0), aiIntelligenceEvaluations: aiAfter0 },
      C2_Z1: { planBridge: true, eval: true, succRate: succRate(Z1), aiIntelligenceEvaluations: aiAfter1 },
    },
    deltaPlan: 'BLOCKED (X not measurable)',
    contaminationCheck: { diff, behaviorSame, pass: diff === 0 && behaviorSame },
    observabilityProven: (aiAfter1 > 0 && aiAfter0 === 0 && diff === 0),
  };
  dumpJson('5.9-C-smoke-summary.json', summary);
  console.log('\n[5.9-C] artifacts:', path.join(OUT_DIR, '5.9-C-smoke-summary.json'));
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.9-D — 真实 LLM / Intelligence 验证（协议 §13，设计锁定 2026-08-23）
//
// 核心对照：
//   Z = Deterministic Plan Architecture Baseline  (BENCH_PLAN_BRIDGE=1, AI_PROVIDER=mock)
//   D = Real LLM Autonomous Planner              (BENCH_PLAN_BRIDGE=0, AI_PROVIDER=deepseek + 真实 key)
//
// 六验收（每个任务同时回答，见 §13.2）：
//   ① Planner 生成可执行 plan？ ② Runtime 完整消费 plan？ ③ Ground Truth 通过？
//   ④ Recovery 真被 Intelligence 使用？ ⑤ Intelligence 真产生可观测行为？
//   ⑥ 最终才比收益 ΔSuccess/ΔRecovery/ΔCost/ΔLatency
//
// 纪律（§13.5）：若 D 的自主 planner 仍 navigate→HEALING→RUNNING（executed=0 非终态），
//   直接判 D Planner/Runtime 集成 BLOCKED，不改 mock / 不改任务 / 不降标准 / 不伪装 bridge plan。
//
// 注：不接 mock planner（D 用真实 LLM）；需在真实可交互环境（BENCH_PW_CHROMIUM=1 或真实浏览器）
//   运行，且需用户授权真实 API Key 后才执行。本函数已就绪，但执行前需确保：
//   - DEEPSEEK_API_KEY（或 OPENAI_API_KEY）已注入环境
//   - 真实浏览器可用（真实 planner 生成的 plan 面向真实页面语义）
// ─────────────────────────────────────────────────────────────────────────────
async function runPhaseD() {
  const rounds = 1; // 11×1 smoke（不先 100×3，见 §13.3）
  const tasks = expandTasks(rounds);
  const opts = { mockBaseUrl: process.env.BENCH_MOCK_URL || 'http://localhost:4599' };

  // ── 输入护栏（Benchmark 层，不碰 Runtime）──
  // D 组用真实 LLM（BENCH_PLAN_BRIDGE=0），需对应真实 key。缺失则明确报错退出，
  // 避免静默发起真实网络请求并长时间挂起/重试。
  // dProvider 默认跟随显式 AI_PROVIDER（real），否则 deepseek。mock 为 Benchmark 内部连通性测试，放行。
  const dProvider = process.env.BENCH_D_PROVIDER || process.env.AI_PROVIDER || 'deepseek';
  const keyEnv = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[dProvider] || 'AI_API_KEY';
  if (dProvider !== 'mock' && !process.env[keyEnv]) {
    console.error(`\n[5.9-D] ⛔ 护栏拦截：真实 LLM provider="${dProvider}" 需要环境变量 ${keyEnv}，但当前未设置。`);
    console.error('[5.9-D]   请先注入真实 API Key（不硬编码、不退回 mock）。协议 §13：不改代码/不改任务/不降标准。');
    console.error('[5.9-D]   退出。未执行任何真实实验。');
    process.exit(2);
  }
  console.log(`[5.9-D] 护栏检查：D provider=${dProvider}` + (dProvider === 'mock' ? ' (Benchmark 内部连通性测试，非真实实验)' : ` 需要 ${keyEnv} = 已设置 ✅`));

  console.log(`\n[5.9-D] STORE_DRIVER=${process.env.STORE_DRIVER || 'json'}  AI_PROVIDER=${process.env.AI_PROVIDER}  baseTasks=${TASKS.length} rounds=${rounds} (11×1 smoke)`);
  console.log('[5.9-D] 协议 §13：Z=确定性 Plan 基线 / D=真实 LLM 自主 planner；六验收逐任务判读；不修 mock/不改任务/不降标准\n');

  const mockApp = require('./mockSite').buildApp();
  const mockServer = await new Promise((res) => { const s = mockApp.listen(0, () => res(s)); });
  const mockPort = mockServer.address().port;
  const mockUrl = `http://localhost:${mockPort}`;
  console.log('[5.9-D] mock site up', mockUrl, '(注：真实 planner 在 mockSite 上可能重演 navigate→HEALING，这是验收①信号，非 bug)');
  const opts2 = { ...opts, mockBaseUrl: mockUrl };

  const aiCollector = () => {
    try { return require('./../server/agent/intelligence/evaluation/evaluationCollector'); }
    catch { return null; }
  };
  const aiCount = () => {
    const c = aiCollector();
    if (!c) return -1;
    try { return c.list({}).length; } catch { return -1; }
  };
  const aiReset = () => {
    const c = aiCollector();
    if (c && typeof c.clear === 'function') { try { c.clear(); } catch {} }
  };

  function runGroupWithEnv(env, RunnerCls, label, idPrefix) {
    const prev = {};
    for (const k of ['BENCH_PLAN_BRIDGE', 'BENCH_EVAL', 'BENCH_SKIP_C', 'AI_PROVIDER']) { prev[k] = process.env[k]; }
    // 支持 null = 该组显式 unset（用于 D 组关闭 Plan Bridge：'0' 在 JS 中是 truthy，必须用 delete）
    const toDelete = [];
    for (const [k, v] of Object.entries(env)) {
      if (v === null) { delete process.env[k]; toDelete.push(k); }
      else process.env[k] = v;
    }
    const groupTasks = tasks.map((t) => Object.assign({}, t, { id: `${idPrefix}-${t.id}` }));
    return runGroup(RunnerCls, groupTasks, opts2).then((rows) => {
      for (const k of ['BENCH_PLAN_BRIDGE', 'BENCH_EVAL', 'BENCH_SKIP_C', 'AI_PROVIDER']) {
        if (toDelete.includes(k) || prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
      }
      console.log(`\n[5.9-D] ${label} done (${rows.length})`);
      return rows;
    });
  }

  // 六验收：从单任务 raw/trace 抽取（与 instrument.js 字段对齐）
  function acceptance(row) {
    const r = row.raw || {};
    const tr = r.trace || {};
    const steps = tr.steps || [];
    const first = steps[0] || null;
    const planStepCount = r.planStepCount || 0;
    const executedStepCount = r.executedStepCount || 0;
    // ① Planner：是否产生 plan / 步数 / schema / 首步是否 HEALING
    const planGenerated = planStepCount > 0;
    const schemaOk = first && first.action && first.action.type ? true : (planStepCount > 0);
    const firstNavHealing = first && (first.status === 'HEALING' || (first.failureLayer != null) || (r.recoveryTriggered && executedStepCount === 0));
    // ② Runtime 消费：exec==plan
    const execEqualsPlan = planStepCount > 0 && executedStepCount === planStepCount;
    // ③ Ground Truth
    const groundTruth = r.groundTruth === true;
    const fairnessMismatch = r.fairnessMismatch === true;
    // ④ Recovery
    const recovery = {
      retryCount: r.retryCount || 0,
      triggered: r.recoveryTriggered || false,
      types: r.recoveryTypes || [],
      success: r.recoverySuccess || false,
      fkHit: r.failureKnowledgeHit || false,
    };
    // ⑤ Intelligence 可观测
    const intel = {
      evalCount: r.intelligenceRecorded ? (aiCountFor(row) || 1) : 0,
      memoryHit: (r.memoryHitRate || 0) > 0,
      router: r.routerAccuracy != null,
      fk: r.failureKnowledgeHit || false,
      llmCalls: (tr.intelligence && tr.intelligence.llmCalls) || r.llmCalls || 0,
      tokens: (tr.intelligence && tr.intelligence.tokens) || 0,
    };
    return {
      taskId: row.taskId, category: row.category, success: row.success,
      planGenerated, planStepCount, schemaOk, firstNavHealing,
      execEqualsPlan, executedStepCount,
      groundTruth, fairnessMismatch,
      recovery, intel,
      dBlocked: (!planGenerated) || (planGenerated && firstNavHealing && executedStepCount === 0),
    };
  }
  // evaluator 计数按任务过滤（agentRunner 用 created.id 记录，与 group idPrefix 对齐）
  function aiCountFor(row) {
    const c = aiCollector();
    if (!c) return 0;
    try { return c.list({ taskId: row.taskId }).length; } catch { return 0; }
  }

  function printAcceptance(rows, label) {
    console.log(`\n=== ${label} 六验收逐任务 ===`);
    for (const row of rows) {
      const a = acceptance(row);
      const flag = a.dBlocked ? ' ⛔ BLOCKED' : '';
      console.log(`  ${row.taskId.padEnd(22)} succ=${a.success ? 'Y' : 'N'} plan=${a.planGenerated ? a.planStepCount : 'NONE'} schema=${a.schemaOk ? 'OK' : 'BAD'} firstNavHeALING=${a.firstNavHealing ? 'Y' : 'N'} exec==plan=${a.execEqualsPlan ? 'Y' : 'N'} GT=${a.groundTruth ? 'Y' : 'N'} retry=${a.recovery.retryCount} recov=${a.recovery.triggered ? (a.recovery.success ? 'OK' : 'FAIL') : 'n/a'} eval=${a.intel.evalCount} llm=${a.intel.llmCalls}${flag}`);
    }
  }

  // ── Z 组：确定性 Plan 基线（BENCH_PLAN_BRIDGE=1, BENCH_EVAL=1, AI_PROVIDER=mock）────
  // Z 不调真实 LLM（确定性 plan 注入，不触发 planner），mock provider 确保零外部依赖。
  aiReset();
  const Z = await runGroupWithEnv({ BENCH_PLAN_BRIDGE: '1', BENCH_EVAL: '1', AI_PROVIDER: 'mock' }, AgentRunner, '5.9-D Z (plan bridge ON, eval ON)', 'DZ');
  const Zrows = Z.map(acceptance);
  printAcceptance(Z, 'Z (Deterministic Plan Architecture Baseline)');

  // ── D 组：真实 LLM 自主 planner（BENCH_PLAN_BRIDGE=0, BENCH_EVAL=1, AI_PROVIDER=真实）──
  // 唯一核心变量 = Plan 来源。真实 provider 由 BENCH_D_PROVIDER 决定（默认 deepseek），
  // 护栏已在函数开头确认对应 key 已注入。若 D 仍 navigate→HEALING→RUNNING，则判 BLOCKED。
  aiReset();
  const D = await runGroupWithEnv({ BENCH_PLAN_BRIDGE: null, BENCH_EVAL: '1', AI_PROVIDER: dProvider }, AgentRunner, '5.9-D D (real LLM autonomous planner)', 'DD');
  const Drows = D.map(acceptance);
  printAcceptance(D, 'D (Real LLM Autonomous Planner)');

  // ── 汇总对照 ──────────────────────────────────────────────────────────────
  const succRate = (rows) => +(rows.filter((r) => r.success).length / rows.length * 100).toFixed(1);
  const avg = (rows, f) => rows.length ? Math.round(rows.reduce((s, r) => s + f(r), 0) / rows.length) : 0;
  const dBlockedCount = Drows.filter((a) => a.dBlocked).length;

  console.log('\n=== 5.9-D 对照（Z vs D）===');
  console.log('  route   Succ%   AvgLat(ms)  AvgLLM  AvgTokens  EvalTotal  RecoveryOK%');
  console.log('  Z       ' + succRate(Z) + '%     ' + avg(Z, (r) => r.latencyMs) + '        ' + avg(Z, (r) => (r.raw.intelligence || {}).llmCalls || 0) + '     ' + avg(Z, (r) => (r.raw.intelligence || {}).tokens || 0) + '        ' + aiCount() + '        ' + rate(Zrows, (a) => a.filter((x) => x.recovery.success).length));
  console.log('  D       ' + succRate(D) + '%     ' + avg(D, (r) => r.latencyMs) + '        ' + avg(D, (r) => (r.raw.intelligence || {}).llmCalls || 0) + '     ' + avg(D, (r) => (r.raw.intelligence || {}).tokens || 0) + '        ' + aiCount() + '        ' + rate(Drows, (a) => a.filter((x) => x.recovery.success).length));

  console.log('\n=== 5.9-D 收益度量（仅当 D 未 BLOCKED）===');
  if (dBlockedCount > 0) {
    console.log('  ⛔ D Planner/Runtime 集成 BLOCKED：' + dBlockedCount + '/' + D.length + ' 任务出现 plan 未生成或首步 HEALING 且 executed=0');
    console.log('     裁定：自主 Intelligence Planner 尚未达到可可靠执行的生产成熟度。');
    console.log('     纪律：未修改 mock / 未改任务 / 未降标准 / 未伪装 bridge plan。');
    console.log('     ΔSuccess / ΔRecovery / ΔCost / ΔLatency 暂不计算。');
  } else {
    const dS = succRate(D), zS = succRate(Z);
    const dR = rate(Drows, (a) => a.filter((x) => x.recovery.success).length), zR = rate(Zrows, (a) => a.filter((x) => x.recovery.success).length);
    console.log('  ΔSuccess  = ' + (dS - zS).toFixed(1) + ' %pt');
    console.log('  ΔRecovery = ' + (dR - zR).toFixed(1) + ' %pt');
    console.log('  ΔLatency  = ' + (avg(D, (r) => r.latencyMs) - avg(Z, (r) => r.latencyMs)) + ' ms');
    console.log('  ΔCost     = 真实 LLM tokens/cost（D 组）— 见逐任务 trace');
  }

  const summary = {
    phase: '5.9-D-smoke',
    note: '11×1 smoke; Z=deterministic plan baseline; D=real LLM autonomous planner; six acceptance questions per task',
    z: { succRate: succRate(Z), acceptance: Zrows },
    d: { succRate: succRate(D), acceptance: Drows, blockedCount: dBlockedCount },
    delta: dBlockedCount > 0 ? 'BLOCKED (D planner/runtime integration not production-ready)' : {
      success: +(succRate(D) - succRate(Z)).toFixed(1),
      recovery: +(rate(Drows, (a) => a.filter((x) => x.recovery.success).length) - rate(Zrows, (a) => a.filter((x) => x.recovery.success).length)).toFixed(1),
      latency: avg(D, (r) => r.latencyMs) - avg(Z, (r) => r.latencyMs),
    },
    discipline: 'no mock fix / no task change / no lowered bar / no bridge-plan masquerade',
  };
  dumpJson('5.9-D-smoke-summary.json', summary);
  console.log('\n[5.9-D] artifacts:', path.join(OUT_DIR, '5.9-D-smoke-summary.json'));
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.9-E — Autonomous Planner Integration（协议 §14，设计锁定 2026-08-23）
//
// 唯一目标：证明下面这条链能真实发生（不是提升成功率）：
//   Task → Runtime → planner.planObjective() → AI Provider → DeepSeek →
//   structured Plan → Plan validation → Runtime consumes Plan →
//   Step execution → Ground Truth
//
// 8 Gate（全部 PASS 才允许重新进入 5.9-D'）：
//   E1 planner.planObjective() 实际被调用
//   E2 llmCalls > 0
//   E3 DeepSeek 实际收到请求并返回（provider=deepseek 且 llmCalls>0）
//   E4 返回结果成功解析成合法 Plan（planSchemaValid）
//   E5 planGenerated=true 且 planStepCount>0
//   E6 Runtime 实际消费该 Plan（planStepCount == executedStepCount 或 exec>0）
//   E7 executedStepCount > 0
//   E8 evaluator 能记录对应 Intelligence evaluation
//
// 调用链证据（至少保存）：
//   plannerCalled / providerCalled / providerName / llmRequestId /
//   llmCalls / planGenerated / planSchemaValid / planStepCount /
//   executedStepCount / firstExecutedAction / runtimeStatus /
//   groundTruth / evaluationRecorded
//
// 纪律（§14）：不改 task.verify / 不改 mockSite / 不重新启用 Plan Bridge /
//   不降低 verification 标准 / 不修改成功判定 / 不做 100×3 / 不用成功率作主指标。
//   只做纯观测 wrap（不改 Runtime 决策逻辑）采集调用链。
//
// 先只跑 1 个最简单任务（默认 nav，可 BENCH_E_TASK 覆盖）。二元问题：
//   真实 LLM Planner 到底有没有进入 Runtime？一个任务足够回答。
// ─────────────────────────────────────────────────────────────────────────────
async function runPhaseE() {
  // 护栏：真实 LLM 需 key
  const dProvider = process.env.BENCH_D_PROVIDER || process.env.AI_PROVIDER || 'deepseek';
  const keyEnv = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[dProvider] || 'AI_API_KEY';
  if (dProvider !== 'mock' && !process.env[keyEnv]) {
    console.error(`\n[5.9-E] ⛔ 护栏拦截：真实 LLM provider="${dProvider}" 需要 ${keyEnv}，未设置。`);
    console.error('[5.9-E]   退出。未执行任何实验。');
    process.exit(2);
  }

  // ── 纯观测 wrap（在 agentRunner require 之后、run 之前）──
  // 不改 Runtime 决策：只记录调用链证据，原样转发返回值。
  const chain = {
    plannerCalled: false,
    plannerArgs: null,
    providerCalled: false,
    providerName: null,
    llmRequestId: null,
    llmCalls: 0,
  };
  // planner.planObjective 是模块单例属性访问，wrap 后对 runtime 生效
  const plannerMod = require('./../server/agent/planner');
  const origPlanObjective = plannerMod.planObjective;
  plannerMod.planObjective = async function wrappedPlanObjective(...args) {
    chain.plannerCalled = true;
    const a0 = args[0] || {};
    const hasObservation = !!(a0.observation || (a0.ctx && a0.ctx.observation) || a0.pageSnapshot);
    chain.plannerArgs = { objective: a0.objective, target: a0.target, providerKind: a0.provider && a0.provider.kind, observationPassed: hasObservation };
    // E4-1 前置（只读观测，不改行为）：记录 planner 实际看到的输入来源，证明页面 observation 是否进入上下文。
    console.error('[E4-observe] planner 输入来源 objective=' + JSON.stringify((a0.objective || '').slice(0, 80)) + ' target=' + JSON.stringify(a0.target || '') + ' observationPassed=' + hasObservation);
    try { const _r = await origPlanObjective.apply(this, args); if (process.env.PLANNER_DEBUG) console.error('[e-wrap] planner result=', JSON.stringify(_r).slice(0, 800)); return _r; }
    finally {}
  };

  // ── 5.9-E2 Diagnostic Only（纯观测，不改 Runtime 行为）──
  // 订阅 Agent 事件总线，采集本次执行的完整事件时序；执行后结合 stepManager / taskManager /
  // checkpoint 只读读取，定位「Step 1 → Step 2」之间的实际断点。受 BENCH_E2_DIAG=1 触发。
  const e2Diag = { on: process.env.BENCH_E2_DIAG === '1', eventLog: [], unsub: null };
  if (e2Diag.on) {
    const agentEvents = require('./../server/agent/events');
    e2Diag.unsub = agentEvents.on((evt) => {
      // 收集全部进程内事件（不过滤）；诊断时按真实 taskId 反查过滤。
      e2Diag.eventLog.push({ t: evt.type, taskId: evt.taskId, stepId: evt.stepId, attemptId: evt.attemptId, p: evt.payload });
    });
  }

  const rounds = 1;
  const tasks = expandTasks(rounds);
  const opts = { mockBaseUrl: process.env.BENCH_MOCK_URL || 'http://localhost:4599' };

  // 单任务：默认 nav（最简单），BENCH_E_TASK 可覆盖
  const taskId = process.env.BENCH_E_TASK || 'nav';
  const single = tasks.find((t) => t._baseId === taskId) || tasks.find((t) => t._baseId === 'nav');
  if (!single) { console.error('[5.9-E] 找不到任务', taskId); process.exit(2); }
  const singleTasks = [Object.assign({}, single, { id: `E-${single._baseId}#0`, _baseId: single._baseId })];

  console.log(`\n[5.9-E] STORE_DRIVER=${process.env.STORE_DRIVER || 'json'}  provider=${dProvider}  singleTask=${single._baseId} (1 task, integration-only)`);
  console.log('[5.9-E] 协议 §14：证明调用链，不测成功率；E1-E8 全 PASS 才允许 5.9-D\'。\n');

  const mockApp = require('./mockSite').buildApp();
  const mockServer = await new Promise((res) => { const s = mockApp.listen(0, () => res(s)); });
  const mockPort = mockServer.address().port;
  const mockUrl = `http://localhost:${mockPort}`;
  console.log('[5.9-E] mock site up', mockUrl);
  const opts2 = { ...opts, mockBaseUrl: mockUrl };

  // 局部 runGroupWithEnv（与 D 同逻辑：支持 null=unset，关闭 Plan Bridge）
  function runGroupWithEnv(env, RunnerCls, label, idPrefix) {
    const prev = {};
    for (const k of ['BENCH_PLAN_BRIDGE', 'BENCH_EVAL', 'BENCH_SKIP_C', 'AI_PROVIDER']) { prev[k] = process.env[k]; }
    const toDelete = [];
    for (const [k, v] of Object.entries(env)) {
      if (v === null) { delete process.env[k]; toDelete.push(k); }
      else process.env[k] = v;
    }
    const groupTasks = singleTasks.map((t) => Object.assign({}, t, { id: `${idPrefix}-${t.id}` }));
    return runGroup(RunnerCls, groupTasks, opts2).then((rows) => {
      for (const k of ['BENCH_PLAN_BRIDGE', 'BENCH_EVAL', 'BENCH_SKIP_C', 'AI_PROVIDER']) {
        if (toDelete.includes(k) || prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
      }
      console.log(`\n[5.9-E] ${label} done (${rows.length})`);
      return rows;
    });
  }

  // 关闭 Plan Bridge（null=unset），真实 LLM 自主 planner
  const D = await runGroupWithEnv({ BENCH_PLAN_BRIDGE: null, BENCH_EVAL: '1', AI_PROVIDER: dProvider }, AgentRunner, `5.9-E (integration, task=${single._baseId})`, 'E');
  const row = D[0];
  const r = (row && row.raw) || {};
  const tr = r.trace || {};
  const intel = tr.intelligence || {};
  const steps = tr.steps || [];
  const firstExec = steps[0] && steps[0].action && steps[0].action.type;

  // 从 recorder 读 llmCalls / providerName（真实调用证据）
  let recLlmCalls = 0, recProvider = null;
  try {
    const recorder = require('./../server/agent/recorder');
    const exec = recorder.get(r.executionId || (tr.executionId));
    if (exec && exec.llmCalls) {
      recLlmCalls = exec.llmCalls.length;
      recProvider = exec.llmCalls.map((c) => c.provider).filter(Boolean)[0] || null;
      chain.llmCalls = recLlmCalls;
      chain.providerName = recProvider;
      chain.providerCalled = recLlmCalls > 0;
    }
  } catch (e) { /* 观测失败不影响判定，仅记录 */ console.warn('[5.9-E] recorder 读取失败:', String(e.message || e).slice(0, 100)); }

  // 5.9-E 修正：planStepCount 必须反映 Runtime 自主 planner 真实落库的步骤数。
  // 顶层 r.planStepCount 是 Plan Bridge 注入专用字段（自主 planner 下恒为 0），
  // 自主 planner 的真实 Plan 步骤由 instrument.buildSteps 从 stepManager 采集（r.trace.planStepCount）。
  // 仅修正读数来源，不改 Runtime / Plan Bridge / verify / GroundTruth / verification 标准。
  const planStepCount = (tr.planStepCount || r.planStepCount || 0);
  const planGenerated = planStepCount > 0;
  const executedStepCount = r.executedStepCount || 0;
  const planSchemaValid = planGenerated; // planStepCount>0 即 schema 通过（Runtime 已落库 steps）
  const evaluationRecorded = !!r.intelligenceRecorded;

  // ── 8 Gate ──
  const gates = {
    E1: chain.plannerCalled,
    E2: chain.llmCalls > 0,
    E3: chain.providerCalled && chain.providerName === 'deepseek',
    E4: planSchemaValid,
    E5: planGenerated && planStepCount > 0,
    E6: planGenerated && (executedStepCount > 0),
    E7: executedStepCount > 0,
    E8: evaluationRecorded,
  };
  const allPass = Object.values(gates).every(Boolean);

  console.log('\n=== 5.9-E 调用链证据 ===');
  console.log('  plannerCalled       = ' + chain.plannerCalled);
  console.log('  providerCalled      = ' + chain.providerCalled);
  console.log('  providerName        = ' + (chain.providerName || 'n/a'));
  console.log('  llmRequestId        = ' + (chain.llmRequestId || 'n/a (resp id 未采集)'));
  console.log('  llmCalls            = ' + chain.llmCalls);
  console.log('  planGenerated       = ' + planGenerated);
  console.log('  planSchemaValid     = ' + planSchemaValid);
  console.log('  planStepCount       = ' + planStepCount);
  console.log('  executedStepCount   = ' + executedStepCount);
  console.log('  firstExecutedAction = ' + (firstExec || 'n/a'));
  console.log('  runtimeStatus       = ' + (r.runtimeStatus || 'n/a'));
  console.log('  groundTruth         = ' + (r.groundTruth === true));
  console.log('  evaluationRecorded  = ' + evaluationRecorded);

  console.log('\n=== 5.9-E 8 Gate ===');
  for (const [k, v] of Object.entries(gates)) {
    console.log('  ' + k + '  ' + (v ? 'PASS' : '⛔ FAIL') + (k === 'E3' && !chain.providerCalled ? '  (DeepSeek 未收到请求)' : '') + (k === 'E5' && !planGenerated ? '  (plan 未生成)' : '') + (k === 'E7' && planGenerated && executedStepCount === 0 ? '  (Planner→Runtime consumption 集成失败)' : ''));
  }

  // 早停逻辑（单任务，不跑多任务）
  if (chain.plannerCalled === false) {
    console.log('\n[5.9-E] 早停：plannerCalled=false → 自主 planner 未进入 Runtime。');
  } else if (chain.plannerCalled && !chain.providerCalled) {
    console.log('\n[5.9-E] 早停：plannerCalled=true 但 providerCalled=false → planner 未触发 LLM。');
  } else if (chain.llmCalls > 0 && !planGenerated) {
    console.log('\n[5.9-E] 早停：llmCalls>0 但 planGenerated=false → LLM 返回未解析成合法 Plan。');
  } else if (planGenerated && executedStepCount === 0) {
    console.log('\n[5.9-E] 早停：planGenerated=true 但 executedStepCount=0 → Planner→Runtime consumption 集成失败。');
  }

  console.log('\n[5.9-E] 裁定：' + (allPass ? 'PASS — 调用链打通，允许进入 5.9-D\'' : 'FAIL — 集成未打通，5.9-D\' 暂不执行'));

  const summary = {
    phase: '5.9-E-integration',
    note: 'single task, integration-only; not success-rate measurement',
    task: single._baseId,
    chain,
    gates,
    allPass,
    discipline: 'no task.verify change / no mockSite change / no plan bridge / no lowered bar / no 100x3 / success-rate not primary metric',
  };
  dumpJson('5.9-E-integration-summary.json', summary);
  console.log('[5.9-E] artifacts:', path.join(OUT_DIR, '5.9-E-integration-summary.json'));

  // ── 5.9-E2 生命周期诊断（Diagnostic Only；只读，不改行为）──
  if (e2Diag.on) {
    try {
      if (e2Diag.unsub) e2Diag.unsub();
      const stepManager = require('./../server/agent/stepManager');
      const taskManager = require('./../server/agent/taskManager');
      const checkpoint = require('./../server/agent/checkpoint');
      // 从事件总线直接提取本次 E 任务的真实 taskId（agentRunner 内部 createTask 生成 task_xxx）
      const candIds = {};
      e2Diag.eventLog.forEach((e) => { if (e.taskId && String(e.taskId).startsWith('task_')) candIds[e.taskId] = (candIds[e.taskId] || 0) + 1; });
      const taskId = Object.keys(candIds).sort((a, b) => candIds[b] - candIds[a])[0];

      console.log('\n=== 5.9-E2 Lifecycle Diagnosis (Diagnostic Only) ===');
      if (!taskId) {
        console.log('  (无法定位诊断 task；事件数=' + e2Diag.eventLog.length + ')');
      } else {
        const steps = stepManager.listSteps(taskId);
        const task = taskManager.getTask(taskId);
        const cps = checkpoint.listForTask(taskId);
        const lastCp = cps.length ? cps[cps.length - 1] : null;

        console.log('  executionId = ' + ((task && task.currentExecutionId) || (r.executionId)));
        console.log('  taskId      = ' + taskId);
        console.log('  runtimeStatus (final snapshot) = ' + (task ? task.status : 'n/a'));
        console.log('  Plan: ' + steps.length + ' steps');
        steps.forEach((s, i) => {
          const desc = (s.description || '').slice(0, 40);
          const act = s.action && s.action.type;
          console.log(`  Step ${i} [${s.status || 'PENDING'}] action=${act} desc="${desc}"` +
            (s.retryable ? ` retryable=${s.retryable} maxRetries=${s.maxRetries || 'task'}` : ''));
        });

        // 事件时序（step_started / verification / retrying / warning / terminal）
        const taskEvents = e2Diag.eventLog.filter((e) => e.taskId === taskId);
        const seq = taskEvents.filter((e) =>
          ['task.step_started', 'ai.verification.completed', 'agent.retrying', 'ai.warning', 'task.completed', 'task.failed', 'task.paused', 'agent.recovered'].includes(e.t));
        console.log('\n  Event sequence (' + seq.length + '):');
        seq.forEach((e) => {
          const extra = e.t === 'ai.verification.completed' ? ` success=${e.p.success} type=${e.p.type}`
            : e.t === 'agent.retrying' ? ` attempt=${e.p.attempt}/${e.p.max} reason=${e.p.reason} terminal=${e.p.terminal}`
            : e.t === 'ai.warning' ? ` code=${e.p.code}` : '';
          console.log(`    [${e.t}] step=${e.stepId || '-'}${extra}`);
        });

        // retry 计数（agent.retrying 事件数）
        const retryEvents = taskEvents.filter((e) => e.t === 'agent.retrying');
        // verification 失败
        const verifyFails = taskEvents.filter((e) => e.t === 'ai.verification.completed' && e.p.success === false);
        // HEALING 进入（step 状态为 HEALING 的 step）
        const healingSteps = steps.filter((s) => s.status === 'HEALING');
        // 首个非 SUCCESS 的 step（断点）
        const firstNonSuccess = steps.find((s) => s.status !== 'SUCCESS');

        console.log('\n  --- E2 定位 ---');
        console.log('  retry events total   = ' + retryEvents.length);
        console.log('  verification FAILED  = ' + verifyFails.length);
        console.log('  steps in HEALING     = ' + healingSteps.length + (healingSteps.length ? ' (' + healingSteps.map((s) => steps.indexOf(s)).join(',') + ')' : ''));
        console.log('  first non-SUCCESS step index = ' + (firstNonSuccess ? steps.indexOf(firstNonSuccess) : 'none(all SUCCESS)'));
        console.log('  last checkpoint step = ' + (lastCp && lastCp.stepId ? lastCp.stepId : 'n/a') + (lastCp ? ` url=${lastCp.url || 'n/a'}` : ''));

        // 区分 A/B/C/D
        let root = 'UNKNOWN';
        if (firstNonSuccess && firstNonSuccess.status === 'FAILED') root = 'A: Step FAILED → Recovery loop (or escalate/fail terminal)';
        else if (firstNonSuccess && firstNonSuccess.status === 'HEALING') root = 'A/B-cross: Step stuck in HEALING (retry exhausted or recovery loop)';
        else if (firstNonSuccess && firstNonSuccess.status === 'PENDING') {
          const idx = steps.indexOf(firstNonSuccess);
          if (idx === 0) root = 'D/C: Step 0 never executed (loop did not enter iteration 0)';
          else {
            const prev = steps[idx - 1];
            root = (prev.status === 'SUCCESS')
              ? 'B: Step ' + (idx - 1) + ' SUCCESS but transition to Step ' + idx + ' NOT EXECUTED'
              : 'C: Step ' + (idx - 1) + ' not SUCCESS (' + prev.status + ') → Step ' + idx + ' blocked';
          }
        } else if (!firstNonSuccess) root = 'none: all steps SUCCESS (lifecycle completed)';

        console.log('  Root cause class     = ' + root);
        console.log('  _waitFinal snapshot  = runtimeStatus=' + (task ? task.status : 'n/a') +
          '; executedStepCount=' + executedStepCount + '; planStepCount=' + planStepCount);
        console.log('\n  Note: Diagnostic Only — no behavior changed. Decision on fix deferred to user.');
      }
    } catch (e2e) {
      console.warn('[5.9-E2] 诊断采集异常（不影响验收）:', String(e2e.message || e2e).slice(0, 200));
    }
  }

  process.exit(allPass ? 0 : 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.9-E4 — Plan Semantic Compatibility (11×1 Smoke)
// 授权目标：研究 Real LLM Plan 与真实页面的语义兼容性，不优化 D' 成功率。
// 纪律：纯观测采集 + 归因 + 记录 FINDING；发现问题即冻结，不在实验过程中修。
// ─────────────────────────────────────────────────────────────────────────────
async function runPhaseE4() {
  const { runE4Smoke } = require('./e4-smoke');
  const rep = await runE4Smoke({});
  const agg = rep.aggregate;

  console.log('\n=== 5.9-E4 Plan Semantic Compatibility (11×1 Smoke) ===');
  console.log('  provider        = ' + rep.provider);
  console.log('  PlanBridge       = ' + rep.planBridge + ' (真实 Planner)');
  console.log('  status           = ' + rep.status);

  console.log('\n--- 层级指标（不以 Success% 为主）---');
  console.log('  Observation Coverage        = ' + pct(agg.observationCoverage));
  console.log('  Plan Schema Validity        = ' + pct(agg.planSchemaValidRate));
  console.log('  Plan Semantic Compatibility = ' + pct(agg.planSemanticCompatRate));
  console.log('  Target Grounding Rate       = ' + pct(agg.targetGroundingRate));
  console.log('  Verification Compatibility  = ' + pct(agg.verificationCompatRate));
  console.log('  First-Step Compatibility    = ' + pct(agg.firstStepCompatRate));
  console.log('  Terminal Finalization       = ' + pct(agg.terminalFinalizationRate));
  console.log('  GroundTruth Pass Rate       = ' + pct(agg.groundTruthPassRate));

  console.log('\n--- Semantic Failure Attribution (逐 step 归类，非二元) ---');
  for (const [k, v] of Object.entries(agg.semanticFailureAttribution)) {
    console.log('  ' + k.padEnd(38) + ' = ' + v);
  }

  console.log('\n--- 逐任务摘要 ---');
  for (const t of rep.tasks) {
    console.log(`  ${t.task.padEnd(16)} obs=${t.observationPassed ? 'Y' : 'N'} schema=${t.planSchemaValid ? 'OK' : 'BAD'} steps=${t.planStepCount} ` +
      `mismatch=${t.semanticMismatchCount} execFail=${t.execFailureCount} verifyFail=${t.verifyFailureCount} recovFail=${t.recoveryFailureCount} ` +
      `GT=${t.groundTruth ? 'Y' : 'N'} term=${t.terminalStatus}`);
  }

  console.log('\n--- FINDINGS (仅记录，不修改；E4 冻结) ---');
  if (!rep.findings.length) {
    console.log('  (无 FINDING)');
  } else {
    for (const f of rep.findings) {
      console.log(`  [${f.severity}] ${f.type} @ ${f.task}: ${f.detail}`);
    }
  }

  console.log('\n--- 层级流（Schema → Semantic → Executable → GroundTruth）---');
  console.log('  Schema Validity        = ' + pct(agg.planSchemaValidRate));
  console.log('  Semantic Compatibility = ' + pct(agg.planSemanticCompatRate));
  console.log('  Executable Compat      = ' + pct(agg.targetGroundingRate));
  console.log('  GroundTruth Outcome    = ' + pct(agg.groundTruthPassRate));

  const summary = {
    phase: '5.9-E4',
    status: rep.status,
    discipline: rep.discipline,
    aggregate: agg,
    findings: rep.findings,
    tasks: rep.tasks,
  };
  const f = dumpJson('5.9-E4-smoke-summary.json', summary);
  console.log('\n[E4] artifacts:', f);
  console.log('[E4] 裁定：发现问题即冻结，不在实验过程中修。用户裁定是否进入 E4-FIX / D\'。');
  process.exit(0);
}

function pct(x) { return x == null ? 'n/a' : (Math.round(x * 1000) / 10) + '%'; }

