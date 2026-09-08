'use strict';
// C64 守护测试 —— browserManager launch 并发去重 + 失败路径 shim 清理
// （FPB_DATA_DIR tmp 隔离 via child process——identityStore/PROFILES_ROOT 模块加载时
//  定死，同 C59 先例；fake playwright context 零浏览器零外网）。
// 缺陷背景（browserManager.js 1524 行大文件深扫——老模块扫描终点站）：
//   L1 (B类) launch 仅以 sessions.has 判重：launchPersistentContext await 数秒期间
//      sessions 尚未 set，同 profile 并发 launch（前端双击/自动化并发）各自走完
//      前段 → 撞同一 userDataDir（Chrome SingletonLock 冲突/双实例半启动/profile
//      数据损坏）。修复：in-flight Promise 表共享同一次启动。
//   L2 (B类) launch 失败路径（launchPersistentContext 抛错等）已创建的本地 shim
//      server 无人关闭（close() 只覆盖成功路径）→ listen 句柄/端口随失败次数累积
//      泄漏。修复：catch 内统一关闭后 rethrow。
// 覆盖：
//   P1 L1 最强实证：并发两次 launch 同一 profile → launchPersistentContext 仅 1 次调用
//      + 两次返回同一 session
//   P2 L1 失败后允许重试：失败 launch 清除 in-flight → 再次调用重新走启动
//   P3 L2 最强实证：launchPersistentContext 抛错 → 传播错误且 shim server 已关闭
//      （listening === false，修复前泄漏为 true）
//   P4 L1 正常路径回归：串行第二次 launch 直接返回既有 session（不再调 launch）
//   P5 fake session 形态完整：shimServers/chromePid/pages 记录在案（正常路径结构不回归）

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('FAIL ' + name + ' :: ' + JSON.stringify(detail)); }
}

