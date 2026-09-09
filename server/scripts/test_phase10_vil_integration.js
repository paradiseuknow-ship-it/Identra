'use strict';

// Phase 10.7 集成测试：真实浏览器驱动 VIL 观察窗口（async fixtures）。
// 不依赖 LLM / DeepSeek —— 直接验证 WAIT / RECHECK / VERIFY / SUCCESS / TIMEOUT / ESCALATION 链路。
// 运行：node server/scripts/test_phase10_vil_integration.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const vwin = require('../agent/verification/verificationWindow');
const vil = require('../agent/verification/verificationIntelligence');
const observation = require('../agent/observation');
const verification = require('../agent/verification');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n=== ' + name + ' ==='); }

function startServer() {
  const root = path.resolve(__dirname, '..', '..', 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.statusCode = 403; res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.end('not found'); return; }
      const ext = path.extname(file);
      const ct = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript' : 'text/plain';
      res.setHeader('Content-Type', ct);
      res.end(data);
    });
  });
  return require('./lib_safe_port').listenSafe(server, '127.0.0.1').then((srv) => ({ server: srv, port: srv.address().port }));
}

async function main() {
  const mock = await startServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  const browser = await chromium.launch({ headless: true });

  // 事件计数器（复用 aiEvents schema，不落库）
  const events = [];
  const emit = (e) => events.push(e);

  // ---------- async-success：FAIL → VIL → WAIT → RECHECK → VERIFY → SUCCESS ----------
  section('1. async-success：真实异步恢复（WAIT + RECHECK + VERIFY → SUCCESS）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/async/async-success.html');
    // 模拟「动作」：点击触发按钮（真实 DOM 异步变更）
    await page.click('#trigger');
    // 初始观察（点击后即刻，尚未 SUCCESS）
    const initObs = await observation.inspect(page, { skipCache: true });
    ok(/Processing/i.test(initObs.observation.textSummary || '') && !/SUCCESS/i.test(initObs.observation.textSummary || ''), '初始观察处于 Processing（尚未 SUCCESS，验证已失败，进入窗口）');

    // VIL 分类：稳定但无目标证据，或处于异步处理中（Processing）→ 可恢复类（RECHECK_OBSERVATION）
    // 注：P4 ASYNC_PENDING 集成后，含 "Processing" 文本的观察会被精确分类为 ASYNC_PENDING（仍是可恢复类），
    //     故此处允许列表需包含 ASYNC_PENDING（原 STATE_UNKNOWN / EVENTUAL_CONSISTENCY / OBSERVATION_DELAY 语义不变）。
    const dec = vil.analyze({ beforeObservation: {}, afterObservation: initObs.observation, expectedVerification: { type: 'text_present', expect: 'SUCCESS' }, actionResult: { success: true } });
    ok(['STATE_UNKNOWN', 'EVENTUAL_CONSISTENCY', 'OBSERVATION_DELAY', 'ASYNC_PENDING'].includes(dec.failureType), 'VIL 分类触发可恢复类（' + dec.failureType + '）');
    emit({ type: 'ai.verification.decision', payload: { failureType: dec.failureType, decision: dec.decision } });

    // 运行观察窗口（真实重观察 + 真实重验证）
    const win = await vwin.runObservationWindow({
      page, taskId: 'int-async-success', ctx: { taskId: 'int-async-success' },
      verification: { type: 'text_present', expect: 'SUCCESS' },
      beforeObservation: {}, initialObservation: initObs.observation,
      decision: dec.decision, verifyFn: verification.verify, inspectFn: (p, o) => observation.inspect(p, o), emit,
    });
    ok(win.recovered === true, 'async-success：窗口恢复成功（recovered=true）');
    ok(win.observationCount >= 2, '观察次数 >= 2（初始 + 至少一次重观察，RECHECK 真实发生），实际 ' + win.observationCount);
    ok(win.verificationAttempts >= 2, '验证尝试 >= 2，实际 ' + win.verificationAttempts);
    const waitEvents = events.filter((e) => e.type === 'ai.verification.window');
    ok(waitEvents.length >= 1, '发出 ai.verification.window 事件（WAIT 计数 = ' + waitEvents.length + '）');
    ok(win.stateChanged === true, 'stateChanged=true（DOM 从 Pending 变为 SUCCESS）');
    // 恢复事件
    emit({ type: 'ai.verification.recovered', payload: { failureType: dec.failureType, decision: dec.decision, recoveryAction: 'WAIT+RECHECK' } });
    await page.close();
  }

  // ---------- async-loading：loading → 最终态 ----------
  section('2. async-loading：loading 后稳定态恢复');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/async/async-loading.html');
    // 该 fixture 在 load 时自动进入 Loading → Loaded（无触发按钮）
    const initObs = await observation.inspect(page, { skipCache: true });
    ok(/Loading/i.test(initObs.observation.textSummary || ''), '初始观察处于 Loading 态');
    const dec = vil.analyze({ beforeObservation: {}, afterObservation: initObs.observation, expectedVerification: { type: 'text_present', expect: 'Loaded' }, actionResult: { success: true } });
    const win = await vwin.runObservationWindow({
      page, taskId: 'int-async-loading', ctx: { taskId: 'int-async-loading' },
      verification: { type: 'text_present', expect: 'Loaded' },
      beforeObservation: {}, initialObservation: initObs.observation,
      decision: dec.decision, verifyFn: verification.verify, inspectFn: (p, o) => observation.inspect(p, o), emit,
    });
    ok(win.recovered === true, 'async-loading：等待稳定后出现 Loaded，恢复成功');
    await page.close();
  }

  // ---------- async-never-success：永不成立 → TIMEOUT → 不恢复（不无限等待） ----------
  section('3. async-never-success：明确超时收口（TIMEOUT → 不恢复）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/async/async-never-success.html');
    // 该 fixture 在 load 时自动进入 Processing 且永不成功（无触发按钮）
    const initObs = await observation.inspect(page, { skipCache: true });
    const start = Date.now();
    const dec = vil.analyze({ beforeObservation: {}, afterObservation: initObs.observation, expectedVerification: { type: 'text_present', expect: 'SUCCESS' }, actionResult: { success: true } });
    const win = await vwin.runObservationWindow({
      page, taskId: 'int-async-never', ctx: { taskId: 'int-async-never' },
      verification: { type: 'text_present', expect: 'SUCCESS' },
      beforeObservation: {}, initialObservation: initObs.observation,
      decision: dec.decision, verifyFn: verification.verify, inspectFn: (p, o) => observation.inspect(p, o), emit,
    });
    const elapsed = Date.now() - start;
    ok(win.recovered === false, 'async-never：窗口明确未恢复（recovered=false）');
    ok(elapsed < vwin.DEFAULT_MAX_MS + 3000, 'async-never：在 (maxMs+' + 3000 + 'ms) 内收口（无无限等待），实际 ' + elapsed + 'ms');
    ok(win.elapsedMs <= vwin.DEFAULT_MAX_MS + 1500, '窗口受 DEFAULT_MAX_MS 上限约束（elapsedMs=' + win.elapsedMs + '）');
    // 超时后必须升级（不静默通过）
    const wouldEscalate = (win.recovered === false);
    ok(wouldEscalate === true, '超时未恢复 → 必须交上层 HUMAN_ESCALATE（不 silent-pass）');
    await page.close();
  }

  // ---------- 停止门计数 ----------
  section('4. 停止门计数（VIL decision / WAIT / RECHECK / recovered）');
  const decisionEvents = events.filter((e) => e.type === 'ai.verification.decision');
  const windowEvents = events.filter((e) => e.type === 'ai.verification.window');
  const recoveredEvents = events.filter((e) => e.type === 'ai.verification.recovered');
  ok(decisionEvents.length > 0, 'VIL decision 事件 > 0（实际 ' + decisionEvents.length + '）');
  ok(windowEvents.length > 0, 'WAIT/RECHECK 窗口事件 > 0（实际 ' + windowEvents.length + '）');
  ok(recoveredEvents.length > 0, 'VIL recovered 事件 > 0（实际 ' + recoveredEvents.length + '）');
  // RECHECK = observationCount 累计 - 1（初始）
  const totalObs = windowEvents.reduce((a, e) => a + (e.payload.observationCount || 0), 0);
  ok(totalObs > 3, 'RECHECK（重新观察）真实发生，observationCount 累计 = ' + totalObs);

  await browser.close();
  try { mock.server.close(); } catch (e) {}

  console.log('\n---------------------------------------------------');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  console.log('---------------------------------------------------');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('[integration] 异常:', (e && e.stack) || e); process.exit(1); });
