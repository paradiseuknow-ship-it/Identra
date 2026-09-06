'use strict';

// STEP 10 — CAP-K3：siteMemory.recordTaskResult 成功侧生产链接入（browserless，纯逻辑 + 真实 store）。
// 覆盖：
//   1) 成功侧接线：complete → recordTaskResult(ok:true)（真实业务结果，非 action_success）
//   2) flowName=任务目标 / avgSteps=真实完成步数 落入 commonFlows
//   3) 读侧闭环：siteMemory.getSite 能看到回写（Router/contextBuilder 的消费源）
//   4) 失败侧按现有契约：fail → ok:false + failureType（仅显式原因码，无 reason 不污染）
//   5) escalate / cancel 不回写（宁可少记不误记）
//   6) 终态幂等：complete/fail 对已终态任务重入原样返回，经验不双计
//      （根因：transitionTask 对 next===current 直接放行，终态重入会整函数体重跑）
//   7) retry 语义：FAILED → 再跑 → SUCCESS = 两次独立运行事实（1F+1S），不是重复记录
//   8) fail-open：siteMemory 崩溃 → 任务仍 SUCCESS
// 用法：node server/scripts/test_step10_site_memory_wiring.js

const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const siteMemory = require('../agent/intelligence/siteMemory');

const SITE = 'smk3.test';
const GOAL = '在 smk3 测试站完成下单';
const TARGET = 'http://' + SITE + '/checkout';
const collectedTaskIds = [];

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

// 测试捷径：直改状态（生产中由 start()/状态机驱动），与 test_step8 同模式
function forceStatus(id, status) {
  const t = taskManager.getTask(id);
  t.status = status;
  store.upsert('aiTasks', t);
  return t;
}

function newTask(name) {
  const t = taskManager.createTask({ name, objective: GOAL, targetUrl: TARGET, profileId: null });
  collectedTaskIds.push(t.id);
  return t;
}

function cleanup() {
  for (const id of collectedTaskIds) {
    try { taskManager.deleteTask(id); } catch (e) { /* 已不存在则忽略 */ }
  }
  try { siteMemory.removeSite(SITE); } catch (e) {}
}

