'use strict';
// STEP 20 — hidden-headful 模式产品验证（CAP hidden-headful：有界面但窗口移出屏幕）
// 背景（STEP 19 边界）：严格 headless 信号的驱动层 webDriverIsOn + hasHeadlessWorkerUA 来自
// Worker/UA-CH 层，Playwright addInitScript 不可达。hidden-headful 用真实 headful Chrome 进程
// （UA/Worker/UA-CH 全真）+ --window-position=-32000,-32000 离屏，从根上消除该层信号。
// 断言（确定性）：
//   T1 CreepJS 渲染产出 FP ID（站点可达 + 指纹计算完成）
//   T2 headless% <= 33（headful 等效基线，STEP 18 实证 headful=33% / headless=67%）
//   T3 navigator.webdriver === false
//   T4 离屏窗口截图可用：page.screenshot 返回 >30KB buffer（off-screen 非黑屏/非空白）
//   T5 同 profile 跨会话 CreepJS FP ID 一致（hidden-headful 不破坏指纹稳定性）
//   T6 window.screenX <= -20000（hiddenWindow 启动参数确实生效，窗口已离屏）
//   T7 document.visibilityState === 'visible'（--disable-backgrounding-occluded-windows 生效，
//      离屏窗口内页面照常渲染，rAF/定时器不被节流）
//   T8 页内 UA 不含 "Headless"（UA/UA-CH 层全真）
// 用法：node server/scripts/verify_hidden_headful.js [--baseline]（--baseline 额外跑一次普通 headful 对照，仅记录）

const fs = require('fs');
const os = require('os');
const path = require('path');

const ARGS = new Set(process.argv.slice(2));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step20-'));
process.env.FPB_DATA_DIR = TMP; // 不污染生产 store；必须在 require db 之前

const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');

const report = { at: new Date().toISOString(), mode: 'hidden-headful', visits: {}, baseline: null, assertions: [], ok: false };
function assert(name, cond, detail) {
  report.assertions.push({ name, pass: !!cond, detail: detail === undefined ? null : detail });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail) + ']'));
  return !!cond;
}

function buildProfile(id, seed, opts) {
  const o = opts || {};
  const profile = {
    id, name: id, group: 'verify', tags: [], notes: '',
    seed, headless: o.hiddenWindow ? false : (o.headless !== undefined ? o.headless : false),
    proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: {
      restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10,
      clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false,
      hiddenWindow: o.hiddenWindow === true,
    },
    lastSessionUrls: [], fingerprintOverride: { timezone: 'Asia/Shanghai', language: 'zh-CN', timezoneMode: 'custom', languageMode: 'custom' },
    createdAt: Date.now(),
  };
  const mergedOverride = { os: profile.os, browser: profile.browser, ...profile.fingerprintOverride };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), mergedOverride, null);
  return profile;
}

async function visitCreepjs(profile, tag) {
  const session = await browserManager.launch(profile, null);
  const page = session.page;
  const out = { url: 'https://abrahamjuliot.github.io/creepjs/', rendered: false, text: '', fpId: null, headlessDetected: null, fp: null, screenshotKB: null, screenX: null, visibilityState: null };
  try {
    await page.goto(out.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.trust-score, .score, #fingerprint-data, body', { timeout: 60000 });
    await page.waitForTimeout(20000); // CreepJS 全量指纹计算需 8~25 秒

    // T4 截图可用性：hidden-headful 核心卖点——离屏窗口也能产出真实渲染截图
    const shot = await page.screenshot({ type: 'png' });
    out.screenshotKB = Math.round(shot.length / 1024);
    out.screenshotPath = path.join(TMP, tag + '_creepjs.png');
    fs.writeFileSync(out.screenshotPath, shot);

    out.text = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 8000);
    out.rendered = out.text.length > 200;
    const mFp = out.text.match(/FP\s*ID:?\s*([a-f0-9]{16,})/i);
    if (mFp) out.fpId = mFp[1];
    const mHead = out.text.match(/(\d+)%\s*headless/i);
    if (mHead) out.headlessDetected = Number(mHead[1]);

    out.fp = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screenX: window.screenX,
      screenY: window.screenY,
      visibilityState: document.visibilityState,
      outerWidth: window.outerWidth,
      innerWidth: window.innerWidth,
    }));
    out.screenX = out.fp.screenX;
    out.visibilityState = out.fp.visibilityState;
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
  } finally {
    await browserManager.close(profile.id).catch(() => {});
  }
  return out;
}

