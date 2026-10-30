'use strict';
// C195 守护：出口 IP ↔ 指纹一致性体检（integrity 第 7 项）+ resolveEgressGeo 体检入口。
//
// 背景（问题3 残留）：C193 修掉了「预览落指纹池随机」，但「自定义/随机时区与出口 IP 地理
// 矛盾」的 profile 仍被静默接受——IP↔时区矛盾恰是风控（Stripe Radar / PX）一级特征，
// 用户在风控前完全看不见。本批在 integrity 体检里补交叉比对：时区（强信号）、语言主子标签
// （弱信号）、坐标距离 >500km（Geolocation vs IP 矛盾）。
//
// 关键实现事实（守护锚定）：
//   - 比对只对「非 ip 来源」的维度做（mode='ip' 生成时已对齐，比对恒等无信息量）；
//   - integrity 保持纯同步本地计算：网络解析由调用方注入 opts.ipGeo，null ⇒ 跳过（不误报）；
//   - mode 全非 ip（custom/随机——恰是核心场景）时 resolveForProfile 返回 not-needed/geo=null，
//     体检必须走 resolveEgressGeo（同一实现，仅绕过 mode 前置）。
//
// 守护分层：
//   A 比对逻辑（离线真实执行 runIntegrityCheck，注入 geo 夹具）
//   B resolveEgressGeo（依赖注入离线执行：总是解析、缓存、失败语义）
//   C 接线（browserManager 启动路径 / index.js 按需端点传 ipGeo；模板自检保持离线）
//   D haversine 数学正确性

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_ROOT = path.join(os.tmpdir(), 'c195-guard-' + process.pid);
fs.mkdirSync(TMP_ROOT, { recursive: true });
process.env.FPB_DATA_DIR = TMP_ROOT;

const integrity = require('../integrity');
const ipGeo = require('../fp/ipGeo');

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function eq(name, a, b) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function has(name, s, sub) { ok(name, typeof s === 'string' && s.includes(sub), 'missing=' + sub + ' got=' + String(s).slice(0, 140)); }

const GEO_DE = {
  ip: '198.51.100.9', country: 'Germany', countryCode: 'DE', city: 'Berlin', region: 'Berlin',
  timezone: 'Europe/Berlin', offset: 60, lat: 52.52, lng: 13.4, language: 'de-DE', isp: 'x', org: 'x',
};

function mkProfile(over) {
  return Object.assign({
    id: 'p-c195', name: 'c195', os: 'windows', browser: 'chrome',
    seed: 's-c195', proxyMode: 'none', fingerprintOverride: {}, fingerprint: null,
  }, over);
}

function mkFp(over) {
  return Object.assign({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.73 Safari/537.36',
    timezone: 'Europe/Berlin', timezoneMode: 'custom',
    language: 'de-DE', languageMode: 'custom',
    geolocation: { mode: 'custom', lat: 52.52, lng: 13.4, accuracy: 100 },
  }, over);
}

// 只取第 7 项（出口↔指纹）的 network 结果，排除 proxy 配置检查的干扰
function egRows(report) {
  return report.results.filter((r) => r.area === 'network' && (
    r.msg.includes('出口 IP ↔ 指纹一致性') || r.msg.includes('出口 IP 地理未解析')
    || r.msg.includes('均为「基于 IP」') || r.msg.includes('与出口 IP')
  ));
}

let calls = null;
function stub(over) {
  const o = over || {};
  calls = { egress: 0, proxyEgress: 0, lookup: 0 };
  ipGeo.__setDepsForTest({
    getEgressIp: async () => { calls.egress++; if (o.egressThrows) throw new Error(o.egressThrows); return '203.0.113.7'; },
    getProxyEgressGeo: async () => { calls.proxyEgress++; if (o.proxyThrows) throw new Error(o.proxyThrows); return { ip: '198.51.100.9', geo: Object.assign({}, GEO_DE) }; },
    lookupIp: async (ip) => { calls.lookup++; if (o.lookupThrows) throw new Error(o.lookupThrows); return Object.assign({ ip }, GEO_DE); },
  });
  ipGeo.__clearCacheForTest();
}

