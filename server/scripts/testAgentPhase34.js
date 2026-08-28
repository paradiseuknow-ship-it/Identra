'use strict';

// Phase 3.4 Profile Intelligence 验收（纯逻辑，无浏览器 / 无 server 依赖）。
// 覆盖：
//   [schema] 字段校验 / 状态枚举
//   [Case1] 选「对该目标最好的环境」：A 站 stripe 95 vs B 站 stripe 40 → 选 A（即便 B 总体环境更好）
//   [Case2] 新 Profile 无历史 → 用 environment 分（integrity+proxy），不因无历史被罚
//   [Case3] Profile 恶化（近期成功率暴跌）→ 降权，Healthy 胜出
//   [Case4] 跨站隔离：stripe 成功环境不自动推荐到 notion
//   [region] 地区偏好：US 环境在 region=US 时优先；DISABLED 被跳过
//   [lifecycle] 连续失败 → WARNING/DEGRADED（不删除）

const store = require('../agent/store');
const analyzer = require('../agent/intelligence/profile/profileAnalyzer');
const matcher = require('../agent/intelligence/profile/profileMatcher');
const advisor = require('../agent/intelligence/profile/profileAdvisor');
const scoring = require('../agent/intelligence/profile/profileScore');
const schema = require('../agent/intelligence/profile/schema');

const COLLECTION = analyzer.COLLECTION;
const TEST_IDS = ['pp_a', 'pp_b', 'pp_c', 'pp_d', 'pp_e', 'pp_f', 'pp_g', 'pp_h', 'pp_p', 'pp_q'];

// 真实 Profile 白名单：仅保留 data/profiles.json 中存在的 Profile 评分，
// 其余（测试注入 + 其它测试脚本经 taskManager 钩子产生的记录）一律清除，保证本测试隔离。
function realProfileIds() {
  try {
    const fs = require('fs');
    const path = require('path');
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'profiles.json'), 'utf8'));
    const arr = Array.isArray(p) ? p : Object.values(p);
    return new Set(arr.map((x) => x && x.id).filter(Boolean));
  } catch (e) { return new Set(); }
}

function clean() {
  const real = realProfileIds();
  store.write(COLLECTION, store.read(COLLECTION, []).filter((r) => r && real.has(r.profileId)));
}
clean();

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
}

console.log('\n=== Phase 3.4 Profile Intelligence ===\n');

// ---------- schema 校验 ----------
console.log('[schema]');
{
  const bad = schema.validate({ profileId: 'x', dimensions: { fingerprint: 99, network: 99, storage: 99, taskSuccess: 99 }, score: 50 }); // 缺 stability
  ok(!bad.ok, 'schema 拒绝缺失 stability 维度', bad.ok ? 'unexpected ok' : bad.errors[0]);
  const badScore = schema.validate({ profileId: 'x', dimensions: { fingerprint: 99, network: 99, storage: 99, taskSuccess: 99, stability: 99 }, score: 150 });
  ok(!badScore.ok, 'schema 拒绝 score>100');
  const wrongStatus = schema.validate({ profileId: 'x', dimensions: { fingerprint: 90, network: 90, storage: 90, taskSuccess: 90, stability: 90 }, score: 90, status: 'BROKEN' });
  ok(!wrongStatus.ok, 'schema 拒绝非法 status');
  const good = schema.validate({ profileId: 'x', dimensions: { fingerprint: 90, network: 90, storage: 90, taskSuccess: 90, stability: 90 }, score: 90, status: 'ACTIVE' });
  ok(good.ok, 'schema 放行合法记录');
  ok(schema.PROFILE_STATUS.includes('WARNING') && schema.PROFILE_STATUS.includes('DEGRADED') && schema.PROFILE_STATUS.includes('DISABLED'), 'PROFILE_STATUS 含 WARNING/DEGRADED/DISABLED');
}

