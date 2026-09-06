'use strict';

// B1 PENDING 残留 ROOT CAUSE 修复 — 针对性回归测试
//
// 背景（Final100 实证 rw.005/060/061/075，错误 id 与步骤位置错位是直接铁证）：
//   normalizeStrictToCanonical 把 plan 步骤统一重编号为 step_001..N；
//   runtime.tryReplan 直接 createStep(planStep.id) → replan 剩余步骤（从 step_001 重新
//   编号）与既有已 SUCCESS 步骤 id 冲突 → getStep 命中旧步骤 → 主循环「已终态跳过」
//   逻辑（liveStatus===SUCCESS → index++）误跳过 replan 新步骤 → 循环正常退出 →
//   B.4 收口守卫发现 PENDING 残留 → 任务 FAILED「任务完成但存在未成功步骤」。
//
// 修复内容（本测试锁定的契约）：
//   1. stepManager.uniqueStepId(taskId, baseId)：base 未占用原样返回；被占用追加
//      _rp 序号（再冲突递增）；空 base 原样透传（createStep 走 uid 兜底）。
//   2. runtime.tryReplan：挂载 replan 步骤前经 uniqueStepId 分配无冲突 id ——
//      关键不变量：挂载后 getStep(newId) 必须返回「新描述」而非旧 SUCCESS 步骤；
//      旧步骤（index 前）id/描述/状态完全不受影响；index 起旧步骤被移除。
//
// 纪律：断言真实 store 行为（真实 createStep/getStep/listSteps + 真实 tryReplan 接线），
//       不 eval 源码；不触碰验证门槛/Success Definition/replan 触发条件。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 FPB_DATA_DIR：必须在 require 任何 agent 模块之前设置（避免污染真实 store）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-replan-ids-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const planner = require('../agent/planner');
const stepManager = require('../agent/stepManager');
const taskManager = require('../agent/taskManager');
const store = require('../agent/store');
const runtime = require('../agent/runtime');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}

