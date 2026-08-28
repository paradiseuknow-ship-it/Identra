'use strict';

// Worker 状态机（Phase 4.2）。
// Worker 是一个「可管理实体」，不是函数包装。状态明确区分：
//   STARTING   启动中（资源/连接准备）
//   READY      可接任务
//   ASSIGNED   已分配任务，但 Runtime 尚未真正启动（Scheduler 已认领，Worker 已占位）
//   RUNNING    真正执行（navigate/observe/click/repair/verify 异步进行中）
//   PAUSED     暂停（人工介入 / 等待外部信号）
//   DRAINING   优雅退出中：禁止新任务，等待当前任务结束
//   STOPPED    已停止
//   DEAD       心跳丢失，被 Recovery 判定死亡
//
// 合法转移表：从「当前状态」能去哪些「目标状态」。
// 不在表中的转移一律拒绝（返回 false），避免状态被随意污染。

const STATUS = {
  STARTING: 'STARTING',
  READY: 'READY',
  ASSIGNED: 'ASSIGNED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  DRAINING: 'DRAINING',
  STOPPED: 'STOPPED',
  DEAD: 'DEAD',
};

// 合法转移边（有向）。
const TRANSITIONS = {
  STARTING: ['READY', 'DEAD', 'STOPPED'],
  READY: ['ASSIGNED', 'DRAINING', 'STOPPED', 'DEAD'],
  ASSIGNED: ['RUNNING', 'READY', 'PAUSED', 'DRAINING', 'STOPPED', 'DEAD'], // 分配可被取消回 READY
  RUNNING: ['PAUSED', 'DRAINING', 'STOPPED', 'DEAD', 'READY'], // 任务自然完成后释放回 READY（找出空闲 Worker 接续派发）
  PAUSED: ['RUNNING', 'DRAINING', 'STOPPED', 'DEAD'],
  DRAINING: ['STOPPED', 'DEAD'], // 仅允许结束或死亡；不再接新任务
  STOPPED: ['STARTING'], // 重启
  DEAD: ['STARTING'], // 复活（重建）
};

// 是否允许从 from → to。
function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.indexOf(to) >= 0;
}

// 终态（不再迁移）。
function isTerminal(status) {
  return status === STATUS.STOPPED || status === STATUS.DEAD;
}

// 是否可接收新任务分配。
// READY：空闲可派；ASSIGNED：已占一个坑，不可再派（防重复绑定）；其余均不可。
function isAssignable(status) {
  return status === STATUS.READY;
}

// 是否处于优雅退出（拒绝新任务）。
function isDraining(status) {
  return status === STATUS.DRAINING;
}

module.exports = { STATUS, TRANSITIONS, canTransition, isTerminal, isAssignable, isDraining };
