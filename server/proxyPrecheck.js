'use strict';

/**
 * 代理出口预检（Pre-check）。
 *
 * 在 Profile 启动前（或手动）用与浏览器完全一致的链路
 *   本机 -> v2ray(hop) -> rola(upstream) -> 目标
 * 验证两件事：
 *   1) 出口 IP 是住宅(isp) 还是 机房/数据中心(hosting) —— 脏 IP 会被 Google 拉黑；
 *   2) www.google.com 的 TLS 是否真能握手成功并返回首页 —— 复现 ERR_SSL_BAD_RECORD_TYPE 类阻断。
 *
 * 设计：best-effort、可超时、失败仅报警不阻断。
 */

const tls = require('tls');
const { openSocks5Chain } = require('./socksShim');

// 命中即判为 hosting（机房/云/数据中心）的组织名或 ASN 关键词。
// 这些是 Google 风控重点照顾的对象，住宅代理池混入它们时极易被拒。
const HOSTING_KEYWORDS = [
  'HOSTING', 'DATA CENTER', 'DATACENTER', 'CLOUD', 'SERVER', 'VPS', 'VDS',
  'AWS', 'AMAZON', 'GOOGLE', 'MICROSOFT', 'AZURE', 'ORACLE', 'OVH',
  'DIGITALOCEAN', 'HETZNER', 'LINODE', 'VULTR', 'CONTABO', 'LEASEWEB', 'M247',
  'DATACAMP', 'CHOOPA', 'GOONET', 'LIMESTONE', 'FRANCEIX', 'QUADRANET',
  'HOSTWINDS', 'RAMNODE', 'BUYVM', 'PRIVATESYSTEMS', 'NFORCE', 'SERVERIUS',
  'AUTONATION', 'NETWORK INNOVATIONS', 'DATA CAMP', 'MICRO HOSTING',
  'DATASTORE', 'ROOT', 'EUROFIBER', 'CORE-BACKBONE', 'NOVOSERV',
];

function classifyType(org, asn) {
  const s = ((org || '') + ' ' + (asn || '')).toUpperCase();
  if (HOSTING_KEYWORDS.some((k) => s.includes(k))) return 'hosting';
  return 'isp';
}

function httpGet(sock, host, path, timeout = 12000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, timeout);
    const onData = (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) {
        done = true; clearTimeout(timer);
        const head = buf.slice(0, i).toString('latin1');
        const body = buf.slice(i + 4).toString('latin1');
        const m = head.match(/HTTP\/1\.[01] (\d+)/);
        sock.removeListener('data', onData);
        resolve({ status: m ? Number(m[1]) : 0, body });
      }
    };
    sock.on('data', onData);
    sock.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
  });
}

async function tlsOver(socket, servername) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername, rejectUnauthorized: false }, () => {
      t.removeListener('error', reject);
      resolve(t);
    });
    t.once('error', reject);
  });
}

async function getIpInfo(upstream, hop) {
  const socket = await openSocks5Chain({ host: 'ipinfo.io', port: 443 }, upstream, hop, 20000);
  const tlsSock = await tlsOver(socket, 'ipinfo.io');
  const { body } = await httpGet(tlsSock, 'ipinfo.io', '/json', 12000);
  try {
    const j = JSON.parse(body);
    const asn = (j.org && j.org.match(/AS\d+/) || [null])[0];
    return { ip: j.ip || null, country: j.country || null, org: j.org || null, asn, city: j.city || null };
  } catch (e) {
    return null;
  }
}

async function testGoogle(upstream, hop) {
  try {
    const socket = await openSocks5Chain({ host: 'www.google.com', port: 443 }, upstream, hop, 20000);
    const tlsSock = await tlsOver(socket, 'www.google.com');
    const { status, body } = await httpGet(tlsSock, 'www.google.com', '/', 12000);
    const isHome = /<title>Google<\/title>/.test(body);
    const blocked = /unusual traffic|our systems have detected|captcha|recaptcha/i.test(body);
    return { reachable: true, status, isHome, blocked };
  } catch (e) {
    // ERR_SSL_BAD_RECORD_TYPE 在 Node 侧多表现为 ERR_SSL 系列错误
    return { reachable: false, error: e.code || e.message };
  }
}

/**
 * 预检一个 SOCKS5 上游出口。
 * @param {{host:string,port:number,username?:string,password?:string}} upstream rola 上游
 * @param {{host:string,port:number}|null} hop 本机 v2ray 跳（默认 127.0.0.1:10808）
 * @returns {Promise<{ok:boolean,ip:?string,country:?string,asn:?string,org:?string,type:string,google:?{reachable:boolean,status?:number,isHome?:boolean,blocked?:boolean,error?:string}}>}
 */
async function precheckProxy(upstream, hop) {
  const result = { ok: false, ip: null, country: null, asn: null, org: null, type: 'unknown', google: null };
  const info = await getIpInfo(upstream, hop);
  if (info) {
    result.ip = info.ip;
    result.country = info.country;
    result.org = info.org;
    result.asn = info.asn;
    result.type = classifyType(info.org, info.asn);
  }
  result.google = await testGoogle(upstream, hop);
  result.ok = !!result.ip
    && result.type !== 'hosting'
    && result.google
    && result.google.reachable
    && !result.google.blocked;
  return result;
}

module.exports = { precheckProxy, classifyType };
