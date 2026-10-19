'use strict';

// C182 守护：「禁止加载大图（省流量）」的两个实现级缺陷。
//
// 现场（用户 2026-10-19 反馈）：profile 勾选「禁止加载大图」并把阈值设为 50 KB 后，
// 登录页的 hCaptcha 挑战图经常加载不出来，人工验证无法完成。
//
// 根因一（严重 · buildArgs）：旧实现
//     if (behavior.blockImages || (blockImagesThresholdKB !== undefined && blockImagesThresholdKB <= 0))
//         args.push('--blink-settings=imagesEnabled=false');
//   只要勾选就**无条件**关掉 Blink 图片开关，完全忽略阈值 ⇒ 所有 <img> 与 CSS 背景图都不渲染，
//   验证码图必死；而且该开关是强自动化指纹（new Image().width===0 即可被站点探测）。
//   实测（_c182_probe，系统 Chrome）：带该开关时 3/3 张图 naturalWidth=0，其中最小的一张
//   只有 99 字节 —— 阈值 50KB 根本不该碰它。
//
// 根因二（静默失效 · setupRoutes）：阈值判定只读 content-length，
//   CDN / 动态图用 Transfer-Encoding: chunked 时该头缺失 ⇒ len=0 ⇒ 307KB 大图被放行。
//   实测同一次探针：big.png(307678B) 被 abort，big-chunked.png 同样 307678B 却 fulfill。
//
// 本守护钉住四件事（全程离线：纯函数 + mock route，不起浏览器、不触任何站点）：
//   ① 构建参数里**永不**出现 imagesEnabled 开关（阈值模式与全禁模式皆然）；
//   ② 阈值模式按真实字节数判定，chunked（无 content-length）也拦得住；
//   ③ 验证码 / 反爬域名一律放行 —— 阈值模式与全禁模式都放行（UI 承诺「已自动放行」）；
//   ④ 未勾选时不得注册图片拦截（历史误伤面），且 blockVideo 分支保持原样。
//
// 运行：node server/scripts/test_c182_image_block_saving.js

const os = require('os');
const path = require('path');
const fs = require('fs');

// C140 纪律：夹具一律隔离数据根，绝不写入 server/data（数据根为模块加载期解析）。
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c182_image_block_' + Date.now());

