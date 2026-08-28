'use strict';

// Phase 3.5 Intelligence Router 测试：纯逻辑，不启动 server（共享 store 并发写风险）。
// 覆盖：Case1 最佳 Profile+Flow 选 A；Case2 新站无经验→环境分+Planner；
//      Case3 Failure 风险 warning；Case4 Decision 必须有理由；Case5 Cache hit。

const store = require('../agent/store');
const profAnalyzer = require('../agent/intelligence/profile/profileAnalyzer');
const flowMemory = require('../agent/intelligence/flowMemory');
const flowMatcher = require('../agent/intelligence/flowMatcher');
const siteMemory = require('../agent/intelligence/siteMemory');
const failureCollector = require('../agent/intelligence/failure/failureCollector');
const router = require('../agent/intelligence/router');
const profileAdvisor = require('../agent/intelligence/profile/profileAdvisor');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
}

// 仅保留真实 profiles，清掉测试注入的（防 phase31 经 taskManager 钩子污染）
const path = require('path');
const fs = require('fs');
function clean() {
  const realRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'profiles.json'), 'utf8'));
  const real = Array.isArray(realRaw) ? realRaw : Object.values(realRaw);
  const realIds = new Set(real.map((r) => r.id));
  store.write('aiProfileScores', store.read('aiProfileScores', []).filter((r) => realIds.has(r.profileId)));
  store.write('aiFlowMemory', store.read('aiFlowMemory', []).filter((r) => !['f_a', 'f_b'].includes(r.id)));
  store.write('aiSiteMemory', store.read('aiSiteMemory', []).filter((r) => !['r_stripe.com', 'r_neo.com'].includes(r.site)));
  store.write('aiFailureKnowledge', store.read('aiFailureKnowledge', []).filter((r) => !['fk_cookie', 'fk_neo'].includes(r.id)));
  router.cache.clear();
}

// ============================================================
console.log('\n[Schema] 安全红线');
{
  const { validateDecision, FORBIDDEN_STRATEGIES } = router.schema;
  const bad = validateDecision({ decision: { profile: { id: 'p1' }, flow: { id: 'f1' }, strategy: { actions: ['switch_ip'], expectedSuccess: 0.9 } } });
  ok(!bad.ok && bad.errors.join().includes('switch_ip'), '禁止策略被拒绝', JSON.stringify(bad.errors));
  const good = validateDecision({ decision: { profile: { id: 'p1' }, strategy: { expectedSuccess: 0.9 } } });
  ok(good.ok, '正常决策通过校验');
  ok(FORBIDDEN_STRATEGIES.includes('auto_pay'), 'auto_pay 在红线列表');
}

// ============================================================
console.log('\n[Case1] 最佳 Profile + Flow：A(Profile90/Flow95) vs B(Profile95/Flow50) → 选 A');
clean();
{
  // A：环境评分 90，且有 stripe 高置信 flow
  profAnalyzer.applyDimensions('pp_a', { fingerprint: 90, network: 90, storage: 90, taskSuccess: 90, stability: 90 }, { name: 'EnvA' });
  for (let i = 0; i < 5; i++) profAnalyzer.recordTaskOutcome('pp_a', 'stripe.com', true);
  // B：环境评分 95，但 stripe 无高置信 flow（仅环境好）
  profAnalyzer.applyDimensions('pp_b', { fingerprint: 95, network: 95, storage: 95, taskSuccess: 95, stability: 95 }, { name: 'EnvB' });

  // 给 A 落一条高置信 flow（通过 flowMemory.lookup 可命中 reused）
  flowMemory.recordFlow('stripe.com', '注册 SaaS', [
    { id: 'st0', name: '打开注册页', type: 'START', elementHints: {}, context: { urlPattern: '/signup' }, verification: { type: 'page_change' }, risk: 'LOW', next: 'st1' },
    { id: 'st1', name: '填写邮箱', type: 'STEP', elementHints: { semantic: 'email' }, verification: { type: 'field_filled' }, risk: 'MEDIUM', next: 'DONE' },
  ], { source: { type: 'ai_success' } });
  // 强化 flow 使其高成功（lookup 需 confidence>=0.85 的 reused）
  const f = flowMemory.getByKey('stripe.com', '注册 SaaS');
  for (let i = 0; i < 3; i++) flowMemory.recordOutcomeFlow(f.id, true);

  const d = router.decide({ objective: '注册 SaaS', targetUrl: 'https://stripe.com/signup', region: 'US' });
  ok(d && d.decision && d.decision.profile && d.decision.profile.id === 'pp_a', '选择环境 A（Profile+Flow 综合最佳）', d && d.decision && d.decision.profile && d.decision.profile.id);
  ok(d.decision.flow && d.decision.flow.id, '复用 A 的高置信 flow', d.decision.flow && d.decision.flow.id);
  ok(!d.decision.strategy.requireLLM, '有 flow → 不需 LLM', d.decision.strategy.requireLLM);
  // 评分应高于纯 B 环境（A 有 flow 加成）
  ok(d.decision.strategy.expectedSuccess >= 0.7, '预计成功率合理', d.decision.strategy.expectedSuccess);
}

