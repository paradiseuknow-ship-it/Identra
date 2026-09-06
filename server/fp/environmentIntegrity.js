'use strict';

// Phase 14.3 — Environment Integrity（环境内部一致性）
//
// 边界（Phase 14 规格 §四）：只判断「系统内部声明的环境参数是否彼此一致」。
//   ✅ UA ↔ engine / UA ↔ Client Hints / platform ↔ OS / mobile ↔ platform /
//      browser version ↔ engine version / network 配置 ↔ 观测数据（记录性）
//   ❌ 绝不判断「这个 IP 像不像真人」「能否通过 WAF」「Stripe 风险分高低」
//      —— 这些是系统不可可靠知道的第三方内部评分，做了就是 D 类伪装。
//
// 输出：{ status: PASS|WARN|FAIL, checks: [{name, status, detail?}], reasons: [] }
// 单项 check 状态：PASS / WARN / FAIL / UNKNOWN（数据不足 → UNKNOWN，不计入 WARN/FAIL）

// UA token ↔ platform 映射（桌面/移动主流组合）
const UA_PLATFORM_RULES = [
  { os: 'Windows', uaRe: /Windows NT/, platforms: ['Win32', 'Win64'] },
  { os: 'macOS', uaRe: /Macintosh/, platforms: ['MacIntel'] },
  { os: 'Linux', uaRe: /Linux/, platforms: ['Linux x86_64', 'Linux i686', 'Linux armv81', 'Linux aarch64'] },
  { os: 'Android', uaRe: /Android/, platforms: ['Linux armv81', 'Linux aarch64', 'Android'] },
  { os: 'iOS', uaRe: /iPhone|iPad/, platforms: ['iPhone', 'iPad', 'MacIntel'] },
];

function checkUaPlatform(browser) {
  const ua = String(browser.userAgent || '');
  const platform = browser.platform;
  if (!ua || !platform) return { name: 'ua_platform', status: 'UNKNOWN', detail: 'missing UA or platform' };
  const rule = UA_PLATFORM_RULES.find((r) => r.uaRe.test(ua));
  if (!rule) return { name: 'ua_platform', status: 'UNKNOWN', detail: 'UA 不匹配任何已知 OS 模板' };
  const ok = rule.platforms.includes(platform);
  // iOS iPad 桌面模式会报 MacIntel，属合法形态 → WARN 级
  const severity = (rule.os === 'iOS' && platform === 'MacIntel') ? 'WARN' : (ok ? 'PASS' : 'FAIL');
  return {
    name: 'ua_platform',
    status: severity,
    detail: ok || severity === 'WARN'
      ? `UA→${rule.os} ↔ platform=${platform}`
      : `UA 指向 ${rule.os} 但 platform=${platform}（期望 ${rule.platforms.join('/')}）`,
  };
}

function checkUaClientHints(snap) {
  const ua = String(snap.browser.userAgent || '');
  const brands = snap.clientHints.brands;
  if (!ua || !Array.isArray(brands) || !brands.length) {
    return { name: 'ua_clienthints', status: 'UNKNOWN', detail: '缺少 UA 或 brands（Safari 无 CH 属合法 UNKNOWN）' };
  }
  const brandNames = brands.map((b) => String(b.brand).toLowerCase()).join(' ');
  const isChromeUa = /Chrome\//.test(ua);
  const isEdgeUa = /Edg\//.test(ua);
  const hasChrome = brandNames.includes('chrom');
  const edgeBrand = brands.some((b) => /^microsoft edge$/i.test(String(b.brand).trim()));
  // Edge 家族双向校验：UA 是 Edge 但 brands 无 Edge → FAIL；UA 非 Edge 但 brands 有 Edge → FAIL
  if (isEdgeUa && !edgeBrand) return { name: 'ua_clienthints', status: 'FAIL', detail: 'Edge UA 但 brands 缺 Microsoft Edge 项' };
  if (!isEdgeUa && edgeBrand) return { name: 'ua_clienthints', status: 'FAIL', detail: `UA 非 Edge 却携带 Edge brands: ${brandNames.slice(0, 60)}` };
  if (isEdgeUa && edgeBrand && hasChrome) return { name: 'ua_clienthints', status: 'PASS', detail: 'Edge UA ↔ Edge+Chromium brands' };
  if (isChromeUa && hasChrome) return { name: 'ua_clienthints', status: 'PASS', detail: 'Chrome UA ↔ Chromium brands' };
  if (!isChromeUa && !isEdgeUa) {
    // 非 Chromium UA（如 Safari）不应有 Chromium brands
    if (hasChrome) return { name: 'ua_clienthints', status: 'FAIL', detail: `非 Chromium UA 却携带 Chromium brands: ${brandNames.slice(0, 60)}` };
    return { name: 'ua_clienthints', status: 'UNKNOWN', detail: '非 Chromium UA，无 CH 可比' };
  }
  return { name: 'ua_clienthints', status: 'FAIL', detail: `UA 与 brands 家族不一致（UA=${ua.slice(0, 60)} brands=${brandNames.slice(0, 60)}）` };
}

