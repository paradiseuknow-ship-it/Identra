'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { generateFingerprint, seedFromProfile } = require('./fp/generate');
const { ensureIdentity } = require('./fp/identityStore');
const { buildIdentity } = require('./fp/identityFactory');
const { buildInjectionScript } = require('./fp/inject');
const nativeOwnership = require('./fp/nativeOwnership');
const { isPatchActive } = require('./fp/nativePatchManifest');
const { applyHeadlessBrandContract } = require('./fp/uaBrands');
const { checkProxyGeo, getProxyEgressGeo, resolveProxyType, getEgressIp } = require('./proxyChecker');
const { lookupIp } = require('./geoip');
const { startShim } = require('./socksShim');
const { startHttpShim } = require('./httpProxyShim');
const { precheckProxy } = require('./proxyPrecheck');
const { runIntegrityCheck, logIntegrity } = require('./integrity');

const sessions = new Map(); // profileId -> { context, page, fp, proxy, profileId, startedAt }

// 可选：经中间 SOCKS5 代理（如本机 v2ray）再连上游 rola，避免 rola 因源 IP 地区拒绝连接。
// 优先读取环境变量 SOCKS5_HOP；未设置时默认使用本机 v2ray 常见端口 127.0.0.1:10808。
// 若该端口不可用，socksShim 会自动回退到直连 upstream。
function parseSocks5Hop() {
  const env = process.env.SOCKS5_HOP || process.env.socks5_hop || '';
  if (env) {
    const m = env.match(/^([^:]+):(\d+)$/);
    if (m) return { host: m[1], port: Number(m[2]) };
  }
  return { host: '127.0.0.1', port: 10808 };
}
const GLOBAL_SOCKS5_HOP = parseSocks5Hop();

// 启动时异步确认默认 hop 端口是否真的是无认证 SOCKS5，仅用于日志/提示
async function checkHopPortAvailable() {
  if (process.env.SOCKS5_HOP || process.env.socks5_hop) return true; // 用户已显式设置，信任即可
  const net = require('net');
  const socket = new net.Socket();
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.connect(10808, '127.0.0.1');
    });
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 3000);
      socket.once('data', (buf) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(buf.length >= 2 && buf[0] === 0x05 && buf[1] === 0x00);
      });
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    return ok;
  } catch (e) {
    try { socket.destroy(); } catch (_) {}
    return false;
  }
}

// 优先使用系统 Google Chrome，其 JA3/TLS 指纹更接近真实用户，能降低被 Google 等站直接拒绝的概率
const SYSTEM_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const { assertSafeName, resolveWithin } = require('./security/safePath');

// C46 真实缺陷（B 类基建）：PROFILES_ROOT 此前硬编码 data/profiles，漏接 CAP-O1 FPB_DATA_DIR
// 隔离约定（db.js / agent/storage / backup.js / identity.js 均已支持）→ fp16b 真实 launch 测试
// 与所有 launch 路径固定写 data/profiles/<id>，跨回归实例/相邻套件争用同一 Chrome profile
// 目录（SingletonLock）→ 偶发 launch 崩溃 FATAL「无统计行」（2026-09-07 C44/C45 两轮实证）。
// 补齐约定：FPB_DATA_DIR 设置时 profile 目录随数据根隔离；默认路径零变化。
const PROFILES_ROOT = process.env.FPB_DATA_DIR
  ? path.resolve(process.env.FPB_DATA_DIR, 'profiles')
  : path.join(__dirname, '..', 'data', 'profiles');

// STEP 0.5 §2.2：profileId 参与文件系统路径拼接，必须过段名白名单 + 根内解析。
// 合法 id 形如 p_lz3k9x（字母数字 + 下划线），白名单不会误伤。
function profileDataDir(profileId) {
  return resolveWithin(PROFILES_ROOT, assertSafeName(profileId, 'profileId'));
}

// 读取本机真实 Chrome 的完整版本号（如 151.0.7922.138），用于把伪造 UA 对齐到引擎实际版本，
// 使 UA 字符串 / Sec-CH-UA 请求头 / navigator.userAgentData 三者版本完全一致（与 adsPower 同款自然度）。
// 失败返回 null，此时沿用指纹池版本。返回完整版本（含补丁/构建号），避免 UA 写成 151.0.0.0 这种零补丁假版本。
//
// C30 真实缺陷修复：原实现每次 launch 都 fork 一次 powershell 读 PE 版本头，且失败**静默返回 null**。
// 顺序回归跑 130+ 套件时系统负载高，powershell 冷启动常越过 5s 超时 → getChromeVersion() 返回 null
// → 伪造 UA 停在指纹池版本（147），而 brands/identity 走原生回放（152）→ **UA 层 ↔ brands 层版本分裂**
// （step19 L6a/L7 invariant 红灯）。这是 A 类层间一致性缺陷，不是测试噪声：
//   ① 版本号属进程级不变事实 → memo 缓存（一次成功即复用，彻底消除重复 fork 与负载窗口）；
//   ② 失败重试一轮 + 超时放宽到 8s；
//   ③ 失败必须留下可观测 warn（原先 return null 静默，等于把失守的一致性藏起来）。
let _chromeVerCache = null;
let _chromeVerWarned = false;
function getChromeVersion() {
  if (_chromeVerCache) return _chromeVerCache;
  if (!SYSTEM_CHROME || !fs.existsSync(SYSTEM_CHROME)) {
    if (!_chromeVerWarned) {
      _chromeVerWarned = true;
      console.warn('[ua] 未找到本机 Chrome 可执行文件，伪造 UA 无法对齐引擎版本：' + SYSTEM_CHROME);
    }
    return null;
  }
  const cmd = `powershell -NoProfile -Command "(Get-Item '${SYSTEM_CHROME.replace(/'/g, "''")}').VersionInfo.ProductVersion"`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] });
      const m = (out || '').trim().match(/^(\d+\.\d+\.\d+\.\d+)/);
      if (m) { _chromeVerCache = m[1]; return _chromeVerCache; }
    } catch (e) {
      if (attempt === 1 && !_chromeVerWarned) {
        _chromeVerWarned = true;
        console.warn('[ua] 读取引擎版本失败（UA 将无法对齐引擎，层间一致性风险）：' + String(e.message || e).slice(0, 160));
      }
    }
  }
  return null;
}

// Phase 16-B C7-CONFIG：Accept-Language 单一事实源 = fp.languages（identity 列表）。
// 原 buildAcceptLanguage()（手工拼 q-factor 串）已删除：CDP acceptLanguage 期望「原始逗号
// 分隔列表」，q 因子由 Chromium 原生 net::HttpUtil::GenerateAcceptLanguageHeader 生成；
// 手工 q 串经 renderer 侧 ParseAndSanitize（不剥 q）会污染 Worker 端 navigator.languages
//（B 类一致性缺陷：["de-DE","de;q=0.9",...] ≠ window FP.languages）。

// C7-CONFIG：Worker/pref 链 Accept-Language 注入（launch 前 read-modify-write）。
// WorkerNavigator 的语言链 = renderer_preferences_.accept_languages
//（dedicated_or_shared_worker_global_scope_context_impl.cc:480-483 ← WebWorkerFetchContext
// ← profile pref intl.accept_languages）。CDP page-session override 不达 Worker
//（.benchmark/c7_worker_probe.js V2-V7 实证：Worker 恒显机器 pref 值），pref 注入是
// Worker 一致性的唯一 CONFIG 通道；同时兜底 C2-active（CDP UA-CH 停发）与无 CDP 形态的
// HTTP/window-native（c7_worker_probe2 V8 实证：pref 链驱动三端原生同源 + 原生 q 生成）。
// 解析失败不动原文件（绝不破坏既有 profile 数据）。
function injectAcceptLanguagesPref(userDataDir, languages) {
  try {
    if (!Array.isArray(languages) || !languages.length) return;
    const defDir = path.join(userDataDir, 'Default');
    const prefsPath = path.join(defDir, 'Preferences');
    let prefs;
    if (fs.existsSync(prefsPath)) {
      try {
        prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      } catch (e) {
        return;
      }
    } else {
      fs.mkdirSync(defDir, { recursive: true });
      prefs = {};
    }
    if (!prefs || typeof prefs !== 'object') return;
    prefs.intl = Object.assign({}, prefs.intl, { accept_languages: languages.join(',') });
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (e) {
    console.warn('[fp16b-c7] accept_languages pref 注入失败(忽略):', e.message);
  }
}

// P4.2：native UA-CH brands 捕获 —— 唯一事实源 = 浏览器原生运行时。
// 实测（.benchmark/p42_capture_probe.json）：about:blank 上 navigator.userAgentData 为 null，
// 因此用一次性 127.0.0.1 捕获页（真实 http origin）在 addInitScript 之前读取原生
// brands + fullVersionList（此刻 context 尚未注入任何 init script，读到的就是二进制原生值，
// 且不受 Playwright userAgent option 污染——实测 UA option 不改变原生 brands）。
// 结果按「二进制|引擎版本|headless」记忆化：进程内同一浏览器形态只捕获一次。
const _nativeUaBrandsCache = new Map();
async function captureNativeUaBrands(context, cacheKey) {
  if (!context) return null;
  if (cacheKey && _nativeUaBrandsCache.has(cacheKey)) return _nativeUaBrandsCache.get(cacheKey);
  let result = null;
  let server = null;
  let tempPage = null;
  try {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>ua-ch-capture</body></html>');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    tempPage = await context.newPage();
    await tempPage.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 10000 });
    result = await tempPage.evaluate(async () => {
      const u = navigator.userAgentData;
      if (!u || !Array.isArray(u.brands) || !u.brands.length) return null;
      const brands = u.brands.map((b) => ({ brand: String(b.brand), version: String(b.version) }));
      let fullVersionList = null;
      try {
        const he = await u.getHighEntropyValues(['fullVersionList']);
        if (he && Array.isArray(he.fullVersionList) && he.fullVersionList.length) {
          fullVersionList = he.fullVersionList.map((b) => ({ brand: String(b.brand), version: String(b.version) }));
        }
      } catch (e) {}
      return { brands, fullVersionList };
    });
  } catch (e) {
    console.warn('[ua] native brands 捕获失败(双层降级为浏览器原生):', e.message);
    result = null;
  } finally {
    if (tempPage) await tempPage.close().catch(() => {});
    if (server) server.close();
  }
  if (result && cacheKey) _nativeUaBrandsCache.set(cacheKey, result);
  return result;
}

