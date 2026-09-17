'use strict';

// Phase 3.1 验收：Memory Infrastructure + Element Memory。
// 覆盖：memoryRecord 基座 / elementMemory 模式演化 / resolveSelector 记忆优先 + 成功强化 /
//       Case1 首次 semanticResolver→保存 / Case2 标签变更后 pattern 演化 + 再次命中零推理 /
//       Case3 低置信度降级 / C105 F1 零证据拒点双向契约 / 浏览器端到端（F1 拒点 → 恢复链）。
//       ★ C139：Case 的 fixture 语义必须与元素标签有**词法关联**（F1 要求），详见 3b 段注释。
// 注意：集成部分启动浏览器，必须**停止 server 进程**后独立运行。
// 用法：node server/scripts/testAgentPhase31.js

// C139：数据根隔离 —— 必须位于本文件**首个 require 之前**（browserManager / identityStore 的
// 数据根是**模块加载期**解析，晚于 require 则 FPB_DATA_DIR 失效）。本套件会写
// aiElementMemory / aiSiteMemory 并创建 profile，未隔离时直接污染真实 server/data
// （EX-06 登记原因①）。一条隔离行同时覆盖 dataRoot() 与 aiStoreRoot() 两根。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c139_phase31_' + Date.now());

const db = require('../db');
const taskManager = require('../agent/taskManager');
const browserManager = require('../browserManager');
const store = require('../agent/store');
const tools = require('../agent/tools');
require('../agent/runtime');

const testSite = require('./_testSite');
const memoryRecord = require('../agent/intelligence/memoryRecord');
const elementMemory = require('../agent/intelligence/elementMemory');
const siteMemory = require('../agent/intelligence/siteMemory');
const semanticResolver = require('../agent/semanticResolver');

let pass = 0, fail = 0;
// C139：把 origResolve 提升到模块作用域 —— 异常路径（main().catch）此前写的是
// `semanticResolver.resolve = semanticResolver.resolve`（自赋值 no-op，注释说「还原」但根本没还原），
// 一旦集成段抛错，spy 会残留在后续 test-site 请求上，污染同进程内后续断言。
let origResolve = null;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStatus(taskId, targets, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = taskManager.getTask(taskId);
    if (t && targets.includes(t.status)) return t;
    await sleep(600);
  }
  return taskManager.getTask(taskId);
}

const PROFILE = 'p_phase31_' + Date.now().toString(36);
async function makeProfile() {
  db.upsertProfile({
    id: PROFILE, name: 'p31', group: 'default', tags: [], notes: '', seed: 'p31',
    headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { cacheClearMode: 'none' }, fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });
}

function clearSiteMemory(site) {
  store.write('aiElementMemory', store.read('aiElementMemory', []).filter((r) => r.site !== site));
  store.write('aiSiteMemory', store.read('aiSiteMemory', []).filter((r) => r.site !== site));
}