async function main() {
  console.log('== STEP 10 / CAP-K3: siteMemory 成功侧生产链接入 ==');
  cleanup();

  // ============ 1) 成功侧接线 + flowName/avgSteps ============
  console.log('\n[1] complete → recordTaskResult(ok:true)');
  const s0 = siteMemory.getSite(SITE);
  ok(!s0 || (s0.history.successTasks || 0) === 0, '前置：站点记忆为空');

  const t1 = newTask('k3-success');
  forceStatus(t1.id, 'RUNNING');
  taskManager.complete(t1.id, { completedSteps: 5, totalSteps: 5 });
  const rec1 = siteMemory.getSite(SITE);
  ok(rec1 && rec1.history.successTasks === 1, '成功任务回写 successTasks=1',
    rec1 && JSON.stringify(rec1.history));
  ok(!!rec1.commonFlows[GOAL], 'flowName=任务目标 落入 commonFlows');
  const f1 = rec1.commonFlows[GOAL];
  ok(f1.samples === 1 && f1.successRate === 1 && f1.avgSteps === 5,
    'commonFlows 首样本：samples=1 / successRate=1 / avgSteps=5（真实完成步数）',
    JSON.stringify(f1));
  ok(typeof rec1.confidence === 'number' && Math.abs(rec1.confidence - 0.813) < 0.01,
    'memoryRecord 公式：1 次成功 → confidence=0.813（rate=1 × (0.75+0.25×1/4)）', String(rec1.confidence));

  // ============ 2) 读侧闭环 ============
  console.log('\n[2] 读侧闭环（Router/contextBuilder 消费源）');
  const viaApi = siteMemory.listSites().find((r) => r.site === SITE);
  ok(viaApi && viaApi.history.successTasks === 1, 'listSites/getSite 可读回写（消费侧无需改动）');

  // ============ 3) 失败侧按现有契约 ============
  console.log('\n[3] fail → ok:false + failureType');
  const t2 = newTask('k3-fail');
  forceStatus(t2.id, 'PLANNING'); // PLANNING→FAILED 合法
  taskManager.fail(t2.id, new Error('k3 模拟失败'), { reason: 'CREDENTIAL_UNAVAILABLE' });
  const rec2 = siteMemory.getSite(SITE);
  ok(rec2.history.failedTasks === 1, '失败任务回写 failedTasks=1', JSON.stringify(rec2.history));
  ok(rec2.frequentFailures.includes('CREDENTIAL_UNAVAILABLE'), '显式原因码进入 frequentFailures');
  const f2a = rec2.commonFlows[GOAL];
  ok(f2a.samples === 2 && Math.abs(f2a.successRate - 0.5) < 0.001,
    '失败侧同目标聚合：samples=2 / successRate 1→0.5（失败不吃 flowName 会虚高）', JSON.stringify(f2a));

  const t3 = newTask('k3-fail-noreason');
  forceStatus(t3.id, 'PLANNING');
  const ffBefore = rec2.frequentFailures.length;
  taskManager.fail(t3.id, new Error('k3 自由文本失败：Element not found at (x,y)'));
  const rec3 = siteMemory.getSite(SITE);
  ok(rec3.history.failedTasks === 2, '无 reason 的失败仍计 failedTasks（事实计数）');
  ok(rec3.frequentFailures.length === ffBefore, '无显式原因码 → 不从自由错误文本臆造类别（不污染）');
  ok(Math.abs(rec3.commonFlows[GOAL].successRate - 1 / 3) < 0.001, '1S+2F → successRate≈0.333');

  // ============ 4) escalate / cancel 不回写 ============
  console.log('\n[4] escalate / cancel 零回写（宁可少记不误记）');
  const t4 = newTask('k3-escalate');
  forceStatus(t4.id, 'RUNNING');
  taskManager.escalate(t4.id, new Error('k3 需人工'), { reason: 'verification' });
  const rec4 = siteMemory.getSite(SITE);
  ok(rec4.history.successTasks === 1 && rec4.history.failedTasks === 2,
    'escalate 后 success/failed 均不变（升级不是已证实的失败结果，也绝不误记成功）',
    JSON.stringify(rec4.history));

  const t5 = newTask('k3-cancel');
  forceStatus(t5.id, 'RUNNING');
  taskManager.cancel(t5.id);
  const rec5 = siteMemory.getSite(SITE);
  ok(rec5.history.successTasks === 1 && rec5.history.failedTasks === 2, 'cancel 后计数不变');

  // ============ 5) 终态幂等 ============
  console.log('\n[5] 终态重入不双计（transitionTask 同状态放行 → 必须有守卫）');
  const r1 = taskManager.complete(t1.id, { completedSteps: 99, totalSteps: 99 }); // 对已 SUCCESS 重入
  ok(r1 && r1.status === 'SUCCESS' && r1.result.completedSteps === 5,
    'complete 重入原样返回，result 不被覆盖');
  const rec6 = siteMemory.getSite(SITE);
  ok(rec6.history.successTasks === 1, 'complete 重入 → successTasks 不双计', JSON.stringify(rec6.history));
  ok(Object.keys(rec6.commonFlows).length === 1 && rec6.commonFlows[GOAL].samples === 3,
    'commonFlows 不双计（重入前已是 1S+2F = samples 3）');
  const r2 = taskManager.fail(t1.id, new Error('对 SUCCESS 任务再 fail'));
  ok(r2 && r2.status === 'SUCCESS' && rec6.history.failedTasks === (siteMemory.getSite(SITE).history.failedTasks),
    '对终态任务 fail 原样返回，不误记失败');
  const r3 = taskManager.escalate(t2.id, new Error('对 FAILED 任务再 escalate'));
  ok(r3 && r3.status === 'FAILED' && siteMemory.getSite(SITE).history.failedTasks === 2,
    '对终态任务 escalate 原样返回（同时保护 recordFlowFailure 不双计）');

  // ============ 6) retry 语义：两次运行 = 两个事实 ============
  console.log('\n[6] FAILED → 重跑 → SUCCESS = 1F+1S（事实，非重复）');
  const t6 = newTask('k3-retry');
  forceStatus(t6.id, 'PLANNING');
  taskManager.fail(t6.id, new Error('第一次运行失败'));
  ok(siteMemory.getSite(SITE).history.failedTasks === 3, '第一次运行失败已记');
  // 模拟 retry 后的第二次运行（生产由 retry()→start() 驱动状态机 FAILED→PLANNING→…→RUNNING）
  forceStatus(t6.id, 'RUNNING');
  taskManager.complete(t6.id, { completedSteps: 3, totalSteps: 3 });
  const rec7 = siteMemory.getSite(SITE);
  ok(rec7.history.successTasks === 2 && rec7.history.failedTasks === 3,
    '第二次运行成功单独记（1F+1S 并存，不是覆盖也不是重复）', JSON.stringify(rec7.history));
  const f2 = rec7.commonFlows[GOAL];
  // 全序列：1S(5步) → 2F → 1F → 1S(3步) = samples 5 / rate 0.4 / avgSteps=round((5×4+3)/5)=5（失败不更新步数）
  ok(f2.samples === 5 && Math.abs(f2.successRate - 0.4) < 0.001 && f2.avgSteps === 5,
    '同目标五次运行聚合：samples=5 / successRate=0.4 / avgSteps=5', JSON.stringify(f2));

  // ============ 7) fail-open ============
  console.log('\n[7] fail-open：siteMemory 崩溃不改变任务终态');
  const t7 = newTask('k3-failopen');
  forceStatus(t7.id, 'RUNNING');
  const origRecord = siteMemory.recordTaskResult;
  siteMemory.recordTaskResult = () => { throw new Error('k3 模拟 siteMemory 崩溃'); };
  let done = null, threw = false;
  try { done = taskManager.complete(t7.id, { completedSteps: 2, totalSteps: 2 }); }
  catch (e) { threw = true; }
  siteMemory.recordTaskResult = origRecord;
  ok(!threw && done && done.status === 'SUCCESS', '写侧抛异常 → 任务仍 SUCCESS（telemetry 静默降级）');
  ok(siteMemory.getSite(SITE).history.successTasks === 2, '崩溃那次未写入（计数仍为 2，无半写状态）');

  // ============ 收尾 ============
  cleanup();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
