'use strict';
// STEP 17 — 真实反检测站点验证（CAP 产品验证：工程测试通过 ≠ 产品验证通过）
// 站点：CreepJS（https://abrahamjuliot.github.io/creepjs/，静态 GitHub Pages，无 API key）+ Iphey（尽力探测）
// 验证矩阵（身份单元 = profile[id+seed]，seedFromProfile 含 id——「同形不同样」兜底，故稳定性用同 id 跨会话验证）：
//   A: Windows/Chrome seed='ad-a' override={Asia/Shanghai, zh-CN}（本机地理一致基线），启动两次（跨会话稳定性）
//   B: Windows/Chrome seed='ad-b' override={Europe/London, en-GB}（异号必须异指纹；UA/TZ 与本机 IP 不一致预期站点报 mismatch，如实记录）
// 断言（确定性，不依赖外网站点评分）：
//   T1 navigator.webdriver === false（全部）
//   T2 页内 Intl 时区 === override 指定时区；navigator.language === override 指定语言
//   T3 A 两次会话：CreepJS FP ID / UA / canvas 哈希 / webgl renderer / 时区 / 语言 完全一致（跨会话稳定）
//   T4 A 与 B：CreepJS FP ID 与 canvas 哈希必须不同（异号异指纹）
//   T5 CreepJS 页面渲染产出 FP ID（站点可达 + 指纹计算完成）
// 用法：node server/scripts/verify_antidetect_sites.js [--iphey] [--skip-creepjs]

const fs = require('fs');
const os = require('os');
const path = require('path');

const ARGS = new Set(process.argv.slice(2));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step17-'));
process.env.FPB_DATA_DIR = TMP; // 不污染生产 store；必须在 require db 之前

const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');

function strHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ s.charCodeAt(i)) >>> 0;
    h1 = (h1 * 16777619) >>> 0;
    h2 = (h2 + s.charCodeAt(i) * (i + 1)) >>> 0;
  }
  return h1.toString(16) + '-' + h2.toString(16);
}

const report = { at: new Date().toISOString(), profiles: {}, creepjs: {}, iphey: null, assertions: [], ok: false };
function assert(name, cond, detail) {
  report.assertions.push({ name, pass: !!cond, detail: detail === undefined ? null : detail });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail) + ']'));
  return !!cond;
}

function buildProfile(id, seed, osName, override) {
  const profile = {
    id, name: id, group: 'verify', tags: [], notes: '',
    seed, headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: osName, browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    lastSessionUrls: [], fingerprintOverride: override, createdAt: Date.now(),
  };
  const mergedOverride = { os: profile.os, browser: profile.browser, ...override };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), mergedOverride, null);
  return profile;
}

async function pageFingerprint(page) {
  return await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '16px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 100, 30);
    ctx.fillStyle = '#069';
    ctx.fillText('creepjs-verify-\u2713', 2, 2);
    const canvasData = c.toDataURL();
    let webglRenderer = null, webglVendor = null;
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      webglVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
      webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } catch (e) { /* webgl 不可用 */ }
    return {
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory || null,
      canvasHash: canvasData.length + ':' + canvasData.slice(-64),
      webglVendor, webglRenderer,
    };
  });
}

async function visitCreepjs(profile) {
  const session = await browserManager.launch(profile, null);
  const page = session.page;
  const out = { url: 'https://abrahamjuliot.github.io/creepjs/', rendered: false, text: '', fpId: null, fuzzy: null, headlessDetected: null, trustScore: null, lies: null, fp: null };
  try {
    await page.goto(out.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.trust-score, .score, #fingerprint-data, body', { timeout: 60000 });
    await page.waitForTimeout(20000); // CreepJS 全量指纹计算需 8~25 秒
    out.text = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 8000);
    out.rendered = out.text.length > 200;
    const mFp = out.text.match(/FP\s*ID:?\s*([a-f0-9]{16,})/i);
    const mFuzzy = out.text.match(/Fuzzy:?\s*([a-f0-9]{16,})/i);
    if (mFp) out.fpId = mFp[1];
    if (mFuzzy) out.fuzzy = mFuzzy[1];
    const mHead = out.text.match(/(\d+)%\s*headless/i);
    if (mHead) out.headlessDetected = Number(mHead[1]);
    const mTrust = out.text.match(/trust\s*score[^%\d]*(\d+(?:\.\d+)?)/i);
    const mLies = out.text.match(/(\d+)\s*lies/i);
    if (mTrust) out.trustScore = mTrust[1];
    if (mLies) out.lies = Number(mLies[1]);
    out.fp = await pageFingerprint(page);
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
  } finally {
    await browserManager.close(profile.id).catch(() => {});
  }
  return out;
}

