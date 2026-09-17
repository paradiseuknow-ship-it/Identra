'use strict';

/**
 * test_c141_task_wait_singleton.js
 *
 * C141 守护：任务状态等待原语必须是**单一实现**，且收口必须**双向咬得住**。
 *
 * 缺陷背景（C141 §A 全仓横扫，600 个 .js）：
 *   ① A 类真缺陷 —— server/agent/runtime.js 的 ensureBrowser 在 async 函数内用**同步忙等**
 *      （`while (Date.now() < end) {}`，300ms/600ms）做重试退避 ⇒ 阻塞事件循环；同文件 :110
 *      已有正确的非阻塞 backoffSleep，属同文件两种写法并存。
 *   ② B 类一致性 —— `waitStatus` 在 4 个套件里各有一份**逐字同形**的复制
 *      （testAgentPhase5 / 22 / 23 / 31）。C140 为修一个语义缺陷（终态词表漏 HUMAN_ESCALATION /
 *      混入非终态 PAUSED_FOR_HUMAN）必须逐文件手工改 4 遍 ⇒ 逻辑复制 N 份，修复代价 N 倍，
 *      且任何一份漏改都是**静默**分叉。
 *
 * 守护策略（每条判据都配 revert 对照，防真空绿）：
 *   A 单一实现本身 —— 存在、可加载、无死导出、arity 与真实调用点一致
 *   B 委托关系     —— 4 个套件必须委托，且体内**不得**再有循环体（含 revert 注入对照）
 *   C ★ 全仓唯一性 —— 扫描全部 server/scripts/*.js，等待循环体只允许出现在白名单；
 *                    白名单里的「登记排除」套件必须在 EXCLUDED_SUITES.json 中在册（防过期登记）
 *   D 真实行为     —— 从 taskWait.js 源码提取**真实函数体**用 stub 实跑（不复制实现）
 *   E 接口不变量   —— 本批**不得**破坏 c119 A6 / c140 C5-C5b 依赖的形状
 *   F 防空断言     —— 证明提取器/特征正则不是恒空或恒真
 *   G 隔离
 *
 * 隔离：FPB_DATA_DIR 指向 tmp 且置于**首个 require 之前**（入集前提）。本套件零浏览器、零 LLM、
 * 零网络；仅 require taskWait（其传递依赖 taskManager）用于断言导出面。
 */

// 数据根隔离必须早于**任何** require（含 node 内置）：dataRoot / browserManager / identityStore
// 的数据根在**模块加载期**解析，晚于首个 require 的隔离行只覆盖一半（C140 EX-08 同族实证）。
// 故此处用内联 require 把隔离行顶到最前，使本套件满足最严形态。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c141_task_wait_' + Date.now());

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = __dirname;
const TASKWAIT_PATH = path.join(SCRIPTS, 'taskWait.js');
const SUITES = ['testAgentPhase5.js', 'testAgentPhase22.js', 'testAgentPhase23.js', 'testAgentPhase31.js'];
const EXCLUDED_PATH = path.join(SCRIPTS, 'EXCLUDED_SUITES.json');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}
const j = (a) => JSON.stringify(a);
const read = (p) => fs.readFileSync(p, 'utf8');

// ── 只剥**整行注释**（字符串里的 // 不能被误剥；内联注释里的示例属合法文档）──
const stripLineComments = (s) => s.split('\n').filter((l) => {
  const t = l.trim();
  return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
}).join('\n');

// ── 把字符串字面量整体替换为等长空白（字符串**不是代码**）──
// 这一步是本守护能扫描**自身**的前提：本文件里的特征正则/回退样例都以字符串形态存在，
// 若不遮蔽，扫描器会把自己的样例文本当成「一个复制体」而自我误报。
function blankStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\'' || c === '"') {
      const q = c;
      out += ' ';
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += ' ';
        i++;
      }
      out += ' ';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ── 花括号配对取函数体 ──
function extractFunctionBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// A 单一实现本身
// ════════════════════════════════════════════════════════════════════════════
console.log('[A] 单一实现');
const twSrc = read(TASKWAIT_PATH);
const twCode = blankStrings(stripLineComments(twSrc));

let twMod = null;
try { twMod = require(TASKWAIT_PATH); } catch (e) { twMod = { __err: String((e && e.message) || e) }; }
check('A1 taskWait.js 可加载且导出 waitTaskStatus 函数',
  !!twMod && typeof twMod.waitTaskStatus === 'function',
  twMod && twMod.__err ? twMod.__err : 'typeof=' + typeof (twMod && twMod.waitTaskStatus));

// 无死导出：收口模块只允许导出被消费的那一个名字（C137 已为 successMetrics.TERMINAL 立过先例）
const exportKeys = twMod ? Object.keys(twMod).sort() : [];
check('A2 ★ 无死导出：导出面恰好 [waitTaskStatus]',
  j(exportKeys) === j(['waitTaskStatus']), 'keys=' + j(exportKeys));

// arity 必须与**全部真实调用点**一致 —— 不得挂未被消费的可选参数（L16：不为不存在的形状写代码）
check('A3 arity===3（taskId, targets, timeoutMs），无未被消费的参数',
  !!twMod && twMod.waitTaskStatus.length === 3,
  'arity=' + (twMod && twMod.waitTaskStatus && twMod.waitTaskStatus.length));

// 轮询常量从源码解析（不硬编码期望值）；收口前 4 份统一为 600ms ⇒ 等价锚
const mPoll = twCode.match(/const\s+POLL_MS\s*=\s*(\d+)/);
const pollMs = mPoll ? Number(mPoll[1]) : null;
check('A4 轮询间隔可从源码解析且为 600（收口前 4 份的统一原值）',
  pollMs === 600, 'POLL_MS=' + pollMs);
check('A4b 防空：A4 的提取器不是恒 null（特征真的在源码里）',
  mPoll !== null, 'match=' + j(mPoll && mPoll[0]));

// ════════════════════════════════════════════════════════════════════════════
// B 委托关系（正向）
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[B] 委托关系');
const suiteSrc = {};
for (const f of SUITES) suiteSrc[f] = read(path.join(SCRIPTS, f));

const requiresDelegate = (src) => /require\(\s*'\.\/taskWait'\s*\)/.test(src);
const bodyDelegates = (src) => /async\s+function\s+waitStatus\s*\([^)]*\)\s*\{\s*return\s+taskWait\.waitTaskStatus\(\s*taskId\s*,\s*targets\s*,\s*timeoutMs\s*\)\s*;\s*\}/.test(src);

const noRequire = SUITES.filter((f) => !requiresDelegate(suiteSrc[f]));
check('B1 4 个套件均 require ./taskWait', noRequire.length === 0, noRequire.join(','));
const noDeleg = SUITES.filter((f) => !bodyDelegates(suiteSrc[f]));
check('B2 ★ 4 个套件的 waitStatus 体是单行委托（保留 async function 外壳）',
  noDeleg.length === 0, noDeleg.join(','));

