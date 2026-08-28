'use strict';
// =============================================================================
// executionFailureTaxonomy.js — Phase 4 C1：Execution Failure Taxonomy（只读）
//
// 设计原则（对齐冻结边界）：
//   - 纯函数分类器，不读写 store、不启动浏览器、不调用 LLM、不修改任务结果/状态。
//   - 仅消费「既有 runtime 数据」中抽取出的信号包（signals），把 FAILED / CANCELLED
//     任务从粗分类（VERIFY_FAILED / DOM_CHANGED）拆解为细粒度执行层失败类别。
//   - 不改动 Business Success 定义 / benchmark 口径 / decision 语义 / success definition。
//
// 覆盖类别（至少）：
//   AUTH_FAILURE | CAPTCHA_OR_HUMAN_CHECK | ELEMENT_NOT_FOUND | TIMEOUT |
//   NETWORK_FAILURE | PERMISSION_DENIED | PLANNER_FAILURE | TOOL_FAILURE |
//   UNKNOWN_EXECUTION_FAILURE
//
// 输入 signals（均由调用方从 store 既有字段抽取，本模块不自行读取 store）：
//   {
//     taskStatus: string,                 // 'FAILED' | 'CANCELLED'
//     code: string,                       // 主 attempt error.code（如 VERIFY_FAILED）
//     message: string,                    // 主 attempt error.message（含验证需求文本）
//     failureType: string,                // VIL failureType（DOM_CHANGED/STATE_UNKNOWN/...）
//     events: [{ type, payload }],        // aiEvents（diagnosing/verification/needApproval/cancelled/failed...）
//     snapshots: [{ visibleTexts, errorType }],  // aiFailureSnapshots 可见文本
//     repairs: [{ status, error, strategy }],     // aiRepairAttempts
//     actions: [{ type, target }],        // attempt.action（被执行的动作）
//   }
// =============================================================================

const EXECUTION_FAILURE_CATEGORIES = [
  'AUTH_FAILURE',
  'CAPTCHA_OR_HUMAN_CHECK',
  'ELEMENT_NOT_FOUND',
  'TIMEOUT',
  'NETWORK_FAILURE',
  'PERMISSION_DENIED',
  'PLANNER_FAILURE',
  'TOOL_FAILURE',
  'UNKNOWN_EXECUTION_FAILURE',
];

// 信号分层：
//   - strongHay：权威执行信号（error.code / error.message 验证需求文本 / VIL failureType /
//     agent.diagnosing 类别 / repair 错误信息）。这些是「真实执行失败」的强证据，优先级高、误报低。
//   - weakHay：页面可见文本（snapshot.visibleTexts）。仅用于高精度的 CAPTCHA 识别，
//     不用于 AUTH/PERMISSION 等易因后台 UI 文案（如「权限管理」「登录」链接）误判的类别。
function buildHay(signals) {
  const s = signals || {};
  const diagCats = (s.events || [])
    .filter((e) => e && e.type === 'agent.diagnosing' && e.payload && e.payload.category)
    .map((e) => e.payload.category)
    .join(' ');
  const repairText = (s.repairs || []).map((r) => JSON.stringify(r && r.error || '') + ' ' + (r && r.strategy || '')).join(' ');
  const actionText = (s.actions || []).map((a) => JSON.stringify(a || '')).join(' ');
  const strong = [
    String(s.code || ''),
    String(s.message || ''),
    String(s.failureType || ''),
    diagCats,
    repairText,
    actionText,
  ].join(' || ').toLowerCase();
  const weak = (s.snapshots || []).map((sn) => {
    const vt = Array.isArray(sn && sn.visibleTexts) ? sn.visibleTexts.join(' ') : (sn && sn.visibleTexts || '');
    return vt + ' ' + (sn && sn.errorType || '');
  }).join(' ').toLowerCase();
  return { strong, weak };
}

// terminalCause（终态成因）：仅 CANCELLED 需要解释「为何被取消」，FAILED 为 null。
// 不重新定义 CANCELLED 语义，仅基于既有事件/时长做只读归因。
function deriveTerminalCause(signals) {
  const s = signals || {};
  if (s.taskStatus !== 'CANCELLED') return null;
  // 直接检查既有 runtime 信号（不依赖 buildHay 的精简信号集）：
  //   - events 中是否出现 task.cancelled（runner 在 PER_TASK_TIMEOUT 后发出）
  //   - 任务级 error 是否为 "用户取消"（taskManager.cancel 写入）
  const events = s.events || [];
  const hasCancelEv = events.some((e) => e && e.type === 'task.cancelled');
  const taskErr = String(s.taskError || '');
  const attemptMsg = String(s.message || '');
  if (hasCancelEv || /用户取消/.test(taskErr) || /per_task_timeout|exceeded.*timeout|timed? out/i.test(taskErr + ' ' + attemptMsg)) {
    return 'PER_TASK_TIMEOUT_CANCEL'; // 执行循环超过单任务墙钟预算，被 runner 取消
  }
  return 'CANCELLED_OTHER';
}

