'use strict';

// SEMANTIC_RELOCATE 修复动作封顶 + R2 非破坏化 — 针对性回归测试
//
// 背景 1（dl240 基线 rw.026 实锤）：elementChanged.execute 对 buildElementVariants 的结果
// 无上限循环——semantic 不在 SYNONYMS 字典时 CLICK_FALLBACK 生成 11 个变体 → REPAIR_TIMEOUT
// 误收口。封顶修复：变体探测 = 原 action + ≤3 个语义变体。
//
// 背景 2（R2 非破坏化，2026-09-03）：SMOKE5 rw.094 / run9 rw.001 实证——旧实现「先 reload
// 再探测」会摧毁未提交客户端状态（表单/SPA/购物车），产生次生失败。修复：探测先行、
// reload 降为最后手段——阶段 1 活跃 DOM 零破坏探测（原 action + ≤3 变体）；全部失败才
// 阶段 2 reload + 前 2 变体收窄复探。
//
// 修复契约（本测试锁定）：
//   1. 封顶：阶段 1 = 原 action + ≤3 变体；阶段 2 = reload + ≤2 变体（最坏 7 动作）。
//   2. 命中即停：任一变体成功立即返回 ok=true。
//   3. 零破坏守卫：阶段 1 命中时**绝不 reload**（客户端状态完整保留）。
//   4. 顺序：首个探测必须是原 action；变体顺序**由词表导出**（C150：具体 CTA 短语在前）。
//   5. recovery 路径不受影响：buildElementVariants 本身不变。
//
// C150 修订（真实站点可用性）：词表由 11 个通用短动词扩为「具体 CTA 短语 + 通用短动词」。
//   T1 / T5 的变体数与顺序断言从**字面快照**改为**从词表导出的不变量**，并新增一条
//   按内容形状判定的意图断言（探测窗口必须由具体多词/中文短语占据），使 revert 可被咬住。

const path = require('path');
const elementChanged = require(path.join(__dirname, '..', 'agent', 'repair', 'strategies', 'elementChanged'));
const elementMissing = require(path.join(__dirname, '..', 'agent', 'recovery', 'strategies', 'elementMissing'));

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}

function makeCtx(failUntil) {
  let n = 0;
  const calls = [];
  return {
    ctx: {
      runAction: async (action) => {
        n++;
        calls.push(action);
        const okFlag = failUntil != null && n >= failUntil;
        return { success: okFlag };
      },
    },
    calls,
    count: () => n,
  };
}

