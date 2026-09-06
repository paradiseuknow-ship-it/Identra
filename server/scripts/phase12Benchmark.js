'use strict';
// Phase 12 — 100-task 产品级真实验证 runner。
// 复用 Phase 10.9 成熟 harness（phase10Benchmark）的 runScenario/aggregate/startMockServer/loadTasks，
// 保证与 Phase 10.9 基线同口径（同 runtime / verification / success 定义）。仅改写输出文件名为 phase12_*。
// 真实 DeepSeek + 真实 Chromium；无 mock / attachPlan / fallback。每任务独立 profile，串行执行。
const fs = require('fs');
const path = require('path');
// R10-C：repair 价值三分类度量（纯增量指标，零行为改动；见 repairValueMetrics.js 头注）。
const { classifyRepairOutcome, aggregateRepairValue } = require('./repairValueMetrics');

// R7 crash guard（runner 主进程）：无声死亡留证据（见 benchCrashGuard.js 头注）。
require('./benchCrashGuard').install('phase12_runner_' + String(process.env.PHASE12_TAG || 'default').replace(/[^\w-]/g, '_'));

if (!process.env.DEEPSEEK_API_KEY) { console.error('[phase12] 缺少 DEEPSEEK_API_KEY：要求真实 DeepSeek，禁止回退 mock。'); process.exit(2); }
if (process.env.AI_PROVIDER === 'mock') { console.error('[phase12] 检测到 AI_PROVIDER=mock，终止。'); process.exit(2); }
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';

// 预设 task deadline env：必须发生在 require('./phase10Benchmark') 之前——
// 该模块加载时即从 FPB_TASK_DEADLINE 解析 per-task deadline（worker 子进程经
// spawn env 全量继承同样生效）。与下方 TASK_DEADLINE_MS 解析幂等。
(function presetTaskDeadlineEnv() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--task-deadline');
  // R1 迁移（2026-09-03）：canonical 240s——未显式 --task-deadline 时按 canonical 预设，
  // 使默认路径与 dl240 实证配置（240s deadline + repair 预算 120s）完全等价。
  const v = i >= 0 ? parseInt(a[i + 1], 10) : 240000;
  if (v > 0) {
    process.env.FPB_TASK_DEADLINE = String(v);
    // 修复编排预算随 task deadline 同步放大：max(默认 90s, deadline/2)。retry 耗尽后的
    // 修复编排（LLM 诊断 + 3 次浏览器修复动作）在 90s 内真实跑不完（rw.026/046 实证），
    // 预算不足时 REPAIR_TIMEOUT 会把可修复失败误收口为 FAILED。
    // 用户显式设置的 FPB_REPAIR_TIMEOUT_MS 优先不覆盖。
    const cur = parseInt(process.env.FPB_REPAIR_TIMEOUT_MS || '', 10);
    if (!(Number.isFinite(cur) && cur > 0)) {
      process.env.FPB_REPAIR_TIMEOUT_MS = String(Math.max(90000, Math.floor(v / 2)));
    }
  }
})();

const P9 = require('./phase10Benchmark');
const agentScore = require('../agentScore');

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); if (i < 0) return def; const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) return true; return n; }
// harness per-task deadline 可配置化（2026-09-01）：--task-deadline 显式覆盖 worker 内
// phase10 runScenario 的 per-task deadline（经 FPB_TASK_DEADLINE env 透传，spawn env 全量
// 继承，worker 无需改动）。不设 → worker canonical 240000ms 默认（R1 迁移）。
// hard deadline 保护垫 = max(--timeout, task-deadline + 90s)，确保树杀永远晚于业务 deadline；
// --timeout 默认随之 330000 = canonical 240s + 90s 保护垫（R1：默认路径树杀不得先于 240s）。
const TASK_DEADLINE_MS = parseInt(arg('--task-deadline', '0'), 10) || 0;
const PER_TASK_TIMEOUT = Math.max(
  parseInt(arg('--timeout', '330000'), 10) || 330000,
  TASK_DEADLINE_MS ? TASK_DEADLINE_MS + 90000 : 0
);
if (TASK_DEADLINE_MS) process.env.FPB_TASK_DEADLINE = String(TASK_DEADLINE_MS);
const MAX = parseInt(arg('--max', '0'), 10) || 0;

function pct(x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; }