// ★ 体内不得再有循环体：从**真实源码**取函数体后判定
const loopInBody = [];
for (const f of SUITES) {
  const b = extractFunctionBody(suiteSrc[f], 'waitStatus');
  if (!b) { loopInBody.push(f + '(体提取失败)'); continue; }
  const bc = blankStrings(stripLineComments(b));
  if (/while\s*\(/.test(bc) || /targets\.includes\(/.test(bc) || /taskManager\.getTask\(/.test(bc)) {
    loopInBody.push(f);
  }
}
check('B3 ★ 4 个套件的 waitStatus 体内不再有循环体（while / targets.includes / taskManager.getTask）',
  loopInBody.length === 0, loopInBody.join(','));

// revert 对照：把旧循环体插回委托体，B3 的判据必须翻红
const REVERTED_BODY = 'async function waitStatus(taskId, targets, timeoutMs) {\n'
  + '  const end = Date.now() + timeoutMs;\n'
  + '  while (Date.now() < end) {\n'
  + '    const t = taskManager.getTask(taskId);\n'
  + '    if (t && targets.includes(t.status)) return t;\n'
  + '    await sleep(600);\n'
  + '  }\n'
  + '  return taskManager.getTask(taskId);\n'
  + '}';
const revertedBc = blankStrings(stripLineComments(REVERTED_BODY));
check('B4 revert 对照：旧循环体必须被判为「体内有循环」（否则 B3 是真空绿）',
  /while\s*\(/.test(revertedBc) && /targets\.includes\(/.test(revertedBc), '');
check('B5 revert 对照：旧实现文本不得被判为「单行委托」（否则 B2 是真空绿）',
  !bodyDelegates(REVERTED_BODY), '');

// ════════════════════════════════════════════════════════════════════════════
// C ★ 全仓唯一性
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[C] 全仓唯一性');
// 等待循环特征 = 「按状态集合.contains(status) 做命中判定」+「while 时间窗」
const RE_MARK_A = /targets\.includes\(/;
const RE_MARK_B = /while\s*\(\s*Date\.now\(\)\s*</;
const hasWaitLoop = (code) => RE_MARK_A.test(code) && RE_MARK_B.test(code);

// 白名单：唯一实现 + 3 个登记排除面（Phase2/3 = 500ms 轮询·账号依赖；Phase4 = 走 HTTP·需后端）
const WHITELIST = ['taskWait.js', 'testAgentPhase2.js', 'testAgentPhase3.js', 'testAgentPhase4.js'];

const jsFiles = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.js')).sort();
check('C0 防空：待扫描文件数 > 50（扫描面非空）', jsFiles.length > 50, 'n=' + jsFiles.length);

const detected = [];
for (const f of jsFiles) {
  let code;
  try { code = blankStrings(stripLineComments(read(path.join(SCRIPTS, f)))); } catch (e) { continue; }
  if (hasWaitLoop(code)) detected.push(f);
}
check('C0b 防空：特征正则能命中白名单里的 taskWait.js（否则说明特征恒假、C1 退化为真空绿）',
  detected.includes('taskWait.js'), 'detected=' + j(detected));

const unexpected = detected.filter((f) => !WHITELIST.includes(f));
check('C1 ★ 等待循环体只出现在白名单（无第二份复制体）', unexpected.length === 0, unexpected.join(','));

// 防空：白名单每一项必须真的在场（登记不得过期 → 过期即红）
const staleWhite = WHITELIST.filter((f) => !detected.includes(f));
check('C2 ★ 白名单登记未过期：每一项都必须真的含等待循环体（否则白名单在漂移）',
  staleWhite.length === 0, staleWhite.join(','));

// ★ 4 个已收口套件**不得**再出现在扫描结果里（与 C1 互补：C1 管「无意外体」，此处管「收口面的体真的没了」）
const stillCopied = SUITES.filter((f) => detected.includes(f));
check('C3 ★ 4 个已收口套件不得再含等待循环体', stillCopied.length === 0, stillCopied.join(','));

// ★ 登记的「不可验证」前提必须成立：白名单里非唯一实现的 3 项必须在 EXCLUDED_SUITES.json 在册
let excludedFiles = [];
try {
  const ex = JSON.parse(read(EXCLUDED_PATH));
  excludedFiles = (ex.suites || []).map((s) => s.file);
} catch (e) { excludedFiles = []; }
check('C4 防空：EXCLUDED_SUITES.json 可解析且非空（否则 C5 退化为真空绿）',
  excludedFiles.length > 0, 'n=' + excludedFiles.length);
const boundary = WHITELIST.filter((f) => f !== 'taskWait.js');
const notRegistered = boundary.filter((f) => !excludedFiles.includes(f));
check('C5 ★ 白名单里的 3 个边界套件全部在 EXCLUDED_SUITES.json 在册（「改动不可验证」的前提成立）',
  notRegistered.length === 0, notRegistered.join(','));

// revert 对照：把复制体注入一个已收口套件的文本，C1/C3 必须翻红
const FROZEN_SUITE = suiteSrc[SUITES[0]];
const injected = FROZEN_SUITE.replace('return taskWait.waitTaskStatus(taskId, targets, timeoutMs);',
  'return taskWait.waitTaskStatus(taskId, targets, timeoutMs); /* revert */');
const injectedWithLoop = FROZEN_SUITE.split('\n').slice(0, 5).join('\n') + '\n' + REVERTED_BODY + '\n' + FROZEN_SUITE.split('\n').slice(5).join('\n');
check('C6 revert 对照：向已收口套件注入旧循环体 ⇒ 特征必须命中（C1/C3 有分辨力）',
  hasWaitLoop(blankStrings(stripLineComments(injectedWithLoop))) && !hasWaitLoop(blankStrings(stripLineComments(injected))),
  '');

// ════════════════════════════════════════════════════════════════════════════
// D 真实行为（从源码提取真实函数体实跑，不复制实现）
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[D] 真实行为');
// 终态词表 stub（与 taskStateManager.TASK_TERMINAL 同集合；此处独立给出，使 D 组不依赖业务模块）
const TASK_TERMINAL_STUB = ['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'];

function extractFunctionDecl(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return null;
}

const twBody = extractFunctionDecl(stripLineComments(twSrc), 'waitTaskStatus');
check('D0 waitTaskStatus 真实函数**声明**可提取（防空：提取失败时 D1-D5 全部退化为真空绿）',
  !!twBody, twBody ? 'len=' + twBody.length : 'regex/配对未命中');
check('D0b 提取到的必须是 async 函数声明（裸块会让 new Function 抛 await 非法 ⇒ 整组崩溃而非失败）',
  !!twBody && /^async\s+function\s+waitTaskStatus\s*\(/.test(twBody.trim()), '');

// 工厂：闭包注入 stub taskManager / sleep / POLL_MS，得到**真实函数体**构造出的函数。
// ★ 构造失败必须变成 check FAIL 而不是抛崩（崩溃的守护 = 零信号，无法定位）。
let buildErr = null;
function makeRealFn(stubGetTask, sleepLog) {
  try {
    const fn = new Function('taskManager', 'sleep', 'POLL_MS',
      twBody + '\nreturn waitTaskStatus;');
    return fn({ getTask: stubGetTask }, (ms) => { sleepLog.push(ms); return new Promise((r) => setTimeout(r, 1)); }, pollMs);
  } catch (e) {
    buildErr = String((e && e.message) || e);
    return null;
  }
}

(async () => {
  check('D0c 真实声明可被 new Function 构造（否则 D 组不可用，须显式失败）', (() => {
    const probe = makeRealFn(() => ({ status: 'FAILED' }), []);
    return !!probe;
  })(), buildErr ? 'err=' + buildErr : '');

  if (twBody && !buildErr) {
    // D1 命中即返回，零等待
    {
      const log = [];
      let calls = 0;
      const hits = { status: 'FAILED', id: 't1' };
      const f = makeRealFn(() => { calls++; return hits; }, log);
      const t0 = Date.now();
      const r = await f('t1', TASK_TERMINAL_STUB, 30000);
      const el = Date.now() - t0;
      check('D1 命中目标 ⇒ 立即返回该对象（calls===1 且不睡）',
        r === hits && calls === 1 && log.length === 0, 'calls=' + calls + ' sleeps=' + log.length + ' elapsed=' + el + 'ms');
    }

    // D2 未命中 ⇒ 轮询到超时，返回**最后一次**读到的任务；且间隔取自源码常量
    {
      const log = [];
      let calls = 0;
      const running = { status: 'RUNNING', id: 't2' };
      const f = makeRealFn(() => { calls++; return running; }, log);
      const r = await f('t2', TASK_TERMINAL_STUB, 60);
      check('D2 未命中 ⇒ 轮询至超时后返回最后一次读到的任务（calls≥2）',
        r === running && calls >= 2, 'calls=' + calls + ' status=' + (r && r.status));
      check('D2b ★ 轮询间隔取自源码 POLL_MS（每一次 sleep 的实参都等于它）',
        log.length > 0 && log.every((ms) => ms === pollMs), 'sleeps=' + j(log.slice(0, 3)) + ' POLL_MS=' + pollMs);
    }

    // D3 ★ 非终态不得被当作命中（C140 缺陷类的结构复现）
    {
      const log = [];
      let calls = 0;
      const paused = { status: 'PAUSED_FOR_HUMAN', id: 't3' };
      const f = makeRealFn(() => { calls++; return paused; }, log);
      const r = await f('t3', TASK_TERMINAL_STUB, 60);
      check('D3 ★ 非终态（PAUSED_FOR_HUMAN ∉ targets）不得提前返回，必须走到超时（calls≥2）',
        r === paused && calls >= 2, 'calls=' + calls + ' status=' + (r && r.status));
      // revert 对照：targets 误含该非终态 ⇒ 必须提前返回（证明 D3 的 calls≥2 有分辨力）
      const log2 = [];
      let calls2 = 0;
      const f2 = makeRealFn(() => { calls2++; return paused; }, log2);
      const r2 = await f2('t3', ['PAUSED_FOR_HUMAN'].concat(TASK_TERMINAL_STUB), 60);
      check('D3b revert 对照：targets 误含 PAUSED_FOR_HUMAN ⇒ 立即命中（calls===1）',
        r2 === paused && calls2 === 1, 'calls=' + calls2);
    }

    // D4 任务不存在（null）不得崩，且超时后返回 null
    {
      const log = [];
      let calls = 0;
      const f = makeRealFn(() => { calls++; return null; }, log);
      let threw = null;
      let r = 'UNSET';
      try { r = await f('nope', TASK_TERMINAL_STUB, 40); } catch (e) { threw = String((e && e.message) || e); }
      check('D4 getTask 恒 null ⇒ 不抛错且超时后返回 null（收口前后行为一致）',
        threw === null && r === null && calls >= 2, 'threw=' + threw + ' r=' + j(r) + ' calls=' + calls);
    }

    // D5 ★ 与模块导出面一致：源码提取体 vs 真实模块 —— 同一份东西
    {
      const log = [];
      let calls = 0;
      const hits = { status: 'SUCCESS', id: 't5' };
      const stub = () => { calls++; return hits; };
      const viaSource = await makeRealFn(stub, log)('t5', TASK_TERMINAL_STUB, 30000);
      check('D5 源码提取体的行为与模块导出面一致（命中即返回同一对象）',
        viaSource === hits && calls === 1, 'calls=' + calls);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // E 接口不变量（本批不得破坏 c119 A6 / c140 C5-C5b 依赖的形状）
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[E] 接口不变量');
  const defsLeft = SUITES.filter((f) => !/function\s+waitStatus\(/.test(suiteSrc[f]));
  check('E1 ★ 4 个套件仍保留 `function waitStatus(` 定义（c119 A6 的 defs 依赖，去掉即漂移）',
    defsLeft.length === 0, defsLeft.join(','));

  // c119 A6 的算式：waitStatus( 出现数 − function waitStatus( 定义数 === 等待窗（调用点）数
  // ★ 与 c119 的**实际判定**对齐：c119 的 A 组先剥注释再做该算式，故此处也必须剥注释 ——
  //   否则注释里的锚形文本会被算进来，得到与 c119 不一致（且更严于真相）的结论。
  const countA6 = (src) => ({
    calls: (src.match(/waitStatus\(/g) || []).length,
    defs: (src.match(/function\s+waitStatus\(/g) || []).length,
    sites: (src.match(/await\s+waitStatus\(/g) || []).length,
  });
  const a6 = [];
  for (const f of SUITES) {
    const c = countA6(stripLineComments(suiteSrc[f]));
    if (!(c.defs === 1 && c.calls - c.defs === c.sites)) a6.push(f + j(c));
  }
  check('E2 ★ 剥注释后 c119 A6 算式仍自洽（defs===1 且 calls − defs === 调用点数）',
    a6.length === 0, a6.join(','));

  // revert 对照：注释里写锚形文本会污染「未剥注释」的计数 ⇒ 证明 E2 的「剥注释」是承重的，
  // 也钉住「注释不得写锚形文本」这条纪律（C131 同族教训：共享实现的注释会扫红锚字面形状的守护）。
  const cleanBase = countA6(stripLineComments(suiteSrc[SUITES[0]]));
  const polluted = countA6('// 锚形文本示例：await ' + 'waitStatus(t.id, T, 1);\n'
    + stripLineComments(suiteSrc[SUITES[0]]));
  check('E2b ★ revert 对照：注释里的锚形文本确实会污染未剥注释的计数（证明 E2 的剥注释承重）',
    polluted.sites > cleanBase.sites,
    'clean=' + j(cleanBase) + ' polluted=' + j(polluted));

  // c140 C5：调用行不得是手写字面终态清单；C5b：目标必须派生自 TASK_TERMINAL
  const litLeft = [];
  const notDerived = [];
  for (const f of SUITES) {
    const src = suiteSrc[f];
    const bad = src.split('\n').filter((l) => /waitStatus\(/.test(l) && /\[\s*'/.test(l));
    if (bad.length) litLeft.push(f);
    if (!(/waitStatus\([^)]*TASK_TERMINAL/.test(src))) notDerived.push(f);
  }
  check('E3 ★ 4 个套件的 waitStatus 调用目标仍无手写字面清单（c140 C5 依赖）',
    litLeft.length === 0, litLeft.join(','));
  check('E4 ★ 4 个套件的 waitStatus 目标仍派生自 TASK_TERMINAL（c140 C5b 依赖）',
    notDerived.length === 0, notDerived.join(','));

  // 本批新增的 require 必须在数据根隔离行**之后**（入集前提，C135 F1 同族纪律）
  const isoBad = [];
  for (const f of SUITES.concat(['test_c141_task_wait_singleton.js'])) {
    let src;
    try { src = read(path.join(SCRIPTS, f)); } catch (e) { continue; }
    const lines = src.split('\n');
    const iso = lines.findIndex((l) => /process\.env\.FPB_DATA_DIR\s*=/.test(l));
    const firstReq = lines.findIndex((l) => /^\s*(const|let|var)\s.*=\s*require\(/.test(l));
    if (!(iso >= 0 && firstReq > iso)) isoBad.push(f + '(iso=' + iso + ' firstReq=' + firstReq + ')');
  }
  check('E5 隔离行早于首个 require（含本套件自身）', isoBad.length === 0, isoBad.join(','));

  // ══════════════════════════════════════════════════════════════════════════
  // G 隔离
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n[G] 隔离');
const dd = String(process.env.FPB_DATA_DIR || '');
// 判据必须与 os.tmpdir() 比对（Windows 上是 `C:\...\AppData\Local\Temp`，含 "emp" 不含 "tmp"
// —— 写成 /tmp/i 会恒假；C141 首跑实测该假红，已改为与事实源比对）
const tmpRoot = os.tmpdir();
check('G1 FPB_DATA_DIR 落在 os.tmpdir() 下且不在仓库内',
  dd.length > 0 && dd.indexOf(tmpRoot) === 0 && dd.indexOf(ROOT) < 0,
  'FPB_DATA_DIR=' + dd + ' tmp=' + tmpRoot);

  console.log('\n== C141 结果: PASS ' + pass + ' / FAIL ' + fail + ' ==');
  process.exit(fail ? 1 : 0);
})();
