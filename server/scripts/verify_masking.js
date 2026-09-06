'use strict';
// STEP 24 harness — Pixelscan Masking 卡归因 + 终态全采集
// 取证发现（probe_masking.js step24_probe_masking_1788039878335）：
//   1) 产品组 Fingerprint = "Masking detected"（终态），对照组 Fingerprint 卡停在 Collecting Data…
//   2) Browser 卡特征签名串（Chrome-29-0,Opera-16-0,…）两组完全相同——不是判定差异源；
//      但产品组本次 Browser FAIL（STEP 23 终极实测为 ok），唯一变量 = seed 生成 UA 147 对齐到引擎 151。
//   3) 对照组无注入也触发 Location "Timezone spoofed"——环境侧因素。
// 本 harness 三轮对照：
//   A: p21_a（STEP 23 终极实测同 seed，UA 预生成即接近引擎）
//   B: p24_probe（probe 同 seed，UA 147→151 对齐）
//   C: 对照组（原生 Chrome，无注入）
// 每轮等待所有 verdict 卡脱离 Collecting Data…（deadline 240s），并尝试点击每张 checker-card
// 展开子明细后转储全卡文本。红线：仅正常 CTA 交互与卡片点击取证，不绕过任何风控。
// 用法：node server/scripts/verify_masking.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step24-'));
process.env.FPB_DATA_DIR = TMP;

const { chromium } = require('playwright');
const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');

const SYSTEM_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HIDDEN_ARGS = ['--window-position=-32000,-32000', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
const report = { at: new Date().toISOString(), rounds: {} };

function buildProfile(id, seed) {
  const profile = {
    id, name: id, group: 'verify', tags: [], notes: '',
    seed, headless: false, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false, hiddenWindow: true },
    lastSessionUrls: [], fingerprintOverride: {}, createdAt: Date.now(),
  };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), { os: 'Windows', browser: 'Chrome' }, null);
  return profile;
}

