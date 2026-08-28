'use strict';

// Profile Scoring（Phase 3.4）：全局「环境评分」。
// 关键设计（用户强调）：成功次数最多 ≠ 最好环境。必须从五个维度综合：
//   ProfileScore =
//     Fingerprint Health × 0.25
//   + Network Health     × 0.25
//   + Site Success Hist. × 0.30
//   + Stability          × 0.10
//   + Freshness          × 0.10
// 其中 Site Success History 需样本权重（siteScoreFromStats），不是朴素成功率。
//
// 注意：本模块只算「全局综合分」。针对具体站点的匹配分由 profileMatcher 处理
// （站点专属分优先于纯环境质量），以满足「跨站隔离」与「选对目标的环境」。

const DAY_MS = 1000 * 60 * 60 * 24;
const W = { fingerprint: 0.25, network: 0.25, siteSuccess: 0.30, stability: 0.10, freshness: 0.10 };

// 站点成功率成熟所需样本数（比元素记忆保守：环境选择风险更高）
const SITE_FULL_SAMPLES = 10;
const GLOBAL_FULL_SAMPLES = 10;

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function round(v) { return Math.round(v); }

// 样本置信度：达到 FULL 样本才完全可信（0→1 线性）
function sampleConfidence(n, full) {
  n = Math.max(0, Number(n) || 0);
  return Math.min(1, n / (full || SITE_FULL_SAMPLES));
}

// 新鲜度因子（0.5~1.0）：7 天内为 1；60 天后衰减到 0.5 下限（老环境评分可能已失效）
function freshnessFactor(updatedAt, now) {
  now = now || Date.now();
  const age = Math.max(0, (now - (updatedAt || now))) / DAY_MS;
  if (age <= 7) return 1;
  return Math.max(0.5, 1 - (age - 7) / 60);
}

// 全局综合评分（0-100）。siteSuccess 传入 taskSuccess 维度（全局任务成功率）。
// dims: { fingerprint, network, siteSuccess, stability }；freshness 由 updatedAt 推导。
function computeScore({ fingerprint, network, siteSuccess, stability, freshness }) {
  const f = clamp(fingerprint == null ? 0 : fingerprint, 0, 100);
  const n = clamp(network == null ? 0 : network, 0, 100);
  const s = clamp(siteSuccess == null ? 0 : siteSuccess, 0, 100);
  const st = clamp(stability == null ? 0 : stability, 0, 100);
  const fr = clamp((freshness == null ? 1 : freshness) * 100, 0, 100);
  const score = f * W.fingerprint + n * W.network + s * W.siteSuccess + st * W.stability + fr * W.freshness;
  return clamp(round(score), 0, 100);
}

// 全局分（基于已存记录）：Site Success 用 taskSuccess 维度；freshness 由 updatedAt 计算。
function overallScore(record) {
  if (!record) return 0;
  const d = record.dimensions || {};
  const fr = freshnessFactor(record.updatedAt || Date.now());
  return computeScore({
    fingerprint: d.fingerprint,
    network: d.network,
    siteSuccess: d.taskSuccess,
    stability: d.stability,
    freshness: fr,
  });
}

// 站点成功率 → 0-100 评分。
// 近期趋势加权：recent 窗口（布尔数组）显著偏离历史时，向近期靠拢（恶化要降权）。
// 朴素成功率 × 样本成熟度 × 新鲜度，避免「样本少却虚高」与「老经验虚高」。
function siteScoreFromStats({ success, failed, recent, freshness }) {
  const total = (Number(success) || 0) + (Number(failed) || 0);
  if (!total) return 0;
  const rate = success / total;
  const recArr = Array.isArray(recent) ? recent : [];
  const recTotal = recArr.length;
  const recSucc = recArr.filter(Boolean).length;
  const recRate = recTotal ? recSucc / recTotal : rate;
  // 近期窗口足够（≥3）才引入趋势修正，否则信任历史
  const effRate = recTotal >= 3 ? (0.6 * rate + 0.4 * recRate) : rate;
  const conf = sampleConfidence(total, SITE_FULL_SAMPLES);
  const fr = freshness == null ? 1 : freshness;
  const s = effRate * 100 * (0.6 + 0.4 * conf) * (0.5 + 0.5 * fr);
  return clamp(round(s), 0, 100);
}

// 站点评分对应的「置信度」（供 advisor 透出）：样本越多越可信
function siteConfidence(samples) {
  return Math.round(sampleConfidence(samples, SITE_FULL_SAMPLES) * 1000) / 1000;
}

// 全局置信度
function globalConfidence(totalTasks) {
  return Math.round(sampleConfidence(totalTasks, GLOBAL_FULL_SAMPLES) * 1000) / 1000;
}

module.exports = {
  computeScore, overallScore, siteScoreFromStats, sampleConfidence, freshnessFactor,
  siteConfidence, globalConfidence, clamp, round, DAY_MS,
  SITE_FULL_SAMPLES, GLOBAL_FULL_SAMPLES, WEIGHTS: W,
};
