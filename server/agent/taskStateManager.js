'use strict';

// Task / Step 状态机（唯一实现点）。
// 禁止在项目其它地方直接修改状态字符串；一律经此处校验后转换。

const TASK_STATES = [
  'PENDING', 'PLANNING', 'PREPARING', 'PROFILE_READY', 'BROWSER_READY',
  'RUNNING', 'VERIFYING', 'HEALING', 'PAUSED_FOR_HUMAN',
  'RECOVERING', 'SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION',
];

// 终态集合：进入后不可再转（混沌防护，杜绝 RUNNING 永久悬挂）。
// Phase 5.8：显式列出，供终态判定与幽灵锁检测复用。
const TASK_TERMINAL = ['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'];

const STEP_STATES = ['PENDING', 'RUNNING', 'VERIFYING', 'FAILED', 'HEALING', 'SUCCESS', 'SKIPPED'];

const TASK_TRANSITIONS = {
  PENDING: ['PLANNING', 'PREPARING', 'CANCELLED'],
  PLANNING: ['PREPARING', 'FAILED', 'CANCELLED'],
  PREPARING: ['PROFILE_READY', 'BROWSER_READY', 'RUNNING', 'FAILED', 'CANCELLED', 'PAUSED_FOR_HUMAN'],
  PROFILE_READY: ['BROWSER_READY', 'RUNNING', 'FAILED', 'CANCELLED', 'PAUSED_FOR_HUMAN'],
  BROWSER_READY: ['RUNNING', 'FAILED', 'CANCELLED', 'PAUSED_FOR_HUMAN'],
  RUNNING: ['VERIFYING', 'HEALING', 'PAUSED_FOR_HUMAN', 'RECOVERING', 'SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'],
  VERIFYING: ['RUNNING', 'HEALING', 'PAUSED_FOR_HUMAN', 'SUCCESS', 'FAILED'],
  HEALING: ['RUNNING', 'VERIFYING', 'RECOVERING', 'PAUSED_FOR_HUMAN', 'FAILED'],
  PAUSED_FOR_HUMAN: ['RUNNING', 'RECOVERING', 'SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'],
  RECOVERING: ['RUNNING', 'PREPARING', 'FAILED', 'CANCELLED', 'PAUSED_FOR_HUMAN'],
  SUCCESS: [],
  FAILED: ['PREPARING', 'PLANNING'],   // 允许重试/重新规划
  CANCELLED: [],
};

const STEP_TRANSITIONS = {
  PENDING: ['RUNNING', 'SKIPPED'],
  RUNNING: ['VERIFYING', 'FAILED', 'HEALING', 'SUCCESS', 'SKIPPED'],
  VERIFYING: ['SUCCESS', 'FAILED', 'HEALING'],
  FAILED: ['HEALING', 'RUNNING', 'SUCCESS', 'SKIPPED'],
  HEALING: ['RUNNING', 'VERIFYING', 'FAILED', 'SUCCESS'],
  SUCCESS: [],
  SKIPPED: [],
};

function isTaskState(s) { return TASK_STATES.includes(s); }
function isStepState(s) { return STEP_STATES.includes(s); }
function isTaskTerminal(s) { return TASK_TERMINAL.includes(s); }

// 校验并返回新状态；非法转换抛错（由调用方捕获并记录）
function transitionTask(current, next) {
  if (!isTaskState(current)) throw new Error('非法 Task 状态: ' + current);
  if (!isTaskState(next)) throw new Error('非法目标 Task 状态: ' + next);
  if (next === current) return next;
  const allowed = TASK_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new Error(`非法 Task 状态转换: ${current} -> ${next}`);
  }
  return next;
}

function transitionStep(current, next) {
  if (!isStepState(current)) throw new Error('非法 Step 状态: ' + current);
  if (!isStepState(next)) throw new Error('非法目标 Step 状态: ' + next);
  if (next === current) return next;
  const allowed = STEP_TRANSITIONS[current] || [];
  if (!allowed.includes(next)) {
    throw new Error(`非法 Step 状态转换: ${current} -> ${next}`);
  }
  return next;
}

module.exports = {
  TASK_STATES, STEP_STATES, TASK_TRANSITIONS, STEP_TRANSITIONS, TASK_TERMINAL,
  isTaskState, isStepState, isTaskTerminal, transitionTask, transitionStep,
};
