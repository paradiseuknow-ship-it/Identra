'use strict';
// C193 守护：「基于 IP」只有一份实现，且预览与启动语义一致。
//
// 背景（2026-10-30 用户实测）：新建配置时时区/市区/语言都选「基于 IP」，
// 点「生成新指纹」右侧概要却随机显示各国（每次换种子国家都变）。
// 根因：预览路径 index.js.resolveIpGeo 在 **proxy 为空时直接 return null**，
// 于是 generateFingerprint 走指纹池随机；而启动路径无代理时会解析本机出口、失败则阻断启动。
// 同一语义两套行为 ⇒ 预览 ≠ 运行态；而且用户完全看不出「基于 IP 其实没生效」。
//
// 守护分两层：
//   A ipModesOf 纯函数：哪些维度要求基于 IP；
//   B resolveForOverride 全分支（依赖注入，离线真实执行）：无代理也必须解析、失败必须可见、
//     启动路径 strict 必须抛错阻断、缓存只缓存成功。
//   C 接线：index.js / browserManager 都必须委托同一实现，且 unresolved 不得覆盖库里的指纹。

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_ROOT = path.join(os.tmpdir(), 'c193-guard-' + process.pid);
fs.mkdirSync(TMP_ROOT, { recursive: true });
process.env.FPB_DATA_DIR = TMP_ROOT;

const ipGeo = require('../fp/ipGeo');

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function eq(name, a, b) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function has(name, s, sub) { ok(name, typeof s === 'string' && s.includes(sub), 'missing=' + sub + ' got=' + String(s).slice(0, 120)); }

const GEO_DE = {
  country: 'Germany', countryCode: 'DE', city: 'Berlin', region: 'Berlin',
  timezone: 'Europe/Berlin', offset: 60, lat: 52.52, lng: 13.4, language: 'de-DE', isp: 'x', org: 'x',
};

let calls = null;
// 依赖注入夹具：每个用例重置，统计真实调用次数（「零网络」这类断言靠它）
function stub(over) {
  const o = over || {};
  calls = { egress: 0, proxyEgress: 0, lookup: 0, egressArgs: [] };
  ipGeo.__setDepsForTest({
    getEgressIp: async (proxy) => {
      calls.egress++; calls.egressArgs.push(proxy);
      if (o.egressThrows) throw new Error(o.egressThrows);
      return o.ip === undefined ? '203.0.113.7' : o.ip;
    },
    getProxyEgressGeo: async () => {
      calls.proxyEgress++;
      if (o.proxyThrows) throw new Error(o.proxyThrows);
      return o.proxyResult === undefined ? { ip: '198.51.100.9', geo: Object.assign({ ip: '198.51.100.9' }, GEO_DE) } : o.proxyResult;
    },
    lookupIp: async (ip) => {
      calls.lookup++;
      if (o.lookupThrows) throw new Error(o.lookupThrows);
      if (o.lookupResult === null) return null;
      return o.lookupResult === undefined ? Object.assign({ ip }, GEO_DE) : o.lookupResult;
    },
  });
  ipGeo.__clearCacheForTest();
}

const ALL_IP = { timezoneMode: 'ip', languageMode: 'ip', geolocation: { mode: 'ip' } };
const ALL_CUSTOM = { timezoneMode: 'custom', languageMode: 'custom', geolocation: { mode: 'custom' } };