// 构造最小 task 记录（tryReplan 只读 task.id / task.replanCount）
function makeTask(id) {
  const task = {
    id, objective: '测试任务', status: 'RUNNING',
    planVersion: 'plan_v1', replanCount: 0,
    secretRefs: [], policy: {},
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  store.upsert('aiTasks', task);
  return task;
}

// 直连 store 建一个指定 id 的 step（绕过 plan 编号，模拟历史 SUCCESS 步骤）
// 状态经合法链转换：PENDING → RUNNING → SUCCESS（状态机唯一实现点约束）
function seedStep(taskId, planId, index, description, status) {
  const s = stepManager.createStep(taskId, { id: planId, description }, index);
  if (status === 'SUCCESS') {
    stepManager.setStepState(s.id, 'RUNNING');
    stepManager.setStepState(s.id, 'SUCCESS');
  }
  return s;
}

(async () => {
  console.log('== A. uniqueStepId 单元契约 ==');

  const t1 = makeTask('task_ut1');
  seedStep('task_ut1', 'step_001', 0, '旧导航', 'SUCCESS');

  await ok('A1 base 未被占用 → 原样返回', () => {
    assert.strictEqual(stepManager.uniqueStepId('task_ut1', 'step_009'), 'step_009');
  });

  await ok('A2 base 被占用 → 追加 _rp1', () => {
    assert.strictEqual(stepManager.uniqueStepId('task_ut1', 'step_001'), 'step_001_rp1');
  });

  await ok('A3 _rp1 也被占用 → 递增到 _rp2', () => {
    stepManager.createStep('task_ut1', { id: 'step_001_rp1', description: '占位' }, 5);
    assert.strictEqual(stepManager.uniqueStepId('task_ut1', 'step_001'), 'step_001_rp2');
  });

  await ok('A4 空 base → 原样透传（createStep 走 uid 兜底）', () => {
    assert.strictEqual(stepManager.uniqueStepId('task_ut1', ''), '');
    assert.strictEqual(stepManager.uniqueStepId('task_ut1', undefined), undefined);
  });

  console.log('== B. tryReplan 接线（rw.061 最小重放）==');

  // 场景：9 步注册两阶段任务；执行到 index=4（提交张三）失败 → replan 返回 5 个
  // 重编号步骤 step_001..step_005（新描述）。修复前：新 001..004 与旧 SUCCESS 0..3 冲突。
  const t2 = makeTask('task_rp61');
  const oldDesc = [
    '导航到会员注册表单页面', '在姓名输入框填写张三', '在邮箱输入框填写张三的邮箱',
    '在手机号输入框填写张三的手机号', '点击提交注册按钮，提交张三的注册信息',
    '在姓名输入框填写李四', '在邮箱输入框填写李四的邮箱', '在手机号输入框填写李四的手机号',
    '点击提交注册按钮，提交李四的注册信息',
  ];
  const oldSteps = oldDesc.map((d, i) => {
    const st = i < 4 ? 'SUCCESS' : null;
    const s = stepManager.createStep('task_rp61', { id: 'step_00' + (i + 1), description: d }, i);
    if (st) { stepManager.setStepState(s.id, 'RUNNING'); stepManager.setStepState(s.id, 'SUCCESS'); }
    return s;
  });

  const newDesc = [
    '重规划：点击提交注册按钮提交张三信息',
    '重规划：填写李四姓名', '重规划：填写李四邮箱', '重规划：填写李四手机号',
    '重规划：提交李四注册信息',
  ];
  planner.replan = async () => ({
    ok: true,
    steps: newDesc.map((d, i) => ({
      id: 'step_00' + (i + 1), type: 'ACT', description: d, expectedOutcome: d,
      risk: 'LOW', action: { type: 'click', target: { semantic: d }, risk: 'LOW', verification: { type: 'none' } },
    })),
  });

  await ok('B1 tryReplan 返回 ok 且新步骤挂载于 index..index+n-1', async () => {
    const r = await runtime.tryReplan(t2, { url: 'http://x', elements: [] }, oldSteps, 4);
    assert.strictEqual(r.ok, true, 'tryReplan 应成功：' + JSON.stringify(r));
    const all = stepManager.listSteps('task_rp61');
    assert.strictEqual(all.length, 9, '总数应仍为 9（4 旧 + 5 新），实际 ' + all.length);
    for (let i = 4; i <= 8; i++) assert.strictEqual(all[i].index, i, 'index 应连续');
  });

  await ok('B2 关键不变量：getStep(新id) 返回新描述（修复前命中旧 SUCCESS 步骤）', () => {
    const all = stepManager.listSteps('task_rp61');
    for (let i = 4; i <= 8; i++) {
      const s = all[i];
      assert.strictEqual(s.description, newDesc[i - 4], `index=${i} 应为新步骤`);
      assert.strictEqual(stepManager.getStep(s.id).description, newDesc[i - 4],
        `getStep(${s.id}) 必须返回新描述——这是「已终态跳过」误跳的直接触发点`);
      // 只禁止占用「仍存活」旧步骤的 id（index 起旧步骤已被移除，同 id 复用是合法且无冲突的）
      const forbidden = 'task_rp61_step_00' + (i - 3);
      if (i - 3 <= 4) { // 旧 step_001..004 仍存活（index 0..3）
        assert.notStrictEqual(s.id, forbidden, '新步骤不得占用仍存活的旧 id');
      }
    }
  });

  await ok('B3 旧 SUCCESS 步骤（index 0..3）id/描述/状态零改动', () => {
    for (let i = 0; i < 4; i++) {
      const s = stepManager.getStep('task_rp61_step_00' + (i + 1));
      assert.ok(s, '旧步骤应存在');
      assert.strictEqual(s.description, oldDesc[i]);
      assert.strictEqual(s.status, 'SUCCESS');
    }
  });

  await ok('B4 index 起旧步骤已从 store 移除（无幽灵记录）', () => {
    for (let i = 4; i < 9; i++) {
      const ghost = stepManager.getStep('task_rp61_step_00' + (i + 1) + '_rp1');
      // 新步骤 id 形如 step_00N_rp1；同 id 不得存在两条记录（listSteps 去重计数）
      const cnt = stepManager.listSteps('task_rp61').filter((x) => x.id === ghost && ghost).length;
      assert.ok(cnt <= 1);
    }
    const ids = stepManager.listSteps('task_rp61').map((s) => s.id);
    assert.strictEqual(new Set(ids).size, ids.length, '全 store step id 必须唯一');
  });

  await ok('B5 主循环已终态跳过逻辑不会误跳新 replan 步骤（liveStatus 必为 PENDING）', () => {
    // 复现修复前的误跳机制：runtime 主循环按 step.id 查 live 状态。
    const all = stepManager.listSteps('task_rp61');
    for (let i = 4; i <= 8; i++) {
      const live = (stepManager.getStep(all[i].id) || {}).status;
      assert.strictEqual(live, 'PENDING', `index=${i} live 状态必须反映新步骤（PENDING）`);
    }
  });

  console.log('== C. 二次 replan（_rp 序号递增）与无 id 步骤 ==');

  const t3 = makeTask('task_rp2');
  const base3 = ['步骤一', '步骤二', '步骤三'].map((d, i) => {
    const s = stepManager.createStep('task_rp2', { id: 'step_00' + (i + 1), description: d }, i);
    if (i < 2) { stepManager.setStepState(s.id, 'RUNNING'); stepManager.setStepState(s.id, 'SUCCESS'); }
    return s;
  });
  planner.replan = async () => ({
    ok: true,
    steps: [
      { id: 'step_001', type: 'ACT', description: '二次重规划A', expectedOutcome: '', risk: 'LOW', action: { type: 'click', target: { semantic: 'a' }, risk: 'LOW', verification: { type: 'none' } } },
      { type: 'ACT', description: '无id步骤', expectedOutcome: '', risk: 'LOW', action: { type: 'click', target: { semantic: 'b' }, risk: 'LOW', verification: { type: 'none' } } },
    ],
  });

  await ok('C1 第二次 replan：重编号 id 再次冲突 → _rp 递增 + 无 id 走 uid', async () => {
    const r = await runtime.tryReplan(t3, { url: 'http://x', elements: [] }, base3, 1);
    assert.strictEqual(r.ok, true);
    const all = stepManager.listSteps('task_rp2');
    const ids = all.map((s) => s.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'id 唯一');
    const noId = all.find((s) => s.description === '无id步骤');
    assert.ok(noId && noId.id, '无 id 步骤应由 createStep uid 兜底生成 id');
    const rpA = all.find((s) => s.description === '二次重规划A');
    assert.ok(/_rp\d+$/.test(rpA.id.replace('task_rp2_', '')), '冲突 id 应带 _rp 序号: ' + rpA.id);
    assert.strictEqual(stepManager.getStep(rpA.id).description, '二次重规划A');
  });

  await ok('C2 replan 失败 → {ok:false}，store 零改动', async () => {
    const before = stepManager.listSteps('task_rp2').map((s) => s.id);
    planner.replan = async () => ({ ok: false, error: 'replan 无步骤' });
    const r = await runtime.tryReplan(t3, { url: 'http://x', elements: [] }, base3, 1);
    assert.strictEqual(r.ok, false);
    const after = stepManager.listSteps('task_rp2').map((s) => s.id);
    assert.deepStrictEqual(after, before, '失败路径不得改动 store');
  });

  await ok('C3 replan 抛异常 → {ok:false}（防御契约保持）', async () => {
    planner.replan = async () => { throw new Error('LLM 超时'); };
    const r = await runtime.tryReplan(t3, { url: 'http://x', elements: [] }, base3, 1);
    assert.strictEqual(r.ok, false);
  });

  console.log(passed + ' passed' + (process.exitCode ? '（存在失败）' : ''));
})();