function classifyExecutionFailure(signals) {
  const s = signals || {};
  const { strong, weak } = buildHay(s);
  const diagCats = (s.events || [])
    .filter((e) => e && e.type === 'agent.diagnosing' && e.payload && e.payload.category)
    .map((e) => String(e.payload.category).toUpperCase());
  const evidence = [];

  const has = (re) => re.test(strong) || re.test(weak);

  // 顺序：超时/网络/元素缺失/规划/工具（权威执行信号）→ 再处理易误判的权限/鉴权（仅限强信号）→ 验证码（弱信号高精度）→ 兜底。

  // 1) TIMEOUT：动作超时 / 墙钟超时 / 执行循环超预算
  if (/\btimeout\b|timed? out|超时|exceeded.*time|per_task_timeout|wall.?clock/.test(strong)) {
    evidence.push('检测到超时信号（code/message/diagnosing）');
    return { category: 'TIMEOUT', terminalCause: deriveTerminalCause(s), confidence: 0.85, evidence };
  }
  // 2) NETWORK_FAILURE：网络层错误
  if (/net::err|econnrefused|enotfound|econnreset|\bdns\b|connection (refused|reset|aborted|failed)|network error|502|503|504|bad gateway|gateway timeout|网络错误|无法连接|连接失败/.test(strong)) {
    evidence.push('检测到网络层错误信号');
    return { category: 'NETWORK_FAILURE', terminalCause: deriveTerminalCause(s), confidence: 0.85, evidence };
  }
  // 3) ELEMENT_NOT_FOUND：元素缺失（真实执行层根因，动态 DOM 场景常见）
  if (/element_not_found|未找到元素|no element|locator.*not|missing element|unable to find|找不到.*元素|元素未找到|element_present.*(未找到|not found)/.test(strong) || diagCats.includes('ELEMENT_NOT_FOUND')) {
    evidence.push('检测到元素未找到信号（执行层根因）');
    return { category: 'ELEMENT_NOT_FOUND', terminalCause: deriveTerminalCause(s), confidence: 0.85, evidence };
  }
  // 4) PLANNER_FAILURE：规划/重规划真正失败（注意：agent.replan 仅为恢复动作，不算规划失败）
  if (/planner.*(fail|error)|planning failed|规划失败|model capability|provider.*error|llm call failed|plan generation failed|无法生成计划|规划器.*错误|plan.*exception/.test(strong)) {
    evidence.push('检测到规划/重规划失败信号');
    return { category: 'PLANNER_FAILURE', terminalCause: deriveTerminalCause(s), confidence: 0.8, evidence };
  }
  // 5) TOOL_FAILURE：工具/动作执行失败（非元素缺失、非超时）
  if (/tool (execution|failed|error)|element_not_interactable|not interactable|obscured|covered by|not visible|outside of viewport|action failed|工具执行失败|动作执行失败|interactable|不可交互/.test(strong) || diagCats.includes('ELEMENT_NOT_INTERACTABLE')) {
    evidence.push('检测到工具/动作执行失败信号');
    return { category: 'TOOL_FAILURE', terminalCause: deriveTerminalCause(s), confidence: 0.78, evidence };
  }
  // 6) PERMISSION_DENIED：403 / 明确禁止（仅限强信号，避免后台 UI「权限」文案误判）
  if (/\b403\b|forbidden|access denied|permission denied|禁止访问|无权访问|权限不足（拒绝）|拒绝访问/.test(strong)) {
    evidence.push('检测到权限/403 信号（强信号）');
    return { category: 'PERMISSION_DENIED', terminalCause: deriveTerminalCause(s), confidence: 0.85, evidence };
  }
  // 7) AUTH_FAILURE：登录墙 / 会话失效 / 401 / 密码错误（强信号，避免泛「登录」链接误判）
  if (/\b401\b|unauthorized|session.?expired|登录失效|登录过期|密码错误|sign.?in required|auth(?:entication)? failed|鉴权失败|需要登录|请先登录|请登录后|not.?logged.?in/.test(strong)) {
    evidence.push('检测到登录/鉴权障碍信号');
    return { category: 'AUTH_FAILURE', terminalCause: deriveTerminalCause(s), confidence: 0.82, evidence };
  }
  // 8) CAPTCHA_OR_HUMAN_CHECK：验证码 / 人机校验（弱信号但高精度）
  if (/验证码|captcha|人机验证|滑块验证|安全验证|are you a human|行为验证|拖动验证/.test(weak) || diagCats.includes('CAPTCHA')) {
    evidence.push('检测到验证码/人机校验信号');
    return { category: 'CAPTCHA_OR_HUMAN_CHECK', terminalCause: deriveTerminalCause(s), confidence: 0.9, evidence };
  }
  // 9) UNKNOWN_EXECUTION_FAILURE：兜底（VIL DOM_CHANGED/STATE_UNKNOWN 但无更深执行信号）
  evidence.push('未匹配到具体执行层信号；粗分类=' + (s.failureType || s.code || 'UNKNOWN'));
  return { category: 'UNKNOWN_EXECUTION_FAILURE', terminalCause: deriveTerminalCause(s), confidence: 0.5, evidence };
}

module.exports = {
  EXECUTION_FAILURE_CATEGORIES,
  classifyExecutionFailure,
  deriveTerminalCause,
  buildHay,
};
