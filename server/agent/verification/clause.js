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

// ── 页面可见文本证据（C126 建立，C127 下沉）─────────────────────────────────────
// 背景：验证引擎只读 `after.textSummary`（observation.js 里是**前 120 个**筛选元素的文本，
// 截断 5000），而诊断层读 `visibleText`（全页 innerText 去重行，截断 8000）。
// 长页面上目标文本落在第 121 个元素之后时，验证引擎判「不包含」、诊断层判「包含」
// ⇒ 跨层相反答案，且真实成功会被 text_present 误判失败（恒假方向，与 C123 同族）。
//
// **C127**：同一份「页面文本」还有第三个、第四个消费方（pageReady.textOf /
// pageStateClassifier.extractText），它们甚至读的是一个**生产观测从不产出**的字段名
// （`visibleTexts` 复数）⇒ 恒静默回落窄口径。所以口径不能再留在本模块里，
// 已**下沉到中立模块 `../pageText.js`**（不依赖 verification，谁都能 require），
// 本模块只**再导出同一函数引用**，绝不留第二份实现
// （C126 守护的「口径定义唯一」断言已同步把锚点上移到 pageText.js，见 test_c126 A1/A8）。
//
// 注意 roleText **不进入**文本证据：它是交互元素的角色名（含 aria-label），属**元素级**
// 证据（由 element_present 的语义解析与存在性索引负责）。混进文本通道会让「视觉上没有
// 这段文字」的元素属性命中 text_present，是假阳性来源 —— 与 C123 的「证据层级」纪律同源。
const { normalizeText } = require('../existence');
const { pageText } = require('../pageText');

function evalTextPresent(after, expect) {
  const e = normalizeText(expect);
  if (!e) return { ok: false, confidence: 0.7, reason: 'text_present: 子句缺少 expect' };
  const ok = pageText(after).includes(e);
  return {
    ok,
    confidence: ok ? 0.9 : 0.7,
    reason: '页面文本' + (ok ? '包含' : '不包含') + ' "' + expect + '"',
  };
}

// C146：缺 expect（含空串/纯空白）不再「无条件成立」，改为 fail-closed。
//
// 改前实测（真实调用，非手写模拟）：`evalTextAbsent(page, '')` 返回成立（confidence 0.85，
// 理由文案自述「无条件成立」）。它是本模块 6 个判定器中**唯一**的 fail-open ——
// text_present / storage / url_contains / url_pattern 的缺参分支全部 fail-closed
// （因此本文件里「缺参 ⇒ 无条件成立」的形状只此一处；C146 守护按该**内容形状**做自动对账，
// 新增判定器会被自动覆盖，不会出现覆盖面漂移）。
//
// 为什么在 JS 上「不加固」必然 fail-open：`''.includes('')` 恒为 true ⇒ 两侧朴素实现都恒真。
// C126 只给 `text_present` 补了 fail-closed 守卫（其守护的「E 组：fail-closed / 健壮性」里
// 明确断言「expect 为空串 ⇒ text_present 不成立」），而**同一后果面的姊妹** text_absent
// —— 同一文本源（pageText）、同一归一化（normalizeText）、相邻定义、同一批消费者 ——
// 被漏掉（L6：同一后果面不得两条路径不一致）。本批即把那份加固补到姊妹上。
//
// 危害**双向**、同一根因，真实 `evaluateContract` 调用取证：
//   ① 落在 requiredEvidence 槽 ⇒ 契约无条件满足（success=true / conf 0.85 / evidence 为空）
//      ⇒ 伪成功通道（与「不设伪成功」纪律冲突）；
//   ② 落在 forbiddenEvidence 槽 ⇒ evaluateContract 第 1 步「任一命中即硬失败」被无条件触发
//      ⇒ 真实成功被恒判失败（conf 0.95）。
//   同一份 `{ type:'text_absent', expect:'' }` 在两个槽位产生**相反极性**，两者都错。
// 可达性：schema/action.js 的 verification 校验只断言 type ∈ VERIFICATION_TYPES
// （`text_absent` 在内），**不强制 expect** ⇒ 畸形输入可经计划校验进入执行链；
// normalizeContract / validateContract 亦只按 `.type` 过滤 ⇒ 合约侧同样可达。
//
// 方向 = **收紧**（更不容易误判成功），与 C131 的 P2 守卫同向。**不改 Success Definition**：
// 只影响畸形子句；真实语料（server/data + .step22-e2e）text_absent 子句总数 = 0，
// 内部构造点（contract.deriveContract 的派生契约）全部带非空 expect ⇒ 良构计划零影响。
// confidence 取 0.7 与姊妹 evalTextPresent 的缺参分支同值；且失败时 evaluateContract
// 会统一覆盖为 0.5，故该数值不参与成功裁决。
function evalTextAbsent(after, expect) {
  const e = normalizeText(expect);
  if (!e) return { ok: false, confidence: 0.7, reason: 'text_absent: 子句缺少 expect（fail-closed）' };
  const ok = !pageText(after).includes(e);
  return {
    ok,
    confidence: ok ? 0.85 : 0.6,
    reason: '页面文本' + (ok ? '未出现' : '出现') + ' "' + expect + '"',
  };
}

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

