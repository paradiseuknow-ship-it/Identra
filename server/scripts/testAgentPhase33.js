'use strict';

// Phase 3.3 Failure Knowledge 验收（纯逻辑，无浏览器 / 无 server 依赖）。
// 覆盖：
//   Case1 首次学 / 二次复用跳过 LLM（直接推荐 SEMANTIC_RELOCATE）
//   Case2 错误误导保护（403 → 只存 REAUTH_OR_PAUSE，禁止撞库/自动绕过）
//   Case3 低成功经验降权（10 败 2 成 → confidence<0.5 → 不可自动使用）
//   Case4 跨站隔离（A 站经验不影响 B 站）
//   + schema 拒绝禁止字段 / 纯 errorType 误配被拒 / export-import 经验包

const store = require('../agent/store');
const fk = require('../agent/intelligence/failure/failureKnowledge');
const matcher = require('../agent/intelligence/failure/failureMatcher');
const advisor = require('../agent/intelligence/failure/failureAdvisor');
const collector = require('../agent/intelligence/failure/failureCollector');
const scoring = require('../agent/intelligence/failure/failureScoring');
const schema = require('../agent/intelligence/failure/schema');
const flowMemory = require('../agent/intelligence/flowMemory');

const TEST_SITES = ['shop.test', 'bank.test', 'a.test', 'b.test', 'exp.test'];
function clean() {
  for (const c of ['aiFailureKnowledge', 'aiSiteMemory', 'aiElementMemory', 'aiFlowMemory']) {
    store.write(c, (store.read(c, []).filter((r) => !TEST_SITES.includes(r.site))));
  }
}
clean();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
}

console.log('\n=== Phase 3.3 Failure Knowledge ===\n');

// ---------- schema 校验 ----------
console.log('[schema]');
{
  const bad = schema.validate({ site: 'x', category: 'ELEMENT_CHANGED', condition: {}, evidence: { errorType: 'ELEMENT_NOT_FOUND' }, solution: { strategy: 'SEMANTIC_RELOCATE', steps: ['a'], selector: '.btn' } });
  ok(!bad.ok, 'schema 拒绝包含 selector 的 solution', bad.ok ? 'unexpected ok' : bad.errors[0]);
  const badStrategy = schema.validate({ site: 'x', category: 'ELEMENT_CHANGED', condition: {}, evidence: { errorType: 'E' }, solution: { strategy: 'HACK_THE_SITE', steps: [] } });
  ok(!badStrategy.ok, 'schema 拒绝不受控策略');
  const badForbidden = schema.validate({ site: 'x', category: 'HTTP_FORBIDDEN', condition: {}, evidence: { errorType: 'NAVIGATION_FAILED' }, solution: { strategy: 'SEMANTIC_RELOCATE', steps: [] } });
  ok(!badForbidden.ok, 'schema 拒绝受保护类别使用非 REAUTH_OR_PAUSE 策略');
  const good = schema.validate({ site: 'x', category: 'ELEMENT_CHANGED', condition: { urlPattern: '/signup', actionType: 'click' }, evidence: { errorType: 'ELEMENT_NOT_FOUND' }, solution: { strategy: 'SEMANTIC_RELOCATE', steps: ['inspect'] } });
  ok(good.ok, 'schema 放行合法经验');
}

// ---------- Case1：首次学 / 二次复用跳过 LLM ----------
console.log('\n[Case1] 首次失败→学习；二次同错→复用历史策略（不调用 LLM Diagnosis）');
{
  const ctx = { site: 'shop.test', category: 'ELEMENT_CHANGED', errorType: 'ELEMENT_NOT_FOUND', url: 'http://shop.test/signup', actionType: 'click', pageState: 'REGISTER_FORM', element: 'submit_button', strategy: 'SEMANTIC_RELOCATE', steps: ['inspect', 'semanticResolver', 'retry click'] };
  const r1 = collector.recordSuccess(ctx);
  ok(r1.ok && r1.fk, '首次修复成功 → 落库 FailureKnowledge');

  // 第二次相同失败上下文 → advisor 直接命中
  const a = advisor.recommend({ site: 'shop.test', url: 'http://shop.test/signup', errorType: 'ELEMENT_NOT_FOUND', action: 'click', pageState: 'REGISTER_FORM' });
  ok(a.matched && a.usable, '二次同错 → 命中历史经验且可用', 'conf=' + (a.confidence != null ? a.confidence : 'n/a'));
  ok(a.recommendation && a.recommendation.strategy === 'SEMANTIC_RELOCATE', '直接推荐 SEMANTIC_RELOCATE（无需 LLM Diagnosis）', a.recommendation && a.recommendation.strategy);
  ok(a.fromFailureMemory === true, '标记 fromFailureMemory（消费点：跳过 Diagnosis LLM）');

  // resolveDiagnosis 供 repairManager 决策
  const rd = advisor.resolveDiagnosis({ site: 'shop.test', url: 'http://shop.test/signup', errorType: 'ELEMENT_NOT_FOUND', action: 'click', pageState: 'REGISTER_FORM' });
  ok(rd.useMemory === true && rd.syntheticDiagnosis && rd.syntheticDiagnosis.fromFailureMemory, 'resolveDiagnosis 返回 useMemory（repairManager 据此跳过 LLM）');

  // 数据已聚合进 siteMemory.failureProfile
  const sm = require('../agent/intelligence/siteMemory').getSite('shop.test');
  ok(sm && sm.failureProfile.commonFailures.some((f) => f.type === 'ELEMENT_CHANGED' && f.frequency >= 1), '站点失败画像已聚合 commonFailures');
}

