'use strict';

// C151 守护：遮挡（OBSTRUCTION）诊断不得被修复入口的「验证失败强制路由」丢弃。
//
// 缺陷背景（A 类真缺陷，2026-09-28 实测，非推理）：
//   Phase 7 Step 5 以错误分类器类型为权威，把 VERIFY_FAILED 的诊断类别**无条件**改写成
//   VERIFICATION_FAILED（原意：禁止被重分类成 ELEMENT_CHANGED 后误用语义重定位）。
//   但**遮挡不是「验证策略过严」** —— cookie/consent 横幅、模态弹窗是**可执行的真实原因**，
//   诊断层已经给出可执行建议。无条件覆盖把它一起丢掉 ⇒ repairPlanner 只能产出 VERIFY_RETRY
//   （重观察 + 重验证，对遮挡**原理上无效**）⇒ 目标按钮被横幅盖住时永远点不到。
//
//   实测链路（localhost 夹具 /cookie：全屏 #consent 盖住 Continue）：
//     agent.diagnosing { category:'OBSTRUCTION', confidence:0.9,
//                        recommendation:'按站点规则处理弹窗（accept/reject）后重试' }
//     → 覆盖发生 → 策略 VERIFY_RETRY → 3 次修复全 false → HUMAN_ESCALATION
//     （同一路径在更早基线上显示 SUCCESS，靠的是「修复重验证恒无 before ⇒ page_change 无条件
//       判成功」的假成功通道；C150 把真实 before 接回后该通道被堵死，缺陷才显形。）
//
// 本批方向（诚实声明）：
//   · **收紧为条件豁免**：只放行 OBSTRUCTION；其余一切诊断类别照旧被覆盖为 VERIFICATION_FAILED。
//     「放宽」= 让更多东西通过；这里通过面**没有扩大**（受害者是「遮挡」这一条**被误丢**的诊断），
//     且遮挡补偿动作仍受 repairPolicy 的 MEDIUM + confidence≥0.85 门把守。
//   · **新增**：`agent.diagnosing` 事件加 `resolvedCategory`（实际用于选策略的类别）——
//     此前只上报覆盖**前**的类别，遥测会显示 OBSTRUCTION 而实际按 VERIFICATION_FAILED 路由。
//   · **未动**：repairPlanner 映射表、repairPolicy 门限、verification 判据面、maxRepairAttempts。
//
// 判据按「内容形状 + 双向」建立；D 组用**两个错误实现**证明判据对两个方向都有分辨力
// （只锚一个方向 = 另一个方向静默失效）。数据根隔离必须在首个 require 之前。

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'c151_obstruction_'));
process.env.FPB_DATA_DIR = TMP;

const ROOT = path.join(__dirname, '..', '..');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
const j = (x) => { try { return JSON.stringify(x); } catch (e) { return String(x); } };

// 历史实现（仅供双向对照，**不是**被测对象）：无条件覆盖 —— C151 之前的行为。
function legacyForceOverwrite({ classifierType, diagnosisCategory }) {
  return classifierType === 'VERIFICATION_FAILED' ? 'VERIFICATION_FAILED' : (diagnosisCategory || classifierType || 'UNKNOWN');
}
// 过度豁免（反方向错误实现）：任何诊断类别都不覆盖。
function overExempt({ classifierType, diagnosisCategory }) {
  return diagnosisCategory || classifierType || 'UNKNOWN';
}

const VF = 'VERIFICATION_FAILED';

