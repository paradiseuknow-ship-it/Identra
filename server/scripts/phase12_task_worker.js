'use strict';
// STEP22-后续 infra 加固（2026-08-31）：单任务隔离执行 worker。
// 背景：run1/run2 各出现一次 headless 假死（不同任务、概率性 ~1.5-3%），假死任务的
// taskManager.cancel 同步卡死 → in-process runner 整体被拖死，100 任务无法自然完成。
// 方案：每个任务由父进程 spawn 独立子进程执行 phase10Benchmark.runScenario（真实链路
// 与评分语义零改动），父进程设硬性 deadline，超时对子进程树 taskkill /T /F（连 Chromium
// 一起回收），该任务记为 TIMEOUT——只改执行容器，不改 runtime/verification/成功定义。
const P9 = require('./phase10Benchmark');

// R7 crash guard（worker 进程）：worker 崩溃时 runner 有 on('error'/'exit') 兜底，
// 此处额外同步落盘崩溃证据（见 benchCrashGuard.js 头注）。
require('./benchCrashGuard').install('phase12_worker_' + String(process.argv[process.argv.indexOf('--task') + 1] || 'unknown').replace(/[^\w-]/g, '_'));

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); if (i < 0) return def; const n = argv[i + 1]; return (n === undefined || n.startsWith('--')) ? true : n; }
const taskId = String(arg('--task', ''));
const port = String(arg('--port', ''));

(async () => {
  try {
    const list = P9.loadTasks();
    const scn = list.find((s) => s.id === taskId);
    if (!scn) { console.log('WORKER_RESULT:' + JSON.stringify({ workerError: 'task not found: ' + taskId })); process.exit(3); }
    const baseUrl = 'http://127.0.0.1:' + port;
    const rec = await P9.runScenario(scn, baseUrl);
    console.log('WORKER_RESULT:' + JSON.stringify(rec));
    process.exit(0);
  } catch (e) {
    console.log('WORKER_RESULT:' + JSON.stringify({ workerError: String((e && e.message) || e) }));
    process.exit(4);
  }
})();
