'use strict';

/**
 * 本地 HTTP 代理中转器（shim）。
 *
 * 问题 1：某些住宅/HTTP 代理的首次 CONNECT 隧道偶发失败（"无法访问此网站"），
 *         或并发资源加载时部分 CONNECT 被丢弃导致 CSS/JS 没加载、页面排版错乱。
 *         Playwright/Chromium 对单个 CONNECT 不会重试，只能让用户手动刷新。
 * 问题 2：HTTP 代理下 Chromium 访问 http:// 站点会发「绝对 URI 普通 GET」而非 CONNECT，
 *         旧版 shim 对这类请求一律回 405 METHOD NOT ALLOWED，整页打不开。
 * 问题 3：上游若需经中间代理（如本机 v2ray）才能稳定到达，直连上游会间歇失败。
 *
 * 解决：本机起一个无认证 HTTP 代理，Chromium 全部流量先连它；
 *       - CONNECT（https）：以账号密码向上游发起 CONNECT，失败自动重试 3 次；
 *       - 普通 HTTP 请求（http:// 站点）：原样转发绝对 URI 请求到上游代理；
 *       - 上游连接优先经 options.hopProxy（SOCKS5 中间跳，如 v2ray），
 *         hop 失败自动回退直连上游。
 */

const http = require('http');
const net = require('net');
const { socksHandshake } = require('./socksShim');