(async () => {
  console.log('=== C195 出口 IP ↔ 指纹一致性体检守护 ===');

  // ---------------- A 比对逻辑（离线真实执行）----------------
  console.log('\n--- A 比对逻辑 ---');
  const P = mkProfile();

  // A1: ipGeo=null ⇒ 跳过（note，不误报）
  let rep = integrity.runIntegrityCheck(P, { fp: mkFp(), ipGeo: null });
  let rows = egRows(rep);
  ok('A1 ipGeo 缺失 ⇒ note 跳过', rows.length === 1 && rows[0].ok === true && rows[0].msg.includes('出口 IP 地理未解析'),
    JSON.stringify(rows.map(r => r.msg)));

  // A2: 三维度全 mode=ip ⇒ 跳过（生成时已对齐）
  rep = integrity.runIntegrityCheck(P, {
    fp: mkFp({ timezoneMode: 'ip', languageMode: 'ip', geolocation: { mode: 'ip', lat: 52.52, lng: 13.4, accuracy: 100 } }),
    ipGeo: GEO_DE,
  });
  rows = egRows(rep);
  ok('A2 全 mode=ip ⇒ 跳过比对', rows.length === 1 && rows[0].ok === true && rows[0].msg.includes('均为「基于 IP」'),
    JSON.stringify(rows.map(r => r.msg)));

  // A3: 时区矛盾（custom America/Los_Angeles vs 出口 Berlin）
  rep = integrity.runIntegrityCheck(P, { fp: mkFp({ timezone: 'America/Los_Angeles' }), ipGeo: GEO_DE });
  rows = rep.results.filter((r) => r.area === 'network' && r.msg.includes('时区与出口 IP 地理不一致'));
  ok('A3 时区矛盾 ⇒ warn', rows.length === 1 && rows[0].ok === false, JSON.stringify(rows.map(r => r.msg)));
  has('A3b warn 含出口应为的时区', rows[0] && rows[0].msg, 'Europe/Berlin');

  // A4: 时区一致（custom 恰好等于出口）⇒ 无 warn，PASS
  rep = integrity.runIntegrityCheck(P, { fp: mkFp(), ipGeo: GEO_DE });
  rows = egRows(rep);
  ok('A4 全一致 ⇒ PASS 无矛盾', rows.length === 1 && rows[0].ok === true && rows[0].msg.includes('PASS'),
    JSON.stringify(rows.map(r => r.msg)));

  // A5: mode=ip 时区（已对齐）+ custom 语言矛盾 ⇒ 只报语言
  rep = integrity.runIntegrityCheck(P, {
    fp: mkFp({ timezoneMode: 'ip', language: 'en-US' }),
    ipGeo: GEO_DE,
  });
  ok('A5 mode=ip 时区不比对', rep.results.every((r) => !(r.area === 'network' && r.msg.includes('时区与出口 IP 地理不一致'))));
  rows = rep.results.filter((r) => r.area === 'network' && r.msg.includes('语言与出口 IP 地区不一致'));
  ok('A5b custom 语言矛盾 ⇒ warn', rows.length === 1 && rows[0].ok === false, JSON.stringify(rows.map(r => r.msg)));

  // A6: 语言主子标签——en-US vs de-DE 矛盾；en-US vs en-GB 不矛盾
  rep = integrity.runIntegrityCheck(P, { fp: mkFp({ language: 'en-US' }), ipGeo: GEO_DE });
  ok('A6 主子标签矛盾 ⇒ warn', rep.results.some((r) => r.area === 'network' && r.msg.includes('语言与出口 IP 地区不一致')));
  const GEO_GB = Object.assign({}, GEO_DE, { country: 'United Kingdom', city: 'London', language: 'en-GB', timezone: 'Europe/London' });
  rep = integrity.runIntegrityCheck(P, { fp: mkFp({ timezone: 'Europe/London', language: 'en-US' }), ipGeo: GEO_GB });
  ok('A6b 同主子标签（en-US vs en-GB）⇒ 不 warn',
    rep.results.every((r) => !(r.area === 'network' && r.msg.includes('语言与出口 IP 地区不一致'))));

  // A7: 坐标距离——Berlin↔Berlin 无 warn；custom 坐标 New York vs 出口 Berlin ⇒ warn
  rep = integrity.runIntegrityCheck(P, { fp: mkFp({ geolocation: { mode: 'custom', lat: 40.71, lng: -74.01, accuracy: 100 } }), ipGeo: GEO_DE });
  rows = rep.results.filter((r) => r.area === 'network' && r.msg.includes('地理位置坐标距出口'));
  ok('A7 坐标 >500km ⇒ warn', rows.length === 1 && rows[0].ok === false, JSON.stringify(rows.map(r => r.msg)));
  has('A7b warn 含距离 km', rows[0] && rows[0].msg, 'km');
  rep = integrity.runIntegrityCheck(P, {
    fp: mkFp({ geolocation: { mode: 'custom', lat: 53.55, lng: 9.99, accuracy: 100 } }), // Hamburg
    ipGeo: GEO_DE,
  });
  ok('A7c Hamburg↔Berlin ≈255km ⇒ 无坐标 warn',
    rep.results.every((r) => !(r.area === 'network' && r.msg.includes('地理位置坐标距出口'))));

  // A8: geolocation=block ⇒ 不比对坐标（lat/lng=0 无语义）
  rep = integrity.runIntegrityCheck(P, {
    fp: mkFp({ geolocation: { mode: 'block', lat: 0, lng: 0, accuracy: 0 } }),
    ipGeo: GEO_DE,
  });
  ok('A8 block 模式 ⇒ 不比对坐标',
    rep.results.every((r) => !(r.area === 'network' && r.msg.includes('地理位置坐标距出口'))));

  // A9: 三矛盾齐发 ⇒ 3 条 warn + summary.network=WARNING + pass=false
  rep = integrity.runIntegrityCheck(P, {
    fp: mkFp({
      timezone: 'America/Los_Angeles', language: 'zh-CN',
      geolocation: { mode: 'custom', lat: 40.71, lng: -74.01, accuracy: 100 },
    }),
    ipGeo: GEO_DE,
  });
  const warns = rep.results.filter((r) => r.area === 'network' && !r.ok && (
    r.msg.includes('与出口 IP 地理不一致') || r.msg.includes('与出口 IP 地区不一致') || r.msg.includes('地理位置坐标距出口')));
  eq('A9 三矛盾 ⇒ 3 条 warn', warns.length, 3);
  eq('A9b summary.network=WARNING', rep.summary.network, 'WARNING');
  eq('A9c report.pass=false（WARNING 语义）', rep.pass, false);

  // A10: 全一致 ⇒ summary.network=OK
  rep = integrity.runIntegrityCheck(P, { fp: mkFp(), ipGeo: GEO_DE });
  eq('A10 全一致 ⇒ summary.network=OK', rep.summary.network, 'OK');

  // ---------------- B resolveEgressGeo（体检入口）----------------
  console.log('\n--- B resolveEgressGeo ---');
  const ALL_CUSTOM = { timezoneMode: 'custom', languageMode: 'custom', geolocation: { mode: 'custom' } };

  // B1: mode 全非 ip ⇒ resolveForProfile 返回 not-needed（对照），resolveEgressGeo 必须给 geo
  stub();
  let r = await ipGeo.resolveForProfile(mkProfile({ fingerprintOverride: ALL_CUSTOM }), null);
  eq('B1 对照：resolveForProfile 全非 ip ⇒ not-needed', r.status, 'not-needed');
  ok('B1b 对照：零网络调用', calls.egress === 0 && calls.proxyEgress === 0 && calls.lookup === 0, JSON.stringify(calls));
  r = await ipGeo.resolveEgressGeo(null, { strict: false, cache: true });
  eq('B1c resolveEgressGeo ⇒ status=ok', r.status, 'ok');
  ok('B1d geo 完整（含 timezone/language/lat/lng）',
    r.geo && r.geo.timezone === 'Europe/Berlin' && r.geo.language === 'de-DE' && Number.isFinite(r.geo.lat) && Number.isFinite(r.geo.lng),
    JSON.stringify(r.geo));

  // B2: 缓存复用——第二次调用零网络
  r = await ipGeo.resolveEgressGeo(null, { strict: false, cache: true });
  eq('B2 二次调用 ⇒ ok（缓存命中）', r.status, 'ok');
  ok('B2b 零新增网络调用', calls.egress === 1 && calls.lookup === 1, JSON.stringify(calls));

  // B3: 解析失败 ⇒ strict=false 不抛错、geo=null（体检跳过路径）
  stub({ egressThrows: 'boom' });
  r = await ipGeo.resolveEgressGeo(null, { strict: false, cache: true });
  eq('B3 失败 ⇒ status=unresolved', r.status, 'unresolved');
  eq('B3b geo=null', r.geo, null);
  ok('B3c 不抛错（体检可安全跳过）', true);

  // B4: 有代理时走 proxyEgress 分支
  stub();
  r = await ipGeo.resolveEgressGeo({ type: 'socks5', server: '1.2.3.4:1080' }, { strict: false, cache: true });
  eq('B4 代理形态 ⇒ ok', r.status, 'ok');
  eq('B4b 走 getProxyEgressGeo', calls.proxyEgress, 1);

  // ---------------- C 接线（静态形状断言）----------------
  console.log('\n--- C 接线 ---');
  const ROOT = path.join(__dirname, '..');
  const BM = fs.readFileSync(path.join(ROOT, 'browserManager.js'), 'utf8');
  const IDX = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const INTEG = fs.readFileSync(path.join(ROOT, 'integrity.js'), 'utf8');

  // C1: 启动路径体检传 ipGeo
  has('C1 browserManager 体检调用传 ipGeo', BM, 'runIntegrityCheck(profile, { fp, engineVersion: realVer, proxies, ipGeo: ipGeoForCheck })');
  has('C1b resolveIpGeoForIntegrity 已接线', BM, 'const ipGeoForCheck = await resolveIpGeoForIntegrity(profile, proxies, needsFreshIpGeo, ipGeo);');

  // C2: 体检解析必须走 resolveEgressGeo（防回归回 resolveForProfile 的 not-needed 陷阱）
  has('C2 体检解析用 resolveEgressGeo', BM, 'ipGeoResolve.resolveEgressGeo(proxySourceOf(profile, proxies), { strict: false, cache: true })');

  // C3: index.js 按需体检端点传 ipGeo 且补解析
  has('C3 index integrity 端点传 ipGeo', IDX, 'ipGeo: ipGeoForCheck');
  has('C3b 端点补解析用 resolveEgressGeo', IDX, 'ipGeoResolve.resolveEgressGeo(proxyForProfile, { strict: false, cache: true })');

  // C4: 模板自检保持离线（不传 ipGeo、不做网络）
  const tplIdx = IDX.slice(IDX.indexOf("templateRouter.get('/templates/:id/check'"));
  has('C4 模板自检注释保持「不做网络依赖」', tplIdx, '自检不做网络依赖');
  ok('C4b 模板自检 runIntegrityCheck 不传 ipGeo',
    tplIdx.includes('runIntegrityCheck(p, { fp, engineVersion, proxies: db.getProxies() })')
    && !tplIdx.includes('ipGeoForCheck'),
    '模板自检应保持 ipGeo=null 离线语义');

  // C5: integrity.js 契约与实现形状
  has('C5 opts 契约含 ipGeo', INTEG, 'opts: { fp, engineVersion, proxies, proxy, ipGeo }');
  has('C5b 比对跳过 mode=ip', INTEG, "fpMode.timezone !== 'ip'");
  has('C5c resolveEgressGeo 导出', fs.readFileSync(path.join(ROOT, 'fp', 'ipGeo.js'), 'utf8'), 'resolveEgressGeo,');

  // ---------------- D haversine 数学 ----------------
  console.log('\n--- D haversine ---');
  const dHH = integrity.haversineKm(52.52, 13.4, 53.55, 9.99); // Berlin↔Hamburg
  ok('D1 Berlin↔Hamburg ≈255km（±25）', Math.abs(dHH - 255) < 25, 'got=' + dHH.toFixed(1));
  const dNY = integrity.haversineKm(52.52, 13.4, 40.71, -74.01); // Berlin↔New York
  ok('D2 Berlin↔NewYork ≈6385km（±150）', Math.abs(dNY - 6385) < 150, 'got=' + dNY.toFixed(1));
  eq('D3 同点 ⇒ 0km', integrity.haversineKm(52.52, 13.4, 52.52, 13.4).toFixed(2), '0.00');

  console.log('\n========================================');
  console.log(`C195 守护: 通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) { console.log('FAILS:\n' + fails.join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
