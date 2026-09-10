'use strict';

// Observation Layer：生成压缩页面观察结果，不发送完整 HTML。
// (B3/B1 修复入口文件)
// 输出：{ url, title, textSummary, elements[], errors[] }
// 过滤：script/style/hidden 元素；password/cookie/token/authorization 一律 REDACTED。
// 接入 observationCache：url + 内容 hash 未变时直接复用缓存，省 token。

const obsCache = require('./observationCache');
// STEP 2：网络可观测层。挂在 page 上，采集 request/response/console/pageerror。
// 只观测，不判定；采集的文本一律脱敏（Authorization / token / 卡号 / CVV / 密码）。
const networkObserver = require('./network/networkObserver');
const networkReadiness = require('./networkReadiness');
// CAP-L1：通用支付字段识别（autocomplete token / 通用构词），页内脱敏令牌的单一真源。
const paymentField = require('./paymentField');
// Phase 15.0（GAP-1）：真实站点 challenge / 外部阻断检测（纯函数，零网络依赖）。
const challengeDetector = require('../fp/challengeDetector');

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'form', 'label', 'img', 'h1', 'h2', 'h3', 'p', 'summary']);

// v0.2.1：在 page 对象上挂载请求监听，得到真实的「网络是否仍在进行」信号。
// C106 F19 后收敛为独立模块 server/agent/networkReadiness.js —— 判据改为按请求类型分层
// （详见该模块），且挂载时机由 browserManager 在 page 创建时立即执行：
// 原先只在首次 inspect 时才挂，会漏掉页面加载期间的所有请求，
// 而「没抓到」会伪装成「已就绪」（比恒 pending 更危险）。
function ensureNetHook(page) {
  return networkReadiness.attach(page);
}
const ROLE_TAGS = { a: 'link', button: 'button', input: 'input', select: 'select', textarea: 'textarea', form: 'form', img: 'img' };