// ============================================================
console.log('\n[Case2] 新网站无经验 → 用环境分 + Planner（不调 Memory）');
clean();
{
  profAnalyzer.applyDimensions('pp_x', { fingerprint: 85, network: 85, storage: 85, taskSuccess: 85, stability: 85 }, { name: 'EnvX' });
  const d = router.decide({ objective: '注册全新站点', targetUrl: 'https://example-new.com/signup', region: 'US' });
  ok(d.decision.profile && d.decision.profile.id === 'pp_x', '新站仍选最佳环境', d.decision.profile && d.decision.profile.id);
  ok(!d.decision.flow, '新站无 flow 经验', d.decision.flow);
  ok(d.decision.strategy.requireLLM, '无 flow → 需 LLM 规划', d.decision.strategy.requireLLM);
  ok(!d.decision.flow, '新站无 flow 经验 → 不 claim 复用 flow', d.decision.flow);
}

// ============================================================
console.log('\n[Case3] Failure 风险 → 输出 warning（如 cookie popup 历史）');
clean();
{
  // 在 stripe 落一条 cookie popup 失败经验（可用，置信度>=0.5）
  failureCollector.recordRepair({
    site: 'stripe.com', category: 'OBSTRUCTION', errorType: 'OBSTRUCTION',
    url: 'https://stripe.com/signup', actionType: 'task', pageState: 'loaded',
    strategy: 'DISMISS_OVERLAY', steps: ['点击接受 Cookie'], success: false,
    source: { type: 'ai_success' },
  });
  // 强化该经验使其 usable（6 次成功）
  for (let i = 0; i < 6; i++) {
    failureCollector.recordRepair({
      site: 'stripe.com', category: 'OBSTRUCTION', errorType: 'OBSTRUCTION',
      url: 'https://stripe.com/signup', actionType: 'task', pageState: 'loaded',
      strategy: 'DISMISS_OVERLAY', steps: ['点击接受 Cookie'], success: true,
      source: { type: 'repair_success' },
    });
  }

  const d = router.decide({ objective: '注册 SaaS', targetUrl: 'https://stripe.com/signup', region: 'US' });
  ok(d.warnings && d.warnings.length > 0, '输出 warning', JSON.stringify(d.warnings));
  ok(d.warnings.join().includes('OBSTRUCTION') || d.warnings.join().includes('DISMISS_OVERLAY') || d.warnings.join().toLowerCase().includes('overlay'), 'warning 含遮挡/cookie 提示', JSON.stringify(d.warnings));
}

// ============================================================
console.log('\n[Case4] Decision 必须有理由（不能盲选）');
clean();
{
  const d = router.decide({ objective: '注册 SaaS', targetUrl: 'https://stripe.com/signup', region: 'US' });
  ok(d.reasons && d.reasons.length > 0, 'decision 至少含 1 条 reason', JSON.stringify(d.reasons));
  ok(d.explanation && d.explanation.summary, '有 summary 摘要', d.explanation && d.explanation.summary);
}

// ============================================================
console.log('\n[Case5] Decision Cache：第二次命中缓存');
clean();
{
  router.cache.clear();
  const input = { objective: '注册 SaaS', targetUrl: 'https://stripe.com/signup', region: 'US' };
  const first = router.decide(input);
  const second = router.decide(input);
  ok(second.fromCache === true, '第二次调用命中缓存', 'fromCache=' + second.fromCache);
  // 缓存内容一致
  ok(JSON.stringify(first.decision) === JSON.stringify(second.decision), '缓存决策与首次一致');
}

// ============================================================
console.log('\n[Advisor Registry] 可扩展、不硬编码');
{
  const reg = router.advisorRegistry;
  const before = reg.list().length;
  reg.register({ name: 'cookie', priority: 85, run: () => ({ ok: true }) });
  ok(reg.list().length === before + 1, '注册新 advisor 成功');
  // 按 priority 降序：cookie(85) 应在 planner(10) 之前
  const names = reg.list().map((a) => a.name);
  ok(names.indexOf('cookie') < names.indexOf('planner'), '新 advisor 按优先级排序生效');
  reg.unregister('cookie');
  ok(reg.list().length === before, '卸载 advisor 成功');
}

// ============================================================
console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
