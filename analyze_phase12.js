'use strict';
// Phase 12 — 纯只读事后分析脚本（不修改任何冻结代码 / 不触碰 agent / verification / VIL）。
// 读取：(1) .benchmark/phase12_100task_<runId>.json（harness 输出）
//       (2) server/data/aiEvents.json / aiAttempts.json / aiSteps.json / aiTasks.json（原始累积数据）
// 仅聚合计算，输出 .benchmark/phase12_metrics.json 并打印摘要。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const BENCH = path.join(ROOT, '.benchmark');
const DATA = path.join(ROOT, 'server', 'data');

function loadJson(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }
function pct(x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; }
function uniq(a) { return Array.from(new Set(a)); }

// 1) 找到最新的 harness 输出
const benchFiles = fs.existsSync(BENCH) ? fs.readdirSync(BENCH).filter((f) => /^phase12_100task_.*\.json$/.test(f)) : [];
if (!benchFiles.length) { console.error('[analyze] 未找到 phase12_100task_*.json，基准可能尚未完成。'); process.exit(3); }
benchFiles.sort((a, b) => fs.statSync(path.join(BENCH, b)).mtimeMs - fs.statSync(path.join(BENCH, a)).mtimeMs);
const out = loadJson(path.join(BENCH, benchFiles[0]));
console.log('[analyze] 输入:', benchFiles[0]);

const perTask = out.perTask || [];
const total = perTask.length;

// 2) 原始 store
const events = loadJson(path.join(DATA, 'aiEvents.json'), []);
const attempts = loadJson(path.join(DATA, 'aiAttempts.json'), []);
const steps = loadJson(path.join(DATA, 'aiSteps.json'), []);
const tasks = loadJson(path.join(DATA, 'aiTasks.json'), []);

// stepId -> taskId 映射（attempt 无 taskId，需经 step 桥接）
const step2task = {};
steps.forEach((s) => { if (s && s.id && s.taskId) step2task[s.id] = s.taskId; });
function attemptTaskId(a) { return (a && a.stepId && step2task[a.stepId]) || null; }

// ── A. 来自 harness 输出（终端态口径）──
const successCount = perTask.filter((r) => r.status === 'SUCCESS').length;
const businessSuccess = total ? successCount / total : null;

const esc = perTask.filter((r) => r.status === 'HUMAN_ESCALATION');
const escReal = esc.filter((r) => r.escalationKind === 'REAL').length;
const escCredible = esc.filter((r) => r.escalationKind === 'CREDIBLE').length;
const realEscalation = total ? escReal / total : null;
const credibleEscalation = total ? escCredible / total : null;

const totalAttempts = perTask.reduce((a, r) => a + (r.attemptCount || 0), 0);
const successAttempts = perTask.reduce((a, r) => a + (r.successAttempts || 0), 0);
const executionSuccess = totalAttempts ? successAttempts / totalAttempts : null;

const repairTotal = perTask.reduce((a, r) => a + (r.repairCount || 0), 0);
const repairOk = perTask.reduce((a, r) => a + (r.repairSuccess || 0), 0);
const repairAttemptSuccess = repairTotal ? repairOk / repairTotal : null;

const needRecovery = perTask.filter((r) => (r.retries || 0) + (r.repairCount || 0) > 0);
const recovered = needRecovery.filter((r) => r.status === 'SUCCESS').length;
const businessRecovery = needRecovery.length ? recovered / needRecovery.length : null;

const needRepair = perTask.filter((r) => (r.repairCount || 0) > 0);
const repairRecovered = needRepair.filter((r) => r.status === 'SUCCESS').length;
const repairBusinessRecovery = needRepair.length ? repairRecovered / needRepair.length : null;

const tax = { ELEMENT_NOT_FOUND: 0, VERIFY_FAILED: 0, POLICY_BLOCK: 0, RESOURCE_LOCK: 0, TIMEOUT: 0, NETWORK: 0, OTHER: 0 };
perTask.forEach((r) => { if (r.taxonomy && tax[r.taxonomy] != null) tax[r.taxonomy]++; });

// per-category / longflow
const catSet = {};
perTask.forEach((r) => { (catSet[r.category] = catSet[r.category] || []).push(r); });
const perCategory = {};
Object.keys(catSet).forEach((c) => {
  const arr = catSet[c];
  perCategory[c] = { total: arr.length, success: arr.filter((r) => r.status === 'SUCCESS').length, rate: arr.length ? arr.filter((r) => r.status === 'SUCCESS').length / arr.length : null };
});
const longflow = perCategory['longflow'] || { total: 0, success: 0, rate: null };

