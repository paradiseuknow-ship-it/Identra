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

// ---------------------------------------------------------------------------
// 环境确定性加固（PHASE 17-C，2026-09-11；**零断言改动**）
//
// 执行器环境的 TEMP/TMP 在后台任务 / 嵌套 shell 下并不确定（可能缺失或为 POSIX 形态），
// 而 os.tmpdir() 会因此回落到「可创建但不可列」的 %SystemRoot%\temp → esbuild 解析
// resolveDir 父目录时 Access is denied → 8 个 SSR/esbuild 套件整套假红
// （c70/c74/c78/c80/c81/c82/c87/c88）。**不是代码回归，是执行器环境非确定性。**
//
// 完整根因链、两次实证与踩坑记录见 `server/scripts/tmpEnvGuard.js` 头部注释。
// 这里只做一件事：**任何环境变量都不依赖**地把 TEMP/TMP 固定到可列目录。
// ---------------------------------------------------------------------------
const { ensureListableTemp } = require('./tmpEnvGuard');
const TMP_ENV = ensureListableTemp();

// 每个测试文件的超时上限（毫秒）。超时按失败计，避免 CI 被悬挂进程卡死。
const PER_TEST_TIMEOUT_MS = Number(process.env.REGRESSION_TIMEOUT_MS) || 180000;

// 每套件超时覆盖表。语义 = **防悬挂保险丝**（超时按失败计，避免卡死全量回归），
// 它**不参与**任何业务判定 —— 断言口径与它无关。
//
// ★ 跨层不变量（C119 建立并守护，`test_c119_suite_timeout_consistency.js`）：
//   执行器超时  >  该套件内部最大观测窗（`waitTaskTerminal(id, N)` 的 max N）
//   否则最长的那个内部窗**永远无法兑现** —— 断言还没等到终态，进程已被执行器杀掉，
//   报出来的形态从「假红（读到中间态）」退化成「套件被超时截断」，更难归因。
//
// 演进：
//   C108（2026-09-10）mock plan strict 契约修复后 runtime REPLAN 真实可用，step22 受控失败
//     注入场景（F1）恢复链实测 193.4s 到 HUMAN_ESCALATION（C79 曾 4/4 复现 200–260s 击穿旧
//     180s 全局窗）→ suite 总时长 ~70–94s 升至 ~250–280s。设 480000。
//     **当时成立**：F1 观测窗 300s < 执行器 480s ✓（重基线证据 .benchmark/c108_step22_run*.log）
//   C118（2026-09-13）F1 观测窗 300s → 600s（余量塌缩修复）。
//     ✗ **但不变量未同步**：480s < 600s ⇒ 若 F1 链长落在 480–600s 区间，断言本会绿，
//     却先被执行器杀掉 —— C118 的修复在该区间**完全无法兑现**。同一类「阈值余量不足」
//     缺陷在新阈值上重演（C116 实测 267.9–305.6s → C117 377.6s，距 480s 仅 ~27%）。
//   C119（本批次）重基线 480000 → 720000：= 最大内部窗 600s + 120s（站点启动 + A/C/E/F2
//     区典型耗时 + 负载波动余量），且 ≤ 2× 最大内部窗（1200s）防真悬挂拖死全量回归。
//     720s / 实测套件最大耗时 377.6s（C117）= 1.91× 余量。
//     **断言口径零变化**：只放宽保险丝，不放松任何判定。
const PER_TEST_TIMEOUT_OVERRIDES = {
  'test_step22_business_e2e.js': Number(process.env.REGRESSION_TIMEOUT_STEP22_MS) || 720000,
  // 注：testAgentPhase22.js 于 C135 晋升入集，初版曾按其 §A 观测值 146s 设 300s 保险丝；
  // 修掉过时断言后实测仅 8.2s（146s 的构成是**旧断言等满 90s 观测窗**，非真实耗时），
  // 其内部窗 90s < 全局 180s ⇒ 按 C119 不变量无需 override，故不登记。
  // 保险丝表只放有实测依据的条目，避免超时参数族被"顺手加一项"污染。
  //
  // C140：testAgentPhase23.js 晋升入集，实测总时长 **164s**（含 4 个 120s 观测窗，绿路径提前返回），
  // 对全局保险丝 180s 仅 **1.10×** —— 与 C118「300s 观测窗余量塌缩」是**同一形态换了一层**：
  // 余量不足时被执行器 SIGTERM，表现为假红，且每次假红都要烧一轮全量复跑证清白。
  // 按 C119 不变量核对：套件内部最大观测窗 120s < 180s ⇒ 不变量成立，但**总时长**逼近保险丝
  // 属于同一参数族的另一条轴，C119 的横向检查（只比「窗 vs 超时」）结构上看不到它。
  // ⇒ 登记 override = 300s（1.83× 实测、2.5× 单窗；**仅放宽保险丝**，观测窗与断言一字未动，
  //    超时不参与业务判定）。
  // 同批按同一判据核过其余同族套件（C140 修复后实测）：Phase5 72s（180/72 = 2.5×）、
  // Phase22 100s（1.8×）、Phase31 27s（6.7×）⇒ 余量充足，均**不登记**。
  // ★ Phase23 修复后实测 **184s > 180s**：不加 override 就会被执行器 SIGTERM（本条即为此设）。
  'testAgentPhase23.js': Number(process.env.REGRESSION_TIMEOUT_PHASE23_MS) || 300000,
};

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
// --list：只打印扫描面划分（候选 / 入集 / 登记排除）后退出，不执行任何套件。
// 供 test_c135_regression_scope.js 消费 —— 守护测试**不得**自行复刻扫描规则
// （那正是本批次修掉的缺陷形态：执行器与本守护长期各持一份规则，任一侧漂移即静默少覆盖）。
const LIST = argv.includes('--list');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

