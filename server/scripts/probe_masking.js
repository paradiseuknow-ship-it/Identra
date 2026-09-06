'use strict';
// STEP 24 probe — Pixelscan「Masking detected」（Fingerprint 卡）细项取证（只取证不断言）
// 背景：STEP 23 修复后 Browser 卡已 FAIL→[ok]，但 Fingerprint 卡仍标 Masking detected。
// 目标：抓到 Masking 卡的子信号明细（Pixelscan 通常在卡片内/展开区列出被判定 masked 的原因），
//       以及产品组 vs 无注入对照组的 Fingerprint 卡差异，为噪声痕迹类嗅探源定位提供证据。
// 方法：产品组（hidden-headful + 注入）与对照组（同系统 Chrome、同离屏参数、无注入原生 Playwright）
//       各跑一轮完整扫描，转储：
//         1) .checker-card 逐卡的完整 innerText（含展开的子信号列表）
//         2) 页面全文中含 mask/fingerprint 关键词的行及其上下文
//         3) 全页截图
// 用法：node server/scripts/probe_masking.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step24-probe-'));
process.env.FPB_DATA_DIR = TMP;

const { chromium } = require('playwright');
const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');

const SYSTEM_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HIDDEN_ARGS = ['--window-position=-32000,-32000', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
const out = { at: new Date().toISOString(), groups: {} };

function buildProfile(id) {
  const profile = {
    id, name: id, group: 'verify', tags: [], notes: '',
    seed: 'step24-' + id, headless: false, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false, hiddenWindow: true },
    lastSessionUrls: [], fingerprintOverride: {}, createdAt: Date.now(),
  };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), { os: 'Windows', browser: 'Chrome' }, null);
  return profile;
}

// 快照式扫描（与 verify_pixelscan 相同模式）：完成判据=明细区填充完整
async function runScan(group, profile) {
  const r = { url: null, scanDone: false, closedEarly: false, checkersText: [], maskingLines: [], detailText: null, screenshotKB: null };
  let page, context, session;
  let pageClosed = false;
  const onClose = () => { pageClosed = true; r.closedEarly = true; };

  try {
    if (group === 'product') {
      session = await browserManager.launch(profile, null);
      page = session.page; context = session.context;
    } else {
      // 对照组：原生 Playwright persistent context，同系统 Chrome + 同离屏参数，无注入
      const ctrlDir = path.join(TMP, 'control-profile');
      context = await chromium.launchPersistentContext(ctrlDir, {
        headless: false,
        executablePath: fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined,
        args: HIDDEN_ARGS,
        viewport: { width: 1366, height: 768 },
      });
      page = context.pages()[0] || await context.newPage();
    }
    page.on('close', onClose);
    page.on('crash', onClose);
    context.on('close', onClose);

    await page.goto('https://pixelscan.net/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000);
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a, button')).find((e) => /scan my browser/i.test((e.textContent || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('CTA not found');
    await page.waitForURL(/fingerprint-check/, { timeout: 30000 }).catch(() => {});
    r.url = page.url();

    const grab = async () => {
      const s = await page.evaluate(() => {
        const detailEl = Array.from(document.querySelectorAll('section, div')).find((e) =>
          /^What Websites See About You/i.test((e.querySelector('.main-title') || {}).textContent || ''));
        const dtext = (detailEl && detailEl.innerText) || '';
        const hashAfter = (label) => { const m = dtext.match(new RegExp(label + '\\s*\\n\\s*([a-f0-9]{16,64})', 'i')); return m ? m[1] : null; };
        // 逐卡完整 innerText（含子信号明细）
        const cards = Array.from(document.querySelectorAll('.checker-card')).map((c) => ({
          cls: c.className,
          text: (c.innerText || '').trim().slice(0, 2000),
        }));
        // 全文中 mask 相关行 ± 上下文
        const body = (document.body && document.body.innerText) || '';
        const lines = body.split('\n');
        const maskLines = [];
        lines.forEach((ln, i) => {
          if (/mask/i.test(ln) && ln.trim()) {
            maskLines.push(lines.slice(Math.max(0, i - 2), i + 4).join(' ⏎ ').slice(0, 500));
          }
        });
        return { cards, maskLines, dtext: dtext.slice(0, 8000), canvas: hashAfter('Canvas Hash'), audio: hashAfter('AudioContext Hash') };
      });
      return s;
    };

    const deadline = Date.now() + 150000;
    let snap = null;
    while (Date.now() < deadline && !pageClosed) {
      try { snap = await grab(); } catch (e) {}
      if (snap && snap.canvas && snap.audio) break;
      try { await page.waitForTimeout(3000); } catch (e) { break; }
    }
    // 完成后再等 8s 让 verdict 卡定型，再抓最终快照
    await page.waitForTimeout(8000).catch(() => {});
    if (!pageClosed) { try { snap = await grab(); } catch (e) {} }
    if (snap) { r.checkersText = snap.cards; r.maskingLines = snap.maskLines; r.detailText = snap.dtext; }
    r.scanDone = !!(snap && snap.canvas && snap.audio);

    if (!pageClosed) {
      const shot = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      if (shot) {
        r.screenshotKB = Math.round(shot.length / 1024);
        const shotDir = path.join(__dirname, '..', '..', '.benchmark', 'step24_probe_screenshots');
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(path.join(shotDir, group + '_fullpage.png'), shot);
      }
    }
  } catch (e) {
    r.error = String(e && e.message || e).slice(0, 300);
  } finally {
    if (group === 'product') { await browserManager.close(profile.id).catch(() => {}); }
    else if (context) { await context.close().catch(() => {}); }
  }
  return r;
}

(async () => {
  console.log('=== STEP 24 probe: Pixelscan Masking 卡取证 ===');
  console.log('数据目录: ' + TMP);

  const P = buildProfile('p24_probe');
  db.upsertProfile(P);

  console.log('\n── [A] 产品组（hidden-headful + 注入）──');
  out.groups.product = await runScan('product', P);
  console.log('  scanDone=' + out.groups.product.scanDone + ' cards=' + (out.groups.product.checkersText || []).length + (out.groups.product.error ? ' error=' + out.groups.product.error : ''));

  console.log('\n── [B] 对照组（原生 Chrome，无注入）──');
  out.groups.control = await runScan('control', P);
  console.log('  scanDone=' + out.groups.control.scanDone + ' cards=' + (out.groups.control.checkersText || []).length + (out.groups.control.error ? ' error=' + out.groups.control.error : ''));

  // 控制台摘要：逐卡状态 + mask 行
  for (const g of ['product', 'control']) {
    const gr = out.groups[g] || {};
    console.log('\n──── ' + g.toUpperCase() + ' ────');
    for (const c of gr.checkersText || []) {
      const failed = /--failed/.test(c.cls);
      console.log('  [' + (failed ? 'FAIL' : ' ok ') + '] ' + c.text.replace(/\n/g, ' | ').slice(0, 220));
    }
    for (const ml of gr.maskingLines || []) console.log('  MASK> ' + ml.replace(/\n/g, ' ⏎ '));
  }

  const outPath = path.join(__dirname, '..', '..', '.benchmark', 'step24_probe_masking_' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('\n报告: ' + outPath);
  await browserManager.closeAll().catch(() => {});
  process.exit(0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await browserManager.closeAll().catch(() => {});
  process.exit(1);
});
