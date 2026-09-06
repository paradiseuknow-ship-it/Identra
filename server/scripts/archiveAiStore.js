'use strict';

// 一次性存储治理迁移：把历史任务（超过保留期且已终态）的关联记录从主集合归档到
// data/archive/<collection>/<时间戳>.json，主集合重写为保留集。
//
// 背景（2026-09-04）：aiAttempts.json 膨胀到 42MB（14446 条），JsonStore 全量重写型
// 存储每条 insert 都是 O(全文件) IO，曾同步阻塞事件循环数小时。运行时自动水位归档
// （jsonStore.AUTO_ARCHIVE_LIMITS）已上线，但只按条数裁头；本脚本按「任务时间 + 引用
// 完整性」做一次性精确归档，避免悬空引用（task 归档则其 steps/attempts/checkpoints/
// executions/repairs/plannerEvidence 一并归档）。
//
// 用法：
//   node server/scripts/archiveAiStore.js                 # dry-run，只打印统计
//   node server/scripts/archiveAiStore.js --apply         # 执行归档
//   node server/scripts/archiveAiStore.js --keep-days 14  # 保留最近 14 天（默认 7）
//
// 红线：只动历史数据归档，不删任何记录（evidence-first）；活跃/未终态任务永不归档；
//       不触碰 aiEvents/aiKnowledge/aiElementMemory/aiFlowMemory 等记忆与环形缓冲集合。

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.FPB_DATA_DIR
  ? path.resolve(process.env.FPB_DATA_DIR)
  : path.join(__dirname, '..', 'data'); // server/scripts → server/data（与 storage/index.js resolveDataDir 一致）

const TERMINAL_TASK_STATES = ['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION', 'COMPLETED'];

// task 主集合 + 引用集合（全部按 taskId 关联，字段已实证存在）
const TASK_COLLECTION = 'aiTasks';
const REFERENCE_COLLECTIONS = [
  'aiSteps',
  'aiAttempts',
  'aiExecutions',
  'aiCheckpoints',
  'aiRepairAttempts',
  'aiPlannerEvidence',
];

// ── 纯函数：分拣（导出供测试）──
function taskEndTime(t) {
  return t.finishedAt || t.startedAt || t.createdAt || 0;
}

function pickArchiveTaskIds(tasks, cutoffMs, nowMs) {
  const archive = new Set();
  for (const t of tasks) {
    const isTerminal = TERMINAL_TASK_STATES.includes(t.status);
    const endedBefore = taskEndTime(t) < cutoffMs;
    // 防时钟漂移：结束时间晚于 now 的记录视为异常时间戳，保守不归档
    const sane = taskEndTime(t) <= nowMs;
    if (isTerminal && endedBefore && sane) archive.add(t.id);
  }
  return archive;
}

// 按条数保留：终态任务按结束时间排序，只保留最近 keepCount 个；活跃任务永不归档。
// 跑批形态（每轮 100 任务）下按天数窗口裁不动主文件，按条数更贴合。
function pickArchiveTaskIdsByCount(tasks, keepCount, nowMs) {
  const candidates = tasks
    .filter((t) => TERMINAL_TASK_STATES.includes(t.status) && taskEndTime(t) <= nowMs)
    .sort((a, b) => taskEndTime(b) - taskEndTime(a));
  const keep = new Set(candidates.slice(0, Math.max(0, keepCount)).map((t) => t.id));
  const archive = new Set();
  for (const t of candidates) {
    if (!keep.has(t.id)) archive.add(t.id);
  }
  return archive;
}

function partitionCollection(arr, archiveIds, keyField, ghostTaskIds) {
  const kept = [];
  const moving = [];
  const ghosts = ghostTaskIds instanceof Set ? ghostTaskIds : null;
  for (const item of arr) {
    const k = item && item[keyField];
    if (k && archiveIds.has(k)) moving.push(item);
    else if (ghosts && k && ghosts.has(k)) moving.push(item); // 存量悬空（task 已不存在）一并归档
    else kept.push(item);
  }
  return { kept, moving };
}

// 从「保留 + 归档」之外的关联记录里收集 ghost taskId（task 早已不存在的悬空引用）。
function collectGhostTaskIds(referenceArrays, knownTaskIds) {
  const ghosts = new Set();
  for (const arr of referenceArrays) {
    for (const item of arr) {
      const k = item && item.taskId;
      if (k && !knownTaskIds.has(k)) ghosts.add(k);
    }
  }
  return ghosts;
}

// ── IO ──
function readCollection(name) {
  const f = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(f)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('[archive] 警告: ' + name + '.json 解析失败，跳过（' + e.message + '）');
    return [];
  }
}

function archiveDirFor(name) {
  return path.join(DATA_DIR, 'archive', name);
}

