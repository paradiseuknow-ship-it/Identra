'use strict';

// Phase 15 存储治理测试（2026-09-04）：
// 1) JsonStore 自动归档（水位触发 / 归档文件 / 主文件截尾 / 防递归）
// 2) archiveOldest 手动语义
// 3) read 深拷贝隔离（双重克隆消除后语义不变）
// 4) stepManager 大观察体外置（externalizeEvidence / normalizeErrorShape）
// 5) archiveAiStore 分拣纯函数（引用完整性：task 归档则关联记录一并归档）

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { JsonStore, AUTO_ARCHIVE_LIMITS, archiveDateString } = require('../agent/storage/jsonStore');
const stepManager = require('../agent/stepManager');
const archiveAiStore = require('./archiveAiStore');

const pass = [];
const failures = [];
async function t(name, fn) {
  try { await fn(); pass.push(name); console.log('  ok - ' + name); }
  catch (e) { failures.push(name + ': ' + e.message); console.log('  FAIL - ' + name + ' :: ' + e.message); }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-store-test-'));
}

async function main() {
  console.log('\n===== test_phase15_storage =====');

  // ── A. archiveOldest 手动语义 ──
  await t('A1 archiveOldest 归档头部 N 条并截尾主文件', () => {
    const dir = tmpDir();
    const s = new JsonStore(dir);
    const items = Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, v: i }));
    s.write('aiAttempts', items);
    const r = s.archiveOldest('aiAttempts', 4);
    assert.strictEqual(r.archived, 4);
    assert.strictEqual(r.remaining.length, 6);
    assert.strictEqual(r.remaining[0].id, 'x4');
    const main = s.read('aiAttempts');
    assert.strictEqual(main.length, 6);
    const files = fs.readdirSync(path.join(dir, 'archive', 'aiAttempts'));
    assert.strictEqual(files.length, 1);
    const archived = JSON.parse(fs.readFileSync(path.join(dir, 'archive', 'aiAttempts', files[0]), 'utf8'));
    assert.strictEqual(archived.length, 4);
    assert.strictEqual(archived[0].id, 'x0');
    assert.strictEqual(archived[3].id, 'x3');
  });

  await t('A2 archiveOldest 空集合 / count 超总量 安全返回', () => {
    const dir = tmpDir();
    const s = new JsonStore(dir);
    s.write('aiSteps', [{ id: 'a' }]);
    const r = s.archiveOldest('aiSteps', 5);
    assert.strictEqual(r.archived, 0);
    assert.strictEqual(s.read('aiSteps').length, 1);
  });

  await t('A3 二次归档追加同一时间戳文件不覆盖', () => {
    const dir = tmpDir();
    const s = new JsonStore(dir);
    s.write('aiAttempts', Array.from({ length: 12 }, (_, i) => ({ id: 'y' + i })));
    s.archiveOldest('aiAttempts', 3);
    const r2 = s.archiveOldest('aiAttempts', 3);
    assert.strictEqual(r2.archived, 3);
    const files = fs.readdirSync(path.join(dir, 'archive', 'aiAttempts'));
    assert.strictEqual(files.length, 1); // 同秒内同一文件追加
    const archived = JSON.parse(fs.readFileSync(path.join(dir, 'archive', 'aiAttempts', files[0]), 'utf8'));
    assert.strictEqual(archived.length, 6);
  });

  // ── B. 自动水位归档 ──
  await t('B1 write 超水位自动归档（limit 注入为 10）', () => {
    const dir = tmpDir();
    const s = new JsonStore(dir);
    const orig = AUTO_ARCHIVE_LIMITS.aiAttempts;
    AUTO_ARCHIVE_LIMITS.aiAttempts = 10;
    try {
      s.write('aiAttempts', Array.from({ length: 16 }, (_, i) => ({ id: 'z' + i })));
      const main = s.read('aiAttempts');
      // 触发时归档 floor(10/3)=3 条 → 主文件 13
      assert.strictEqual(main.length, 13);
      assert.strictEqual(main[0].id, 'z3');
      const files = fs.readdirSync(path.join(dir, 'archive', 'aiAttempts'));
      assert.strictEqual(files.length, 1);
      const archived = JSON.parse(fs.readFileSync(path.join(dir, 'archive', 'aiAttempts', files[0]), 'utf8'));
      assert.strictEqual(archived.length, 3);
      assert.strictEqual(archived[0].id, 'z0');
    } finally {
      AUTO_ARCHIVE_LIMITS.aiAttempts = orig;
    }
  });

  await t('B2 未配置水位的集合不触发自动归档', () => {
    const dir = tmpDir();
    const s = new JsonStore(dir);
    const big = Array.from({ length: 50 }, (_, i) => ({ id: 'k' + i }));
    s.write('aiKnowledge', big); // aiKnowledge 不在 AUTO_ARCHIVE_LIMITS
    assert.strictEqual(s.read('aiKnowledge').length, 50);
    assert.ok(!fs.existsSync(path.join(dir, 'archive', 'aiKnowledge')));
  });

  // ── C. read 深拷贝隔离 ──
  await t('C1 read 返回深拷贝：修改返回值不污染 store', () => {
    const dir = tmpDir();
    const s = new JsonStore(dir);
    s.write('aiTasks', [{ id: 't1', nested: { a: 1 } }]);
    const got = s.read('aiTasks');
    got[0].nested.a = 999;
    got[0].newField = 'x';
    const again = s.read('aiTasks');
    assert.strictEqual(again[0].nested.a, 1);
    assert.strictEqual(again[0].newField, undefined);
    assert.strictEqual(s.find('aiTasks', 't1').nested.a, 1);
  });

  // ── D. stepManager 证据外置 ──
  await t('D1 小观察体不外置原样保留', () => {
    const obs = { url: 'http://x/a', title: 'T', texts: ['a', 'b'] };
    const r = stepManager.normalizeErrorShape({ code: 'VERIFY_FAILED', message: 'm', observationBefore: obs }, 'att_a1');
    assert.strictEqual(r.observationBefore.externalized, undefined);
    assert.strictEqual(r.observationBefore.url, 'http://x/a');
  });

  await t('D2 >4KB 观察体外置：store 留指针，文件可还原', () => {
    const dir = tmpDir();
    const oldDataDir = process.env.FPB_DATA_DIR;
    process.env.FPB_DATA_DIR = dir;
    try {
      const bigObs = { url: 'http://x/big', title: 'Big', texts: Array.from({ length: 200 }, (_, i) => 'text-' + i + '-' + 'x'.repeat(40)) };
      assert.ok(JSON.stringify(bigObs).length > 4 * 1024);
      const r = stepManager.normalizeErrorShape({ code: 'VERIFY_FAILED', message: 'm', observationAfter: bigObs }, 'att_big1');
      const kept = r.observationAfter;
      assert.strictEqual(kept.externalized, true);
      assert.ok(kept.byteSize > 4 * 1024);
      assert.strictEqual(kept.url, 'http://x/big');
      assert.ok(kept.file.endsWith('att_big1.observationAfter.json'));
      const f = path.join(dir, kept.file);
      assert.ok(fs.existsSync(f), '外置文件应存在: ' + f);
      const restored = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.deepStrictEqual(restored.value, bigObs);
    } finally {
      if (oldDataDir === undefined) delete process.env.FPB_DATA_DIR;
      else process.env.FPB_DATA_DIR = oldDataDir;
    }
  });

  await t('D3 previousObservationDiff 同样外置', () => {
    const dir = tmpDir();
    const oldDataDir = process.env.FPB_DATA_DIR;
    process.env.FPB_DATA_DIR = dir;
    try {
      const bigDiff = { changes: Array.from({ length: 100 }, (_, i) => ({ field: 'f' + i, detail: 'd'.repeat(80) })) };
      const r = stepManager.normalizeErrorShape({ code: 'X', message: 'm', previousObservationDiff: bigDiff }, 'att_diff1');
      assert.strictEqual(r.previousObservationDiff.externalized, true);
      assert.ok(fs.existsSync(path.join(dir, r.previousObservationDiff.file)));
    } finally {
      if (oldDataDir === undefined) delete process.env.FPB_DATA_DIR;
      else process.env.FPB_DATA_DIR = oldDataDir;
    }
  });

  await t('D4 无 attemptId 时退化不抛错（向后兼容单参调用）', () => {
    const obs = { url: 'u', texts: Array.from({ length: 300 }, () => 'y'.repeat(50)) };
    const r = stepManager.normalizeErrorShape({ code: 'X', message: 'm', observationBefore: obs });
    // 无 id → 外置文件名用 att_unknown，仍然成功外置
    assert.strictEqual(r.observationBefore.externalized, true);
  });

  // ── E. archiveAiStore 分拣纯函数 ──
  await t('E1 pickArchiveTaskIds：只归档已终态且超窗任务，未来时间戳保守保留', () => {
    const now = 1_000_000_000_000;
    const tasks = [
      { id: 'old_done', status: 'SUCCESS', finishedAt: now - 10 * 86400e3 },
      { id: 'old_running', status: 'RUNNING', finishedAt: now - 10 * 86400e3 },
      { id: 'recent', status: 'FAILED', finishedAt: now - 1 * 86400e3 },
      { id: 'future_bug', status: 'FAILED', finishedAt: now + 86400e3 },
    ];
    const ids = archiveAiStore.pickArchiveTaskIds(tasks, now - 7 * 86400e3, now);
    assert.deepStrictEqual([...ids].sort(), ['old_done']);
  });

  await t('E2 partitionCollection：task 归档则 steps/attempts 关联记录一并归档（无悬空引用）', () => {
    const ids = new Set(['task_old']);
    const steps = [
      { id: 's1', taskId: 'task_old' },
      { id: 's2', taskId: 'task_new' },
      { id: 's3', taskId: null },
    ];
    const { kept, moving } = archiveAiStore.partitionCollection(steps, ids, 'taskId');
    assert.strictEqual(moving.length, 1);
    assert.strictEqual(moving[0].id, 's1');
    assert.deepStrictEqual(kept.map((x) => x.id), ['s2', 's3']);
  });

  await t('E3 taskEndTime 优先级 finishedAt > startedAt > createdAt', () => {
    assert.strictEqual(archiveAiStore.taskEndTime({ finishedAt: 3, startedAt: 2, createdAt: 1 }), 3);
    assert.strictEqual(archiveAiStore.taskEndTime({ startedAt: 2, createdAt: 1 }), 2);
    assert.strictEqual(archiveAiStore.taskEndTime({ createdAt: 1 }), 1);
    assert.strictEqual(archiveAiStore.taskEndTime({}), 0);
  });

  await t('E4 pickArchiveTaskIdsByCount：保留最近 N 个终态任务，活跃任务永不归档', () => {
    const now = 1_000_000_000_000;
    const tasks = [
      { id: 't1', status: 'FAILED', finishedAt: now - 5 * 86400e3 },
      { id: 't2', status: 'SUCCESS', finishedAt: now - 4 * 86400e3 },
      { id: 't3', status: 'FAILED', finishedAt: now - 3 * 86400e3 },
      { id: 't4', status: 'RUNNING', finishedAt: now - 2 * 86400e3 }, // 活跃，永不归档
      { id: 't5', status: 'CANCELLED', finishedAt: now - 1 * 86400e3 },
    ];
    const ids = archiveAiStore.pickArchiveTaskIdsByCount(tasks, 2, now);
    // 终态按时间降序：t5(新) t3 t2 t1(旧)；保留 t5/t3，归档 t2/t1；t4 活跃不参与
    assert.deepStrictEqual([...ids].sort(), ['t1', 't2']);
  });

  // ── F. 生产数据 dry-run（只读，验证脚本对真实数据可跑）──
  await t('F1 真实数据 dry-run 无异常', () => {
    const r = archiveAiStore.run({ apply: false, keepDays: 7 });
    assert.ok(typeof r.totalMoving === 'number');
    assert.ok(r.dryRun === true);
  });

  console.log('\n===== test_phase15_storage =====');
  console.log('PASS=' + pass.length + ' FAIL=' + failures.length);
  if (failures.length) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
