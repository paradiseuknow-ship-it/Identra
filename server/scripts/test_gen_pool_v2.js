'use strict';
// test_gen_pool_v2.js —— genPhase12PoolV2.js 产物与行为测试。
// 断言对象：真实写盘的 phase12_pool_v2.json / real-world-v2/、生成器进程行为（fail-fast / 确定性）、
// 冻结产物零触碰（phase12_pool.json + real-world/ 指纹不变）。
// 运行：node server/scripts/test_gen_pool_v2.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POOL_V2 = path.join(ROOT, 'phase12_pool_v2.json');
const POOL_V1 = path.join(ROOT, 'phase12_pool.json');
const V2_DIR = path.join(ROOT, 'server', 'scenarios', 'real-world-v2');
const V1_DIR = path.join(ROOT, 'server', 'scenarios', 'real-world');
const GEN = path.join(__dirname, 'genPhase12PoolV2.js');
const lint = require('./pool_alignment_lint');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function sha(data) { return crypto.createHash('sha256').update(data, 'utf8').digest('hex'); }
function dirHash(dir) {
  const files = fs.readdirSync(dir).filter((f) => f !== 'index.json').sort();
  return sha(files.map((f) => f + ':' + sha(fs.readFileSync(path.join(dir, f), 'utf8'))).join('|'));
}

// ── 0. 冻结产物指纹（测试开始前）──
const v1PoolHash0 = sha(fs.readFileSync(POOL_V1, 'utf8'));
const v1DirHash0 = dirHash(V1_DIR);
const v2DirHash0 = dirHash(V2_DIR);

// ── 1. 池快照结构与 lint 零错配 ──
const pool = JSON.parse(fs.readFileSync(POOL_V2, 'utf8'));
ok(pool._meta && pool._meta.frozen === true && pool._meta.generator === 'genPhase12PoolV2.js', '_meta: frozen + generator 溯源');
ok(pool._meta.alignmentLint && pool._meta.alignmentLint.mismatch === 0, '_meta.alignmentLint.mismatch = 0');
ok(pool.tasks.length === 100, 'v2 池 100 任务');
ok(sha(JSON.stringify(pool.tasks)) === pool._meta.sha256, '_meta.sha256 与 tasks 内容一致（可复核）');
const lintRes = lint.lintPool(pool.tasks);
ok(lintRes.mismatch.length === 0, '共享 lint（audit v2 等价逻辑）对 v2 池零错配');

// ── 2. 分布与凭据契约 ──
const byCat = {}; pool.tasks.forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + 1; });
ok(byCat.saas === 30 && byCat.ecommerce === 25 && byCat.data_entry === 20 && byCat.longflow === 25, '类别分布 30/25/20/25');
const req = pool.tasks.filter((t) => t.credentialRequirement === 'required');
const none = pool.tasks.filter((t) => t.credentialRequirement === 'none');
ok(req.length === 30 && req.every((t) => t.credentialRef === 'saas_demo'), 'required 30 个且全部 saas_demo（none+login 结构性缺陷修复）');
ok(req.every((t) => t.fixture === 'saas/login.html'), 'required 全部落在登录 fixture（契约与 fixture 一致）');
ok(none.length === 70 && none.every((t) => !t.credentialRef), 'none 70 个且无 credentialRef');
ok(none.filter((t) => t.fixture === 'saas/login.html').every((t) => !/看板|导出|活跃用户/.test(t.objective)), '登录 fixture 的 none 任务 objective 不含登录后实体');

// ── 3. 池内无明文凭据 ──
const poolRaw = fs.readFileSync(POOL_V2, 'utf8');
ok(!poolRaw.includes('Saas#2024') && !poolRaw.includes('ops@cloudsaas.io'), 'v2 池快照无明文凭据（与 v1 池口径一致）');
ok(!pool.tasks.some((t) => 'credentialValue' in t), '池任务不含 credentialValue 键');

