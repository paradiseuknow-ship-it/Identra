'use strict';

// C196 守护：deleteTask / retry 连带清外置证据文件（与 store 记录同一清退口径）。
//
// 失败面（立项判据）：C190 一次性清理实测 evidence 318→239，其中 79/318=25% 为
// deleteTask 留下的孤儿文件 —— _purgeTaskEvidence 只删 aiSteps/aiAttempts/aiSkillRouting
// 记录，evidence/attempt_errors/<attemptId>.<field>.json（stepManager 外置大证据体）
// 与 evidence/snapshots/<taskId>/（页面快照）两个文件面永久残留。
//
// 分组：
//   A 行为（隔离数据根内端到端）：deleteTask/retry 后文件与记录同清、survivor 不误删、
//     pre-v0.2.2 孤儿 attempt（taskId=null 经 stepId 命中）覆盖、前缀碰撞防误删、
//     目录缺失 fail-safe。
//   B 接线静态（c112 X2 源断言先例）：_purgeTaskEvidence 委托两个 purge 实现；
//     attemptIds 快照必须在 aiAttempts 写回**之前**（删除后反查恒空 = C67b 同族死逻辑）。
//
// 咬点（本测试必须能咬住的回改形态）：
//   ① 去掉 _purgeTaskEvidence 内两个 purge 委托调用 → A1/A4 红
//   ② attemptIds 快照移到 store.write('aiAttempts') 之后 → A1/A3 红 + X3 红
//   ③ purgeAttemptErrorFiles 前缀匹配去掉 `+'.'`（裸 startsWith）→ A6 红（att_x 误删 att_xy）
//   ④ purgeTaskSnapshots 去掉 safeJoinWithin → A7 非 taskId 输入抛错/穿越红

// C190：产品数据根隔离（C140 纪律）——必须前置于首个写面 server 模块 require
// （dataRoot/SNAP_DIR 均在模块加载期解析）。
const _fsC190 = require('fs');
const _osC190 = require('os');
const _pathC190 = require('path');
process.env.FPB_DATA_DIR = _fsC190.mkdtempSync(_pathC190.join(_osC190.tmpdir(), 'fpb-c196-evidence-'));

const fs = require('fs');
const path = require('path');
const taskManager = require('../agent/taskManager');
const stepManager = require('../agent/stepManager');
const evidence = require('../agent/evidence');
const store = require('../agent/store');

const ROOT = _pathC190.join(__dirname, '..');
const tmSrc = _fsC190.readFileSync(_pathC190.join(ROOT, 'agent', 'taskManager.js'), 'utf8');

let passed = 0, failed = 0;
function chk(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.error('  FAIL', name, detail ? '- ' + detail : ''); process.exitCode = 1; }
}
const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };

function errFileDir() { return stepManager.evidenceErrorDir(); }
function snapDir(taskId) { return path.join(evidence.SNAP_DIR, taskId); }

// 造一个带 step/attempt/外置证据文件/snapshots 的任务，返回句柄
function makeTaskWithEvidence(label) {
  const task = taskManager.createTask({ name: 'C196-' + label, objective: 'test', targetUrl: 'https://example.com/' + label });
  const step = stepManager.createStep(task.id, { description: 'step-' + label, type: 'ACT' }, 0);
  const att = stepManager.createAttempt(step.id, 'exec_' + label, { type: 'click', selector: '#x' });
  // attempt_errors 外置文件（externalizeEvidence 同名形态：<attemptId>.<field>.json）
  const errDir = errFileDir();
  fs.mkdirSync(errDir, { recursive: true });
  const errFiles = [att.id + '.observationBefore.json', att.id + '.error.json'];
  for (const f of errFiles) fs.writeFileSync(path.join(errDir, f), JSON.stringify({ value: { url: 'https://x/' } }), 'utf8');
  // snapshots 快照文件
  const sd = snapDir(task.id);
  fs.mkdirSync(sd, { recursive: true });
  const snapFiles = ['step0_before_action_1.png', 'step0_after_action_2.png'];
  for (const f of snapFiles) fs.writeFileSync(path.join(sd, f), 'png', 'utf8');
  return { task, step, att, errFiles, snapFiles };
}

// ── A. 行为 ──
console.log('A. 行为（隔离根 ' + process.env.FPB_DATA_DIR + '）');

