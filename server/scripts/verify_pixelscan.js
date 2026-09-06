'use strict';
// STEP 21 — Pixelscan 真实站点验证（hidden-headful 模式，STEP 20 产品形态）
// 取证基础（probe_pixelscan.js）：首页 CTA "Scan My Browser Now" → /fingerprint-check 扫描页；
// 扫描状态在 .status-bar/.status-text（"…is scanning…" → 终态）；逐项检查在 .checker-card
// （类含 --failed/--passed）；明细卡含 Canvas/WebGL/AudioContext/Font Hash 与 HTTP/JS 双 UA。
// 断言（确定性，站点 verdict 作为证据记录；Bot 检测为硬断言）：
//   P1 扫描页到达并渲染（url 含 fingerprint-check，扫描已启动）
//   P2 扫描完成（status-bar 脱离 "scanning…"，等待上限 150s）
//   P3 Bot check = No automated behavior detected（自动化行为检测通过——硬断言）
//   P4 HTTP UA === JS UA（UA 层一致性）
//   P5 WebGL renderer 非空且非 Apple（Windows profile OS 感知）
//   P6 navigator.webdriver === false
//   P7 跨会话稳定：Canvas / WebGL / AudioContext / Font Hash 两次会话完全一致
//   P8 跨会话 UA 一致
// 证据记录（不断言，诚实呈现）：checker 卡片逐项状态（browser/proxy/fingerprint）、
//   Location/Language 终值、status-bar 终态文本。
// 红线合规：仅点击正常 CTA 进入扫描，不绕过任何 CAPTCHA/风控；若遇人机验证如实记录为 blocked。
// 用法：node server/scripts/verify_pixelscan.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step21-'));
process.env.FPB_DATA_DIR = TMP;

const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');

const report = { at: new Date().toISOString(), mode: 'hidden-headful', visits: {}, assertions: [], ok: false };
function assert(name, cond, detail) {
  report.assertions.push({ name, pass: !!cond, detail: detail === undefined ? null : detail });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail) + ']'));
  return !!cond;
}

function buildProfile(id) {
  const profile = {
    id, name: id, group: 'verify', tags: [], notes: '',
    seed: 'step21-' + id, headless: false, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false, hiddenWindow: true },
    lastSessionUrls: [], fingerprintOverride: {}, createdAt: Date.now(),
  };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), { os: 'Windows', browser: 'Chrome' }, null);
  return profile;
}

