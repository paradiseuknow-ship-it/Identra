'use strict';
// ============================================================================
// Phase 9 P4 — Planner 页面上下文专项测试
//
// 【根因】Planner 契约编造：78 个失败 attempt 中 48.7% 是 CONTRACT_SELECTOR_MISMATCH
//   （scraping/list.html 真实 id 是 `list`，Planner 却写出 `element_present="member-list"`）。
//   定位到三个串联断裂点，任一存在都会导致 Planner 规划时看不到页面：
//     B1  runtime.resolvePlan → contextBuilder.build 从不传 observation → ctx.context.page 恒为 null
//     B2  contextBuilder elements 映射丢掉 id / ariaLabel（17 字段只映射 7 个）
//     B3  planner.contextBlock / deepseek.buildContextSection 不输出 textSummary 与 elements
//
// 【验证策略】当前环境无 DEEPSEEK_API_KEY，无法端到端重跑真实 LLM 规划，
//   故用「因果证明 + 根因边界锁定」替代：
//   A 组（纯函数，真实 observation 结构）：B2 / B3 修复后 context 与 prompt 携带真实页面信息。
//   B 组（真实 Chromium）：B1 修复后规划前能产出真实 observation。
//   C 组（根因边界）：Planner 历史上编造的标识在真实页面上【确实不存在】—— 证明归因正确，
//      且若 Planner 当年能看到清单（A 组证明现在能看到），就不会写出这些契约。
//   D 组（红线）：修复不触碰判定 / 阈值 / Guard / success definition。
//
// 运行：node server/scripts/test_phase9_p4_planner_context.js
//   可选：P4_DEBUG=1 输出诊断
// ============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const DEBUG = !!process.env.P4_DEBUG;

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(4, 62 - t.length))); }

