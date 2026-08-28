'use strict';
// run_live100.js — STEP 2 真实 100-task live 评估编排器（新增，不改动既有 harness / 口径）。
//
// 行为：
//   - 复用 phase10Benchmark 的真实 runScenario（DeepSeek 规划 + Chromium 驱动 + 真实验证/恢复）。
//   - 每个 scenario 跑完后，从共享 store 中隔离快照「本 run 产生的 P9 任务」相关数据，
//     避免与任何历史/并发 store 数据污染。
//   - 原始 raw runtime outcome 直接落盘（perTask + P9.aggregate summary），不做任何改写。
//   - 数据仅用于后续只读后处理（analyze_live100.js）。
//   - 健壮性：单任务超时（默认 240s）→ 超时记为 RUNNER_ERROR 并继续；增量落盘；支持 --resume 断点续跑。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-... node server/scripts/run_live100.js
//     [--pool phase12_pool.json] [--out-raw .benchmark/phase3_live100_raw.json]
//     [--out-store .benchmark/phase3_live_raw_store] [--progress .benchmark/phase3_live100_progress.jsonl]
//     [--timeout-ms 240000] [--resume]

const fs = require('fs');
const path = require('path');

const P9 = require('./phase10Benchmark'); // 顶部守卫：缺 DEEPSEEK_API_KEY 直接 exit(2)
const store = require('../agent/store');

const OUT_DIR = path.resolve(__dirname, '..', '..', '.benchmark');
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {}

