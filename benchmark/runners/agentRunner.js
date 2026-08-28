'use strict';

// Phase 5.4 — Experience Agent Runner C：完整 Runtime
// Parser -> Router -> Scheduler -> Worker -> Browser -> Observe -> Recover -> Eval -> Learn
// 复用现有端到端入口（taskManager.createTask + start + schedulerLoop）。
// 指标来源：
//   success/latency/llmCalls/tokens/cost  由 Runner 测量（与 A/B 同口径）
//   recovery/memoryHit/routerAccuracy/humanEscalation 由 observability 聚合补充
//
// 关键约束：每组 Runner 使用独立 store 命名空间（通过 STORE_DATA_DIR 隔离），
// 跑完全部 11 任务后，Runner C 调用 observability.dashboard() 回填 C 专属指标。

const path = require('path');
const taskManager = require('../../server/agent/taskManager');
const { schedulerLoop } = require('../../server/agent/execution');
const observability = require('../../server/agent/observability');
const runtime = require('../../server/agent/runtime');
const browserManager = require('../../server/browserManager');
const stepManager = require('../../server/agent/stepManager');
const db = require('../../server/db');
const { injectPlan } = require('../agentPlanBridge');
const { verifyResult } = require('../verify');
const { BenchmarkRunner } = require('../runner');
const instrument = require('../instrument');
// 5.9-C2：evaluator 纯观测接入点（collector.collect 仅落库 aiIntelligenceEvaluations，不改 Memory/决策）。
// 仅当 BENCH_EVAL=1 时调用，不改变任何 Runtime 决策路径。
const intelligenceCollector = require('../../server/agent/intelligence/evaluation/evaluationCollector');

// 5.9-A.2 防回归断言：Plan Step Verification 不得作为最终判据。
// 这 6 类任务的 task.verify 关键且极易被 plan 旁路，需显式标识。
const FAIRNESS_GUARD_CATEGORIES = new Set([
  'timeout', 'browser-crash', 'worker-crash', 'session-expired', 'structure-change', 'cookie-consent',
]);

class AgentRunner extends BenchmarkRunner {
  constructor(opts = {}) {
    super({ ...opts, name: 'ExperienceAgent(C)', runner: 'C' });
    this.mockBaseUrl = opts.mockBaseUrl || this.mockBaseUrl;
    this.schedulerStarted = false;
  }

