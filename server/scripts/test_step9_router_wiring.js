'use strict';

// STEP 9 — CAP-K2：intelligenceRouter 决策接入执行链（browserless）。
// 覆盖：
//   1) toIntelligence：Router 结果 → 精简 hints（profileId/flowId/expectedSuccess/warnings）
//   2) enhanceTaskInput：未指定 profileId 时 Router 补齐；显式指定永不覆盖
//   3) fail-open：Router 抛异常不阻断创建，input 原样返回
//   4) 空 objective/targetUrl → 不咨询 Router
//   5) createTask 落库 routerHints（真实 store）
//   6) contextBuilder.build 把 task.routerHints 透传进 context；无 hints → null
//   7) planner.contextBlock 与 deepseek.buildContextSection（两个序列化点）都渲染 warnings；
//      无 hints 不渲染（防死护栏：断言「有 hints 必出、无 hints 必不出」两侧）
//   8) 端到端：createTask(经 enhancer) → getTask → build → contextBlock 含失败经验文本（无 LLM）
// 用法：node server/scripts/test_step9_router_wiring.js

const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const contextBuilder = require('../agent/contextBuilder');
const planner = require('../agent/planner');
const deepseek = require('../agent/llm/providers/deepseek');
const router = require('../agent/intelligence/router');
const { enhanceTaskInput, toIntelligence } = require('../agent/intelligence/router/taskInputEnhancer');
const analyzer = require('../agent/intelligence/profile/profileAnalyzer');
const failureKnowledge = require('../agent/intelligence/failure/failureKnowledge');

const SITE = 'capk2.test';
const PROF = 'prof_capk2_a';
const TARGET = 'http://' + SITE + '/page';
const OBJECTIVE = 'capk2 在测试站点击提交按钮';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
const createdTasks = [];
function mkTask(input) { const t = taskManager.createTask(input); createdTasks.push(t.id); return t; }

function cleanup() {
  store.write('aiFailureKnowledge', store.read('aiFailureKnowledge', []).filter((r) => r.site !== SITE));
  store.write('aiProfileScores', store.read('aiProfileScores', []).filter((r) => r.profileId !== PROF));
  for (const id of createdTasks) { try { taskManager.deleteTask(id); } catch (e) {} }
}

