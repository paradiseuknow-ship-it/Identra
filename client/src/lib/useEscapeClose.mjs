import { useEffect } from 'react';

// C43 —— 键盘可达性：Escape 关闭弹层。
// 缺陷背景：全应用弹层（TaskDetail / BrowserViewer / ProfileEditor / 删除确认）
// 原本都只能鼠标点 ✕ 关闭，零键盘路径。
// 用法：useEscapeClose(active, onClose) —— active 为 true 时监听 window keydown，
// Escape 触发 onClose；active 变 false 或卸载时自动清理（无泄漏）。

// 纯函数：事件是否为 Escape（独立导出便于守护测试）
export function isEscapeKey(e) {
  // 兼容旧行为：部分浏览器/输入法环境用 keyCode 27
  return e && (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27);
}

export function useEscapeClose(active, onClose) {
  useEffect(() => {
    if (!active || typeof onClose !== 'function') return undefined;
    const handler = (e) => {
      if (isEscapeKey(e)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, onClose]);
}
