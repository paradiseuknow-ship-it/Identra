'use strict';
// C58 守护测试 —— 代理检测链资源与解析硬化（tmp 隔离、零浏览器、零外网，纯本地 socket）。
//
// 缺陷背景（老模块 proxyChecker.js / proxyPrecheck.js 首轮缺陷扫描，B 类资源/解析缺陷）：
//   D1 资源泄漏：fetchEgressIpViaProxy / quickEgress 失败路径从不 destroy socket ——
//      对死代理每次检测（getEgressIp 2 协议×2 重试，每次 2 策略；detectProxyProtocol 再复检）
//      可悬挂泄漏最多 8 个客户端连接；tlsOver 握手失败也不销毁底层 socket。
//   D2 死代码：httpGetOverSocket 在同文件定义两次（后一份覆盖前一份），两份语义还有差异。
//   D3 分包误判：waitForConnect 负向分支 /HTTP\/1\.[01] (?!200)/ 在 TCP 分包
//      （先到 "HTTP/1.1 2"）时把合法 200 误判为 CONNECT 拒绝。
//   D4 契约违反：precheckProxy 中 getIpInfo 异常直接穿透 → 整次预检被跳过
//      （含 Google 可达性检查），违反模块自述「best-effort、失败仅报警不阻断」。
//   （边界记录：api.ipify.org 实测响应非 chunked，close-delimited；httpGetOverSocket
//    不做 chunked 解码暂不构成缺陷，如未来源响应变化需补 de-chunk。）
//
// 覆盖：
//   P1  D3 最强实证：200 状态行分包到达 → waitForConnect 必须成功（旧代码误判拒绝）
//   P2  D3 回归：完整非 200（407）→ 正确拒绝（含状态码）
//   P3  超时路径：等待 CONNECT 应答超时 → 'proxy connect timeout'
//   P4  非整数状态前缀（"HTTP/1.1 4" + "07"）分包 → 仍正确拒绝（等齐三位）
//   P5  D1 最强实证：getEgressIp 对「407 且永不关闭连接」的假代理 → 拒绝后
//       服务端观测到所有收到 CONNECT 的连接均已被客户端关闭（旧代码悬挂泄漏 → close 永不来）
//   P6  resolveProxyType 走同一假代理 → 不抛错、回落 preferred，且连接同样被关闭
//   P7  D2 代码锚点：httpGetOverSocket 仅一处定义；mid-stream 负向前瞻已移除
//   P8  D4：openSocks5Chain 注入抛错 → precheckProxy 必须整体 resolve（ok:false +
//       google.reachable:false），不得 reject 跳过 Google 检查
//   P9  真实路径形状：checkProxy 对已关闭端口 → ok:false + error 非空 + latencyMs 数值
//
// 用法：node server/scripts/test_c58_proxy_hygiene.js

const net = require('net');
const EE = require('events');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// C58 P8 需要：先打补丁 socksShim 缓存，再加载 proxyPrecheck（其顶层解构捕获函数引用）
const socksShim = require(path.join(ROOT, 'server', 'socksShim.js'));
let chainCalls = 0;
socksShim.openSocks5Chain = async () => { chainCalls++; throw new Error('mock chain down'); };
const precheck = require(path.join(ROOT, 'server', 'proxyPrecheck.js'));
const checker = require(path.join(ROOT, 'server', 'proxyChecker.js'));

function fakeSocket() {
  const s = new EE();
  s.write = () => true;
  s.destroy = () => { s.destroyed = true; };
  return s;
}

// 「407 且永不主动关闭」的假 HTTP 代理：用于泄漏检测
function startRejectProxy() {
  const state = { conns: [] };
  const server = net.createServer((sock) => {
    const rec = { closed: false, sawConnect: false };
    state.conns.push(rec);
    sock.on('close', () => { rec.closed = true; });
    sock.on('error', () => { /* 客户端 destroy 可能触发 ECONNRESET，忽略 */ });
    sock.on('data', (d) => {
      if (!rec.sawConnect && d.toString().startsWith('CONNECT')) rec.sawConnect = true;
      try {
        sock.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="x"\r\nContent-Length: 0\r\n\r\n');
      } catch (e) { /* ignore */ }
    });
  });
  return require('./lib_safe_port').listenSafe(server, '127.0.0.1').then(() => ({ server, port: server.address().port, state }));
}

