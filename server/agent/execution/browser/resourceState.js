'use strict';

// Browser Resource State（Phase 4.4）。
// Browser 是一个「可占用资源实体」，不是 Worker 的一部分。
// 生命周期独立于 Worker / Task：
//   CREATED    已登记（尚未启动）
//   STARTING   启动中（launch 进程/连接）
//   READY      Browser 健康、空闲、可绑定任务
//   BUSY       已被某任务占用（执行中）
//   IDLE       任务结束、临时回收前的空闲（区别于 READY：曾占用过，可复用）
//   DRAINING   优雅退出中：禁止新绑定，等待当前释放
//   CLOSED     已关闭（正常退出终态）
//   DEAD       心跳丢失 / 崩溃，被 Recovery 判定死亡
//
// 合法转移表：不在表中的转移一律拒绝，避免状态被随意污染。

const STATUS = {
  CREATED: 'CREATED',
  STARTING: 'STARTING',
  READY: 'READY',
  BUSY: 'BUSY',
  IDLE: 'IDLE',
  DRAINING: 'DRAINING',
  CLOSED: 'CLOSED',
  DEAD: 'DEAD',
};

// 合法转移边（有向）。
const TRANSITIONS = {
  CREATED: ['STARTING', 'BUSY', 'CLOSED', 'DEAD'], // 新建后可直接占用（跳过重启动）或先 STARTING
  STARTING: ['READY', 'DEAD', 'CLOSED'],   // 启动失败→DEAD/关闭
  READY: ['BUSY', 'DRAINING', 'CLOSED', 'DEAD'], // 空闲可占用；或退出/死亡
  BUSY: ['IDLE', 'DRAINING', 'DEAD', 'CLOSED'],  // 占用结束→IDLE；或崩溃
  IDLE: ['BUSY', 'DRAINING', 'CLOSED', 'DEAD', 'READY'], // 复用或退出
  DRAINING: ['CLOSED', 'DEAD'],             // 仅允许结束或死亡；不再接新任务
  CLOSED: ['CREATED'],                      // 重启（重建）
  DEAD: ['CREATED', 'STARTING'],            // 复活（重建 Browser）
};

function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.indexOf(to) >= 0;
}

// 终态（不再迁移，除非重建）。
function isTerminal(status) {
  return status === STATUS.CLOSED;
}

// 是否健康（可被（重新）绑定任务）：READY / IDLE。
function isHealthy(status) {
  return status === STATUS.READY || status === STATUS.IDLE;
}

// 是否被占用（BUSY / DRAINING 视为不可新接任务；DRAINING 是退出中）。
function isOccupied(status) {
  return status === STATUS.BUSY;
}

// 是否死亡（需重建）。
function isDead(status) {
  return status === STATUS.DEAD;
}

module.exports = { STATUS, TRANSITIONS, canTransition, isTerminal, isHealthy, isOccupied, isDead };
