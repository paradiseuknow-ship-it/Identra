'use strict';
/**
 * C114 —— step22_business_e2e 测试自身 stepId 子串碰撞修复守护（零浏览器、零 LLM）。
 *
 * 缺陷背景（flake 三件之一，登记后本批实施）：
 *   test_step22_business_e2e.js E 区用 indexOf('e3') 过滤 task.step_started 事件。
 *   但 stepId 真实格式 = <taskId>_<planStepId>（stepManager.createStep:58 拼 taskId 前缀；
 *   runtime.js:297 事件与 aiAttempts 均落该 id）。taskId = 'task_' + Date.now().toString(36)
 *   + 随机 base36 尾巴 —— 当 taskId 本身含 'e3' 子串时（约 1% 概率），该任务全部步骤
 *   （..._e1 / ..._e2 / ..._e3）的 stepId 都含 'e3' → 过滤命中全部步骤 → started3[0]
 *   落在 e1 → aiAttempts 按 e1 的 stepId 过滤 → e3Fails=0 →「aiAttempts 中存在 e3 失败
 *   记录」假红（5 轮 1 中）。
 *   修复：改后缀锚定正则 /_e3(_rp\d+)?$/（兼容 replan 变体 uniqueStepId 的 _e3_rpN），
 *   与同文件 F 区既有正确模式 endsWith('_f2') 同族。
 *
 * 隔离：本测试在 require 业务模块**之前**把 FPB_DATA_DIR 指向临时目录（c109/c111 的
 * T24 模式），断言真实数据目录零写入。AI_PROVIDER=mock 显式声明：本套件零 LLM、零浏览器。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 必须在 require 业务模块之前设置（store 单例在 require 时创建）──────────────
const TMP_DIR = path.join(os.tmpdir(), 'c114_stepid_collision_' + Date.now());
process.env.FPB_DATA_DIR = TMP_DIR;
process.env.AI_PROVIDER = 'mock';
const REAL_DATA_DIR = path.join(__dirname, '..', 'data');
const probeFiles = ['aiSteps.json', 'aiAttempts.json', 'aiTasks.json'];
const realBefore = probeFiles.map((f) => {
  const p = path.join(REAL_DATA_DIR, f);
  return fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
});

const stepManager = require('../agent/stepManager');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}

// ── 被测谓词：与修复后 test_step22_business_e2e.js:567 逐字一致 ────────────────
// （源码锚点由 P4 证明两者一致；此处持有同构实现以做真实行为断言，不 eval 源码）
const FIXED_PREDICATE = (e) => e.type === 'task.step_started' && e.stepId && /_e3(_rp\d+)?$/.test(String(e.stepId));
// 修复前谓词（负向对照，实锤旧假红机制）
const OLD_PREDICATE = (e) => e.type === 'task.step_started' && e.stepId && String(e.stepId).indexOf('e3') >= 0;

function evt(stepId) { return { type: 'task.step_started', stepId }; }

// ══════════════════════════════════════════════════════════════════════════════
// P1 真实模块契约：createStep 产出的 step.id = <taskId>_<planStep.id>
// （这是事件 stepId / aiAttempts.stepId 的唯一事实源，runtime.js:297 + stepManager.js:112）
// ══════════════════════════════════════════════════════════════════════════════
{
  const tA = 'task_mtabc123e3xyz9k'; // 刻意含 'e3' 子串的 taskId（碰撞形态）
  const planSteps = [
    { id: 'e1', description: 'Open step A', type: 'ACT', retryable: true, maxRetries: 2, action: { type: 'navigate', target: { url: 'http://127.0.0.1:1/a' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 15000 } },
    { id: 'e2', description: 'Continue to step B', type: 'ACT', retryable: true, maxRetries: 2, action: { type: 'click', target: { selector: '#next-a' }, risk: 'LOW', timeoutMs: 8000, verification: { type: 'url_contains', expect: '/step-b' } } },
    { id: 'e3', description: 'Continue to step C (delayed button)', type: 'ACT', retryable: true, maxRetries: 4, action: { type: 'click', target: { selector: '#continue' }, risk: 'LOW', timeoutMs: 8000, verification: { type: 'url_contains', expect: '/step-c' } } },
  ];
  const created = planSteps.map((s, i) => stepManager.createStep(tA, s, i));
  const ids = created.map((s) => s.id);
  check('P1a createStep 前缀契约：id = <taskId>_<planStep.id>（碰撞 taskId）',
    ids[0] === tA + '_e1' && ids[1] === tA + '_e2' && ids[2] === tA + '_e3',
    'ids=' + JSON.stringify(ids));
  check('P1b 碰撞前提实锤：三个 stepId 都含 "e3" 子串（旧 indexOf 过滤必然全命中）',
    ids.every((id) => id.indexOf('e3') >= 0), 'ids=' + JSON.stringify(ids));

  // ════════════════════════════════════════════════════════════════════════════
  // P2 杀手：碰撞 taskId 下，旧谓词命中全部步骤（假红机制精确复现），
  // 修复谓词恰好只命中 e3（且 started3[0] 即 e3 —— 下游 aiAttempts 过滤随之正确）
  // ════════════════════════════════════════════════════════════════════════════
  const evs = ids.map(evt);
  const oldHits = evs.filter(OLD_PREDICATE);
  const fixedHits = evs.filter(FIXED_PREDICATE);
  check('P2a 修复前假红机制复现：indexOf 谓词命中全部 3 步（ started3[0] 落在 e1 → e3Fails=0 假红）',
    oldHits.length === 3 && oldHits[0].stepId === tA + '_e1',
    'oldHits=' + JSON.stringify(oldHits.map((e) => e.stepId)));
  check('P2b 修复谓词恰好只命中 e3', fixedHits.length === 1 && fixedHits[0].stepId === tA + '_e3',
    'fixedHits=' + JSON.stringify(fixedHits.map((e) => e.stepId)));
  check('P2c started3[0].stepId 即 e3 真实 id（下游 aiAttempts 精确过滤的前提）',
    fixedHits.length >= 1 && fixedHits[0].stepId === created[2].id,
    'started3[0]=' + (fixedHits[0] && fixedHits[0].stepId));

  // aiAttempts 真实记录面验证：按 fixedHits[0].stepId 查询失败/成功分组语义成立
  const attFail = { id: 'att_x1', stepId: created[2].id, error: { code: 'ELEMENT_NOT_FOUND' }, startedAt: 1 };
  const attOk = { id: 'att_x2', stepId: created[2].id, error: null, startedAt: 2 };
  const attE1 = { id: 'att_x3', stepId: created[0].id, error: null, startedAt: 0 }; // e1 的成功（不应混入）
  const pool = [attE1, attFail, attOk];
  const stepIdE3 = fixedHits[0].stepId;
  const fails = pool.filter((a) => a.stepId === stepIdE3 && a.error);
  const oks = pool.filter((a) => a.stepId === stepIdE3 && !a.error);
  check('P2d 修复后 aiAttempts 分组语义成立：e3 失败 ≥1 且成功 ≥1（断言 e3Fails>=1 不再假红）',
    fails.length === 1 && oks.length === 1, 'fails=' + fails.length + ' oks=' + oks.length);
}

// ══════════════════════════════════════════════════════════════════════════════
// P3 干净路径不变性：taskId 不含 'e3' 时新旧谓词等价（都恰好命中 e3 一步）
// ══════════════════════════════════════════════════════════════════════════════
{
  const tB = 'task_mtxqrto4hk1db'; // 无 'e3' 子串
  const ids = [tB + '_e1', tB + '_e2', tB + '_e3'].map(evt);
  const oldHits = ids.filter(OLD_PREDICATE);
  const fixedHits = ids.filter(FIXED_PREDICATE);
  check('P3 干净 taskId 下新旧等价：均恰好命中 e3 一步（非碰撞路径零行为变化）',
    oldHits.length === 1 && fixedHits.length === 1 && fixedHits[0].stepId === tB + '_e3',
    'old=' + oldHits.length + ' fixed=' + JSON.stringify(fixedHits.map((e) => e.stepId)));
}

// ══════════════════════════════════════════════════════════════════════════════
// P4 replan 变体边界：uniqueStepId 产出 _e3_rpN，修复正则覆盖、旧 indexOf 误吞它步
// ══════════════════════════════════════════════════════════════════════════════
{
  const tC = 'task_mtreplan01';
  const s = stepManager.createStep(tC, { id: 'e3', description: 'x', type: 'ACT', retryable: true, maxRetries: 1, action: { type: 'navigate', target: { url: 'http://127.0.0.1:1/x' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 15000 } }, 0);
  // 复刻 uniqueStepId 冲突分配：base 已被占用 → 追加 _rp1（stepManager.js:85-91 契约）
  const replanId = stepManager.uniqueStepId(tC, 'e3'); // e3 已占用 → e3_rp1
  check('P4a uniqueStepId 冲突分配契约：e3 已占用 → e3_rp1', replanId === 'e3_rp1', 'replanId=' + replanId);
  const rpStepId = tC + '_' + replanId;
  check('P4b 修复正则覆盖 replan 变体 <taskId>_e3_rp1', FIXED_PREDICATE(evt(rpStepId)), rpStepId);
  check('P4c 修复正则不误吞：_e3 中缀（非后缀）不命中',
    !FIXED_PREDICATE(evt(tC + '_e30')) && !FIXED_PREDICATE(evt('task_xe3y_e1')) && !FIXED_PREDICATE(evt(tC + '_e3x')),
    '');
  check('P4d 旧 indexOf 对 replan 变体是误吞式匹配（无后缀锚定，全部子串命中）',
    OLD_PREDICATE(evt(tC + '_e30')) && OLD_PREDICATE(evt('task_xe3y_e1')), '');
}

// ══════════════════════════════════════════════════════════════════════════════
// P5 源码锚点：被修文件已落修复谓词、旧谓词清零；F 区 endsWith('_f2') 正确模式保留
// ══════════════════════════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(path.join(__dirname, 'test_step22_business_e2e.js'), 'utf8');
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('P5a 旧谓词 indexOf(\'e3\') 已清零（stripComments 后）', noComments.indexOf("indexOf('e3')") < 0, '');
  check('P5b 修复谓词 _e3(_rp\\d+)?$ 已落盘', noComments.indexOf('_e3(_rp\\d+)?$') >= 0, '');
  check('P5c F 区既有正确模式 endsWith(\'_f2\') 保留（同族锚定不被误伤）', noComments.indexOf("endsWith('_f2')") >= 0, '');
}

// ══════════════════════════════════════════════════════════════════════════════
// T24 隔离零污染：真实数据目录在测试前后 mtime 不变
// ══════════════════════════════════════════════════════════════════════════════
{
  const realAfter = probeFiles.map((f) => {
    const p = path.join(REAL_DATA_DIR, f);
    return fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
  });
  check('T24 真实数据目录零写入（aiSteps/aiAttempts/aiTasks mtime 不变）',
    JSON.stringify(realBefore) === JSON.stringify(realAfter),
    'before=' + JSON.stringify(realBefore) + ' after=' + JSON.stringify(realAfter));
}

console.log('\n===== C114 SUMMARY: ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