// 通过 CDP Emulation.setUserAgentOverride 一次性对齐【网络层 Client Hints 请求头】与【JS 层 navigator 属性】。

// C10（locale HTTP 裸头竞态修复）：renderer 级 Intl locale override。
// Playwright locale option 会同时触发 browser 级 Browser.setLocaleOverride → network 层
// Accept-Language 变裸单值（XHR/fetch 管道不走 emulation acceptLanguage 改写，实测裸头
// 泄漏：.benchmark/c10_locale_probe.js 形态 A xhr=BARE vs navigation=Q-FORM 竞态）。
// 改为仅发 renderer 级 Emulation.setLocaleOverride：Intl.DateTimeFormat/NumberFormat
// = fp.language（形态 D 实证 de-DE），HTTP 头全管道回归 pref/override 的原生 q 形。
// 独立于 C2-active 状态发送（Intl 一致性与 UA-CH 让位正交）。
async function sendIntlLocaleOverride(client, language) {
  try {
    await client.send('Emulation.setLocaleOverride', { locale: language });
  } catch (e) {
    if (!String(e && e.message).includes('Another locale override')) {
      console.warn('[ua] Intl locale override 失败(已忽略):', e.message);
    }
  }
}
// 这是关键：Playwright 的 userAgent 选项只改了 User-Agent 头，但 Sec-CH-UA / Sec-CH-UA-Platform /
// Sec-CH-UA-Mobile 等 Client Hints 头仍由 Chromium 按真实二进制版本自动生成，与伪造 UA 对不上。
// Google / Cloudflare / reCAPTCHA 会同时比对「请求头里的 Client Hints」与「JS 读到的 navigator.userAgentData」，
// 一旦版本/平台不一致即判定自动化 → 跳人机验证。CDP override 让两者完全一致（adsPower 同理）。
//
// P4.2：brands/fullVersionList 不再硬编码——唯一事实源 = 浏览器原生运行时捕获（fp._uaBrands，
// 由 createProfileContext 在 addInitScript 之前捕获并施加既有 HeadlessChrome 契约）。
// Chrome 153+ 改变 GREASE 格式/顺序时，本层自动跟随原生值，不存在版本快照漂移。

// Phase 16-B C2（platformversion-identity）行为接线 gate。
// 相干性要求（缺一不可）：
//   ① manifest 判定 patch active（enabled=双回归全过；或显式测试通道 FPB_FORCE_ACTIVE_PATCHES）；
//   ② 本次 launch 实际使用 native patched 二进制（FPB_NATIVE_CHROME 指向）——
//      stock 系统 Chrome 无 fp-platform-version switch/merge 语义，此时让位会造成
//      platformVersion 空值直漏（B 类一致性缺陷），必须保持既有 '15.0.0' 行为。
function isC2PlatformVersionActive() {
  return isPatchActive('platformversion-identity') && !!process.env.FPB_NATIVE_CHROME;
}

// Phase 16-B C3（navigator-identity）行为接线 gate。与 C2 同款相干性要求：
// manifest active（或 FPB_FORCE_ACTIVE_PATCHES 测试通道）+ 实际使用 native
// patched 二进制；stock 二进制上注入 --fp-platform 无人消费，此时让位会造成
// navigator.platform 直漏本机原生值（B 类一致性缺陷），必须保持 JS 生产既有行为。
function isC3PlatformActive() {
  return isPatchActive('navigator-identity') && !!process.env.FPB_NATIVE_CHROME;
}

// Phase 16-B C4（hardwareConcurrency-identity）行为接线 gate。patch 在
// NavigatorBase::hardwareConcurrency() 单 virtual 点消费 --fp-hardware-concurrency；
// 仅当 manifest 激活且运行 native patched 二进制时才注入（stock 二进制上无人消费）。
function isC4HardwareConcurrencyActive() {
  return isPatchActive('hardwareConcurrency-identity') && !!process.env.FPB_NATIVE_CHROME;
}

// Phase 16-B C5（deviceMemory-identity）行为接线 gate。patch 在
// NavigatorDeviceMemory::deviceMemory() 单函数点消费 --fp-device-memory；
// 仅当 manifest 激活且运行 native patched 二进制时才注入（stock 二进制上无人消费）。
// 白名单 = Chromium 真实输出域 {1,2,4,8,16,32}（ApproximatedDeviceMemory 实际
// clamp 桌面 [2,32]/Android [1,8]，crbug 454354290；非 spec 文本域 {0.25..8}）。
function isC5DeviceMemoryActive() {
  return isPatchActive('deviceMemory-identity') && !!process.env.FPB_NATIVE_CHROME;
}

// Phase 16-B C6（maxTouchPoints-identity）行为接线 gate。patch 在
// NavigatorEvents::maxTouchPoints() 单函数点消费 --fp-max-touch-points；
// 仅当 manifest 激活且运行 native patched 二进制时才注入（stock 二进制上无人消费）。
// 白名单 = 真实输出域 {0,5,10}（Windows SM_MAXIMUMTOUCHES 触摸屏常见 10 /
// 无数字化仪 0；移动端典型 5）。
function isC6MaxTouchPointsActive() {
  return isPatchActive('maxTouchPoints-identity') && !!process.env.FPB_NATIVE_CHROME;
}

async function applyClientHints(page, fp) {
  if (!page || !fp || !fp.userAgent) return;
  try {
    const client = await page.context().newCDPSession(page);
    const osPlatform = (fp.os === 'Windows' ? 'Windows'
      : (fp.os === 'macOS' || fp.os === 'Mac') ? 'macOS'
      : fp.os === 'Linux' ? 'Linux'
      : fp.os === 'Android' ? 'Android'
      : fp.os === 'iOS' ? 'iOS' : 'Windows');
    // P4.2（B 类修复·层一致性）：网络层 Client Hints 头与 JS 层 navigator.userAgentData（inject.js）
    // 必须逐字段一致——真实 Chrome 两层恒一致。两层均消费同一份 fp._uaBrands（原生捕获回放）。
    let brands = Array.isArray(fp._uaBrands) && fp._uaBrands.length
      ? fp._uaBrands.map((b) => ({ brand: String(b.brand), version: String(b.version) }))
      : null;
    let fullVersionList = Array.isArray(fp._uaFullVersionList) && fp._uaFullVersionList.length
      ? fp._uaFullVersionList.map((b) => ({ brand: String(b.brand), version: String(b.version) }))
      : null;
    if (!brands && page) {
      // 二次兜底：直接读当前页面（若 init script 已注入则与本层同源；若未注入则为原生值）
      try {
        const cap = await page.evaluate(() => {
          const u = navigator.userAgentData;
          return (u && Array.isArray(u.brands) && u.brands.length)
            ? u.brands.map((b) => ({ brand: String(b.brand), version: String(b.version) }))
            : null;
        });
        if (cap) brands = applyHeadlessBrandContract(cap);
      } catch (e) {}
    }
    if (!brands) {
      // 终极兜底：不发送 userAgentMetadata → 网络层与 JS 层均保持浏览器原生 UA-CH
      // （原生两层天然同源，见 .benchmark/step19_drift_probe.json），绝不伪造。
      await client.send('Emulation.setUserAgentOverride', {
        userAgent: fp.userAgent,
        acceptLanguage: fp.languages.join(','),
        platform: osPlatform,
      });
      await sendIntlLocaleOverride(client, fp.language);
      // C10 纪律：不 detach。emulation override（setUserAgentOverride/setLocaleOverride）
      // 随 DevTools session 生命周期存活（c10_locale_probe_d.js 实证：detach 后 Intl
      // override 被撤销回机器 locale）。session 保持至 context 关闭自然销毁；
      // 重复调用（同页再入）由「Another locale override」容忍分支 + 幂等覆盖兜底。
      console.log('[ua] Client Hints: brands 无原生捕获 → 保留浏览器原生 UA-CH（双层原生同源）');
      return;
    }
    if (!fullVersionList) {
      fullVersionList = brands.map((b) => ({
        brand: b.brand,
        version: /^\d+$/.test(b.version) ? b.version + '.0.0.0' : b.version,
      }));
    }
    // C2（platformversion-identity）active：UA-CH platformVersion 让位 Native。CDP 协议结构
    // 实证（16-B C2 修复轮）：userAgentMetadata.platformVersion 是 required String（缺字段 =
    // InvalidParams；空串虽被 browser 层 merge 回退，但 renderer 管道 navigation_request →
    // DocumentLoader → LocalFrameClientImpl「整体替换」绕过 merge → JS hev 直漏空串）。因此
    // C2 active 时整个 CDP UA-CH override 停发：JS/HTTP/Worker 全部回落 browser 级 patched
    // GetUserAgentMetadata()（单源）；UA 字符串由 Playwright context userAgent option 提供
    //（P4.2 实测：UA option 不污染原生 brands）。仅此 surface 让位；C2 inactive：逐字节 stock。
    if (isC2PlatformVersionActive()) {
      await sendIntlLocaleOverride(client, fp.language);
      // C10 纪律：session 保持（detach 撤销 emulation override），见上方 C10 注释。
      console.log('[ua] C2 platformVersion->Native: CDP UA-CH override skipped (Native single-source), UA string via Playwright option');
      return;
    }
    await client.send('Emulation.setUserAgentOverride', {
      userAgent: fp.userAgent,
      acceptLanguage: fp.languages.join(','),
      platform: osPlatform,
      userAgentMetadata: {
        brands,
        fullVersionList,
        platform: osPlatform,
        platformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        model: '',
        mobile: false,
        wow64: false,
      },
    });
    await sendIntlLocaleOverride(client, fp.language);
    // C10 纪律：session 保持（detach 撤销 emulation override），见 fallback 分支 C10 注释。
    console.log(`[ua] Client Hints 已对齐(原生回放): UA=${fp.userAgent} platform=${osPlatform} brands=${brands.map((b) => b.brand + '@' + b.version).join(', ')}`);
  } catch (e) {
    console.warn('[ua] Client Hints 覆盖失败(已忽略):', e.message);
  }
}

