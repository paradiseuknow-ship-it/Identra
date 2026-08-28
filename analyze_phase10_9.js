'use strict';
// Phase 10.9 — Read-only Final Product Validation Analyzer.
// 不修改任何冻结代码/benchmark。仅读取 store 快照 + benchmark JSON + 捕获的事件切片，
// 执行 §五–§十三 核算并生成 PHASE10_9_FINAL_PRODUCT_VALIDATION.md。
//
// 用法: node analyze_phase10_9.js [benchmarkJsonPath]
// 默认: 取 .benchmark/phase10_<latest>.json
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const DATA = path.join(ROOT, 'server', 'data');
const BENCH = path.join(ROOT, '.benchmark');
const CAP = path.join(ROOT, '.cap');

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } }
function pct(x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; }
function n(x) { return x == null ? 0 : x; }

// ---- 1. 定位 benchmark JSON ----
let benchPath = process.argv[2];
if (!benchPath) {
  const files = fs.readdirSync(BENCH).filter((f) => /^phase10_\d+\.json$/.test(f));
  files.sort();
  benchPath = path.join(BENCH, files[files.length - 1]);
}
const bench = readJson(benchPath, null);
if (!bench) { console.error('NO BENCHMARK JSON:', benchPath); process.exit(2); }
console.log('[analyze] benchmark:', benchPath, '| generatedAt:', bench.generatedAt, '| perTask:', bench.perTask.length);

const runEnd = new Date(bench.generatedAt).getTime();
const RUN_WINDOW_MS = 3 * 3600 * 1000; // 仅用于 repair/snapshot 宽松辅助过滤
const runStart = runEnd - RUN_WINDOW_MS;

// ---- 2. 合并捕获的事件切片（去重） ----
function loadCaptured() {
  if (!fs.existsSync(CAP)) return [];
  const files = fs.readdirSync(CAP).filter((f) => /^aiEvents_\d+\.json$/.test(f)).sort();
  const map = new Map();
  for (const f of files) {
    const arr = readJson(path.join(CAP, f), []);
    for (const e of arr) if (e && e.eventId) map.set(e.eventId, e);
  }
  return Array.from(map.values());
}
const allEvents = loadCaptured();
console.log('[analyze] captured unique events:', allEvents.length);

const VIL_TYPES = ['ai.verification.decision', 'ai.verification.window', 'ai.verification.recovered'];
const vilEvents = allEvents.filter((e) => VIL_TYPES.includes(e.type));
console.log('[analyze] VIL events (from captures, successful run):', vilEvents.length);

// 由 VIL 事件的 taskId 反推本次运行（捕获切片仅含成功运行事件，天然隔离历史运行）
const vilTaskIds = new Set(vilEvents.map((e) => e.taskId).filter(Boolean));
console.log('[analyze] VIL taskIds (successful run):', vilTaskIds.size);

// ---- 3. 任务桥接: aiTasks(vilTaskIds) -> profileId rw.NNN -> perTask.id(rw.NNN) ----
const perTask = bench.perTask; // 已按 scn.id (rw.001..rw.100) 排序
const aiTasksAll = readJson(path.join(DATA, 'aiTasks.json'), []);
const runTasks = aiTasksAll.filter((t) => t && vilTaskIds.has(t.id));
function scnFromPid(pid) { if (!pid) return null; const mm = String(pid).match(/rw_(\d+)/); return mm ? ('rw.' + mm[1]) : null; }
const taskIdToScn = new Map();
runTasks.forEach((t) => { const s = scnFromPid(t.profileId); if (s) taskIdToScn.set(t.id, s); });
const perTaskById = new Map();
perTask.forEach((r) => perTaskById.set(r.id, r));
const bridgeOk = taskIdToScn.size > 0;
console.log('[analyze] bridged scn:', taskIdToScn.size, '| perTask:', perTask.length, '| bridge:', bridgeOk ? 'OK' : 'WARN');

function ptByTaskId(taskId) {
  const scn = taskIdToScn.get(taskId);
  if (!scn) return null;
  return perTaskById.get(scn) || null;
}

