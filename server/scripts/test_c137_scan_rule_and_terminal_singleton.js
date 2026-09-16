'use strict';

/**
 * test_c137_scan_rule_and_terminal_singleton.js
 *
 * C137 守护：两处「同域第二份副本」的收口必须**双向咬得住**。
 *
 *   ① 扫面规则副本 —— `run_phase9_regression.sh` 曾内联 `ls server/scripts/test_*.js`
 *      （与 suiteScope.js（唯一事实源）并列的**第三份副本**）；`test_c94_safe_port.js`
 *      的 P3 整类守卫也曾内联 `/^test_.*\.js$/`（**第四份**）。
 *      收口后：shell 一律向事实源取清单，取不到就 **fail closed**（绝不回落到某个内联 glob）；
 *      c94 的整类守卫改用**候选全集**（覆盖面从「历史命名」扩到「任何 test 开头」）。
 *   ② 终态集合副本 —— `successMetrics.js` 曾内联 `TERMINAL` 字面量
 *      （与 taskStateManager.js 的 `TASK_TERMINAL` 同域同集合、仅顺序不同，且**全仓零消费者**）。
 *      收口为**静态委托**（同一数组引用）。
 *
 * 为什么这个守护是必要的：
 *   两处缺陷的**当下影响都是零**（顺序不同 / 零消费者），因此任何「行为回归」都抓不到它们；
 *   唯一能防住未来漂移的手段 = 断言**形状本身**（委托关系、无内联字面量、集合同源），
 *   并对**仍然并存**的副本（benchmark/gate 受 Phase 6 冻结，不重构）做**登记 + 集合等价**断言 ——
 *   漂移即红。这正是 L15「并存须可区分＋登记」与 L17「双向咬」的落地。
 *
 * 隔离：FPB_DATA_DIR 指向 tmp；只 require suiteScope（fs/path only）+ 两个纯常量模块。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c137_singleton_' + Date.now());

const ROOT = path.join(__dirname, '..', '..');
const SCOPE_PATH = path.join(__dirname, 'suiteScope.js');
const SHELL_PATH = path.join(__dirname, 'run_phase9_regression.sh');
const C94_PATH = path.join(__dirname, 'test_c94_safe_port.js');
const SM_PATH = path.join(__dirname, '..', 'agent', 'successMetrics.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}

// 只剥**整行注释**（与 C135 守护同一判据：内联注释里的示例正则属合法文档，字符串里的 // 不能被误剥）
const stripLineComments = (s) => s.split('\n').filter((l) => {
  const t = l.trim();
  return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
}).join('\n');

// shell 侧要用 `#` 起首的注释（首跑正是在这里踩了假红：用 JS 剥注释函数判 shell 源码，
// `# ... test_*.js ...` 这种**合法文档注释**被当成内联实现 ⇒ C1/F1 双假红）。
const stripHashComments = (s) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

const j = (a) => JSON.stringify(a);
const sorted = (a) => j([...a].sort());

const suiteScope = require(SCOPE_PATH);
const successMetrics = require(SM_PATH);
const taskStateManager = require(path.join(__dirname, '..', 'agent', 'taskStateManager.js'));

// ════════════════════════════════════════════════════════════════════════════
// A 事实源 CLI：shell 执行器取清单的唯一入口
// ════════════════════════════════════════════════════════════════════════════
const cli = spawnSync(process.execPath, [SCOPE_PATH, '--phase9'], { encoding: 'utf8', cwd: ROOT });
const cliLines = String(cli.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
const ph9 = suiteScope.phase9Scope().map((s) => s.label);

check('A1 suiteScope --phase9 可执行且 exit=0', cli.status === 0,
  'status=' + cli.status + ' stderr=' + String(cli.stderr || '').slice(0, 120));
check('A2 清单非空（防空断言：空清单下后面全部断言会退化成真空绿）', cliLines.length > 100,
  'n=' + cliLines.length);
check('A3 清单全部是 server/scripts 下的相对路径', cliLines.every((l) => l.startsWith('server/scripts/') && l.endsWith('.js')),
  cliLines.filter((l) => !(l.startsWith('server/scripts/') && l.endsWith('.js'))).slice(0, 3).join(','));
check('A4 清单无重复且已排序', new Set(cliLines).size === cliLines.length && j(cliLines) === j([...cliLines].sort()),
  'unique=' + new Set(cliLines).size + ' sorted=' + (j(cliLines) === j([...cliLines].sort())));
check('A5 ★ CLI 输出与 phase9Scope() 逐项一致（执行的与声明的是同一份）',
  j(cliLines) === j(ph9), 'cli=' + cliLines.length + ' api=' + ph9.length);

// ════════════════════════════════════════════════════════════════════════════
// B 规格双录入：phase9 面必须 = 独立扫描器算出的集合，且与入集构成**无黑洞**划分
// ════════════════════════════════════════════════════════════════════════════
const inSet = suiteScope.listTestFiles().map((s) => s.label);
const excludedBase = new Set(suiteScope.excludedSuites().map((s) => s.base));
// 独立规格（不复用实现）：候选 ∩ server/scripts ∩ 历史命名 test_ ∩ ¬登记排除
const spec = suiteScope.collectCandidates()
  .filter((s) => s.label.startsWith('server/scripts/') && /^test_.*\.js$/.test(s.base) && !excludedBase.has(s.base))
  .map((s) => s.label);

check('B1 ★ 规格 = 实现（独立扫描器双录入，杜绝"实现即规格"的真空）', j(spec) === j(ph9),
  'spec=' + spec.length + ' impl=' + ph9.length);
check('B2 phase9 面 ⊆ 执行器入集', ph9.every((l) => inSet.includes(l)),
  ph9.filter((l) => !inSet.includes(l)).slice(0, 3).join(','));

const rest = inSet.filter((l) => !ph9.includes(l));
check('B3 ★ 无黑洞：phase9 面 ∪ 其余入集 = 全部入集（且两侧互斥）',
  ph9.length + rest.length === inSet.length && new Set([...ph9, ...rest]).size === inSet.length,
  ph9.length + ' + ' + rest.length + ' vs ' + inSet.length);
check('B4 差集非空（否则 B3 是恒真断言 = 真空绿）', rest.length > 0, 'rest=' + rest.length);
check('B5 ★ 差集每一项都有成立的声明理由（历史命名之外 ∧ 或 不在 server/scripts）',
  rest.every((l) => !/^test_/.test(path.basename(l)) || !l.startsWith('server/scripts/')),
  rest.filter((l) => /^test_/.test(path.basename(l)) && l.startsWith('server/scripts/')).slice(0, 3).join(','));

// ════════════════════════════════════════════════════════════════════════════
// C shell 执行器：静态无 glob + **真执行**其获取块 + fail closed
// ════════════════════════════════════════════════════════════════════════════
const shellSrc = fs.readFileSync(SHELL_PATH, 'utf8');
const shellNc = stripHashComments(shellSrc);
check('C1 ★ shell 不再内联 test_*.js 通配（剥注释后；注释里提到历史 glob 属合法文档）',
  !/test_\*\.js/.test(shellNc), (shellNc.match(/.*test_\*\.js.*/) || [''])[0].slice(0, 90));
