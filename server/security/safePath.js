'use strict';

// 路径安全：所有用户可控路径段必须先过白名单，再在指定根目录内解析。
// STEP 0.5 §2.2 —— 此前 evidence.filePath() 直接 path.join(SNAP_DIR, taskId, file)，
//   file 取自 URL 且零校验，`../../` 可穿越到任意目录（配合 sendFile 可远程拖库）。
//
// 使用约定：
//   1. 每个来自 req.params / req.body / req.query 的路径段，先过 assertSafeName()。
//   2. 拼接后必须过 resolveWithin()，确保规范化结果仍在根目录内。

const path = require('path');

// 安全段名：字母数字开头，只允许 . _ - ，长度 1..128。
// 不含 `/` `\` `:` 与 `..`，因此段级别已排除穿越与 Windows 盘符/UNC。
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeName(name, label) {
  const s = String(name == null ? '' : name);
  if (!s || s.length > 128 || s === '.' || s === '..' || !SAFE_NAME_RE.test(s)) {
    const err = new Error(
      `不安全的路径段 (${label || 'name'}): ${JSON.stringify(s).slice(0, 80)}`
    );
    err.code = 'UNSAFE_PATH_SEGMENT';
    err.statusCode = 400;
    throw err;
  }
  return s;
}

// 在 root 内解析 segments。任何逃逸（../、绝对段、盘符）一律抛错。
function resolveWithin(root, ...segments) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, ...segments.map((s) => String(s == null ? '' : s)));
  const rel = path.relative(rootAbs, target);
  // rel 为空表示 target === root（目录本身，允许）；否则不得向上逃逸也不得是绝对形式。
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('路径逃逸被拒绝（path traversal）');
    err.code = 'PATH_ESCAPE';
    err.statusCode = 400;
    throw err;
  }
  return target;
}

// 组合：先逐段白名单校验，再在根内解析。
function safeJoinWithin(root, ...segments) {
  segments.forEach((s, i) => assertSafeName(s, 'segment[' + i + ']'));
  return resolveWithin(root, ...segments);
}

// 写入侧使用：把任意内部标识（stepId / label 等）规整成安全段名。
// 与 assertSafeName 的区别：这里不抛错，而是替换非法字符，避免业务因命名问题静默失败。
function sanitizeSegment(s) {
  const out = String(s == null ? '' : s)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, 100);
  if (!out || out === '.' || out === '..') return 'unnamed';
  // 首位必须是字母数字
  return /^[A-Za-z0-9]/.test(out) ? out : 's_' + out;
}

function isSafeName(name) {
  try {
    assertSafeName(name);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { assertSafeName, resolveWithin, safeJoinWithin, sanitizeSegment, isSafeName, SAFE_NAME_RE };
