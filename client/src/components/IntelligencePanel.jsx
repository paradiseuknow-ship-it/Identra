import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';

// C24: 智能记忆面板（站点画像 / Element 记忆 / 流记忆 / 失败知识）——只读出口。
// 缺口背景：/api/ai/intelligence/* 全家桶（Flow/Element Memory、Failure Knowledge 三大架构模块）
// 此前 client 零消费，AI 积累的经验对用户完全不可见。

const pct = (v) => (typeof v === 'number' ? Math.round(v * 100) + '%' : '—');
const RISK = {
  low: 'bg-emerald-500/15 text-emerald-400',
  medium: 'bg-amber-500/15 text-amber-400',
  high: 'bg-rose-500/15 text-rose-400',
  unknown: 'bg-slate-500/15 text-slate-400',
};

export default function IntelligencePanel({ notify }) {
  const [sites, setSites] = useState([]);
  const [flows, setFlows] = useState([]);
  const [failures, setFailures] = useState([]);
  const [selected, setSelected] = useState(null); // site detail
  const [view, setView] = useState('sites'); // sites | flows | failures
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, f, k] = await Promise.all([api.intelSites(), api.intelFlows(), api.intelFailures()]);
      setSites(Array.isArray(s) ? s : []);
      setFlows(Array.isArray(f) ? f : []);
      setFailures(Array.isArray(k) ? k : []);
      setErr('');
    } catch (e) { setErr(String(e.message || e)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openSite = async (siteName) => {
    try {
      const d = await api.intelSiteDetail(siteName);
      setSelected(d);
    } catch (e) { notify(e.message, false); }
  };

  return (
    <div className="space-y-4">
      {/* tab 行 */}
      <div className="flex gap-2 text-xs">
        {[['sites', '站点画像（' + sites.length + '）'], ['flows', '流记忆（' + flows.length + '）'], ['failures', '失败知识（' + failures.length + '）']].map(([k, label]) => (
          <button key={k} onClick={() => { setView(k); setSelected(null); }}
            className={`px-3 py-1.5 rounded text-xs border ${view === k ? 'bg-sky-600 border-sky-500 text-white' : 'border-edge text-slate-400 hover:bg-edge'}`}>{label}</button>
        ))}
        <button onClick={load} className="ml-auto px-3 py-1.5 rounded border border-edge hover:bg-edge text-slate-300 text-xs">刷新</button>
      </div>
      {err && <div className="text-xs text-rose-400">{err}</div>}

      {/* 站点画像 */}
      {view === 'sites' && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {sites.map((s) => (
            <button key={s.site} onClick={() => openSite(s.site)}
              className={`text-left bg-panel/60 border rounded-lg p-3 hover:border-sky-600 ${selected && selected.site && selected.site.site === s.site ? 'border-sky-600' : 'border-edge'}`}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-200 truncate">{s.site}</span>
                <span className={`px-2 py-0.5 rounded text-xs ${RISK[s.riskLevel] || RISK.unknown}`}>{s.riskLevel || 'unknown'}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                成功 {s.history?.successTasks || 0} · 失败 {s.history?.failedTasks || 0}
              </div>
            </button>
          ))}
          {!sites.length && <div className="text-sm text-slate-500 col-span-full p-6 text-center border border-dashed border-edge rounded-lg">暂无站点记忆——AI 执行任务后会自动积累站点画像。</div>}
        </div>
      )}
      {view === 'sites' && selected && (
        <div className="bg-panel/60 border border-edge rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-200">{selected.site?.site} 详情</span>
            <button onClick={() => setSelected(null)} className="text-xs text-slate-500 hover:text-slate-300">收起</button>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-400 mb-1.5">Element 记忆（{selected.elements?.length || 0}）</div>
            <div className="space-y-1 max-h-40 overflow-auto">
              {(selected.elements || []).map((e) => (
                <div key={e.id} className="text-xs border-b border-edge/30 py-1 flex justify-between gap-3">
                  <span className="text-slate-300 truncate" title={e.patterns}>{e.purpose} <span className="text-slate-600 font-mono">{e.elementType}</span></span>
                  <span className="text-slate-500 shrink-0">置信 {pct(e.confidence)} · 成功 {pct(e.successRate)}</span>
                </div>
              ))}
              {!selected.elements?.length && <div className="text-xs text-slate-600">无</div>}
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-400 mb-1.5">流记忆（{selected.flows?.length || 0}）</div>
            <div className="space-y-1 max-h-40 overflow-auto">
              {(selected.flows || []).map((f) => (
                <div key={f.id} className="text-xs border-b border-edge/30 py-1 flex justify-between gap-3">
                  <span className="text-slate-300 truncate">{f.goal}</span>
                  <span className="text-slate-500 shrink-0">置信 {pct(f.confidence)} · 样本 {f.samples || 0}</span>
                </div>
              ))}
              {!selected.flows?.length && <div className="text-xs text-slate-600">无</div>}
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-slate-400 mb-1.5">失败经验（{selected.failures?.length || 0}）</div>
            <div className="space-y-1 max-h-40 overflow-auto">
              {(selected.failures || []).map((r) => (
                <div key={r.id} className="text-xs border-b border-edge/30 py-1">
                  <div className="flex justify-between gap-3">
                    <span className="text-amber-400">{r.category}</span>
                    <span className="text-slate-500 shrink-0">置信 {pct(r.confidence)}</span>
                  </div>
                  {r.solution && <div className="text-slate-500 mt-0.5">解法: {r.solution}</div>}
                </div>
              ))}
              {!selected.failures?.length && <div className="text-xs text-slate-600">无</div>}
            </div>
          </div>
        </div>
      )}

      {/* 流记忆全局 */}
      {view === 'flows' && (
        <div className="bg-panel/60 border border-edge rounded-lg p-4">
          <div className="space-y-1 max-h-96 overflow-auto">
            {flows.map((f) => (
              <div key={f.id} className="text-xs border-b border-edge/30 py-1.5 flex justify-between gap-3">
                <span className="text-slate-300 truncate"><span className="text-sky-400 font-mono mr-2">{f.site}</span>{f.goal}</span>
                <span className="text-slate-500 shrink-0">置信 {pct(f.confidence)} · 成功 {pct(f.successRate)} · 样本 {f.samples || 0}</span>
              </div>
            ))}
            {!flows.length && <div className="text-xs text-slate-500">暂无流记忆。</div>}
          </div>
        </div>
      )}

      {/* 失败知识全局 */}
      {view === 'failures' && (
        <div className="bg-panel/60 border border-edge rounded-lg p-4">
          <div className="space-y-1.5 max-h-96 overflow-auto">
            {failures.map((r) => (
              <div key={r.id} className="text-xs border-b border-edge/30 py-1.5">
                <div className="flex justify-between gap-3">
                  <span><span className="text-sky-400 font-mono mr-2">{r.site}</span><span className="text-amber-400">{r.category}</span></span>
                  <span className="text-slate-500 shrink-0">置信 {pct(r.confidence)} · 成功率 {pct(r.successRate)}</span>
                </div>
                {r.condition && <div className="text-slate-500 mt-0.5">条件: {r.condition}</div>}
                {r.solution && <div className="text-slate-400 mt-0.5">解法: {r.solution}</div>}
              </div>
            ))}
            {!failures.length && <div className="text-xs text-slate-500">暂无失败知识。</div>}
          </div>
        </div>
      )}
    </div>
  );
}
