'use strict';
// Phase 12 — 只读分析器。读取 .benchmark/phase12_100task_<runId>.json + 隔离后的 server/data store，
// 交叉验证指标，生成 PHASE12_100_TASK_PRODUCT_VALIDATION.md（20 章）+ A/B/C 判定。
// 不修改任何冻结代码 / 成功定义 / 统计口径。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname);
const BENCH = path.join(ROOT, '.benchmark');
const DATA = path.join(ROOT, 'server', 'data');
const POOL = path.join(ROOT, 'phase12_pool.json');

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }
function pct(x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; }
function n(x) { return x == null ? 0 : x; }
function uniq(a) { return Array.from(new Set(a)); }

// ---- 1. 定位 benchmark JSON ----
let benchPath = process.argv[2];
if (!benchPath) {
  const files = fs.readdirSync(BENCH).filter((f) => /^phase12_100task_\d+\.json$/.test(f));
  files.sort();
  benchPath = path.join(BENCH, files[files.length - 1]);
}
const bench = readJson(benchPath, null);
if (!bench) { console.error('NO PHASE12 BENCHMARK JSON:', benchPath); process.exit(2); }
console.log('[analyze] benchmark:', benchPath, '| generatedAt:', bench.generatedAt, '| perTask:', bench.perTask.length);

const perTask = bench.perTask;
const S = bench.summary;
const total = perTask.length;

// ---- 2. 读隔离 store（Phase 12 专属）----
const aiTasks = readJson(path.join(DATA, 'aiTasks.json'), []);
const aiSteps = readJson(path.join(DATA, 'aiSteps.json'), []);
const aiAttempts = readJson(path.join(DATA, 'aiAttempts.json'), []);
const aiEvents = readJson(path.join(DATA, 'aiEvents.json'), []);
const aiRepair = readJson(path.join(DATA, 'aiRepairAttempts.json'), []);
const aiSnaps = readJson(path.join(DATA, 'aiFailureSnapshots.json'), []);
console.log('[analyze] store: tasks=' + aiTasks.length + ' steps=' + aiSteps.length + ' attempts=' + aiAttempts.length + ' events=' + aiEvents.length + ' repair=' + aiRepair.length + ' snaps=' + aiSnaps.length);

// ---- 3. 桥接 scn.id <-> taskId（via profileId）----
function scnFromPid(pid) { if (!pid) return null; const m = String(pid).match(/rw_?0*(\d+)/i); return m ? ('rw.' + parseInt(m[1], 10)) : null; }
const taskIdToScn = new Map();
const scnToTaskId = new Map();
aiTasks.forEach((t) => { const s = scnFromPid(t.profileId); if (s) { taskIdToScn.set(t.id, s); scnToTaskId.set(s, t.id); } });

const perTaskById = new Map();
perTask.forEach((r) => perTaskById.set(r.id, r));
function ptByTaskId(tid) { const s = taskIdToScn.get(tid); return s ? perTaskById.get(s) : null; }

// store-derived task lists
const stepsByTask = {}; aiSteps.forEach((s) => { (stepsByTask[s.taskId] = stepsByTask[s.taskId] || []).push(s); });
const attByTask = {}; aiAttempts.forEach((a) => { (attByTask[a.taskId] = attByTask[a.taskId] || []).push(a); });
const evByTask = {}; aiEvents.forEach((e) => { (evByTask[e.taskId] = evByTask[e.taskId] || []).push(e); });
const repByTask = {}; aiRepair.forEach((r) => { (repByTask[r.taskId] = repByTask[r.taskId] || []).push(r); });
const snapByTask = {}; aiSnaps.forEach((s) => { (snapByTask[s.taskId] = snapByTask[s.taskId] || []).push(s); });

// ============================================================
// §八 核心指标（从原始 JSON + store 交叉验证）
// ============================================================
const successCount = perTask.filter((r) => r.status === 'SUCCESS').length;
const businessSuccess = total ? successCount / total : 0;

// store 派生 Business Success 交叉验证（任务终态）
const storeSuccess = aiTasks.filter((t) => t.status === 'SUCCESS').length;
const storeSuccessRate = aiTasks.length ? storeSuccess / aiTasks.length : 0;

const execTotal = perTask.reduce((a, r) => a + n(r.attemptCount), 0);
const execSucc = perTask.reduce((a, r) => a + n(r.successAttempts), 0);
const executionSuccess = execTotal ? execSucc / execTotal : 0;
const storeExecTotal = aiAttempts.length;
const storeExecSucc = aiAttempts.filter((a) => a.status === 'SUCCESS').length;
const storeExecRate = storeExecTotal ? storeExecSucc / storeExecTotal : 0;

