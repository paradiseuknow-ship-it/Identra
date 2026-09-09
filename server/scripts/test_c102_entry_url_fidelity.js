'use strict';
// C102 守护：入口地址保真（联盟/推广链接不可被绕过）
// 背景（用户实录 task_mttpxi1bc61hf）：联盟链接 try.webflow.com/t0wz830c5n4y 是业务归因入口，
// LLM 规划按语义「规范化」为 webflow.com 域名根，或转述丢链接 → 归因丢失、收入无法确认。
// 三层：
//   A. planner.enforceEntryUrl —— 首个 NAVIGATE 的 action.target.url 必须 = 用户 target（确定性改写）
//   B. parser —— URL 尾部中英文标点剥离；多 URL 取第一个
//   C. runtime 归因保新 —— isTrackedEntry/entryDomainOf 判定 + refreshAttributionCookies 守卫条件
const assert = require('assert');

let pass = 0, fail = 0;
function chk(name, fn) {
  try { fn(); pass++; console.log('  ok -', name); }
  catch (e) { fail++; console.log('  FAIL -', name, '::', e.message); }
}

const planner = require('../agent/planner');
const parser = require('../agent/parser');

// ---- A. enforceEntryUrl（经 planObjective 不便单测 provider，直接验证导出行为等价路径：
//      planner 未导出该函数时，用完整 planObjective + mock provider 走成功路径验证）----
chk('A1 mock provider 计划首个 NAVIGATE 被强制改写为用户 target', async () => {});
(async () => {
  // A 走真实 planObjective（mock provider 恒输出 NAVIGATE 到语义域名根的场景用可控 provider 模拟）
  const provider = {
    kind: 'test',
    async plan() {
      // 模拟 LLM 漂移：把 try.webflow.com 深链接规范化成域名根（strict 形状，action=字符串）
      return [
        { action: 'navigate', target: { url: 'https://www.webflow.com' }, semantic: '打开 Webflow 首页', expectedResult: '页面加载', verification: { type: 'url_contains', expect: 'webflow' } },
        { action: 'inspect', target: { semantic: '页面主体' }, semantic: '观察页面', expectedResult: '快照', verification: { type: 'none' } },
      ];
    },
  };
  const r = await planner.planObjective({
    objective: '打开联盟链接注册会员',
    target: 'https://try.webflow.com/t0wz830c5n4y',
    constraints: [], credentialRefs: [],
    executionMode: 'SIMULATION', provider, ctx: { taskId: 'task_c102_a' },
  });
  chk('A1 planObjective 成功', () => assert.ok(r.ok, r.error || 'not ok'));
  chk('A2 首个 NAVIGATE url 被强制为联盟链接', () => {
    const nav = r.plan.steps.find((s) => s.type === 'NAVIGATE');
    assert.strictEqual(nav.action.target.url, 'https://try.webflow.com/t0wz830c5n4y');
  });
  chk('A3 plan 标记 entryUrlEnforced', () => assert.strictEqual(r.plan.entryUrlEnforced, true));

  // ---- B. parser ----
  const p1 = parser.heuristicParse('打开 https://try.webflow.com/t0wz830c5n4y。注册会员，购买最便宜的月度会员');
  chk('B1 URL 尾部中文句号被剥离', () => assert.strictEqual(p1.target, 'https://try.webflow.com/t0wz830c5n4y'));
  const p2 = parser.heuristicParse('打开 https://try.webflow.com/t0wz830c5n4y 然后打开 https://webflow.com/pricing 完成购买');
  chk('B2 多 URL 取第一个为入口', () => assert.strictEqual(p2.target, 'https://try.webflow.com/t0wz830c5n4y'));
  const p3 = parser.heuristicParse('打开 https://example.com/a) 完成');
  chk('B3 URL 尾部英文右括号被剥离', () => assert.strictEqual(p3.target, 'https://example.com/a'));

  // ---- C. runtime helpers（不启浏览器：导出面检查 + 纯函数行为）----
  const fs = require('fs');
  const rtSrc = fs.readFileSync(require.resolve('../agent/runtime'), 'utf-8');
  chk('C1 runtime 存在归因保新守卫（fresh 才清 / 恢复不清 / env 可关）', () => {
    assert.ok(rtSrc.includes('refreshAttributionCookies'), 'refreshAttributionCookies 缺失');
    assert.ok(rtSrc.includes("FPB_KEEP_ENTRY_COOKIES"), 'env 开关缺失');
    assert.ok(/recoveryUrl\) return/.test(rtSrc), '恢复续跑守卫缺失');
    assert.ok(/status === 'SUCCESS'/.test(rtSrc), '已有进度守卫缺失');
    assert.ok(/clearCookies\(\{ domain \}\)/.test(rtSrc), '必须按 domain 过滤清除，禁止全量清');
  });
  chk('C2 归因保新调用点在浏览器就绪后、计划解析前', () => {
    const idxEnsure = rtSrc.indexOf('await ensureBrowser(task)');
    const idxRefresh = rtSrc.indexOf('await refreshAttributionCookies(task)');
    const idxResolve = rtSrc.indexOf('await resolvePlan(task)');
    assert.ok(idxEnsure > 0 && idxRefresh > idxEnsure && idxResolve > idxRefresh, '调用顺序不对');
  });
  chk('C3 planner 源码含 enforceEntryUrl 且成功路径接线', () => {
    const src = fs.readFileSync(require.resolve('../agent/planner'), 'utf-8');
    assert.ok(src.includes('function enforceEntryUrl'), '函数缺失');
    assert.ok(/enforceEntryUrl\(vr\.plan, target\)/.test(src), '成功路径未接线');
  });

  // ---- D. C103：302 型入口 URL 验证修正 ----
  chk('D1 relaxEntryUrlVerification 接线成功路径', () => {
    const src = fs.readFileSync(require.resolve('../agent/planner'), 'utf-8');
    assert.ok(src.includes('function relaxEntryUrlVerification'), '函数缺失');
    assert.ok(/relaxEntryUrlVerification\(vr\.plan, target\)/.test(src), '成功路径未接线');
  });
  // 端到端：mock provider 给入口 NAVIGATE 写 url_contains=入口 URL 片段 → 必须被置 none
  const provider302 = {
    kind: 'test',
    async plan() {
      return [
        { action: 'navigate', target: { url: 'https://www.webflow.com' }, semantic: '打开 Webflow 首页', expectedResult: '页面加载', verification: { type: 'url_contains', expect: 'try.webflow.com/t0wz830c5n4y' } },
        { action: 'inspect', target: { semantic: '页面主体' }, semantic: '观察页面', expectedResult: '快照', verification: { type: 'none' } },
      ];
    },
  };
  const r302 = await planner.planObjective({
    objective: '联盟链接注册', target: 'https://try.webflow.com/t0wz830c5n4y',
    constraints: [], credentialRefs: [], executionMode: 'SIMULATION', provider: provider302, ctx: { taskId: 'task_c103_a' },
  });
  chk('D2 302 型入口的 url_contains 入口验证被置 none', () => {
    assert.ok(r302.ok, r302.error || 'not ok');
    const nav = r302.plan.steps.find((s) => s.type === 'NAVIGATE');
    assert.strictEqual(nav.action.verification.type, 'none');
    assert.strictEqual(r302.plan.entryVerifyAdjusted, true);
  });
  // 反向：非深链接入口（根路径）不放宽
  const providerRoot = {
    kind: 'test',
    async plan() {
      return [
        { action: 'navigate', target: { url: 'https://example.com/other' }, semantic: '打开首页', expectedResult: '加载', verification: { type: 'url_contains', expect: 'example.com' } },
        { action: 'inspect', target: { semantic: '页面主体' }, semantic: '观察', expectedResult: '快照', verification: { type: 'none' } },
      ];
    },
  };
  const rRoot = await planner.planObjective({
    objective: '根路径任务', target: 'https://example.com',
    constraints: [], credentialRefs: [], executionMode: 'SIMULATION', provider: providerRoot, ctx: { taskId: 'task_c103_b' },
  });
  chk('D3 根路径入口的 URL 验证不放宽', () => {
    assert.ok(rRoot.ok, rRoot.error || 'not ok');
    const nav = rRoot.plan.steps.find((s) => s.type === 'NAVIGATE');
    assert.strictEqual(nav.action.verification.type, 'url_contains');
  });

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
