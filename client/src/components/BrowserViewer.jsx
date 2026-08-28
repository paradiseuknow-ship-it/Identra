import React, { useEffect, useState, useCallback } from 'react';

export default function BrowserViewer({ profileId, onClose }) {
  const [img, setImg] = useState(null);
  const [url, setUrl] = useState('https://whoer.net');
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/browser/${profileId}/screenshot?t=${Date.now()}`);
      const j = await r.json();
      if (j.ok && j.data) {
        setImg('data:image/png;base64,' + j.data);
        setErr(null);
      } else if (j.error) {
        setErr(j.error);
      }
    } catch (e) {
      setErr('获取画面失败: ' + e.message);
    }
  }, [profileId]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) refresh(); };
    tick();
    const iv = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [refresh]);

  const go = async () => {
    if (!url) return;
    try {
      await fetch(`/api/browser/${profileId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      setTimeout(refresh, 800);
    } catch (e) {
      setErr('导航失败: ' + e.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-5xl bg-panel border border-edge rounded-lg overflow-hidden flex flex-col" style={{ height: '88vh' }}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-edge bg-panel/80">
          <input
            className="inp flex-1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder="输入网址，如 https://whoer.net"
          />
          <button onClick={go} className="px-3 py-1.5 rounded bg-sky-600 text-white text-sm hover:bg-sky-500">前往</button>
          <button onClick={refresh} className="px-3 py-1.5 rounded bg-edge hover:bg-slate-700 text-sm">刷新</button>
          <button onClick={onClose} className="px-3 py-1.5 rounded bg-rose-600/80 hover:bg-rose-600 text-white text-sm">关闭</button>
        </div>
        <div className="flex-1 bg-black flex items-center justify-center overflow-auto">
          {err && <div className="text-rose-400 text-sm p-4">{err}</div>}
          {!err && !img && <div className="text-slate-500 text-sm">正在获取浏览器画面…</div>}
          {img && <img src={img} alt="browser" className="max-w-full max-h-full" />}
        </div>
        <div className="px-3 py-1.5 border-t border-edge text-xs text-slate-500">
          云查看：浏览器在后台运行，画面每 2.5 秒自动刷新。如需真实弹窗，可在配置「运行模式」选「有界面」并在本机桌面运行。
        </div>
      </div>
    </div>
  );
}