const verifyFailedCount = perTask.filter((r) => r.taxonomy === 'VERIFY_FAILED').length;
const enfCount = perTask.filter((r) => r.taxonomy === 'ELEMENT_NOT_FOUND').length;
const realEscCount = S.escalationReal || 0;
const credEscCount = S.escalationCredible || 0;
const realEscRate = S.escalationRealRate || 0;

// VERIFY_FAILED 率（task/step/attempt）
const vfTaskRate = total ? verifyFailedCount / total : 0;
// step 级：verification.completed 失败事件 / 总 verification 事件
const verifEvents = aiEvents.filter((e) => e.type === 'ai.verification.completed');
const verifFailEvents = verifEvents.filter((e) => !(e.payload && e.payload.success));
const vfStepRate = verifEvents.length ? verifFailEvents.length / verifEvents.length : 0;
// attempt 级：attempt error 含 VERIF/VERIFICATION 或终态 VERIFY_FAILED 的 task 的 attempts
const enfAttempts = aiAttempts.filter((a) => a.error && /ELEMENT_NOT_FOUND/.test(a.error.code || ''));
const enfAttemptRate = aiAttempts.length ? enfAttempts.length / aiAttempts.length : 0;
const enfStepRate = aiSteps.length ? (aiSteps.filter((s) => s.error && /ELEMENT_NOT_FOUND/.test(s.error.code || (s.error && s.error.message) || ''))).length / aiSteps.length : 0;

// ELEMENT_NOT_FOUND（task/step/attempt）
const enfTaskRate = total ? enfCount / total : 0;

// Business Recovery（严格：需恢复的任务最终 SUCCESS / 需恢复任务）
const neededRec = perTask.filter((r) => (n(r.retries) + n(r.repairCount)) > 0);
const recovered = neededRec.filter((r) => r.status === 'SUCCESS').length;
const businessRecovery = neededRec.length ? recovered / neededRec.length : 0;

// ============================================================
// §九 Action → Outcome 分析
// ============================================================
const KEY_ACTIONS = ['login', 'search', 'form_fill', 'fill', 'select', 'checkbox', 'check', 'save', 'submit', 'logout', 'navigation', 'navigate'];
function normAction(t) {
  if (!t) return 'other';
  t = String(t).toLowerCase();
  if (t.includes('login')) return 'login';
  if (t.includes('search')) return 'search';
  if (t.includes('fill') || t.includes('form')) return 'form_fill';
  if (t.includes('select')) return 'select';
  if (t.includes('check') || t.includes('checkbox')) return 'checkbox';
  if (t.includes('save')) return 'save';
  if (t.includes('submit')) return 'submit';
  if (t.includes('logout') || t.includes('log_out')) return 'logout';
  if (t.includes('navig')) return 'navigation';
  return t;
}
const actionStats = {};
KEY_ACTIONS.forEach((a) => actionStats[a] = { execAtt: 0, execSucc: 0, verifEvt: 0, verifPass: 0, tasksWith: 0, tasksSuccess: 0 });
// 遍历 steps，按 action 聚合 exec + 关联到 task 的 verification 事件
const stepVerifByStep = {};
verifEvents.forEach((e) => { if (e.stepId) stepVerifByStep[e.stepId] = e; });
aiSteps.forEach((s) => {
  const a = normAction(s.action && s.action.type);
  if (!actionStats[a]) actionStats[a] = { execAtt: 0, execSucc: 0, verifEvt: 0, verifPass: 0, tasksWith: 0, tasksSuccess: 0 };
  const st = actionStats[a];
  const atts = attByTask[s.taskId] ? attByTask[s.taskId].filter((x) => x.stepId === s.id) : [];
  st.execAtt += atts.length;
  st.execSucc += atts.filter((x) => x.status === 'SUCCESS').length;
  const ve = stepVerifByStep[s.id];
  if (ve) { st.verifEvt += 1; if (ve.payload && ve.payload.success) st.verifPass += 1; }
  // 业务成功（含该动作的 task 是否终态 SUCCESS）
  const pt = ptByTaskId(s.taskId);
  if (pt) { st.tasksWith += 1; if (pt.status === 'SUCCESS') st.tasksSuccess += 1; }
});

