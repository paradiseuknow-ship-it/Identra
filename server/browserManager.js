'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { generateFingerprint, seedFromProfile } = require('./fp/generate');
const { buildInjectionScript } = require('./fp/inject');
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

function profileDataDir(profileId) {
  return path.join(__dirname, '..', 'data', 'profiles', profileId);
}

// 读取本机真实 Chrome 的完整版本号（如 151.0.7922.138），用于把伪造 UA 对齐到引擎实际版本，
// 使 UA 字符串 / Sec-CH-UA 请求头 / navigator.userAgentData 三者版本完全一致（与 adsPower 同款自然度）。
// 失败返回 null，此时沿用指纹池版本。返回完整版本（含补丁/构建号），避免 UA 写成 151.0.0.0 这种零补丁假版本。
function getChromeVersion() {
  if (!SYSTEM_CHROME || !fs.existsSync(SYSTEM_CHROME)) return null;
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Item '${SYSTEM_CHROME.replace(/'/g, "''")}').VersionInfo.ProductVersion"`,
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const m = (out || '').trim().match(/^(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

// 根据主语言生成带 q-factor 的 Accept-Language 头（如 de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7）
function buildAcceptLanguage(lang) {
  if (!lang) return null;
  const base = lang.split('-')[0];
  return `${lang},${base};q=0.9,en-US;q=0.8,en;q=0.7`;
}

// 通过 CDP Emulation.setUserAgentOverride 一次性对齐【网络层 Client Hints 请求头】与【JS 层 navigator 属性】。
// 这是关键：Playwright 的 userAgent 选项只改了 User-Agent 头，但 Sec-CH-UA / Sec-CH-UA-Platform /
// Sec-CH-UA-Mobile 等 Client Hints 头仍由 Chromium 按真实二进制版本自动生成，与伪造 UA 对不上。
// Google / Cloudflare / reCAPTCHA 会同时比对「请求头里的 Client Hints」与「JS 读到的 navigator.userAgentData」，
// 一旦版本/平台不一致即判定自动化 → 跳人机验证。CDP override 让两者完全一致（adsPower 同理）。
async function applyClientHints(page, fp) {
  if (!page || !fp || !fp.userAgent) return;
  try {
    const client = await page.context().newCDPSession(page);
    const uaVer = (function () {
      const p = fp.userAgent.split('Chrome/')[1];
      if (!p) return '120.0.0.0';
      return p.split(' ')[0] || '120.0.0.0';
    })();
    const majorVer = uaVer.split('.')[0];
    const osPlatform = (fp.os === 'Windows' ? 'Windows'
      : (fp.os === 'macOS' || fp.os === 'Mac') ? 'macOS'
      : fp.os === 'Linux' ? 'Linux'
      : fp.os === 'Android' ? 'Android'
      : fp.os === 'iOS' ? 'iOS' : 'Windows');
    const platformVersion = (fp.os === 'Windows' ? '10.0.0'
      : (fp.os === 'macOS' || fp.os === 'Mac') ? '14.0.0'
      : fp.os === 'Linux' ? '6.0.0'
      : '15.0.0');
    const brands = [
      { brand: 'Google Chrome', version: majorVer },
      { brand: 'Chromium', version: majorVer },
      { brand: 'Not?A_Brand', version: '24' },
    ];
    const fullVersionList = [
      { brand: 'Google Chrome', version: uaVer },
      { brand: 'Chromium', version: uaVer },
      { brand: 'Not?A_Brand', version: '24.0.0.0' },
    ];
    await client.send('Emulation.setUserAgentOverride', {
      userAgent: fp.userAgent,
      acceptLanguage: buildAcceptLanguage(fp.language),
      platform: osPlatform,
      userAgentMetadata: {
        brands,
        fullVersionList,
        platform: osPlatform,
        platformVersion,
        architecture: 'x86',
        bitness: '64',
        model: '',
        mobile: false,
        wow64: false,
      },
    });
    client.detach().catch(() => {});
    console.log(`[ua] Client Hints 已对齐: UA=${fp.userAgent} platform=${osPlatform} brandsVer=${majorVer}`);
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
    // 稳定性：禁用崩溃转储处理器与 GPU 进程，避免弱网下 GPU/崩溃进程异常导致整个 Chromium 瞬间退出
    '--disable-crashpad-handler',
    '--disable-breakpad',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--disable-software-rasterizer',
  ];
  const fp = profile.fingerprint || {};
  const behavior = profile.launchBehavior || {};

  if (fp.hardwareAcceleration === false) {
    args.push('--disable-gpu', '--disable-software-rasterizer');
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
  const loc = page.locator ? page.locator(selector).first() : page.$(selector);
  const box = await (loc.boundingBox ? loc.boundingBox() : loc.then((el) => el && el.boundingBox()));
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

async function launch(profile, proxies) {
  if (sessions.has(profile.id)) return sessions.get(profile.id);

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
  const shimServers = [];
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
  }

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

  // ---- 分辨率策略 ----
  // adsPower 模式：headful 下默认「真实最大化分辨率」——把窗口最大化到本机真实显示器，
  // 并把指纹 screen 写成真实显示器尺寸，使 screen / outerWidth / innerWidth / devicePixelRatio
  // 全部一致（规避「innerWidth > screen.width」这类伪造破绽；也避免随机分辨率比显示器大导致
  // 窗口被裁切、点最大化没反应的"只显示一小部分"问题）。
  // 仅当用户显式配置 fingerprintOverride.screen（自定义分辨率）时，才按自定义尺寸开窗口。
  const isHeadful = profile.headless === false;
  const customScreen = (override.screen && override.screen.width && override.screen.height) ? override.screen : null;
  const useRealScreen = isHeadful && !customScreen;

  const geo = fp.geolocation;
  const launchOpts = {
    // 默认无头（配合网页"云查看"截图稳定）；仅当配置明确选"有界面"时才弹窗
    headless: isHeadful ? false : true,
    proxy: proxyToPlaywright(proxy),
    args: buildArgs(profile),
    executablePath: process.env.BENCH_PW_CHROMIUM ? undefined : (fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined),
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
    locale: fp.language,
    timezoneId: fp.timezone,
    colorScheme: 'no-preference',
    extraHTTPHeaders: (() => {
      const al = buildAcceptLanguage(fp.language);
      return al ? { 'Accept-Language': al } : undefined;
    })(),
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

  // 注入指纹 JS（覆盖 canvas/webgl/audio/webrtc/navigator 等）；使用最终 fp.screen
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
}

function getSession(profileId) {
  return sessions.get(profileId) || null;
}

function isRunning(profileId) {
  return sessions.has(profileId);
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
      execSync('taskkill /F /T /PID ' + s.chromePid + ' 2>nul', { stdio: 'ignore', timeout: 5000 });
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
// 查找与指定 profile data dir 关联的 chrome.exe PID 列表（Windows PowerShell）。
function findChromePidsForDir(dir) {
  try {
    // PowerShell Get-CimInstance 获取 chrome 进程的 CommandLine + ProcessId，
    // 筛选命令行中包含目标 user-data-dir 路径的进程。
    const escaped = dir.replace(/'/g, "''").replace(/\\/g, '\\\\');
    const cmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Where-Object { $_.CommandLine -like \\"*' + escaped + '*\\" } | Select-Object -ExpandProperty ProcessId"';
    const out = execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  } catch (e) { return []; }
}

// 服务启动时清理：扫描所有 profile data dir，强杀关联的残留 chrome 进程
// （防止上次崩溃后遗留的孤儿进程占用内存 / 占用 SingletonLock 导致重启失败）。
function cleanupOrphanedChromium() {
  try {
    const profilesDir = path.join(__dirname, '..', 'data', 'profiles');
    if (!fs.existsSync(profilesDir)) return;
    let dirs = [];
    try { dirs = fs.readdirSync(profilesDir).filter(d => fs.statSync(path.join(profilesDir, d)).isDirectory()); } catch (e) {}
    for (const dir of dirs) {
      if (sessions.has(dir)) continue; // 活跃 session，跳过
      const fullDir = path.join(profilesDir, dir);
      const pids = findChromePidsForDir(fullDir);
      for (const pid of pids) {
        try {
          execSync('taskkill /F /PID ' + pid + ' 2>nul', { stdio: 'ignore', timeout: 5000 });
          console.warn('[zombie] 启动清理：强杀残留 chrome PID', pid, '(profile', dir + ')');
        } catch (e) {}
      }
    }
  } catch (e) {}
}

// 定时僵尸进程扫描：对比活跃 session 数与系统 chrome 进程数，
// 发现命令行含 profile data dir 但已不在 sessions 中的孤儿进程即强杀。
let zombieTimer = null;
function startZombieKiller(intervalMs) {
  if (zombieTimer) clearInterval(zombieTimer);
  zombieTimer = setInterval(() => {
    try {
      const profilesDir = path.join(__dirname, '..', 'data', 'profiles');
      if (!fs.existsSync(profilesDir)) return;
      let dirs = [];
      try { dirs = fs.readdirSync(profilesDir).filter(d => fs.statSync(path.join(profilesDir, d)).isDirectory()); } catch (e) {}
      for (const dir of dirs) {
        if (sessions.has(dir)) continue; // 活跃，跳过
        const fullDir = path.join(profilesDir, dir);
        const pids = findChromePidsForDir(fullDir);
        for (const pid of pids) {
          try {
            execSync('taskkill /F /PID ' + pid + ' 2>nul', { stdio: 'ignore', timeout: 5000 });
            console.warn('[zombie] 定时扫描：强杀孤儿 chrome PID', pid, '(profile', dir + ')');
          } catch (e) {}
        }
      }
    } catch (e) {}
  }, intervalMs || 5 * 60 * 1000); // 默认 5 分钟
}

module.exports = {
  launch, getSession, isRunning, getPage, close, closeAll, screenshot, navigate,
  cleanupOrphanedChromium, startZombieKiller, setupRoutes, isVerificationHost,
  humanMove, humanClick, humanType, humanScroll,
  getChromeVersion,
  getPages, switchToPage, openPage, closePage, acceptDialog, dismissDialog,
};