(async () => {
  console.log('=== STEP 20 hidden-headful 产品验证（CreepJS） ===');
  console.log('数据目录: ' + TMP);

  const HH = buildProfile('p20_hh', 'hh-a', { hiddenWindow: true });
  db.upsertProfile(HH);
  report.profile = { id: HH.id, headless: HH.headless, launchBehavior: HH.launchBehavior };

  for (const tag of ['HH-1st', 'HH-2nd']) {
    console.log('\n── CreepJS @ ' + tag + ' (hidden-headful, id=' + HH.id + ') ──');
    const r = await visitCreepjs(HH, tag);
    report.visits[tag] = r;
    console.log('  rendered=' + r.rendered + ' fpId=' + (r.fpId || 'n/a').slice(0, 16) + ' headless%=' + r.headlessDetected +
      ' screenshot=' + r.screenshotKB + 'KB screenX=' + r.screenX + ' visibility=' + r.visibilityState + (r.error ? ' error=' + r.error : ''));
    if (r.fp) console.log('  ua=' + r.fp.userAgent.slice(0, 60) + ' webdriver=' + r.fp.webdriver + ' outer=' + r.fp.outerWidth + ' inner=' + r.fp.innerWidth);
  }
  const v1 = report.visits['HH-1st'] || {}, v2 = report.visits['HH-2nd'] || {};

  if (ARGS.has('--baseline')) {
    console.log('\n── CreepJS @ HEADFUL 对照（普通有界面，仅记录） ──');
    const BF = buildProfile('p20_bf', 'hh-b', { hiddenWindow: false, headless: false });
    db.upsertProfile(BF);
    report.baseline = await visitCreepjs(BF, 'HEADFUL');
    console.log('  headless%=' + report.baseline.headlessDetected + ' fpId=' + (report.baseline.fpId || 'n/a').slice(0, 16));
  }

  console.log('\n── 确定性断言 ──');
  assert('T1a CreepJS 渲染产出 FP ID（HH-1st）', !!v1.fpId, { fpId: v1.fpId, error: v1.error });
  assert('T1b CreepJS 渲染产出 FP ID（HH-2nd）', !!v2.fpId, { fpId: v2.fpId, error: v2.error });
  assert('T2a headless% <= 33（headful 等效基线，HH-1st）', typeof v1.headlessDetected === 'number' && v1.headlessDetected <= 33, v1.headlessDetected);
  assert('T2b headless% <= 33（HH-2nd）', typeof v2.headlessDetected === 'number' && v2.headlessDetected <= 33, v2.headlessDetected);
  assert('T3 navigator.webdriver=false', (v1.fp && v1.fp.webdriver === false) && (v2.fp && v2.fp.webdriver === false),
    { a: v1.fp && v1.fp.webdriver, b: v2.fp && v2.fp.webdriver });
  assert('T4a 离屏窗口截图可用 >30KB（HH-1st）', typeof v1.screenshotKB === 'number' && v1.screenshotKB > 30, v1.screenshotKB);
  assert('T4b 离屏窗口截图可用 >30KB（HH-2nd）', typeof v2.screenshotKB === 'number' && v2.screenshotKB > 30, v2.screenshotKB);
  assert('T5 同profile 跨会话 CreepJS FP ID 一致', !!v1.fpId && v1.fpId === v2.fpId, { a: v1.fpId, b: v2.fpId });
  assert('T6a 窗口已离屏 screenX<=-20000（HH-1st）', typeof v1.screenX === 'number' && v1.screenX <= -20000, v1.screenX);
  assert('T6b 窗口已离屏 screenX<=-20000（HH-2nd）', typeof v2.screenX === 'number' && v2.screenX <= -20000, v2.screenX);
  assert('T7a 离屏页面 visibilityState=visible（HH-1st）', v1.visibilityState === 'visible', v1.visibilityState);
  assert('T7b 离屏页面 visibilityState=visible（HH-2nd）', v2.visibilityState === 'visible', v2.visibilityState);
  assert('T8 页内 UA 不含 Headless（UA/UA-CH 全真）',
    (v1.fp && !/headless/i.test(v1.fp.userAgent)) && (v2.fp && !/headless/i.test(v2.fp.userAgent)),
    { a: v1.fp && v1.fp.userAgent, b: v2.fp && v2.fp.userAgent });
  if (report.baseline) {
    report.baselineNote = 'HEADFUL 对照 headless%=' + report.baseline.headlessDetected + '（仅记录，STEP 18 已实证 headful=33%）';
  }

  report.ok = report.assertions.length > 0 && report.assertions.every((x) => x.pass);
  const outPath = path.join(__dirname, '..', '..', '.benchmark', 'step20_hidden_headful_' + Date.now() + '.json');
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
