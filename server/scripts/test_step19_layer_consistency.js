'use strict';
// STEP 19R — 层一致性工程测试（B 类修复：网络层 Client Hints 头 === JS 层 userAgentData）
// 断言对象 = 真实 launch 链路（browserManager.launch → applyClientHints CDP override + inject.js）。
// 本地 HTTP server 捕获请求头（sec-ch-ua* / user-agent / accept-language），与页内 JS 读值逐字段比对：
//   L1 sec-ch-ua 头 brands === navigator.userAgentData.brands（含 GREASE 值与顺序）
//   L2 sec-ch-ua-platform 头 === userAgentData.platform
//   L3 sec-ch-ua-mobile 头 === userAgentData.mobile
//   L4 HTTP User-Agent 头 === navigator.userAgent
//   L5 Accept-Language 头语言族 === navigator.language
//   L6 JS 层 fullVersionList/uaFullVersion 主版本 === UA 主版本（getHighEntropyValues）
//   L7 sec-ch-ua 头主版本 === UA 头主版本（版本对齐无残留）
//   L8 双层同源 invariant（P4.2）：JS brands === HTTP brands === 契约(原生 brands)
//      —— 从「版本快照断言」升级为「稳定 invariant」，版本漂移免疫（P4.2 授权令 §8）
//   TA 原生同源·JS 层（P4.2 §9 Test A）：JS brands === contract(native brands)
//   TB 原生同源·HTTP 层（P4.2 §9 Test B）：HTTP brands === contract(native brands)
//   TC 顺序保留（P4.2 §9 Test C）：契约只允许 HeadlessChrome→Google Chrome 重命名，不重排
//   TD 版本保留（P4.2 §9 Test D）：brand.version 逐项 === 原生值，GREASE 版本非硬编码
//   TE 无硬编码 GREASE 回归（P4.2 §9 Test E）：生产源文件零固定 GREASE contract 字面量
//   TF Headless 契约（P4.2 §9 Test F）：JS/HTTP 两层均无 HeadlessChrome 且保持同源
// 用法：node server/scripts/test_step19_layer_consistency.js

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step19-layer-'));
process.env.FPB_DATA_DIR = TMP;

const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');
const { chromium } = require('playwright');

const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail).slice(0, 300) + ']'));
  return !!cond;
}

function parseSecChUa(h) {
  // 例: '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"'
  if (!h) return null;
  return h.split(', ').map((part) => {
    const m = part.match(/"([^"]+)";v="([^"]+)"/);
    return m ? { brand: m[1], version: m[2] } : null;
  }).filter(Boolean);
}

// P4.2：独立原生探针——不经 browserManager 注入链，直接读系统二进制的原生 brands。
// 注意 about:blank 上 navigator.userAgentData 为 null（实测），必须用真实 http 页。
async function probeNativeBrands() {
  const SYSTEM_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const executablePath = fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined;
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>probe</html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:' + srv.address().port + '/', { waitUntil: 'load', timeout: 15000 });
      return await page.evaluate(async () => {
        const u = navigator.userAgentData;
        if (!u || !Array.isArray(u.brands) || !u.brands.length) return null;
        let fullVersionList = null;
        try {
          const he = await u.getHighEntropyValues(['fullVersionList']);
          if (he && Array.isArray(he.fullVersionList)) fullVersionList = he.fullVersionList.map((b) => ({ brand: String(b.brand), version: String(b.version) }));
        } catch (e) {}
        return { brands: u.brands.map((b) => ({ brand: String(b.brand), version: String(b.version) })), fullVersionList };
      });
    } finally { await browser.close(); }
  } finally { srv.close(); }
}

// TC/TD 规则：除 HeadlessChrome→Google Chrome 重命名外逐项一致（顺序/数量/版本）
function contractMatchesNative(replayed, native) {
  if (!Array.isArray(replayed) || !Array.isArray(native) || replayed.length !== native.length) return false;
  return native.every((nb, i) => {
    const rb = replayed[i];
    const brandOk = rb.brand === nb.brand || (nb.brand === 'HeadlessChrome' && rb.brand === 'Google Chrome');
    return brandOk && String(rb.version) === String(nb.version);
  });
}

