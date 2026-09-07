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
  const [view, setView] = useState('sites'); // sites | flows | failures | advisor | health
  const [err, setErr] = useState('');

  // C28：Router 决策试算 / 环境推荐
  const [decForm, setDecForm] = useState({ objective: '', targetUrl: '', region: '', profileId: '' });
  const [decision, setDecision] = useState(null);
  const [recForm, setRecForm] = useState({ site: '', url: '', profileId: '' });
  const [recommend, setRecommend] = useState(null);
  // C28：经验健康看板 / 环境评分 / 站点×环境矩阵
  const [evalRep, setEvalRep] = useState(null);
  const [profRecs, setProfRecs] = useState([]);
  const [matrix, setMatrix] = useState(null);
  const [outcome, setOutcome] = useState({ profileId: '', site: '', ok: true });

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

  // C25：经验包导出/导入（Element + Site + Flow 站点经验整体迁移）
  const exportPack = async (siteName) => {
    try {
      const r = await api.intelExportPack({ site: siteName });
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'intel-pack-' + siteName.replace(/[^a-z0-9.-]/gi, '_') + '-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      notify('经验包已导出（' + siteName + '）');
    } catch (e) { notify('导出失败: ' + e.message, false); }
  };

  const importPack = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const pack = parsed.pack || parsed; // 兼容裸 pack 与 { pack } 包装
      const r = await api.intelImportPack({ pack });
      notify('经验包已导入');
      await load();
    } catch (e) { notify('导入失败: ' + e.message, false); }
  };

  // C28：健康看板数据（切到该视图时拉取；失败降级为空，不阻断面板）
  const loadHealth = useCallback(async () => {
    try {
      const [e, p, m] = await Promise.all([
        api.intelEvaluation().catch(() => null),
        api.intelProfiles().catch(() => []),
        api.intelMatrix().catch(() => null),
      ]);
      // 该端点返回 { ok, report } 包装，统一降级为 report 本体（避免上层到处判空）
      setEvalRep((e && e.report) || e);
      setProfRecs(Array.isArray(p) ? p : []);
      setMatrix(m);
    } catch (e2) { setErr(String(e2.message || e2)); }
  }, []);

  useEffect(() => { if (view === 'health') loadHealth(); }, [view, loadHealth]);

  const runDecision = async () => {
    try {
      const r = await api.intelDecision({
        objective: decForm.objective.trim() || undefined,
        targetUrl: decForm.targetUrl.trim() || undefined,
        region: decForm.region.trim() || undefined,
        profileId: decForm.profileId.trim() || undefined,
      });
      setDecision(r);
    } catch (e) { notify(e.message, false); }
  };

  const runRecommend = async () => {
    try {
      const r = await api.intelRecommend({
        site: recForm.site.trim() || undefined,
        url: recForm.url.trim() || undefined,
        profileId: recForm.profileId.trim() || undefined,
      });
      setRecommend(r);
    } catch (e) { notify(e.message, false); }
  };

  const submitOutcome = async () => {
    if (!outcome.profileId.trim() || !outcome.site.trim()) return notify('请填写 Profile ID 与站点', false);
    try {
      await api.intelRecordOutcome(outcome.profileId.trim(), { site: outcome.site.trim(), ok: !!outcome.ok });
      notify('已登记一次执行结果');
      await loadHealth();
    } catch (e) { notify(e.message, false); }
  };

  return (
    <div className="space-y-4">
      {/* tab 行 */}
      <div className="flex gap-2 text-xs flex-wrap">
        {[['sites', '站点画像（' + sites.length + '）'], ['flows', '流记忆（' + flows.length + '）'], ['failures', '失败知识（' + failures.length + '）'], ['advisor', '决策试算'], ['health', '经验健康']].map(([k, label]) => (
          <button key={k} onClick={() => { setView(k); setSelected(null); }}
            className={`px-3 py-1.5 rounded text-xs border ${view === k ? 'bg-sky-600 border-sky-500 text-white' : 'border-edge text-slate-400 hover:bg-edge'}`}>{label}</button>
        ))}
        <button onClick={load} className="ml-auto px-3 py-1.5 rounded border border-edge hover:bg-edge text-slate-300 text-xs">刷新</button>
        <label className="px-3 py-1.5 rounded border border-edge hover:bg-edge text-slate-300 text-xs cursor-pointer" title="导入站点经验包（JSON）">
          导入经验包
          <input type="file" accept=".json,application/json" className="hidden" onChange={importPack} />
        </label>
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
            <div className="flex gap-2 items-center">
              <button onClick={() => exportPack(selected.site?.site)} className="px-2 py-1 rounded bg-sky-600/80 hover:bg-sky-500 text-white text-xs" title="导出该站点 Element+Site+Flow 经验包（JSON）">导出经验包</button>
              <button onClick={() => setSelected(null)} className="text-xs text-slate-500 hover:text-slate-300">收起</button>
            </div>
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

      {/* C28：Router 决策试算 + 环境推荐 */}
      {view === 'advisor' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-panel/60 border border-edge rounded-lg p-4">
            <div className="text-sm font-semibold text-slate-200 mb-2">Router 决策试算（只读，不执行）</div>
            <div className="grid grid-cols-1 gap-2 text-xs">
              <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" placeholder="objective（任务目标）"
                value={decForm.objective} onChange={(e) => setDecForm({ ...decForm, objective: e.target.value })} />
              <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" placeholder="targetUrl（目标地址）"
                value={decForm.targetUrl} onChange={(e) => setDecForm({ ...decForm, targetUrl: e.target.value })} />
              <div className="flex gap-2">
                <input className="flex-1 px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" placeholder="region（可选）"
                  value={decForm.region} onChange={(e) => setDecForm({ ...decForm, region: e.target.value })} />
                <input className="flex-1 px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" placeholder="profileId（可选，指定环境）"
                  value={decForm.profileId} onChange={(e) => setDecForm({ ...decForm, profileId: e.target.value })} />
              </div>
              <button onClick={runDecision} className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white w-fit">试算</button>
            </div>
            {decision && (
              <div className="mt-3 text-xs space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">推荐环境</span>
                  <span className="text-slate-200 font-mono">{decision.decision?.profile?.name || decision.decision?.profile?.id || '—'}</span>
                  {decision.decision?.profile?.score != null && <span className="text-sky-300">评分 {decision.decision.profile.score}</span>}
                  {decision.fromCache && <span className="px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-400">缓存命中</span>}
                </div>
                {decision.decision?.profile?.reason && <div className="text-slate-500">理由：{decision.decision.profile.reason}</div>}
                <div className="text-slate-500">
                  流程 {decision.decision?.flow?.id ? <span className="font-mono text-slate-300">{String(decision.decision.flow.id).slice(-10)}</span> : '无'} ·
                  置信 {pct(decision.decision?.flow?.confidence)} ·
                  需 LLM 规划 {String(decision.decision?.strategy?.requireLLM)}
                </div>
                {Array.isArray(decision.reasons) && decision.reasons.length > 0 && (
                  <ul className="list-disc pl-4 text-slate-400">{decision.reasons.slice(0, 6).map((r, i) => <li key={i}>{typeof r === 'string' ? r : JSON.stringify(r)}</li>)}</ul>
                )}
                {Array.isArray(decision.warnings) && decision.warnings.length > 0 && (
                  <ul className="list-disc pl-4 text-amber-400">{decision.warnings.slice(0, 6).map((w, i) => <li key={i}>{typeof w === 'string' ? w : JSON.stringify(w)}</li>)}</ul>
                )}
              </div>
            )}
          </div>

          <div className="bg-panel/60 border border-edge rounded-lg p-4">
            <div className="text-sm font-semibold text-slate-200 mb-2">环境推荐（Profile Advisor）</div>
            <div className="grid grid-cols-1 gap-2 text-xs">
              <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" placeholder="site（如 example.com）"
                value={recForm.site} onChange={(e) => setRecForm({ ...recForm, site: e.target.value })} />
              <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" placeholder="url（无 site 时按 url 推导）"
                value={recForm.url} onChange={(e) => setRecForm({ ...recForm, url: e.target.value })} />
              <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" placeholder="profileId（可选，尊重用户指定）"
                value={recForm.profileId} onChange={(e) => setRecForm({ ...recForm, profileId: e.target.value })} />
              <button onClick={runRecommend} className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white w-fit">推荐</button>
            </div>
            {recommend && (
              <div className="mt-3 text-xs space-y-1">
                {recommend.matched ? (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">推荐</span>
                      <span className="text-slate-200">{recommend.recommendation?.name || recommend.recommendation?.profileId}</span>
                      <span className="text-slate-500">置信 {pct(recommend.recommendation?.confidence)}</span>
                      {recommend.recommendation?.specificity && <span className="px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-400">{recommend.recommendation.specificity}</span>}
                      {recommend.recommendation?.status && <span className="text-slate-500">{recommend.recommendation.status}</span>}
                    </div>
                    {recommend.recommendation?.reason && <div className="text-slate-500">{recommend.recommendation.reason}</div>}
                  </>
                ) : <div className="text-slate-500">未匹配：{recommend.reason || '—'}</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* C28：经验健康看板 + 环境评分 + 站点×环境矩阵 */}
      {view === 'health' && (
        <div className="space-y-4">
          <div className="bg-panel/60 border border-edge rounded-lg p-4">
            <div className="text-sm font-semibold text-slate-200 mb-2">经验健康看板</div>
            {evalRep ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div className="rounded border border-edge px-3 py-2">
                  <div className="text-slate-500">Router 准确率</div>
                  <div className="text-sky-300 text-base">{pct(evalRep.routerAccuracy)}<span className="text-slate-600 text-xs ml-1">n={evalRep.routerAccuracyN ?? 0}</span></div>
                </div>
                <div className="rounded border border-edge px-3 py-2">
                  <div className="text-slate-500">LLM 节省</div>
                  <div className="text-emerald-300 text-base">{typeof evalRep.llmReduction === 'number' ? pct(evalRep.llmReduction) : (evalRep.llmReduction || '—')}</div>
                </div>
                <div className="rounded border border-edge px-3 py-2">
                  <div className="text-slate-500">Memory ROI</div>
                  <div className="text-sky-300 text-base">{typeof evalRep.memoryROI === 'number' ? evalRep.memoryROI : (evalRep.memoryROI ? JSON.stringify(evalRep.memoryROI).slice(0, 40) : '—')}</div>
                </div>
                <div className="rounded border border-edge px-3 py-2">
                  <div className="text-slate-500">生成时间</div>
                  <div className="text-slate-300 text-base">{evalRep.generatedAt ? new Date(evalRep.generatedAt).toLocaleString() : '—'}</div>
                </div>
              </div>
            ) : <div className="text-xs text-slate-500">暂无评估数据。</div>}
            {evalRep && Array.isArray(evalRep.weakAreas) && evalRep.weakAreas.length > 0 && (
              <div className="mt-3 text-xs">
                <div className="text-slate-400 mb-1">弱项</div>
                <ul className="list-disc pl-4 text-amber-400">
                  {evalRep.weakAreas.slice(0, 8).map((w, i) => <li key={i}>{typeof w === 'string' ? w : JSON.stringify(w).slice(0, 160)}</li>)}
                </ul>
              </div>
            )}
          </div>

          <div className="bg-panel/60 border border-edge rounded-lg p-4">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <span className="text-sm font-semibold text-slate-200">环境评分（{profRecs.length}）</span>
              <div className="flex items-center gap-2 text-xs">
                <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200 w-40" placeholder="Profile ID"
                  value={outcome.profileId} onChange={(e) => setOutcome({ ...outcome, profileId: e.target.value })} />
                <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200 w-40" placeholder="site"
                  value={outcome.site} onChange={(e) => setOutcome({ ...outcome, site: e.target.value })} />
                <label className="flex items-center gap-1 text-slate-400">
                  <input type="checkbox" checked={outcome.ok} onChange={(e) => setOutcome({ ...outcome, ok: e.target.checked })} />成功
                </label>
                <button onClick={submitOutcome} className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white">登记结果</button>
              </div>
            </div>
            <div className="space-y-1 max-h-52 overflow-auto">
              {profRecs.map((r) => (
                <div key={r.profileId || r.id} className="text-xs border-b border-edge/30 py-1 flex justify-between gap-3">
                  <span className="text-slate-300 truncate">{r.name || r.profileId} <span className="text-slate-600 font-mono">{r.profileId}</span></span>
                  <span className="text-slate-500 shrink-0">评分 {r.score != null ? r.score : '—'} · 成功 {r.stats?.success || 0}/{r.stats?.totalTasks || 0} · {r.status || '—'}</span>
                </div>
              ))}
              {!profRecs.length && <div className="text-xs text-slate-500">暂无环境评分记录（任务执行后自动积累，也可上方手动登记）。</div>}
            </div>
          </div>

          <div className="bg-panel/60 border border-edge rounded-lg p-4">
            <div className="text-sm font-semibold text-slate-200 mb-2">站点 × 环境矩阵</div>
            {matrix && (matrix.sites || []).length > 0 ? (
              <div className="overflow-auto">
                <table className="w-full text-xs">
                  <thead className="text-slate-500 text-left">
                    <tr><th className="py-1">站点</th>{(matrix.profiles || []).map((p) => <th key={p} className="py-1 font-mono">{String(p).slice(-8)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {(matrix.sites || []).map((s) => (
                      <tr key={s} className="border-t border-edge/40 text-slate-300">
                        <td className="py-1 pr-3">{s}</td>
                        {(matrix.profiles || []).map((p) => {
                          const v = matrix.matrix && matrix.matrix[s] ? matrix.matrix[s][p] : null;
                          return <td key={p} className="py-1">{v == null ? <span className="text-slate-700">—</span> : v}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="text-xs text-slate-500">暂无矩阵数据（需要有站点维度的环境评分）。</div>}
          </div>
        </div>
      )}
    </div>
  );
}
