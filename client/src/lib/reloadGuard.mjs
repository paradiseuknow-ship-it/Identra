// C37：双通道（SSE + 轮询）并发 reload 的乱序守卫。
// 缺陷背景：TaskDetail 中 SSE 每条事件触发一次完整 reload（6 个请求），与 2.5s 轮询并发飞行；
// 先发出的请求后返回时，旧响应会覆盖新响应 → UI 状态回跳（任务明明已推进却显示旧 step/observation）。
// 语义：latest-wins —— 只有「最新一次调用」的结果允许落 state；被更新调用取代的旧响应静默丢弃。
// 纯函数、零依赖、可直接被 node 测试执行（.mjs）。

/**
 * 创建 latest-wins 守卫。
 * @returns {(run: () => Promise<T>, apply: (v: T) => void) => Promise<T>}
 *   run   —— 取数据的异步函数（fetch 层）
 *   apply —— 拿到结果后的 setState 逻辑（只在本次调用仍是最新时执行）
 *   返回 run 的结果（便于测试断言）；若本次调用已被更新的调用取代：
 *   - 不执行 apply（旧响应不落 state）
 *   - run 抛错不向外传播（已被取代的错误无需打扰 UI）
 */
export function createLatestGuard() {
  let seq = 0;
  return function guard(run, apply) {
    const my = ++seq;
    return Promise.resolve()
      .then(run)
      .then(
        (v) => {
          if (my === seq && typeof apply === 'function') apply(v);
          return v;
        },
        (e) => {
          if (my === seq) throw e;
          return undefined;
        }
      );
  };
}

/**
 * 创建 leading+trailing 节流（trailing 保证窗口内最后一次调用最终一定执行）。
 * 用途：SSE 事件密集时不再每条事件打满 6 个请求（事件风暴），窗口内合并为一次 reload。
 * @returns {{ call: (...args) => void, cancel: () => void }}
 *   call   —— 节流入口：窗口首调用立即执行（leading），窗口内后续调用合并，
 *             窗口结束时如有积压则以最后参数再执行一次（trailing）
 *   cancel —— 清理（组件卸载时调用，防止 trailing 回调打到已卸载组件）
 */
export function createTrailingThrottle(fn, wait) {
  let timer = null;
  let pending = null; // 窗口内积压的最后一次调用参数
  function drain() {
    timer = null;
    if (pending === null) return;
    const args = pending;
    pending = null;
    fn(...args);
  }
  return {
    call(...args) {
      pending = args;
      if (timer === null) {
        pending = null;
        fn(...args); // leading：窗口首调用立即执行
        timer = setTimeout(drain, wait);
      }
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
