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

module.exports = { attach, compute, BLOCKING_WINDOW_MS };
