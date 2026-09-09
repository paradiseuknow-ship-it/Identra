'use strict';
// C63 守护测试 —— httpProxyShim CONNECT 隧道 settled守卫 + systemStorage cleanup
// fail-closed + screencast pushFrame 恒等透传（tmp/本地隔离、零浏览器、零外网）。
// 缺陷背景（老模块扫描第 4 批）：
//   D1 (B类) httpProxyShim CONNECT：隧道建立（200 已回复 + pipe 生效）后上游 error
//      仍触发重试分支 → 第二次 tryOnce 对 clientSocket 二次注入
//      'HTTP/1.1 200 Connection established' 响应头 + 重复 pipe = 已协商 TLS 流被注入
//      垃圾字节（hop 模式 + 不稳定上游正是 shim 的目标场景）。
//   D2 (B类) systemStorage.cleanupBrowserProfiles：isRunning 未注入时老实现视为
//      「全部未运行」= 危险默认方向反了 → fail-closed（不注入判定函数就拒绝列候选）。
//   D3 (C类) screencastManager.attachScreencast：p.data 已是 base64，decode→encode
//      恒等往返每帧白做一次全帧编解码（消除）。
// 覆盖：
//   P0 D3 恒等：FrameHub 订阅方收到的帧字节 === pushFrame 传入字符串
//   P1 D1 最强实证：fake 上游 200 建隧道后主动 error → 客户端字节流中 200 头仅 1 次
//      + fake 上游连接数仅 1（settled 守卫阻断重试）
//   P2 D1 建立前重试语义保持：上游 200 前断开 → 仍按既有重试语义走（此处只验证
//      非 200 拒绝路径仍能重试到第二次连接）
//   P3 D1 正常路径回归：200 → 双向 echo 数据完整性（pipe 不回归）
//   P4 D2 fail-closed：不传 isRunning → candidates 空 + skipped 提示
//   P5 D2 正常路径：isRunning 注入 → 运行中 kept、未运行进 candidates
//   P6 baseline：cleanupBenchmarkLogs keepRecent/olderThanDays 语义不回归

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + JSON.stringify(detail)); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fake 上游 HTTP 代理：收到 CONNECT 回 200 并 echo 隧道数据；可配置在建立后 destroy
function fakeUpstream({ destroyAfterTunnel = false, rejectFirstN = 0 } = {}) {
  const state = { connections: 0, tunnels: 0, echo: [] };
  const server = net.createServer((sock) => {
    state.connections++;
    if (rejectFirstN >= state.connections) { sock.destroy(); return; } // 直接断开（触发 error 路径）
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString('utf8');
      const rest = buf.slice(idx + 4);
      if (/^CONNECT /m.test(head)) {
        state.tunnels++;
        sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (rest.length) { state.echo.push(rest); sock.write(rest); }
        if (destroyAfterTunnel) {
          // 隧道建立后（已回 200）主动毁链——触发 shim 的 upstream error
          setTimeout(() => sock.destroy(), 30);
        }
        // 之后进入 echo 模式
        sock.on('data', (d2) => { state.echo.push(d2); sock.write(d2); });
      } else {
        state.echo.push(d);
        sock.write(d);
      }
    });
    sock.on('error', () => {});
  });
  return { server, state };
}

function listen(server) {
  return require('./lib_safe_port').listenSafe(server, '127.0.0.1').then(() => server.address().port);
}

// 对 shim 发 CONNECT 并收集响应直到 idle
function tunnelClient(shimPort, payload, { waitMs = 700 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(shimPort, '127.0.0.1');
    const chunks = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('error', () => {});
    sock.on('connect', () => {
      sock.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      setTimeout(() => { try { sock.write(payload); } catch (e) {} }, 150);
      setTimeout(() => { try { sock.end(); } catch (e) {} try { sock.destroy(); } catch (e) {} resolve(Buffer.concat(chunks)); }, waitMs);
    });
  });
}

