'use strict';

// 单一权威「业务成功」口径（B3 / Phase 12B 收尾修复）。
//
// 设计原则（来自用户验收规则）：
//   - 业务成功 ONLY 来源于 task 终态 status === 'SUCCESS'（由 taskManager.complete() 单一写入）。
//   - harness / store / report / analyze 必须从同一来源派生，禁止各自发明口径。
//   - 若不同口径出现冲突，默认按「更严格的真实业务终态」处理，绝不取高值。
//   - 提供一致性断言：harness 派生 success 必须等于 store 派生 success，否则视为度量缺陷。

const TERMINAL = ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'];

// 一个 task 是否业务成功：唯一判定 = 终态 SUCCESS。
function isBusinessSuccess(task) {
  return !!(task && task.status === 'SUCCESS');
}

// 从 task 列表派生业务成功计数（authoritative）。
function businessSuccess(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const total = list.length;
  const success = list.filter(isBusinessSuccess).length;
  return { success, total, rate: total ? success / total : 0 };
}

// 升级分类（仅用于统计，不重复发明成功口径）。
function isEscalation(task) {
  return !!(task && task.status === 'HUMAN_ESCALATION');
}
function escalationKindOf(task) {
  if (!isEscalation(task)) return null;
  return task.escalationKind || 'REAL';
}

// 一致性断言：harness 派生的任务集 与 store 派生的任务集，必须指向同一批 SUCCESS。
// 入参：
//   harnessTasks  —— benchmark 输出 perTask（来自 taskManager.getTask 即时终态）
//   storeTasks   —— 运行后原始 aiTasks（持久化终态）
// 返回 { consistent, harnessSuccess, storeSuccess, mismatch[] }
//   mismatch 列出 status 不一致的 taskId（若存在），便于精准定位度量偏差。
function consistencyCheck(harnessTasks, storeTasks) {
  const hList = Array.isArray(harnessTasks) ? harnessTasks : [];
  const sList = Array.isArray(storeTasks) ? storeTasks : [];
  const sById = new Map();
  sList.forEach((t) => sById.set(t.id, t));
  let harnessSuccess = 0, storeSuccess = 0;
  const mismatch = [];
  const hIds = new Set();
  for (const t of hList) {
    hIds.add(t.id);
    if (isBusinessSuccess(t)) harnessSuccess++;
    const s = sById.get(t.id);
    if (s && isBusinessSuccess(s) && !isBusinessSuccess(t)) mismatch.push({ id: t.id, harness: t.status, store: s.status });
    if (s && !isBusinessSuccess(s) && isBusinessSuccess(t)) mismatch.push({ id: t.id, harness: t.status, store: s.status });
  }
  // store 中多出/缺失的任务也计入 storeSuccess（用于交叉校验）
  for (const t of sList) if (isBusinessSuccess(t)) storeSuccess++;
  // 当集合不完全一致时，要求 harness 与 store 的 SUCCESS 计数相等是最低一致性契约。
  const consistent = (harnessSuccess === storeSuccess) && (mismatch.length === 0);
  return { consistent, harnessSuccess, storeSuccess, mismatch };
}

module.exports = {
  TERMINAL,
  isBusinessSuccess,
  businessSuccess,
  isEscalation,
  escalationKindOf,
  consistencyCheck,
};
