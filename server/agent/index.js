'use strict';

// AI Browser Operator — 路由装配（/api/ai/*）。
// Phase 1.1：Task CRUD/状态流转、Lock、Schema 校验、Policy 决策、Secret 注册、
//           SSE 事件流（含 Last-Event-ID 回放）、Execution/Diagnosis 查询。

const express = require('express');
const fs = require('fs');
const path = require('path');
const taskManager = require('./taskManager');
const events = require('./events');
const { validateAction, ACTION_TYPES, RISK_LEVELS } = require('./schema/action');
const policy = require('./policy');
const secretManager = require('./secretManager');
const recorder = require('./recorder');
const queue = require('./queue');
const sites = require('./sites');
const context = require('./context');
const sessionManager = require('./sessionManager');
const parser = require('./parser');
const planner = require('./planner');
const flowPlanner = require('./intelligence/flowPlanner');
const evidence = require('./evidence');
const store = require('./store');
const identity = require('../identity'); // STEP 22 (I1)：/secrets 走唯一 RBAC 检查入口
const { createProvider } = require('./llm/provider');

// 加载 runtime 以注册 executor 钩子（start/resume 后自动触发 Agent 循环）
require('./runtime');

// 启动恢复：扫描被中断的 RUNNING/HEALING/RECOVERING 任务 → RECOVERING → relaunch → checkpoint → 继续
setImmediate(() => {
  try {
    require('./recovery/recoveryManager').recoverInterruptedTasks();
  } catch (e) {
    console.warn('[recovery] 启动恢复执行异常(已忽略):', String(e.message || e).slice(0, 150));
  }
});

// CAP-M1：定时触发循环（1s tick，unref，惰性启动；只扫描到期的 ACTIVE schedule 并创建任务，
// 执行链决策与 /execution/submit 一致，绝不改任务业务状态）
setImmediate(() => {
  try {
    require('./scheduleTrigger').startTriggerLoop();
  } catch (e) {
    console.warn('[scheduleTrigger] 循环启动异常(已忽略):', String(e.message || e).slice(0, 150));
  }
});

const router = express.Router();

