'use strict';

// C141：任务状态等待原语 —— 单一实现（唯一事实源）。
//
// 背景（C141 §A 全仓横扫，600 个 .js）：`waitStatus` 在 4 个套件里各有一份**逐字同形**的复制
// （testAgentPhase5 / 22 / 23 / 31，均为 `taskManager.getTask` + 600ms 轮询），
// 而 C140 为修**一个**语义缺陷（终态词表漏 HUMAN_ESCALATION ⇒ 任务已终态仍空转满观测窗；
// 或混入非终态 PAUSED_FOR_HUMAN ⇒ 提前返回后读到 TOCTOU 竞态快照）必须**逐文件手工改 4 遍**。
// 这正是「同一证据多消费方 ⇒ 口径必须唯一」的代价：逻辑复制 N 份，语义修复代价就是 N 倍，
// 且任何一份漏改都是**静默**分叉。
//
// 本模块是该族等待逻辑的唯一事实源。消费方**只能委托**，不得再复制循环体。
//
// 命名：本文件刻意**不加** `_` 前缀 —— `.gitignore` 的 `_*.js` 是「一次性脚本」通配，
// 会给新 clone 造成 MODULE_NOT_FOUND（`_testSite.js` 已因此踩坑，靠 `!server/scripts/_testSite.js`
// 例外行补救）。常驻共享依赖不应依赖例外行存活。
//
// 语义（与收口前逐字等价，只是把循环体集中到一处）：
//   - 命中 targets 中任一状态 ⇒ 立即返回**该时刻**的任务对象；
//   - 超时 ⇒ 返回 `taskManager.getTask(taskId)`（可能为 null；调用方负责判空）。
//     收口前后一致：此处**不新增抛错、不新增重试、不做状态判定**。
//   - 轮询间隔 600ms（= 4 个套件收口前的原值）。
//
// 有意不纳入（登记边界，见 .benchmark/C141_REPORT.md）：
//   - `testAgentPhase2/3` 的 `waitForStatus`（500ms 轮询）与 `testAgentPhase4` 的 `waitStatus`
//     （走 HTTP `/tasks/:id`，需自起 7788 后端）—— 三者均处登记排除面，改动无法经执行器验证。

const taskManager = require('../agent/taskManager');

// 轮询间隔（不导出：无消费者的导出即死导出，见 C137 对 successMetrics.TERMINAL 的处置）。
const POLL_MS = 600;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitTaskStatus(taskId, targets, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = taskManager.getTask(taskId);
    if (t && targets.includes(t.status)) return t;
    await sleep(POLL_MS);
  }
  return taskManager.getTask(taskId);
}

module.exports = { waitTaskStatus };