function proxyToPlaywright(proxy) {
  if (!proxy || !proxy.server) return undefined;
  let server = proxy.server;
  const type = (proxy.type || '').toLowerCase();
  // Playwright 的 SOCKS 代理 server 必须带协议头，否则会被当成 HTTP 处理
  if (type === 'socks5' && !/^socks5:\/\//i.test(server)) server = 'socks5://' + server;
  else if (type === 'socks4' && !/^socks4:\/\//i.test(server)) server = 'socks4://' + server;
  else if ((type === 'http' || type === 'https') && !/^https?:\/\//i.test(server)) server = (type === 'https' ? 'https://' : 'http://') + server;
  const p = { server };
  if (proxy.username) p.username = proxy.username;
  if (proxy.password) p.password = proxy.password;
  if (proxy.bypass) p.bypass = proxy.bypass;
  return p;
}

function buildArgs(profile) {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    '--disable-background-networking',
    '--disable-component-updates',
    '--disable-quic',
    // 稳定性：禁用崩溃转储处理器，避免弱网下崩溃进程异常导致整个 Chromium 瞬间退出
    '--disable-crashpad-handler',
    '--disable-breakpad',
  ];
  const fp = profile.fingerprint || {};
  const behavior = profile.launchBehavior || {};

  // GPU（STEP 19 修复）：此前 base args 无条件 --disable-gpu/--disable-software-rasterizer，
  // 导致 ①headless 下 WebGL 完全不可用（无 WebGL 的桌面浏览器是强 headless/自动化信号，
  // CreepJS 67% headless 的主因）②fp.hardwareAcceleration 旋钮为死参数。
  // 现按 fp.hardwareAcceleration 决定：默认 true 保留硬件加速（WebGL 真实可用），
  // 显式 false 才禁用（弱网/稳定性场景保留原有行为）。
  if (fp.hardwareAcceleration === false) {
    args.push('--disable-gpu', '--disable-gpu-sandbox', '--disable-software-rasterizer');
  }

  if (fp.tlsDisabled) {
    args.push('--ssl-version-max=tls1.2', '--disable-features=HttpsUpgrades');
  }
  if (fp.portScanProtection) {
    args.push('--force-webrtc-ip-handling-policy=default_public_interface_only');
  }
  if (behavior.blockVideo) {
    args.push(
      '--disable-features=PreloadMediaEngagementData,MediaRemoting,MediaSessionService',
      '--disable-media-source',
      '--disable-bundled-ppapi-flash'
    );
  }
  if (behavior.blockImages || (behavior.blockImagesThresholdKB !== undefined && behavior.blockImagesThresholdKB <= 0)) {
    args.push('--blink-settings=imagesEnabled=false');
  }

  // CAP hidden-headful（STEP 20）：launchBehavior.hiddenWindow=true 时窗口移出屏幕——
  // 进程仍是有界面 headful Chrome（UA/Worker/UA-CH 全真，无 HeadlessChrome 痕迹），
  // 兼顾反检测与「无头式」自动化体验。三个参数配合：
  //   --window-position=-32000,-32000 窗口移出可视区（-32000 而非 -3200 防止部分 WM 边缘吸附）；
  //   --disable-backgrounding-occluded-windows 窗口不可见时 Chromium 会将渲染器降级为
  //     backgrounding 状态（requestAnimationFrame 停摆、定时器节流、visibilityState 变化），
  //     禁掉它保证离屏窗口内页面照常渲染（自动化/取证依赖）；
  //   --disable-renderer-backgrounding 同理，防止后台 renderer 进程优先级被压低导致超时。
  if (behavior.hiddenWindow === true) {
    args.push(
      '--window-position=-32000,-32000',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    );
  }

  // 用户自定义启动参数
  if (Array.isArray(profile.launchArgs)) {
    for (const a of profile.launchArgs) {
      if (typeof a === 'string' && a.trim()) args.push(a.trim());
    }
  }
  return args;
}

// 启动前缓存清理，分三档，严格遵守「缓存清理」与「站点状态清理」分离：
//   'cache' —— 只清 HTTP Cache / Code Cache / GPUCache，绝不碰 LocalStorage / IndexedDB /
//              Service Worker / Cookies。现代网站登录态、设备状态大量存在这些存储里，
//              清它们 = 把用户踢下线，违背"环境持久化"。
//   'full'  —— 缓存 + 全部站点状态（LocalStorage / IndexedDB / Service Worker / Storage 等）；
//              Cookies 默认保留，仅当 opts.clearCookies === true 才一并删除。
// 返回被清理的目录名列表（便于日志/前端提示）。
async function clearProfileCache(profileId, mode = 'cache', opts = {}) {
  const base = profileDataDir(profileId);
  const cleared = [];
  if (!fs.existsSync(base)) return cleared;
  if (mode !== 'cache' && mode !== 'full') return cleared;

  const cacheDirs = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache'];
  const stateDirs = [
    'Default/Local Storage',
    'Default/Session Storage',
    'Default/IndexedDB',
    'Default/databases',
    'Default/Service Worker',
    'Default/Storage',
    'Default/File System',
  ];
  const cookieFiles = ['Default/Cookies', 'Default/Network/Cookies'];
  const dirs = mode === 'full' ? cacheDirs.concat(stateDirs) : cacheDirs;

  for (const d of dirs) {
    const full = path.join(base, d);
    if (fs.existsSync(full)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        cleared.push(d);
      } catch (e) {}
    }
  }
  if (mode === 'full' && opts.clearCookies === true) {
    for (const f of cookieFiles) {
      const full = path.join(base, f);
      if (fs.existsSync(full)) {
        try {
          fs.rmSync(full, { force: true });
          cleared.push(f);
        } catch (e) {}
      }
    }
  }
  return cleared;
}

async function resolveLaunchIpGeo(profile, proxy) {
  const override = profile.fingerprintOverride || {};
  const tzIp = override.timezoneMode === 'ip';
  const langIp = override.languageMode === 'ip';
  const geoIp = override.geolocation?.mode === 'ip';
  if (!tzIp && !langIp && !geoIp) return null;

  // 配置了代理 + "基于 IP"模式：必须拿到【代理出口】的地理信息。
  // 否则时区/语言/地理位置会回退成随机或本机值，与代理地区不一致 → 出库被识别为泄露。
  // 因此：解析失败一律报错并阻断启动，【绝不回退直连 / 随机】。
  if (proxy && proxy.server) {
    let ip = null;
    let geo = null;
    try {
      ({ ip, geo } = await getProxyEgressGeo(proxy)); // 内部已重试 socks5/http + 多 geo 源
    } catch (e) {
      throw new Error(
        '代理出口 IP 解析失败：' + (e.message || e) +
        '。已阻止启动，避免指纹回退成本机直连导致泄露。请检查代理可用性，或改用「自定义」时区/语言/地理位置后重试。'
      );
    }
    if (!ip) {
      throw new Error(
        '代理出口 IP 解析失败：无法获取代理的公网出口地址。已阻止启动，避免指纹回退成本机直连导致泄露。' +
        '请检查代理可用性，或改用「自定义」时区/语言/地理位置后重试。'
      );
    }
    if (!geo) {
      throw new Error(
        '已取得代理出口 IP，但地理位置库未返回时区/语言/经纬度。已阻止启动，避免"基于 IP"指纹落空造成环境不一致（出库异常）。' +
        '请检查本机到 geo 服务的网络可达性，或改用「自定义」后重试。'
      );
    }
    return geo;
  }

  // 无代理：直连本就是该环境的真实出口，用本机出口 IP 解析地理（不算泄露）
  try {
    const ip = await getEgressIp(null);
    const geo = await lookupIp(ip);
    if (geo) geo.ip = ip;
    if (!geo) throw new Error('无法解析本机出口 IP 的地理位置');
    return geo;
  } catch (e) {
    throw new Error('未配置代理且无法解析本机出口 IP，无法生成"基于 IP"指纹：' + (e.message || e));
  }
}

function videoMimeOrUrl(req) {
  const rt = req.resourceType();
  const url = req.url().toLowerCase();
  if (rt === 'media' || rt === 'video') return true;
  if (/\.(mp4|webm|ogg|ogv|mov|mkv|avi|flv|m4v|3gp)(\?|#|$)/i.test(url)) return true;
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) return true;
  if (url.includes('video') && /\.(ts|m4s|mp2t)(\?|#|$)/i.test(url)) return true;
  const headers = req.headers();
  const ct = (headers['content-type'] || '').toLowerCase();
  if (ct.startsWith('video/') || ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/dash+xml')) return true;
  return false;
}

// 验证码 / 反爬挑战的图片域名白名单：这些图若被「禁止加载大图」拦截，会导致 reCAPTCHA /
// hCaptcha / Cloudflare Turnstile 等图形验证永远加载不出 → 验证失败 / 一直转圈。
// 即使用户开启了省流量功能，也强制放行这些域名，保证验证可正常进行。
const VERIFICATION_HOST_KEYWORDS = [
  'recaptcha', 'gstatic', 'google.com', 'hcaptcha', 'cloudflare', 'captcha',
  'arkoselabs', 'funcaptcha', 'geetest', 'twocaptcha', 'datadome',
  'perimeterx', 'incapsula', 'kasada', 'fingerprintjs',
];
function isVerificationHost(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return VERIFICATION_HOST_KEYWORDS.some((k) => h.includes(k));
  } catch (e) {
    return false;
  }
}

async function setupRoutes(page, behavior) {
  behavior = behavior || {};
  // 图片拦截仅在用户显式开启「禁止加载大图」(blockImages===true) 时才生效；
  // 否则即便 blockImagesThresholdKB 有默认值，也一律不拦截（避免默认就拖慢网速 / 拦掉验证码）。
  const imgEnabled = behavior.blockImages === true;
  const blockImagesAll = imgEnabled && (behavior.blockImagesThresholdKB === undefined || behavior.blockImagesThresholdKB <= 0);
  const blockImagesThreshold = imgEnabled && behavior.blockImagesThresholdKB > 0 ? behavior.blockImagesThresholdKB * 1024 : 0;

  if (!behavior.blockVideo && !blockImagesAll && !blockImagesThreshold) return;

  await page.route('**/*', async (route) => {
    const req = route.request();

    if (behavior.blockVideo && videoMimeOrUrl(req)) {
      route.abort('blockedbyclient');
      return;
    }

    if (req.resourceType() === 'image') {
      // 验证码 / 反爬挑战图强制放行，绝不因省流量而被拦
      if (isVerificationHost(req.url())) {
        route.continue();
        return;
      }
      if (blockImagesAll) {
        route.abort('blockedbyclient');
        return;
      }
      if (blockImagesThreshold) {
        try {
          const response = await route.fetch();
          const len = Number(response.headers()['content-length'] || 0);
          if (len > blockImagesThreshold) {
            route.abort('blockedbyclient');
            return;
          }
          // 未超阈值：原样回放（route.fulfill 复用已 fetch 的 response，避免手动编解码开销）
          await route.fulfill({ response });
          return;
        } catch (e) {
          try { route.continue(); } catch (_) {}
          return;
        }
      }
    }

    route.continue();
  });
}

// ---------------- 行为层拟人化（Bezier 鼠标轨迹 + 随机键盘时序）----------------
// 高级风控（Google reCAPTCHA v3 / Cloudflare Turnstile）在指纹过关后，会审计鼠标轨迹与
// 输入时序。Playwright 原生 page.click()/page.fill() 是“瞬移 + 0ms 灌字”，必须用人化层包装。

function randomBetween(min, max) { return min + Math.random() * (max - min); }
function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }

function bezierQuadratic(t, p0, p1, p2) {
  const omt = 1 - t;
  return omt * omt * p0 + 2 * omt * t * p1 + t * t * p2;
}

// 生成带轻微抖动的二次贝塞尔鼠标路径点
function generateBezierPath(fromX, fromY, toX, toY, steps = 30) {
  // 控制点偏向目标方向但带随机偏移，模拟人手“弧线 + 过冲/回正”
  const midX = (fromX + toX) / 2;
  const midY = (fromY + toY) / 2;
  const cpX = midX + randomBetween(-80, 80) + (toX - fromX) * randomBetween(-0.15, 0.15);
  const cpY = midY + randomBetween(-80, 80) + (toY - fromY) * randomBetween(-0.15, 0.15);
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let x = bezierQuadratic(t, fromX, cpX, toX) + randomBetween(-1.5, 1.5);
    let y = bezierQuadratic(t, fromY, cpY, toY) + randomBetween(-1.5, 1.5);
    // 终点前轻微“慢下来”模拟人手定位
    const ease = t < 0.85 ? 1 : (1 - t) / 0.15 * 0.6 + 0.4;
    points.push({ x: Math.round(x), y: Math.round(y), delay: Math.round(randomBetween(12, 22) * ease) });
  }
  return points;
}

async function getMousePos(page) {
  try {
    return await page.evaluate(() => ({
      x: window.__fpMouseX || 0,
      y: window.__fpMouseY || 0,
    }));
  } catch (e) { return { x: 0, y: 0 }; }
}

async function setMousePos(page, x, y) {
  try { await page.evaluate((xx, yy) => { window.__fpMouseX = xx; window.__fpMouseY = yy; }, x, y); } catch (e) {}
}

async function humanMove(page, targetX, targetY, options = {}) {
  const start = options.fromX !== undefined && options.fromY !== undefined
    ? { x: options.fromX, y: options.fromY }
    : await getMousePos(page);
  const steps = options.steps || 30;
  const path = generateBezierPath(start.x, start.y, targetX, targetY, steps);
  for (const pt of path) {
    // 5.9-E3.1：循环内每次 await 前检查页面是否仍存活，避免对已死 context 无限发送 CDP
    if (page && typeof page.isClosed === 'function' && page.isClosed()) {
      throw new Error('humanMove: 页面在移动过程中关闭（渲染进程崩溃）');
    }
    await page.mouse.move(pt.x, pt.y);
    await setMousePos(page, pt.x, pt.y);
    await sleep(pt.delay);
  }
}

async function humanClick(page, selector, options = {}) {
  if (page && typeof page.isClosed === 'function' && page.isClosed()) {
    throw new Error('humanClick: 页面已关闭，放弃点击 ' + selector);
  }
  const loc0 = page.locator ? page.locator(selector).first() : page.$(selector);
  let loc = loc0;
  const box0 = await (loc0.boundingBox ? loc0.boundingBox() : loc0.then((el) => el && el.boundingBox()));
  let box = box0;
  // C105 F14（真实站点实证 task_mtudaiwupwsmo）：重复 id 在真实站点极其常见，且**第一个实例
  // 往往是隐藏副本**（响应式站点的移动端/备选副本，w=0,h=0）。旧实现只取 .first() → box 为 null
  // → 误报 "element not found"，而该元素在页面上真实存在且可见。
  // 实证：联盟落地页 #continue-nav 共 4 个实例，首个 w=0（隐藏），两个可见实例（245×51 / 142×51）
  // 排在后面 —— 连续 18 次假性 ELEMENT_NOT_FOUND，恢复链反复 reload，最终升级人工。
  // 修复：首个实例无有效 box 时，按 DOM 顺序在其余匹配项中找第一个真实可见（有面积）的实例。
  // 边界：不改变「元素确实不存在」的语义 —— 全部实例都无 box 时仍照原样抛 not found。
  if (!box && page.locator) {
    try {
      const n = await page.locator(selector).count();
      for (let i = 1; i < n && !box; i++) {
        const cand = page.locator(selector).nth(i);
        const b = await cand.boundingBox({ timeout: 3000 }).catch(() => null);
        if (b && b.width > 0 && b.height > 0) { loc = cand; box = b; }
      }
    } catch (e) { /* 计数/遍历失败：保持原行为（不因诊断逻辑吞掉真实错误） */ }
  }
  if (!box) throw new Error('humanClick: element not found: ' + selector);
  // 点击元素内部一个非中心点（更自然），避开边缘
  const targetX = box.x + box.width * randomBetween(0.35, 0.65);
  const targetY = box.y + box.height * randomBetween(0.35, 0.65);
  await humanMove(page, targetX, targetY, options.moveOptions);
  // 悬停微颤 + 按下/抬起分离
  await sleep(randomBetween(60, 160));
  await page.mouse.down();
  await sleep(randomBetween(40, 110));
  await page.mouse.up();
  await sleep(randomBetween(20, 80));
}

async function humanType(page, selector, text, options = {}) {
  // 5.9-E3.1：循环型拟人输入设总时长上限，避免单次字符输入触发 CDP 僵死后永久 await。
  // 这是纯 JS 边界（能 throw），覆盖"慢调用但 event loop 可运行"场景；真冻结时无效，
  // 但配合 tools.js 的 withBrowserOp 上下文检测，可大幅降低悬挂概率。
  const _deadline = Date.now() + (Number(process.env.TOOL_OP_TIMEOUT_MS) || 25000);
  await humanClick(page, selector, options);
  // P3.2 replace-input 语义：humanType 契约是「输入目标值」（与 fill/locator.fill 的
  // replace 语义对齐），输入前先清空已有内容——Ctrl/Cmd+A 全选 + Backspace 删除，
  // 保持 human 层键盘路径不变。守卫：仅当聚焦元素确为可编辑输入元素时清空，
  // 避免聚焦意外落在非输入元素时 Ctrl+A 全选页面。对空输入框是幂等 no-op
  // （credential 注入路径的输入框通常为空，不受影响）。
  const activeTag = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return tag;
    if (el.isContentEditable) return 'contenteditable';
    return null;
  }).catch(() => null);
  if (activeTag) {
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
  }
  const baseDelay = options.baseDelay || 60;
  const randomDelay = options.randomDelay || 100;
  const mistakes = options.mistakes || 0; // 0 表示不模拟输错；1 表示可能输错一次再回退
  let pendingMistake = mistakes > 0 && Math.random() < 0.3;
  for (const char of String(text)) {
    if (Date.now() > _deadline) {
      throw new Error('humanType: 输入超过总时长上限（' + (Number(process.env.TOOL_OP_TIMEOUT_MS) || 25000) + 'ms），中止以避免悬挂');
    }
    if (page && typeof page.isClosed === 'function' && page.isClosed()) {
      throw new Error('humanType: 页面在输入过程中关闭（渲染进程崩溃）');
    }
    const delay = Math.round(baseDelay + Math.random() * randomDelay);
    // 极偶然：长停顿（模拟用户思考）
    const thinkPause = Math.random() < 0.05 ? randomBetween(250, 700) : 0;
    if (pendingMistake && /[a-zA-Z0-9]/.test(char)) {
      const wrong = String.fromCharCode((char.charCodeAt(0) % 26) + 65);
      await page.keyboard.type(wrong, { delay: Math.max(10, Math.round(delay * 0.6)) });
      await sleep(randomBetween(150, 300));
      await page.keyboard.press('Backspace');
      await sleep(randomBetween(120, 250));
      pendingMistake = false;
    }
    await page.keyboard.type(char, { delay });
    if (thinkPause > 0) await sleep(thinkPause);
  }
}

