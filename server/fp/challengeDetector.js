'use strict';

// Phase 14.7 — Challenge / External Block Detection（纯函数，零网络依赖）
//
// 定位：识别页面/响应中的 CAPTCHA / WAF challenge / 硬阻断特征，供 harness 决定终态。
// 铁律：只识别、不处理——检测到 challenge 的动作是「进入 HUMAN_ESCALATION 终态并留证」，
//       绝不自动解决/绕过（Phase 14 硬性边界 §一.7）。
//
// 三层判定（2026-09-04 webflow T01-T03 首跑修正：PX beacon 全站运行 + #px-captcha 隐藏 div
// 在 200 正常页面也存在，「出现特征」≠「遭遇拦截」，必须分层）：
//   1. externalBlock：阻断状态码(403/429/503) ×（WAF 特征 ∨ denied 文案）→ WAF 硬拦截
//   2. interactiveChallenge：可见 challenge 元素（challengeVisible）∨ 强 challenge 文案
//      ∨ challenge 形态标题 ∨ 非 403 但 denied 文案 → 交互式人工验证
//   3. passiveBeacon：仅有 WAF 厂商特征（脚本引用/隐藏 div/响应头）且页面正常 → 仅记录，
//      challenge=false（防止把全站 beacon 误判为拦截）
//
// 终态映射（使用现有 vocabulary，不新增重复状态）：
//   externalBlock / interactiveChallenge → 任务终态 HUMAN_ESCALATION（escalationKind='permission'）
//     harness 级细分：BLOCKED_EXTERNAL / HUMAN_REQUIRED（记 evidence，不进终态枚举）
//   其余（含 passiveBeacon）→ SUCCESS

const VENDOR_MARKERS = [
  { kind: 'perimeterx', re: /perimeterx|_pxAppId|_pxvid|human security|captcha\.px-cdn\.net|px-captcha/i },
  { kind: 'cloudflare', re: /cloudflare|cf-ray|cf-browser-verification|cf-challenge|just a moment/i },
  { kind: 'akamai', re: /akamai|_abck/i },
  { kind: 'kasada', re: /kasada|x-kpsdk|kpsdk/i },
  { kind: 'dataDome', re: /datadome|dd-verification/i },
];

// 强 challenge 文案：出现即交互式（不依赖状态码）
// 2026-09-04 R09 实测补全：PX press-and-hold 变体（200 状态、无标准 captcha DOM）——
// "Confirm you're not a bot" + "press and hold the button"（含俄语本地化）仅在真实
// challenge 页出现，正常业务页面不会含此文案，误报风险可控。
const CHALLENGE_TEXT_RE = /verify you are human|prove you.{0,4}re human|human verification|are you a robot|complete the (security check|verification)|confirm you.{0,4}re not a (bot|robot)|press and hold the button|нажмите и удерживайте|请完成(安全)?验证|滑动验证/i;
// denied 文案：配合状态码或 challenge 元素使用
const DENIED_TEXT_RE = /access.{0,20}denied|has been denied|access to this (page|content)|request blocked|unusual (traffic|activity)/i;
// challenge 形态标题
const CHALLENGE_TITLE_RE = /just a moment|attention required|access denied|verify|challenge|security check|denied/i;
// captcha 容器/组件（DOM 引用级）
const CAPTCHA_DOM_RE = /g-recaptcha|h-captcha|cf-turnstile|px-captcha|captcha-container|captcha-container|recaptcha\/api\.js|hcaptcha\.com\/1\/api\.js|challenges\.cloudflare\.com/i;

// @param {object} input { status, html, title, challengeVisible }
//   challengeVisible: 可选 boolean——调用方（harness）用页面 evaluate 检测 captcha 元素
//   实际可见性后的显式结论；未提供时由文案/标题启发判定
// @returns { challenge, interactive, externalBlock, passiveBeacon, kind, markers, evidence }
function detectChallenge({ status = null, html = '', title = '', challengeVisible = null } = {}) {
  const body = String(html || '');
  const head = String(title || '');
  const markers = VENDOR_MARKERS.filter((m) => m.re.test(body) || m.re.test(head)).map((m) => m.kind);
  const blockedStatus = status === 403 || status === 429 || status === 503;
  const captchaDom = CAPTCHA_DOM_RE.test(body);
  const challengeText = CHALLENGE_TEXT_RE.test(body) || CHALLENGE_TEXT_RE.test(head);
  const deniedText = DENIED_TEXT_RE.test(body) || DENIED_TEXT_RE.test(head);

  // 1. WAF 硬阻断
  const externalBlock = blockedStatus && (markers.length > 0 || captchaDom || deniedText || CHALLENGE_TITLE_RE.test(head));

  // 2. 交互式 challenge：可见性显式结论优先，其次强文案/challenge 标题
  const interactive = externalBlock
    ? false
    : (challengeVisible === true)
      || (challengeVisible !== false && (challengeText || (captchaDom && CHALLENGE_TITLE_RE.test(head))))
      || (!blockedStatus && deniedText && (captchaDom || markers.length > 0));

  // 3. 被动 beacon：有厂商特征但页面正常且无 challenge 证据
  const passiveBeacon = !externalBlock && !interactive && markers.length > 0;

  const kind = markers.length ? markers[0] : null;
  const challenge = externalBlock || interactive;
  const evidence = [
    status ? `http_status=${status}` : null,
    markers.length ? `vendor_markers=${markers.join(',')}` : null,
    captchaDom ? 'captcha_dom_reference=true' : null,
    challengeVisible === true ? 'challenge_visible=true' : challengeVisible === false ? 'challenge_visible=false' : null,
    challengeText ? 'challenge_text=true' : null,
    deniedText ? 'denied_text=true' : null,
    head ? `title="${head.slice(0, 80)}"` : null,
  ].filter(Boolean);

  return { challenge, interactive, externalBlock, passiveBeacon, kind, markers, evidence };
}

// 终态映射（现有 vocabulary；harness 级细分仅记 evidence 不扩终态枚举）
function terminalStateFor(detection) {
  if (!detection || (!detection.challenge && !detection.externalBlock)) {
    return { taskStatus: 'SUCCESS', harnessClass: null, escalationKind: null };
  }
  return {
    taskStatus: 'HUMAN_ESCALATION',
    harnessClass: detection.externalBlock && !detection.interactive ? 'BLOCKED_EXTERNAL' : 'HUMAN_REQUIRED',
    escalationKind: 'permission',
  };
}

module.exports = { detectChallenge, terminalStateFor, VENDOR_MARKERS };
