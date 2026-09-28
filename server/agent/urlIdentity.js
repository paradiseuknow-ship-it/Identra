'use strict';

/**
 * URL 身份解析 —— **全库唯一实现**（C147）。
 *
 * 缺陷背景（A 类真缺陷，2026-09-18 端到端实测）：
 *   用户自然语言里的**裸域名**（`example.com`）是完全合法的输入形态，LLM parser
 *   会把它原样作为 target 返回。而下游任何直接解析都会对裸域抛 `TypeError: Invalid URL`，
 *   被各处 `catch` 静默吞成 null —— 于是「站点识别链」整段失效：
 *     · Profile 推荐拿不到 site ⇒ profileId 恒为 null ⇒ runtime.ensureBrowser 直接硬失败
 *       （实测 task_mu7446n8rpge6：519ms / actions=[] / "任务未绑定 Profile"，不重试不升级）
 *     · 五层记忆全关（Profile / Flow / Failure / Element / Site）
 *     · 凭据闸锚点 origin 为 null ⇒ 凭据动作一律 AUTHORIZATION_CONTEXT_MISSING（fail closed）
 *     · 入口归因保新静默跳过、302 入口验证放宽失效
 *   同一份逻辑在库内被**复制了 8 次**（`siteOfUrl` / `siteFromUrl` / `siteOf` 三个名字、
 *   一份完全相同的实现），修一处不会修其余 —— 故本批收口为唯一实现，消费方只能委托。
 *
 * 归一化边界（白名单，**绝不猜**）：
 *   · 只对「host 至少含一个点」的裸域名补默认 scheme（`https://`，安全默认）
 *   · 任何已有 scheme（http/https/about/data/blob/file/chrome/...）一律原样返回
 *   · 空 / 非字符串 / 含空白 / 相对路径 / 无点主机名（如 localhost）/ 其它形态
 *     → 原样返回（fail-open：不阻断、不臆造、不猜测协议与路径）
 *   · 幂等：normalizeUrl(normalizeUrl(x)) === normalizeUrl(x)
 *
 * 与既有实现的关系（诚实声明）：
 *   `credentialAuthorization` 曾自带 hostOf/originOf/isOriginlessLocalContext 三份同义实现，
 *   `diagnosisDecision` / `memory` / `sites` / `browserManager` / `skillRouter` 亦各有一份；
 *   本批全部委托到此处，语义按原样保留（originOf 的 `httpOnly` 参数即为此而设）。
 *   本模块**不接执行、不判定成功、不改 verification 语义**。
 */

// 任意 scheme（RFC 3986 §3.1：ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"）
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

