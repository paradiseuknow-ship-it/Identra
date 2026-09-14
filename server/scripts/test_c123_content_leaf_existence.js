'use strict';
// C123 守护：存在性索引（observation.contentLeaves）与 element_present/element_absent 的对称性。
//
// 守护的缺陷（A 类真实缺陷，P1 六例根因）：
//   elements[] 是 semanticResolver 的**唯一**候选池，而 observation.js 刻意不收
//   div/span/p（容量取舍：数量大、挤爆 80 上限、稀释排序）。该取舍的理由是
//   「文本已由 textSummary 覆盖，text_present 验证不受影响」—— 只覆盖了 text_present：
//   element_present 同为 elements[] 的消费者却被一起牺牲 ⇒ 页面上真实存在的展示性条目
//   （榜单项 <span class="name">戴尔 U2723QE…</span>）恒判「未找到元素」⇒ 4 次验证全败
//   ⇒ HEALING ⇒ 重试耗尽 ⇒ HUMAN_ESCALATION。
//
// 修复：另建 contentLeaves 存在性索引（叶子/直接文本 + 带身份 + ≤120 字符 + 全页 ≤40 条），
//   **不进 elements[]**（动作目标候选池语义与排序不变），element_present 与 element_absent
//   共用同一个 matchContentLeaf 回落。
//
// 用法：node server/scripts/test_c123_content_leaf_existence.js
//   真实 Chromium + 本地 http server 提供 mock-site fixture（与 test_c105_m3_realweb_matrix 同范式）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
// C94 整类纪律：test_*.js 禁止「让 OS 分配动态端口」的裸监听（动态端口可能落在
// Chrome unsafe-port 黑名单 ⇒ page.goto ERR_UNSAFE_PORT 假红），必须消费共享安全端口原语。
// ⚠ 注释内不得写出被禁模式的字面量：c94 的 P3a 是纯文本扫描，会把它当成违规（本套件曾因此假红）。
const { listenSafe } = require('./lib_safe_port');

const ROOT = path.join(__dirname, '..', '..');
const MOCK = path.join(ROOT, 'mock-site');
const observation = require(path.join(ROOT, 'server/agent/observation'));
const verification = require(path.join(ROOT, 'server/agent/verification'));
const semanticResolver = require(path.join(ROOT, 'server/agent/semanticResolver'));

