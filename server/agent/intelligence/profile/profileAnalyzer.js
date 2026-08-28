'use strict';

// Profile Analyzer（Phase 3.4）：Profile 评分记录的持久化与演化。
// 数据：aiProfileScores.json —— 每个 Profile 一条：score / dimensions / siteScores / stats / confidence / status / region。
// 学习闭环：
//   任务完成/失败 → recordTaskOutcome(profileId, site, ok)
//     → 更新全局 stats + 近期窗口 + 该站点 siteScores（含近期趋势加权）
//     → 重算 dimensions(stability/taskSuccess) 与 overall score / confidence
//     → 更新生命周期（恶化降级，不删除）
//
// 安全约束：仅存储「环境健康」与「站点成功率」量化指标；不存储任何 selector / 坐标 / 凭据 / 执行脚本。

const store = require('../../store');
const scoring = require('./profileScore');
const metrics = require('./profileMetrics');
const { PROFILE_STATUS } = require('./schema');

const COLLECTION = 'aiProfileScores';
const RECENT_WINDOW = 12; // 近期窗口长度（用于稳定性与趋势）

// 中性初值（未体检/无历史时的占位，避免虚高）
const NEUTRAL_DIMS = { fingerprint: 70, network: 70, storage: 75, taskSuccess: 50, stability: 70 };

