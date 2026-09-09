'use strict';
// C94 — Chrome unsafe-port 安全监听守护（零浏览器，tmp 隔离，AI 无关）。
//
// 背景（.benchmark/phase9_regression_20260909_094756.txt 实证）：
//   phase9 test_step19_layer_consistency FATAL page.goto net::ERR_UNSAFE_PORT
//   at http://127.0.0.1:6000/ —— 测试用端口 0 自动分配的临时端口命中 Chrome
//   unsafe-port 黑名单（6000=X11）→ 套件无统计行 → OK=182/BAD=1 假红。
//   概率性 flake，任何「临时端口 + 真实 Chromium goto」的测试都可能随机踩中。
//
// 修复：server/scripts/lib_safe_port.js 共享原语（listenSafe：不再让 OS 自动分配，
//   改为从非特权段随机取【不在 Chromium kRestrictedPorts 黑名单内】的显式候选端口
//   直接绑定；EADDRINUSE 等绑定失败 → close 后换下一候选，上限 50 次后 fail-loud），
//   全部消费临时端口的 test_*.js 收口迁移。
//
// 本守护三层：
//   P1 纯函数契约：isUnsafePort 对 Chromium 官方黑名单关键值命中/放行逐点断言
//   P2 真实模块行为杀手（真实 http server + 真实 listenSafe 全链路）：
//      B1 30 次顺序绑定全 safe（行为面：真实绑定路径端口恒安全）
//      B2 重绑路径：首次候选强制撞已被占用的端口 → listenSafe 必须 close+换候选
//         重绑成功，且绑定成功后真实 HTTP GET 200（端到端可用）
//      B3 放弃路径：listen 恒失败 → 50 次候选上限后必须 reject（不死循环）
//      B4 候选采样：randomSafePort 5000 次采样全 safe（纯函数行为面整类守卫）
//   P3 整类守卫：server/scripts/test_*.js 零裸 listen(0 + 全量消费 lib_safe_port
//      （未来任何新测试裸 listen(0) 直接红灯）

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c94-'));
process.env.FPB_DATA_DIR = TMP;

const { listenSafe, isUnsafePort, UNSAFE_PORTS, randomSafePort } = require('./lib_safe_port');

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; failures.push(name); console.log('  ✘ FAIL ' + name + '  [' + JSON.stringify(detail).slice(0, 240) + ']'); }
  return !!cond;
}

// ===== P1 纯函数契约：Chromium kRestrictedPorts 关键值 =====
console.log('\n== P1 isUnsafePort 黑名单契约 ==');
// 注意：445（microsoft-ds）不在 Chromium kRestrictedPorts 内——曾误列为 unsafe，
// 与「黑名单共 80 项」锚冲突。此处逐点值与 lib 的 UNSAFE_PORTS 必须同源一致。
const unsafeOnes = [1, 7, 22, 25, 53, 69, 123, 389, 465, 587, 636, 993, 995, 2049, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080];
for (const p of unsafeOnes) assert('unsafe ' + p, isUnsafePort(p) === true, p);
for (const p of [0, 80, 443, 3000, 5000, 8080, 8888, 49152, 65535]) assert('safe ' + p, isUnsafePort(p) === false, p);
// 黑名单规模锚（防误删列表项）：官方 kRestrictedPorts 共 80 项
assert('UNSAFE_PORTS 规模 === 80（Chromium 官方黑名单全集）', UNSAFE_PORTS.size === 80, UNSAFE_PORTS.size);

// ===== P2 真实模块行为杀手 =====
function makeServer() {
  return http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); });
}

