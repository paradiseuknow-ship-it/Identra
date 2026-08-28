'use strict';

/**
 * 本地 SOCKS5 中转器（shim）。
 *
 * 问题：Chromium / Playwright 的代理不支持 SOCKS5 用户名/密码认证
 * （会报 "Browser does not support socks5 proxy authentication"）。
 * 解决：在本机起一个「无认证」的 SOCKS5 代理，Chromium 连它；
 *       本 shim 再以账号密码向上游真实 SOCKS5 代理发起认证并中继流量。
 */

const net = require('net');

// 在已有 socket 上完成 SOCKS5 握手并 CONNECT 到 target（支持用户名密码认证）
// 返回 { socket, leftover }
function socksHandshake(socket, auth, targetHost, targetPort, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('SOCKS5 handshake timeout')); }, timeout);
    const hasAuth = auth && auth.username && auth.password;
    const methods = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
    let state = 'greet';
    let pending = Buffer.alloc(0);

    function onError(err) { clearTimeout(timer); socket.destroy(); reject(err); }
    socket.once('error', onError);

    function sendConnect() {
      const host = Buffer.from(targetHost, 'utf8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
      ]);
      socket.write(req);
    }

    function consume(buf) {
      if (state === 'greet') {
        if (buf.length < 2) return buf;
        const method = buf[1];
        const rest = buf.slice(2);
        if (method === 0x00) {
          state = 'connect';
          sendConnect();
        } else if (method === 0x02 && hasAuth) {
          state = 'auth';
          const u = Buffer.from(auth.username, 'utf8');
          const p = Buffer.from(auth.password, 'utf8');
          const authReq = Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
          socket.write(authReq);
        } else {
          clearTimeout(timer); socket.destroy(); reject(new Error('SOCKS5 auth method not accepted: ' + method)); return rest;
        }
        return rest;
      }
      if (state === 'auth') {
        if (buf.length < 2) return buf;
        if (buf[0] !== 0x01 || buf[1] !== 0x00) {
          clearTimeout(timer); socket.destroy(); reject(new Error('SOCKS5 auth failed')); return buf.slice(2);
        }
        state = 'connect';
        sendConnect();
        return buf.slice(2);
      }
      if (state === 'connect') {
        if (buf.length < 10) return buf;
        const rep = buf[1];
        if (rep !== 0x00) {
          clearTimeout(timer); socket.destroy(); reject(new Error('SOCKS5 connect failed: ' + rep)); return buf;
        }
        const atyp = buf[3];
        let offset = 4;
        if (atyp === 0x01) offset += 6;
        else if (atyp === 0x03) offset += 1 + buf[4] + 2;
        else if (atyp === 0x04) offset += 18;
        clearTimeout(timer);
        socket.removeListener('error', onError);
        socket.removeListener('data', onData);
        const leftover = buf.slice(offset);
        // 把 connect reply 之后已经收到的数据（如 TLS Server Hello）重新注入 socket 流，
        // 避免 pipe 后续监听时丢失首段数据导致 TLS/应用层握手失败。
        if (leftover.length > 0) {
          setImmediate(() => { try { socket.emit('data', leftover); } catch (_) {} });
        }
        resolve(socket);
        return leftover;
      }
      return buf;
    }

    function onData(data) { pending = consume(Buffer.concat([pending, data])); }
    socket.on('data', onData);
    socket.write(methods);
  });
}

// 建立一条完整 SOCKS5 链路：本机 -> hopProxy?(无认证) -> upstream(认证) -> target
async function openSocks5Chain(target, upstream, hopProxy, timeout = 30000) {
  const first = hopProxy || upstream;
  const socket = new net.Socket();
  await new Promise((resolve, reject) => {
    socket.once('connect', () => { socket.setTimeout(0); resolve(); });
    socket.once('error', reject);
    socket.setTimeout(timeout, () => { socket.destroy(); reject(new Error('SOCKS connect timeout')); });
    socket.connect(Number(first.port), first.host);
  });

  // 第一跳：到 hopProxy 或 upstream 的 gateway
  const firstAuth = hopProxy ? null : { username: upstream.username || '', password: upstream.password || '' };
  const firstTarget = hopProxy
    ? { host: upstream.host, port: Number(upstream.port) }
    : { host: target.host, port: Number(target.port) };
  await socksHandshake(socket, firstAuth, firstTarget.host, firstTarget.port, timeout);

  // 第二跳（若存在 hopProxy）：在 hopProxy 隧道内再做 upstream 的认证到最终 target
  if (hopProxy) {
    await socksHandshake(socket, { username: upstream.username, password: upstream.password }, target.host, target.port, timeout);
  }

  return socket;
}

// 启动本地 SOCKS5 服务端（无认证），解析 Chromium 的请求后通过上游带认证 SOCKS5 转发
// options.hopProxy: 可选中间 SOCKS5 代理（如本机 v2ray），先经它再连 upstream
function startShim(upstream, options = {}) {
  const server = net.createServer((client) => {
    client.once('data', (greet) => {
      // SOCKS5 握手：必须 05 开头
      if (!greet || greet[0] !== 0x05) { client.destroy(); return; }
      // 告诉客户端：我们只支持「无认证」(0x00)
      client.write(Buffer.from([0x05, 0x00]));

      client.once('data', (req) => {
        // 请求格式: VER(05) CMD(01=CONNECT) RSV(00) ATYP(01/03/04) ...
        if (!req || req[0] !== 0x05 || req[1] !== 0x01) {
          client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.destroy();
          return;
        }
        const atyp = req[3];
        let host, offset;
        if (atyp === 0x01) { // IPv4
          host = Array.from(req.slice(4, 8)).join('.');
          offset = 8;
        } else if (atyp === 0x03) { // 域名
          const len = req[4];
          host = req.slice(5, 5 + len).toString('utf8');
          offset = 5 + len;
        } else if (atyp === 0x04) { // IPv6
          const parts = [];
          for (let i = 4; i < 20; i += 2) parts.push(req.readUInt16BE(i).toString(16));
          host = parts.join(':');
          offset = 20;
        } else {
          client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.destroy();
          return;
        }
        const port = req.readUInt16BE(offset);

        // 通过上游 SOCKS5（可选中间 hopProxy，如本机 v2ray）建立到目标站点的链路
        const upstreamProxy = { host: upstream.host, port: Number(upstream.port), username: upstream.username || '', password: upstream.password || '' };
        const hopProxy = options.hopProxy && options.hopProxy.host ? options.hopProxy : null;

        function tryConnect(hop) {
          return openSocks5Chain({ host, port }, upstreamProxy, hop, 30000);
        }

        function setupPipe(remote) {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.pipe(remote);
          remote.pipe(client);
          client.on('error', () => {});
          remote.on('error', () => {});
          client.on('close', () => remote.destroy());
          remote.on('close', () => client.destroy());
        }

        tryConnect(hopProxy).then(setupPipe).catch((e) => {
          if (hopProxy) {
            // hop 失败时回退直连 upstream（兼容未启动 v2ray 的场景）
            tryConnect(null).then(setupPipe).catch(() => {
              client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              client.destroy();
            });
          } else {
            client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            client.destroy();
          }
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, endpoint: `127.0.0.1:${port}` });
    });
  });
}

module.exports = { startShim, openSocks5Chain, socksHandshake };