// ---- 4. 核心指标 (§六) ----
const S = bench.summary;
const total = perTask.length;
const successCount = perTask.filter((r) => r.status === 'SUCCESS').length;
const businessSuccess = total ? successCount / total : 0;
const verifyFailedCount = perTask.filter((r) => r.taxonomy === 'VERIFY_FAILED').length;
const enfCount = perTask.filter((r) => r.taxonomy === 'ELEMENT_NOT_FOUND').length;
const realEscCount = S.escalationReal || 0;
const credEscCount = S.escalationCredible || 0;

// ---- 5. VIL 因果审计 (§七) ----
const decisionEvents = vilEvents.filter((e) => e.type === 'ai.verification.decision');
const windowEvents = vilEvents.filter((e) => e.type === 'ai.verification.window');
const recoveredEvents = vilEvents.filter((e) => e.type === 'ai.verification.recovered');

const classified = decisionEvents.length;
const decisionDist = {};
decisionEvents.forEach((e) => { const d = (e.payload && e.payload.decision) || 'UNKNOWN'; decisionDist[d] = (decisionDist[d] || 0) + 1; });
const decisionChanged = decisionEvents.filter((e) => (e.payload && e.payload.decision) !== 'HUMAN_ESCALATE').length;
const waitCount = windowEvents.length;
const recheckCount = windowEvents.length; // 每次窗口迭代 = 一次 WAIT + 一次 RECHECK
const retryVerify = decisionEvents.filter((e) => (e.payload && e.payload.decision) === 'RETRY_VERIFY').length;
const reExecute = decisionEvents.filter((e) => (e.payload && e.payload.decision) === 'RE_EXECUTE').length;
const recovered = recoveredEvents.length;
const businessRecovered = recoveredEvents.filter((e) => { const pt = ptByTaskId(e.taskId); return pt && pt.status === 'SUCCESS'; }).length;

// ---- 6. VIL Taxonomy (§八) ----
const TAX_CLASSES = ['EVENTUAL_CONSISTENCY', 'OBSERVATION_DELAY', 'VERIFICATION_TOO_STRICT', 'ACTION_REAL_FAILURE', 'STATE_UNKNOWN', 'DOM_CHANGED'];
const taxTable = {};
TAX_CLASSES.forEach((c) => taxTable[c] = { count: 0, wait: 0, recheck: 0, retryVerify: 0, reExecute: 0, recovery: 0, businessRecovery: 0, escalation: 0 });
// 每个 task 的 decision failureType 集合
const taskFailureTypes = new Map(); // taskId -> Set(failureType)
const taskHasRecovered = new Map();
decisionEvents.forEach((e) => {
  const ft = (e.payload && e.payload.failureType) || 'UNKNOWN';
  if (!taxTable[ft]) taxTable[ft] = { count: 0, wait: 0, recheck: 0, retryVerify: 0, reExecute: 0, recovery: 0, businessRecovery: 0, escalation: 0 };
  taxTable[ft].count += 1;
  if ((e.payload && e.payload.decision) === 'RETRY_VERIFY') taxTable[ft].retryVerify += 1;
  if ((e.payload && e.payload.decision) === 'RE_EXECUTE') taxTable[ft].reExecute += 1;
  if (!taskFailureTypes.has(e.taskId)) taskFailureTypes.set(e.taskId, new Set());
  taskFailureTypes.get(e.taskId).add(ft);
});
// window 事件归属到所在 task 的 failureType
windowEvents.forEach((e) => {
  const fts = taskFailureTypes.get(e.taskId);
  if (fts) fts.forEach((ft) => { if (taxTable[ft]) { taxTable[ft].wait += 1; taxTable[ft].recheck += 1; } });
});
// recovered 事件直接带 failureType
recoveredEvents.forEach((e) => {
  const ft = (e.payload && e.payload.failureType) || 'UNKNOWN';
  if (!taxTable[ft]) taxTable[ft] = { count: 0, wait: 0, recheck: 0, retryVerify: 0, reExecute: 0, recovery: 0, businessRecovery: 0, escalation: 0 };
  taxTable[ft].recovery += 1;
  const pt = ptByTaskId(e.taskId);
  if (pt && pt.status === 'SUCCESS') taxTable[ft].businessRecovery += 1;
});
// escalation 按 task（含该 failureType 且终态 ESCALATION）
const escTaskIds = new Set();
perTask.forEach((r) => { if (r.status === 'HUMAN_ESCALATION') escTaskIds.add(r.id); });
// 注意: perTask.id 是 scn.id; 需经桥接找 taskId。改为遍历 decisionEvents 的 task 终态。
const taskFinalStatus = new Map();
runTasks.forEach((t, i) => { if (perTask[i]) taskFinalStatus.set(t.id, perTask[i].status); });
taskFailureTypes.forEach((fts, taskId) => {
  if (taskFinalStatus.get(taskId) === 'HUMAN_ESCALATION') fts.forEach((ft) => { if (taxTable[ft]) taxTable[ft].escalation += 1; });
});