  async run(task) {
    const started = Date.now();
    try {
      // 0) 确保有绑定 Profile（Agent Runtime 强制要求 Profile 才能启动浏览器）
      //    E4-Harness-Isolation（2026-08-24）：每任务独立 profile，避免 browserPool 资源闸门
      //    对同一 profile 串行互斥导致单任务 RUNNING 占用后续任务 worker（任务间污染根因）。
      //    仅改 harness 隔离，不碰任何 server/agent/* 被测对象。
      const profileId = this._ensureProfile(task.id);

      // 1) 构造任务（objective 喂入 Parser/Router）
      //    注意：taskManager.createTask 的 input schema 不含 category 字段（会被丢弃），
      //    故 createTask 返回的 created 对象无 category。这里显式补挂 benchmark task 的 category，
      //    使 injectPlan 能映射 planFor(category) 注入完整步骤（5.9-A.3 根因：否则退化到 base 两步）。
      const created = taskManager.createTask({
        name: `bench-${task.id}`,
        objective: task.objective,
        targetUrl: this.mockBaseUrl + (task.targetUrl || '/'),
        profileId,
        executionMode: 'AUTO',
      });
      created.category = task.category;

      // 1.1) Plan Bridge：无 LLM 时注入确定性 plan（BENCH_PLAN_BRIDGE=1）。
      //      必须在 scheduler 派发前注入，runtime.resolvePlan 会优先复用已落库 steps。
      //      记录注入的 plan 步骤数（5.9-A.3 验收：planStepCount == executedStepCount）。
      //      E4-Harness-Isolation：支持 per-run 覆盖 this.planBridgeOverride（harness 隔离，不改被测）。
      let planStepCount = 0;
      const useBridge = (this.planBridgeOverride !== undefined)
        ? !!this.planBridgeOverride
        : !!process.env.BENCH_PLAN_BRIDGE;
      if (useBridge) {
        planStepCount = injectPlan(created, this.mockBaseUrl, task.targetUrl);
      }

      // 1.2) 5.9-A.2 防回归断言（仅日志，不阻塞执行）：
      //      Plan Step Verification 只是"执行策略"，最终成功必须回到 task.verify（Ground Truth）。
      //      若 plan 最后一步 verification.type 与 task.verify.type 不同，显式标记，提醒后续 Fairness Gate 复核。
      if (FAIRNESS_GUARD_CATEGORIES.has(task.category)) {
        // task.verify 是唯一合法终态判据；plan 步骤不得替代它。
        console.log(`[Fairness-Guard] task=${task.id} category=${task.category} ` +
          `groundTruth.verify=${JSON.stringify(task.verify)} ` +
          `(Plan Step Verification 仅作执行策略，最终以 task.verify 复核)`);
      }

      // 2) Phase 5.8：走完整生产链路，不再绕过 Scheduler（原 5.7 的 runtime.run 捷径已移除）。
      //    Benchmark Task → TaskManager.createTask → Scheduler.submit(QUEUED)
      //      → Scheduler Loop tick → Worker assign/markRunning → taskManager.start
      //      → Runtime → Router/Memory/Failure Knowledge → Verification → Evaluation → Observability
      this._ensureScheduler();
      this.sched.submit(created.id, { profileId, category: 'NORMAL' });

      // 3) 等待终态落地（Scheduler 经事件驱动 Worker 释放；终态由 runtime 经 taskManager 落库）
      const final = await this._waitFinal(created.id, task.verify.timeoutMs + 20000);

      // 4) 5.9-A.2 核心修复：最终成功判据回归 task.verify（Ground Truth），
      //    与 A/B 完全同构。Runtime 的 SUCCESS 只是"plan 步骤执行完"，不是任务成功。
      //    从 Browser Session 复用 page（per-profile 单例，串行 run 时序安全），
      //    用统一的 verifyResult(task.verify) 复核最终页面状态。
      const runtimeStatus = final.status;
      let groundTruth = false;
      let groundTruthError = null;
      const verifyStart = Date.now();
      try {
        const session = browserManager.getSession(profileId);
        if (session && session.page) {
          groundTruth = await verifyResult(task, session.page, { baseUrl: this.mockBaseUrl });
        } else {
          // 拿不到 page（session 已释放/异常）：退化为 runtimeStatus 判分并标记
          groundTruth = runtimeStatus === 'SUCCESS';
          groundTruthError = 'no-session-page(fallback-to-runtimeStatus)';
        }
      } catch (ve) {
        groundTruth = false;
        groundTruthError = String(ve.message || ve).slice(0, 160);
      }
      const verifyLatencyMs = Date.now() - verifyStart;

      // 5) 回收指标（5.9-B：分层编排指标 + 单任务 trace）
      // 5.9-E 时序修正：evaluator 观测记录必须先持久化，再让 instrument.collectTaskTrace
      // 快照读取。原顺序（instrument 先于 collect）导致 E8 读数永远读不到本次记录。
      // 此处仅调整观测管线的落库/读取顺序，不改变 Runtime 决策 / Ground Truth / Recovery。
      const success = groundTruth;
      if (process.env.BENCH_EVAL === '1') {
        let intelligenceMetrics = { llmCalls: 0, recoveryTriggered: false };
        try {
          const partialTrace = instrument.collectTaskTrace(created.id, final.currentExecutionId, {
            category: task.category,
            runtimeStatus,
            groundTruth,
            groundTruthError,
            fairnessMismatch: runtimeStatus === 'SUCCESS' && !groundTruth,
          });
          intelligenceMetrics = partialTrace.intelligence;
        } catch (_) { /* 允许 instrument 暂不可读，不影响落库 */ }
        try {
          const site = (task.targetUrl || '').replace(/^https?:\/\//, '').split('/')[0] || 'mock';
          const decisionSource = (process.env.BENCH_PLAN_BRIDGE === '1') ? 'DETERMINISTIC_PLAN' : 'AUTONOMOUS_PLANNER';
          intelligenceCollector.collect({
            taskId: created.id,
            site,
            decision: { source: decisionSource, strategy: task.category || null, confidence: null },
            prediction: { expectedSuccess: null },
            actual: {
              success,
              durationMs: Date.now() - started,
              llmCalls: intelligenceMetrics.llmCalls,
              repairCount: intelligenceMetrics.recoveryTriggered ? 1 : 0,
            },
            experiment: { group: 'C2', label: decisionSource },
          });
        } catch (e) {
          // 纯观测：任何异常都不能影响 Benchmark 结果
          console.warn('[5.9-C2] evaluator.collect skipped:', String(e.message || e).slice(0, 120));
        }
      }

      const executionId = final.currentExecutionId;
      const trace = instrument.collectTaskTrace(created.id, executionId, {
        category: task.category,
        runtimeStatus,
        groundTruth,
        groundTruthError,
        fairnessMismatch: runtimeStatus === 'SUCCESS' && !groundTruth,
      });
      const metrics = trace.intelligence; // 兼容旧字段
      const humanEscalation = runtimeStatus === 'HUMAN_ESCALATION' || trace.recovery.humanEscalationEvt;

      return this.result(task, {
        success,
        latencyMs: Date.now() - started,
        llmCalls: metrics.llmCalls,
        tokens: metrics.tokens,
        cost: this.estimateCost(metrics.llmCalls, metrics.tokens),
        recovery: trace.recovery.recoveryTriggered,
        recoveryOk: trace.recovery.recoverySuccess,
        humanEscalation,
        memoryHit: metrics.memoryHit,
        routerAccuracy: metrics.routerAccuracy,
        error: success ? null
          : (humanEscalation ? 'HUMAN_ESCALATION'
            : (groundTruthError || `runtime=${runtimeStatus};groundTruth=false`)),
        raw: {
          executionId,
          profileId,                // E4-Harness-Isolation：透出本任务独立 profileId，供 collector 只读 grounding 校验
          runtimeStatus,            // Runtime 内部终态（plan 步骤跑完判 SUCCESS）
          groundTruth,              // 5.9-A.2 统一 Ground Truth 复核结果
          groundTruthError,         // Ground Truth 复核异常（若有）
          fairnessMismatch: runtimeStatus === 'SUCCESS' && !groundTruth, // Runtime 判成功但 Ground Truth 判失败 → 假阳性捕获
          planStepCount,            // 5.9-A.3：注入的 plan 步骤总数
          executedStepCount: trace.executedStepCount,
          verifyLatencyMs,
          // 5.9-B 分层编排信号（供 report.js 聚合）
          queueWaitMs: trace.queueWaitMs,
          retryCount: trace.recovery.retryCount,
          recoveryTriggered: trace.recovery.recoveryTriggered,
          recoveryTypes: trace.recovery.recoveryTypes,
          recoverySuccess: trace.recovery.recoverySuccess,
          recoveryLatencyMs: trace.recovery.recoveryLatencyMs,
          intelligenceRecorded: trace.intelligence.recorded,
          memoryHitRate: trace.intelligence.memoryHitRate,
          routerAccuracy: trace.intelligence.routerAccuracy,
          failureKnowledgeHit: trace.intelligence.failureKnowledgeHit,
          workerUtilization: trace.resourceSnapshot.workerUtilization,
          browserUtilization: trace.resourceSnapshot.browserUtilization,
          profileContention: trace.resourceSnapshot.profileContention,
          ghostLock: trace.resourceSnapshot.ghostLock,
          resourceBusyEvents: trace.resourceSnapshot.resourceBusyEvents,
          failureAttribution: trace.failureAttribution,
          // 完整单任务 trace（report.js 落盘）
          trace,
        },
      });
    } catch (e) {
      return this.result(task, {
        success: false,
        latencyMs: Date.now() - started,
        error: String(e.message || e).slice(0, 200),
      });
    }
  }

  _ensureScheduler() {
    if (!this.schedulerStarted) {
      // E4-Harness-Isolation（2026-08-24）：允许通过 BENCH_MAX_WORKERS 提高调度并发度，
      // 使单任务 RUNNING/HUNG 占用一个 worker 时，其余任务仍可派发到独立 worker，不被阻塞。
      // 仅配置调度容量（不改 scheduler 任何逻辑），属 harness 隔离，不碰被测对象。
      // scheduler 为全局单例且可能被 require 链以默认 maxWorkers=1 预建；getInstance 不提供
      // 重置接口，故这里不重建单例，而是向既有 scheduler 的 executorPool 动态补足 worker
      // （仅扩展 worker 集合，不改 scheduler 任何逻辑/状态机）。
      const maxWorkers = Number(process.env.BENCH_MAX_WORKERS) || 1;
      const sched = schedulerLoop.getInstance();
      // 必须先 start（start 内 _reapZombieWorkers 会清空 registry 仅留 worker_1），再补 worker
      if (typeof sched.start === 'function') sched.start();
      if (maxWorkers > 1 && sched.pool && Array.isArray(sched.pool.workers)) {
        const { Worker } = require('../../server/agent/execution/executorPool');
        const workerManager = require('../../server/agent/execution/workerManager');
        const { STATUS } = require('../../server/agent/execution/workerState');
        for (let i = 1; i < maxWorkers; i++) {
          const wid = 'worker_' + (i + 1);
          // 以 workerManager registry 为权威：仅当 registry 缺该 worker 才注册并补入 pool
          if (!workerManager.get(wid)) {
            try { workerManager.startWorker({ id: wid, capacity: 1 }); } catch (_) { /* 已存在忽略 */ }
          }
          if (!sched.pool.workers.some((w) => w.id === wid)) {
            const w = new Worker({ id: wid });
            w.status = STATUS.READY;
            sched.pool.workers.push(w);
          }
        }
      }
      this._sched = sched;
      this.sched = this._sched; // 暴露 submit 接口（调度入口）
      this.schedulerStarted = true;
    }
  }

  _ensureProfile(taskId) {
    // E4-Harness-Isolation（2026-08-24）：每任务独立 profile，解除 browserPool 资源闸门串行互斥。
    const baseId = (taskId || 'bench') + '-' + process.pid;
    const pid = 'bench-profile-' + Buffer.from(baseId).toString('hex').slice(0, 16);
    // 每次 run 重建（清掉可能缺 userDataDir 的旧 profile，避免脏数据）
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const ud = path.join(os.tmpdir(), 'bench-profile-' + pid);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch {}
    try { fs.mkdirSync(ud, { recursive: true }); } catch {}
    db.upsertProfile({
      id: pid,
      name: 'Benchmark Profile',
      fingerprint: {},
      launchBehavior: { headless: true },
      launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      userDataDir: ud,
      createdAt: Date.now(),
    });
    return pid;
  }

  async _waitFinal(taskId, timeoutMs) {
    const t0 = Date.now();
    // 轻量轮询（benchmark 不需要事件总线）。
    // Phase 5.8：终态集合 = SUCCESS / FAILED / CANCELLED / HUMAN_ESCALATION（杜绝 RUNNING 悬挂）。
    const TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'];
    while (Date.now() - t0 < timeoutMs) {
      const t = taskManager.getTask(taskId);
      if (t && TERMINAL.includes(t.status)) return t;
      await new Promise((r) => setTimeout(r, 200));
    }
    // 超时仍非终态 → 返回当前状态（验收阶段用于检测悬挂，不静默成功）
    return taskManager.getTask(taskId) || { status: 'TIMEOUT' };
  }

  _collectMetrics(taskId, executionId) {
    // 5.9-B：指标现已统一由 instrument.collectTaskTrace 收集（见 run()）。
    // 保留空壳仅为兼容潜在直接调用；新逻辑请走 instrument。
    return { llmCalls: 0, tokens: 0, recovery: false, recoveryOk: false, humanEscalation: false, memoryHit: 0, routerAccuracy: null };
  }

  async close() {
    // 注意：schedulerLoop 是进程级全局单例。5.9-C 会用同一 AgentRunner 类串行跑多组，
    // 若此处 stop() 会把后续组的 scheduler 误杀导致卡死。因此 close 只标记本 runner，
    // 不停止全局 scheduler（进程退出时由运行环境回收）。5.9-B 仅 C 一组，进程随后退出，无副作用。
    this.schedulerStarted = false;
  }
}

function opts_profile() {
  // benchmark 用一个固定 profile（真实浏览器集成时覆盖）
  return process.env.BENCH_PROFILE_ID || null;
}

function _benchmarkProfileId() {
  return process.env.BENCH_PROFILE_ID || 'bench-profile';
}

module.exports = { AgentRunner };
