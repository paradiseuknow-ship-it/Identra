'use strict';
// C42 —— 浏览器实时画面流（CDP Page.startScreencast → SSE 帧流）。
// 缺陷背景：BrowserViewer 原为 2.5s 全图截图轮询——观感是"每 2.5 秒一张照片"，
//   且每次都是全屏 PNG 全量传输；任务执行"直播观看"体验差。
// 方案：CDP screencast 接收浏览器自推送的增量 JPEG 帧（页面不动不出帧，零带宽），
//   经 FrameHub（最新帧胜出 + 最小帧间隔节流）转发给 SSE 订阅者。
// 纯逻辑（createFrameHub）与 CDP 适配分离——守护测试零浏览器覆盖纯逻辑 + SSE 契约。

// ---- FrameHub：纯逻辑（可注入测试）----
// 语义：
//   - 订阅计数 0→1 触发 onNeedStart（启动 screencast），1→0 触发 onNeedStop（停止并释放 CDP）
//   - pushFrame 节流：minFrameIntervalMs 内的新帧只覆盖 pending（最新帧胜出），
//     间隔到期由 timer 发出——高帧率场景不堆积、不丢"最新画面"
//   - 首帧立即发出（不等 interval），保证接入即有画面
function createFrameHub({ minFrameIntervalMs = 120, onNeedStart, onNeedStop } = {}) {
  let subs = [];
  let seq = 0;
  let lastSentAt = -Infinity;
  let pending = null; // { jpeg }
  let timer = null;

  function flush() {
    timer = null;
    if (!pending || subs.length === 0) return;
    const frame = { seq: ++seq, jpeg: pending.jpeg };
    pending = null;
    lastSentAt = Date.now();
    for (const fn of [...subs]) {
      try { fn(frame); } catch { /* 单订阅者异常不中断广播 */ }
    }
  }

  return {
    subscribe(fn) {
      subs.push(fn);
      if (subs.length === 1 && onNeedStart) {
        try { onNeedStart(); } catch (e) { /* start 失败不阻断订阅，帧事件由适配层报错 */ }
      }
      return () => {
        // C45：幂等退订——重复 unsubscribe 不得二次触发 onNeedStop（否则 CDP stop/detach 双发）
        if (!subs.includes(fn)) return;
        subs = subs.filter((s) => s !== fn);
        if (subs.length === 0) {
          if (timer) { clearTimeout(timer); timer = null; }
          pending = null;
          if (onNeedStop) { try { onNeedStop(); } catch { /* 释放失败不阻断 */ } }
        }
      };
    },
    pushFrame(jpeg) {
      if (subs.length === 0) return null; // 无观众不出帧（CDP 侧也已 stop，双保险）
      pending = { jpeg };
      const due = lastSentAt + minFrameIntervalMs - Date.now();
      if (timer) return { queued: true, seq: null };
      if (due <= 0) flush();
      else timer = setTimeout(flush, due);
      return { queued: true, seq: null };
    },
    subscriberCount() { return subs.length; },
    latestSeq() { return seq; },
  };
}

// ---- CDP 适配（真实浏览器路径）----
const hubs = new Map(); // profileId -> { hub, stopAdapter }

function attachScreencast(browserManager, profileId) {
  // 返回 stop 函数；帧事件内部接到 hub.pushFrame
  const s = browserManager.getSession(profileId);
  if (!s) throw new Error('浏览器未运行');
  const page = s.page || s.context.pages()[0];
  if (!page) throw new Error('无可用页面');
  let cdp = null;
  let onFrame = null;
  return (async () => {
    cdp = await page.context().newCDPSession(page);
    onFrame = async (p) => {
      try {
        const hubEntry = hubs.get(profileId);
        if (hubEntry) hubEntry.hub.pushFrame(Buffer.from(p.data, 'base64').toString('base64'));
        await cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      } catch { /* 帧处理异常不影响 screencast 生命周期 */ }
    };
    cdp.on('Page.screencastFrame', onFrame);
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 60, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1,
    });
    return async () => {
      try { await cdp.send('Page.stopScreencast'); } catch { /* 已 detach */ }
      try { cdp.off('Page.screencastFrame', onFrame); await cdp.detach(); } catch { /* 已 detach */ }
    };
  })();
}

// 取或建某 profile 的帧中心；首个订阅者触发 CDP attach，最后订阅者离开触发释放
function getHub(browserManager, profileId) {
  if (hubs.has(profileId)) return hubs.get(profileId).hub;
  const hub = createFrameHub({
    minFrameIntervalMs: 120, // ≈8fps 上限
    onNeedStart() {
      attachScreencast(browserManager, profileId)
        .then((stop) => {
          const e = hubs.get(profileId);
          if (e && e.hub.subscriberCount() > 0) { e.stopAdapter = stop; return; }
          // C45 缺陷修复（A 类）：attach 异步期间 hub 已被移除或订阅者已清零时，
          // 旧实现直接丢弃 stop → CDP session + screencast 永久泄漏（浏览器持续推帧+ack）。
          // 修复：attach 完成即检查活跃状态，失活则立即释放。
          Promise.resolve(stop()).catch(() => {});
          if (e) hubs.delete(profileId);
        })
        .catch(() => { /* attach 失败：SSE 客户端将收到错误事件（无帧）；下次订阅重试 */ });
    },
    onNeedStop() {
      const entry = hubs.get(profileId);
      if (entry && entry.stopAdapter) {
        Promise.resolve(entry.stopAdapter()).catch(() => {}).finally(() => {
          if (hubs.get(profileId) === entry && entry.hub.subscriberCount() === 0) hubs.delete(profileId);
        });
      } else {
        hubs.delete(profileId);
      }
    },
  });
  hubs.set(profileId, { hub, stopAdapter: null });
  return hub;
}

function hubFor(profileId) { const e = hubs.get(profileId); return e ? e.hub : null; }
function resetForTests() { hubs.clear(); }

module.exports = { createFrameHub, getHub, hubFor, resetForTests };
