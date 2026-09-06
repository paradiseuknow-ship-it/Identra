'use strict';

// Phase 14.2 — Environment Snapshot（真实站点就绪 · 可观测性基座）
//
// 定位（Phase 14 规格 §三）：这不是「人类评分器」——只描述系统真实观察到的环境。
//
// 铁律：
//   1. 敏感凭证绝不进入 snapshot：password / CVV / card number / access token /
//      cookie value / session secret 一律深度剥除（denylist scrub）
//   2. 会话状态只记 presence / metadata（cookiesPresent: {present, count}，绝不存值）
//   3. timestamp 可注入 → 测试可确定性
//   4. 页面采集失败优雅降级（字段置 null，绝不抛异常拖垮主链路）

const SNAPSHOT_VERSION = 1;

// 深度剥除 denylist 键（键名匹配即整键删除；只删一层引用，不影响原对象）
const DENYLIST_RE = /password|passwd|pwd|cvv|cvc|card.?number|card.?cvv|secret|token|authorization|cookie.?value|session.?key|api.?key|credential(s)?.?value/i;
const PRESENCE_ONLY_RE = /cookie|storage|indexeddb|serviceworker/i;

function scrubValue(value, keyName) {
  if (value === null || value === undefined) return null;
  if (keyName && DENYLIST_RE.test(String(keyName))) return undefined; // 整键剥除
  if (typeof value === 'string') {
    // 值级兜底：疑似 JWT / 长随机 secret 字符串 → 只记「REDACTED」
    if (/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(value)) return '[REDACTED_JWT]';
    return value;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const v = scrubValue(value[i], keyName);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      const v = scrubValue(value[k], k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

// 纯装配器：各部分由调用方提供（页面采集 / fp 对象 / profile / proxy / task 标识），缺省优雅降级
function buildEnvironmentSnapshot(parts = {}) {
  const snap = {
    snapshotVersion: SNAPSHOT_VERSION,
    browser: {
      engine: parts.browser?.engine ?? null,
      engineVersion: parts.browser?.engineVersion ?? null,
      browser: parts.browser?.browser ?? null,
      browserVersion: parts.browser?.browserVersion ?? null,
      userAgent: parts.browser?.userAgent ?? null,
      platform: parts.browser?.platform ?? null,
      mobile: parts.browser?.mobile ?? null,
      language: parts.browser?.language ?? null,
      timezone: parts.browser?.timezone ?? null,
    },
    clientHints: {
      brands: Array.isArray(parts.clientHints?.brands) ? parts.clientHints.brands : null,
      fullVersionList: Array.isArray(parts.clientHints?.fullVersionList) ? parts.clientHints.fullVersionList : null,
      platform: parts.clientHints?.platform ?? null,
      platformVersion: parts.clientHints?.platformVersion ?? null,
      architecture: parts.clientHints?.architecture ?? null,
      model: parts.clientHints?.model ?? null,
      mobile: parts.clientHints?.mobile ?? null,
    },
    fingerprint: {
      fingerprintId: parts.fingerprint?.fingerprintId ?? null,
      source: parts.fingerprint?.source ?? null, // generated | native-captured | custom
      consistencyStatus: parts.fingerprint?.consistencyStatus ?? 'UNKNOWN', // PASS | WARN | FAIL | UNKNOWN
    },
    network: {
      proxyType: parts.network?.proxyType ?? null,
      proxyConfigured: parts.network?.proxyConfigured === true,
      ip: parts.network?.ip ?? null,
      country: parts.network?.country ?? null,
      region: parts.network?.region ?? null,
      asn: parts.network?.asn ?? null,
    },
    profile: {
      profileId: parts.profile?.profileId ?? null,
      persistent: parts.profile?.persistent === true,
      cacheClearMode: parts.profile?.cacheClearMode ?? null,
    },
    session: {
      cookiesPresent: parts.session?.cookiesPresent ?? { present: false, count: 0 },
      localStoragePresent: parts.session?.localStoragePresent === true,
      indexedDbPresent: parts.session?.indexedDbPresent === true,
      serviceWorkerPresent: parts.session?.serviceWorkerPresent === true,
    },
    task: {
      taskId: parts.task?.taskId ?? null,
      executionId: parts.task?.executionId ?? null,
      attemptId: parts.task?.attemptId ?? null,
    },
    timestamp: typeof parts.timestamp === 'number' ? parts.timestamp : Date.now(),
  };
  return scrubValue(snap); // 出口统一 scrub（纵深防御：即使调用方误传敏感键也进不来）
}

// 页面侧采集：从真实浏览器读 navigator / userAgentData / storage presence（只读、只记 presence）
async function collectFromPage(page) {
  if (!page) return {};
  try {
    return await page.evaluate(() => {
      const out = {};
      try { out.userAgent = navigator.userAgent; } catch (e) {}
      try { out.platform = navigator.platform; } catch (e) {}
      try { out.language = navigator.language; } catch (e) {}
      try { out.mobile = /Mobi|Android|iPhone/i.test(navigator.userAgent) || (navigator.userAgentData && navigator.userAgentData.mobile) || false; } catch (e) {}
      try { out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
      try {
        const ch = navigator.userAgentData;
        if (ch) {
          out.clientHints = {
            platform: ch.platform || null,
            platformVersion: null, // 需 getHighEntropyValues（异步），此处只记同步可得项
            mobile: ch.mobile === true,
            brands: Array.isArray(ch.brands) ? ch.brands.map((b) => ({ brand: String(b.brand), version: String(b.version) })) : null,
          };
        }
      } catch (e) {}
      try { out.localStoragePresent = localStorage.length > 0; } catch (e) { out.localStoragePresent = false; }
      try { out.serviceWorkerPresent = !!(navigator.serviceWorker && navigator.serviceWorker.controller); } catch (e) { out.serviceWorkerPresent = false; }
      try { out.indexedDbPresent = !!indexedDB; } catch (e) { out.indexedDbPresent = false; }
      return out;
    });
  } catch (e) {
    return {}; // 页面不可用 → 全部降级为 null，由装配器兜底
  }
}

// 组合采集器：page 实测 + fp/profile/proxy 元数据 → 完整 snapshot
async function captureEnvironmentSnapshot({ page = null, fp = null, profile = null, proxy = null, task = {}, ipInfo = null } = {}) {
  const live = await collectFromPage(page);
  const brands = (fp && (fp._uaFullVersionList || fp._uaBrands)) || (live.clientHints && live.clientHints.brands) || null;
  const parts = {
    browser: {
      engine: 'Blink',
      engineVersion: fp ? String(fp.browserVersion || '').split('.').join('.') || null : null,
      browser: fp ? fp.browser : null,
      browserVersion: fp ? fp.browserVersion || null : null,
      userAgent: live.userAgent || (fp ? fp.userAgent : null),
      platform: live.platform || (fp ? fp.platform : null),
      mobile: typeof live.mobile === 'boolean' ? live.mobile : /Mobi|Android|iPhone/i.test((fp && fp.userAgent) || ''),
      language: live.language || (fp ? fp.language : null),
      timezone: live.timezone || (fp ? fp.timezone : null),
    },
    clientHints: {
      brands,
      fullVersionList: (fp && fp._uaFullVersionList) || null,
      platform: (live.clientHints && live.clientHints.platform) || (fp ? fp.os : null),
      platformVersion: (live.clientHints && live.clientHints.platformVersion) || null,
      architecture: null,
      model: null,
      mobile: (live.clientHints && live.clientHints.mobile) ?? null,
    },
    fingerprint: {
      fingerprintId: fp ? (fp.id || null) : null,
      source: fp ? (fp._uaBrands ? 'native-captured' : 'generated') : null,
      consistencyStatus: 'UNKNOWN',
    },
    network: {
      proxyType: proxy ? (proxy.type || null) : null,
      proxyConfigured: !!proxy,
      ip: ipInfo ? ipInfo.ip : null,
      country: ipInfo ? ipInfo.country : null,
      region: ipInfo ? ipInfo.region : null,
      asn: ipInfo ? ipInfo.asn : null,
    },
    profile: {
      profileId: profile ? profile.id : null,
      persistent: !!(profile && profile.persistentContext),
      cacheClearMode: profile && profile.launchBehavior ? profile.launchBehavior.cacheClearMode || null : null,
    },
    session: {
      cookiesPresent: { present: false, count: 0 },
      localStoragePresent: live.localStoragePresent === true,
      indexedDbPresent: live.indexedDbPresent === true,
      serviceWorkerPresent: live.serviceWorkerPresent === true,
    },
    task,
  };
  if (page) {
    try {
      const ctx = page.context();
      const cookies = ctx.cookies();
      parts.session.cookiesPresent = { present: true, count: cookies.length }; // 只记 presence/count，绝不存值
    } catch (e) { /* 保持默认 */ }
  }
  return buildEnvironmentSnapshot(parts);
}

module.exports = { buildEnvironmentSnapshot, collectFromPage, captureEnvironmentSnapshot, scrubValue, DENYLIST_RE, SNAPSHOT_VERSION };
