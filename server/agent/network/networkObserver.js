'use strict';

// STEP 2 —— Network Intelligence：网络与运行时可观测层。
//
// 为什么需要（STEP 0 取证结论）：
//   改造前系统对网络是完全瞎的 —— 只有一个 pending 计数器（observation.js 的
//   __pendingRequests），没有 status、没有响应体、没有 console、没有 pageerror。
//   后果是**业务失败在 HTTP 200 里发生，而系统完全看不见**：
//     表单提交返回 200 + {"error":"email already registered"}，
//     DOM 上只是多了一行红字，DOM_CHANGED=true → 系统认为"动作产生了影响"，
//     然后按 VERIFY_FAILED 原样重试（phase68 中 51.3% 的失败是零信息重试）。
//
// 本层职责（只观测，不改任何判定语义）：
//   1. 为每个 page 实例挂一次性监听：request / response / requestfailed / console / pageerror
//   2. 环形缓冲，恒定内存占用（不做全量留存，避免长时间任务 OOM）
//   3. 输出结构化快照，供 Diagnosis（STEP 3）与 Self-Healing（STEP 4）消费
//   4. 所有落库的文本一律脱敏：Authorization / token / 卡号 / CVV / 密码永不以明文出现
//
// 红线：本模块不得判定成功，不得改变 verification 语义，不得绕过 policy。

const { redactSecrets, redactUrl, redactBody } = require('../../security/redact');

// 环形缓冲上限（超出丢弃最早的条目）
const LIMITS = {
  requests: 120,
  console: 80,
  pageErrors: 40,
  urlChars: 300,
  bodyChars: 600,
  textChars: 300,
};

const API_RESOURCE_TYPES = new Set(['xhr', 'fetch']);
// 只对这些内容类型尝试读响应体（避免把图片/字体二进制读进内存）
const TEXTUAL_CONTENT_TYPE = /(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql))/i;

function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function safeStr(v, cap) {
  try { return String(v == null ? '' : v).slice(0, cap); } catch (e) { return ''; }
}

function reqKey(method, url) {
  return String(method || 'GET').toUpperCase() + ' ' + String(url || '');
}

/**
 * 为 page 安装网络监听（幂等）。
 * @returns {boolean} 是否新安装成功（false = 该 page 已挂过或挂载失败）
 */
function attach(page) {
  if (!page || typeof page.on !== 'function') return false;
  if (page.__fpbNetwork) return false;

  const state = {
    attachedAt: Date.now(),
    pending: 0,
    requests: [],      // { method, url, resourceType, at, status?, failed?, failureText?, bodyPreview?, contentType?, ms? }
    console: [],       // { type, text, at }
    pageErrors: [],    // { message, stack, at }
    pendingMap: new Map(),
  };
  page.__fpbNetwork = state;

  try {
    page.on('request', (req) => {
      state.pending += 1;
      let url = '', method = 'GET', resourceType = 'other', postPreview = null;
      try { url = redactUrl(req.url(), LIMITS.urlChars); } catch (e) { url = ''; }
      try { method = safeStr(req.method(), 16) || 'GET'; } catch (e) {}
      try { resourceType = safeStr(req.resourceType(), 24) || 'other'; } catch (e) {}
      try {
        const pd = req.postData();
        postPreview = pd ? redactBody(pd, LIMITS.bodyChars) : null;
      } catch (e) { postPreview = null; }
      const rec = { method, url, resourceType, postPreview, at: Date.now(), status: null, failed: false, failureText: null, bodyPreview: null, contentType: null, ms: null };
      state.pendingMap.set(reqKey(method, url), rec);
      pushCapped(state.requests, rec, LIMITS.requests);
    });
  } catch (e) {}

  const finish = (req, patch) => {
    state.pending = Math.max(0, state.pending - 1);
    let url = '', method = 'GET';
    try { url = redactUrl(req.url(), LIMITS.urlChars); } catch (e) {}
    try { method = safeStr(req.method(), 16) || 'GET'; } catch (e) {}
    const k = reqKey(method, url);
    const rec = state.pendingMap.get(k);
    state.pendingMap.delete(k);
    if (rec) Object.assign(rec, patch, { ms: Date.now() - rec.at });
  };

  try {
    page.on('requestfinished', (req) => {
      let status = null;
      try { const r = req.response(); status = r ? r.status() : null; } catch (e) {}
      finish(req, { status });
    });
  } catch (e) {}

  try {
    page.on('requestfailed', (req) => {
      let failureText = null;
      try { failureText = safeStr(req.failure() && req.failure().errorText, 200); } catch (e) {}
      finish(req, { failed: true, failureText });
    });
  } catch (e) {}

  // 响应体：只对 XHR/Fetch 的文本型响应尝试读取（异步、失败静默，绝不阻塞主流程）
  try {
    page.on('response', (res) => {
      (async () => {
        try {
          const req = res.request();
          const rt = safeStr(req && req.resourceType && req.resourceType(), 24) || 'other';
          if (!API_RESOURCE_TYPES.has(rt)) return;
          const status = res.status();
          const headers = (() => { try { return res.headers() || {}; } catch (e) { return {}; } })();
          const ct = safeStr(headers['content-type'] || headers['Content-Type'] || '', 120);
          if (!TEXTUAL_CONTENT_TYPE.test(ct)) {
            // 非文本型：只记状态，不读体
            const rec = matchByUrl(state, res.url());
            if (rec) { rec.status = status; rec.contentType = ct; }
            return;
          }
          let body = null;
          try { body = await res.text(); } catch (e) { body = null; }
          const rec = matchByUrl(state, res.url());
          if (rec) {
            rec.status = status;
            rec.contentType = ct;
            rec.bodyPreview = redactBody(body, LIMITS.bodyChars);
          } else {
            pushCapped(state.requests, {
              method: (() => { try { return safeStr(req.method(), 16) || 'GET'; } catch (e) { return 'GET'; } })(),
              url: redactUrl(res.url(), LIMITS.urlChars),
              resourceType: rt, postPreview: null, at: Date.now(),
              status, failed: false, failureText: null,
              contentType: ct, bodyPreview: redactBody(body, LIMITS.bodyChars), ms: null,
            }, LIMITS.requests);
          }
        } catch (e) { /* 响应体读取失败不影响任何主流程 */ }
      })();
    });
  } catch (e) {}

  try {
    page.on('console', (msg) => {
      let type = 'log', text = '';
      try { type = safeStr(msg.type(), 16) || 'log'; } catch (e) {}
      try { text = redactBody(msg.text(), LIMITS.textChars) || ''; } catch (e) { text = ''; }
      pushCapped(state.console, { type, text, at: Date.now() }, LIMITS.console);
    });
  } catch (e) {}

  try {
    page.on('pageerror', (err) => {
      pushCapped(state.pageErrors, {
        message: redactBody(err && err.message, LIMITS.textChars) || 'unknown',
        stack: redactBody(err && err.stack, LIMITS.textChars) || null,
        at: Date.now(),
      }, LIMITS.pageErrors);
    });
  } catch (e) {}

  return true;
}