function ensure(profileId, opts) {
  opts = opts || {};
  let rec = getRecord(profileId);
  if (!rec) {
    rec = {
      id: profileId,           // 唯一键（JsonStore.upsert 依赖 id 匹配，避免多条记录被合并）
      profileId,
      name: opts.name || profileId,
      score: 0,
      dimensions: Object.assign({}, NEUTRAL_DIMS, opts.dimensions || {}),
      siteScores: {},         // site -> { score, success, failed, samples, recent:[bool], confidence, updatedAt }
      stats: { totalTasks: 0, success: 0, failed: 0 },
      recent: [],             // 全局近期成功窗口 [bool]
      region: opts.region || null,
      confidence: 0,
      status: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    rec.score = scoring.overallScore(rec);
    store.upsert(COLLECTION, rec);
  }
  return rec;
}

function getRecord(profileId) {
  return store.findWhere(COLLECTION, (r) => r && r.profileId === profileId)[0] || null;
}

function listRecords() {
  return store.read(COLLECTION, []);
}

function removeProfile(profileId) {
  store.write(COLLECTION, store.read(COLLECTION, []).filter((r) => r.profileId !== profileId));
}

// 站点评分数值（兼容 siteScores[site] 为对象或数值简写）
function siteScoreValue(rec, site) {
  const ss = rec && rec.siteScores && rec.siteScores[site];
  if (ss == null) return null;
  return typeof ss === 'number' ? ss : (ss.score || 0);
}

// 重算某站点评分（含近期趋势 + 样本成熟度 + 新鲜度）
function recomputeSiteScore(rec, site) {
  const ss = rec.siteScores[site];
  const fresh = scoring.freshnessFactor(Date.now());
  ss.score = scoring.siteScoreFromStats({ success: ss.success, failed: ss.failed, recent: ss.recent, freshness: fresh });
  ss.confidence = scoring.siteConfidence(ss.samples);
  ss.updatedAt = Date.now();
  return ss;
}

// 生命周期：基于全局近期窗口的失败率自动演化（不删除、DISABLED 仅人工）
function updateLifecycle(rec) {
  if (rec.status === 'DISABLED') return rec; // 人工禁用，不被自动逻辑覆盖
  const r = rec.recent || [];
  const n = r.length;
  const succ = r.filter(Boolean).length;
  const rate = n ? succ / n : 1;
  if (n >= 5 && rate <= 0.3) rec.status = 'DEGRADED';
  else if (n >= 5 && rate < 0.5) rec.status = 'WARNING';
  else if (n >= 5 && rate >= 0.7 && (rec.status === 'WARNING' || rec.status === 'DEGRADED')) rec.status = 'ACTIVE';
  return rec;
}

// 记录一次任务结果（成功/失败），更新 Profile 评分与生命周期。
// opts: { name, region }
function recordTaskOutcome(profileId, site, ok, opts) {
  if (!profileId) return { skipped: true, reason: '无 profileId' };
  if (!site) return { skipped: true, reason: '无 site' };
  const rec = ensure(profileId, opts || {});
  if (opts && opts.name && rec.name === profileId) rec.name = opts.name;
  if (opts && opts.region && !rec.region) rec.region = opts.region;

  // 全局
  rec.stats.totalTasks = (rec.stats.totalTasks || 0) + 1;
  if (ok) rec.stats.success = (rec.stats.success || 0) + 1;
  else rec.stats.failed = (rec.stats.failed || 0) + 1;
  rec.recent = (rec.recent || []).slice(-(RECENT_WINDOW - 1));
  rec.recent.push(!!ok);

  // 站点专属
  const ss = rec.siteScores[site] || (rec.siteScores[site] = { score: 0, success: 0, failed: 0, samples: 0, recent: [], confidence: 0, updatedAt: 0 });
  ss.samples = (ss.samples || 0) + 1;
  if (ok) ss.success = (ss.success || 0) + 1;
  else ss.failed = (ss.failed || 0) + 1;
  ss.recent = (ss.recent || []).slice(-(RECENT_WINDOW - 1));
  ss.recent.push(!!ok);
  recomputeSiteScore(rec, site);

  // 维度重算（taskSuccess / stability 来自真实任务）
  rec.dimensions.taskSuccess = metrics.taskSuccessDimension(rec.stats);
  rec.dimensions.stability = metrics.stabilityDimension(rec.recent);
  // 其余维度（fingerprint/network/storage）如需刷新由 analyzer.analyzeLive 触发，这里保留既有值

  rec.score = scoring.overallScore(rec);
  rec.confidence = scoring.globalConfidence(rec.stats.totalTasks);
  updateLifecycle(rec);
  rec.updatedAt = Date.now();
  store.upsert(COLLECTION, rec);
  return { ok: true, profileId, site, record: rec };
}

// 注入维度初值（用于首次创建时带入 integrity/proxy 体检结果，或测试构造）
function applyDimensions(profileId, dims, opts) {
  const rec = ensure(profileId, opts || {});
  rec.dimensions = Object.assign({}, rec.dimensions, dims);
  rec.score = scoring.overallScore(rec);
  rec.updatedAt = Date.now();
  store.upsert(COLLECTION, rec);
  return rec;
}

// 人工设置生命周期（例如 DISABLED）
function setStatus(profileId, status) {
  if (!PROFILE_STATUS.includes(status)) return { ok: false, error: '非法状态' };
  const rec = ensure(profileId);
  rec.status = status;
  rec.updatedAt = Date.now();
  store.upsert(COLLECTION, rec);
  return { ok: true, record: rec };
}

// 站点-Profile 矩阵：rows=站点，cols=Profile，值=站点评分（无数据则 null）
function siteProfileMatrix(sites) {
  const recs = listRecords();
  const siteList = sites && sites.length ? sites : uniqueSites(recs);
  const cols = recs.map((r) => r.profileId);
  const matrix = {};
  for (const site of siteList) {
    matrix[site] = {};
    for (const r of recs) {
      const v = siteScoreValue(r, site);
      matrix[site][r.profileId] = v == null ? null : v;
    }
  }
  return { sites: siteList, profiles: cols, matrix };
}

function uniqueSites(recs) {
  const set = new Set();
  for (const r of recs) for (const s of Object.keys(r.siteScores || {})) set.add(s);
  return Array.from(set);
}

module.exports = {
  COLLECTION, RECENT_WINDOW, ensure, getRecord, listRecords, removeProfile,
  siteScoreValue, recordTaskOutcome, applyDimensions, setStatus,
  updateLifecycle, siteProfileMatrix, recomputeSiteScore, NEUTRAL_DIMS,
};
