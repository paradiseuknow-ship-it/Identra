'use strict';
// 池任务 objective ↔ fixture 内容对齐 lint —— 共享模块（从 audit_pool_fixture_alignment.js v2 抽取）。
// 设计约束：与 audit v2 的逐任务判定逻辑逐字节等价（等价性由 test_pool_alignment_lint.js 对
// 冻结池 + audit --json 输出双重断言）。audit 脚本本身保持冻结不动；本模块供
// genPhase12PoolV2.js 做生成期 fail-fast 断言复用。
//
// 判定规则（与 audit v2 一致）：
//   1) NOUNS 词典：objective 含名词且 fixture 文本不含 → missing
//   2) SYNONYM_GROUPS 同义词组豁免（仪表盘↔数据看板↔看板）
//   3) id 契约：objective 声称 id 改名 → fixture 须真有该 id
//   4) SETTINGS_PAGE_RE 设置页实体规则
//   5) searchOnly 降级：纯搜索空结果可执行（fixture 须真有搜索能力）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// objective 资源名词 → 需在 fixture 中出现的对应文本（宁缺勿滥：只收录明确指向页面实体的词）
const NOUNS = [
  '订单', '报表', '成员', '管理员', '日志', '收货人', '库存', '结算', '地址',
  '购物车', '加入购物车', '详情', '支付', '发货', '签收', '退款', '待付款',
  '导出', '下载', '翻页', '筛选', '项目', '任务', '头像', '邀请', '通知', '账单', '看板',
  '戴尔 U2723QE', '机械键盘', '无线鼠标', '显示器', '平板', 'USB 网卡',
  // ---- v2 新增（B2 逐任务仲裁驱动）----
  '编辑', '个人资料', '显示名', '语言', '时区', 'API 密钥', '去重', '会员',
];

// 同义词组：objective 中命中组内任一词，fixture 命中组内任一词即视为对齐
const SYNONYM_GROUPS = [
  ['仪表盘', '数据看板', '看板'],
];

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

function fixtureRawText(rel, root) {
  const p = path.join(root || ROOT, 'mock-site', rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

// fixture 能力矩阵
function capabilityMatrix(rel, root) {
  const txt = fixtureRawText(rel, root);
  if (txt == null) return null;
  const ids = [...txt.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const forms = (txt.match(/<form/g) || []).length;
  const buttons = [...txt.matchAll(/<button[^>]*>([^<]{0,30})/g)].map((m) => m[1].trim()).filter(Boolean);
  const inputs = [...txt.matchAll(/<input[^>]*type="([^"]+)"/g)].map((m) => m[1]);
  const links = (txt.match(/<a\s/g) || []).length;
  const entities = ['机械键盘', '无线鼠标', '4K显示器', '戴尔 U2723QE', 'LG 27UP850'].filter((e) => txt.includes(e));
  return { ids: [...new Set(ids)], forms, buttons: [...new Set(buttons)], inputs: [...new Set(inputs)], links, entities };
}

// 单任务 lint：返回 missing 数组（空数组 = 对齐）。t.taskId || t.id 兼容池/场景两种形态。
function lintTask(t, txt) {
  const id = t.taskId || t.id;
  const missing = [];
  if (txt == null) { missing.push('<fixture 文件不存在>'); return { id, missing }; }
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
  return { id, missing };
}

// 池级 lint：返回 { mismatch, searchOnlyPass }，结构与 audit v2 输出一致。
// fixturesText 可选注入（生成器对未落盘任务可直接传模板对应的 fixture 文本）。
function lintPool(tasks, fixturesText) {
  const rows = [];
  const searchOnlyPass = [];
  for (const t of tasks) {
    const txt = fixturesText ? (fixturesText[t.fixture] != null ? fixturesText[t.fixture] : fixtureRawText(t.fixture)) : fixtureRawText(t.fixture);
    const { id, missing } = lintTask(t, txt);
    if (missing.length) {
      // searchOnly 降级：唯一缺失是商品/内容词且 objective 无结果性要求，且 fixture 真有搜索能力 → 可执行（空结果）
      if (isSearchOnly(t.objective) && txt != null && txt.includes('搜索')) { searchOnlyPass.push({ id, missing, objective: t.objective, fixture: t.fixture }); continue; }
      rows.push({ id, fixture: t.fixture, missing, objective: t.objective });
    }
  }
  return { mismatch: rows, searchOnlyPass };
}

module.exports = {
  NOUNS, SYNONYM_GROUPS, RESULT_VERBS, SETTINGS_PAGE_RE,
  fixtureRawText, isSearchOnly, capabilityMatrix, lintTask, lintPool,
};
