'use strict';

// resourceMetrics（Phase 4.6）：Browser/Profile 资源利用与争用指标。
// 数据源：aiBrowserResources（status/profileId/owner）、aiProfileBindings（status/ownerTaskId/active）。
// 关注：Browser utilization、Profile contention、RESOURCE_BUSY 次数、ghost lock。

const store = require('../store');
const { STATUS: RES } = require('../execution/browser/resourceState');

function compute() {
  const resources = store.read('aiBrowserResources', []);
  const bindings = store.read('aiProfileBindings', []);

  const totalRes = resources.length;
  const busyRes = resources.filter((r) => r.status === RES.BUSY).length;
  const readyRes = resources.filter((r) => r.status === RES.READY || r.status === RES.IDLE).length;
  const deadRes = resources.filter((r) => r.status === RES.DEAD || r.status === RES.CLOSED).length;

  // Profile contention：同一 profile 历史上有过 >1 次绑定尝试（被拒次数），或当前绑定存在但 owner 不符
  const activeBindings = bindings.filter((b) => b.status === 'ACTIVE' || b.active);
  // ghost lock：ACTIVE 绑定但其 task 已终态（COMPLETED/FAILED/CANCELLED）却未释放
  const tasks = store.read('aiTasks', []);
  const terminalTaskIds = new Set(tasks.filter((t) =>
    ['COMPLETED', 'SUCCESS', 'FAILED', 'CANCELLED'].indexOf(t.status) >= 0).map((t) => t.id));
  const ghostLocks = activeBindings.filter((b) => b.ownerTaskId && terminalTaskIds.has(b.ownerTaskId)).length;

  // contention：按 profile 统计活跃绑定数（>1 即争用）
  const byProfile = {};
  for (const b of activeBindings) {
    if (!b.profileId) continue;
    byProfile[b.profileId] = (byProfile[b.profileId] || 0) + 1;
  }
  const contentionProfiles = Object.keys(byProfile).filter((p) => byProfile[p] > 1).length;

  // RESOURCE_BUSY 次数：从 aiEvents 统计 dispatch.rejected（资源占用导致拒派）
  const evts = store.read('aiEvents', []);
  const resourceBusy = evts.filter((e) => e.type === 'dispatch.rejected' && /RESOURCE_BUSY|BUSY/.test(JSON.stringify(e.payload || {}))).length;

  return {
    browsers: { total: totalRes, busy: busyRes, idle: readyRes, dead: deadRes },
    browserUtilization: totalRes ? +(busyRes / totalRes).toFixed(4) : null,
    profileBindings: { active: activeBindings.length, total: bindings.length },
    contentionProfiles,
    ghostLocks,
    resourceBusyEvents: resourceBusy,
    isHealthy: ghostLocks === 0,
  };
}

module.exports = { compute };
