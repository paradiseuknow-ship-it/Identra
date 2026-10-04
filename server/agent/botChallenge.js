'use strict';
// C106 F18 — 反爬/人机验证挑战页【识别与显式升级】（不绕过）。
//
// 真实站点实证（Webflow 联盟注册 task_mtuqje3txasfd + probe_c106_empty_obs_1788998063594）：
//   点进注册入口后落地 https://webflow.com/signup?... ，页面真实内容是
//     "Confirm you're not a bot / Before we continue, press and hold the button
//      to confirm you're human. ID de référence ..."
//   并加载 https://js.px-cloud.net/... （PerimeterX）。DOM 仅 22–26 节点、零 input。
//   而 agent 对此一无所知：仍按「注册表单」语义反复 fill password →
//   ELEMENT_NOT_FOUND ×4 → 分步步推进 no_advance_control ×2 → HUMAN_ESCALATION，
//   升级理由写的是「重试4次耗尽」，完全没提「被人机验证挡住」。
//
// 为什么必须修（且为什么不绕过）：
//   - 不修 → 每次遇到挑战页都空转满预算（实证 283s），且升级信息误导运营。
//   - 修法只能是【识别 + 显式升级】：告诉人「此处需要真人通过验证」，
//     由人决定是否继续。**绝不自动解题、绝不隐藏自动化痕迹、绝不触碰挑战控件**——
//     那属于 CAPTCHA/PX/WAF bypass，是本项目红线（Phase 16-B 冻结条款）。
//
// 判定信号全部来自页面自述与通用第三方组件，绝无站点特判：
//   1) 页面可见文本命中通用挑战文案（英/法/德/西/中），
//   2) 页面 URL 落在已知挑战/验证路径，
//   3) 页面引用了已知人机验证供应商脚本/iframe 域名（PerimeterX / Cloudflare Turnstile /
//      hCaptcha / reCAPTCHA / GeeTest / Kasada / DataDome）——识别第三方组件属通用能力。
//
// 输出：{ blocked, passive, vendor, confidence, evidence[] }；调用方（runtime / 凭据闸）据此升级或放行。
//
// ═══════════════════════════════════════════════════════════════════════════
// C160（2026-10-03）判定分层修正 —— 消除「出现特征 ⇒ 遭遇拦截」的假阳性
// ═══════════════════════════════════════════════════════════════════════════
//
// 真实站点实证（Spocket 注册漏斗 task_musir5ru5d8jy / task_musj6r35n8m6l，profile p_musiekhd9fs4）：
//   https://app.spocket.co/signup 是【完全正常的注册表单页】（Email address + Name + Get Started），
//   页脚仅有一句全站声明 "This site is protected by hCaptcha ..."，并引用
//   https://js.hcaptcha.com/1/api.js（被动防护脚本）。但凭据闸据本模块判定「人机验证挑战页」
//   → SECURITY_CHALLENGE → 拒绝往注册表单填邮箱 ⇒ 注册从第一步就走不通。
//   本批探针 _c160_probe.js 实测对照：连「正常商品页 + PerimeterX 全站脚本」也判 blocked=true。
//
// 根因：原实现 `blocked = evidence.length > 0`，等价于「只要引用了厂商组件就算遭遇挑战」。
//   而本仓 server/fp/challengeDetector.js（Phase 14.7，2026-09-04 已修正）对此早有结论：
//     「PX beacon 全站运行 + #px-captcha 隐藏 div 在 200 正常页面也存在，
//       『出现特征』≠『遭遇拦截』，必须分层」。
//   ⇒ 本文件是同一语义的第二份实现，且是【未同步修正】的那一份。C160 把判定分层与
//     challengeDetector 对齐；两份实现的语义等价性由 C106 守护 P9 锁死（防再次漂移）。
//
// 分层（与 fp/challengeDetector.js 同构）：
//   1. interactive  → blocked=true ：页面【正在】要求人机验证
//        (a) 可见挑战控件 —— 真实几何（w≥150 且 h≥150；真挑战实测 520×570，被动 badge 仅 ~70×70）
//        (b) 指令性挑战文案（"Confirm you're not a bot" / "press and hold the button" …）
//        (c) 挑战专有 URL（challenge/captcha 参数、/cdn-cgi/challenge-platform/ 路径）
//        (d) captcha DOM 容器【且】挑战形态标题（双信号交叉，单信号不判）
//   2. passiveBeacon → blocked=false：仅引用厂商组件 / 声明式文案，页面自身正常 → 只留痕
//   3. none          → blocked=false
//
//   注：本模块不消费 HTTP 状态码（agent 层拿到的是观察快照）。WAF 硬阻断（403/429/503 × 特征）
//   由 observation.computeChallenge → challengeDetector 覆盖，两条路径不重复判同一件事。
//
// 非对称取舍（有意，不可随意反转）：宁可漏判「无文案的纯图形挑战页」，
//   也绝不误判正常业务页 —— 漏判代价＝多绕几轮重试后仍走升级路径；误判代价＝正常流程直接死。
// ═══════════════════════════════════════════════════════════════════════════

