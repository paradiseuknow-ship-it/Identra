'use strict';

// Flow Memory：状态机式流程记忆（Phase 3.2 Flow Intelligence）。
// 保存：goal / site / states / successRate / confidence / versions / samples / stats。
// 禁止：固定 selector / 坐标 / xpath（见 flowSchema.validateFlow）。
// 消费点：
//   - 规划前：flowPlanner.planWithMemory → 置信度≥0.85 直接加载历史 flow，跳过 LLM Planner；
//   - 执行后：taskManager.complete → recordFlowFromTask 提炼成功流程落库。
// 流程只提供「状态建议」，执行仍走 policy / verification / tools，绝不绕过。

const store = require('../store');
const { createBase, recordOutcome, computeConfidence, SOURCE_WEIGHT } = require('./memoryRecord');
const { validateFlow, normalizeGoal } = require('./flowSchema');
const flowMatcher = require('./flowMatcher');
const failureKnowledge = require('./failure/failureKnowledge');

// 流程置信度：流程是「整段已验证计划」，单次成功价值高于单个元素点击，
// 故成熟度曲线更快（2 样本即满），保证首次成功后即可复用（≥0.85）。
function flowConfidence(rec) {
  const rate = rec.successRate || 0;
  const total = (rec.samples.success || 0) + (rec.samples.failed || 0);
  const maturity = Math.min(1, total / 2);
  const src = SOURCE_WEIGHT[(rec.source && rec.source.type) || 'ai_success'] || 1;
  return Math.round(Math.min(1, Math.max(0, rate * (0.85 + 0.15 * maturity) * src)) * 1000) / 1000;
}

const COLLECTION = 'aiFlowMemory';
const PACK_FORMAT = 'ai-browser-operator@3.2';

function siteOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch (e) { return null; }
}

function flowKey(site, goal) {
  return String(site) + '|' + normalizeGoal(goal);
}

function listForSite(site) {
  return store.findWhere(COLLECTION, (r) => r.site === site).sort((a, b) => b.updatedAt - a.updatedAt);
}

function getByKey(site, goal) {
  const k = flowKey(site, goal);
  return store.findWhere(COLLECTION, (r) => r.key === k && (r.status || 'ACTIVE') === 'ACTIVE')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;
}

// 落库一个 flow（新建或演化既有）。states 必须已通过 validateFlow。
function recordFlow(site, goal, states, opts) {
  opts = opts || {};
  const v = validateFlow({ goal, states });
  if (!v.ok) return { ok: false, error: v.errors.join('; ') };
  const k = flowKey(site, goal);
  const existing = getByKey(site, goal);
  let rec;
  if (existing) {
    rec = existing;
    rec.version = (rec.version || 1) + 1; // 演化：版本递增，旧经验不删除
  } else {
    rec = createBase({ prefix: 'flow', key: k, site, goal: normalizeGoal(goal), source: opts.source || { type: 'ai_success' } });
  }
  rec.states = states;
  rec.goal = normalizeGoal(goal);
  rec.confidence = flowConfidence(rec);
  store.upsert(COLLECTION, rec);
  return { ok: true, flow: rec };
}

function recordOutcomeFlow(flowId, ok) {
  const rec = store.find(COLLECTION, flowId);
  if (!rec) return null;
  recordOutcome(rec, ok);
  rec.confidence = flowConfidence(rec);
  store.upsert(COLLECTION, rec);
  return rec;
}

// 把已执行成功的 task plan 提炼为 flow（只保留 semantic/状态，绝不存 selector/坐标）。
function recordFlowFromTask(task) {
  if (!task) return null;
  const site = siteOf(task.targetUrl);
  if (!site) return null;
  const stepManager = require('../stepManager');
  const steps = stepManager.listSteps(task.id);
  if (!steps.length) return null;
  const goal = task.planGoal || task.objective;
  const states = steps.map((s, i) => stateFromStep(s, i, steps, task.id));
  const v = validateFlow({ goal, states });
  if (!v.ok) return null;
  const r = recordFlow(site, goal, states, { source: { type: 'ai_success' } });
  if (!r.ok) return null;
  // CAP-K1：返回计过一次成功后的最新记录（旧实现返回 recordFlow 时的过期快照，
  // 其 confidence 是 0/0 样本下的 0 —— 调用方据此判断会误判为不可复用）。
  return recordOutcomeFlow(r.flow.id, true) || r.flow;
}

