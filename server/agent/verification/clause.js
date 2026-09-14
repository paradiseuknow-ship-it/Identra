'use strict';

// 业务子句判定的**唯一实现**（C125）。
//
// 背景：验证引擎（verification.js）与诊断层（verificationIntelligence.js 的 clausePresent）
// 都要回答「这条 requiredEvidence 子句在观察中是否成立」，但各自维护了一份 switch。
// C124 已证明同一语义两份实现必然产生跨层相反答案（D1 缺分支恒假 / D2 恒真谎报成功）。
// C125 的覆盖面勘查发现缺口仍在：verification.js 有 13 个分支，VIL 只有 9 个 ——
// `storage` / `url_pattern` / `login_state` 在 VIL 里落 `default: return false`。
//
// 本模块把这三个类型的判定核心（含 P2 无效证据守卫与 fail-closed 语义）下沉为共享函数，
// 两个消费层只保留调用点。新增子句类型时若只改一层，test_c125 的覆盖面自动对账会红。
//
// 职责边界：本模块只做**子句是否成立**的判定，不做成功裁决、不写状态、不访问网络。
// 置信度随判定一并返回（置信度是裁决的一部分，分开摆就会再次各自漂移）。

// url_pattern 的 pattern 长度上限（C105 前既有约束：超长拒绝评估，防正则灾难与注入面）。
const MAX_PATTERN_LEN = 200;

// 文本脱敏截断长度：证据文案里出现的存储值只保留前 60 字符。
// 观察层已对敏感键脱敏（observation.js _capStore），这里不再引入新的泄露面。
const EVIDENCE_VALUE_SLICE = 60;

// ── URL 表面键（C105 F3；原在 verification.js，C125 下沉为本模块共享） ──────────
// URL 恒真判定的「表面键」——只取 host + pathname，query 一律不参与。
// 背景（C105 实锤）：联盟落地页 before.url = webflowmarketingmain.com/fr?...&pscd=try.webflow.com
// 旧实现整串 includes(expect) → query 参数 pscd=try.webflow.com 命中 expect「webflow.com」
// → 真实点击 CTA 后成功导航到 webflow.com 的证据被 P2 守卫误判「动作前已成立」而拒绝，
// 任务被拖入重试泥潭。query 是可被第三方注入的污染面，不构成「URL 表面已存在」的证据。
function urlSurfaceKey(u) {
  const s = String(u || '');
  try {
    const p = new URL(s);
    return ((p.hostname || '').toLowerCase()) + (p.pathname || '/');
  } catch (e) {
    // 回归修订（R-F3）：URL 解析失败（如测试伪端口 http://127.0.0.1:PORT0/...）不得让
    // P2 恒真守卫静默失效（返回 null → 守卫永远不触发）。回退为「剥掉 query/hash 的原始串」
    // ——保持 F3 的核心语义，同时对任意字符串都能给出确定性表面键。
    return s.split('?')[0].split('#')[0];
  }
}

// expect 在 URL 表面（host+pathname）上是否成立。expect 为完整 URL 时取其 host+path 再比对。
function surfaceContains(url, expect) {
  const surface = urlSurfaceKey(url);
  if (!surface) return false;
  const e = String(expect || '');
  if (!e) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e)) {
    const es = urlSurfaceKey(e);
    return !!es && surface.includes(es);
  }
  return surface.includes(e);
}