// ---------- Case2：错误误导保护（403 / forbidden）----------
console.log('\n[Case2] 403 → 只推荐等待/换环境/人工，禁止自动绕过');
{
  const r = collector.recordSuccess({ site: 'bank.test', category: 'HTTP_FORBIDDEN', errorType: 'NAVIGATION_FAILED', url: 'http://bank.test/admin', actionType: 'navigate', pageState: 'ADMIN', strategy: 'SEMANTIC_RELOCATE', steps: ['force bypass'] });
  ok(r.ok, '受保护类别仍可落库');
  const stored = fk.getForSite('bank.test')[0];
  ok(stored.solution.strategy === 'REAUTH_OR_PAUSE', '强制策略为 REAUTH_OR_PAUSE（等待/换环境/人工）', stored.solution.strategy);
  ok(!/bypass|撞库|force/i.test(JSON.stringify(stored.solution)), 'solution 不含任何绕过/撞库指令');
  const a = advisor.recommend({ site: 'bank.test', url: 'http://bank.test/admin', errorType: 'NAVIGATION_FAILED', action: 'navigate', pageState: 'ADMIN' });
  ok(a.matched && a.recommendation && a.recommendation.strategy === 'REAUTH_OR_PAUSE', 'advisor 只建议 REAUTH_OR_PAUSE（仍经 Policy 门禁→人工）');
}

// ---------- Case3：低成功经验降权 ----------
console.log('\n[Case3] 10 败 2 成 → confidence<0.5 → 不可自动使用');
{
  const base = { site: 'a.test', category: 'TIMEOUT', errorType: 'TIMEOUT', url: 'http://a.test/checkout', actionType: 'submit', pageState: 'PAYMENT', strategy: 'WAIT_RETRY_RELOAD', steps: ['wait', 'reload', 'retry'] };
  let rec;
  for (let i = 0; i < 2; i++) rec = collector.recordSuccess(base);
  for (let i = 0; i < 10; i++) rec = collector.recordFailure(base);
  const fkRec = fk.getForSite('a.test')[0];
  ok(fkRec && fkRec.samples.failed >= 10 && fkRec.samples.success <= 2, '样本累计 10 败 2 成');
  ok(scoring.failureConfidence(fkRec) < 0.5, '低成功 → confidence<0.5', 'conf=' + scoring.failureConfidence(fkRec));
  const a = advisor.recommend({ site: 'a.test', url: 'http://a.test/checkout', errorType: 'TIMEOUT', action: 'submit', pageState: 'PAYMENT' });
  ok(a.matched && a.usable === false, '命中但不可用（自动复用风险过高，转正常诊断/人工）', 'usable=' + a.usable);
}

// ---------- Case4：跨站隔离 ----------
console.log('\n[Case4] 跨站隔离：A 站经验不影响 B 站');
{
  collector.recordSuccess({ site: 'c.test', category: 'ELEMENT_CHANGED', errorType: 'ELEMENT_NOT_FOUND', url: 'http://c.test/signup', actionType: 'click', pageState: 'REGISTER_FORM', element: 'Continue', strategy: 'SEMANTIC_RELOCATE', steps: ['inspect', 'retry'] });
  const a = advisor.recommend({ site: 'b.test', url: 'http://b.test/signup', errorType: 'ELEMENT_NOT_FOUND', action: 'click', pageState: 'REGISTER_FORM' });
  ok(!a.matched, 'B 站相同错误 → 不命中 A 站经验（跨站隔离）', 'matched=' + a.matched);
}

// ---------- 纯 errorType 误配被拒 ----------
console.log('\n[matcher] 防止只按 errorType 匹配');
{
  // 同一 site/errorType，但 action/url/pageState 全不同 → 加权得分应 < 阈值
  collector.recordSuccess({ site: 'exp.test', category: 'OBSTRUCTION', errorType: 'ELEMENT_NOT_INTERACTABLE', url: 'http://exp.test/home', actionType: 'check', pageState: 'HOME', element: 'modal', strategy: 'DISMISS_OVERLAY', steps: ['dismiss'] });
  const a = advisor.recommend({ site: 'exp.test', url: 'http://exp.test/checkout', errorType: 'ELEMENT_NOT_INTERACTABLE', action: 'click', pageState: 'PAYMENT' });
  ok(!a.matched || a.score < matcher.MATCH_THRESHOLD, '仅 errorType 相同（其余维度不同）→ 不误配', 'score=' + (a.score != null ? a.score : 'n/a'));
}

// ---------- 经验包导出/导入 ----------
console.log('\n[export/import]');
{
  const pack = flowMemory.exportPack('shop.test');
  ok(pack.pack.failureKnowledge && pack.pack.failureKnowledge.length >= 1, '经验包含 failureKnowledge', 'n=' + (pack.pack.failureKnowledge || []).length);
  // 清空后导入
  store.write('aiFailureKnowledge', []);
  const imp = flowMemory.importPack(pack.pack);
  ok(imp.imported >= 1 && imp.ok, '导入失败经验成功', 'imported=' + imp.imported);
  ok(fk.getForSite('shop.test').length >= 1, '导入后经验可查');
}

// ---------- 清理测试数据 ----------
clean();

console.log('\n=== Phase 3.3 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail ? 1 : 0);
