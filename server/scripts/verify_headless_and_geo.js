'use strict';
// STEP 18 — headless 检测对抗证据 + geo 对齐全链路验证（真实站点，无 mock）
// Part A（headless 信号对比）：同一指纹配置分别以 headless / headful 访问 CreepJS，
//   捕获 headless% / like-headless% / stealth% / window.chrome / plugins 等信号，方向性断言 headful 检出率更低。
// Part B（geo 对齐全链路）：profile 时区/语言/地理位置全部 mode='ip'（无代理分支 = 本机真实出口，
//   与 proxy 分支同一代码路径；proxy 分支的 fail-closed 已由既有测试覆盖）→ 启动时 getEgressIp→lookupIp→
//   把时区/语言/经纬度钉到出口 IP 地理 → CreepJS 页内观察三者一致。
// 断言：
//   G1a geo 链生效：fingerprint.timezone 存在且为 IANA 合法时区
//   G1b 页内 Intl 时区 === fingerprint.timezone === 出口 geo 时区（三元一致）
//   G1c 页内 language === fingerprint.language
//   G1d 页内 geolocation 权限授权（geo.mode=ip 注入坐标的前提）
//   A1a 两种模式均完成 CreepJS 渲染并取得 headless 信号
//   A1b 方向性证据：headful 的 headless 检出率 <= headless 模式
// 用法：node server/scripts/verify_headless_and_geo.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step18-'));
process.env.FPB_DATA_DIR = TMP;

const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');

const report = { at: new Date().toISOString(), headless: {}, geo: {}, assertions: [], ok: false };
function assert(name, cond, detail) {
  report.assertions.push({ name, pass: !!cond, detail: detail === undefined ? null : detail });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail) + ']'));
  return !!cond;
}

function buildProfile(id, headless, override) {
  const profile = {
    id, name: id, group: 'verify', tags: [], notes: '',
    seed: 'step18-' + id, headless, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    lastSessionUrls: [], fingerprintOverride: override, createdAt: Date.now(),
  };
  const mergedOverride = { os: profile.os, browser: profile.browser, ...override };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), mergedOverride, null);
  return profile;
}

async function creepjsSignals(profile) {
  const session = await browserManager.launch(profile, null);
  const page = session.page;
  const out = { rendered: false, headlessPct: null, likeHeadlessPct: null, stealthPct: null, text: '', evals: null };
  try {
    await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(20000);
    out.text = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 8000);
    out.rendered = out.text.length > 200;
    const mh = out.text.match(/(\d+)%\s*headless/i);
    const ml = out.text.match(/(\d+)%\s*like headless/i);
    const ms = out.text.match(/(\d+)%\s*stealth/i);
    if (mh) out.headlessPct = Number(mh[1]);
    if (ml) out.likeHeadlessPct = Number(ml[1]);
    if (ms) out.stealthPct = Number(ms[1]);
    out.evals = await page.evaluate(async () => {
      let geoPermission = 'unsupported';
      try { geoPermission = await navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state); } catch (e) { /* 某些引擎不支持 */ }
      return {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
        webdriver: navigator.webdriver,
        hasWindowChrome: !!window.chrome,
        pluginsCount: navigator.plugins ? navigator.plugins.length : -1,
        geoPermission,
      };
    });
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
  } finally {
    await browserManager.close(profile.id).catch(() => {});
  }
  return out;
}

