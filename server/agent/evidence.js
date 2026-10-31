'use strict';

// Evidence / Snapshot：关键节点保存页面截图（before_action / after_action / verification_failed）。
// 存储：data/evidence/snapshots/<taskId>/<stepId>_<label>_<ts>.png
// 未来自愈必须依赖这些证据。

const fs = require('fs');
const path = require('path');
const { safeJoinWithin, sanitizeSegment } = require('../security/safePath');
const { dataRoot } = require('../dataRoot');

// C115：快照目录跟随统一数据根（server/dataRoot.js）。此前硬编码 <repo>/data，
// 完全不认 FPB_DATA_DIR——后果：隔离测试（FPB_DATA_DIR=tmp）产生的截图仍写进**真实**
// data 目录，长期无界累积并污染真实证据链（T24「隔离零污染」纪律外的漏网面）。
// 非隔离模式下 dataRoot() 与旧值逐字相同（都是 <repo>/data）→ 行为零变化。
// 保留唯一默认根定义在此（与 C46 对 identityStore/browserManager 的口径一致）。
const SNAP_DIR = path.join(dataRoot(), 'evidence', 'snapshots');

async function saveSnapshot(page, taskId, stepId, label) {
  if (!page) return null;
  try {
    const dir = safeJoinWithin(SNAP_DIR, taskId);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${sanitizeSegment(stepId || 'step')}_${sanitizeSegment(label)}_${Date.now()}.png`;
    await page.screenshot({ path: safeJoinWithin(SNAP_DIR, taskId, file) });
    return file;
  } catch (e) {
    return null;
  }
}

function listForTask(taskId) {
  // taskId 直接来自 URL，必须先过段名白名单，否则 `../` 可列遍任意目录。
  const dir = safeJoinWithin(SNAP_DIR, taskId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((file) => ({ file, taskId, url: '/api/ai/snapshots/' + taskId + '/' + encodeURIComponent(file) }));
}

// 读取侧严格校验：taskId 与 file 均来自 URL，此前 path.join 不阻挡 `../`，
// 配合 sendFile 可从快照目录穿越到任意文件（远程读取凭据库/源码）。
function filePath(taskId, file) {
  return safeJoinWithin(SNAP_DIR, taskId, file);
}

// C196：删除任务的整组快照（deleteTask/retry 源头清退，与 store 记录同一口径）。
// taskId 经 safeJoinWithin 段名白名单校验（防穿越）；逐文件 unlink 而非 rmSync recursive
// （小半径：快照目录内只有 saveSnapshot 写入的 png 文件，无子目录）；目录不存在静默
// 返回 0；单文件删除失败跳过（不阻断任务删除）。返回删除的文件数。
function purgeTaskSnapshots(taskId) {
  if (!taskId || typeof taskId !== 'string') return 0;
  let dir;
  try { dir = safeJoinWithin(SNAP_DIR, taskId); } catch (e) { return 0; }
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return 0; } // 目录不存在 = 零文件，非错误
  let removed = 0;
  for (const f of files) {
    try { fs.unlinkSync(safeJoinWithin(SNAP_DIR, taskId, f)); removed++; } catch (e) {}
  }
  try { fs.rmdirSync(dir); } catch (e) {} // 空目录移除；非空/失败留着无害
  return removed;
}

module.exports = { saveSnapshot, listForTask, filePath, purgeTaskSnapshots, SNAP_DIR };

// 对外抛出路径校验错误，供路由层转换为 400（此前会冒泡成 500）。
module.exports.SAFE_PATH_ERROR_CODES = new Set(['UNSAFE_PATH_SEGMENT', 'PATH_ESCAPE']);
