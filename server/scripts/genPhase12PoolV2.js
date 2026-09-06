'use strict';
// Phase 12 Pool v2 —— fixture 对齐重生成（B3 池对齐契约的落地产物）。
//
// 背景：dl240 双口径审计（docs/product/DUAL_CALIBER_EVIDENCE_AUDIT_REPORT.md）证实，
// v1 池 26pp 假阳性的主根因是 genRealWorldScenarios.js 生成时 objective 模板与 fixture
// 内容从未对齐（B 类池生成缺陷）：login.html 无项目/设置/成员，search.html 无编辑/库存/订单，
// list.html 是纯静态只读榜，form.html 无公司/上传字段，download.html 无上传控件。
//
// v2 原则：
//   1) 每个 objective 的目标资源/能力在对应 fixture 中确定性存在（生成期 lint fail-fast）
//   2) 需要登录后状态的任务一律 credentialRequirement='required' + credentialRef='saas_demo'
//      （修复 v1 none+login 结构性不可满足的 B 类最大损失源）；仅观察未登录可达状态的任务为 none
//   3) 不新增 fixture 页面（复用既有 6 个 mock-site 文件，不碰冻结 real-world/ 与 phase12_pool.json）
//   4) 引号词接地断言：objective 中「X」必须在 fixture 文本中出现，或 fixture 为
//      search_lazy.html（回显机制：任意词都确定性回显「搜索结果：X」），或 objective 期望
//      「未找到相关商品」且 fixture 具有该确定性空结果提示
//   5) v2 移除 pay_demo 支付契约（无任何 fixture 具备结算/支付能力，v1 该 2 任务不可满足）；
//      敏感字段门/凭据族覆盖由 25 个 saas_demo required 任务保留
//
// 输出：
//   - server/scenarios/real-world-v2/rw.001..100.json + index.json（含 credentialValue，供 harness 播种）
//   - phase12_pool_v2.json（池快照，与 v1 池同构，无明文凭据）
//
// 运行：node server/scripts/genPhase12PoolV2.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lint = require('./pool_alignment_lint');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_SCEN = path.join(ROOT, 'server', 'scenarios', 'real-world-v2');
const OUT_POOL = path.join(ROOT, 'phase12_pool_v2.json');

// ── fixture 文本（接地断言与 lint 输入）──
const FIXTURES = {};
for (const f of ['saas/login.html', 'scraping/list.html', 'ecommerce/search.html', 'ecommerce/search_lazy.html', 'data_entry/form.html', 'download.html']) {
  FIXTURES[f] = fs.readFileSync(path.join(ROOT, 'mock-site', f), 'utf8');
}
const ECHO_FIXTURE = 'ecommerce/search_lazy.html';

// ── 任务构建 ──
const tasks = [];
let n = 0;
function add(t) {
  n++;
  const base = {
    id: 'rw.' + String(n).padStart(3, '0'),
    credentialRequirement: 'none', riskLevel: 'MEDIUM', credentialRef: null,
  };
  tasks.push(Object.assign(base, t));
}
const VER = (type, description) => ({ type, description });

// ── A. SaaS 30（fixture: saas/login.html；能力=登录表单/登录后看板/活跃用户数/导出 CSV）──
// A1 登录 10（required, saas_demo）
const SAAS = 'saas/login.html';
const SAAS_LOGIN_CRED = { email: 'ops@cloudsaas.io', password: 'Saas#2024' };
const a1 = [
  ['使用凭据登录 SaaS 控制台并查看看板', VER('element_present', '登录后数据看板区域可见')],
  ['登录系统并确认数据看板出现', VER('element_present', '登录后数据看板区域可见')],
  ['登录后查看本月活跃用户数', VER('text_present', '本月活跃用户数值可见')],
  ['登录后点击导出 CSV 按钮并确认导出成功', VER('text_present', '报表已导出提示出现')],
  ['使用邮箱密码登录控制台', VER('element_present', '登录后数据看板区域可见')],
  ['登录系统并确认看板中显示本月活跃用户', VER('text_present', '本月活跃用户数值可见')],
  ['登录后点击导出报表并确认出现「report_2024.csv」', VER('text_present', 'report_2024.csv 出现在导出提示中')],
  ['使用正确凭据登录控制台并确认导出按钮可见', VER('element_present', '登录后导出 CSV 按钮可见')],
  ['登录后查看数据看板并导出 CSV', VER('text_present', '报表已导出提示出现')],
  ['登录系统并确认数据看板内容可见', VER('element_present', '登录后数据看板区域可见')],
];
a1.forEach(([obj, ver], i) => add({
  category: 'saas', name: 'SaaS登录' + (i + 1), objective: obj, fixture: SAAS, difficulty: 'medium',
  expectedVerification: ver, credentialRequirement: 'required', credentialRef: 'saas_demo', riskLevel: 'MEDIUM',
  _needsLogin: true, _credentialValue: SAAS_LOGIN_CRED,
}));

