'use strict';
// 跨平台回归执行器 —— npm test 的入口。
//
// 为什么用 Node 而不是 shell 脚本：
//   run_phase9_regression.sh 依赖 bash，而 Windows 下 npm 默认用 cmd.exe 执行 scripts，
//   `npm test` 会直接失败。用 Node 写执行器 → 全平台一致，且不再硬编码 node 绝对路径。
//
// 设计原则：
//   1. **红灯必须可信**。套件里不允许有"一直红"的文件 —— 那会训练所有人忽略红灯。
//      因此取证型测试（依赖历史数据集）已改为 SKIP 守卫，真实能力缺口登记在
//      KNOWN_GAPS.json 并单独归类。
//   2. **缺口不能隐身**。KNOWN_GAPS 里的文件照跑，失败时打印为「已知缺口」而非静默通过；
//      若哪天它自己变绿，执行器会提示"已修复，请从 KNOWN_GAPS.json 移除"。
//   3. 未登记的任何失败 → 退出码 1 → CI 变红。
//
// 用法：
//   node server/scripts/runRegression.js             # 跑全部
//   node server/scripts/runRegression.js --verbose   # 打印每个文件的完整输出
//   node server/scripts/runRegression.js --only phase9 # 只跑文件名含 phase9 的

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ROOT, 'server', 'scripts');
const OUT_DIR = path.join(ROOT, '.benchmark');

// 每个测试文件的超时上限（毫秒）。超时按失败计，避免 CI 被悬挂进程卡死。
const PER_TEST_TIMEOUT_MS = Number(process.env.REGRESSION_TIMEOUT_MS) || 180000;

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

// ---------------------------------------------------------------------------
// 扫描范围：server/scripts/test_*.js（维护中的套件）+ 根目录 test_*.js（历史探针）
// ---------------------------------------------------------------------------
function listTestFiles() {
  const files = [];
  const scan = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!/^test_.*\.js$/.test(name)) continue;
      files.push({ file: path.join(dir, name), label: prefix + name });
    }
  };
  scan(SCRIPTS_DIR, 'server/scripts/');
  scan(ROOT, '');
  return ONLY ? files.filter((f) => f.label.includes(ONLY)) : files;
}

// ---------------------------------------------------------------------------
// 已知能力缺口登记（不阻塞退出码，但必须可见、可追踪）
// ---------------------------------------------------------------------------
const GAPS_FILE = path.join(__dirname, 'KNOWN_GAPS.json');
function loadKnownGaps() {
  try {
    const j = JSON.parse(fs.readFileSync(GAPS_FILE, 'utf8'));
    const m = {};
    for (const g of (j.gaps || [])) m[path.basename(g.file)] = g;
    return m;
  } catch (e) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 从输出里抓统计行（兼容三种既有风格 + 本仓特有的中文汇总）
// ---------------------------------------------------------------------------
function pickSummary(log) {
  const lines = log.split('\n');
  const patterns = [
    /PASS[:=]\s*\d+/i,
    /\d+\s*(PASS|通过)/i,
    /结果[:：]\s*\d+\s*通过/i,
    /全部通过|ALL PASS/i,
  ];
  for (const re of patterns) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (re.test(lines[i])) return lines[i].trim().slice(0, 60);
    }
  }
  return '(无统计行)';
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
const knownGaps = loadKnownGaps();
const files = listTestFiles();

if (!files.length) {
  console.error('未找到任何测试文件');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const logPath = path.join(OUT_DIR, 'regression_' + Date.now() + '.log');
const fullLog = [];

const rows = [];
let okCount = 0, failCount = 0, gapCount = 0, fixedCount = 0, skipCount = 0;
const t0 = Date.now();

console.log('回归执行器：' + files.length + ' 个测试文件'
  + (ONLY ? '（过滤: ' + ONLY + '）' : '')
  + (Object.keys(knownGaps).length ? '，已登记缺口 ' + Object.keys(knownGaps).length + ' 项' : ''));
console.log('─'.repeat(96));

for (const { file, label } of files) {
  const base = path.basename(file);
  const started = Date.now();
  const res = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: PER_TEST_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  const elapsed = Date.now() - started;
  const log = ((res.stdout || '') + (res.stderr || '')).trimEnd();

  fullLog.push('\n' + '─'.repeat(20) + ' ' + label + ' ' + '─'.repeat(20) + '\n' + log + '\n');

  const timedOut = res.error && /ETIMEDOUT|timed out/i.test(String(res.error.message || res.error));
  const code = timedOut ? 124 : (res.status == null ? 1 : res.status);
  const summary = timedOut ? ('超时 >' + Math.round(PER_TEST_TIMEOUT_MS / 1000) + 's') : pickSummary(log);

  const skips = (log.match(/⊘ SKIP/g) || []).length;
  skipCount += skips;

  const gap = knownGaps[base];
  let verdict;
  if (code === 0) {
    if (gap) { verdict = 'GAP-FIXED'; fixedCount++; }
    else { verdict = 'OK'; okCount++; }
  } else {
    if (gap) { verdict = 'KNOWN-GAP'; gapCount++; }
    else { verdict = 'FAIL'; failCount++; }
  }

  rows.push({ label, verdict, code, elapsed, summary, skips });
  const mark = { OK: '✓', 'KNOWN-GAP': '⊗', 'GAP-FIXED': '★', FAIL: '✗' }[verdict];
  console.log(
    mark + ' ' + verdict.padEnd(10) +
    label.padEnd(46) +
    String((elapsed / 1000).toFixed(1) + 's').padStart(7) +
    (skips ? ('  skip:' + skips).padStart(9) : ' '.repeat(9)) +
    '  ' + summary
  );
  if (VERBOSE) console.log(log.split('\n').map((l) => '      ' + l).join('\n'));
}

const total = ((Date.now() - t0) / 1000).toFixed(1);

console.log('─'.repeat(96));
console.log('通过 ' + okCount + '   失败 ' + failCount + '   已知缺口 ' + gapCount
  + '   缺口已修复 ' + fixedCount + '   取证跳过 ' + skipCount + '   总耗时 ' + total + 's');

if (gapCount) {
  console.log('\n已知能力缺口（不阻塞 CI，但必须在路线图中排期）：');
  for (const r of rows) {
    if (r.verdict !== 'KNOWN-GAP') continue;
    const g = knownGaps[path.basename(r.label)];
    console.log('  ⊗ ' + r.label);
    console.log('      ' + (g && g.断言 ? g.断言 : ''));
    if (g && g.业务影响) console.log('      影响: ' + g.业务影响);
    if (g && g.追踪) console.log('      追踪: ' + g.追踪 + '（' + (g.归类 || '未定级') + '）');
  }
}
if (fixedCount) {
  console.log('\n★ 下列已登记缺口现在通过了 —— 请从 server/scripts/KNOWN_GAPS.json 移除对应条目：');
  for (const r of rows) if (r.verdict === 'GAP-FIXED') console.log('  ★ ' + r.label);
}
if (failCount) {
  console.log('\n失败文件（阻塞 CI）：');
  for (const r of rows) if (r.verdict === 'FAIL') console.log('  ✗ ' + r.label + '  ' + r.summary);
}

fs.writeFileSync(logPath, fullLog.join('\n'), 'utf8');
console.log('\n完整日志: ' + path.relative(ROOT, logPath));

process.exit(failCount ? 1 : 0);
