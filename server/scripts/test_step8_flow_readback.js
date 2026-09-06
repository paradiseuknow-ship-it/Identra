'use strict';

// STEP 8 — CAP-K1：flowMemory 读侧回流 + 失败反馈闭环（browserless，纯逻辑 + 真实 store）。
// 覆盖：
//   1) recordFlowFromTask 写读保真（actionType/field/value/credentialRef/verification 落库）
//   2) 敏感值守卫（password 字面量绝不落库；credentialRef 引用可落）
//   3) tryFlowPlan 命中 → 重建 typed action 且通过 schema/plan.validatePlan
//   4) planWithMemory 命中时 LLM 零调用（spy 断言）
//   5) 校验门 fail-safe：value/credentialRef 双缺的 fill → validatePlan 拒绝 → 降级 LLM
//   6) 失败反馈闭环（真实 taskManager.fail / escalate → recordOutcomeFlow(false) → 跌破阈值）
//   7) runtime.resolvePlan 生产路径真实命中 flow（不触浏览器：flow 分支在规划观察之前）
// 用法：node server/scripts/test_step8_flow_readback.js

const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const stepManager = require('../agent/stepManager');
const fm = require('../agent/intelligence/flowMemory');
const fp = require('../agent/intelligence/flowPlanner');
const runtime = require('../agent/runtime');

const SITE_HOST = 'flowrb.test';
const GOAL_MAIN = '登录 flowrb 测试站';
const GOAL_PLAIN_PW = 'flowrb 明文密码任务';
const GOAL_RUNTIME = 'flowrb runtime 命中';
const TARGET_MAIN = 'http://flowrb.test/login';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

function cleanup() {
  store.write('aiFlowMemory', store.read('aiFlowMemory', []).filter((r) => r.site !== SITE_HOST));
  store.write('aiTasks', store.read('aiTasks', []).filter((t) => !(t.id || '').startsWith('task_rb')));
  store.write('aiSteps', store.read('aiSteps', []).filter((s) => !(s.taskId || '').startsWith('task_rb')));
}

// 构造 canonical plan step（与 planner.planObjective 产出同形）
function pstep(id, type, description, action, risk) {
  return { id, type, description, expectedOutcome: description, risk: risk || 'MEDIUM', action };
}

// 造一组真实登录流步骤并经 stepManager.createStep 落库（与生产 createStep 同路径）
function seedTaskSteps(taskId, targetUrl, pwMode) {
  const plan = [
    pstep('step_001', 'NAVIGATE', '打开登录页', {
      type: 'navigate', target: { url: targetUrl }, risk: 'LOW',
      verification: { type: 'url_contains', expect: '/login' },
    }, 'LOW'),
    pstep('step_002', 'ACT', '填写邮箱', {
      type: 'fill', target: { field: 'email', semantic: '邮箱' }, value: 'a@b.com', risk: 'MEDIUM',
      verification: { type: 'text_present', expect: '登录' },
    }),
    pstep('step_003', 'ACT', '填写密码', pwMode === 'plain'
      ? { type: 'fill', target: { field: 'password', semantic: '密码' }, value: 'Secret123!', risk: 'HIGH', verification: { type: 'element_present', expect: 'password' } }
      : { type: 'fill', target: { field: 'password', semantic: '密码' }, credentialRef: 'vault:rb_pw', risk: 'HIGH', verification: { type: 'element_present', expect: 'password' } }, 'HIGH'),
    pstep('step_004', 'ACT', '点击登录', {
      type: 'click', target: { field: 'loginBtn', semantic: '登录按钮' }, risk: 'MEDIUM',
      verification: { type: 'url_contains', expect: 'dashboard' },
    }),
    pstep('step_005', 'ACT', '选择地区', {
      type: 'select', target: { field: 'country', semantic: '地区选择' }, value: 'CN', risk: 'MEDIUM',
      verification: { type: 'element_present', expect: 'country' },
    }),
  ];
  plan.forEach((s, i) => stepManager.createStep(taskId, s, i));
  return plan.length;
}

