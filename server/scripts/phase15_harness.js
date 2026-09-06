'use strict';

// Phase 15 — Real-Site Generic Task Execution Harness
//
// 与 Phase 14 recon harness 的本质区别：本 harness 走【完整 runtime 链路】
// （taskManager.createTask → start → planner.planObjective（真实 LLM）→ runtime 主循环
//   → tools/policy/verification/checkpoint/recovery → 终态），验证的是 Agent 本身，
// 真实网站只是 execution target。
//
// 硬性边界（Phase 14/15 规格）：
//   - 无任何站点专用 selector / 业务逻辑 / retry policy；URL 全部参数化
//   - challenge / 403 → HUMAN_ESCALATION（harness 级细分 BLOCKED_EXTERNAL / HUMAN_REQUIRED
//     仅记 evidence）—— 绝不换 IP/指纹重试、绝不绕过
//   - credentialsRequired 且凭据未就绪 → STOP（不创建任务，evidence 记 SKIPPED_CREDENTIALS_PENDING）
//   - R09 使用专用无效测试凭据（invalidCredentials，非真实账号）
//   - evidence 禁存：password/CVV/卡号/token/session/cookie value（cookie 仅 presence/count/names）
//
// 用法：
//   编排模式：node server/scripts/phase15_harness.js --tasks R01,R02,R03,R04 [--base-url URL] [--label phase15]
//   worker 模式：node server/scripts/phase15_harness.js --worker --tasks R01,R02 ...
//     R10 两段式：--worker --tasks R10 --kill-after-ms 6000（pass1，模拟崩溃）
//                 --worker --resume-task <taskId>（pass2，recover 恢复）
//   evidence：.benchmark/<label>/<runTag>/R0x.json + FPB_EVENTS_DIR 按任务 events JSONL

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 轻量 .env 加载（项目无 dotenv 依赖）：仅填充 process.env 中尚不存在的键，不覆盖已有环境变量。
(function loadDotEnv() {
  try {
    const envPath = path.resolve(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { /* .env 缺失不致命：AI_PROVIDER=auto 时会走 mock provider */ }
})();

const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}
function hasFlag(name) { return args.includes(name); }

const IS_WORKER = hasFlag('--worker');
const LABEL = argOf('--label', 'phase15');
const SERVER_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');
const OUT = path.join(PROJECT_ROOT, '.benchmark', LABEL);
const TASKS_JSON = path.join(SERVER_ROOT, 'scenarios', 'real-site', 'phase15_tasks.json');
const TERMINAL_STATES = ['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'];

// 终态后收集段的超时保护：任何证据采集调用挂起（浏览器/页面异常态）不得阻塞 worker 退出。
function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => { console.log('[phase15-worker] TIMEOUT ' + label); resolve(null); }, ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function loadTasks() {
  const cfg = JSON.parse(fs.readFileSync(TASKS_JSON, 'utf8'));
  return cfg;
}

// ── worker：进程内完整 runtime 执行 ──
async function workerMain() {
  const cfg = loadTasks();
  const baseUrl = argOf('--base-url', process.env.FPB_REALSITE_BASE_URL || cfg.defaultBaseUrl);
  const taskIds = argOf('--tasks', '').split(',').map((s) => s.trim()).filter(Boolean);
  const resumeTaskId = argOf('--resume-task', null);
  const killAfterMs = parseInt(argOf('--kill-after-ms', '0'), 10) || 0;
  const runTag = process.env.FPB15_RUN_TAG || new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(OUT, runTag);
  fs.mkdirSync(runDir, { recursive: true });
  if (process.env.FPB_EVENTS_DIR) fs.mkdirSync(process.env.FPB_EVENTS_DIR, { recursive: true });

  const taskManager = require('../agent/taskManager');
  const stepManager = require('../agent/stepManager');
  const store = require('../agent/store');
  const runtime = require('../agent/runtime');
  const browserManager = require('../browserManager');
  const observation = require('../agent/observation');
  const checkpointMod = require('../agent/checkpoint');
  const secretManager = require('../agent/secretManager');
  const vault = require('../vault');
  const contract = require('../agent/realSiteContract');
  const { captureEnvironmentSnapshot } = require('../fp/environmentSnapshot');
  const { checkEnvironmentIntegrity } = require('../fp/environmentIntegrity');
  const { detectChallenge } = require('../fp/challengeDetector');

  const profile = {
    id: 'phase15_recon',
    headless: true,
    browser: 'Chrome',
    os: 'Windows',
    startupUrls: [],
    lastSessionUrls: [],
    launchBehavior: {},
  };

  const session = await browserManager.launch(profile, []);
  const page = await browserManager.getPage(profile.id);
  const fp = session.fp || null;
  const proxy = session.proxy || null;
  const host = new URL(baseUrl).host;
  const results = [];
  let lastChallenge = null; // 上一任务观测到的 challenge（执行前门）

  function collectTaskEvidence(def, task, extra = {}) {
    // 性能纪律：aiAttempts.json 实测 40MB / aiSteps.json 12MB —— 对每条 attempt 做
    // store.find(aiSteps) 线性扫描是 O(n×m)（上亿次比较，同步阻塞事件循环数小时）。
    // 必须一次读入建 Map 索引后 O(n) 归并。
    const allSteps = store.read('aiSteps', []);
    const stepTaskMap = new Map(allSteps.map((s) => [s.id, s.taskId]));
    const mySteps = allSteps.filter((s) => s.taskId === task.id);
    const attempts = store.read('aiAttempts', []).filter((a) => stepTaskMap.get(a.stepId) === task.id);
    const checkpoints = checkpointMod.listForTask(task.id);
    const credRec = task.secretRefs && task.secretRefs.length ? secretManager.getByRef(task.secretRefs[0]) : null;
    return {
      taskId: def.taskId,
      name: def.name,
      executionId: task.currentExecutionId,
      startTime: task.startedAt,
      endTime: task.finishedAt,
      durationMs: (task.finishedAt || Date.now()) - (task.startedAt || Date.now()),
      objective: def.objective,
      initialUrl: task.targetUrl,
      finalUrl: extra.finalUrl || null,
      taskReadiness: extra.readiness || null,
      environmentSnapshot: extra.snapshot || null,
      environmentIntegrity: extra.integrity || null,
      steps: mySteps.map((s) => ({
        id: s.id, description: s.description, status: s.status,
        actionType: s.action && s.action.type, matchedBy: s.matchedBy || null,
      })),
      attempts: attempts.map((a) => ({
        stepId: a.stepId, status: a.status, error: a.error ? { code: a.error.code, message: String(a.error.message || '').slice(0, 200) } : null,
      })),
      httpStatusWhenAvailable: extra.httpStatus || null,
      challengeState: extra.challengeState || null,
      failureDiagnosis: extra.diagnosis || null,
      repairAttempts: attempts.filter((a) => a.status === 'FAILED').length,
      checkpoint: checkpoints.length ? { count: checkpoints.length, latestUrl: checkpoints[checkpoints.length - 1].url, latestAt: checkpoints[checkpoints.length - 1].timestamp } : null,
      verification: extra.verification || null,
      credentialRef: credRec ? { id: credRec.id, type: credRec.type, available: credRec.available, masked: secretManager.maskedView(credRec) } : null,
      terminalState: extra.terminalState || { taskStatus: task.status, harnessClass: null },
      error: task.error ? String(task.error).slice(0, 400) : null,
      ...extra.overflow,
    };
  }

  async function observeNow(taskIdLabel) {
    try {
      const insp = await observation.inspect(page, { skipCache: true, taskId: null, source: 'harness_final' });
      if (insp && insp.ok) return insp.observation;
    } catch (e) { /* 页面可能已关 */ }
    return null;
  }

  function cookieMetadata() {
    try {
      const ctx = session.context;
      return ctx.cookies().then((cs) => ({ count: cs.length, names: cs.map((c) => c.name).slice(0, 50) }));
    } catch (e) { return Promise.resolve({ count: 0, names: [] }); }
  }

  async function runOne(def) {
    const rec = { taskId: def.taskId, startedAt: Date.now() };
    try {
      // 0. 契约执行期校验（fail-closed）
      const vexec = contract.validateForExecution(def);
      if (!vexec.ok) {
        rec.terminalState = { taskStatus: 'SKIPPED_CONTRACT', harnessClass: null };
        rec.validationErrors = vexec.errors;
        return rec;
      }

      // 1. 环境快照 + Integrity
      const snap = await withTimeout(
        captureEnvironmentSnapshot({ page, fp, profile, proxy, task: { taskId: def.taskId, executionId: runTag, attemptId: 'A1' } }),
        20000, 'env-snapshot ' + def.taskId,
      );
      const integrity = snap ? checkEnvironmentIntegrity(snap) : { status: 'MISSING' };

      // 2. 凭据就绪（R05-R08 授权凭据 / R09 专用无效测试凭据）
      let credentialReady = false;
      let secretRefs = [];
      if (def.credentialsRequired && def.invalidCredentials) {
        // R09：注册专用无效测试凭据（非真实账号；走完整 credentialRef 链路）
        vault.setProfileSecrets(profile.id, {
          email: 'phase15.invalid@example.invalid',
          password: 'WrongPass-Invalid-#15',
        });
        const sec = secretManager.createSecret({ profileId: profile.id, type: 'email_password', site: host, label: 'phase15-invalid-credential' });
        secretRefs = [sec.id];
        credentialReady = !!secretManager.resolve(sec.id);
      } else if (def.credentialsRequired) {
        // R05-R08：凭据必须在执行前已存在于 credential workspace（用户授权）。
        const rec0 = store.read('aiCredentials', []).find((c) => c.profileId === profile.id && c.type === 'email_password');
        if (rec0) { credentialReady = !!secretManager.resolve(rec0.id); secretRefs = [rec0.id]; }
      }

      // 3. Task Readiness（四项门 + challenge 门）
      const readiness = contract.computeTaskReadiness({
        integrity,
        credentialReady,
        credentialsRequired: !!def.credentialsRequired,
        challenge: lastChallenge,
        policyDecision: { decision: 'ALLOW' },
      });
      if (readiness.decision === 'BLOCK') {
        rec.terminalState = { taskStatus: 'SKIPPED_CREDENTIALS_PENDING', harnessClass: null };
        rec.readiness = readiness;
        rec.blockers = readiness.blockers;
        return rec;
      }

      // 4. 创建任务并走完整 runtime（planner → runtime → 终态）
      const url = contract.resolveTaskUrl(def, baseUrl);
      const task = taskManager.createTask({
        name: 'phase15_' + def.taskId,
        objective: def.objective,
        targetUrl: url,
        profileId: profile.id,
        executionMode: 'AUTONOMOUS',
        policy: { riskFloor: 'HIGH', taskTimeoutMs: def.maxTaskTimeoutMs || 180000 },
        secretRefs,
      });
      taskManager.start(task.id);

      // R10 pass1：人为中断（模拟进程崩溃）
      if (def.interruptible && killAfterMs > 0) {
        setTimeout(() => {
          console.log('[phase15-worker] R10 pass1 人为中断（模拟进程崩溃）');
          process.exit(137);
        }, killAfterMs).unref();
      }

      // 等待终态
      const deadline = Date.now() + (def.maxTaskTimeoutMs || 180000) + 90000;
      let t = taskManager.getTask(task.id);
      while (t && !TERMINAL_STATES.includes(t.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        t = taskManager.getTask(task.id);
      }
      if (t && !TERMINAL_STATES.includes(t.status)) {
        try { taskManager.cancel(task.id, 'harness deadline'); } catch (e) {}
        t = taskManager.getTask(task.id);
      }

      // 5. 终态后观察 + 分类（每步带超时保护，采集挂起不阻塞 worker）
      console.log('[phase15-worker] ' + def.taskId + ' 终态=' + (t ? t.status : 'UNKNOWN') + '，采集证据…');
      const finalObs = await withTimeout(observeNow(), 12000, 'final-observation ' + def.taskId);
      const cs = (await withTimeout(cookieMetadata(), 8000, 'cookies ' + def.taskId)) || { count: 0, names: [] };
      const finalUrl = finalObs ? finalObs.url : (page && page.url ? page.url() : null);
      const challengeState = finalObs ? finalObs.challenge : null;
      lastChallenge = challengeState;

      let harnessTerminal = { taskStatus: t ? t.status : 'UNKNOWN', harnessClass: null };
      let diagnosis = null;
      let classification = null;
      // O(n×m) 修复：aiAttempts 40MB —— 与 collectTaskEvidence 同法，Map 索引后单遍过滤
      const _stepTaskMap = new Map(store.read('aiSteps', []).map((s) => [s.id, s.taskId]));
      const lastAttempt = store.read('aiAttempts', []).map((a) => {
        return (_stepTaskMap.get(a.stepId) === task.id && a.error) ? a : null;
      }).filter(Boolean).pop() || null;
      if (lastAttempt && lastAttempt.error) {
        diagnosis = { rootCause: lastAttempt.error.failureType || lastAttempt.error.code, code: lastAttempt.error.code, message: String(lastAttempt.error.message || '').slice(0, 300) };
        classification = contract.classifyRealSiteFailure({ diagnosis, challenge: challengeState });
      }
      if (challengeState && challengeState.challenge) {
        harnessTerminal.harnessClass = challengeState.externalBlock && !challengeState.interactive ? 'BLOCKED_EXTERNAL' : 'HUMAN_REQUIRED';
      }
      if (def.expectedFailure) {
        const efo = contract.expectedFailureOutcome({ expectedFailure: true, classification: classification ? classification.classification : (challengeState && challengeState.challenge ? (challengeState.externalBlock ? 'EXTERNAL_BLOCK' : 'INTERACTIVE_CHALLENGE') : null) });
        if (efo) harnessTerminal = { taskStatus: efo.terminal, harnessClass: harnessTerminal.harnessClass, note: efo.note };
      }

      rec.result = collectTaskEvidence(def, t || task, {
        finalUrl,
        readiness,
        snapshot: snap,
        integrity,
        challengeState: challengeState ? { kind: challengeState.kind, challenge: challengeState.challenge, externalBlock: challengeState.externalBlock, interactive: challengeState.interactive, evidence: challengeState.evidence } : null,
        diagnosis: diagnosis ? { ...diagnosis, classification } : null,
        cookies: { count: cs.count, names: cs.names },
        terminalState: harnessTerminal,
        verification: { steps: (stepManager.listSteps(task.id) || []).filter((s) => s.status === 'SUCCESS').length, total: (stepManager.listSteps(task.id) || []).length },
      });
      rec.terminalState = harnessTerminal;
      return rec;
    } catch (e) {
      rec.error = String((e && e.message) || e).slice(0, 300);
      rec.terminalState = { taskStatus: 'FAILED', harnessClass: null };
      return rec;
    }
  }

  // R10 pass2：恢复模式
  if (resumeTaskId) {
    const t = taskManager.getTask(resumeTaskId);
    if (!t) { console.error('RESUME_TASK_NOT_FOUND', resumeTaskId); process.exit(2); }
    const preCheckpoints = checkpointMod.listForTask(resumeTaskId).length;
    const preSuccessSteps = stepManager.listSteps(resumeTaskId).filter((s) => s.status === 'SUCCESS');
    console.log('[phase15-worker] R10 pass2 恢复：checkpoints=' + preCheckpoints + ' preSuccessSteps=' + preSuccessSteps.length + ' pass1Status=' + t.status);
    // pass1 已自然终态（如 SUCCESS）：无需恢复，优雅落证退出。
    // taskManager.recover 的「终态任务不允许恢复」守卫是正确生产行为，这里不做绕行。
    if (TERMINAL_STATES.includes(t.status)) {
      console.log('[phase15-worker] R10 pass1 已达终态 ' + t.status + '，无需恢复（不重复执行已完成动作）');
      const postSuccessSteps = stepManager.listSteps(resumeTaskId).filter((s) => s.status === 'SUCCESS');
      const evidence = {
        taskId: 'R10',
        mode: 'interrupted_recovery',
        interruption: 'none (pass1 completed before kill timer)',
        pass1: { preCheckpoints, preSuccessStepIds: preSuccessSteps.map((s) => s.id), status: t.status },
        pass2: {
          terminalStatus: t.status,
          postSuccessStepIds: postSuccessSteps.map((s) => s.id),
          preservedSuccessSteps: preSuccessSteps.length,
          checkpointRestored: false,
          note: 'recover 守卫正确拒绝恢复终态任务（Gate E: no duplicate action）',
        },
        startTime: Date.now(),
        endTime: Date.now(),
        terminalState: { taskStatus: t.status, harnessClass: null },
      };
      const dir = path.join(OUT, process.env.FPB15_RUN_TAG || new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'R10_recovery.json'), JSON.stringify(evidence, null, 2), 'utf8');
      console.log('PHASE15_R10_DONE status=' + t.status + ' preserved=' + preSuccessSteps.length + ' checkpointRestored=false (already-terminal)');
      return;
    }
    taskManager.recover(resumeTaskId);
    const deadline = Date.now() + 300000;
    let cur = taskManager.getTask(resumeTaskId);
    while (cur && !TERMINAL_STATES.includes(cur.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      cur = taskManager.getTask(resumeTaskId);
    }
    const postSuccessSteps = stepManager.listSteps(resumeTaskId).filter((s) => s.status === 'SUCCESS');
    const finalObs = await observeNow();
    const cs = await cookieMetadata();
    const evidence = {
      taskId: 'R10',
      mode: 'interrupted_recovery',
      pass1: { preCheckpoints, preSuccessStepIds: preSuccessSteps.map((s) => s.id) },
      pass2: {
        terminalStatus: cur ? cur.status : 'UNKNOWN',
        postSuccessStepIds: postSuccessSteps.map((s) => s.id),
        preservedSuccessSteps: postSuccessSteps.filter((s) => preSuccessSteps.some((p) => p.id === s.id)).length,
        checkpointRestored: preCheckpoints > 0,
        finalUrl: finalObs ? finalObs.url : null,
      },
      cookies: { count: cs.count, names: cs.names },
      startTime: t.startedAt, endTime: (cur && cur.finishedAt) || Date.now(),
      environmentIntegrity: null,
      terminalState: { taskStatus: cur ? cur.status : 'UNKNOWN', harnessClass: null },
    };
    fs.writeFileSync(path.join(runDir, 'R10_recovery.json'), JSON.stringify(evidence, null, 2), 'utf8');
    console.log('PHASE15_R10_DONE status=' + evidence.terminalState.taskStatus + ' preserved=' + evidence.pass2.preservedSuccessSteps + ' checkpointRestored=' + evidence.pass2.checkpointRestored);
    await browserManager.close(profile.id).catch(() => {});
    process.exit(0);
  }

  for (const id of taskIds) {
    const def = cfg.tasks.find((x) => x.taskId === id);
    if (!def) { console.error('UNKNOWN_TASK', id); continue; }
    const rec = await runOne(def);
    results.push(rec);
    const evidence = rec.result || rec;
    fs.writeFileSync(path.join(runDir, def.taskId + '.json'), JSON.stringify(evidence, null, 2), 'utf8');
    console.log('[phase15-worker] ' + def.taskId + ' → ' + JSON.stringify(rec.terminalState || evidence.terminalState));
  }

  await withTimeout(browserManager.close(profile.id).catch(() => {}), 15000, 'browser-close');
  fs.writeFileSync(path.join(runDir, '_worker_summary.json'), JSON.stringify({
    runTag, baseUrl, tasks: results.map((r) => ({ taskId: r.taskId, terminal: r.terminalState })),
  }), 'utf8');
  console.log('PHASE15_WORKER_DONE runDir=' + runDir);
  process.exit(0);
}

// ── 编排模式：spawn worker 子进程（R10 两段式） ──
function runWorkerNode(extraArgs, { killAfterMs = 0 } = {}) {
  return new Promise((resolve) => {
    const node = process.execPath;
    const child = spawn(node, [__filename, '--worker', '--label', LABEL, ...extraArgs], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    let killer = null;
    if (killAfterMs > 0) {
      killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, killAfterMs);
    }
    child.on('exit', (code) => {
      if (killer) clearTimeout(killer);
      resolve({ code, out });
    });
  });
}

async function orchestratorMain() {
  const cfg = loadTasks();
  const baseUrl = argOf('--base-url', process.env.FPB_REALSITE_BASE_URL || cfg.defaultBaseUrl);
  const taskIds = argOf('--tasks', 'R01,R02,R03,R04').split(',').map((s) => s.trim()).filter(Boolean);
  const runTag = new Date().toISOString().replace(/[:.]/g, '-');
  process.env.FPB15_RUN_TAG = runTag;
  fs.mkdirSync(path.join(OUT, runTag), { recursive: true });
  console.log('[phase15] runTag=' + runTag + ' baseUrl=' + baseUrl + ' tasks=' + taskIds.join(','));

  // R10 两段式：pass1 kill-after → pass2 recover
  if (taskIds.includes('R10')) {
    const nonR10 = taskIds.filter((x) => x !== 'R10');
    if (nonR10.length) {
      await runWorkerNode(['--tasks', nonR10.join(','), '--base-url', baseUrl]);
    }
    console.log('[phase15] R10 pass1：启动任务并在 8s 后硬杀（模拟进程中断）');
    // kill-after-ms 可覆盖：默认 8s（planning 阶段中断）；调大可让步骤先成功再杀（验证 preserved 语义）
    const killMs = parseInt(argOf('--kill-after-ms', '8000'), 10) || 8000;
    const pass1 = await runWorkerNode(['--tasks', 'R10', '--kill-after-ms', String(killMs), '--base-url', baseUrl], { killAfterMs: killMs + 15000 });
    console.log('[phase15] R10 pass1 退出 code=' + pass1.code);
    // 找到 pass1 创建的任务 id（从 worker summary 或 store 文件读取）
    const storeDir = path.join(SERVER_ROOT, 'data');
    let r10TaskId = null;
    try {
      const tasksPath = path.join(storeDir, 'aiTasks.json');
      const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
      const r10 = tasks.filter((x) => x.name === 'phase15_R10').sort((a, b) => b.createdAt - a.createdAt)[0];
      r10TaskId = r10 && r10.id;
    } catch (e) {}
    if (!r10TaskId) { console.error('[phase15] R10 任务未找到'); process.exit(1); }
    console.log('[phase15] R10 pass2：recover ' + r10TaskId);
    await runWorkerNode(['--resume-task', r10TaskId, '--base-url', baseUrl]);
  } else {
    await runWorkerNode(['--tasks', taskIds.join(','), '--base-url', baseUrl]);
  }
  console.log('PHASE15_ORCHESTRATOR_DONE runTag=' + runTag);
  process.exit(0);
}

if (require.main === module) {
  (IS_WORKER ? workerMain() : orchestratorMain()).catch((e) => {
    console.error('FATAL', (e && e.message) || e);
    process.exit(1);
  });
}
module.exports = { loadTasks };