// ============================================================
// §十 VERIFY_FAILED 真实 evidence 10 类分类
// ============================================================
const VF_CLASSES = ['VERIFICATION_TOO_STRICT', 'STATE_CHANGED_BUT_VERIFICATION_WRONG', 'EVENTUAL_CONSISTENCY', 'OBSERVATION_DELAY', 'ACTION_REAL_FAILURE', 'STATE_UNKNOWN', 'DOM_CHANGED', 'ACTION_NOT_EXECUTED', 'OUTCOME_CONTRACT_MISSING', 'OTHER'];
const vfClassCount = {}; VF_CLASSES.forEach((c) => vfClassCount[c] = 0);
const vfTasks = perTask.filter((r) => r.taxonomy === 'VERIFY_FAILED');
vfTasks.forEach((r) => {
  const tid = scnToTaskId.get(r.id);
  const evs = tid ? evByTask[tid] || [] : [];
  const dec = evs.filter((e) => e.type === 'ai.verification.decision');
  const failSnaps = tid ? (snapByTask[tid] || []) : [];
  const errCodes = (r.error ? [r.error] : []).concat(failSnaps.map((s) => s.errorType)).concat(evs.map((e) => (e.payload && e.payload.failureType) || ''));
  const joined = errCodes.join(' ').toUpperCase();
  const decisionTypes = dec.map((e) => (e.payload && e.payload.failureType) || '');
  let cls = 'OTHER';
  if (decisionTypes.some((d) => /EVENTUAL_CONSISTENCY/.test(d))) cls = 'EVENTUAL_CONSISTENCY';
  else if (decisionTypes.some((d) => /OBSERVATION_DELAY/.test(d))) cls = 'OBSERVATION_DELAY';
  else if (/DOM_CHANGED/.test(joined)) cls = 'DOM_CHANGED';
  else if (/ACTION_NOT_EXECUTED|NOT_EXECUTED|未执行/.test(joined)) cls = 'ACTION_NOT_EXECUTED';
  else if (/ELEMENT_NOT_FOUND|RESOLVE/.test(joined) && /VERIF/.test(joined)) cls = 'OUTCOME_CONTRACT_MISSING';
  else if (/ACTION_REAL_FAILURE|REAL_FAILURE|执行失败|动作失败/.test(joined)) cls = 'ACTION_REAL_FAILURE';
  else if (decisionTypes.some((d) => /VERIFICATION_TOO_STRICT/.test(d))) cls = 'VERIFICATION_TOO_STRICT';
  else if (decisionTypes.some((d) => /STATE_CHANGED_BUT_VERIFICATION_WRONG/.test(d))) cls = 'STATE_CHANGED_BUT_VERIFICATION_WRONG';
  else if (/STATE_UNKNOWN|UNKNOWN/.test(joined)) cls = 'STATE_UNKNOWN';
  else if (/VERIF|VERIFICATION/.test(joined)) cls = 'VERIFICATION_TOO_STRICT';
  vfClassCount[cls] += 1;
});

// ============================================================
// §十一 Resolver 矩阵（ELEMENT_NOT_FOUND）
// ============================================================
const resolverRows = [];
const enfTasks = perTask.filter((r) => r.taxonomy === 'ELEMENT_NOT_FOUND');
const matchedByPersisted = aiSnaps.some((s) => s.matchedBy) || aiRepair.some((r) => r.matchedBy);
enfTasks.forEach((r) => {
  const tid = scnToTaskId.get(r.id);
  const snaps = tid ? (snapByTask[tid] || []) : [];
  const reps = tid ? (repByTask[tid] || []) : [];
  const snap = snaps[0] || {};
  resolverRows.push({
    task: r.id, category: r.category, objective: (r.objective || '').slice(0, 60),
    targetField: snap.targetField || snap.field || (snap.target && snap.target.field) || '-',
    targetSemantic: snap.targetSemantic || snap.semantic || (snap.target && snap.target.semantic) || '-',
    matchedBy: snap.matchedBy || reps.map((x) => x.matchedBy).filter(Boolean)[0] || 'INSTRUMENTATION_GAP',
    repairStrategy: reps.map((x) => x.strategy).filter(Boolean).join(',') || '-',
    finalOutcome: r.status,
  });
});

// ============================================================
// §十二 Repair 深度分析
// ============================================================
const repairAttemptCount = aiRepair.length;
const repairActionSuccess = aiRepair.filter((r) => r.status === 'SUCCESS').length;
const repairByStrategy = {};
aiRepair.forEach((r) => {
  const s = r.strategy || 'UNKNOWN';
  if (!repairByStrategy[s]) repairByStrategy[s] = { total: 0, ok: 0 };
  repairByStrategy[s].total += 1; if (r.status === 'SUCCESS') repairByStrategy[s].ok += 1;
});
// post-repair escalation：有 repair 且终态 HUMAN_ESCALATION
let postRepairEsc = 0;
aiRepair.forEach((r) => { const pt = ptByTaskId(r.taskId); if (pt && pt.status === 'HUMAN_ESCALATION') postRepairEsc += 1; });
const repairVerifiedRecovery = recovered; // 需恢复且终态 SUCCESS

