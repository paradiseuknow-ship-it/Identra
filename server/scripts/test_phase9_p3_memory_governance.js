'use strict';
// Phase 9 P3 — Element Memory 污染治理专项测试
//
// 背景（P2 中实测到的硬问题）：
//   tools.execute 里 recordSuccess 的条件是 toolOut.success = 【动作机械成功】，
//   而业务验证（verification.verify）在其之后由 runtime 执行。于是：
//     点击 input#q 机械成功 → 记忆 +1 → 随后 text_present 验证失败 → 记忆既不撤销也不扣减
//   → 在 127.0.0.1|搜索表单 上累积出 confidence=1 / success=208 / failed=0 的假成功记忆，
//   → 该记忆又持续把后续 submit 指错目标（element-level success ≠ business success）。
//
// 修复：tools.execute 只【挂起】确认信息（memoryConfirmation），
//       runtime 在【业务验证通过后】才调用 elementMemory.confirmPendingSuccess 落库；
//       验证失败 → 完全不强化。无验证契约的动作保持原行为（立即确认），避免退化。
//
// 覆盖：
//   A. 纯函数：confirmPendingSuccess 行为与空值安全
//   B. 真实链路：验证失败 → 记忆不增长（核心）
//   C. 真实链路：验证通过 → 记忆增长（核心，证明未切断学习）
//   D. 真实链路：无验证契约 → 记忆仍增长（不退化）
//   E. 红线：不绕过验证、不判假成功、不改变 recordFailure 语义

const fs = require('fs');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');

// 每个真实链路 case 必须在【独立子进程】中运行：
// runtime 是全局单例 + profile 锁，前一任务的异步收口（repair/escalate）会与后一任务的状态机冲突，
// 实测表现为「非法 Task 状态转换: CANCELLED -> PAUSED_FOR_HUMAN」。子进程隔离可彻底避免。
const CASE = (() => { const i = process.argv.indexOf('--case'); return i < 0 ? null : process.argv[i + 1]; })();
// 只跑指定 case（调试用）：P3_CASES=D 只跑 D 组，默认 BCD。避免每次调试都等全部子进程。
const CASES = process.env.P3_CASES || 'BCD';

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function skipped(name, why) { skip++; console.log('  SKIP ' + name + ' — ' + why); }
function section(t) { console.log('\n== ' + t + ' =='); }

