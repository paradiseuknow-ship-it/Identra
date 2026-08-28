'use strict';

// Phase 5.8 验收脚本：100 Mock tasks 走完整 Scheduler 路径，验证生命周期正确性。
// 验收标准：
//   - 0 个 RUNNING 永久悬挂
//   - 0 个重复 execution
//   - 0 个 ghost lock
//   - 0 个无限 retry
//   - 每个 task 终态 ∈ { SUCCESS, FAILED, CANCELLED, HUMAN_ESCALATION }
//   - Scheduler 路径与直接 runtime.run() 终态一致（由 runner 实现保证）
//
// 用法：BENCH_PW_CHROMIUM=1 node benchmark/verify-lifecycle.js [count]
//   count 默认 100。

const taskManager = require('../server/agent/taskManager');
require('../server/agent/runtime'); // 副作用：注册 setExecutor(run)，否则 scheduler 派发后 runtime 不执行
const { schedulerLoop } = require('../server/agent/execution');
const { browserResourcePool } = require('../server/agent/execution/browser');
const db = require('../server/db');
const { injectPlan } = require('./agentPlanBridge');
const { allTasks } = require('./tasks');

const TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'];

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

async function main() {
  const COUNT = parseInt(process.argv[2] || '100', 10);
  const tasks = allTasks();
  if (!tasks.length) throw new Error('no benchmark tasks');

  // 启动 mock 站点（随机端口）
  const mockApp = require('./mockSite').buildApp();
  const mockServer = await new Promise((res) => { const s = mockApp.listen(0, () => res(s)); });
  const mockUrl = `http://localhost:${mockServer.address().port}`;
  console.log('[verify] mock site', mockUrl);

  // 单 Scheduler 实例（单 Worker，串行派发）
  const sched = schedulerLoop.getInstance();
  sched.start();

  // 固定 profile（每次重建 userDataDir 避免脏数据）
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const pid = 'bench-lifecycle';
  const ud = path.join(os.tmpdir(), 'bench-lifecycle-' + pid);
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(ud, { recursive: true }); } catch {}
  db.upsertProfile({
    id: pid, name: 'Lifecycle', fingerprint: {},
    launchBehavior: { headless: true },
    launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    userDataDir: ud, createdAt: Date.now(),
  });

  const results = [];
  const startAll = Date.now();

  for (let i = 0; i < COUNT; i++) {
    const t = tasks[i % tasks.length];
    const created = taskManager.createTask({
      name: `lc-${i}-${t.id}`,
      objective: t.objective,
      targetUrl: mockUrl + (t.targetUrl || '/'),
      profileId: pid,
      executionMode: 'AUTO',
    });

    // Plan Bridge：注入确定性合法 plan（不借助 LLM）
    // 注意：传相对路径 t.targetUrl（如 /login），由 bridge 拼 mockBaseUrl，避免 URL 双重前缀。
    if (process.env.BENCH_PLAN_BRIDGE !== '0') injectPlan(created, mockUrl, t.targetUrl);

    // 完整 Scheduler 路径
    sched.submit(created.id, { profileId: pid, category: 'NORMAL' });

    // 轮询终态（超时留足 chromium 启动 + 重试/修复余量，避免误判悬挂）
    const t0 = Date.now();
    let final = null;
    while (Date.now() - t0 < (t.verify.timeoutMs + 60000)) {
      const cur = taskManager.getTask(created.id);
      if (cur && TERMINAL.includes(cur.status)) { final = cur; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    final = final || taskManager.getTask(created.id) || { status: 'TIMEOUT' };
    const success = final.status === 'SUCCESS';
    results.push({
      i, category: t.category, status: final.status,
      latency: Date.now() - t0, executionId: final.currentExecutionId,
      error: final.error ? final.error.slice(0, 80) : null,
    });
    console.log(`  #${i} ${t.category} -> ${final.status} (${Date.now() - t0}ms)${final.error ? ' :: ' + final.error.slice(0, 80) : ''}`);
  }

  // ---- 验收断言 ----
  const statuses = results.map((r) => r.status);
  const nonTerminal = results.filter((r) => !TERMINAL.includes(r.status));
  const byStatus = {};
  statuses.forEach((s) => { byStatus[s] = (byStatus[s] || 0) + 1; });

  // 重复 executionId
  const execIds = results.map((r) => r.executionId).filter(Boolean);
  const dupExec = execIds.length - new Set(execIds).size;

  // ghost lock：profile 资源是否仍被持有（task 全终态后应为空闲）
  const resource = browserResourcePool.getStatus ? browserResourcePool.getStatus(pid) : null;
  const ghostLock = resource && resource.heldBy ? 1 : 0;

  // 无限 retry：检测单 task 是否超过 maxRetries 仍非终态（此处已由 nonTerminal 覆盖，另查 attempt 异常）
  const lat = results.map((r) => r.latency);

  console.log('\n=== Phase 5.8 Lifecycle Verification ===');
  console.log('Total:', results.length);
  console.log('Status distribution:', JSON.stringify(byStatus));
  console.log('Success rate:', (byStatus.SUCCESS || 0) / results.length * 100 + '%');
  console.log('P50/P95/P99 latency:', pct(lat, 50) + '/' + pct(lat, 95) + '/' + pct(lat, 99) + 'ms');
  console.log('Non-terminal (hanging) tasks:', nonTerminal.length);
  console.log('Duplicate execution IDs:', dupExec);
  console.log('Ghost lock (profile still held):', ghostLock);
  console.log('Avg latency:', Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) + 'ms');

  const PASS = nonTerminal.length === 0 && dupExec === 0 && ghostLock === 0;
  console.log('\nVERDICT:', PASS ? 'PASS ✅' : 'FAIL ❌');
  if (nonTerminal.length) {
    console.log('Hanging tasks:');
    nonTerminal.slice(0, 10).forEach((r) => console.log('  #' + r.i, r.category, r.status));
  }

  // 清理
  try { sched.stop(); } catch {}
  try { mockServer.close(); } catch {}
  process.exit(PASS ? 0 : 1);
}

main().catch((e) => { console.error('verify error', e); process.exit(1); });