function main() {
  console.log('\n=== 播种经验（Profile 评分 + 失败知识）===');
  // Profile：该站 2 次成功 → matcher 有 site 样本
  analyzer.recordTaskOutcome(PROF, SITE, true, { name: 'CAP-K2 环境 A', region: 'US' });
  analyzer.recordTaskOutcome(PROF, SITE, true, { name: 'CAP-K2 环境 A', region: 'US' });
  // 失败知识：ACTIVE 经验一条 → failure advisor 应产出 warning
  const fk = failureKnowledge.record(
    SITE, 'ELEMENT_NOT_FOUND', { actionType: 'click' },
    { errorType: 'ELEMENT_NOT_FOUND' },
    { strategy: 'SEMANTIC_RELOCATE', steps: ['按语义重新定位目标元素'] },
  );
  ok(!!(fk && (fk.ok !== false)), '失败经验落库成功', fk && fk.error);

  console.log('\n=== 1) toIntelligence 形状 ===');
  const d = router.decide({ objective: OBJECTIVE, targetUrl: TARGET, useCache: false });
  const intel = toIntelligence(d);
  ok(!!intel, 'decide → toIntelligence 非空');
  ok(intel.profileId === PROF, 'profileId 取自 Router 推荐（= ' + intel.profileId + '）');
  ok(Array.isArray(intel.warnings) && intel.warnings.some((w) => String(w).includes('ELEMENT_NOT_FOUND')),
    '失败经验进入 warnings（含 ELEMENT_NOT_FOUND）', JSON.stringify(intel.warnings));
  ok(toIntelligence(null) === null && toIntelligence({}) === null, '空输入 → null（fail-safe）');

  console.log('\n=== 2) enhanceTaskInput ===');
  const r1 = enhanceTaskInput({ objective: OBJECTIVE, targetUrl: TARGET });
  ok(r1.intelligence && r1.intelligence.profileId === PROF, '未指定 profileId → Router 补齐');
  ok(r1.input.profileId === PROF, 'enhanced input.profileId 已补齐');
  ok(r1.input.routerHints && Array.isArray(r1.input.routerHints.warnings), 'routerHints 已挂到 input');

  const r2 = enhanceTaskInput({ objective: OBJECTIVE, targetUrl: TARGET, profileId: 'prof_capk2_user_pick' });
  ok(r2.input.profileId === 'prof_capk2_user_pick', '显式 profileId 永不被 Router 覆盖');

  const r3 = enhanceTaskInput({ objective: OBJECTIVE, targetUrl: TARGET, profileId: null });
  ok(r3.input.profileId === PROF, '显式 null 同视为未指定（补齐）');

  const r4 = enhanceTaskInput({ name: '无目标占位任务' });
  ok(r4.intelligence === null && r4.input.profileId === undefined && !('routerHints' in r4.input),
    '无 objective/targetUrl → 不咨询 Router，input 原样');

  console.log('\n=== 3) fail-open ===');
  // 注意：enhancer 直接 require intelligenceRouter（内层模块），router/index.js 的 decide
  // 只是 require 时的函数引用拷贝 —— stub 必须打在内层模块上才真正生效。
  const innerRouter = require('../agent/intelligence/router/intelligenceRouter');
  const origDecide = innerRouter.decide;
  innerRouter.decide = () => { throw new Error('capk2 模拟 Router 崩溃'); };
  let r5 = null, threw = false;
  try { r5 = enhanceTaskInput({ objective: OBJECTIVE, targetUrl: TARGET, profileId: 'prof_keep' }); }
  catch (e) { threw = true; }
  innerRouter.decide = origDecide;
  ok(!threw, 'Router 崩溃不阻断创建');
  ok(r5 && r5.intelligence === null && r5.input.profileId === 'prof_keep' && !('routerHints' in r5.input),
    'fail-open：input 原样、无 hints');

  console.log('\n=== 4) createTask 落库 routerHints ===');
  const t1 = mkTask(r1.input);
  const back = taskManager.getTask(t1.id);
  ok(back && back.routerHints && back.routerHints.profileId === PROF, 'routerHints 随任务持久化');
  ok(back.routerHints.warnings.length === r1.intelligence.warnings.length, 'warnings 落库无损');
  const t2 = mkTask({ name: 'capk2 无 hints 任务', objective: 'capk2 无 hints' });
  const back2 = taskManager.getTask(t2.id);
  ok(back2 && back2.routerHints === null, '未咨询 Router 的任务 routerHints=null');

  console.log('\n=== 5) contextBuilder 透传 ===');
  // runtime.resolvePlan 的真实包装：ctx = { taskId, executionId, context: build(...) }
  const ctx1 = { context: contextBuilder.build({ task: back }) };
  ok(ctx1.context.routerHints && ctx1.context.routerHints.warnings.length >= 1,
    'build({task}) → context.routerHints.warnings 透传');
  const ctx2 = { context: contextBuilder.build({ task: back2 }) };
  ok(ctx2.context.routerHints === null, '无 hints → context.routerHints=null');

  console.log('\n=== 6) 两个序列化点渲染（有必出/无必不出）===');
  const block1 = planner.contextBlock(ctx1);
  ok(block1.includes('Router 经验提示'), 'planner.contextBlock 渲染 hints 头');
  ok(block1.includes('ELEMENT_NOT_FOUND'), 'planner.contextBlock 含失败类别文本');
  const block2 = planner.contextBlock(ctx2);
  ok(!block2.includes('Router 经验提示'), 'planner.contextBlock 无 hints 不渲染（防死护栏）');
  const ds1 = deepseek.buildContextSection(ctx1);
  ok(ds1.includes('Router 经验提示') && ds1.includes('ELEMENT_NOT_FOUND'),
    'deepseek.buildContextSection 同步渲染（第二序列化点）');
  const ds2 = deepseek.buildContextSection(ctx2);
  ok(!ds2.includes('Router 经验提示'), 'deepseek 无 hints 不渲染');

  console.log('\n=== 7) 端到端链路（createTask→getTask→build→contextBlock，无 LLM）===');
  const { input: eIn } = enhanceTaskInput({ objective: OBJECTIVE, targetUrl: TARGET });
  const eTask = mkTask(eIn);
  const eCtx = { context: contextBuilder.build({ task: taskManager.getTask(eTask.id) }) };
  const eBlock = planner.contextBlock(eCtx);
  ok(eBlock.includes('Router 经验提示') && eBlock.includes('SEMANTIC_RELOCATE'),
    '失败经验的 solution.strategy 一路进到 Planner prompt');

  console.log('\n========================================');
  console.log('STEP 9（CAP-K2）: ' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exitCode = 1;
}

try { cleanup(); } catch (e) {}
try { main(); } finally { try { cleanup(); } catch (e) {} }
