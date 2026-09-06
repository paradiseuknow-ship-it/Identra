'use strict';
// STEP 22 — Pixelscan「Masking detected / Browser FAIL」对照归因实验（假设驱动）
// 背景（STEP 21）：hidden-headful 下 Pixelscan Bot check 通过，但 Fingerprint 卡标
// 「Masking detected」、Browser 卡 FAIL（多浏览器特征嗅探）。归因假设：
//   H1（注入痕迹）：指纹注入层留下可嗅探痕迹 → 产品缺陷，需对抗研究；
//   H2（环境因素）：与注入无关——CN 直连 IP 信誉 / Playwright 自动化驱动面 / 站点启发式
//     对本机真实 Chrome 也标记 → 非注入缺陷。
// 实验：A = 产品 hidden-headful（指纹注入）；B = 对照组（同一系统 Chrome、同一离屏启动参数、
//   同一 CTA 流程，但**无任何指纹注入/UA override**，原生 Playwright context）。
// 判读：B 也 FAIL → H2（注入无关）；仅 A FAIL → H1（注入痕迹，转入对抗研究）。
// 断言（确定性）：实验两侧数据均可采集且归因结论可判定（任一结果都是有效结论）。
// 红线合规：仅正常 CTA 交互，不绕过任何 CAPTCHA/风控；若遇人机验证如实记录 blocked。
// 用法：node server/scripts/verify_pixelscan_attribution.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step22-'));
process.env.FPB_DATA_DIR = TMP;

const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');
const { chromium } = require('playwright');

const SYSTEM_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HIDDEN_ARGS = ['--window-position=-32000,-32000', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];

const report = { at: new Date().toISOString(), groups: {}, comparison: {}, assertions: [], ok: false };
function assert(name, cond, detail) {
  report.assertions.push({ name, pass: !!cond, detail: detail === undefined ? null : detail });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail) + ']'));
  return !!cond;
}

function buildProductProfile(id) {
  const profile = {
    id, name: id, group: 'verify', tags: [], notes: '',
    seed: 'step22-' + id, headless: false, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false, hiddenWindow: true },
    lastSessionUrls: [], fingerprintOverride: {}, createdAt: Date.now(),
  };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), { os: 'Windows', browser: 'Chrome' }, null);
  return profile;
}

// 快照式取证（与 verify_pixelscan.js 同源逻辑）
async function grabSnapshotOf(page) {
  return await page.evaluate(() => {
    const statusEl = document.querySelector('.status-bar') || document.querySelector('[class*="status-text"]');
    const checkers = Array.from(document.querySelectorAll('.checker-card')).map((c) => ({
      title: (c.querySelector('.checker-card__info, [class*="info"]') || c).textContent.trim().slice(0, 100),
      failed: /--failed/.test(c.className),
    }));
    const detailEl = Array.from(document.querySelectorAll('section, div')).find((e) =>
      /^What Websites See About You/i.test((e.querySelector('.main-title') || {}).textContent || ''));
    const dtext = (detailEl && detailEl.innerText) || (document.body ? document.body.innerText : '');
    const hashAfter = (label) => { const m = dtext.match(new RegExp(label + '\\s*\\n\\s*([a-f0-9]{16,64})', 'i')); return m ? m[1] : null; };
    const uaHttp = (dtext.match(/HTTP\s*\n\s*(Mozilla[^\n]+)/i) || [])[1] || null;
    const uaJs = (dtext.match(/JavaScript\s*\n\s*(Mozilla[^\n]+)/i) || [])[1] || null;
    const wgr = (dtext.match(/WebGL Renderer\s*\n\s*([^\n]+)/i) || [])[1] || null;
    return {
      statusText: statusEl ? statusEl.textContent.trim() : '',
      checkers,
      hashes: { canvas: hashAfter('Canvas Hash'), webgl: hashAfter('WebGL Hash'), audio: hashAfter('AudioContext Hash'), fonts: hashAfter('Font hash'), uaHttp, uaJs, webglRenderer: wgr },
      ua: navigator.userAgent,
      webdriver: navigator.webdriver,
    };
  });
}

