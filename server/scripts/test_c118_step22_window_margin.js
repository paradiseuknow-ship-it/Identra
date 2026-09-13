'use strict';
/**
 * C118 —— step22 F1 观测窗重基线守护（零浏览器、零 LLM、零网络、零业务模块 require）。
 *
 * 缺陷背景（父级 MEMORY 登记「未做，须独立批次」的收口）：
 *   test_step22_business_e2e.js F1 恢复链（repair 耗尽 → replan#1 → 执行 → … → 升级）真实链长
 *   随执行环境负载漂移：C108 实测 193.4s → C116 实测 267.9–305.6s（4 红全 >300s / 3 绿全
 *   <300s 完美分离）→ C117 runRegression 实测 377.6s。旧 300s 观测窗余量塌到负值：断言在
 *   真实终态（HUMAN_ESCALATION）到达前截断读到 RUNNING = 假红，每次假红都要烧一轮全量复跑。
 *   修复：观测窗 300s → 600s（实测上界 377.6s + >50% 余量）；断言口径零变化
 *   （!== 'SUCCESS' 与终态白名单一字不动）；waitTaskTerminal 终态 1s 轮询早退 =>
 *   绿路径零成本，只有真悬挂才耗满窗。
 *
 * 守护策略：从 test_step22_business_e2e.js 源码提取 waitTaskTerminal 真实函数体（new Function
 * 注入 stub api 实跑，不复制实现），加 stripComments 源码锚点，证明「只延长观测、不放松裁决」。
 * 隔离：本套件不 require 任何业务模块（store 单例无从创建）；FPB_DATA_DIR / AI_PROVIDER=mock
 * 仍显式声明以固化环境契约。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 环境契约声明（无业务模块 require，无双根/存储面触碰）─────────────────────
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c118_window_margin_' + Date.now());
process.env.AI_PROVIDER = 'mock';

const STEP22_PATH = path.join(__dirname, 'test_step22_business_e2e.js');
const SRC = fs.readFileSync(STEP22_PATH, 'utf8');
const NO_COMMENTS = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}

// ── 提取真实 waitTaskTerminal 函数体（声明到首个列 0 的闭括号）────────────────
const m = NO_COMMENTS.match(/async function waitTaskTerminal[\s\S]*?\n\}/);
if (!m) {
  check('X0 waitTaskTerminal 函数体可提取', false, 'regex 未命中');
  console.log('\n===== C118 SUMMARY: ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(1);
}
// 工厂：按场景注入 stub api（固定返回某状态），得到闭包了 api/AUTH 的真实 waitTaskTerminal
const makeWait = (statusFn) =>
  new Function('api', 'AUTH', m[0] + '\nreturn waitTaskTerminal;')(
    async () => ({ json: { status: statusFn() } }),
    { authorization: 'stub' }
  );

// ══════════════════════════════════════════════════════════════════════════════
// A 真实行为：终态早退（绿路径零成本）+ 超时回传原始状态（不伪造终态）
// ══════════════════════════════════════════════════════════════════════════════
(async () => {
  // A1：任务已到 HUMAN_ESCALATION → 即使窗口 600s 也在首个轮询（≈1s）早退
  {
    const t0 = Date.now();
    const r = await makeWait(() => 'HUMAN_ESCALATION')('task_x', 600000);
    const elapsed = Date.now() - t0;
    check('A1 终态早退：HUMAN_ESCALATION 立即返回（600s 窗绿路径零成本）',
      r.status === 'HUMAN_ESCALATION' && elapsed < 10000, 'elapsed=' + elapsed + 'ms');
  }
  // A2：窗口到期仍是 RUNNING → 回传原始状态（不伪造终态；下游断言靠它分辨假截断）
  {
    const t0 = Date.now();
    const r = await makeWait(() => 'RUNNING')('task_y', 1500);
    const elapsed = Date.now() - t0;
    check('A2 超时回传原始 RUNNING（不伪造终态，裁决权仍在断言）',
      r.status === 'RUNNING' && elapsed >= 1000, 'elapsed=' + elapsed + 'ms');
  }
  // A3：extraTerminals 合并语义保留（F2/A/C/E 区扩展终态能力不被窗口调整破坏）
  {
    const r = await makeWait(() => 'PAUSED_FOR_HUMAN')('task_z', 600000, ['PAUSED_FOR_HUMAN']);
    check('A3 extraTerminals 合并：PAUSED_FOR_HUMAN 经 extraTerminal 早退', r.status === 'PAUSED_FOR_HUMAN', '');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // B 观测窗锚点：F1=600s、旧 300s 清零、其余等待窗不动（无连带放大）
  // ════════════════════════════════════════════════════════════════════════════
  check('B1 F1 观测窗已落 600000（waitTaskTerminal(t1.json.id, 600000)）',
    NO_COMMENTS.indexOf('waitTaskTerminal(t1.json.id, 600000)') >= 0, '');
  check('B2 旧 300s 窗清零（stripComments 后无 waitTaskTerminal(t1.json.id, 300000)）',
    NO_COMMENTS.indexOf('waitTaskTerminal(t1.json.id, 300000)') < 0, '');
  check('B3 其余等待窗保持 180000 恰 4 处（A/C/E/F2 区无连带放大）',
    (NO_COMMENTS.match(/waitTaskTerminal\([^)]*, 180000\)/g) || []).length === 4, '');
  check('B4 源码中 300000 已清零（无残留半截口径）', NO_COMMENTS.indexOf('300000') < 0, '');

  // ════════════════════════════════════════════════════════════════════════════
  // C 裁决口径零变化（红线证明：只延长观测、不放松判定）
  // ════════════════════════════════════════════════════════════════════════════
  check('C1 「未判 SUCCESS」断言保留（fin1.status !== \'SUCCESS\'）',
    NO_COMMENTS.indexOf("fin1.status !== 'SUCCESS'") >= 0, '');
  check('C2 显式交人终态白名单保留（FAILED/HUMAN_ESCALATION/PAUSED_FOR_HUMAN）',
    NO_COMMENTS.indexOf("['FAILED', 'HUMAN_ESCALATION', 'PAUSED_FOR_HUMAN'].includes(fin1.status)") >= 0, '');
  check('C3 reverified success===false 断言保留（F1 状态丢失取证面未动）',
    /re1\.length >= 1 && re1\[re1\.length - 1\]\.payload\.success === false/.test(NO_COMMENTS), '');

  // ════════════════════════════════════════════════════════════════════════════
  // D 余量算术自检：600s = 实测上界 377.6s + >50% 余量，且 ≤ 2× 上界（防失控放大）
  // ════════════════════════════════════════════════════════════════════════════
  {
    // 实测链长（C116 267.9–305.6s / C117 runRegression 377.6s，.benchmark/c117_runregression.log）
    const MEASURED_MAX_MS = 377600;
    const WINDOW_MS = 600000;
    check('D1 窗 ≥ 实测上界 1.5×（377.6s×1.5=566.4s ≤ 600s）', WINDOW_MS >= MEASURED_MAX_MS * 1.5, '');
    check('D2 窗 ≤ 实测上界 2×（600s ≤ 755.2s，防失控放大拖长真悬挂失败）',
      WINDOW_MS <= MEASURED_MAX_MS * 2, '');
    // 注释里的取证链锚点保留（防后人删测量依据使窗口变成无源之数）
    check('D3 取证链注释保留（377.6 / 267.9 / 193.4 实测值在源码注释中）',
      SRC.indexOf('377.6') >= 0 && SRC.indexOf('267.9') >= 0 && SRC.indexOf('193.4') >= 0, '');
  }

  console.log('\n===== C118 SUMMARY: ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
