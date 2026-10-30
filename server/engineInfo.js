'use strict';
// C194：浏览器内核（本机 Google Chrome / Chromium）版本检测与更新。
//
// 背景（2026-10-30 用户提问）：产品此前**完全没有内核版本概念** —— 只用硬编码路径的本机 Chrome，
// 既不知道当前内核版本相对官方稳定版是否落后，也没有任何更新入口。
// 内核版本落后的代价不是"功能少"，而是**指纹自相矛盾**：
//   · UA / Sec-CH-UA / navigator.userAgentData 被对齐到本机引擎版本（C30/C194），
//     引擎旧 ⇒ UA 也旧 ⇒ 与真实流量分布脱节（旧版本 Chrome 占比过低本身就是特征）；
//   · 站点侧新特性探测（新 API 存在性、Codec 支持）与旧引擎对不上；
//   · 反检测厂商会用「引擎补丁号 vs TLS/JA3 特征」交叉验证。
//
// 设计要点：
//   ① 真相源唯一：当前版本只从 browserManager.getChromeVersion() 取（同一条 UA 对齐链路），
//      本模块不另起一套 powershell/PE 解析。
//   ② 最新版本只查官方数据源（Chrome for Testing last-known-good / Chromium Dash），
//      绝不下载、绝不执行第三方二进制。
//   ③ 定期检测：进程内定时器（默认 24h）+ 状态文件 TTL（12h），启动 30s 后首检；
//      检测失败**不缓存失败**为"最新"，只记录 error 供 UI 显示，避免把网络故障伪装成"已最新"。
//   ④ 更新的可执行动作：调用系统自带的 Google Update（官方更新器），不自行下载安装包。

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { dataRoot } = require('./dataRoot');

const CHECK_INTERVAL_MS = Number(process.env.FPB_ENGINE_CHECK_INTERVAL_MS) || 24 * 60 * 60 * 1000;
const STATE_TTL_MS = Number(process.env.FPB_ENGINE_STATE_TTL_MS) || 12 * 60 * 60 * 1000;

// 官方数据源（按顺序回退）。两者都是 Google 官方发布物：
// chrome-for-testing 是 CfT 文档站（快、稳定）；chromiumdash 是 Chromium 官方发布看板（偶尔慢）。
const SOURCES = [
  {
    name: 'chrome-for-testing',
    url: 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json',
    pick: (d) => (d && d.channels && d.channels.Stable && d.channels.Stable.version) || null,
  },
  {
    name: 'chromiumdash',
    url: 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1',
    pick: (d) => (Array.isArray(d) && d[0] && d[0].version) || null,
  },
];

// Windows 官方更新器候选路径（存在即用，绝不下载）
const GOOGLE_UPDATE_CANDIDATES = [
  'C:/Program Files (x86)/Google/Update/GoogleUpdate.exe',
  'C:/Program Files/Google/Update/GoogleUpdate.exe',
];

function fetchJsonUrl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs || 8000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 512 * 1024) { req.destroy(new Error('response too large')); } });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('invalid json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function runGoogleUpdate() {
  const exe = GOOGLE_UPDATE_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!exe) {
    return Promise.resolve({
      ok: false,
      error: '未找到 Google Update（GoogleUpdate.exe）。请手动打开 chrome://settings/help 触发更新。',
      via: null,
    });
  }
  return new Promise((resolve) => {
    // /ua = update all（官方更新器参数），/installsource scheduler = 走计划任务来源
    execFile(exe, ['/ua', '/installsource', 'scheduler'], { timeout: 30000, windowsHide: true }, (err) => {
      if (err) return resolve({ ok: false, error: String(err.message || err).slice(0, 200), via: exe });
      resolve({ ok: true, error: null, via: exe });
    });
  });
}

let deps = {
  getCurrentVersion: () => require('./browserManager').getChromeVersion(),
  chromePath: () => require('./browserManager').SYSTEM_CHROME,
  invalidateVersionCache: () => require('./browserManager').invalidateChromeVersionCache(),
  fetchJson: fetchJsonUrl,
  runUpdate: runGoogleUpdate,
};

function __setDepsForTest(d) { deps = Object.assign({}, deps, d || {}); }
function __resetDepsForTest() {
  deps = {
    getCurrentVersion: () => require('./browserManager').getChromeVersion(),
    chromePath: () => require('./browserManager').SYSTEM_CHROME,
    invalidateVersionCache: () => require('./browserManager').invalidateChromeVersionCache(),
    fetchJson: fetchJsonUrl,
    runUpdate: runGoogleUpdate,
  };
}

function stateFile() { return path.join(dataRoot(), 'engine-status.json'); }

function readState() {
  try {
    const p = stateFile();
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return d && typeof d === 'object' ? d : null;
  } catch (e) { return null; }
}

function writeState(state) {
  try {
    const p = stateFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.warn('[engine] 状态写入失败(忽略):', e.message);
    return false;
  }
}