async function humanScroll(page, deltaY = 300, options = {}) {
  const steps = options.steps || 8;
  const chunk = Math.round(deltaY / steps);
  const _deadline = Date.now() + (Number(process.env.TOOL_OP_TIMEOUT_MS) || 25000);
  for (let i = 0; i < steps; i++) {
    if (Date.now() > _deadline) {
      throw new Error('humanScroll: 超过总时长上限，中止');
    }
    if (page && typeof page.isClosed === 'function' && page.isClosed()) {
      throw new Error('humanScroll: 页面在滚动过程中关闭');
    }
    await page.mouse.wheel(0, chunk + Math.round(randomBetween(-5, 5)));
    await sleep(randomBetween(40, 90));
  }
}

// 预热代理连接：新标签页的首次真实导航偶尔会失败（浏览器→代理的鉴权/握手连接未就绪，
// 表现为"无法访问此网站"，刷新一次即正常）。这里先用一个临时页面对代理发起几次真实导航，
// 建立并认证浏览器→代理的 keep-alive 连接，之后再关掉临时页。这样用户后续任意导航都能
// 复用已认证的代理连接，避免首次失败。
async function warmupProxyConnection(context, proxy) {
  if (!proxy || !proxy.server) return;
  const candidates = [
    'https://www.gstatic.com/generate_204',
    'https://1.1.1.1',
    'https://www.google.com',
  ];
  let wp = null;
  try {
    wp = await context.newPage();
    for (const url of candidates) {
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          await wp.goto(url, { timeout: 8000, waitUntil: 'domcontentloaded' });
          ok = true; // 能完成导航即说明浏览器→代理隧道已建立（含鉴权），无需关心目标站点返回码
        } catch (e) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (ok) break;
    }
  } catch (e) {
    // 预热失败不阻断启动，仅记录
    console.warn('[warmup] 代理预热失败(已忽略):', e.message);
  } finally {
    if (wp) { try { await wp.close(); } catch (e) {} }
  }
}

