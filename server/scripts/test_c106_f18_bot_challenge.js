'use strict';
// C106 F18 — 反爬/人机验证挑战页识别【守护】。
//
// 红线声明（本测试同时是纪律锁）：
//   本模块只做「识别 + 显式升级」。测试断言中**不允许**出现任何
//   解题/模拟通过/隐藏自动化痕迹/点击挑战控件的行为；命中即 escalate，绝不重试。
//
// 真实站点实证：webflow.com/signup 落地为 PerimeterX 挑战页，DOM 仅 22–26 节点、
// 零 input，页面自述 "Confirm you're not a bot / press and hold …"，并引用 js.px-cloud.net。
//
// C160 追加实证：https://app.spocket.co/signup 是【正常注册页】，页脚仅一句全站声明
//   "This site is protected by hCaptcha" 并引用 js.hcaptcha.com/1/api.js —— 原实现
//   （blocked = evidence.length > 0）据此拒绝往注册表单填凭据，注册第一步即死。
//
// 覆盖：
//   P1 文本命中（英/法/德/西/中多语言）—— 指令性文案
//   P2 供应商组件识别（px / cloudflare / hcaptcha / recaptcha / geetest / kasada / datadome）
//      P2  ·  仅引用组件且页面正常 ⇒ 识别但【不】阻断（passive）
//      P2b ·  组件 + 指令性文案 ⇒ 仍【须】阻断（不得放宽）
//   P3 URL 命中（低置信度通道）
//   P4 负例：正常注册/登录/搜索页绝不误判（误判会让 agent 放弃本可完成的流程）
//   P5 置信度分层与双信号拉满
//   P6 整类守卫：不得出现站点特判（webflow / 具体域名黑名单）
//   P7 可见挑战控件通道（真实几何；不可见 ⇒ 不阻断）
//   P8 图形 captcha：容器 × 挑战形态标题（双信号交叉）
//   P9 跨实现一致性：与 server/fp/challengeDetector.js 对同组向量必须同答案（防再次漂移）

const bc = require('../agent/botChallenge');
const challengeDetector = require('../fp/challengeDetector');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('❌ FAIL | ' + name + ' | ' + detail); }
}
const obs = (text, url) => ({ url: url || 'https://example.com/signup', textSummary: text, visibleText: text, elements: [] });

// ---------- P1 文本命中（多语言，指令性文案） ----------
const TEXTS = [
  "Confirm you're not a bot Before we continue, press and hold the button to confirm you're human.",
  'Verify you are human to continue.',
  'Are you a robot? Please complete the security check.',
  'Bot detected. Human verification required.',
  'Confirmez que vous n’êtes pas un robot avant de continuer.',
  'Vérifiez que vous n’êtes pas un robot.',
  'Bestätigen Sie, dass Sie kein Bot sind.',
  'Confirma que no eres un robot.',
  '请完成安全验证后继续访问。',
  '需要验证您不是机器人',
];
TEXTS.forEach((t, i) => {
  const r = bc.detect(obs(t));
  check('P1.' + (i + 1) + ' 文本命中「' + t.slice(0, 34) + '…」', r.blocked === true, JSON.stringify(r.evidence));
});

// ---------- P2 供应商组件（html 通道）----------
// 关键语义变更（C160）：**引用厂商组件 ≠ 遭遇拦截**（PX/CF/hCaptcha 均全站被动运行）。
// 旧锚「仅 vendor ⇒ blocked=true」已不成立（实证：正常商品页 + PX 脚本被误判为挑战页）。
const VENDORS = [
  ['perimeterx', '<script src="https://js.px-cloud.net/?t=abc"></script>'],
  ['cloudflare', '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'],
  ['hcaptcha', '<iframe src="https://newassets.hcaptcha.com/captcha/v1/index.html"></iframe>'],
  ['recaptcha', '<script src="https://www.google.com/recaptcha/api.js"></script>'],
  ['geetest', '<script src="https://static.geetest.com/static/js/gt.0.4.9.js"></script>'],
  ['kasada', '<script src="https://x.kasada.io/ips.js"></script>'],
  ['datadome', '<script src="https://geo.captcha-delivery.com/captcha/?initialCid=1"></script>'],
];
VENDORS.forEach(([vendor, html], i) => {
  const r = bc.detect(obs(''), { html });
  check('P2.' + (i + 1) + ' 仅引用组件（页面正常）⇒ 识别但【不】阻断 ' + vendor,
    r.blocked === false && r.vendor === vendor && r.passive === true,
    JSON.stringify({ vendor: r.vendor, blocked: r.blocked, evidence: r.evidence }));
  const r2 = bc.detect(obs("Confirm you're not a bot"), { html });
  check('P2.' + (i + 1) + 'b 组件 + 指令性文案 ⇒ 仍【须】阻断 ' + vendor,
    r2.blocked === true, JSON.stringify(r2.evidence));
});

