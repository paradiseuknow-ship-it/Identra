'use strict';

// Phase 10 结果分析（只读，不修改任何数据）。
// 输入：最新 phase10_*.json + store（按 mock 端口隔离，复用 Phase 9 方法）。
// 输出：phase10_analysis.json（供 PHASE10_REAL_WORLD_RESULT_REPORT.md 引用）。
//
// 相比 Phase 9 分析，新增：
//   - VIL 子类分布（来自 aiAttempts.error.failureType，v0.2.1 新埋点）
//   - 真实观察信号可用性校验（loadingState/networkState/previousObservationDiff 是否采集）

const fs = require('fs');
const path = require('path');

const benchDir = path.join(__dirname, '..', '..', '.benchmark');
const storeDir = path.join(__dirname, '..', 'agent', 'data');

const toArr = (x) => (Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.values(x) : []));
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : '0%');

// 选定最新的 phase10 JSON
const files = fs.readdirSync(benchDir).filter((f) => f.startsWith('phase10_') && f.endsWith('.json'));
let best = null, bestId = -1;
for (const f of files) {
  const m = f.match(/phase10_(\d+)\.json/);
  if (m && Number(m[1]) > bestId) { bestId = Number(m[1]); best = f; }
}
if (!best) { console.error('未找到 phase10 JSON'); process.exit(1); }
const j = JSON.parse(fs.readFileSync(path.join(benchDir, best), 'utf8'));
const PT = j.perTask || [];
console.log('使用: ' + best + ' (perTask=' + PT.length + ')');

const port = (() => { const m = (PT[0] && PT[0].targetUrl || '').match(/127\.0\.0\.1:(\d+)/); return m ? m[1] : null; })();
console.log('隔离端口: ' + port);

function load(f) { return toArr(JSON.parse(fs.readFileSync(path.join(storeDir, f), 'utf8'))); }
const aiTasks = load('aiTasks.json');
const aiSteps = load('aiSteps.json');
const aiAttempts = load('aiAttempts.json');
const aiRepairs = load('aiRepairAttempts.json');

const tasks = port ? aiTasks.filter((t) => (t.targetUrl || '').includes('127.0.0.1:' + port)) : aiTasks;
const tids = new Set(tasks.map((t) => t.id));
const steps = aiSteps.filter((s) => tids.has(s.taskId));
const sids = new Set(steps.map((s) => s.id));
const attempts = aiAttempts.filter((a) => sids.has(a.stepId));
const repairs = aiRepairs.filter((r) => tids.has(r.taskId));

// ---------- Part 1: Data Integrity ----------
const integrity = {
  jsonTasks: PT.length,
  storeTasks: tasks.length,
  storeSteps: steps.length,
  storeAttempts: attempts.length,
  storeRepairs: repairs.length,
  statusMatch: (() => {
    const js = {}; PT.forEach((t) => { js[t.status] = (js[t.status] || 0) + 1; });
    const st = {}; tasks.forEach((t) => { st[t.status] = (st[t.status] || 0) + 1; });
    let diff = 0; for (const k of new Set([...Object.keys(js), ...Object.keys(st)])) diff += Math.abs((js[k] || 0) - (st[k] || 0));
    return diff;
  })(),
};

// ---------- Part 2: Core Metrics ----------
const planner = {
  totalSteps: steps.length,
  avgSteps: steps.length ? Math.round((steps.length / Math.max(1, tasks.length)) * 10) / 10 : 0,
};
const attTotal = attempts.length;
const attSuccess = attempts.filter((a) => a.status === 'SUCCESS').length;
const execution = { actionSuccessRate: Math.round((attSuccess / Math.max(1, attTotal)) * 1000) / 10, attemptsTotal: attTotal, attemptsSuccess: attSuccess };

const business = {
  success: PT.filter((t) => t.status === 'SUCCESS').length,
  rate: pct(PT.filter((t) => t.status === 'SUCCESS').length, PT.length),
  escalation: PT.filter((t) => t.escalated).length,
  escalationRate: pct(PT.filter((t) => t.escalated).length, PT.length),
};

// ---------- Part 3: Escalation split ----------
const esc = PT.filter((t) => t.escalated);
const escalation = {
  total: esc.length,
  credible: esc.filter((t) => t.escalationKind === 'CREDIBLE').length,
  real: esc.filter((t) => t.escalationKind === 'REAL').length,
  credibleRate: pct(esc.filter((t) => t.escalationKind === 'CREDIBLE').length, PT.length),
  realRate: pct(esc.filter((t) => t.escalationKind === 'REAL').length, PT.length),
};

// ---------- Part 4: Failure Taxonomy ----------
const tax = {};
PT.forEach((t) => { const k = t.taxonomy || 'UNKNOWN'; tax[k] = (tax[k] || 0) + 1; });