// ── B. 来自原始 store（VIL / Action→Outcome）──
const vilDecisions = events.filter((e) => e.type === 'ai.verification.decision');
const vilRecovered = events.filter((e) => e.type === 'ai.verification.recovered');
const vilDecisionTaskIds = uniq(vilDecisions.map((e) => e.taskId).filter(Boolean));
const vilRecoveredTaskIds = uniq(vilRecovered.map((e) => e.taskId).filter(Boolean));
const vilDecisionRate = total ? vilDecisionTaskIds.length / total : null;       // 任务级：VIL 参与比例
const vilDecisionCount = vilDecisions.length;
const vilRecoveryRate = vilDecisionTaskIds.length ? vilRecoveredTaskIds.length / vilDecisionTaskIds.length : null; // 任务级恢复
const vilRecoveryRateByEvent = vilDecisions.length ? vilRecovered.length / vilDecisions.length : null;

// Action -> Outcome
const actionMap = {};
attempts.forEach((a) => {
  const t = attemptTaskId(a);
  if (!t) return;
  const at = (a.action && a.action.type) || 'UNKNOWN';
  actionMap[at] = actionMap[at] || { total: 0, success: 0 };
  actionMap[at].total++;
  if (a.status === 'SUCCESS') actionMap[at].success++;
});
const actionOutcome = {};
Object.keys(actionMap).sort().forEach((at) => {
  actionOutcome[at] = { total: actionMap[at].total, success: actionMap[at].success, rate: actionMap[at].total ? actionMap[at].success / actionMap[at].total : null };
});

// ── C. 交叉校验：用原始 aiTasks 终态复核 Business Success ──
const taskTerminal = {};
tasks.forEach((t) => { if (t && t.id) taskTerminal[t.id] = t.status; });
const crossSuccess = perTask.filter((r) => taskTerminal[r.id] === 'SUCCESS').length;
const crossBusinessSuccess = total ? crossSuccess / total : null;

// ── 汇总 ──
const metrics = {
  generatedAt: new Date().toISOString(),
  source: benchFiles[0],
  totalTasks: total,
  frozenPoolSha256: out.selection && out.selection.sha256,
  business: {
    businessSuccess,
    crossValidatedBusinessSuccess: crossBusinessSuccess,
    executionSuccess,
    businessRecovery,
    realEscalation,
    credibleEscalation,
    verifyFailedCount: tax.VERIFY_FAILED,
    elementNotFoundCount: tax.ELEMENT_NOT_FOUND,
    repairAttemptSuccess,
    repairBusinessRecovery,
    vilDecisionRate,
    vilDecisionCount,
    vilRecoveryRate,
    vilRecoveryRateByEvent,
  },
  failureTaxonomy: tax,
  perCategory,
  longflow,
  actionOutcome,
  cost: out.summary && out.summary.averageCost,
  agentScore: out.summary && out.summary.agentScore,
};

// 输出
fs.writeFileSync(path.join(BENCH, 'phase12_metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');

console.log('\n================ PHASE 12 — FINAL METRICS (read-only analysis) ================');
console.log('Total tasks              :', total);
console.log('Business Success         :', pct(businessSuccess), '(cross-validated', pct(crossBusinessSuccess) + ')');
console.log('Execution Success        :', pct(executionSuccess));
console.log('Business Recovery        :', pct(businessRecovery));
console.log('Real Escalation          :', pct(realEscalation), '(' + escReal + ' tasks)');
console.log('Credible Escalation      :', pct(credibleEscalation), '(' + escCredible + ' tasks)');
console.log('VERIFY_FAILED            :', tax.VERIFY_FAILED);
console.log('ELEMENT_NOT_FOUND        :', tax.ELEMENT_NOT_FOUND);
console.log('Repair Attempt Success   :', pct(repairAttemptSuccess));
console.log('Repair Business Recovery :', pct(repairBusinessRecovery));
console.log('VIL Decision Rate        :', pct(vilDecisionRate), '(events=' + vilDecisionCount + ')');
console.log('VIL Recovery (task)      :', pct(vilRecoveryRate));
console.log('VIL Recovery (event)     :', pct(vilRecoveryRateByEvent));
console.log('Long Workflow Success    :', pct(longflow.rate), '(' + longflow.success + '/' + longflow.total + ')');
console.log('Per-category success     :');
Object.keys(perCategory).forEach((c) => console.log('   - ' + c.padEnd(12), pct(perCategory[c].rate), '(' + perCategory[c].success + '/' + perCategory[c].total + ')'));
console.log('Action->Outcome (top)    :');
Object.keys(actionOutcome).sort((a, b) => actionOutcome[b].total - actionOutcome[a].total).slice(0, 12).forEach((a) => console.log('   - ' + a.padEnd(12), pct(actionOutcome[a].rate), '(' + actionOutcome[a].success + '/' + actionOutcome[a].total + ')'));
console.log('Failure Taxonomy         :', JSON.stringify(tax));
console.log('Avg cost / task          : $' + (metrics.cost && metrics.cost.avgUSDPerTask));
console.log('Metrics JSON             :', path.join(BENCH, 'phase12_metrics.json'));
console.log('=============================================================================');