// 页面内执行：收集可见交互元素 + 可见文本摘要（不含敏感值）
//
// ⚠️ 本模板字符串有两条硬约束，违反后都不会报「正则写错了」，只会静默失效：
//
//   1) 禁止出现反引号（`）。一旦出现，模板字面量被提前闭合，整个 observation.js 在
//      require 阶段 SyntaxError（不是运行时报错），表现为「所有页面观察全线崩溃」
//      且任何测试都来不及跑。写注释时也不要用反引号包裹 HTML 片段（曾因此整模块编译失败）。
//      ${ } 只允许出现在本文件顶部已声明的常量注入处（_TAGS_JSON / _ROLES_JSON /
//      _SENS_TOKENS_JSON），且必须是 JSON.stringify 的结果 —— 这是刻意的单一真源设计，
//      让页内脚本与 Node 侧模块（如 paymentField.js）不可能漂移。禁止在页内逻辑里写 ${。
//
//   2) 正则里的反斜杠必须写成双反斜杠（源码里写 \\s / \\b / \\d，页内生效为 \s / \b / \d）。
//      模板字面量会先做一次转义处理，源码里只写一个反斜杠时会被当成转义序列吃掉：
//      写 \s 变成字母 s、写 \d 变成字母 d、写 \b 变成退格符 U+0008。
//      结果是正则**语法仍然合法、测试仍然通过，但匹配语义全变**（例如
//      写 /\s+/g 变成按字母 s 切分；写 \b\d{4} 变成「退格符+dddd」永不命中）。
//      2026-08-29 取证：脱敏五条规则里有四条因此完全失效 —— 观察层是喂给 LLM 的
//      唯一入口，等于卡号/CVV/Bearer token 一直以明文进入模型上下文。
//
// 自动化护栏见 test_step5_nearby_text.js：Case 1 编译守卫 + Case 8/11 真实浏览器
// 端到端脱敏断言（只比对源码文本的「一致性测试」抓不到第 2 条）。
const _TAGS_JSON = JSON.stringify([...INTERACTIVE_TAGS]);
const _ROLES_JSON = JSON.stringify(ROLE_TAGS);
// CAP-L1：敏感字段脱敏令牌。单一真源在 paymentField.js，此处以 JSON 注入页内脚本，
// 杜绝「Node 侧加了令牌、页内脚本没同步 → 明文进 LLM」这类静默漂移（同 SEC-E7 教训）。
const _SENS_TOKENS_JSON = JSON.stringify(paymentField.SENSITIVE_TOKENS);
// 精确命中键集（'exp' / 'pan' / 'mmyy' 这类短词只能整体相等命中，子串会误伤 panel / expand）
const _SENS_EXACT_JSON = JSON.stringify(paymentField.SENS_EXACT_KEYS);
const COLLECT_JS = `(() => {
  const INTERACTIVE_TAGS = new Set(${_TAGS_JSON});
  const ROLE_TAGS = ${_ROLES_JSON};
  const SENS_TOKENS = ${_SENS_TOKENS_JSON};
  const SENS_EXACT = new Set(${_SENS_EXACT_JSON});
  const out = { title: '', textSummary: '', visibleText: '', roleText: '', elements: [], errors: [], loadingState: 'unknown', domFingerprint: '' };
  out.title = document.title || '';
  const body = document.body;
  const isVisible = (el) => {
    if (el.hidden) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelFor = (el) => {
    if (el.labels && el.labels.length) return el.labels[0].innerText || '';
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText || ''; }
    return '';
  };
  // 脱敏规则必须与 server/security/redact.js 的 redactSecrets 保持一致
  // （test_step2_network_intelligence.js 有「脱敏规则一致性」断言做护栏）。
  const redact = (s) => String(s || '')
    // 1) k=v 形态，含 JSON 引号形态（"password":"xxx" —— 接口请求体里最常见的形态）。
    //    负向前瞻：值以 Bearer/Basic 开头时跳过，让位给规则 2；
    //    否则 'Authorization: Bearer x' 会被压成 'Authorization=REDACTED'，Bearer 标记连同内容一起被吃掉。
    .replace(/(password|passwd|pwd|passcode|cookie|token|authorization|auth|session|sessionid|otp|secret|credential|private[_-]?key|api[_-]?key|access[_-]?key|card|cardnumber|cvv|cvc)\\s*["']?\\s*[=:]\\s*(?!Bearer\\b|Basic\\b)["']?[^\\s"',}]+/gi, '$1=REDACTED')
    // 2) Bearer / Basic（顺序敏感：必须在规则 1 之后，由规则 1 的前瞻让位）
    .replace(/\\b(Bearer|Basic)\\s+[A-Za-z0-9.\\-_~+\\/=]+/gi, '$1 REDACTED')
    .replace(/\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b/g, 'CARD_REDACTED')
    // 15 位卡号（Amex 4-6-5 分组）
    .replace(/\\b\\d{4}[\\s-]?\\d{6}[\\s-]?\\d{5}\\b/g, 'CARD_REDACTED')
    .replace(/\\b\\d{3,4}\\b(?=\\s*cvv\\b)/gi, 'CVV_REDACTED')
    // 6) CVV「词在前、数字在后」：规则 1 只覆盖 cvv=123（需要 =/: 分隔），
    //    规则 5 只覆盖 123 cvv（数字在前）。而页面真实文本里「CVV 123」同样常见，
    //    实测 "cvc 123" 此前原样进入观察结果 —— 明文 CVV 会进 LLM 上下文。
    //    放在最后执行，不影响前面规则的输出形态（"cvv=REDACTED" 不会被二次改写）。
    //    ⚠️ 必须与 server/security/redact.js 的规则 6 保持同步。
    .replace(/\\b(cvv|cvc|cvn|security\\s*code)\\s*[:=]?\\s*(\\d{3,4})\\b/gi, '$1 REDACTED');

  // ── Signal 3 邻近文本采集（修复 CAP-E6-NEARBY-TEXT-DEAD）──
  // 背景：semanticResolver.scoreNearbyText() 读 parentText/siblingText/nearbyText/containerText，
  // 但本脚本此前从不写入这四个字段 → 该信号在生产中恒为 0 分（Resolver 五个信号里有一个是死壳）。
  // 它本该解决的真实形态：「h3 用户名 + input name=username」—— 没有 label[for] 关联，
  // 控件自身只有英文 name，语义只存在于旁边的标题文字。真实站点大量用 div/h3/p 做字段标题。
  //
  // 采集约束（都是这套信号特有的坑，改这段代码前请先读）：
  //   1) 只取「紧邻在前的文本」，不取父容器全部直接文本 —— 否则
  //      「div 里平铺 用户名+input#a+密码+input#b」时两个 input 都会拿到
  //      「用户名 密码」，互相串味，定位必然错（这一条是必须守住的正确性底线）。
  //   2) 前一个兄弟元素必须是「标题型」且内部不含别的控件 —— 否则
  //      「button 提交 + input」会把按钮文字当成字段标签。
  //   3) 一律脱敏：这是新增的文本外泄面，必须走与 label/placeholder 相同的 redact。
  const _cap = (s, n) => { try { return String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n); } catch (e) { return ''; } };
  // 标题型标签：真实站点里承担「字段标题」角色的标签（刻意不含 input/button/a 等控件）
  const TITLE_LIKE = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'legend', 'dt', 'th',
    'figcaption', 'caption', 'strong', 'b', 'em', 'span', 'small', 'p', 'div', 'td', 'li']);
  const CONTROL_LIKE = new Set(['input', 'textarea', 'select', 'button', 'a', 'summary']);
  const _hasControl = (el) => { try { return !!el.querySelector('input,textarea,select,button,a'); } catch (e) { return false; } };
  // (1) 紧邻在前的文本节点（遇到任何元素即停止）
  const precedingText = (el) => {
    try {
      const parts = [];
      let n = el.previousSibling;
      while (n && n.nodeType === 3) {
        const t = String(n.nodeValue || '').trim();
        if (t) parts.unshift(t);
        n = n.previousSibling;
      }
      return _cap(parts.join(' '), 80);
    } catch (e) { return ''; }
  };
  // (2) 前一个兄弟元素（标题型 + 短文本 + 内部无其它控件）
  const siblingTextOf = (el) => {
    try {
      const s = el.previousElementSibling;
      if (!s) return '';
      const t = String(s.tagName || '').toLowerCase();
      if (!TITLE_LIKE.has(t) || CONTROL_LIKE.has(t)) return '';
      if (_hasControl(s)) return '';
      const txt = _cap((s.innerText || s.textContent || ''), 80);
      // 超过 40 字的是内容块，不是字段标签
      return txt.length <= 40 ? txt : '';
    } catch (e) { return ''; }
  };
  // (3) 容器可访问名：最近 form/fieldset 的 aria-label 或 legend（仅短文本，避免整页文本灌入）
  const containerTextOf = (el) => {
    try {
      const box = el.closest ? el.closest('form,fieldset,[role="group"]') : null;
      if (!box) return '';
      const aria = String((box.getAttribute && box.getAttribute('aria-label')) || '').trim();
      if (aria) { const t = _cap(aria, 80); return t.length <= 40 ? t : ''; }
      const lg = box.querySelector ? box.querySelector('legend') : null;
      if (lg) { const t = _cap((lg.innerText || lg.textContent || ''), 80); return t.length <= 40 ? t : ''; }
      return '';
    } catch (e) { return ''; }
  };
  const nearbyOf = (el) => {
    const siblingText = siblingTextOf(el);
    const parentText = precedingText(el);
    return {
      siblingText: redact(siblingText),
      parentText: redact(parentText),
      nearbyText: redact(_cap((parentText + ' ' + siblingText).trim(), 120)),
      containerText: redact(containerTextOf(el)),
    };
  };
  const seen = new Set();

  // 元素状态（disabled / value / checked / selected 等），用于语义定位与验证
  const elState = (el) => {
    const tag = (el.tagName || '').toLowerCase();
    const s = { disabled: !!el.disabled };
    if (tag === 'input') {
      const t = ((typeof el.getAttribute === 'function' && el.getAttribute('type')) || 'text').toLowerCase();
      s.type = t;
      // 敏感字段（password/secret/token/...）：明文值禁止离开浏览器（防泄漏），
      // 仅暴露长度与 sensitive 标记，供 verification 做「是否已填写」判定而不暴露内容（B1 安全修复）。
      const _ac = (el.getAttribute ? (el.getAttribute('autocomplete') || '') : '');
      const _nm = (el.getAttribute ? (el.getAttribute('name') || '') : '') + ' ' +
        (el.getAttribute ? (el.getAttribute('id') || '') : '') + ' ' +
        (el.getAttribute ? (el.getAttribute('placeholder') || '') : '') + ' ' +
        (el.getAttribute ? (el.getAttribute('aria-label') || '') : '') + ' ' + _ac;
      const _sensType = /^(password|passwd|pwd|secret|token|otp|cvc|cvv|cc|card|cardnumber|ccnumber|account_number|ssn)$/i.test(t);
      const _sensName = /(password|passwd|pwd|secret|token|otp|cvc|cvv|card|ccv|ssn|social)/i.test(_nm);
      // CAP-L1：补齐两个此前完全遗漏的判定面 ——
      //   (a) autocomplete 是 W3C 标准里站点自声明的字段语义（cc-number / cc-csc / cc-exp），
      //       也是陌生站点上**唯一可判定**的信号。此前完全不看它，于是
      //       name="number" autocomplete="cc-number" 的卡号框 value 以明文进了观察结果。
      //   (b) 历史别名漏掉了 ccnum / ccnumber / cvv2 / csc / expiry / expdate / securitycode 等
      //       真实站点常见写法（SENS_TOKENS 由 paymentField.js 注入，单一真源）。
      //   ⚠️ 匹配用 substring 而非正则：页内脚本里写正则极易踩「模板字面量吃掉反斜杠」的坑
      //      （SEC-E7：四条脱敏规则因此静默失效），无正则 = 无转义面。
      const _nz = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, '');
      // 子串命中：复合词（cardholdername 含 cardholder）。key 是所有属性拼成一串，
      // 因此 autocomplete=cc-number + name=number 也能靠 'cardnumber' 之外的路径命中。
      const _sensKey = _nz(_nm);
      const _sensToken = SENS_TOKENS.some((tk) => _sensKey.indexOf(tk) >= 0);
      // 精确命中：'exp' / 'pan' / 'mmyy' / 'csc' 这类短词只能整体相等判定 ——
      // 子串匹配会把 panel / expand / company 误判成卡号。
      // 必须逐个属性分别比对，不能拼成一串后再比对（拼串后 'exp'+'cc-exp' 变成
      // 'expexccexp'，整体相等永远不成立 —— 这正是 name="exp" autocomplete="cc-exp"
      // 的有效期框此前漏网的原因：它是真实网关最常见的写法之一）。
      const _labels = (function () { try { return labelFor(el) || ''; } catch (e) { return ''; } })();
      const _sensExact = SENS_EXACT.has(_nz(el.getAttribute ? el.getAttribute('name') : null))
        || SENS_EXACT.has(_nz(el.id))
        || SENS_EXACT.has(_nz(el.getAttribute ? el.getAttribute('placeholder') : null))
        || SENS_EXACT.has(_nz(el.getAttribute ? el.getAttribute('aria-label') : null))
        || SENS_EXACT.has(_nz(_ac))
        || SENS_EXACT.has(_nz(_labels));
      if (_sensType || _sensName || _sensToken || _sensExact) {
        const raw = (el.value || '');
        s.value = '';                 // 敏感字段明文不出浏览器
        s.sensitive = true;
        s.valueLength = raw.length;   // 仅暴露长度，供「是否已填写」判定
      } else {
        s.value = (el.value || '').slice(0, 120);
      }
      if (t === 'checkbox' || t === 'radio') s.checked = !!el.checked;
      s.readOnly = !!el.readOnly;
    } else if (tag === 'select') {
      s.value = el.value || '';
      try { s.selectedText = (el.options && el.selectedIndex >= 0) ? (el.options[el.selectedIndex].text || '') : ''; } catch (e) {}
    } else if (tag === 'textarea') {
      s.value = (el.value || '').slice(0, 120);
    }
    return s;
  };
  // 结构化包围盒（同时保留 bbox 兼容旧字段）
  const bboxObj = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  // C105 M3：中心点命中测试（hit-test）。语义评分只能回答「像不像目标」，回答不了
  // 「此刻点不点得到」——被 overlay / cookie banner / sticky 层覆盖的按钮与正常按钮同分，
  // 点下去打在遮挡层上：要么静默无效果，要么 30s 超时后走恢复链烧预算。
  // 只判可交互元素（elementFromPoint 有布局成本，且只有动作目标需要这个信号）。
  // 取值：clear（命中自身/自身后代/自身祖先）| occluded（中心被他元素覆盖）|
  //       offscreen（中心在视口外，scroll 后仍可点，不做否决）| zero-area | unknown。
  const occlusionOf = (el, box) => {
    try {
      if (!box || !(box.w > 0) || !(box.h > 0)) return 'zero-area';
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      if (cx < 0 || cy < 0 || cx > (window.innerWidth || 0) || cy > (window.innerHeight || 0)) return 'offscreen';
      const hit = document.elementFromPoint(cx, cy);
      if (!hit) return 'unknown';
      if (hit === el || el.contains(hit) || hit.contains(el)) return 'clear';
      return 'occluded';
    } catch (e) { return 'unknown'; }
  };
  // 为元素构造 CSS 选择器（主要用于 iframe 内元素定位）；主文档元素不强制带 selector。
  const cssFor = (el) => {
    // C106 F17：真实站点实证 —— webflow.com/signup 上 page.evaluate 整体抛
    //   TypeError: Cannot read properties of undefined (reading 'toLowerCase')
    // 根因即本行：某些节点（非标准元素 / 被脚本覆写 tagName 的节点）没有 tagName，
    // 一次访问就让整页观察失败 → 观察空集 → 所有动作误报 ELEMENT_NOT_FOUND。
    const tag = String(el.tagName || '').toLowerCase();
    if (el.id) return tag + '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    const attrs = [];
    const nm = el.getAttribute && el.getAttribute('name');
    const ty = el.getAttribute && el.getAttribute('type');
    const ar = el.getAttribute && el.getAttribute('aria-label');
    const ro = el.getAttribute && el.getAttribute('role');
    if (nm) attrs.push('[name="' + String(nm).replace(/"/g, "'") + '"]');
    if (ty) attrs.push('[type="' + String(ty).replace(/"/g, "'") + '"]');
    if (ar) attrs.push('[aria-label="' + String(ar).replace(/"/g, "'") + '"]');
    if (ro) attrs.push('[role="' + String(ro).replace(/"/g, "'") + '"]');
    if (!attrs.length && el.className && typeof el.className === 'string') {
      const c = el.className.trim().split(/\\s+/)[0];
      if (c) attrs.push('.' + (window.CSS && CSS.escape ? CSS.escape(c) : c));
    }
    return tag + attrs.slice(0, 3).join('');
  };
  // iframe 寻址：生成 ' >> ' 分段里那一段 iframe 选择器。
  //
  // CAP-F2 修复。这里连着错了两层，只修第一层会留下更难查的第二层：
  //
  //   ① 原实现用全局自增计数器生成 iframe:nth-of-type(n)。但 nth-of-type 的语义是
  //      「同父级同类型兄弟中的第 N 个」，不是「全文第 N 个 iframe」。
  //      两个 iframe 分属不同容器时（<div id=a><iframe></div> 与 <div id=b><iframe></div>），
  //      正确索引都是 1，计数器却给出 1 和 2；iframe 嵌套 iframe 时内层也应从 1 重新数。
  //      于是选择器指向错误的 iframe，或直接匹配不到任何元素。
  //
  //   ② 那么把计数器换成「同父级序号」（正确的 nth-of-type 语义）够不够？也不够 ——
  //      上面那个例子里两个 iframe 的 nth-of-type 都是 1，选择器变成**歧义**的；
  //      实测 3 个分属不同容器的 iframe 会被 "iframe:nth-of-type(1)" 全部命中，
  //      Playwright 严格模式下直接抛 strict mode violation。
  //      旧实现「编号唯一但指向不存在的元素」，纯同父级序号「编号正确但不唯一」——两者都不可用。
  //
  //   本质错配：旧实现数的是**文档序**，写出来的却是**同父级序**（nth-of-type）。
  //   因此位置型兜底改用 Playwright 的 :nth-match(iframe, n) —— 它表达的正是文档序，
  //   且天然唯一。同时仍优先用 id / name 这类语义更稳、可读性更好的候选。
  //
  //   这才是「嵌套表单不可操作」的真正根因 —— 寻址方案（' >> ' + makeLocator）本来就有且可用，
  //   只是这一段选择器生成得不对。因此这里修选择器，而不是新增一个有状态的 switchFrame 动作：
  //   后者会引入第二套寻址体系，与 observation 产出的选择器互相打架，且状态会在 step 之间泄漏。
  const _esc = (v) => (typeof CSS !== 'undefined' && CSS && CSS.escape ? CSS.escape(v) : String(v));
  const _uniq = (doc, sel) => {
    try { return !!doc && doc.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  };
  const iframeSelectorFor = (el, docIdx) => {
    const doc = el.ownerDocument;
    const cands = [];
    if (el.id) cands.push('iframe#' + _esc(el.id));
    const nm = el.getAttribute && el.getAttribute('name');
    if (nm) cands.push('iframe[name="' + String(nm).replace(/"/g, "'") + '"]');
    // 位置型兜底必须是文档序（:nth-match），不能是 nth-of-type：后者按同父级兄弟计数，
    // 多个 iframe 分属不同容器时索引重复，选择器会变成歧义的（实测 3 个 iframe 全是 1）。
    cands.push('iframe:nth-match(iframe, ' + docIdx + ')');
    for (const c of cands) { if (_uniq(doc, c)) return c; }
    return cands[cands.length - 1];
  };
  const walk = (root, prefix) => {
    if (!root || !root.querySelectorAll) return;
    const all = root.querySelectorAll('*');
    // 每个文档独立计数：:nth-match(iframe, n) 是在「父文档」内计数的，
    // 嵌套 iframe 必须在自己的文档里从 1 重新数，否则内层索引会接着外层累加。
    let iframeIdxInDoc = 0;
    for (const el of all) {
      if (seen.has(el)) continue;
      seen.add(el);
      // C106 F17：同上，tagName 缺失不得让整页观察失效（真实站点实证）。
      const tag = String(el.tagName || '').toLowerCase();
      if (!tag) continue;
      if (['script', 'style', 'noscript', 'template', 'svg', 'head'].includes(tag)) continue;
      // iframe：仅同域可读取其内部 DOM 并递归收集其交互元素；跨域 iframe 浏览器禁止访问，直接跳过。
      if (tag === 'iframe') {
        let fdoc = null;
        try { fdoc = el.contentDocument; } catch (e) { fdoc = null; }
        if (fdoc && fdoc.body) {
          iframeIdxInDoc++;
          const fprefix = (prefix ? prefix + ' >> ' : '') + iframeSelectorFor(el, iframeIdxInDoc);
          walk(fdoc, fprefix);
        }
        continue;
      }
      const roleAttr = el.getAttribute && el.getAttribute('role');
      const role = roleAttr || ROLE_TAGS[tag] || null;
      // STEP 7：draggable="true" 也要收。看板卡片、拖拽排序、拖拽上传区大量用
      // <div draggable="true"> —— 它们既不在 INTERACTIVE_TAGS 里、也没有 role，
      // 于是被整条采集链丢掉：Planner 看不到拖拽源，拖拽的放置区（多半也是纯容器）
      // 同样看不到。draggable 是 W3C 标准属性，属通用判定，不是站点特化。
      // 代价是元素集变大，因此只对声明了 draggable="true" 的元素放行，不放宽到任意 div。
      const isDraggable = !!(el.getAttribute && el.getAttribute('draggable') === 'true');
      const isInteractive = INTERACTIVE_TAGS.has(tag) || !!roleAttr || isDraggable;
      if (!isInteractive) continue;
      if (!isVisible(el)) continue;
      const elSelector = prefix ? (prefix + ' >> ' + cssFor(el)) : null;
      let text = '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const ph = el.getAttribute('placeholder') || '';
        const name = el.getAttribute('name') || '';
        const type = el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text');
        const lbl = labelFor(el);
        const aria = el.getAttribute('aria-label') || '';
        // CAP-L1：autocomplete 是 W3C 标准中站点自声明的字段语义（cc-number / cc-exp /
        // cc-csc ...）。陌生站点上没有别的信号比它更可靠，且它本身不含任何秘密，
        // 因此可以安全进 LLM 上下文 —— 有了它，AI 才能把「这个输入框」对上「卡号的哪一段」。
        const ac = el.getAttribute('autocomplete') || '';
        text = [lbl, ph, aria, name].filter(Boolean).join(' | ');
        const box = bboxObj(el);
        const hit = occlusionOf(el, box);
        out.elements.push({
          // C105 M3：hit-test 三字段（occluded 是 semanticResolver F8 的否决开关；
          // hitTest 原始取值保留供诊断 —— offscreen/unknown 一律不否决）
          hitTest: hit, occluded: hit === 'occluded',
          id: el.id || null, role, tag, type, name: name || null,
          autocomplete: ac ? String(ac).trim().toLowerCase().slice(0, 60) : null,
          // C105 M2：data-testid 站点自声明的测试权威身份（业界事实标准，稳定性高于构建哈希化 id）
          testId: (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa') || null),
          cls: (el.getAttribute('class') || '').trim().slice(0, 60) || null,
          text: redact(text).slice(0, 200),
          placeholder: ph ? redact(ph).slice(0, 100) : null,
          label: lbl ? redact(lbl).slice(0, 100) : null,
          ariaLabel: aria ? redact(aria).slice(0, 100) || null : null,
          visible: true,
          bbox: box,
          boundingBox: box,
          innerText: redact((el.innerText || '').trim()).slice(0, 300),
          roleText: (role + ': ' + redact((text || '').trim())).slice(0, 160),
          state: elState(el),
          selector: elSelector,
          inFrame: !!prefix,
          // Signal 3 邻近文本（CAP-E6）：无 label[for] 关联时，语义只存在于旁边的标题文字里
          ...nearbyOf(el),
        });
      } else {
        text = (el.innerText || el.textContent || '').trim();
        if (tag === 'img') text = el.getAttribute('alt') || '';
        // Phase 9 P1 — Candidate Discovery Gap 修复：
        // INTERACTIVE_TAGS 声明收集 form/label/h1~h3/img/p，但此前只有
        // a/button/summary/带 role 属性的元素会被写入 elements[]。
        // 结果：<form id="regForm"> 在页面上真实存在，却一个候选都进不了
        // elements[]（elements[] 是 semanticResolver 的唯一候选池），
        // 导致 element_present="form" 恒为「未找到元素 "form"」。
        // phase68 证据：36 次该失败、9 个任务全部卡死在 step0，后续步骤从未执行。
        // 这里把「结构性容器与标题」补齐进候选池。
        // 刻意不加入 p/div/span：数量大，会挤爆 80 条上限并稀释排序；
        // 且它们的文本已由 textSummary 覆盖，text_present 验证不受影响。
        if (tag === 'a' || tag === 'button' || tag === 'summary' || roleAttr
            || tag === 'form' || tag === 'label' || tag === 'h1' || tag === 'h2' || tag === 'h3') {
          const box = bboxObj(el);
          const hit = occlusionOf(el, box);
          // C105 M2：testId 同输入分支；href 只存 pathname（剥 query/hash —— query 可携带
          // token/session 等敏感参数不进上下文，pathname 已足够做 a[href*=] 结构接地）。
          let hrefPath = null;
          if (tag === 'a') {
            try {
              const raw = el.getAttribute('href') || '';
              if (raw && !/^(javascript|mailto|tel):/i.test(raw)) {
                hrefPath = new URL(raw, location.href).pathname || '/';
              }
            } catch (e) { hrefPath = null; }
          }
          out.elements.push({
            id: el.id || null, role, tag, type: tag, name: null,
            // C105 M3：hit-test 三字段（同输入分支）
            hitTest: hit, occluded: hit === 'occluded',
            testId: (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa') || null),
            href: hrefPath,
            cls: (el.getAttribute('class') || '').trim().slice(0, 60) || null,
            text: redact(text).slice(0, 200),
            placeholder: null, label: null, ariaLabel: redact(el.getAttribute('aria-label') || '').slice(0, 100) || null,
            visible: true,
            bbox: box,
            boundingBox: box,
            innerText: redact((el.innerText || el.textContent || '').trim()).slice(0, 300),
            roleText: (role + ': ' + redact(text)).slice(0, 160),
            state: elState(el),
            selector: elSelector,
            inFrame: !!prefix,
            // Signal 3 邻近文本（CAP-E6）：纯图标按钮的语义只存在于旁边的说明文字里
            ...nearbyOf(el),
          });
        }
      }
    }
  };
  // C106 F17 保底：walk 内任何未预料的单元素异常，都不应让整页观察归零。
  // 真实站点实证（webflow.com/signup）：一次属性访问 TypeError → 整个 evaluate 失败
  // → 上层拿到 {ok:false} 且无 observation → 所有动作报「未找到输入目标」，
  // 与页面真实内容完全无关。这里截断到异常发生处，保留已采集元素并留痕，
  // 使观察降级为「部分可见」而不是「全盲」。
  try {
    walk(body, '');
  } catch (e) {
    out.walkError = String((e && e.message) || e).slice(0, 200);
  }
  // 可见文本摘要（去重、截断、脱敏）。标签集合扩展至 div/td/th 等内容容器，
  // 修复 Phase 5 发现的 text_present 对 <div> 动态渲染内容的盲区（verification 读取本字段）。
  const texts = [];
  const seenT = new Set();
  for (const el of body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,summary,span,div,td,th,label,button,a,option,strong,b,em,code')) {
    if (!isVisible(el)) continue;
    const t = (el.innerText || '').trim();
    if (t && t.length > 1 && !seenT.has(t)) { seenT.add(t); texts.push(t); }
  }
  out.textSummary = redact(texts.slice(0, 120).join(' ')).slice(0, 5000);

  // 完整可见文本（全页面 innerText，去重行、截断）—— 富文本通道，供 Planner / 验证消费
  const fullLines = (body.innerText || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
  const seenL = new Set();
  const full = [];
  for (const l of fullLines) { if (!seenL.has(l)) { seenL.add(l); full.push(l); } }
  out.visibleText = redact(full.join('\\n')).slice(0, 8000);

  // 角色文本：交互 / 带 role 元素的「role: 文本」列表，辅助语义定位与验证
  const roleLines = [];
  for (const el of out.elements) { if (el.roleText) roleLines.push(el.roleText); }
  out.roleText = roleLines.slice(0, 150).join(' | ').slice(0, 5000);
  // 常见错误关键字扫描
  const errRe = /(error|failed|invalid|forbidden|denied|try again|captcha|oops|exception|404|500)/i;
  if (errRe.test(out.textSummary)) out.errors.push('页面文本包含疑似错误关键词');

  // v0.2.1：真实采集加载状态（DOM 级，非虚拟）
  const rs = document.readyState;
  out.loadingState = rs === 'complete' ? 'complete' : (rs === 'interactive' ? 'interactive' : 'loading');

  // STEP 22 (V1)：真实 Web Storage 快照（localStorage/sessionStorage），供 verification 的
  // storage 证据（登录态/业务状态持久化断言）。只读采集，绝不写入。
  // 脱敏纪律：键名命中敏感令牌（password/token/secret/... 单一真源 SENS_TOKENS/SENS_EXACT）
  // 的条目只输出 REDACTED 占位；其余键值经与文本相同的 redact 后截断，防灌爆观察层。
  out.storage = { localStorage: {}, sessionStorage: {} };
  const _nzK = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const _isSensKey = (k) => { const z = _nzK(k); return SENS_TOKENS.some((tk) => z.indexOf(tk) >= 0) || SENS_EXACT.has(z); };
  const _capStore = (st, dst) => {
    try {
      if (!st) return;
      let n = 0;
      for (let i = 0; i < st.length && n < 50; i++) {
        const k = st.key(i);
        if (k == null) continue;
        let v = '';
        try { v = String(st.getItem(k) || ''); } catch (e2) { v = ''; }
        if (_isSensKey(k)) { dst[k] = 'REDACTED'; }
        else { const capped = v.length > 200 ? (v.slice(0, 200) + '...') : v; dst[k] = redact(capped); }
        n++;
      }
    } catch (e) {}
  };
  try { _capStore(window.localStorage, out.storage.localStorage); } catch (e) {}
  try { _capStore(window.sessionStorage, out.storage.sessionStorage); } catch (e) {}

  // v0.2.1：DOM 指纹（结构化元素 + 文本的轻量哈希），供 VIL 判 DOM_CHANGED / mutationState
  let _h = 0;
  const _str = (out.elements || []).map((e) => [e.id, e.role, e.text, e.placeholder, e.label, e.ariaLabel].join('|')).join('#') + '::' + (out.textSummary || '');
  for (let i = 0; i < _str.length; i++) { _h = (_h * 31 + _str.charCodeAt(i)) | 0; }
  out.domFingerprint = ('0000000' + (_h >>> 0).toString(16)).slice(-8);

  return out;
})()`;

