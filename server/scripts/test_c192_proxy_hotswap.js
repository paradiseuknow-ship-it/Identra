'use strict';
// C192 守护：代理配置变更后，点一次「启动」就必须用上新代理（不得要求手动停止环境）。
//
// 背景（2026-10-30 用户实测）：代理失效后换新代理，环境里点「启动」仍然网页错误，
// 必须「关闭网页 → 停止环境 → 再启动」才恢复。根因：Chromium 的代理是**进程启动参数**，
// 会话内改配置不会热连；而 launch() 只要 sessions.has(id) 就原样返回旧会话 ⇒ 一直走旧代理。
//
// 本守护分两层：
//   A 决策层（纯函数，真实执行）：planSessionReuse / proxySignature / proxySourceOf 全分支；
//   B 会话层（真实 Chrome）：注入真实 context 制造「旧代理签名」→ 调用 launch →
//     必须自动关闭并重建会话，且回传 proxySwitched。
// C 接线层：路由必须把 proxySwitched / restartRequired 送到前端（口径唯一，防"算了却没告知"）。

const os = require('os');
const fs = require('fs');
const path = require('path');

// 数据根隔离必须在首个 require 之前（模块加载期解析，见 MEMORY 架构事实）
const TMP_ROOT = path.join(os.tmpdir(), 'c192-guard-' + process.pid);
fs.mkdirSync(TMP_ROOT, { recursive: true });
process.env.FPB_DATA_DIR = TMP_ROOT;

const { chromium } = require('playwright-core');
const bm = require('../browserManager');

const CHROME = process.env.FP_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function eq(name, a, b) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

// 无代理 + 全部「自定义」⇒ 启动不查网络（resolveLaunchIpGeo 直接返回 null），守护可离线跑
function makeProfile(over) {
  return Object.assign({
    id: 'p_c192probe',
    name: 'c192-probe',
    seed: 'c192-guard-seed',
    headless: true,
    os: 'Windows',
    browser: 'Chrome',
    proxyMode: 'none',
    proxyInline: null,
    proxyId: null,
    startupUrls: [],
    launchArgs: [],
    launchBehavior: { cacheClearMode: 'none' },
    fingerprintOverride: {
      timezoneMode: 'custom', timezone: 'Asia/Shanghai', timezoneOffset: 480,
      languageMode: 'custom', language: 'zh-CN',
      geolocation: { mode: 'custom', lat: 31.23, lng: 121.47 },
      clientRects: false,
    },
  }, over || {});
}