async function runScan(tag, group, profile) {
  const r = { url: null, scanDone: false, closedEarly: false, rounds: 0, cardsFinal: false, checkersText: [], banner: null, expanded: {}, screenshotKB: null };
  let page, context, session;
  let pageClosed = false;
  const onClose = () => { pageClosed = true; r.closedEarly = true; };

  try {
    if (group === 'product') {
      session = await browserManager.launch(profile, null);
      page = session.page; context = session.context;
    } else {
      const ctrlDir = path.join(TMP, 'control-profile-' + tag);
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
        const cards = Array.from(document.querySelectorAll('.checker-card')).map((c) => ({
          cls: c.className,
          text: (c.innerText || '').trim().slice(0, 3000),
        }));
        const bannerEl = Array.from(document.querySelectorAll('h1, h2, h3, [class*="title"]')).find((e) => /fingerprint is/i.test(e.textContent || ''));
        const detailEl = Array.from(document.querySelectorAll('section, div')).find((e) =>
          /^What Websites See About You/i.test((e.querySelector('.main-title') || {}).textContent || ''));
        const dtext = (detailEl && detailEl.innerText) || '';
        const hashAfter = (label) => { const m = dtext.match(new RegExp(label + '\\s*\\n\\s*([a-f0-9]{16,64})', 'i')); return m ? m[1] : null; };
        return {
          cards,
          banner: bannerEl ? bannerEl.textContent.trim().slice(0, 120) : null,
          canvas: hashAfter('Canvas Hash'),
          audio: hashAfter('AudioContext Hash'),
        };
      });
      return s;
    };

    // 轮询：核心 verdict 卡（Browser/Fingerprint/Bot check）出终态即可完成——
    // Location/Proxy 依赖站点 geo 后端，连续访问会触发后端停摆（恒停 Collecting），
    // 只作证据记录，不阻塞归因。轮询间隔 10s 降低触发限流的概率。
    const deadline = Date.now() + 300000;
    let snap = null;
    const verdictDone = (s) => {
      if (!s || !s.cards) return false;
      const hasCanvasAudio = !!s.canvas && !!s.audio;
      const byLabel = (re) => s.cards.find((c) => re.test(c.text.split('\n').slice(-1)[0]) || re.test(c.text));
      const core = [/^Browser$/m, /Fingerprint/i, /Bot check/i];
      const finalCards = core.map((re) => byLabel(re)).filter(Boolean)
        .filter((c) => !/collecting data/i.test(c.text));
      return !!(hasCanvasAudio && finalCards.length >= 3);
    };
    while (Date.now() < deadline && !pageClosed) {
      try { snap = await grab(); r.rounds++; } catch (e) {}
      if (verdictDone(snap)) break;
      try { await page.waitForTimeout(10000); } catch (e) { break; }
    }
    r.cardsFinal = !!verdictDone(snap);

    // 展开取证：点击每张 verdict 卡后重抓文本，记录展开新增内容
    if (!pageClosed && snap) {
      const cardCount = snap.cards.length;
      for (let i = 0; i < cardCount; i++) {
        try {
          const before = await page.evaluate((idx) => {
            const c = document.querySelectorAll('.checker-card')[idx];
            return c ? c.innerText.trim() : '';
          }, i);
          await page.evaluate((idx) => {
            const c = document.querySelectorAll('.checker-card')[idx];
            if (c) c.click();
          }, i);
          await page.waitForTimeout(1200);
          const after = await page.evaluate((idx) => {
            const c = document.querySelectorAll('.checker-card')[idx];
            return c ? c.innerText.trim() : '';
          }, i);
          if (after.length > before.length + 10) {
            r.expanded['card' + i] = after.slice(0, 3000);
          }
        } catch (e) { /* 卡可能消失 */ }
      }
      // 展开操作后重抓最终卡状态
      try { snap = await grab(); } catch (e) {}
    }

    if (snap) { r.checkersText = snap.cards; r.banner = snap.banner; }
    r.scanDone = !!(snap && snap.canvas && snap.audio);
    r.collectingAtEnd = snap ? (snap.cards || []).filter((c) => /collecting data/i.test(c.text)).map((c) => c.text.replace(/\n/g, ' ').slice(0, 60)) : null;

    if (!pageClosed) {
      const shot = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      if (shot) {
        r.screenshotKB = Math.round(shot.length / 1024);
        const shotDir = path.join(__dirname, '..', '..', '.benchmark', 'step24_screenshots');
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(path.join(shotDir, tag + '_fullpage.png'), shot);
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
  console.log('=== STEP 24 harness: Masking 归因三轮对照 ===');
  console.log('数据目录: ' + TMP);

  const PA = buildProfile('p24_a', 'step21-p21_a');   // STEP 23 终极实测同 seed
  const PB = buildProfile('p24_b', 'step24-p24_probe'); // probe 同 seed（UA 147→151 对齐）
  db.upsertProfile(PA);
  db.upsertProfile(PB);
  console.log('A seed UA(预生成)=' + PA.fingerprint.userAgent.slice(0, 90));
  console.log('B seed UA(预生成)=' + PB.fingerprint.userAgent.slice(0, 90));

  const rounds = [
    ['A_p21a', 'product', PA],
    ['B_p24b', 'product', PB],
    ['C_control', 'control', null],
  ];
  for (const [tag, group, profile] of rounds) {
    console.log('\n── ' + tag + ' (' + group + ') ──');
    const r = await runScan(tag, group, profile);
    report.rounds[tag] = r;
    console.log('  scanDone=' + r.scanDone + ' cardsFinal=' + r.cardsFinal + ' rounds=' + r.rounds + (r.error ? ' error=' + r.error : ''));
    console.log('  banner=' + JSON.stringify(r.banner));
    if (r.collectingAtEnd) console.log('  仍Collecting: ' + JSON.stringify(r.collectingAtEnd));
    for (const c of r.checkersText || []) {
      const failed = /--failed/.test(c.cls);
      console.log('    [' + (failed ? 'FAIL' : ' ok ') + '] ' + c.text.replace(/\n/g, ' | ').slice(0, 180));
    }
    const expKeys = Object.keys(r.expanded || {});
    if (expKeys.length) for (const k of expKeys) console.log('    EXPANDED ' + k + ': ' + r.expanded[k].replace(/\n/g, ' | ').slice(0, 500));
  }

  const outPath = path.join(__dirname, '..', '..', '.benchmark', 'step24_masking_rounds_' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n报告: ' + outPath);
  await browserManager.closeAll().catch(() => {});
  process.exit(0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await browserManager.closeAll().catch(() => {});
  process.exit(1);
});