(async () => {
  const { startHttpShim } = require(path.join(__dirname, '..', 'httpProxyShim.js'));
  const systemStorage = require(path.join(__dirname, '..', 'systemStorage.js'));
  const { createFrameHub } = require(path.join(__dirname, '..', 'screencastManager.js'));

  // ---- P0 D3：FrameHub 帧透传恒等 ----
  {
    const seen = [];
    const hub = createFrameHub({ minFrameIntervalMs: 1, onNeedStart() {}, onNeedStop() {} });
    hub.subscribe((f) => seen.push(f.jpeg));
    const jpeg = 'AAECAwQFBgcICQ=='; // 任意 base64 字符串（CDP p.data 形态）
    hub.pushFrame(jpeg);
    await sleep(50);
    chk('P0.frame-passthrough-identity', seen.length === 1 && seen[0] === jpeg, 'frame must pass through byte-identical (got: ' + JSON.stringify(seen) + ')');
  }

  // ---- P1 D1 最强实证：隧道建立后上游 error → 不重试、不二次注入 200 ----
  {
    const fu = fakeUpstream({ destroyAfterTunnel: true });
    const upPort = await listen(fu.server);
    const shim = await startHttpShim({ server: '127.0.0.1:' + upPort, username: '', password: '' }, { hopProxy: null });
    try {
      const received = await tunnelClient(shim.port, Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05]), { waitMs: 900 });
      const s = received.toString('latin1');
      const count200 = (s.match(/200 Connection established/g) || []).length;
      chk('P1.single-200', count200 === 1, 'client stream must contain exactly one 200 header (got: ' + count200 + ')');
      chk('P1.no-retry-connections', fu.state.connections === 1, 'upstream must see exactly 1 connection after settled error (got: ' + fu.state.connections + ')');
      chk('P1.no-retry-tunnels', fu.state.tunnels === 1, 'upstream must see exactly 1 CONNECT (got: ' + fu.state.tunnels + ')');
    } finally { try { shim.server.close(); } catch (e) {} fu.server.close(); }
  }

  // ---- P2 D1 语义保持：上游 200 前断开 → 仍重试（连接数 > 1）----
  {
    const fu = fakeUpstream({ rejectFirstN: 1 }); // 第 1 次连接直接毁链
    const upPort = await listen(fu.server);
    const shim = await startHttpShim({ server: '127.0.0.1:' + upPort, username: '', password: '' }, { hopProxy: null });
    try {
      await tunnelClient(shim.port, Buffer.alloc(0), { waitMs: 1200 });
      chk('P2.pre-tunnel-retry-preserved', fu.state.connections >= 2, 'pre-tunnel failure must still retry (connections: ' + fu.state.connections + ')');
    } finally { try { shim.server.close(); } catch (e) {} fu.server.close(); }
  }

  // ---- P3 正常路径回归：200 + 双向 echo 完整性 ----
  {
    const fu = fakeUpstream({});
    const upPort = await listen(fu.server);
    const shim = await startHttpShim({ server: '127.0.0.1:' + upPort, username: '', password: '' }, { hopProxy: null });
    try {
      const payload = Buffer.from('TLS-CLIENT-HELLO-SENTINEL-0123456789');
      const received = await tunnelClient(shim.port, payload, { waitMs: 800 });
      chk('P3.200-returned', received.toString('latin1').includes('200 Connection established'), 'tunnel must be established');
      chk('P3.echo-integrity', received.includes(payload), 'payload must round-trip through tunnel intact');
    } finally { try { shim.server.close(); } catch (e) {} fu.server.close(); }
  }

  // ---- P4/P5 D2：cleanupBrowserProfiles fail-closed 与正常路径 ----
  {
    const runBP = (args) => systemStorage.CLEANUP_TARGETS.browserProfiles.run(args);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c63-profiles-'));
    try {
      fs.mkdirSync(path.join(dir, 'running-p'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'idle-p'), { recursive: true });
      const r0 = await runBP({ profilesDir: dir }); // 不传 isRunning
      chk('P4.fail-closed-no-candidates', r0.candidates.length === 0 && !!r0.skipped, 'missing isRunning must refuse to list candidates (got: ' + JSON.stringify(r0.candidates) + ')');
      const r1 = await runBP({ profilesDir: dir, isRunning: (n) => n === 'running-p' });
      chk('P5.running-kept', r1.kept.includes('running-p') && !r1.candidates.some((c) => c.file === 'running-p'), 'running profile must be kept');
      chk('P5.idle-candidate', r1.candidates.length === 1 && r1.candidates[0].file === 'idle-p', 'idle profile must be a candidate');
      // cleanup 整链 dryRun=false 时运行中目录绝不被 rm
      const r2 = await systemStorage.cleanup({ targets: ['browserProfiles'], dryRun: false, isRunning: (n) => n === 'running-p', profilesDir: dir });
      chk('P5.cleanup-rm-idle-only', r2.ok && fs.existsSync(path.join(dir, 'running-p')) && !fs.existsSync(path.join(dir, 'idle-p')), 'cleanup must remove only idle profile dir');
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  }

  // ---- P6 baseline：cleanupBenchmarkLogs 语义 ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c63-bench-'));
    try {
      const now = Date.now();
      const write = (n, ageDays) => { const p = path.join(dir, n); fs.writeFileSync(p, 'x'); fs.utimesSync(p, new Date(now - ageDays * 864e5), new Date(now - ageDays * 864e5)); };
      write('a.log', 10); write('b.log', 8); write('c.log', 1); write('phase9_regression_x.txt', 10);
      const { candidates, kept } = await systemStorage.CLEANUP_TARGETS.benchmarkLogs.run({ olderThanDays: 7, keepRecent: 1, benchDir: dir });
      const names = candidates.map((c) => c.file).sort();
      chk('P6.keep-recent', kept.length === 1 && kept[0] === 'c.log', 'most recent log always kept (got: ' + kept.join(',') + ')');
      chk('P6.old-candidates', JSON.stringify(names) === JSON.stringify(['a.log', 'b.log', 'phase9_regression_x.txt']), 'logs older than 7d (except kept) are candidates (got: ' + JSON.stringify(names) + ')');
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  }

  console.log('\n===== C63 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (fail > 0) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