// ---------- Part 5: VIL subclass distribution (v0.2.1 新埋点) ----------
const vilDist = {};
let vilTagged = 0;
attempts.forEach((a) => {
  const ft = a.error && a.error.failureType;
  if (ft) { vilDist[ft] = (vilDist[ft] || 0) + 1; vilTagged++; }
});
// 观察信号可用性
const obsSample = attempts.filter((a) => a.error && a.error.observationAfter).slice(0, 50);
const obsSignal = {
  withObservationAfter: attempts.filter((a) => a.error && a.error.observationAfter).length,
  withLoadingState: obsSample.filter((a) => a.error.observationAfter && a.error.observationAfter.loadingState).length,
  withNetworkState: obsSample.filter((a) => a.error.observationAfter && a.error.observationAfter.networkState).length,
  withDomFingerprint: obsSample.filter((a) => a.error.observationAfter && a.error.observationAfter.domFingerprint).length,
};

// ---------- Part 6: Verification Analysis ----------
const vfTasks = PT.filter((t) => t.taxonomy === 'VERIFY_FAILED');
const verification = {
  verifyFailedCount: vfTasks.length,
  verifyFailedRate: pct(vfTasks.length, PT.length),
  repairTriggered: vfTasks.filter((t) => t.repairCount > 0).length,
  finalEscalated: vfTasks.filter((t) => t.escalated).length,
  recovered: vfTasks.filter((t) => t.status === 'SUCCESS').length,
};

// ---------- Part 7: Repair Analysis ----------
const repairedTasks = PT.filter((t) => t.repairCount > 0);
const recoveredTasks = repairedTasks.filter((t) => t.status === 'SUCCESS');
const repairTotal = repairs.length;
const repairSuccess = repairs.filter((r) => r.status === 'SUCCESS').length;
const repair = {
  repairTotal, repairSuccess,
  attemptSuccessRate: Math.round((repairSuccess / Math.max(1, repairTotal)) * 1000) / 10,
  repairedTasks: repairedTasks.length,
  recoveredTasks: recoveredTasks.length,
  businessRecoveryRate: Math.round((recoveredTasks.length / Math.max(1, repairedTasks.length)) * 1000) / 10,
};

// ---------- Part 8: Scenario Matrix ----------
const cats = {};
PT.forEach((t) => {
  const c = t.category || 'unknown';
  if (!cats[c]) cats[c] = { total: 0, success: 0, vf: 0, en: 0, escalated: 0, cost: 0, dur: 0 };
  cats[c].total++;
  if (t.status === 'SUCCESS') cats[c].success++;
  if (t.taxonomy === 'VERIFY_FAILED') cats[c].vf++;
  if (t.taxonomy === 'ELEMENT_NOT_FOUND') cats[c].en++;
  if (t.escalated) cats[c].escalated++;
  cats[c].cost += (t.tokensPrompt + t.tokensCompletion) || 0;
  cats[c].dur += t.latencyMs || 0;
});
Object.keys(cats).forEach((c) => {
  cats[c].successRate = pct(cats[c].success, cats[c].total);
  cats[c].avgCostTokens = cats[c].total ? Math.round(cats[c].cost / cats[c].total) : 0;
  cats[c].avgDurationS = cats[c].total ? Math.round((cats[c].dur / cats[c].total) / 1000) / 10 : 0;
});

// ---------- Part 9: Phase comparison ----------
const phaseCompare = {
  'Phase6/7': { businessSuccess: '40%(伪)', verifyFailed: '未 instrument', recovery: '0%', realEscalation: '46.7%' },
  'Phase9': { businessSuccess: '9%', verifyFailed: '65%', recovery: '0%', realEscalation: '72%', elementNotFound: '7%' },
  'Phase10(v0.2.1)': {
    businessSuccess: business.rate, verifyFailed: verification.verifyFailedRate,
    recovery: repair.businessRecoveryRate, realEscalation: escalation.realRate,
    elementNotFound: (tax.ELEMENT_NOT_FOUND || 0) + ' (' + pct(tax.ELEMENT_NOT_FOUND || 0, PT.length) + ')',
  },
};

const out = {
  source: best, generatedAt: j.generatedAt, port,
  integrity, planner, execution, business, escalation, taxonomy: tax,
  vilDistribution: vilDist, vilTagged, obsSignal, verification, repair, scenarioMatrix: cats, phaseCompare,
};
fs.writeFileSync(path.join(benchDir, 'phase10_analysis.json'), JSON.stringify(out, null, 2));
console.log('已写出 .benchmark/phase10_analysis.json');
console.log('Business Success:', business.rate, '| VERIFY_FAILED:', verification.verifyFailedRate, '| Recovery:', repair.businessRecoveryRate, '| Real Esc:', escalation.realRate);
console.log('VIL subclass tagged attempts:', vilTagged, JSON.stringify(vilDist));
console.log('ELEMENT_NOT_FOUND:', tax.ELEMENT_NOT_FOUND || 0);