function parseProxyServer(server) {
  const s = String(server || '').replace(/^https?:\/\//i, '');
  const [host, port] = s.split(':');
  return { host: host || '127.0.0.1', port: Number(port) || 80 };
}

// 建立到「上游 HTTP 代理」的 TCP 连接；hopProxy 存在时先经 SOCKS5 隧道
function connectUpstream(upstreamAddr, hopProxy, timeout = 15000) {
  return new Promise(async (resolve, reject) => {
    const socket = new net.Socket();
    const fail = (err) => { try { socket.destroy(); } catch (e) {} reject(err); };
    if (!hopProxy) {
      socket.once('connect', () => resolve(socket));
      socket.once('error', fail);
      socket.connect(Number(upstreamAddr.port), upstreamAddr.host);
      return;
    }
    socket.setTimeout(timeout, () => fail(new Error('hop connect timeout')));
    socket.once('error', fail);
    socket.connect(Number(hopProxy.port), hopProxy.host, () => {
      socket.setTimeout(0);
      // 在 hop SOCKS5 隧道内连到上游代理端口（无认证，认证由 HTTP 层 Proxy-Authorization 完成）
      socksHandshake(socket, null, upstreamAddr.host, Number(upstreamAddr.port), timeout)
        .then(() => resolve(socket))
        .catch(fail);
    });
  });
}

function startHttpShim(upstream, options = {}) {
  const upstreamAddr = parseProxyServer(upstream.server);
  const hopProxy = options.hopProxy && options.hopProxy.host ? options.hopProxy : null;
  const hasAuth = !!(upstream.username || upstream.password);
  const authHeader = hasAuth
    ? 'Basic ' + Buffer.from(`${upstream.username || ''}:${upstream.password || ''}`).toString('base64')
    : null;
  const maxAttempts = 3;

  // ---- 普通 HTTP 请求（http:// 站点：绝对 URI 的 GET/POST/...）----
  // 直接接管客户端 socket，把上游返回的原始 HTTP 响应字节透传回去。
  function handlePlainRequest(req) {
    const clientSocket = req.socket;
    const tryOnce = (attempt, hop) => {
      connectUpstream(upstreamAddr, hop).then((up) => {
        // 原样重建请求行 + 请求头，附上代理认证
        let head = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(req.headers)) {
          if (v == null || k === 'proxy-connection') continue;
          head += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
        }
        if (authHeader) head += `Proxy-Authorization: ${authHeader}\r\n`;
        head += '\r\n';
        up.write(head);
        // end:false —— GET 请求体读完时不要半关闭上游 socket，等响应/客户端断开再关
        req.pipe(up, { end: false });
        up.pipe(clientSocket);
        const cleanup = () => { try { up.destroy(); } catch (e) {} };
        clientSocket.on('close', cleanup);
        up.on('error', cleanup);
        clientSocket.on('error', cleanup);
      }).catch(() => {
        // hop 失败回退直连；直连也失败则重试（与 CONNECT 分支一致的次数）
        if (hop && attempt < maxAttempts) return tryOnce(attempt, null);
        if (attempt < maxAttempts - 1) return setTimeout(() => tryOnce(attempt + 1, hop), 300);
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); } catch (e) {}
        clientSocket.destroy();
      });
    };
    tryOnce(0, hopProxy);
  }

  const server = http.createServer((req, res) => {
    // 绝对 URI（http://host/path）= 浏览器把本 shim 当 HTTP 代理用的普通请求，转发到上游
    if (/^http:\/\//i.test(req.url)) { handlePlainRequest(req); return; }
    // 其他情况（如被当 origin 服务器访问）直接拒绝
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // ---- CONNECT（https 站点隧道）----
  server.on('connect', (clientReq, clientSocket, head) => {
    const [targetHost, targetPortStr] = (clientReq.url || '').split(':');
    const targetPort = Number(targetPortStr) || 443;
    if (!targetHost) {
      try { clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {}
      clientSocket.destroy();
      return;
    }

    function tryOnce(attempt, hop) {
      connectUpstream(upstreamAddr, hop).then((upstreamSocket) => {
        const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Connection: keep-alive\r\n` +
          (authHeader ? `Proxy-Authorization: ${authHeader}\r\n` : '') +
          `\r\n`;
        upstreamSocket.write(connectReq);

        let buf = Buffer.alloc(0);
        function onData(chunk) {
          buf = Buffer.concat([buf, chunk]);
          const headerEnd = buf.indexOf('\r\n\r\n');
          if (headerEnd === -1) return; // 等待完整响应头

          upstreamSocket.removeListener('data', onData);
          const header = buf.slice(0, headerEnd + 4).toString('utf8');
          const body = buf.slice(headerEnd + 4);

          const ok = header.startsWith('HTTP/1.1 200') || header.startsWith('HTTP/1.0 200');
          if (!ok) {
            upstreamSocket.destroy();
            if (hop) { setTimeout(() => tryOnce(attempt, null), 200); return; } // hop 失败回退直连
            if (attempt < maxAttempts - 1) { setTimeout(() => tryOnce(attempt + 1, null), 300); return; }
            try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {}
            clientSocket.destroy();
            return;
          }

          // 隧道建立成功
          try { clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n'); } catch (e) {}
          if (head && head.length) upstreamSocket.write(head);
          if (body.length) clientSocket.write(body);
          clientSocket.pipe(upstreamSocket);
          upstreamSocket.pipe(clientSocket);

          clientSocket.on('error', () => {});
          upstreamSocket.on('error', () => {});
          clientSocket.on('close', () => { try { upstreamSocket.destroy(); } catch (e) {} });
          upstreamSocket.on('close', () => { try { clientSocket.destroy(); } catch (e) {} });
        }

        upstreamSocket.on('data', onData);

        upstreamSocket.on('error', () => {
          upstreamSocket.destroy();
          if (hop) { setTimeout(() => tryOnce(attempt, null), 200); return; }
          if (attempt < maxAttempts - 1) { setTimeout(() => tryOnce(attempt + 1, null), 300); return; }
          try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {}
          clientSocket.destroy();
        });

        clientSocket.on('close', () => { try { upstreamSocket.destroy(); } catch (e) {} });
      }).catch(() => {
        if (hop) { setTimeout(() => tryOnce(attempt, null), 200); return; } // hop 失败回退直连
        if (attempt < maxAttempts - 1) { setTimeout(() => tryOnce(attempt + 1, null), 300); return; }
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {}
        clientSocket.destroy();
      });
    }

    tryOnce(0, hopProxy);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, endpoint: `127.0.0.1:${port}` });
    });
  });
}

module.exports = { startHttpShim };
