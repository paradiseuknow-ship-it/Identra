'use strict';

/**
 * 安全自检脚本：用给定代理拉起指纹浏览器，依次访问 3 个检测站并解析结果。
 *
 * 用法：
 *   node server/scripts/selfcheck.js "IP:端口:用户:密码"
 *   node server/scripts/selfcheck.js "socks5://IP:端口:用户:密码"
 *   node server/scripts/selfcheck.js "http://用户:密码@IP:端口"
 *   SELFCHECK_PROXY="..." node server/scripts/selfcheck.js
 */

const path = require('path');
const fs = require('fs');
const browserManager = require('../browserManager');

function parseProxyString(raw) {
  if (!raw) return null;
  let s = raw.trim();
  let type = null;
  const scheme = s.match(/^(socks5|http|https):\/\/(.*)$/i);
  if (scheme) { type = scheme[1].toLowerCase(); s = scheme[2]; }
  if (s.includes('@')) {
    const idx = s.indexOf('@');
    const auth = s.slice(0, idx);
    const hostport = s.slice(idx + 1);
    const ac = auth.split(':');
    const [user, pass] = [ac[0] || '', ac.slice(1).join(':')];
    const hp = hostport.split(':');
    return { type: type || 'http', host: hp[0] || '', port: hp[1] || '', username: user, password: pass };
  }
  const parts = s.split(':');
  if (parts.length >= 4) return { type: type || 'http', host: parts[0], port: parts[1], username: parts[2], password: parts.slice(3).join(':') };
  if (parts.length === 2) return { type: type || 'http', host: parts[0], port: parts[1], username: '', password: '' };
  if (parts.length === 1) return { type: type || 'http', host: parts[0], port: '', username: '', password: '' };
  return null;
}

const rawProxy = process.argv[2] || process.env.SELFCHECK_PROXY;
if (!rawProxy) {
  console.error('缺少代理参数。用法: node server/scripts/selfcheck.js "IP:端口:用户:密码"');
  process.exit(2);
}
const inline = parseProxyString(rawProxy);
if (!inline || !inline.host) {
  console.error('代理格式无法解析:', rawProxy);
  process.exit(2);
}
const proxyServer = `${inline.host}:${inline.port}`;

const profileId = 'selfcheck_' + Date.now().toString(36);
const profile = {
  id: profileId,
  name: '安全自检',
  seed: profileId,
  os: 'Windows',
  browser: 'Chrome',
  headless: true,
  proxyMode: 'inline',
  proxyInline: {
    type: inline.type || 'http',
    server: proxyServer,
    username: inline.username,
    password: inline.password,
  },
  startupUrls: [],
  launchArgs: [],
  launchBehavior: {
    restoreLastSession: false,
    blockVideo: false,
    blockImages: false,
    blockImagesThresholdKB: 10,
    clearCacheOnLaunch: false,
    cacheClearMode: 'none',
    clearCookies: false,
  },
  fingerprintOverride: {
    timezoneMode: 'ip',
    languageMode: 'ip',
    geolocation: { mode: 'ip' },
    webRtc: 'replace-udp',
  },
  fingerprint: null,
};

const SHOT_DIR = path.join('/tmp', 'fpb_selfcheck');
fs.mkdirSync(SHOT_DIR, { recursive: true });

async function acceptCookies(page) {
  try {
    const ok = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input'));
      const accept = btns.find((b) => /(accept all|agree|akzeptieren|tout accepter|alle akzeptieren|aceptar|同意)/i.test(b.innerText));
      if (accept) { accept.click(); return true; }
      return false;
    });
    if (ok) await page.waitForTimeout(1500);
  } catch (e) {}
}

async function extractWhoer(page) {
  await acceptCookies(page);
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (e) {}
  await page.waitForTimeout(1500);
  // whoer 新版不再显示单一匿名度百分比，而是 checklist
    const data = await page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    const rows = Array.from(document.querySelectorAll('tr, .info-row, [class*="row"]'))
      .map((tr) => (tr && tr.innerText ? tr.innerText.trim() : ''))
      .filter(Boolean);
    return { text: text.slice(0, 1200), rows };
  });
  const lowers = data.text.toLowerCase();
  // 只在该项"值"为阳性（检测到）时才算扣分项，而不是标签词出现就算。
  // whoer 用德文：Ja=是/Yes，Nein=否/No。
  const flags = [];
  const riskTerms = ['blacklist', 'timezone', 'language', 'dns', 'webrtc', 'proxy', 'flash', 'vpn', 'tor', 'anonymizer', 'sperrliste', 'zeitzone', 'sprache'];
  for (const f of riskTerms) {
    const re = new RegExp(f + '[^a-zäöü]{0,12}(ja|yes|detected|erkannt|暴露|泄露)', 'i');
    if (re.test(lowers)) flags.push(f);
  }
  // 代理被检测：出现 "proxy ... ja/yes/detected" 或英文 "proxy detected"
  const proxyDetected = /proxy[^a-z]{0,12}(ja|yes|detected|erkannt)/i.test(lowers)
    || /proxy server[^a-z]{0,12}(yes|detected)/i.test(lowers);
  return { ...data, flags, proxyDetected };
}