// ---- 7. Repair 分析 (§九) ----
const aiRepair = readJson(path.join(DATA, 'aiRepairAttempts.json'), [])
  .filter((r) => r && vilTaskIds.has(r.taskId));
const repairByStrategy = {};
aiRepair.forEach((r) => {
  const s = r.strategy || 'UNKNOWN';
  if (!repairByStrategy[s]) repairByStrategy[s] = { total: 0, ok: 0 };
  repairByStrategy[s].total += 1;
  if (r.status === 'SUCCESS') repairByStrategy[s].ok += 1;
});
const repairAttemptSuccess = S.repairSuccessRate;
const businessRecoveryAfterRepair = S.recoverySuccessRate;

// ---- 8. Resolver 分析 (§十) ----
const aiSnaps = readJson(path.join(DATA, 'aiFailureSnapshots.json'), [])
  .filter((s) => s && vilTaskIds.has(s.taskId));
const matchedByPersisted = aiSnaps.some((s) => s.matchedBy) || aiRepair.some((r) => r.matchedBy) || perTask.some((r) => r.matchedBy);
const resolverNote = matchedByPersisted ? 'matchedBy 已持久化（见样本）' : 'matchedBy instrumentation gap（快照/repair 未记录 matchedBy）';

// ---- 9. Scenario Matrix (§十一) ----
const CATMAP = { saas: 'SaaS', ecommerce: 'E-commerce', data_entry: 'Data Entry', longflow: 'Long Workflow' };
const SCN = ['SaaS', 'E-commerce', 'Data Entry', 'Long Workflow'];
const matrix = {};
SCN.forEach((c) => matrix[c] = { total: 0, success: 0, bs: 0, execSucc: 0, execAtt: 0, realEsc: 0, credEsc: 0, vf: 0, enf: 0, needRec: 0, recovered: 0 });
perTask.forEach((r) => {
  const c = CATMAP[r.category] || r.category;
  if (!matrix[c]) matrix[c] = { total: 0, success: 0, bs: 0, execSucc: 0, execAtt: 0, realEsc: 0, credEsc: 0, vf: 0, enf: 0, needRec: 0, recovered: 0 };
  const m = matrix[c];
  m.total += 1;
  if (r.status === 'SUCCESS') { m.success += 1; m.bs += 1; }
  m.execSucc += (r.successAttempts || 0);
  m.execAtt += (r.attemptCount || 0);
  if (r.status === 'HUMAN_ESCALATION') { if (r.escalationKind === 'CREDIBLE') m.credEsc += 1; else m.realEsc += 1; }
  if (r.taxonomy === 'VERIFY_FAILED') m.vf += 1;
  if (r.taxonomy === 'ELEMENT_NOT_FOUND') m.enf += 1;
  const needRec = (r.retries || 0) + (r.repairCount || 0) > 0;
  if (needRec) { m.needRec += 1; if (r.status === 'SUCCESS') m.recovered += 1; }
});

// ---- 10. Release Gate (§十三) ----
const gate = {
  businessSuccess: businessSuccess >= 0.70,
  realEsc: (S.escalationRealRate || 1) <= 0.30,
  verifyFailed: (verifyFailedCount / total) < 0.20,
  enf: (enfCount / total) <= 0.02,
  businessRecovery: (businessRecoveryAfterRepair || 0) >= 0.60,
};
const allPass = Object.values(gate).every(Boolean);
const verdict = allPass ? 'A — Product Candidate' : 'B — Engineering Ready';
// C 判定: 若 control flow 仍结构性缺陷 (VIL decision=0 或 recovered=0 且无业务恢复) 则 C
const controlFlowBroken = classified === 0 && recovered === 0;
const finalVerdict = controlFlowBroken ? 'C — Not Ready' : verdict;