async function visitIphey(profile) {
  const session = await browserManager.launch(profile, null);
  const page = session.page;
  const out = { url: 'https://iphey.com/', rendered: false, verdict: null, text: '' };
  try {
    await page.goto(out.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(25000); // SPA 检测流程较长
    out.text = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 6000);
    out.rendered = out.text.length > 100;
    if (/trust\s*worth/i.test(out.text) && /reliable|suspicious|low/i.test(out.text)) {
      const m = out.text.match(/(reliable|suspicious|low)/i);
      out.verdict = m ? m[1].toLowerCase() : null;
    }
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
  } finally {
    await browserManager.close(profile.id).catch(() => {});
  }
  return out;
}

(async () => {
  console.log('=== STEP 17 真实反检测站点验证（CreepJS' + (ARGS.has('--skip-creepjs') ? ' 跳过' : '') + (ARGS.has('--iphey') ? ' + Iphey' : '') + '） ===');
  console.log('数据目录: ' + TMP);

  const A = buildProfile('p17_a', 'ad-a', 'Windows', { timezone: 'Asia/Shanghai', language: 'zh-CN', timezoneMode: 'custom', languageMode: 'custom' });
  const B = buildProfile('p17_b', 'ad-b', 'Windows', { timezone: 'Europe/London', language: 'en-GB', timezoneMode: 'custom', languageMode: 'custom' });
  for (const p of [A, B]) db.upsertProfile(p);
  report.profiles = { A: A.fingerprint, B: B.fingerprint };

  if (!ARGS.has('--skip-creepjs')) {
    for (const [key, prof] of [['A-1st', A], ['B', B], ['A-2nd', A]]) {
      console.log('\n── CreepJS @ profile ' + key + ' (id=' + prof.id + ' seed=' + prof.seed + ') ──');
      const r = await visitCreepjs(prof);
      report.creepjs[key] = r;
      console.log('  rendered=' + r.rendered + ' fpId=' + (r.fpId || 'n/a').slice(0, 16) + ' headless%=' + r.headlessDetected + (r.error ? ' error=' + r.error : ''));
      if (r.fp) console.log('  tz=' + r.fp.timezone + ' lang=' + r.fp.language + ' webdriver=' + r.fp.webdriver + ' canvas=' + String(r.fp.canvasHash).slice(0, 18));
    }
    const fa = report.creepjs['A-1st'] && report.creepjs['A-1st'].fp, fc = report.creepjs['A-2nd'] && report.creepjs['A-2nd'].fp, fb = report.creepjs.B && report.creepjs.B.fp;
    const ra1 = report.creepjs['A-1st'] || {}, ra2 = report.creepjs['A-2nd'] || {}, rb = report.creepjs.B || {};

    console.log('\n── 确定性断言 ──');
    if (fa && fc) {
      assert('T3a 同profile 跨会话 CreepJS FP ID 一致', ra1.fpId && ra1.fpId === ra2.fpId, { a: ra1.fpId, c: ra2.fpId });
      assert('T3b 同profile 跨会话 userAgent 一致', fa.userAgent === fc.userAgent);
      assert('T3c 同profile 跨会话 canvas 哈希一致', fa.canvasHash === fc.canvasHash, { a: fa.canvasHash, c: fc.canvasHash });
      assert('T3d 同profile 跨会话 webgl renderer 一致', fa.webglRenderer === fc.webglRenderer);
      assert('T3e 同profile 跨会话 时区/语言一致', fa.timezone === fc.timezone && fa.language === fc.language);
    } else {
      assert('T3 跨会话一致性（A 两次页面指纹可用）', false, { a1Available: !!fa, a2Available: !!fc });
    }
    if (fa && fb) {
      assert('T4a 异号 CreepJS FP ID 不同', ra1.fpId && rb.fpId && ra1.fpId !== rb.fpId);
      assert('T4b 异号 canvas 哈希不同（噪声生效）', fa.canvasHash !== fb.canvasHash);
      assert('T2b B 页内时区=Europe/London', fb.timezone === 'Europe/London', fb.timezone);
      assert('T2c B 页内语言=en-GB', fb.language === 'en-GB', fb.language);
    } else {
      assert('T2/T4 B 页面指纹可用', false, { bAvailable: !!fb });
    }
    if (fa) {
      assert('T1a A navigator.webdriver=false', fa.webdriver === false, fa.webdriver);
      assert('T2a A 页内时区=Asia/Shanghai', fa.timezone === 'Asia/Shanghai', fa.timezone);
      assert('T2d A 页内语言=zh-CN', fa.language === 'zh-CN', fa.language);
    }
    assert('T5 CreepJS 页面渲染产出 FP ID', ['A-1st', 'B', 'A-2nd'].some((k) => report.creepjs[k] && report.creepjs[k].fpId));
  }

  if (ARGS.has('--iphey')) {
    console.log('\n── Iphey @ profile A（尽力探测，失败不阻塞） ──');
    report.iphey = await visitIphey(A);
    console.log('  rendered=' + report.iphey.rendered + ' verdict=' + report.iphey.verdict + (report.iphey.error ? ' error=' + report.iphey.error : ''));
  }

  report.ok = report.assertions.length > 0 && report.assertions.every((x) => x.pass);
  const outPath = path.join(__dirname, '..', '..', '.benchmark', 'step17_antidetect_' + Date.now() + '.json');
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