(async () => {
  console.log('=== C192 代理切换热生效守护 ===');

  // ---------------- A 决策层 ----------------
  console.log('\n--- A planSessionReuse 决策矩阵 ---');
  const proxies = [
    { id: 'px_a', type: 'socks5', server: '1.1.1.1:1080', username: 'u1', password: 'secret-a' },
    { id: 'px_b', type: 'http', server: '2.2.2.2:8080', username: 'u2', password: 'secret-b' },
  ];
  const pInlineA = makeProfile({ proxyMode: 'inline', proxyInline: { type: 'socks5', server: '1.1.1.1:1080', username: 'u1', password: 'secret-a' } });
  const pInlineA2 = makeProfile({ proxyMode: 'inline', proxyInline: { type: 'socks5', server: '9.9.9.9:1080', username: 'u1', password: 'secret-a' } });
  const pSavedA = makeProfile({ proxyMode: 'saved', proxyId: 'px_a' });
  const pSavedB = makeProfile({ proxyMode: 'saved', proxyId: 'px_b' });
  const pDirect = makeProfile();

  eq('A1 无会话 ⇒ fresh', bm.planSessionReuse(null, pDirect, proxies), 'fresh');
  eq('A2 旧会话无签名（来源未知）⇒ 保守 reuse，绝不打断运行实例',
    bm.planSessionReuse({}, pSavedB, proxies), 'reuse');
  eq('A3 签名一致 ⇒ reuse（零副作用）',
    bm.planSessionReuse({ proxySourceSig: bm.proxySignature(bm.proxySourceOf(pSavedA, proxies)) }, pSavedA, proxies), 'reuse');
  eq('A4 换到另一个已保存代理 ⇒ relaunch',
    bm.planSessionReuse({ proxySourceSig: bm.proxySignature(bm.proxySourceOf(pSavedA, proxies)) }, pSavedB, proxies), 'relaunch');
  eq('A5 内联代理地址变更 ⇒ relaunch',
    bm.planSessionReuse({ proxySourceSig: bm.proxySignature(bm.proxySourceOf(pInlineA, proxies)) }, pInlineA2, proxies), 'relaunch');
  eq('A6 直连 → 代理 ⇒ relaunch',
    bm.planSessionReuse({ proxySourceSig: 'direct' }, pSavedA, proxies), 'relaunch');
  eq('A7 代理 → 直连（关掉代理）⇒ relaunch',
    bm.planSessionReuse({ proxySourceSig: bm.proxySignature(bm.proxySourceOf(pSavedA, proxies)) }, pDirect, proxies), 'relaunch');
  // 同一 proxyId 但代理记录本身被改（代理管理里换了地址/账号）—— 这是最容易漏的分支：
  // profile 字段没动，只有 proxies 表变了。签名必须覆盖实体内容而非仅 id。
  const proxiesChanged = [{ id: 'px_a', type: 'socks5', server: '1.1.1.1:1080', username: 'u1', password: 'NEW-secret' }];
  eq('A8 同 proxyId 但密码变了 ⇒ relaunch',
    bm.planSessionReuse({ proxySourceSig: bm.proxySignature(bm.proxySourceOf(pSavedA, proxies)) }, pSavedA, proxiesChanged), 'relaunch');
  const proxiesChangedHost = [{ id: 'px_a', type: 'socks5', server: '1.1.1.1:1090', username: 'u1', password: 'secret-a' }];
  eq('A9 同 proxyId 但地址端口变了 ⇒ relaunch',
    bm.planSessionReuse({ proxySourceSig: bm.proxySignature(bm.proxySourceOf(pSavedA, proxies)) }, pSavedA, proxiesChangedHost), 'relaunch');
  eq('A10 签名稳定（同输入两次一致）',
    bm.proxySignature(proxies[0]) === bm.proxySignature(proxies[0]), true);
  ok('A11 签名不含明文密码', !bm.proxySignature(proxies[0]).includes('secret-a'), bm.proxySignature(proxies[0]));
  ok('A12 密码不同 ⇒ 摘要不同', bm.proxySignature(proxies[0]) !== bm.proxySignature(proxiesChanged[0]), 'collapse');
  eq('A13 inline 优先于 proxyId（与启动路径 resolveProxy 同序）',
    bm.proxySignature(bm.proxySourceOf(makeProfile({ proxyMode: 'inline', proxyId: 'px_b', proxyInline: { type: 'http', server: '3.3.3.3:80' } }), proxies)),
    bm.proxySignature({ type: 'http', server: '3.3.3.3:80' }));
  eq('A14 代理池里 id 找不到 ⇒ 视为直连', bm.proxySignature(bm.proxySourceOf(makeProfile({ proxyMode: 'saved', proxyId: 'px_missing' }), proxies)), 'direct');

  // ---------------- B 会话层（真实 Chrome） ----------------
  console.log('\n--- B 真实会话：代理签名过期 ⇒ launch 必须自动重建 ---');
  const prof = makeProfile();
  let seeded = null;
  try {
    if (!fs.existsSync(CHROME)) throw new Error('未找到 Chrome: ' + CHROME);
    const br = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const ctx = await br.newContext();
    const pg = await ctx.newPage();
    await pg.goto('about:blank');
    seeded = ctx;
    bm.__setSessionForTest(prof.id, { context: ctx, page: pg });
    const injected = bm.getSession(prof.id);
    ok('B1 注入的真实会话已注册', !!injected && bm.isRunning(prof.id));
    // 制造「运行中实例还在用旧代理」的状态：签名与当前配置（direct）不一致
    injected.proxySourceSig = 'socks5|127.0.0.1:1080|old-user|deadbeef';
    const before = injected;
    const sess = await bm.launch(prof, []);
    ok('B2 launch 返回的会话不是旧会话（已重建）', sess && sess !== before, 'same session object');
    eq('B3 新会话代理签名 = 当前配置（direct）', sess && sess.proxySourceSig, 'direct');
    eq('B4 已回传 proxySwitched=true', bm.consumeProxyRelaunched(prof.id), true);
    eq('B5 proxySwitched 读后即清（不产生陈旧提示）', bm.consumeProxyRelaunched(prof.id), false);
    ok('B6 旧 context 已被关闭', ctx.isClosed(), 'old context still open');
    await bm.close(prof.id);
    eq('B7 收尾后不再运行', bm.isRunning(prof.id), false);
  } catch (e) {
    ok('B 组执行（真实 Chrome 可用）', false, String(e && e.message || e).slice(0, 200));
  } finally {
    try { if (seeded && !seeded.isClosed()) await seeded.close(); } catch (e) {}
    try { await bm.close(prof.id); } catch (e) {}
  }

  // ---------------- C 接线层 ----------------
  console.log('\n--- C 路由接线（口径唯一）---');
  const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  ok('C1 launch 路由回传 proxySwitched', /res\.json\(\{\s*ok:\s*true,\s*running:\s*true,\s*proxySwitched\s*\}\)/.test(idxSrc), 'missing');
  ok('C2 launch 路由读取 consumeProxyRelaunched', idxSrc.includes('browserManager.consumeProxyRelaunched('), 'missing');
  ok('C3 PUT 路由在落库前取旧代理签名', /prevProxySig\s*=\s*browserManager\.proxySignature\(/.test(idxSrc), 'missing');
  ok('C4 restartRequired 依赖运行态', /restartRequired\s*=\s*proxyChanged\s*&&\s*browserManager\.isRunning\(/.test(idxSrc), 'missing');
  const edSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'components', 'ProfileEditor.jsx'), 'utf8');
  ok('C5 编辑器保存后提示 restartRequired', edSrc.includes('saved.restartRequired'), 'missing');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.jsx'), 'utf8');
  ok('C6 列表启动提示 proxySwitched', appSrc.includes('r.proxySwitched'), 'missing');

  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 2 }); } catch (e) {}

  console.log('\n=== 结果: PASS=' + pass + ' FAIL=' + fail + ' ===');
  if (fail) { console.log('失败项:\n  ' + fails.join('\n  ')); }
  // 必须显式退出：本套件起过真实 Chrome，残留句柄会让进程挂着不退，
  // 回归跑批会把「已出结果但没退出」记成「超时 >180s」（本轮实测踩中）。
  process.exit(fail ? 1 : 0);
})();
