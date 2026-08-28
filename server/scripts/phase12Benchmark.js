'use strict';
// Phase 12 — 100-task 产品级真实验证 runner。
// 复用 Phase 10.9 成熟 harness（phase10Benchmark）的 runScenario/aggregate/startMockServer/loadTasks，
// 保证与 Phase 10.9 基线同口径（同 runtime / verification / success 定义）。仅改写输出文件名为 phase12_*。
// 真实 DeepSeek + 真实 Chromium；无 mock / attachPlan / fallback。每任务独立 profile，串行执行。
const fs = require('fs');
const path = require('path');

if (!process.env.DEEPSEEK_API_KEY) { console.error('[phase12] 缺少 DEEPSEEK_API_KEY：要求真实 DeepSeek，禁止回退 mock。'); process.exit(2); }
if (process.env.AI_PROVIDER === 'mock') { console.error('[phase12] 检测到 AI_PROVIDER=mock，终止。'); process.exit(2); }
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';

const P9 = require('./phase10Benchmark');
const agentScore = require('../agentScore');

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); if (i < 0) return def; const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) return true; return n; }
const PER_TASK_TIMEOUT = parseInt(arg('--timeout', '180000'), 10) || 180000;
const MAX = parseInt(arg('--max', '0'), 10) || 0;

function pct(x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; }

async function main() {
  let list = P9.loadTasks();
  if (MAX > 0) list = list.slice(0, MAX);
  console.log('== Phase 12 100-task Product Validation ==');
  console.log('[phase12] provider =', process.env.AI_PROVIDER, '| model =', process.env.DEEPSEEK_MODEL || 'deepseek-chat');
  console.log('[phase12] 真实任务数 =', list.length, MAX > 0 ? '(抽样 --max ' + MAX + ')' : '');

  const mock = await P9.startMockServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;

  const results = [];
  for (const scn of list) {
    process.stdout.write(`[phase12] 「${scn.name}」(${scn.id}) ... `);
    let rec;
    try { rec = await P9.runScenario(scn, baseUrl); }
    catch (e) {
      rec = { id: scn.id, name: scn.name, category: scn.category, status: 'RUNNER_ERROR', error: String((e && e.message) || e),
        stepCount: 0, attemptCount: 0, successAttempts: 0, retries: 0, repairCount: 0, repairSuccess: 0, verificationTotal: 0, verificationPassed: 0,
        latencyMs: null, tokensPrompt: 0, tokensCompletion: 0, taxonomy: 'OTHER', escalated: false, escalationKind: null,
        scores: agentScore.compute({ steps: [], attempts: [], retries: 0, repairs: 0, escalated: false, status: 'RUNNER_ERROR' }) };
    }
    results.push(rec);
    console.log(`status=${rec.status} steps=${rec.stepCount} ok=${rec.successAttempts}/${rec.attemptCount} verif=${rec.verificationPassed}/${rec.verificationTotal} repair=${rec.repairSuccess}/${rec.repairCount} tax=${rec.taxonomy || '-'}`);
  }

  const agg = P9.aggregate(results);
  const runId = Date.now();
  const out = {
    generatedAt: new Date().toISOString(), runId,
    simulated: false, provider: process.env.AI_PROVIDER, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    selection: { type: 'frozen-pool', poolFile: 'phase12_pool.json', count: list.length, sha256: (require('crypto').createHash('sha256').update(list.map((s) => s.id).sort().join(','), 'utf8').digest('hex')) },
    summary: agg, perTask: results,
  };

  const dir = path.resolve(__dirname, '..', '..', '.benchmark');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const outPath = path.join(dir, 'phase12_100task_' + runId + '.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

  console.log('\n========= PHASE 12 100-TASK PRODUCT VALIDATION =========');
  console.log('Total tasks        :', agg.totalTasks);
  console.log('Business Success   :', pct(agg.successRate));
  console.log('Planner            :', pct(agg.plannerSuccessRate));
  console.log('Execution Success  :', pct(agg.executionSuccessRate));
  console.log('Verif accuracy     :', agg.verificationAccuracy == null ? '-' : pct(agg.verificationAccuracy));
  console.log('Repair success     :', agg.repairSuccessRate == null ? 'N/A' : pct(agg.repairSuccessRate));
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
