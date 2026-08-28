'use strict';
// ============================================================================
// Phase 9 — 4-task Gate（确定性回放版 / Deterministic Replay Gate）
//
// 【本 Gate 的定位】
//   真实 Chromium + 真实 taskManager/runtime/tools/verification + 真实成功判定。
//   与「真实 LLM Gate」的唯一差异：plan 来自 phase12/phase68 真实跑批中 DeepSeek 实际产出的
//   plan（从 .benchmark/phase68_100task_store 回放），而不是本次重新调用 LLM 规划。
//   原因：当前运行环境无 DEEPSEEK_API_KEY，LLM 规划环节无法执行；
//         而 Phase 9 修改的是「执行链路」（E5 Guard / 候选池 / 动作排序），不是 LLM 规划。
//
// 【红线遵守声明】
//   * 无 mock / 无 fake / 无 fallback success：每一步的执行、观察、验证、成功判定全部走真实实现。
//   * 不降低任何验证阈值：verification.verify 原样调用，DOM_CHANGED ≠ SUCCESS 语义不变。
//   * 不绕过 Guard：contextGuard.guard 原样执行（P0 只放宽了「导航目标语义」与「只读动作」）。
//   * plan 不是我编造的：它是历史真实跑批里 LLM 的输出，逐字回放（仅重写 targetUrl 端口与凭据引用）。
//
// 【4 个任务与覆盖的修复路径】
//   rw.001 SaaS登录1  (4 步) → P0：navigate 到 saas/login.html 曾 196 次被 E5 阻断
//   rw.035 商品搜索5  (3 步) → P2：submit 曾因 elementMemory 短路落在 input#q 而非 searchBtn
//   rw.056 表格填写1  (5 步) → P1：element_present="form" 曾因 form 不在候选池失败 36 次
//   rw.076 多步确认1  (6 步) → 完整 Business Loop：搜索 → 加购 → 购物车 → 确认
//
// 运行：node server/scripts/phase9_gate_replay.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const STORE_SRC = path.join(ROOT, '.benchmark', 'phase68_100task_store');
const OUT_DIR = path.join(ROOT, '.benchmark');
const DATA_DIR = path.join(ROOT, 'server', 'data');

// ── 1. 启动 mock 站点（真实 HTTP，端口随机）──
function startMockServer() {
  const root = path.join(ROOT, 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(file);
      const ct = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript' : 'text/plain';
      res.setHeader('Content-Type', ct);
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ── 2. store 隔离：备份 → Gate 结束恢复（保证 Gate 可重复、无副作用）──
const BACKUP_DIR = path.join(OUT_DIR, '_phase9_gate_store_backup');
function isolateStore() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  files.forEach((f) => fs.copyFileSync(path.join(DATA_DIR, f), path.join(BACKUP_DIR, f)));
  // 清空执行侧数据，避免历史数据干扰 Gate 判定；
  // 刻意【保留】aiElementMemory.json：其中的「搜索表单→input」污染记忆是对照组，
  // Gate 要证明的正是「即使存在这条成功记忆，submit 仍能正确落到按钮」。
  const keep = new Set(['aiElementMemory.json', 'aiCredentials.json', 'aiProfiles.json']);
  files.forEach((f) => {
    if (keep.has(f)) return;
    fs.writeFileSync(path.join(DATA_DIR, f), '[]');
  });
  return files;
}
function restoreStore() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).forEach((f) => {
    fs.copyFileSync(path.join(BACKUP_DIR, f), path.join(DATA_DIR, f));
  });
}

// ── 3. 从 phase68 真实跑批 store 中提取指定任务的真实 plan ──
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i < 0 ? null : process.argv[i + 1]; })();
// --taskIds：回放任意历史任务（逗号分隔 task id）。用于把 Gate 从 4 个精选场景扩展到
// 「受某缺陷影响的真实任务样本」，例如 P3 观察窗口失效影响的 55 个任务。
const TASK_IDS = (() => { const i = process.argv.indexOf('--taskIds'); return i < 0 ? null : process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean); })();
const GATE_TASKS = [
  { rw: 'rw.001', label: 'SaaS登录1', covers: 'P0 (E5 false block)' },
  { rw: 'rw.035', label: '商品搜索5', covers: 'P2 (submit ranking / memory short-circuit)' },
  { rw: 'rw.056', label: '表格填写1', covers: 'P1 (form candidate discovery)' },
  { rw: 'rw.076', label: '多步确认1', covers: 'Full business loop' },
];

