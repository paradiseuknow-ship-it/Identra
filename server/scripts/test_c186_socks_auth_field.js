'use strict';

// C186 守护：SOCKS5 上游认证的字段映射（用户名必须真的发出去）。
//
// 背景（2026-10-22 用户报「环境启动失败」）：
//   socks 库 v2.x 的 ProxyInfo 认证字段名是 userId，不是 username。
//   旧实现两处都写 username ⇒ 库读到 userId 缺失 ⇒ **用户名恒为空，只发密码** ⇒
//   上游认证失败（SOCKS5 应答 rep=0x02 NotAllowed）⇒ 上游被误判成「不支持 SOCKS5 转发」
//   ⇒ 自动降级 http ⇒ 出口 IP 探测耗尽重试 ⇒ 「环境启动」被阻断。
//   失败是**静默**的：没有异常、没有日志，只有启动被拒 + 一条会误导方向的错误信息。
//
// 因此本守护不复述字段名，而是**把库真正发出去的字节抓下来**：
//   起一个本地 SOCKS5 服务端，用 socks 库真实握手，断言 AUTH 报文里的用户名长度>0 且值正确。
//   同时用旧写法（username）跑同一条链路，断言用户名长度=0 —— 证明该断言有分辨力，
//   而不是「不管怎么写都绿」的真空断言。
//
// 运行：node server/scripts/test_c186_socks_auth_field.js

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

// C140：夹具隔离数据根（proxyChecker 间接依赖 geoip/data，按纪律先隔离再 require）
const TMP = path.join(os.tmpdir(), 'c186_socks_field_' + Date.now());
process.env.FPB_DATA_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const SERVER_DIR = path.join(__dirname, '..');
const pc = require(path.join(SERVER_DIR, 'proxyChecker.js'));
const { SocksClient } = require(path.join(SERVER_DIR, '..', 'node_modules', 'socks'));
// C94 纪律：禁止裸随机端口监听（动态端口可能落在 Chromium unsafe-port 黑名单），
// 本地假服务端一律消费共享原语 listenSafe 取安全端口。
const { listenSafe } = require('./lib_safe_port.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got));
}

// ---------------------------------------------------------------------------
// 假 SOCKS5 服务端：完整走完 greeting → auth → connect，并记录客户端发来的认证字段
// ---------------------------------------------------------------------------
function startFakeSocks5() {
  const captured = { greeting: null, auth: null, connect: null };
  const server = net.createServer((c) => {
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = [];
        for (let i = 0; i < n; i++) methods.push(buf[2 + i]);
        captured.greeting = { raw: buf.slice(0, 2 + n).toString('hex'), methods: methods.map((m) => '0x' + m.toString(16)) };
        const useAuth = methods.includes(0x02);
        c.write(Buffer.from([0x05, useAuth ? 0x02 : 0x00]));
        buf = Buffer.alloc(0);
        stage = useAuth ? 'auth' : 'connect';
        return;
      }
      if (stage === 'auth') {
        const ulen = buf[1];
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen];
        if (buf.length < 2 + ulen + 1 + plen) return;
        captured.auth = {
          raw: buf.toString('hex'),
          userLen: ulen,
          user: buf.slice(2, 2 + ulen).toString(),
          passLen: plen,
          pass: buf.slice(2 + ulen + 1, 2 + ulen + 1 + plen).toString(),
        };
        c.write(Buffer.from([0x01, 0x00]));
        buf = Buffer.alloc(0);
        stage = 'connect';
        return;
      }
      if (stage === 'connect') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host = null, portOff = 0;
        if (atyp === 0x01) { host = Array.from(buf.slice(4, 8)).join('.'); portOff = 8; }
        else if (atyp === 0x03) { const l = buf[4]; host = buf.slice(5, 5 + l).toString(); portOff = 5 + l; }
        else { host = 'atyp' + atyp; portOff = 5; }
        if (buf.length < portOff + 2) return;
        captured.connect = { atyp: '0x' + atyp.toString(16), host, port: buf.readUInt16BE(portOff) };
        c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        stage = 'done';
      }
    });
  });
  return listenSafe(server, '127.0.0.1').then(() => ({}))
    .then(() => ({ server, port: server.address().port, captured }));
}

// 用给定 proxy 对象跑一次真实握手，返回抓到的报文
async function handshakeWith(proxyObj) {
  const fake = await startFakeSocks5();
  try {
    let connErr = null;
    try {
      const info = await SocksClient.createConnection({
        proxy: Object.assign({ host: '127.0.0.1', port: fake.port, type: 5 }, proxyObj),
        command: 'connect',
        destination: { host: 'example.com', port: 443 },
        timeout: 5000,
      });
      try { info.socket.destroy(); } catch (e) {}
    } catch (e) { connErr = e.message; }
    // 给假服务端一点时间写满 captured
    await new Promise((r) => setTimeout(r, 120));
    try { fake.server.close(); } catch (e) {}
    return { captured: fake.captured, connErr };
  } finally {
    try { fake.server.close(); } catch (e) {}
  }
}

