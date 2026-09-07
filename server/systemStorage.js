'use strict';
// C47 —— 存储使用与清理治理。
// 背景：data/profiles（Chromium 用户数据）与 .benchmark（回归日志/取证）持续增长，
//   无任何可见性也无清理路径——磁盘占用失控只能靠手工。
// 设计：
//   collectStats(): 统计各目录体积（并发受控、结果缓存 5 分钟，统计期间不阻塞其它请求）
//   cleanup(): 白名单清理（benchmarkLogs / browserProfiles），dryRun 默认 true，
//     路径 resolve 后强制限制在项目根内（防逃逸），运行中 profile 一律跳过。
// 红线：不触碰 data 下的业务集合 JSON（aiTasks 等），仅白名单两类。

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 80000; // 单目录统计条目上限（防失控遍历）

let statsCache = null; // { at, items }

async function dirSize(dir) {
  let bytes = 0, files = 0, truncated = false;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (files > MAX_ENTRIES) { truncated = true; return { bytes, files, truncated }; }
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (e.isSymbolicLink()) continue;
      try { const st = await fsp.stat(p); bytes += st.size; files += 1; } catch { /* raced */ }
    }
  }
  return { bytes, files, truncated };
}

// insideRoot：resolve 后必须仍在项目根内（防路径逃逸）
function insideRoot(p) {
  const r = path.resolve(p);
  return r === ROOT || r.startsWith(ROOT + path.sep);
}

// 收集存储统计（带缓存）
async function collectStats({ force = false } = {}) {
  if (!force && statsCache && Date.now() - statsCache.at < CACHE_TTL_MS) return statsCache.items;
  const defs = [
    { key: 'benchmark', label: '回归日志与取证（.benchmark）', dir: path.join(ROOT, '.benchmark') },
    { key: 'profiles', label: '浏览器用户数据（data/profiles）', dir: path.join(ROOT, 'data', 'profiles') },
    { key: 'collections', label: '业务数据集合（data 其余）', dir: path.join(ROOT, 'data') },
    { key: 'dist', label: '前端构建产物（client/dist）', dir: path.join(ROOT, 'client', 'dist') },
  ];
  const items = [];
  for (const d of defs) {
    let stat = { bytes: 0, files: 0, truncated: false };
    try {
      if (fs.existsSync(d.dir)) stat = await dirSize(d.dir);
    } catch { /* 目录不可读按 0 处理 */ }
    items.push({ ...d, exists: fs.existsSync(d.dir), ...stat });
  }
  statsCache = { at: Date.now(), items };
  return items;
}

// ---- cleanup ----
// benchmarkLogs：.benchmark 下 *.log 与 phase9_regression_*.txt；保留最近 keepRecent 个 log + 全部 *.md 报告
async function cleanupBenchmarkLogs({ olderThanDays = 7, keepRecent = 3 } = {}) {
  const dir = path.join(ROOT, '.benchmark');
  if (!fs.existsSync(dir)) return { candidates: [], kept: [] };
  const cut = Date.now() - olderThanDays * 24 * 3600 * 1000;
  const entries = (await fsp.readdir(dir)).filter((f) => /\.log$/i.test(f) || /^phase9_regression_.*\.txt$/i.test(f));
  const withTime = [];
  for (const f of entries) {
    try { const st = await fsp.stat(path.join(dir, f)); withTime.push({ file: f, mtime: st.mtimeMs, size: st.size }); } catch { /* raced */ }
  }
  withTime.sort((a, b) => b.mtime - a.mtime);
  const kept = withTime.slice(0, keepRecent).map((x) => x.file); // 最近 N 个 log 永远保留
  const candidates = withTime
    .slice(keepRecent)
    .filter((x) => x.mtime < cut)
    .map((x) => ({ ...x, path: path.join(dir, x.file) }));
  return { candidates, kept };
}

// browserProfiles：未被运行会话持有的 profile 目录（isRunning 由调用方注入）
async function cleanupBrowserProfiles({ isRunning }) {
  const dir = path.join(ROOT, 'data', 'profiles');
  if (!fs.existsSync(dir)) return { candidates: [], kept: [] };
  const candidates = [], kept = [];
  for (const name of await fsp.readdir(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = await fsp.stat(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (typeof isRunning === 'function' && isRunning(name)) { kept.push(name); continue; }
    const size = await dirSize(p);
    candidates.push({ file: name, path: p, size: size.bytes, mtime: st.mtimeMs });
  }
  return { candidates, kept };
}

const CLEANUP_TARGETS = {
  benchmarkLogs: { label: '回归日志（.benchmark *.log / phase9_*.txt）', run: cleanupBenchmarkLogs },
  browserProfiles: { label: '未运行 profile 的浏览器用户数据（data/profiles）', run: cleanupBrowserProfiles },
};

// 执行清理；dryRun 默认 true（只统计不删除）
async function cleanup({ targets = [], olderThanDays = 7, keepRecent = 3, dryRun = true, isRunning } = {}) {
  const plan = [];
  let freed = 0;
  for (const t of targets) {
    const def = CLEANUP_TARGETS[t];
    if (!def) return { ok: false, error: '未知清理目标: ' + t + '（允许: ' + Object.keys(CLEANUP_TARGETS).join(', ') + '）' };
    const { candidates, kept } = await def.run({ olderThanDays, keepRecent, isRunning });
    for (const c of candidates) {
      if (!insideRoot(c.path)) continue; // 防逃逸：越界路径直接跳过
      freed += c.size || 0;
      if (!dryRun) {
        await fsp.rm(c.path, { recursive: true, force: true });
      }
      plan.push({ target: t, file: c.file, size: c.size || 0, removed: !dryRun });
    }
  }
  statsCache = null; // 清理后强制重新统计
  return { ok: true, dryRun, freed, count: plan.length, plan };
}

function resetCacheForTests() { statsCache = null; }

module.exports = { collectStats, cleanup, CLEANUP_TARGETS, insideRoot, dirSize, resetCacheForTests };