// ── 4. 引号词接地（测试内独立复核，不依赖生成器自检）──
const FIXTURES = {};
for (const f of ['saas/login.html', 'scraping/list.html', 'ecommerce/search.html', 'ecommerce/search_lazy.html', 'data_entry/form.html', 'download.html']) {
  FIXTURES[f] = fs.readFileSync(path.join(ROOT, 'mock-site', f), 'utf8');
}
let ungrounded = 0;
for (const t of pool.tasks) {
  const txt = FIXTURES[t.fixture];
  for (const m of t.objective.matchAll(/[「]([^」]+)[」]/g)) {
    const term = m[1];
    const grounded = txt.includes(term) || t.fixture === 'ecommerce/search_lazy.html'
      || (t.objective.includes('未找到相关商品') && txt.includes('未找到相关商品'));
    if (!grounded) ungrounded++;
  }
}
ok(ungrounded === 0, '引号词接地复核：所有「X」有 fixture 文本/回显机制/确定性空结果依据');

// ── 5. 场景文件形态（harness 播种输入）──
const scenIds = fs.readdirSync(V2_DIR).filter((f) => f !== 'index.json').map((f) => f.replace('.json', '')).sort();
ok(scenIds.length === 100 && scenIds[0] === 'rw.001' && scenIds[scenIds.length - 1] === 'rw.100', '场景文件 rw.001..rw.100 全量');
let scenBad = 0;
for (const t of pool.tasks) {
  const s = JSON.parse(fs.readFileSync(path.join(V2_DIR, t.taskId + '.json'), 'utf8'));
  if (t.credentialRequirement === 'required' && !s.credentialValue) scenBad++;
  if (t.credentialRequirement === 'none' && s.credentialValue) scenBad++;
  if (s.objective !== t.objective || s.fixture !== t.fixture) scenBad++;
}
ok(scenBad === 0, '场景文件与池任务一一对应（required 含 credentialValue / none 不含 / objective 一致）');
const idx = JSON.parse(fs.readFileSync(path.join(V2_DIR, 'index.json'), 'utf8'));
ok(idx.count === 100 && idx.alignmentLint.mismatch === 0, 'index.json count=100 且 lint 零错配');

// ── 6. 确定性重生成（同输入逐字节同产物）──
execFileSync(process.execPath, [GEN], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
ok(dirHash(V2_DIR) === v2DirHash0, '重生成后场景目录逐字节不变（确定性）');
const poolRe = JSON.parse(fs.readFileSync(POOL_V2, 'utf8'));
ok(JSON.stringify(poolRe.tasks) === JSON.stringify(pool.tasks), '重生成后池 tasks 内容不变（_meta.generatedAt 除外）');

// ── 7. 冻结产物零触碰 ──
ok(sha(fs.readFileSync(POOL_V1, 'utf8')) === v1PoolHash0, 'v1 冻结池 phase12_pool.json 指纹不变');
ok(dirHash(V1_DIR) === v1DirHash0, 'v1 场景目录 real-world/ 指纹不变');

// ── 8. fail-fast 负向注入：错配 objective → exit 2 且不写任何产物 ──
const tmpGen = path.join(__dirname, 'tmp_gen_inject_bad.js');
const src = fs.readFileSync(GEN, 'utf8');
const inject = "add({ category: 'saas', name: '注入', objective: '登录后进入项目列表', fixture: SAAS, difficulty: 'easy', expectedVerification: VER('element_present', 'x') });\n// ── B. 电商 25 ──";
fs.writeFileSync(tmpGen, src.replace('// ── B. 电商 25 ──', inject), 'utf8');
let exitCode = 0, stderr = '';
try { execFileSync(process.execPath, [tmpGen], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { exitCode = e.status; stderr = String(e.stderr || ''); }
ok(exitCode === 2, '注入错配任务 → 生成器 exit 2（fail-fast）');
ok(stderr.includes('[lint]') && stderr.includes('项目'), '失败输出含 lint 命中明细');
ok(dirHash(V2_DIR) === v2DirHash0, '失败运行后场景目录未被写入');
ok(sha(fs.readFileSync(POOL_V1, 'utf8')) === v1PoolHash0, '失败运行后 v1 冻结池仍不变');
try { fs.unlinkSync(tmpGen); } catch (e) {}

console.log('test_gen_pool_v2: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