// ---------- P3 URL 通道 ----------
check('P3.1 Cloudflare 挑战 URL（专有路径 ⇒ 阻断）', bc.detect(obs(''), { url: 'https://x.com/cdn-cgi/challenge-platform/h/b/orchestrate' }).blocked === true);
check('P3.2 普通 signup URL 不命中', bc.detect(obs(''), { url: 'https://example.com/signup?utm_source=a' }).blocked === false);
check('P3.3 URL 通道置信度低于文本通道',
  bc.detect(obs('Confirm you are not a bot'), {}).confidence > bc.detect(obs(''), { url: 'https://x.com/cdn-cgi/challenge-platform/h/b' }).confidence);

// ---------- P4 负例（防误判） ----------
const NEG = [
  'Create your account. Sign up with email or continue with Google.',
  'Sign in to your dashboard. Enter your email and password.',
  'Search results for running shoes. 1,204 items found.',
  'Créez votre compte gratuitement. Commencez gratuitement.',
  'Welcome back! Please log in to continue to your workspace.',
  'Checkout: review your order and complete the payment.',
];
NEG.forEach((t, i) => {
  const r = bc.detect(obs(t), {});
  check('P4.' + (i + 1) + ' 负例不误判「' + t.slice(0, 32) + '…」', r.blocked === false, JSON.stringify(r.evidence));
});
check('P4.7 空观察不误判', bc.detect(null, {}).blocked === false);
check('P4.8 仅含 "not" 与 "bot" 分处两处的普通文案不误判',
  bc.detect(obs('We are not selling bots or automated tools.'), {}).blocked === false);
// C159 真实站点回归锚：全站声明 + 被动防护脚本的正常注册页【必须】放行。
// 这一条如果红，说明又回到了「出现特征即拦截」的老缺陷（注册漏斗第一步会再次死掉）。
check('P4.9 正常注册页（全站 hCaptcha 声明 + 被动脚本）⇒ 放行（C159 真实站点锚）',
  bc.detect(obs('Welcome to Spocket Email address Name Get Started This site is protected by hCaptcha'),
    { url: 'https://app.spocket.co/signup', html: '<title>Spocket</title><script src="https://js.hcaptcha.com/1/api.js"></script><form><input name="email"></form>' }).blocked === false,
  JSON.stringify(bc.detect(obs('Welcome to Spocket This site is protected by hCaptcha'),
    { url: 'https://app.spocket.co/signup', html: '<title>Spocket</title><script src="https://js.hcaptcha.com/1/api.js"></script>' }).evidence));

// ---------- P5 置信度 ----------
const txtOnly = bc.detect(obs('Confirm you are not a robot'), {});
const both = bc.detect(obs('Confirm you are not a robot'), { html: '<script src="https://js.px-cloud.net/x.js"></script>' });
check('P5.1 文本命中置信度 ≥0.9', txtOnly.confidence >= 0.9, String(txtOnly.confidence));
check('P5.2 双信号拉满 ≥0.95', both.confidence >= 0.95, String(both.confidence) + ' vendor=' + both.vendor);
check('P5.3 未命中置信度 0', bc.detect(obs('Sign up'), {}).confidence === 0);
check('P5.4 被动信标置信度 <0.6（不得越过任何判定阈值）',
  bc.detect(obs(''), { html: '<script src="https://js.px-cloud.net/x.js"></script>' }).confidence < 0.6,
  String(bc.detect(obs(''), { html: '<script src="https://js.px-cloud.net/x.js"></script>' }).confidence));

// ---------- P6 整类守卫：禁止站点特判 ----------
// 只扫可执行代码：注释里必然出现实证站点名（"webflow.com/signup 落地为 PerimeterX 挑战页"），
// 那属于证据记录，不是判定逻辑。守卫要防的是「代码里写死站点名做特判」。
const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'agent', 'botChallenge.js'), 'utf8');
const src = raw
  .split(/\r?\n/)
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
check('P6.1 可执行代码不含站点名特判（webflow）', !/webflow/i.test(src));
check('P6.2 源码不含具体站点域名黑名单（example.com 除外）', !/(?:^|[^\w.])(?:amazon|booking|ticketmaster|steam)\.com/i.test(src));
check('P6.3 源码不含绕过类动词（solve/bypass/forge/spoof）', !/solveCaptcha|bypassCaptcha|forgeFingerprint|spoofChallenge/i.test(src));
check('P6.4 指令性文案表不得含裸 captcha（防页脚声明误判）',
  !bc.TEXT_PATTERNS.some((re) => re.test('This site is protected by hCaptcha')),
  JSON.stringify(bc.TEXT_PATTERNS.filter((re) => re.test('protected by hCaptcha')).map(String)));

// ---------- P7 可见挑战控件通道 ----------
check('P7.1 可见挑战控件（challengeVisible=true）⇒ 阻断',
  bc.detect(obs(''), { html: '<title>Site</title>', challengeVisible: true }).blocked === true);