async function runScan(launchFn, tag) {
  const { page, cleanup, ctx } = await launchFn();
  const out = { url: null, detailDone: false, closedEarly: false, checkers: null, hashes: null, ua: null, webdriver: null, statusText: null };
  let snapshot = { statusText: '', checkers: [], hashes: null, ua: null, webdriver: null };
  let pageClosed = false;
  page.on('close', () => { pageClosed = true; out.closedEarly = true; });
  page.on('crash', () => { pageClosed = true; out.closedEarly = true; });
  ctx.on('close', () => { pageClosed = true; });
  try {
    await page.goto('https://pixelscan.net/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000);
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a, button')).find((e) => /scan my browser/i.test((e.textContent || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('未找到 Scan My Browser CTA');
    await page.waitForURL(/fingerprint-check/, { timeout: 30000 }).catch(() => {});
    out.url = page.url();
    const deadline = Date.now() + 150000;
    const detailDone = (h) => !!(h && h.canvas && h.audio && h.uaHttp && h.uaJs);
    while (Date.now() < deadline && !pageClosed) {
      try {
        const s = await grabSnapshotOf(page);
        if (s && (s.checkers.length || s.statusText)) snapshot = s;
      } catch (e) { /* 页面可能刚被关 */ }
      if (detailDone(snapshot.hashes)) break;
      try { await page.waitForTimeout(3000); } catch (e) { break; }
    }
    out.statusText = snapshot.statusText;
    out.checkers = snapshot.checkers;
    out.hashes = snapshot.hashes;
    out.ua = snapshot.ua;
    out.webdriver = snapshot.webdriver;
    out.detailDone = detailDone(snapshot.hashes);
    const shot = await page.screenshot({ type: 'png' }).catch(() => null);
    if (shot) { out.screenshotPath = path.join(TMP, tag + '_pixelscan.png'); fs.writeFileSync(out.screenshotPath, shot); }
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
  } finally {
    await cleanup().catch(() => {});
  }
  return out;
}

(async () => {
  console.log('=== STEP 22 Pixelscan 归因实验（A=产品注入 vs B=无注入原生对照） ===');
  console.log('数据目录: ' + TMP);

  // A 组：产品 hidden-headful（指纹注入）
  console.log('\n── A 组 @ 产品 hidden-headful ──');
  const PA = buildProductProfile('p22_a');
  db.upsertProfile(PA);
  report.groups.A = await runScan(async () => {
    const session = await browserManager.launch(PA, null);
    return { page: session.page, ctx: session.context, cleanup: async () => { await browserManager.close(PA.id).catch(() => {}); } };
  }, 'A_product');
  console.log('  url=' + report.groups.A.url + ' detailDone=' + report.groups.A.detailDone + ' webdriver=' + report.groups.A.webdriver + (report.groups.A.error ? ' error=' + report.groups.A.error : ''));
  for (const c of report.groups.A.checkers || []) console.log('    A checker: ' + (c.failed ? '[FAIL] ' : '[ok] ') + c.title.slice(0, 80));

  // B 组：对照——同一系统 Chrome、同一离屏参数、无注入
  console.log('\n── B 组 @ 无注入原生 Chrome 对照 ──');
  const ctrlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step22-ctrl-'));
  report.groups.B = await runScan(async () => {
    const ctx = await chromium.launchPersistentContext(ctrlDir, {
      headless: false,
      executablePath: fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined,
      args: HIDDEN_ARGS,
    });
    let page = ctx.pages()[0];
    if (!page) page = await ctx.newPage();
    return { page, ctx, cleanup: async () => { await ctx.close().catch(() => {}); } };
  }, 'B_control');
  console.log('  url=' + report.groups.B.url + ' detailDone=' + report.groups.B.detailDone + ' webdriver=' + report.groups.B.webdriver + (report.groups.B.error ? ' error=' + report.groups.B.error : ''));
  for (const c of report.groups.B.checkers || []) console.log('    B checker: ' + (c.failed ? '[FAIL] ' : '[ok] ') + c.title.slice(0, 80));

  const A = report.groups.A, B = report.groups.B;
  const cardOf = (g, label) => (g.checkers || []).find((c) => new RegExp(label, 'i').test(c.title)) || null;

  console.log('\n── 确定性断言 ──');
  assert('A1 产品组扫描明细填充完整', A.detailDone === true, { url: A.url, status: A.statusText });
  assert('B1 对照组扫描明细填充完整', B.detailDone === true, { url: B.url, status: B.statusText });
  assert('B2 对照组为真实 Chrome UA（无 Headless/无伪装）', !!B.ua && /Chrome/.test(B.ua) && !/Headless/i.test(B.ua), B.ua);

  const aBrowser = cardOf(A, 'browser'), bBrowser = cardOf(B, 'browser');
  assert('E1a Browser 卡状态两侧均采集（归因可判定）', !!aBrowser && !!bBrowser, { a: aBrowser && aBrowser.failed, b: bBrowser && bBrowser.failed });
  const aMask = cardOf(A, 'fingerprint'), bMask = cardOf(B, 'fingerprint');
  assert('E1b Fingerprint 卡状态两侧均采集（归因可判定）', !!aMask && !!bMask, { a: aMask && aMask.failed, b: bMask && bMask.failed });

  // 归因判读（结论性断言——无论哪种组合都是有效实验结论，前提是数据可靠）
  const attribution = {
    browserCard: { product: aBrowser && aBrowser.failed, control: bBrowser && bBrowser.failed },
    fingerprintCard: { product: aMask && aMask.failed, control: bMask && bMask.failed },
    browserSignature: { product: aBrowser && aBrowser.title, control: bBrowser && bBrowser.title },
  };
  if (attribution.browserCard.control === true) {
    attribution.verdict = 'H2_INJECTION_INDEPENDENT';
    attribution.explain = '对照组（无注入原生 Chrome）Browser 卡同样 FAIL——多浏览器特征嗅探与指纹注入无关，归因站点启发式/环境因素';
  } else if (attribution.browserCard.product === true && attribution.browserCard.control === false) {
    attribution.verdict = 'H1_INJECTION_TRACE';
    attribution.explain = '仅产品组 Browser 卡 FAIL——指纹注入存在可嗅探痕迹，需转入对抗研究';
  } else {
    attribution.verdict = 'CLEAN_BOTH';
    attribution.explain = '两侧 Browser 卡均通过——此前 FAIL 可能是站点状态波动，需复测';
  }
  if (attribution.fingerprintCard.control === true) {
    attribution.maskVerdict = 'H2_INJECTION_INDEPENDENT（对照组同样 Masking detected，归因 IP 信誉/环境启发式）';
  } else if (attribution.fingerprintCard.product === true && attribution.fingerprintCard.control === false) {
    attribution.maskVerdict = 'H1_INJECTION_TRACE（仅产品组被标记 Masking detected）';
  } else {
    attribution.maskVerdict = 'CLEAN_BOTH';
  }
  report.comparison = attribution;
  assert('E2 归因结论已判定', typeof attribution.verdict === 'string' && /H1|H2|CLEAN/.test(attribution.verdict), attribution);
  assert('E3 Masking 归因结论已判定', typeof attribution.maskVerdict === 'string', attribution.maskVerdict);
  // 对照组故意无注入：原生 Playwright 的 navigator.webdriver=true 是**原始自动化信号**，
  // 产品注入将其压为 false——这正是产品能力断言（掩盖生效），而非可比性失败。
  assert('E4 产品注入掩盖自动化信号：对照组 webdriver=true → 产品组 false',
    B.webdriver === true && A.webdriver === false, { a: A.webdriver, b: B.webdriver });

  report.ok = report.assertions.length > 0 && report.assertions.every((x) => x.pass);
  const outPath = path.join(__dirname, '..', '..', '.benchmark', 'step22_pixelscan_attribution_' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  const pass = report.assertions.filter((x) => x.pass).length;
  console.log('\n================ 归因结论 ================');
  console.log('Browser 卡: ' + attribution.verdict + ' —— ' + attribution.explain);
  console.log('Masking 卡: ' + attribution.maskVerdict);
  console.log('================ 汇总 ================');
  console.log('PASS=' + pass + '  FAIL=' + (report.assertions.length - pass) + '  =>  ' + (report.ok ? 'VERIFICATION_OK' : 'VERIFICATION_FAILED'));
  console.log('报告: ' + outPath);
  await browserManager.closeAll().catch(() => {});
  process.exit(report.ok ? 0 : 1);
})().catch(async (e) => {
  console.error('FATAL', e);
  await browserManager.closeAll().catch(() => {});
  process.exit(1);
});