// A1 deleteTask：记录与两个文件面同清
{
  const h = makeTaskWithEvidence('del');
  const survivor = makeTaskWithEvidence('keep');
  const errDir = errFileDir();
  const before = fs.readdirSync(errDir).length;
  taskManager.deleteTask(h.task.id);
  chk('A1a deleteTask 后 steps 清', store.read('aiSteps', []).every((s) => s.taskId !== h.task.id));
  chk('A1b deleteTask 后 attempts 清', store.read('aiAttempts', []).every((a) => a.taskId !== h.task.id && a.stepId !== h.step.id));
  chk('A1c attempt_errors 外置文件清', h.errFiles.every((f) => !exists(path.join(errDir, f))), h.errFiles.join(','));
  chk('A1d snapshots 目录清', !exists(snapDir(h.task.id)));
  chk('A1e survivor 记录保留', store.read('aiSteps', []).some((s) => s.taskId === survivor.task.id));
  chk('A1f survivor attempt_errors 文件保留', survivor.errFiles.every((f) => exists(path.join(errDir, f))));
  chk('A1g survivor snapshots 文件保留', survivor.snapFiles.every((f) => exists(path.join(snapDir(survivor.task.id), f))));
  // 收尾：survivor 也删，保持隔离根自洽
  taskManager.deleteTask(survivor.task.id);
  chk('A1h survivor 删除后其文件清', survivor.errFiles.every((f) => !exists(path.join(errDir, f))) && !exists(snapDir(survivor.task.id)));
}

// A2 pre-v0.2.2 孤儿 attempt（taskId=null，stepId 命中）文件同清
{
  const task = taskManager.createTask({ name: 'C196-legacy', objective: 'test', targetUrl: 'https://example.com/legacy' });
  const step = stepManager.createStep(task.id, { description: 's', type: 'ACT' }, 0);
  const legacyAtt = { id: 'att_legacy_' + Date.now().toString(36), stepId: step.id, taskId: null, startedAt: 1 };
  store.insert('aiAttempts', legacyAtt);
  const errDir = errFileDir();
  fs.mkdirSync(errDir, { recursive: true });
  const f = legacyAtt.id + '.observationBefore.json';
  fs.writeFileSync(path.join(errDir, f), '{}', 'utf8');
  taskManager.deleteTask(task.id);
  chk('A2a legacy attempt 记录清（stepId 命中）', store.read('aiAttempts', []).every((a) => a.id !== legacyAtt.id));
  chk('A2b legacy attempt 外置文件清', !exists(path.join(errDir, f)));
}

// A3 retry：旧 attempt 外置文件清（retry 内部同一 _purgeTaskEvidence 口径）
{
  const h = makeTaskWithEvidence('retry');
  // 置 FAILED（直接落库绕过状态机，retry 入口校验只看 status）
  const t = taskManager.getTask(h.task.id);
  t.status = 'FAILED';
  store.upsert('aiTasks', t);
  let retryErr = null;
  try { taskManager.retry(h.task.id); } catch (e) { retryErr = e; }
  const errDir = errFileDir();
  chk('A3a retry 后旧 attempt 外置文件清', h.errFiles.every((f) => !exists(path.join(errDir, f))));
  chk('A3b retry 后旧 snapshots 目录清', !exists(snapDir(h.task.id)));
  chk('A3c retry 本身不因清理抛错', retryErr === null || /不存在|状态/.test(String(retryErr && retryErr.message)), retryErr && String(retryErr.message));
  try { taskManager.deleteTask(h.task.id); } catch (e) {}
}

// A4 fail-safe：全新任务（零 evidence 文件）deleteTask 不抛错
{
  const task = taskManager.createTask({ name: 'C196-bare', objective: 'test', targetUrl: 'https://example.com/bare' });
  let delErr = null;
  try { taskManager.deleteTask(task.id); } catch (e) { delErr = e; }
  chk('A4 零文件任务 deleteTask 不抛错', delErr === null, delErr && String(delErr.message));
}

// A5 前缀碰撞：attemptId 互为前缀时只删精确命中（裸 startsWith 会误删）
{
  const errDir = errFileDir();
  fs.mkdirSync(errDir, { recursive: true });
  const fx = 'att_x.observationBefore.json';
  const fxy1 = 'att_xy.observationBefore.json';
  const fxy2 = 'att_xy.error.json';
  fs.writeFileSync(path.join(errDir, fx), '{}', 'utf8');
  fs.writeFileSync(path.join(errDir, fxy1), '{}', 'utf8');
  fs.writeFileSync(path.join(errDir, fxy2), '{}', 'utf8');
  const removed = stepManager.purgeAttemptErrorFiles(new Set(['att_x']));
  chk('A5a 前缀命中删除且计数=1', removed === 1, 'removed=' + removed);
  chk('A5b att_x 文件已删', !exists(path.join(errDir, fx)));
  chk('A5c att_xy 文件不误删', exists(path.join(errDir, fxy1)) && exists(path.join(errDir, fxy2)));
  // 多字段同 attempt 全删
  fs.writeFileSync(path.join(errDir, fxy1), '{}', 'utf8');
  const removed2 = stepManager.purgeAttemptErrorFiles(new Set(['att_xy']));
  chk('A5d 同 attempt 多字段全删（=2）', removed2 === 2 && !exists(path.join(errDir, fxy1)) && !exists(path.join(errDir, fxy2)), 'removed=' + removed2);
  // 空集合 / 空目录 / 目录不存在均零副作用
  chk('A5e 空集合返回 0', stepManager.purgeAttemptErrorFiles(new Set()) === 0);
  chk('A5f null 输入返回 0 不抛错', stepManager.purgeAttemptErrorFiles(null) === 0);
}

