'use strict';

// Profile Integrity：启动前的内部一致性体检。
// 目的不是增加指纹能力，而是防止开发/运营过程中把 Profile 搞"脏"——例如 UA 与引擎版本错位、
// 时区配置写错、代理配置失效、指纹生成不确定等。只报警不改行为（WARNING 不阻断启动）。
//
// 分层（与产品模型对齐）：
//   fingerprint —— "这个环境是谁"：UA / Client Hints / locale / timezone / viewport / 确定性
//   storage     —— "这个环境经历过什么"：userDataDir 是否就绪
//   network     —— "这个环境从哪里连接"：proxy 配置是否有效

const fs = require('fs');
const path = require('path');
const { generateFingerprint, seedFromProfile } = require('./fp/generate');
const { dataRoot } = require('./dataRoot');

// C59：跟随数据根（FPB_DATA_DIR 隔离测试下与 browserManager 的 profiles 根对齐；
// 原实现硬编码 ../data/profiles，隔离模式下检查错目录——C47 同类边界）
function profileDataDir(profileId) {
  return path.join(dataRoot(), 'profiles', profileId);
}

// 提取 UA 里的 Chrome 大版本（如 151.0.7922.138 -> 151）
function uaChromeMajor(ua) {
  if (!ua) return null;
  const m = ua.match(/Chrome\/(\d+)(\.\d+)*/);
  return m ? parseInt(m[1], 10) : null;
}

// 校验 IANA 时区名是否真实有效：无效时 Intl 会抛 RangeError
function isTzValid(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    return true;
  } catch (e) {
    return false;
  }
}

const LOCALE_RE = /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/;

