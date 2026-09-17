'use strict';

// C140 守护套件：修复策略动作契约 + 套件夹具契约 + 跨层预算不变量 + 仓库自洽。
//
// 归属背景（C140 归因结论）：
//   · A 类真缺陷：repair/strategies/obstruction.js 与 sessionExpired.js 的内部 click 写
//     verification:{type:'none'}，而 click 在 schema/action.js 的 MUST_VERIFY 名单内、
//     tools.execute 第 171-172 行对每个动作再校验一次 ⇒ 两条策略的核心动作**结构性不可达**
//     （DISMISS_OVERLAY / REAUTH_OR_PAUSE 的死路径，实测 validateAction 直接 REJECT）。
//   · C 类测试过时：Phase5/Phase23 的夹具在 click 强制 verification 契约下无法诚实验证；
//     终态词表漏 HUMAN_ESCALATION 导致观测窗空转；/flaky4 的慢请求数是旧恢复预算的快照。
//
// 纪律：断言**真正执行的那份东西**——策略提交的动作由策略自身代码构造（runAction 只作收集器），
// 校验用生产同一函数 validateAction；源码级判据一律配 shape + revert + missing 三向，且带防空断言。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripLineComments = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const { validateAction } = require('../agent/schema/action');
const obstruction = require('../agent/repair/strategies/obstruction');
const sessionExpired = require('../agent/repair/strategies/sessionExpired');
// 真终态集合的**唯一事实源**（生产同一常量）—— C 组据此判「等待目标是否派生自事实源」，
// 而不是把词表再手抄一份进守护（L1：不留第二份同义实现）。
const { TASK_TERMINAL } = require('../agent/taskStateManager');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

// 收集器：策略代码自己构造动作，本函数只记录（返回 failure ⇒ 让 obstruction 遍历全部语义）
async function collect(mod, ctxInput) {
  const seen = [];
  const ctx = { runAction: async (a) => { seen.push(a); return { success: false }; } };
  let out = null;
  try { out = await mod.execute({ task: ctxInput.task, step: ctxInput.step, ctx }); }
  catch (e) { out = { ok: false, actions: [], error: String(e.message || e) }; }
  return { seen, out };
}