// 指令性挑战文案：出现即交互式（页面在【要求】人做事）
const TEXT_PATTERNS = [
  // 英文（PerimeterX / Cloudflare / 通用）
  /confirm\s+you(?:'re| are)\s+(?:not\s+)?(?:a\s+)?(?:bot|robot|human)/i,
  /press\s+and\s+hold(?:\s+the\s+button)?/i,
  /verify(?:ing)?\s+you(?:'re| are)\s+(?:a\s+)?human/i,
  /are\s+you\s+a\s+(?:robot|bot)/i,
  /bot\s+(?:detected|verification|check)/i,
  /human\s+verification/i,
  /complete\s+the\s+security\s+check/i,
  /enable\s+javascript\s+and\s+cookies\s+to\s+continue/i,
  /attention\s+required\s*[!.:]?\s*(?:cloudflare)?/i,
  // 法文（本仓真实站点为法语落地页）
  /v[eé]rifi(?:er|ez)\s+que\s+vous\s+(?:n[’']êtes|etes)\s+pas\s+un\s+robot/i,
  /confirmez\s+que\s+vous\s+(?:n[’']êtes|etes)\s+pas\s+un\s+robot/i,
  // 德文 / 西班牙文
  /best[äa]tigen\s+sie,\s*dass\s+sie\s+kein\s+bot\s+sind/i,
  /confirma\s+que\s+no\s+eres\s+un\s+robot/i,
  // 中文
  /(?:请|需要)?(?:完成|通过)(?:安全|人机)验证/,
  /验证您(?:不是|是)(?:机器人|真人)/,
];

// 声明式 / 标注式文案：**单独命中不构成挑战**（正常站点的页脚声明、隐私说明都会出现）。
// C160：原实现在 TEXT_PATTERNS 里放裸 /captcha/i，页脚 "protected by hCaptcha" 直接命中 → 假阳性。
const WEAK_TEXT_PATTERNS = [
  /\bprotected\s+by\s+(?:hcaptcha|recaptcha|turnstile)/i,
  /\bcaptcha\b/i,
];

const URL_PATTERNS = [
  /(?:^|[?&])(?:__?cf_chl|cf_chl_|challenge|captcha|px-captcha)=/i,
  /\/(?:_sec|challenge|cdn-cgi\/challenge|captcha)(?:\/|$)/i,
  /\/cdn-cgi\/challenge-platform\//i,
  /\/verify(?:-human|you-are-human|-you-are-human)(?:\/|$)/i,
];

// 已知人机验证/风控供应商（第三方组件域名，非站点特判）
const VENDORS = [
  { vendor: 'perimeterx', re: /px-cloud\.net|px-cdn\.net|perimeterx\.net|human\-challenge/i },
  { vendor: 'cloudflare', re: /challenges\.cloudflare\.com|cf\-challenge|turnstile/i },
  { vendor: 'hcaptcha', re: /hcaptcha\.com/i },
  { vendor: 'recaptcha', re: /(?:www\.)?google\.com\/recaptcha|recaptcha\.net/i },
  { vendor: 'geetest', re: /geetest\.com/i },
  { vendor: 'kasada', re: /kasada\.io|k\-sd\-?c/i },
  { vendor: 'datadome', re: /datadome\.co|captcha\-delivery\.com/i },
  { vendor: 'akamai', re: /akam(?:ai)?\.net\/.*(?:bm|sensor)|_abck/i },
];

// captcha 容器/组件（DOM 引用级）—— 单信号不判，须与挑战形态标题交叉（见 interactive (d)）
const CAPTCHA_DOM_RE = /g-recaptcha|h-captcha|cf-turnstile|px-captcha|captcha-container|recaptcha\/api\.js|hcaptcha\.com\/\d\/api\.js|challenges\.cloudflare\.com/i;

// 挑战形态标题（从 <title> 提取）—— 刻意不含裸 "verify"/"denied"（"Verify your email" 类正常标题
// 会在 (d) 分支与 captcha 容器交叉时造成误判）。
const CHALLENGE_TITLE_RE = /just a moment|attention required|access denied|security check|human verification|are you a robot|challenge/i;

// 可见挑战控件最小尺寸：真挑战实测 520×570；被动 badge 约 70×70（w<150）⇒ 二者可分离。
// 该判据源自 C157 真实站点实证（挑战判据必须用可见尺寸，frame=challenge 会被预加载 ⇒ 按 URL 判定是假阳性）。
const VISIBLE_CHALLENGE_MIN = 150;

// 页面内一次性采集：HTML + 可见挑战控件几何。返回 { html, visible }。
//
// ⚠️ 调用方式固定为 `page.evaluate(botChallenge.PROBE_PAGE)` —— **必须作为 pageFunction 传入，
//    不得作为 evaluate 的第二个参数（arg）**：Playwright 的 arg 只接受可序列化值，
//    传函数会在 innerSerializeValue 处直接抛错（C160 fixture 实证）。
//    函数体自带 try/catch 且不依赖任何外部闭包（阈值内联，序列化会丢失闭包变量），
//    与 VISIBLE_CHALLENGE_MIN 保持一致，由守护 P7.3 锁死。
//
// 「可见」的三要素（缺一不可）—— C160 真实站点实证：
//   ① 尺寸达阈值（真挑战实测 520×570；被动 badge 约 70×70，hCaptcha 页脚 453×64）
//   ② 未被隐藏（visibility≠hidden 且 display≠none 且 opacity≠0）
//   ③ 与视口有交集（bottom>0 且 right>0）
//   app.spocket.co/signup 上存在 hCaptcha 的**隐形验证 iframe**：300×150（尺寸达标！）
//   却置于 `top:-9999px; left:1px` 且 `visibility:hidden` —— 若只看尺寸会把它误判为
//   「正在要求人机验证」，凭据闸随即拒绝往正常注册表单填表。三要素齐备才是真可见。
function PROBE_PAGE() {
  var html = '';
  var visible = null;
  try { html = document.documentElement ? document.documentElement.outerHTML.slice(0, 20000) : ''; } catch (e) { html = ''; }
  try {
    visible = false;
    function visiblyChallenge(el) {
      var r = el.getBoundingClientRect();
      if (!(r.width >= 150 && r.height >= 150)) return false;
      if (r.bottom <= 0 || r.right <= 0) return false;
      var cs = window.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      return !(parseFloat(cs.opacity) === 0);
    }
    var i;
    var fr = document.querySelectorAll('iframe');
    for (i = 0; i < fr.length; i++) {
      var s = fr[i].getAttribute('src') || '';
      if (/hcaptcha|recaptcha|turnstile|px-captcha|captcha-delivery|geetest|kasada/i.test(s) && visiblyChallenge(fr[i])) { visible = true; break; }
    }
    if (!visible) {
      var ns = document.querySelectorAll('[class*=captcha],[id*=captcha],[class*=challenge],[id*=challenge],[class*=turnstile],[id*=turnstile]');
      for (i = 0; i < ns.length; i++) { if (visiblyChallenge(ns[i])) { visible = true; break; } }
    }
  } catch (e) { visible = null; }
  return { html: html, visible: visible };
}

function textOf(obs) {
  if (!obs) return '';
  const parts = [];
  if (typeof obs.textSummary === 'string') parts.push(obs.textSummary);
  if (typeof obs.visibleText === 'string') parts.push(obs.visibleText.slice(0, 4000));
  if (Array.isArray(obs.elements)) {
    for (const e of obs.elements.slice(0, 60)) {
      if (e && typeof e.text === 'string') parts.push(e.text);
      if (e && typeof e.innerText === 'string') parts.push(e.innerText);
    }
  }
  return parts.join(' \n ').slice(0, 8000);
}

function titleOf(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  return m ? String(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function detectVendor(haystack) {
  for (const v of VENDORS) {
    if (v.re.test(haystack)) return v.vendor;
  }
  return null;
}

/**
 * 判定当前观察是否处于「人机验证/反爬挑战页」。
 * @param {object} obs observation 快照（可为 null）
 * @param {object} [ctx] { url, html, challengeVisible }
 *   html             页面 HTML（用于供应商脚本域名 / captcha 容器 / title 识别）
 *   challengeVisible 调用方用 VISIBILITY_PROBE 得到的可见挑战控件结论（true/false/null）
 * @returns {{blocked:boolean, passive:boolean, vendor:string|null, confidence:number, evidence:string[]}}
 */
function detect(obs, ctx) {
  const evidence = [];
  const text = textOf(obs);
  const url = String((ctx && ctx.url) || (obs && obs.url) || '');
  const html = String((ctx && ctx.html) || '');
  const visibility = (ctx && typeof ctx.challengeVisible === 'boolean') ? ctx.challengeVisible : null;

  let strongHit = null;
  for (const re of TEXT_PATTERNS) {
    const m = text.match(re);
    if (m) { strongHit = m[0]; break; }
  }
  if (strongHit) evidence.push('interactive_text:' + String(strongHit).slice(0, 80));

  let weakHit = null;
  for (const re of WEAK_TEXT_PATTERNS) {
    const m = text.match(re);
    if (m) { weakHit = m[0]; break; }
  }
  if (weakHit) evidence.push('passive_text:' + String(weakHit).slice(0, 60));

  let urlHit = null;
  for (const re of URL_PATTERNS) {
    const m = url.match(re);
    if (m) { urlHit = m[0]; break; }
  }
  if (urlHit) evidence.push('challenge_url:' + urlHit);

  const vendor = detectVendor(text + ' \n ' + url + ' \n ' + html.slice(0, 20000));
  if (vendor) evidence.push('vendor:' + vendor);

  const captchaDom = CAPTCHA_DOM_RE.test(html);
  if (captchaDom) evidence.push('captcha_dom:true');

  const title = titleOf(html);
  const titleHit = CHALLENGE_TITLE_RE.test(title);
  if (titleHit) evidence.push('challenge_title:' + title.slice(0, 60));

  const visibleChallenge = visibility === true;
  if (visibility !== null) evidence.push('challenge_visible:' + String(visibility));

  // ---- 分层判定（与 fp/challengeDetector.js 同构）----
  const interactive = visibleChallenge
    || !!strongHit
    || !!urlHit
    || (captchaDom && titleHit && visibility !== false);

  const passiveBeacon = !interactive && (!!vendor || !!weakHit || captchaDom);

  // 置信度：可见控件 / 指令性文案最高；DOM×标题交叉次之；仅 URL 更低；被动信标封顶 0.35
  let confidence = 0;
  if (interactive) {
    if (visibleChallenge && vendor) confidence = 0.97;
    else if (strongHit && vendor) confidence = 0.97;
    else if (visibleChallenge) confidence = 0.95;
    else if (strongHit) confidence = 0.9;
    else if (captchaDom && titleHit) confidence = 0.8;
    else if (urlHit) confidence = 0.6;
    else confidence = 0.6;
  } else if (passiveBeacon) {
    confidence = 0.35;
  }

  return { blocked: interactive, passive: passiveBeacon, vendor, confidence, evidence: evidence.slice(0, 6) };
}

module.exports = {
  detect, PROBE_PAGE, VISIBLE_CHALLENGE_MIN,
  TEXT_PATTERNS, WEAK_TEXT_PATTERNS, URL_PATTERNS, VENDORS, CAPTCHA_DOM_RE, CHALLENGE_TITLE_RE,
};