// CAP-K1 敏感值守卫：这些字段名的 value 绝不落库（红线：LLM/存储不见明文凭据）。
// 即使上游契约意外允许了 value 字面量，提炼侧也再拦一道。
const SENSITIVE_VALUE_FIELD_RE = /pass|pwd|cvv|cvc|card|otp|token|secret|pin|密码|卡号|验证码/i;

function stateFromStep(s, i, steps, taskId) {
  const rawId = (s.id && taskId && s.id.indexOf(taskId + '_') === 0) ? s.id.slice(taskId.length + 1) : s.id;
  const act = s.action || {};
  const t = act.target || {};
  const sem = t.semantic || t.field || t.text;
  // CAP-K1 写读保真：旧实现只存 semantic，toPlan 一律重建成 click —— fill/select/press
  // 全部退化为点击，重放必失败且无人知晓（失败反馈此前也是零调用）。这里保留可重放的最小集：
  // 动作类型 / field / 非敏感 value / credentialRef（引用非明文）/ verification / 业务契约。
  // 禁止项不变：selector / 坐标 / xpath 由 flowSchema.validateFlow 拒绝。
  const actionType = typeof act.type === 'string' ? act.type : undefined;
  const field = t.field || undefined;
  const credentialRef = act.credentialRef || undefined;
  let value;
  if (!credentialRef && typeof act.value === 'string' && act.value.length <= 200
    && !(field && SENSITIVE_VALUE_FIELD_RE.test(field))) {
    value = act.value;
  }
  const kind = i === 0 ? 'START' : (s.type === 'NAVIGATE' ? 'NAVIGATE' : 'STEP');
  const nextRaw = i < steps.length - 1
    ? ((steps[i + 1].id && taskId && steps[i + 1].id.indexOf(taskId + '_') === 0) ? steps[i + 1].id.slice(taskId.length + 1) : steps[i + 1].id)
    : 'DONE';
  return {
    id: rawId || ('st' + i),
    name: s.description || (s.type || 'step'),
    type: kind,
    // 旧字段保留（向后兼容既有落库数据）
    elementHints: sem ? { semantic: sem } : undefined,
    // CAP-K1 新增：可重放字段
    actionType,
    field: field || undefined,
    semantic: sem || undefined,
    value,
    credentialRef,
    context: s.context || (kind === 'START' ? { urlPattern: '/' } : undefined),
    // verification 优先取步骤级（createStep 落库处），否则取动作级；都不在才退 page_change
    verification: s.verification || act.verification || { type: 'page_change' },
    expectedBusinessState: act.expectedBusinessState || undefined,
    risk: s.risk || act.risk || (kind === 'START' ? 'LOW' : 'MEDIUM'),
    next: nextRaw,
  };
}

// 历史 flow → 可执行的 Plan（不含 selector/坐标；START/NAVIGATE 由调用方填 URL）。
// CAP-K1：新格式 state 带 actionType/field/value/credentialRef，按原动作类型重建；
// 旧格式（无 actionType，语义只有 elementHints）退回 click —— 与历史行为一致。
// 重建结果必须再过 schema/plan.validatePlan（由 flowPlanner.tryFlowPlan 统一把关），
// 旧数据缺 verification 等 MUST_VERIFY 契约时校验不过 → 自动降级 LLM 规划，绝不带病重放。
function toPlan(flow, targetUrl) {
  const steps = (flow.states || []).map((st, i) => {
    const hint = st.elementHints || {};
    const sem = st.semantic || hint.semantic || st.name;
    const isNav = st.type === 'NAVIGATE' || st.type === 'START';
    let action;
    if (isNav) {
      action = { type: 'navigate', target: { url: i === 0 ? (targetUrl || '') : (st.context && st.context.urlPattern ? st.context.urlPattern : '') }, risk: st.risk || 'LOW', verification: st.verification };
    } else if (st.actionType && st.actionType !== 'navigate') {
      action = { type: st.actionType, target: { field: st.field, semantic: sem }, risk: st.risk || 'MEDIUM', verification: st.verification };
      if (st.value !== undefined && st.value !== null) action.value = st.value;
      if (st.credentialRef) action.credentialRef = st.credentialRef;
      if (st.expectedBusinessState) action.expectedBusinessState = st.expectedBusinessState;
    } else {
      action = { type: 'click', target: { semantic: sem }, risk: st.risk || 'MEDIUM', verification: st.verification };
    }
    return {
      id: st.id, type: isNav ? 'NAVIGATE' : 'ACT', description: st.name,
      expectedOutcome: st.name, risk: st.risk || 'MEDIUM', action, verification: st.verification, fromFlow: true,
    };
  });
  return { goal: flow.goal, steps };
}