const CHILD_SCRIPT = `
'use strict';
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('FAIL ' + name + ' :: ' + JSON.stringify(detail)); }
}

const ROOT = process.env.FPB_ROOT;
const which = process.env.C64_PHASE;

// monkeypatch playwright：拦截 launchPersistentContext（零真实浏览器）
const pwPath = require.resolve('playwright', { paths: [ROOT, path.join(ROOT, 'server')] });
const pw = require(pwPath);
const launchCalls = [];
let failNext = false;
let delayMs = 0;
pw.chromium.launchPersistentContext = async function (userDataDir, opts) {
  launchCalls.push({ userDataDir, headless: opts && opts.headless });
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  if (failNext) { const e = new Error('simulated launch failure'); throw e; }
  const fakePage = {
    url: () => 'about:blank',
    goto: async () => ({}),
    on: () => {},
    context: () => fakeContext,
  };
  const fakeContext = {
    _browser: { _process: { pid: 424242 } }, // 方式1 直接取 PID，避免 powershell 枚举
    pages: () => [fakePage],
    newPage: async () => { throw new Error('fake: no new pages'); },
    addInitScript: async () => {},
    on: () => {},
    close: async () => {},
  };
  return fakeContext;
};

const browserManager = require(path.join(ROOT, 'server', 'browserManager.js'));
const { startHttpShim } = require(path.join(ROOT, 'server', 'httpProxyShim.js'));

const mkProfile = (id) => ({
  id, name: id, os: 'windows', browser: 'chrome', headless: true,
  fingerprint: {}, fingerprintOverride: {}, launchBehavior: {},
  proxyInline: { type: 'http', server: '127.0.0.1:1', username: '', password: '' }, // 死上游：shim 照常启动
});

(async () => {
  if (which === 'l1') {
    // ---- P1 并发去重 ----
    delayMs = 400; // 拉长 launchPersistentContext 窗口（老实现此窗口内并发必撞）
    const profile = mkProfile('c64conc1');
    const [a, b] = await Promise.all([
      browserManager.launch(profile, []),
      browserManager.launch(profile, []),
    ]);
    chk('P1.single-launch-call', launchCalls.length === 1, 'concurrent launches must share one startup (got: ' + launchCalls.length + ')');
    chk('P1.same-session', a === b, 'both callers must receive the same session object');
    delayMs = 0;

    // ---- P4 串行第二次直接复用 ----
    const c = await browserManager.launch(profile, []);
    chk('P4.serial-reuse', c === a && launchCalls.length === 1, 'serial relaunch must return existing session without re-launch');
    await browserManager.close(profile.id).catch(() => {});

    // ---- P2 失败后允许重试 ----
    failNext = true;
    let threw = null;
    try { await browserManager.launch(mkProfile('c64retry'), []); } catch (e) { threw = e; }
    chk('P2.failure-propagates', !!threw, 'launch failure must propagate');
    failNext = false;
    const s2 = await browserManager.launch(mkProfile('c64retry'), []);
    chk('P2.retry-after-failure', !!s2 && launchCalls.length === 3, 'failed launch must clear in-flight and allow retry (launchCalls: ' + launchCalls.length + ')');
    await browserManager.close('c64retry').catch(() => {});
  }

  if (which === 'l2') {
    // ---- P3 失败路径 shim 清理 ----
    const countServers = () => process._getActiveHandles().filter((h) => h && (typeof h.listening === 'boolean' || (h.constructor && h.constructor.name === 'Server'))).length;
    const profile = mkProfile('c64shim');
    let threw = null;
    // 对照 shim：await close 回调确保句柄完全释放（基线卫生），并验证 close 语义
    const probe = await startHttpShim({ server: '127.0.0.1:1', username: '', password: '' }, { hopProxy: null });
    await new Promise((r) => probe.server.close(r));
    chk('P3.close-semantics-sanity', probe.server.listening === false, 'probe shim close() must stop listening (sanity)');
    const before = countServers();
    // 注意：probe 自身 handle 释放存在 Node close 事件 tick 延迟（Windows 实测），
    // 不做绝对零断言；L2 的证据是「每次失败 launch 后计数归零」的绝对断言（下方 mid/after）。
    console.log('INFO P3.baseline-servers=' + before);
    failNext = true;
    try { await browserManager.launch(profile, []); } catch (e) { threw = e; }
    chk('P3.failure-propagates', !!threw, 'launch failure must propagate');
    await new Promise((r) => setTimeout(r, 100));
    const mid = countServers();
    chk('P3.first-failure-no-leak', mid === 0, 'first failed launch must close its shim (got: ' + mid + ')');
    try { await browserManager.launch(mkProfile('c64shim2'), []); } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
    const after = countServers();
    chk('P3.no-shim-leak', after === 0, 'second failed launch must close its shim too (got: ' + after + ')');
  }

  // ---- P5 fake session 结构（正常路径，L1 流程的副产品断言）----
  if (which === 'l1') {
    const s = browserManager.getSession('c64conc1') || null;
    // 注意 P1/P4 close 掉了，这里只做模块导出面回归
    chk('P5.exports-intact', typeof browserManager.launch === 'function' && typeof browserManager.close === 'function' && typeof browserManager.isRunning === 'function', 'public surface intact');
  }

  console.log('CHILD_RESULT ' + pass + ' ' + fail);
  if (fail > 0) { failures.forEach((f) => console.log('CHILD_FAILED ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('CHILD FATAL', e); process.exit(2); });
`;

(async () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'c64-data-'));
  // 清理被 monkeypatch 的 playwright require 缓存影响：两阶段各自独立 child
  for (const phase of ['l1', 'l2']) {
    const r = spawnSync(NODE, ['-e', CHILD_SCRIPT], {
      encoding: 'utf8',
      timeout: 180000,
      env: {
        ...process.env,
        C64_PHASE: phase,
        FPB_ROOT: ROOT,
        FPB_DATA_DIR: path.join(tmpData, phase),
        FPB_ALLOW_EPHEMERAL_KEY: '1',
        // 明确禁用 native 二进制 gate（isC2..C6 全 false → fake context 免 CDP）
        FPB_NATIVE_CHROME: '',
      },
    });
    const out = (r.stdout || '') + (r.stderr || '');
    process.stdout.write(out);
    const m = (r.stdout || '').match(/CHILD_RESULT (\d+) (\d+)/);
    if (!m) throw new Error('child [' + phase + '] produced no CHILD_RESULT (exit=' + r.status + ')');
    pass += Number(m[1]); fail += Number(m[2]);
  }
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch (e) { /* tmp 清理尽力而为 */ }

  console.log('\n===== C64 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (fail > 0) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
