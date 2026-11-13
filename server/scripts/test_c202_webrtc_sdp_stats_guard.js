'use strict';
// C202 守护：replace-udp 候选改写必须覆盖站点读描述符/读统计的两条旁路。
//
// 背景（受控对照实证，真代理链路）：旧实现只改写事件路径（onicecandidate /
// addEventListener / addIceCandidate），站点读
//   ① pc.localDescription.sdp —— SDP 候选行是浏览器原生候选，实测真实公网 IP（srflx）
//      与 mDNS host 主机名（<uuid>.local + network-cost 999）直读可见；
//   ② pc.getStats() 的 local-candidate 条目 —— address 字段直读真实 IP。
// 两条旁路都把「事件路径已改写为出口 IP」的伪装整个击穿。
//
// 契约（真实 Chrome + 真 buildInjectionScript，本地页离线验证，mDNS host 候选
// 无需外网即可收集 ⇒ 断言非 vacuous）：
//   A 事件路径：候选地址恒=出口 IP、typ 恒 srflx、无 network-cost（锁定既有行为）。
//   B 描述符旁路：localDescription（含 current/pending 同源）SDP 候选行不得出现
//     .local / 真实地址 / network-cost 999；返回对象仍是 RTCSessionDescription。
//   C 统计旁路：getStats() 返回包装 Map（包装生效的实证），且任何有地址的
//     local-candidate 条目地址恒=出口 IP。
//   D 源码形态：rewriteSdpLines 复用 rewriteCandidate（单一实现）、三个 description
//     getter 全覆盖、getStats 包装仅 replace-udp 生效。
//   E 防误伤：proxy 模式（relay-only）保持零候选——三条路径都不得出现任何候选。

const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { buildInjectionScript } = require('../fp/inject');
const { generateFingerprint } = require('../fp/generate');
const { listenSafe } = require('./lib_safe_port');

