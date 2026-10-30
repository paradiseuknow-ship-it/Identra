'use strict';
// C184 下半段守护：getChromeVersion 的 CDP 版本回读兜底。
//
// 背景（L62 已实证）：getChromeVersion 依赖 powershell 读 chrome.exe 的 PE 版本头，
// shell 缺 WindowsPowerShell/v1.0 / 负载高超时 / 权限异常 ⇒ 返回 null ⇒ 伪造 UA 停在
// 指纹池版本而 brands/identity 走原生回放 ⇒ UA↔brands 版本分裂（c31 P0 / step19 L6a 红）。
// C194 上半段只修了 mtime 失效；本批补 CDP Browser.getVersion 回读兜底：
//   - 会话建立后（fire-and-forget，不阻塞启动）读浏览器级真实版本；
//   - 仅在文件版本读取失败（realVer=null）时介入：回填 _chromeVerCache ⇒ 下次启动自愈；
//   - major 一致不回填；CDP 失败静默退场（保持 getChromeVersion 既有 warn）。
//
// 守护分层：
//   A captureCdpChromeVersion 单元（mock page/CDP client，真实执行缓存回填分支）
//   B 接线（_launchProfile fire-and-forget 调用点 + exports）

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_ROOT = path.join(os.tmpdir(), 'c184b-guard-' + process.pid);
fs.mkdirSync(TMP_ROOT, { recursive: true });
process.env.FPB_DATA_DIR = TMP_ROOT;

const bm = require('../browserManager');

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function eq(name, a, b) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

// mock CDP：统计 detach 调用；可注入 product / send 抛错
function mkPage(over) {
  const o = over || {};
  const state = { detached: 0 };
  const client = {
    send: async (method) => {
      if (o.sendThrows) throw new Error(o.sendThrows);
      if (method !== 'Browser.getVersion') throw new Error('unexpected method ' + method);
      return { product: o.product === undefined ? 'Chrome/156.0.8078.80' : o.product };
    },
    detach: async () => { state.detached++; },
  };
  const page = {
    context: async () => ({
      newCDPSession: async () => client,
    }),
  };
  return { page, state };
}

(async () => {
  console.log('=== C184 下半段 CDP 版本回读兜底守护 ===');

  // ---------------- A captureCdpChromeVersion ----------------
  console.log('\n--- A CDP 回读 ---');

  // A1: realVer=null + CDP 成功 ⇒ 回填缓存，getChromeVersion 下次直接用 CDP 值
  bm.invalidateChromeVersionCache();
  let t = mkPage();
  let v = await bm.captureCdpChromeVersion(t.page, null);
  eq('A1 realVer=null ⇒ 返回 CDP 版本', v, '156.0.8078.80');
  eq('A1b 缓存已回填（getChromeVersion 直接命中 CDP 值，不再 fork powershell）', bm.getChromeVersion(), '156.0.8078.80');

  // A2: realVer major 与 CDP 一致 ⇒ 不回填（文件版本与 CDP 同源，缓存保持 null 由正常路径处理）
  bm.invalidateChromeVersionCache();
  t = mkPage({ product: 'Chrome/156.0.9999.99' });
  v = await bm.captureCdpChromeVersion(t.page, '156.0.8078.73');
  eq('A2 major 一致 ⇒ 返回 CDP 版本', v, '156.0.9999.99');
  ok('A2b 缓存未回填（不等于 CDP 的假补丁号）', bm.getChromeVersion() !== '156.0.9999.99',
    'got=' + bm.getChromeVersion());

  // A3: CDP send 抛错 ⇒ null、缓存不动
  bm.invalidateChromeVersionCache();
  t = mkPage({ sendThrows: 'cdp down' });
  v = await bm.captureCdpChromeVersion(t.page, null);
  eq('A3 CDP 失败 ⇒ null', v, null);
  ok('A3b 失败静默（不抛错）', true);

  // A4: page=null ⇒ null
  v = await bm.captureCdpChromeVersion(null, null);
  eq('A4 page=null ⇒ null', v, null);

  // A5: product 无完整版本号 ⇒ null
  t = mkPage({ product: 'Chrome/xxx' });
  v = await bm.captureCdpChromeVersion(t.page, null);
  eq('A5 product 无版本 ⇒ null', v, null);

  // A6: realVer=null + CDP 成功 ⇒ 回填路径留下可观测 warn（C30 契约：失守必须可见）
  bm.invalidateChromeVersionCache();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    t = mkPage();
    await bm.captureCdpChromeVersion(t.page, null);
  } finally {
    console.warn = origWarn;
  }
  ok('A6 兜底回填 ⇒ 留下 warn', warns.some((w) => w.includes('CDP 回读兜底')),
    JSON.stringify(warns));

  // A7: CDP session 用完必须 detach（资源清理）
  bm.invalidateChromeVersionCache();
  t = mkPage();
  await bm.captureCdpChromeVersion(t.page, null);
  eq('A7 detach 恰好一次', t.state.detached, 1);

  // A8: 只发 Browser.getVersion（不碰其它协议域）
  bm.invalidateChromeVersionCache();
  t = mkPage({ product: 'Chrome/999.0.0.1' });
  await bm.captureCdpChromeVersion(t.page, null);
  eq('A8 CDP 版本已回填 999.0.0.1', bm.getChromeVersion(), '999.0.0.1');

  // 恢复现场：不让假版本污染后续（getChromeVersion 缓存清空后走真实文件读取）
  bm.invalidateChromeVersionCache();
  const real = bm.getChromeVersion();
  ok('A9 现场恢复：清缓存后文件版本可读（非假版本）', real === null || /^\d+\.\d+\.\d+\.\d+$/.test(real), 'got=' + real);

  // ---------------- B 接线 ----------------
  console.log('\n--- B 接线 ---');
  const BM = fs.readFileSync(path.join(__dirname, '..', 'browserManager.js'), 'utf8');

  // B1: 启动路径仅在 realVer 为空时 fire-and-forget 兜底
  ok('B1 _launchProfile 接线：!realVer 时触发（fire-and-forget）',
    BM.includes('if (!realVer) {') && BM.includes('captureCdpChromeVersion(page, realVer).catch(() => {});'),
    '应含 fire-and-forget 调用点');

  // B2: exports 暴露（守护可真实执行）
  ok('B2 exports 含 captureCdpChromeVersion',
    BM.includes('captureCdpChromeVersion,'), 'exports 缺失');

  // B3: CDP Browser.getVersion 是浏览器级调用（不受注入 spoof 影响）——锚定实现不读 navigator
  ok('B3 实现走 CDP Browser.getVersion',
    BM.includes("client.send('Browser.getVersion')"), '应通过 CDP 协议读版本');

  // B4: 缓存回填走既有 mtime 守卫通道（与 C194 一致，不绕过 stamp）
  ok('B4 回填同时写 stamp（复用 mtime 失效通道）',
    BM.includes('_chromeVerCache = cdpVer;') && BM.includes('_chromeVerStamp = chromeFileStamp();'),
    '回填必须同步 stamp，否则文件更新后 CDP 旧值永久粘住');

  console.log('\n========================================');
  console.log(`C184 下半段守护: 通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) { console.log('FAILS:\n' + fails.join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