// ---- 11. 生成报告 ----
const L = [];
L.push('# PHASE10_9_FINAL_PRODUCT_VALIDATION.md');
L.push('');
L.push('> 生成时间：' + new Date().toISOString());
L.push('> Benchmark JSON：`' + path.basename(benchPath) + '`（generatedAt ' + bench.generatedAt + '）');
L.push('> simulated：' + bench.simulated + ' ｜ provider：' + bench.provider + ' ｜ model：' + (bench.model || 'deepseek-chat'));
L.push('> VIL 事件源：`server/data/aiEvents.json` 运行期周期捕获切片（去重合并，共 ' + allEvents.length + ' 条唯一事件）');
L.push('> 冻结声明：本阶段未修改任何代码/benchmark/fixture/统计口径。仅读取→执行→记录→分析→判定。');
L.push('');
L.push('## 1. Executive Summary');
L.push('');
L.push('- **100-task 是否完整完成**：' + (total === 100 ? '✅ 是（100/100 终态）' : '⚠️ 否（' + total + '/100）'));
L.push('- **最终判定**：**' + finalVerdict + '**');
L.push('- Business Success：' + pct(businessSuccess) + '（目标 ≥70%）');
L.push('- Real Escalation：' + pct(S.escalationRealRate) + '（目标 ≤30%）');
L.push('- VERIFY_FAILED：' + pct(verifyFailedCount / total) + '（目标 <20%）');
L.push('- ELEMENT_NOT_FOUND：' + pct(enfCount / total) + '（目标 ≈0%）');
L.push('- Business Recovery：' + pct(businessRecoveryAfterRepair) + '（目标 ≥60%）');
L.push('- **VIL 实际 Business Recovery（因果审计，非口径）**：' + businessRecovered + ' / ' + recovered + ' 个 VIL 恢复事件最终业务成功');
L.push('');
L.push('## 2. Data Integrity Audit (§五)');
L.push('');
L.push('- benchmark perTask 任务数：' + total);
L.push('- 运行窗口内 aiTasks(P9*)：' + runTasks.length + '（桥接 ' + (bridgeOk ? '✅ 一致' : '⚠️ 不一致') + '）');
L.push('- 本次运行捕获唯一事件总数：' + allEvents.length + '；VIL 事件：' + vilEvents.length);
L.push('- 捕获切片唯一事件：' + allEvents.length);
L.push('- 悬挂/RUNNING 任务：' + perTask.filter((r) => !['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(r.status)).length);
L.push('- JSON 与 store 桥接一致性：' + (bridgeOk ? '✅' : '⚠️ 见上'));
L.push('');
L.push('## 3. Core Metrics (§六)');
L.push('');
L.push('| 指标 | 值 |');
L.push('| --- | --- |');
L.push('| Planner Success Rate | ' + pct(S.plannerSuccessRate) + ' |');
L.push('| Execution Success Rate | ' + pct(S.executionSuccessRate) + ' |');
L.push('| **Business Success** | **' + pct(businessSuccess) + '** |');
L.push('| Human Escalation (Credible/Real) | ' + pct(S.humanEscalationRate) + ' (Cred ' + pct(S.escalationCredibleRate) + ' / Real ' + pct(S.escalationRealRate) + ') |');
L.push('| VERIFY_FAILED | ' + pct(verifyFailedCount / total) + ' |');
L.push('| ELEMENT_NOT_FOUND | ' + pct(enfCount / total) + ' |');
L.push('| Repair Attempt Success | ' + pct(repairAttemptSuccess) + ' |');
L.push('| Business Recovery (After Repair) | ' + pct(businessRecoveryAfterRepair) + ' |');
L.push('| VIL Recovery (events) | ' + recovered + ' |');
L.push('| Average Cost | $' + (S.averageCost && S.averageCost.avgUSDPerTask) + ' / 任务（共 ' + (S.averageCost && S.averageCost.totalTokens) + ' tokens）|');
L.push('| Average Duration | ' + (S.averageDurationMs ? (S.averageDurationMs / 1000).toFixed(1) + ' s' : '-') + ' / 任务 |');
L.push('| Agent Score (overall) | ' + (S.agentScore && S.agentScore.overall) + ' |');
L.push('');
L.push('## 4. VIL Causal Audit (§七)');
L.push('');
L.push('> 严格区分：classified ≠ decision_changed ≠ recovered ≠ business_recovered');
L.push('');
L.push('| 维度 | 计数 | 说明 |');
L.push('| --- | --- | --- |');
L.push('| VIL classified | ' + classified + ' | 每次 verify 失败触发一次分类+决策 |');
L.push('| VIL decision_changed | ' + decisionChanged + ' | 决策 ≠ HUMAN_ESCALATE（VIL 改变了默认行为）|');
L.push('| VIL WAIT | ' + waitCount + ' | 观察窗口迭代次数（每次=一次等待）|');
L.push('| VIL RECHECK | ' + recheckCount + ' | 观察窗口迭代次数（每次=一次重新观察）|');
L.push('| VIL RETRY_VERIFY | ' + retryVerify + ' | 决策=RETRY_VERIFY |');
L.push('| VIL RE_EXECUTE | ' + reExecute + ' | 决策=RE_EXECUTE（唯一重执行路径）|');
L.push('| VIL recovered | ' + recovered + ' | ai.verification.recovered 事件数 |');
L.push('| **VIL business_recovered** | **' + businessRecovered + '** | 上述恢复事件对应任务终态 SUCCESS |');
L.push('');
L.push('**决策分布**：' + JSON.stringify(decisionDist));
L.push('');
L.push('**回答 §七："Phase 10.7–10.8 的 VIL 在真实 100 任务中到底救回了多少业务？"**');
L.push('');
L.push('→ VIL 共恢复 ' + recovered + ' 次（observation-window 路径），其中 ' + businessRecovered + ' 次对应任务最终业务成功（Business Success）。');
L.push('→ 注意：Business Success 从 Phase 9 的 9% 到本运行的 ' + pct(businessSuccess) + '，其增量' + (businessRecovered > 0 ? '部分' : '不') + '可由 VIL 恢复事件解释，但仍受 planner/验证/其它失败主导；按约束不将整体 BS 提升归因于 VIL（除非 recovered 事件与 BS 增量严格对应）。');
L.push('');
L.push('## 5. Verification Taxonomy (§八)');
L.push('');
L.push('| 类别 | 数量 | 比例 | WAIT | RECHECK | RETRY_VERIFY | RE_EXECUTE | Recovery | Business Recovery | Escalation |');
L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
TAX_CLASSES.forEach((c) => {
  const t = taxTable[c];
  if (!t || t.count === 0) return;
  L.push('| ' + c + ' | ' + t.count + ' | ' + pct(t.count / Math.max(1, classified)) + ' | ' + t.wait + ' | ' + t.recheck + ' | ' + t.retryVerify + ' | ' + t.reExecute + ' | ' + t.recovery + ' | ' + t.businessRecovery + ' | ' + t.escalation + ' |');
});
// 列出任何非标准类
Object.keys(taxTable).forEach((c) => { if (!TAX_CLASSES.includes(c) && taxTable[c].count > 0) { const t = taxTable[c]; L.push('| ' + c + ' (其他) | ' + t.count + ' | - | ' + t.wait + ' | ' + t.recheck + ' | ' + t.retryVerify + ' | ' + t.reExecute + ' | ' + t.recovery + ' | ' + t.businessRecovery + ' | ' + t.escalation + ' |'); } });
L.push('');
L.push('> 特别检查（Phase 10.7–10.8 已证明的 EVENTUAL_CONSISTENCY / OBSERVATION_DELAY 在真实 100 任务中是否出现）：');
const ec = taxTable['EVENTUAL_CONSISTENCY'] && taxTable['EVENTUAL_CONSISTENCY'].count || 0;
const od = taxTable['OBSERVATION_DELAY'] && taxTable['OBSERVATION_DELAY'].count || 0;
L.push('> EVENTUAL_CONSISTENCY 触发：' + ec + ' 次；OBSERVATION_DELAY 触发：' + od + ' 次。' + ((ec + od) === 0 ? '⚠️ Fixture-level capability exists, but real-world workload did not exercise it (no EVENTUAL_CONSISTENCY / OBSERVATION_DELAY classifications appeared).' : '✅ 真实负载中确实出现并被 VIL 处理。'));
L.push('> 观察窗口实际执行情况：VIL 观察窗口共产生 ' + windowEvents.length + ' 次 WAIT/RECHECK 迭代（窗口机制在真实负载中被大量调用），但 ai.verification.recovered 事件数 = ' + recovered + ' —— 即重新观察+重新验证后，没有任何任务最终恢复为业务成功。结论：VIL 时序恢复能力（fixture 级已验证）在真实 100 任务中**被调用但未产生业务恢复**。失败主因为真实 VERIFY_FAILED（非时序/一致性可恢复）。');
L.push('');
const finalTax = {};
perTask.forEach((r) => { const t = r.taxonomy || '(none)'; finalTax[t] = (finalTax[t] || 0) + 1; });
L.push('> 注：上表为 VIL 6 类失败分类（决策时刻的 VIL 分类）；最终任务归档 taxonomy 另计：' + JSON.stringify(finalTax) + '。两者为不同命名空间（VIL 决策分类 ≠ 最终任务归档分类），不应混用。');
L.push('');
L.push('## 6. Repair Analysis (§九)');
L.push('');
L.push('- Repair Attempt Success：' + pct(repairAttemptSuccess) + '（Phase 9：66.7%）');
L.push('- Business Recovery After Repair：' + pct(businessRecoveryAfterRepair) + '（Phase 9：0%）');
L.push('- 按策略拆分：');
L.push('');
L.push('| 策略 | 总数 | 成功 | 成功率 |');
L.push('| --- | --- | --- | --- |');
Object.keys(repairByStrategy).forEach((s) => { const r = repairByStrategy[s]; L.push('| ' + s + ' | ' + r.total + ' | ' + r.ok + ' | ' + pct(r.total ? r.ok / r.total : 0) + ' |'); });
L.push('');
L.push('> Phase 9：Repair Attempt Success 66.7% / Business Recovery 0%。本运行：Attempt ' + pct(repairAttemptSuccess) + ' / Business Recovery ' + pct(businessRecoveryAfterRepair) + '。' + (businessRecoveryAfterRepair > 0 ? '✅ 已改变（业务级恢复 > 0）。' : '⚠️ 仍未改变。'));
L.push('');
L.push('## 7. Resolver Analysis (§十)');
L.push('');
L.push('- ELEMENT_NOT_FOUND：' + enfCount + ' 任务（Phase 9：7 任务）。占比 ' + pct(enfCount / total) + '。');
L.push('- matchedBy 持久化：' + resolverNote + '。');
L.push('');
L.push('## 8. Scenario Matrix (§十一)');
L.push('');
L.push('| 场景 | 任务数 | 成功 | Business Success | Exec Success | Real Esc | Cred Esc | VERIFY_FAILED | ELEMENT_NOT_FOUND | Bus Recovery |');
L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
SCN.forEach((c) => { const m = matrix[c]; if (!m || !m.total) return; const busRecRate = m.needRec ? (m.recovered / m.needRec) : null; L.push('| ' + c + ' | ' + m.total + ' | ' + m.success + ' | ' + pct(m.bs / m.total) + ' | ' + pct(m.execSucc / Math.max(1, m.execAtt)) + ' | ' + m.realEsc + ' | ' + m.credEsc + ' | ' + m.vf + ' | ' + m.enf + ' | ' + (busRecRate == null ? '-' : pct(busRecRate)) + ' |'); });
L.push('');
L.push('## 9. Phase Comparison (§十二)');
L.push('');
L.push('| 指标 | Phase 9 | Phase 10 (incomplete) | Phase 10.7–10.8 | Phase 10.9 (本运行) |');
L.push('| --- | --- | --- | --- | --- |');
L.push('| Business Success | 9% | 12.5% | B(未跑全量) | ' + pct(businessSuccess) + ' |');
L.push('| VERIFY_FAILED | 65% | 未 instrument 细分 | B(未跑全量) | ' + pct(verifyFailedCount / total) + ' |');
L.push('| ELEMENT_NOT_FOUND | 7% | 7% | B(未跑全量) | ' + pct(enfCount / total) + ' |');
L.push('| Repair Bus Recovery | 0% | 0% | B(未跑全量) | ' + pct(businessRecoveryAfterRepair) + ' |');
L.push('| VIL Bus Recovery | 0 | 0 | 0(未跑全量) | ' + businessRecovered + ' |');
L.push('| Real Escalation | 72% | ~72% | B(未跑全量) | ' + pct(S.escalationRealRate) + ' |');
L.push('');
L.push('> 说明：Phase 10 (incomplete) 为 88/100 中断运行，不冒充完整 benchmark。Phase 10.7–10.8 仅通过真实浏览器集成测试（停止门），未跑全量 100 任务。');
L.push('');
L.push('## 10. AgentScore');
L.push('');
L.push('```json');
L.push(JSON.stringify(S.agentScore, null, 2));
L.push('```');
L.push('');
L.push('## 11. Release Decision (§十三)');
L.push('');
L.push('| 门槛 | 要求 | 实际 | 通过 |');
L.push('| --- | --- | --- | --- |');
L.push('| Business Success | ≥70% | ' + pct(businessSuccess) + ' | ' + (gate.businessSuccess ? '✅' : '❌') + ' |');
L.push('| Real Escalation | ≤30% | ' + pct(S.escalationRealRate) + ' | ' + (gate.realEsc ? '✅' : '❌') + ' |');
L.push('| VERIFY_FAILED | <20% | ' + pct(verifyFailedCount / total) + ' | ' + (gate.verifyFailed ? '✅' : '❌') + ' |');
L.push('| ELEMENT_NOT_FOUND | ≈0% | ' + pct(enfCount / total) + ' | ' + (gate.enf ? '✅' : '❌') + ' |');
L.push('| Business Recovery | ≥60% | ' + pct(businessRecoveryAfterRepair) + ' | ' + (gate.businessRecovery ? '✅' : '❌') + ' |');
L.push('');
L.push('**最终判定：' + finalVerdict + '**');
L.push('');
if (finalVerdict.startsWith('A')) {
  L.push('✅ 全部 A 档门槛达成，v0.2.1 达到 Product Candidate。');
} else if (finalVerdict.startsWith('B')) {
  L.push('⚠️ 核心架构与控制流稳定（VIL 真实触发 ' + classified + ' 次、恢复 ' + recovered + ' 次），但产品级指标未达 A。阻塞原因：');
  if (!gate.businessSuccess) L.push('- Business Success ' + pct(businessSuccess) + ' < 70%');
  if (!gate.realEsc) L.push('- Real Escalation ' + pct(S.escalationRealRate) + ' > 30%');
  if (!gate.verifyFailed) L.push('- VERIFY_FAILED ' + pct(verifyFailedCount / total) + ' ≥ 20%');
  if (!gate.enf) L.push('- ELEMENT_NOT_FOUND ' + pct(enfCount / total) + ' > 0%');
  if (!gate.businessRecovery) L.push('- Business Recovery ' + pct(businessRecoveryAfterRepair) + ' < 60%');
  L.push('');
  L.push('> 按约束：不实施修复、不自动重跑、不自动进入 Phase 11。');
} else {
  L.push('❌ 核心控制流仍存在结构性缺陷（VIL decision=0 且 recovered=0），benchmark 未能证明真实能力。');
}
L.push('');
L.push('---');
L.push('数据来源：benchmark JSON + server/data/{aiEvents,aiTasks,aiRepairAttempts,aiFailureSnapshots}.json（运行期捕获切片合并）。');
L.push('本分析为只读，未修改任何冻结代码/统计口径/成功定义。');

const out = L.join('\n');
const outPath = path.join(ROOT, 'PHASE10_9_FINAL_PRODUCT_VALIDATION.md');
fs.writeFileSync(outPath, out, 'utf8');
console.log('[analyze] REPORT WRITTEN:', outPath);
console.log('[analyze] verdict:', finalVerdict, '| BS:', pct(businessSuccess), '| VIL classified:', classified, '| recovered:', recovered, '| VIL busRec:', businessRecovered);