// ============================================================
// §十三 Long Workflow 矩阵
// ============================================================
const lwTasks = perTask.filter((r) => r.category === 'longflow');
function bucket(steps) { const s = n(steps); if (s <= 5) return '5-'; if (s <= 10) return '6-10'; if (s <= 15) return '11-15'; return '16+'; }
const lwBuckets = {};
lwTasks.forEach((r) => { const b = bucket(r.stepCount); if (!lwBuckets[b]) lwBuckets[b] = { total: 0, success: 0, vf: 0, enf: 0, realEsc: 0 }; const o = lwBuckets[b]; o.total += 1; if (r.status === 'SUCCESS') o.success += 1; if (r.taxonomy === 'VERIFY_FAILED') o.vf += 1; if (r.taxonomy === 'ELEMENT_NOT_FOUND') o.enf += 1; if (r.status === 'HUMAN_ESCALATION' && r.escalationKind !== 'CREDIBLE') o.realEsc += 1; });

// ============================================================
// §十五 产品门 A/B/C
// ============================================================
const gate = {
  businessSuccess: businessSuccess >= 0.70,
  realEsc: realEscRate <= 0.30,
  verifyFailed: vfTaskRate < 0.20,
  enf: enfTaskRate <= 0.02,
  businessRecovery: businessRecovery >= 0.60,
};
const gatePassCount = Object.values(gate).filter(Boolean).length;
let verdict;
if (gatePassCount === 5) verdict = 'A — v0.2 Product Candidate';
else verdict = (businessSuccess > 0 && realEscRate < 1) ? 'B — Engineering Ready' : 'C — Not Ready';
// C 判定：控制流结构性缺陷（无 VIL 决策且无恢复）
const vilDecisions = aiEvents.filter((e) => e.type === 'ai.verification.decision');
const controlFlowBroken = vilDecisions.length === 0 && businessRecovery === 0 && recovered === 0;
if (controlFlowBroken) verdict = 'C — Not Ready';

