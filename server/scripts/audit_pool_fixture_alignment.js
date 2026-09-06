'use strict';
// 池任务 objective ↔ fixture 内容对齐审计 v2（B3，只读，不参与回归套件）。
// 背景：dl240 基线 ESC 30% 曾被假设为 C 类「列表渲染/lazy 验证契约」，
// 取证发现主根因是 genRealWorldScenarios.js 生成时 objective 模板与 fixture 内容从未对齐（B 类池生成缺陷）。
//
// v2 增强（2026-09-01 B3）：
//   1) 词典扩容（编辑/设置/个人资料/显示名/价格更新/语言/时区/密钥/去重/会员 等 B2 仲裁中新发现的缺口词）
//   2) 同义词组（objective「仪表盘」↔ fixture「数据看板」不误报）
//   3) 语义规则降级：
//      - searchOnly：objective 仅要求搜索某商品（无 打开/查看/确认/编辑/进入/详情 后续）→ 空结果可执行，单列不判错配
//      - memberForm：objective 要求注册/录入会员 且 fixture 为注册表单（含 注册+成功 反馈）→ 可行
//   4) fixture 能力矩阵（ids/forms/buttons/entities）+ JSON 输出（--json <path>）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'phase12_pool.json'), 'utf8'));

// objective 资源名词 → 需在 fixture 中出现的对应文本（宁缺勿滥：只收录明确指向页面实体的词）
const NOUNS = [
  '订单', '报表', '成员', '管理员', '日志', '收货人', '库存', '结算', '地址',
  '购物车', '加入购物车', '详情', '支付', '发货', '签收', '退款', '待付款',
  '导出', '下载', '翻页', '筛选', '项目', '任务', '头像', '邀请', '通知', '账单', '看板',
  '戴尔 U2723QE', '机械键盘', '无线鼠标', '显示器', '平板', 'USB 网卡',
  // ---- v2 新增（B2 逐任务仲裁驱动）----
  '编辑', '个人资料', '显示名', '语言', '时区', 'API 密钥', '去重', '会员',
];
// 编辑页/更新价格 等动宾结构由动词规则覆盖（fixture 无编辑能力时 objective 含 编辑/更新 即命中）

// 同义词组：objective 中命中组内任一词，fixture 命中组内任一词即视为对齐
const SYNONYM_GROUPS = [
  ['仪表盘', '数据看板', '看板'],
];