function parseVer(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

// 版本落差分级：patch（补丁，安全修复）< build（构建号，通常等同一次小版本）< major（大版本，功能+检测面变化）
function compareVersions(current, latest) {
  const a = parseVer(current);
  const b = parseVer(latest);
  if (!a || !b) return { level: 'unknown', outdated: null, behind: null };
  if (a[0] === b[0] && a[2] === b[2] && a[3] === b[3]) {
    return { level: 'up-to-date', outdated: false, behind: { major: 0, build: 0, patch: 0 } };
  }
  let level;
  if (a[0] !== b[0]) level = 'major';
  else if (a[2] !== b[2]) level = 'build';
  else level = 'patch';
  return {
    level,
    outdated: true,
    behind: {
      major: Math.max(0, b[0] - a[0]),
      build: a[0] === b[0] ? Math.max(0, b[2] - a[2]) : null,
      patch: Math.max(0, b[3] - a[3]),
    },
  };
}

async function fetchLatest() {
  let lastErr = null;
  for (const s of SOURCES) {
    try {
      const data = await deps.fetchJson(s.url, 8000);
      const v = s.pick(data);
      if (v && parseVer(v)) return { version: v, source: s.name };
      lastErr = new Error(s.name + ' 返回内容无版本号');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有内核版本数据源均不可达');
}

function buildStatus(state) {
  const cur = (() => { try { return deps.getCurrentVersion(); } catch (e) { return null; } })();
  const latest = (state && state.latest) || null;
  const cmp = compareVersions(cur, latest);
  const chromePath = (() => { try { return deps.chromePath(); } catch (e) { return null; } })();
  return {
    current: cur,
    chromePath,
    chromeExists: chromePath ? (() => { try { return fs.existsSync(chromePath); } catch (e) { return false; } })() : false,
    latest,
    source: (state && state.source) || null,
    checkedAt: (state && state.checkedAt) || null,
    level: cmp.level,
    outdated: cmp.outdated,
    behind: cmp.behind,
    error: (state && state.error) || null,
    update: (state && state.update) || null,
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}

// 强制联网检测并落盘。失败**不覆盖**上次的 latest（避免一次网络抖动把"最新版"清空），
// 只记录 error，让 UI 能区分「不知道」与「已是最新」。
async function checkNow() {
  const prev = readState() || {};
  const cur = (() => { try { return deps.getCurrentVersion(); } catch (e) { return null; } })();
  let latest = null; let source = null; let error = null;
  try {
    const r = await fetchLatest();
    latest = r.version; source = r.source;
  } catch (e) {
    error = String(e.message || e).slice(0, 200);
    latest = prev.latest || null;
    source = prev.source || null;
  }
  const state = {
    latest,
    source,
    error,
    checkedAt: error ? (prev.checkedAt || null) : Date.now(),
    lastAttemptAt: Date.now(),
    currentAtCheck: cur,
    update: prev.update || null,
  };
  writeState(state);
  return buildStatus(state);
}

// 读缓存优先（避免每次打开设置页都打网络）；force=true 强制检测。
async function getStatus(opts) {
  const o = opts || {};
  const state = readState();
  const fresh = !!(state && state.checkedAt && (Date.now() - state.checkedAt) < STATE_TTL_MS);
  if (!o.force && fresh) return buildStatus(state);
  return checkNow();
}

async function triggerUpdate() {
  const state = readState() || {};
  const r = await deps.runUpdate();
  const rec = { lastAttemptAt: Date.now(), ok: !!r.ok, error: r.error || null, via: r.via || null };
  writeState(Object.assign({}, state, { update: rec }));
  if (rec.ok) {
    try { deps.invalidateVersionCache(); } catch (e) {}
  }
  return rec;
}

// 定期检测：启动 30s 后首检（不与启动链抢资源），随后按间隔循环。
// 定时器 unref ⇒ 绝不阻止进程退出（避免"关了服务进程还挂着"）。
let timer = null;
let firstTimer = null;
function startScheduler() {
  if (process.env.FPB_DISABLE_ENGINE_CHECK === '1') return false;
  if (firstTimer || timer) return true;
  firstTimer = setTimeout(() => {
    firstTimer = null;
    checkNow().catch((e) => console.warn('[engine] 定期检测失败(忽略):', String(e.message || e).slice(0, 160)));
  }, 30000);
  if (firstTimer.unref) firstTimer.unref();
  timer = setInterval(() => {
    checkNow().catch((e) => console.warn('[engine] 定期检测失败(忽略):', String(e.message || e).slice(0, 160)));
  }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return true;
}

function stopScheduler() {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  getStatus,
  checkNow,
  triggerUpdate,
  startScheduler,
  stopScheduler,
  compareVersions,
  parseVer,
  __setDepsForTest,
  __resetDepsForTest,
  SOURCES,
  GOOGLE_UPDATE_CANDIDATES,
};