async function main() {
  console.log('== STEP 8 / CAP-K1: flowMemory 读侧回流 + 失败反馈闭环 ==');
  cleanup();

  // ============ 1) 写读保真 ============
  console.log('\n[1] recordFlowFromTask 写读保真');
  const tA = 'task_rb_a';
  seedTaskSteps(tA, TARGET_MAIN, 'ref');
  const flowA = fm.recordFlowFromTask({ id: tA, targetUrl: TARGET_MAIN, objective: GOAL_MAIN });
  ok(!!flowA, '成功任务提炼出 flow');
  const recA = fm.getByKey(SITE_HOST, GOAL_MAIN);
  ok(!!recA && recA.id === flowA.id, 'getByKey 按 site|goal 命中同一条');
  ok(recA.confidence >= 0.85, '单次成功后 confidence ≥ 0.85（阈值可复用）', String(recA.confidence));
  const st = recA.states;
  ok(st[1].actionType === 'fill' && st[1].field === 'email' && st[1].value === 'a@b.com',
    'fill 步骤保留 actionType/field/value', JSON.stringify(st[1]));
  ok(st[2].credentialRef === 'vault:rb_pw' && st[2].value === undefined,
    '凭据字段只存 credentialRef，明文 value 绝不落库', JSON.stringify(st[2]));
  ok(st[1].verification && st[1].verification.type === 'text_present', 'verification 原样保留');
  ok(st[3].actionType === 'click' && st[4].actionType === 'select' && st[4].value === 'CN',
    'click/select 类型与值保留');
  ok(st[0].next === 'step_002' && st[4].next === 'DONE', '状态机 next 链完整');

  // ============ 2) tryFlowPlan 命中 ============
  console.log('\n[2] tryFlowPlan 命中 + Plan Schema 门');
  const hit = fp.tryFlowPlan(TARGET_MAIN, GOAL_MAIN);
  ok(!!hit, '高置信度 → 命中', hit ? 'null' : '');
  ok(hit && hit.plan.steps.length === 5, '重建计划步数一致', hit && String(hit.plan.steps.length));
  ok(hit && hit.plan.steps[1].action.type === 'fill' && hit.plan.steps[1].action.value === 'a@b.com',
    '重建为 fill（旧实现退化为 click）', hit && JSON.stringify(hit.plan.steps[1].action));
  ok(hit && hit.plan.steps[2].action.credentialRef === 'vault:rb_pw', 'credentialRef 回传');
  ok(hit && hit.plan.steps[3].action.type === 'click', 'click 保持 click');
  ok(hit && hit.plan.fromFlow === true && !!hit.flowId, 'plan.fromFlow 与 flowId 就位');
  ok(hit && hit.confidence >= 0.85, '返回置信度');

  // ============ 3) planWithMemory LLM 零调用 ============
  console.log('\n[3] planWithMemory 命中时跳过 LLM');
  let llmCalled = false;
  const spy = { plan: async () => { llmCalled = true; return []; }, kind: 'spy' };
  const prHit = await fp.planWithMemory({ objective: GOAL_MAIN, target: TARGET_MAIN, executionMode: 'AUTONOMOUS', provider: spy, ctx: {} });
  ok(prHit.ok && prHit.fromFlow === true && llmCalled === false, '命中 flow → provider.plan 未被调用', 'llmCalled=' + llmCalled);
  const prMiss = await fp.planWithMemory({ objective: '完全无关的目标 xyz', target: TARGET_MAIN, executionMode: 'AUTONOMOUS', provider: {}, ctx: {} });
  ok(prMiss.ok === false && !prMiss.fromFlow, '未命中 → 走 LLM 路径（无能力 provider 时明确失败，不假装成功）');

  // ============ 4) 校验门 fail-safe ============
  console.log('\n[4] 校验门 fail-safe：双缺 fill 降级 LLM');
  const tB = 'task_rb_b';
  seedTaskSteps(tB, TARGET_MAIN, 'plain'); // 明文密码 → 提炼侧丢弃 value → fill 无 value/credentialRef
  const flowB = fm.recordFlowFromTask({ id: tB, targetUrl: TARGET_MAIN, objective: GOAL_PLAIN_PW });
  ok(!!flowB, '明文密码 flow 本身可落库（值已剥离）');
  const recB = fm.getByKey(SITE_HOST, GOAL_PLAIN_PW);
  ok(recB && recB.states[2].value === undefined && !recB.states[2].credentialRef,
    '敏感值确实被剥离', recB && JSON.stringify(recB.states[2]));
  const hitB = fp.tryFlowPlan(TARGET_MAIN, GOAL_PLAIN_PW);
  ok(hitB === null, '双缺 fill 被 validatePlan 拒绝 → 返回 null 降级 LLM，绝不带病重放', hitB ? '意外命中' : '');

  // ============ 5) 失败反馈闭环 ============
  console.log('\n[5] 失败反馈闭环（真实 fail / escalate）');
  const t1 = taskManager.createTask({ name: 'rb1', objective: GOAL_MAIN, targetUrl: TARGET_MAIN, profileId: null });
  taskManager.markFlowUsed(t1.id, flowA.id, recA.confidence);
  ok(taskManager.getTask(t1.id).flowUsedId === flowA.id, 'markFlowUsed 落库');
  // 测试捷径：直改状态到 PLANNING 使 PLANNING→FAILED 合法（生产中由 start() 驱动）
  const t1b = taskManager.getTask(t1.id); t1b.status = 'PLANNING'; store.upsert('aiTasks', t1b);
  taskManager.fail(t1.id, new Error('rb-test 失败'));
  const afterFail = fm.getByKey(SITE_HOST, GOAL_MAIN);
  ok(Math.abs(afterFail.confidence - 0.5) < 0.02, '1 成功 + 1 失败 → confidence 0.5（跌破 0.85）', String(afterFail.confidence));
  ok(fp.tryFlowPlan(TARGET_MAIN, GOAL_MAIN) === null, '失败反馈后同目标降级 LLM，过期 flow 不再重放');
  const t2 = taskManager.createTask({ name: 'rb2', objective: GOAL_MAIN, targetUrl: TARGET_MAIN, profileId: null });
  taskManager.markFlowUsed(t2.id, flowA.id, afterFail.confidence);
  const t2b = taskManager.getTask(t2.id); t2b.status = 'RUNNING'; store.upsert('aiTasks', t2b);
  taskManager.escalate(t2.id, new Error('rb-test 升级'), { reason: 'verification' });
  const afterEsc = fm.getByKey(SITE_HOST, GOAL_MAIN);
  ok(afterEsc.confidence < afterFail.confidence, 'escalate 同样吃失败反馈（继续衰减）',
    afterFail.confidence + ' → ' + afterEsc.confidence);
  ok(fp.tryFlowPlan(TARGET_MAIN, GOAL_MAIN) === null, '衰减后持续走 LLM（保守策略：烧毁的 flow 不自动复活）');

  // ============ 6) runtime.resolvePlan 生产路径真实命中 ============
  console.log('\n[6] runtime.resolvePlan 真实命中 flow（browserless）');
  const tC = 'task_rb_c';
  seedTaskSteps(tC, 'http://flowrb.test/rt', 'ref');
  const flowC = fm.recordFlowFromTask({ id: tC, targetUrl: 'http://flowrb.test/rt', objective: GOAL_RUNTIME });
  ok(!!flowC && flowC.confidence >= 0.85, 'runtime 场景 flow 就位');
  const t3 = taskManager.createTask({ name: 'rb3', objective: GOAL_RUNTIME, targetUrl: 'http://flowrb.test/rt', profileId: null });
  const steps = await runtime.resolvePlan(taskManager.getTask(t3.id));
  ok(Array.isArray(steps) && steps.length === 5, 'resolvePlan 返回 flow 重放步骤（未触浏览器）',
    steps && steps.length);
  ok(steps[1] && steps[1].action && steps[1].action.type === 'fill' && steps[1].action.value === 'a@b.com',
    '生产步骤是保真的 fill（不是旧实现的 click）', steps[1] && JSON.stringify(steps[1].action || {}));
  const t3b = taskManager.getTask(t3.id);
  ok(t3b.flowUsedId === flowC.id && t3b.flowConfidence >= 0.85, '任务记录 flowUsedId（失败反馈可用）',
    JSON.stringify({ flowUsedId: t3b.flowUsedId, flowConfidence: t3b.flowConfidence }));
  // 交叉验证：若无 flow 命中，resolvePlan 会走观察+LLM（browserless 下不做阴性对照，已由 [2][4] 覆盖读侧 null 路径）

  cleanup();
  console.log('\nPASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); cleanup(); process.exit(1); });