const CHROME = process.env.FP_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC_IP = '203.0.113.99'; // TEST-NET-3，永不与真实地址撞车

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); } }

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>c202</title></head><body>c202 webrtc guard</body></html>`;

// 夹具桩：离线 mDNS 场景下原生 getStats() 的 local-candidate 不暴露 address，
// 导致 C2「零真实 IP 泄漏」断言恒绿（L57：夹具缺陷让断言 vacuous）。
// 桩返回确定性 fakeReport（刻决不用 Map 实例，保住 C1「包装生效」判据的非 vacuous），
// 内含带真实地址的 local-candidate，使 C2 能值级验证改写逻辑。
// 注入脚本在 new RTCPeerConnection() 时从原型捕获 pc.getStats，故此桩须先于注入脚本执行。
const STUB = `
(() => {
  const P = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
  if (!P) return;
  P.getStats = function () {
    return Promise.resolve({
      forEach(fn) {
        fn({ type: 'local-candidate', address: '198.51.100.7', ip: '198.51.100.7', relatedAddress: '198.51.100.7', candidateType: 'srflx' }, 'local-cand-1');
        fn({ type: 'remote-candidate', address: '198.51.100.8' }, 'remote-cand-1');
      }
    });
  };
})();
`;

async function startServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(HTML);
  });
  const bound = await listenSafe(srv, '127.0.0.1');
  return { srv, port: bound.address().port };
}

// 页内探针：收集三条路径的候选形态
const PROBE = `
(async () => {
  const PUBLIC_IP = ${JSON.stringify(PUBLIC_IP)};
  const collect = async () => {
    const out = { event: [], sdp: [], stats: [], error: null };
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.invalid.invalid:9' }] });
      pc.createDataChannel('c202');
      pc.onicecandidate = (e) => { if (e.candidate) out.event.push(e.candidate.candidate); };
      await pc.setLocalDescription(await pc.createOffer());
      const t0 = Date.now();
      while (pc.iceGatheringState !== 'complete' && Date.now() - t0 < 4000) {
        await new Promise((r) => setTimeout(r, 150));
      }
      out.gatheringState = pc.iceGatheringState;
      out.hooked = Object.prototype.hasOwnProperty.call(pc, 'localDescription');
      out.descCtor = (pc.localDescription && pc.localDescription.constructor) ? pc.localDescription.constructor.name : '(null)';
      out.descType = pc.localDescription ? pc.localDescription.type : null;
      const sdp = pc.localDescription ? pc.localDescription.sdp : '';
      out.sdp = (sdp.match(/a=candidate:.+/g) || []);
      const st = await pc.getStats();
      out.statsIsMap = (typeof Map !== 'undefined' && st instanceof Map);
      st.forEach((v) => { if (v && v.type === 'local-candidate') out.stats.push({ address: v.address || v.ip || null, cand: v.candidateType || null }); });
      pc.close();
    } catch (e) { out.error = String((e && e.message) || e); }
    return out;
  };
  const replaceUdp = await collect();
  return { replaceUdp };
})();
`;

(async () => {
  console.log('=== C202 WebRTC 候选改写旁路守护（replace-udp SDP/getStats）===');
  const { srv, port } = await startServer();
  const url = 'http://127.0.0.1:' + port + '/';

  const src = fs.readFileSync(path.join(__dirname, '../fp/inject.js'), 'utf8');
  const fpR = generateFingerprint('c202-guard-seed', { os: 'Windows', browser: 'Chrome', webRtc: 'replace-udp', webRtcPublicIp: PUBLIC_IP });
  const fpP = generateFingerprint('c202-guard-seed', { os: 'Windows', browser: 'Chrome', webRtc: 'proxy', webRtcPublicIp: PUBLIC_IP });
  ok('前置：fp.replace-udp 模式与映射 IP 落地', fpR.webRtc === 'replace-udp' && fpR.webRtcPublicIp === PUBLIC_IP,
    'webRtc=' + fpR.webRtc + ' publicIp=' + fpR.webRtcPublicIp);
  ok('前置：fp.proxy 模式落地', fpP.webRtc === 'proxy');

  // ---------------- S：结构性语法防线 ----------------
  // 教训：C202 初版把 CRLF 写成单份反斜杠，被 buildInjectionScript 模板字面量求值成
  // 真实 CRLF，生成脚本字符串跨行 → Invalid or unexpected token → 全部 hook 未安装。
  // 当时行为断言（A/B/C/E）全红但归因困难；故先加编译 + 双份形态断言，把根因钉死。
  console.log('-- S 结构性语法防线 --');
  const genR = buildInjectionScript(fpR);
  const genP = buildInjectionScript(fpP);
  let compileErr = '';
  try { new Function(genR); new Function(genP); } catch (e) { compileErr = String((e && e.message) || e); }
  ok('S1 生成注入脚本可编译（两种模式；语法错则全部 hook 未安装）', compileErr === '', compileErr);
  ok('S2 源码 CRLF 反斜杠双份（模板字面量内不被吞）',
    src.includes("sdp.split('\\\\r\\\\n')") && src.includes("join('\\\\r\\\\n')"));
  ok('S2b 生成脚本 CRLF 为单份转义字面量（页面侧 split 语义正确）',
    genR.includes("split('\\r\\n')") && !genR.includes("split('\\\\r\\\\n')"));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-webrtc-ip-handling-policy=default_public_interface_only'] });
  try {
    // ---------------- A/B/C：replace-udp ----------------
    console.log('-- replace-udp 模式（本地 mDNS host 候选，离线）--');
    const ctxR = await browser.newContext();
    await ctxR.addInitScript(STUB + '\n' + buildInjectionScript(fpR));
    const pageR = await ctxR.newPage();
    await pageR.goto(url, { waitUntil: 'load' });
    const r = await pageR.evaluate(PROBE);

    ok('C0 注入 hook 已安装（pc 实例 own localDescription 描述符，断言非 vacuous）', r.replaceUdp.hooked === true,
      'hooked=' + r.replaceUdp.hooked);
    ok('A1 事件候选非空（mDNS host 候选离线可收集，断言非 vacuous）', r.replaceUdp.event.length >= 1,
      'event=' + JSON.stringify(r.replaceUdp.event));
    ok('A2 事件候选地址恒=出口 IP', r.replaceUdp.event.every((c) => c.includes(' ' + PUBLIC_IP + ' ')),
      JSON.stringify(r.replaceUdp.event));
    ok('A3 事件候选 typ 恒 srflx 且无 network-cost', r.replaceUdp.event.every((c) => /typ srflx/.test(c) && !/network-cost/.test(c)),
      JSON.stringify(r.replaceUdp.event));

    ok('B1 SDP 候选行非空（与事件同源，断言非 vacuous）', r.replaceUdp.sdp.length >= 1,
      'sdp=' + JSON.stringify(r.replaceUdp.sdp));
    ok('B2 SDP 无 .local mDNS 主机名', r.replaceUdp.sdp.every((l) => !/\.local/.test(l)),
      JSON.stringify(r.replaceUdp.sdp));
    ok('B3 SDP 候选地址恒=出口 IP', r.replaceUdp.sdp.every((l) => l.includes(' ' + PUBLIC_IP + ' ')),
      JSON.stringify(r.replaceUdp.sdp));
    ok('B4 SDP typ 恒 srflx 且无 network-cost', r.replaceUdp.sdp.every((l) => /typ srflx/.test(l) && !/network-cost/.test(l)),
      JSON.stringify(r.replaceUdp.sdp));
    ok('B5 localDescription 仍是 RTCSessionDescription（instanceof 语义未破坏）', r.replaceUdp.descCtor === 'RTCSessionDescription' && r.replaceUdp.descType === 'offer',
      'ctor=' + r.replaceUdp.descCtor + ' type=' + r.replaceUdp.descType);

    ok('C1 getStats 返回包装 Map（旁路改写生效的实证）', r.replaceUdp.statsIsMap === true, 'statsIsMap=' + r.replaceUdp.statsIsMap);
    const badStats = r.replaceUdp.stats.filter((s) => s.address !== PUBLIC_IP);
    ok('C2 getStats local-candidate 恒=出口 IP 且夹具非空（零真实 IP 泄漏）',
      r.replaceUdp.stats.length >= 1 && badStats.length === 0,
      'stats=' + JSON.stringify(r.replaceUdp.stats) + ' bad=' + JSON.stringify(badStats));

    ok('X1 三路径均无异常', !r.replaceUdp.error, 'error=' + r.replaceUdp.error);
    await ctxR.close();

    // ---------------- E：proxy 模式（relay-only，防误伤） ----------------
    console.log('-- proxy 模式（relay-only 零候选，防误伤）--');
    const ctxP = await browser.newContext();
    await ctxP.addInitScript(buildInjectionScript(fpP));
    const pageP = await ctxP.newPage();
    await pageP.goto(url, { waitUntil: 'load' });
    const p = await pageP.evaluate(PROBE);
    ok('E1 proxy 模式事件候选为零（relay-only 语义保持）', p.replaceUdp.event.length === 0, JSON.stringify(p.replaceUdp.event));
    ok('E2 proxy 模式 SDP 候选行为零', p.replaceUdp.sdp.length === 0, JSON.stringify(p.replaceUdp.sdp));
    await ctxP.close();

    // ---------------- D：源码形态 ----------------
    console.log('-- D 源码形态 --');
    ok('D1 rewriteSdpLines 存在且仅 replace-udp+publicIp 生效', /const rewriteSdpLines = \(sdp\) => \{/.test(src) && /effectiveMode !== 'replace-udp' \|\| !publicIp\) return sdp;/.test(src));
    ok('D2 SDP 候选行复用 rewriteCandidate（单一实现，勿复制改写逻辑）', /= rewriteCandidate\(line\.slice\(2\)\)/.test(src));
    ok('D3 三个 description getter 全覆盖', /'localDescription', 'currentLocalDescription', 'pendingLocalDescription'/.test(src) && /\.forEach\(\(prop\) => \{/.test(src));
    ok('D4 getStats 包装仅 replace-udp 生效', /if \(effectiveMode === 'replace-udp'\) \{\s*\r?\n\s*const origGetStats = pc\.getStats;/.test(src));
    ok('D5 getStats 改写 address/ip/relatedAddress 三字段', /if \(c\.address\) c\.address = publicIp;/.test(src) && /if \(c\.ip\) c\.ip = publicIp;/.test(src) && /if \(c\.relatedAddress\) c\.relatedAddress = publicIp;/.test(src));
    ok('D6 事件路径 network-cost 剥离保持（防回退）', /tokens\[i\] === 'network-cost'/.test(src) && /i\+\+; continue;/.test(src) && /out\.join\(' '\)/.test(src));
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }

  console.log('\\n== C202 守护结果: ' + pass + ' 通过 / ' + fail + ' 失败 ==');
  if (fail > 0) { console.log('FAILS:\\n' + fails.join('\\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('GUARD CRASH:', e); process.exit(2); });
