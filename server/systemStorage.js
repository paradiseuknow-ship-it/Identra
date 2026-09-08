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

// C51：excludeTop —— 只跳过 dir 第一层下指定名称的子目录（整棵剪枝）。
// 用途：collections 统计 data 目录时排除 profiles 子目录，消除与 profiles 项的双重计数。
async function dirSize(dir, { excludeTop = [] } = {}) {
  let bytes = 0, files = 0, truncated = false;
  const excludeSet = new Set(excludeTop);
  const stack = [{ dir, top: true }];
  while (stack.length) {
    const { dir: cur, top } = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (files > MAX_ENTRIES) { truncated = true; return { bytes, files, truncated }; }
      if (top && e.isDirectory() && excludeSet.has(e.name)) continue; // C51：第一层整棵剪枝
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push({ dir: p, top: false }); continue; }
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

// insideBoundary：防逃逸边界跟随注入的清理根（测试注入 tmp 时边界=tmp，默认=项目根内标准目录）
function insideBoundary(p, boundary) {
  const b = path.resolve(boundary || ROOT);
  const r = path.resolve(p);
  return r === b || r.startsWith(b + path.sep);
}

// 收集存储统计（带缓存）
// C51：dirs 可注入（守护测试 tmp 隔离）；collections 项 excludeTop 排除 profiles，
//   修复「collections 统计整个 data（含 data/profiles）→ 与 profiles 项双重计数」的展示缺陷
//   （label 一直写的是「data 其余」，实现此前与口径不符）。
async function collectStats({ force = false, dirs = {} } = {}) {
  if (!force && statsCache && Date.now() - statsCache.at < CACHE_TTL_MS) return statsCache.items;
  const defs = [
    { key: 'benchmark', label: '回归日志与取证（.benchmark）', dir: dirs.benchmark || path.join(ROOT, '.benchmark') },
    { key: 'profiles', label: '浏览器用户数据（data/profiles）', dir: dirs.profiles || path.join(ROOT, 'data', 'profiles') },
    { key: 'collections', label: '业务数据集合（data 其余）', dir: dirs.collections || path.join(ROOT, 'data'), excludeTop: ['profiles'] },
    { key: 'dist', label: '前端构建产物（client/dist）', dir: dirs.dist || path.join(ROOT, 'client', 'dist') },
  ];
  const items = [];
  for (const d of defs) {
    let stat = { bytes: 0, files: 0, truncated: false };
    const exists = fs.existsSync(d.dir);
    if (exists) {
      try { stat = await dirSize(d.dir, { excludeTop: d.excludeTop }); } catch { /* 目录不可读按 0 处理 */ }
    }
    items.push({ key: d.key, label: d.label, dir: d.dir, exists, ...stat });
  }
  statsCache = { at: Date.now(), items };
  return items;
}

// ---- cleanup ----
// benchmarkLogs：.benchmark 下 *.log 与 phase9_regression_*.txt；保留最近 keepRecent 个 log + 全部 *.md 报告
async function cleanupBenchmarkLogs({ olderThanDays = 7, keepRecent = 3, benchDir } = {}) {
  const dir = benchDir || path.join(ROOT, '.benchmark'); // benchDir 可注入（守护测试 tmp 隔离，不消耗宿主删除配额）
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
// C63 D2（B 类）：isRunning 是安全关键参数——缺失时老实现「typeof !== 'function' 就当
// 全部未运行」= 危险默认方向反了（运行中 profile 目录会被列入清理候选，dryRun=false
// 时 rm 正在使用的 Chromium 用户数据 = 浏览器数据损坏）。现在 fail-closed：未注入
// 判定函数时拒绝列出任何候选（宁可漏删，不可误删）。
async function cleanupBrowserProfiles({ isRunning, profilesDir } = {}) {
  const dir = profilesDir || path.join(ROOT, 'data', 'profiles'); // profilesDir 可注入（同上）
  if (!fs.existsSync(dir)) return { candidates: [], kept: [] };
  if (typeof isRunning !== 'function') {
    return { candidates: [], kept: [], skipped: 'isRunning not provided: fail-closed (refusing to list profiles without a liveness check)' };
  }
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
// C51：olderThanDays / keepRecent 参数硬化 —— NaN/负数/非整数一律回落保守默认（7 / 3，保留更多）。
//   缺陷背景：keepRecent 负数会让 slice 语义反转（candidates 取到最旧 N 条当清理对象、
//   kept 反而保留其余），路由层 Number()||default 只挡 NaN 挡不住负数 → 在库级钳制。
async function cleanup({ targets = [], olderThanDays = 7, keepRecent = 3, dryRun = true, isRunning, benchDir, profilesDir } = {}) {
  const otd = Number(olderThanDays);
  const kr = Number(keepRecent);
  olderThanDays = Number.isFinite(otd) && otd >= 0 ? Math.floor(otd) : 7;
  keepRecent = Number.isFinite(kr) && kr >= 0 ? Math.floor(kr) : 3;
  const plan = [];
  let freed = 0;
  for (const t of targets) {
    const def = CLEANUP_TARGETS[t];
    if (!def) return { ok: false, error: '未知清理目标: ' + t + '（允许: ' + Object.keys(CLEANUP_TARGETS).join(', ') + '）' };
    const { candidates, kept } = await def.run({ olderThanDays, keepRecent, isRunning, benchDir, profilesDir });
    const boundary = t === 'benchmarkLogs' ? (benchDir || path.join(ROOT, '.benchmark'))
      : t === 'browserProfiles' ? (profilesDir || path.join(ROOT, 'data', 'profiles'))
      : ROOT;
    for (const c of candidates) {
      if (!insideBoundary(c.path, boundary)) continue; // 防逃逸：越界路径直接跳过
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

module.exports = { collectStats, cleanup, CLEANUP_TARGETS, insideRoot, insideBoundary, dirSize, resetCacheForTests };
