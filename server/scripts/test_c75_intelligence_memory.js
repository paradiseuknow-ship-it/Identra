#!/usr/bin/env node
// C75 —— intelligence/ 子目录深扫守护（agent 子模块扫描第 5 批）：
//   D1 (B)：elementMemory.getRecord 无 context 分支用 indexOf(base)===0 前缀匹配 ——
//     semantic 'search' 命中 'searchbox'/'searchbar' 等更长语义的记忆（key 无分隔符边界检查），
//     跨语义污染候选池。修复：要求 key 相等或以 base+'|' 开头。
//   D2 (B)：三个 importPack 不校验记录 site 与 pack.site 一致 —— 经验包内 site 字段可被
//     篡改，跨站隔离红线被导入写入侧旁路。修复：不一致记录 skipped（不静默改写）。
//   D3 (B)：flowMemory.importPack 的 profileScores 分支 ensure(p.profileId) 会为不存在的
//     profile 凭空创建幽灵评分记录（NEUTRAL_DIMS 初值），Profile Advisor 随后可能把任务
//     导向根本不存在的环境。修复：仅导入既有 profile 的站点分。
//   D4 (C)：siteMemory.recordTaskResult total>=3 即 medium —— 100% 成功站点也标 medium；
//     修复：补 low 档（panel RISK 已预留 low 配色）。
//   D5 (C)：decisionCache 内存 Map 无上限（key 含用户自由文本 objective，长跑泄漏）。
//     修复：MAX_ENTRIES=500 FIFO 裁剪。
// 零浏览器。FPB_DATA_DIR tmp 隔离。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + ': ' + detail); console.log('  FAIL ' + name + ' — ' + detail); }
}

function runInChild(fnName, script) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c75-data-'));
  const tmpJS = path.join(os.tmpdir(), 'c75-' + fnName + '-' + Date.now() + '.js');
  fs.writeFileSync(tmpJS, script, 'utf8');
  const r = spawnSync(process.execPath, [tmpJS], {
    env: Object.assign({}, process.env, { FPB_DATA_DIR: dataDir }),
    encoding: 'utf8',
    timeout: 60000,
  });
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpJS, { force: true }); } catch (e) {}
  return r;
}

const INTEL = here.replace(/\\/g, '/') + '/../agent/intelligence';