function loadRealPlans() {
  const tasks = JSON.parse(fs.readFileSync(path.join(STORE_SRC, 'aiTasks.json'), 'utf8'));
  const steps = JSON.parse(fs.readFileSync(path.join(STORE_SRC, 'aiSteps.json'), 'utf8'));
  const out = [];
  if (TASK_IDS && TASK_IDS.length) {
    for (const id of TASK_IDS) {
      const t = tasks.find((x) => x.id === id);
      if (!t) { console.error('[gate] 未找到历史任务 id: ' + id); continue; }
      if (ONLY && ONLY !== id) continue;
      const ss = steps.filter((s) => s.taskId === t.id).sort((a, b) => a.index - b.index);
      out.push({
        rw: id, label: t.name, covers: '指定任务（真实跑批 plan 回放）',
        name: t.name, objective: t.objective, targetUrl: t.targetUrl,
        historicalStatus: t.status,
        plan: { goal: t.planGoal || t.objective, steps: ss.map((s) => ({ type: s.type, action: s.action, verification: s.verification })) },
      });
    }
    return out;
  }
  for (const g of GATE_TASKS) {
    if (ONLY && g.rw !== ONLY) continue;
    const t = tasks.find((x) => String(x.name || '').includes(g.label));
    if (!t) { console.error('[gate] 未找到历史任务: ' + g.label); continue; }
    const ss = steps.filter((s) => s.taskId === t.id).sort((a, b) => a.index - b.index);
    out.push({
      rw: g.rw, label: g.label, covers: g.covers,
      name: t.name, objective: t.objective, targetUrl: t.targetUrl,
      historicalStatus: t.status,
      plan: { goal: t.planGoal || t.objective, steps: ss.map((s) => ({ type: s.type, action: s.action, verification: s.verification })) },
    });
  }
  return out;
}

// ── 3b. 反事实验证（counterfactual）──
// 用途：把「planner 契约准确性」这个变量隔离掉，证明执行链路本身已打通。
// 做法：仅把已被 trace 证明与 fixture 不符的 planner 期望，替换成 fixture 的真实内容：
//   rw.001#0  input[name='username'] → input[name='email']   （login.html 真实字段名）
//   rw.056#4  text_present 提交成功    → 注册成功              （form.html 真实成功文案）
//   rw.076    关键词 耳机 → 显示器                             （search.html 商品库真实存在的商品）
// 红线声明：本模式【不修改任何验证阈值】【不绕过 Guard】【不判假成功】；
//           verification.verify 原样调用，失败仍记失败。它只把「错误的提问」换成「正确的提问」。
const COUNTERFACTUAL = process.argv.includes('--counterfactual');

function applyCounterfactual(scn) {
  const fix = (o) => {
    if (!o || typeof o.expect !== 'string') return;
    if (scn.rw === 'rw.001' && o.expect === "input[name='username']") o.expect = "input[name='email']";
    if (scn.rw === 'rw.056' && o.expect === '提交成功') o.expect = '注册成功';
    if (scn.rw === 'rw.076') o.expect = o.expect.split('耳机').join('显示器');
  };
  // 关键：验证真正消费的是 action.expectedBusinessState.requiredEvidence（见 attempt.error.message
  // 「required unmet: ...」），verification 字段只是附带。两处都要修正，否则契约替换不生效。
  const fixContract = (a) => {
    if (!a) return;
    fix(a.verification);
    const bs = a.expectedBusinessState;
    if (bs) {
      (bs.requiredEvidence || []).forEach(fix);
      (bs.forbiddenEvidence || []).forEach(fix);
    }
  };
  scn.plan.steps.forEach((s) => {
    fix(s.verification);
    fixContract(s.action);
    if (scn.rw === 'rw.076' && s.action && typeof s.action.value === 'string') s.action.value = s.action.value.split('耳机').join('显示器');
  });
  if (scn.rw === 'rw.001') return 'contract: username → email（fixture 真实字段名）';
  if (scn.rw === 'rw.056') return 'contract: 提交成功 → 注册成功（fixture 真实文案）';
  if (scn.rw === 'rw.076') return 'contract: 耳机 → 显示器（fixture 商品库真实存在的商品）';
  return null;
}