function writeArchive(name, items, stamp) {
  const dir = archiveDirFor(name);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, stamp + '.json');
  let prev = [];
  if (fs.existsSync(f)) {
    try {
      const p = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(p)) prev = p;
    } catch (e) { prev = []; }
  }
  prev.push(...items);
  fs.writeFileSync(f, JSON.stringify(prev, null, 2), 'utf8');
  return f;
}

function rewriteMain(name, kept) {
  const f = path.join(DATA_DIR, name + '.json');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

function byteSize(name) {
  const f = path.join(DATA_DIR, name + '.json');
  return fs.existsSync(f) ? fs.statSync(f).size : 0;
}

function mb(n) { return (n / 1048576).toFixed(2) + 'MB'; }

// ── main ──
function run({ apply, keepDays, keepTasks }) {
  const nowMs = Date.now();
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const tasks = readCollection(TASK_COLLECTION);
  let archiveIds;
  if (keepTasks != null) {
    archiveIds = pickArchiveTaskIdsByCount(tasks, keepTasks, nowMs);
    console.log('[archive] 保留窗口: 最近 ' + keepTasks + ' 个终态任务（按条数）');
  } else {
    const cutoffMs = nowMs - (keepDays || 7) * 86400 * 1000;
    archiveIds = pickArchiveTaskIds(tasks, cutoffMs, nowMs);
    console.log('[archive] 保留窗口: ' + (keepDays || 7) + ' 天 (cutoff=' + new Date(cutoffMs).toISOString() + ')');
  }
  console.log('[archive] tasks 总数=' + tasks.length + ' 归档任务数=' + archiveIds.size);

  const plan = [];
  const taskPart = partitionCollection(tasks, archiveIds, 'id');
  plan.push({ name: TASK_COLLECTION, kept: taskPart.kept, moving: taskPart.moving });

  // ghost 收集：taskId 不在「保留 ∪ 归档」中的悬空引用（task 早已不存在的存量垃圾）一并归档
  const refArrays = new Map(REFERENCE_COLLECTIONS.map((n) => [n, readCollection(n)]));
  const knownTaskIds = new Set(taskPart.kept.map((t) => t.id));
  for (const id of archiveIds) knownTaskIds.add(id);
  const ghostTaskIds = collectGhostTaskIds([...refArrays.values()], knownTaskIds);
  if (ghostTaskIds.size) {
    console.log('[archive] 检测到存量悬空 taskId=' + ghostTaskIds.size + ' 个（关联记录将一并归档）');
  }

  for (const name of REFERENCE_COLLECTIONS) {
    const arr = refArrays.get(name);
    const part = partitionCollection(arr, archiveIds, 'taskId', ghostTaskIds);
    plan.push({ name, kept: part.kept, moving: part.moving });
  }

  let totalMoving = 0;
  let sizeBefore = 0;
  let sizeAfter = 0;
  console.log('\n[archive] 集合                    归档条数   保留条数   主文件before → after(估算)');
  for (const p of plan) {
    const before = byteSize(p.name);
    sizeBefore += before;
    const afterEst = before * (p.kept.length / Math.max(1, p.kept.length + p.moving.length));
    sizeAfter += p.kept.length ? afterEst : 0;
    totalMoving += p.moving.length;
    console.log(
      '  ' + p.name.padEnd(24) +
      String(p.moving.length).padStart(8) +
      String(p.kept.length).padStart(10) +
      '   ' + mb(before) + ' → ~' + mb(afterEst)
    );
  }
  console.log('\n[archive] 合计归档条数=' + totalMoving + '，主文件 ' + mb(sizeBefore) + ' → ~' + mb(sizeAfter));

  if (!apply) {
    console.log('[archive] DRY-RUN 完成（加 --apply 执行归档）');
    return { dryRun: true, totalMoving, archiveIds: archiveIds.size };
  }

  for (const p of plan) {
    if (!p.moving.length) continue;
    const f = writeArchive(p.name, p.moving, stamp);
    rewriteMain(p.name, p.kept);
    console.log('[archive] ' + p.name + ': ' + p.moving.length + ' 条 → ' + f);
  }
  console.log('[archive] APPLY 完成');
  return { dryRun: false, totalMoving, archiveIds: archiveIds.size };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const keepIdx = args.indexOf('--keep-days');
  const keepDays = keepIdx >= 0 ? parseInt(args[keepIdx + 1], 10) || 7 : null;
  const keepCountIdx = args.indexOf('--keep-tasks');
  const keepTasks = keepCountIdx >= 0 ? parseInt(args[keepCountIdx + 1], 10) || 300 : (keepDays != null ? null : 300);
  run({ apply, keepDays, keepTasks });
}

module.exports = {
  taskEndTime,
  pickArchiveTaskIds,
  pickArchiveTaskIdsByCount,
  partitionCollection,
  run,
  TERMINAL_TASK_STATES,
  REFERENCE_COLLECTIONS,
};
