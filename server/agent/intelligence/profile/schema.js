'use strict';

// Profile Intelligence Schema（Phase 3.4）。
// Profile 评分记录结构：profileId / name / score / dimensions / siteScores / stats / confidence / status / region / updatedAt。
// 评分维度 dimensions：fingerprint / network / storage / taskSuccess / stability（每项 0-100）。
// 生命周期 PROFILE_STATUS：ACTIVE / WARNING / DEGRADED / DISABLED（恶化只降级不删除，DISABLED 仅人工）。
//
// 与 Flow/Element/Failure 同理：禁止保存任何 selector / xpath / 坐标 / cookie 明文 / 凭据。
// Profile 评分只描述「环境健康」与「站点成功率」，不承载任何可执行的浏览器指令。

const PROFILE_STATUS = ['ACTIVE', 'WARNING', 'DEGRADED', 'DISABLED'];

// 评分权重（与 Phase 3.4 设计一致，总计 = 1.0）
const SCORE_WEIGHTS = {
  fingerprint: 0.25,
  network: 0.25,
  siteSuccess: 0.30,
  stability: 0.10,
  freshness: 0.10,
};

const DIMENSION_KEYS = ['fingerprint', 'network', 'storage', 'taskSuccess', 'stability'];

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function validate(record) {
  const errors = [];
  if (!record || typeof record !== 'object') return { ok: false, errors: ['必须是对象'] };
  if (!record.profileId) errors.push('profileId 缺失');

  const dims = record.dimensions;
  if (!dims || typeof dims !== 'object') errors.push('dimensions 缺失');
  else {
    for (const k of DIMENSION_KEYS) {
      if (!isNum(dims[k]) || dims[k] < 0 || dims[k] > 100) errors.push(`dimensions.${k} 必须是 0-100 的数值`);
    }
  }

  if (!isNum(record.score) || record.score < 0 || record.score > 100) errors.push('score 必须是 0-100');

  if (record.status && !PROFILE_STATUS.includes(record.status)) errors.push('status 非法: ' + record.status);

  const stats = record.stats;
  if (stats && typeof stats === 'object') {
    if (stats.totalTasks != null && !isNum(stats.totalTasks)) errors.push('stats.totalTasks 非法');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: record };
}

// siteScores 中单站点记录的合法结构校验（score 也可为数值简写，但内部统一存对象）
function validateSiteScore(ss) {
  if (isNum(ss)) return { ok: true };
  if (!ss || typeof ss !== 'object') return { ok: false, errors: ['siteScore 非法'] };
  if (!isNum(ss.score) || ss.score < 0 || ss.score > 100) return { ok: false, errors: ['siteScore.score 必须是 0-100'] };
  return { ok: true };
}

module.exports = { validate, validateSiteScore, PROFILE_STATUS, SCORE_WEIGHTS, DIMENSION_KEYS };
