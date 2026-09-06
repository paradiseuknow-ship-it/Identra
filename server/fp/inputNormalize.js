'use strict';

// Phase 14.1 — Fingerprint Input Normalization & Fail-Fast（真实站点就绪 · 环境归因前置）
//
// 背景（2026-09-04 webflow 侦察第 2 轮实证）：profile.os/browser 传小写（'windows'）时，
// generate.js 的 UA 池按 `u.os === targetOs` 严格匹配 → 池空 → 全池随机 fallback →
// 出现 iPhone UA × Windows platform × Chrome brands 的灾难性错配，任何 WAF 秒判机器人。
//
// 修复原则（Phase 14 硬性边界）：
//   1. 优先 normalize input（大小写/别名 → canonical 值域）
//   2. unknown input → 确定性报错 fail-fast
//   3. 禁止 unknown input → random environment
//   4. 不修改指纹生成策略本身（本模块只做输入层规范化，generateFingerprint 逻辑零改动）
//
// canonical 值域 = D.USER_AGENTS 模板池真实域：
//   OS      ∈ { Windows, macOS, Linux, Android, iOS }
//   BROWSER ∈ { Chrome, Edge, Safari }
//
// 空组合池（如 Windows+Safari）同样是「静默环境错配」的来源，同属 fail-fast 范围——
// 不可用组合物理上就不存在一致的 UA/ClientHints/平台，与其静默拼出矛盾环境，不如启动期报错。

const OS_CANONICAL = ['Windows', 'macOS', 'Linux', 'Android', 'iOS'];
const BROWSER_CANONICAL = ['Chrome', 'Edge', 'Safari'];

const OS_ALIASES = {
  windows: 'Windows', win: 'Windows', win32: 'Windows',
  macos: 'macOS', mac: 'macOS', osx: 'macOS', darwin: 'macOS', macintosh: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS', iphone: 'iOS', ipad: 'iOS',
};

const BROWSER_ALIASES = {
  chrome: 'Chrome', chromium: 'Chrome',
  edge: 'Edge', msedge: 'Edge',
  safari: 'Safari',
};

class FingerprintInputError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FingerprintInputError';
    this.code = code;
  }
}

// 单值规范化：null/undefined/空串 → null（未指定，交由上层默认）；别名 → canonical；未知 → throw
function canonicalOs(input) {
  if (input === null || input === undefined || input === '') return null;
  const key = String(input).trim().toLowerCase();
  if (!(key in OS_ALIASES)) {
    throw new FingerprintInputError(
      `[fp.input] unknown os "${input}"（canonical 值域: ${OS_CANONICAL.join('/')}）——拒绝生成随机错配环境`,
      'FP_INPUT_UNKNOWN_OS'
    );
  }
  return OS_ALIASES[key];
}

function canonicalBrowser(input) {
  if (input === null || input === undefined || input === '') return null;
  const key = String(input).trim().toLowerCase();
  if (!(key in BROWSER_ALIASES)) {
    throw new FingerprintInputError(
      `[fp.input] unknown browser "${input}"（canonical 值域: ${BROWSER_CANONICAL.join('/')}）——拒绝生成随机错配环境`,
      'FP_INPUT_UNKNOWN_BROWSER'
    );
  }
  return BROWSER_ALIASES[key];
}

// override 级规范化：仅处理 os/browser 两个键，其余键原样保留（浅拷贝，不改入参）
function canonicalizeFingerprintInput(override) {
  if (!override || typeof override !== 'object') return override;
  const out = { ...override };
  if ('os' in out) out.os = canonicalOs(out.os);
  if ('browser' in out) out.browser = canonicalBrowser(out.browser);
  return out;
}

// 可用组合校验（canonical 后调用）：组合在 UA 模板池无模板 → throw（替代旧的静默全池 fallback）
function assertCombinationAvailable(os, browser, uaPool) {
  if (!os && !browser) return true;
  const has = (uaPool || []).some((u) => (!os || u.os === os) && (!browser || u.browser === browser));
  if (!has) {
    throw new FingerprintInputError(
      `[fp.input] 环境组合 os="${os || '*'}" browser="${browser || '*'}" 在 UA 模板池无可用模板——拒绝静默回退随机环境（不可用组合本身即环境不一致）`,
      'FP_INPUT_UNAVAILABLE_COMBINATION'
    );
  }
  return true;
}

module.exports = {
  OS_CANONICAL,
  BROWSER_CANONICAL,
  OS_ALIASES,
  BROWSER_ALIASES,
  FingerprintInputError,
  canonicalOs,
  canonicalBrowser,
  canonicalizeFingerprintInput,
  assertCombinationAvailable,
};