// 用未脱敏 url 反查已记录条目（url 已脱敏过，故按「脱敏后相等」匹配）
function matchByUrl(state, rawUrl) {
  const target = redactUrl(rawUrl, LIMITS.urlChars);
  for (let i = state.requests.length - 1; i >= 0; i--) {
    const r = state.requests[i];
    if (r && r.url === target && r.status == null) return r;
  }
  return null;
}

function isApi(rec) {
  return !!rec && (API_RESOURCE_TYPES.has(rec.resourceType) || !!rec.bodyPreview || !!rec.postPreview);
}

/**
 * 输出结构化网络快照（纯度：不修改监听状态）。
 * @param {object} page
 * @param {object} [opts] { sinceTs?, limit? }
 */
function snapshot(page, opts = {}) {
  const empty = {
    attached: false, pending: 0, sinceTs: 0,
    counts: { requests: 0, completed: 0, failures: 0, api: 0, status4xx: 0, status5xx: 0, consoleErrors: 0, consoleWarnings: 0, pageErrors: 0 },
    failures: [], apiResponses: [], console: [], pageErrors: [],
    lastRequestAt: null, lastResponseAt: null,
  };
  const st = page && page.__fpbNetwork;
  if (!st) return empty;

  const since = Number(opts.sinceTs) || 0;
  const limit = Number(opts.limit) || 20;
  const reqs = st.requests.filter((r) => r && r.at >= since);
  const consoleEntries = st.console.filter((c) => c && c.at >= since);
  const errors = st.pageErrors.filter((e) => e && e.at >= since);

  let completed = 0, failures = 0, api = 0, s4xx = 0, s5xx = 0;
  for (const r of reqs) {
    if (typeof r.status === 'number' || r.failed) completed += 1;
    if (r.failed || (typeof r.status === 'number' && r.status >= 400)) failures += 1;
    if (isApi(r)) api += 1;
    if (typeof r.status === 'number') {
      if (r.status >= 400 && r.status < 500) s4xx += 1;
      if (r.status >= 500) s5xx += 1;
    }
  }

  const lastResponseAt = reqs.reduce((acc, r) => {
    if (typeof r.status === 'number' || r.failed) return Math.max(acc, r.at + (r.ms || 0));
    return acc;
  }, 0) || null;

  return {
    attached: true,
    pending: st.pending,
    sinceTs: since,
    counts: {
      requests: reqs.length,
      completed, failures, api, status4xx: s4xx, status5xx: s5xx,
      consoleErrors: consoleEntries.filter((c) => c.type === 'error').length,
      consoleWarnings: consoleEntries.filter((c) => c.type === 'warning').length,
      pageErrors: errors.length,
    },
    failures: reqs.filter((r) => r.failed || (typeof r.status === 'number' && r.status >= 400)).slice(-limit),
    apiResponses: reqs.filter(isApi).slice(-limit),
    console: consoleEntries.slice(-limit),
    pageErrors: errors.slice(-limit),
    lastRequestAt: reqs.length ? reqs[reqs.length - 1].at : null,
    lastResponseAt,
  };
}

/** 清空某 page 的网络缓冲（任务/步骤边界调用，避免跨步骤串味） */
function reset(page) {
  const st = page && page.__fpbNetwork;
  if (!st) return false;
  st.requests.length = 0;
  st.console.length = 0;
  st.pageErrors.length = 0;
  st.pendingMap.clear();
  st.pending = 0;
  return true;
}

module.exports = { attach, snapshot, reset, LIMITS, redactSecrets, redactUrl, redactBody };