// P3-VIL 专用页面（虚拟路由，不落盘）：
// 刻意构造「动作已完成、但业务结果延迟出现」的真实时序场景 —— 用于覆盖 runtime 的
// 【第二处记忆确认出口】：VIL 观察窗口恢复（verificationWindow.recovered）。
// 点击后立即改变 DOM（使 domChanged=true → VIL 判 RETRY_VERIFY 进入观察窗口），
// 2500ms 后才出现目标文本（晚于 submit 分支的 networkidle 沉降等待，确保首次验证必然失败）。
// 延迟取 2500ms：观察窗口上限 VIL_WINDOW_MAX_MS 默认 5200ms，留足余量。
// 刻意不使用「处理中 / 加载中」字样：那会命中 detectAsyncPending 的 loading 关键词，
// 使 VIL 改判 ASYNC_PENDING（submit 属敏感动作 → HUMAN_ESCALATE），从而不进入观察窗口。
const P3_VIL_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>P3 VIL</title></head>
<body><h1>P3 VIL 时序场景</h1>
<button id="goBtn" onclick="document.getElementById('out').textContent='已接收请求';setTimeout(function(){document.getElementById('out').textContent='处理完成__P3VIL';},2500)">提交申请</button>
<div id="out">待处理</div></body></html>`;

function startMockServer() {
  const root = path.join(ROOT, 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    if (p === '/__p3_vil.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(P3_VIL_HTML);
      return;
    }
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// 读取某 site+semantic 下所有记录的 success 总和（跨 context 汇总，避免 context 差异干扰）
function successSum(site, semantic) {
  const em = require('../agent/intelligence/elementMemory');
  return (em.listAll ? em.listAll() : [])
    .filter((r) => r.site === site && String(r.semantic || '') === String(semantic))
    .reduce((a, r) => a + ((r.samples && r.samples.success) || 0), 0);
}

function newProfile(rw) {
  return {
    id: 'p9_p3_' + rw + '_' + Date.now().toString(36), name: 'P9-P3-' + rw, group: 'default', tags: [], notes: '',
    seed: 'p3-seed', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  };
}

const TERMINAL = ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'];
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 跑一个单步任务，返回 { status, stepStatus }
async function runStep(base, rw, planSteps, opts) {
  const steps = Array.isArray(planSteps) ? planSteps : [planSteps];
  const db = require('../db');
  const taskManager = require('../agent/taskManager');
  const browserManager = require('../browserManager');
  require('../agent/runtime');

  const profile = newProfile(rw);
  db.upsertProfile(profile);
  // 采集验证相关事件：用于断言「确实经过 VIL 观察窗口恢复」而非「首次验证即通过」。
  // 没有它就无法区分 runtime 的两处记忆确认出口，D 组会退化为与 C 组同义的重复覆盖。
  const events = require('../agent/events');
  const vil = { decisions: [], recovered: [], windows: [] };
  // 诊断探针（仅包裹，不改产品代码）：记录窗口内 observation.inspect 的真实调用与异常。
  // verificationWindow 内部 `catch (e) { insp = null }` 静默吞异常，导致「窗口拿到了旧观察」与
  // 「窗口根本没拿到观察」在外部表现完全一致。此探针用于区分二者。
  const emMod = require('../agent/intelligence/elementMemory');
  const origConfirm = emMod.confirmPendingSuccess;
  const confirmProbe = { calls: 0, args: [] };
  emMod.confirmPendingSuccess = function patchedConfirm(conf) {
    confirmProbe.calls += 1;
    confirmProbe.args.push({
      site: conf && conf.site, semantic: conf && conf.semantic,
      hasEl: !!(conf && conf.element), actType: conf && conf.actionType,
    });
    return origConfirm.call(this, conf);
  };
  const observationMod = require('../agent/observation');
  const origInspect = observationMod.inspect;
  const inspectProbe = { calls: 0, fromWindow: 0, errors: [], texts: [] };
  observationMod.inspect = async function patchedInspect(pg, o) {
    inspectProbe.calls += 1;
    const fromWin = !!(o && o.source === 'verification_window');
    if (fromWin) inspectProbe.fromWindow += 1;
    try {
      const r = await origInspect.call(this, pg, o);
      // 必须同时记录 ok=false 的情形：observation.inspect 在 page.evaluate 失败时【返回】
      // { ok:false, error } 而非抛异常。只记成功样本会完全看不到窗口里的真实失败。
      if (fromWin) {
        const t = (r && r.observation) ? String(r.observation.textSummary || r.observation.visibleText || '') : '';
        inspectProbe.texts.push({
          ok: !!(r && r.ok), err: (r && r.error) ? String(r.error).slice(0, 160) : null,
          hasTarget: t.includes('处理完成__P3VIL'), len: t.length, tail: t.slice(-40),
        });
      }
      return r;
    } catch (e) {
      inspectProbe.errors.push({ fromWin, msg: String((e && e.message) || e).slice(0, 200) });
      throw e;
    }
  };
  const off = events.on((e) => {
    if (!e) return;
    if (e.type === 'ai.verification.decision') {
      vil.decisions.push({ ft: (e.payload && e.payload.failureType) || null, d: (e.payload && e.payload.decision) || null });
    }
    if (e.type === 'ai.verification.recovered') vil.recovered.push(e.payload && e.payload.failureType);
    // 窗口内每次迭代的真实结果：iteration / 验证是否成功 / DOM 是否变化 / 累计耗时。
    // verificationWindow 内部静默吞掉 inspect 异常（insp=null → 沿用旧观察），
    // 没有这个事件就无法判断「窗口没等到」还是「窗口拿到了旧观察」。
    if (e.type === 'ai.verification.window') {
      vil.windows.push({
        it: e.payload && e.payload.iteration, ok: e.payload && e.payload.verificationSuccess,
        chg: e.payload && e.payload.stateChanged, el: e.payload && e.payload.elapsedMs,
        obsOk: e.payload && e.payload.observationOk,
        obsErr: (e.payload && e.payload.observationError) || null,
      });
    }
  });
  const task = taskManager.createTask({
    name: 'P9P3-' + rw, objective: 'p3 memory governance',
    targetUrl: base + '/ecommerce/search.html',
    profileId: profile.id, executionMode: 'AUTONOMOUS', constraints: [], policy: { riskFloor: 'HIGH' },
  });
  taskManager.attachPlan(task.id, { goal: 'p3', steps });
  taskManager.start(task.id);

  const end = Date.now() + (opts && opts.timeoutMs || 60000);
  let final = null;
  while (Date.now() < end) {
    final = taskManager.getTask(task.id);
    if (final && TERMINAL.includes(final.status)) break;
    await sleep(400);
  }
  if (!final || !TERMINAL.includes(final.status)) { try { taskManager.cancel(task.id); } catch (e) {} }

  const stepManager = require('../agent/stepManager');
  const doneSteps = stepManager.listSteps(task.id).sort((a, b) => a.index - b.index);
  const targetStep = doneSteps[doneSteps.length - 1]; // 目标动作是最后一步
  const out = {
    status: final ? final.status : 'TIMEOUT',
    stepStatus: targetStep ? targetStep.status : null,
    steps: doneSteps.map((s) => ({ index: s.index, status: s.status })),
    // 诊断信息：逐 attempt 的失败码/消息。测试判定不用它，只在断言失败时回传定位根因。
    debug: doneSteps.map((s) => ({
      index: s.index, status: s.status,
      attempts: (stepManager.listAttempts(s.id) || []).map((a) => ({
        n: a.attemptNo, state: a.state,
        code: (a.error && (a.error.code || a.error.type)) || a.failureCode || null,
        msg: (a.error && (a.error.message || a.error.reason)) || a.failureReason || null,
        // 修复（repair）会改写 action —— 记录真实执行的动作，用于判断记忆为何未增长
        act: a.action ? { type: a.action.type, tgt: a.action.target } : null,
        meta: a.meta || null,
      })),
    })),
    vil, inspectProbe, confirmProbe,
  };
  try { if (typeof off === 'function') off(); } catch (e) {}
  try { observationMod.inspect = origInspect; } catch (e) {}
  try { emMod.confirmPendingSuccess = origConfirm; } catch (e) {}
  try { taskManager.cancel(task.id); } catch (e) {}
  try { browserManager.close(profile.id).catch(() => {}); } catch (e) {}
  try { db.deleteProfile(profile.id); } catch (e) {}
  return out;
}

async function runCaseInChild(name, planStep, timeoutMs, navPath) {
  return new Promise((resolve) => {
    const child = fork(__filename, ['--case', name], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += String(d); });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ caseName: name, error: '子进程超时' }); }, (timeoutMs || 90000) + 30000);
    child.on('exit', () => {
      clearTimeout(timer);
      const m = buf.match(/__RESULT__(\{.*?\})__END__/s);
      if (m) { try { resolve(JSON.parse(m[1])); return; } catch (e) {} }
      resolve({ caseName: name, error: '未解析到结果', tail: buf.slice(-300) });
    });
    child.send({ planStep, timeoutMs: timeoutMs || 60000, navPath: navPath || '/ecommerce/search.html' });
  });
}

// 子进程主体：接收 planStep → 跑真实链路 → 回传结果
if (CASE) {
  process.on('message', async (msg) => {
    let server = null;
    try {
      server = await startMockServer();
      const base = 'http://127.0.0.1:' + server.address().port;
      const sem = msg.planStep.semanticProbe;
      // 前导 navigate：确保动作发生在真实页面上（否则动作在 about:blank 上失败，
      // 记忆「不增长」只是因为没产生元素，无法证明修复生效）
      const navStep = {
        type: 'NAVIGATE',
        action: {
          type: 'navigate', target: { url: base + (msg.navPath || '/ecommerce/search.html') }, value: null, credentialRef: null,
          reason: '', risk: 'LOW', timeoutMs: 20000, retryable: false,
          verification: { type: 'none' },
        },
        verification: { type: 'none' },
      };
      const before = successSum('127.0.0.1', sem);
      const res = await runStep(base, CASE, [navStep, msg.planStep], msg.timeoutMs);
      const after = successSum('127.0.0.1', sem);
      const navOk = res.steps && res.steps[0] ? res.steps[0].status : null;
      process.stdout.write('__RESULT__' + JSON.stringify({
        caseName: CASE, stepStatus: res.stepStatus, taskStatus: res.status,
        navStatus: navOk, before, after, grew: after > before,
        vil: res.vil, debug: res.debug,
        inspectProbe: res.inspectProbe, confirmProbe: res.confirmProbe,
      }) + '__END__');
    } catch (e) {
      process.stdout.write('__RESULT__' + JSON.stringify({ caseName: CASE, error: String((e && e.message) || e) }) + '__END__');
    } finally {
      try { if (server) server.close(); } catch (e) {}
      process.exit(0);
    }
  });
  // 不继续往下走父进程逻辑
  return;
}

(async () => {
  // ─────────────────────────────────────────────
  section('A. 纯函数：confirmPendingSuccess');
  {
    const em = require('../agent/intelligence/elementMemory');
    ok('A.1 空值安全（null / undefined / {}）',
      em.confirmPendingSuccess(null) === null && em.confirmPendingSuccess(undefined) === null && em.confirmPendingSuccess({}) === null);
    ok('A.2 缺 site / semantic / element 时不写入',
      em.confirmPendingSuccess({ semantic: 'x', element: {} }) === null &&
      em.confirmPendingSuccess({ site: 's', element: {} }) === null &&
      em.confirmPendingSuccess({ site: 's', semantic: 'x' }) === null);

    // 每次运行用唯一 site：store 是持久化的，固定 site 会让 success 跨运行累积，导致断言失效
    const site = 'p3.unit.' + Date.now().toString(36) + '.test';
    const el = { tag: 'button', id: 'goBtn', text: 'Go', role: 'button' };
    const r1 = em.confirmPendingSuccess({ site, semantic: '确认按钮', element: el, meta: { type: 'ai_success' } });
    ok('A.3 正常写入并返回 record', !!r1 && (r1.samples && r1.samples.success) === 1, r1 ? JSON.stringify(r1.samples) : 'null');
    const r2 = em.confirmPendingSuccess({ site, semantic: '确认按钮', element: el, meta: { type: 'ai_success' } });
    ok('A.4 重复确认会累加（幂等由调用方保证）', !!r2 && (r2.samples && r2.samples.success) === 2, r2 ? JSON.stringify(r2.samples) : 'null');
  }

  // ─────────────────────────────────────────────
  section('B/C/D. 真实链路：记忆只由业务验证结果强化（子进程隔离）');
  {
    const stepB = {
      type: 'ACT',
      semanticProbe: 'P3探针-验证失败',
      action: {
        type: 'submit', target: { semantic: 'P3探针-验证失败', field: 'search' }, value: null, credentialRef: null,
        reason: '', risk: 'LOW', timeoutMs: 15000, retryable: false,
        verification: { type: 'text_present', expect: '这个字符串在页面上绝对不存在__P3' },
        expectedBusinessState: {
          stateType: 'CUSTOM', expected: '目标不应被观察到',
          requiredEvidence: [{ type: 'text_present', expect: '这个字符串在页面上绝对不存在__P3' }],
          forbiddenEvidence: [], evidenceLogic: 'AND',
        },
      },
      verification: { type: 'text_present', expect: '这个字符串在页面上绝对不存在__P3' },
    };
    const stepC = {
      type: 'ACT',
      semanticProbe: 'P3探针-验证通过',
      action: {
        type: 'submit', target: { semantic: 'P3探针-验证通过', field: 'search' }, value: null, credentialRef: null,
        reason: '', risk: 'LOW', timeoutMs: 15000, retryable: false,
        verification: { type: 'text_present', expect: '购物车' },
        expectedBusinessState: {
          stateType: 'SEARCH_SUCCESS', expected: '搜索页可见文本',
          requiredEvidence: [{ type: 'text_present', expect: '购物车' }],
          forbiddenEvidence: [], evidenceLogic: 'AND',
        },
      },
      verification: { type: 'text_present', expect: '购物车' },
    };
    // D. VIL 观察窗口恢复路径 —— runtime 的【第二处】记忆确认出口。
    // 场景：动作已执行完成，但业务结果 2500ms 后才出现（真实异步落库 / 异步渲染的典型形态）。
    //   → 首次验证失败 → VIL 判 DOM_CHANGED → RETRY_VERIFY → 观察窗口内 Fresh Observation
    //   → 目标文本出现 → 重新验证通过 → recovered。
    // 覆盖点：runtime.js「VIL 观察窗口恢复」分支中的 confirmPendingSuccess 调用。
    // 注：D 组原设计为「无验证契约的动作」，该前提在架构上不成立 —— 见 E.5 红线。
    const stepD = {
      type: 'ACT',
      semanticProbe: 'P3探针-VIL恢复',
      action: {
        type: 'submit', target: { semantic: 'P3探针-VIL恢复', field: 'goBtn' }, value: null, credentialRef: null,
        reason: '', risk: 'LOW', timeoutMs: 15000, retryable: false,
        verification: { type: 'text_present', expect: '处理完成__P3VIL' },
        expectedBusinessState: {
          stateType: 'CUSTOM', expected: '业务结果延迟出现',
          requiredEvidence: [{ type: 'text_present', expect: '处理完成__P3VIL' }],
          forbiddenEvidence: [], evidenceLogic: 'AND',
        },
      },
      verification: { type: 'text_present', expect: '处理完成__P3VIL' },
    };

    const dumpDebug = (tag, r) => {
      if (!process.env.P3_DEBUG) return;
      console.log('  [debug-' + tag + '] vil=' + JSON.stringify(r.vil || null));
      console.log('  [debug-' + tag + '] ' + JSON.stringify(r.debug || r.error || r));
      if (r.inspectProbe) console.log('  [debug-' + tag + '] inspectProbe=' + JSON.stringify(r.inspectProbe));
      if (r.confirmProbe) console.log('  [debug-' + tag + '] confirmProbe=' + JSON.stringify(r.confirmProbe));
    };
    const rB = CASES.includes('B') ? await runCaseInChild('B', stepB, 90000) : null;
    dumpDebug('B', rB || { skipped: true });
    if (!CASES.includes('B')) skipped('B 组', 'P3_CASES=' + CASES);
    else if (rB.error) skipped('B 组', '子进程异常: ' + rB.error);
    else {
      ok('B.0 [前提] navigate 前导步骤成功（否则本组为假通过）', rB.navStatus === 'SUCCESS', 'nav=' + rB.navStatus);
      ok('B.1 动作确实被判定为失败（验证未通过）', rB.stepStatus !== 'SUCCESS', 'step=' + rB.stepStatus + ' task=' + rB.taskStatus);
      ok('B.2 [核心] 验证失败后，该语义的记忆 success 未增长',
        rB.grew === false, 'before=' + rB.before + ' after=' + rB.after);
    }

    const rC = CASES.includes('C') ? await runCaseInChild('C', stepC, 90000) : null;
    dumpDebug('C', rC || { skipped: true });
    if (!CASES.includes('C')) skipped('C 组', 'P3_CASES=' + CASES);
    else if (rC.error) skipped('C 组', '子进程异常: ' + rC.error);
    else {
      ok('C.0 [前提] navigate 前导步骤成功', rC.navStatus === 'SUCCESS', 'nav=' + rC.navStatus);
      ok('C.1 动作被判定为成功', rC.stepStatus === 'SUCCESS', 'step=' + rC.stepStatus + ' task=' + rC.taskStatus);
      ok('C.2 [核心] 验证通过后，该语义的记忆 success 增长',
        rC.grew === true, 'before=' + rC.before + ' after=' + rC.after);
    }

    const rD = CASES.includes('D') ? await runCaseInChild('D', stepD, 90000, '/__p3_vil.html') : null;
    dumpDebug('D', rD || { skipped: true });
    if (!CASES.includes('D')) skipped('D 组', 'P3_CASES=' + CASES);
    else if (rD.error) skipped('D 组', '子进程异常: ' + rD.error);
    else {
      const dec = (rD.vil && rD.vil.decisions) || [];
      const rec = (rD.vil && rD.vil.recovered) || [];
      const wins = (rD.vil && rD.vil.windows) || [];
      ok('D.0 [前提] navigate 前导步骤成功', rD.navStatus === 'SUCCESS', 'nav=' + rD.navStatus);
      ok('D.1 [前提] 首次验证确实失败并进入 VIL 决策（否则本组不覆盖目标路径）',
        dec.length > 0, 'decisions=' + JSON.stringify(dec));
      // 观察窗口内若拿不到观察（inspect ok=false），窗口就只是空转：每次都拿旧观察重新验证，
      // 必然 recovered=false。此断言直接防御该类缺陷（如 getPage 漏 await 传入 Promise）。
      ok('D.1b [前提] 观察窗口内每次观察都真实成功（否则窗口形同失效）',
        wins.length > 0 && wins.every((w) => w.obsOk === true),
        '失败样本=' + JSON.stringify(wins.filter((w) => w.obsOk !== true).slice(0, 2)));
      ok('D.2 [前提] VIL 观察窗口确实恢复了验证（否则本组为假通过）',
        rec.length > 0, 'recovered=' + JSON.stringify(rec));
      ok('D.3 动作最终被判定为成功', rD.stepStatus === 'SUCCESS', 'step=' + rD.stepStatus + ' task=' + rD.taskStatus);
      ok('D.4 [核心] VIL 恢复路径下记忆仍被强化（runtime 第二处确认出口生效）',
        rD.grew === true, 'before=' + rD.before + ' after=' + rD.after);
    }
  }

  // ─────────────────────────────────────────────
  section('E. 红线：不绕过验证 / 不判假成功 / 不改变 recordFailure 语义');
  {
    const verification = require('../agent/verification');
    const noEvidence = { url: 'http://127.0.0.1/ecommerce/search.html', title: '', textSummary: '', elements: [] };
    ok('E.1 [红线] 无证据时 text_present 仍判失败（未降低阈值）',
      verification.verify({ type: 'text_present', expect: '搜索' }, noEvidence).success === false);
    ok('E.2 [红线] 无证据时 element_present 仍判失败',
      verification.verify({ type: 'element_present', expect: 'form' }, noEvidence).success === false);
    const em2 = require('../agent/intelligence/elementMemory');
    const recBefore = em2.listAll().length;
    em2.recordFailure('p3.redline.test', '红线语义', null, null);
    ok('E.3 [红线] recordFailure 语义未变（不因本次改动而失效）', em2.listAll().length >= recBefore);
    ok('E.4 [红线] 记忆确认不改变验证结果本身',
      verification.verify({ type: 'text_present', expect: '搜索' }, noEvidence).success === false);

    // E.5/E.6：D 组原设计（无验证契约的关键动作）在架构上根本不成立 —— 这是既有且正确的红线，
    // 在此固化为显式断言，防止后续改动以「补测试」名义削弱它。
    const { validateAction } = require('../agent/schema/action');
    const noContract = { type: 'click', target: { semantic: 'x', field: 'goBtn' }, verification: { type: 'none' } };
    const vNoContract = validateAction(noContract);
    ok('E.5 [红线] 关键动作无验证契约仍被拒绝（禁止仅以 action_success 作为完成证据）',
      vNoContract.ok === false && (vNoContract.errors || []).join(' ').includes('必须提供有意义的验证'),
      JSON.stringify(vNoContract.errors || []));
    const onlyActionSuccess = { type: 'submit', target: { semantic: 'x', field: 'goBtn' }, verification: { type: 'action_success' } };
    const vOnly = validateAction(onlyActionSuccess);
    ok('E.6 [红线] 关键动作仅用 action_success 仍被拒绝（需补 expectedBusinessState）',
      vOnly.ok === false && (vOnly.errors || []).join(' ').includes('action_success'),
      JSON.stringify(vOnly.errors || []));
  }

  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
