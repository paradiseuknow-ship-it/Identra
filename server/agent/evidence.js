'use strict';

// Evidence / Snapshot：关键节点保存页面截图（before_action / after_action / verification_failed）。
// 存储：data/evidence/snapshots/<taskId>/<stepId>_<label>_<ts>.png
// 未来自愈必须依赖这些证据。

const fs = require('fs');
const path = require('path');

const SNAP_DIR = path.join(__dirname, '..', '..', 'data', 'evidence', 'snapshots');

async function saveSnapshot(page, taskId, stepId, label) {
  if (!page) return null;
  try {
    const dir = path.join(SNAP_DIR, String(taskId));
    fs.mkdirSync(dir, { recursive: true });
    const file = `${stepId || 'step'}_${label}_${Date.now()}.png`;
    await page.screenshot({ path: path.join(dir, file) });
    return file;
  } catch (e) {
    return null;
  }
}

function listForTask(taskId) {
  const dir = path.join(SNAP_DIR, String(taskId));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((file) => ({ file, taskId, url: '/api/ai/snapshots/' + taskId + '/' + encodeURIComponent(file) }));
}

function filePath(taskId, file) {
  return path.join(SNAP_DIR, String(taskId), file);
}

module.exports = { saveSnapshot, listForTask, filePath, SNAP_DIR };