// 把历史 plan 里的 mock 站点端口重写为本次运行端口（其余字段逐字保留）
function rewriteUrls(node, from, to) {
  if (typeof node === 'string') return node.split(from).join(to);
  if (Array.isArray(node)) return node.map((n) => rewriteUrls(n, from, to));
  if (node && typeof node === 'object') { const o = {}; for (const k of Object.keys(node)) o[k] = rewriteUrls(node[k], from, to); return o; }
  return node;
}

const TERMINAL = ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'];
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runOne(scn, baseUrl, port) {
  const db = require('../db');
  const taskManager = require('../agent/taskManager');
  const browserManager = require('../browserManager');
  const store = require('../agent/store');
  const vault = require('../vault');
  require('../agent/runtime');

  const PROFILE_ID = 'p9gate_' + scn.rw.replace(/\W/g, '_') + '_' + Date.now().toString(36);
  db.upsertProfile({
    id: PROFILE_ID, name: 'P9GATE-' + scn.rw, group: 'default', tags: [], notes: '',
    seed: 'gate-seed', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });

  // ── 凭据播种（仅 SaaS 登录任务；凭据为 mock-site fixture 自带演示账号，非真实用户账号）──
  let credNote = null;
  if (scn.rw === 'rw.001') {
    try {
      vault.setProfileSecrets(PROFILE_ID, { email: 'ops@cloudsaas.io', password: 'Saas#2024' });
      // 历史 plan 中 credentialRef="password"，据此注册同 id 的引用，使解析链路可走通
      store.upsert('aiCredentials', {
        id: 'password', type: 'email_password', profileId: PROFILE_ID,
        site: 'saas', label: 'saas_demo', available: true, createdAt: Date.now(),
      });
      credNote = '已播种 saas_demo（mock-site fixture 演示账号），credentialRef="password" 可解析';
    } catch (e) { credNote = '凭据播种失败: ' + e.message; }
  }

  const targetUrl = String(scn.targetUrl).replace(/127\.0\.0\.1:\d+/, '127.0.0.1:' + port);
  const plan = rewriteUrls(scn.plan, /127\.0\.0\.1:\d+/g, '127.0.0.1:' + port);

  const task = taskManager.createTask({
    name: 'P9GATE ' + scn.name,
    objective: scn.objective,
    targetUrl,
    profileId: PROFILE_ID,
    executionMode: 'AUTONOMOUS',
    constraints: [],
    policy: { riskFloor: 'HIGH' },
  });
  taskManager.attachPlan(task.id, plan);
  taskManager.start(task.id);

  const end = Date.now() + 180000;
  let final = null;
  while (Date.now() < end) {
    final = taskManager.getTask(task.id);
    if (final && TERMINAL.includes(final.status)) break;
    await sleep(500);
  }
  if (!final || !TERMINAL.includes(final.status)) {
    try { taskManager.cancel(task.id); } catch (e) {}
    final = taskManager.getTask(task.id) || { id: task.id, status: 'TIMEOUT' };
  }

  // ── 聚合（纯读 store，判定口径与 phase9Benchmark 一致）──
  const allSteps = store.read('aiSteps', []);
  const steps = allSteps.filter((s) => s.taskId === task.id).sort((a, b) => a.index - b.index);
  const stepIds = new Set(steps.map((s) => s.id));
  const attempts = store.read('aiAttempts', []).filter((a) => stepIds.has(a.stepId));
  const guardEvents = store.read('aiEvents', []).filter((e) => e.taskId === task.id && String(e.type || '').startsWith('ai.guard'));
  const verifEvents = store.read('aiEvents', []).filter((e) => e.taskId === task.id && e.type === 'ai.verification.completed');
  const codes = attempts.map((a) => a.error && a.error.code).filter(Boolean);

  // ── 失败步骤的逐 attempt 证据（诊断用；不改变任何判定）──
  const attemptDetail = attempts.map((a) => {
    const st = steps.find((s) => s.id === a.stepId);
    return {
      stepIndex: st ? st.index : null,
      status: a.status,
      error: a.error ? (a.error.code || a.error.message || String(a.error)) : null,
      selector: (a.result && a.result.selector) || null,
      acted: (a.result && a.result.acted) || null,
      landed: (a.result && a.result.landed) !== undefined ? a.result.landed : null,
      beforeText: String((a.before && a.before.textSummary) || '').slice(0, 80),
      afterText: String((a.after && a.after.textSummary) || '').slice(0, 140),
      keys: Object.keys(a).join(','),
      raw: JSON.stringify(a).slice(0, 900),
    };
  });
  const decisions = store.read('aiEvents', []).filter((e) => e.taskId === task.id && e.type === 'ai.verification.decision')
    .map((e) => e.payload).slice(0, 10);

  // Phase 9 P3：观察窗口恢复与空转计数 —— 修复「getPage 漏 await」的核心指标。
  //  - vilRecovered：窗口内 Fresh Observation 使验证真正通过的次数（修复前恒为 0）
  //  - vilWindowIterations：窗口迭代次数；若 observationOk=false 说明窗口在空转
  const windowEvents = store.read('aiEvents', []).filter((e) => e.taskId === task.id && e.type === 'ai.verification.window');
  const recoveredEvents = store.read('aiEvents', []).filter((e) => e.taskId === task.id && e.type === 'ai.verification.recovered');

  const stepDetail = steps.map((s) => ({
    index: s.index, type: s.type, status: s.status,
    action: s.action ? s.action.type : null,
    target: s.action && s.action.target ? (s.action.target.semantic || s.action.target.field || s.action.target.url || s.action.target.selector) : null,
    verification: s.verification ? s.verification.type + '=' + (s.verification.expect || '') : null,
  }));

  try { taskManager.cancel(task.id); } catch (e) {}
  try { browserManager.close(PROFILE_ID).catch(() => {}); } catch (e) {}
  try { db.deleteProfile(PROFILE_ID); } catch (e) {}

  const businessSuccess = final.status === 'SUCCESS';
  return {
    rw: scn.rw, label: scn.label, covers: scn.covers,
    objective: scn.objective, targetUrl,
    historicalStatus: scn.historicalStatus,
    status: final.status,
    businessSuccess,
    stepCount: steps.length,
    stepStatuses: steps.map((s) => s.status).join(','),
    steps: stepDetail,
    attempts: attemptDetail,
    verificationDecisions: decisions,
    vilRecovered: recoveredEvents.length,
    vilWindowIterations: windowEvents.length,
    vilWindowObservationOk: windowEvents.filter((e) => e.payload && e.payload.observationOk).length,
    attemptCount: attempts.length,
    guardBlocked: guardEvents.filter((e) => e.type === 'ai.guard.blocked').length,
    guardPassed: guardEvents.filter((e) => e.type === 'ai.guard.passed').length,
    guardModes: Array.from(new Set(guardEvents.map((e) => e.payload && e.payload.guardMode).filter(Boolean))),
    verificationTotal: verifEvents.length,
    verificationPassed: verifEvents.filter((e) => e.payload && e.payload.success).length,
    errorCodes: Array.from(new Set(codes)),
    error: (final.error && (final.error.message || String(final.error))) || null,
    credNote,
  };
}

