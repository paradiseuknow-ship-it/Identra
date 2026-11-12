'use strict';
// C198：Chrome UA 版本冻结（UA Reduction）——单一实现。
// 实证（.benchmark/step19_signal_audit_*.json control-headed + hev 对照探针）：
//   真 Chrome 157 的 navigator.userAgent 为 Chrome/157.0.0.0 —— Chromium 自 UA Reduction
//   起 UA 字符串小版本冻结为 .0.0.0，完整版本号只出现在 UA-CH
//   getHighEntropyValues 的 uaFullVersion / fullVersionList（客户端提示）里：
//     UA 字符串      → Chrome/157.0.0.0
//     uaFullVersion  → 157.0.8103.38（完整）
//   旧实现把引擎完整版本号写进 UA（Chrome/157.0.8103.38），格式与所有真实 Chrome 相异，
//   是反爬静态评分可直接使用的 UA 格式异常（Webflow/PX 长按挑战反复复现的候选信号之一）。
// 消费方：browserManager（launch 对齐）＋index.js（preview / regenerateSeed 两处）。
// 注意：identity.browserVersion 由 fp.userAgent 派生（identityFactory.browserVersionFromUA），
//   冻结后为 N.0.0.0 —— identitySchema V4 版本格式 N(.N){0,3} 合法；UA-CH 侧完整版本
//   由 inject.js 从原生 userAgentData 回读（与本模块解耦，勿从 UA 字符串回抠全版本）。

// 冻结 UA 字符串中的 Chrome 版本号为 <major>.0.0.0（不动 Edg/ 等其他 token）
function freezeChromeUaVersion(ua) {
  if (typeof ua !== 'string') return ua;
  return ua.replace(/Chrome\/(\d+)(\.\d+)*/g, (m, major) => 'Chrome/' + major + '.0.0.0');
}

// 对齐：引擎 major ＋ 冻结格式（唯一实现）。引擎版本不可读时原样返回（调用方负责告警）。
function alignUaToEngine(ua, engineVersion) {
  if (!engineVersion || typeof ua !== 'string') return ua;
  if (!/Chrome\/\d+(\.\d+)*/.test(ua)) return ua;
  const major = String(engineVersion).split('.')[0];
  if (!/^\d+$/.test(major)) return ua;
  return ua.replace(/Chrome\/\d+(\.\d+)*/, 'Chrome/' + major + '.0.0.0');
}

// UA 主版本（integrity UA↔引擎一致性校验用；冻结前后均可解析）
function uaChromeMajor(ua) {
  if (typeof ua !== 'string') return null;
  const m = ua.match(/Chrome\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = { freezeChromeUaVersion, alignUaToEngine, uaChromeMajor };
