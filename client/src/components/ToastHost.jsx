import React, { useEffect, useRef, useState } from 'react';
import { toastBus, applyIncoming } from '../lib/toastBus.mjs';

// C41 —— Toast 宿主：堆叠渲染总线广播的通知（最多 maxVisible 条）。
// 与旧实现的关键差异：每条 toast 拥有独立 timer（id 索引），先发的 timer
// 不再清掉后发的通知；组件卸载时 cleanup 清掉全部 timer（无卸载后 setState）。
export default function ToastHost({ bus = toastBus, durationMs = 2500, maxVisible = 4 }) {
  const [items, setItems] = useState([]);
  const timersRef = useRef(new Map());

  useEffect(() => {
    const unsub = bus.subscribe((item) => {
      setItems((prev) => applyIncoming(prev, item, maxVisible));
      const t = setTimeout(() => {
        timersRef.current.delete(item.id);
        setItems((prev) => prev.filter((x) => x.id !== item.id));
      }, durationMs);
      timersRef.current.set(item.id, t);
    });
    return () => {
      unsub();
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
  }, [bus, durationMs, maxVisible]);

  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col gap-2 items-end">
      {items.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-2 rounded shadow-lg text-white text-sm ${t.ok ? 'bg-emerald-600' : 'bg-rose-600'}`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
