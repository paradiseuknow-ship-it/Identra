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
  if (r.ok) recordOutcomeFlow(r.flow.id, true);
  return r.ok ? r.flow : null;
}

function stateFromStep(s, i, steps, taskId) {
  const rawId = (s.id && taskId && s.id.indexOf(taskId + '_') === 0) ? s.id.slice(taskId.length + 1) : s.id;
  const t = (s.action && s.action.target) || {};
  const sem = t.semantic || t.field || t.text;
  const kind = i === 0 ? 'START' : (s.type === 'NAVIGATE' ? 'NAVIGATE' : 'STEP');
  const nextRaw = i < steps.length - 1
    ? ((steps[i + 1].id && taskId && steps[i + 1].id.indexOf(taskId + '_') === 0) ? steps[i + 1].id.slice(taskId.length + 1) : steps[i + 1].id)
    : 'DONE';
  return {
    id: rawId || ('st' + i),
    name: s.description || (s.type || 'step'),
    type: kind,
    elementHints: sem ? { semantic: sem } : undefined,
    context: s.context || (kind === 'START' ? { urlPattern: '/' } : undefined),
    verification: s.verification || { type: 'page_change' },
    risk: s.risk || (kind === 'START' ? 'LOW' : 'MEDIUM'),
    next: nextRaw,
  };
}

// 历史 flow → 可执行的 Plan（不含 selector/坐标；START/NAVIGATE 由调用方填 URL）。
function toPlan(flow, targetUrl) {
  const steps = (flow.states || []).map((st, i) => {
    const hint = st.elementHints || {};
    const isNav = st.type === 'NAVIGATE' || st.type === 'START';
    const action = isNav
      ? { type: 'navigate', target: { url: i === 0 ? (targetUrl || '') : (st.context && st.context.urlPattern ? st.context.urlPattern : '') }, risk: st.risk || 'LOW', verification: st.verification }
      : { type: 'click', target: { semantic: hint.semantic || st.name }, risk: st.risk || 'MEDIUM', verification: st.verification };
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
