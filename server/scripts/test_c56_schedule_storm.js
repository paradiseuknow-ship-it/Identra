'use strict';

// C56 — scheduleTrigger 重复触发风暴修复（browserless，纯模块 + 真实 store，tmp 隔离）。
//
// 缺陷背景（C52 教训记录的 scheduleTrigger 边界，本批实锤修复）：
//   旧实现在 fireSchedule 【之后】才推进 nextRunAt（cronNext 抛错 / intervalMs||0 / 记录型 upsert 抛错），
//   抛错 → nextRunAt 不推进不落盘 → 下一 tick（1s）重新到期 → 每秒重复触发风暴。
//   实锤路径：cronNext 视界 366 天 —— 闰日类 cron（'0 0 31 2 *'，2 月 31 日永不存在）必抛
//   'cron 无匹配时刻'；触发当日之后所有 tick 永远抛错 → 无限风暴。
//
// 修复（scheduleTrigger.js C56）：
//   1) _advanceNextRun 纯计算绝不抛：cron 失败 → 退避 CRON_FAILURE_BACKOFF_MS(60s)；interval 非法 → MIN 下限
//   2) tick / triggerOnce：先推进+落盘，再触发（即使触发或记录落盘抛错，周期已推进，绝不重复）
//   3) updateSchedule：先落 intervalMs 下限再计算 nextRunAt（旧顺序 ||0 先算 = 立即既往到期）
//
// 覆盖：
//   A) cron 风暴修复（最强实证：三次 tick runCount 恒 1）+ 合法 cron 严格按表不漂移
//   B) interval 非法下限（旧 ||0 → +0 每秒到期）
//   C) triggerOnce：正常语义回归 + 损坏 cron 不抛错 + PAUSED 400
//   D) updateSchedule：intervalMs 变更语义回归 + cron→interval 切换
//   E) 代码锚点守护（_advanceNextRun 三消费点 + 退避常量导出）
// 用法：node server/scripts/test_c56_schedule_storm.js

// 数据目录隔离：必须在 require 之前设置（store/identity 均在 require 时解析数据目录）
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c56-storm-'));
process.env.FPB_DATA_DIR = TMP1;

const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const scheduleTrigger = require('../agent/scheduleTrigger');
const { cronNext } = require('../agent/cronExpr');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }
function expectThrow(fn, needle, name) {
  try { fn(); fail++; console.log('  ✘ FAIL: ' + name + ' — 未抛异常'); }
  catch (e) {
    const msg = String(e.message || e) + ' [status=' + (e.status || '') + ']';
    if (!needle || msg.includes(needle)) { pass++; console.log('  ✔ ' + name); }
    else { fail++; console.log('  ✘ FAIL: ' + name + ' — 异常不匹配: ' + msg.slice(0, 120)); }
  }
}
// 读最新记录 → 篡改 → 落盘（模拟损坏/历史遗留数据，绕过校验层的唯一现实入口）
function corrupt(id, patch) {
  const rec = scheduleTrigger.getSchedule(id);
  Object.assign(rec, patch);
  store.upsert('aiSchedules', rec);
  return rec;
}

const schedIds = [], taskIds = [];
function trackSched(id) { schedIds.push(id); return id; }
function trackTasks(r) { for (const t of (r.taskIds || [])) taskIds.push(t); return r; }

// ============================================================================
section('A: cron 风暴修复（fireSchedule 后 cronNext 抛错 → 旧代码每 tick 重复触发）');

// A0 前置：'0 0 31 2 *'（2 月 31 日永不存在）在任何时刻都必然抛错 —— 风暴路径确定性复现
expectThrow(() => cronNext('0 0 31 2 *', new Date()), '无匹配', 'A0 闰日类 cron cronNext 必抛（风暴触发面）');