async function main() {
  // rw.026 铁证形态：click + semantic 不在字典 → 12 个 variants
  const rw026Action = { type: 'click', target: { semantic: '数据列表区域' }, risk: 'MEDIUM', verification: { type: 'none' } };

  await ok('T1 前置：buildElementVariants 对未知语义生成「原 action + 完整 CTA 词表」个变体（recovery 路径）', () => {
    // C150：从**词表导出**不变量，不再写死 12 —— 词表演进时重算即可，不需要改测试。
    const vocab = new Set(
      elementMissing.CLICK_FALLBACK.map((s) => String(s).toLowerCase()).filter((s) => s !== '数据列表区域')
    );
    const v = elementMissing.buildElementVariants(rw026Action);
    if (v.length !== 1 + vocab.size) {
      throw new Error('期望 1 + 词表去重后 ' + vocab.size + ' = ' + (1 + vocab.size) + ' 个变体，实际 ' + v.length);
    }
  });

  await ok('T2 全部失败：阶段 1 四探测 → reload → 阶段 2 两探测 = 7 动作、reload 恰 1 次且在最后', async () => {
    const { ctx, calls, count } = makeCtx(null);
    const r = await elementChanged.execute({ task: {}, step: { action: rw026Action }, ctx });
    if (r.ok !== false) throw new Error('应返回 ok=false');
    if (count() !== 7) throw new Error('期望 7 次动作（4 live + 1 reload + 2 after-reload），实际 ' + count());
    const reloads = calls.filter((a) => a.type === 'reload');
    if (reloads.length !== 1) throw new Error('reload 应恰好 1 次，实际 ' + reloads.length);
    if (calls.indexOf(reloads[0]) !== 4) throw new Error('reload 必须发生在阶段 1 四次探测之后（第 5 位），实际第 ' + (calls.indexOf(reloads[0]) + 1) + ' 位');
    if (r.actions.length !== 7) throw new Error('actions 记录应 7 条，实际 ' + r.actions.length);
    const lastPhase = r.actions[6].phase;
    if (lastPhase !== 'after-reload') throw new Error('末位动作应属 after-reload 阶段，实际 ' + lastPhase);
  });

  await ok('T3 命中即停 + 零破坏守卫：阶段 1 第 3 次命中 → ok=true 且全程零 reload', async () => {
    const { ctx, calls, count } = makeCtx(3);
    const r = await elementChanged.execute({ task: {}, step: { action: rw026Action }, ctx });
    if (r.ok !== true) throw new Error('应返回 ok=true');
    if (count() !== 3) throw new Error('命中即停应 3 次动作，实际 ' + count());
    if (calls.some((a) => a.type === 'reload')) throw new Error('阶段 1 命中时不得 reload（R2 零破坏守卫）');
  });

  await ok('T4 字典语义封顶一致：submit（13 个变体）全失败同样 7 次动作', async () => {
    const a = { type: 'click', target: { semantic: 'submit' }, risk: 'LOW', verification: { type: 'none' } };
    const v = elementMissing.buildElementVariants(a);
    if (v.length !== 13) throw new Error('前置：submit 变体数期望 13，实际 ' + v.length);
    const { ctx, count } = makeCtx(null);
    const r = await elementChanged.execute({ task: {}, step: { action: a }, ctx });
    if (r.ok !== false) throw new Error('应返回 ok=false');
    if (count() !== 7) throw new Error('最坏应 7 次动作，实际 ' + count());
  });

  await ok('T5 顺序：live 探测 = 原 action + 词表首 3 项（须为具体 CTA 短语）；复探 = 原 action + 词表首项', async () => {
    const vocab = elementMissing.CLICK_FALLBACK;
    const { ctx, calls } = makeCtx(null);
    await elementChanged.execute({ task: {}, step: { action: rw026Action }, ctx });
    const clicks = calls.filter((a) => a.type === 'click');
    if (clicks.length !== 6) throw new Error('click 探测应 6 次（4 live + 2 复探），实际 ' + clicks.length);
    if (clicks[0].target.semantic !== '数据列表区域') throw new Error('首个探测必须是原 action');
    const live = clicks.slice(1, 4).map((a) => a.target.semantic);
    if (JSON.stringify(live) !== JSON.stringify(vocab.slice(0, 3))) {
      throw new Error('live 变体应为词表首 3 项，实际 ' + JSON.stringify(live));
    }
    // C150 意图不变量（按**内容形状**判定，不按标识符/字面顺序）：
    // 探测窗口必须由「具体 CTA 短语」占据。通用短动词（continue/next/submit 等单字词）
    // 一旦回到队首即视为回归 —— 实证：sonymaxweb.com 的真实注册入口是 `Start Free Trial`，
    // 旧词表一个都不在页面上 ⇒ 恢复链 100% 空转。
    const isSpecificCta = (s) => /\s/.test(String(s)) || /[\u4e00-\u9fa5]/.test(String(s));
    if (!live.every(isSpecificCta)) {
      throw new Error('live 窗口前 3 项必须是具体多词 / 中文 CTA 短语（C150），实际 ' + JSON.stringify(live));
    }
    // 通用短动词必须整体后置：submit 会命中目录类站点的 `Submit Tool`（提交工具，非注册）。
    const genericAt = vocab.indexOf('submit');
    if (genericAt < 0) throw new Error('词表必须保留 submit（C105 F6.2 契约：英语页真实存在词保留）');
    if (genericAt < elementMissing.CTA_SPECIFIC.length) {
      throw new Error('通用短动词 submit 必须排在全部具体短语之后，实际索引 ' + genericAt + '（具体短语数 ' + elementMissing.CTA_SPECIFIC.length + '）');
    }
    const reprobe = clicks.slice(4).map((a) => a.target.semantic);
    if (JSON.stringify(reprobe) !== JSON.stringify(['数据列表区域', vocab[0]])) {
      throw new Error('复探应取前 2 变体（原 action + 词表首项），实际 ' + JSON.stringify(reprobe));
    }
  });

  await ok('T6 契约常量：MAX_PROBE_VARIANTS=3 存在于实现（防回归）', () => {
    const s = require('fs').readFileSync(
      path.join(__dirname, '..', 'agent', 'repair', 'strategies', 'elementChanged.js'),
      'utf8'
    );
    if (!/MAX_PROBE_VARIANTS = 3;/.test(s)) throw new Error('封顶常量缺失或被改动');
    if (!/variants\.slice\(0, 1 \+ MAX_PROBE_VARIANTS\)/.test(s)) throw new Error('封顶切片缺失');
  });

  await ok('T7 阶段 1 首个变体即命中 → 动作数 1、零 reload（最小破坏面）', async () => {
    const { ctx, calls, count } = makeCtx(1);
    const r = await elementChanged.execute({ task: {}, step: { action: rw026Action }, ctx });
    if (r.ok !== true) throw new Error('应返回 ok=true');
    if (count() !== 1) throw new Error('应仅 1 次动作，实际 ' + count());
    if (calls.some((a) => a.type === 'reload')) throw new Error('不得 reload');
    if (r.actions[0].phase !== 'live') throw new Error('动作应标记 live 阶段');
  });

  await ok('T8 阶段 2 命中：第 6 次动作（复探第 1 个）成功 → ok=true', async () => {
    const { ctx, count } = makeCtx(6);
    const r = await elementChanged.execute({ task: {}, step: { action: rw026Action }, ctx });
    if (r.ok !== true) throw new Error('应返回 ok=true');
    if (count() !== 6) throw new Error('应 6 次动作（4+1 reload+1 复探命中），实际 ' + count());
  });

  console.log(`\nrepair variant cap: ${passed} passed, ${process.exitCode ? 'FAILED' : 'all green'}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
