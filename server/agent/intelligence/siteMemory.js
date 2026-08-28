'use strict';

// Site Memory：站点画像（成功率 / 常用流程 / 风险 / 高频失败）。
// 写入：task 完成/失败；消费：chat 推荐、contextBuilder 站点知识、推荐引擎（3.5）。

const store = require('../store');
const { createBase, recordOutcome } = require('./memoryRecord');

function getSite(site) {
  return store.findWhere('aiSiteMemory', (r) => r.site === site)[0] || null;
}

function ensure(site) {
  let r = getSite(site);
  if (!r) {
    r = createBase({
      prefix: 'site',
      site,
      domain: site,
      history: { successTasks: 0, failedTasks: 0 },
      commonFlows: {},       // flowName -> { successRate, avgSteps, samples, lastUsed }
      frequentFailures: [],
      failureProfile: { commonFailures: [] }, // 失败画像（Phase 3.3）：type -> { frequency, successRate }
      riskLevel: 'unknown',
    });
    store.upsert('aiSiteMemory', r);
  }
  return r;
}

// 任务结果回写：成功/失败、流程成功率、风险聚合
function recordTaskResult(site, { ok, flowName, avgSteps, failureType }) {
  const r = ensure(site);
  if (ok) r.history.successTasks = (r.history.successTasks || 0) + 1;
  else r.history.failedTasks = (r.history.failedTasks || 0) + 1;

  if (flowName) {
    const f = r.commonFlows[flowName] || { successRate: 0, avgSteps: 0, samples: 0, lastUsed: 0 };
    f.samples += 1;
    f.successRate = ok ? ((f.successRate * (f.samples - 1) + 1) / f.samples) : ((f.successRate * (f.samples - 1)) / f.samples);
    if (avgSteps) f.avgSteps = f.avgSteps ? Math.round(((f.avgSteps * (f.samples - 1)) + avgSteps) / f.samples) : avgSteps;
    f.lastUsed = Date.now();
    r.commonFlows[flowName] = f;
  }
  if (failureType && !r.frequentFailures.includes(failureType)) r.frequentFailures.push(failureType);

  const total = r.history.successTasks + r.history.failedTasks;
  if (total >= 5 && r.history.successTasks / total < 0.6) r.riskLevel = 'high';
  else if (total >= 3) r.riskLevel = 'medium';
  else r.riskLevel = 'unknown';

  recordOutcome(r, ok);
  store.upsert('aiSiteMemory', r);
  return r;
}

// 失败画像聚合（Phase 3.3）：按错误类别累积频次与成功率，供 chat 推荐与 3.5 推荐引擎。
function recordFailureProfile(site, { type, success }) {
  const r = ensure(site);
  const list = r.failureProfile.commonFailures || (r.failureProfile.commonFailures = []);
  let e = list.find((x) => x.type === type);
  if (!e) { e = { type, frequency: 0, successRate: 0 }; list.push(e); }
  e.frequency = (e.frequency || 0) + 1;
  const prev = e.successRate || 0;
  const n = e.frequency;
  e.successRate = success ? Math.round(((prev * (n - 1) + 1) / n) * 1000) / 1000 : Math.round(((prev * (n - 1)) / n) * 1000) / 1000;
  store.upsert('aiSiteMemory', r);
  return r;
}

function listSites() {
  return store.read('aiSiteMemory', []);
}

function removeSite(site) {
  store.write('aiSiteMemory', store.read('aiSiteMemory', []).filter((r) => r.site !== site));
}

module.exports = { getSite, ensure, recordTaskResult, recordFailureProfile, listSites, removeSite };