async function main() {
  console.log('== C140 修复策略动作契约 + 夹具契约 + 跨层预算不变量 ==');

  // ── A 组：策略产出的动作必须过生产 schema 门槛 ──
  console.log('\n[A] 修复策略提交的动作 × 生产 validateAction');
  const stepFor = { id: 's1', action: { type: 'click', target: { semantic: 'continue' }, risk: 'LOW', verification: { type: 'page_change' } } };

  const obs = await collect(obstruction, { task: { id: 't1' }, step: stepFor });
  const obsClicks = obs.seen.filter((a) => a && a.type === 'click');
  console.log('  · obstruction 提交 ' + obs.seen.length + ' 个动作，其中 click ' + obsClicks.length + ' 个：' +
    JSON.stringify(obs.seen.map((a) => a.type + ':' + (a.target && a.target.semantic || '-') + '/' + (a.verification && a.verification.type))));
  ok(obsClicks.length >= 2, 'A0 防空：obstruction 确实提交了多个 dismiss click（非空收集）', 'clicks=' + obsClicks.length);
  const obsBad = obs.seen.filter((a) => !validateAction(a).ok);
  ok(obsBad.length === 0, 'A1 obstruction 提交的每个动作都通过 validateAction（DISMISS_OVERLAY 不再结构性不可达）',
    obsBad.map((a) => a.type + '→' + validateAction(a).errors.join('|')).join(' ; '));

  const ses = await collect(sessionExpired, {
    task: { id: 't2', policy: { reauth: 'auto' }, secretRefs: ['sec_1'] },
    step: { id: 's2', action: { type: 'click', target: { semantic: 'login' }, risk: 'MEDIUM', verification: { type: 'page_change' } } },
  });
  ok(ses.seen.length >= 1, 'A2 防空：sessionExpired 自动重登分支确实提交了动作', 'n=' + ses.seen.length);
  const sesBad = ses.seen.filter((a) => !validateAction(a).ok);
  ok(sesBad.length === 0, 'A3 sessionExpired 提交的每个动作都通过 validateAction',
    sesBad.map((a) => a.type + '→' + validateAction(a).errors.join('|')).join(' ; '));

  // A4/A5：判据必须有分辨力（把 verification 改回 none 必须被 validateAction 咬住）
  const badClick = { type: 'click', target: { semantic: 'accept' }, risk: 'LOW', verification: { type: 'none' } };
  ok(!validateAction(badClick).ok, 'A4 正向对照：click + verification{none} 必须被生产门槛拒绝（判据非恒真）');
  const goodClick = { type: 'click', target: { semantic: 'accept' }, risk: 'LOW', verification: { type: 'page_change' } };
  ok(validateAction(goodClick).ok, 'A5 反向对照：同一语义 + page_change 必须放行（差异仅在 verification）');

  // ── B 组：两处 A 类修复的源码形状（shape + revert + missing）──
  console.log('\n[B] 修复策略源码形状（双向咬）');
  const shapeOf = (rel, declRe, noneRe) => {
    const src = stripLineComments(read(rel));
    return { decl: declRe.test(src), none: noneRe.test(src) };
  };
  const CLICK_NONE = /type:\s*'click'[^\n]*verification:\s*\{\s*type:\s*'none'\s*\}/;
  const CLICK_PC = /type:\s*'click'[^\n]*verification:\s*\{\s*type:\s*'page_change'\s*\}/;

  const oShape = shapeOf('server/agent/repair/strategies/obstruction.js', CLICK_PC, CLICK_NONE);
  ok(oShape.decl && !oShape.none, 'B1 obstruction 的 click 用 page_change 且已无 verification{none}',
    JSON.stringify(oShape));
  const oRevert = CLICK_NONE.test("const res = await ctx.runAction({ type: 'click', target: { semantic: sem }, risk: 'LOW', verification: { type: 'none' } });");
  ok(oRevert, 'B1b revert 对照：把该行改回 verification{none} 必须被同一判据检出（否则判据无效）');
  const oMissing = CLICK_PC.test("const res = await ctx.runAction({ type: 'click', target: { semantic: sem }, risk: 'LOW' });");
  ok(!oMissing, 'B1c missing 对照：删掉 verification 声明时必须判为缺失（不得真空绿）');
  const oForced = /if\s*\(\s*true\s*\)\s*\{[^\n]*ctx\.runAction/.test(read('server/agent/repair/strategies/obstruction.js'));
  ok(!oForced, 'B1d 不得出现强制真值旁路（防空断言）');

  const sShape = shapeOf('server/agent/repair/strategies/sessionExpired.js', CLICK_PC, CLICK_NONE);
  ok(sShape.decl && !sShape.none, 'B2 sessionExpired 的 click 用 page_change 且已无 verification{none}',
    JSON.stringify(sShape));
  ok(CLICK_NONE.test("ctx.runAction({ type: 'click', target: { semantic: 'login' }, risk: 'MEDIUM', verification: { type: 'none' } })"),
    'B2b revert 对照：sessionExpired 旧写法必须被同一判据检出');

  // ── C 组：套件夹具契约（EX-04/EX-05 直钉）──
  console.log('\n[C] 套件夹具契约');
  const p5 = read('server/scripts/testAgentPhase5.js');
  const p23 = read('server/scripts/testAgentPhase23.js');
  // C140 横扫同族时新增的两项：Phase22 含**同源夹具缺陷**（click + verification{none}，第三个实例）、
  // Phase31 含同类等待口径（终态等待表混入非终态）。同族调用点必须一并收口（L5/L15）。
  const p22 = read('server/scripts/testAgentPhase22.js');
  const p31 = read('server/scripts/testAgentPhase31.js');
  const p5No = stripLineComments(p5);
  const p23No = stripLineComments(p23);
  const p22No = stripLineComments(p22);
  const p31No = stripLineComments(p31);

  // C1/C2：click ∈ MUST_VERIFY ⇒ 夹具里「click + verification{none}」是**恒不可达**的动作。
  // 横扫同族发现第三个同源实例（Phase22）——它长期隐身是因为断言不依赖点击成功（只判终态/诊断），
  // 使用例自称的「点击不存在元素 → ELEMENT_NOT_FOUND」从未真正执行。
  const clickNoneLines = (src) => src.split('\n').filter((l) => /type:\s*'click'/.test(l) && /verification:\s*\{\s*type:\s*'none'\s*\}/.test(l));
  ok(clickNoneLines(p5No).length === 0, 'C1 Phase5 无「click + verification{none}」夹具（EX-04 直钉）', clickNoneLines(p5No).join(' | '));
  ok(clickNoneLines(p23No).length === 0, 'C2 Phase23 无「click + verification{none}」夹具', clickNoneLines(p23No).join(' | '));
  ok(clickNoneLines(p22No).length === 0, 'C2c Phase22 无「click + verification{none}」夹具（同源第三例，C140 横扫发现）', clickNoneLines(p22No).join(' | '));
  ok(clickNoneLines("const X = (s) => ({ type: 'click', target: { semantic: s }, verification: { type: 'none' } });").length === 1,
    'C2b revert 对照：旧夹具行必须被同一判据检出');

  ok(/renamed-nav/.test(p5No) && !/localhost:9555\/renamed'/.test(p5No), 'C3 Phase5 §5 已改用可验证夹具 /renamed-nav');
  ok(/renamed-nav/.test(p23No) && !/localhost:9555\/renamed'/.test(p23No), 'C4 Phase23 §8 已改用可验证夹具 /renamed-nav');
  // C5/C6：等待「终态」必须是**派生自唯一事实源**的集合，不能是手写字面清单。
  // 旧字面清单同时犯两个错：(a) 漏 HUMAN_ESCALATION ⇒ 任务已终态仍空转满观测窗（旧版 305s 真因之一）；
  // (b) 混入**非终态** PAUSED_FOR_HUMAN ⇒ waitStatus 在该中间态提前返回，随后读到的是 TOCTOU 竞态读
  // （本套件实测两次运行相反读数：一次 PAUSED_FOR_HUMAN、一次 HUMAN_ESCALATION）。
  // ★ 族级：`waitStatus` 是共享原语，**全部**终态等待点都必须派生自事实源，而不是只修被立案的那两个。
  const WAIT_FAMILY = [['Phase5', p5No], ['Phase22', p22No], ['Phase23', p23No], ['Phase31', p31No]];
  const waitLiteral = (src) => src.split('\n').filter((l) => /waitStatus\(/.test(l) && /\[\s*'/.test(l));
  const waitCalls = (src) => src.split('\n').filter((l) => /await\s+waitStatus\(/.test(l));
  const derived = (src) => /(?:const|let|var)\s*\{[^}]*\bTASK_TERMINAL\b[^}]*\}\s*=\s*require\(/.test(src) && /waitStatus\([^)]*TASK_TERMINAL/.test(src);

  for (const [tag, src] of WAIT_FAMILY) {
    ok(waitCalls(src).length >= 1, 'C5a [' + tag + '] 防空：确有 waitStatus 调用点（否则下列判据真空绿）', String(waitCalls(src).length));
  }
  const litLeft = WAIT_FAMILY.filter(([, src]) => waitLiteral(src).length > 0).map(([t]) => t);
  ok(litLeft.length === 0, 'C5 ★ 族级：4 个套件的 waitStatus 目标全部不再是手写字面终态清单', litLeft.join(','));
  const notDerived = WAIT_FAMILY.filter(([, src]) => !derived(src)).map(([t]) => t);
  ok(notDerived.length === 0, 'C5b ★ 族级：4 个套件的 waitStatus 目标全部由 taskStateManager.TASK_TERMINAL 派生', notDerived.join(','));
  ok(TASK_TERMINAL.includes('HUMAN_ESCALATION'), 'C6c 事实源含 HUMAN_ESCALATION（Phase 5.8 显式交人终态，runtime.js:1205-1210）', JSON.stringify(TASK_TERMINAL));
  ok(!TASK_TERMINAL.includes('PAUSED_FOR_HUMAN'), 'C6d 事实源**不含** PAUSED_FOR_HUMAN（非终态、可 resume）⇒ 结构上不可能再被当作等待目标', JSON.stringify(TASK_TERMINAL));
  ok(waitLiteral("const r = await waitStatus(t.id, ['SUCCESS', 'FAILED', 'PAUSED_FOR_HUMAN'], 1);").length === 1,
    'C6e revert 对照：手写字面清单必须被同一判据检出（含旧值形态）');
  ok(!derived("const r = await waitStatus(t.id, ['SUCCESS', 'FAILED'], 1);"), 'C6f revert 对照：字面清单不得被判为「派生自事实源」');

  // C7：§7/§4 断言必须锚**具体真终态 + 根因文案**，不接受中间态；并显式关闭 replan 以保证确定性
  // （否则归宿取决于 replan 能否收敛 = LLM 可用性 —— 探针实测放开 replan 时 /empty 收敛为 SUCCESS）。
  ok(/r\.status === 'HUMAN_ESCALATION'/.test(p23No), 'C7 Phase23 §7 断言锚 HUMAN_ESCALATION（且带根因文案）');
  ok(/maxReplans:\s*0/.test(p23No), 'C7c Phase23 §7 显式 maxReplans:0（去掉「replan 是否收敛」这一外部变量）');
  ok(/r1\.status === 'HUMAN_ESCALATION'/.test(p22No), 'C7d Phase22 §4 断言锚 HUMAN_ESCALATION（同族同口径）');
  ok(/maxReplans:\s*0/.test(p22No), 'C7e Phase22 §4 显式 maxReplans:0（同族同口径）');
  ok(!/PAUSED_FOR_HUMAN'\s*,\s*'修复耗尽/.test(p23No), 'C7b Phase23 §7 不再断言已废弃的 PAUSED_FOR_HUMAN 终态');
  ok(/resetFlaky4/.test(p23No), 'C8 Phase23 §6 调用夹具复位（消除跨次运行的状态依赖）');

  // ── D 组：跨层预算不变量（防夹具参数再次静默漂移）──
  console.log('\n[D] 跨层预算不变量');
  const siteSrc = read('server/test-site/server.js');
  const rtSrc = read('server/agent/runtime.js');
  const rmSrc = read('server/agent/recovery/recoveryManager.js');

  const mSlow = siteSrc.match(/const FLAKY4_SLOW_REQUESTS\s*=\s*(\d+)/);
  const mRetry = rtSrc.match(/step\.maxRetries\s*\|\|\s*\(task\.policy\s*&&\s*task\.policy\.maxActionRetries\)\s*\|\|\s*(\d+)/);
  const mReload = rmSrc.match(/const RELOAD_CAP_PER_STEP\s*=\s*(\d+)/);
  ok(!!mSlow && !!mRetry && !!mReload, 'D0 三个事实源均可解析（任一缺失即红，避免真空绿）',
    JSON.stringify({ slow: mSlow && mSlow[1], retry: mRetry && mRetry[1], reload: mReload && mReload[1] }));
  if (mSlow && mRetry && mReload) {
    const slow = Number(mSlow[1]), retry = Number(mRetry[1]), reload = Number(mReload[1]);
    const need = 1 + retry + reload; // 恢复期最多 1+retry 次导航 + ≤reload 次 reload ⇒ 请求数上界
    ok(slow > need, 'D1 夹具慢请求数 > 确定性恢复请求上界（否则 Repair 层恒不被触达）', 'slow=' + slow + ' need>' + need);
    ok(!(4 > need), 'D1b revert 对照：旧值 4 必须判为不足（' + 4 + ' > ' + need + ' = ' + (4 > need) + '）');
  }
  ok(/\/flaky4-reset/.test(siteSrc), 'D2 test-site 提供 /flaky4-reset 复位入口');
  ok(/resetFlaky4/.test(read('server/scripts/_testSite.js')), 'D3 _testSite 导出 resetFlaky4');

  const vSite = (siteSrc.match(/const VERSION\s*=\s*(\d+)/) || [])[1];
  const vUtil = (read('server/scripts/_testSite.js').match(/const VERSION\s*=\s*(\d+)/) || [])[1];
  ok(!!vSite && !!vUtil && vSite === vUtil, 'D4 两处 test-site VERSION 严格一致（不一致会让所有浏览器套件启动失败）',
    'server=' + vSite + ' helper=' + vUtil);
  ok(!('9' === vSite), 'D4b revert 对照：VERSION 仍为旧值 9 时本判据不成立（防旧进程复用导致路由缺失）');

  // ── E 组：仓库自洽（_testSite 是常驻依赖，不得被「一次性脚本」通配吞掉）──
  console.log('\n[E] 仓库自洽');
  const gi = read('.gitignore');
  ok(/^\s*!server\/scripts\/_testSite\.js\s*$/m.test(gi), 'E1 .gitignore 为 _testSite.js 放开例外（4 个已入库套件 require 它）');
  ok(/^\s*_\*\.js\s*$/m.test(gi), 'E1b 例外不破坏原有「_*.js 一次性脚本」规则（通用规则仍在场）');
  ok(!/^\s*!server\/scripts\/_testSite\.js\s*$/m.test('# _*.js\n'), 'E1c revert 对照：无例外行的文本必须判红');

  // E1d 顺序不变量：gitignore 语义是「**最后一条**匹配的规则胜出」⇒ 例外行若排在 `_*.js` 之前，
  // 会被通用规则重新吞掉（静默失效，E1 的「存在性」断言对此完全无能）；同理，在例外行**之后再**
  // 出现一条 `_*.js` 也会重新吞掉。故取**最后一条**通用规则的下标与例外行下标比较。
  const giOrderOf = (text) => {
    const lines = text.split('\n');
    const ex = lines.map((l, i) => (/^\s*!server\/scripts\/_testSite\.js\s*$/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
    const gen = lines.map((l, i) => (l.trim() === '_*.js' ? i : -1)).filter((i) => i >= 0).pop();
    return { ex, gen, okOrder: ex !== undefined && gen !== undefined && ex > gen };
  };
  const giOrder = giOrderOf(gi);
  ok(giOrder.okOrder, 'E1d 例外行位于**最后一条** `_*.js` 之后（最后匹配者胜，顺序倒置/后置重复即静默失效）', JSON.stringify(giOrder));
  ok(!giOrderOf('!server/scripts/_testSite.js\n_*.js\n').okOrder, 'E1e revert 对照：例外行置于通用规则之前时本判据不成立');
  ok(!giOrderOf('_*.js\n!server/scripts/_testSite.js\n_*.js\n').okOrder, 'E1f revert 对照：例外行之后再现 `_*.js` 时本判据不成立');
  ok(fs.existsSync(path.join(ROOT, 'server/scripts/_testSite.js')), 'E2 _testSite.js 在磁盘存在（否则 require 直接崩）');
  const suitesRequiring = ['testAgentPhase5.js', 'testAgentPhase22.js', 'testAgentPhase23.js', 'testAgentPhase31.js'];
  const missingRef = suitesRequiring.filter((f) => !/_testSite/.test(read('server/scripts/' + f)));
  ok(missingRef.length === 0, 'E3 引用面与登记一致（4 个套件均 require _testSite）', missingRef.join(','));

  // 数据根隔离行必须早于首个 require
  const isoBeforeRequire = (src, tag) => {
    const lines = src.split('\n');
    const iso = lines.findIndex((l) => /process\.env\.FPB_DATA_DIR\s*=/.test(l));
    const firstReq = lines.findIndex((l) => /^\s*(const|let|var)\s.*=\s*require\(/.test(l));
    return { iso, firstReq, okIso: iso >= 0 && firstReq > iso, tag };
  };
  for (const [f, tag] of [['testAgentPhase5.js', 'Phase5'], ['testAgentPhase23.js', 'Phase23']]) {
    const r = isoBeforeRequire(read('server/scripts/' + f), tag);
    ok(r.okIso, 'E4 ' + tag + ' 的 FPB_DATA_DIR 隔离行早于首个 require（入集前提）', JSON.stringify(r));
  }

  console.log('\n== C140 守护结果: PASS=' + pass + ' FAIL=' + fail + ' ==');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('守护异常:', e && e.stack || e); process.exit(1); });