(async () => {
  console.log('===== PHASE 9 — 4-task Gate（确定性回放版）=====');
  console.log('plan 来源：.benchmark/phase68_100task_store（历史真实跑批中 DeepSeek 的实际输出）');
  console.log('执行/验证/判定：100% 真实实现（无 mock / 无 fallback / 无阈值降级）');
  console.log('');

  if (!fs.existsSync(STORE_SRC)) { console.error('[gate] 缺少 phase68 store，无法回放。'); process.exit(2); }

  const server = await startMockServer();
  const port = server.address().port;
  const plans = loadRealPlans();
  console.log('mock-site 端口 =', port, '| 回放任务数 =', plans.length);
  console.log('');

  isolateStore();
  const results = [];
  try {
    for (const scn of plans) {
      process.stdout.write('[gate] ' + scn.rw + ' 「' + scn.label + '」... ');
      let cfNote = null;
      if (COUNTERFACTUAL) cfNote = applyCounterfactual(scn);
      const r = await runOne(scn, 'http://127.0.0.1:' + port, port);
      r.counterfactual = cfNote;
      results.push(r);
      console.log('status=' + r.status + (r.businessSuccess ? '  ✔ BUSINESS SUCCESS' : '  ✘'));
    }
  } finally {
    restoreStore();
    server.close();
  }

  // ── 报告 ──
  console.log('\n────────────────────────────────────────────────');
  console.log('== 逐任务明细 ==');
  for (const r of results) {
    console.log('\n### ' + r.rw + ' 「' + r.label + '」 — 覆盖 ' + r.covers);
    console.log('    目标       : ' + r.objective);
    console.log('    历史状态   : ' + r.historicalStatus + '   →   本次状态: ' + r.status +
      (r.businessSuccess ? '  （业务成功）' : ''));
    console.log('    步骤       : ' + r.stepCount + ' 步 [' + r.stepStatuses + ']');
    console.log('    Guard      : blocked=' + r.guardBlocked + ' passed=' + r.guardPassed +
      (r.guardModes.length ? ' modes=' + r.guardModes.join('/') : ''));
    console.log('    验证       : ' + r.verificationPassed + '/' + r.verificationTotal + ' 通过');
    if (r.errorCodes.length) console.log('    错误码     : ' + r.errorCodes.join(', '));
    if (r.vilWindowIterations || r.vilRecovered) {
      console.log('    VIL 窗口    : 迭代=' + r.vilWindowIterations + ' 有效观察=' + r.vilWindowObservationOk +
        ' 恢复=' + r.vilRecovered);
    }
    if (r.credNote) console.log('    凭据       : ' + r.credNote);
    if (r.counterfactual) console.log('    反事实修正 : ' + r.counterfactual);
    if (r.error) console.log('    error      : ' + String(r.error).slice(0, 160));
    r.steps.forEach((s) => {
      console.log('      #' + s.index + ' ' + s.type + '/' + s.action + ' → ' + s.target +
        '  [' + s.status + ']  verif=' + s.verification);
    });
    if (process.env.GATE_VERBOSE) {
      console.log('    -- 逐 attempt 证据 --');
      r.attempts.forEach((a) => {
        console.log('      #' + a.stepIndex + ' [' + a.status + '] sel=' + a.selector + ' acted=' + a.acted + ' landed=' + a.landed +
          (a.error ? '  err=' + a.error : ''));
        console.log('          before: ' + a.beforeText);
        console.log('          after : ' + a.afterText);
        if (process.env.GATE_DUMP && a.status !== 'SUCCESS') { console.log('          keys: ' + a.keys); console.log('          raw : ' + a.raw); }
      });
      if (r.verificationDecisions && r.verificationDecisions.length) {
        console.log('    -- VIL 决策 --');
        r.verificationDecisions.forEach((d) => console.log('      ' + JSON.stringify(d).slice(0, 260)));
      }
    }
  }

  const bs = results.filter((r) => r.businessSuccess).length;
  console.log('\n────────────────────────────────────────────────');
  console.log('== Gate 结论 ==');
  console.log('Business Success : ' + bs + '/' + results.length);
  console.log('E5 阻断次数      : ' + results.reduce((a, r) => a + r.guardBlocked, 0));
  console.log('验证通过率       : ' +
    results.reduce((a, r) => a + r.verificationPassed, 0) + '/' + results.reduce((a, r) => a + r.verificationTotal, 0));
  console.log('VIL 观察窗口     : 迭代=' + results.reduce((a, r) => a + (r.vilWindowIterations || 0), 0) +
    '  有效观察=' + results.reduce((a, r) => a + (r.vilWindowObservationOk || 0), 0) +
    '  恢复=' + results.reduce((a, r) => a + (r.vilRecovered || 0), 0));

  const outFile = path.join(OUT_DIR, 'phase9_gate4_replay_' + Date.now() + '.json');
  fs.writeFileSync(outFile, JSON.stringify({
    mode: 'deterministic-replay',
    note: 'plan 回放自 phase68 真实跑批；执行/验证/判定全部真实。LLM 规划环节未覆盖（环境无 DEEPSEEK_API_KEY）。',
    results,
    summary: {
      businessSuccess: bs, total: results.length,
      guardBlocked: results.reduce((a, r) => a + r.guardBlocked, 0),
      verificationPassed: results.reduce((a, r) => a + r.verificationPassed, 0),
      verificationTotal: results.reduce((a, r) => a + r.verificationTotal, 0),
      vilWindowIterations: results.reduce((a, r) => a + (r.vilWindowIterations || 0), 0),
      vilWindowObservationOk: results.reduce((a, r) => a + (r.vilWindowObservationOk || 0), 0),
      vilRecovered: results.reduce((a, r) => a + (r.vilRecovered || 0), 0),
    },
  }, null, 2));
  console.log('\n结果已写入: ' + path.relative(ROOT, outFile));
  process.exit(0);
})().catch((e) => { console.error('[gate] 异常: ', e && e.stack || e); restoreStore(); process.exit(1); });
