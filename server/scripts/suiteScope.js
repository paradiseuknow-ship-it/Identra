'use strict';

// 回归套件扫描面 —— **唯一事实源**（C135 建立）。
//
// 为什么需要它：
//   扫描规则此前在本文件之外存在**两份复刻** —— runRegression.js（执行器）与
//   test_c119_suite_timeout_consistency.js（跨层超时不变量）各自内联
//   `/^test_.*\.js$/`。任一侧改动都会让另一侧静默少覆盖，且没有任何断言能发现。
//
// 语义澄清（C135 §A 实测结论）：
//   「入集」的真实前提**不是**「文件名以 test_ 开头」，而是
//   **「已做数据根隔离、可在无 server 的执行器下安全并跑」**。
//   旧规则把 testAgent*.js / testMemoryIsolation.js / testWorkerIsolation.js 共 21 个真实套件
//   静默排除在外，而这 21 项**全部**未做数据根隔离 —— 19 项直接写真实 server/data
//   （testAgentPhase32 的 clean() 会清空 aiElementMemory / aiFlowMemory / aiSiteMemory）。
//   所以「放宽规则把它们扫进来」= 每次全量回归都破坏真实数据，是数据破坏而非覆盖率提升。
//
// 因此本模块把两个集合显式分开：
//   candidates = 任何 test 开头的 .js（server/scripts + 仓库根）  —— 覆盖面**不允许**有黑洞
//   runSet     = candidates − EXCLUDED_SUITES.json 登记的排除项     —— 执行器实际运行集
//   差集必须与登记表逐项一致，由 test_c135_regression_scope.js 双向守护。
//
// 约束：本模块**只**依赖 fs/path，不 require 任何业务模块（可被守护测试零副作用引入）。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ROOT, 'server', 'scripts');
const EXCLUDED_FILE = path.join(__dirname, 'EXCLUDED_SUITES.json');

// 候选：任何 test 开头的 .js（大小写不敏感 —— Windows 文件系统不区分大小写，
// 但规则不应把 TestFoo.js 变成扫描面黑洞）。
const CANDIDATE_RE = /^test.*\.js$/i;

// 历史规则（C135 之前 runRegression 内联的那一条）。保留导出**仅供守护测试做双向对照**：
// 若有人把候选规则退回成它，差集立刻非空 ⇒ 守护变红。
const LEGACY_SCAN_RE = /^test_.*\.js$/;

// 排除登记：{ basename -> { file, 原因, 归类, 晋升条件, 追踪 } }
function loadExcluded() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf8')); } catch (e) { j = null; }
  const out = new Map();
  for (const s of ((j && j.suites) || [])) {
    if (s && s.file) out.set(path.basename(s.file), s);
  }
  return out;
}

// 候选全集（含被排除项），按 label 稳定排序
function collectCandidates() {
  const out = [];
  const scan = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const n of fs.readdirSync(dir).sort()) {
      if (!CANDIDATE_RE.test(n)) continue;
      out.push({ base: n, label: prefix + n, file: path.join(dir, n) });
    }
  };
  scan(SCRIPTS_DIR, 'server/scripts/');
  scan(ROOT, '');
  return out;
}

// 执行器入集 = 候选 − 登记排除
function listTestFiles() {
  const excluded = loadExcluded();
  return collectCandidates().filter((s) => !excluded.has(s.base));
}

// 登记排除项（带元数据，供执行器打印「差异不隐身」与守护校验）
function excludedSuites() {
  const excluded = loadExcluded();
  return collectCandidates()
    .filter((s) => excluded.has(s.base))
    .map((s) => Object.assign({}, s, { meta: excluded.get(s.base) }));
}

module.exports = {
  ROOT,
  SCRIPTS_DIR,
  EXCLUDED_FILE,
  CANDIDATE_RE,
  LEGACY_SCAN_RE,
  collectCandidates,
  listTestFiles,
  excludedSuites,
  loadExcluded,
};