async function extractSannysoft(page) {
  const url = page.url();
  // 页面没真正加载 sannysoft（如代理隧道失败停在错误页/about:blank）时，不应误判
  if (!/sannysoft/i.test(url)) {
    return { webdriverLine: '', webdriverStatus: null, webdriverDetected: null, rows: [], note: '页面未加载(sannysoft URL=' + url + ')' };
  }
  const text = await page.evaluate(() => document.body ? document.body.innerText : '');
  if (!/webdriver/i.test(text)) {
    return { webdriverLine: '', webdriverStatus: null, webdriverDetected: null, rows: [], note: '页面内容不含 WebDriver 测试项(可能未加载完成)' };
  }
  // 精准定位 WebDriver (New) / WEBDRIVER 行：sannysoft 的表格行通常包含 class status-true/status-false
  const rows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('tr, .test-row, [class*="test"]')).map((tr) => {
      const tds = Array.from(tr.querySelectorAll('td, .name, .value, .status, div'));
      return tds.map((td) => td.innerText.trim()).join(' | ');
    });
  });
  let webdriverLine = '';
  const candidateRows = rows.filter((r) => /webdriver/i.test(r));
  if (candidateRows.length) webdriverLine = candidateRows.join(' ; ');
  const matched = webdriverLine.match(/not detected|missing \(passed\)|present|true|false|ok|bad|yes|no|missing/i);
  const status = matched ? matched[0] : null;
  const lowerLine = webdriverLine.toLowerCase();
  const isDetected = status
    ? (/present|true|yes|bad/i.test(status) && !/not detected|missing|no|ok|false|passed/i.test(lowerLine))
    : false;
  return {
    webdriverLine,
    webdriverStatus: status,
    webdriverDetected: isDetected,
    rows: candidateRows,
  };
}

async function extractPixelscan(page) {
  await page.waitForTimeout(3000);
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
  const m = bodyText.match(/trust score[^0-9]*?(\d{1,3})\s*%/i)
    || bodyText.match(/(\d{1,3})\s*%\s*trust/i)
    || bodyText.match(/score[^0-9]*?(\d{1,3})/i);
  const liesIdx = bodyText.toLowerCase().indexOf('lies');
  const lies = liesIdx >= 0 ? bodyText.slice(liesIdx, liesIdx + 600) : '';
  return { trustScore: m ? Number(m[1]) : null, lies: lies.slice(0, 400), bodyText: bodyText.slice(0, 2000) };
}