// A6 purgeTaskSnapshots 非法/不存在输入 fail-safe
{
  chk('A6a 不存在 taskId 返回 0', evidence.purgeTaskSnapshots('task_nope_' + Date.now().toString(36)) === 0);
  chk('A6b 非 string taskId 返回 0', evidence.purgeTaskSnapshots(null) === 0 && evidence.purgeTaskSnapshots(undefined) === 0);
  // 穿越 taskId（行为级）：sentinel 任务的快照必须原封不动。两个形态：
  //  ① '../snapshots' —— 裸 path.join 会规范化回 SNAP_DIR 本身（列到的是 sentinel
  //     目录条目，unlink 删不掉目录，此形态必须返回 0 且不误删）；
  //  ② '../snapshots/<sentinelId>' —— 退化实现会直接定位到 sentinel 目录内部
  //     并删掉其文件（safeJoinWithin 形态则拒绝 '..' 段直接返回 0）。
  const sentinelId = 'task_sentinel_' + Date.now().toString(36);
  const sentinelDir = path.join(evidence.SNAP_DIR, sentinelId);
  fs.mkdirSync(sentinelDir, { recursive: true });
  const sentinelFile = path.join(sentinelDir, 's.png');
  fs.writeFileSync(sentinelFile, 'png', 'utf8');
  const escapeRet = evidence.purgeTaskSnapshots('../' + path.basename(evidence.SNAP_DIR));
  chk('A6c 穿越 taskId 返回 0', escapeRet === 0, 'ret=' + escapeRet);
  chk('A6d 穿越 taskId 不删 sentinel', exists(sentinelFile) && exists(sentinelDir));
  const escapeRet2 = evidence.purgeTaskSnapshots('../' + path.basename(evidence.SNAP_DIR) + '/' + sentinelId);
  chk('A6e 穿越+sibling 指向返回 0', escapeRet2 === 0, 'ret=' + escapeRet2);
  chk('A6f 穿越+sibling 指向不删 sentinel 文件', exists(sentinelFile));
  fs.rmSync(sentinelDir, { recursive: true, force: true });
}

// ── B. 接线静态（c112 X2 源断言先例）──
console.log('B. 接线静态');
chk('X1 _purgeTaskEvidence 委托 purgeAttemptErrorFiles', /_purgeTaskEvidence[\s\S]{0,2200}purgeAttemptErrorFiles/.test(tmSrc));
chk('X2 _purgeTaskEvidence 委托 purgeTaskSnapshots', /_purgeTaskEvidence[\s\S]{0,2400}purgeTaskSnapshots/.test(tmSrc));
{
  // X3：attemptIds 快照必须在 aiAttempts 写回之前（顺序锚——删除后反查恒空 = C67b 同族死逻辑）
  const fnSrc = tmSrc.slice(tmSrc.indexOf('function _purgeTaskEvidence'));
  const body = fnSrc.slice(0, fnSrc.indexOf('\nfunction '));
  const iSnapshot = body.indexOf('purgedAttemptIds = new Set');
  const iWriteAtt = body.indexOf("store.write('aiAttempts'");
  chk('X3 attemptIds 快照先于 aiAttempts 写回', iSnapshot > 0 && iWriteAtt > iSnapshot, 'snapshot@' + iSnapshot + ' write@' + iWriteAtt);
  // 快照过滤条件与写回过滤条件同口径（taskId 命中 ∪ stepId 命中）
  chk('X4a 快照条件含 taskId 命中', /purgedAttemptIds[\s\S]{0,400}a\.taskId === taskId/.test(body));
  chk('X4b 快照条件含 stepId 命中（pre-v0.2.2 孤儿）', /purgedAttemptIds[\s\S]{0,400}stepIds\.has\(a\.stepId\)/.test(body));
}
chk('X5 stepManager 导出 purgeAttemptErrorFiles', typeof stepManager.purgeAttemptErrorFiles === 'function');
chk('X6 evidence 导出 purgeTaskSnapshots', typeof evidence.purgeTaskSnapshots === 'function');

console.log('\nC196 evidence purge: PASS ' + passed + ' / FAIL ' + failed);
process.exit(failed ? 1 : 0);
