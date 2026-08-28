'use strict';

// Phase 4.4 Matrix Runner：10 个真实业务任务稳定性评估（非 benchmark / 非 E4）。
//
// 目标：用真实 DeepSeek Planner + 真实浏览器，跑 10 个不同业务任务，
// 产出产品稳定性统计：successRate / failureTypes / averageSteps / averageRepairCount。
//
// 约束：
//   - 复用既有 agent 能力，不修改 runtime / E4 / benchmark / fingerprint baseline。
//   - 每个任务均走唯一真实链路（createTask 不 attachPlan → runtime.resolvePlan → Planner → DeepSeek → browser → verification → repair）。
//   - 不模拟成功；终态为 SUCCESS 或明确业务失败均记为真实结果。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-... node server/scripts/matrix.js

const path = require('path');
const http = require('http');
const fs = require('fs');

const hasRealProvider = !!(
  process.env.DEEPSEEK_API_KEY ||
  (process.env.AI_PROVIDER && ['deepseek', 'openai'].includes(process.env.AI_PROVIDER))
);
if (!hasRealProvider) {
  console.error('[matrix] 缺少真实 LLM 环境：未检测到 DEEPSEEK_API_KEY / AI_PROVIDER=deepseek|openai。');
  console.error('[matrix] 按约束不回退 mock、不模拟成功。提供 key 后重跑。');
  process.exit(2);
}
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';

require('../agent/llm/providers/deepseek'); // 注册 deepseek 工厂