(async () => {
  console.log('=== C193 「基于 IP」单一实现守护 ===');

  // ---------------- A ipModesOf ----------------
  console.log('\n--- A ipModesOf ---');
  let m = ipGeo.ipModesOf(ALL_IP);
  ok('A1 三维度全 ip ⇒ any=true', m.any && m.timezone && m.language && m.geolocation, JSON.stringify(m));
  m = ipGeo.ipModesOf({ languageMode: 'ip' });
  ok('A2 仅语言为 ip ⇒ 仍需解析（any=true）', m.any && !m.timezone && m.language && !m.geolocation, JSON.stringify(m));
  m = ipGeo.ipModesOf(ALL_CUSTOM);
  ok('A3 全自定义 ⇒ any=false（零网络）', m.any === false, JSON.stringify(m));
  m = ipGeo.ipModesOf({ geolocation: { mode: 'block' } });
  ok('A4 地理位置=禁止 ⇒ 不算 ip 模式', m.any === false, JSON.stringify(m));
  m = ipGeo.ipModesOf(undefined);
  ok('A5 override 缺失不抛错', m.any === false, JSON.stringify(m));

  // ---------------- B resolveForOverride ----------------
  console.log('\n--- B 解析分支（依赖注入真实执行）---');
  stub();
  let r = await ipGeo.resolveForOverride(ALL_CUSTOM, null);
  eq('B1 非 ip 模式 ⇒ status=not-needed', r.status, 'not-needed');
  ok('B1b 非 ip 模式 ⇒ 零网络调用', calls.egress === 0 && calls.proxyEgress === 0 && calls.lookup === 0, JSON.stringify(calls));

  stub();
  r = await ipGeo.resolveForOverride(ALL_IP, null);
  eq('B2 无代理 ⇒ 必须直连解析本机出口（旧实现此处直接返回 null）', r.status, 'ok');
  ok('B2b 无代理 ⇒ 真实调用 getEgressIp(null)', calls.egress === 1 && calls.egressArgs[0] === null, JSON.stringify(calls));
  ok('B2c 返回的 geo 带出口 IP', !!(r.geo && r.geo.ip === '203.0.113.7'), JSON.stringify(r.geo));

  stub({ egressThrows: '所有出口 IP 探测源均不可达' });
  r = await ipGeo.resolveForOverride(ALL_IP, null);
  eq('B3 无代理且解析失败 ⇒ status=unresolved', r.status, 'unresolved');
  has('B3b 失败原因可见（不是静默 null）', r.error, '未配置代理且无法解析本机出口 IP');
  has('B3c 错误里带底层原因', r.error, '所有出口 IP 探测源均不可达');

  stub({ lookupResult: null });
  r = await ipGeo.resolveForOverride(ALL_IP, null);
  eq('B4 出口 IP 拿到但 geo 库为空 ⇒ unresolved', r.status, 'unresolved');

  stub();
  r = await ipGeo.resolveForOverride(ALL_IP, { type: 'socks5', server: '1.2.3.4:1080' });
  eq('B5 有代理 ⇒ 走代理出口解析', r.status, 'ok');
  ok('B5b 有代理时绝不直连取本机 IP', calls.proxyEgress === 1 && calls.egress === 0, JSON.stringify(calls));

  stub({ proxyThrows: 'connect ECONNREFUSED' });
  r = await ipGeo.resolveForOverride(ALL_IP, { type: 'socks5', server: '1.2.3.4:1080' });
  eq('B6 代理不可用（预览）⇒ unresolved 不抛错', r.status, 'unresolved');
  has('B6b 文案指向代理出口解析失败', r.error, '代理出口 IP 解析失败');
  has('B6c 文案明确阻止启动', r.error, '已阻止启动');

  stub({ proxyThrows: 'connect ECONNREFUSED' });
  let threw = null;
  try { await ipGeo.resolveForOverride(ALL_IP, { type: 'socks5', server: '1.2.3.4:1080' }, { strict: true }); }
  catch (e) { threw = e; }
  ok('B7 启动路径 strict=true ⇒ 必须抛错阻断', !!threw, 'did not throw');
  has('B7b 阻断文案逐字沿用', threw && threw.message, '已阻止启动，避免指纹回退成本机直连导致泄露');

  stub({ proxyResult: { ip: null, geo: null } });
  threw = null;
  try { await ipGeo.resolveForOverride(ALL_IP, { type: 'http', server: '1.2.3.4:8080' }, { strict: true }); }
  catch (e) { threw = e; }
  has('B8 有代理但拿不到出口 IP ⇒ strict 抛「无法获取代理的公网出口地址」', threw && threw.message, '无法获取代理的公网出口地址');

  stub({ proxyResult: { ip: '198.51.100.9', geo: null } });
  threw = null;
  try { await ipGeo.resolveForOverride(ALL_IP, { type: 'http', server: '1.2.3.4:8080' }, { strict: true }); }
  catch (e) { threw = e; }
  has('B9 有 IP 但 geo 为空 ⇒ strict 抛「地理位置库未返回」', threw && threw.message, '地理位置库未返回时区/语言/经纬度');

  stub();
  await ipGeo.resolveForOverride(ALL_IP, null);
  const afterFirst = Object.assign({}, calls);
  r = await ipGeo.resolveForOverride(ALL_IP, null);
  ok('B10 成功结果命中缓存（第二次零网络）', calls.egress === afterFirst.egress, JSON.stringify(calls));
  ok('B10b 缓存命中标记可见', r.cached === true, JSON.stringify(r));

  stub({ egressThrows: 'boom' });
  await ipGeo.resolveForOverride(ALL_IP, null);
  const afterFail = calls.egress;
  await ipGeo.resolveForOverride(ALL_IP, null);
  ok('B11 失败不缓存（瞬时故障不被冻结）', calls.egress === afterFail + 1, 'egress=' + calls.egress + ' expect=' + (afterFail + 1));

  stub();
  await ipGeo.resolveForOverride(ALL_IP, { type: 'socks5', server: '1.2.3.4:1080' });
  const afterProxyA = calls.proxyEgress;
  await ipGeo.resolveForOverride(ALL_IP, { type: 'socks5', server: '1.2.3.4:1081' });
  ok('B12 换代理 ⇒ 缓存 key 变化，必须重新解析', calls.proxyEgress === afterProxyA + 1, 'proxyEgress=' + calls.proxyEgress);

  stub();
  r = await ipGeo.resolveForOverride({ languageMode: 'ip' }, null);
  eq('B13 仅语言为 ip ⇒ 也解析（不是只有全 ip 才解析）', r.status, 'ok');

  ipGeo.__resetDepsForTest();
  ipGeo.__clearCacheForTest();

  // ---------------- C 接线 ----------------
  console.log('\n--- C 接线（单一实现）---');
  const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  ok('C1 预览/保存路径委托 ipGeoResolve.resolveForOverride', idxSrc.includes('ipGeoResolve.resolveForOverride('), 'missing');
  ok('C2 index.js 不再自带「有代理才解析」的旧分支',
    !/if \(proxy\) \{\s*const r = await checkProxyGeo\(proxy\);\s*return r\.geo \|\| null;/.test(idxSrc), '旧分支仍在');
  ok('C3 预览接口回传 ipGeoStatus', /ipGeoStatus:\s*\{\s*status:\s*geoState\.status/.test(idxSrc), 'missing');
  ok('C4 unresolved 时不覆盖已有指纹（GET/PUT 两处都要）',
    (idxSrc.match(/geoState\.status === 'ok' \|\| geoState\.status === 'not-needed'/g) || []).length >= 2, 'count<2');
  const bmSrc = fs.readFileSync(path.join(__dirname, '..', 'browserManager.js'), 'utf8');
  ok('C5 启动路径委托 resolveForProfile(strict:true)',
    /resolveForProfile\(profile,\s*proxy,\s*\{\s*strict:\s*true/.test(bmSrc), 'missing');
  ok('C6 browserManager 不再内联「无代理则直连解析」的重复实现',
    !bmSrc.includes('未配置代理且无法解析本机出口 IP'), '重复文案仍在（说明还有第二份实现）');
  const edSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'components', 'ProfileEditor.jsx'), 'utf8');
  ok('C7 概要面板显示未解析告警', edSrc.includes('「基于 IP」未解析到出口位置'), 'missing');
  ok('C8 未解析时逐项标注指纹池随机', edSrc.includes('指纹池随机'), 'missing');

  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 2 }); } catch (e) {}

  console.log('\n=== 结果: PASS=' + pass + ' FAIL=' + fail + ' ===');
  if (fail) { console.log('失败项:\n  ' + fails.join('\n  ')); process.exitCode = 1; }
})();
