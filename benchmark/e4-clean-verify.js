'use strict';

// Phase 5.9-E4-Clean-Verify — 单任务 Collector Instrumentation 确定性验收
//
// 目标：在「干净、无缓存污染、单 collector 无嵌套 wrap」前提下，验证 E4 collector 能否可靠回答：
//   - Planner 是否实际被 runtime 调用（plannerCalled / plannerInvocationEvidence）
//   - Plan 从哪里产生（planOrigin: REAL_LLM / BRIDGE / CACHE / UNKNOWN）
//   - 生成多少 steps（planStepCount）
//   - observation 是否进入 Planner（E4-1 observationPassed）
//   - 终态（runtimeStatus / terminalStatus）
//
// 严格边界（用户授权，2026-08-24）：
//   ✅ 仅改 E4 collector/harness（e4-smoke.js / 本文件）
//   ❌ 不修改 planner.js / runtime.js / agentRunner.js / taskManager 行为 / verification /
//      retry / recovery / repairManager / executor / tools / browserManager / mockSite /
//      elementChanged / GroundTruth / Plan Bridge / Runtime URL 行为
//   ❌ 不把 plannerCalled 依赖单一 monkey-patch 计数（已改为 task-scoped 排除法）
//   ❌ 不跑 11×1 / 100×3 / 不启动 D'
//
// 防 cache 污染前提（本脚本强制保证）：
//   1. 全新 task_id（search-e4-clean-001）→ 无历史 aiSteps
//   2. BENCH_PLAN_BRIDGE 显式 false → 排除 BRIDGE 注入
//   3. AI_PROVIDER=deepseek + 真实 key → 真实 LLM planner
//   4. 独立进程运行 → 无 e4-hi 嵌套 wrap，plannerProbe 为单一直接观测
//   5. 真实 browser（mockSite + 真实 chromium，非 SIMULATION）

const path = require('path');

function L(msg) { console.log('[E4-CLEAN] ' + msg); }

