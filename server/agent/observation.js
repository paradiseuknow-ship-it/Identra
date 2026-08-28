'use strict';

// Observation Layer：生成压缩页面观察结果，不发送完整 HTML。
// (B3/B1 修复入口文件)
// 输出：{ url, title, textSummary, elements[], errors[] }
// 过滤：script/style/hidden 元素；password/cookie/token/authorization 一律 REDACTED。
// 接入 observationCache：url + 内容 hash 未变时直接复用缓存，省 token。

const obsCache = require('./observationCache');

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'form', 'label', 'img', 'h1', 'h2', 'h3', 'p', 'summary']);

// v0.2.1：在 page 对象上挂载一次性请求计数器，得到真实的「网络是否仍在进行」信号。
// 不新增全局 event system —— 仅按需为本 page 实例挂 Playwright 原生 request 监听。
function ensureNetHook(page) {
  if (!page) return;
  if (page.__vilNetHooked) return;
  page.__vilNetHooked = true;
  page.__pendingRequests = 0;
  try {
    page.on('request', () => { page.__pendingRequests = (page.__pendingRequests || 0) + 1; });
    page.on('requestfinished', () => { page.__pendingRequests = Math.max(0, (page.__pendingRequests || 0) - 1); });
    page.on('requestfailed', () => { page.__pendingRequests = Math.max(0, (page.__pendingRequests || 0) - 1); });
  } catch (e) { /* 页面已失效时忽略 */ }
}
const ROLE_TAGS = { a: 'link', button: 'button', input: 'input', select: 'select', textarea: 'textarea', form: 'form', img: 'img' };

// 页面内执行：收集可见交互元素 + 可见文本摘要（不含敏感值）
const _TAGS_JSON = JSON.stringify([...INTERACTIVE_TAGS]);
const _ROLES_JSON = JSON.stringify(ROLE_TAGS);
const COLLECT_JS = `(() => {
  const INTERACTIVE_TAGS = new Set(${_TAGS_JSON});
  const ROLE_TAGS = ${_ROLES_JSON};
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
  const redact = (s) => String(s || '')
    .replace(/(password|passwd|pwd|cookie|token|authorization|otp|secret|api[_-]?key|card|cvv)\\s*[=:]\\s*\\S+/gi, '$1=REDACTED')
    .replace(/\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b/g, 'CARD_REDACTED')
    .replace(/\\b\\d{3,4}\\b(?=\\s*cvv\\b)/gi, 'CVV_REDACTED');
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
      const _nm = (el.getAttribute ? (el.getAttribute('name') || '') : '') + ' ' +
        (el.getAttribute ? (el.getAttribute('id') || '') : '') + ' ' +
        (el.getAttribute ? (el.getAttribute('placeholder') || '') : '') + ' ' +
        (el.getAttribute ? (el.getAttribute('aria-label') || '') : '');
      const _sensType = /^(password|passwd|pwd|secret|token|otp|cvc|cvv|cc|card|cardnumber|ccnumber|account_number|ssn)$/i.test(t);
      const _sensName = /(password|passwd|pwd|secret|token|otp|cvc|cvv|card|ccv|ssn|social)/i.test(_nm);
      if (_sensType || _sensName) {
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
  // 为元素构造 CSS 选择器（主要用于 iframe 内元素定位）；主文档元素不强制带 selector。
  const cssFor = (el) => {
    const tag = el.tagName.toLowerCase();
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
  // iframe 序号：用于生成 "iframe:nth-of-type(n)" 前缀（best-effort，按文档出现顺序递增）
  let _iframeSeq = 0;
  const walk = (root, prefix) => {
    if (!root || !root.querySelectorAll) return;
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (seen.has(el)) continue;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'head'].includes(tag)) continue;
      // iframe：仅同域可读取其内部 DOM 并递归收集其交互元素；跨域 iframe 浏览器禁止访问，直接跳过。
      if (tag === 'iframe') {
        let fdoc = null;
        try { fdoc = el.contentDocument; } catch (e) { fdoc = null; }
        if (fdoc && fdoc.body) {
          _iframeSeq++;
          const fprefix = (prefix ? prefix + ' >> ' : '') + 'iframe:nth-of-type(' + _iframeSeq + ')';
          walk(fdoc, fprefix);
        }
        continue;
      }
      const roleAttr = el.getAttribute && el.getAttribute('role');
      const role = roleAttr || ROLE_TAGS[tag] || null;
      const isInteractive = INTERACTIVE_TAGS.has(tag) || !!roleAttr;
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
        text = [lbl, ph, aria, name].filter(Boolean).join(' | ');
        const box = bboxObj(el);
        out.elements.push({
          id: el.id || null, role, tag, type, name: name || null,
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
          out.elements.push({
            id: el.id || null, role, tag, type: tag, name: null,
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
          });
        }
      }
    }
  };
  walk(body, '');
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
      return { ok: true, cached: true, observation: hit.summary };
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
  // 真实网络状态：本 page 实例的请求计数器
  ensureNetHook(page);
  if (page && typeof page.__pendingRequests === 'number') {
    observation.networkState = page.__pendingRequests > 0 ? 'pending' : 'idle';
  }
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
