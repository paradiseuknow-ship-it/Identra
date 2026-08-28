'use strict';

// Dispatch Policy（Phase 4.3）。
// 在既有类别优先级之上，计算「综合派发分」，解决 starvation 与抢占公平问题。
//
// 基础优先级（用户既定）：
//   HUMAN_RESUME 90 > RECOVERY 80 > NORMAL 50 > BACKGROUND_LEARNING 10
//
// 综合分：
//   score = priority
//         + waitingTimeBoost   （等待越久越优先，线性小增益）
//         + retryBoost         （重试任务适度加权，避免被新任务永远压制）
//         + humanBoost         （人工相关额外加成，强保证 HUMAN_RESUME 优先）
//         - blockedPenalty     （被阻塞/依赖未满足的惩罚）
//         + agingFactor        （老化因子：等待超过阈值后指数抬升，防 starvation）
//
// 设计原则：
//  - 不修改 Task 业务状态；本模块仅「读」queueItem 字段（priority/category/createdAt/retryCount/blocked）
//    与「上下文时钟 now」，纯函数打分。
//  - 默认参数可控，便于测试（Case4 Aging 用 now 偏移模拟等待 1h/2h）。

const scheduler = require('./scheduler');

// 评分系数（可调，单点便于回归）。
const DEFAULTS = {
  waitingTimeBoostPerMin: 0.5,  // 每等待 1 分钟 +0.5 分（线性，温和）
  retryBoostPerRetry: 3,       // 每次重试 +3 分（封顶 retryBoostCap）
  retryBoostCap: 15,           // 重试加权上限，避免无限堆叠
  humanBoost: 5,               // HUMAN_RESUME 额外 +5（强保证压过 RECOVERY）
  blockedPenalty: 40,          // 被阻塞任务扣分（排在可跑任务之后）
  agingThresholdMin: 20,       // 等待超过 20 分钟进入老化区
  agingFactorPerMin: 1.2,      // 老化区内每超出 1 分钟额外 +1.2 分（指数趋势，线性近似）
  agingFactorCap: 200,         // 老化加成上限，避免分数爆炸
};

// queueItem: { taskId, priority?, category?, createdAt, retryCount?, blocked? }
// ctx: { now }  （now 可注入，便于测试模拟等待时长）
// 返回 { score, parts }。
function scoreFor(queueItem, ctx) {
  ctx = ctx || {};
  const now = ctx.now != null ? ctx.now : Date.now();
  const cfg = Object.assign({}, DEFAULTS, ctx.config || {});

  const priority = queueItem.priority != null
    ? queueItem.priority
    : scheduler.priorityFor(queueItem.category || 'NORMAL');
  const category = queueItem.category
    || scheduler.categoryForPriority(priority)
    || 'NORMAL';

  const createdAt = queueItem.createdAt != null ? queueItem.createdAt : now;
  const waitedMin = Math.max(0, (now - createdAt) / 60000);

  // 线性等待增益
  const waitingTimeBoost = waitedMin * cfg.waitingTimeBoostPerMin;

  // 重试增益（封顶）
  const retryCount = queueItem.retryCount || 0;
  const retryBoost = Math.min(retryCount * cfg.retryBoostPerRetry, cfg.retryBoostCap);

  // 人工加成
  const humanBoost = category === 'HUMAN_RESUME' ? cfg.humanBoost : 0;

  // 阻塞惩罚
  const blockedPenalty = queueItem.blocked ? cfg.blockedPenalty : 0;

  // 老化因子：超过阈值后额外抬升，防长等任务 starvation
  let agingFactor = 0;
  if (waitedMin > cfg.agingThresholdMin) {
    const over = waitedMin - cfg.agingThresholdMin;
    agingFactor = Math.min(over * cfg.agingFactorPerMin, cfg.agingFactorCap);
  }

  const score = priority
    + waitingTimeBoost
    + retryBoost
    + humanBoost
    - blockedPenalty
    + agingFactor;

  return {
    score: Math.round(score * 100) / 100,
    parts: {
      priority, waitingTimeBoost: round(waitingTimeBoost), retryBoost,
      humanBoost, blockedPenalty, agingFactor: round(agingFactor), waitedMin: round(waitedMin),
    },
  };
}

function round(n) { return Math.round(n * 100) / 100; }

// 对一批 queueItem 排序（降序），返回带 score 的新数组（不修改入参）。
function rank(items, ctx) {
  return items
    .map((it) => Object.assign({ _score: scoreFor(it, ctx) }, it))
    .sort((a, b) => b._score.score - a._score.score);
}

module.exports = { DEFAULTS, scoreFor, rank };