(async () => {
  // ---- P1: D3 最强实证 —— 200 状态行分包到达 ----
  {
    const s = fakeSocket();
    const p = checker.waitForConnect(s, /HTTP\/1\.[01] 200/, 2000);
    setTimeout(() => s.emit('data', Buffer.from('HTTP/1.1 2')), 20);
    setTimeout(() => s.emit('data', Buffer.from('00 OK\r\n\r\n')), 60);
    let ok = false, err = null;
    try { await p; ok = true; } catch (e) { err = e; }
    chk('P1 分包 200（"HTTP/1.1 2" + "00 OK"）成功通过', ok, '旧代码 mid-stream 负向前瞻误判拒绝: ' + (err && err.message));
  }

  // ---- P2: 完整非 200 → 拒绝（含状态码）----
  {
    const s = fakeSocket();
    const p = checker.waitForConnect(s, /HTTP\/1\.[01] 200/, 2000);
    setTimeout(() => s.emit('data', Buffer.from('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')), 20);
    let err = null;
    try { await p; } catch (e) { err = e; }
    chk('P2 完整 407 正确拒绝', !!err && /rejected \(407\)/.test(err.message), err ? err.message : 'resolved');
  }

  // ---- P3: 超时 ----
  {
    const s = fakeSocket();
    let err = null;
    try { await checker.waitForConnect(s, /HTTP\/1\.[01] 200/, 120); } catch (e) { err = e; }
    chk('P3 CONNECT 应答超时拒绝', !!err && /proxy connect timeout/.test(err.message), err ? err.message : 'resolved');
  }

  // ---- P4: 非整数状态前缀分包 → 等齐三位后仍拒绝 ----
  {
    const s = fakeSocket();
    const p = checker.waitForConnect(s, /HTTP\/1\.[01] 200/, 2000);
    setTimeout(() => s.emit('data', Buffer.from('HTTP/1.1 4')), 20);
    setTimeout(() => s.emit('data', Buffer.from('07 Forbidden\r\n\r\n')), 60);
    let err = null;
    try { await p; } catch (e) { err = e; }
    chk('P4 分包 407 等齐三位状态码后拒绝', !!err && /rejected \(407\)/.test(err.message), err ? err.message : 'resolved');
  }

  // ---- P5: D1 泄漏最强实证 —— 失败后所有 CONNECT 连接被客户端关闭 ----
  {
    const { server, port, state } = await startRejectProxy();
    let rejected = false;
    try {
      await checker.getEgressIp({ type: 'http', server: '127.0.0.1:' + port });
    } catch (e) { rejected = true; }
    await sleep(500); // 等待 destroy 后 close 事件传播
    const connectConns = state.conns.filter((c) => c.sawConnect);
    const leaked = connectConns.filter((c) => !c.closed);
    chk('P5a getEgressIp 对死代理拒绝', rejected, 'expected throw');
    chk('P5b 失败路径无 socket 泄漏（服务端观测全部已关闭）',
      connectConns.length >= 2 && leaked.length === 0,
      'CONNECT 连接=' + connectConns.length + ' 泄漏=' + leaked.length);
    server.close();
  }

  // ---- P6: resolveProxyType 不抛错 + 连接关闭 ----
  {
    const { server, port, state } = await startRejectProxy();
    let t = null, threw = false;
    try { t = await checker.resolveProxyType({ type: 'http', server: '127.0.0.1:' + port }); }
    catch (e) { threw = true; }
    await sleep(500);
    const connectConns = state.conns.filter((c) => c.sawConnect);
    const leaked = connectConns.filter((c) => !c.closed);
    chk('P6a resolveProxyType 回落 preferred 且不抛错', !threw && t === 'http', threw ? 'threw' : 't=' + t);
    chk('P6b quickEgress 失败路径无泄漏', connectConns.length >= 1 && leaked.length === 0,
      'CONNECT 连接=' + connectConns.length + ' 泄漏=' + leaked.length);
    server.close();
  }

  // ---- P7: D2 代码锚点（源文件守护）----
  {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'proxyChecker.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // 剥离注释只看真实代码
    const defs = (code.match(/function httpGetOverSocket\(/g) || []).length;
    chk('P7a httpGetOverSocket 仅一处定义（死代码副本已删）', defs === 1, 'defs=' + defs);
    chk('P7b mid-stream 负向前瞻已移除', !code.includes('(?!200)'), 'found (?!200)');
    chk('P7c 失败路径销毁锚点存在', src.includes('function destroyQuietly(') && (src.match(/destroyQuietly\(/g) || []).length >= 5,
      'destroyQuietly occurrences=' + (src.match(/destroyQuietly\(/g) || []).length);
  }

  // ---- P8: D4 precheckProxy best-effort 契约 ----
  {
    chainCalls = 0;
    let result = null, threw = false;
    try {
      result = await precheck.precheckProxy({ host: '127.0.0.1', port: 1, username: '', password: '' }, null);
    } catch (e) { threw = true; }
    chk('P8a 上游链路抛错时 precheckProxy 整体 resolve（不 reject）', !threw, threw ? 'rejected' : 'resolved');
    chk('P8b 结果形状：ok=false + google.reachable=false（Google 检查未被跳过）',
      result && result.ok === false && result.google && result.google.reachable === false,
      JSON.stringify(result));
    chk('P8c Google 检查确实执行（两次链路调用）', chainCalls === 2, 'chainCalls=' + chainCalls);
  }

  // ---- P9: 真实路径形状（关闭端口，快速失败）----
  {
    const r = await checker.checkProxy({ type: 'http', server: '127.0.0.1:9' });
    chk('P9a checkProxy 死端口 → ok:false + error 非空',
      r && r.ok === false && typeof r.error === 'string' && r.error.length > 0,
      JSON.stringify(r));
    chk('P9b latencyMs 为数值', r && Number.isFinite(r.latencyMs), 'latencyMs=' + (r && r.latencyMs));
  }

  console.log('\n==== C58 守护测试: ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) { console.log(failures.join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
