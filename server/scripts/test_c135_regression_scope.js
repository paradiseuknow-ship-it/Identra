'use strict';
/**
 * C135 —— 回归覆盖面**双向咬**守护（零浏览器、零 LLM、零网络、零业务模块 require）。
 *
 * 缺陷背景（C135 立案）：
 *   runRegression 的入集规则内联 `/^test_.*\.js$/`，注释却自称「维护中的套件」。
 *   实测：server/scripts 下 255 个 test 开头的 .js 中，**21 个真实套件静默不在扫描面内**
 *   （testAgent*.js × 19 + testMemoryIsolation.js + testWorkerIsolation.js）。
 *   红灯不可见 = 这些套件可以长期腐化而无人知晓（testAgentPhase22 的断言就在
 *   Phase 5.8 状态机升级后腐化了整整几个月）。
 *
 *   同一规则还在 test_c119_suite_timeout_consistency.js 里存有**第二份复刻**，
 *   任一侧漂移都会让另一侧静默少覆盖，且当时没有任何断言能发现。
 *
 * 真实语义（§A 实测）：
 *   入集前提**不是**文件名前缀，而是「已做数据根隔离、可在无 server 的执行器下安全并跑」。
 *   21 个漏网项**全部**未做数据根隔离（19 项直接写真实 server/data，
 *   testAgentPhase32 的 clean() 会清空 aiElementMemory/aiFlowMemory/aiSiteMemory）。
 *   ⇒ 盲目放宽规则得到的是**数据破坏**，不是覆盖率。故修复形态 = 把差异**显式登记**。
 *
 * 守护策略（本套件只做只读取证 + 一次 `runRegression --list` 子进程）：
 *   A 划分可取证      —— 候选 = 入集 ⊎ 登记排除（互斥且完备）
 *   B ★ 主不变量      —— 规格候选集**不允许有黑洞**（漏登记即红）
 *   C 登记表完整性    —— 四字段齐全 / 无过期 / 无重复
 *   D ★ 反向咬        —— 判定函数有分辨力；退回旧规则必须被咬住
 *   E 晋升项在位      —— 已修好并晋升的 11 项不得被悄悄移出
 *   F ★ 入集前提      —— 晋升项必须真的做了数据根隔离（且检测器反向有分辨力）
 *   G 单一事实源      —— 执行器与 C119 都不得再内联扫描正则
 *   H 隔离零污染
 *
 * 隔离：FPB_DATA_DIR 指向 tmp；本套件不 require 任何业务模块。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c135_regression_scope_' + Date.now());

const ROOT = path.join(__dirname, '..', '..');
const REG_PATH = path.join(__dirname, 'runRegression.js');
const C119_PATH = path.join(__dirname, 'test_c119_suite_timeout_consistency.js');
const SCOPE_PATH = path.join(__dirname, 'suiteScope.js');
const EXCLUDED_PATH = path.join(__dirname, 'EXCLUDED_SUITES.json');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}

// ── 只剥掉**整行注释**（行首 // 或 *）与块注释本体 ──────────────────────────────
// 只剥整行注释是刻意的：内联注释里出现扫描正则的字面量是合法文档，不应算作"内联实现"；
// 而 `//` 出现在字符串里（如 http://）不应被误剥 ⇒ 按行首判定最稳。
const stripLineComments = (s) => s.split('\n').filter((l) => {
  const t = l.trim();
  return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
}).join('\n');

// ══════════════════════════════════════════════════════════════════════════════
// 规格（spec）—— 独立于实现书写，是双向咬的基准
// ══════════════════════════════════════════════════════════════════════════════
const SPEC_RE = /^test.*\.js$/i;      // 规格：任何 test 开头的 .js 都是候选套件
const HISTORIC_RE = /^test_.*\.js$/;  // 历史入集规则：退回它必须被本守护咬住

function specCandidates() {
  const out = [];
  const scan = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const n of fs.readdirSync(dir).sort()) if (SPEC_RE.test(n)) out.push(prefix + n);
  };
  scan(__dirname, 'server/scripts/');
  scan(ROOT, '');
  return out;
}

// 缺口判定函数（D 组注入用；也是 B1 的实现）
function holes(candidates, runSet, excludedSet) {
  return candidates.filter((c) => !runSet.has(c) && !excludedSet.has(c));
}

// 数据根隔离检测器（F 组）：隔离行必须出现在**首个 require 之前**
const FIRST_REQUIRE_RE = /^\s*(?:(?:const|let|var)\s+[^=]*=\s*)?require\(/;
function isolatedOk(src) {
  const lines = src.split('\n');
  const iso = lines.findIndex((l) => /process\.env\.FPB_DATA_DIR\s*=/.test(l));
  const req = lines.findIndex((l) => FIRST_REQUIRE_RE.test(l));
  return iso >= 0 && req >= 0 && iso < req;
}

// C135 晋升入集清单（登记型断言：修好并晋升的项不得被悄悄移出；
// 确需移出时**必须同时**改这里并在 EXCLUDED_SUITES.json 登记原因 —— 两处都改才算显式决策）
const PROMOTED = [
  'server/scripts/testAgentInfra.js',
  'server/scripts/testAgentPhase22.js',
  'server/scripts/testAgentPhase33.js',
  'server/scripts/testAgentPhase35.js',
  'server/scripts/testAgentPhase36.js',
  'server/scripts/testAgentPhase41.js',
  'server/scripts/testAgentPhase44.js',
  'server/scripts/testAgentPhase45.js',
  'server/scripts/testAgentPhase46.js',
  // C136 归因而晋升：「可能为真回归（高优先级）」的 EX-09/EX-10 双双被定性为**测试自身缺陷**：
  //  Phase42 = scan 自 Phase 5.8 起只判 ASSIGNED/RUNNING（测试把 worker 留在 READY）；
  //  Phase43 = start() 会先 _reapZombieDispatches()（测试「先 submit 再 start」⇒ 刚入队被收割）。
  //  生产代码两者均未改（归属证据：_reapZombieDispatches 在 C134 已存在、C135 未改）。
  'server/scripts/testAgentPhase42.js',
  'server/scripts/testAgentPhase43.js',
  // C138 归因而晋升：EX-07「待归因（可能为真缺陷，高优先级）」定性为**测试构造了生产不可发生的
  //  输入** —— 其 LLM_PLAN 的 fill 既无 value 也无 credentialRef（schema/action.js:174 要求其一），
  //  而生产 planner 出口强制 validatePlan（planner.js:465）⇒ 这种 plan 永远不会落库成 flow；
  //  读侧 CAP-K1 守卫（tryFlowPlan 先过 validatePlan）正确拒绝带病重放，故旧断言红。
  //  归属证据：把同一 plan 的 fill 补成合法（credentialRef）后整条复用链绿（fromFlow=true calls=1）。
  'server/scripts/testAgentPhase32.js',
  'server/scripts/testMemoryIsolation.js',
  'server/scripts/testWorkerIsolation.js',
  // C139 归因而晋升（EX-06/EX-08 双双定性为**测试自身缺陷**，生产业务零改动）：
  //  Phase31 = 旧 fixture 的语义/标签组合（semantic 'submit' + 标签 Continue/Proceed）建立在
  //    **C105 F1 之前**的可行性假设上（那时兜底给所有 button 0.4 同分、DOM 顺序决胜）；
  //    F1 已用真实站点实证改为「兜底候选必须与元素自身身份信号有词法关联」⇒ 该 fixture 恒零候选。
  //    另修两个测试自身缺陷：缺 null 守卫（崩溃吃掉整段下游断言）、异常路径自赋值 no-op（spy 不还原）。
  //    实测 28/0（原 11/13 + 崩溃）。集成段断言改为契约稳定形态（key 无关的标签 pattern 统计 +
  //    「零证据语义不复用记忆」显式契约）。
  //  Phase34 = realProfileIds() 硬编码 `__dirname/../../data/profiles.json`，是**第二份数据根口径**
  //    ⇒ 隔离只覆盖 store 集合位置，白名单仍指向真实目录 ⇒ 遗留真实 profile（p_phase23_*）赢得
  //    region 组。收口为 dataRoot()（无隔离时与旧路径逐字相同 ⇒ 行为中性）+ 症状直钉断言。实测 31/0。
  'server/scripts/testAgentPhase31.js',
  'server/scripts/testAgentPhase34.js',
];

(async () => {
  // ── A 划分可取证 ──────────────────────────────────────────────────────────
  const r = spawnSync(process.execPath, [REG_PATH, '--list'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: process.env,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const grab = (kind) => out.split('\n').filter((l) => l.startsWith(kind + ' ')).map((l) => l.slice(kind.length + 1).trim());
  const CAND = grab('CANDIDATE');
  const RUN = grab('RUN');
  const EXC = grab('EXCLUDED');

  check('A1 执行器 --list 可用且退出码为 0', r.status === 0, 'status=' + r.status + ' bytes=' + out.length);
  check('A2 --list 三类行均非空（非恒空实现）', CAND.length > 100 && RUN.length > 100 && EXC.length > 0,
    'cand=' + CAND.length + ' run=' + RUN.length + ' exc=' + EXC.length);
  {
    const candSet = new Set(CAND);
    const union = new Set([...RUN, ...EXC]);
    const sameSize = union.size === candSet.size;
    const allIn = [...union].every((x) => candSet.has(x));
    check('A3 划分完备：RUN ⊎ EXCLUDED === CANDIDATE', sameSize && allIn,
      'union=' + union.size + ' cand=' + candSet.size);
    const inter = RUN.filter((x) => EXC.includes(x));
    check('A4 划分互斥：RUN ∩ EXCLUDED 为空', inter.length === 0, JSON.stringify(inter.slice(0, 5)));
  }

  // ── B ★ 主不变量：候选集不允许有黑洞 ──────────────────────────────────────
  const runSet = new Set(RUN);
  const excSet = new Set(EXC);
  const spec = specCandidates();
  const miss = holes(spec, runSet, excSet);
  check('B1 ★ 规格候选集无黑洞（每项要么入集、要么显式登记排除）',
    miss.length === 0, miss.join(' | '));
  {
    const a = new Set(spec); const b = new Set(CAND);
    const onlySpec = spec.filter((x) => !b.has(x));
    const onlyImpl = CAND.filter((x) => !a.has(x));
    check('B2 实现候选集与规格候选集一致（规则未被窄化/放大）',
      onlySpec.length === 0 && onlyImpl.length === 0,
      'spec-only=' + JSON.stringify(onlySpec.slice(0, 5)) + ' impl-only=' + JSON.stringify(onlyImpl.slice(0, 5)));
  }

  // ── C 登记表完整性 ────────────────────────────────────────────────────────
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(EXCLUDED_PATH, 'utf8')); } catch (e) { reg = null; }
  const suites = (reg && reg.suites) || [];
  check('C1 登记表可解析且 suites 为数组', Array.isArray(suites) && suites.length > 0, 'n=' + suites.length);
  {
    // 四条字段全部必填；并对两处"实体字段"设最低实质长度（防占位符）。
    // 归类/追踪是**短标签**，只要求非空 —— 早期版本对全部字段统一要求 ≥4 字，
    // 会把合法标签「待归因」（3 字）误判为缺失（本守护首跑即如此假红）。
    const need = ['原因', '归类', '晋升条件', '追踪'];
    const MIN = { 原因: 20, 晋升条件: 10 };
    const bad = suites.filter((s) => need.some((k) => !s[k] || String(s[k]).trim().length < (MIN[k] || 1)))
      .map((s) => s.file + ' 缺/过短:' + need.filter((k) => !s[k] || String(s[k]).trim().length < (MIN[k] || 1)).join(','));
    check('C2 每条登记含 原因/归类/晋升条件/追踪，且实体字段非占位',
      bad.length === 0, bad.join(' | '));
  }
  {
    const names = suites.map((s) => path.basename(s.file || ''));
    const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
    check('C3 登记表无重复条目', dup.length === 0, JSON.stringify(dup));
    const ghost = names.filter((n) => !fs.existsSync(path.join(__dirname, n)));
    check('C4 登记表无过期条目（文件真实存在）', ghost.length === 0, JSON.stringify(ghost));
    const notCandidate = names.filter((n) => !spec.includes('server/scripts/' + n) && !spec.includes(n));
    check('C5 登记条目的文件确属候选集', notCandidate.length === 0, JSON.stringify(notCandidate));
  }

  // ── D ★ 反向咬：判定函数必须有分辨力 ──────────────────────────────────────
  check('D1 判定函数对真实集合返回空（与 B1 同源，非恒非空实现）',
    holes(spec, runSet, excSet).length === 0, '');
  check('D2 判定函数对注入的合成候选**必须**报缺口（证明有分辨力）',
    holes(['server/scripts/testC135Synthetic.js'], runSet, excSet).length === 1, '');
  {
    // 模拟「有人把入集规则退回历史 /^test_.*\.js$/」：晋升的 11 项会重新变成黑洞
    const legacyRun = new Set(spec.filter((x) => HISTORIC_RE.test(path.basename(x))));
    const legacyMiss = holes(spec, legacyRun, excSet);
    check('D3 ★ 退回历史规则 /^test_.*\\.js$/ 必须被咬住（咬得住 = 本守护有意义）',
      legacyMiss.length >= 1, '会重新失联 ' + legacyMiss.length + ' 项: ' + legacyMiss.slice(0, 3).join(','));
  }
  {
    // 反向：把晋升项整批从入集移出（且保持登记表不变）也必须被咬住（漏登记 ⇒ 红）。
    // 注意分母：登记排除的 10 项在登记表内，因此不计入缺口 —— 缺口恰好 = 晋升项数。
    const realExc = new Set(suites.map((s) => 'server/scripts/' + path.basename(s.file || '')));
    const runWithoutPromoted = new Set(spec.filter((x) => !PROMOTED.includes(x)));
    check('D4 ★ 晋升项被移出且未登记时，必须报出恰好 |PROMOTED| 个缺口',
      holes(spec, runWithoutPromoted, realExc).length === PROMOTED.length,
      'holes=' + holes(spec, runWithoutPromoted, realExc).length + ' 期望=' + PROMOTED.length);
  }

  // ── E 晋升项在位 ─────────────────────────────────────────────────────────
  {
    const notRun = PROMOTED.filter((p) => !runSet.has(p));
    // C139：去掉标签里硬编码的项数（「11 项」随每批晋升必然漂移）⇒ 改为自描述计数，
    // 与 D4 一样从 PROMOTED 派生（单调递增字段不得人工快照）。
    check('E1 ★ C135 起晋升的项（共 ' + PROMOTED.length + '）均在入集内（不得被悄悄移出）', notRun.length === 0, JSON.stringify(notRun));
  }

  // ── F ★ 入集前提：晋升项必须真的做了数据根隔离 ──────────────────────────────
  {
    const bad = PROMOTED.filter((p) => {
      const f = path.join(ROOT, p);
      if (!fs.existsSync(f)) return true;
      return !isolatedOk(fs.readFileSync(f, 'utf8'));
    });
    check('F1 ★ 全部晋升项已做数据根隔离（隔离行先于首个 require）', bad.length === 0, JSON.stringify(bad));
    // 反向分辨力：登记排除中的项（均未隔离）必须被判为未隔离
    const sample = suites[0] && path.join(__dirname, path.basename(suites[0].file || ''));
    const sampleOk = sample && fs.existsSync(sample) ? isolatedOk(fs.readFileSync(sample, 'utf8')) : null;
    check('F2 隔离检测器反向有分辨力（未隔离样本必须判否）', sampleOk === false,
      'sample=' + path.basename(sample || '') + ' isolated=' + sampleOk);
  }

  // ── G 单一事实源：不得再有第二份扫描规则 ─────────────────────────────────
  {
    const regNc = stripLineComments(fs.readFileSync(REG_PATH, 'utf8'));
    const c119Nc = stripLineComments(fs.readFileSync(C119_PATH, 'utf8'));
    const scopeNc = stripLineComments(fs.readFileSync(SCOPE_PATH, 'utf8'));
    check('G1 执行器不再内联扫描正则（^test_）', !/\^test_/.test(regNc),
      (regNc.match(/.*\^test_.*/) || [''])[0].slice(0, 90));
    check('G2 C119 不再内联扫描正则（^test_）', !/\^test_/.test(c119Nc),
      (c119Nc.match(/.*\^test_.*/) || [''])[0].slice(0, 90));
    check('G3 执行器与 C119 均委托 suiteScope.listTestFiles()',
      /suiteScope\.listTestFiles\(\)/.test(regNc) && /suiteScope\.listTestFiles\(\)/.test(c119Nc), '');
    check('G4 suiteScope 自身持有唯一候选规则并导出必要 API',
      /CANDIDATE_RE\s*=\s*\/\^test\.\*\\\.js\$\/i/.test(scopeNc)
      && /listTestFiles/.test(scopeNc) && /excludedSuites/.test(scopeNc)
      && /collectCandidates/.test(scopeNc) && /LEGACY_SCAN_RE/.test(scopeNc), '');
  }

  // ── H 隔离零污染 ─────────────────────────────────────────────────────────
  check('H1 FPB_DATA_DIR 落在系统临时目录内（隔离）',
    path.normalize(process.env.FPB_DATA_DIR).indexOf(path.normalize(os.tmpdir())) === 0,
    process.env.FPB_DATA_DIR);
  check('H2 本套件零业务模块 require',
    !/require\(['"][^'"]*agent\//.test(fs.readFileSync(__filename, 'utf8')), '');

  console.log('\n===== C135 SCOPE SUMMARY: ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