check('P7.2 明确不可见（challengeVisible=false）且无其他强信号 ⇒ 不阻断',
  bc.detect(obs(''), { html: '<title>Site</title><script src="https://js.hcaptcha.com/1/api.js"></script>', challengeVisible: false }).blocked === false);
check('P7.3 探测函数与阈值常量同为 150（页面内序列化执行，阈值必须内联一致）',
  bc.VISIBLE_CHALLENGE_MIN === 150 && /150/.test(bc.PROBE_PAGE.toString()));
check('P7.6 「可见」必须三要素齐备：尺寸 ∧ 未隐藏(visibility/display/opacity) ∧ 与视口有交集', (() => {
  const s = bc.PROBE_PAGE.toString();
  return /visibility/.test(s) && /display/.test(s) && /opacity/.test(s) && /bottom\s*<=?\s*0/.test(s) && /getBoundingClientRect/.test(s);
})(), '缺任一要素 ⇒ hCaptcha 隐形 iframe(300x150, top:-9999, hidden) 会被误判为可见挑战');
check('P7.4 PROBE_PAGE 自包含（可在无 DOM 沙箱独立执行：不抛错、html 为空串、visible=null）', (() => {
  try {
    const vm = require('vm');
    const fn = vm.runInNewContext('(' + bc.PROBE_PAGE.toString() + ')');
    const r = fn();
    return !!r && r.visible === null && typeof r.html === 'string';
  } catch (e) { return false; }
})());
check('P7.5 两个调用点都把它当 pageFunction 传入（不得作为 evaluate 的 arg —— Playwright 的 arg 不接受函数）', (() => {
  const T = require('fs').readFileSync(require('path').join(__dirname, '..', 'agent', 'tools.js'), 'utf8');
  const R = require('fs').readFileSync(require('path').join(__dirname, '..', 'agent', 'runtime.js'), 'utf8');
  const good = /evaluate\(botChallenge\.PROBE_PAGE\)/;
  const bad = /evaluate\([^)]*,\s*botChallenge\.PROBE_PAGE\s*\)/;
  return good.test(T) && good.test(R) && !bad.test(T) && !bad.test(R);
})());

// ---------- P8 图形 captcha：容器 × 挑战形态标题（双信号） ----------
check('P8.1 captcha 容器 + 挑战形态标题 ⇒ 阻断',
  bc.detect(obs(''), { html: '<title>Just a moment...</title><div id="px-captcha"></div>' }).blocked === true);
check('P8.2 captcha 容器 + 正常标题 ⇒ 不阻断（单信号不判）',
  bc.detect(obs(''), { html: '<title>Spocket</title><div id="px-captcha"></div>' }).blocked === false);

// ---------- P9 跨实现一致性（与 fp/challengeDetector.js 同答案）----------
// 同一语义存在两条路径：agent 层（本模块，凭据闸/运行时升级）与 observation 层
// （challengeDetector，Phase 14.7 已修正）。二者对同一输入必须给出同一结论，
// 否则该语义就会再次出现「一份修了、一份没修」的漂移 —— C159 正是这么发生的。
const VECTORS = [
  { name: '真挑战页（PX 指令性文案 + 脚本）', text: "Confirm you're not a bot press and hold the button", html: '<title>Attention Required</title><script src="https://js.px-cloud.net/x.js"></script>', title: 'Attention Required', expect: true },
  { name: '正常注册页（hCaptcha 声明 + 被动脚本）', text: 'Welcome to Spocket This site is protected by hCaptcha', html: '<title>Spocket</title><script src="https://js.hcaptcha.com/1/api.js"></script><div class="h-captcha"></div>', title: 'Spocket', expect: false },
  { name: '正常商品页（+ PX 全站脚本）', text: 'Add to cart Free shipping over $50', html: '<title>Shop</title><script src="https://js.px-cloud.net/a.js"></script>', title: 'Shop', expect: false },
  { name: '可见挑战控件（无文案）', text: '', html: '<title>Site</title>', title: 'Site', visible: true, expect: true },
  { name: '普通登录页（无任何特征）', text: 'Sign in to your account', html: '<title>Sign in</title>', title: 'Sign in', expect: false },
];
VECTORS.forEach((v, i) => {
  const vis = (typeof v.visible === 'boolean') ? v.visible : null;
  const b = bc.detect({ url: 'https://example.com/', textSummary: v.text, visibleText: v.text, elements: [] },
    { url: 'https://example.com/', html: v.html, challengeVisible: vis });
  const c = challengeDetector.detectChallenge({ status: 200, html: v.html + '\n' + v.text, title: v.title, challengeVisible: vis });
  check('P9.' + (i + 1) + ' 跨实现同答案：' + v.name,
    b.blocked === c.challenge && b.blocked === v.expect,
    JSON.stringify({ agent: b.blocked, fp: c.challenge, expect: v.expect, agentEv: b.evidence, fpEv: c.evidence }));
});

console.log(`\n=== C106 F18 挑战页识别: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