// 裸域名形态：host（至少一个点）[:port][/path][?query][#hash]
// 刻意**不匹配**单标签主机名（localhost）—— 见文件头边界。
const BARE_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?(?:[/?#]\S*)?$/i;

// IPv4 字面量（与 BARE_HOST_RE 有重叠，故必须先判）：本地/自托管服务默认 **http**。
// 规则可解释：域名 → https（公网站点安全默认）；IP 字面量 → http（裸 IP 几无证书，
// 实测 fixture 全部形如 http://127.0.0.1:<port>/…）。这不是猜测，是有明确依据的默认值选择。
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#]\S*)?$/;

// 默认协议
const DEFAULT_SCHEME = 'https://';
const IPV4_SCHEME = 'http://';

// ---------- C149：自然语言 → 裸域 URL 的形状常量 ----------

// 候选扫描：host（≥2 段，末段全字母 2–24）[:port][/path]，要求左侧是「非域名字符」边界，
// 避免从 `xfoo.com.cn` 里抠出 `foo.com.cn`（吞掉前一个标签）。
const BARE_CANDIDATE_RE = /(?:^|[^\w.%+-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:\/\S{0,200})?)/gi;

// IPv4 字面量候选（裸域之外的另一类合法入口：本地/自托管服务）。与 IPV4_RE 同口径。
const IPV4_CANDIDATE_RE = /(?:^|[^\w.])((?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/\S{0,200})?)/g;

// TLD **白名单**（与 normalizeUrl 的「绝不猜」边界同一哲学：不放宽 = 不臆造入口）。
// 覆盖 2 字母 ccTLD 与常见 gTLD；`.test` 为保留域，产品夹具在用。
const TLD_WHITELIST = new Set(
  ('com org net edu gov mil int info biz name pro aero coop museum jobs travel mobi tel asia cat'
    + ' app dev page site online shop store tech cloud xyz top vip club live life world today news blog'
    + ' media art design studio agency digital network systems solutions services group team works tools'
    + ' zone space host website press review run fit fun icu link click one you io ai co me tv cc gg so test'
    + ' cn uk de fr jp kr ru br in au ca us nl it es se no dk fi pl ch at be cz gr pt tr il za mx ar cl sg'
    + ' my th vn ph id hk tw mo nz ie hu ro sk si hr bg lt lv ee ua by kz sa ae eg ng ke ma pe ec uy bo ve'
    + ' gt cr pa do jm tt').split(' '),
);

// 文件扩展名黑名单（**优先于白名单**）。与白名单有交集的项在此显式覆盖：
// `md`(摩尔多瓦/ Markdown)、`py`(巴拉圭/ Python)、`rs`(塞尔维亚/ Rust)、`sh`(圣赫勒拿/ Shell)。
// 语境判定：在这类「任务目标文本」里，`.md` 更可能是文件名而不是摩尔多瓦站点 ⇒ 保守按文件处理。
const TLD_DENY_FILE_EXT = new Set(
  ('md sh py rs js ts jsx tsx json html htm css scss less pdf doc docx xls xlsx ppt pptx'
    + ' png jpg jpeg gif svg webp avif ico bmp tif tiff mp3 mp4 avi mkv mov wav flac ogg'
    + ' zip rar 7z tar gz bz2 xz whl egg jar class exe dll msi dmg apk ipa iso img bin'
    + ' log bak tmp ini cfg conf toml env lock map min sqlite db dat csv tsv xml yaml yml txt rtf tex'
    + ' php rb go c cpp h hpp java kt swift lua').split(' '),
);

/**
 * 归一化：裸域名补默认 scheme；其余一律原样返回。
 * @param {*} raw
 * @returns {*} string 原样或补齐后的字符串；非字符串/空/不可判定 → 原值
 */
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (!s) return raw;
  if (/\s/.test(s)) return raw; // 含空白：不是单一 URL 形态
  // ⚠️ 判定顺序是本函数的正确性关键：裸域/IPv4 **必须先判**。
  //   原因（对拍实测暴露）：RFC 3986 §3.1 的 scheme 语法是 ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )，
  //   **允许点号** —— 于是 `example.com:8443/x` 会被 SCHEME_RE 匹配成「scheme=example.com」，
  //   判定为"已带 scheme"而原样返回，裸域 + 端口的形态照旧不可解析。
  //   裸域/IPv4 的形态比 scheme 更具体（要求至少一个点 + 冒号后只能是数字端口），故先判。
  if (IPV4_RE.test(s)) return IPV4_SCHEME + s; // IPv4 字面量：http
  if (BARE_HOST_RE.test(s)) return DEFAULT_SCHEME + s; // 裸域名：https
  if (SCHEME_RE.test(s)) return raw; // 已有 scheme（含 about:/data:/fixture:/javascript:）—— 绝不改写
  return raw;
}

/** 解析为 URL 对象（先归一化）；不可解析返回 null。 */
function parseUrl(raw) {
  const s = normalizeUrl(raw);
  if (typeof s !== 'string' || !s) return null;
  try {
    return new URL(s);
  } catch (e) {
    return null;
  }
}

/**
 * 站点标识（hostname，小写）。
 * RFC 3986 §3.2.2：host 大小写不敏感 —— 小写是唯一规范形态，
 * 与 `sites.safeHost` / `memory.safeHost` / `diagnosisDecision` 的口径对齐。
 * @returns {string|null}
 */
function hostOf(raw) {
  const u = parseUrl(raw);
  if (!u || !u.hostname) return null;
  return String(u.hostname).toLowerCase();
}

/**
 * origin（scheme://host[:port]）；originless 上下文返回 null。
 * @param {*} raw
 * @param {{httpOnly?: boolean}} [opts] httpOnly=true 时仅认 http/https（Skill 层调用口径）
 * @returns {string|null}
 */
function originOf(raw, opts) {
  const u = parseUrl(raw);
  if (!u || !u.hostname) return null;
  if (opts && opts.httpOnly && u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // about:blank / data: / blob: / file: 的 origin 恒为字符串 "null" → 语义上「无 origin」
  return u.origin && u.origin !== 'null' ? String(u.origin).toLowerCase() : null;
}

/**
 * 是否属于「不承载 origin 的本地上下文」（about: / data: / blob: / file: / 空）。
 *
 * 为什么必须与「origin 不可解析」区分开（C107 自测暴露的 P0-A B 类缺陷）：
 *   浏览器新页面的初始地址就是 about:blank，产品 launch 还会先打开一个 data: 欢迎页。
 *   这两类地址的 `location.origin` 恒为字符串 "null" —— 于是 originOf 返回 null，
 *   被旧实现归入 PAGE_ORIGIN_UNKNOWN → 拒绝；后果是**任何任务的第一步凭据 fill 都会被拒绝**
 *   （正常工作流直接死掉），而真实外泄场景（漂移到第三方 https 域）根本不经过这条分支。
 *   即：把「没有 origin」误当成「origin 未授权」，是纯粹的假阳性。
 *
 * 安全边界（为什么**不等于放行**）：这类上下文既不承载第三方站点、也不承载本站凭据输入，
 * 页面上不存在任何「属于某个 site 的凭据框」。真正的风险动作发生的前提是
 * 「页面已在一个 http(s) origin 上」，因此这里**不放行**凭据动作，而是要求先完成导航：
 * 上层据此走 `NO_ORIGIN_CONTEXT` 拒绝 + 留痕（fail closed，但归因正确、可恢复）。
 */
function isOriginlessLocalContext(url) {
  const s = String(url || '').trim();
  if (!s) return true; // 空 URL 视为尚未进入任何文档
  if (s === 'about:blank') return true;
  if (/^about:/i.test(s)) return true;
  if (/^data:/i.test(s)) return true;
  if (/^blob:/i.test(s)) return true;
  if (/^file:/i.test(s)) return true;
  return false;
}

/**
 * 从自然语言文本中提取**无 scheme 的裸域 URL**（C149）。
 *
 * 缺陷背景（A 类真缺陷，2026-09-28 端到端实测，非推理）：
 *   用户把网址写在目标文字里 —— 实测原文「注册并购买最便宜的月度会员（目标站点 sonymaxweb.com）」，
 *   `targetUrl` 字段留空（`task_mue92wqu9fp3g` / `task_mue95y79eylwj`）。
 *   而启发式 `URL_RE` 只认带 scheme 的完整 URL ⇒ `target` 恒为 null ⇒ 落库 `targetUrl` 为空
 *   ⇒ Profile 推荐拿不到 site ⇒ `runtime.ensureBrowser` 硬失败「任务未绑定 Profile」
 *   （519ms，不重试不升级，横跨 10 天未被立项）。
 *
 * 为什么不能"把正则放宽一点"（本批最大的风险面，C147 曾据此**有意**不改）：
 *   `report.pdf` / `index.html` / `1.5` / `v2.0` / `3.14` **全都命中「裸域形状」**。
 *   一律当 URL 提取 ⇒ 凭空造出 `https://report.pdf` 这种不存在的入口 —— 正是新缺陷类。
 *   故沿用本文件既有哲学（**白名单，绝不猜**），按形状三重门控：
 *     (1) 末段必须**全字母**且长度 2–24 ⇒ 直接杀掉 `1.5` / `v2.0` / `3.14`（末段是数字）
 *     (2) 末段必须在本文件 TLD **白名单**内（2 字母 ccTLD ∪ 常见 gTLD）
 *     (3) 末段不得是已知**文件扩展名**（与白名单有交集时本条优先，见 TLD_DENY_FILE_EXT）
 *   正反例双向可验证（见 `server/scripts/test_c149_url_from_text.js`）。
 *
 * 边界（诚实声明）：
 *   · 本函数**只处理无 scheme 的裸域**。带 scheme 的完整 URL 由调用方既有的 `URL_RE` 路径处理
 *     （C102 的「入口 URL 保真 + 中文标点边界」语义俱在，不在此重复实现第二份正则）。
 *   · 取**按出现顺序第一个**通过门控的候选（与 C102「多 URL 取第一个为入口」同口径）。
 *   · 提取不到返回 null —— 绝不臆造。
 *
 * @param {*} text
 * @returns {string|null} 补齐 scheme 后的绝对 URL；无匹配 → null
 */
function extractBareUrl(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s || !s.trim()) return null;
  // 两类候选合并后**按出现顺序**取第一个通过门控的（与 C102「多 URL 取第一个为入口」同口径）。
  const cands = [];
  BARE_CANDIDATE_RE.lastIndex = 0;
  IPV4_CANDIDATE_RE.lastIndex = 0;
  let m;
  while ((m = BARE_CANDIDATE_RE.exec(s)) !== null) cands.push({ i: m.index, t: m[1] });
  while ((m = IPV4_CANDIDATE_RE.exec(s)) !== null) cands.push({ i: m.index, t: m[1] });
  cands.sort((a, b) => a.i - b.i);
  for (const c of cands) {
    const cand = stripTrailingUrlPunct(c.t);
    if (isPlausibleEntryHost(cand)) return normalizeUrl(cand);
  }
  return null;
}

/** 剥掉 URL 尾部的中英文标点（C102 同口径：中文无空格分词，句号/右括号会被吃进 URL）。 */
function stripTrailingUrlPunct(s) {
  return String(s || '').replace(/[。，、；！？）」』】》.,;!?)\]}>]+$/, '');
}