// C64 L1（B 类）：并发去重——launchPersistentContext 可能耗时数秒，老实现仅以
// sessions.has 判重，await 期间 sessions 尚未 set，同一 profile 的并发 launch
// （前端双击/自动化并发）会各自走完前段并撞同一 userDataDir（Chrome SingletonLock
// 冲突 / 双实例半启动 / profile 数据损坏）。in-flight Promise 表：同 profile 并发
// 调用共享同一次启动；完成/失败后移除（失败允许重试）。
const _launchInFlight = new Map();

async function launch(profile, proxies) {
  if (sessions.has(profile.id)) return sessions.get(profile.id);
  if (_launchInFlight.has(profile.id)) return _launchInFlight.get(profile.id);
  const p = _launchProfile(profile, proxies).finally(() => { _launchInFlight.delete(profile.id); });
  _launchInFlight.set(profile.id, p);
  return p;
}

async function _launchProfile(profile, proxies) {
  let shimServers = []; // C64 L2：声明提到 try 外——失败路径清理需要
  try {
  let proxy = profile.proxyInline && profile.proxyInline.server
    ? profile.proxyInline
    : (proxies ? proxies.find((x) => x.id === profile.proxyId) : null);

  // 启动前判定代理实际可用协议：优先用户所选（多为 socks5），若 SOCKS5 仅握手不转发则回退 http
  if (proxy && proxy.server) {
    try {
      const effectiveType = await resolveProxyType(proxy);
      proxy = { ...proxy, type: effectiveType };
    } catch (e) {
      // 判定全部失败：兜底用 http（多数住宅/HTTP 代理 http 可用），避免沿用可能不通的 socks5 启动 shim 导致浏览器直连
      proxy = { ...proxy, type: 'http' };
    }
  }

  // 本地代理中转 shim（解决 Chromium 对代理认证支持差 + 住宅代理 CONNECT 偶发失败/无重试的问题）
  // 出口 IP 检测通过 shim 走也能拿到真实上游出口，因此可以在 resolveLaunchIpGeo 之前起。
  if (proxy && proxy.server) {
    const type = (proxy.type || '').toLowerCase();
    if (type === 'socks5' && (proxy.username || proxy.password)) {
      // Chromium 不支持带认证的 SOCKS5，用本地无认证 SOCKS5 shim 中转
      const raw = String(proxy.server || '').replace(/^socks5:\/\//i, '');
      const [h, p] = raw.split(':');
      // 预先保存 rola 上游凭据（重赋值 proxy 为 shim 空凭据后不可再用）
      const rolaUser = proxy.username, rolaPass = proxy.password;
      const shim = await startShim({ host: h, port: p, username: rolaUser, password: rolaPass }, { hopProxy: GLOBAL_SOCKS5_HOP });
      shimServers.push(shim.server);
      proxy = { type: 'socks5', server: shim.endpoint, username: '', password: '' };

      // 出口 IP 信誉预检（非阻塞、best-effort，失败不影响启动）：
      // 检查 rola 出口是住宅(isp)还是机房(hosting)，以及 Google 是否真能握手。
      // 命中脏 IP 时仅报警提示，不改启动行为。
      const upstream = { host: h, port: Number(p), username: rolaUser, password: rolaPass };
      precheckProxy(upstream, GLOBAL_SOCKS5_HOP).then((r) => {
        if (!r.ok) {
          const why = [];
          if (r.type === 'hosting') why.push('出口为机房/数据中心 IP');
          if (r.google && !r.google.reachable) why.push('Google 不可达(' + (r.google.error || '?') + ')');
          else if (r.google && r.google.blocked) why.push('Google 被风控拦截');
          if (!r.ip) why.push('出口 IP 未知');
          console.warn(`[precheck] profile ${profile.id} 出口 ${r.ip || '?'} 类型=${r.type} 国家=${r.country || '?'} —— 建议换 country-xx：${why.join('；') || '异常'}`);
        }
      }).catch(() => {});
    } else if (type === 'http' || type === 'https') {
      // HTTP 代理：通过本地 shim 中转（上游经 v2ray hop，失败回退直连），失败自动重试 CONNECT
      const shim = await startHttpShim(
        { server: proxy.server, username: proxy.username, password: proxy.password },
        { hopProxy: GLOBAL_SOCKS5_HOP }
      );
      shimServers.push(shim.server);
      proxy = { type: 'http', server: shim.endpoint, username: '', password: '' };
    }
  }

  const override = { os: profile.os, browser: profile.browser, ...(profile.fingerprintOverride || {}) };
  const needsFreshIpGeo = profile.fingerprint?.randomFingerprint || override.timezoneMode === 'ip' || override.languageMode === 'ip' || override.geolocation?.mode === 'ip';
  const ipGeo = needsFreshIpGeo ? await resolveLaunchIpGeo(profile, proxy) : (profile.fingerprint?.ipGeo || null);
  const fp = generateFingerprint(seedFromProfile(profile), override, ipGeo);

  // 把伪造 UA 的 Chrome 版本对齐到本机真实引擎版本（含完整补丁/构建号），
  // 避免「UA 版本 ≠ 引擎版本」的次级标记，也避免写成 151.0.0.0 这种零补丁假版本被高级 Client Hints 校验抓到。
  const realVer = getChromeVersion();
  if (realVer && fp.userAgent && /Chrome\/\d+(\.\d+)*/.test(fp.userAgent)) {
    const before = fp.userAgent;
    fp.userAgent = fp.userAgent.replace(/Chrome\/\d+(\.\d+)*/, 'Chrome/' + realVer);
    if (before !== fp.userAgent) console.log(`[ua] 已将伪造 UA 版本对齐到引擎: ${before} -> ${fp.userAgent}`);
  } else if (fp.userAgent && /Chrome\/\d+(\.\d+)*/.test(fp.userAgent)) {
    // 一致性失守必须可见：不阻断启动，但每次都报警（防止再次出现「静默分裂」而无人察觉）
    console.warn(`[ua] 引擎版本未知（profile ${profile.id}）：UA 保持 ${fp.userAgent.match(/Chrome\/[\d.]+/)[0]}，未与 brands/identity 对齐`);
  }

  // Phase 16-B §9（Option B）：profile launch 时确保 profile-bound identity.json。
  // identity 派生自 UA 对齐后的最终 fp（与注入面一致）；首次落盘后幂等读回（同 profile 跨 launch 稳定，§20/S3）。
  // 校验失败 fail-fast 阻断启动（继承 identitySchema V1-V6 纪律，无 fallback）。
  // Native 侧（Gate A 后）从 <userDataDir>/identity.json 读取——两处同根已实证（data/profiles/）。
  const identity = ensureIdentity(profile.id, () => buildIdentity(seedFromProfile(profile), fp));
  console.log(`[identity] profile ${profile.id} -> ${identity.identity.identityId} (browserVersion ${identity.identity.browserVersion}, ${identity.created ? 'created' : 'existing'})`);

  // Profile Integrity：启动前内部一致性体检（只报警、不阻断启动，供开发期排查"脏 Profile"）
  try {
    const report = runIntegrityCheck(profile, { fp, engineVersion: realVer, proxies });
    logIntegrity(profile.id, report);
  } catch (e) {
    console.warn('[integrity] 体检执行异常(已忽略):', String(e.message || e).slice(0, 200));
  }

  const behavior = profile.launchBehavior || {};

  // 启动前缓存清理（三档，见 clearProfileCache 注释）：
  //  cacheClearMode: 'none'|'cache'|'full'；兼容旧布尔开关 clearCacheOnLaunch=true 视为 'full'（原行为）。
  const cacheClearMode = behavior.cacheClearMode || (behavior.clearCacheOnLaunch === true ? 'full' : 'none');
  if (cacheClearMode !== 'none') {
    const cleared = await clearProfileCache(profile.id, cacheClearMode, { clearCookies: behavior.clearCookies === true });
    if (cleared.length) console.log(`[cache] profile ${profile.id} 已清理(${cacheClearMode}): ${cleared.join(', ')}`);
  }

  const userDataDir = profileDataDir(profile.id);

  // C7-CONFIG：Worker/pref 链 Accept-Language 注入（必须在 launch 前；见函数注释）
  injectAcceptLanguagesPref(userDataDir, fp.languages);

  // ---- 分辨率策略 ----
  // adsPower 模式：headful 下默认「真实最大化分辨率」——把窗口最大化到本机真实显示器，
  // 并把指纹 screen 写成真实显示器尺寸，使 screen / outerWidth / innerWidth / devicePixelRatio
  // 全部一致（规避「innerWidth > screen.width」这类伪造破绽；也避免随机分辨率比显示器大导致
  // 窗口被裁切、点最大化没反应的"只显示一小部分"问题）。
  // 仅当用户显式配置 fingerprintOverride.screen（自定义分辨率）时，才按自定义尺寸开窗口。
  const isHeadful = profile.headless === false;
  const customScreen = (override.screen && override.screen.width && override.screen.height) ? override.screen : null;
  // CAP hidden-headful（STEP 20）：launchBehavior.hiddenWindow=true = 有界面但窗口移出屏幕——
  // UA/Worker/UA-CH 全部为真实 Chrome（无 HeadlessChrome 痕迹，addInitScript 不可达的 Worker 层天然一致），
  // 兼顾反检测与无头式自动化。隐藏窗口与「真实最大化分辨率」互斥（off-screen 窗口无法最大化）。
  const hiddenWindow = isHeadful && behavior.hiddenWindow === true;
  const useRealScreen = isHeadful && !customScreen && !hiddenWindow;

  const geo = fp.geolocation;
  // Phase 16-B C2（platformversion-identity）：Native platformVersion opt-in。
  // switch 携带 identity 值（identity.osVersion，schema V4 校验格式）；identity 缺失时
  // 发裸开关 = Native value_or fallback 语义（原生 GetPlatformVersion()）。
  // C2 inactive（manifest 未激活或非 native 二进制）：不注入任何 fp-* switch = stock。
  const launchArgs = buildArgs(profile);
  if (isC2PlatformVersionActive()) {
    const identityPv = identity.identity.osVersion;
    launchArgs.push(identityPv ? '--fp-platform-version=' + identityPv : '--fp-platform-version');
    console.log('[fp16b] C2 platformVersion -> Native (switch=' + (identityPv ? 'identity:' + identityPv : 'bare/fallback') + ')');
  }
  // Phase 16-B C3（navigator-identity）：Native navigator.platform opt-in。
  // switch 携带 identity 值（identity.cpuProfile.platform，Win32/MacIntel 等纯
  // ASCII 词表）；identity 缺失时发裸开关 = Native value_or fallback 语义（原生
  // GetReducedNavigatorPlatform()）。非 ASCII 值由 patch 侧逐字符校验 fail-open
  // 回 stock（WTF::String latin1 构造语义防误读）。C3 inactive：不注入 = stock。
  if (isC3PlatformActive()) {
    const identityPlatform = identity.identity.cpuProfile.platform;
    launchArgs.push(identityPlatform ? '--fp-platform=' + identityPlatform : '--fp-platform');
    console.log('[fp16b] C3 navigator.platform -> Native (switch=' + (identityPlatform ? 'identity:' + identityPlatform : 'bare/fallback') + ')');
  }
  // Phase 16-B C4（hardwareConcurrency-identity）：Native navigator.hardwareConcurrency
  // opt-in。switch 携带 identity 值（identity.cpuProfile.hardwareConcurrency，严格十进制
  // [1,1024] 由 patch 侧校验，bare/invalid fail-open 回 stock SysInfo 值）；identity 缺失
  // 时发裸开关 = Native value_or fallback 语义。CDP 显式 override（Emulation.
  // setHardwareConcurrencyOverride）在 patch 插入点之后生效 = 显式 CDP 仍获胜。
  // C4 inactive：不注入 = stock。
  if (isC4HardwareConcurrencyActive()) {
    const identityHc = identity.identity.cpuProfile.hardwareConcurrency;
    launchArgs.push(identityHc ? '--fp-hardware-concurrency=' + identityHc : '--fp-hardware-concurrency');
    console.log('[fp16b] C4 navigator.hardwareConcurrency -> Native (switch=' + (identityHc ? 'identity:' + identityHc : 'bare/fallback') + ')');
  }
  // Phase 16-B C5（deviceMemory-identity）：Native navigator.deviceMemory opt-in。
  // switch 携带 identity 值（identity.memoryProfile.deviceMemoryGB）；patch 侧白名单 =
  // Chromium 真实输出域 {1,2,4,8,16,32} 精确 token（ApproximatedDeviceMemory 实际
  // clamp 桌面 [2,32]/Android [1,8]，crbug 454354290），其余 fail-open 回 stock。
  // data.js 池 [4,8,8,16,16,32] 全部在真实域内（与白名单一致，I2 断言固化）。
  // C5 inactive：不注入 = stock。
  if (isC5DeviceMemoryActive()) {
    const identityDm = identity.identity.memoryProfile.deviceMemoryGB;
    if ([1, 2, 4, 8, 16, 32].includes(identityDm)) {
      launchArgs.push('--fp-device-memory=' + identityDm);
      console.log('[fp16b] C5 navigator.deviceMemory -> Native (switch=identity:' + identityDm + ')');
    } else {
      console.log('[fp16b] C5 navigator.deviceMemory -> out-of-domain identity value (' + identityDm + ') NOT injected; Native stays stock (real domain {1,2,4,8,16,32})');
    }
  }
  // Phase 16-B C6（maxTouchPoints-identity）：Native navigator.maxTouchPoints opt-in。
  // switch 携带 identity 派生值（fp.os 同源：Android/iOS=5，桌面=0 —— 与 inject.js
  // JS 层现行规则逐字节一致，JS→Native 迁移零值漂移，零 schema/池变更）；patch 侧
  // 白名单 = 真实输出域 {0,5,10}（Windows SM_MAXIMUMTOUCHES / 无数字化仪 0），
  // bare/越域 fail-open 回 stock Settings。C6 inactive：不注入 = stock。
  if (isC6MaxTouchPointsActive()) {
    const identityMt = (fp.os === 'Android' || fp.os === 'iOS') ? 5 : 0;
    launchArgs.push('--fp-max-touch-points=' + identityMt);
    console.log('[fp16b] C6 navigator.maxTouchPoints -> Native (switch=identity:' + identityMt + ')');
  }
  const launchOpts = {
    // 默认无头（配合网页"云查看"截图稳定）；仅当配置明确选"有界面"时才弹窗
    headless: isHeadful ? false : true,
    proxy: proxyToPlaywright(proxy),
    args: launchArgs,
    // FPB_NATIVE_CHROME：native patched 二进制选择（Phase 16-B POC 惯例 env，测试通道）；
    // 优先级高于系统 Chrome，未设置时行为与此前逐字节一致。
    executablePath: process.env.BENCH_PW_CHROMIUM ? undefined
      : (process.env.FPB_NATIVE_CHROME && fs.existsSync(process.env.FPB_NATIVE_CHROME)) ? process.env.FPB_NATIVE_CHROME
      : (fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined),
  };
  if (useRealScreen) {
    // viewport:null => Playwright 以「最大化窗口」启动；--start-maximized + --window-position 双保险
    launchOpts.viewport = null;
    launchOpts.args = launchOpts.args.concat(['--start-maximized', '--window-position=0,0']);
  } else {
    // 无头（截图用固定视口）或用户自定义分辨率：精确把窗口设为该尺寸（不最大化）
    const sw = customScreen ? customScreen.width : fp.screen.width;
    const sh = customScreen ? customScreen.height : fp.screen.height;
    launchOpts.viewport = { width: sw, height: sh };
    launchOpts.deviceScaleFactor = (customScreen && customScreen.pixelRatio) || fp.screen.pixelRatio;
    launchOpts.args = launchOpts.args.concat([`--window-size=${sw},${sh}`]);
  }
  Object.assign(launchOpts, {
    userAgent: fp.userAgent,
    // C10：locale option 已删除。它触发 browser 级 Browser.setLocaleOverride → network 层
    // Accept-Language 裸单值（XHR/fetch 管道竞态，c10_locale_probe.js 形态 A 实测）。
    // Intl 一致性由 sendIntlLocaleOverride（renderer 级 Emulation.setLocaleOverride）承担，
    // 形态 D 实证 Intl=fp.language 且 HTTP 全管道原生 q 形。
    timezoneId: fp.timezone,
    colorScheme: 'no-preference',
    // C7-CONFIG：不设置 extraHTTPHeaders.Accept-Language——HTTP Accept-Language 仅由
    // ① pref 链（intl.accept_languages，injectAcceptLanguagesPref 注入）与
    // ② CDP override（browser 侧 EmulationHandler::ApplyOverrides →
    //    GenerateAcceptLanguageHeader 原生生成 q）驱动。
    // 实测（.benchmark/c7_worker_probe3.js V11/V12）：Playwright locale 派生头在
    // navigation 上优先于 extraHTTPHeaders，保留第三写只会造成 subresource 头
    // 三态分裂（locale 裸单值 / 无 q 列表 / 原生 q）；删除后收敛为两写。
    geolocation: geo && geo.mode !== 'real' && geo.mode !== 'block'
      ? { latitude: geo.lat, longitude: geo.lng, accuracy: geo.accuracy }
      : undefined,
    permissions: geo && geo.mode !== 'block' ? ['geolocation'] : [],
  });
  const context = await chromium.launchPersistentContext(userDataDir, launchOpts);

  // 持久化上下文可能自动恢复上次页面
  let page = context.pages()[0];
  if (!page) page = await context.newPage();

  // 真实分辨率探测（仅 headful + 真实模式）：窗口已最大化，读取显示器真实尺寸回填 fp.screen，
  // 使注入的 screen / outerWidth / devicePixelRatio 与真实窗口完全一致，规避伪造破绽。
  if (useRealScreen) {
    try {
      const real = await page.evaluate(() => ({
        w: window.screen.width,
        h: window.screen.height,
        aw: window.screen.availWidth,
        ah: window.screen.availHeight,
        dpr: window.devicePixelRatio || 1,
      }));
      fp.screen = { width: real.w, height: real.h, availWidth: real.aw, availHeight: real.ah, pixelRatio: real.dpr };
      console.log(`[screen] 已采用真实最大化分辨率: ${real.w}x${real.h} @ ${real.dpr}x（与窗口一致，规避 innerWidth>screen.width 破绽）`);
    } catch (e) {
      console.warn('[screen] 真实分辨率探测失败，回退指纹随机值:', e.message);
    }
  }

  // P4.2：native UA-CH brands 捕获——必须在 addInitScript 之前（捕获页未被注入 = 纯原生值）。
  // 捕获结果施加既有 HeadlessChrome 契约后写入 fp._uaBrands / fp._uaFullVersionList，
  // 供 inject.js（JS 层）与 applyClientHints（HTTP 层）同源消费。
  try {
    const nativeUa = await captureNativeUaBrands(
      context,
      (launchOpts.executablePath || 'bundled') + '|' + (realVer || '') + '|' + (launchOpts.headless ? 'h' : 'f')
    );
    if (nativeUa && Array.isArray(nativeUa.brands) && nativeUa.brands.length) {
      fp._uaBrands = applyHeadlessBrandContract(nativeUa.brands);
      fp._uaFullVersionList = nativeUa.fullVersionList ? applyHeadlessBrandContract(nativeUa.fullVersionList) : null;
      console.log('[ua] native brands 已捕获: ' + fp._uaBrands.map((b) => b.brand + '@' + b.version).join(', '));
    }
  } catch (e) {}

  // 注入指纹 JS（覆盖 canvas/webgl/audio/webrtc/navigator 等）；使用最终 fp.screen
  // Phase 16-B：ownership 基线随 fp 注入（fp._nativeOwned = NATIVE_OWNED surface 列表），
  // inject.js 内 NATIVE_OWNED_SET 消费 → JS hook 自动让位；基线空集时行为逐字节等价。
  fp._nativeOwned = nativeOwnership.nativeOwnedSurfaces();
  await context.addInitScript(buildInjectionScript(fp));

  // 初始 about:blank 页在 addInitScript 之前已存在，重新导航一次使其获得注入
  if (page.url() === 'about:blank' || page.url() === '') {
    try { await page.goto('about:blank', { timeout: 5000 }); } catch (e) {}
  }

  // 对齐网络层 Client Hints（Sec-CH-UA 等）与 JS 层 navigator 属性，避免被 Google 判定自动化
  await applyClientHints(page, fp);

  // 对所有页面及后续新页面设置拦截
  for (const p of context.pages()) await setupRoutes(p, behavior);
  context.on('page', (p) => {
    setupRoutes(p, behavior);
    applyClientHints(p, fp);
    // 多页/标签页追踪：弹窗新页面自动加入 session.pages 并成为当前激活页（getPage 返回它）
    const s = sessions.get(profile.id);
    if (s && Array.isArray(s.pages)) {
      s.pages.push(p);
      s.activePageIndex = s.pages.length - 1;
      s.page = p;
    }
  });

  // 稳定性守护：渲染进程崩溃 / context 断开时记录并自愈，避免「窗口自己消失」无提示
  const guardPage = (p) => {
    try {
      p.on('crash', () => {
        console.warn(`[stability] 渲染进程崩溃: profile=${profile.id} url=${p.url() || ''}（弱网/资源加载压力下易触发，Playwright 会自动重建渲染进程）`);
      });
    } catch (e) {}
  };
  for (const p of context.pages()) guardPage(p);
  context.on('page', (p) => guardPage(p));
  context.on('close', () => {
    console.warn(`[stability] context 关闭: profile=${profile.id}`);
  });
  // 可控对话框处理：不再盲目 dismiss 所有 dialog。先把 dialog 暂存到 session._pendingDialogs，
  // 交给 tools.js 的 dialog 动作（acceptDialog / dismissDialog）在窗口内消费；若窗口内无人处理
  // （默认 8s，可用 DIALOG_AUTO_DISMISS_MS 覆盖），自动 dismiss 兜底，避免 Playwright 未处理
  // 对话框引发 unhandledRejection（协议错误拖垮整个服务）。
  context.on('dialog', (dialog) => {
    const s = sessions.get(profile.id);
    if (!s) { dialog.dismiss().catch(() => {}); return; }
    if (!Array.isArray(s._pendingDialogs)) s._pendingDialogs = [];
    const info = {
      dialog,
      type: dialog.type(),
      message: dialog.message(),
      page: (typeof dialog.page === 'function') ? dialog.page() : null,
      _timer: null,
    };
    s._pendingDialogs.push(info);
    info._timer = setTimeout(() => {
      const idx = s._pendingDialogs ? s._pendingDialogs.indexOf(info) : -1;
      if (idx >= 0) {
        s._pendingDialogs.splice(idx, 1);
        info.dialog.dismiss().catch(() => {});
        console.warn('[dialog] 无人处理的对话框已自动 dismiss（避免 unhandledRejection）: ' + info.message);
      }
    }, Number(process.env.DIALOG_AUTO_DISMISS_MS) || 8000);
  });
  context.on('disconnected', () => {
    console.warn(`[stability] 浏览器进程断开(可能崩溃): profile=${profile.id} —— 若前端显示退出，多为 Chromium 进程异常退出，需排查内存/GPU`);
    // Phase 5.8 防御（Finding #1 家族）：断开即标记会话失效并移出 sessions，
    // 避免 runtime 复用已死的 context 反复失败却无法自愈；下次 ensureBrowser 会 relaunch。
    try { sessions.delete(profile.id); } catch (e) {}
  });

  // 预热代理连接：建立并认证浏览器→代理的 keep-alive 连接，避免新建标签页首次导航失败
  await warmupProxyConnection(context, proxy);

  // 内置欢迎页：启动后默认打开，直观确认浏览器已活 + 展示指纹概要
  const welcomeIp = (ipGeo && ipGeo.ip)
    ? ipGeo.ip
    : (proxy && proxy.server ? '代理模式（未解析地理，启动前已校验）' : '直连');
  const welcomeHtml = `<!doctype html><html><head><meta charset="utf-8"><title>指纹浏览器已启动</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1e293b;padding:30px 38px;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.45);max-width:600px;width:90%}
h1{margin:0 0 18px;font-size:22px;color:#38bdf8}
.row{display:flex;justify-content:space-between;gap:16px;padding:7px 0;border-bottom:1px solid #334155;font-size:14px}
.k{color:#94a3b8;white-space:nowrap}.v{color:#e2e8f0;font-weight:600;text-align:right;word-break:break-all}
.tip{margin-top:18px;font-size:12px;color:#64748b;line-height:1.6}</style></head>
<body><div class="card"><h1>✅ 指纹浏览器已启动</h1>
<div class="row"><span class="k">出口 IP</span><span class="v">${welcomeIp}</span></div>
<div class="row"><span class="k">时区</span><span class="v">${fp.timezone}</span></div>
<div class="row"><span class="k">语言</span><span class="v">${fp.language}</span></div>
<div class="row"><span class="k">UA</span><span class="v">${fp.userAgent}</span></div>
<div class="row"><span class="k">分辨率</span><span class="v">${fp.screen.width}x${fp.screen.height} @ ${fp.screen.pixelRatio}x</span></div>
<div class="row"><span class="k">WebRTC</span><span class="v">${fp.webRtc}</span></div>
<div class="tip">在地址栏输入任意网址即可开始浏览。窗口由本机 Chromium 独立弹出（不是网页内嵌）。如未看到窗口，请检查是否被最小化或在其他桌面。</div>
</div></body></html>`;
  const welcomeUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(welcomeHtml);

  // 决定启动 URL
  const startupUrls = Array.isArray(profile.startupUrls) ? profile.startupUrls.filter(Boolean) : [];
  const restoreUrls = behavior.restoreLastSession && Array.isArray(profile.lastSessionUrls) ? profile.lastSessionUrls.filter(Boolean) : [];
  let urlsToOpen = restoreUrls.length ? restoreUrls : startupUrls;
  if (!urlsToOpen.length) urlsToOpen = [welcomeUrl];

  {
    await page.goto(urlsToOpen[0], { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
    for (let i = 1; i < urlsToOpen.length; i++) {
      const p2 = await context.newPage();
      await setupRoutes(p2, behavior);
      p2.goto(urlsToOpen[i], { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  // 获取 Chrome 主进程 PID（用于关闭时强杀残留进程树）
  let chromePid = null;
  try {
    // 方式1：Playwright 私有 API（launch 返回 Browser 时有效）
    const browser = context._browser || (context._browserContext && context._browserContext._browser);
    if (browser && browser._process) chromePid = browser._process.pid;
  } catch (e) {}
  // 方式2：launchPersistentContext 下 context._browser 为 undefined，反查 user-data-dir 关联的 chrome PID
  if (!chromePid) {
    try {
      const dir = profileDataDir(profile.id);
      // chrome 子进程可能需要几百毫秒才注册到 WMI，重试 3 次
      for (let i = 0; i < 3 && !chromePid; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 400));
        const pids = findChromePidsForDir(dir);
        if (pids.length) chromePid = pids[0]; // 取第一个（主进程）
      }
    } catch (e) {}
  }

  const session = { context, page, fp, proxy: proxy || null, profileId: profile.id, startedAt: Date.now(), shimServers, chromePid, pages: [page], activePageIndex: 0, behavior: behavior || {} };
  sessions.set(profile.id, session);
  return session;
  } catch (e) {
    // C64 L2（B 类）：启动失败（launchPersistentContext 抛错/代理检查失败等）必须
    // 关闭已创建的本地 shim server——close() 只覆盖成功路径，失败路径老实现无人
    // 关闭 → listen 句柄/端口随失败次数累积泄漏（进程无法优雅退出 + 端口耗尽）。
    for (const ss of shimServers) { try { ss.close(); } catch (_) {} }
    throw e;
  }
}

function getSession(profileId) {
  return sessions.get(profileId) || null;
}

function isRunning(profileId) {
  return sessions.has(profileId);
}

// C20：运行态快照 —— 每个运行中 Profile 的实时信息（UI「运行中」卡片的 uptime/当前页面/页签数/代理）。
// page.url() 等读操作全部 try 包裹：单会话异常不拖垮整个快照。
function runtimeSnapshots() {
  const out = [];
  for (const s of sessions.values()) {
    let currentUrl = null;
    try { currentUrl = s.page && s.page.url ? s.page.url() : null; } catch (e) { /* 页面正在销毁 */ }
    let pagesCount = 1;
    try { pagesCount = Array.isArray(s.pages) && s.pages.length ? s.pages.length : 1; } catch (e) { /* ignore */ }
    out.push({
      profileId: s.profileId,
      startedAt: s.startedAt,
      uptimeMs: Date.now() - (s.startedAt || Date.now()),
      currentUrl,
      pagesCount,
      proxyId: (s.proxy && s.proxy.id) || null,
      chromePid: s.chromePid || null,
    });
  }
  return out;
}

async function getPage(profileId) {
  const s = sessions.get(profileId);
  if (!s) return null;
  return s.page;
}

// ---------------- 多页 / 标签页管理 ----------------
// session.pages 保存全部已打开页面；session.page / activePageIndex 指向当前激活页。
// 弹窗（context.on('page')）已自动入列并成为激活页；下面 helper 供 tools.js 的 openTab/closeTab/switchTab 调用。

function findSessionForPage(page) {
  if (!page) return null;
  for (const s of sessions.values()) {
    if (s.page === page) return s;
    if (Array.isArray(s.pages) && s.pages.indexOf(page) >= 0) return s;
  }
  return null;
}

async function getPages(profileId) {
  const s = sessions.get(profileId);
  if (!s) return [];
  return (Array.isArray(s.pages) ? s.pages : [s.page]).filter(Boolean);
}

async function switchToPage(profileId, indexOrUrl) {
  const s = sessions.get(profileId);
  if (!s || !Array.isArray(s.pages) || !s.pages.length) return null;
  let idx = -1;
  if (typeof indexOrUrl === 'number') {
    idx = indexOrUrl >= 0 ? indexOrUrl : s.pages.length + indexOrUrl;
  } else if (typeof indexOrUrl === 'string' && indexOrUrl) {
    idx = s.pages.findIndex((p) => (p.url() || '').indexOf(indexOrUrl) >= 0);
  }
  if (idx < 0 || idx >= s.pages.length) return null;
  s.activePageIndex = idx;
  s.page = s.pages[idx];
  return s.pages[idx];
}

async function openPage(profileId, url) {
  const s = sessions.get(profileId);
  if (!s) return null;
  const p = await s.context.newPage();
  await setupRoutes(p, s.behavior || {}).catch(() => {});
  await applyClientHints(p, s.fp).catch(() => {});
  s.pages = Array.isArray(s.pages) ? s.pages : [s.page];
  s.pages.push(p);
  s.activePageIndex = s.pages.length - 1;
  s.page = p; // 新标签成为激活页
  if (url) { await p.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {}); }
  return p;
}

async function closePage(profileId, indexOrUrl) {
  const s = sessions.get(profileId);
  if (!s || !Array.isArray(s.pages) || !s.pages.length) return false;
  let idx = -1;
  if (typeof indexOrUrl === 'number') {
    idx = indexOrUrl >= 0 ? indexOrUrl : s.pages.length + indexOrUrl;
  } else if (typeof indexOrUrl === 'string' && indexOrUrl) {
    idx = s.pages.findIndex((p) => (p.url() || '').indexOf(indexOrUrl) >= 0);
  } else {
    idx = (typeof s.activePageIndex === 'number') ? s.activePageIndex : s.pages.length - 1;
  }
  if (idx < 0 || idx >= s.pages.length) return false;
  const p = s.pages[idx];
  s.pages.splice(idx, 1);
  if (typeof s.activePageIndex === 'number') {
    if (s.activePageIndex >= s.pages.length) s.activePageIndex = s.pages.length - 1;
    if (s.page === p) s.page = s.pages[Math.max(0, s.activePageIndex)] || null;
  }
  try { await p.close(); } catch (e) {}
  return true;
}

// ---------------- 可控对话框 ----------------
// 消费 session._pendingDialogs 中「属于该 page」的待处理 dialog（找不到则取第一个），
// 成功返回 { ok, type, message }；无人处理返回 { ok:false }。

async function acceptDialog(page, value) {
  const s = findSessionForPage(page);
  if (!s || !Array.isArray(s._pendingDialogs) || !s._pendingDialogs.length) return { ok: false, error: '没有待处理的对话框' };
  let idx = s._pendingDialogs.findIndex((d) => d.page === page);
  if (idx < 0) idx = 0;
  const info = s._pendingDialogs.splice(idx, 1)[0];
  if (info._timer) clearTimeout(info._timer);
  try {
    await info.dialog.accept(value);
    return { ok: true, type: info.type, message: info.message };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function dismissDialog(page) {
  const s = findSessionForPage(page);
  if (!s || !Array.isArray(s._pendingDialogs) || !s._pendingDialogs.length) return { ok: false, error: '没有待处理的对话框' };
  let idx = s._pendingDialogs.findIndex((d) => d.page === page);
  if (idx < 0) idx = 0;
  const info = s._pendingDialogs.splice(idx, 1)[0];
  if (info._timer) clearTimeout(info._timer);
  try {
    await info.dialog.dismiss();
    return { ok: true, type: info.type, message: info.message };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function close(profileId) {
  const s = sessions.get(profileId);
  if (!s) return;
  if (Array.isArray(s.shimServers)) { for (const ss of s.shimServers) { try { ss.close(); } catch (e) {} } }
  try {
    const urls = s.context.pages()
      .map((p) => p.url())
      .filter((u) => u && !u.startsWith('about:') && !u.startsWith('chrome://') && !u.startsWith('edge://') && !u.startsWith('chrome-error://'));
    if (urls.length) {
      const db = require('./db');
      const p = db.getProfile(profileId);
      if (p) {
        p.lastSessionUrls = urls;
        db.upsertProfile(p);
      }
    }
  } catch (e) {}

  // GC 清理注入：在 context.close() 之前向所有页面注入解绑脚本，
  // 将 inject.js 产生的闭包引用（噪声缓存、离屏 Canvas 等）置 null，加速 V8 回收。
  try {
    for (const p of s.context.pages()) {
      await p.evaluate(() => {
        try {
          if (window.__fpNoiseCache) window.__fpNoiseCache = null;
          if (window.__fpCanvasCache) window.__fpCanvasCache = null;
        } catch (e) {}
      }).catch(() => {});
    }
  } catch (e) {}

  try { await s.context.close(); } catch (e) {}

  // 强杀残留 Chrome 进程树：context.close() 偶发未完全杀死子进程（GPU/renderer/utility），
  // 用 taskkill /T 递归杀整棵树，防止僵尸进程累积撑爆内存。
  if (s.chromePid) {
    try {
      killPid(s.chromePid, true);
    } catch (e) {}
  }
  sessions.delete(profileId);
}

async function closeAll() {
  for (const id of [...sessions.keys()]) {
    await close(id).catch(() => {});
  }
}

// 当前页截图（base64），供网页控制台"云查看"使用
async function screenshot(profileId) {
  const s = sessions.get(profileId);
  if (!s) throw new Error('浏览器未运行');
  const page = s.page || s.context.pages()[0];
  if (!page) throw new Error('无可用页面');
  const buf = await page.screenshot({ encoding: 'binary', fullPage: false });
  return Buffer.from(buf).toString('base64');
}

// 让浏览器打开指定网址
async function navigate(profileId, url) {
  const s = sessions.get(profileId);
  if (!s) throw new Error('浏览器未运行');
  const page = s.page || s.context.pages()[0];
  if (!page) throw new Error('无可用页面');
  // 失败重试一次：偶发的代理首次建链失败，重试即可成功（与"刷新一次才正常"同因）
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      return true;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  const msg = (lastErr && lastErr.message) || '';
  console.warn('[navigate] 导航失败(已重试):', msg);
  const proxyErr = msg.includes('ERR_TUNNEL_CONNECTION_FAILED') || msg.includes('net::ERR_')
    ? '代理隧道建立失败：目标站(如 Google)可能拒绝了当前代理出口IP，建议更换代理出口或节点后重试。'
    : msg;
  throw new Error(proxyErr || '导航失败');
}

// ---- 僵尸进程强杀 ----
// STEP 0.5 §2.3：PID 必须是正整数才允许拼入系统命令，杜绝命令注入。
function killPid(pid, recursiveTree) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  const flags = recursiveTree ? '/F /T' : '/F';
  try {
    execSync('taskkill ' + flags + ' /PID ' + n + ' 2>nul', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (e) { return false; }
}

// 一次性列举系统全部 chrome.exe 进程（PID + CommandLine）。
// STEP 0.5 §2.3 安全语义保留：spawnSync 参数数组、不经 cmd.exe shell 解析；枚举结果只读。
// 性能关键（2026-08-30 修复）：无论有多少 profile 目录，进程枚举只做【一次】——
// 此前实现对每个 profile 目录各起一次 spawnSync('powershell')（数据目录增长到 1538 个时，
// 启动清理可同步阻塞小时级，事件循环完全冻结，HTTP 服务假死）。
function listChromeProcesses() {
  try {
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | ' +
      'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = ((r && r.stdout) || '').trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .map((p) => ({ pid: parseInt(p && p.ProcessId, 10), cl: String((p && p.CommandLine) || '') }))
      .filter((p) => Number.isInteger(p.pid) && p.pid > 0);
  } catch (e) { return []; }
}

// 查找与指定 profile data dir 关联的 chrome.exe PID 列表（基于一次性进程枚举）。
function findChromePidsForDir(dir) {
  try {
    const full = String(path.resolve(String(dir || ''))).toLowerCase();
    const name = path.basename(full);
    // STEP 0.5 §2.3：目录名（源自文件系统列举，间接受 profileId 影响）必须先过白名单
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return [];
    return listChromeProcesses()
      .filter((p) => p.cl.toLowerCase().replace(/\//g, '\\').includes(full))
      .map((p) => p.pid);
  } catch (e) { return []; }
}

// 强杀「命令行指向孤儿 profile data dir」的 chrome 进程（服务启动清理与定时扫描共用）。
// 只做一次进程枚举 + Node 侧路径匹配；沙箱/无 powershell 环境 fail-open（枚举为空 → 不杀）。
function killOrphanChromium() {
  try {
    const profilesDir = PROFILES_ROOT; // C46：随 FPB_DATA_DIR 隔离，不再重复硬编码
    if (!fs.existsSync(profilesDir)) return;
    let dirs = [];
    try { dirs = fs.readdirSync(profilesDir).filter((d) => { try { return fs.statSync(path.join(profilesDir, d)).isDirectory(); } catch (e) { return false; } }); } catch (e) {}
    const orphanDirs = dirs.filter((d) => !sessions.has(d)); // 活跃 session 跳过
    if (!orphanDirs.size) return;
    // 目录名白名单（STEP 0.5 §2.3）：仅匹配合法 profileId 形态的目录
    const wanted = orphanDirs
      .filter((d) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(d))
      .map((d) => path.join(profilesDir, d).toLowerCase());
    if (!wanted.length) return;
    const procs = listChromeProcesses();
    for (const p of procs) {
      const cl = p.cl.toLowerCase().replace(/\//g, '\\');
      if (wanted.some((full) => cl.includes(full))) {
        try {
          killPid(p.pid, false);
          console.warn('[zombie] 强杀孤儿 chrome PID', p.pid);
        } catch (e) {}
      }
    }
  } catch (e) {}
}

// 服务启动时清理：强杀所有残留 chrome 孤儿进程
// （防止上次崩溃后遗留的孤儿进程占用内存 / 占用 SingletonLock 导致重启失败）。
function cleanupOrphanedChromium() {
  killOrphanChromium();
}

// 定时僵尸进程扫描：对比活跃 session 数与系统 chrome 进程数，
// 发现命令行含 profile data dir 但已不在 sessions 中的孤儿进程即强杀。
let zombieTimer = null;
function startZombieKiller(intervalMs) {
  if (zombieTimer) clearInterval(zombieTimer);
  zombieTimer = setInterval(() => {
    try { killOrphanChromium(); } catch (e) {}
  }, intervalMs || 5 * 60 * 1000); // 默认 5 分钟
}

module.exports = {
  launch, getSession, isRunning, runtimeSnapshots, getPage, close, closeAll, screenshot, navigate,
  cleanupOrphanedChromium, startZombieKiller, setupRoutes, isVerificationHost,
  humanMove, humanClick, humanType, humanScroll,
  getChromeVersion, captureNativeUaBrands, applyHeadlessBrandContract,
  getPages, switchToPage, openPage, closePage, acceptDialog, dismissDialog,
  PROFILES_ROOT, // C46：暴露根路径供守护测试断言 FPB_DATA_DIR 隔离解析
};