(async () => {
  // 本地捕获 server
  let captured = null;
  const server = http.createServer((req, res) => {
    captured = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // P4.2：注入前先取原生基准（独立探针，不经产品注入链）
  const native = await probeNativeBrands();
  const contract = browserManager.applyHeadlessBrandContract;

  // 用一个「预生成 UA 版本远离引擎」的 seed 暴露对齐残留（多 seed 提高命中概率）
  const profile = {
    id: 'p19_layer', name: 'p19_layer', group: 'verify', tags: [], notes: '',
    seed: 'step19-layer-1', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    lastSessionUrls: [], fingerprintOverride: {}, createdAt: Date.now(),
  };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), { os: 'Windows', browser: 'Chrome' }, null);
  db.upsertProfile(profile);
  console.log('预生成 UA: ' + profile.fingerprint.userAgent.slice(0, 100));

  const session = await browserManager.launch(profile, null);
  const page = session.page;
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(500);
  if (!assert('L0 本地请求已被捕获（含 sec-ch-ua 头）', !!(captured && captured['sec-ch-ua']), captured && Object.keys(captured || {}).filter((k) => k.startsWith('sec-')))) {
    await browserManager.close(profile.id); server.close(); process.exit(1);
  }

  const js = await page.evaluate(async () => {
    const he = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'uaFullVersion', 'platformVersion', 'architecture', 'bitness']);
    return {
      ua: navigator.userAgent,
      brands: navigator.userAgentData.brands.map((b) => ({ brand: b.brand, version: String(b.version) })),
      platform: navigator.userAgentData.platform,
      mobile: navigator.userAgentData.mobile,
      language: navigator.language,
      he,
    };
  });

  const hdrBrands = parseSecChUa(captured['sec-ch-ua']);
  const uaMajor = (s) => String(s).split('Chrome/')[1] && String(s).split('Chrome/')[1].split(' ')[0].split('.')[0];
  const fullMajor = (s) => String(s).split('.')[0];

  assert('L1a sec-ch-ua brands 条数 === JS brands 条数', hdrBrands.length === js.brands.length, { hdr: hdrBrands, js: js.brands });
  assert('L1b sec-ch-ua brands 逐项一致（值+顺序，含 GREASE）',
    JSON.stringify(hdrBrands) === JSON.stringify(js.brands), { hdr: hdrBrands, js: js.brands });
  assert('L2 sec-ch-ua-platform === JS platform',
    String(captured['sec-ch-ua-platform']).replace(/"/g, '') === js.platform, { hdr: captured['sec-ch-ua-platform'], js: js.platform });
  // sec-ch-ua-mobile 是结构化字段布尔：?0=false / ?1=true（需归一化，不能直接字符串比对）
  const hdrMobile = String(captured['sec-ch-ua-mobile']).trim() === '?1';
  assert('L3 sec-ch-ua-mobile === JS mobile', hdrMobile === js.mobile, { hdr: captured['sec-ch-ua-mobile'], js: js.mobile });
  assert('L4 HTTP User-Agent === navigator.userAgent', captured['user-agent'] === js.ua, { hdr: captured['user-agent'], js: js.ua });
  assert('L5 Accept-Language 首语言 === navigator.language',
    String(captured['accept-language']).split(',')[0] === js.language, { hdr: captured['accept-language'], js: js.language });
  assert('L6a JS fullVersionList 主版本 === UA 主版本',
    fullMajor(js.he.fullVersionList.find((b) => b.brand === 'Google Chrome').version) === uaMajor(js.ua), { he: js.he.fullVersionList, ua: js.ua });
  assert('L6b JS uaFullVersion === UA 完整版本', js.he.uaFullVersion === uaVerOf(js.ua), { he: js.he.uaFullVersion });
  assert('L7 sec-ch-ua 头主版本 === UA 头主版本',
    hdrBrands.find((b) => b.brand === 'Google Chrome').version === uaMajor(captured['user-agent']), { hdr: hdrBrands, uaHdr: captured['user-agent'] });
  // ===== P4.2：L8 从「版本快照」升级为「双层同源 invariant」+ Test A–F =====
  // L8：JS brands === HTTP brands === 契约(原生 brands)——单源回放，无任何版本快照断言。
  // 适用于 Chromium 151 / Chrome 152 / 未来任意版本（只要浏览器原生 brands 正确即通过）。
  if (!assert('L0b 原生基准已取得（原生探针 brands 非空）', !!(native && Array.isArray(native.brands) && native.brands.length), native)) {
    await browserManager.close(profile.id); server.close(); process.exit(1);
  }
  const replayed = contract(native.brands);
  assert('L8 JS/HTTP brands 双层同源 invariant（同值同序同结构）',
    JSON.stringify(hdrBrands) === JSON.stringify(js.brands) && JSON.stringify(js.brands) === JSON.stringify(replayed),
    { hdr: hdrBrands, js: js.brands, replayed });
  // Test A — 原生同源·JS 层：JS brands === contract(native brands)（含单源 fp._uaBrands 中转验证）
  assert('TA JS 层 brands === 契约(原生 brands)（单源 fp._uaBrands）',
    Array.isArray(session.fp._uaBrands)
    && JSON.stringify(session.fp._uaBrands) === JSON.stringify(replayed)
    && JSON.stringify(js.brands) === JSON.stringify(replayed),
    { fpUaBrands: session.fp._uaBrands, replayed, js: js.brands });
  // Test B — 原生同源·HTTP 层：HTTP brands === contract(native brands)
  assert('TB HTTP 层 brands === 契约(原生 brands)', JSON.stringify(hdrBrands) === JSON.stringify(replayed),
    { hdr: hdrBrands, replayed });
  // Test C — 顺序保留：除 HeadlessChrome→Google Chrome 重命名外，顺序/数量逐项一致
  assert('TC 契约不重排（顺序/数量保留，仅允许 HeadlessChrome 重命名）',
    contractMatchesNative(js.brands, native.brands), { native: native.brands, js: js.brands });
  // Test D — 版本保留：逐项 version === 原生值；GREASE brand 版本跟随原生，非硬编码旧值
  const greasedNative = native.brands.find((b) => /^Not/.test(b.brand));
  const greasedJs = js.brands.find((b) => /^Not/.test(b.brand));
  assert('TD brand.version 逐项 === 原生值（GREASE 版本非硬编码）',
    contractMatchesNative(js.brands, native.brands)
    && !!greasedNative && !!greasedJs && String(greasedJs.version) === String(greasedNative.version),
    { nativeGrease: greasedNative, jsGrease: greasedJs });
  // Test E — 无硬编码 GREASE 回归：生产源文件（inject.js / browserManager.js）零固定 GREASE 字面量
  const injectSrc = fs.readFileSync(path.join(__dirname, '..', 'fp', 'inject.js'), 'utf8');
  const bmSrc = fs.readFileSync(path.join(__dirname, '..', 'browserManager.js'), 'utf8');
  const injectHits = injectSrc.match(/Not[=?_ ]A[_ ]?Brand/g) || [];
  const bmHits = bmSrc.match(/Not[=?_ ]A[_ ]?Brand/g) || [];
  assert('TE 生产源文件零硬编码 GREASE contract（inject.js + browserManager.js）',
    injectHits.length === 0 && bmHits.length === 0,
    { injectHits: injectHits.length, bmHits: bmHits.length });
  // Test F — Headless 契约：两层均无 HeadlessChrome，且契约后 JS == HTTP 仍然成立
  assert('TF 两层无 HeadlessChrome 且保持同源',
    !js.brands.some((b) => b.brand === 'HeadlessChrome')
    && !hdrBrands.some((b) => b.brand === 'HeadlessChrome')
    && JSON.stringify(hdrBrands) === JSON.stringify(js.brands),
    { js: js.brands, hdr: hdrBrands });

  function uaVerOf(ua) { const p = String(ua).split('Chrome/')[1]; return p ? p.split(' ')[0] : ''; }

  await browserManager.close(profile.id);
  server.close();
  const pass = results.filter((r) => r.pass).length;
  console.log('\nPASS=' + pass + ' FAIL=' + (results.length - pass) + ' => ' + (pass === results.length ? 'TEST_OK' : 'TEST_FAILED'));
  await browserManager.closeAll().catch(() => {});
  process.exit(pass === results.length ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e); await browserManager.closeAll().catch(() => {}); process.exit(1); });