// 查询包装（上游调用）
function lookup(site, goal) {
  return flowMatcher.lookup(site, goal, listForSite(site));
}

// 经验包导出 / 导入（含 Element + Site + Flow，站点经验整体迁移）
function exportPack(site, opts) {
  opts = opts || {};
  const flows = listForSite(site);
  const elements = store.findWhere('aiElementMemory', (r) => r.site === site);
  const sites = store.findWhere('aiSiteMemory', (r) => r.site === site);
  const failures = failureKnowledge.exportPack(site);
  const profileScores = require('./profile/profileAnalyzer').listRecords()
    .filter((r) => r.siteScores && r.siteScores[site])
    .map((r) => ({ profileId: r.profileId, name: r.name, siteScore: r.siteScores[site], updatedAt: r.updatedAt }));
  return {
    pack: {
      name: opts.name || (site + ' Flow Experience Pack'),
      type: 'experience', format: PACK_FORMAT, version: 1, site, exportedAt: Date.now(),
      flowMemory: flows, elementMemory: elements, siteMemory: sites, failureKnowledge: failures,
      profileScores,
    },
  };
}

function importPack(packObj) {
  const pack = packObj && packObj.pack ? packObj.pack : packObj;
  if (!pack || pack.format !== PACK_FORMAT) return { ok: false, error: '格式不支持', imported: 0, skipped: 0 };
  let imported = 0, skipped = 0;
  const merge = (name, arr) => {
    for (const r of arr || []) {
      // C75 D2：与 elementMemory.importPack 同守卫 —— 记录 site 必须与 pack.site 一致，
      // 否则跨站隔离被导入写入侧旁路。不一致计 skipped，不静默改写。
      if (r.site !== pack.site) { skipped++; continue; }
      const ex = store.find(name, r.id);
      if (!ex || (ex.version || 1) < (r.version || 1)) { store.upsert(name, r); imported++; }
      else skipped++;
    }
  };
  merge(COLLECTION, pack.flowMemory);
  merge('aiElementMemory', pack.elementMemory);
  merge('aiSiteMemory', pack.siteMemory);
  merge(failureKnowledge.COLLECTION, pack.failureKnowledge);
  // Profile 评分：仅导入与该站点相关的站点分（不覆盖全局维度，避免污染）
  const ps = require('./profile/profileAnalyzer');
  for (const p of pack.profileScores || []) {
    if (!p || !p.profileId || !p.siteScore) continue;
    // C75 D3：目标 profile 必须已有评分记录 —— ensure() 会为不存在的 profileId 凭空创建
    // 幽灵评分记录（NEUTRAL_DIMS 初值），Profile Advisor 随后可能把任务导向一个
    // 根本不存在的环境（任务创建后 browserManager 找不到 profile 直接失败）。
    // 经验包只应增强既有环境的站点经验，不能创造环境。
    if (!ps.getRecord(p.profileId)) { skipped++; continue; }
    const rec = ps.ensure(p.profileId, { name: p.name });
    const site = pack.site;
    const ss = rec.siteScores[site] || (rec.siteScores[site] = { score: 0, success: 0, failed: 0, samples: 0, recent: [], confidence: 0, updatedAt: 0 });
    // 经验包带来的样本计为 1 次成功（来自另一环境验证）
    ss.samples = (ss.samples || 0) + 1;
    ss.success = (ss.success || 0) + 1;
    ps.recomputeSiteScore(rec, site);
    store.upsert(ps.COLLECTION, rec);
    imported++;
  }
  return { ok: true, imported, skipped };
}

module.exports = {
  recordFlow, recordOutcomeFlow, recordFlowFromTask, toPlan, getByKey, listForSite,
  lookup, siteOf, validateFlow, exportPack, importPack, flowKey, COLLECTION, MIN_CONFIDENCE: flowMatcher.LOAD_THRESHOLD,
};