const TASK_DEFS = [
  { key: 'search',        name: '搜索',       fixture: 'search.html',   objective: '在搜索框输入 "hello world" 并提交，验证页面出现搜索结果' },
  { key: 'login',         name: '登录',       fixture: 'login.html',    objective: '在用户名输入 admin、密码输入 123456，点击登录按钮，验证登录成功' },
  { key: 'form_submit',   name: '表单提交',   fixture: 'search.html',   objective: '在搜索框输入 test 并提交搜索表单' },
  { key: 'page_jump',     name: '页面跳转',   fixture: 'search.html',   objective: '打开页面并在搜索框输入 go 提交，观察结果区域内容变化' },
  { key: 'extract',       name: '数据提取',   fixture: 'search.html',   objective: '在搜索框输入 report 并提交，提取结果区域中的文本' },
  { key: 'download',      name: '下载',       fixture: 'download.html', objective: '点击下载链接完成文件下载' },
  { key: 'multi_step',    name: '多步骤流程', fixture: 'search.html',   objective: '在搜索框输入 multi，提交搜索，并验证结果出现' },
  { key: 'error_recovery',name: '错误恢复',   fixture: 'login.html',    objective: '在用户名输入 wrong、密码输入 bad，点击登录（预期认证失败并触发恢复流程）' },
  { key: 'page_change',   name: '页面变化',   fixture: 'search.html',   objective: '在搜索框输入 change 提交后，确认页面结果区域发生变化' },
  { key: 'timeout_recovery', name: '超时恢复', fixture: 'search.html',  objective: '在不存在的输入框 #nonexist 中输入内容并提交（预期元素缺失触发重试/恢复）' },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startMockServer() {
  const root = path.resolve(__dirname, '..', '..', 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.statusCode = 403; res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.end('not found'); return; }
      const ext = path.extname(file);
      const ct = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript' : 'text/plain';
      res.setHeader('Content-Type', ct);
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function runOne(def, baseUrl) {
  const db = require('../db');
  const taskManager = require('../agent/taskManager');
  const store = require('../agent/store');
  const browserManager = require('../browserManager');
  require('../agent/runtime'); // 注册 executor 钩子

  const PROFILE_ID = 'p_matrix_' + def.key + '_' + Date.now().toString(36);
  const profile = {
    id: PROFILE_ID, name: 'Matrix-' + def.key, group: 'default', tags: [], notes: '',
    seed: 'matrix-seed', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  };
  db.upsertProfile(profile);

  const targetUrl = baseUrl + '/' + def.fixture;
  const task = taskManager.createTask({
    name: 'Matrix ' + def.name,
    objective: def.objective,
    targetUrl,
    profileId: PROFILE_ID,
    executionMode: 'AUTONOMOUS',
    constraints: [],
    policy: { riskFloor: 'HIGH' }, // 良性 submit 在 AUTONOMOUS 下可执行
  });

  taskManager.start(task.id);
  const end = Date.now() + 90000;
  let final = null;
  while (Date.now() < end) {
    final = taskManager.getTask(task.id);
    if (final && ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(final.status)) break;
    await sleep(500);
  }

  // 收集统计（保留 aiSteps/aiRepairAttempts/aiFailureSnapshots 以便聚合）
  const steps = store.read('aiSteps', []).filter((s) => s.taskId === task.id);
  const repairs = store.read('aiRepairAttempts', []).filter((r) => r.taskId === task.id);
  const snaps = store.read('aiFailureSnapshots', []).filter((s) => s.taskId === task.id);
  const failureType = snaps.length ? snaps[snaps.length - 1].errorType
    : (final && final.error && final.error.code) ? final.error.code
    : (final && typeof final.error === 'string' ? final.error : final.status);

  // 清理浏览器/ profile（保留分析数据）
  try { taskManager.cancel(task.id); } catch (e) {}
  try { browserManager.close(PROFILE_ID).catch(() => {}); } catch (e) {}
  try { db.deleteProfile(PROFILE_ID); } catch (e) {}

  return {
    key: def.key, name: def.name, status: final ? final.status : 'TIMEOUT',
    stepCount: steps.length, repairCount: repairs.length,
    failureType: failureType || null,
  };
}

function aggregate(results) {
  const total = results.length;
  const success = results.filter((r) => r.status === 'SUCCESS').length;
  const failed = results.filter((r) => r.status === 'FAILED' || r.status === 'HUMAN_ESCALATION').length;
  const failureTypes = {};
  results.forEach((r) => { if (r.status !== 'SUCCESS') { const k = r.failureType || 'UNKNOWN'; failureTypes[k] = (failureTypes[k] || 0) + 1; } });
  const avgSteps = total ? +(results.reduce((a, r) => a + r.stepCount, 0) / total).toFixed(2) : 0;
  const avgRepair = total ? +(results.reduce((a, r) => a + r.repairCount, 0) / total).toFixed(2) : 0;
  return {
    total, success, failed,
    successRate: total ? +(success / total).toFixed(4) : null,
    failureTypes, avgSteps, avgRepair,
  };
}

async function main() {
  console.log('== Phase 4.4 Matrix Runner：10 真实业务任务稳定性评估 ==');
  const mock = await startMockServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  console.log('[matrix] mock-site 入口：', baseUrl);

  const results = [];
  for (const def of TASK_DEFS) {
    process.stdout.write(`[matrix] 运行「${def.name}」... `);
    const r = await runOne(def, baseUrl);
    results.push(r);
    console.log(`status=${r.status} steps=${r.stepCount} repairs=${r.repairCount} failType=${r.failureType || '-'}`);
  }

  const agg = aggregate(results);
  console.log('\n================ MATRIX REPORT ================');
  console.log('总任务数        :', agg.total);
  console.log('成功            :', agg.success);
  console.log('失败/人工升级   :', agg.failed);
  console.log('成功率          :', agg.successRate != null ? (agg.successRate * 100).toFixed(1) + '%' : '-');
  console.log('平均步骤数      :', agg.avgSteps);
  console.log('平均恢复次数    :', agg.avgRepair);
  console.log('失败类型分布    :', JSON.stringify(agg.failureTypes));
  console.log('逐任务明细:');
  results.forEach((r) => {
    console.log(`  - ${r.name.padEnd(6)} ${r.status.padEnd(16)} steps=${r.stepCount} repairs=${r.repairCount} failType=${r.failureType || '-'}`);
  });
  console.log('===============================================');

  try { mock.server.close(); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { console.error('[matrix] 异常:', e && e.stack || e); process.exit(1); });