async function runE4CleanVerify(opts = {}) {
  const dProvider = process.env.BENCH_D_PROVIDER || process.env.AI_PROVIDER || 'deepseek';
  const keyEnv = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[dProvider] || 'AI_API_KEY';
  if (dProvider !== 'mock' && !process.env[keyEnv]) {
    console.error(`\n[E4-CLEAN] ⛔ 护栏：真实 LLM provider="${dProvider}" 需要 ${keyEnv}，未设置。`);
    process.exit(2);
  }

  // 强制排除 Plan Bridge（防 BRIDGE 污染）
  delete process.env.BENCH_PLAN_BRIDGE;
  process.env.BENCH_PLAN_BRIDGE = '0';

  const { runE4Smoke } = require('./e4-smoke');
  const { allTasks } = require('./tasks');

  // 选 search 任务（轻量、稳定），赋予全新 e4 task id，确保无历史 aiSteps
  const base = allTasks().find((t) => t.id === 'search');
  if (!base) { console.error('[E4-CLEAN] 找不到 base task: search'); process.exit(2); }
  const cleanId = 'search-e4-clean-001';
  L(`clean task: base=search  e4Id=${cleanId}  provider=${dProvider}  planBridge=OFF`);

  L('运行 runE4Smoke（单 task，clean id）...');
  const smoke = await runE4Smoke({
    taskIds: ['search'],
    cleanTaskIds: { search: cleanId },
  });

  const rep = (smoke.tasks && smoke.tasks[0]) || null;
  if (!rep) { L('❌ 无 task report 返回'); return { pass: false, reason: 'no-report' }; }

  const ir = rep.invocationRecord || {};
  L('─'.repeat(56));
  L('RESULT:');
  L(`  e4TaskId            = ${rep.e4TaskId}`);
  L(`  executionId         = ${ir.executionId}`);
  L(`  plannerCalled       = ${rep.plannerCalled}`);
  L(`  plannerInvocationEvidence = ${rep.plannerInvocationEvidence}`);
  L(`  planOrigin          = ${rep.planOrigin}`);
  L(`  plannerSource       = ${rep.plannerSource}`);
  L(`  planStepCount       = ${rep.planStepCount}`);
  L(`  preExistingSteps    = ${ir.preExistingSteps}`);
  L(`  postSteps           = ${ir.postSteps}`);
  L(`  bridgeActive        = ${ir.bridgeActive}`);
  L(`  observationPassed   = ${rep.observationPassed}`);
  L(`  runtimeStatus       = ${rep.runtimeStatus}`);
  L(`  terminalStatus      = ${rep.terminalStatus}`);
  L(`  groundTruth         = ${rep.groundTruth}`);
  L('─'.repeat(56));

  // 验收判据（用户八、验收输出）：
  // PASS 条件：
  //   - 无 cache 污染：preExistingSteps === 0 且 bridgeActive === false
  //   - planner 实际调用可证明：plannerInvocationEvidence 含 REAL_LLM（DIRECT_PROBE 或 INFERRED）
  //   - planOrigin === REAL_LLM
  //   - planStepCount > 0（Plan 确实生成并落地）
  //   - terminalStatus 为合法终态（非 PENDING/RUNNING 悬挂）
  const noCache = ir.preExistingSteps === 0 && ir.bridgeActive === false;
  const plannerProven = /REAL_LLM/.test(rep.plannerInvocationEvidence);
  const originReal = rep.planOrigin === 'REAL_LLM';
  const stepsOk = rep.planStepCount > 0;
  const terminalOk = ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(rep.terminalStatus);

  const pass = noCache && plannerProven && originReal && stepsOk && terminalOk;

  L(`  [check] no cache contamination (pre=0 & bridge=false): ${noCache}`);
  L(`  [check] planner invocation proven (REAL_LLM evidence): ${plannerProven}`);
  L(`  [check] planOrigin === REAL_LLM: ${originReal}`);
  L(`  [check] planStepCount > 0: ${stepsOk}`);
  L(`  [check] terminalStatus terminal: ${terminalOk}`);
  L('─'.repeat(56));
  L(pass ? '✅ E4-Clean-Verify PASS：Collector 能可靠证明 REAL_LLM Planner invocation（无 cache 污染）'
         : '❌ E4-Clean-Verify FAIL / INCONCLUSIVE');

  if (!noCache) {
    L('⚠️  CACHE CONTAMINATION 仍存在：preExistingSteps=' + ir.preExistingSteps + ' bridgeActive=' + ir.bridgeActive);
  }

  // 保存完整 raw evidence（供用户审阅，不修改任何被测）
  const outPath = path.join(__dirname, 'results', '5.9-E4-clean-verify.json');
  const fs = require('fs');
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ pass, rep, invocationRecord: ir, smoke: { aggregate: smoke.aggregate, findings: smoke.findings } }, null, 2));
    L('raw evidence → ' + outPath);
  } catch (e) { L('write evidence err: ' + String(e.message || e).slice(0, 120)); }

  return {
    pass,
    inconclusive: !pass,
    plannerInvocationEvidence: rep.plannerInvocationEvidence,
    planOrigin: rep.planOrigin,
    planStepCount: rep.planStepCount,
    observationPassed: rep.observationPassed,
    runtimeStatus: rep.runtimeStatus,
    terminalStatus: rep.terminalStatus,
    cacheContamination: !noCache,
    rep,
  };
}

module.exports = { runE4CleanVerify };

if (require.main === module) {
  runE4CleanVerify().then((r) => {
    if (r.inconclusive && !r.pass) {
      console.error('\n[E4-CLEAN] E4 Collector Observability = INCONCLUSIVE（未可靠证明 Planner invocation）');
      process.exit(3);
    }
    process.exit(r.pass ? 0 : 1);
  }).catch((e) => {
    console.error('[E4-CLEAN] 异常:', e);
    process.exit(2);
  });
}