// ── url_contains：字面片段包含（C131 下沉为本模块共享的唯一实现）────────────────
// 背景（C131 实锤）：本判定此前有**三份互不同口径的实现**（L6/L15）——
//   ① verification.js:70（成功裁决面）——裸 includes + P2 守卫
//   ② verificationIntelligence.js:248（诊断面 clausePresent）——裸 includes，**无 P2**
//   ③ verificationIntelligence.js:206（诊断面 expectedActuallyPresent）——裸 includes，无 P2
// 三处对**同一份证据**给出不同结论：同一 clause + 同一 before/after，① 说 false
// （invalidEvidence=precondition_true），② 说 true ⇒ 诊断层判「业务结果其实已达成」
// ⇒ 4b 报 VERIFICATION_TOO_STRICT 并 RETRY_VERIFY，而裁决面明明判失败 —— 跨层相反答案。
// 契约依据（planner.js:79/86 权威措辞，全文无 toLowerCase）：
//   「url_contains（URL 变化；expect 必须是动作执行前 URL 中不存在的片段 ——
//     若入口 URL 已包含该片段，验证将被判为无效证据而失败）」
// 即 P2 不是验证引擎的局部加固，而是**该子句的语义定义的一部分**。clause.js:136
// 「P2 无效证据守卫与 url_contains 同理」正是以本函数为参照——此前参照物缺 P2，
// 属「注释声明的语义」与「实现」脱节（L16 谱系：声明了不存在的形状）。
// 大小写口径（C130 已统一）：两侧均**原样**比较。RFC 3986 §6.2.2 的 scheme/host
// 折叠属于 urlSurfaceKey 的职责（P2 表面键内已折叠 host），字面片段匹配则保持原样 ——
// 契约里 expect 是「原样字面片段」，整体 lowerCase 会使本子句比契约**更宽**。
// 方向说明：P2 使判定**更严**（更不容易误判成功），与「不设伪成功」一致。
function evalUrlContains(cl, after, before) {
  const v = cl || {};
  const expect = (v.expect != null) ? String(v.expect) : '';
  const url = (after && after.url) || '';
  if (!expect) {
    return { ok: false, confidence: 0.5, reason: 'url_contains: 缺少 expect（fail-closed）' };
  }
  const hit = url.includes(expect);
  // P2 无效证据守卫：expect 若在动作执行前（before 观察）的 URL 表面已成立，
  // 则它是「恒真证据」——与本次动作的因果无关，不能单独作为本动作成功的证明。
  // 背景（2026-08-31 run6 实证）：/saas/login.html 上 url_contains "saas" 恒真，
  // 错误凭据也被判 SUCCESS（假阳性）。守卫只拒绝「无效证据」，不改变 Success Definition。
  // C105 F3：恒真判定只在 URL 表面（host+pathname）上进行，query 不参与 ——
  // pscd=try.webflow.com 这类第三方注入的 query 参数不能把真导航证据误判为恒真。
  if (hit && before && before.url && surfaceContains(before.url, expect)) {
    return {
      ok: false,
      confidence: 0.8,
      invalidEvidence: 'precondition_true',
      reason: 'P2 无效证据守卫: url 条件在动作执行前已成立（before url 表面='
        + (urlSurfaceKey(before.url) || String(before.url)) + ' 已包含 "' + expect
        + '"，恒真证据与本次动作无因果），不能作为本动作成功的证明',
    };
  }
  return {
    ok: hit,
    confidence: hit ? 0.95 : 0.8,
    reason: 'url_contains: url=' + url + ' ' + (hit ? '包含' : '不包含') + ' "' + expect + '"',
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
  pageText,
  evalTextPresent,
  evalTextAbsent,
  evalStorage,
  evalUrlContains,
  evalUrlPattern,
  evalLoginState,
};