function resolveScenarios(poolPath) {
  const raw = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.tasks)) return raw.tasks;
  if (Array.isArray(raw.scenarios)) return raw.scenarios;
  return Object.values(raw).filter((v) => v && typeof v === 'object' && v.objective);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT after ' + ms + 'ms (' + label + ')')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const poolPath = path.resolve(__dirname, '..', '..', get('--pool', 'phase12_pool.json'));
  const outRaw = get('--out-raw', path.join(OUT_DIR, 'phase3_live100_raw.json'));
  const outStore = get('--out-store', path.join(OUT_DIR, 'phase3_live_raw_store'));
  const progressFile = get('--progress', path.join(OUT_DIR, 'phase3_live100_progress.jsonl'));
  const timeoutMs = parseInt(get('--timeout-ms', '240000'), 10);
  const resume = argv.includes('--resume');
  const resumeManifestPath = path.join(OUT_DIR, 'phase3_live_resume.json');

  const scenarios = resolveScenarios(poolPath);
  console.log('[live100] 场景数 =', scenarios.length, '| pool =', poolPath, '| timeout =', timeoutMs, 'ms | resume =', resume);

  // ---- 断点续跑：载入既有快照 collectors + 已完成清单 ----
  const collectors = { aiTasks: [], aiSteps: [], aiAttempts: [], aiEvents: [], aiRepairAttempts: [], aiFailureSnapshots: [] };
  const collectedTaskIds = new Set();
  const doneSet = new Set();      // 已完成 scenario.taskId
  const rawResults = [];          // 已完成的 rec（含续跑载入）
  if (resume) {
    try {
      const man = JSON.parse(fs.readFileSync(resumeManifestPath, 'utf8'));
      for (const e of man) {
        doneSet.add(e.taskId);
        rawResults.push(e.rec);
        if (e.taskId) collectedTaskIds.add(e.taskId); // 占位，避免重复收集（实际按 createdAt 过滤）
      }
      console.log('[live100] 续跑：已载入', doneSet.size, '个已完成场景');
    } catch (e) { console.log('[live100] 无既有续跑清单，从 0 开始'); }
    // 载入既有 outStore collectors（保留上轮已收集的 73 个任务数据）
    try {
      for (const k of Object.keys(collectors)) {
        const p = path.join(outStore, k + '.json');
        if (fs.existsSync(p)) collectors[k] = JSON.parse(fs.readFileSync(p, 'utf8'));
      }
      console.log('[live100] 续跑：已载入既有 outStore 快照');
    } catch (e) { console.log('[live100] 无既有 outStore，从 0 开始'); }
  } else {
    // 全新运行：清理上轮产物
    for (const f of [outRaw, resumeManifestPath, progressFile]) { try { fs.unlinkSync(f); } catch (e) {} }
    try { fs.rmSync(outStore, { recursive: true, force: true }); } catch (e) {}
  }

  const mock = await P9.startMockServer();
  const baseUrl = `http://127.0.0.1:${mock.server.address().port}`;

  function collectNewForRun(runStartTs) {
    const tasks = store.read('aiTasks', []);
    const newTasks = tasks.filter((t) => !collectedTaskIds.has(t.id) && /^P9 /.test(t.name || '') && (t.createdAt || 0) >= runStartTs);
    for (const t of newTasks) {
      collectedTaskIds.add(t.id);
      const stepsAll = store.read('aiSteps', []);
      const stepIds = new Set(stepsAll.filter((s) => s.taskId === t.id).map((s) => s.id));
      const steps = stepsAll.filter((s) => stepIds.has(s.id));
      const attempts = store.read('aiAttempts', []).filter((a) => stepIds.has(a.stepId));
      const events = store.read('aiEvents', []).filter((e) => e.taskId === t.id);
      const repairs = store.read('aiRepairAttempts', []).filter((r) => r.taskId === t.id);
      const snaps = store.read('aiFailureSnapshots', []).filter((s) => s.taskId === t.id);
      collectors.aiTasks.push(t);
      collectors.aiSteps.push(...steps);
      collectors.aiAttempts.push(...attempts);
      collectors.aiEvents.push(...events);
      collectors.aiRepairAttempts.push(...repairs);
      collectors.aiFailureSnapshots.push(...snaps);
    }
  }

  function persistIncremental() {
    try {
      fs.mkdirSync(outStore, { recursive: true });
    } catch (e) {}
    for (const k of Object.keys(collectors)) {
      fs.writeFileSync(path.join(outStore, k + '.json'), JSON.stringify(collectors[k], null, 2), 'utf8');
    }
    fs.writeFileSync(outRaw, JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: 'LIVE',
      provider: process.env.AI_PROVIDER || 'deepseek',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      pool: poolPath,
      note: 'raw runtime outcome（未经任何改写）；derived 指标见 analyze_live100.js 后处理。',
      partial: rawResults.length < scenarios.length,
      completed: rawResults.length,
      total: scenarios.length,
      perTask: rawResults,
    }, null, 2), 'utf8');
    // 续跑清单
    try {
      const man = rawResults.map((rec, idx) => ({ taskId: (scenarios[idx] && (scenarios[idx].taskId || scenarios[idx].id)) || rec.id, rec }));
      fs.writeFileSync(resumeManifestPath, JSON.stringify(man, null, 2), 'utf8');
    } catch (e) {}
  }

  const t0 = Date.now();
  const runStartTs = t0;
  let ran = 0;
  for (let i = 0; i < scenarios.length; i++) {
    const scn = scenarios[i];
    if (!scn.id) scn.id = scn.taskId;
    const key = scn.taskId || scn.id;
    if (resume && doneSet.has(key)) {
      process.stdout.write(`[live100] (${i + 1}/${scenarios.length}) 跳过已完成 ${key}\n`);
      continue;
    }
    const pct = ((i + 1) / scenarios.length * 100).toFixed(1);
    process.stdout.write(`[live100] (${i + 1}/${scenarios.length} ${pct}%) 「${scn.name}」(${key}) ... `);
    let rec;
    try {
      rec = await withTimeout(P9.runScenario(scn, baseUrl), timeoutMs, key);
    } catch (e) {
      rec = { id: key, name: scn.name, category: scn.category, status: 'RUNNER_ERROR', error: String((e && e.message) || e) };
    }
    rawResults.push(rec);
    collectNewForRun(runStartTs);
    persistIncremental(); // 每个任务后增量落盘，避免中断丢数据
    ran++;
    console.log(`status=${rec.status} steps=${rec.stepCount} ok=${rec.successAttempts}/${rec.attemptCount} verif=${rec.verificationPassed}/${rec.verificationTotal} repair=${rec.repairSuccess}/${rec.repairCount} tax=${rec.taxonomy || '-'}`);
    try { fs.appendFileSync(progressFile, JSON.stringify({ i: i + 1, id: rec.id, status: rec.status, ts: Date.now() }) + '\n'); } catch (e) {}
  }

  const summary = P9.aggregate(rawResults);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n[live100] 完成（ran=' + ran + ', total=' + scenarios.length + '）。原始 raw 落盘：', outRaw);
  console.log('[live100] 隔离 store 落盘：', outStore);
  console.log('[live100] 耗时：', elapsed, 's');
  console.log('[live100] summary.successRate =', summary.successRate, '| humanEscalationRate =', summary.humanEscalationRate);

  try { mock.server.close(); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { console.error('[live100] 异常:', (e && e.stack) || e); process.exit(1); });
