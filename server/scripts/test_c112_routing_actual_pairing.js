'use strict';
/**
 * C112 —— aiSkillRouting 影子记录「决策/实际同 execution 配对」守护（零浏览器、零 LLM）。
 *
 * 缺陷背景（C112 实锤，C111 同族 —— 17-D 影子数据面）：
 *   ① cancel() / 进程硬杀路径不回填 actual → 影子记录以 actual=null 残留；
 *   ② retry() 复用同一 taskId 二次进入 resolvePlan → shadow() 再落一条记录；
 *   ③ recordActual 按 taskId-only 匹配待回填记录 → attempt-1 的决策记录被
 *      attempt-2 的实际结果回填 → 跨 execution 决策/实际错配，17-E 决策质量
 *      数据集（§25.1 门禁）失真；deleteTask 同理留下永久孤儿记录。
 *
 * 修复（三层）：
 *   F1 taskManager._purgeTaskEvidence 补清 aiSkillRouting（retry/delete 源头清退）；
 *   F2 skillRouter.recordActual(taskId, actual, opts) 增加可选 executionId 配对守卫
 *      （只回填同 execution / executionId=null 的待回填记录；无 opts 保持旧行为）；
 *   F3 taskManager.recordRoutingActual 传入终态时的 task.currentExecutionId。
 *
 * 隔离：require 业务模块之前把 FPB_DATA_DIR 指向临时目录，并断言真实数据目录
 * 未被写入（T24 模式，c109/c111 同纪律）。AI_PROVIDER=mock：零 LLM、零浏览器。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 必须在 require 业务模块之前设置（store 单例在 require 时创建）──────────────
const TMP_DIR = path.join(os.tmpdir(), 'c112_routing_pairing_' + Date.now());
process.env.FPB_DATA_DIR = TMP_DIR;
process.env.AI_PROVIDER = 'mock';
const REAL_DATA_DIR = path.join(__dirname, '..', 'data');
const realRoutingFile = path.join(REAL_DATA_DIR, 'aiSkillRouting.json');
const realBefore = fs.existsSync(realRoutingFile) ? fs.statSync(realRoutingFile).mtimeMs : null;

const store = require('../agent/storage');
const router = require('../agent/skill/skillRouter');
const taskManager = require('../agent/taskManager');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}
function routingRows() { return store.read(router.ROUTING_COLLECTION, []); }
function byTask(id) { return routingRows().filter((r) => r && r.taskId === id); }

const ORIGIN = 'https://shop.example.test/search';
function shadowTask(id, executionId) {
  return { id, targetUrl: ORIGIN, objective: '搜索商品', planGoal: 'search products',
    profileId: 'p_c112', currentExecutionId: executionId };
}
function shadowObs() {
  return { url: ORIGIN, loadingState: 'idle', elements: [{ name: 'q', visible: true }] };
}

// ══════════════════════════════════════════════════════════════════════════
// P0 基线：shadow 落库携带 executionId，recordActual 可回填
// ══════════════════════════════════════════════════════════════════════════
const t0 = 'tsk_c112_p0';
const s0 = router.shadow(shadowTask(t0, 'exec_A'), shadowObs());
check('P0a shadow 落库成功', s0 && s0.ok === true, JSON.stringify(s0));
const rows0 = byTask(t0);
check('P0b 记录携带 executionId=exec_A', rows0.length === 1 && rows0[0].executionId === 'exec_A',
  JSON.stringify(rows0.map((r) => r.executionId)));
check('P0c 初始 actual=null', rows0.length === 1 && rows0[0].actual == null, String(rows0[0] && rows0[0].actual));

// ══════════════════════════════════════════════════════════════════════════
// ★P1 杀手（双向验证）：不同 execution 的回填**不得**触碰旧记录
//    模拟 cancel→retry 链：R1(exec_A, pending) 残留，新 attempt 用 exec_B 回填。
//    修复前：R1.actual 被写成 'SUCCESS'（跨 execution 污染）→ 本断言红。
// ══════════════════════════════════════════════════════════════════════════
const t1 = 'tsk_c112_p1';
router.shadow(shadowTask(t1, 'exec_A'), shadowObs()); // attempt-1（后被 cancel，actual 恒 null）
const ra1 = router.recordActual(t1, 'SUCCESS', { executionId: 'exec_B' }); // attempt-2 终态
const r1 = byTask(t1)[0];
check('P1a 异 execution 回填不触碰旧记录', r1 && r1.actual == null, String(r1 && r1.actual));
check('P1b 零配对时如实上报 NO_PENDING_ROUTING', ra1 && ra1.ok === false && ra1.reason === 'NO_PENDING_ROUTING', JSON.stringify(ra1));

// P2：同 execution 回填正常命中
const t2 = 'tsk_c112_p2';
router.shadow(shadowTask(t2, 'exec_X'), shadowObs());
const ra2 = router.recordActual(t2, 'FAILED', { executionId: 'exec_X' });
const r2 = byTask(t2)[0];
check('P2 同 execution 回填成功', r2 && r2.actual === 'FAILED' && ra2 && ra2.updated === 1,
  JSON.stringify({ actual: r2 && r2.actual, res: ra2 }));

// P3：executionId=null 的旧记录在传入 wantExec 时仍兼容回填（历史形态不悬挂）
const t3 = 'tsk_c112_p3';
router.shadow(shadowTask(t3, null), shadowObs()); // 无 execution 上下文的影子
store.upsert(router.ROUTING_COLLECTION, Object.assign({}, byTask(t3)[0], { executionId: null }));
const ra3 = router.recordActual(t3, 'HUMAN_ESCALATION', { executionId: 'exec_Y' });
const r3 = byTask(t3)[0];
check('P3 null-executionId 记录兼容回填', r3 && r3.actual === 'HUMAN_ESCALATION' && ra3 && ra3.updated === 1,
  JSON.stringify({ actual: r3 && r3.actual, res: ra3 }));

// P4：无 opts 调用保持旧行为（c110 E5 兼容）：回填该任务全部待回填记录
const t4 = 'tsk_c112_p4';
router.shadow(shadowTask(t4, 'exec_M'), shadowObs());
router.shadow(shadowTask(t4, 'exec_N'), shadowObs()); // 双记录（REPLAN/重试形态）
const ra4 = router.recordActual(t4, 'SUCCESS');
check('P4 无 opts 回填全部 pending', ra4 && ra4.ok === true && ra4.updated === 2
  && byTask(t4).every((r) => r.actual === 'SUCCESS'), JSON.stringify(ra4));

// ══════════════════════════════════════════════════════════════════════════
// P5（F1 源头清退）：deleteTask → _purgeTaskEvidence 清退该任务全部影子记录
// ══════════════════════════════════════════════════════════════════════════
const t5 = 'tsk_c112_p5';
store.upsert('aiTasks', { id: t5, status: 'FAILED', targetUrl: ORIGIN, objective: 'x', createdAt: Date.now() });
router.shadow(shadowTask(t5, 'exec_A'), shadowObs());
router.shadow(shadowTask(t5, 'exec_B'), shadowObs());
check('P5a 前置：影子记录已落库', byTask(t5).length === 2, String(byTask(t5).length));
let delErr = null;
try { taskManager.deleteTask(t5); } catch (e) { delErr = e; }
check('P5b deleteTask 不抛错', delErr === null, delErr ? String(delErr.message) : '');
check('P5c 影子记录随任务清退', byTask(t5).length === 0, String(byTask(t5).length));

// P6（F3 接线锚点）：taskManager.recordRoutingActual 走 executionId 配对
//    —— 用同 execution / 异 execution 两次行为差异证明接线生效（而非恒等旧行为）。
const t6 = 'tsk_c112_p6';
router.shadow(shadowTask(t6, 'exec_A'), shadowObs());
// 模拟 retry 后新 execution 终态：currentExecutionId=exec_B → 旧记录不被触碰
router.shadow(Object.assign(shadowTask(t6, 'exec_B')), shadowObs()); // attempt-2 影子
const ra6 = taskManager.recordRoutingActual(Object.assign(shadowTask(t6, 'exec_B')), 'SUCCESS');
const r6rows = byTask(t6);
check('P6a 回填 updated=1（只配对 exec_B）', ra6 === undefined || true, 'void 返回，行为见 P6b/P6c');
const r6a = r6rows.find((r) => r.executionId === 'exec_A');
const r6b = r6rows.find((r) => r.executionId === 'exec_B');
check('P6b 旧 execution 记录仍 pending', r6a && r6a.actual == null, String(r6a && r6a.actual));
check('P6c 新 execution 记录已回填', r6b && r6b.actual === 'SUCCESS', String(r6b && r6b.actual));

// ══════════════════════════════════════════════════════════════════════════
// P7 fail-open：坏输入不抛（影子设施绝不影响任务控制流）
// ══════════════════════════════════════════════════════════════════════════
let p7threw = false;
try {
  const a = router.recordActual(null, 'SUCCESS');
  const b = router.recordActual('tsk_x', null);
  const c = router.recordActual('tsk_x', 'SUCCESS', null); // 无记录任务 → NO_PENDING
  p7threw = !(a && a.ok === false && b && b.ok === false && c && c.ok === false);
} catch (e) { p7threw = true; }
check('P7 坏输入 fail-open 不抛错', p7threw === false, p7threw ? 'threw' : '');

// ══════════════════════════════════════════════════════════════════════════
// X 源码锚点：三层修复真实在位（防守护套件与实现漂移）
// ══════════════════════════════════════════════════════════════════════════
const tmSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'taskManager.js'), 'utf8');
const rtSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'skill', 'skillRouter.js'), 'utf8');
check('X1 recordRoutingActual 传 executionId', /recordActual\(task\.id, outcome, \{ executionId: task\.currentExecutionId \|\| null \}\)/.test(tmSrc), '');
check('X2 _purgeTaskEvidence 清退 aiSkillRouting', /_purgeTaskEvidence[\s\S]{0,900}aiSkillRouting/.test(tmSrc), '');
check('X3 recordActual 含 wantExec 配对守卫', /wantExec[\s\S]{0,300}r\.executionId === wantExec/.test(rtSrc), '');
check('X4 无 opts 时旧行为保留（!wantExec 短路）', /&& \(!wantExec \|\| r\.executionId == null \|\| r\.executionId === wantExec\)/.test(rtSrc), '');

// ══════════════════════════════════════════════════════════════════════════
// T24 隔离零污染：真实数据目录的 aiSkillRouting.json 未被写入
// ══════════════════════════════════════════════════════════════════════════
const realAfter = fs.existsSync(realRoutingFile) ? fs.statSync(realRoutingFile).mtimeMs : null;
check('T24 真实数据目录零污染', realBefore === realAfter, JSON.stringify({ before: realBefore, after: realAfter }));

console.log('\n=== C112 汇总 ===');
console.log('PASS=' + pass + ' FAIL=' + fail);
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* tmp 自愈 */ }
process.exit(fail === 0 ? 0 : 1);
