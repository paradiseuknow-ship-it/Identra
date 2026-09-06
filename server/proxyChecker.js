'use strict';

const net = require('net');
const https = require('https');
const tls = require('tls');
const { lookupIp } = require('./geoip');
const { startShim } = require('./socksShim');
const { SocksClient } = require('socks');

function proxyToParts(proxy) {
  if (!proxy || !proxy.server) return null;
  const type = (proxy.type || 'http').toLowerCase();
  const server = String(proxy.server).replace(/^[a-z0-9]+:\/\//i, '');
  const [host, port] = server.split(':');
  return { type, host, port: Number(port), username: proxy.username || '', password: proxy.password || '' };
}

// 在已建立的 TCP socket 上发一次 HTTP GET 并取回响应体
function httpGetOverSocket(socket, host, path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error('http timeout')); }
    }, timeoutMs);
    const onData = (d) => {
      if (done) return;
      buf += d.toString();
      const sep = buf.indexOf('\r\n\r\n');
      if (sep >= 0) {
        done = true;
        clearTimeout(timer);
        const head = buf.slice(0, sep);
        const body = buf.slice(sep + 4);
        const m = head.match(/HTTP\/1\.[01] (\d+)/);
        if (m && m[1] !== '200') return reject(new Error('HTTP ' + m[1]));
        socket.removeListener('data', onData);
        resolve(body.trim());
      }
    };
    socket.on('data', onData);
    socket.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
  });
}

function waitForConnect(socket, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('proxy connect timeout')), timeoutMs);
    const onData = (d) => {
      buf += d.toString();
      if (pattern.test(buf)) { clearTimeout(timer); socket.removeListener('data', onData); resolve(); }
      else if (/HTTP\/1\.[01] (?!200)/.test(buf)) { clearTimeout(timer); socket.removeListener('data', onData); reject(new Error('proxy CONNECT rejected')); }
    };
    socket.on('data', onData);
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// 在已建立的 socket（TCP 或 TLS）上发一次 HTTPS/HTTP GET 并取回响应体
function httpGetOverSocket(socket, host, path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error('http timeout')); }
    }, timeoutMs);
    const onData = (d) => {
      if (done) return;
      buf += d.toString();
      const sep = buf.indexOf('\r\n\r\n');
      if (sep >= 0) {
        done = true;
        clearTimeout(timer);
        const head = buf.slice(0, sep);
        const body = buf.slice(sep + 4);
        const m = head.match(/HTTP\/1\.[01] (\d+)/);
        if (m && m[1] !== '200') { socket.removeListener('data', onData); return reject(new Error('HTTP ' + m[1])); }
        socket.removeListener('data', onData);
        resolve(body.trim());
      }
    };
    socket.on('data', onData);
    socket.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
  });
}

// 建立到目标主机的 TLS 隧道（在已有 socket 上）
function tlsOver(socket, servername) {
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect({ socket, servername }, () => {
      tlsSock.removeListener('error', reject);
      resolve(tlsSock);
    });
    tlsSock.once('error', reject);
  });
}

