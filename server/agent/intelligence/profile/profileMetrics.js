'use strict';

// Profile Metrics（Phase 3.4）：把既有数据源映射为「维度健康分」（0-100 纯函数，可注入）。
// 数据源：
//   - integrity.js    → fingerprint / storage 层体检
//   - proxyChecker.js / proxyPrecheck.js → network（代理可用性 / 住宅 vs 机房 / 延迟 / 地区 / 是否被墙）
//   - 任务stats       → taskSuccess / stability
// 所有函数接受「已计算好的报告」作为参数，便于测试注入，不在此处触发网络。

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// ---- fingerprint 健康 ----
// report: integrity.runIntegrityCheck 的返回 { summary, results }
function fingerprintHealthFromIntegrity(report) {
  if (!report) return 70; // 未体检：中性分，等待真实数据
  if (report.summary && report.summary.fingerprint === 'OK') return 92;
  const fails = (report.results || []).filter((r) => r.area === 'fingerprint' && !r.ok).length;
  // 每有一项指纹体检失败扣 12，下限 40
  return clamp(100 - fails * 12, 40, 100);
}

// ---- storage 健康（userDataDir 是否就绪）----
function storageHealthFromIntegrity(report) {
  if (!report) return 75;
  if (report.summary && report.summary.storage === 'OK') return 95;
  const warns = (report.results || []).filter((r) => r.area === 'storage' && !r.ok).length;
  return warns ? 70 : 90;
}

// ---- network 健康 ----
// health: 归一化对象 { ok, latencyMs, type:'isp'|'hosting'|'unknown', reachable, blocked }
//   可来自 proxyChecker.checkProxyGeo / proxyPrecheckProxy 的返回。
function networkHealthFromProxy(health) {
  if (!health) return 70;            // 无代理配置（直连）：中性分
  if (!health.ok) return 25;         // 代理不可用
  let s = 80;
  if (health.type === 'isp') s += 10;          // 住宅 IP 优先
  else if (health.type === 'hosting') s = Math.min(s, 60); // 机房 IP 风控风险更高
  if (health.latencyMs != null) {
    if (health.latencyMs < 150) s += 5;
    else if (health.latencyMs > 400) s -= 15;
  }
  if (health.reachable === false) s -= 20;     // 目标不可达
  if (health.blocked) s -= 15;                 // 被风控/验证码拦截
  return clamp(Math.round(s), 0, 100);
}

// ---- 任务成功率维度（全局）----
function taskSuccessDimension(stats) {
  stats = stats || {};
  const total = stats.totalTasks || (stats.success || 0) + (stats.failed || 0);
  if (!total) return 50; // 无历史：未验证中性分
  const succ = stats.success || 0;
  return clamp(Math.round((succ / total) * 100), 0, 100);
}

// ---- 稳定性维度：基于近期窗口成功率 ----
function stabilityDimension(recent) {
  const arr = Array.isArray(recent) ? recent : [];
  if (!arr.length) return 70; // 无近期数据：中性
  const succ = arr.filter(Boolean).length;
  return clamp(Math.round((succ / arr.length) * 100), 0, 100);
}

// 从 injected 输入构造完整 dimensions（供 analyzer.ensure 赋初值 / 实时评估）。
// inputs: { fingerprint, network, storage, taskSuccess, stability }（均可选，缺省取中性）
function buildDimensions(inputs) {
  inputs = inputs || {};
  return {
    fingerprint: clamp(Number.isFinite(inputs.fingerprint) ? inputs.fingerprint : 70, 0, 100),
    network: clamp(Number.isFinite(inputs.network) ? inputs.network : 70, 0, 100),
    storage: clamp(Number.isFinite(inputs.storage) ? inputs.storage : 75, 0, 100),
    taskSuccess: clamp(Number.isFinite(inputs.taskSuccess) ? inputs.taskSuccess : 50, 0, 100),
    stability: clamp(Number.isFinite(inputs.stability) ? inputs.stability : 70, 0, 100),
  };
}

// ---- 实时采集（可选，仅显式路由调用，best-effort，绝不阻断）----
// 加载 profiles.json 中的 profile，跑 integrity + 代理探测，返回 { dimensions, region, geo }。
async function collectLive(profileId) {
  try {
    const fs = require('fs');
    const path = require('path');
    const profPath = path.join(__dirname, '..', '..', '..', '..', 'data', 'profiles.json');
    if (!fs.existsSync(profPath)) return null;
    const profiles = JSON.parse(fs.readFileSync(profPath, 'utf8'));
    const arr = Array.isArray(profiles) ? profiles : Object.values(profiles);
    const profile = arr.find((p) => p && p.id === profileId);
    if (!profile) return null;

    const dims = { fingerprint: 70, network: 70, storage: 75, taskSuccess: 50, stability: 70 };
    let region = null, geo = null;

    try {
      const { runIntegrityCheck } = require('../../../integrity');
      const rep = runIntegrityCheck(profile, { fp: profile.fingerprint });
      dims.fingerprint = fingerprintHealthFromIntegrity(rep);
      dims.storage = storageHealthFromIntegrity(rep);
    } catch (e) { /* 体检失败沿用中性分 */ }

    // 代理探测（若配置了 proxyId）
    try {
      const proxiesPath = path.join(__dirname, '..', '..', '..', '..', 'data', 'proxies.json');
      if (fs.existsSync(proxiesPath) && profile.proxyId) {
        const proxies = JSON.parse(fs.readFileSync(proxiesPath, 'utf8'));
        const plist = Array.isArray(proxies) ? proxies : Object.values(proxies);
        const px = plist.find((x) => x && x.id === profile.proxyId);
        if (px) {
          const { checkProxyGeo } = require('../../../proxyChecker');
          const h = await checkProxyGeo(px);
          dims.network = networkHealthFromProxy({
            ok: h.ok, latencyMs: h.latencyMs,
            type: (h.geo && h.geo.type) || (h.detectedType ? 'unknown' : 'unknown'),
            blocked: h.geo && h.geo.type === 'hosting',
          });
          geo = h.geo || null;
          if (h.geo && h.geo.countryCode) region = h.geo.countryCode;
        }
      }
    } catch (e) { /* 代理探测失败沿用中性分 */ }

    // 由 fingerprint 语言兜底地区
    if (!region && profile.fingerprint && profile.fingerprint.language) {
      const m = String(profile.fingerprint.language).split(/[-_]/);
      if (m[1]) region = m[1].toUpperCase();
    }
    return { dimensions: dims, region, geo };
  } catch (e) {
    return null;
  }
}

module.exports = {
  fingerprintHealthFromIntegrity, storageHealthFromIntegrity, networkHealthFromProxy,
  taskSuccessDimension, stabilityDimension, buildDimensions, collectLive,
};