async function visitPixelscan(profile, tag) {
  const session = await browserManager.launch(profile, null);
  const page = session.page;
  const out = { url: null, rendered: false, scanDone: false, closedEarly: false, closedBy: null, statusText: null, checkers: null, hashes: null, ua: null, webdriver: null, screenshotKB: null };
  // 快照式取证：Pixelscan 扫描结束/检测触发时可能 window.close() 自关标签页——
  // 每 3s 轮询时把能抓到的状态全部留档，页面被关后用最后成功快照继续断言。
  let snapshot = { statusText: '', checkers: null, hashes: null, ua: null, webdriver: null };
  let pageClosed = false;
  page.on('close', () => { pageClosed = true; out.closedEarly = true; out.closedBy = 'page-close'; });
  page.on('crash', () => { pageClosed = true; out.closedEarly = true; out.closedBy = 'page-crash'; });
  session.context.on('close', () => { if (!out.closedBy) { out.closedBy = 'context-close'; } pageClosed = true; });

  const grabSnapshot = async () => {
    const s = await page.evaluate(() => {
      const statusEl = document.querySelector('.status-bar') || document.querySelector('[class*="status-text"]');
      const checkers = Array.from(document.querySelectorAll('.checker-card')).map((c) => ({
        title: (c.querySelector('.checker-card__info, [class*="info"]') || c).textContent.trim().slice(0, 100),
        failed: /--failed/.test(c.className),
      }));
      // 哈希与明细在「What Websites See About You」区的卡片里（Canvas/WebGL/AudioContext Hash
      // 都在 Hardware 大卡内，按卡片标题抓不到）——直接对 section 文本做标签正则提取。
      const detailEl = Array.from(document.querySelectorAll('section, div')).find((e) =>
        /^What Websites See About You/i.test((e.querySelector('.main-title') || {}).textContent || ''));
      const dtext = (detailEl && detailEl.innerText) || (document.body ? document.body.innerText : '');
      const hashAfter = (label) => { const m = dtext.match(new RegExp(label + '\\s*\\n\\s*([a-f0-9]{16,64})', 'i')); return m ? m[1] : null; };
      const uaHttp = (dtext.match(/HTTP\s*\n\s*(Mozilla[^\n]+)/i) || [])[1] || null;
      const uaJs = (dtext.match(/JavaScript\s*\n\s*(Mozilla[^\n]+)/i) || [])[1] || null;
      const wgr = (dtext.match(/WebGL Renderer\s*\n\s*([^\n]+)/i) || [])[1] || null;
      const wgv = (dtext.match(/WebGL Vendor\s*\n\s*([^\n]+)/i) || [])[1] || null;
      const textOf = (label) => { const m = dtext.match(new RegExp('^' + label + '\\s*\\n([\\s\\S]{0,200})', 'im')); return m ? m[1].split('\n').slice(0, 4).join(' | ').trim() : null; };
      return {
        statusText: statusEl ? statusEl.textContent.trim() : '',
        checkers,
        hashes: {
          canvas: hashAfter('Canvas Hash'),
          webgl: hashAfter('WebGL Hash'),
          audio: hashAfter('AudioContext Hash'),
          fonts: hashAfter('Font hash'),
          uaHttp, uaJs, webglVendor: wgv, webglRenderer: wgr,
          location: textOf('Location'),
          language: textOf('Language'),
          dateTime: textOf('Date & Time'),
        },
        ua: navigator.userAgent,
        webdriver: navigator.webdriver,
      };
    });
    if (s && (s.checkers.length || s.statusText)) snapshot = s; // 只接受非空快照
  };

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

    // 轮询（最长 150s）：抓快照。完成信号 = 明细区填充完整（Canvas/Audio Hash + HTTP/JS 双 UA）；
    // status-bar 可能恒停留轮询文案 "…is scanning…"（probe 实证），不作为完成判据，仅作证据记录。
    const deadline = Date.now() + 150000;
    // 注意布尔化：链式 && 的返回值是最后一个 truthy 值（这里会是 uaJs 字符串），
    // 必须 !!() 包裹，否则 scanDone 变字符串、严格 === true 断言恒假。
    const detailDone = (h) => !!(h && h.canvas && h.audio && h.uaHttp && h.uaJs);
    while (Date.now() < deadline && !pageClosed) {
      try { await grabSnapshot(); } catch (e) { /* 页面可能刚被关，下轮检测 pageClosed */ }
      if (detailDone(snapshot.hashes)) break;
      try { await page.waitForTimeout(3000); } catch (e) { break; }
    }
    out.statusText = snapshot.statusText;
    out.checkers = snapshot.checkers;
    out.hashes = snapshot.hashes;
    out.ua = snapshot.ua;
    out.webdriver = snapshot.webdriver;
    out.scanDone = !!(detailDone(snapshot.hashes) ||
      (pageClosed && snapshot.hashes && !!snapshot.hashes.canvas));
    await page.waitForTimeout(3000).catch(() => {});
    out.checkers = snapshot.checkers;

    if (!pageClosed) {
      try { await grabSnapshot(); } catch (e) {}
      out.checkers = snapshot.checkers; out.hashes = snapshot.hashes; out.statusText = snapshot.statusText;
      const shot = await page.screenshot({ type: 'png' });
      out.screenshotKB = Math.round(shot.length / 1024);
      out.screenshotPath = path.join(TMP, tag + '_pixelscan.png');
      fs.writeFileSync(out.screenshotPath, shot);
      out.ua = snapshot.ua; out.webdriver = snapshot.webdriver;
    } else {
      const shot = await page.screenshot({ type: 'png' }).catch(() => null);
      if (shot) {
        out.screenshotKB = Math.round(shot.length / 1024);
        out.screenshotPath = path.join(TMP, tag + '_pixelscan.png');
        fs.writeFileSync(out.screenshotPath, shot);
      }
    }
    out.rendered = (snapshot.checkers || []).length > 0 || out.scanDone;
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
  } finally {
    await browserManager.close(profile.id).catch(() => {});
  }
  return out;
}