// 走代理访问 api.ipify.org 拿到出口 IP（不经过 Chromium，稳定且快）。
// 采用标准做法：CONNECT 到 443 后 TLS + HTTPS GET。
// 注意：很多住宅/HTTP 代理只放行 HTTPS(443) 隧道，明文 80 会被 RST（read ECONNRESET），
// 所以优先 443，失败再回退 80 明文，与 AdsPower 等真实浏览器的探测方式一致。
const IPIFY = { host: 'api.ipify.org', port: 443, path: '/?format=json' };
async function fetchEgressIpViaProxy(proxy) {
  const parts = proxyToParts(proxy);
  if (!parts) throw new Error('no proxy');
  let authHeader = '';
  if (parts.username) {
    const auth = Buffer.from(parts.username + ':' + parts.password).toString('base64');
    authHeader = `Proxy-Authorization: Basic ${auth}\r\n`;
  }

  const strategies = [
    { port: 443, useTls: true },
    { port: 80, useTls: false },
  ];
  let lastErr;
  for (const s of strategies) {
    try {
      if (parts.type === 'socks5') {
        const info = await SocksClient.createConnection({
          proxy: { host: parts.host, port: parts.port, type: 5, username: parts.username, password: parts.password },
          command: 'connect',
          destination: { host: IPIFY.host, port: s.port },
          timeout: 15000,
        });
        const sock = s.useTls ? await tlsOver(info.socket, IPIFY.host) : info.socket;
        return httpGetOverSocket(sock, IPIFY.host, IPIFY.path);
      }

      // HTTP / HTTPS 代理：CONNECT 隧道，再（可选）TLS + GET
      const conn = net.connect(parts.port, parts.host);
      await new Promise((res, rej) => { conn.once('connect', res); conn.once('error', rej); });
      conn.write(`CONNECT ${IPIFY.host}:${s.port} HTTP/1.1\r\nHost: ${IPIFY.host}\r\n${authHeader}\r\n`);
      await waitForConnect(conn, /HTTP\/1\.[01] 200/);
      const sock = s.useTls ? await tlsOver(conn, IPIFY.host) : conn;
      return httpGetOverSocket(sock, IPIFY.host, IPIFY.path);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('proxy egress failed');
}

// 直连出口 IP 探测：多源回退（STEP 18 实证修复）——原单源 api.ipify.org 在部分网络（如 CN 直连）
// 被连接重置，导致「基于 IP」指纹模式的直连分支恒失败；按可达性顺序多源回退，单请求 6s 超时防悬挂。
const EGRESS_IP_SOURCES = [
  'https://api.ipify.org?format=json',
  'https://api.ip.sb/jsonip',
  'https://api.myip.com',
];
function fetchJsonUrl(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const req = mod.get(url, (r) => {
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => resolve(b.trim()));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout ' + timeoutMs + 'ms')); });
  });
}
function parseEgressIp(body) {
  try { return JSON.parse(body).ip || null; } catch (e) { return null; }
}
async function fetchEgressIpDirect() {
  for (const src of EGRESS_IP_SOURCES) {
    try {
      const body = await fetchJsonUrl(src);
      const ip = parseEgressIp(body);
      if (ip) return body;
    } catch (e) { /* 换下一个源 */ }
  }
  throw new Error('所有出口 IP 探测源均不可达: ' + EGRESS_IP_SOURCES.join(', '));
}

// 解析出口公网 IP（带重试）。
// 关键：配置了代理时，必须基于【代理的出口 IP】，否则会拿到本机直连真实 IP，
// 导致"基于 IP"的时区/语言/地理位置与本机所在地对齐，而非代理所在地。
// 因此：有代理时【绝不回退直连】——代理解析失败就报错，而不是退而取本机 IP。
async function getEgressIp(proxy) {
  if (!proxy) {
    // 无代理：直连取本机出口
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const body = await fetchEgressIpDirect();
        const ip = JSON.parse(body).ip;
        if (ip) return ip;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    throw lastErr || new Error('无法解析出口 IP');
  }

  // 有代理：自动尝试 socks5→http（或 http→socks5），只走代理，绝不回退直连。
  const preferred = (proxy.type || 'http').toLowerCase();
  const order = preferred === 'socks5' ? ['socks5', 'http'] : ['http', 'socks5'];
  let lastErr;
  for (const type of order) {
    for (let i = 0; i < 2; i++) {
      try {
        const body = await fetchEgressIpViaProxy({ ...proxy, type });
        const ip = JSON.parse(body).ip;
        if (ip) return ip;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }
  throw lastErr || new Error('代理出口 IP 解析失败');
}

// 出口 IP + 地理位置（时区/语言/经纬度），供"基于 IP"指纹使用。稳定、不依赖再起浏览器。
async function getProxyEgressGeo(proxy) {
  const ip = await getEgressIp(proxy);
  const geo = await lookupIp(ip);
  if (geo) geo.ip = ip;
  return { ip, geo };
}

// 自动识别代理实际可用协议。很多端口同时监听 HTTP/SOCKS5，但 SOCKS5 TCP 转发可能不可用，
// 而 HTTP CONNECT 可用（或相反）。先按用户选的类型试，失败再试另一种。
async function detectProxyProtocol(proxy) {
  const preferred = (proxy.type || 'http').toLowerCase();
  const fallback = preferred === 'socks5' ? 'http' : 'socks5';
  const types = [preferred, fallback];
  let lastErr = null;
  for (const type of types) {
    try {
      const ip = await getEgressIp({ ...proxy, type });
      if (ip) return { type, ip, error: null };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('proxy 两种协议均检测失败');
}

// 通过代理检测出口 IP，并查询地理位置/时区/语言。
async function checkProxyGeo(proxy) {
  const t0 = Date.now();
  const preferred = (proxy.type || 'http').toLowerCase();
  try {
    const { type: detectedType, ip } = await detectProxyProtocol(proxy);
    const geo = await lookupIp(ip);
    if (geo) geo.ip = ip;
    return { ok: true, ip, detectedType: detectedType !== preferred ? detectedType : undefined, latencyMs: Date.now() - t0, error: null, geo };
  } catch (e) {
    return { ok: false, ip: null, latencyMs: Date.now() - t0, error: String(e.message || e).slice(0, 200), geo: null };
  }
}

// 仅检测连通性（IP 探测）
async function checkProxy(proxy) {
  const t0 = Date.now();
  const preferred = (proxy.type || 'http').toLowerCase();
  try {
    const { type: detectedType, ip } = await detectProxyProtocol(proxy);
    return { ok: true, ip, detectedType: detectedType !== preferred ? detectedType : undefined, latencyMs: Date.now() - t0, error: null };
  } catch (e) {
    return { ok: false, ip: null, latencyMs: Date.now() - t0, error: String(e.message || e).slice(0, 200) };
  }
}

// ---- 启动前快速判定实际可用协议 ----
// 某些住宅代理端口同时监听 SOCKS5/HTTP，但 SOCKS5 仅完成握手却不转发 TCP，
// 导致真实浏览器走 SOCKS5 时 ERR_SOCKS_CONNECTION_FAILED。这里真正发送一次请求
// 验证「数据能否转发」，优先用户所选（多为 socks5），失败回退 http。
// 单次短超时，避免拖慢启动。
async function quickEgress(parts, type) {
  const TIMEOUT = 8000;
  if (type === 'socks5') {
    const info = await SocksClient.createConnection({
      proxy: { host: parts.host, port: parts.port, type: 5, username: parts.username, password: parts.password },
      command: 'connect',
      destination: { host: IPIFY.host, port: IPIFY.port },
      timeout: TIMEOUT,
    });
    const sock = await tlsOver(info.socket, IPIFY.host);
    const body = await httpGetOverSocket(sock, IPIFY.host, IPIFY.path, TIMEOUT);
    return JSON.parse(body).ip;
  }
  const conn = net.connect(parts.port, parts.host);
  await new Promise((res, rej) => { conn.once('connect', res); conn.once('error', rej); });
  let auth = '';
  if (parts.username) {
    const a = Buffer.from(parts.username + ':' + parts.password).toString('base64');
    auth = `Proxy-Authorization: Basic ${a}\r\n`;
  }
  conn.write(`CONNECT ${IPIFY.host}:${IPIFY.port} HTTP/1.1\r\nHost: ${IPIFY.host}\r\n${auth}\r\n`);
  await waitForConnect(conn, /HTTP\/1\.[01] 200/, TIMEOUT);
  const sock = await tlsOver(conn, IPIFY.host);
  const body = await httpGetOverSocket(sock, IPIFY.host, IPIFY.path, TIMEOUT);
  return JSON.parse(body).ip;
}

async function resolveProxyType(proxy) {
  const parts = proxyToParts(proxy);
  if (!parts) return (proxy.type || 'http').toLowerCase();
  const preferred = (proxy.type || 'http').toLowerCase();
  const order = preferred === 'socks5' ? ['socks5', 'http'] : ['http', 'socks5'];
  for (const type of order) {
    try {
      const ip = await quickEgress(parts, type);
      if (ip) return type;
    } catch (e) { /* 该协议不可用，试下一个 */ }
  }
  return preferred; // 都连不通则沿用用户所选
}

module.exports = { checkProxy, checkProxyGeo, getEgressIp, getProxyEgressGeo, resolveProxyType };