async function cleanup(ids) {
  try { browserManager.close(PROFILE).catch(() => {}); } catch (e) {}
  for (const id of ids) { try { taskManager.cancel(id); } catch (e) {} store.remove('aiTasks', id); }
  store.write('aiSteps', store.read('aiSteps', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiAttempts', store.read('aiAttempts', []).filter((a) => { const st = store.find('aiSteps', a.stepId); return st && !ids.includes(st.taskId); }));
  store.write('aiQueue', store.read('aiQueue', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiExecutions', store.read('aiExecutions', []).filter((e) => !ids.includes(e.taskId)));
  clearSiteMemory('localhost');
  db.deleteProfile(PROFILE);
  testSite.cleanup();
}

async function main() {
  console.log('== Phase 3.1 Memory Infrastructure + Element Memory 验收 ==');

  // ---- 1) memoryRecord 基座 ----
  console.log('[memory-record]');
  const mr = memoryRecord;
  let rec = mr.createBase({ prefix: 't', source: { type: 'human' } });
  ok(rec.status === 'ACTIVE' && rec.version === 1 && rec.confidence === 0 && rec.samples.success === 0 && rec.source.type === 'human', '统一字段: version/status/confidence/samples/source');
  mr.recordOutcome(rec, true);
  ok(rec.samples.success === 1 && rec.successRate === 1 && rec.confidence >= 0.8, '1 次成功 → 置信度 ≥0.8', String(rec.confidence));
  for (let i = 0; i < 5; i++) mr.recordOutcome(rec, false);
  ok(rec.status === 'DEPRECATED' && rec.confidence < 0.4, '长期失败自动 DEPRECATED（旧经验保留不消费）', String(rec.status));

  // ---- 2) siteMemory ----
  console.log('[site-memory]');
  clearSiteMemory('u4.test'); // 防上次运行残留
  siteMemory.recordTaskResult('u4.test', { ok: true, flowName: 'signup', avgSteps: 6 });
  siteMemory.recordTaskResult('u4.test', { ok: true, flowName: 'signup' });
  siteMemory.recordTaskResult('u4.test', { ok: false, failureType: 'ELEMENT_NOT_FOUND' });
  const s = siteMemory.getSite('u4.test');
  ok(s.history.successTasks === 2 && s.history.failedTasks === 1, '站点成功/失败统计');
  ok(s.commonFlows.signup.successRate === 1 && s.commonFlows.signup.samples === 2, '流程成功率聚合');
  ok(s.frequentFailures.includes('ELEMENT_NOT_FOUND'), '高频失败记录');

  // ---- 3) Element Memory：Case1/2/3（spy semanticResolver）----
  console.log('[element-memory]');
  clearSiteMemory('u1.test'); clearSiteMemory('u3.test');
  let spyCount = 0;
  origResolve = semanticResolver.resolve;
  semanticResolver.resolve = function (...a) { spyCount++; return origResolve.apply(this, a); };

  // C139 归属结论：本段旧 fixture 用的 act={semantic:'submit'} + 标签 'Continue'/'Proceed'
  // 是 **C105 F1 之前**的可行性假设 —— 那时「纯图标/无文本按钮兜底」给所有 button 一律 0.4 同分、
  // DOM 顺序决胜，所以语义与标签毫无词法关系也能命中。C105 F1 已用真实站点实证改掉它
  // （法语站误点 Plateforme 菜单：真实 CTA 一直在列表 index 40）：兜底候选必须与元素**自身身份信号**
  // 有词法关联（token 相交），零关联直接出局 ⇒ 上述 fixture 恒返回 null（实测 A1/A3）。
  // 因此：断言**不是被放宽**，而是对齐现行契约；被推翻的旧假设另钉成显式双向守护（见 3b）。
  // fixture 设计：语义取 2 token（'submit signup'），两个标签各自带**不同**的 token
  // ⇒ 既满足 F1 词法关联，又保持「标签变更 → 记忆不匹配 → 新 pattern 演化」的原意
  // （单 token 语义下两个含该词的标签必然互相包含，pattern 的 includes 匹配会直接命中，演化链就测不到了）。
  const SEM = 'submit signup';
  const act = { type: 'click', target: { semantic: SEM } };
  const actZero = { type: 'click', target: { semantic: 'submit' } }; // 旧假设的语义（F1 拒点对照）
  const obs1 = { url: 'http://u1.test/form', elements: [{ id: 'b1', role: 'button', tag: 'button', text: 'Submit', visible: true }] };

  // Case1：记忆为空 → semanticResolver → 成功后保存
  const r1 = await tools.resolveSelector(act, obs1);
  ok(r1 && r1.selector && r1.fromMemory === false, 'Case1 首次走 semanticResolver', r1 && JSON.stringify(r1));
  ok(spyCount === 1, 'Case1 调用 semanticResolver 一次', String(spyCount));
  // C139 null 守卫：解析失败必须**显式 FAIL**，不得让 r1.pattern 抛 TypeError 把
  // 崩溃点之后的全部断言（Case2/3 + 整个集成段）静默吃掉 —— 这是本套件长期
  // 「只报 1 项红 + 系统性瘫痪」的原因（EX-06 登记原因②）。
  ok(!!(r1 && r1.pattern), 'Case1 解析结果携带 pattern（null 守卫）', r1 ? JSON.stringify(r1) : 'resolveSelector 返回 null');
  if (r1 && r1.pattern) elementMemory.recordSuccess('u1.test', SEM, r1.pattern, { type: 'ai_success' });
  const rec1 = elementMemory.getRecord('u1.test', SEM);
  ok(!!rec1 && rec1.patterns.length === 1, 'Case1 成功后保存 pattern', rec1 ? String(rec1.patterns.length) : '无记录');

  // Case2：标签换成 Signup（与 Submit 无包含关系）→ 记忆不匹配 → semanticResolver → 新 pattern 演化
  const obs2 = { url: 'http://u1.test/form', elements: [{ id: 'b1', role: 'button', tag: 'button', text: 'Signup', visible: true }] };
  const r2 = await tools.resolveSelector(act, obs2);
  ok(r2 && r2.selector && r2.fromMemory === false, 'Case2 标签变更未命中记忆 → semanticResolver', r2 === null ? 'resolveSelector 返回 null' : '');
  ok(!!(r2 && r2.pattern), 'Case2 解析结果携带 pattern（null 守卫）', r2 ? JSON.stringify(r2) : 'resolveSelector 返回 null');
  if (r2 && r2.pattern) elementMemory.recordSuccess('u1.test', SEM, r2.pattern, { type: 'ai_success' });
  const rec2 = elementMemory.getRecord('u1.test', SEM);
  ok(!!rec2 && rec2.version === 2 && rec2.patterns.length === 2, 'Case2 pattern 演化（version 2，Submit 旧经验保留）', rec2 ? 'version=' + rec2.version + ' n=' + rec2.patterns.length : '无记录');

  // Case2-hit：再次 Signup → 命中记忆，不调用 semanticResolver（零推理）
  spyCount = 0;
  const r3 = await tools.resolveSelector(act, obs2);
  ok(r3 && r3.selector && r3.fromMemory === true, 'Case2 命中 Memory');
  ok(spyCount === 0, '命中 Memory 不调用 semanticResolver', String(spyCount));

  // Case3：低置信度记忆 → 自动降级 semanticResolver
  elementMemory.recordSuccess('u3.test', SEM, { text: 'Submit', role: 'button' }, { type: 'ai_success' });
  for (let i = 0; i < 5; i++) elementMemory.recordFailure('u3.test', SEM);
  const raw3 = elementMemory.listAll().find((x) => x.site === 'u3.test' && x.semantic === SEM);
  ok(raw3 && raw3.confidence < 0.8 && (raw3.status === 'DEPRECATED' || raw3.status === 'ACTIVE'), 'Case3 低置信度', raw3 ? String(raw3.confidence) + '/' + raw3.status : '无记录');
  spyCount = 0;
  const obs3 = { url: 'http://u3.test/form', elements: [{ id: 'b1', role: 'button', tag: 'button', text: 'Submit', visible: true }] };
  const r4 = await tools.resolveSelector(act, obs3);
  ok(r4 && r4.fromMemory === false && spyCount >= 1, 'Case3 低置信度自动降级 semanticResolver', 'fromMemory=' + (r4 && r4.fromMemory));

  // ---- 3b) C105 F1 零证据拒点：把被推翻的旧假设钉成显式契约（双向）----
  // 反向：本套件**历史 fixture 的语义/标签组合**（semantic 'submit' + 标签 'Continue'）在 F1 下
  // 必须零候选 —— 这正是 EX-06 原来那条红的根因，钉住它就钉住了「红因归属 = fixture 语义过时」。
  // 正向：有词法关联时必须出候选 —— 否则「一律拒绝」会伪装成绿（L17 双向咬）。
  const obsZero = { url: 'http://u1.test/form', elements: [{ id: 'b9', role: 'button', tag: 'button', text: 'Continue', visible: true }] };
  const rZero = await tools.resolveSelector(actZero, obsZero);
  ok(rZero === null, 'F1 零证据拒点（反向）：旧 fixture 语义/标签零词法关联 ⇒ 不出候选', rZero ? JSON.stringify(rZero) : 'null');
  const rEvid = await tools.resolveSelector(act, { url: 'http://u1.test/form', elements: [{ id: 'b9', role: 'button', tag: 'button', text: 'Submit', visible: true }] });
  ok(!!(rEvid && rEvid.selector), 'F1 零证据拒点（正向对照）：有词法关联 ⇒ 必须出候选', rEvid ? JSON.stringify(rEvid.selector) : 'null');

  semanticResolver.resolve = origResolve;

  // ---- 4) 端到端：/evolve 三次执行（真实浏览器 + 真实恢复链）----
  // C139 实测（.benchmark/c139_phase31_run1.out）：F1 之后这条链的真实形态是
  //   计划语义 'submit' 与页面标签 'Continue'/'Proceed' 零词法关联
  //   → semanticResolver 零候选（F1 拒点）
  //   → 恢复链 elementMissing 用 SYNONYMS['submit'] 展开变体，挑出**在新鲜观察中可解析**的那个
  //     （Continue → 变体 'continue'；Proceed → 变体 'proceed'）
  //   → 业务 SUCCESS，记忆按**恢复链生效语义**落库（实测 Task1 后 key = localhost|continue|CTX:…）
  // 因此断言改为「契约稳定」形态：业务结果 + **按观察标签**的 pattern 积累（key 无关），
  // 并把「零证据语义不复用记忆」钉成显式契约 —— 这样既保留原意（pattern 积累 / 演化），
  // 又不把断言绑死在兜底/恢复链选中哪个同义词上。
  console.log('[integration] /evolve 三次执行（Continue → Proceed → Proceed）');
  await testSite.ensure();
  await makeProfile();
  clearSiteMemory('localhost');
  semanticResolver.resolve = function (...a) { spyCount++; return origResolve.apply(this, a); };

  const runEvolve = async (name) => {
    const t = taskManager.createTask({ name, objective: 'x', targetUrl: 'http://localhost:9555/evolve', profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' } });
    taskManager.attachPlan(t.id, {
      goal: name, steps: [
        { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: { type: 'navigate', target: { url: 'http://localhost:9555/evolve' }, risk: 'LOW', verification: { type: 'page_change' } } },
        { id: 'click', type: 'ACT', description: '点击 submit 语义的 CTA', expectedOutcome: 'o', risk: 'MEDIUM', action: { type: 'click', target: { semantic: 'submit' }, risk: 'MEDIUM', verification: { type: 'page_change' } } },
      ],
    });
    taskManager.start(t.id);
    const r = await waitStatus(t.id, ['SUCCESS', 'FAILED', 'PAUSED_FOR_HUMAN'], 90000);
    return { t, r };
  };

  // C139：一律走 null 守卫读取，并把**实际落库的 memory key** 打出来 ——
  // 解析走语义兜底 / 恢复链时，落库 key 是「实际命中的语义」而非计划里的语义，
  // 不打印就无法区分「没保存」与「保存到别的 key」（本套件历史上正是被这一点误导）。
  const memOf = (sem) => elementMemory.getRecord('localhost', sem);
  const memKeys = () => elementMemory.listAll().filter((r) => String(r.key).indexOf('localhost|') === 0).map((r) => r.key + '(' + r.version + '/' + r.patterns.length + ')').join(' ');
  // key 无关的 pattern 统计：按 pattern.text 计数（恢复链选哪个同义词都不影响）
  const labelPatterns = () => elementMemory.listAll().filter((r) => String(r.key).indexOf('localhost|') === 0)
    .reduce((m, r) => { (r.patterns || []).forEach((p) => { if (p && p.text) m[p.text] = (m[p.text] || 0) + 1; }); return m; }, {});

  const a = await runEvolve('p31 a');
  ok(a.r.status === 'SUCCESS', 'Task1 成功（Continue，F1 拒点 → 恢复链同义词）', a.r.error || '');
  console.log('    [诊断] Task1 后 memory keys =', memKeys() || '(空)');
  const patA = labelPatterns();
  ok(!!patA['Continue'], 'Task1 按观察标签积累 Continue pattern', JSON.stringify(patA));

  const b = await runEvolve('p31 b');
  ok(b.r.status === 'SUCCESS', 'Task2 成功（Proceed，同上）', b.r.error || '');
  const patB = labelPatterns();
  ok(!!patB['Proceed'], 'Task2 标签变更后新增 Proceed pattern', JSON.stringify(patB));
  ok(!!patB['Continue'], 'Task2 保留 Continue 旧 pattern（演化而非替换）');

  spyCount = 0;
  const c = await runEvolve('p31 c');
  ok(c.r.status === 'SUCCESS', 'Task3 成功（Proceed）', c.r.error || '');
  ok(!!labelPatterns()['Proceed'], 'Task3 强化 Proceed pattern');

  // ---- 4b) C139 契约：零证据语义不会零推理复用 ----
  // F1 生效 ⇒ 计划语义 'submit' 与页面标签零关联 ⇒ 既不按 'submit' 落库，也不会有零推理命中；
  // 每个 Task 都必然再走一次语义解析 + 恢复链（实测 Task3 resolveSelector 调用 24 次）。
  // ★ 这是**有意的权衡**（宁可多次解析，也不按 DOM 顺序误点）：若将来 F1 被回退，
  //   本断言会变红，迫使做显式决策，而不是让「零推理复用」悄悄回来。
  ok(!memOf('submit'), '记忆不按计划语义 submit 落库（F1 拒零证据 ⇒ 落库 key = 恢复链生效语义）', memKeys());
  ok(spyCount > 0, '零证据语义不复用记忆（F1 生效：仍需语义/恢复链解析）', 'calls=' + spyCount);

  semanticResolver.resolve = origResolve;

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup([a.t.id, b.t.id, c.t.id]);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); try { if (origResolve) semanticResolver.resolve = origResolve; } catch (x) {} try { testSite.cleanup(); } catch (x) {} process.exit(1); });
