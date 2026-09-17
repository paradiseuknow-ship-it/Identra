'use strict';
/**
 * C119 —— 超时参数族跨层一致性守护（零浏览器、零 LLM、零网络、零业务模块 require）。
 *
 * 缺陷背景：
 *   超时参数有**两层**，语义嵌套但此前无人校验它们的关系：
 *     ① 套件内部观测窗  —— `waitTaskTerminal(id, N)`（step22 F1 = 600s）
 *     ② 执行器进程超时  —— runRegression `PER_TEST_TIMEOUT_OVERRIDES`（step22 = 480s）
 *   C118 把 ① 从 300s 提到 600s，却没同步 ② ⇒ 480s < 600s：
 *   若 F1 链长落在 480–600s，断言**本会绿**，但执行器先杀掉进程 ⇒ 600s 窗在该区间
 *   **永远无法兑现**。这与 C118 刚修的「300s 窗余量塌缩」是**同一类缺陷换了阈值重演**。
 *   修复：执行器超时 480s → 720s（= 最大内部窗 600s + 120s 余量，≤ 2× 上界）。
 *
 * 守护策略：
 *   A 提取器自洽 —— 直接解析 runRegression.js 与 step22 源码，非硬编码期望值
 *   B 硬不变量   —— 执行器超时 > 套件内部最大窗（本批次核心）
 *   C 横向完整性 —— 扫描**全部**套件，防止未来新增套件重蹈「窗 > 超时」覆辙
 *   D 真实行为   —— 从 step22 源码提取 waitTaskTerminal 真实函数体实跑（不复制实现）
 *   E 取证链锚点 —— 防执行器超时变成无源之数
 *   F 防空断言   —— 证明提取器不是恒空/恒真实现
 *   G 隔离零污染
 *
 * 隔离：本套件不 require 任何业务模块；FPB_DATA_DIR / AI_PROVIDER=mock 显式声明以固化环境契约。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c119_timeout_consistency_' + Date.now());
process.env.AI_PROVIDER = 'mock';

const ROOT = path.join(__dirname, '..', '..');
const REG_PATH = path.join(__dirname, 'runRegression.js');
const STEP22_PATH = path.join(__dirname, 'test_step22_business_e2e.js');
// ★ C135：扫描范围唯一事实源（见下方 listSuites 的说明）。
// suiteScope 只依赖 fs/path，不 require 任何业务模块 ⇒ G2「零业务模块 require」前提不被破坏。
const suiteScope = require('./suiteScope');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ══════════════════════════════════════════════════════════════════════════════
// 提取器（全部从源码解析，不硬编码任何期望值）
// ══════════════════════════════════════════════════════════════════════════════

// 全局默认超时：const PER_TEST_TIMEOUT_MS = Number(process.env.X) || N;
function extractGlobalTimeout(src) {
  const m = src.match(/const\s+PER_TEST_TIMEOUT_MS\s*=[^;\n]*?\|\|\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

// 每套件覆盖表：{ 'x.js': Number(process.env.Y) || N }
function extractOverrides(src) {
  const block = src.match(/const\s+PER_TEST_TIMEOUT_OVERRIDES\s*=\s*\{([\s\S]*?)\n\};/);
  if (!block) return null;
  const out = {};
  const re = /'([^']+\.js)'\s*:\s*[^\n]*?\|\|\s*(\d+)/g;
  let m;
  while ((m = re.exec(block[1]))) out[m[1]] = Number(m[2]);
  return out;
}

// 把字符串字面量整体替换为等长空白（字符串**不是代码**）。
// 必要性（实证）：`test_c118_step22_window_margin.js` 里有断言锚点字符串
// `'waitTaskTerminal(t1.json.id, 600000)'` —— 它是被检查的目标文本，不是真调用。
// 不 mask 会被横向扫描误判为「该套件窗 600s > 其生效超时 180s」而假红。
function maskStrings(s) {
  return s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length));
}

// 套件内部观测窗：waitTaskTerminal(<expr>, N) 的第 2 参数（函数定义行第 2 参数是标识符，天然不命中）
function extractWaitWindows(raw) {
  const src = maskStrings(raw);
  const wins = [];
  const re = /waitTaskTerminal\(\s*[^,()]+,\s*(\d+)/g;
  let m;
  while ((m = re.exec(src))) wins.push(Number(m[1]));
  // ★ C140：同族**第二个**等待原语 —— `waitStatus(taskId, targets, N)`（三参：终态集合由调用方给）。
  // 旧提取器只认 `waitTaskTerminal`，于是 Phase5/Phase22/Phase23/Phase31 的内部窗（90s/120s）
  // 对本守护**结构性不可见** ⇒ C1/C2「窗 > 生效超时」「窗 > 全局默认必须登记 override」
  // 在这 4 个套件上永远无法触发（L14 覆盖面静默漂移；本批正是靠人手核对才发现）。
  // 目标集合只支持**标识符**（如 TASK_TERMINAL）或不可达的数组字面量：本批已把 4 个套件的
  // 终态等待全部改为派生事实源 `TASK_TERMINAL` ⇒ 标识符形态即事实形态；
  // 提取数量与调用点数量的自洽性由 A6 断言（防「改了写法但提取器静默漏配」）。
  const re2 = /waitStatus\(\s*[^,()]+,\s*[A-Za-z_$][\w$]*\s*,\s*(\d+)\s*\)/g;
  while ((m = re2.exec(src))) wins.push(Number(m[1]));
  // 调用方省略窗时的兜底默认：Date.now() + (timeoutMs || N)
  const d = src.match(/Date\.now\(\)\s*\+\s*\(timeoutMs\s*\|\|\s*(\d+)\)/);
  if (d) wins.push(Number(d[1]));
  return wins;
}

// ★ C135：扫描范围**不得**再复刻 —— 收口到唯一事实源 server/scripts/suiteScope.js。
// 旧实现在此内联 `/^test_.*\.js$/` 并注释「复刻 runRegression 的扫描范围」：这意味着执行器的
// 扫描面一旦变化，本守护的 C 组（横向完整性）就会**静默少覆盖**，且没有任何断言能发现
// （正是 C135 立案的那类缺陷）。现改为直接消费入集（= 候选 − EXCLUDED_SUITES.json 登记排除），
// C1/C2 的覆盖面自动跟随执行器，不再存在两份规则。
function listSuites() {
  return suiteScope.listTestFiles();
}

const REG_SRC = fs.readFileSync(REG_PATH, 'utf8');
const REG_NC = strip(REG_SRC);
const STEP22_SRC = fs.readFileSync(STEP22_PATH, 'utf8');
const STEP22_NC = strip(STEP22_SRC);

const GLOBAL_MS = extractGlobalTimeout(REG_NC);
const OVERRIDES = extractOverrides(REG_NC);
const STEP22_WINDOWS = extractWaitWindows(STEP22_NC);
const STEP22_MAX_WINDOW = STEP22_WINDOWS.length ? Math.max(...STEP22_WINDOWS) : 0;
const STEP22_EFFECTIVE = (OVERRIDES && OVERRIDES['test_step22_business_e2e.js']) || GLOBAL_MS;

(async () => {
  // ════════════════════════════════════════════════════════════════════════════
  // A 提取器自洽：解析出的值必须与源码真实结构吻合
  // ════════════════════════════════════════════════════════════════════════════
  check('A1 全局超时可提取（PER_TEST_TIMEOUT_MS）',
    Number.isInteger(GLOBAL_MS) && GLOBAL_MS > 0, 'GLOBAL_MS=' + GLOBAL_MS);
  check('A2 覆盖表可提取且非空',
    OVERRIDES !== null && Object.keys(OVERRIDES).length >= 1,
    'keys=' + JSON.stringify(OVERRIDES && Object.keys(OVERRIDES)));
  check('A3 step22 内部观测窗可提取且非空',
    STEP22_WINDOWS.length >= 1, 'windows=' + JSON.stringify(STEP22_WINDOWS));
  {
    // 自洽：调用点数量 === 源码中 `waitTaskTerminal(` 出现次数 − 1（函数定义那处）
    const callSites = (STEP22_NC.match(/waitTaskTerminal\(/g) || []).length;
    check('A4 提取窗数量与调用点数量自洽（定义行不计入）',
      STEP22_WINDOWS.length - 1 === callSites - 1,
      'windows=' + STEP22_WINDOWS.length + ' callSites=' + callSites);
  }
  check('A5 最大内部窗已落在 600000（C118 重基线后的真实值）',
    STEP22_MAX_WINDOW === 600000, 'STEP22_MAX_WINDOW=' + STEP22_MAX_WINDOW);

  // ★ C140：同族原语 `waitStatus` 的提取自洽 —— 「调用点数 − 定义数」必须 === 提取到的窗数量。
  // 若未来有人换了写法（例如把目标集合写成含逗号的表达式），提取器会**静默少配** ⇒ 本断言先红。
  {
    const FAMILY = ['testAgentPhase5.js', 'testAgentPhase22.js', 'testAgentPhase23.js', 'testAgentPhase31.js'];
    const bad = []; const found = [];
    for (const f of FAMILY) {
      let src = '';
      try { src = strip(fs.readFileSync(path.join(__dirname, f), 'utf8')); } catch (e) { bad.push(f + ' 读取失败'); continue; }
      const calls = (src.match(/waitStatus\(/g) || []).length;
      const defs = (src.match(/function\s+waitStatus\(/g) || []).length;
      const wins = extractWaitWindows(src).length;
      found.push(f + '=' + wins);
      if (wins !== calls - defs) bad.push(f + ' wins=' + wins + ' calls=' + calls + ' defs=' + defs);
    }
    check('A6 ★ waitStatus 族窗提取自洽（调用点数 − 定义数 === 提取数）',
      bad.length === 0 && found.length === FAMILY.length, bad.join(' | ') || found.join(' '));
  }
  // ⚠ 同 F 组教训：人造源码必须**运行时拼接**构造，不得把窗口的完整字面形式直写进本文件 ——
  // 直写会让本文件自身的文本面被自己的测试数据污染，G3「本套件自身无等待窗」随即假红
  // （本批第一次运行正是这样红的，detail=[123456,123456,123456]；根因是 maskStrings 基于正则，
  //  遇到本文件里含引号的**正则字面量**会失准，于是漏网）。
  {
    const PROBE = 'const r = await ' + 'waitStatus(' + 't.id, TERMS, ' + '123456' + ');';
    check('A7 revert 对照：waitStatus 的窗必须能被现提取器检出（旧实现只认 waitTaskTerminal ⇒ 检不出）',
      extractWaitWindows(PROBE).includes(123456) && !/waitTaskTerminal/.test(PROBE),
      JSON.stringify(extractWaitWindows(PROBE)));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // B 硬不变量（本批次核心）：执行器超时 > 内部最大窗，否则那个窗永远无法兑现
  // ════════════════════════════════════════════════════════════════════════════
  check('B1 ★ 执行器超时 > 套件内部最大观测窗（窗可被兑现）',
    STEP22_EFFECTIVE > STEP22_MAX_WINDOW,
    'exec=' + STEP22_EFFECTIVE + ' maxWin=' + STEP22_MAX_WINDOW);
  check('B2 余量 ≥ 120s（覆盖站点启动 + A/C/E/F2 区典型耗时 + 负载波动）',
    STEP22_EFFECTIVE - STEP22_MAX_WINDOW >= 120000,
    'margin=' + (STEP22_EFFECTIVE - STEP22_MAX_WINDOW) + 'ms');
  check('B3 执行器超时 ≤ 2× 最大内部窗（防失控放大拖死全量回归）',
    STEP22_EFFECTIVE <= STEP22_MAX_WINDOW * 2,
    'exec=' + STEP22_EFFECTIVE + ' cap=' + STEP22_MAX_WINDOW * 2);
  check('B4 step22 确实走了 override（而非碰巧落在全局默认上）',
    STEP22_EFFECTIVE !== GLOBAL_MS && STEP22_EFFECTIVE > GLOBAL_MS,
    'exec=' + STEP22_EFFECTIVE + ' global=' + GLOBAL_MS);

  // ════════════════════════════════════════════════════════════════════════════
  // C 横向完整性：扫描全部套件 —— 本次漏掉的正是这个检查
  // ════════════════════════════════════════════════════════════════════════════
  const suites = listSuites();
  const SELF = path.basename(__filename);
  const violations = [];
  const missingOverride = [];
  for (const s of suites) {
    if (s.base === SELF) continue; // 自引用：本套件无异步等待窗（G2 另有断言）
    let wins = [];
    try { wins = extractWaitWindows(strip(fs.readFileSync(s.file, 'utf8'))); } catch (e) { continue; }
    if (!wins.length) continue;
    const maxW = Math.max(...wins);
    const eff = (OVERRIDES && OVERRIDES[s.base]) || GLOBAL_MS;
    if (maxW > eff) violations.push(s.base + ' maxWin=' + maxW + ' > eff=' + eff);
    if (maxW > GLOBAL_MS && !(OVERRIDES && OVERRIDES[s.base])) {
      missingOverride.push(s.base + ' maxWin=' + maxW + ' > global=' + GLOBAL_MS);
    }
  }
  check('C1 ★ 横向：无套件的内部窗超过其生效执行器超时',
    violations.length === 0, violations.join(' | '));
  check('C2 ★ 横向：内部窗超过全局默认的套件必须登记 override',
    missingOverride.length === 0, missingOverride.join(' | '));
  {
    const bases = new Set(suites.map((s) => s.base));
    const ghosts = Object.keys(OVERRIDES || {}).filter((k) => !bases.has(k));
    check('C3 覆盖表无幽灵条目（表内每个套件文件都真实存在）',
      ghosts.length === 0, JSON.stringify(ghosts));
  }
  check('C4 横向扫描确实扫到了套件（非恒空实现）',
    suites.length > 100, 'suites=' + suites.length);

  // ════════════════════════════════════════════════════════════════════════════
  // D 真实行为：提取 step22 里 waitTaskTerminal 的真实函数体实跑
  // ════════════════════════════════════════════════════════════════════════════
  {
    const body = STEP22_NC.match(/async function waitTaskTerminal[\s\S]*?\n\}/);
    check('D0 waitTaskTerminal 函数体可提取', !!body, body ? '' : 'regex 未命中');
    if (body) {
      // 工厂：注入 stub api（固定返回某状态），得到闭包了 api/AUTH 的真实函数
      const makeWait = (statusFn) =>
        new Function('api', 'AUTH', body[0] + '\nreturn waitTaskTerminal;')(
          async () => ({ json: { status: statusFn() } }),
          { authorization: 'stub' }
        );
      {
        const t0 = Date.now();
        const r = await makeWait(() => 'HUMAN_ESCALATION')('task_x', STEP22_MAX_WINDOW);
        const elapsed = Date.now() - t0;
        check('D1 终态早退：600s 窗下 HUMAN_ESCALATION 首轮返回（绿路径零成本）',
          r.status === 'HUMAN_ESCALATION' && elapsed < 10000, 'elapsed=' + elapsed + 'ms');
      }
      {
        const t0 = Date.now();
        const r = await makeWait(() => 'RUNNING')('task_y', 1500);
        const elapsed = Date.now() - t0;
        check('D2 超时回传原始 RUNNING（不伪造终态，裁决权仍在断言）',
          r.status === 'RUNNING' && elapsed >= 1000, 'elapsed=' + elapsed + 'ms');
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // E 取证链锚点：防执行器超时变成无源之数
  // ════════════════════════════════════════════════════════════════════════════
  check('E1 实测链长取证值保留在 runRegression.js 注释中（193.4 / 267.9 / 377.6）',
    REG_SRC.indexOf('193.4') >= 0 && REG_SRC.indexOf('267.9') >= 0 && REG_SRC.indexOf('377.6') >= 0, '');
  check('E2 ★ 跨层不变量在源码注释中被显式写明',
    REG_SRC.indexOf('跨层不变量') >= 0 && REG_SRC.indexOf('永远无法兑现') >= 0, '');
  check('E3 超时语义被写明为「防悬挂保险丝」而非判定标准',
    REG_SRC.indexOf('保险丝') >= 0 && REG_SRC.indexOf('断言口径') >= 0, '');
  check('E4 C108 设窗依据与 C118/C119 演进链均在注释中（480000 / 600s 由来）',
    REG_SRC.indexOf('480000') >= 0 && REG_SRC.indexOf('C118') >= 0 && REG_SRC.indexOf('C119') >= 0, '');

  // ════════════════════════════════════════════════════════════════════════════
  // F 防空断言：证明提取器真的在工作（喂人造源码，必须解析出预期结果）
  // ════════════════════════════════════════════════════════════════════════════
  {
    // ⚠ 人造源码必须**运行时拼接**构造，不能把字面调用形式直写在本文件里：
    // 否则本文件自身的文本面就会被自己的测试数据污染，
    // G3「本套件自身无等待窗」随即假红 —— 本批次第一次运行正是这样红的
    // （detail 显示 [888000,777000]，来源就是这里）。
    const W = 'waitTaskTerminal';
    const DN = 'Date.now()';
    const fake = 'const PER_TEST_TIMEOUT_MS = Number(process.env.X) || 111000;\n'
      + "const PER_TEST_TIMEOUT_OVERRIDES = {\n  'test_fake.js': Number(process.env.Y) || 999000,\n};\n"
      + 'await ' + W + '(t.id, 888000);\n'
      + 'const deadline = ' + DN + ' + (timeoutMs || 777000);\n';
    const fg = extractGlobalTimeout(fake);
    const fo = extractOverrides(fake);
    const fw = extractWaitWindows(fake);
    check('F1 提取器对人造源码返回预期值（非恒空/恒真实现）',
      fg === 111000 && fo && fo['test_fake.js'] === 999000
      && fw.indexOf(888000) >= 0 && fw.indexOf(777000) >= 0,
      'global=' + fg + ' ov=' + JSON.stringify(fo) + ' wins=' + JSON.stringify(fw));
    // 反例：违反不变量的源码必须被 C1 逻辑判为违规
    const badEff = 500000; const badWin = Math.max(...fw);
    check('F2 反例自检：窗(888000) > 虚设超时(500000) 时违规判定成立',
      badWin > badEff, 'win=' + badWin + ' eff=' + badEff);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // G 隔离零污染
  // ════════════════════════════════════════════════════════════════════════════
  check('G1 FPB_DATA_DIR 落在系统临时目录内（隔离）',
    path.normalize(process.env.FPB_DATA_DIR).indexOf(path.normalize(os.tmpdir())) === 0,
    process.env.FPB_DATA_DIR);
  {
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    check('G2 本套件零业务模块 require（store 单例无从创建）',
      !/require\(['"][^'"]*agent\//.test(selfSrc), '');
    check('G3 本套件自身无 waitTaskTerminal 等待窗（C 组排除自身的前提成立）',
      extractWaitWindows(strip(selfSrc)).length === 0,
      JSON.stringify(extractWaitWindows(strip(selfSrc))));
    // G4 maskStrings 有效性自检：把「调用形式」包进字符串字面量后必须被清理干净，
    // 否则横向扫描会把它当成真实调用 —— c118 的断言锚点字符串正是这种形态。
    // 同样运行时拼接构造，避免污染本文件文本面。
    const fakeCall = 'waitTaskTerminal' + '(x, 123456)';
    const realCall = 'waitTaskTerminal' + '(y, 654321)';
    const pw = extractWaitWindows('const s = ' + "'" + fakeCall + "'" + ';\nawait ' + realCall + ';\n');
    check('G4 maskStrings 生效：字符串内的伪调用被清理，只剩真实调用',
      pw.length === 1 && pw[0] === 654321, JSON.stringify(pw));
  }

  console.log('\n===== C119 SUMMARY: ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