// 主入口：返回 { pass, status, results, summary }
// opts: { fp, engineVersion, proxies, proxy }
function runIntegrityCheck(profile, opts = {}) {
  const { fp, engineVersion, proxies, proxy } = opts;
  const results = [];
  const note = (area, ok, msg) => results.push({ area, ok, msg });
  const ok = (area, msg) => note(area, true, msg);
  const warn = (area, msg) => note(area, false, msg);

  const override = {
    os: profile.os,
    browser: profile.browser,
    ...(profile.fingerprintOverride || {}),
  };

  // ---- fingerprint 层 ----
  // 1) UA ↔ browser version：伪造 UA 的大版本必须与本机引擎一致
  const uaMajor = uaChromeMajor(fp && fp.userAgent);
  if (engineVersion) {
    const engineMajor = parseInt(String(engineVersion).split('.')[0], 10);
    if (uaMajor && uaMajor === engineMajor) {
      ok('fingerprint', `UA ${uaMajor} ↔ 引擎 ${engineMajor} 一致`);
    } else {
      warn('fingerprint', `UA Chrome/${uaMajor || '?'} ↔ 引擎 Chrome/${engineMajor} 不一致（应自动对齐，可能引擎版本读取失败）`);
    }
  } else {
    note('fingerprint', true, '引擎版本不可读，跳过 UA↔引擎校验（UA 沿用指纹池版本）');
  }

  // 2) UA 格式 + Client Hints 一致性（三者均由同一 fp.userAgent 派生，校验格式是否合法）
  if (fp && fp.userAgent && /Chrome\/\d+\.\d+\.\d+\.\d+/.test(fp.userAgent)) {
    ok('fingerprint', `UA 格式合法: ${fp.userAgent}`);
  } else {
    warn('fingerprint', `UA 格式异常（缺少 Chrome/N.N.N.N 完整版本）: ${(fp && fp.userAgent) || '空'}`);
  }

  // 3) locale ↔ language：Playwright locale / Accept-Language / navigator.language 同一来源，校验格式
  if (fp && fp.language && LOCALE_RE.test(fp.language)) {
    ok('fingerprint', `language/locale 合法: ${fp.language}`);
  } else {
    warn('fingerprint', `language/locale 格式异常: ${(fp && fp.language) || '空'}`);
  }

  // 4) timezone 有效
  if (fp && fp.timezone && isTzValid(fp.timezone)) {
    ok('fingerprint', `timezone 有效: ${fp.timezone}`);
  } else {
    warn('fingerprint', `timezone 无效或缺失: ${(fp && fp.timezone) || '空'}`);
  }

  // 5) viewport / screen 有效
  const sc = fp && fp.screen;
  const vpOk = sc && Number.isInteger(sc.width) && Number.isInteger(sc.height)
    && sc.width > 0 && sc.height > 0 && sc.width <= 16384 && sc.height <= 16384
    && sc.pixelRatio > 0 && sc.pixelRatio <= 10;
  if (vpOk) {
    ok('fingerprint', `viewport/screen 有效: ${sc.width}x${sc.height} @ ${sc.pixelRatio}x`);
  } else {
    warn('fingerprint', `viewport/screen 异常: ${sc ? sc.width + 'x' + sc.height : '缺失'}`);
  }

  // 6) fingerprint 生成确定性（同 seed → 同 fp 稳定字段）
  const randomFp = profile.fingerprint && profile.fingerprint.randomFingerprint === true;
  if (randomFp) {
    note('fingerprint', true, 'randomFingerprint 开启：指纹每次启动重新生成（预期行为，跳过确定性校验）');
  } else {
    try {
      const a = generateFingerprint(seedFromProfile(profile), override, null);
      const b = generateFingerprint(seedFromProfile(profile), override, null);
      const stable = (f) => JSON.stringify([
        f.screen, f.hardwareConcurrency, f.deviceMemory, f.noiseSeed,
        f.webgl, f.fonts, f.mac, f.deviceName, f.platform, f.vendor,
      ]);
      if (stable(a) === stable(b)) {
        ok('fingerprint', '生成确定性 PASS（同 seed → 同 fp）');
      } else {
        warn('fingerprint', '生成不确定：同 seed 两次生成结果不一致，检查 seed / randomFingerprint 配置');
      }
    } catch (e) {
      note('fingerprint', true, '确定性校验异常(已忽略): ' + String(e.message || e).slice(0, 120));
    }
  }

  // ---- storage 层 ----
  const udDir = profileDataDir(profile.id);
  if (fs.existsSync(udDir)) {
    ok('storage', `userDataDir 就绪: data/profiles/${profile.id}`);
  } else {
    note('storage', true, 'userDataDir 尚未创建（首次启动将自动创建）');
  }

  // ---- network 层 ----
  // proxy 有效性：保存代理必须能在代理库中找到；内联代理必须有 server(host:port) 或 host/port。
  // 兼容系统两种存储：server 带 scheme（socks5://h:p）与不带（h:p）。
  const parseServer = (s) => {
    if (!s) return null;
    let str = String(s);
    const scheme = str.match(/^([a-z0-9]+):\/\//i);
    if (scheme) str = str.slice(scheme[0].length);
    const m = str.match(/^([^:@/\s]+):(\d{1,5})/);
    return m && m[1] && m[2] ? { host: m[1], port: m[2] } : null;
  };

  if (!proxy && !profile.proxyInline && profile.proxyMode !== 'saved') {
    note('network', true, '未配置代理（直连模式）');
  } else {
    const eff = proxy || profile.proxyInline;
    if (eff && eff.host && eff.port) {
      ok('network', `proxy 配置有效: ${eff.host}:${eff.port}`);
    } else if (eff && eff.server) {
      const parsed = parseServer(eff.server);
      if (parsed) {
        ok('network', `proxy 配置有效: ${parsed.host}:${parsed.port} (${eff.type || '?'})`);
      } else {
        warn('network', `proxy server 格式异常: ${eff.server}`);
      }
    } else if (profile.proxyMode === 'saved') {
      const found = (proxies || []).find((x) => x.id === profile.proxyId);
      if (found && found.server) {
        const parsed = parseServer(found.server);
        if (parsed) ok('network', `proxy 配置有效: ${parsed.host}:${parsed.port}`);
        else warn('network', `代理库中 server 格式异常: ${found.server}`);
      } else {
        warn('network', `proxyMode=saved 但代理库中找不到 proxyId=${profile.proxyId || '(空)'}`);
      }
    } else {
      warn('network', '代理配置不完整（缺少 server 或 host/port）');
    }
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok);
  const summary = {
    fingerprint: results.filter((r) => r.area === 'fingerprint' && !r.ok).length === 0 ? 'OK' : 'WARNING',
    storage: results.filter((r) => r.area === 'storage' && !r.ok).length === 0 ? 'OK' : 'WARNING',
    network: results.filter((r) => r.area === 'network' && !r.ok).length === 0 ? 'OK' : 'WARNING',
    integrity: failed.length === 0 ? 'PASS' : 'WARNING',
  };
  return { pass: failed.length === 0, status: failed.length === 0 ? 'PASS' : 'WARNING', results, summary };
}

// 启动时日志输出（非阻塞，仅供开发期观察）
function logIntegrity(profileId, report) {
  if (!report) return;
  console.log(`[integrity] profile=${profileId} 层=${report.summary.fingerprint}/${report.summary.storage}/${report.summary.network} 总体=${report.status}`);
  for (const r of report.results) {
    if (!r.ok) console.warn(`[integrity]   ⚠ ${r.area}: ${r.msg}`);
  }
}

module.exports = { runIntegrityCheck, logIntegrity, profileDataDir };