// A2 未登录观察 5（none：仅未登录可达状态）
const a2 = [
  ['打开 SaaS 控制台页面，确认企业邮箱输入框可见', VER('element_present', '企业邮箱输入框可见')],
  ['打开登录页并确认密码输入框存在', VER('element_present', '密码输入框可见')],
  ['打开控制台登录页确认登录按钮存在', VER('element_present', '登录按钮可见')],
  ['输入错误密码提交登录，确认出现「邮箱或密码错误」提示', VER('text_present', '邮箱或密码错误提示出现')],
  ['不填写任何内容直接提交登录，确认出现错误提示', VER('text_present', '邮箱或密码错误提示出现')],
];
a2.forEach(([obj, ver], i) => add({
  category: 'saas', name: 'SaaS登录页观察' + (i + 1), objective: obj, fixture: SAAS, difficulty: 'easy',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'LOW', _needsLogin: false,
}));

// A3 登录+导出多步 5（required, hard）
const a3 = [
  ['登录后依次确认数据看板与导出按钮均可见', VER('element_present', '看板区域与导出 CSV 按钮均可见')],
  ['登录后查看活跃用户数并点击导出 CSV', VER('text_present', '报表已导出提示出现')],
  ['登录系统导出报表并确认 report_2024.csv 提示', VER('text_present', 'report_2024.csv 出现在导出提示中')],
  ['登录后确认看板出现，再点击导出并确认导出成功提示', VER('text_present', '报表已导出提示出现')],
  ['使用凭据登录并确认从登录到看板到导出的完整流程', VER('text_present', '报表已导出提示出现')],
];
a3.forEach(([obj, ver], i) => add({
  category: 'saas', name: 'SaaS登录导出链' + (i + 1), objective: obj, fixture: SAAS, difficulty: 'hard',
  expectedVerification: ver, credentialRequirement: 'required', credentialRef: 'saas_demo', riskLevel: 'MEDIUM',
  _needsLogin: true, _credentialValue: SAAS_LOGIN_CRED,
}));

// A4 登录后观察 5（required, medium）
const a4 = [
  ['登录后确认数据看板标题可见', VER('element_present', '数据看板标题可见')],
  ['登录系统并查看本月活跃用户数值', VER('text_present', '本月活跃用户数值可见')],
  ['登录后点击导出 CSV 确认导出提示出现', VER('text_present', '报表已导出提示出现')],
  ['使用凭据登录并确认看板区域展示', VER('element_present', '登录后数据看板区域可见')],
  ['登录后确认活跃用户数据与导出按钮同时可见', VER('element_present', '看板数据与导出 CSV 按钮均可见')],
];
a4.forEach(([obj, ver], i) => add({
  category: 'saas', name: 'SaaS看板确认' + (i + 1), objective: obj, fixture: SAAS, difficulty: 'medium',
  expectedVerification: ver, credentialRequirement: 'required', credentialRef: 'saas_demo', riskLevel: 'MEDIUM',
  _needsLogin: true, _credentialValue: SAAS_LOGIN_CRED,
}));

// A5 登录后导出确认 5（required, medium）
const a5 = [
  ['登录后使用导出功能并确认导出文件名为 report_2024.csv', VER('text_present', 'report_2024.csv 出现在导出提示中')],
  ['登录系统确认活跃用户指标展示后点击导出', VER('text_present', '报表已导出提示出现')],
  ['登录后验证看板区域从隐藏变为可见', VER('element_present', '登录后数据看板区域可见')],
  ['登录后先查看活跃用户数再确认导出按钮可见', VER('element_present', '导出 CSV 按钮可见')],
  ['使用凭据登录后确认控制台进入已登录状态（看板可见）', VER('element_present', '登录后数据看板区域可见')],
];
a5.forEach(([obj, ver], i) => add({
  category: 'saas', name: 'SaaS导出确认' + (i + 1), objective: obj, fixture: SAAS, difficulty: 'medium',
  expectedVerification: ver, credentialRequirement: 'required', credentialRef: 'saas_demo', riskLevel: 'MEDIUM',
  _needsLogin: true, _credentialValue: SAAS_LOGIN_CRED,
}));