// ---------------------------------------------------------------------------
// 扫描范围（★ C135 收口到唯一事实源 server/scripts/suiteScope.js）
//
//   候选 = 任何 test 开头的 .js（server/scripts + 仓库根）—— 覆盖面不允许有黑洞
//   入集 = 候选 − server/scripts/EXCLUDED_SUITES.json 登记的排除项
//
// 旧实现：本文件内联 `/^test_.*\.js$/`，注释却自称「维护中的套件」—— 两者**语义不等价**。
// 真实入集前提是「已做数据根隔离、可在无 server 的执行器下安全并跑」。旧规则因此静默漏掉
// 21 个真实套件（红灯不可见），而这 21 项**全部**未做数据根隔离（19 项直接写真实
// server/data，testAgentPhase32 的 clean() 会清空 aiElementMemory/aiFlowMemory/aiSiteMemory）
// ⇒ 盲目放宽规则引入的是数据破坏，而不是覆盖率提升。现把语义显式化：差集必须逐项登记。
// 同一规则曾在本文件与 test_c119_suite_timeout_consistency.js 各存一份复刻，已一并收口。
// ---------------------------------------------------------------------------
const suiteScope = require('./suiteScope');

function listTestFiles() {
  const files = suiteScope.listTestFiles();
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
    // C135：`[:=]` 改为可选 —— testAgent* 族用 `PASS 32 / FAIL 1`（数字在后），
    // 旧式 `PASS[:=]\d+` 认不出，导致晋升入集的 11 个套件在汇总列恒显「(无统计行)」，
    // 与「红灯必须可信 / 缺口不能隐身」同因：可读性缺口会让绿灯看起来像异常。
    // 仅影响展示列，不参与任何判定。
    /PASS\s*[:=]?\s*\d+/i,
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
const excluded = suiteScope.excludedSuites();

// --list：把扫描面的三划分交给守护测试（结构化、一行一项），不做任何执行。
if (LIST) {
  for (const s of suiteScope.collectCandidates()) console.log('CANDIDATE ' + s.label);
  for (const s of files) console.log('RUN ' + s.label);
  for (const s of excluded) console.log('EXCLUDED ' + s.label);
  process.exit(0);
}

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
  + '，候选 ' + (files.length + excluded.length) + ' 个'
  + (excluded.length ? '（其中 ' + excluded.length + ' 个已登记排除）' : '')
  + (Object.keys(knownGaps).length ? '，已登记缺口 ' + Object.keys(knownGaps).length + ' 项' : ''));
console.log('临时目录：' + TMP_ENV.dir + (TMP_ENV.changed ? '（已从不「可列」目录加固，见 ensureListableTemp）' : ''));
// 「差异不能隐身」：登记排除的候选套件每次运行都打印出来（不执行、不算失败），
// 与 KNOWN_GAPS 同哲学 —— 扫描面缺口必须可见，但不应伪装成红灯。
if (excluded.length) {
  console.log('已登记排除 ' + excluded.length + ' 个候选套件（不执行；逐条理由见 server/scripts/EXCLUDED_SUITES.json）：');
  for (const s of excluded) {
    console.log('  ⊘ ' + s.label.padEnd(30) + (s.meta.追踪 || '').padEnd(12) + (s.meta.归类 || ''));
  }
}
console.log('─'.repeat(96));

for (const { file, label } of files) {
  const base = path.basename(file);
  const started = Date.now();
  const timeoutMs = PER_TEST_TIMEOUT_OVERRIDES[base] || PER_TEST_TIMEOUT_MS;
  const res = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  const elapsed = Date.now() - started;
  const log = ((res.stdout || '') + (res.stderr || '')).trimEnd();

  fullLog.push('\n' + '─'.repeat(20) + ' ' + label + ' ' + '─'.repeat(20) + '\n' + log + '\n');

  const timedOut = res.error && /ETIMEDOUT|timed out/i.test(String(res.error.message || res.error));
  const code = timedOut ? 124 : (res.status == null ? 1 : res.status);
  const summary = timedOut ? ('超时 >' + Math.round(timeoutMs / 1000) + 's') : pickSummary(log);

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