// ---------------- Task ----------------
router.post('/tasks', (req, res) => {
  try {
    // CAP-K2：创建前咨询 Intelligence Router（fail-open，只建议不执行）。
    // 此前 POST /tasks 零 Router 咨询：调用方漏传 profileId 时 start() 直接失败，
    // 且 Router 的失败经验 warnings 在该路径从未进入执行链。
    const { input, intelligence } = require('./intelligence/router/taskInputEnhancer').enhanceTaskInput(req.body || {});
    // CAP-O1 §10：Task 归属盖章 —— workspaceId/createdBy 由身份层提供，不接受调用方伪造
    if (req.identityUser) {
      input.workspaceId = req.identityUser.currentWorkspaceId || input.workspaceId;
      input.createdBy = req.identityUser.id;
    }
    const t = taskManager.createTask(input);
    res.json(Object.assign({}, t, intelligence ? { intelligence } : {}));
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.get('/tasks', (req, res) => {
  res.json(taskManager.listTasks());
});

router.get('/tasks/:id', (req, res) => {
  const t = taskManager.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

router.post('/tasks/:id/start', (req, res) => {
  try {
    const r = taskManager.start(req.params.id);
    res.json({ ok: true, task: r.task, executionId: r.execution.id });
  } catch (e) {
    res.status(409).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.post('/tasks/:id/cancel', (req, res) => {
  try {
    res.json(taskManager.cancel(req.params.id));
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.post('/tasks/:id/resume', (req, res) => {
  try {
    res.json(taskManager.resume(req.params.id));
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.post('/tasks/:id/pause', (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || 'manual pause';
    const t = taskManager.pauseForHuman(req.params.id, reason, { manual: true });
    res.json({ ok: true, task: t });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.post('/tasks/:id/retry', (req, res) => {
  try {
    const r = taskManager.retry(req.params.id);
    res.json({ ok: true, task: r.task, executionId: r.execution.id });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.delete('/tasks/:id', (req, res) => {
  try {
    res.json(taskManager.deleteTask(req.params.id));
  } catch (e) {
    res.status(409).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

// ---------------- Execution / Diagnosis ----------------
router.get('/tasks/:id/execution', (req, res) => {
  const t = taskManager.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (!t.currentExecutionId) return res.json(null);
  res.json(recorder.get(t.currentExecutionId));
});

router.get('/tasks/:id/diagnosis', (req, res) => {
  const t = taskManager.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  // Phase 2.2：返回最后的结构化诊断（含 FailureSnapshot 引用）
  const snapshots = (() => { try { return require('./recovery/failureSnapshot').listForTask(t.id); } catch (e) { return []; } })();
  res.json({
    taskId: t.id,
    available: !!t.lastDiagnosis,
    diagnosis: t.lastDiagnosis || null,
    failureSnapshots: snapshots.slice(-5).map((s) => ({ id: s.id, stepId: s.stepId, errorType: s.errorType, url: s.url, screenshotRef: s.screenshotRef, timestamp: s.timestamp })),
  });
});

// Action Replay：完整动作执行链（debug / 训练 / 自愈追溯）
router.get('/tasks/:id/replay', (req, res) => {
  const t = taskManager.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(require('./recovery/replay').buildTaskReplay(t));
});

// Repair Attempts：修复生命周期 + 策略成功率统计
router.get('/tasks/:id/repairs', (req, res) => {
  const t = taskManager.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const ra = require('./repair/repairAttempts');
  res.json({ repairs: ra.listForTask(t.id), stats: ra.statsByStrategy() });
});

// ---------------- Experience Intelligence（Phase 3.1 + 3.2）----------------
router.get('/intelligence/sites', (req, res) => {
  res.json(require('./intelligence/siteMemory').listSites());
});
router.get('/intelligence/sites/:site', (req, res) => {
  const sm = require('./intelligence/siteMemory');
  const em = require('./intelligence/elementMemory');
  const fm = require('./intelligence/flowMemory');
  const fk = require('./intelligence/failure/failureKnowledge');
  const site = sm.getSite(req.params.site);
  res.json({
    site: site || { site: req.params.site, history: { successTasks: 0, failedTasks: 0 }, commonFlows: {}, frequentFailures: [], failureProfile: { commonFailures: [] }, riskLevel: 'unknown' },
    elements: em.listForSite(req.params.site).map((r) => ({ id: r.id, purpose: r.purpose, elementType: r.elementType, patterns: r.patterns, confidence: r.confidence, successRate: r.successRate, samples: r.samples, stats: r.stats, status: r.status, version: r.version })),
    flows: fm.listForSite(req.params.site).map((f) => ({ id: f.id, goal: f.goal, confidence: f.confidence, successRate: f.successRate, samples: f.samples, stats: f.stats, status: f.status, version: f.version, states: f.states })),
    failures: fk.getForSite(req.params.site).map((r) => ({ id: r.id, category: r.category, condition: r.condition, evidence: r.evidence, solution: r.solution, confidence: r.confidence, successRate: r.successRate, samples: r.samples, status: r.status, version: r.version })),
  });
});
router.get('/intelligence/flows', (req, res) => {
  const fm = require('./intelligence/flowMemory');
  const site = req.query.site;
  const list = site ? fm.listForSite(site) : store.read(fm.COLLECTION, []);
  res.json(list.map((f) => ({ id: f.id, site: f.site, goal: f.goal, confidence: f.confidence, successRate: f.successRate, samples: f.samples, stats: f.stats, status: f.status, version: f.version, states: f.states })));
});
router.get('/intelligence/flows/:site', (req, res) => {
  res.json(require('./intelligence/flowMemory').listForSite(req.params.site));
});
// 失败经验（Phase 3.3）
router.get('/intelligence/failures', (req, res) => {
  const fk = require('./intelligence/failure/failureKnowledge');
  const site = req.query.site;
  const list = site ? fk.getForSite(site) : fk.listAll();
  res.json(list.map((r) => ({ id: r.id, site: r.site, category: r.category, condition: r.condition, evidence: r.evidence, solution: r.solution, confidence: r.confidence, successRate: r.successRate, samples: r.samples, status: r.status, version: r.version })));
});
router.get('/intelligence/failures/:site', (req, res) => {
  res.json(require('./intelligence/failure/failureKnowledge').getForSite(req.params.site));
});
// 环境评分（Phase 3.4 Profile Intelligence）
router.get('/intelligence/profiles', (req, res) => {
  res.json(require('./intelligence/profile/profileAnalyzer').listRecords());
});
router.get('/intelligence/profiles/:id', (req, res) => {
  const rec = require('./intelligence/profile/profileAnalyzer').getRecord(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  res.json(rec);
});
router.post('/intelligence/profiles/:id/record', (req, res) => {
  const { site, ok, name, region } = req.body || {};
  if (!site) return res.status(400).json({ ok: false, error: 'site 必填' });
  try {
    const r = require('./intelligence/profile/profileAnalyzer').recordTaskOutcome(req.params.id, site, !!ok, { name, region });
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
});
router.post('/intelligence/profile-recommend', (req, res) => {
  const { site, url, task, region, profileId } = req.body || {};
  const r = require('./intelligence/profile/profileAdvisor').recommend({ site, url, task, region, profileIdHint: profileId });
  res.json(r);
});
router.get('/intelligence/site-profile-matrix', (req, res) => {
  const sites = req.query.sites ? String(req.query.sites).split(',') : null;
  res.json(require('./intelligence/profile/profileAnalyzer').siteProfileMatrix(sites));
});
// Intelligence Router：统一决策入口（Phase 3.5）。只读、仅建议，不执行。
router.post('/intelligence/decision', (req, res) => {
  const { objective, targetUrl, region, constraints, profileId } = req.body || {};
  if (!objective && !targetUrl) return res.status(400).json({ ok: false, error: 'objective 或 targetUrl 必填' });
  try {
    const d = require('./intelligence/router').decide({ objective, targetUrl, region, constraints, profileId });
    res.json({ ok: true, decision: d });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
// 经验包导出（Element + Site + Flow，站点经验整体迁移）
router.post('/intelligence/export', (req, res) => {
  const { site, name } = req.body || {};
  if (!site) return res.status(400).json({ ok: false, error: 'site 必填' });
  const fm = require('./intelligence/flowMemory');
  res.json(fm.exportPack(site, { name }));
});
// 经验包导入
router.post('/intelligence/import', (req, res) => {
  const { pack } = req.body || {};
  if (!pack) return res.status(400).json({ ok: false, error: 'pack 必填' });
  const fm = require('./intelligence/flowMemory');
  try { res.json(fm.importPack(pack)); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
});
// Intelligence Evaluation Layer：健康看板（Phase 3.6）。
// 经验自我评估：Router 准确率 / LLM 节省 / Memory ROI / 弱项。只读，不改 Memory。
router.get('/intelligence/evaluation/report', (req, res) => {
  try {
    const rep = require('./intelligence/evaluation').evaluator.report(
      req.query.site ? { site: req.query.site } : {},
    );
    res.json({ ok: true, report: rep });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});

// Execution Layer（Phase 4.1）：Queue + Worker 编排。只读/提交，执行仍委托 taskManager/runtime。
const execution = require('./execution');
router.get('/execution/queue', (req, res) => {
  res.json({ queue: execution.queueManager.baseQueue.list(), dispatches: execution.queueManager.listExecutions() });
});
router.get('/execution/workers', (req, res) => {
  // Phase 4.2：返回真实 Worker 实体列表（aiWorkers），含状态/心跳/当前执行。
  res.json({ workers: execution.workerManager.list() });
});
router.post('/execution/workers/start', (req, res) => {
  // 启动一个 Worker 实体（经 WorkerManager，不直接操作 aiWorkers）。
  try {
    const w = execution.workerManager.startWorker(req.body || {});
    res.json({ ok: true, worker: w });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/workers/:id/stop', (req, res) => {
  // 优雅停止 Worker（DRAINING → STOPPED）。
  try {
    const r = execution.workerManager.stopWorker(req.params.id);
    res.json(Object.assign({ ok: r.ok }, r));
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/recovery', (req, res) => {
  // 触发崩溃恢复扫描（DEAD worker 的 RUNNING execution → RECOVERING）。
  try {
    const pool = new execution.executorPool.ExecutorPool({ maxWorkers: 1 });
    const r = pool.recovery(Date.now(), (req.body && req.body.timeoutMs) || 30000);
    res.json({ ok: true, recovered: r.recovered, dead: r.dead });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/submit', (req, res) => {
  const { taskId, category, profileId, priorityOverride } = req.body || {};
  if (!taskId) return res.status(400).json({ ok: false, error: 'taskId 必填' });
  try {
    // 无效入口修复（Phase 1 收口）：/execution/submit 过去仅建 QUEUED 派遣记录，
    // 若 Scheduler 未手动启动则任务永不执行（卡死 QUEUED）。现统一为：
    //  - Scheduler 运行中 → 入队，由调度循环派遣（可选编排层）；
    //  - Scheduler 未运行 → 经【唯一执行链】taskManager.start 直接启动（绝不卡死）。
    const sched = schedulerLoop.getInstance();
    const schedRunning = sched && typeof sched.getStatus === 'function' && sched.getStatus().status === 'RUNNING';
    if (schedRunning) {
      const item = execution.queueManager.submit(taskId, { category, profileId, priorityOverride });
      res.json({ ok: true, mode: 'scheduled', queued: item });
    } else {
      const r = taskManager.start(taskId); // 唯一执行链：enqueue + runtime.run
      res.json({ ok: true, mode: 'direct', started: r });
    }
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
});

// 手动恢复（进程重启后 / 崩溃后调用）
router.post('/tasks/:id/recover', (req, res) => {
  try { res.json(taskManager.recover(req.params.id)); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
});

// Execution Layer（Phase 4.3）：Scheduler Loop 控制面。
const schedulerLoop = require('./execution/schedulerLoop');
router.post('/execution/scheduler/start', (req, res) => {
  try { res.json(schedulerLoop.getInstance({ maxWorkers: (req.body && req.body.maxWorkers) || 1 }).start()); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/scheduler/stop', (req, res) => {
  try { res.json(schedulerLoop.getInstance().stop()); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/scheduler/pause', (req, res) => {
  try { res.json(schedulerLoop.getInstance().pause()); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/scheduler/resume', (req, res) => {
  try { res.json(schedulerLoop.getInstance().resume()); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/scheduler/drain', (req, res) => {
  try { res.json(schedulerLoop.getInstance().drain()); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/scheduler/tick', (req, res) => {
  try { res.json(schedulerLoop.getInstance().tickOnce()); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.get('/execution/scheduler/status', (req, res) => {
  try { res.json(schedulerLoop.getInstance().getStatus()); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});

// Execution Layer（Phase 4.4）：Browser Resource Pool 控制面。
const browserPool = require('./execution/browser').browserResourcePool;
const resourceRecovery = require('./execution/browser').resourceRecovery;
router.get('/execution/resources', (req, res) => {
  try { res.json({ resources: browserPool.listResources(), bindings: browserPool.listBindings() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/resources/acquire', (req, res) => {
  const { profileId, taskId, workerId } = req.body || {};
  if (!profileId) return res.status(400).json({ ok: false, error: 'profileId 必填' });
  try { res.json(browserPool.acquireResource(profileId, { taskId, workerId })); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/resources/release', (req, res) => {
  const { profileId, taskId } = req.body || {};
  if (!profileId) return res.status(400).json({ ok: false, error: 'profileId 必填' });
  try { res.json(browserPool.releaseResource(profileId, { taskId })); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.post('/execution/resources/recover', (req, res) => {
  try {
    const taskManager = require('./taskManager');
    const r = resourceRecovery.recover({
      now: Date.now(),
      heartbeatTimeoutMs: (req.body && req.body.heartbeatTimeoutMs) || 30000,
      taskExists: (id) => !!taskManager.getTask(id),
      taskIsTerminal: (id) => { const t = taskManager.getTask(id); return t && ['DONE', 'FAILED', 'CANCELLED', 'COMPLETED'].indexOf(t.status) >= 0; },
    });
    res.json({ ok: true, actions: r.actions, summary: r.summary });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});

// Observability（Phase 4.6）：运营数据层。所有指标从既有持久化集合聚合。
const observability = require('./observability');
router.get('/observability/metrics', (req, res) => {
  try { res.json({ ok: true, dashboard: observability.dashboard() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.get('/observability/trace/:taskId', (req, res) => {
  try {
    const t = observability.trace(req.params.taskId);
    if (!t) return res.status(404).json({ ok: false, error: 'task 不存在' });
    res.json({ ok: true, trace: t });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
router.get('/observability/dashboard', (req, res) => {
  try { res.json({ ok: true, dashboard: observability.dashboard() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});

// ---------------- Chat / Session（Phase 1.4）----------------
router.post('/chat', async (req, res) => {
  try {
    const { message, sessionId, profileId, executionMode } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ ok: false, error: 'message 必填' });

    // C16：LLM key 缺失守卫。AI_PROVIDER=auto（缺省）且无任何 key 时，provider 会静默
    // 解析为 mock 并返回"假计划"——用户无感知地拿到不可执行的结果。现在 fail-fast
    // 返回可行动文案；显式设置 AI_PROVIDER=mock 的开发/测试路径不受影响。
    const providerKind = String(process.env.AI_PROVIDER || 'auto').toLowerCase();
    if (providerKind === 'auto' && !process.env.OPENAI_API_KEY && !process.env.AI_API_KEY && !process.env.DEEPSEEK_API_KEY) {
      return res.status(409).json({
        ok: false,
        code: 'NO_LLM_KEY',
        error: '未配置 LLM API key（当前为 mock 模式）——请到「系统设置」粘贴 DeepSeek API key，保存即时生效',
      });
    }

    // 1) Session（复用或新建）
    let session = sessionId ? sessionManager.getSession(sessionId) : null;
    if (!session) session = sessionManager.createSession({ userMessage: message, context: { profileId: profileId || '' } });
    else sessionManager.addMessage(session.id, 'user', message);

    // 2) Parser → 结构化任务输入
    const prov = createProvider(process.env.AI_PROVIDER || 'auto');
    const parsed = await parser.parse(String(message), prov, {});

    // 2.5) Intelligence Router（Phase 3.5）：唯一智能入口。
    //      经验优先（Profile→Site→Flow→Failure→Element），LLM 最后补充。
    //      仅「决策 + 解释」，绝不执行；结果仍经 Policy → Runtime（沿用既有 approval 流程）。
    let recommendedProfileId = profileId || null;
    let routerDecision = null;
    try {
      const site = parsed.target ? siteOfUrl(parsed.target) : null;
      routerDecision = require('./intelligence/router').decide({
        objective: parsed.objective || message,
        targetUrl: parsed.target || '',
        region: parsed.region,
        constraints: parsed.constraints || [],
        profileId: profileId || null,
      });
      if (routerDecision && routerDecision.decision && routerDecision.decision.profile) {
        recommendedProfileId = routerDecision.decision.profile.id;
      }
    } catch (e) { /* Router 失败不阻断，沿用既有逻辑 */ }

    // 3) 创建 Task（不执行，等待人工确认 Plan）
    // CAP-K2：Router 决策摘要（含失败经验 warnings）随任务落库，经 contextBuilder 进 Planner 上下文
    const { toIntelligence } = require('./intelligence/router/taskInputEnhancer');
    const intelligence = toIntelligence(routerDecision);
    const task = taskManager.createTask({
      name: (parsed.objective || '任务').slice(0, 20),
      objective: parsed.objective || message,
      targetUrl: parsed.target || '',
      profileId: recommendedProfileId,
      executionMode: ['SIMULATION', 'ASSIST', 'AUTONOMOUS', 'DEBUG'].includes(executionMode) ? executionMode : 'ASSIST',
      secretRefs: parsed.credentialRefs || [],
      constraints: parsed.constraints || [],
      routerHints: intelligence || undefined,
    });

    // 4) Planner → Plan（先查 Flow Memory，高置信度直接加载历史流程，跳过 LLM；不自动执行）
    const pr = await flowPlanner.planWithMemory({ ...parsed, executionMode: task.executionMode, provider: prov, ctx: { taskId: task.id } });
    if (!pr.ok) {
      try { taskManager.deleteTask(task.id); } catch (e) {}
      return res.status(400).json({ ok: false, error: pr.error || '计划生成失败' });
    }
    if (pr.fromFlow) {
      pr.plan.fromFlow = true;
      // CAP-K1：/chat 起源的 flow 重放也记录 flowId，失败/升级同样吃置信度反馈
      try { taskManager.markFlowUsed(task.id, pr.flowId, pr.confidence); } catch (e) {}
    }
    taskManager.attachPlan(task.id, pr.plan);
    sessionManager.attachTask(session.id, task.id);
    sessionManager.addMessage(session.id, 'ai', pr.fromFlow
      ? `已复用历史流程经验（置信度 ${(pr.confidence || 0).toFixed(2)}，跳过 LLM 规划），等待人工确认后执行。`
      : '已生成计划，等待人工确认后执行。');

    // Phase 3.5：在会话消息中提示 AI Decision（仅建议，可在确认前手动更改）
    if (routerDecision && routerDecision.decision && !profileId) {
      const d = routerDecision.decision;
      const es = d.strategy && d.strategy.expectedSuccess != null ? Math.round(d.strategy.expectedSuccess * 100) : null;
      const parts = [
        d.profile ? `推荐环境 ${d.profile.id}（评分 ${d.profile.score}）` : '默认环境',
        d.flow ? '已学习流程经验' : '需重新规划',
        es != null ? `预计成功率 ${es}%` : '',
        d.strategy && d.strategy.requireLLM ? '（经验不足，调用 LLM）' : '（经验驱动）',
      ].filter(Boolean);
      sessionManager.addMessage(session.id, 'ai', `AI Decision：${parts.join(' · ')}。`);
    }

    res.json({
      ok: true, sessionId: session.id, taskId: task.id, fromFlow: !!pr.fromFlow, confidence: pr.confidence,
      profileId: task.profileId,
      aiDecision: routerDecision ? {
        summary: routerDecision.explanation && routerDecision.explanation.summary,
        profile: routerDecision.decision && routerDecision.decision.profile,
        flow: routerDecision.decision && routerDecision.decision.flow,
        strategy: routerDecision.decision && routerDecision.decision.strategy,
        reasons: routerDecision.reasons || [],
        warnings: routerDecision.warnings || [],
        fromCache: !!routerDecision.fromCache,
      } : null,
      status: taskManager.getTask(task.id).status,
      plan: { goal: pr.plan.goal, fromFlow: !!pr.fromFlow, steps: pr.plan.steps.map((s) => ({ id: s.id, type: s.type, description: s.description, expectedOutcome: s.expectedOutcome, risk: s.risk })) },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.get('/sessions', (req, res) => res.json(sessionManager.listSessions()));

// ---------------- LLM Cost Dashboard（Phase 1.4）----------------
// 价格估算（USD / 1M tokens），仅统计用；成本字段默认 0 由 recorder 记录
const MODEL_PRICES = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'deepseek-chat': { in: 0.14, out: 0.28 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
};
function estimateCost(model, promptTokens, completionTokens) {
  const p = MODEL_PRICES[model] || { in: 0.5, out: 1.5 };
  return ((promptTokens || 0) / 1e6) * p.in + ((completionTokens || 0) / 1e6) * p.out;
}

router.get('/llm/stats', (req, res) => {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  let calls = 0, tokens = 0, cost = 0, tasks = 0, totalCalls = 0;
  const exes = store.read('aiExecutions', []);
  for (const exe of exes) {
    const llms = (exe.llmCalls || []).filter((c) => c.timestamp >= dayStart.getTime());
    if (!llms.length) continue;
    tasks += 1;
    for (const c of llms) {
      totalCalls += 1;
      calls += 1;
      tokens += c.tokens || 0;
      cost += estimateCost(c.model, c.promptTokens || 0, c.completionTokens || 0);
    }
  }
  res.json({
    today: { calls, tokens, cost: Math.round(cost * 10000) / 10000 },
    tasks,
    avgCost: tasks ? Math.round((cost / tasks) * 10000) / 10000 : 0,
    provider: (() => { try { return createProvider(process.env.AI_PROVIDER || 'auto').name; } catch (e) { return 'mock'; } })(),
  });
});

// ---------------- Snapshot（Phase 1.4）----------------
router.get('/tasks/:id/snapshots', (req, res) => {
  try {
    res.json(evidence.listForTask(req.params.id));
  } catch (e) {
    // 路径校验失败（UNSAFE_PATH_SEGMENT / PATH_ESCAPE）→ 400，不当成 500
    res.status(e.statusCode || 400).json({ error: 'invalid task id', detail: String(e.message || e).slice(0, 160) });
  }
});

router.get('/snapshots/:taskId/:file', (req, res) => {
  let f;
  try {
    f = evidence.filePath(req.params.taskId, req.params.file);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: 'invalid path', detail: String(e.message || e).slice(0, 160) });
  }
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(404).json({ error: 'snapshot not found' });
});

// ---------------- Approval（Phase 1.4）----------------
router.post('/tasks/:id/approve', (req, res) => {
  try { res.json(taskManager.approve(req.params.id)); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
});
router.post('/tasks/:id/reject', (req, res) => {
  try { res.json(taskManager.reject(req.params.id)); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
});
router.post('/tasks/:id/modify', (req, res) => {
  try { res.json(taskManager.modify(req.params.id, req.body || {})); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
});

// ---------------- SSE 事件流 ----------------
function handleSse(req, res, filters) {
  const lastEventId = req.headers['last-event-id'];
  events.subscribe(res, filters);
  if (lastEventId) {
    const replay = events.replaySince(String(lastEventId), filters);
    for (const evt of replay) {
      try { res.write(`id: ${evt.eventId}\ndata: ${JSON.stringify(evt)}\n\n`); } catch (e) { break; }
    }
  }
}

// 从 URL 提取 site（hostname）
function siteOfUrl(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch (e) { return null; }
}

router.get('/events', (req, res) => {
  handleSse(req, res, {});
});

router.get('/tasks/:id/events', (req, res) => {
  handleSse(req, res, { taskId: req.params.id });
});

router.get('/tasks/:id/recent-events', (req, res) => {
  res.json(events.recent(req.params.id, Number(req.query.limit) || 200));
});

// ---------------- Schema / Policy 校验（供测试与前端调用）----------------
router.post('/schema/validate', (req, res) => {
  const r = validateAction(req.body || {});
  res.json(r);
});

router.post('/policy/decide', (req, res) => {
  const r = validateAction(req.body && req.body.action);
  if (!r.ok) return res.status(400).json({ ok: false, errors: r.errors });
  const decision = policy.allowsAction(r.action, req.body && req.body.task);
  res.json({ ok: true, action: r.action, effectiveRisk: policy.effectiveRisk(r.action), decision });
});

// ---------------- Secret（引用注册，脱敏视图）----------------
// STEP 22 (I1)：identity/workspace 安全接线。
//   - 挂载点（server/index.js /api/ai）已有 identityResolver+requireAuth → 未认证 401；
//   - 写操作要求 credential:manage（OWNER/ADMIN，复用既有 RBAC，不新增权限体系）；
//   - 归属盖章在服务端：workspaceId/createdBy 一律取自 req.identityUser，
//     调用方 body 伪造的 workspaceId 被直接忽略；
//   - 列表只返回本工作区（+ legacy 对 local 用户）可见的凭据，跨工作区不可见；
//   - 明文永不经过本路由（明文只进 vault，见 /api/vault/:id）。
router.post('/secrets', (req, res) => {
  try {
    const u = req.identityUser;
    identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'credential:manage');
    const { profileId, type, site, label } = req.body || {};
    if (!profileId) return res.status(400).json({ ok: false, error: 'profileId 必填' });
    // 请求体中的 workspaceId/createdBy 即便传入也被忽略（服务端盖章，防伪造）
    const rec = secretManager.createSecret({
      profileId, type, site, label,
      workspaceId: u.currentWorkspaceId, createdBy: u.id,
    });
    try {
      require('../audit').log({ workspaceId: u.currentWorkspaceId, actorId: u.id, actorName: u.username, actorType: 'user', action: 'secret.create', resourceType: 'credential', resourceId: rec.id, detail: { type: rec.type, site: rec.site, profileId: rec.profileId } });
    } catch (e) { /* 审计失败不影响主流程 */ }
    res.json(secretManager.maskedView(rec));
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.get('/secrets', (req, res) => {
  try {
    const u = req.identityUser;
    if (!u) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    res.json(identity.filterByWorkspace(secretManager.listRecords(), u).map((r) => secretManager.maskedView(r)));
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.delete('/secrets/:id', (req, res) => {
  try {
    const u = req.identityUser;
    const rec = secretManager.getByRef(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: 'credential not found' });
    identity.assertCanAccessResource(u, rec, 'credential:manage');
    secretManager.remove(rec.id);
    try {
      require('../audit').log({ workspaceId: rec.workspaceId || (u && u.currentWorkspaceId) || null, actorId: u.id, actorName: u.username, actorType: 'user', action: 'secret.delete', resourceType: 'credential', resourceId: rec.id, detail: {} });
    } catch (e) { /* 审计失败不影响主流程 */ }
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

// ---------------- 队列 / 站点 / 健康 ----------------
router.get('/queue', (req, res) => res.json(queue.list()));

router.get('/sites', (req, res) => res.json(sites.list()));

// ---------------- CAP-M1：定时触发 / 批量执行 ----------------
// /api/ai/schedules*（子路由自带身份守卫：task:create / task:read）
router.use('/schedules', require('./scheduleTrigger').router);

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: '0.1.0',
    phase: '4.6',
    provider: (() => { try { return require('./llm/provider').createProvider(process.env.AI_PROVIDER || 'auto').name; } catch (e) { return 'mock'; } })(),
    actionTypes: ACTION_TYPES.length,
    riskLevels: RISK_LEVELS,
    secrets: secretManager.listMasked().length,
    queue: queue.list().length,
  });
});

module.exports = router;