// ── 单任务隔离执行（infra 加固，评分语义零改动）──
// 背景：headless 假死（~1.5-3%/任务概率）令 taskManager.cancel 同步卡死，in-process
// runner 被整体拖死（2026-08-30 run1/run2 两实例）。子进程隔离 + 硬 deadline 树杀后，
// 假死任务转化为 TIMEOUT 记录，run 必然可完成。runScenario/aggregate/池选择不变。
const { spawn } = require('child_process');
const HARD_DEADLINE_MS = PER_TASK_TIMEOUT + 90000;

function fallbackRecord(scn, status, taxonomy, error) {
  return { id: scn.id, name: scn.name, category: scn.category, status, error: error || null,
    stepCount: 0, attemptCount: 0, successAttempts: 0, retries: 0, repairCount: 0, repairSuccess: 0, verificationTotal: 0, verificationPassed: 0,
    latencyMs: null, tokensPrompt: 0, tokensCompletion: 0, taxonomy, escalated: status === 'HUMAN_ESCALATION', escalationKind: null,
    scores: agentScore.compute({ steps: [], attempts: [], retries: 0, repairs: 0, escalated: false, status }) };
}

function runIsolated(scn, port) {
  return new Promise((resolve) => {
    let out = '', done = false, killed = false;
    let child;
    try {
      child = spawn(process.execPath, [path.join(__dirname, 'phase12_task_worker.js'), '--task', scn.id, '--port', String(port)],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { resolve(fallbackRecord(scn, 'RUNNER_ERROR', 'OTHER', String((e && e.message) || e))); return; }
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { process.stderr.write('[worker ' + scn.id + '] ' + d); });
    child.on('error', (e) => finish(fallbackRecord(scn, 'RUNNER_ERROR', 'OTHER', String((e && e.message) || e))));
    child.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('WORKER_RESULT:'));
      if (line) {
        try {
          const parsed = JSON.parse(line.slice('WORKER_RESULT:'.length));
          if (parsed.workerError) return finish(fallbackRecord(scn, 'RUNNER_ERROR', 'OTHER', parsed.workerError));
          return finish(parsed);
        } catch (e) { /* fallthrough */ }
      }
      finish(fallbackRecord(scn, 'RUNNER_ERROR', 'OTHER', killed ? 'worker killed by hard deadline' : 'worker exited without result'));
    });
    setTimeout(() => {
      if (done) return;
      killed = true;
      try {
        if (process.platform === 'win32') {
          require('child_process').execSync('taskkill /pid ' + child.pid + ' /T /F', { stdio: 'ignore' });
        } else { child.kill('SIGKILL'); }
      } catch (e) {}
      finish(fallbackRecord(scn, 'TIMEOUT', 'TIMEOUT', 'hard deadline ' + HARD_DEADLINE_MS + 'ms exceeded（headless 假死防护：子进程树已强杀）'));
    }, HARD_DEADLINE_MS);
  });
}