// A1 风暴修复最强实证：损坏 cron + 到期 → 连续三次 tick，runCount 恒 1
const s1 = trackSched(scheduleTrigger.createSchedule({
  name: '风暴复现', objective: 'OBJ_C56_A1', targetUrl: 'https://example.com',
  profileIds: [], intervalMs: 60000, autoStart: false,
}).id);
corrupt(s1, { cron: '0 0 31 2 *', nextRunAt: Date.now() - 10 }); // 模拟损坏/历史遗留（绕过创建校验）
const t1 = Date.now();
const r1 = scheduleTrigger.tickSchedules(t1);
ok(r1.fired.includes(s1), 'A1 tick1 触发（到期实体正常消费）');
let rec1 = scheduleTrigger.getSchedule(s1);
ok(rec1.runCount === 1, 'A1 tick1 runCount=1');
ok(rec1.nextRunAt === t1 + scheduleTrigger.CRON_FAILURE_BACKOFF_MS, 'A1 cronNext 失败 → 退避 +60s（不再立即到期）', 'nextRunAt=' + rec1.nextRunAt + ' 期望=' + (t1 + 60000));
ok(rec1.nextRunAt > Date.now(), 'A1 退避后 nextRunAt 在未来');
const r2 = scheduleTrigger.tickSchedules(Date.now());
ok(!r2.fired.includes(s1), 'A1 tick2 不重复触发（旧代码此处再次 fire → 风暴）');
ok(scheduleTrigger.getSchedule(s1).runCount === 1, 'A1 tick2 runCount 仍=1');
scheduleTrigger.tickSchedules(Date.now());
ok(scheduleTrigger.getSchedule(s1).runCount === 1, 'A1 tick3 runCount 仍=1（三次 tick 恒 1，风暴消除）');
ok(rec1.lastRunTaskIds.length === 1 && scheduleTrigger.getSchedule(s1).lastRunTaskIds.length === 1, 'A1 触发产出已落盘');

// A2 表达式整体损坏（parse 抛错路径）同样退避
const s2 = trackSched(scheduleTrigger.createSchedule({
  name: '损坏表达式', objective: 'OBJ_C56_A2', targetUrl: 'https://example.com',
  profileIds: [], intervalMs: 60000, autoStart: false,
}).id);
corrupt(s2, { cron: 'this is not a cron!!', nextRunAt: Date.now() - 10 });
const t2 = Date.now();
scheduleTrigger.tickSchedules(t2);
rec1 = scheduleTrigger.getSchedule(s2);
ok(rec1.runCount === 1 && rec1.nextRunAt === t2 + scheduleTrigger.CRON_FAILURE_BACKOFF_MS, 'A2 parse 损坏 → 触发 1 次 + 退避落盘');
ok(!scheduleTrigger.tickSchedules(Date.now()).fired.includes(s2), 'A2 下一 tick 不重复触发');

// A3 合法 cron 语义保留：严格按表推进（C21 不漂移语义）
const s3 = trackSched(scheduleTrigger.createSchedule({
  name: '合法 cron', objective: 'OBJ_C56_A3', targetUrl: 'https://example.com',
  cron: '*/2 * * * *', autoStart: false,
}).id);
corrupt(s3, { nextRunAt: Date.now() - 10 });
const t3 = Date.now();
scheduleTrigger.tickSchedules(t3);
rec1 = scheduleTrigger.getSchedule(s3);
const expected3 = cronNext('*/2 * * * *', new Date(t3));
ok(rec1.runCount === 1 && rec1.nextRunAt === expected3, 'A3 合法 cron 严格按表推进（= cronNext(cron, tick时刻)）');
ok(new Date(expected3).getMinutes() % 2 === 0, 'A3 推进目标为偶数分钟（*/2 语义正确）');
ok(!scheduleTrigger.tickSchedules(Date.now()).fired.includes(s3), 'A3 合法 cron 下一 tick 不重复触发');

// ============================================================================
section('B: interval 非法下限（旧 intervalMs||0 → +0 每秒到期风暴）');

const s4 = trackSched(scheduleTrigger.createSchedule({
  name: 'interval 损坏', objective: 'OBJ_C56_B1', targetUrl: 'https://example.com',
  profileIds: [], intervalMs: 60000, autoStart: false,
}).id);
corrupt(s4, { cron: null, intervalMs: null, nextRunAt: Date.now() - 10 });
const t4 = Date.now();
scheduleTrigger.tickSchedules(t4);
rec1 = scheduleTrigger.getSchedule(s4);
ok(rec1.runCount === 1 && rec1.nextRunAt === t4 + scheduleTrigger.MIN_INTERVAL_MS, 'B1 intervalMs=null → MIN 下限（旧 ||0 = +0 立即再到期）');
ok(!scheduleTrigger.tickSchedules(Date.now()).fired.includes(s4), 'B1 下一 tick 不重复触发（两次连续 tick 间隔 < 1s）');

const s5 = trackSched(scheduleTrigger.createSchedule({
  name: 'interval 过小', objective: 'OBJ_C56_B2', targetUrl: 'https://example.com',
  profileIds: [], intervalMs: 60000, autoStart: false,
}).id);
corrupt(s5, { cron: null, intervalMs: 500, nextRunAt: Date.now() - 10 });
scheduleTrigger.tickSchedules(Date.now());
rec1 = scheduleTrigger.getSchedule(s5);
ok(rec1.nextRunAt > Date.now() && rec1.nextRunAt - t4 <= scheduleTrigger.MIN_INTERVAL_MS + 1500, 'B2 intervalMs=500 (< MIN) → 落 MIN 下限而非 500/0');