let pass = 0; const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fails.push(name + (detail ? ' | ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' | ' + detail : '')); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain', '.json': 'application/json' };
function serve() {
  const s = http.createServer((rq, rs) => {
    const p = path.join(MOCK, decodeURIComponent(rq.url.split('?')[0]));
    if (!p.startsWith(MOCK) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rs.writeHead(404); return rs.end('nf'); }
    rs.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    rs.end(fs.readFileSync(p));
  });
  return listenSafe(s, '127.0.0.1');
}

(async () => {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const gather = async (fx) => {
    await page.goto('http://127.0.0.1:' + port + '/' + fx, { waitUntil: 'load' });
    const r = await observation.inspect(page);
    assert(r && r.ok, 'inspect failed: ' + JSON.stringify(r && r.error));
    return r.observation;
  };

  console.log('=== A 组：P1 实证目标在真实 DOM 上的存在性判定 ===');
  const list = await gather('scraping/list.html');
  ok((list.contentLeaves || []).length > 0, 'A1 list.html 采集到存在性索引', 'leaves=' + (list.contentLeaves || []).length);
  for (const [i, ex] of ['戴尔 U2723QE', '三星 S27A800', '小米 27寸 4K 显示器'].entries()) {
    const v = verification.verify({ type: 'element_present', expect: ex }, list, null);
    ok(v.success === true, 'A2.' + (i + 1) + ' element_present 命中真实条目 "' + ex + '"', JSON.stringify(v.evidence).slice(0, 90));
  }
  const cart = await gather('ecommerce/search.html');
  ok(verification.verify({ type: 'element_present', expect: '购物车' }, cart, null).success === true,
    'A3 element_present 命中「含内联子元素」的文本容器（购物车：<b>0</b> 件）');

  console.log('=== B 组：判别力（不得退化成「整页有这个词就算命中」）===');
  for (const [i, ex] of ['不存在的商品XYZ', '任天堂 Switch OLED', '¥99999'].entries()) {
    const v = verification.verify({ type: 'element_present', expect: ex }, list, null);
    ok(v.success === false, 'B1.' + (i + 1) + ' 页面上没有的目标必须判 false "' + ex + '"');
  }
  const dl = await gather('download.html');
  ok(verification.verify({ type: 'element_present', expect: '戴尔 U2723QE' }, dl, null).success === false,
    'B2 跨页面不得误命中（download.html 上没有榜单条目）');

  console.log('=== C 组：不破坏既有路径（elements 池语义零变化）===');
  ok((list.elements || []).length === 0, 'C1 list.html 的 elements[] 仍为空（展示性元素未被塞进动作候选池）', 'elements=' + (list.elements || []).length);
  const before = semanticResolver.resolve('搜索', cart).length;
  ok(before >= 1, 'C2 search.html 的交互元素仍可从 elements[] 解析', 'n=' + before);
  ok(semanticResolver.resolve('购物车', cart).length === 0, 'C3 存在性索引不参与动作目标解析（cartbar 不得变成可点击目标）');
  ok(typeof list.textSummary === 'string' && list.textSummary.length > 0, 'C4 textSummary 未受影响');

  console.log('=== D 组：present / absent 对称性（L6：不得留第二份同义实现）===');
  const p1 = verification.verify({ type: 'element_present', expect: '戴尔 U2723QE' }, list, null);
  const a1 = verification.verify({ type: 'element_absent', expect: '戴尔 U2723QE' }, list, null);
  ok(p1.success === true && a1.success === false, 'D1 存在的目标：present=true 且 absent=false（不得矛盾）',
    'present=' + p1.success + ' absent=' + a1.success);
  const p2 = verification.verify({ type: 'element_present', expect: '不存在的商品XYZ' }, list, null);
  const a2 = verification.verify({ type: 'element_absent', expect: '不存在的商品XYZ' }, list, null);
  ok(p2.success === false && a2.success === true, 'D2 不存在的目标：present=false 且 absent=true（不得矛盾）',
    'present=' + p2.success + ' absent=' + a2.success);

  console.log('=== E 组：静态契约（事实源锚点）===');
  const vsrc = fs.readFileSync(path.join(ROOT, 'server/agent/verification.js'), 'utf8');
  const osrc = fs.readFileSync(path.join(ROOT, 'server/agent/observation.js'), 'utf8');
  const csrc = fs.readFileSync(path.join(ROOT, 'server/agent/contextBuilder.js'), 'utf8');
  // 统计**调用点**：函数定义那一行必须剔除，否则恒定多算 1（守护首版即踩此计数错误）。
  const callSites = vsrc.split('\n').filter((l) => !/function matchContentLeaf/.test(l)).join('\n');
  const nPresent = (callSites.match(/matchContentLeaf\(after, expect\)/g) || []).length;
  ok(nPresent === 2, 'E1 present 与 absent 共用同一 matchContentLeaf 回落（各一次调用，共 2 处）', 'n=' + nPresent);
  // C124 锚点上移（不降标准）：实现从 verification.js 下沉为全仓唯一共用原语 existence.js，
  // verification.js 与 verificationIntelligence.js 只能委托调用 —— 两个消费层各留一份
  // 正是本批修掉的 L6 不对称，故此处从「本文件内的唯一函数」加严为「全仓唯一 + 两处委托」。
  const xsrc = fs.readFileSync(path.join(ROOT, 'server/agent/existence.js'), 'utf8');
  const isrc2 = fs.readFileSync(path.join(ROOT, 'server/agent/verification/verificationIntelligence.js'), 'utf8');
  ok((xsrc.match(/function matchContentLeaf\(/g) || []).length === 1,
    'E2 回落实现在全仓唯一（existence.js 定义且仅定义一次）');
  ok(!/function matchContentLeaf\(/.test(vsrc) && /require\('\.\/existence'\)/.test(vsrc),
    'E2b verification.js 只委托、不再自带实现');
  ok(!/function matchContentLeaf\(/.test(isrc2) && /require\('\.\.\/existence'\)/.test(isrc2),
    'E2c verificationIntelligence.js 只委托、不再自带实现');
  ok(/out\.contentLeaves = leaves;/.test(osrc), 'E3 observation 采集产出 contentLeaves');
  ok(/contentLeaves: \(data\.contentLeaves \|\| \[\]\)\.slice\(0, 40\)/.test(osrc), 'E4 inspect 侧限量 40（容量受控）');
  ok(/MAX_LEAVES = 40/.test(osrc), 'E5 页面内采集限量 40');
  ok(!/contentLeaves/.test(csrc), 'E6 contentLeaves 不进 contextBuilder（零 LLM token 成本）');

  console.log('=== F 组：防空断言（探针自身的有效性）===');
  // 存在性索引为空（旧行为）时，A2 必须失败 —— 否则本套件没咬住目标。
  const stripped = Object.assign({}, list, { contentLeaves: [] });
  ok(verification.verify({ type: 'element_present', expect: '戴尔 U2723QE' }, stripped, null).success === false,
    'F1 抽掉 contentLeaves 后 A2 立即转红（断言确实咬住存在性索引，而非别的通道）');
  // 但 elements 池命中（download.html 的 <a>）不依赖索引 —— 证明没有为了修 A2 而架空原通道。
  ok(verification.verify({ type: 'element_present', expect: '下载示例文件' }, Object.assign({}, dl, { contentLeaves: [] }), null).success === true,
    'F2 原 elements 池通道仍独立有效（抽掉索引也不受影响）');

  await browser.close();
  server.close();

  console.log('');
  console.log('C123 GUARD: PASS=' + pass + ' FAIL=' + fails.length);
  if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('SUITE ERROR', e && e.stack ? e.stack.slice(0, 600) : e); process.exit(1); });
