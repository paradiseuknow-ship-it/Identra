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
// 覆盖：
//   P1 文本命中（英/法/德/西/中多语言）
//   P2 供应商组件识别（px / cloudflare / hcaptcha / recaptcha / geetest / kasada / datadome）
//   P3 URL 命中（低置信度通道）
//   P4 负例：正常注册/登录/搜索页绝不误判（误判会让 agent 放弃本可完成的流程）
//   P5 置信度分层与双信号拉满
//   P6 整类守卫：不得出现站点特判（webflow / 具体域名黑名单）

const bc = require('../agent/botChallenge');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('❌ FAIL | ' + name + ' | ' + detail); }
}
const obs = (text, url) => ({ url: url || 'https://example.com/signup', textSummary: text, visibleText: text, elements: [] });

// ---------- P1 文本命中（多语言） ----------
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

// ---------- P2 供应商组件（html 通道） ----------
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
  check('P2.' + (i + 1) + ' 供应商识别 ' + vendor, r.blocked === true && r.vendor === vendor, JSON.stringify({ vendor: r.vendor, evidence: r.evidence }));
});

// ---------- P3 URL 通道 ----------
check('P3.1 Cloudflare 挑战 URL', bc.detect(obs(''), { url: 'https://x.com/cdn-cgi/challenge-platform/h/b/orchestrate' }).blocked === true);
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

// ---------- P5 置信度 ----------
const txtOnly = bc.detect(obs('Confirm you are not a robot'), {});
const both = bc.detect(obs('Confirm you are not a robot'), { html: '<script src="https://js.px-cloud.net/x.js"></script>' });
check('P5.1 文本命中置信度 ≥0.9', txtOnly.confidence >= 0.9, String(txtOnly.confidence));
check('P5.2 双信号拉满 ≥0.95', both.confidence >= 0.95, String(both.confidence) + ' vendor=' + both.vendor);
check('P5.3 未命中置信度 0', bc.detect(obs('Sign up'), {}).confidence === 0);

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

console.log(`\n=== C106 F18 挑战页识别: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
