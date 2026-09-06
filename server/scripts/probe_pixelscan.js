'use strict';
// STEP 21 probe — Pixelscan 页面取证（verdict 解析前置）：hidden-headful 访问 pixelscan.net，
// 转储 innerText / 候选选择器命中 / 截图，用于确定 verdict 提取方案。只取证，不断言。

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step21-probe-'));
process.env.FPB_DATA_DIR = TMP;

const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');

(async () => {
  const profile = {
    id: 'p21_probe', name: 'p21_probe', group: 'verify', tags: [], notes: '',
    seed: 'step21-probe', headless: false, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false, hiddenWindow: true },
    lastSessionUrls: [], fingerprintOverride: {}, createdAt: Date.now(),
  };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), { os: 'Windows', browser: 'Chrome' }, null);
  db.upsertProfile(profile);

  const session = await browserManager.launch(profile, null);
  const page = session.page;
  const out = {};
  try {
    await page.goto('https://pixelscan.net/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000);
    // 进入真实扫描流程：点击首页 CTA（正常用户交互，非绕过）
    out.landingUrl = page.url();
    const clicked = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('a, button'));
      const btn = cands.find((e) => /scan my browser/i.test((e.textContent || '').trim()));
      if (btn) { btn.click(); return (btn.textContent || '').trim().slice(0, 60); }
      return null;
    });
    out.clickedCta = clicked;
    if (!clicked) {
      // 备选：Fingerprint Check 卡片链接
      await page.evaluate(() => {
        const card = Array.from(document.querySelectorAll('a, button')).find((e) => /fingerprint check/i.test((e.textContent || '').trim()));
        if (card) card.click();
      });
      out.clickedCta = 'fingerprint-check-card';
    }
    await page.waitForTimeout(40000); // SPA 检测流程较长，给足时间
    out.title = await page.title();
    out.url = page.url();
    out.text = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 10000);
    out.textLen = out.text.length;
    // 候选选择器探测
    out.selectors = await page.evaluate(() => {
      const sels = ['[class*="verdict"]', '[class*="score"]', '[class*="consisten"]', '[class*="result"]',
        '[data-testid*="verdict"]', '[data-testid*="score"]', 'h1', 'h2', 'h3', '[class*="status"]', '[class*="check"]'];
      const hits = {};
      for (const s of sels) {
        const els = Array.from(document.querySelectorAll(s)).slice(0, 8);
        if (els.length) hits[s] = els.map((e) => (e.className && typeof e.className === 'string' ? e.className : e.tagName) + ' :: ' + (e.textContent || '').trim().slice(0, 120));
      }
      return hits;
    });
    const shot = await page.screenshot({ type: 'png', fullPage: false });
    out.screenshotPath = path.join(TMP, 'pixelscan_probe.png');
    fs.writeFileSync(out.screenshotPath, shot);
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
  }
  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(TMP, 'probe.json'), JSON.stringify(out, null, 2));
  await browserManager.closeAll().catch(() => {});
  process.exit(0);
})().catch(async (e) => { console.error('FATAL', e); await browserManager.closeAll().catch(() => {}); process.exit(1); });
