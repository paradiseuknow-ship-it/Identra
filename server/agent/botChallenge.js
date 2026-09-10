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
// 输出：{ blocked, vendor, confidence, evidence[] }；调用方（runtime）据此立即升级。

const TEXT_PATTERNS = [
  // 英文（PerimeterX / Cloudflare / 通用）
  /confirm\s+you(?:'re| are)\s+(?:not\s+)?(?:a\s+)?(?:bot|robot|human)/i,
  /press\s+and\s+hold(?:\s+the\s+button)?/i,
  /verify(?:ing)?\s+you(?:'re| are)\s+(?:a\s+)?human/i,
  /are\s+you\s+a\s+(?:robot|bot)/i,
  /bot\s+(?:detected|verification|check)/i,
  /human\s+verification/i,
  /captcha/i,
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

const URL_PATTERNS = [
  /(?:^|[?&])(?:__?cf_chl|cf_chl_|challenge|captcha|px-captcha)=/i,
  /\/(?:_sec|challenge|cdn-cgi\/challenge|captcha)(?:\/|$)/i,
  /\/verify(?:-human|you-are-human|-you-are-human)(?:\/|$)/i,
];

// 已知人机验证/风控供应商（第三方组件域名，非站点特判）
const VENDORS = [
  { vendor: 'perimeterx', re: /px-cloud\.net|px-cdn\.net|perimeterx\.net|human\-challenge/i },
  { vendor: 'cloudflare', re: /challenges\.cloudflare\.com|cf\-challenge|turnstile|cdn\-cgi\/challenge/i },
  { vendor: 'hcaptcha', re: /hcaptcha\.com/i },
  { vendor: 'recaptcha', re: /(?:www\.)?google\.com\/recaptcha|recaptcha\.net/i },
  { vendor: 'geetest', re: /geetest\.com/i },
  { vendor: 'kasada', re: /kasada\.io|k\-sd\-?c/i },
  { vendor: 'datadome', re: /datadome\.co|captcha\-delivery\.com/i },
  { vendor: 'akamai', re: /akam(?:ai)?\.net\/.*(?:bm|sensor)|_abck/i },
];

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

function detectVendor(haystack) {
  for (const v of VENDORS) {
    if (v.re.test(haystack)) return v.vendor;
  }
  return null;
}

/**
 * 判定当前观察是否处于「人机验证/反爬挑战页」。
 * @param {object} obs observation 快照（可为 null）
 * @param {object} [ctx] { url, html } 可选补充信号（html 用于供应商脚本域名识别）
 * @returns {{blocked:boolean, vendor:string|null, confidence:number, evidence:string[]}}
 */
function detect(obs, ctx) {
  const evidence = [];
  const text = textOf(obs);
  const url = String((ctx && ctx.url) || (obs && obs.url) || '');
  const html = String((ctx && ctx.html) || '');

  let textHit = null;
  for (const re of TEXT_PATTERNS) {
    const m = text.match(re);
    if (m) { textHit = m[0]; break; }
  }
  if (textHit) evidence.push('text:' + String(textHit).slice(0, 80));

  let urlHit = null;
  for (const re of URL_PATTERNS) {
    const m = url.match(re);
    if (m) { urlHit = m[0]; break; }
  }
  if (urlHit) evidence.push('url:' + urlHit);

  const vendor = detectVendor(text + ' \n ' + url + ' \n ' + html.slice(0, 20000));
  if (vendor) evidence.push('vendor:' + vendor);

  // 置信度：文本命中最高（页面自述）；供应商组件次之；仅 URL 命中最低。
  let confidence = 0;
  if (textHit) confidence = 0.9;
  else if (vendor) confidence = 0.75;
  else if (urlHit) confidence = 0.6;

  // 双信号交叉 → 拉满
  if (textHit && vendor) confidence = 0.97;

  return { blocked: evidence.length > 0, vendor, confidence, evidence: evidence.slice(0, 5) };
}

module.exports = { detect, TEXT_PATTERNS, URL_PATTERNS, VENDORS };