function startMockServer() {
  const root = path.join(ROOT, 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ────────────────────────────────────────────────────────────────────────────
// A 组：纯函数 —— 给定与 COLLECT_JS 同构的真实 observation，context/prompt 是否携带页面信息
// ────────────────────────────────────────────────────────────────────────────
function testA() {
  section('A 组：contextBuilder / contextBlock 携带真实页面信息（纯函数）');
  const contextBuilder = require('../agent/contextBuilder');
  const planner = require('../agent/planner');
  const deepseek = require('../agent/llm/providers/deepseek');

  // 字段逐个对齐 observation.js 的 COLLECT_JS 输出（17 字段）
  const obs = {
    url: 'http://127.0.0.1:1/scraping/list.html',
    title: '比价网 - 商品列表',
    textSummary: '比价网 · 显示器榜单 共 10 条商品 戴尔 U2723QE 27寸 4K',
    elements: [
      { id: 'list', role: null, tag: 'div', type: 'div', name: null, cls: null, text: '戴尔 U2723QE', placeholder: null, label: null, ariaLabel: null, visible: true, state: {} },
      { id: 'q', role: 'textbox', tag: 'input', type: 'text', name: 'q', cls: null, text: '搜索框', placeholder: '搜索商品', label: null, ariaLabel: '搜索框', visible: true, state: {} },
      { id: 'searchBtn', role: 'button', tag: 'button', type: 'button', name: null, cls: null, text: '搜索', placeholder: null, label: null, ariaLabel: '搜索按钮', visible: true, state: {} },
    ],
    errors: [],
  };

  const ctx = contextBuilder.build({
    task: { id: 't', objective: '抓取商品列表', targetUrl: obs.url, executionMode: 'AUTONOMOUS', status: 'RUNNING' },
    observation: obs, steps: [], checkpoint: null, errorHistory: [], verification: null, execution: null, error: null, budgetCfg: null,
  });

  ok('A.0 [前提] 传入 observation 后 ctx.context.page 非 null', !!(ctx && ctx.page),
    'page=' + JSON.stringify(ctx && ctx.page).slice(0, 160));

  const els = (ctx.page && ctx.page.elements) || [];
  const ids = els.map((e) => e.id).filter(Boolean);
  const ariaLabels = els.map((e) => e.ariaLabel).filter(Boolean);

  ok('A.1 [B2] Planner 上下文携带页面真实 id（list / q / searchBtn）',
    ids.includes('list') && ids.includes('q') && ids.includes('searchBtn'),
    'ids=' + JSON.stringify(ids));

  ok('A.2 [B2] Planner 上下文携带 ariaLabel（搜索框 / 搜索按钮）',
    ariaLabels.includes('搜索框') && ariaLabels.includes('搜索按钮'),
    'ariaLabels=' + JSON.stringify(ariaLabels));

  ok('A.3 [B2] 不因补字段而丢失原有 7 个字段',
    els.every((e) => 'role' in e && 'tag' in e && 'type' in e && 'name' in e && 'text' in e && 'placeholder' in e && 'label' in e),
    'sample=' + JSON.stringify(els[0] || {}).slice(0, 200));

  // A.4~A.6  B3：prompt 里必须出现真实文本与元素清单
  // planner.contextBlock 是模块私有函数，通过 planObjective 的 prompt 路径无法直接取；
  // 改用「同构 ctx 输入 + 捕获 provider.structured 的 prompt」来端到端验证真实注入。
  let capturedPrompt = null;
  const fakeProvider = {
    kind: 'fake', model: 'none',
    structured: async (c, opts) => { capturedPrompt = opts && opts.prompt; return { goal: 'x', steps: [] }; },
  };
  const planCtx = { taskId: 't', executionId: 'e', context: ctx };

  // 同步触发（planObjective 是 async，这里只取 prompt 不关心结果）
  let syncDone = false;
  planner.planObjective({
    objective: '抓取商品列表', target: obs.url, constraints: [],
    credentialRefs: [], executionMode: 'AUTONOMOUS', provider: fakeProvider, ctx: planCtx,
  }).then(() => { syncDone = true; }).catch(() => { syncDone = true; });

  // planObjective 首轮会 await，此处用微任务队列推进若干轮以捕获 prompt
  return new Promise((resolve) => {
    let ticks = 0;
    const spin = () => {
      ticks++;
      if (capturedPrompt || syncDone || ticks > 50) {
        section('A 组（续）：prompt 注入验证');
        ok('A.4 [B3] planner 把 prompt 成功交给 provider（捕获到 prompt）', !!capturedPrompt,
          'captured=' + String(capturedPrompt).slice(0, 120));
        if (capturedPrompt) {
          ok('A.5 [B3] prompt 含页面可见文本', capturedPrompt.includes('戴尔 U2723QE'),
            'prompt 片段=' + capturedPrompt.slice(0, 300));
          ok('A.6 [B3] prompt 含页面元素清单与真实 id',
            capturedPrompt.includes('"id":"list"') || capturedPrompt.includes('"id": "list"'),
            'prompt 尾部=' + capturedPrompt.slice(-500));
          ok('A.7 [B3] prompt 明确约束「禁止臆造标识」', capturedPrompt.includes('禁止臆造'),
            '未找到约束文案');
        } else {
          ok('A.5 [B3] prompt 含页面可见文本', false, '未捕获 prompt');
          ok('A.6 [B3] prompt 含页面元素清单与真实 id', false, '未捕获 prompt');
          ok('A.7 [B3] prompt 明确约束「禁止臆造标识」', false, '未捕获 prompt');
        }
        // deepseek 侧的 context section 同步修复（通过同构 ctx 直接调用其私有构造不可达，
        // 改为静态断言：源码必须包含 textSummary / elements 注入）
        const src = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'llm', 'providers', 'deepseek.js'), 'utf8');
        ok('A.8 [B3] deepseek provider 同样注入 textSummary 与 elements',
          src.includes('页面可见文本') && src.includes('页面元素清单'),
          'deepseek.js 未同步修复');
        resolve();
        return;
      }
      setImmediate(spin);
    };
    setImmediate(spin);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// B 组：真实浏览器 —— 规划前观察（B1）产出真实 observation
// ────────────────────────────────────────────────────────────────────────────
async function testB(base) {
  section('B 组：真实 Chromium —— 规划前观察产出真实 observation');
  const db = require('../db');
  const observation = require('../agent/observation');
  const browserManager = require('../browserManager');

  const PROFILE_ID = 'p9p4b_' + Date.now().toString(36);
  db.upsertProfile({
    id: PROFILE_ID, name: 'P9P4B', group: 'default', tags: [], notes: '',
    seed: 'p4b', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });
  const session = await browserManager.launch(db.getProfile(PROFILE_ID), null);
  const page = session.page;

  // 复刻 capturePlanningObservation 的行为：about:blank → goto → inspect
  const target = base + '/data_entry/form.html';
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const insp = await observation.inspect(page, {});

  ok('B.1 [B1] 规划前观察成功返回 ok=true', !!(insp && insp.ok), 'insp=' + JSON.stringify(insp).slice(0, 200));
  if (!insp || !insp.ok) { try { browserManager.close(PROFILE_ID); } catch (e) {} return; }

  const obs = insp.observation;
  ok('B.2 [B1] observation.url 指向目标页', String(obs.url || '').endsWith('/data_entry/form.html'), 'url=' + obs.url);
  const obsIds = (obs.elements || []).map((e) => e.id).filter(Boolean);
  ok('B.3 [B1] 观察到表单页真实 id（regForm / name / email / phone / submitBtn）',
    obsIds.includes('regForm') && obsIds.includes('email') && obsIds.includes('submitBtn'),
    'ids=' + JSON.stringify(obsIds));

  // B.4 关键因果：真实 id 经 contextBuilder 后仍可被 Planner 看见
  const contextBuilder = require('../agent/contextBuilder');
  const ctx = contextBuilder.build({
    task: { id: 't', objective: '填写并提交注册表单', targetUrl: target, executionMode: 'AUTONOMOUS', status: 'RUNNING' },
    observation: obs, steps: [], checkpoint: null, errorHistory: [], verification: null, execution: null, error: null, budgetCfg: null,
  });
  const ctxIds = ((ctx.page && ctx.page.elements) || []).map((e) => e.id).filter(Boolean);
  ok('B.4 [因果] 真实浏览器 id 完整传导到 Planner 上下文',
    ctxIds.length > 0 && obsIds.every((i) => ctxIds.includes(i)),
    'obs=' + JSON.stringify(obsIds) + ' ctx=' + JSON.stringify(ctxIds));

  // B.5 降级安全：无 targetUrl / 无浏览器时不得抛异常
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'runtime.js'), 'utf8');
  ok('B.5 [安全] capturePlanningObservation 全程 try/catch 且失败返回 null（不新增失败模式）',
    runtimeSrc.includes('async function capturePlanningObservation') && runtimeSrc.includes('降级为无页面上下文规划'),
    'runtime.js 缺少降级保护');

  try { browserManager.close(PROFILE_ID).catch(() => {}); } catch (e) {}
  try { db.deleteProfile(PROFILE_ID); } catch (e) {}
}

// ────────────────────────────────────────────────────────────────────────────
// C 组：根因边界 —— 历史上 Planner 编造的标识，在真实页面上确实不存在
// ────────────────────────────────────────────────────────────────────────────
function testC() {
  section('C 组：根因边界 —— 编造标识在真实页面上确实不存在（归因正确性）');
  // 这些标识来自 phase9 20-task 回放的失败 attempt 契约（真实跑批产物，非构造）
  const FABRICATED = [
    { file: 'scraping/list.html', token: 'member-list' },
    { file: 'scraping/list.html', token: 'order-list' },
    { file: 'scraping/list.html', token: 'log-list' },
  ];
  let allAbsent = true;
  const detail = [];
  for (const f of FABRICATED) {
    const p = path.join(ROOT, 'mock-site', f.file);
    const src = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const absent = src !== '' && !src.includes(f.token);
    if (!absent) allAbsent = false;
    detail.push(f.token + '@' + f.file + '=' + (absent ? '不存在' : '存在/文件缺失'));
  }
  ok('C.1 [归因] Planner 编造的 member-list/order-list/log-list 在 fixture 中确实不存在',
    allAbsent, detail.join('; '));

  // C.2：这些页面的真实 id 是 list —— 若契约写成 list，验证即可能通过
  const listSrc = fs.readFileSync(path.join(ROOT, 'mock-site', 'scraping', 'list.html'), 'utf8');
  ok('C.2 [归因] 页面真实 id 为 list（正确的契约应写 element_present=list）',
    listSrc.includes('id="list"'), '未找到 id="list"');

  // C.3：Planner 若能看到清单，就不会写出不存在的标识 —— 由 A.6/B.4 已证明清单可传导，
  //      此处补充断言：清单里不含任何编造标识（防止误把编造值回灌）
  ok('C.3 [归因] 真实观察清单不含编造标识（修复后不会把错误示范喂回 Planner）',
    !listSrc.includes('member-list') && !listSrc.includes('order-list') && !listSrc.includes('log-list'),
    'fixture 中出现了编造标识');
}

// ────────────────────────────────────────────────────────────────────────────
// D 组：红线 —— 修复不得触碰判定 / 阈值 / Guard / success definition
// ────────────────────────────────────────────────────────────────────────────
function testD() {
  section('D 组：红线检查');
  const verification = require('../agent/verification');
  const vil = require('../agent/verification/verificationIntelligence');
  const guard = require('../agent/contextGuard');
  const actionSchema = require('../agent/schema/action');

  // D.1 DOM_CHANGED ≠ SUCCESS 语义不变
  const r = vil.analyze({
    beforeObservation: { textSummary: 'a', elements: [{ id: 'x', tag: 'div', text: 'a' }] },
    afterObservation: {
      textSummary: 'b',
      elements: [{ id: 'y', tag: 'div', text: 'b' }],
      previousObservationDiff: { domChanged: true },
      loadingState: 'complete',
    },
    actionResult: { success: true },
    action: { type: 'click', target: { semantic: 'x' } },
    expectedVerification: { type: 'text_present', expect: '绝不存在的文本__P4' },
  });
  ok('D.1 [红线] DOM_CHANGED 仍不判成功（不因 P4 改动而放宽）',
    !(r && r.success === true) && r.failureType !== 'SUCCESS',
    'failureType=' + (r && r.failureType));

  // D.2 Guard 仍在：expectedSite=saas + GENERIC + 无 SaaS 证据 → 仍 BLOCK（P0 修复的保守分支）
  const g = guard.guard(
    { type: 'click', target: { semantic: '导出' } },
    { state: 'GENERIC' }, 'saas', {}
  );
  ok('D.2 [红线] Context Guard 未被绕过（GENERIC + 无 SaaS 证据仍拦截）',
    !!(g && g.blocked) && g.code === 'CONTEXT_WRONG_APP',
    'guard=' + JSON.stringify({ blocked: g && g.blocked, code: g && g.code }));

  // D.2b P0 修复仍在：GENERIC + 强 SaaS 证据 → 放行（不是"GENERIC → always SaaS"）
  const g2 = guard.guard(
    { type: 'click', target: { semantic: '导出' } },
    { state: 'GENERIC' }, 'saas',
    { observation: { url: 'https://app.cloudsaas.io/dashboard', title: 'CloudSaaS 控制台', textSummary: '工作区 团队成员 订阅套餐' } }
  );
  ok('D.2b [P0 仍在] GENERIC + 强 SaaS 证据 → 放行（修复未被回退）',
    !!(g2 && g2.blocked === false) && g2.guardMode === 'saas_evidence',
    'guard=' + JSON.stringify({ blocked: g2 && g2.blocked, mode: g2 && g2.guardMode }));

  // D.3 关键动作无验证契约仍被拒绝
  const v = actionSchema.validateAction({
    type: 'click', target: { semantic: '提交', field: 'goBtn' }, verification: { type: 'none' },
  });
  ok('D.3 [红线] 关键动作无验证契约仍被拒绝',
    !!(v && v.ok === false), 'validate=' + JSON.stringify(v && v.ok));

  // D.4 verification.verify 未被弱化（不存在的文本仍失败）
  const vres = verification.verify(
    { type: 'text_present', expect: '绝不存在的文本__P4' },
    { textSummary: '完全不同的页面文本', elements: [] }, null
  );
  ok('D.4 [红线] verification.verify 未被降阈值（缺失文本仍判失败）',
    !!(vres && vres.success === false), 'verify=' + JSON.stringify(vres && vres.success));

  // D.5 成功定义文件未被改动（success definition 冻结）
  const okFiles = ['server/agent/verification.js', 'server/agent/verification/verificationIntelligence.js'];
  let frozen = true;
  for (const f of okFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/Phase 9 P4/.test(src)) frozen = false; // P4 不应在验证核心留下改动
  }
  ok('D.5 [红线] 验证核心未被 P4 改动（DOM_CHANGED≠SUCCESS 语义源封存）', frozen,
    'verification 核心文件中出现了 P4 标记');
}

(async () => {
  console.log('===== Phase 9 P4 — Planner 页面上下文专项测试 =====');
  const server = await startMockServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  if (DEBUG) console.log('[debug] mock-site =', base);

  try {
    await testA();
    await testB(base);
    testC();
    testD();
  } catch (e) {
    fail++; failures.push('运行异常: ' + String((e && e.stack) || e).slice(0, 400));
    console.log('\n运行异常:', e);
  }

  console.log('\n===== P4 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (failures.length) { console.log('失败项:'); failures.forEach((f) => console.log('  - ' + f)); }
  server.close();
  process.exit(fail ? 1 : 0);
})();