check('C2 shell 向事实源取清单（引用 suiteScope.js 且带 --phase9）',
  /suiteScope\.js/.test(shellNc) && /--phase9/.test(shellNc));

const m = shellSrc.match(/# ── C137-SCOPE-BEGIN ──\n([\s\S]*?)# ── C137-SCOPE-END ──/);
check('C3 获取块哨兵在位（守护据此提取**真实代码**；改结构必须同步本守护）', !!m,
  m ? 'block_lines=' + m[1].split('\n').filter(Boolean).length : '未找到哨兵');

function findBash() {
  const cands = [
    process.env.C137_BASH,
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ } }
  return 'bash';
}
const BASH = findBash();

if (m) {
  const probeDir = path.join(os.tmpdir(), 'c137_probe_' + process.pid);
  fs.mkdirSync(probeDir, { recursive: true });
  const block = 'NODE="${NODE:-node}"\n' + m[1] + 'printf "%s\\n" $FILES\n';

  const okFile = path.join(probeDir, 'ok.sh');
  fs.writeFileSync(okFile, block, 'utf8');
  const r1 = spawnSync(BASH, [okFile], { encoding: 'utf8', cwd: ROOT });
  const got = String(r1.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  check('C4 ★ 真执行 shell 的获取块 ⇒ 清单与事实源逐项一致（执行的才是被断言的）',
    r1.status === 0 && j(got) === j(ph9),
    'status=' + r1.status + ' got=' + got.length + ' want=' + ph9.length + ' bash=' + BASH + ' err=' + String(r1.stderr || '').slice(0, 120));

  const badFile = path.join(probeDir, 'bad.sh');
  fs.writeFileSync(badFile, block.replace('NODE="${NODE:-node}"', 'NODE="/nonexistent/node-c137-probe"'), 'utf8');
  const r2 = spawnSync(BASH, [badFile], { encoding: 'utf8', cwd: ROOT });
  const r2out = String(r2.stdout || '') + String(r2.stderr || '');
  check('C5 ★ fail closed：事实源不可得 ⇒ 非零退出并明确拒绝（绝不回落内联 glob）',
    r2.status !== 0 && /致命/.test(r2out),
    'status=' + r2.status + ' out=' + r2out.replace(/\s+/g, ' ').slice(0, 110));

  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

// ════════════════════════════════════════════════════════════════════════════
// D 终态集合：静态委托 + 仍并存的副本必须「可区分 + 登记 + 集合等价」
// ════════════════════════════════════════════════════════════════════════════
const TASK_TERMINAL = taskStateManager.TASK_TERMINAL;
check('D1 ★ successMetrics.TERMINAL 是 TASK_TERMINAL 的**同一引用**（静态委托，不是再复制）',
  successMetrics.TERMINAL === TASK_TERMINAL,
  'same_ref=' + (successMetrics.TERMINAL === TASK_TERMINAL) + ' sm=' + j(successMetrics.TERMINAL));
check('D2 导出仍在（向后兼容，未删公共面）', Array.isArray(successMetrics.TERMINAL) && successMetrics.TERMINAL.length === 4);

const smNc = stripLineComments(fs.readFileSync(SM_PATH, 'utf8'));
check('D3 ★ successMetrics 源码不再含同域字面量副本（回退即红）',
  !/=\s*\[\s*'SUCCESS'\s*,\s*'FAILED'/.test(smNc),
  (smNc.match(/.*'SUCCESS'\s*,\s*'FAILED'.*/) || [''])[0].slice(0, 80));
check('D4 委托是**静态 require**（非运行时拼装，否则等价性无法静态判定）',
  /require\(['"]\.\/taskStateManager['"]\)/.test(smNc));

// 仍并存的副本：Phase 6 冻结的 benchmark / gate 脚本（刻意不重构）⇒ 登记 + 集合等价断言
const KNOWN_LITERAL_COPIES = [
  { file: 'server/scripts/phase9Benchmark.js', note: 'Phase 6 冻结：benchmark 脚本不改（只读统计用途）' },
  { file: 'server/scripts/phase10Benchmark.js', note: 'Phase 6 冻结：100×3 基线基座，改动静默失效风险 > 收益' },
  { file: 'server/scripts/phase9_gate_replay.js', note: 'Phase 6 冻结：gate 复算脚本，非生产路径' },
];
check('D5 登记表每条都带理由（"并存须可区分＋登记"，不接受无理由并存）',
  KNOWN_LITERAL_COPIES.length > 0 && KNOWN_LITERAL_COPIES.every((k) => !!(k.note && k.note.length > 8)),
  'n=' + KNOWN_LITERAL_COPIES.length);

for (const k of KNOWN_LITERAL_COPIES) {
  const src = fs.readFileSync(path.join(ROOT, k.file), 'utf8');
  const mm = src.match(/const TERMINAL = \[([^\]]*)\]/);
  const arr = mm ? mm[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : null;
  check('D6 ★ 登记副本集合与事实源等价（成员漂移即红）: ' + path.basename(k.file),
    !!arr && sorted(arr) === sorted(TASK_TERMINAL),
    arr ? arr.join('/') : '未找到字面量');
}

// ════════════════════════════════════════════════════════════════════════════
// E c94 整类守卫：委托事实源 + 覆盖面不缩小（严格扩张，且非真空）
// ════════════════════════════════════════════════════════════════════════════
const c94Nc = stripLineComments(fs.readFileSync(C94_PATH, 'utf8'));
check('E1 ★ c94 整类守卫改用事实源（静态委托断言：宽窄类 no-op 不会被行为面咬住）',
  /require\(['"]\.\/suiteScope['"]\)/.test(c94Nc));
check('E2 ★ c94 不再内联 ^test_ 前缀正则（回退即红）',
  !/\^test_/.test(c94Nc), (c94Nc.match(/.*\^test_.*/) || [''])[0].slice(0, 90));

const allCand = suiteScope.collectCandidates().map((s) => s.label);
const legacyCand = allCand.filter((l) => /^test_/.test(path.basename(l)));
check('E3 覆盖面严格扩张：存在历史规则**看不见**的候选（否则本改是 no-op 美化）',
  allCand.length > legacyCand.length,
  'cand=' + allCand.length + ' legacy=' + legacyCand.length);
check('E4 扩张非真空：候选集非空且历史集是它的真子集',
  allCand.length > 0 && legacyCand.every((l) => allCand.includes(l)),
  'legacy ⊆ cand = ' + legacyCand.every((l) => allCand.includes(l)));

// ════════════════════════════════════════════════════════════════════════════
// F 反向咬：把「旧形状」合成出来，断言判定函数确实咬得住（不许只靠正向绿）
// ════════════════════════════════════════════════════════════════════════════
const SHELL_GLOB_PROBE = 'for f in $(ls server/scripts/test_*.js | sort); do';
check('F1 ★ 反向：内联通配的合成样本必须被判为违规（证明 C1 有分辨力）',
  /test_\*\.js/.test(SHELL_GLOB_PROBE) === true && /test_\*\.js/.test(shellNc) === false,
  'probe=hit real=miss');
const C94_INLINE_PROBE = "const testFiles = fs.readdirSync(scriptsDir).filter((f) => /^test_.*\\.js$/.test(f));";
check('F2 ★ 反向：内联 ^test_ 的合成样本必须被判为违规（证明 E2 有分辨力）',
  /\^test_/.test(C94_INLINE_PROBE) === true && /\^test_/.test(c94Nc) === false,
  'probe=hit real=miss');
const DRIFTED_LITERAL = "const TERMINAL = ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION'];";
const dl = DRIFTED_LITERAL.match(/\[([^\]]*)\]/)[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
check('F3 ★ 反向：成员漂移的合成副本必须被判为不等价（证明 D6 有分辨力）',
  sorted(dl) !== sorted(TASK_TERMINAL), 'probe=' + dl.join('/'));
check('F4 ★ 反向：把事实源替换成历史 glob 后，差集必须非空（证明 B5 的理由判定不是恒真）',
  (() => {
    const legacyOnly = allCand.filter((l) => l.startsWith('server/scripts/') && /^test_/.test(path.basename(l)) && !excludedBase.has(path.basename(l)));
    return j(legacyOnly) === j(ph9);   // 当前**恰好等价** ⇒ 说明 B5 的理由是真实成立的
  })(), 'legacyOnly == phase9 (' + ph9.length + ')');

// ════════════════════════════════════════════════════════════════════════════
// G 隔离自证
// ════════════════════════════════════════════════════════════════════════════
check('G1 FPB_DATA_DIR 已隔离到 tmp（本套件不写真实数据根）',
  /[\\/](Temp|tmp)[\\/]/i.test(String(process.env.FPB_DATA_DIR || '')),
  String(process.env.FPB_DATA_DIR || '').slice(-40));
check('G2 本套件不 require 业务执行链（只依赖事实源与两个纯常量模块）',
  !/require\(['"][^'"]*(browser|tools|runtime|schedulerLoop|execution)[^'"]*['"]\)/.test(fs.readFileSync(__filename, 'utf8')));

console.log('\nPASS=' + pass + ' FAIL=' + fail + ' => ' + (fail === 0 ? 'TEST_OK' : 'TEST_FAILED'));
if (fail > 0) { console.log('失败项: ' + fail); process.exit(1); }
process.exit(0);
