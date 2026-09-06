'use strict';

// CAP-B1：代理池健康度与自动轮换。
//
// 定位：代理是「网络从哪里连接」的资源——死了要早知道（健康度），死了要能换（轮换）。
//
// 设计约束：
//   - 健康数据是**服务端事实**：只能由 check 路由（recordCheck）写入；
//     客户端 PUT 一律剥离 health/lastCheck（防伪造健康报告骗过轮换）。
//   - 滑动窗口：history 只留最近 HEALTH_WINDOW 条，防无限增长。
//   - 状态机（由连续失败/成功驱动，不用自由文本）：
//       unchecked（无记录）→ healthy（连续成功）→ degraded（有失败）→ dead（连续失败 ≥ DEAD_THRESHOLD）
//   - 轮换语义（红线：绝不静默改变执行语义）：
//       * 显式轮换：POST /proxies/rotate（profile:manage）——换 profile.proxyId；
//       * 启动时自动轮换：仅当 profile.proxyAutoRotate === true 且当前代理已 dead 且
//         同池有健康替补才换，并审计 proxy.auto_rotate；找不到替补 → 保持原代理（fail-open）。
//   - 池 = proxy.pool 字符串（可选）；跨池绝不轮换（地理/用途对齐原则）。

const HEALTH_WINDOW = 20;
const DEAD_THRESHOLD = 3;

function err400(msg) { const e = new Error(msg); e.status = 400; return e; }

// 归一化 pool 字段：空 → null；超长截断
function normalizePool(pool) {
  if (pool === undefined || pool === null || String(pool).trim() === '') return null;
  return String(pool).trim().slice(0, 40);
}

// 检测结果落健康档案（check 路由专用）。result: { ok, latencyMs?, error? }
function recordCheck(proxy, result) {
  if (!proxy || !result) return proxy;
  const h = proxy.health && typeof proxy.health === 'object' ? proxy.health : {};
  const history = Array.isArray(h.history) ? h.history : [];
  const okNow = !!result.ok;
  history.push({ ok: okNow, latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null, at: Date.now() });
  while (history.length > HEALTH_WINDOW) history.shift();
  const nf = (h.consecutiveFails || 0) + 1;
  const nok = (h.consecutiveOk || 0) + 1;
  proxy.health = {
    consecutiveFails: okNow ? 0 : nf,
    consecutiveOk: okNow ? nok : 0,
    history,
    updatedAt: Date.now(),
  };
  proxy.lastCheck = { ok: okNow, latencyMs: proxy.health.history[proxy.health.history.length - 1].latencyMs, error: result.error || null, at: Date.now() }; // 向后兼容旧消费方
  return proxy;
}

// 状态：unchecked | healthy | degraded | dead
function healthOf(proxy) {
  const h = proxy && proxy.health;
  if (!h || !Array.isArray(h.history) || !h.history.length) return 'unchecked';
  if ((h.consecutiveFails || 0) >= DEAD_THRESHOLD) return 'dead';
  if ((h.consecutiveFails || 0) >= 1) return 'degraded';
  return 'healthy';
}

// 汇总指标：成功率（窗口内）+ 平均延迟（仅成功样本）
function metricsOf(proxy) {
  const h = proxy && proxy.health;
  const history = (h && Array.isArray(h.history)) ? h.history : [];
  const total = history.length;
  const okCount = history.filter((x) => x.ok).length;
  const latencies = history.filter((x) => x.ok && Number.isFinite(x.latencyMs)).map((x) => x.latencyMs);
  return {
    status: healthOf(proxy),
    checked: total,
    successRate: total ? Math.round((okCount / total) * 100) / 100 : null,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    consecutiveFails: (h && h.consecutiveFails) || 0,
    lastCheckedAt: (h && h.updatedAt) || null,
  };
}

const STATUS_RANK = { healthy: 0, unchecked: 1, degraded: 2, dead: 3 };

// 同池挑替补：排除自身与死代理；排序 健康度 → 成功率降序 → 平均延迟升序 → id（确定性）
function pickReplacement(poolName, excludeId, proxies) {
  if (!poolName) return null;
  const candidates = (proxies || [])
    .filter((p) => p.pool === poolName && p.id !== excludeId && healthOf(p) !== 'dead')
    .map((p) => { const m = metricsOf(p); return { p, m }; })
    .sort((a, b) =>
      (STATUS_RANK[a.m.status] - STATUS_RANK[b.m.status]) ||
      ((b.m.successRate || 0) - (a.m.successRate || 0)) ||
      ((a.m.avgLatencyMs || Infinity) - (b.m.avgLatencyMs || Infinity)) ||
      String(a.p.id).localeCompare(String(b.p.id)));
  return candidates.length ? candidates[0].p : null;
}

// 轮换决策（纯函数，启动钩子与显式轮换路由共用）：
//   仅当 profile 走保存代理 + 开了 autoRotate + 当前代理已 dead 时才换
// profile.proxyAutoRotate === true；返回 { rotate, to, reason }
function chooseRotation(profile, proxies) {
  if (!profile || profile.proxyMode !== 'saved' || !profile.proxyId) return { rotate: false, to: null, reason: 'not-saved-proxy' };
  if (profile.proxyAutoRotate !== true) return { rotate: false, to: null, reason: 'auto-rotate-disabled' };
  const current = (proxies || []).find((x) => x.id === profile.proxyId);
  if (!current) return { rotate: false, to: null, reason: 'current-not-found' };
  if (healthOf(current) !== 'dead') return { rotate: false, to: null, reason: 'current-not-dead' };
  const to = pickReplacement(current.pool, current.id, proxies);
  if (!to) return { rotate: false, to: null, reason: 'no-healthy-alternative' };
  return { rotate: true, to, reason: 'current-dead' };
}

module.exports = {
  recordCheck, healthOf, metricsOf, pickReplacement, chooseRotation, normalizePool,
  HEALTH_WINDOW, DEAD_THRESHOLD, STATUS_RANK,
};
