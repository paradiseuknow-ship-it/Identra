import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useEscapeClose } from '../lib/useEscapeClose.mjs';

// C42 —— 云查看双模式：
//   实时流（默认）：SSE + CDP screencast 帧流（≈8fps，页面静止时零流量）
//   低速模式：2.5s 全图截图轮询（窄带兜底）；实时流断线自动降级到低速并提示
export default function BrowserViewer({ profileId, onClose }) {
  const [img, setImg] = useState(null);
  const [url, setUrl] = useState('https://whoer.net');
  const [err, setErr] = useState(null);
  const [mode, setMode] = useState('stream'); // 'stream' | 'slow'
  const [streamStatus, setStreamStatus] = useState('连接中…');
  const esRef = useRef(null);
  useEscapeClose(true, onClose); // C43：Esc 关闭云查看

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

  // 实时流：EventSource 帧渲染；出错自动降级低速
  useEffect(() => {
    if (mode !== 'stream') return undefined;
    let alive = true;
    const es = new EventSource(`/api/browser/${profileId}/stream`);
    esRef.current = es;
    es.onopen = () => { if (alive) { setStreamStatus('实时流已连接'); setErr(null); } };
    es.onmessage = (ev) => {
      if (!alive) return;
      try {
        const j = JSON.parse(ev.data);
        if (j.ok === false) { setStreamStatus('实时流不可用，已切低速'); setMode('slow'); }
      } catch { /* 忽略非 JSON 心跳数据 */ }
    };
    es.addEventListener('frame', (ev) => {
      if (!alive) return;
      try {
        const f = JSON.parse(ev.data);
        if (f.jpeg) { setImg('data:image/jpeg;base64,' + f.jpeg); setErr(null); }
      } catch { /* 忽略坏帧 */ }
    });
    es.onerror = () => {
      if (!alive) return;
      setStreamStatus('实时流断开，已切低速');
      setMode('slow'); // 降级：低速轮询保底，用户可手动切回
    };
    return () => {
      alive = false;
      es.close();
      esRef.current = null;
    };
  }, [mode, profileId]);

  // 低速模式：截图轮询
  useEffect(() => {
    if (mode !== 'slow') return undefined;
    let alive = true;
    const tick = () => { if (alive) refresh(); };
    tick();
    const iv = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [mode, refresh]);

  const go = async () => {
    if (!url) return;
    try {
      await fetch(`/api/browser/${profileId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (mode === 'slow') setTimeout(refresh, 800);
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
          <button
            onClick={() => setMode(mode === 'stream' ? 'slow' : 'stream')}
            className={`px-3 py-1.5 rounded text-sm ${mode === 'stream' ? 'bg-emerald-700/70 hover:bg-emerald-600 text-emerald-100' : 'bg-edge hover:bg-slate-700'}`}
            title="实时流：CDP screencast ≈8fps；低速：每 2.5 秒截图"
          >
            {mode === 'stream' ? '● 实时流' : '低速模式'}
          </button>
          <button onClick={onClose} className="px-3 py-1.5 rounded bg-rose-600/80 hover:bg-rose-600 text-white text-sm">关闭</button>
        </div>
        <div className="flex-1 bg-black flex items-center justify-center overflow-auto">
          {err && <div className="text-rose-400 text-sm p-4">{err}</div>}
          {!err && !img && <div className="text-slate-500 text-sm">正在获取浏览器画面…</div>}
          {img && <img src={img} alt="browser" className="max-w-full max-h-full" />}
        </div>
        <div className="px-3 py-1.5 border-t border-edge text-xs text-slate-500 flex justify-between">
          <span>
            云查看：浏览器在后台运行。
            {mode === 'stream'
              ? ' 实时流：画面由浏览器主动推送（≈8fps，页面静止时零流量）。'
              : ' 低速模式：画面每 2.5 秒自动刷新。'}
            {' '}如需真实弹窗，可在配置「运行模式」选「有界面」并在本机桌面运行。
          </span>
          {mode === 'stream' && <span className="text-slate-400 ml-2 shrink-0">{streamStatus}</span>}
        </div>
      </div>
    </div>
  );
}