// ── B. 电商 25 ──
// B1 商品搜索 5（EC：目录=机械键盘/无线鼠标/4K显示器，搜索为子串过滤）
const EC = 'ecommerce/search.html';
const b1 = [
  ['在搜索框输入「机械键盘」并点击搜索，确认结果出现该商品', VER('text_present', '机械键盘出现在搜索结果中')],
  ['搜索「无线鼠标」并确认结果列表出现对应商品', VER('text_present', '无线鼠标出现在搜索结果中')],
  ['搜索「4K显示器」确认价格 ¥1599 出现在结果中', VER('text_present', '¥1599 出现在搜索结果中')],
  ['搜索「显示器」确认结果包含 4K显示器', VER('text_present', '4K显示器出现在搜索结果中')],
  ['搜索「键盘」确认结果包含机械键盘', VER('text_present', '机械键盘出现在搜索结果中')],
];
b1.forEach(([obj, ver], i) => add({
  category: 'ecommerce', name: '商品搜索' + (i + 1), objective: obj, fixture: EC, difficulty: 'easy',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'LOW',
}));

// B2 加购计数 5（EC：结果行动态 addBtn → #cart 计数）
const b2 = [
  ['搜索「机械键盘」并点击加入购物车，确认购物车数量变为 1', VER('text_present', '购物车计数变为 1')],
  ['搜索「无线鼠标」加购后确认购物车计数更新', VER('text_present', '购物车计数变为 1')],
  ['搜索「4K显示器」并加购，确认按钮文本变为已加入购物车', VER('text_present', '已加入购物车按钮文本出现')],
  ['搜索「键盘」加购后确认购物车件数增加', VER('text_present', '购物车计数变为 1')],
  ['搜索「鼠标」并加入购物车确认购物车数量为 1', VER('text_present', '购物车计数变为 1')],
];
b2.forEach(([obj, ver], i) => add({
  category: 'ecommerce', name: '加购计数' + (i + 1), objective: obj, fixture: EC, difficulty: 'medium',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));

// B3 价格确认 5（EC：价格在 CATALOG 渲染行中）
const b3 = [
  ['搜索「机械键盘」确认结果中价格 ¥399 出现', VER('text_present', '¥399 出现在搜索结果中')],
  ['搜索「无线鼠标」确认价格 ¥129 出现', VER('text_present', '¥129 出现在搜索结果中')],
  ['搜索「4K显示器」确认价格 ¥1599 出现', VER('text_present', '¥1599 出现在搜索结果中')],
  ['搜索「显示器」确认结果中包含商品价格信息', VER('text_present', '价格出现在搜索结果中')],
  ['搜索「键盘」确认结果行的商品描述「RGB 热插拔机械键盘」出现', VER('text_present', 'RGB 热插拔机械键盘描述出现')],
];
b3.forEach(([obj, ver], i) => add({
  category: 'ecommerce', name: '价格确认' + (i + 1), objective: obj, fixture: EC, difficulty: 'easy',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'LOW',
}));

// B4 榜单观察 5（scraping/list.html：静态显示器榜单，戴尔/LG/飞利浦等 10 条）
const LIST = 'scraping/list.html';
const b4 = [
  ['打开比价榜单确认出现「戴尔 U2723QE」', VER('text_present', '戴尔 U2723QE 出现在榜单中')],
  ['查看榜单确认「LG 27UP850」出现', VER('text_present', 'LG 27UP850 出现在榜单中')],
  ['打开商品榜单确认共 10 条商品', VER('text_present', '共 10 条商品计数可见')],
  ['查看榜单确认「戴尔 U2723QE」的价格 ¥3299 出现', VER('text_present', '¥3299 出现在榜单中')],
  ['打开榜单确认「飞利浦 279C9」条目可见', VER('text_present', '飞利浦 279C9 出现在榜单中')],
];
b4.forEach(([obj, ver], i) => add({
  category: 'ecommerce', name: '榜单观察' + (i + 1), objective: obj, fixture: LIST, difficulty: 'easy',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'LOW',
}));

// B5 榜单条目 5（scraping/list.html 只读）
const b5 = [
  ['查看榜单确认「华硕 ProArt PA279CV」条目出现', VER('text_present', '华硕 ProArt PA279CV 出现在榜单中')],
  ['打开比价网榜单确认「明基 PD2705Q」可见', VER('text_present', '明基 PD2705Q 出现在榜单中')],
  ['查看榜单确认「三星 S27A800」条目出现', VER('text_present', '三星 S27A800 出现在榜单中')],
  ['打开榜单确认「小米 27寸 4K 显示器」条目出现', VER('text_present', '小米 27寸 4K 显示器出现在榜单中')],
  ['查看榜单确认「AOC U27U2」条目出现', VER('text_present', 'AOC U27U2 出现在榜单中')],
];
b5.forEach(([obj, ver], i) => add({
  category: 'ecommerce', name: '榜单条目' + (i + 1), objective: obj, fixture: LIST, difficulty: 'easy',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'LOW',
}));

// ── C. 数据录入 20（data_entry/form.html：regForm name/email/phone，必填校验，注册成功回显）──
const DE = 'data_entry/form.html';
// C1 表格填写 5
const c1 = [
  ['填写注册表单：姓名张三，邮箱 z@x.io，手机号 13900000000，并提交', VER('text_present', '注册成功，欢迎 张三 提示出现')],
  ['提交注册表单：姓名李四，邮箱 l@x.io，手机号 13700000000', VER('text_present', '注册成功，欢迎 李四 提示出现')],
  ['填写表单姓名王五、邮箱 w@x.io 并提交，确认注册成功', VER('text_present', '注册成功，欢迎 王五 提示出现')],
  ['录入会员：姓名赵六，邮箱 z@y.io，手机号 13600000000', VER('text_present', '注册成功，欢迎 赵六 提示出现')],
  ['填写报名表单：姓名孙七，邮箱 s@y.io 并提交注册', VER('text_present', '注册成功，欢迎 孙七 提示出现')],
];
c1.forEach(([obj, ver], i) => add({
  category: 'data_entry', name: '表格填写' + (i + 1), objective: obj, fixture: DE, difficulty: 'medium',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));

// C2 多次提交 5（hard：单表单两次提交，每次均有确定性成功回显）
const c2 = [
  ['分两次提交注册：先姓名张三邮箱 z1@x.io，再姓名李四邮箱 l1@x.io，两次均确认注册成功', VER('text_present', '两次提交均出现注册成功提示')],
  ['连续提交两条注册记录：王五 w2@x.io 与 赵六 z2@x.io，各自确认成功提示', VER('text_present', '两次提交均出现注册成功提示')],
  ['提交两条注册：孙七 s3@x.io 和 周八 z8@x.io，确认第二次也显示注册成功', VER('text_present', '第二次提交出现注册成功提示')],
  ['依次用两个邮箱 a4@x.io 与 b4@x.io 配合姓名钱九提交两次注册', VER('text_present', '两次提交均出现注册成功提示')],
  ['连续注册两名会员：吴十 w10@x.io、郑一 z1@y.io，均确认欢迎提示出现', VER('text_present', '两次提交均出现注册成功欢迎提示')],
];
c2.forEach(([obj, ver], i) => add({
  category: 'data_entry', name: '多次提交' + (i + 1), objective: obj, fixture: DE, difficulty: 'hard',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));

// C3 下载 5（download.html：唯一能力=下载链接 sample.txt）
const DL = 'download.html';
const c3 = [
  ['打开下载页确认「下载示例文件」链接可见', VER('element_present', '下载示例文件链接可见')],
  ['点击下载链接下载示例文件', VER('element_present', '下载链接存在并可触发下载')],
  ['确认下载页包含资源下载标题与下载链接', VER('element_present', '资源下载标题与下载链接可见')],
  ['点击页面中的下载链接触发 sample.txt 下载', VER('element_present', '下载链接指向 sample.txt')],
  ['打开资源下载页并确认下载链接存在', VER('element_present', '下载链接可见')],
];
c3.forEach(([obj, ver], i) => add({
  category: 'data_entry', name: '下载链接' + (i + 1), objective: obj, fixture: DL, difficulty: 'easy',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'LOW',
}));

// C4 字段校验 5（form.html 真实行为：缺 name/email → 请填写必填项；齐全 → 注册成功）
const c4 = [
  ['只填姓名不填邮箱直接提交，确认出现「请填写必填项」提示', VER('text_present', '请填写必填项提示出现')],
  ['提交空表单验证必填提示出现', VER('text_present', '请填写必填项提示出现')],
  ['只填邮箱不填姓名提交表单，确认校验提示出现', VER('text_present', '请填写必填项提示出现')],
  ['填写姓名与邮箱后提交，确认提示变为注册成功欢迎语', VER('text_present', '注册成功欢迎提示出现')],
  ['同一姓名连续提交两次注册，确认两次均出现注册成功提示', VER('text_present', '两次提交均出现注册成功提示')],
];
c4.forEach(([obj, ver], i) => add({
  category: 'data_entry', name: '字段校验' + (i + 1), objective: obj, fixture: DE, difficulty: 'medium',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'LOW',
}));

// ── D. 长流程 25 ──
// D1 多步加购确认 5（EC：搜索→加购→计数）
const d1 = [
  ['搜索「机械键盘」→ 加入购物车 → 确认购物车数量变为 1', VER('text_present', '购物车计数变为 1')],
  ['搜索「无线鼠标」→ 加购 → 再搜索「机械键盘」→ 加购 → 确认购物车数量为 2', VER('text_present', '购物车计数变为 2')],
  ['搜索「4K显示器」加入购物车后确认购物车件数增加', VER('text_present', '购物车计数变为 1')],
  ['搜索「键盘」加购后确认按钮文本变为已加入购物车', VER('text_present', '已加入购物车按钮文本出现')],
  ['搜索「鼠标」加购后确认购物车计数从 0 变为 1', VER('text_present', '购物车计数变为 1')],
];
d1.forEach(([obj, ver], i) => add({
  category: 'longflow', name: '多步确认' + (i + 1), objective: obj, fixture: EC, difficulty: 'hard',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'HIGH',
}));

// D2 动态DOM 5（search_lazy.html：800ms 后搜索框可见；任意词确定性回显「搜索结果：X」）
const LAZY = 'ecommerce/search_lazy.html';
const d2 = [
  ['等待页面加载完成后在搜索框输入「路由器」并搜索，确认出现搜索结果回显', VER('text_present', '搜索结果：路由器 回显出现')],
  ['等待搜索框可见后输入「蓝牙音箱」并点击搜索，确认结果区域显示搜索结果', VER('text_present', '搜索结果回显出现')],
  ['在搜索框（id 为 q）输入「摄像头」并搜索，确认出现搜索结果回显', VER('text_present', '搜索结果：摄像头 回显出现')],
  ['在懒加载完成后搜索「移动电源」，确认结果区域显示搜索结果文本', VER('text_present', '搜索结果：移动电源 回显出现')],
  ['等待页面就绪后在搜索框输入「数据线」并搜索，确认出现搜索结果提示', VER('text_present', '搜索结果：数据线 回显出现')],
];
d2.forEach(([obj, ver], i) => add({
  category: 'longflow', name: '动态DOM' + (i + 1), objective: obj, fixture: LAZY, difficulty: 'hard',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'HIGH',
}));

// D3 登录长链 5（saas/login.html，required）
const d3 = [
  ['登录后确认看板出现，再点击导出 CSV 并确认导出成功', VER('text_present', '报表已导出提示出现')],
  ['使用凭据登录系统，查看本月活跃用户数后导出报表', VER('text_present', '报表已导出提示出现')],
  ['登录控制台并完成从看板确认到导出 CSV 的完整链路', VER('text_present', '报表已导出提示出现')],
  ['登录系统确认数据看板可见后点击导出报表', VER('text_present', '报表已导出提示出现')],
  ['使用凭据登录并依次确认看板、活跃用户、导出提示', VER('text_present', '报表已导出提示出现')],
];
d3.forEach(([obj, ver], i) => add({
  category: 'longflow', name: 'SPA多页' + (i + 1), objective: obj, fixture: SAAS, difficulty: 'hard',
  expectedVerification: ver, credentialRequirement: 'required', credentialRef: 'saas_demo', riskLevel: 'HIGH',
  _needsLogin: true, _credentialValue: SAAS_LOGIN_CRED,
}));

// D4 高难多商品加购 2（EC：替代 v1 不可满足的 pay_demo 支付任务——无任何 fixture 具备结算/支付能力）
const d4 = [
  ['依次搜索并加购全部三款商品（机械键盘、无线鼠标、4K显示器），确认购物车数量为 3', VER('text_present', '购物车计数变为 3')],
  ['搜索「显示器」加购后再搜索「键盘」加购，确认购物车计数为 2 且两件商品均显示已加入购物车', VER('text_present', '购物车计数变为 2')],
];
d4.forEach(([obj, ver], i) => add({
  category: 'longflow', name: '高难加购' + (i + 1), objective: obj, fixture: EC, difficulty: 'hard',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'HIGH',
}));

// D5 长流程扩展 8（EC 真实能力内的多步组合；空结果词均为目录外非名词词，期望=确定性「未找到相关商品」）
const d5 = [
  ['搜索「机械键盘」加购后重新搜索「无线鼠标」，确认购物车计数保持为 1', VER('text_present', '购物车计数保持为 1')],
  ['搜索「4K显示器」加购，再搜索「耳机」确认出现未找到相关商品提示', VER('text_present', '未找到相关商品提示出现')],
  ['搜索「键盘」加购后，再次搜索「鼠标」，确认结果区域更新为鼠标商品且购物车计数保持 1', VER('text_present', '购物车计数保持为 1 且结果更新')],
  ['连续搜索三款商品并逐一确认其价格出现', VER('text_present', '三款商品价格均出现在结果中')],
  ['搜索「机械键盘」确认加购前购物车为 0 件，加购后变为 1 件', VER('text_present', '购物车计数从 0 变为 1')],
  ['搜索「扫描仪」确认出现未找到相关商品提示', VER('text_present', '未找到相关商品提示出现')],
  ['搜索「鼠标」加购后确认按钮文本变为已加入购物车，再确认购物车件数为 1', VER('text_present', '购物车计数变为 1')],
  ['搜索「显示器」加购，然后搜索「机械键盘」加购，最后确认购物车数量为 2', VER('text_present', '购物车计数变为 2')],
];
d5.forEach(([obj, ver], i) => add({
  category: 'longflow', name: '长流程扩展' + (i + 1), objective: obj, fixture: EC, difficulty: 'hard',
  expectedVerification: ver, credentialRequirement: 'none', riskLevel: 'HIGH',
}));

// ══════════════════ 生成期对齐断言（fail-fast，任何命中即 exit 2，不写任何产物）══════════════════
const errors = [];

// 断言 1：共享 lint（与 audit v2 等价逻辑）零错配
const lintRes = lint.lintPool(tasks, FIXTURES);
if (lintRes.mismatch.length) {
  for (const r of lintRes.mismatch) errors.push('[lint] ' + r.id + ' | ' + r.objective + ' | 缺: ' + r.missing.join('/'));
}

// 断言 2：引号词接地（「X」须在 fixture 文本中，或 search_lazy 回显，或确定性空结果）
const QUOTED_RE = /[「]([^」]+)[」]/g;
for (const t of tasks) {
  const txt = FIXTURES[t.fixture];
  let m;
  QUOTED_RE.lastIndex = 0;
  while ((m = QUOTED_RE.exec(t.objective)) !== null) {
    const term = m[1];
    const grounded = txt.includes(term)
      || t.fixture === ECHO_FIXTURE
      || (t.objective.includes('未找到相关商品') && txt.includes('未找到相关商品'));
    if (!grounded) errors.push('[quoted] ' + t.id + ' 引号词「' + term + '」在 ' + t.fixture + ' 中无接地依据');
  }
}

// 断言 3：登录契约一致性（needsLogin ↔ credentialRequirement/credentialRef）
for (const t of tasks) {
  if (t._needsLogin) {
    if (t.credentialRequirement !== 'required' || t.credentialRef !== 'saas_demo') {
      errors.push('[login-contract] ' + t.id + ' 声明 needsLogin 但凭据契约不是 required+saas_demo');
    }
  } else {
    if (t.credentialRequirement !== 'none' || t.credentialRef) {
      errors.push('[login-contract] ' + t.id + ' 未声明 needsLogin 但凭据契约不是 none');
    }
    // 断言 4：none 任务不得含登录后实体词（未登录不可达）
    for (const postLoginNoun of ['看板', '导出', '活跃用户']) {
      if (t.fixture === SAAS && t.objective.includes(postLoginNoun)) {
        errors.push('[post-login] ' + t.id + ' none 任务 objective 含登录后实体「' + postLoginNoun + '」');
      }
    }
  }
}

// 断言 5：结构完整性（100 任务、id/objective 唯一、验证类型合法、fixture 已知）
const ids = tasks.map((t) => t.id);
const objs = tasks.map((t) => t.objective);
if (tasks.length !== 100) errors.push('[structure] 任务数 = ' + tasks.length + ' ≠ 100');
if (new Set(ids).size !== tasks.length) errors.push('[structure] taskId 有重复');
if (new Set(objs).size !== 100) {
  const seen = new Set(), dups = [];
  for (const o of objs) { if (seen.has(o)) dups.push(o); seen.add(o); }
  errors.push('[structure] objective 有重复（' + dups.length + ' 个）: ' + dups.join(' || '));
}
for (const t of tasks) {
  if (!['element_present', 'text_present'].includes(t.expectedVerification.type)) {
    errors.push('[structure] ' + t.id + ' 验证类型非法: ' + t.expectedVerification.type);
  }
  if (!FIXTURES[t.fixture]) errors.push('[structure] ' + t.id + ' fixture 未知: ' + t.fixture);
}

if (errors.length) {
  console.error('=== 生成期对齐断言失败（' + errors.length + ' 项），未写出任何产物 ===');
  for (const e of errors) console.error('  ' + e);
  process.exit(2);
}

// ══════════════════ 写出产物 ══════════════════
// 场景文件（与 v1 场景同构：含 credentialValue，供 harness 播种）
fs.mkdirSync(OUT_SCEN, { recursive: true });
for (const t of tasks) {
  const scen = {
    id: t.id, credentialRequirement: t.credentialRequirement, riskLevel: t.riskLevel, credentialRef: t.credentialRef,
    category: t.category, name: t.name, objective: t.objective, fixture: t.fixture, difficulty: t.difficulty,
    expectedVerification: t.expectedVerification,
  };
  if (t._credentialValue) scen.credentialValue = t._credentialValue;
  fs.writeFileSync(path.join(OUT_SCEN, t.id + '.json'), JSON.stringify(scen, null, 2), 'utf8');
}
fs.writeFileSync(path.join(OUT_SCEN, 'index.json'), JSON.stringify({
  count: tasks.length, generator: 'genPhase12PoolV2.js', alignmentLint: { mismatch: 0 },
  tasks: tasks.map((t) => t.id),
}, null, 2), 'utf8');

// 池快照（与 v1 池同构：taskId 键、无明文凭据）
const poolTasks = tasks.map((t) => ({
  taskId: t.id, category: t.category, name: t.name, objective: t.objective, fixture: t.fixture,
  expectedBusinessState: 'planner-derived (contractFromObjective / deriveContract by action.type)',
  expectedVerification: t.expectedVerification,
  credentialRequirement: t.credentialRequirement, credentialRef: t.credentialRef,
  riskLevel: t.riskLevel, difficulty: t.difficulty,
}));
const pool = {
  _meta: {
    frozen: true,
    generatedAt: new Date().toISOString(),
    generator: 'genPhase12PoolV2.js',
    provenance: 'v2 fixture 对齐重生成（B3 池对齐契约落地）；v1 冻结池 phase12_pool.json 未改动，历史基线不可比',
    alignmentLint: { auditor: 'pool_alignment_lint.js (audit v2 等价)', mismatch: 0, searchOnlyPass: lintRes.searchOnlyPass.length },
    taskCount: poolTasks.length,
    sha256: crypto.createHash('sha256').update(JSON.stringify(poolTasks), 'utf8').digest('hex'),
  },
  tasks: poolTasks,
};
fs.writeFileSync(OUT_POOL, JSON.stringify(pool, null, 2), 'utf8');

const byCat = {};
tasks.forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + 1; });
const byFixture = {};
tasks.forEach((t) => { byFixture[t.fixture] = (byFixture[t.fixture] || 0) + 1; });
console.log('v2 池生成完成（生成期对齐断言全绿）：');
console.log('  任务数:', tasks.length, JSON.stringify(byCat));
console.log('  fixture 分布:', JSON.stringify(byFixture));
console.log('  required 凭据任务:', tasks.filter((t) => t.credentialRequirement === 'required').length, '(saas_demo)');
console.log('  场景目录:', OUT_SCEN);
console.log('  池快照:', OUT_POOL, 'sha256=' + pool._meta.sha256.slice(0, 12) + '…');