async function p2() {
  console.log('\n== P2 真实 listenSafe 行为 ==');

  // B1：30 次顺序绑定，端口恒 safe（真实绑定路径）
  let allSafe = true; const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const srv = makeServer();
    await listenSafe(srv, '127.0.0.1');
    const port = srv.address().port;
    if (isUnsafePort(port)) allSafe = false;
    seen.add(port);
    srv.close();
  }
  assert('B1 30 次顺序绑定端口全 safe', allSafe, [...seen].slice(0, 8));

  // B2：重绑路径——首个候选强制撞一个已被占用的端口（EADDRINUSE 现场形状），
  // listenSafe 必须 close + 换候选重绑，最终端到端 HTTP GET 200。
  const blocker = makeServer();
  await listenSafe(blocker, '127.0.0.1');
  const blockerPort = blocker.address().port;

  const real = makeServer();
  let listenCalls = 0;
  const wrapper = Object.create(real);
  Object.defineProperty(wrapper, 'listen', {
    value: (...args) => {
      listenCalls++;
      if (listenCalls === 1) return real.listen(blockerPort, '127.0.0.1'); // 必定 EADDRINUSE
      return real.listen(...args);
    },
  });
  await listenSafe(wrapper, '127.0.0.1');
  const reboundPort = real.address().port;
  assert('B2 首候选撞占用端口 → 换候选重绑到 safe 端口', listenCalls >= 2 && !isUnsafePort(reboundPort) && reboundPort !== blockerPort, { listenCalls, port: reboundPort, blockerPort });
  const got = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: reboundPort, path: '/' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', () => resolve(0));
  });
  assert('B2 重绑后端到端 HTTP GET 200（端口真实可用）', got === 200, got);
  real.close();
  blocker.close();

  // B3：放弃路径——listen 恒失败 → 50 次候选上限后必须 reject（不死循环）
  const cursed = makeServer();
  Object.defineProperty(cursed, 'listen', {
    value: () => {
      process.nextTick(() => cursed.emit('error', Object.assign(new Error('EADDRINUSE fake'), { code: 'EADDRINUSE' })));
      return cursed;
    },
  });
  let rejected = null;
  try { await listenSafe(cursed, '127.0.0.1'); } catch (e) { rejected = e; }
  assert('B3 候选恒失败 → 50 次上限 reject（不死循环）', !!rejected && /no safe port after 50 candidate attempts/.test(rejected.message), rejected && rejected.message);

  // B4：候选采样——randomSafePort 5000 次全 safe（纯函数行为面整类守卫）
  let sampledSafe = true;
  for (let i = 0; i < 5000; i++) if (isUnsafePort(randomSafePort())) sampledSafe = false;
  assert('B4 randomSafePort 5000 次采样恒 safe', sampledSafe);
}
(async () => { await p2();

// ===== P3 整类守卫：test_*.js 零裸 listen(0)，全量消费共享原语 =====
console.log('\n== P3 整类守卫 ==');
const scriptsDir = path.join(__dirname);
const testFiles = fs.readdirSync(scriptsDir).filter((f) => /^test_.*\.js$/.test(f));
const bare = [];
for (const f of testFiles) {
  // 跳过自身：本文件的注释/断言文案必然含被禁模式（自指），扫自己恒红。
  if (f === 'test_c94_safe_port.js') continue;
  const src = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
  if (/listen\(0/.test(src)) bare.push(f);
}
assert('P3a 全部 test_*.js 零裸 listen(0)（整类杀手，未来新文件同样受约束）', bare.length === 0, bare);
const consumers = testFiles.filter((f) => /lib_safe_port/.test(fs.readFileSync(path.join(scriptsDir, f), 'utf8')));
assert('P3b 全量迁移锚：本批收口的 14 个测试文件均消费 lib_safe_port', consumers.length >= 14, { count: consumers.length, missing: testFiles.filter((f) => !consumers.includes(f)) });
assert('P3c lib_safe_port.js 自身在盘', fs.existsSync(path.join(scriptsDir, 'lib_safe_port.js')));

console.log('\nPASS=' + pass + ' FAIL=' + fail + ' => ' + (fail === 0 ? 'TEST_OK' : 'TEST_FAILED'));
if (fail > 0) { console.log('失败项: ' + failures.join(' | ')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