(async () => {
  console.log('代理解析:', JSON.stringify({ ...inline, password: inline.password ? '***' : '' }));
  console.log('浏览器类型:', profile.os, profile.browser, '| headless:', profile.headless);
  console.log('启动浏览器中…\n');

  let session;
  try {
    session = await browserManager.launch(profile, null);
  } catch (e) {
    console.error('浏览器启动失败:', e.message);
    process.exit(1);
  }

  const fp = session.fp;
  console.log('=== 本次指纹概要 ===');
  console.log('UA      :', fp.userAgent);
  console.log('平台     :', fp.platform, '| 语言:', fp.language, '| 时区:', fp.timezone);
  console.log('WebGL   :', fp.webgl && fp.webgl.renderer);
  console.log('CPU/RAM :', fp.hardwareConcurrency, '核 /', fp.deviceMemory, 'GB');
  console.log('IP Geo  :', fp.ipGeo ? `${fp.ipGeo.city}/${fp.ipGeo.region}/${fp.ipGeo.country} tz=${fp.ipGeo.timezone} lang=${fp.ipGeo.language}` : '未启用');
  console.log('WebRTC  :', fp.webRtc, '| 映射出口IP:', fp.webRtcPublicIp);
  console.log();

  // ---- 浏览器侧真实值硬验证 ----
  try {
    const live = await session.page.evaluate(() => new Promise((res) => {
      const r = {
        lang: navigator.language,
        langs: navigator.languages,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffset: new Date().getTimezoneOffset(),
        dateStr: new Date().toString(),
        intlDefault: new Intl.DateTimeFormat('de-DE', { timeZoneName: 'short' }).format(new Date()),
        webdriver: ('webdriver' in navigator),
        webdriverVal: navigator.webdriver,
        ua: navigator.userAgent,
      };
      try {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc.createDataChannel('x');
        let done = false;
        const finish = () => { if (!done) { done = true; try { pc.close(); } catch (e) {} res(r); } };
        pc.onicecandidate = (e) => {
          if (e.candidate && e.candidate.candidate) { r.rtc = e.candidate.candidate; finish(); }
          else if (!e.candidate) finish();
        };
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
        setTimeout(finish, 5000);
      } catch (e) { r.rtcError = e.message; res(r); }
    }));
    console.log('=== 浏览器侧真实值（注入是否生效）===');
    console.log('navigator.language :', live.lang);
    console.log('navigator.languages:', JSON.stringify(live.langs));
    console.log('timezone           :', live.tz, '| getTimezoneOffset:', live.tzOffset);
    console.log('Date.toString()    :', live.dateStr);
    console.log('Intl default format:', live.intlDefault);
    console.log("'webdriver' in nav  :", live.webdriver, '(成员资格本就为 true；关键看值)');
    console.log('navigator.webdriver :', live.webdriverVal, '(应 false → 风控判定通过)');
    console.log('WebRTC 候选        :', live.rtc || live.rtcError || '(无候选)');
    console.log();
  } catch (e) {
    console.log('(实时验证跳过:', e.message, ')');
  }

  const results = {};
  const sites = [
    {
      key: 'whoer',
      url: 'https://whoer.net',
      label: '环境整体合格率 / 匿名度',
      extract: extractWhoer,
    },
    {
      key: 'sannysoft',
      url: 'https://bot.sannysoft.com',
      label: 'WebDriver 自动化特征',
      extract: extractSannysoft,
    },
    {
      key: 'pixelscan',
      url: 'https://pixelscan.net/fingerprint-check',
      label: 'Trust Score / Lies 深度风控',
      extract: async (page) => {
        // 如果页面有 "Scan My Browser Now" / "Start" 按钮，先点击
        try {
          const started = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a'));
            const b = btns.find((x) => /scan my browser|start scan|scan now|start free scan/i.test(x.innerText));
            if (b) { b.click(); return true; }
            return false;
          });
          // 等待扫描完成或超时：通过文案 "scanning" 消失 / "complete" / "result" 出现判断
          if (started) {
            for (let i = 0; i < 30; i++) {
              await page.waitForTimeout(2000);
              const done = await page.evaluate(() => {
                const txt = document.body ? document.body.innerText.toLowerCase() : '';
                return txt.includes('complete') || txt.includes('result') || txt.includes('scan finished') || !txt.includes('scanning');
              });
              if (done) break;
            }
          }
        } catch (e) {}
        return extractPixelscan(page);
      },
    },
  ];

  for (const site of sites) {
    console.log(`--- [${site.label}] ${site.url} ---`);
  let data = null;
  let error = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      if (attempt > 0) await session.page.waitForTimeout(5000);
      await session.page.goto(site.url, { timeout: 60000, waitUntil: 'domcontentloaded' });
      await session.page.waitForTimeout(3000);
      data = await site.extract(session.page);
      error = null;
      break;
    } catch (e) {
      error = e;
      console.log(`  第 ${attempt + 1} 次访问失败:`, e.message.split('\n')[0]);
    }
  }
    const shot = path.join(SHOT_DIR, `${site.key}.png`);
    await session.page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    results[site.key] = data || { error: error?.message };
    if (data) {
      if (site.key === 'whoer') {
        console.log('  代理被检测:', data.proxyDetected ? '是 ⚠' : '否 ✓', '| 阳性扣分项:', data.flags.join(', ') || '无');
        console.log('  checklist 预览:', (data.rows || []).slice(0, 8).join(' ; '));
      }
      if (site.key === 'sannysoft') {
        console.log('  WebDriver 行:', data.webdriverLine);
        console.log('  WebDriver 状态:', data.webdriverStatus, data.webdriverDetected ? '(⚠ 被识别)' : '(OK / 未识别)');
      }
      if (site.key === 'pixelscan') {
        console.log('  Trust Score:', data.trustScore, '%');
        console.log('  Lies:', data.lies ? data.lies.replace(/\s+/g, ' ').slice(0, 300) : '无/未解析');
      }
      console.log('  截图:', shot);
    }
    await session.page.waitForTimeout(9000);
    console.log();
  }

  console.log('=== 自检结论 ===');
  const whoerProxy = results.whoer?.proxyDetected;
  const whoerFlags = results.whoer?.flags || [];
  const wdDetected = results.sannysoft?.webdriverDetected;
  const trust = results.pixelscan?.trustScore;

  if (results.whoer?.error) {
    console.log('⚠ whoer 访问失败:', results.whoer.error);
  } else if (whoerFlags.length === 0 && whoerProxy === false) {
    console.log('✓ whoer 关键项均正常：未检测到代理/黑名单/DNS 等扣分项');
  } else {
    console.log(`⚠ whoer 存在异常：代理被检测=${whoerProxy ? '是' : '否/未知'}，扣分项：${whoerFlags.join(', ')}`);
  }

  if (wdDetected === true) console.log('⚠ WebDriver 被识别 —— 防检测可能失效，目标站会识别为机器人！');
  else if (wdDetected === false) console.log('✓ WebDriver: Not detected（防自动化检测通过）');
  else console.log('⚠ WebDriver 状态未能解析');

  if (trust !== null && trust !== undefined) {
    console.log(trust > 50 ? `✓ Pixelscan Trust Score ${trust}% > 50%` : `⚠ Pixelscan Trust Score ${trust}% <= 50%（偏危险）`);
  } else {
    console.log('⚠ Pixelscan 未返回 Trust Score（github.io 原站已 404，已改用 pixelscan.net/fingerprint-check；该站不再显示单一 Trust Score）');
  }

  await browserManager.close(profileId).catch(() => {});
  console.log('\n完成。截图目录:', SHOT_DIR);
  process.exit(0);
})();
