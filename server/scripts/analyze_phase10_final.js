'use strict';
// READ-ONLY acceptance analysis for Phase 10 (v0.2.1).
// No code modification, no benchmark re-run. Pure store + JSON reads.
const fs = require('fs');
const path = require('path');

const DATA = path.resolve(__dirname, '..', 'data');
const BM = path.resolve(__dirname, '..', '..', '.benchmark');

function load(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
function getErr(a) {
  if (!a.error) return null;
  if (typeof a.error === 'string') { try { return JSON.parse(a.error); } catch (e) { return null; } }
  return a.error;
}
const portOfTask = (t) => (t.targetUrl || '').match(/:([0-9]+)\//) ?.[1] || null;

// ---- load store ----
const T = load(path.join(DATA, 'aiTasks.json')) || [];
const S = load(path.join(DATA, 'aiSteps.json')) || [];
const A = load(path.join(DATA, 'aiAttempts.json')) || [];
const R = load(path.join(DATA, 'aiRepairAttempts.json')) || [];
const E = load(path.join(DATA, 'aiEvents.json')) || [];
const FS = load(path.join(DATA, 'aiFailureSnapshots.json')) || [];

// B3：单一权威「业务成功」口径（harness / store / report 同源派生）。
const { isBusinessSuccess, businessSuccess, consistencyCheck } = require('../agent/successMetrics');

const tasks = Array.isArray(T) ? T : (T.data || []);
const steps = Array.isArray(S) ? S : (S.data || []);
const attempts = Array.isArray(A) ? A : (A.data || []);
const repairs = Array.isArray(R) ? R : (R.data || []);
const events = Array.isArray(E) ? E : (E.data || E.events || []);
const snaps = Array.isArray(FS) ? FS : (FS.data || []);

// step -> task map
const stepTask = {};
for (const s of steps) stepTask[s.id] = s.taskId;

// ── 权威来源：优先使用 benchmark 输出 JSON 的 perTask（终态 status / 真实 category 单一来源）──
function loadLatestBenchmark() {
  try {
    const files = fs.readdirSync(BM).filter((f) => /^(phase10|phase12)_.*\.json$/.test(f));
    let best = null, bestId = -1;
    for (const f of files) {
      const m = f.match(/_(\d+)\.json$/) || f.match(/_(\d+)\.json$/);
      const id = m ? Number(m[1]) : 0;
      if (id > bestId) { bestId = id; best = f; }
    }
    if (best) return JSON.parse(fs.readFileSync(path.join(BM, best), 'utf8'));
  } catch (e) {}
  return null;
}
const _bench = loadLatestBenchmark();
const p10tasks = _bench && Array.isArray(_bench.perTask) ? _bench.perTask.map((t) => ({
  id: t.id, status: t.status, category: t.category, name: t.name, targetUrl: t.targetUrl,
  escalationKind: t.escalationKind, error: t.error, taxonomy: t.taxonomy,
  repairCount: t.repairCount, verificationTotal: t.verificationTotal, verificationPassed: t.verificationPassed,
  lastDiagnosis: t.lastDiagnosis,
})) : [];
const p10ids = new Set(p10tasks.map((t) => t.id));

// store 中按权威 id 集合过滤（不再按端口硬过滤，杜绝整批被滤掉 → 0% 假象）
const storeTasksById = {};
for (const t of tasks) if (p10ids.has(t.id)) storeTasksById[t.id] = t;
const p10Attempts = attempts.filter((a) => { const tid = stepTask[a.stepId]; return tid && p10ids.has(tid); });
const p10Repairs = repairs.filter((r) => p10ids.has(r.taskId));
const p10Steps = steps.filter((s) => p10ids.has(s.taskId));

// B3 一致性断言：canonical perTask 终态 必须与 store 终态一致
const _storeForCc = p10tasks.map((t) => storeTasksById[t.id] || t);
const _cc = consistencyCheck(p10tasks, _storeForCc);
if (!_cc.consistent) console.warn('[B3][WARN] perTask/store 业务成功口径不一致:', JSON.stringify(_cc));
else console.log('[B3] consistency OK: perTask='+_cc.harnessSuccess+' store='+_cc.storeSuccess);

// Phase 9 baseline（store 中 rw.NNN 匹配的历史任务，用于对照；无则空）
function rwId(t) {
  const m = (t.profileId || t.name || '').match(/rw_(\d+)/);
  return m ? 'rw.' + m[1] : null;
}
const p9ByRw = {};
for (const t of tasks) { const r = rwId(t); if (r) p9ByRw[r] = t; }
const p9tasks = Object.values(p9ByRw);
const p9ids = new Set(p9tasks.map((t) => t.id));
const p9Attempts = attempts.filter((a) => { const tid = stepTask[a.stepId]; return tid && p9ids.has(tid); });
const p9Repairs = repairs.filter((r) => p9ids.has(r.taskId));
const p9Steps = steps.filter((s) => p9ids.has(s.taskId));

// ---------- helpers ----------
function statusDist(ts) { const d = {}; for (const t of ts) d[t.status] = (d[t.status] || 0) + 1; return d; }
function failureTypeDist(as) {
  const d = {}; let n = 0;
  for (const a of as) { const e = getErr(a); if (e && e.failureType) { d[e.failureType] = (d[e.failureType] || 0) + 1; n++; } }
  return { dist: d, total: n };
}
function errCodeDist(as) {
  const d = {}; for (const a of as) { const e = getErr(a); if (e && e.code) d[e.code] = (d[e.code] || 0) + 1; }
  return d;
}
function avg(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; }

// VIL 6-class taxonomy
const VIL_CLASSES = ['EVENTUAL_CONSISTENCY', 'OBSERVATION_DELAY', 'VERIFICATION_TOO_STRICT', 'ACTION_REAL_FAILURE', 'STATE_UNKNOWN', 'DOM_CHANGED'];

// repair action tools
function repairToolDist(rs) {
  const d = {}; let totalActions = 0;
  for (const r of rs) {
    const acts = r.actions || [];
    for (const act of acts) { const tool = act.tool || act.type || 'unknown'; d[tool] = (d[tool] || 0) + 1; totalActions++; }
  }
  return { dist: d, totalActions };
}

// ---------- Phase 10 metrics ----------
const p10Status = statusDist(p10tasks);
const p10Total = p10tasks.length;
const p10Success = p10Status.SUCCESS || 0;
const p10Running = p10Status.RUNNING || 0;
const p10Decided = p10Total - p10Running;
const businessSuccessP10 = p10Total ? p10Success / p10Total : 0;
const escalationP10 = (p10Status.HUMAN_ESCALATION || 0);

const p10FT = failureTypeDist(p10Attempts);
const p10ErrCode = errCodeDist(p10Attempts);

// VERIFY_FAILED proxy: tasks whose lastDiagnosis.category==='VERIFICATION_FAILED' OR escalated with verify reason OR failureType present (all 6 classes are verification-domain)
function isVerifyFailed(t) {
  if (t.lastDiagnosis && t.lastDiagnosis.category === 'VERIFICATION_FAILED') return true;
  if (t.error && /verif|VERIFY/i.test(t.error)) return true;
  return false;
}
const p10VerifyFailed = p10tasks.filter(isVerifyFailed).length;

// ELEMENT_NOT_FOUND: failureType === 'ELEMENT_NOT_FOUND' OR error code ELEMENT_NOT_FOUND
const p10ElemNotFound = p10Attempts.filter((a) => { const e = getErr(a); return e && (e.failureType === 'ELEMENT_NOT_FOUND' || e.code === 'ELEMENT_NOT_FOUND'); }).length;
// resolver-relevant classes (missing element / wrong target)
const resolverClasses = ['DOM_CHANGED', 'STATE_UNKNOWN', 'ACTION_REAL_FAILURE'];
const p10ResolverClass = p10Attempts.filter((a) => { const e = getErr(a); return e && resolverClasses.includes(e.failureType); }).length;

// Repair metrics (Phase 10)
const p10RepairTotal = p10Repairs.length;
const p10RepairSuccess = p10Repairs.filter((r) => r.status === 'SUCCESS').length;
const p10RepairTool = repairToolDist(p10Repairs);

// VIL decision proxies via repair tools (the verifyFailed strategy implements VIL routing)
// WAIT ~ wait_stable, RECHECK ~ recheck_observation, RE_EXECUTE ~ rerun/execute, RELOCATE ~ semantic_relocate
function toolCount(tool) { return p10RepairTool.dist[tool] || 0; }
const vilWait = toolCount('wait_stable');
const vilRecheck = toolCount('recheck_observation');
const vilReexec = toolCount('rerun_action') + toolCount('rerun') + toolCount('execute') + toolCount('re_execute');
const vilRelocate = toolCount('semantic_relocate') + toolCount('relocate');

// temporal classes recoveries: EVENTUAL_CONSISTENCY + OBSERVATION_DELAY
const temporalEntered = p10FT.dist.EVENTUAL_CONSISTENCY || 0 + (p10FT.dist.OBSERVATION_DELAY || 0);
// business recovery after VIL-style (wait/recheck) vs repair
// VIL Business Recovery = tasks that are SUCCESS and had a failureType (i.e., recovered from a verify-failure)
const p10RecoveredViaVIL = p10tasks.filter((t) => {
  if (t.status !== 'SUCCESS') return false;
  return p10Attempts.some((a) => stepTask[a.stepId] === t.id && getErr(a) && VIL_CLASSES.includes(getErr(a).failureType));
}).length;
// Repair Business Recovery = tasks SUCCESS that required a repair attempt
const p10RecoveredViaRepair = p10tasks.filter((t) => {
  if (t.status !== 'SUCCESS') return false;
  return p10Repairs.some((r) => r.taskId === t.id);
}).length;

// Scenario matrix by category (derive from name/fixture)
function scenarioOf(t) {
  const n = (t.name || '') + ' ' + (t.targetUrl || '');
  if (/saas|登录|login/i.test(n)) return 'SaaS';
  if (/commerce|电商|shop|cart|checkout|订单/i.test(n)) return 'E-commerce';
  if (/entry|表单|form|录入|data entry/i.test(n)) return 'Data Entry';
  if (/workflow|长流程|多步|long/i.test(n)) return 'Long Workflow';
  return 'Other';
}
const scenarios = ['SaaS', 'E-commerce', 'Data Entry', 'Long Workflow'];
const p10Matrix = {};
for (const sc of scenarios) {
  const ts = p10tasks.filter((t) => scenarioOf(t) === sc);
  const succ = ts.filter((t) => t.status === 'SUCCESS').length;
  const esc = ts.filter((t) => t.status === 'HUMAN_ESCALATION').length;
  p10Matrix[sc] = { total: ts.length, success: succ, businessSuccess: ts.length ? succ / ts.length : 0, escalation: esc };
}

// Failure taxonomy top (by lastDiagnosis.category + failureType)
const failBuckets = {};
for (const t of p10tasks) {
  if (t.status === 'SUCCESS' || t.status === 'RUNNING') continue;
  const cat = (t.lastDiagnosis && t.lastDiagnosis.category) || (isVerifyFailed(t) ? 'VERIFICATION_FAILED' : 'OTHER');
  failBuckets[cat] = (failBuckets[cat] || 0) + 1;
}
// also merge failureType subclasses
for (const a of p10Attempts) { const e = getErr(a); if (e && e.failureType) { const k = 'FT:' + e.failureType; failBuckets[k] = (failBuckets[k] || 0) + 1; } }
const topFailures = Object.entries(failBuckets).sort((a, b) => b[1] - a[1]).slice(0, 10);

// Duration
const p10Durations = p10tasks.filter((t) => t.startedAt && t.finishedAt).map((t) => t.finishedAt - t.startedAt);
const p10AvgDur = avg(p10Durations);

// ---------- Phase 9 baseline (from locked phase9_analysis.json if present, else derive) ----------
const p9base = load(path.join(BM, 'phase9_analysis.json'));
let p9 = null;
if (p9base) {
  p9 = p9base;
} else {
  // derive
  const p9Status = statusDist(p9tasks);
  p9 = {
    taskCount: p9tasks.length,
    status: p9Status,
    businessSuccess: p9tasks.length ? (p9Status.SUCCESS || 0) / p9tasks.length : 0,
    escalation: p9Status.HUMAN_ESCALATION || 0,
  };
}

// Phase 9 store-derived cross-check
const p9Status = statusDist(p9tasks);
const p9FT_store = failureTypeDist(p9Attempts); // expect ~0 (Phase9 predates failureType)
const p9RepairTotal = p9Repairs.length;
const p9RepairSuccess = p9Repairs.filter((r) => r.status === 'SUCCESS').length;

// Per-task Phase9 vs Phase10 matched comparison
const p10ByRw = {}; for (const t of p10tasks) { const r = rwId(t); if (r) p10ByRw[r] = t; }
const matchedRws = Object.keys(p9ByRw).filter((r) => p10ByRw[r]);
let flippedToSuccess = 0, flippedToEsc = 0, bothSuccess = 0, bothEsc = 0;
for (const r of matchedRws) {
  const a = p9ByRw[r].status === 'SUCCESS';
  const b = p10ByRw[r].status === 'SUCCESS';
  if (a && b) bothSuccess++;
  else if (!a && !b) bothEsc++;
  else if (!a && b) flippedToSuccess++;
  else if (a && !b) flippedToEsc++;
}

// ---------- Output ----------
const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    p10Port: (_bench ? String(_bench.runId) : 'canonical-perTask'), p9Port: (p9tasks.length ? 'store-rw-baseline' : 'n/a'),
    note: 'Phase 10 full run created 85/100 tasks; 1 still RUNNING = benchmark terminated early. Analysis covers store-derived Phase 10 data only.',
    storeTotalTasks: tasks.length,
  },
  dataIntegrity: {
    p10TaskCount: p10Total, p9TaskCount: p9tasks.length,
    p10StepCount: p10Steps.length, p9StepCount: p9Steps.length,
    p10AttemptCount: p10Attempts.length, p9AttemptCount: p9Attempts.length,
    p10RepairCount: p10RepairTotal, p9RepairCount: p9RepairTotal,
    p10SnapshotCount: snaps.filter((s) => p10ids.has(s.taskId)).length,
    p10EventCount: events.filter((e) => p10ids.has(e.taskId)).length,
    p10RunningTasks: p10Running,
    escalationKindPersisted: p10tasks.filter((t) => t.escalationKind).length,
    matchedByPersisted: (function () { const raw = fs.readFileSync(path.join(DATA, 'aiAttempts.json'), 'utf8'); return raw.includes('matchedBy'); })(),
    contaminationTotalTasks: tasks.length,
  },
  phase9Baseline: p9,
  phase9StoreCrossCheck: {
    status: p9Status, failureTypeDist: p9FT_store.dist, failureTypeTotal: p9FT_store.total,
    repairTotal: p9RepairTotal, repairSuccess: p9RepairSuccess,
  },
  phase10: {
    status: p10Status,
    businessSuccess: +businessSuccessP10.toFixed(4),
    escalation: escalationP10,
    escalationRate: +(escalationP10 / p10Total).toFixed(4),
    verifyFailedCount: p10VerifyFailed,
    verifyFailedRate: +(p10VerifyFailed / p10Total).toFixed(4),
    failureTypeDist: p10FT.dist,
    failureTypeTotal: p10FT.total,
    errCodeDist: p10ErrCode,
    elementNotFoundCount: p10ElemNotFound,
    resolverClassCount: p10ResolverClass,
    repair: { total: p10RepairTotal, success: p10RepairSuccess, successRate: p10RepairTotal ? +(p10RepairSuccess / p10RepairTotal).toFixed(4) : 0, toolDist: p10RepairTool.dist },
    vilDecisionProxy: { wait: vilWait, recheck: vilRecheck, reexecute: vilReexec, relocate: vilRelocate },
    recoveredViaVIL: p10RecoveredViaVIL,
    recoveredViaRepair: p10RecoveredViaRepair,
    vilBusinessRecoveryRate: p10Total ? +(p10RecoveredViaVIL / p10Total).toFixed(4) : 0,
    repairBusinessRecoveryRate: p10Total ? +(p10RecoveredViaRepair / p10Total).toFixed(4) : 0,
    scenarioMatrix: p10Matrix,
    topFailures,
    avgDurationMs: p10AvgDur ? Math.round(p10AvgDur) : null,
  },
  matchedComparison: {
    matchedTasks: matchedRws.length,
    phase9Success_phase10Success: bothSuccess,
    phase9Esc_phase10Esc: bothEsc,
    phase9Esc_to_phase10Success: flippedToSuccess,
    phase9Success_to_phase10Esc: flippedToEsc,
  },
};

console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(BM, 'phase10_analysis_final.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('\n[written] .benchmark/phase10_analysis_final.json');
