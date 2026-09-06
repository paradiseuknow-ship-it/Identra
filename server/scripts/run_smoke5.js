'use strict';

// 5-task targeted smoke（STEP 1，非 benchmark）：
//   仅跑 rw.094 / rw.083 / rw.004 / rw.027 / rw.034（v1 池任务），目的只有两个：
//   ① 最终确认 rw.094/rw.083 真实根因；② 验证 P4/P5 修复对真实 LLM 的效果。
// 不做全量评分、不建立 baseline、不写 selection 元数据以外的 benchmark 产物。
//
// Evidence chain（每任务一个 JSON，.benchmark/smoke5_<ts>/）：
//   planner output（plans/*.json，经 FPB_CAPTURE_PLAN_DIR 由 deepseekPlan 落盘）
//   → canonical plan（aiSteps：action/verification/description/startedAt）
//   → attempts（执行/观察/验证时序）
//   → aiEvents（taskId 全量事件）
//   → repair/replan（aiRepairAttempts + agent.retrying 事件）
//   → final state（taskManager 终态 + error）
// rw.083 专项块：等待步骤 expected evidence / attempts 时序 / 事件时序（DOM readiness 与
//   waitForElement 内部结果由既有 aiEvents/step 事件承载，缺失处标 null 不臆造）。
//
// 纪律：无 DEEPSEEK_API_KEY 时 fail-fast（exit 2）并说明阻塞，不等待、不重试 API。

const fs = require('fs');
const path = require('path');

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('[smoke5] 硬阻塞：DEEPSEEK_API_KEY 不可用（.env 缺失/为空，环境变量未设置）。');
  console.error('[smoke5] 按纪律不等待不重试。请提供 key 后运行：');
  console.error('[smoke5]   set DEEPSEEK_API_KEY=<key> && node server/scripts/run_smoke5.js');
  process.exit(2);
}

const P9 = require('./phase10Benchmark');
const TARGETS = ['rw.094', 'rw.083', 'rw.004', 'rw.027', 'rw.034'];

async function main() {
  const outDir = path.resolve(__dirname, '..', '..', '.benchmark', 'smoke5_' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  process.env.FPB_CAPTURE_PLAN_DIR = path.join(outDir, 'plans');

  const tasks = P9.loadTasks().filter((t) => TARGETS.includes(t.id));
  const missing = TARGETS.filter((id) => !tasks.some((t) => t.id === id));
  if (missing.length) throw new Error('目标任务在 v1 池中缺失: ' + missing.join(','));

  const mock = await P9.startMockServer();
  if (!mock || !mock.port) throw new Error('mock server 启动失败（port 缺失）');
  const baseUrl = 'http://127.0.0.1:' + mock.port;
  console.log('[smoke5] mock @', baseUrl, '| out:', outDir);

  const results = [];
  for (const scn of tasks) {
    console.log('\n[smoke5] ===', scn.id, scn.objective, '===');
    const rec = await P9.runScenario(scn, baseUrl);
    // 完整 evidence chain（纯读 store，按 taskId/stepId 过滤）
    const store = require('../agent/store');
    const steps = store.read('aiSteps', []).filter((s) => s.taskId === scn.id);
    const stepIds = new Set(steps.map((s) => s.id));
    const attempts = store.read('aiAttempts', []).filter((a) => stepIds.has(a.stepId));
    const events = store.read('aiEvents', []).filter((e) => e.taskId === scn.id);
    const repairs = store.read('aiRepairAttempts', []).filter((r) => r.taskId === scn.id);
    const snapshots = store.read('aiFailureSnapshots', []).filter((s) => s.taskId === scn.id);
    const evidence = {
      taskId: scn.id,
      objective: scn.objective,
      fixture: scn.fixture,
      finalState: { status: rec.status, error: rec.error, taxonomy: rec.taxonomy, escalationClass: rec.escalationClass, escalated: rec.escalated, escalationKind: rec.escalationKind },
      counters: { stepCount: rec.stepCount, attemptCount: rec.attemptCount, retries: rec.retries, repairCount: rec.repairCount, repairSuccess: rec.repairSuccess, verificationTotal: rec.verificationTotal, verificationPassed: rec.verificationPassed, latencyMs: rec.latencyMs },
      canonicalPlan: steps.map((s) => ({ id: s.id, description: s.description, status: s.status, startedAt: s.startedAt, action: s.action, verification: s.verification })),
      attemptsTimeline: attempts.map((a) => ({ stepId: a.stepId, startedAt: a.startedAt, status: a.status, error: a.error })),
      events: events,
      repairs: repairs,
      failureSnapshots: snapshots,
      actionsSummary: rec.actions || null,
    };
    // rw.083 专项：等待类步骤的 expected evidence 与时序（真实执行产物，非推断）
    if (scn.id === 'rw.083') {
      const waitSteps = steps.filter((s) => /等待|加载|wait/i.test(String(s.description || '')));
      evidence.rw083_focus = {
        waitSteps: waitSteps.map((s) => ({
          description: s.description,
          action: s.action,
          expectedEvidence: s.verification, // planner 产出的等待验证证据（P5 判定对象）
          startedAt: s.startedAt,
          status: s.status,
        })),
        attempts: attempts.map((a) => ({ stepId: a.stepId, startedAt: a.startedAt, endedAt: a.endedAt || null, status: a.status })),
        eventOrder: events.map((e) => ({ ts: e.timestamp || e.ts, type: e.type })),
        note: 'DOM readiness / waitForElement 内部结果由事件链承载；字段缺失处保持 null，不臆造。',
      };
    }
    fs.writeFileSync(path.join(outDir, scn.id + '.json'), JSON.stringify(evidence, null, 1), 'utf8');
    results.push({ id: scn.id, status: rec.status, taxonomy: rec.taxonomy, esc: rec.escalationClass, verif: rec.verificationPassed + '/' + rec.verificationTotal, actions: (rec.actions || []).length });
    console.log('[smoke5]', scn.id, '→', rec.status, rec.taxonomy, rec.escalationClass, 'verif', rec.verificationPassed + '/' + rec.verificationTotal);
  }

  try { mock.server.close(); } catch (e) {}
  console.log('\n[smoke5] 汇总（非评分，仅终态观察）:');
  results.forEach((r) => console.log(' ', r.id, r.status, '|', r.taxonomy, '|', r.esc, '| verif', r.verif, '| actions', r.actions));
  console.log('[smoke5] evidence →', outDir);
  console.log('[smoke5] 完成。归因请读各任务 JSON 的 canonicalPlan/attemptsTimeline/repairs 与 plans/*.json（planner 原始输出）。');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[smoke5] FAIL:', e && e.stack || e); process.exit(1); });