async function main() {
  let list = P9.loadTasks();
  if (MAX > 0) list = list.slice(0, MAX);
  console.log('== Phase 12 100-task Product Validation ==');
  console.log('[phase12] provider =', process.env.AI_PROVIDER, '| model =', process.env.DEEPSEEK_MODEL || 'deepseek-chat');
  console.log('[phase12] 真实任务数 =', list.length, MAX > 0 ? '(抽样 --max ' + MAX + ')' : '');

  // ── 增量落盘 + 断点续跑（infra 加固，评分语义零改动）──
  // 背景：宿主会话回收已三次杀死长跑（run3/4 与 P1 v1/v2），runner 只在结束态写盘导致
  // 进度全丢。逐任务 append 到 jsonl；重启时跳过已有记录的任务，聚合合并新旧记录。
  const dir = path.resolve(__dirname, '..', '..', '.benchmark');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  // PHASE12_TAG：smoke/专项运行的产物隔离（增量文件与最终 JSON 均改用独立文件名），
  // 防止 smoke 记录混入 100-task 主增量文件。纯管道隔离，评分语义零改动。
  const TAG = String(process.env.PHASE12_TAG || '').trim();
  const incrementalPath = path.join(dir, (TAG ? 'phase12_tag_' + TAG : 'phase12_100task_incremental') + '.jsonl');
  const results = [];
  const doneIds = new Set();
  if (fs.existsSync(incrementalPath)) {
    for (const line of fs.readFileSync(incrementalPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.id) { results.push(r); doneIds.add(r.id); } } catch (e) {}
    }
  }
  if (doneIds.size > 0) console.log('[phase12] [resume] 增量记录', doneIds.size, '个，跳过:', [...doneIds].join(','));

  const mock = await P9.startMockServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;

  for (const scn of list) {
    if (doneIds.has(scn.id)) { console.log(`[phase12] 「${scn.name}」(${scn.id}) ... [resume] 已有记录，跳过`); continue; }
    process.stdout.write(`[phase12] 「${scn.name}」(${scn.id}) ... `);
    const rec = await runIsolated(scn, mock.port);
    rec.repairOutcomeBreakdown = classifyRepairOutcome(rec); // R10-C 增量字段
    results.push(rec);
    try { fs.appendFileSync(incrementalPath, JSON.stringify(rec) + '\n', 'utf8'); } catch (e) {}
    console.log(`status=${rec.status} steps=${rec.stepCount} ok=${rec.successAttempts}/${rec.attemptCount} verif=${rec.verificationPassed}/${rec.verificationTotal} repair=${rec.repairSuccess}/${rec.repairCount} tax=${rec.taxonomy || '-'}`);
  }

  const agg = P9.aggregate(results);
  agg.repairValue = aggregateRepairValue(results); // R10-C 增量字段（历史记录无 breakdown 时自动按原始字段重算）
  const runId = Date.now();
  const out = {
    generatedAt: new Date().toISOString(), runId,
    simulated: false, provider: process.env.AI_PROVIDER, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    resumedFrom: doneIds.size > 0 ? { incrementalFile: path.basename(incrementalPath), resumedCount: doneIds.size } : null,
    selection: { type: 'frozen-pool', poolFile: process.env.FPB_POOL_FILE || 'phase12_pool.json', scenarioDir: process.env.FPB_SCENARIO_DIR || 'server/scenarios/real-world', count: list.length, sha256: (require('crypto').createHash('sha256').update(list.map((s) => s.id).sort().join(','), 'utf8').digest('hex')) },
    summary: agg, perTask: results,
  };

  const outPath = path.join(dir, (TAG ? 'phase12_tag_' + TAG : 'phase12_100task') + '_' + runId + '.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

  console.log('\n========= PHASE 12 100-TASK PRODUCT VALIDATION =========');
  console.log('Total tasks        :', agg.totalTasks);
  console.log('Business Success   :', pct(agg.successRate));
  console.log('Planner            :', pct(agg.plannerSuccessRate));
  console.log('Execution Success  :', pct(agg.executionSuccessRate));
  console.log('Verif accuracy     :', agg.verificationAccuracy == null ? '-' : pct(agg.verificationAccuracy));
  console.log('Repair success     :', agg.repairSuccessRate == null ? 'N/A' : pct(agg.repairSuccessRate));
  const rv = agg.repairValue || {};
  console.log('Repair value       :', rv.repairValueRate == null ? 'N/A' : pct(rv.repairValueRate),
    '(recovered ' + (rv.recovered || 0) + ' / correctFail ' + (rv.correctFail || 0) + ' / ineffectiveFail ' + (rv.ineffectiveFail || 0) + ')');
  console.log('Recovery (bus)     :', agg.recoverySuccessRate == null ? 'N/A' : pct(agg.recoverySuccessRate));
  console.log('Escalation total   :', pct(agg.humanEscalationRate), '(Credible', pct(agg.escalationCredibleRate), '/ Real', pct(agg.escalationRealRate), ')');
  console.log('ELEMENT_NOT_FOUND  :', agg.failureTaxonomy.ELEMENT_NOT_FOUND);
  console.log('VERIFY_FAILED      :', agg.failureTaxonomy.VERIFY_FAILED);
  console.log('Avg cost           : $' + (agg.averageCost.avgUSDPerTask || 0) + ' / 任务');
  console.log('Avg duration       :', agg.averageDurationMs == null ? '-' : (agg.averageDurationMs / 1000).toFixed(1) + ' s');
  console.log('Agent Score        :', JSON.stringify(agg.agentScore));
  console.log('JSON               :', outPath);
  console.log('=========================================================');

  try { mock.server.close(); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { console.error('[phase12] 异常:', (e && e.stack) || e); process.exit(1); });