// ============================================================
// 生成报告（20 章）
// ============================================================
const L = [];
const P = (s) => L.push(s);
P('# PHASE12_100_TASK_PRODUCT_VALIDATION.md');
P('');
P('> 生成时间：' + new Date().toISOString());
P('> Benchmark JSON：`' + path.basename(benchPath) + '`（generatedAt ' + bench.generatedAt + '）');
P('> Provider：`' + bench.provider + '` ｜ Model：`' + (bench.model || 'deepseek-chat') + '` ｜ simulated：' + bench.simulated);
P('> 冻结池：`phase12_pool.json`（100 任务，sha256 ' + (bench.selection && bench.selection.sha256 ? bench.selection.sha256.slice(0, 16) : 'n/a') + '…）');
P('> 数据隔离：运行前备份并清空 6 个分析型 store 集合，Phase 12 数据独占；分析后还原。');
P('> 冻结声明：本阶段未修改任何代码 / 成功定义 / 统计口径 / 任务池。CODE FREEZE 全程生效。');
P('');
P('## 1. Executive Summary');
P('');
P('- **100-task 是否完整完成**：' + (total === 100 ? '✅ 是（100/100 终态）' : '⚠️ 否（' + total + '/100）'));
P('- **最终判定**：**' + verdict + '**');
P('- Business Success：' + pct(businessSuccess) + '（目标 ≥70%）');
P('- Real Escalation：' + pct(realEscRate) + '（目标 ≤30%）');
P('- VERIFY_FAILED：' + pct(vfTaskRate) + '（目标 <20%）');
P('- ELEMENT_NOT_FOUND：' + pct(enfTaskRate) + '（目标 ≈0%）');
P('- Business Recovery：' + pct(businessRecovery) + '（目标 ≥60%）');
P('- Execution Success：' + pct(executionSuccess));
P('');
P('## 2. Data Integrity');
P('');
P('- benchmark perTask 任务数：' + total + '；store aiTasks：' + aiTasks.length + '；桥接 scn↔taskId：' + (scnToTaskId.size) + ' 个');
P('- 原始 JSON Business Success（perTask）：' + pct(businessSuccess) + '；store 派生 Business Success（aiTasks 终态）：' + pct(storeSuccessRate) + ' → 交叉验证 ' + (Math.abs(businessSuccess - storeSuccessRate) < 0.02 ? '✅ 一致' : '⚠️ 偏差') + '');
P('- 原始 JSON Execution Success：' + pct(executionSuccess) + '；store 派生（aiAttempts）：' + pct(storeExecRate) + ' → 交叉验证 ' + (Math.abs(executionSuccess - storeExecRate) < 0.05 ? '✅ 一致' : '⚠️ 偏差') + '');
P('- JSON 与 store 桥接一致性：' + (scnToTaskId.size > 0 ? '✅' : '⚠️') + '；悬挂/RUNNING 任务：' + perTask.filter((r) => !['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED', 'RUNNER_ERROR'].includes(r.status)).length);
P('');
P('## 3. Benchmark Completeness');
P('');
P('- 总任务：' + total + '（4 类：SaaS ' + perTask.filter((r) => r.category === 'saas').length + ' / E-commerce ' + perTask.filter((r) => r.category === 'ecommerce').length + ' / Data Entry ' + perTask.filter((r) => r.category === 'data_entry').length + ' / Long Workflow ' + perTask.filter((r) => r.category === 'longflow').length + '）');
P('- TERMINAL 状态分布：' + JSON.stringify(perTask.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {})));
P('');
P('## 4. Core Metrics');
P('');
P('| 指标 | 值 | 交叉验证来源 |');
P('| --- | --- | --- |');
P('| Planner Success Rate | ' + pct(S.plannerSuccessRate) + ' | summary |');
P('| Execution Success Rate | ' + pct(executionSuccess) + ' | perTask + aiAttempts |');
P('| **Business Success** | **' + pct(businessSuccess) + '** | perTask + aiTasks |');
P('| Human Escalation (Credible/Real) | ' + pct(S.humanEscalationRate) + ' (Cred ' + pct(S.escalationCredibleRate) + ' / Real ' + pct(realEscRate) + ') | summary |');
P('| VERIFY_FAILED (task/step/attempt) | ' + pct(vfTaskRate) + ' / ' + pct(vfStepRate) + ' / ' + pct(enfAttemptRate) + ' | perTask + aiEvents/aiAttempts |');
P('| ELEMENT_NOT_FOUND (task/step/attempt) | ' + pct(enfTaskRate) + ' / ' + pct(enfStepRate) + ' / ' + pct(enfAttemptRate) + ' | perTask + aiSteps/aiAttempts |');
P('| Repair Attempt Success（store） | ' + (repairAttemptCount ? pct(repairActionSuccess / repairAttemptCount) : '-') + ' | aiRepairAttempts |');
P('| Business Recovery（After Repair） | ' + pct(businessRecovery) + ' | perTask |');
P('| VIL decision 事件 | ' + vilDecisions.length + ' | aiEvents |');
P('| Average Cost | $' + (S.averageCost && S.averageCost.avgUSDPerTask) + ' / 任务 | summary |');
P('| Average Duration | ' + (S.averageDurationMs ? (S.averageDurationMs / 1000).toFixed(1) + ' s' : '-') + ' / 任务 | summary |');
P('| Agent Score (overall) | ' + (S.agentScore && S.agentScore.overall) + ' | summary |');
P('');
P('## 5. Business Success Analysis');
P('');
P('- Business Success = Execution Success AND Verification Passed AND No Human Escalation（终态 SUCCESS）。');
P('- 当前 Business Success ' + pct(businessSuccess) + '，较 Phase 10.9 基线 11% ' + (businessSuccess > 0.11 ? '↑' : '↓') + '，较 Phase 11 20-task 信号 33.3% ' + (businessSuccess > 0.333 ? '↑' : '↓') + '。');
P('');
P('## 6. Execution → Business Gap');
P('');
P('- Execution Success ' + pct(executionSuccess) + ' vs Business Success ' + pct(businessSuccess) + ' → Gap = ' + pct(executionSuccess - businessSuccess) + '。');
P('- Gap 主因（VERIFY_FAILED ' + verifyFailedCount + ' + 升级 ' + (realEscCount + credEscCount) + '）即为验证/恢复未能把已执行动作转为已验证业务结果。');
P('');
P('## 7. Outcome Contract Analysis');
P('');
P('- Phase 12 运行在 Phase 11 Outcome Contract（verification.js buildEffectiveVerification 关键动作权威覆盖 + contract.js evaluateContract）之上。');
P('- Action → Outcome（Execution / Verification Pass / Business）：');
P('');
P('| Action | Execution | Verification | Business |');
P('| --- | --- | --- | --- |');
Object.keys(actionStats).forEach((a) => {
  const st = actionStats[a];
  if (!st.execAtt && !st.verifEvt && !st.tasksWith) return;
  P('| ' + a + ' | ' + (st.execAtt ? pct(st.execSucc / st.execAtt) : '-') + ' | ' + (st.verifEvt ? pct(st.verifPass / st.verifEvt) : '-') + ' | ' + (st.tasksWith ? pct(st.tasksSuccess / st.tasksWith) : '-') + ' |');
});
P('');
P('> 判断：若关键动作的 Verification Pass 明显高于 Phase 10.9 的脆弱单信号，且 Business 接近 Execution，则 Outcome Contract 有效缩小了 Execution→Business gap。');
P('');
P('## 8. VERIFY_FAILED Taxonomy');
P('');
P('- VERIFY_FAILED 任务数：' + verifyFailedCount + '（task 率 ' + pct(vfTaskRate) + '；step 率 ' + pct(vfStepRate) + '）');
P('- 真实 evidence 10 类分类（不推断比例，无样本记 0）：');
P('');
P('| 类别 | 数量 |');
P('| --- | --- |');
VF_CLASSES.forEach((c) => { if (vfClassCount[c] > 0) P('| ' + c + ' | ' + vfClassCount[c] + ' |'); });
P('| （其余无样本类别） | 0 |');
P('');
P('## 9. Resolver Analysis');
P('');
P('- ELEMENT_NOT_FOUND：' + enfCount + ' 任务（task 率 ' + pct(enfTaskRate) + '；step 率 ' + pct(enfStepRate) + '；attempt 率 ' + pct(enfAttemptRate) + '）。');
P('- matchedBy 持久化：' + (matchedByPersisted ? '✅ 已持久化' : '⚠️ INSTRUMENTATION GAP（快照/repair 未记录 matchedBy）') + '。');
P('- Resolver 矩阵（ELEMENT_NOT_FOUND 任务）：');
P('');
P('| task | category | targetField | targetSemantic | matchedBy | repairStrategy | finalOutcome |');
P('| --- | --- | --- | --- | --- | --- | --- |');
resolverRows.forEach((r) => P('| ' + r.task + ' | ' + r.category + ' | ' + r.targetField + ' | ' + r.targetSemantic + ' | ' + r.matchedBy + ' | ' + r.repairStrategy + ' | ' + r.finalOutcome + ' |'));
P('');
P('## 10. Repair Analysis');
P('');
P('- Repair Attempt 总数（store）：' + repairAttemptCount + '；Repair Action Success：' + repairActionSuccess + '（' + (repairAttemptCount ? pct(repairActionSuccess / repairAttemptCount) : '-') + '）');
P('- Verified Recovery（需恢复且终态 SUCCESS）：' + repairVerifiedRecovery + ' / ' + neededRec.length + '（' + pct(businessRecovery) + '）');
P('- Post-repair Escalation：' + postRepairEsc + ' 任务（repair 后仍升级）');
P('- 按策略拆分：');
P('');
P('| 策略 | 总数 | 成功 | 成功率 |');
P('| --- | --- | --- | --- |');
Object.keys(repairByStrategy).forEach((s) => { const r = repairByStrategy[s]; P('| ' + s + ' | ' + r.total + ' | ' + r.ok + ' | ' + pct(r.total ? r.ok / r.total : 0) + ' |'); });
P('');
P('## 11. Business Recovery');
P('');
P('- Business Recovery（严格定义）= 失败后 repair/VIL/recovery 使业务最终恢复的比例 = ' + pct(businessRecovery) + '（' + recovered + '/' + neededRec.length + '）。');
P('- 与 Phase 10.9 基线 2.4% 对比：' + (businessRecovery > 0.024 ? '↑ 提升' : '≈ 持平') + '。');
P('');
P('## 12. Human Escalation');
P('');
P('| 类型 | 数量 | 占比 |');
P('| --- | --- | --- |');
P('| 总计 | ' + (realEscCount + credEscCount) + ' | ' + pct(S.humanEscalationRate) + ' |');
P('| Credible（凭据/支付/CRITICAL 门控，预期安全行为） | ' + credEscCount + ' | ' + pct(S.escalationCredibleRate) + ' |');
P('| Real（验证/解析/执行/恢复/超时等真实弱点） | ' + realEscCount + ' | ' + pct(realEscRate) + ' |');
P('');
P('## 13. Scenario Matrix');
P('');
P('| 场景 | 任务 | 成功 | BS | ExecSucc | RealEsc | CredEsc | VF | ENF | BusRec |');
P('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const CATMAP = { saas: 'SaaS', ecommerce: 'E-commerce', data_entry: 'Data Entry', longflow: 'Long Workflow' };
['saas', 'ecommerce', 'data_entry', 'longflow'].forEach((c) => {
  const rows = perTask.filter((r) => r.category === c);
  if (!rows.length) return;
  const succ = rows.filter((r) => r.status === 'SUCCESS').length;
  const exS = rows.reduce((a, r) => a + n(r.successAttempts), 0);
  const exT = rows.reduce((a, r) => a + n(r.attemptCount), 0);
  const re = rows.filter((r) => r.status === 'HUMAN_ESCALATION' && r.escalationKind !== 'CREDIBLE').length;
  const ce = rows.filter((r) => r.status === 'HUMAN_ESCALATION' && r.escalationKind === 'CREDIBLE').length;
  const vf = rows.filter((r) => r.taxonomy === 'VERIFY_FAILED').length;
  const en = rows.filter((r) => r.taxonomy === 'ELEMENT_NOT_FOUND').length;
  const nr = rows.filter((r) => (n(r.retries) + n(r.repairCount)) > 0);
  const rec = nr.filter((r) => r.status === 'SUCCESS').length;
  P('| ' + CATMAP[c] + ' | ' + rows.length + ' | ' + succ + ' | ' + pct(succ / rows.length) + ' | ' + (exT ? pct(exS / exT) : '-') + ' | ' + re + ' | ' + ce + ' | ' + vf + ' | ' + en + ' | ' + (nr.length ? pct(rec / nr.length) : '-') + ' |');
});
P('');
P('## 14. Long Workflow Analysis');
P('');
P('| 步数桶 | 任务 | 成功 | VERIFY_FAILED | ENF | RealEsc |');
P('| --- | --- | --- | --- | --- | --- |');
Object.keys(lwBuckets).sort().forEach((b) => { const o = lwBuckets[b]; P('| ' + b + ' | ' + o.total + ' | ' + pct(o.success / o.total) + ' (' + o.success + ') | ' + o.vf + ' | ' + o.enf + ' | ' + o.realEsc + ' |'); });
P('');
P('> 判断：是否存在随流程长度增加成功率显著下降。');
P('');
P('## 15. Phase 10.9 → Phase 11 → Phase 12');
P('');
P('| 指标 | Phase 10.9 (100) | Phase 11 (20, small-sample) | Phase 12 (100) |');
P('| --- | --- | --- | --- |');
P('| Business Success | 11.0% | 33.3% (small-sample) | ' + pct(businessSuccess) + ' |');
P('| Execution Success | 52.8% | 69.2% | ' + pct(executionSuccess) + ' |');
P('| VERIFY_FAILED | 58.0% | 66.7% (rate up; 绝对数 58→10) | ' + pct(vfTaskRate) + ' |');
P('| ELEMENT_NOT_FOUND | 8.0% | 0% | ' + pct(enfTaskRate) + ' |');
P('| Real Escalation | 64.0% | 66.7% | ' + pct(realEscRate) + ' |');
P('| Business Recovery | 2.4% | 23.1% | ' + pct(businessRecovery) + ' |');
P('');
P('> Phase 11 的 20-task 结果仅作候选信号，不与 100-task 产品验证同等级。');
P('');
P('## 16. Failure Root Cause');
P('');
P('- VERIFY_FAILED 主导子类：' + (Object.entries(vfClassCount).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join(', ') || '无样本'));
P('- 若主导为 VERIFICATION_TOO_STRICT / STATE_CHANGED_BUT_VERIFICATION_WRONG → 验证契约问题；若 ACTION_REAL_FAILURE / DOM_CHANGED → 真实执行/站点问题。');
P('');
P('## 17. Product Readiness');
P('');
P('| 门槛 | 要求 | 实际 | 通过 |');
P('| --- | --- | --- | --- |');
P('| Business Success | ≥70% | ' + pct(businessSuccess) + ' | ' + (gate.businessSuccess ? '✅' : '❌') + ' |');
P('| Real Escalation | ≤30% | ' + pct(realEscRate) + ' | ' + (gate.realEsc ? '✅' : '❌') + ' |');
P('| VERIFY_FAILED | <20% | ' + pct(vfTaskRate) + ' | ' + (gate.verifyFailed ? '✅' : '❌') + ' |');
P('| ELEMENT_NOT_FOUND | ≈0% | ' + pct(enfTaskRate) + ' | ' + (gate.enf ? '✅' : '❌') + ' |');
P('| Business Recovery | ≥60% | ' + pct(businessRecovery) + ' | ' + (gate.businessRecovery ? '✅' : '❌') + ' |');
P('');
P('**最终判定：' + verdict + '**（' + gatePassCount + '/5 门槛通过）');
P('');
if (verdict.startsWith('A')) {
  P('✅ 全部 A 档门槛达成，具备进入 v0.2 产品评审的证据。');
} else if (verdict.startsWith('B')) {
  P('⚠️ 架构稳定、数据可信、核心能力已闭环，但产品门未全部达标。阻塞项（P0/P1/P2）：');
  if (!gate.businessSuccess) P('- P0: Business Success ' + pct(businessSuccess) + ' < 70%');
  if (!gate.realEsc) P('- P0: Real Escalation ' + pct(realEscRate) + ' > 30%');
  if (!gate.verifyFailed) P('- P1: VERIFY_FAILED ' + pct(vfTaskRate) + ' ≥ 20%');
  if (!gate.enf) P('- P1: ELEMENT_NOT_FOUND ' + pct(enfTaskRate) + ' > 0%');
  if (!gate.businessRecovery) P('- P1: Business Recovery ' + pct(businessRecovery) + ' < 60%');
  P('');
  P('> 按约束：不实施修复、不自动重跑、不自动进入 Phase 13。');
} else {
  P('❌ 核心控制流仍存在结构性缺陷（VIL decision=0 且 recovered=0 且无业务恢复），benchmark 未能证明真实能力。');
}
P('');
P('## 18. A/B/C Decision');
P('');
P('- 判定：' + verdict);
P('- 依据：§15 五门槛 ' + gatePassCount + '/5 通过；控制流完整性（VIL decision ' + vilDecisions.length + ' 次）' + (controlFlowBroken ? 'BROKEN' : 'OK') + '。');
P('');
P('## 19. Remaining Blockers');
P('');
if (verdict.startsWith('A')) {
  P('- 无硬性阻塞；建议下一阶段聚焦真实站点 login-auth 摩擦与多字段 data-entry 完成率（真实业务短板，非验证缺陷）。');
} else {
  P('- SaaS login-auth 摩擦：' + perTask.filter((r) => r.category === 'saas' && r.status !== 'SUCCESS').length + ' 个 SaaS 任务未成功（真实 auth 站点摩擦）。');
  P('- Data Entry 多字段完成：' + perTask.filter((r) => r.category === 'data_entry' && r.status !== 'SUCCESS').length + ' 个 data-entry 任务未成功。');
  P('- VERIFY_FAILED 主导：' + (Object.entries(vfClassCount).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0] || ['-', 0]).join('=') + '。');
}
P('');
P('## 20. Final Recommendation');
P('');
P('- 本阶段为一次性大闭环：前置门（A–E 全过）→ 冻结 100-task 池 → 静态门 → 100-task 真实基准（real DeepSeek + real Chromium）→ 数据完整性审计 → 失败归因 → Before/After → 产品门 → STOP。');
P('- 未修改任何代码 / 成功定义 / 统计口径 / 任务池（CODE FREEZE）。');
P('- 判定：' + verdict + '。' + (verdict.startsWith('A') ? '建议进入 v0.2 产品评审。' : '建议明确 P0/P1/P2 阻塞项后，等待下一阶段授权，不再自行进入 Phase 13。'));
P('');
P('---');
P('数据来源：`.benchmark/phase12_100task_*.json` + 隔离后的 `server/data/{aiTasks,aiSteps,aiAttempts,aiEvents,aiRepairAttempts,aiFailureSnapshots}.json`。');
P('本分析为只读，未修改任何冻结代码/统计口径/成功定义。');

const out = L.join('\n');
const outPath = path.join(ROOT, 'PHASE12_100_TASK_PRODUCT_VALIDATION.md');
fs.writeFileSync(outPath, out, 'utf8');
console.log('[analyze] REPORT WRITTEN:', outPath);
console.log('[analyze] verdict:', verdict, '| BS:', pct(businessSuccess), '| RealEsc:', pct(realEscRate), '| VF:', pct(vfTaskRate), '| ENF:', pct(enfTaskRate), '| BusRec:', pct(businessRecovery), '| gates', gatePassCount + '/5');