// ============================================================================
section('C: triggerOnce（手动触发同构修复 + 语义回归）');

const s6 = trackSched(scheduleTrigger.createSchedule({
  name: '手动触发', objective: 'OBJ_C56_C1', targetUrl: 'https://example.com',
  profileIds: [], intervalMs: 60000, autoStart: false,
}).id);
const beforeC1 = Date.now();
const rc1 = scheduleTrigger.triggerOnce(s6, undefined, 'test');
ok(rc1.ok === true && rc1.taskIds.length === 1 && rc1.runCount === 1, 'C1 手动触发成功（ok/taskIds/runCount）');
trackTasks(rc1);
rec1 = scheduleTrigger.getSchedule(s6);
ok(Math.abs(rec1.nextRunAt - (beforeC1 + 60000)) < 3000, 'C1 nextRunAt = 触发时刻 + intervalMs');

const s7 = trackSched(scheduleTrigger.createSchedule({
  name: '手动+损坏cron', objective: 'OBJ_C56_C2', targetUrl: 'https://example.com',
  profileIds: [], intervalMs: 60000, autoStart: false,
}).id);
corrupt(s7, { cron: '0 0 31 2 *', nextRunAt: Date.now() - 10 });
let rc2 = null, threwC2 = false;
try { rc2 = scheduleTrigger.triggerOnce(s7, undefined, 'test'); }
catch (e) { threwC2 = true; }
ok(!threwC2 && rc2 && rc2.taskIds.length === 1, 'C2 损坏 cron 手动触发不抛错且任务已建（旧代码：任务已建却抛 400 + 不落盘）');
rec1 = scheduleTrigger.getSchedule(s7);
ok(rec1.runCount === 1 && rec1.nextRunAt > Date.now(), 'C2 runCount/nextRunAt 已落盘（退避在未来，tick 不再双拍）');

scheduleTrigger.updateSchedule(s6, { status: 'PAUSED' });
expectThrow(() => scheduleTrigger.triggerOnce(s6, undefined, 'test'), 'PAUSED', 'C3 PAUSED 手动触发 → 400（语义不变）');

// ============================================================================
section('D: updateSchedule 周期变更（回归 + cron→interval 切换）');

const s8 = trackSched(scheduleTrigger.createSchedule({
  name: '周期变更', objective: 'OBJ_C56_D1', targetUrl: 'https://example.com',
  profileIds: [], intervalMs: 60000, autoStart: false,
}).id);
scheduleTrigger.triggerOnce(s8, undefined, 'test');
const updD1 = scheduleTrigger.updateSchedule(s8, { intervalMs: 120000 });
rec1 = scheduleTrigger.getSchedule(s8);
ok(updD1.nextRunAt === rec1.lastRunAt + 120000, 'D1 intervalMs 变更 → nextRunAt = lastRunAt + 新周期（STEP12 F 语义保留）');

const s9 = trackSched(scheduleTrigger.createSchedule({
  name: 'cron切interval', objective: 'OBJ_C56_D2', targetUrl: 'https://example.com',
  cron: '0 0 * * *', autoStart: false,
}).id);
const updD2 = scheduleTrigger.updateSchedule(s9, { cron: null, intervalMs: 120000 });
rec1 = scheduleTrigger.getSchedule(s9);
ok(rec1.cron === null && rec1.intervalMs === 120000, 'D2 cron 清除 + interval 设置成功');
ok(updD2.nextRunAt === rec1.createdAt + 120000, 'D2 cron→interval：nextRunAt = createdAt + intervalMs（无 lastRunAt 基准）');
ok(updD2.nextRunAt > Date.now(), 'D2 切换后不在过去（旧顺序 ||0 先算可致既往到期）');

// ============================================================================
section('E: 代码锚点守护');

const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'scheduleTrigger.js'), 'utf8');
ok(scheduleTrigger.CRON_FAILURE_BACKOFF_MS === 60000, 'E1 退避常量导出 = 60000');
ok((src.match(/_advanceNextRun\(/g) || []).length >= 4, 'E2 _advanceNextRun 定义 + 三消费点（updateSchedule/triggerOnce/tick）均在源码');
ok(!/intervalMs \|\| 0/.test(src), 'E3 旧 intervalMs||0 模式已清零（+0 风暴面消除）');
ok(src.includes("catch (e) { r = { taskIds: [], errors:") && src.includes('记录型落盘失败不影响防风暴'), 'E4 触发兜底 + 记录型 upsert 防御就位');

// ============================================================================
// 清理
for (const id of taskIds) { try { taskManager.deleteTask(id); } catch (e) {} }
for (const id of schedIds) { try { scheduleTrigger.deleteSchedule(id); } catch (e) {} }

console.log('\n========================================');
console.log('C56 结果: PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
