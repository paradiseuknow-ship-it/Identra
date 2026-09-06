'use strict';

// Evidence / Snapshot：关键节点保存页面截图（before_action / after_action / verification_failed）。
// 存储：data/evidence/snapshots/<taskId>/<stepId>_<label>_<ts>.png
// 未来自愈必须依赖这些证据。

const fs = require('fs');
const path = require('path');
const { safeJoinWithin, sanitizeSegment } = require('../security/safePath');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'evidence', 'snapshots');

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

module.exports = { saveSnapshot, listForTask, filePath, SNAP_DIR };

// 对外抛出路径校验错误，供路由层转换为 400（此前会冒泡成 500）。
module.exports.SAFE_PATH_ERROR_CODES = new Set(['UNSAFE_PATH_SEGMENT', 'PATH_ESCAPE']);