(async () => {
  console.log('=== STEP 21 Pixelscan 产品验证（hidden-headful） ===');
  console.log('数据目录: ' + TMP);
  const P = buildProfile('p21_a');
  db.upsertProfile(P);
  report.profile = { id: P.id, mode: 'hidden-headful' };

  for (const tag of ['RUN-1', 'RUN-2']) {
    console.log('\n── Pixelscan @ ' + tag + ' (id=' + P.id + ') ──');
    const r = await visitPixelscan(P, tag);
    report.visits[tag] = r;
    console.log('  url=' + r.url + ' scanDone=' + r.scanDone + ' status="' + r.statusText + '" screenshot=' + r.screenshotKB + 'KB' + (r.error ? ' error=' + r.error : ''));
    if (r.checkers) for (const c of r.checkers) console.log('    checker: ' + (c.failed ? '[FAIL] ' : '[ok] ') + c.title.slice(0, 90));
    if (r.hashes) console.log('    canvas=' + String(r.hashes.canvas).slice(0, 16) + ' webgl=' + String(r.hashes.webgl).slice(0, 16) + ' audio=' + String(r.hashes.audio).slice(0, 16) + ' fonts=' + String(r.hashes.fonts).slice(0, 16));
  }
  const r1 = report.visits['RUN-1'] || {}, r2 = report.visits['RUN-2'] || {};

  console.log('\n── 确定性断言 ──');
  assert('P1a 扫描页到达（RUN-1）', /fingerprint-check/.test(r1.url || ''), r1.url);
  assert('P1b 扫描页到达（RUN-2）', /fingerprint-check/.test(r2.url || ''), r2.url);
  assert('P2a 明细区填充完整=扫描完成（RUN-1）', r1.scanDone === true, { status: r1.statusText, hashes: r1.hashes && { canvas: r1.hashes.canvas, uaHttp: !!r1.hashes.uaHttp, uaJs: !!r1.hashes.uaJs } });
  assert('P2b 明细区填充完整=扫描完成（RUN-2）', r2.scanDone === true, { status: r2.statusText, hashes: r2.hashes && { canvas: r2.hashes.canvas, uaHttp: !!r2.hashes.uaHttp, uaJs: !!r2.hashes.uaJs } });
  const botOk = (r) => (r.checkers || []).some((c) => /bot/i.test(c.title) && !c.failed) ||
    JSON.stringify(r.checkers).match(/no automated behavior/i);
  assert('P3 Bot check 无自动化行为检出（两次）', !!botOk(r1) && !!botOk(r2), { r1: (r1.checkers || []).filter((c) => /bot/i.test(c.title)), r2: (r2.checkers || []).filter((c) => /bot/i.test(c.title)) });
  const uaOk = (r) => r.hashes && r.hashes.uaHttp && r.hashes.uaJs && r.hashes.uaHttp === r.hashes.uaJs && /Chrome/.test(r.hashes.uaJs);
  assert('P4a HTTP UA === JS UA 且为 Chrome（RUN-1）', uaOk(r1), { http: r1.hashes && r1.hashes.uaHttp, js: r1.hashes && r1.hashes.uaJs });
  assert('P4b HTTP UA === JS UA 且为 Chrome（RUN-2）', uaOk(r2), { http: r2.hashes && r2.hashes.uaHttp, js: r2.hashes && r2.hashes.uaJs });
  const wgr = (r) => (r.hashes && r.hashes.webglRenderer) || '';
  assert('P5 WebGL renderer 非空且非 Apple（两次）',
    /ANGLE|Intel|NVIDIA|AMD|Google/.test(wgr(r1)) && !/Apple/i.test(wgr(r1)) &&
    /ANGLE|Intel|NVIDIA|AMD|Google/.test(wgr(r2)) && !/Apple/i.test(wgr(r2)), { r1: wgr(r1), r2: wgr(r2) });
  assert('P6 navigator.webdriver=false（两次）', r1.webdriver === false && r2.webdriver === false, { r1: r1.webdriver, r2: r2.webdriver });
  const same = (k) => r1.hashes && r2.hashes && r1.hashes[k] && r1.hashes[k] === r2.hashes[k];
  assert('P7a 跨会话 Canvas Hash 一致', same('canvas'), { r1: r1.hashes && r1.hashes.canvas, r2: r2.hashes && r2.hashes.canvas });
  assert('P7b 跨会话 WebGL Hash 一致', same('webgl'), { r1: r1.hashes && r1.hashes.webgl, r2: r2.hashes && r2.hashes.webgl });
  assert('P7c 跨会话 AudioContext Hash 一致', same('audio'), { r1: r1.hashes && r1.hashes.audio, r2: r2.hashes && r2.hashes.audio });
  assert('P7d 跨会话 Font Hash 一致', same('fonts'), { r1: r1.hashes && r1.hashes.fonts, r2: r2.hashes && r2.hashes.fonts });
  assert('P8 跨会话 UA 一致', !!r1.ua && r1.ua === r2.ua, { r1: r1.ua, r2: r2.ua });

  report.ok = report.assertions.length > 0 && report.assertions.every((x) => x.pass);
  const outPath = path.join(__dirname, '..', '..', '.benchmark', 'step21_pixelscan_' + Date.now() + '.json');
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