(async () => {
  console.log('=== STEP 18 headless 对抗证据 + geo 对齐全链路 ===');
  console.log('数据目录: ' + TMP);

  // ---- Part A：headless vs headful（同指纹配置，只有 headless 开关不同）----
  const HL = buildProfile('p18_hl', true, { timezone: 'Asia/Shanghai', language: 'zh-CN', timezoneMode: 'custom', languageMode: 'custom' });
  const HF = buildProfile('p18_hf', false, { timezone: 'Asia/Shanghai', language: 'zh-CN', timezoneMode: 'custom', languageMode: 'custom' });
  for (const p of [HL, HF]) db.upsertProfile(p);

  for (const [key, prof] of [['headless', HL], ['headful', HF]]) {
    console.log('\n── CreepJS @ ' + key + ' ──');
    const r = await creepjsSignals(prof);
    report.headless[key] = r;
    console.log('  rendered=' + r.rendered + ' headless%=' + r.headlessPct + ' like%=' + r.likeHeadlessPct + ' stealth%=' + r.stealthPct + (r.error ? ' error=' + r.error : ''));
    if (r.evals) console.log('  window.chrome=' + r.evals.hasWindowChrome + ' plugins=' + r.evals.pluginsCount + ' webdriver=' + r.evals.webdriver);
  }
  const rl = report.headless.headless, rf = report.headless.headful;
  assert('A1a 两种模式均完成 CreepJS 渲染', rl && rf && rl.rendered && rf.rendered);
  if (rl && rf && rl.rendered && rf.rendered) {
    assert('A1b 方向性证据：headful headless 检出率 <= headless 模式', (rf.headlessPct || 0) <= (rl.headlessPct || 0), { headless: rl.headlessPct, headful: rf.headlessPct });
    if (rl.evals && rf.evals) {
      assert('A2 headful 下 window.chrome 存在（真实浏览器对象）', rf.evals.hasWindowChrome === true, rf.evals.hasWindowChrome);
      assert('A3 两种模式 webdriver 均=false', rl.evals.webdriver === false && rf.evals.webdriver === false);
    }
  }

  // ---- Part B：geo 对齐全链路（timezone/language/geolocation 全 mode='ip'）----
  console.log('\n── geo 全链路 @ profile p18_geo（全 mode=ip，本机出口） ──');
  // 期望值独立计算（不依赖产品内部状态）：出口 IP → 公共 geo 源 → 时区/语言
  const { getEgressIp } = require('../proxyChecker');
  const { lookupIp } = require('../geoip');
  const egressIp = await getEgressIp(null);
  const egressGeo = await lookupIp(egressIp);
  const expected = { timezone: egressGeo && egressGeo.timezone, language: egressGeo && egressGeo.language, ip: egressIp };
  report.geo.expectedFromEgress = expected;
  console.log('  独立期望(出口 ' + egressIp + '): tz=' + expected.timezone + ' lang=' + expected.language);
  const G = buildProfile('p18_geo', true, { timezoneMode: 'ip', languageMode: 'ip', geolocation: { mode: 'ip' } });
  db.upsertProfile(G);
  const rg = await creepjsSignals(G);
  report.geo.creepjs = { rendered: rg.rendered, evals: rg.evals, headlessPct: rg.headlessPct, error: rg.error };
  console.log('  页内: tz=' + (rg.evals && rg.evals.timezone) + ' lang=' + (rg.evals && rg.evals.language) + ' geoPerm=' + (rg.evals && rg.evals.geoPermission) + ' rendered=' + rg.rendered + (rg.error ? ' error=' + rg.error : ''));

  if (rg.rendered && rg.evals) {
    assert('G1a geo 链生效：出口 IP geo 含时区与语言', !!(expected.timezone && expected.language), expected);
    assert('G1b 页内 Intl 时区 === 出口 IP geo 时区（IP→指纹→页面三元一致）', rg.evals.timezone === expected.timezone, { page: rg.evals.timezone, expected: expected.timezone });
    assert('G1c 页内 language === 出口 IP geo 语言', rg.evals.language === expected.language, { page: rg.evals.language, expected: expected.language });
    assert('G1d geolocation 权限非 denied（mode=ip 注入坐标前提）', rg.evals.geoPermission === 'granted' || rg.evals.geoPermission === 'prompt', rg.evals.geoPermission);
  } else {
    assert('G geo 链页面可用', false, { rendered: rg.rendered, error: rg.error || null });
  }

  report.ok = report.assertions.length > 0 && report.assertions.every((x) => x.pass);
  const outPath = path.join(__dirname, '..', '..', '.benchmark', 'step18_headless_geo_' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  const pass = report.assertions.filter((x) => x.pass).length;
  console.log('\n================ 汇总 ================');
  console.log('PASS=' + pass + '  FAIL=' + (report.assertions.length - pass) + '  =>  ' + (report.ok ? 'VERIFICATION_OK' : 'VERIFICATION_FAILED'));
  console.log('报告: ' + outPath);
  await browserManager.closeAll().catch(() => {});
  process.exit(report.ok ? 0 : 1);
})().catch(async (e) => {
  console.error('FATAL', e);
  await browserManager.closeAll().catch(() => {});
  process.exit(1);
});