// ---------- Case1：选对该目标最好的环境 ----------
console.log('\n[Case1] 站点专属优先：A(stripe 95) vs B(总体环境更好但无 stripe 历史) → stripe 选 A，无关站点选 B');
clean();
{
  // A：环境中等，stripe 历史优（18 成 2 败）
  analyzer.applyDimensions('pp_a', { fingerprint: 80, network: 80, storage: 80, taskSuccess: 80, stability: 80 }, { name: 'EnvA' });
  for (let i = 0; i < 18; i++) analyzer.recordTaskOutcome('pp_a', 'stripe.com', true);
  for (let i = 0; i < 2; i++) analyzer.recordTaskOutcome('pp_a', 'stripe.com', false);
  // B：环境总体更好（指纹/网络/存储高），且在另一站点健康成功，但【无 stripe 历史】
  analyzer.applyDimensions('pp_b', { fingerprint: 95, network: 95, storage: 95, taskSuccess: 95, stability: 95 }, { name: 'EnvB' });
  for (let i = 0; i < 20; i++) analyzer.recordTaskOutcome('pp_b', 'other-site.com', true);

  const a = analyzer.getRecord('pp_a'), b = analyzer.getRecord('pp_b');
  ok((analyzer.siteScoreValue(a, 'stripe.com') || 0) > 85, 'A 的 stripe 站点评分高', 'A.stripe=' + analyzer.siteScoreValue(a, 'stripe.com'));
  ok(analyzer.siteScoreValue(b, 'stripe.com') == null, 'B 无 stripe 历史（跨站隔离前提）', 'B.stripe=' + analyzer.siteScoreValue(b, 'stripe.com'));
  ok(b.status === 'ACTIVE', 'B 总体健康（不因病态前提被降级）', 'status=' + b.status);

  const rec = advisor.recommend({ site: 'stripe.com' });
  ok(rec.matched && rec.recommendation.profileId === 'pp_a', 'stripe 目标 → 选 A（站点专属优先，尽管 B 环境更好）', 'chosen=' + (rec.recommendation && rec.recommendation.profileId));
  ok(rec.recommendation.specificity === 'site', '推荐依据为 site（站点专属）', rec.recommendation && rec.recommendation.specificity);

  // 反证：对两者都无历史的站点，B（环境更好）胜出 —— 证明「总体好≠对该目标好」
  const recU = advisor.recommend({ site: 'unknown-xyz.com' });
  ok(recU.matched && recU.recommendation.profileId === 'pp_b', '无历史站点 → 总体环境更好的 B 胜出（区分维度）', 'chosen=' + (recU.recommendation && recU.recommendation.profileId));
  ok(recU.recommendation.specificity === 'environment', '无历史 → 依据 environment', recU.recommendation && recU.recommendation.specificity);
}

// ---------- Case2：新 Profile 无历史，用环境分 ----------
console.log('\n[Case2] 新 Profile 无历史 → 按环境质量（integrity+proxy），不因缺历史被罚');
clean();
{
  analyzer.applyDimensions('pp_c', { fingerprint: 92, network: 90, storage: 95, taskSuccess: 50, stability: 70 }, { name: 'FreshGood' });
  analyzer.applyDimensions('pp_d', { fingerprint: 40, network: 40, storage: 40, taskSuccess: 50, stability: 70 }, { name: 'FreshBad' });
  const rec = advisor.recommend({ site: 'new-site.com' });
  ok(rec.matched && rec.recommendation.profileId === 'pp_c', '无历史站点 → 环境更好的 C 胜出', 'chosen=' + (rec.recommendation && rec.recommendation.profileId));
  ok(rec.recommendation.specificity === 'environment', '依据 environment');
  ok(rec.recommendation.confidence <= 0.25, '无历史 → 置信度低（不夸大）', 'conf=' + rec.recommendation.confidence);
}

// ---------- Case3：Profile 恶化降权 ----------
console.log('\n[Case3] Profile 恶化（近期成功率暴跌）→ 降权，Healthy 胜出');
clean();
{
  // E：长期健康（30 成 0 败）
  analyzer.applyDimensions('pp_e', { fingerprint: 85, network: 85, storage: 85, taskSuccess: 85, stability: 85 }, { name: 'Healthy' });
  for (let i = 0; i < 30; i++) analyzer.recordTaskOutcome('pp_e', 'shop.com', true);
  // F：曾健康（20 成），但近期连续失败 → 恶化
  analyzer.applyDimensions('pp_f', { fingerprint: 85, network: 85, storage: 85, taskSuccess: 85, stability: 85 }, { name: 'Degraded' });
  for (let i = 0; i < 20; i++) analyzer.recordTaskOutcome('pp_f', 'shop.com', true);
  for (let i = 0; i < 10; i++) analyzer.recordTaskOutcome('pp_f', 'shop.com', false); // 近期窗口被失败填满

  const f = analyzer.getRecord('pp_f');
  ok((analyzer.siteScoreValue(f, 'shop.com') || 0) < (analyzer.siteScoreValue(analyzer.getRecord('pp_e'), 'shop.com') || 0),
    'F 的 shop 评分显著低于 E（恶化降权）', 'F.shop=' + analyzer.siteScoreValue(f, 'shop.com') + ' E.shop=' + analyzer.siteScoreValue(analyzer.getRecord('pp_e'), 'shop.com'));
  ok(f.status === 'WARNING' || f.status === 'DEGRADED', 'F 生命周期降级（不删除）', 'status=' + f.status);

  const rec = advisor.recommend({ site: 'shop.com' });
  ok(rec.matched && rec.recommendation.profileId === 'pp_e', 'shop 目标 → 仍选健康的 E，而非恶化的 F', 'chosen=' + (rec.recommendation && rec.recommendation.profileId));
}

