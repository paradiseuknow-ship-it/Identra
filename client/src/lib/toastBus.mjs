// C41 —— Toast 通知总线。
// 缺陷背景（A 类真实缺陷）：App.jsx 旧实现为单条 toast + 全局裸 setTimeout：
//   1) 连续两条 notify 时，第一条的 timer 到点会把第二条提前清掉 → 后一条通知被截断甚至瞬间消失；
//   2) 组件卸载后 setTimeout 仍触发 setState（泄漏 + React 警告）；
//   3) 全部 103 处调用经 props 逐层透传（prop drilling）。
// 修复：模块级 pub/sub 总线 + ToastHost 宿主组件（每条独立 timer、卸载清理、FIFO 上限）。
// notify(msg, ok) 签名保持不变 —— 调用方零改动。

// applyIncoming：新 toast 入列的纯函数（FIFO 上限，超出丢最老）
export function applyIncoming(items, item, maxVisible = 4) {
  const next = [...items, item];
  return next.length > maxVisible ? next.slice(next.length - maxVisible) : next;
}

// createToastBus：可实例化的通知总线（可注入 nowFn 便于测试去重窗口）
export function createToastBus({ dedupeWindowMs = 800, nowFn = () => Date.now() } = {}) {
  let listeners = [];
  let seq = 0;
  let lastMsg = null;
  let lastAt = -Infinity;

  const emit = (msg, ok = true) => {
    const now = nowFn();
    // 去重：同一消息在去重窗口内重复触发（如轮询错误风暴）只广播一次
    if (msg === lastMsg && now - lastAt < dedupeWindowMs) return null;
    lastMsg = msg;
    lastAt = now;
    const item = { id: ++seq, msg, ok };
    for (const l of listeners) {
      try { l(item); } catch { /* 单个订阅者异常不影响其他订阅者 */ }
    }
    return item;
  };

  const subscribe = (fn) => {
    listeners.push(fn);
    return () => {
      listeners = listeners.filter((l) => l !== fn);
    };
  };

  return { emit, subscribe };
}

// 全局单例：任何组件可直接 import 使用，无需 props 透传
export const toastBus = createToastBus();
export const toast = {
  ok: (msg) => toastBus.emit(msg, true),
  err: (msg) => toastBus.emit(msg, false),
};
