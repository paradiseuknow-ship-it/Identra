'use strict';

// Scheduler State（Phase 4.3）。
// Scheduler 自身是一个「可管理实体」：有明确生命周期，禁止非法跳变。
// 未来多实例 Scheduler（Leader Election / 分布式锁）时，需要靠状态机判断：
//   - 当前 Scheduler 是否已接管（RUNNING）；
//   - 是否正在退出（DRAINING）；
//   - 是否允许接收新 dispatch（PAUSED/DRAINING 拒绝）。
//
// 合法状态：
//   STOPPED   已停止（初始态/退出终态）
//   STARTING  启动中（资源/Worker 准备，尚未接任务）
//   RUNNING   运行中：正常派发
//   PAUSED    暂停：已有 RUNNING 继续，新 dispatch 拒绝
//   DRAINING  优雅退出：允许在跑任务完成，不再派新
//
// 禁止的转移（用户既定）：
//   RUNNING -> STARTING  （运行中不能回到启动中）
//   STOPPED -> RUNNING   （停止态必须 STARTING 过渡，不能直接 RUNNING）

const STATUS = {
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  DRAINING: 'DRAINING',
};

// 合法转移边（有向）。不在表中的转移一律拒绝。
const TRANSITIONS = {
  STOPPED: ['STARTING'],                 // 启动必须经由 STARTING
  STARTING: ['RUNNING', 'STOPPED'],      // 准备就绪→RUNNING；失败→STOPPED
  RUNNING: ['PAUSED', 'DRAINING', 'STOPPED'], // 运行可暂停/优雅退出/硬停
  PAUSED: ['RUNNING', 'DRAINING', 'STOPPED'], // 恢复→RUNNING；或退出
  DRAINING: ['STOPPED'],                 // 仅允许结束；不再接新任务、不再回 RUNNING
};

function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.indexOf(to) >= 0;
}

// 终态（不再迁移，除非重新 STARTING）。
function isTerminal(status) {
  return status === STATUS.STOPPED;
}

// 是否允许新 dispatch：仅 RUNNING 接受；PAUSED/DRAINING/STARTING/STOPPED 均拒绝。
function isAcceptingDispatch(status) {
  return status === STATUS.RUNNING;
}

// 是否在跑任务（PAUSED/DRAINING 下已有 RUNNING 继续）。
function isActive(status) {
  return status === STATUS.RUNNING || status === STATUS.PAUSED || status === STATUS.DRAINING;
}

module.exports = { STATUS, TRANSITIONS, canTransition, isTerminal, isAcceptingDispatch, isActive };