const ROOT = path.join(__dirname, '..', '..');
const BM_SRC = path.join(__dirname, '..', 'browserManager.js');
const bm = require(path.join(__dirname, '..', 'browserManager.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  << ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

// ---------------- mock：page / request / route（无浏览器） ----------------
function makeMockPage() {
  const handlers = [];
  return {
    handlers,
    route: async (pattern, handler) => { handlers.push({ pattern, handler }); },
  };
}
function mkReq(url, type) {
  return { url: () => url, resourceType: () => type, headers: () => ({}) };
}
function mkRoute(req, opts) {
  opts = opts || {};
  const calls = [];
  const headers = opts.headers || {};
  const body = opts.body || null;
  return {
    calls,
    request: () => req,
    abort: (code) => { calls.push('abort:' + (code || '')); },
    continue: () => { calls.push('continue'); },
    fulfill: async () => { calls.push('fulfill'); },
    fetch: async () => ({ headers: () => headers, body: async () => body }),
  };
}
const aborted = (r) => r.calls.some((c) => c.startsWith('abort'));
const released = (r) => r.calls.includes('continue') || r.calls.includes('fulfill');

// ===========================================================================
(async () => {
  section('① 构建参数：永不生成 Blink 关图开关');

  const plain = stripComments(fs.readFileSync(BM_SRC, 'utf8'));
  ok('源码（去注释）不再出现 imagesEnabled', plain.indexOf('imagesEnabled') === -1,
    { occurrences: (plain.match(/imagesEnabled/g) || []).length });

  const baseProfile = () => ({
    fingerprint: {},
    launchBehavior: {},
  });
  const argsOf = (behavior) => {
    const p = baseProfile();
    p.launchBehavior = behavior;
    return bm.buildArgs(p) || [];
  };

  const cases = [
    ['阈值 50KB（用户现场）', { blockImages: true, blockImagesThresholdKB: 50 }],
    ['阈值 10KB（UI 默认）', { blockImages: true, blockImagesThresholdKB: 10 }],
    ['阈值 0（全部禁止）', { blockImages: true, blockImagesThresholdKB: 0 }],
    ['未勾选 + 阈值 0（历史误伤面）', { blockImages: false, blockImagesThresholdKB: 0 }],
    ['未勾选 + 未设阈值', { blockImages: false }],
  ];
  for (const [label, behavior] of cases) {
    const args = argsOf(behavior);
    const hasBlink = args.some((a) => String(a).includes('imagesEnabled'));
    ok(label + ' -> 无 imagesEnabled 开关', !hasBlink, args.filter((a) => String(a).includes('blink')));
  }

  section('② 阈值模式：按真实字节数判定（chunked 也拦得住）');

  const pageA = makeMockPage();
  await bm.setupRoutes(pageA, { blockImages: true, blockImagesThresholdKB: 50 });
  ok('阈值模式注册了拦截器', pageA.handlers.length === 1, pageA.handlers.length);
  const hA = pageA.handlers[0] && pageA.handlers[0].handler;

  const small = mkRoute(mkReq('https://cdn.example.com/small.png', 'image'),
    { headers: { 'content-length': '10240' }, body: Buffer.alloc(10240) });
  await hA(small);
  ok('10KB 小图放行（低于阈值）', released(small) && !aborted(small), small.calls);

  const big = mkRoute(mkReq('https://cdn.example.com/big.png', 'image'),
    { headers: { 'content-length': '307678' }, body: Buffer.alloc(307678) });
  await hA(big);
  ok('300KB 大图拦截（content-length 可得）', aborted(big), big.calls);

  const chunked = mkRoute(mkReq('https://cdn.example.com/big-chunked.png', 'image'),
    { headers: {}, body: Buffer.alloc(307678) });
  await hA(chunked);
  ok('300KB 大图拦截（chunked / 无 content-length）', aborted(chunked), chunked.calls);

  const tinyChunked = mkRoute(mkReq('https://cdn.example.com/tiny.png', 'image'),
    { headers: {}, body: Buffer.alloc(2048) });
  await hA(tinyChunked);
  ok('2KB chunked 小图放行', released(tinyChunked) && !aborted(tinyChunked), tinyChunked.calls);

  const doc = mkRoute(mkReq('https://cdn.example.com/index.html', 'document'), {});
  await hA(doc);
  ok('非图片资源不受影响（document 放行）', released(doc) && !aborted(doc), doc.calls);

  section('③ 验证码 / 反爬域名：阈值模式与全禁模式都必须放行');

  ok('isVerificationHost(imgs.hcaptcha.com)', bm.isVerificationHost('https://imgs.hcaptcha.com/x.png') === true);
  ok('isVerificationHost(newassets.hcaptcha.com)', bm.isVerificationHost('https://newassets.hcaptcha.com/x.png') === true);
  ok('isVerificationHost(www.gstatic.com/recaptcha)', bm.isVerificationHost('https://www.gstatic.com/recaptcha/api2/logo.png') === true);
  ok('isVerificationHost(challenges.cloudflare.com)', bm.isVerificationHost('https://challenges.cloudflare.com/turnstile/x.png') === true);
  ok('isVerificationHost(普通 CDN) = false', bm.isVerificationHost('https://cdn.example.com/a.png') === false);

  const captchaBig = mkRoute(mkReq('https://imgs.hcaptcha.com/challenge.png', 'image'),
    { headers: { 'content-length': '400000' }, body: Buffer.alloc(400000) });
  await hA(captchaBig);
  ok('阈值模式：400KB 的 hCaptcha 挑战图放行', released(captchaBig) && !aborted(captchaBig), captchaBig.calls);

  const pageB = makeMockPage();
  await bm.setupRoutes(pageB, { blockImages: true, blockImagesThresholdKB: 0 });
  ok('全禁模式注册了拦截器', pageB.handlers.length === 1, pageB.handlers.length);
  const hB = pageB.handlers[0] && pageB.handlers[0].handler;

  const anyImg = mkRoute(mkReq('https://cdn.example.com/anything.png', 'image'), {});
  await hB(anyImg);
  ok('全禁模式：普通图拦截', aborted(anyImg), anyImg.calls);

  const captchaAll = mkRoute(mkReq('https://imgs.hcaptcha.com/challenge.png', 'image'), {});
  await hB(captchaAll);
  ok('全禁模式：验证码图仍然放行', released(captchaAll) && !aborted(captchaAll), captchaAll.calls);

  section('④ 未勾选不拦截；blockVideo 分支保持原样');

  const pageC = makeMockPage();
  await bm.setupRoutes(pageC, { blockImages: false, blockImagesThresholdKB: 0 });
  ok('未勾选 + 阈值 0 -> 不注册拦截器', pageC.handlers.length === 0, pageC.handlers.length);

  const pageD = makeMockPage();
  await bm.setupRoutes(pageD, { blockImages: false, blockImagesThresholdKB: 10 });
  ok('未勾选 + 阈值 10 -> 不注册拦截器', pageD.handlers.length === 0, pageD.handlers.length);

  const pageE = makeMockPage();
  await bm.setupRoutes(pageE, { blockVideo: true });
  ok('blockVideo 单独开启 -> 注册拦截器', pageE.handlers.length === 1, pageE.handlers.length);
  const hE = pageE.handlers[0] && pageE.handlers[0].handler;
  const video = mkRoute(mkReq('https://cdn.example.com/movie.mp4', 'media'), {});
  await hE(video);
  ok('blockVideo：媒体请求拦截', aborted(video), video.calls);
  const imgWhenVideoOnly = mkRoute(mkReq('https://cdn.example.com/a.png', 'image'), {});
  await hE(imgWhenVideoOnly);
  ok('blockVideo 不误伤图片', released(imgWhenVideoOnly) && !aborted(imgWhenVideoOnly), imgWhenVideoOnly.calls);

  console.log('\n----------------------------------------');
  console.log('C182 guard: pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('C182 guard crashed: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