// ---- P1 (D1): getRecord 语义前缀碰撞 ----
{
  const script = `
'use strict';
const store = require('${here.replace(/\\/g, '/')}/../agent/store');
const em = require('${INTEL}/elementMemory');
const out = { ok: true, error: null };
try {
  // 两条记忆：semantic='search'（target 输入框）与 semantic='searchbox'（更长安 went 语义）
  em.recordSuccess('shop.example', 'searchbox', { text: 'Search products', tag: 'input', role: 'searchbox' }, { type: 'ai_success' });
  em.recordSuccess('shop.example', 'search', { text: 'Search', tag: 'input', role: 'searchbox' }, { type: 'ai_success' });

  // 修复前：getRecord('search') 的前缀分支会把 searchbox 记录也算进候选（indexOf('shop.example|search')===0）
  const rSearch = em.getRecord('shop.example', 'search', null);
  const rBox = em.getRecord('shop.example', 'searchbox', null);
  if (!rSearch || !rBox) throw new Error('两条记录都应可读');
  if (rSearch.id === rBox.id) {
    throw new Error('semantic=search 命中了 searchbox 的记录（前缀碰撞，跨语义污染）: ' + rSearch.key);
  }
  if (rSearch.semantic !== 'search') throw new Error('search 查询返回了错误语义: ' + rSearch.semantic);

  // 反向：'searchbox' 不受影响
  if (rBox.semantic !== 'searchbox') throw new Error('searchbox 查询回归');

  // 带分隔符后缀的真 context key 仍可被无 context 查询读到（不回归既有能力）
  em.recordSuccess('shop.example', 'search', { text: 'Search', tag: 'input', role: 'searchbox' }, { type: 'ai_success' },
    { urlPattern: '/results', previousActions: ['navigate'] });
  const rCtx = em.getRecord('shop.example', 'search', null);
  if (!rCtx || rCtx.semantic !== 'search') throw new Error('context 专属记录经无 context 查询应可读');

  out.p1 = 'prefix collision fixed: search != searchbox; context-bearing keys still readable';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
console.log('CHILD_RESULT ' + JSON.stringify(out));
`;
  const r = runInChild('p1', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P1.elementMemory-semantic-prefix-collision', j.ok && !!j.p1, j.error || j.p1 || 'child failed');
}

// ---- P2 (D2): importPack site 不一致拒绝 ----
{
  const script = `
'use strict';
const store = require('${here.replace(/\\/g, '/')}/../agent/store');
const em = require('${INTEL}/elementMemory');
const fm = require('${INTEL}/flowMemory');
const out = { ok: true, error: null };
try {
  const evil = 'evil.example';
  // P2a elementMemory.importPack：包内记录 site 被篡改 → 必须拒绝（跨站隔离写入侧）
  const legit = em.recordSuccess('good.example', 'login', { text: 'Login', tag: 'button', role: 'button' }, { type: 'ai_success' });
  const pack = em.exportPack('good.example').pack;
  pack.elementMemory = pack.elementMemory.map((r) => Object.assign({}, r, { id: r.id + '_x', site: evil }));
  const r1 = em.importPack({ pack });
  if (r1.imported !== 0) throw new Error('篡改 site 的 element 记录应被拒绝，实际导入 ' + r1.imported);
  if (!store.findWhere('aiElementMemory', (x) => x.site === evil).length === false) {
    throw new Error('evil site 记录不应落库');
  }
  if (store.findWhere('aiElementMemory', (x) => x.site === evil).length) throw new Error('evil site 记录已落库（隔离被旁路）');

  // P2b flowMemory.importPack：flow 记录 site 篡改同样拒绝
  const legitFlow = fm.recordFlow('good.example', '登录并查看报表', [
    { id: 's1', name: 'open', type: 'START', next: 'DONE', verification: { type: 'page_change' } },
  ]);
  if (!legitFlow.ok) throw new Error('recordFlow 失败: ' + legitFlow.error);
  const fpack = fm.exportPack('good.example').pack;
  fpack.flowMemory = fpack.flowMemory.map((r) => Object.assign({}, r, { id: r.id + '_y', site: evil }));
  const r2 = fm.importPack({ pack: fpack });
  if (r2.imported !== 0) throw new Error('篡改 site 的 flow 记录应被拒绝，实际导入 ' + r2.imported);
  if (store.findWhere('aiFlowMemory', (x) => x.site === evil).length) throw new Error('evil site flow 已落库');

  // P2c site 一致的合法记录仍可导入（不回归）
  const fpack2 = fm.exportPack('good.example').pack;
  fpack2.flowMemory = fpack2.flowMemory.map((r) => Object.assign({}, r, { id: r.id + '_z' }));
  const r3 = fm.importPack({ pack: fpack2 });
  if (r3.imported < 1) throw new Error('合法同站记录导入回归: ' + JSON.stringify(r3));

  out.p2 = 'importPack cross-site injection blocked (element+flow); legit same-site import intact';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
console.log('CHILD_RESULT ' + JSON.stringify(out));
`;
  const r = runInChild('p2', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P2.importPack-cross-site-injection', j.ok && !!j.p2, j.error || j.p2 || 'child failed');
}

// ---- P3 (D3): 幽灵 profile 评分记录拒绝 ----
{
  const script = `
'use strict';
const fm = require('${INTEL}/flowMemory');
const pa = require('${INTEL}/profile/profileAnalyzer');
const out = { ok: true, error: null };
try {
  const fpack = {
    pack: {
      format: fm.PACK_FORMAT || 'ai-browser-operator@3.2',
      site: 'good.example',
      flowMemory: [], elementMemory: [], siteMemory: [], failureKnowledge: [],
      profileScores: [{ profileId: 'ghost_profile', name: 'ghost', siteScore: { score: 95, success: 9, failed: 1, samples: 10, recent: [], confidence: 1, updatedAt: Date.now() } }],
    },
  };
  const r = fm.importPack(fpack);
  if (r.imported !== 0) throw new Error('幽灵 profile 站点分应被拒绝，实际导入 ' + r.imported);
  if (pa.getRecord('ghost_profile')) throw new Error('幽灵评分记录已被创建（Advisor 可能推荐不存在的环境）');

  // 既有 profile 的站点分正常导入（不回归）
  pa.recordTaskOutcome('real_profile', 'other.example', true, { name: 'real' });
  const fpack2 = JSON.parse(JSON.stringify(fpack));
  fpack2.pack.profileScores = [{ profileId: 'real_profile', name: 'real', siteScore: { score: 80, success: 8, failed: 2, samples: 10, recent: [], confidence: 1, updatedAt: Date.now() } }];
  const r2 = fm.importPack(fpack2);
  if (r2.imported < 1) throw new Error('既有 profile 站点分导入回归');
  const rec = pa.getRecord('real_profile');
  if (!rec.siteScores['good.example']) throw new Error('good.example 站点分未写入 real_profile');

  out.p3 = 'ghost profile score rejected; existing profile site-score import intact';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
console.log('CHILD_RESULT ' + JSON.stringify(out));
`;
  const r = runInChild('p3', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P3.ghost-profile-score-rejected', j.ok && !!j.p3, j.error || j.p3 || 'child failed');
}

// ---- P4 (D4): riskLevel low 档 ----
{
  const script = `
'use strict';
const sm = require('${INTEL}/siteMemory');
const out = { ok: true, error: null };
try {
  sm.removeSite('a.example'); sm.removeSite('b.example'); sm.removeSite('c.example'); sm.removeSite('d.example');
  // 100% 成功 ×4 → low（旧实现 medium）
  for (let i = 0; i < 4; i++) sm.recordTaskResult('a.example', { ok: true });
  if (sm.getSite('a.example').riskLevel !== 'low') throw new Error('全成功站点应 low，实际 ' + sm.getSite('a.example').riskLevel);
  // 4 成功 1 失败（>=3 且 <100%）→ medium
  for (let i = 0; i < 4; i++) sm.recordTaskResult('b.example', { ok: true });
  sm.recordTaskResult('b.example', { ok: false });
  if (sm.getSite('b.example').riskLevel !== 'medium') throw new Error('有失败站点应 medium，实际 ' + sm.getSite('b.example').riskLevel);
  // 5 样本成功率 0.4 → high
  for (let i = 0; i < 2; i++) sm.recordTaskResult('c.example', { ok: true });
  for (let i = 0; i < 3; i++) sm.recordTaskResult('c.example', { ok: false });
  if (sm.getSite('c.example').riskLevel !== 'high') throw new Error('低成功站点应 high，实际 ' + sm.getSite('c.example').riskLevel);
  // 样本不足 → unknown
  sm.recordTaskResult('d.example', { ok: true });
  if (sm.getSite('d.example').riskLevel !== 'unknown') throw new Error('少样本应 unknown，实际 ' + sm.getSite('d.example').riskLevel);

  out.p4 = 'riskLevel: low/medium/high/unknown tiers correct';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
console.log('CHILD_RESULT ' + JSON.stringify(out));
`;
  const r = runInChild('p4', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P4.siteMemory-risklevel-tiers', j.ok && !!j.p4, j.error || j.p4 || 'child failed');
}

// ---- P5 (D5): decisionCache 上限裁剪 ----
{
  const script = `
'use strict';
const dc = require('${INTEL}/router/decisionCache');
const out = { ok: true, error: null };
try {
  dc.clear();
  for (let i = 0; i < 600; i++) dc.set('k' + i, { v: i });
  if (dc.size() > 500) throw new Error('缓存超上限: ' + dc.size());
  if (dc.get('k599') == null) throw new Error('最新条目不应被淘汰');
  if (dc.get('k0') != null) throw new Error('最旧条目应已被淘汰（FIFO）');
  // TTL 与 get 行为不回归
  dc.set('fresh', { ok: 1 });
  if (!dc.get('fresh')) throw new Error('正常读写回归');
  out.p5 = 'cache capped at 500, FIFO eviction, newest intact';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
console.log('CHILD_RESULT ' + JSON.stringify(out));
`;
  const r = runInChild('p5', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P5.decisionCache-size-cap', j.ok && !!j.p5, j.error || j.p5 || 'child failed');
}

console.log('RESULT pass=' + pass + ' fail=' + fail);
if (fail) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