// ── storage：真实 Web Storage 证据（STEP 22 V1）────────────────────────────────
// 数据来自 observation.storage（页内只读真实采集），绝不从任务元数据推断成功。
// 缺 key → 不成立；值不匹配 → 不成立；观察层无 storage 数据（旧观察/采集失败）→ 不成立。
// 全部 fail-closed —— 采集缺失不是「没有要求这条证据」。
// 子句形态：{ type:'storage', storageType:'localStorage'|'sessionStorage', key, equals?, exists? }
function evalStorage(cl, after) {
  const v = cl || {};
  const st = v.storageType === 'sessionStorage' ? 'sessionStorage' : 'localStorage';
  const key = String((v.key != null ? v.key : ''));
  const store = (after && after.storage && after.storage[st]) || null;
  if (!key) return { ok: false, confidence: 0.5, reason: 'storage: 子句缺少 key' };
  if (!store) {
    return { ok: false, confidence: 0.5, reason: 'storage: 观察结果不含 ' + st + ' 数据（观察层未采集或页面不可访问）' };
  }
  const present = Object.prototype.hasOwnProperty.call(store, key);
  if (v.equals !== undefined) {
    const want = String(v.equals);
    const actual = String(store[key]);
    const ok = present && actual === want;
    const tail = ok ? '匹配' : (present ? '不匹配' : '键不存在');
    return {
      ok,
      confidence: ok ? 0.95 : 0.6,
      reason: 'storage: ' + st + '["' + key + '"] 实际="' + actual.slice(0, EVIDENCE_VALUE_SLICE)
        + '" 期望="' + want.slice(0, EVIDENCE_VALUE_SLICE) + '" → ' + tail,
    };
  }
  const wantExists = v.exists === undefined ? true : !!v.exists;
  const ok = wantExists ? present : !present;
  return {
    ok,
    confidence: ok ? 0.85 : 0.6,
    reason: 'storage: ' + st + '["' + key + '"] ' + (present ? '存在' : '不存在')
      + '（期望' + (wantExists ? '存在' : '不存在') + '）',
  };
}

// ── url_pattern：基于真实 page.url() 的正则匹配（STEP 22 V1）────────────────────
// 非法 pattern → 不成立（fail-closed），绝不抛异常崩 Runtime。
// P2 无效证据守卫与 url_contains 同理：pattern 在 before url 表面已匹配 = 恒真证据，
// 与本次动作无因果，不能作为成功证明（C105 F3：只在 host+pathname 表面判定）。
function evalUrlPattern(cl, after, before) {
  const v = cl || {};
  const pat = (v.pattern != null) ? String(v.pattern) : '';
  const url = (after && after.url) || '';
  if (!pat) return { ok: false, confidence: 0.5, reason: 'url_pattern: 缺少 pattern' };
  if (pat.length > MAX_PATTERN_LEN) {
    return { ok: false, confidence: 0.5, reason: 'url_pattern: pattern 超长(>' + MAX_PATTERN_LEN + ')，拒绝评估' };
  }
  let re = null;
  try {
    re = new RegExp(pat);
  } catch (e) {
    return { ok: false, confidence: 0.5, reason: 'url_pattern: 非法正则 "' + pat.slice(0, 80) + '" → 验证失败（fail-closed）' };
  }
  let ok = false;
  try { ok = re.test(url); } catch (e) { ok = false; }
  if (ok && before && before.url && pat) {
    let preHit = false;
    const preSurface = urlSurfaceKey(before.url);
    try { preHit = preSurface ? re.test(preSurface) : false; } catch (e) { preHit = false; }
    if (preHit) {
      return {
        ok: false,
        confidence: 0.7,
        invalidEvidence: 'precondition_true',
        reason: 'P2 无效证据守卫: url_pattern 在动作执行前已匹配（before url 表面='
          + (preSurface || String(before.url)) + '，恒真证据与本次动作无因果），不能作为本动作成功的证明',
      };
    }
  }
  return {
    ok,
    confidence: ok ? 0.95 : 0.7,
    reason: 'url_pattern: url=' + url + ' ' + (ok ? '匹配' : '不匹配') + ' /' + pat.slice(0, 80) + '/',
  };
}

// ── login_state：文本登录态线索 ────────────────────────────────────────────────
// 只做页面文本线索判定，**不涉及凭据读取**（17-A 凭据闸：本模块不接触任何凭据值）。
// text 由调用方按其自身口径构造 —— 验证引擎与诊断层的文本来源本就不同（见 test_c125
// 登记的已知分歧），这里不代替调用方决定口径，只保证「同一份文本 ⇒ 同一份结论」。
const LOGGED_OUT_RE = /(sign in|log in|login|register|create account)/i;
const LOGGED_IN_RE = /(logout|sign out|my account|dashboard|welcome|profile)/i;

function evalLoginState(text) {
  const loggedOut = LOGGED_OUT_RE.test(String(text || ''));
  const loggedIn = LOGGED_IN_RE.test(String(text || ''));
  const ok = !loggedOut || loggedIn;
  return {
    ok,
    confidence: ok ? 0.75 : 0.6,
    reason: '文本登录态线索: 未登录=' + loggedOut + ' 已登录=' + loggedIn,
  };
}

module.exports = {
  MAX_PATTERN_LEN,
  urlSurfaceKey,
  surfaceContains,
  evalStorage,
  evalUrlPattern,
  evalLoginState,
};