// v0.2.2 Business Capability：diff 细分辅助函数（P2）。
// 仅对 elements 做轻量签名比较，不增加 IO；供 previousObservationDiff 的
// elementStateChanged / pageStructureChanged 判定（向后兼容：旧消费者忽略新字段）。
function elementStateSig(els) {
  return (els || []).map((e) => {
    const s = e.state || {};
    const vlen = (s.valueLength != null) ? s.valueLength : (s.value != null ? String(s.value).length : 0);
    return [s.disabled ? 1 : 0, s.sensitive ? 1 : 0, vlen, s.checked ? 1 : 0].join(':');
  }).join('|');
}
function elementStructSig(els) {
  return (els || []).map((e) => [e.tag, e.id, e.role, e.selector, e.type].join(':')).join('|');
}

// v0.2.2：观察血缘（lineage）—— 每个 Observation 携带可审计的标识与时间链，
// 供「Fresh Observation」判定与「STALE_OBSERVATION」检测（Business Loop 专项 §七/§八）。
//  - observationId：本次观察唯一 id
//  - capturedAt：采集时间戳（== timestamp 语义，单一名词）
//  - source：观察来源（before_action | after_action | verification_window | repair | inspect）
//  - parentObservationId：同 task 上一次观察的 id（血缘链）
//  - actionFinishedAt：触发本次观察的动作完成时间戳（after_action / verification_window 才有）
//  - fresh：capturedAt > actionFinishedAt 为真；无 actionFinishedAt 则 null（未知，禁止假装 fresh）
//  - taskId / stepId / attemptId：血缘归属（来自调用方 opts，缺省为空）
function obsId(prefix) {
  return (prefix || 'obs_') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// C72（2026-09-08）缓存命中路径的动态字段一致性：network/storage 在缓存命中时本就刷新，
// 但 challenge 检测与 networkState 此前只跑在新鲜路径 —— 被拦截页面 DOM 静止（403/429/503
// 后 DOM 不变极常见）时后续观察全部缓存命中，EXTERNAL_BLOCK/INTERACTIVE_CHALLENGE 永不触发，
// 任务烧满预算而不是升级人工。提取为共享函数，新鲜/缓存两条路径消费同一实现（单点无漂移）。
function computeNetworkState(page) {
  return networkReadiness.compute(page);
}
function computeChallenge(observation) {
  try {
    const _failures = (observation.network && observation.network.failures) || [];
    const blockedDoc = _failures.find((r) => r && r.resourceType === 'document'
      && (r.status === 403 || r.status === 429 || r.status === 503));
    return challengeDetector.detectChallenge({
      status: blockedDoc ? blockedDoc.status : null,
      html: (observation.textSummary || '') + '\n' + (observation.visibleText || ''),
      title: observation.title || '',
    });
  } catch (e) {
    return null; // 检测是增强能力，绝不成为新故障源
  }
}

async function inspect(page, opts = {}) {
  let data;
  try {
    data = await page.evaluate(COLLECT_JS);
  } catch (e) {
    return { ok: false, error: '页面不可观察: ' + String(e.message || e).slice(0, 200) };
  }

  // 稳定 hash：url + elements + textSummary
  const hash = obsCache.hashContent(data.textSummary || '', data.elements || []);
  if (!opts.skipCache && opts.taskId) {
    const hit = obsCache.get(opts.taskId, data.url || (page.url && page.url()) || '', data.textSummary || '', data.elements || []);
    if (hit.hit) {
      // 缓存命中时网络快照仍需刷新：DOM 一样不代表网络状态一样。
      const cached = hit.summary;
      try { cached.network = networkObserver.snapshot(page, { limit: 20 }); } catch (e) {}
      // C72：networkState 与 challenge 与 network 同批刷新（此前只跑在新鲜路径 ——
      // 被拦截页面 DOM 静止时缓存命中恒走旧值，EXTERNAL_BLOCK 永不触发）。
      cached.networkState = computeNetworkState(page);
      // STEP 22 (V1)：storage 同理必须刷新 —— 登录态写入 localStorage 不一定伴随 DOM 变化，
      // 若沿用缓存观察会让 storage 验证读到过期状态（假 FAIL/假 PASS 都可能）。
      cached.storage = data.storage || { localStorage: {}, sessionStorage: {} };
      cached.challenge = computeChallenge(cached);
      return { ok: true, cached: true, observation: cached };
    }
  }

  const capturedAt = Date.now();
  const observation = {
    observationId: obsId('obs_'),
    url: data.url || (page.url ? page.url() : '') || '',
    title: data.title || '',
    textSummary: data.textSummary || '',
    visibleText: data.visibleText || '',
    roleText: data.roleText || '',
    elements: (data.elements || []).slice(0, 80),
    errors: (data.errors || []).slice(0, 10),
    // v0.2.1 新增真实字段（向后兼容：旧消费者忽略）
    timestamp: capturedAt,
    capturedAt,
    loadingState: data.loadingState || 'unknown',
    domFingerprint: data.domFingerprint || '',
    // STEP 22 (V1)：真实 Web Storage 快照（无则视为未采集，storage 验证将 fail-closed）
    storage: data.storage || null,
    networkState: 'unknown',
    elementState: {
      total: (data.elements || []).length,
      withValue: (data.elements || []).filter((e) => e.state && e.state.value).length,
    },
    // v0.2.2 血缘字段（Business Loop 专项 §七/§八）
    source: opts.source || 'inspect',
    parentObservationId: null,
    actionFinishedAt: (typeof opts.actionFinishedAt === 'number') ? opts.actionFinishedAt : null,
    fresh: (typeof opts.actionFinishedAt === 'number') ? (capturedAt > opts.actionFinishedAt) : null,
    taskId: opts.taskId || null,
    stepId: opts.stepId || null,
    attemptId: opts.attemptId || null,
    previousObservationDiff: { urlChanged: false, textChanged: false, domChanged: false, keyTextChanged: false, elementStateChanged: false, pageStructureChanged: false },
  };
  // 真实网络状态：本 page 实例的请求计数器（C72：与缓存命中路径共享同一实现）
  ensureNetHook(page);
  observation.networkState = computeNetworkState(page);
  // STEP 2：结构化网络快照（请求/响应/失败/console/pageerror，全部脱敏）。
  // 只读，不参与任何成功判定 —— 供 Diagnosis（STEP 3）与 Self-Healing（STEP 4）消费。
  try {
    observation.network = networkObserver.snapshot(page, { limit: 20 });
  } catch (e) {
    observation.network = null;
  }
  // Phase 15.0（GAP-1）：真实站点 challenge / 外部阻断检测（Phase 14 challengeDetector 接入
  // runtime 诊断主路径）。只识别、不处理 —— 检测结果交由 failureDiagnoser 分类
  // （EXTERNAL_BLOCK / INTERACTIVE_CHALLENGE → escalate → HUMAN_ESCALATION）。
  // 数据源：Node 侧已脱敏文本（textSummary/visibleText/title）+ 网络快照中主文档
  // （resourceType=document）的阻断状态码（403/429/503）。绝不改验证语义、绝不触发处理动作。
  // PX beacon 全站存在 ≠ 拦截：challengeDetector 内部三层判定负责防误报。
  // C72：与缓存命中路径共享同一实现（computeChallenge）。
  observation.challenge = computeChallenge(observation);
  // 真实 before/after 差异：与同一 task 上一次观察对比（供 VIL 判 DOM_CHANGED / mutationState）
  if (opts.taskId) {
    const prev = obsCache.last(opts.taskId);
    if (prev) {
      observation.parentObservationId = prev.observationId || null;
      observation.previousObservationDiff = {
        urlChanged: prev.url !== observation.url,
        textChanged: prev.textSummary !== observation.textSummary,
        domChanged: prev.domFingerprint !== observation.domFingerprint,
        keyTextChanged: (prev.visibleText || '') !== (observation.visibleText || ''),
        elementStateChanged: elementStateSig(prev.elements) !== elementStateSig(observation.elements),
        pageStructureChanged: elementStructSig(prev.elements) !== elementStructSig(observation.elements),
      };
    }
  }
  if (opts.taskId) obsCache.set(opts.taskId, observation.url, hash, observation);
  return { ok: true, cached: false, observation };
}

module.exports = { inspect, COLLECT_JS, elementStateSig, elementStructSig };
