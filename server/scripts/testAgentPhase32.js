'use strict';

// Phase 3.2 验收：Element Memory 加固 5 项 + Flow Intelligence（状态机式流程记忆）。
// 纯逻辑（无浏览器）：直接驱动 intelligence 模块 + planWithMemory 决策 + 真实 complete 落库路径。
// 用法：node server/scripts/testAgentPhase32.js
//
// ★ C138 数据根隔离：本套件此前直接读写真实 server/data（回归扫描面缺口使「已做数据根隔离」
//   这一入集前提从未被施加；其 clearAll() 会清空 aiElementMemory/aiFlowMemory/aiSiteMemory）。
//   必须在 require 任何业务模块**之前**设置 —— store 的数据根是模块加载期解析的。

process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c138_p32_' + Date.now());

const store = require('../agent/store');
const planner = require('../agent/planner');
const taskManager = require('../agent/taskManager');
const em = require('../agent/intelligence/elementMemory');
const fm = require('../agent/intelligence/flowMemory');
const fp = require('../agent/intelligence/flowPlanner');
const fschema = require('../agent/intelligence/flowSchema');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

function clearAll() {
  store.write('aiElementMemory', []);
  store.write('aiFlowMemory', []);
  store.write('aiSiteMemory', []);
}

async function main() {
  console.log('== Phase 3.2 Element Memory 加固 + Flow Intelligence 验收 ==');
  clearAll();

  // ============ A) Element Memory 加固 5 项 ============
  console.log('\n[A] Element Memory 加固');

  // A1) context 条件：同按钮不同场景 → 不同记忆
  em.recordSuccess('ctx.test', 'submit', { text: 'Continue', role: 'button' }, { type: 'ai_success' }, { urlPattern: '/signup' });
  em.recordSuccess('ctx.test', 'submit', { text: 'Proceed', role: 'button' }, { type: 'ai_success' }, { urlPattern: '/login' });
  const cSignup = em.getCandidate('ctx.test', 'submit', { url: 'http://ctx.test/signup', elements: [{ text: 'Continue' }] });
  const cLogin = em.getCandidate('ctx.test', 'submit', { url: 'http://ctx.test/login', elements: [{ text: 'Proceed' }] });
  ok(cSignup && cSignup.pattern.text === 'Continue', 'A1 context 命中 /signup → Continue', cSignup && cSignup.pattern.text);
  ok(cLogin && cLogin.pattern.text === 'Proceed', 'A1 context 命中 /login → Proceed', cLogin && cLogin.pattern.text);

  // A2) hit 统计
  ok(cSignup && cSignup.record.stats.memoryHits >= 1 && cSignup.record.stats.hits >= 1, 'A2 memoryHits/hits 统计', cSignup && JSON.stringify(cSignup.record.stats));
  em.recordSuccess('stat.test', 'submit', { text: 'Go', role: 'button' }, { type: 'ai_success' });
  const before = em.getRecord('stat.test', 'submit').stats.semanticFallback || 0;
  em.noteSemanticFallback('stat.test', 'submit');
  const after = em.getRecord('stat.test', 'submit').stats.semanticFallback || 0;
  ok(after === before + 1, 'A2 semanticFallback 统计 +1', String(after));

  // A3) conflict resolver：per-pattern successRate 排序，优先高成功率文本
  em.recordSuccess('conf.test', 'submit', { text: 'Continue', role: 'button' }, { type: 'ai_success' });
  for (let i = 0; i < 9; i++) em.recordSuccess('conf.test', 'submit', { text: 'Proceed', role: 'button' }, { type: 'ai_success' });
  // 降低 Continue 模式成功率（每次重读最新 Continue pattern 避免过期引用）
  for (let i = 0; i < 2; i++) {
    const recNow = em.getRecord('conf.test', 'submit');
    const cp = (recNow.patterns || []).find((p) => p.text === 'Continue');
    em.recordFailure('conf.test', 'submit', null, cp);
  }
  const recNow = em.getRecord('conf.test', 'submit');
  const contPat = (recNow.patterns || []).find((p) => p.text === 'Continue');
  const proceedPat = (recNow.patterns || []).find((p) => p.text === 'Proceed');
  ok(recNow.confidence >= 0.8, 'A3 记录置信度≥0.8（候选可用）', String(recNow.confidence));
  const cand = em.getCandidate('conf.test', 'submit', { url: 'http://conf.test/x', elements: [{ text: 'Continue', role: 'button' }, { text: 'Proceed', role: 'button' }] });
  ok(cand && cand.pattern.text === 'Proceed', 'A3 冲突解析优先高成功率 Proceed', cand && cand.pattern.text);
  ok(proceedPat.successRate > contPat.successRate, 'A3 per-pattern successRate 已分离', `Proceed=${proceedPat.successRate} Continue=${contPat.successRate}`);

  // A4) elementType 扩展（不止按钮）
  em.recordSuccess('type.test', 'email', { tag: 'input', inputType: 'text' }, { type: 'ai_success' });
  ok(em.getRecord('type.test', 'email').elementType === 'input', 'A4 记录 input 类型', em.getRecord('type.test', 'email').elementType);

  // A5) export / import 经验包
  const pack = fm.exportPack('ctx.test').pack;
  ok(pack && pack.format === 'ai-browser-operator@3.2' && Array.isArray(pack.elementMemory), 'A5 导出经验包', pack && pack.format);
  store.write('aiElementMemory', store.read('aiElementMemory', []).filter((r) => r.site !== 'ctx.test'));
  const imp = fm.importPack({ pack });
  ok(imp.ok && imp.imported > 0, 'A5 导入经验包还原', JSON.stringify(imp));
  ok(em.getRecord('ctx.test', 'submit', { urlPattern: '/signup' }) != null, 'A5 导入后可查回', 'ok');

  // ---- 回归：Phase 3.1 语义保持（patterns 演化 / Case2 零推理 / 低置信降级）----
  console.log('\n[A-reg] Phase 3.1 语义回归');
  clearAll();
  em.recordSuccess('u1.test', 'submit', { text: 'Continue', role: 'button', tag: 'button' }, { type: 'ai_success' });
  ok(em.getRecord('u1.test', 'submit').patterns.length === 1, '回归 Case1 保存 1 pattern');
  em.recordSuccess('u1.test', 'submit', { text: 'Proceed', role: 'button', tag: 'button' }, { type: 'ai_success' });
  const r2 = em.getRecord('u1.test', 'submit');
  ok(r2.version === 2 && r2.patterns.length === 2, '回归 Case2 pattern 演化 version2', 'version=' + r2.version);
  const hit = em.getCandidate('u1.test', 'submit', { url: 'http://u1.test/form', elements: [{ text: 'Proceed' }] });
  ok(hit && hit.fromMemory === true, '回归 Case2 命中 Memory 零推理', hit && hit.fromMemory);
  em.recordSuccess('u3.test', 'submit', { text: 'Continue', role: 'button' }, { type: 'ai_success' });
  for (let i = 0; i < 5; i++) em.recordFailure('u3.test', 'submit');
  const raw3 = em.listAll().find((x) => x.site === 'u3.test' && x.semantic === 'submit');
  ok(raw3 && raw3.confidence < 0.8, '回归 Case3 低置信度自动降级', raw3 && String(raw3.confidence));

  // ============ B) Flow Intelligence ============
  console.log('\n[B] Flow Intelligence（状态机式流程记忆）');
  clearAll();

  // B0) 禁止保存 selector / 坐标 / xpath
  const badFlow = { goal: 'x', states: [{ id: 'a', name: 'A', type: 'STEP', selector: '#btn', next: 'DONE' }] };
  ok(fschema.validateFlow(badFlow).ok === false, 'B0 禁止 selector 落库', JSON.stringify(fschema.validateFlow(badFlow).errors));
  const badCoord = { goal: 'x', states: [{ id: 'a', name: 'A', type: 'STEP', coordinates: { x: 1, y: 2 }, next: 'DONE' }] };
  ok(fschema.validateFlow(badCoord).ok === false, 'B0 禁止坐标落库');

  // 模拟 LLM 生成的计划（Case1）
  const LLM_PLAN = {
    goal: 'signup saas account',
    steps: [
      { id: 'nav', type: 'NAVIGATE', description: 'open signup', expectedOutcome: 'o', risk: 'LOW', action: { type: 'navigate', target: { url: 'http://shop.test/signup' }, risk: 'LOW', verification: { type: 'page_change' } } },
      // ★ C138：fill 必须有 value 或 credentialRef（schema/action.js:174）。身份类字段按生产 P1
      //   凭据契约用 credentialRef 引用凭据，禁止明文 value。
      //   旧用例此处**两者都无** ⇒ 该 plan 违反 action 契约，而生产 planner 出口
      //   （planner.js:465 `validatePlan(canonical)`）必然拒绝并重试 ⇒ 这种 plan 永远不会落库成
      //   flow。即旧用例构造的是**生产不可发生的输入**（本文件 stub 掉了整个 planObjective，
      //   绕过了那道校验）；CAP-K1 读侧守卫（tryFlowPlan 重建后先过 validatePlan）正确地拒绝了
      //   带病重放 ⇒ 旧断言红。真正需要钉住的是「合法输入下复用链路健康」+「非法 flow 必被拒」。
      { id: 'fill_email', type: 'ACT', description: 'fill email', expectedOutcome: 'o', risk: 'MEDIUM', action: { type: 'fill', target: { semantic: 'email_field' }, risk: 'MEDIUM', credentialRef: 'cred_email', verification: { type: 'page_change' } } },
      { id: 'click_submit', type: 'ACT', description: 'submit', expectedOutcome: 'o', risk: 'MEDIUM', action: { type: 'click', target: { semantic: 'submit' }, risk: 'MEDIUM', verification: { type: 'page_change' } } },
    ],
  };

  // 拦截 planner.planObjective（模拟 LLM），统计调用次数
  let llmCalls = 0;
  const origPlan = planner.planObjective;
  planner.planObjective = async () => { llmCalls++; return { ok: true, plan: LLM_PLAN }; };

  // 消费点1：planWithMemory 决策（无历史 → 走 LLM）
  const r1 = await fp.planWithMemory({ objective: 'signup saas account', target: 'http://shop.test/signup', executionMode: 'AUTONOMOUS', provider: {}, ctx: {} });
  ok(r1.ok && r1.fromFlow === false && llmCalls === 1, 'B1 Case1 首次走 LLM Planner', 'fromFlow=' + r1.fromFlow + ' calls=' + llmCalls);

  // 执行成功后落库 Flow（真实消费点：taskManager.complete → recordFlowFromTask）。
  // 这里直接调用 recordFlowFromTask（与 complete 内部调用一致；complete 要求任务先进入 RUNNING 态，由 runtime 保证）。
  let recorded = null;
  try {
    const t = taskManager.createTask({ name: 'flow', objective: 'signup saas account', targetUrl: 'http://shop.test/signup', profileId: null, executionMode: 'AUTONOMOUS' });
    taskManager.attachPlan(t.id, LLM_PLAN);
    fm.recordFlowFromTask(t); // 等价于 complete() 内的落库调用
    recorded = fm.getByKey('shop.test', 'signup saas account');
  } catch (e) {
    console.log('  (recordFlowFromTask 异常，回退断言) ' + e.message);
  }
  ok(recorded && recorded.confidence >= 0.85, 'B1 成功后落库 Flow（conf≥0.85 可复用）', recorded && String(recorded.confidence));

  // 消费点1（续）：第二次同目标 → 直接加载历史 flow，不调用 LLM
  const r2flow = await fp.planWithMemory({ objective: 'signup saas account', target: 'http://shop.test/signup', executionMode: 'AUTONOMOUS', provider: {}, ctx: {} });
  ok(r2flow.ok && r2flow.fromFlow === true && llmCalls === 1, 'B2 Case2 二次同目标跳过 LLM', 'fromFlow=' + r2flow.fromFlow + ' calls=' + llmCalls);

  // ★ C138 写读保真（CAP-K1 核心不变量）：flow 重建的 fill 必须**原样带出 credentialRef**。
  //   旧实现只存 semantic、toPlan 一律重建成 click ⇒ fill/select/press 全退化为点击，重放必失败
  //   且无人知晓。这里断言的是「写侧 stateFromStep → 读侧 toPlan」整条链的字段保真。
  const rebuiltFill = (r2flow.plan && r2flow.plan.steps || []).find((s) => s.action.type === 'fill');
  ok(rebuiltFill && rebuiltFill.action.credentialRef === 'cred_email',
    'B2 写读保真：fill 的 credentialRef 往返保留（不退化）', rebuiltFill && JSON.stringify(rebuiltFill.action));

  // ★ C138 契约守卫（正向断言，防未来被削弱）：把同一组 states 去掉 fill 的取值字段 ⇒ 重建后
  //   违反 action 契约。此时即使**置信度达标**，复用入口也必须拒绝并降级 LLM，绝不带病重放。
  //   （旧用例的 LLM_PLAN 正是这种非法形态 —— 这条断言把它从「偶然红」变成「显式守护」。）
  const stripped = JSON.parse(JSON.stringify(recorded.states)).map((st) => {
    if (st.actionType === 'fill') { delete st.value; delete st.credentialRef; }
    return st;
  });
  const gRec = fm.recordFlow('guard.test', 'guard illegal fill', stripped, { source: { type: 'ai_success' } });
  if (gRec.ok) fm.recordOutcomeFlow(gRec.flow.id, true); // 计成功 ⇒ 确保拦下它的是**契约**而非阈值
  const gConf = fm.getByKey('guard.test', 'guard illegal fill');
  const gHit = fp.tryFlowPlan('http://guard.test/x', 'guard illegal fill');
  ok(gConf && gConf.confidence >= 0.85 && gHit === null,
    'B2-guard 高置信度但非法的 flow 仍被复用入口拒绝（绝不带病重放）',
    'conf=' + (gConf && gConf.confidence) + ' hit=' + (gHit ? 'HIT(带病重放!)' : 'null'));

  // B3) 页面变化：flow 仍可用（toPlan 输出仅 semantic/URL 提示，无 selector/坐标）
  const plan = r2flow.plan;
  const noForbidden = plan.steps.every((s) => !s.action.target.selector && !s.action.target.coordinates && !s.action.target.xpath);
  const actOk = plan.steps.every((s) => s.action.type === 'navigate' ? !!s.action.target.url : !!s.action.target.semantic);
  ok(noForbidden && actOk, 'B3 flow 输出为语义/URL 提示（无 selector/坐标），页面变化可经 Element Memory 修复', JSON.stringify(plan.steps.map((s) => s.action.target)));
  ok(plan.steps[0].action.type === 'navigate' && plan.steps[0].action.target.url === 'http://shop.test/signup', 'B3 START 导航回填目标 URL');

  // B4) flow version + 成功率聚合（再次成功 → 演化 version++）
  const vBefore = recorded.version;
  const rr2 = fm.recordFlow('shop.test', 'signup saas account', recorded.states, { source: { type: 'ai_success' } });
  fm.recordOutcomeFlow(rr2.flow.id, true);
  const updated = fm.getByKey('shop.test', 'signup saas account'); // 重读最新落库对象
  ok(updated.version === vBefore + 1 && updated.samples.success >= 2, 'B4 flow 版本演化 + 成功率聚合', 'v=' + updated.version + ' succ=' + updated.samples.success);

  // 恢复 planner
  planner.planObjective = origPlan;

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
