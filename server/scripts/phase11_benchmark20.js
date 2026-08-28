'use strict';
// Phase 11 — Balanced 20-task focused real benchmark (§十四/§十五).
// Reuses the EXACT same real pipeline as phase10Benchmark.js (DeepSeek → Runtime → Browser →
// Verification → Recovery) but selects a balanced 20-task sample (5 per category:
// saas / ecommerce / data_entry / long_workflow) so all VERIFY_FAILED-heavy categories are exercised.
// Gate (§十五): Business Success > 11% (Phase 10.9 baseline), VERIFY_FAILED down, Business Recovery > 2.4%,
// NOT via lowered verification (key actions still require outcome contract; forbidden hard-fail intact).

const path = require('path');
const fs = require('fs');
const http = require('http');

if (!process.env.DEEPSEEK_API_KEY) { console.error('[phase11] 缺少 DEEPSEEK_API_KEY'); process.exit(2); }
if (process.env.AI_PROVIDER === 'mock') { console.error('[phase11] 检测到 AI_PROVIDER=mock，终止。'); process.exit(2); }
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';

const bench = require('./phase10Benchmark');
const runScenario = bench.runScenario;
const aggregate = bench.aggregate;
const startMockServer = bench.startMockServer;
const generateReport = bench.generateReport;
const verdict = bench.verdict;

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); if (i < 0) return def; const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) return true; return n; }
const PER_TASK_TIMEOUT = parseInt(arg('--timeout', '150000'), 10) || 150000;
const PER_CAT = parseInt(arg('--per-cat', '5'), 10) || 5;

function loadScenarios() {
  const dir = path.resolve(__dirname, '..', 'scenarios', 'real-world');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  let list = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  list = list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
}

function pickBalanced(list, perCat) {
  const cats = ['saas', 'ecommerce', 'data_entry', 'long_workflow'];
  const out = [];
  for (const c of cats) {
    const sub = list.filter((s) => s.category === c).slice(0, perCat);
    out.push(...sub);
  }
  return out;
}

function pct(x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; }

async function main() {
  const all = loadScenarios();
  const list = pickBalanced(all, PER_CAT);
  console.log('== Phase 11 Balanced 20-task Benchmark ==');
  console.log('[phase11] provider =', process.env.AI_PROVIDER, '| model =', process.env.DEEPSEEK_MODEL || 'deepseek-chat');
  console.log('[phase11] selected =', list.length, 'tasks | per-cat =', PER_CAT);
  const catCount = {}; list.forEach((s) => catCount[s.category] = (catCount[s.category] || 0) + 1);
  console.log('[phase11] category spread =', JSON.stringify(catCount));

  const mock = await startMockServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;

  const results = [];
  for (const scn of list) {
    process.stdout.write(`[phase11] 「${scn.name}」(${scn.id}/${scn.category}) ... `);
    let rec;
    try { rec = await runScenario(scn, baseUrl); }
    catch (e) {
      rec = { id: scn.id, name: scn.name, category: scn.category, status: 'RUNNER_ERROR', error: String((e && e.message) || e),
        stepCount: 0, attemptCount: 0, successAttempts: 0, retries: 0, repairCount: 0, repairSuccess: 0, verificationTotal: 0, verificationPassed: 0,
        latencyMs: null, tokensPrompt: 0, tokensCompletion: 0, taxonomy: 'OTHER', escalated: false, escalationKind: null,
        scores: { overall: 0 } };
    }
    results.push(rec);
    console.log(`status=${rec.status} steps=${rec.stepCount} ok=${rec.successAttempts}/${rec.attemptCount} verif=${rec.verificationPassed}/${rec.verificationTotal} repair=${rec.repairSuccess}/${rec.repairCount} tax=${rec.taxonomy || '-'} score=${rec.scores.overall}`);
  }

  const agg = aggregate(results);
  const v = verdict(agg);
  const runId = Date.now();
  const out = { generatedAt: new Date().toISOString(), runId, simulated: false, provider: process.env.AI_PROVIDER, model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    selection: { mode: 'balanced', perCat: PER_CAT, categorySpread: catCount },
    summary: agg, verdict: v, perTask: results };

  const dir = path.resolve(__dirname, '..', '..', '.benchmark');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  fs.writeFileSync(path.join(dir, 'phase11_20task_' + runId + '.json'), JSON.stringify(out, null, 2), 'utf8');

  // ---- Phase 11 gate metrics ----
  const total = results.length;
  const successCount = results.filter((r) => r.status === 'SUCCESS').length;
  const businessSuccess = total ? successCount / total : 0;
  const verifyFailed = results.filter((r) => r.taxonomy === 'VERIFY_FAILED').length;
  const enf = results.filter((r) => r.taxonomy === 'ELEMENT_NOT_FOUND').length;
  const realEsc = results.filter((r) => r.escalationKind === 'REAL').length;
  const neededRecovery = results.filter((r) => r.retries + r.repairCount > 0);
  const recovered = neededRecovery.filter((r) => r.status === 'SUCCESS').length;
  const busRecovery = neededRecovery.length ? recovered / neededRecovery.length : 0;

  // false-SUCCESS check (§二): a SUCCESS must have real outcome verification (verificationPassed>0),
  // and for key actions must NOT be action_success-only.
  const falseSuccess = results.filter((r) => r.status === 'SUCCESS' && r.verificationPassed === 0).length;

  console.log('\n================ PHASE 11 — 20-TASK GATE ================');
  console.log('Total tasks            :', total);
  console.log('Business Success       :', pct(businessSuccess), '(baseline 11.0%, gate >11%)');
  console.log('VERIFY_FAILED          :', verifyFailed, '/' + total, '(' + pct(verifyFailed / total) + ') (baseline 58%)');
  console.log('ELEMENT_NOT_FOUND      :', enf, '/' + total, '(' + pct(enf / total) + ') (baseline 8%)');
  console.log('Real Escalation        :', pct(realEsc / total), '(baseline 64%)');
  console.log('Business Recovery      :', pct(busRecovery), '(baseline 2.4%, gate >2.4%)');
  console.log('False-SUCCESS (susp)   :', falseSuccess, '(must be 0 — verification not lowered)');
  console.log('Agent Score overall    :', agg.agentScore && agg.agentScore.overall);
  console.log('JSON                   :', path.join(dir, 'phase11_20task_' + runId + '.json'));
  console.log('=========================================================');

  try { mock.server.close(); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { console.error('[phase11] 异常:', (e && e.stack) || e); process.exit(1); });