(async function main() {
  const rm = require('../agent/repair/repairManager');
  const planner = require('../agent/repair/repairPlanner');

  // ── A 组：维度判定 双向 ────────────────────────────────────────────────
  console.log('\n── A 组：诊断类别 → 修复路由类别（双向）──');
  const seen = [];
  const t = (label, input, want) => {
    const got = rm.resolveDiagnosisCategory(input);
    seen.push(got);
    ok(got === want, label, '得到 ' + j(got) + '，期望 ' + j(want));
  };
  t('A1 遮挡豁免生效：OBSTRUCTION 不被覆盖（唯一放行项）', { classifierType: VF, diagnosisCategory: 'OBSTRUCTION' }, 'OBSTRUCTION');
  t('A2 覆盖保留：ELEMENT_CHANGED 仍被强制（C140 原意不放宽）', { classifierType: VF, diagnosisCategory: 'ELEMENT_CHANGED' }, VF);
  t('A3 覆盖保留：STATE_UNKNOWN 仍被强制', { classifierType: VF, diagnosisCategory: 'STATE_UNKNOWN' }, VF);
  t('A4 无诊断类别时仍强制（不允许 null 漏过）', { classifierType: VF, diagnosisCategory: null }, VF);
  t('A5 其它分类器不改写诊断类别（覆盖只作用于验证失败这一路）', { classifierType: 'ELEMENT_NOT_FOUND', diagnosisCategory: 'OBSTRUCTION' }, 'OBSTRUCTION');
  t('A6 其它分类器 + 其它类别：原样透传', { classifierType: 'TIMEOUT', diagnosisCategory: 'ELEMENT_CHANGED' }, 'ELEMENT_CHANGED');
  t('A7 双空入参回落到 UNKNOWN（不返回 undefined）', { classifierType: null, diagnosisCategory: null }, 'UNKNOWN');
  ok(seen.every((v) => typeof v === 'string' && v.length > 0),
    'A8 返回值恒为非空字符串（防臆造类别 / 防 undefined 进入映射表）', j(seen));

  // ── B 组：豁免之后确实路由到遮挡修复（而不是只改了类别名）────────────
  console.log('\n── B 组：豁免 → repairPlanner 实际映射 ──');
  const pOb = planner.planFromDiagnosis({ task: {}, step: { action: { type: 'click', target: { semantic: 'Continue' } } }, diagnosis: { category: 'OBSTRUCTION', confidence: 0.9 }, classifier: { type: VF }, failureSnapshot: { id: 'fs_c151' } });
  ok(pOb.ok && pOb.plan.strategy === 'DISMISS_OVERLAY' && pOb.plan.strategyType === 'obstruction',
    'B1 OBSTRUCTION → DISMISS_OVERLAY（遮挡补偿动作真的会被执行）', j(pOb.ok ? { s: pOb.plan.strategy, st: pOb.plan.strategyType } : pOb.error));
  ok(pOb.ok && pOb.plan.risk === 'MEDIUM',
    'B2 遮挡修复风险档 = MEDIUM（受 confidence≥0.85 门把守，非无条件自动）', j(pOb.ok && pOb.plan.risk));
  const pVf = planner.planFromDiagnosis({ task: {}, step: { action: { type: 'click', target: { semantic: 'Continue' } } }, diagnosis: { category: VF, confidence: 0.9 }, classifier: { type: VF }, failureSnapshot: { id: 'fs_c151b' } });
  ok(pVf.ok && pVf.plan.strategy === 'VERIFY_RETRY',
    'B3 非遮挡的验证失败仍走 VERIFY_RETRY（分流不被本批抹平）', j(pVf.ok ? pVf.plan.strategy : pVf.error));

  // ── C 组：接线与形状（不留第二份同义判定）─────────────────────────────
  console.log('\n── C 组：接线（形状判据）──');
  const src = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'repair', 'repairManager.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  ok(/resolveDiagnosisCategory\(\s*\{/.test(code),
    'C1 修复入口以**调用**形态使用判定点（不是内联 if）');
  ok(/diag\.diagnosis\.category\s*=\s*_resolvedCat/.test(code),
    'C2 改写仍收敛到同一个取值来源（不出现第二处独立改写）');
  ok(!/diag\.diagnosis\.category\s*=\s*'VERIFICATION_FAILED'/.test(code),
    'C3 不再存在把诊断类别**直接写成字面量**的无条件覆盖（回退必红）');
  ok(/resolvedCategory:\s*_resolvedCat/.test(code),
    'C4 遥测上报实际路由类别（让「显示 A、实际走 B」的误读不再可能）');
  ok(/module\.exports\s*=\s*\{[^}]*resolveDiagnosisCategory[^}]*\}/.test(code),
    'C5 判定点已导出（守护能锚到真实现，不靠手写模拟）');

  // ── D 组：判据分辨力（两个方向都要咬得住）────────────────────────────
  console.log('\n── D 组：判据分辨力（防空绿）──');
  const CASES = [
    { classifierType: VF, diagnosisCategory: 'OBSTRUCTION' },
    { classifierType: VF, diagnosisCategory: 'ELEMENT_CHANGED' },
    { classifierType: 'ELEMENT_NOT_FOUND', diagnosisCategory: 'OBSTRUCTION' },
  ];
  const real = CASES.map((c) => rm.resolveDiagnosisCategory(c));
  const leg = CASES.map((c) => legacyForceOverwrite(c));
  const oe = CASES.map((c) => overExempt(c));
  ok(real.some((v, i) => v !== leg[i]),
    'D1 分辨力：旧的无条件覆盖实现在同一组输入上**答案不同**（若此条失败说明判据无分辨力）', j({ real, leg }));
  ok(real.some((v, i) => v !== oe[i]),
    'D2 分辨力：过度豁免（全放行）实现在同一组输入上**答案不同**（反方向同样咬得住）', j({ real, oe }));
  ok(real[0] === 'OBSTRUCTION' && real[1] === VF,
    'D3 双向对照：真实实现在「该豁免」与「该覆盖」两侧各给出正确答案', j(real));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  console.log('\n=== C151 守护结果：通过 ' + pass + ' / 失败 ' + fail + ' ===');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('  FAIL 测试主体抛异常（其后断言从未执行）:: '
    + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
  console.log('\n=== C151 守护结果：通过 ' + pass + ' / 失败 ' + (fail + 1) + ' ===');
  process.exit(1);
});
