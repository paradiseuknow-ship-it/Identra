'use strict';

/**
 * C106 F19：网络就绪判据（network readiness）。
 *
 * 实证背景（真实 Webflow E2E 第 6 轮）：27 个动作全部卡在 step_001，固定循环
 *   networkState=pending → EVENTUAL_CONSISTENCY → WAIT
 *   → 误诊 NETWORK_REQUEST_FAILED(conf 0.9) → wait → …
 *
 * 根因一（判据语义）：请求计数器把所有请求一视同仁 —— document / xhr / fetch /
 *   长轮询 / analytics beacon / websocket 全部 +1。真实站点（SPA + analytics +
 *   长轮询）必然存在长期不 finish 的请求 → pending 恒为真
 *   → verificationIntelligence._analyze 第 2 步短路命中 WAIT，
 *   第 3 步起整条判据链（loading / domChanged / 证据）永远走不到。
 *
 * 根因二（挂载时机）：hook 原先只在 observation.inspect 首次调用时才挂，
 *   页面加载期间发起的请求（document / 阻塞脚本 / 首屏 xhr）全部漏计 ——
 *   计数器形同虚设，且「没抓到」会伪装成「已就绪」（比恒 pending 更危险）。
 *   故本模块由 browserManager 在 page 创建时立即 attach。
 *
 * 语义修正：networkState 表示「页面主体是否仍在加载」，
 *   只有会阻塞渲染与交互的请求才算未就绪，且各自有一个阻塞窗口
 *   （窗口内该等，超时即视为陈旧，不再钉住整页）。
 */

const networkObserver = require('./network/networkObserver');

// 阻塞窗口（毫秒）：请求持续时间超过自身窗口后不再计入未就绪。
const BLOCKING_WINDOW_MS = {
  document: 20000,
  script: 20000,
  stylesheet: 20000,
  xhr: 3000,      // 首屏数据加载的合理等待窗口（SPA 数据）
  fetch: 3000,
};
// 未列入上表的类型一律不计入：ping(beacon) / eventsource / websocket / image /
// font / media / manifest / other / prefetch —— 它们的存续不代表页面未就绪。

// C172 —— 「导航已发起」信号的唯一记录点。
//
// 消费方：tools.js 的结果落点窗口（settleResultLanding）。点击可能触发整页导航，
// 而观察必须在**新文档**上做；判断「这次点击有没有引发导航」需要一个**早于提交**的信号：
// 主 frame 的 document 请求发出即成立（导航族 goto/reload/表单提交/点击跳转都会产生它）。
// 该请求本来就经过本模块的 request 监听，因此只在此处多记一个时刻 —— 不新增监听器、
// 不做轮询，避免出现第三份「导航侦测」实现。
const DOC_REQUEST_TS_KEY = '__lastDocumentRequestAt';

/**
 * 在 page 上挂载请求监听（幂等）。应在 page 创建后立即调用，
 * 否则会漏掉页面加载期间的请求。
 * @param {object} page Playwright Page
 * @returns {boolean} 是否由本次调用完成挂载
 */
function attach(page) {
  if (!page) return false;
  if (page.__readinessHooked) return false;
  // 无法挂监听（如测试桩 fake page）时**绝不建立分层表** —— 否则空表会让
  // compute 误判为「无阻塞请求 → idle」，把回退路径（__pendingRequests 总计数）堵死。
  if (typeof page.on !== 'function') return false;
  page.__readinessHooked = true;
  if (typeof page.__pendingRequests !== 'number') page.__pendingRequests = 0;
  try {
    page.__blockingPending = new Map();
    page.on('request', (req) => {
      page.__pendingRequests = (page.__pendingRequests || 0) + 1;
      try {
        if (!req || !page.__blockingPending) return;
        const type = String(req.resourceType ? req.resourceType() : '');
        if (!BLOCKING_WINDOW_MS[type]) return;
        // 只看主 frame：iframe 里的第三方资源不该钉住宿主页面的就绪判定
        let isMain = true;
        try { const f = req.frame(); isMain = !f || !f.parentFrame(); } catch (e) { isMain = true; }
        if (!isMain) return;
        // C172：记录主 frame 文档请求的发起时刻（导航族最早可观测信号，先于提交到达）
        if (type === 'document') { try { page[DOC_REQUEST_TS_KEY] = Date.now(); } catch (e) {} }
        page.__blockingPending.set(req, { type, start: Date.now() });
      } catch (e) { /* 观测能力缺失不得影响主流程 */ }
    });
    const onSettled = (req) => {
      page.__pendingRequests = Math.max(0, (page.__pendingRequests || 0) - 1);
      try { if (page.__blockingPending) page.__blockingPending.delete(req); } catch (e) {}
    };
    page.on('requestfinished', onSettled);
    page.on('requestfailed', onSettled);
  } catch (e) { /* 页面已失效时忽略 */ }
  // 完整网络/运行时监听（幂等，失败静默 —— 观测能力缺失不得影响主流程）
  try { networkObserver.attach(page); } catch (e) {}
  return true;
}

/**
 * 计算当前网络就绪状态。
 * @returns {'pending'|'idle'|'unknown'}
 */
function compute(page) {
  if (!page) return 'unknown';
  const m = page.__blockingPending;
  if (m && typeof m.forEach === 'function') {
    const now = Date.now();
    let blocking = 0;
    m.forEach((info, req) => {
      const windowMs = BLOCKING_WINDOW_MS[info && info.type] || 0;
      const start = info && info.start ? info.start : now;
      // 顺带回收陈旧条目：否则长挂请求会让这张表无限增长
      if (now - start > windowMs) {
        m.delete(req);
        return;
      }
      blocking += 1;
    });
    return blocking > 0 ? 'pending' : 'idle';
  }
  // 回退：无分层信息（如测试桩直接给 __pendingRequests）时沿用旧总计数语义。
  if (typeof page.__pendingRequests === 'number') {
    return page.__pendingRequests > 0 ? 'pending' : 'idle';
  }
  return 'unknown';
}

/**
 * C172：本页最近一次「主 frame 文档请求」的发起时刻（毫秒）。
 * 0 = 本页从未观测到文档请求（含未挂监听的情况）。
 *
 * 语义边界（消费方必须知道）：
 *   · 它回答的是「此刻之前**是否已经**有导航在发起」，**不是**「导航已完成」；
 *   · 它只记录时刻，不判断成败 —— 请求失败（如 ERR_ABORTED）同样会推进它；
 *   · 是否「有观测能力」由 compute(page) !== 'unknown' 判定，本函数不做该判断。
 * @param {object} page Playwright Page
 * @returns {number}
 */
function lastDocumentRequestAt(page) {
  if (!page) return 0;
  const v = page[DOC_REQUEST_TS_KEY];
  return (typeof v === 'number' && v > 0) ? v : 0;
}

module.exports = { attach, compute, lastDocumentRequestAt, BLOCKING_WINDOW_MS };