/** 取末段（TLD 候选）。`a.b.com:8443/x` → `com`。 */
function tldOfToken(token) {
  const host = String(token || '').split('/')[0].split('?')[0].split('#')[0].split(':')[0].toLowerCase();
  const parts = host.split('.');
  return parts.length >= 2 ? parts[parts.length - 1] : '';
}

/**
 * 形状门控：token 是否**可判定为**入口主机（裸域或 IPv4 字面量）。
 * IPv4 走 IPV4_RE（四段数字，`1.5` / `3.14` 都不是 ⇒ 天然挡掉版本号）。
 * 裸域要求三重条件（末段全字母 → 在白名单 → 不在文件扩展名黑名单）全部满足。
 */
function isPlausibleEntryHost(token) {
  const t = String(token || '');
  if (!t) return false;
  if (IPV4_RE.test(t)) return true; // IPv4 字面量：http（与 normalizeUrl 同口径）
  if (!BARE_HOST_RE.test(t)) return false;
  const tld = tldOfToken(t);
  if (!/^[a-z]{2,24}$/.test(tld)) return false; // (1) 末段全字母 ⇒ 杀掉 1.5 / v2.0 / 3.14
  if (TLD_DENY_FILE_EXT.has(tld)) return false; // (3) 文件扩展名优先于白名单
  return TLD_WHITELIST.has(tld); // (2) 白名单
}

module.exports = {
  normalizeUrl,
  parseUrl,
  hostOf,
  originOf,
  isOriginlessLocalContext,
  extractBareUrl,
  stripTrailingUrlPunct,
  DEFAULT_SCHEME,
  SCHEME_RE,
  BARE_HOST_RE,
};