function checkUaVersionBrands(snap) {
  const ua = String(snap.browser.userAgent || '');
  const brands = snap.clientHints.brands;
  const m = ua.match(/(?:Chrome|Edg)\/(\d+)\./);
  if (!m || !Array.isArray(brands) || !brands.length) {
    return { name: 'ua_version_brands', status: 'UNKNOWN', detail: '缺少可提取的版本号' };
  }
  const uaMajor = m[1];
  const vBrand = brands.find((b) => /chrom/i.test(String(b.brand)) && !/chromium/i.test(String(b.brand)))
    || brands.find((b) => /chrom/i.test(String(b.brand)));
  if (!vBrand) return { name: 'ua_version_brands', status: 'UNKNOWN', detail: 'brands 无 Chromium 项' };
  const brandMajor = String(vBrand.version || '').split('.')[0];
  if (brandMajor === uaMajor) return { name: 'ua_version_brands', status: 'PASS', detail: `major=${uaMajor} 双侧一致` };
  return { name: 'ua_version_brands', status: 'FAIL', detail: `UA major=${uaMajor} ↔ brands major=${brandMajor} 不一致` };
}

function checkMobilePlatform(snap) {
  const mobile = snap.browser.mobile;
  const ua = String(snap.browser.userAgent || '');
  if (typeof mobile !== 'boolean' || !ua) return { name: 'mobile_platform', status: 'UNKNOWN', detail: '缺少 mobile 或 UA' };
  const isMobileUa = /Mobi|Android|iPhone/.test(ua);
  if (mobile === isMobileUa) return { name: 'mobile_platform', status: 'PASS', detail: `mobile=${mobile} ↔ UA 形态一致` };
  return { name: 'mobile_platform', status: 'FAIL', detail: `mobile=${mobile} 但 UA ${isMobileUa ? '是' : '不是'}移动形态` };
}

function checkEngineVersion(snap) {
  const ev = snap.browser.engineVersion;
  const bv = snap.browser.browserVersion;
  if (!ev || !bv) return { name: 'browser_engine_version', status: 'UNKNOWN', detail: '缺少 engine/browser 版本' };
  const eMajor = String(ev).split('.')[0];
  const bMajor = String(bv).split('.')[0];
  if (eMajor === bMajor) return { name: 'browser_engine_version', status: 'PASS', detail: `engine ${eMajor} ↔ browser ${bMajor}` };
  return { name: 'browser_engine_version', status: 'WARN', detail: `engine major=${eMajor} ↔ browser major=${bMajor} 不一致（可能是引擎后修版本）` };
}

function checkChPlatformOs(snap) {
  const chPlatform = snap.clientHints.platform;
  const ua = String(snap.browser.userAgent || '');
  if (!chPlatform || !ua) return { name: 'ch_platform_os', status: 'UNKNOWN', detail: '缺少 CH platform 或 UA' };
  const rule = UA_PLATFORM_RULES.find((r) => r.uaRe.test(ua));
  if (!rule) return { name: 'ch_platform_os', status: 'UNKNOWN', detail: 'UA 不匹配已知 OS' };
  const chLower = String(chPlatform).toLowerCase();
  const osLower = rule.os.toLowerCase();
  if (chLower === osLower) return { name: 'ch_platform_os', status: 'PASS', detail: `CH platform=${chPlatform} ↔ UA OS=${rule.os}` };
  return { name: 'ch_platform_os', status: 'FAIL', detail: `CH platform=${chPlatform} ↔ UA OS=${rule.os} 不一致` };
}

function checkNetworkObservational(snap) {
  // 记录性检查：不做真伪判定（「IP 是否可信」属第三方内部评分，禁止）
  const n = snap.network;
  if (n.proxyConfigured && !n.ip) {
    return { name: 'network_observed', status: 'WARN', detail: '已配置代理但无观测出口数据（ip/country 缺失）' };
  }
  return { name: 'network_observed', status: 'PASS', detail: `proxyConfigured=${n.proxyConfigured}${n.ip ? ', observed=' + n.ip : ''}` };
}

function checkEnvironmentIntegrity(snap) {
  const checks = [];
  if (!snap || typeof snap !== 'object') {
    return { status: 'FAIL', checks: [{ name: 'snapshot', status: 'FAIL', detail: 'snapshot 缺失或非法' }], reasons: ['snapshot 缺失或非法'] };
  }
  checks.push(checkUaPlatform(snap.browser || {}));
  checks.push(checkUaClientHints(snap));
  checks.push(checkUaVersionBrands(snap));
  checks.push(checkMobilePlatform(snap));
  checks.push(checkEngineVersion(snap));
  checks.push(checkChPlatformOs(snap));
  checks.push(checkNetworkObservational(snap));

  const reasons = checks.filter((c) => c.status === 'FAIL' || c.status === 'WARN').map((c) => `${c.name}: ${c.detail}`);
  const hasFail = checks.some((c) => c.status === 'FAIL');
  const hasWarn = checks.some((c) => c.status === 'WARN');
  const status = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';
  return { status, checks, reasons };
}

module.exports = { checkEnvironmentIntegrity };