function fixtureRawText(rel) {
  const p = path.join(ROOT, 'mock-site', rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

// searchOnly 规则：objective 仅要求搜索（允许「输入X并(点击)搜索」「搜索X」句式），
// 无任何对结果的实体性要求（打开/查看/确认/进入/详情/编辑/加购/结算/出现 等）→ 空结果可执行
const RESULT_VERBS = ['打开', '查看', '确认', '进入', '详情', '编辑', '加购', '加入购物车', '结算', '出现', '更新', '修改', '改为', '设置', '配置', '提交', '筛选', '翻页', '导出', '上传', '支付', '删除', '邀请', '创建', '新建', '标记'];
function isSearchOnly(objective) {
  if (!/搜索|输入/.test(objective)) return false;
  const quoted = objective.match(/[「']([^」']+)[」']/g) || [];
  if (!quoted.length) return false;
  // 除引号词与搜索动词外不得出现结果性动词
  const stripped = quoted.reduce((s, q) => s.replace(q, ' '), objective).replace(/搜索|输入|点击|在|后|并|的|框/g, '');
  return !RESULT_VERBS.some((v) => stripped.includes(v));
}

// 设置页实体规则：「打开设置页/进入设置/在设置中/设置项」指向设置区实体（「设置」作动词不算），
// fixture 须含「设置」字样
const SETTINGS_PAGE_RE = /设置页|打开设置|进入设置|在设置中|设置项/;
// 搜索能力检查：searchOnly 降级要求 fixture 真有搜索能力（含「搜索」标识），否则仍判错配
// （rw.015 教训：login.html 无搜索框，「站内搜索」不可执行）

// fixture 能力矩阵
function capabilityMatrix(rel) {
  const txt = fixtureRawText(rel);
  if (txt == null) return null;
  const ids = [...txt.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const forms = (txt.match(/<form/g) || []).length;
  const buttons = [...txt.matchAll(/<button[^>]*>([^<]{0,30})/g)].map((m) => m[1].trim()).filter(Boolean);
  const inputs = [...txt.matchAll(/<input[^>]*type="([^"]+)"/g)].map((m) => m[1]);
  const links = (txt.match(/<a\s/g) || []).length;
  const entities = ['机械键盘', '无线鼠标', '4K显示器', '戴尔 U2723QE', 'LG 27UP850'].filter((e) => txt.includes(e));
  return { ids: [...new Set(ids)], forms, buttons: [...new Set(buttons)], inputs: [...new Set(inputs)], links, entities };
}

const rows = [];
const searchOnlyPass = [];
for (const t of pool.tasks) {
  const txt = fixtureRawText(t.fixture);
  if (txt == null) { rows.push({ id: t.taskId, fixture: t.fixture, missing: ['<fixture 文件不存在>'], objective: t.objective }); continue; }
  const missing = [];
  for (const n of NOUNS) {
    if (t.objective.includes(n) && !txt.includes(n)) missing.push(n);
  }
  // 同义词组：objective 命中组内词且 fixture 命中组内任一词 → 从 missing 中豁免
  for (const grp of SYNONYM_GROUPS) {
    const objHit = grp.find((w) => t.objective.includes(w));
    if (objHit && grp.some((w) => txt.includes(w))) {
      const idx = missing.indexOf(objHit);
      if (idx >= 0) missing.splice(idx, 1);
    }
  }
  // id 契约类：objective 声称 id 改名时，核对 fixture 是否真有该 id
  const idm = t.objective.match(/id[ 已]*改为\s*[「']?(\w+)/);
  if (idm && !txt.includes('id="' + idm[1] + '"')) missing.push('id="' + idm[1] + '"(objective 声称但 fixture 无)');
  // 设置页实体规则
  if (SETTINGS_PAGE_RE.test(t.objective) && !txt.includes('设置')) missing.push('设置区(objective 指向设置页/设置项，fixture 无)');
  if (missing.length) {
    // searchOnly 降级：唯一缺失是商品/内容词且 objective 无结果性要求，且 fixture 真有搜索能力 → 可执行（空结果）
    if (isSearchOnly(t.objective) && txt.includes('搜索')) { searchOnlyPass.push({ id: t.taskId, missing, objective: t.objective, fixture: t.fixture }); continue; }
    rows.push({ id: t.taskId, fixture: t.fixture, missing, objective: t.objective });
  }
}

console.log('池任务总数:', pool.tasks.length);
console.log('错配任务数(v2 词典+规则后):', rows.length);
const byFixture = {};
for (const r of rows) (byFixture[r.fixture] = byFixture[r.fixture] || []).push(r.id);
for (const [f, ids] of Object.entries(byFixture)) console.log('  ', f, '->', ids.length, ':', ids.join(','));
console.log('\nsearchOnly 可执行单列(不计错配):', searchOnlyPass.length, searchOnlyPass.map((s) => s.id).join(','));
console.log('\n错配明细:');
for (const r of rows) console.log(r.id, '|', r.objective, '| 缺:', r.missing.join('/'));
console.log('\nfixture 能力矩阵:');
const fixturesUsed = [...new Set(pool.tasks.map((t) => t.fixture))];
for (const f of fixturesUsed) console.log(' ', f, JSON.stringify(capabilityMatrix(f)));

// JSON 输出（供 B2 报告/分析器引用）
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) {
  const out = {
    generatedAt: new Date().toISOString(),
    mismatch: rows,
    searchOnlyPass,
    capabilityMatrix: Object.fromEntries(fixturesUsed.map((f) => [f, capabilityMatrix(f)])),
  };
  fs.writeFileSync(path.resolve(process.argv[jsonIdx + 1]), JSON.stringify(out, null, 2));
  console.log('\nJSON 已写出:', path.resolve(process.argv[jsonIdx + 1]));
}
