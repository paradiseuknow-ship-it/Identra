'use strict';

// Scheduler（Phase 4.1/4.3 调度优先级）。
// 任务类别 → 队列优先级。值越大越优先（与既有 aiQueue 排序一致）。
// 规则（用户既定）：
//   HUMAN_RESUME > RECOVERY > NORMAL > BACKGROUND_LEARNING
// 4.1 仅暴露 priorityFor()，完整调度循环（多 Worker 抢占/公平）留待 4.3。

const CATEGORY_PRIORITY = {
  HUMAN_RESUME: 90,        // 人工恢复：最高优先（等待人工的任务恢复后立刻跑）
  RECOVERY: 80,            // 中断恢复：崩溃/重启后恢复的任务
  NORMAL: 50,              // 常规任务
  BACKGROUND_LEARNING: 10, // 后台学习/经验整理：最低优先
};

const CATEGORIES = Object.keys(CATEGORY_PRIORITY);

// 类别 → 优先级。未知类别回落 NORMAL。
function priorityFor(category) {
  return CATEGORY_PRIORITY[category] != null ? CATEGORY_PRIORITY[category] : CATEGORY_PRIORITY.NORMAL;
}

// 类别比较：a 是否比 b 更优先。
function isHigher(a, b) {
  return priorityFor(a) > priorityFor(b);
}

// 反查：给定 priority 返回对应类别（最高匹配；多类别同分时取最高优先级类别）。
// 主要用于 dispatchPolicy 在 queueItem 缺省 category 时推断，不改既有调度语义。
function categoryForPriority(priority) {
  let best = null, bestPri = -Infinity;
  for (const cat of CATEGORIES) {
    const p = CATEGORY_PRIORITY[cat];
    if (p === priority && p > bestPri) { best = cat; bestPri = p; }
  }
  return best;
}

module.exports = { CATEGORY_PRIORITY, CATEGORIES, priorityFor, isHigher, categoryForPriority };
