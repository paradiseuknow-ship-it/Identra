'use strict';

// 修复策略：ELEMENT_CHANGED → SEMANTIC_RELOCATE。
//
// R2 非破坏化（2026-09-03）：探测先行、reload 降为最后手段。
// 缺陷实证（SMOKE5 rw.094 / run9 rw.001）：旧实现「先 reload 一次再探测」——reload 会
// 摧毁未提交的客户端状态（表单输入、SPA 状态、购物车计数），随后的语义重定位/重试
// 建立在被重置的页面上，产生次生失败；failureDiagnoser.stateResetByRepair 证据降级
// 规则即为此而设（治标）。本修复治本：
//   阶段 1：活跃 DOM 上零破坏探测（原 action + ≤3 语义变体，与既有封顶契约同界）；
//   阶段 2（仅当阶段 1 全部失败——元素可能尚未渲染/页面过期）：reload + 前 2 变体收窄复探。
// 预算核算：最坏 4 + 3 = 7 个修复动作（旧实现 5 个），120s canonical 修复预算内收敛。

const elementMissing = require('../../recovery/strategies/elementMissing');

function meta() {
  return {
    type: 'SEMANTIC_RELOCATE',
    risk: 'LOW',
    steps: [
      { type: 'semantic_resolve', description: '活跃 DOM 上零破坏语义重定位（含同义词，优先）' },
      { type: 'retry', description: '重试原动作' },
      { type: 'reload', description: '阶段 1 失败才重载（最后手段，可能重置客户端状态）' },
      { type: 'semantic_resolve', description: '重载后收窄复探' },
      { type: 'retry', description: '复探后重试原动作' },
    ],
    verification: { type: 'action_success' },
  };
}

function describe(action) {
  return action.target && (action.target.semantic || action.target.field || action.target.url || '');
}

async function probe(ctx, probeList, actions, tag) {
  for (const action of probeList) {
    const res = await ctx.runAction(action);
    actions.push({ tool: action.type, target: describe(action), ok: !!res.success, reason: action.reason || null, phase: tag });
    if (res.success) return true;
  }
  return false;
}

async function execute({ task, step, ctx }) {
  const actions = [];
  const variants = elementMissing.buildElementVariants(step.action);

  // 修复编排契约「至多 3 次浏览器修复动作」封顶（rw.026/dl240 实证继承）：
  // 阶段 1 = 原 action + ≤3 语义变体；阶段 2 = reload + 前 2 变体收窄复探。
  const MAX_PROBE_VARIANTS = 3;
  const probeList = variants.slice(0, 1 + MAX_PROBE_VARIANTS);

  // 阶段 1：活跃 DOM 零破坏探测（客户端状态完整保留——表单/SPA/购物车不受影响）。
  if (await probe(ctx, probeList, actions, 'live')) return { ok: true, actions };

  // 阶段 2：仅当阶段 1 全部失败才 reload（页面可能动态渲染/会话过期），收窄复探。
  try {
    const reload = await ctx.runAction({ type: 'reload', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 10000 });
    actions.push({ tool: 'reload', ok: !!reload.success, phase: 'last-resort' });
  } catch (e) {
    actions.push({ tool: 'reload', ok: false, phase: 'last-resort' });
  }
  if (await probe(ctx, probeList.slice(0, 2), actions, 'after-reload')) return { ok: true, actions };
  return { ok: false, actions };
}

module.exports = { meta, execute };
