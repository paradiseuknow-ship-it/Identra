import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';

const KIND_COLOR = {
  PLAN: 'bg-purple-600',
  STEP: 'bg-blue-600',
  ACTION: 'bg-emerald-600',
  OBSERVATION: 'bg-cyan-600',
  ERROR: 'bg-red-600',
  REPAIR: 'bg-amber-600',
  RETRY: 'bg-orange-600',
  VERIFICATION: 'bg-green-600',
  CHECKPOINT: 'bg-indigo-600',
  VIL: 'bg-fuchsia-600',
  ESCALATION: 'bg-rose-700',
};

function fmtTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString();
}

// latency.avg 单位为毫秒；>=1000 时以秒展示，否则以毫秒展示
function fmtDuration(avg) {
  if (avg == null) return null;
  if (avg >= 1000) return (avg / 1000).toFixed(2) + 's';
  return Math.round(avg) + 'ms';
}

function TaskDashboard({ dash, tasks, onSelect, onViewDetail }) {
  // 兼容 { dashboard: { task: {...} } } 与扁平 { total, completed, ... } 两种返回结构
  const dm = (dash && dash.task) || dash || {};
  const successRate = dm.successRate != null ? dm.successRate : null;
  // 后端未直接提供 verificationRate 时，以 successRate*100 作为估算值（带 * 标注）
  const verificationRate = dm.verificationRate != null
    ? dm.verificationRate
    : (successRate != null ? successRate * 100 : null);
  const approxVerification = dm.verificationRate == null && verificationRate != null;

  // 仅渲染后端确实返回的字段（含可选链兜底），不臆造数据
  const stats = [
    { label: '总任务', value: dm.total != null ? dm.total : null },
    { label: '成功', value: dm.completed != null ? dm.completed : null },
    { label: '失败', value: dm.failed != null ? dm.failed : null },
    { label: '成功率', value: successRate != null ? (successRate * 100).toFixed(1) + '%' : null },
  ];
  if (dm.pendingOrRunning != null) stats.push({ label: '运行中', value: dm.pendingOrRunning });
  const avgDur = fmtDuration(dm.latency?.avg);
  if (avgDur != null) stats.push({ label: '平均耗时', value: avgDur });
  if (dm.cancelled != null) stats.push({ label: '已取消', value: dm.cancelled });
  if (dm.recoveryRate != null) stats.push({ label: '恢复率', value: (dm.recoveryRate * 100).toFixed(1) + '%' });
  if (dm.humanEscalation != null) stats.push({ label: '人工升级', value: dm.humanEscalation });
  if (verificationRate != null) stats.push({ label: approxVerification ? '验证率(估算)' : '验证率', value: verificationRate.toFixed(1) + '%', approx: approxVerification });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stats.filter((s) => s.value != null).map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} approx={s.approx} />
        ))}
      </div>
      {approxVerification && (
        <div className="text-[11px] text-gray-400">* 验证率为基于成功率的客户端估算值（后端未直接提供 verificationRate）。</div>
      )}
      <DeprecationView dash={dash} />
      <div className="bg-white dark:bg-gray-800 rounded shadow">
        <div className="px-4 py-2 border-b font-medium">任务列表</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="px-4 py-2">ID</th>
              <th className="px-4 py-2">目标</th>
              <th className="px-4 py-2">状态</th>
              <th className="px-4 py-2">模式</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {(tasks || []).map((tk) => (
              <tr key={tk.id} className="border-t hover:bg-gray-50 dark:hover:bg-gray-700">
                <td className="px-4 py-2 font-mono text-xs">{tk.id}</td>
                <td className="px-4 py-2">{tk.objective || tk.targetUrl || '-'}</td>
                <td className="px-4 py-2">
                  <span className={'px-2 py-0.5 rounded text-xs text-white ' + (tk.status === 'SUCCESS' ? 'bg-green-600' : tk.status === 'FAILED' ? 'bg-red-600' : 'bg-gray-500')}>
                    {tk.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs">{tk.executionMode || '-'}</td>
                <td className="px-4 py-2">
                  <button className="text-blue-600 text-xs" onClick={() => onSelect(tk.id)}>查看时间线</button>
                  {onViewDetail && <button className="text-emerald-600 text-xs ml-2" onClick={() => onViewDetail(tk.id)}>详情</button>}
                </td>
              </tr>
            ))}
            {(!tasks || !tasks.length) && (
              <tr><td colSpan="5" className="px-4 py-4 text-center text-gray-400">暂无任务</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, approx }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded shadow p-3">
      <div className="text-xs text-gray-500">{label}{approx ? ' *' : ''}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

function TimelineNode({ n }) {
  const color = KIND_COLOR[n.kind] || 'bg-gray-600';
  let detail = '';
  if (n.kind === 'PLAN') detail = `${n.objective || ''} (${n.stepCount} 步)`;
  else if (n.kind === 'STEP') detail = `${n.type} · ${n.description || ''} · ${n.status}`;
  else if (n.kind === 'ACTION') detail = `${n.action && (n.action.type || n.action.tool) || ''} · ${n.status}`;
  else if (n.kind === 'OBSERVATION') detail = JSON.stringify(n.observation).slice(0, 120);
  else if (n.kind === 'ERROR') detail = `${n.code || ''}: ${n.message || ''}${n.snapshotRef ? ' [截图]' : ''}`;
  else if (n.kind === 'REPAIR') detail = `${n.strategy} · ${n.status} · risk=${n.risk}`;
  else if (n.kind === 'RETRY') detail = `第 ${n.index} 次尝试`;
  else if (n.kind === 'VERIFICATION') detail = JSON.stringify(n.payload).slice(0, 120);
  else if (n.kind === 'CHECKPOINT') detail = `${n.url || ''} · 上次成功: ${n.lastSuccessfulAction || '-'}`;
  else if (n.kind === 'VIL') {
    const conf = n.confidence != null ? (n.confidence <= 1 ? (n.confidence * 100).toFixed(0) + '%' : String(n.confidence)) : '-';
    detail = `VIL 建议 ${n.decision || '-'}${n.failureType ? `（${n.failureType}）` : ''}：${n.why || '-'} · confidence=${conf}`;
  }
  else if (n.kind === 'ESCALATION') detail = `升级人工：${n.reason || 'verification 重试耗尽 / credential 需审批'}`;
  return (
    <div className="flex gap-2 items-start">
      <span className={'mt-1 px-2 py-0.5 rounded text-xs text-white whitespace-nowrap ' + color}>{n.kind}</span>
      <div className="text-xs">
        <span className="text-gray-400 mr-2">{fmtTs(n.ts)}</span>
        <span className="font-mono">{detail}</span>
      </div>
    </div>
  );
}

function ExecutionTimeline({ trace }) {
  const tl = (trace && trace.timeline) || [];
  if (!tl.length) return <div className="text-gray-400 text-sm p-4">该任务无时间线数据。</div>;
  return (
    <div className="space-y-1 bg-white dark:bg-gray-800 rounded shadow p-3 max-h-[480px] overflow-auto">
      {tl.map((n, i) => <TimelineNode key={i} n={n} />)}
    </div>
  );
}

// C44：遗留端点命中视图（RFC 8594 deprecation 可观测性）——
// 长期 0 命中的 legacy 路由可安全下线；命中上升则提示迁移未完成。
function DeprecationView({ dash }) {
  const dep = dash && dash.deprecation;
  if (!dep) return null;
  return (
    <div className="bg-white dark:bg-gray-800 rounded shadow">
      <div className="px-4 py-2 border-b font-medium flex justify-between items-center">
        <span>遗留端点命中（Deprecation）</span>
        <span className="text-xs text-gray-400">总命中 {dep.total || 0}</span>
      </div>
      {(!dep.routes || !dep.routes.length) ? (
        <div className="px-4 py-3 text-gray-400 text-sm">无遗留端点调用记录 —— 所有流量已走正式路由。</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="px-4 py-2">路由</th>
              <th className="px-4 py-2">命中</th>
              <th className="px-4 py-2">最近调用</th>
              <th className="px-4 py-2">调用者</th>
              <th className="px-4 py-2">建议替代</th>
            </tr>
          </thead>
          <tbody>
            {dep.routes.map((r) => (
              <tr key={r.route} className="border-t">
                <td className="px-4 py-2 font-mono text-xs">{r.route}</td>
                <td className="px-4 py-2">
                  <span className={'px-2 py-0.5 rounded text-xs text-white ' + (r.count > 0 ? 'bg-amber-500' : 'bg-gray-400')}>
                    {r.count}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs">{fmtTs(r.lastAt)}</td>
                <td className="px-4 py-2 text-xs font-mono">{r.lastUser || '-'}</td>
                <td className="px-4 py-2 text-xs text-emerald-600">{r.successor || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CheckpointView({ trace }) {
  const cps = (trace && trace.timeline || []).filter((n) => n.kind === 'CHECKPOINT');
  return (
    <div className="bg-white dark:bg-gray-800 rounded shadow p-3">
      <div className="font-medium mb-2">Checkpoint 恢复状态</div>
      {!cps.length && <div className="text-gray-400 text-sm">无 checkpoint。</div>}
      {cps.map((c, i) => (
        <div key={i} className="text-xs border-t py-2">
          <div>URL: <span className="font-mono">{c.url || '-'}</span></div>
          <div>上次成功动作: {c.lastSuccessfulAction || '-'}</div>
          <div className="text-gray-400">时间戳: {fmtTs(c.ts)}</div>
          <div className="text-amber-600 text-[11px] mt-1">（恢复动作由服务端 checkpoint.restore 执行；此处为只读恢复状态视图）</div>
        </div>
      ))}
    </div>
  );
}

function SnapshotView({ snapshots }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded shadow p-3">
      <div className="font-medium mb-2">Browser Session / 失败快照</div>
      {(!snapshots || !snapshots.length) && <div className="text-gray-400 text-sm">无失败快照。</div>}
      {(snapshots || []).map((s) => (
        <div key={s.id} className="text-xs border-t py-2">
          <div>类型: {s.errorType || '-'}</div>
          <div>URL: <span className="font-mono">{s.url || '-'}</span></div>
          <div className="text-gray-400">截图引用: {s.screenshotRef || '-'}（图像服务未启用）</div>
        </div>
      ))}
    </div>
  );
}

export default function ObservabilityPanel({ onViewDetail }) {
  const [dash, setDash] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [trace, setTrace] = useState(null);
  const [replay, setReplay] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [d, ts] = await Promise.all([api.aiDashboard(), api.aiListTasks()]);
      setDash(d.dashboard || null);
      setTasks(Array.isArray(ts) ? ts : (ts.tasks || []));
    } catch (e) { setErr(String(e.message || e)); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const select = useCallback(async (id) => {
    setSelected(id); setReplay(null);
    try {
      const tr = await api.aiTrace(id);
      setTrace(tr.trace || null);
      try { const sn = await api.aiSnapshots(id); setSnapshots(sn.snapshots || []); }
      catch (e) { setSnapshots([]); }
    } catch (e) { setErr(String(e.message || e)); }
  }, []);

  const doReplay = useCallback(async () => {
    if (!selected) return;
    try { const r = await api.aiReplay(selected); setReplay(r.text || '(无回放数据)'); }
    catch (e) { setReplay('回放失败: ' + (e.message || e)); }
  }, [selected]);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Observability</h2>
      {err && <div className="text-red-600 text-sm">{err}</div>}
      <TaskDashboard dash={dash} tasks={tasks} onSelect={select} onViewDetail={onViewDetail} />
      {selected && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">当前任务: <span className="font-mono">{selected}</span></span>
            <button className="text-xs px-2 py-1 bg-blue-600 text-white rounded" onClick={doReplay}>生成 Replay</button>
          </div>
          <div>
            <div className="font-medium mb-1">Execution Timeline</div>
            <ExecutionTimeline trace={trace} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <CheckpointView trace={trace} />
            <SnapshotView snapshots={snapshots} />
          </div>
          {replay && (
            <div className="bg-black text-green-300 rounded p-3 text-xs font-mono whitespace-pre-wrap max-h-80 overflow-auto">{replay}</div>
          )}
        </div>
      )}
    </div>
  );
}