(async () => {
  console.log('== A. socksProxyInfo 契约（字段名与值映射）==');
  const parts = { host: 'proxy.example.com', port: 1080, username: 'u_alpha', password: 'p_secret' };
  const info = pc.socksProxyInfo(parts);
  ok('A1 认证字段名是 userId', Object.prototype.hasOwnProperty.call(info, 'userId'));
  ok('A2 不再出现 username 字段（库会静默忽略它）', !Object.prototype.hasOwnProperty.call(info, 'username'));
  eq('A3 username 被映射到 userId', info.userId, 'u_alpha');
  eq('A4 密码原样传递', info.password, 'p_secret');
  eq('A5 host/port/type 传递正确', [info.host, info.port, info.type], ['proxy.example.com', 1080, 5]);

  const anonymous = pc.socksProxyInfo({ host: 'h', port: 1, username: undefined, password: undefined });
  eq('A6 无凭据时 userId/password 为空串（不发 null/undefined 给库）', [anonymous.userId, anonymous.password], ['', '']);

  console.log('\n== B. 真实握手：库实际发出的认证字节（新写法）==');
  // 只把**认证字段**交给握手夹具，host/port 必须指向本地假服务端
  const goodInfo = pc.socksProxyInfo({ host: 'irrelevant', port: 1, username: 'u_alpha', password: 'p_secret' });
  const good = await handshakeWith({ userId: goodInfo.userId, password: goodInfo.password });
  ok('B1 握手成功完成（无异常）', good.connErr === null, good.connErr);
  ok('B2 客户端提供了用户/密码认证方法', !!(good.captured.greeting && good.captured.greeting.methods.includes('0x2')),
    good.captured.greeting && good.captured.greeting.methods.join(','));
  ok('B3 用户名长度 > 0（旧实现恒为 0）', !!(good.captured.auth && good.captured.auth.userLen > 0),
    good.captured.auth && ('userLen=' + good.captured.auth.userLen));
  eq('B4 用户名逐字等于配置值', good.captured.auth && good.captured.auth.user, 'u_alpha');
  eq('B5 密码逐字等于配置值', good.captured.auth && good.captured.auth.pass, 'p_secret');
  eq('B6 目标按域名下发（ATYP=3，不做本地解析）',
    [good.captured.connect && good.captured.connect.atyp, good.captured.connect && good.captured.connect.host, good.captured.connect && good.captured.connect.port],
    ['0x3', 'example.com', 443]);

  console.log('\n== C. 反证：旧写法（username 字段）确实丢掉用户名 ==');
  const bad = await handshakeWith({ username: 'u_alpha', password: 'p_secret' });
  ok('C1 旧写法用户名长度为 0（证明 B3/B4 有分辨力）', !!(bad.captured.auth && bad.captured.auth.userLen === 0),
    bad.captured.auth && ('userLen=' + bad.captured.auth.userLen));
  eq('C2 旧写法只发出密码（正是上游 NotAllowed 的成因）', bad.captured.auth && bad.captured.auth.pass, 'p_secret');

  console.log('\n== D. 静态防漂移：不得再出现「裸字段 + type:5」的第二副本 ==');
  const src = fs.readFileSync(path.join(SERVER_DIR, 'proxyChecker.js'), 'utf8');
  const bareDupes = src.split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter((x) => /type:\s*5/.test(x.line) && /username:/.test(x.line) && !/^\s*\/\//.test(x.line));
  eq('D1 proxyChecker 内无裸 socks ProxyInfo 字面量（必须走 socksProxyInfo）', bareDupes.map((x) => x.no), []);
  ok('D2 两处 SocksClient 调用都走统一构造', (src.match(/proxy:\s*socksProxyInfo\(parts\)/g) || []).length === 2,
    'count=' + (src.match(/proxy:\s*socksProxyInfo\(parts\)/g) || []).length);
  ok('D3 socksProxyInfo 已导出（可被守护真实执行）', typeof pc.socksProxyInfo === 'function');

  console.log('\n' + '='.repeat(52));
  console.log('C186 socks-auth-field  pass=' + pass + ' fail=' + fail);
  if (fail) { console.log('FAILED'); process.exitCode = 1; } else { console.log('ALL GREEN'); }
})();