// ---------- Case4：跨站隔离 ----------
console.log('\n[Case4] 跨站隔离：stripe 成功环境不自动推荐到 notion');
clean();
{
  analyzer.applyDimensions('pp_g', { fingerprint: 88, network: 88, storage: 88, taskSuccess: 88, stability: 88 }, { name: 'StripePro' });
  for (let i = 0; i < 12; i++) analyzer.recordTaskOutcome('pp_g', 'stripe.com', true); // 仅 stripe 历史
  analyzer.applyDimensions('pp_h', { fingerprint: 88, network: 88, storage: 88, taskSuccess: 88, stability: 88 }, { name: 'NotionPro' });
  for (let i = 0; i < 12; i++) analyzer.recordTaskOutcome('pp_h', 'notion.so', true);   // 仅 notion 历史

  const recNotion = advisor.recommend({ site: 'notion.so' });
  ok(recNotion.matched && recNotion.recommendation.profileId === 'pp_h', 'notion 目标 → 选有 notion 历史的 H（非 stripe 强的 G）', 'chosen=' + (recNotion.recommendation && recNotion.recommendation.profileId));
  ok(recNotion.recommendation.profileId !== 'pp_g', 'G 的 stripe 成绩不泄漏到 notion');

  const recStripe = advisor.recommend({ site: 'stripe.com' });
  ok(recStripe.matched && recStripe.recommendation.profileId === 'pp_g', 'stripe 目标 → 选有 stripe 历史的 G');
}

// ---------- 地区偏好 + DISABLED 跳过 ----------
console.log('\n[region + lifecycle] 地区匹配加分；DISABLED 被跳过');
clean();
{
  analyzer.ensure('pp_p', { name: 'US-Env', region: 'US' });
  analyzer.ensure('pp_q', { name: 'HK-Env', region: 'HK' });
  // 两者都无目标站历史 → 环境分相近，地区决定
  const recUS = advisor.recommend({ site: 'region-test.com', region: 'US' });
  ok(recUS.matched && recUS.recommendation.profileId === 'pp_p', 'region=US → 选 US 环境', 'chosen=' + (recUS.recommendation && recUS.recommendation.profileId));
  const recHK = advisor.recommend({ site: 'region-test.com', region: 'HK' });
  ok(recHK.matched && recHK.recommendation.profileId === 'pp_q', 'region=HK → 选 HK 环境');

  // DISABLED 跳过
  analyzer.setStatus('pp_q', 'DISABLED');
  const recAfter = advisor.recommend({ site: 'region-test.com', region: 'HK' });
  ok(recAfter.matched && recAfter.recommendation.profileId === 'pp_p', 'HK 环境被 DISABLED → 退回 US 环境（仍可用）', 'chosen=' + (recAfter.recommendation && recAfter.recommendation.profileId));
  analyzer.setStatus('pp_q', 'ACTIVE');
}

// ---------- 评分公式自洽 ----------
console.log('\n[scoring] 公式自洽');
{
  const s = scoring.computeScore({ fingerprint: 92, network: 88, siteSuccess: 81, stability: 90, freshness: 1 });
  ok(s > 80 && s <= 92, '综合分落在合理区间（≈86，符合设计示例）', 'score=' + s);
  // 样本成熟度：样本越少 siteScore 越低（不夸大）
  const lo = scoring.siteScoreFromStats({ success: 1, failed: 0, recent: [true], freshness: 1 });
  const hi = scoring.siteScoreFromStats({ success: 20, failed: 0, recent: [true], freshness: 1 });
  ok(hi > lo, '样本越多站点评分越高（成熟度）', `lo=${lo} hi=${hi}`);
  ok(scoring.siteConfidence(0) < scoring.siteConfidence(10), '样本置信度随样本单调增');
}

// ---------- 清理测试数据 ----------
clean();

console.log('\n=== Phase 3.4 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail ? 1 : 0);
