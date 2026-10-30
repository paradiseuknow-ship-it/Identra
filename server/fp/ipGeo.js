'use strict';
// C193：「基于 IP」的时区 / 语言 / 地理位置解析 —— 唯一实现。
//
// 修复前这里是**两条口径**（同一语义两个实现，必然漂移）：
//   ① 启动路径 browserManager.resolveLaunchIpGeo：有代理→查代理出口；
//      无代理→查本机出口；解析失败一律抛错并**阻断启动**（绝不静默回退随机）。
//   ② 预览路径 index.js.resolveIpGeo：**proxy 为 null 时直接 return null** ——
//      于是「新建配置（还没填代理）」或「代理未填」时，点「生成新指纹」/打开编辑器，
//      时区/语言/坐标全部落到指纹池随机值，右侧概要在各国之间跳，
//      而真实启动时又会严格解析（失败则根本起不来）。预览与运行态完全不一致。
//
// 现在两条路径共用本模块：同一份判定、同一份失败语义。差别只有一处，且必须显式：
//   strict=true （启动）解析失败 → 抛错阻断；
//   strict=false（预览）解析失败 → 回传 status/error 给 UI 明示，绝不假装"基于 IP 成功"。

const { getProxyEgressGeo, getEgressIp } = require('../proxyChecker');
const { lookupIp } = require('../geoip');

// 依赖注入接缝：守护可离线真实执行所有分支（网络类依赖替换为夹具）。
const realDeps = {
  getProxyEgressGeo,
  getEgressIp,
  lookupIp,
};
let deps = Object.assign({}, realDeps);

function __setDepsForTest(d) { deps = Object.assign({}, deps, d || {}); }
function __resetDepsForTest() { deps = Object.assign({}, realDeps); }
function __clearCacheForTest() { cache.clear(); }

// 哪些维度要求「基于 IP」——任一为真才需要解析（否则纯本地计算，不该触发网络）
function ipModesOf(override) {
  const o = override || {};
  const tz = o.timezoneMode === 'ip';
  const lang = o.languageMode === 'ip';
  const geo = !!(o.geolocation && o.geolocation.mode === 'ip');
  return { timezone: tz, language: lang, geolocation: geo, any: tz || lang || geo };
}

// 编辑器打开、切换代理、点「生成新指纹」会连续触发展开预览；同一个出口没必要每次都打网络。
// 只缓存成功结果（失败不缓存：瞬时故障不该被冻结 60s 让用户误以为一直不可用）。
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function cacheKeyFor(proxy, modes) {
  const p = proxy && proxy.server
    ? [String(proxy.type || '').toLowerCase(), String(proxy.server), String(proxy.username || '')].join('|')
    : 'direct';
  return p + '#' + [modes.timezone ? 1 : 0, modes.language ? 1 : 0, modes.geolocation ? 1 : 0].join('');
}

function strictError(kind, msg) {
  if (kind === 'proxy-fail') {
    return '代理出口 IP 解析失败：' + msg +
      '。已阻止启动，避免指纹回退成本机直连导致泄露。请检查代理可用性，或改用「自定义」时区/语言/地理位置后重试。';
  }
  if (kind === 'proxy-no-ip') {
    return '代理出口 IP 解析失败：无法获取代理的公网出口地址。已阻止启动，避免指纹回退成本机直连导致泄露。' +
      '请检查代理可用性，或改用「自定义」时区/语言/地理位置后重试。';
  }
  if (kind === 'proxy-no-geo') {
    return '已取得代理出口 IP，但地理位置库未返回时区/语言/经纬度。已阻止启动，避免"基于 IP"指纹落空造成环境不一致（出库异常）。' +
      '请检查本机到 geo 服务的网络可达性，或改用「自定义」后重试。';
  }
  return '未配置代理且无法解析本机出口 IP，无法生成"基于 IP"指纹：' + msg;
}

// 核心解析。返回 { geo, status, error, ip }
//   status: 'not-needed' 全部维度都不是「基于 IP」（零网络）
//           'ok'         解析成功（geo 可用）
//           'unresolved' 需要解析但没拿到（geo=null，error 说明原因）
async function resolveForOverride(override, proxy, opts) {
  const o = opts || {};
  const modes = ipModesOf(override);
  if (!modes.any) return { geo: null, status: 'not-needed', error: null, ip: null };

  const useCache = o.cache !== false;
  const key = cacheKeyFor(proxy, modes);
  if (useCache) {
    const hit = cache.get(key);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) {
      return { geo: hit.geo, status: 'ok', error: null, ip: hit.ip, cached: true };
    }
  }

  const hasProxy = !!(proxy && proxy.server);
  let geo = null;
  let ip = null;
  let failure = null;

  if (hasProxy) {
    try {
      const r = await deps.getProxyEgressGeo(proxy);
      ip = r && r.ip ? r.ip : null;
      geo = r && r.geo ? r.geo : null;
      if (!ip) failure = { kind: 'proxy-no-ip', msg: '' };
      else if (!geo) failure = { kind: 'proxy-no-geo', msg: '' };
    } catch (e) {
      failure = { kind: 'proxy-fail', msg: String((e && e.message) || e) };
    }
  } else {
    // 无代理时**同样必须解析**：直连出口就是这个环境的真实 IP，「基于 IP」理应对齐它。
    // （旧预览实现此处直接返回 null ⇒ 静默随机，是本轮用户看到的"各国乱跳"来源。）
    try {
      ip = await deps.getEgressIp(null);
      geo = ip ? await deps.lookupIp(ip) : null;
      if (geo) geo.ip = ip;
      if (!geo) failure = { kind: 'direct-fail', msg: '无法解析本机出口 IP 的地理位置' };
    } catch (e) {
      failure = { kind: 'direct-fail', msg: String((e && e.message) || e) };
    }
  }

  if (failure) {
    if (o.strict) throw new Error(strictError(failure.kind, failure.msg));
    return {
      geo: null,
      status: 'unresolved',
      error: strictError(failure.kind, failure.msg),
      reason: failure.kind,
      ip: ip || null,
    };
  }

  if (useCache) cache.set(key, { at: Date.now(), geo, ip });
  return { geo, status: 'ok', error: null, ip, cached: false };
}

// 便捷包装：profile 形态（OS / Browser 等不进解析，只需 fingerprintOverride）
function resolveForProfile(profile, proxy, opts) {
  return resolveForOverride(profile && profile.fingerprintOverride, proxy, opts);
}

// C195：体检/诊断入口——不依赖 override 的 mode 判定，**总是**解析「当前出口地理」。
// 为什么不能复用 resolveForProfile：mode 全非 ip（custom/随机——恰是出口↔指纹矛盾体检
// 的核心场景）时它返回 not-needed/geo=null，比对会被静默跳过。本入口借用「时区=ip」
// 形态触发同一套解析（resolveForOverride 是唯一实现，这里只是绕过 modes.any 前置，
// 非第二实现；geo 返回完整字段，缓存与其它路径共用）。
async function resolveEgressGeo(proxy, opts) {
  return resolveForOverride({ timezoneMode: 'ip' }, proxy, opts);
}

module.exports = {
  ipModesOf,
  resolveForOverride,
  resolveForProfile,
  resolveEgressGeo,
  strictError,
  __setDepsForTest,
  __resetDepsForTest,
  __clearCacheForTest,
};
