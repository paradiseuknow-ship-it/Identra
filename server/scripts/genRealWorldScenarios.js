'use strict';
// Phase 9.1 — 生成真实世界 100 任务池到 server/scenarios/real-world/
// 复用既有 mock-site fixture（不新增浏览器页面），仅扩展任务定义（objective / 验证 / 凭据 / 风险）。
// 运行：node server/scripts/genRealWorldScenarios.js
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '..', 'scenarios', 'real-world');
fs.mkdirSync(OUT, { recursive: true });

const tasks = [];
let n = 0;
function add(t) { n++; tasks.push(Object.assign({ id: 'rw.' + String(n).padStart(3, '0'), credentialRequirement: 'none', riskLevel: 'MEDIUM', credentialRef: null }, t)); }

// ── A. SaaS 30 ──
const SAAS_FIX = 'saas/login.html';
const SAAS_LOGIN_CRED = { email: 'ops@cloudsaas.io', password: 'Saas#2024' };
const saasLogins = ['登录系统并查看看板', '使用凭据登录 SaaS 控制台', '登录后进入项目列表', '登录并打开仪表盘', '使用邮箱密码登录工作区',
  '登录系统查看通知', '登录后导出当前视图', '登录并切换组织', '登录查看团队成员', '登录后打开设置页'];
saasLogins.forEach((obj, i) => add({
  category: 'saas', name: 'SaaS登录' + (i + 1), objective: obj, fixture: SAAS_FIX, difficulty: 'medium',
  expectedVerification: { type: 'element_present', description: '登录后看板/项目名称可见' },
  credentialRequirement: 'required', riskLevel: 'MEDIUM', credentialRef: 'saas_demo', credentialValue: SAAS_LOGIN_CRED,
}));
const saasSearch = ['在搜索框输入「报表」并搜索', '搜索「季度营收」文档', '查找「客户列表」并打开', '搜索「API 密钥」设置项', '在站内搜索「账单」'];
saasSearch.forEach((obj, i) => add({
  category: 'saas', name: 'SaaS搜索' + (i + 1), objective: obj, fixture: SAAS_FIX, difficulty: 'medium',
  expectedVerification: { type: 'element_present', description: '搜索结果区域出现' }, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));
const saasProj = ['点击新建项目并填写名称「Q3 增长」', '创建项目「移动端改版」并保存', '新建项目「数据管道」设置描述', '创建项目「客户成功」并标记颜色', '新建项目「内部工具」'];
saasProj.forEach((obj, i) => add({
  category: 'saas', name: 'SaaS建项目' + (i + 1), objective: obj, fixture: SAAS_FIX, difficulty: 'hard',
  expectedVerification: { type: 'element_present', description: '项目创建成功提示或列表新增' }, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));
const saasSet = ['进入设置关闭邮件通知', '在设置中将语言改为中文', '修改个人资料显示名', '开启两步验证开关', '在设置中配置时区为 UTC+8'];
saasSet.forEach((obj, i) => add({
  category: 'saas', name: 'SaaS改设置' + (i + 1), objective: obj, fixture: SAAS_FIX, difficulty: 'medium',
  expectedVerification: { type: 'element_present', description: '设置保存成功提示' }, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));
const saasData = ['打开数据列表并确认出现「戴尔 U2723QE」', '查看报表并抓取总用户数', '打开成员列表统计管理员数量', '查看订单数据确认最新一笔', '打开日志列表确认无错误'];
saasData.forEach((obj, i) => add({
  category: 'saas', name: 'SaaS数据查看' + (i + 1), objective: obj, fixture: 'scraping/list.html', difficulty: 'easy',
  expectedVerification: { type: 'text_present', description: '目标文本/数据出现在列表中' }, credentialRequirement: 'none', riskLevel: 'LOW',
}));

// ── B. 电商后台 25 ──
const EC = 'ecommerce/search.html';
const ecSearch = ['在搜索框输入「耳机」并点击搜索', '搜索「无线鼠标」并查看结果', '搜索「机械键盘」', '搜索「USB 网卡」', '搜索「显示器」'];
ecSearch.forEach((obj, i) => add({
  category: 'ecommerce', name: '商品搜索' + (i + 1), objective: obj, fixture: EC, difficulty: 'easy',
  expectedVerification: { type: 'element_present', description: '搜索结果页出现商品' }, credentialRequirement: 'none', riskLevel: 'LOW',
}));
const ecEdit = ['搜索「耳机」后点击第一个商品进入编辑页修改标题', '打开商品编辑页将库存文案改为「现货」', '编辑商品「机械键盘」描述追加规格', '在商品编辑页更新价格显示', '编辑商品分类标签'];
ecEdit.forEach((obj, i) => add({
  category: 'ecommerce', name: '商品编辑' + (i + 1), objective: obj, fixture: EC, difficulty: 'medium',
  expectedVerification: { type: 'element_present', description: '编辑保存成功' }, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));
const ecInv = ['搜索「无线鼠标」后将库存数量改为 50', '将商品「显示器」库存更新为 12', '批量设置库存为 99', '修改商品价格字段为 199', '将库存阈值调整为 10'];
ecInv.forEach((obj, i) => add({
  category: 'ecommerce', name: '库存修改' + (i + 1), objective: obj, fixture: EC, difficulty: 'medium',
  expectedVerification: { type: 'element_present', description: '库存/价格更新生效' }, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));
const ecOrder = ['打开订单查询并搜索订单号最近一笔', '查看订单列表确认状态', '查询「待发货」订单数量', '打开订单详情查看收货人', '筛选已完成订单'];
ecOrder.forEach((obj, i) => add({
  category: 'ecommerce', name: '订单查询' + (i + 1), objective: obj, fixture: 'scraping/list.html', difficulty: 'easy',
  expectedVerification: { type: 'text_present', description: '订单信息可见' }, credentialRequirement: 'none', riskLevel: 'LOW',
}));
const ecStatus = ['将订单状态更新为「已发货」', '把待付款订单标记为「已支付」', '将退款订单状态改为「已完成」', '更新订单物流状态', '将订单置为「已签收」'];
ecStatus.forEach((obj, i) => add({
  category: 'ecommerce', name: '状态更新' + (i + 1), objective: obj, fixture: 'scraping/list.html', difficulty: 'medium',
  expectedVerification: { type: 'text_present', description: '状态变更生效' }, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));

// ── C. 数据录入 20 ──
const DE = 'data_entry/form.html';
const deTable = ['填写表单：姓名张三，邮箱 z@x.io，手机号 13900000000', '提交注册表单：姓名李四，邮箱 l@x.io，手机号 13700000000', '填写联系表单：公司 ACME，联系人王五', '录入客户：姓名赵六，邮箱 z@y.io', '填写报名表：姓名孙七，邮箱 s@y.io'];
deTable.forEach((obj, i) => add({
  category: 'data_entry', name: '表格填写' + (i + 1), objective: obj, fixture: DE, difficulty: 'medium',
  expectedVerification: { type: 'element_present', description: '提交成功提示' }, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));
const deBatch = ['连续录入两条会员：张三/李四', '批量填写三个邮箱字段', '录入五条手机号到表单', '分两次提交两个订单联系人', '录入两条地址记录'];
deBatch.forEach((obj, i) => add({
  category: 'data_entry', name: '批量输入' + (i + 1), objective: obj, fixture: DE, difficulty: 'hard',
  expectedVerification: { type: 'element_present', description: '多条记录提交成功' }, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));
const deFile = ['在上传控件选择文件并提交', '上传头像图片后保存', '选择简历文件并确认', '上传附件到表单', '提交带文件的工单'];
deFile.forEach((obj, i) => add({
  category: 'data_entry', name: '文件上传' + (i + 1), objective: obj, fixture: 'download.html', difficulty: 'medium',
  expectedVerification: { type: 'element_present', description: '上传/提交成功' }, credentialRequirement: 'none', riskLevel: 'MEDIUM',
}));
const deValid = ['填写表单并触发邮箱格式校验错误', '提交空表单验证必填提示', '输入非法手机号查看校验', '填写超长文本触发长度校验', '重复提交验证去重'];
deValid.forEach((obj, i) => add({
  category: 'data_entry', name: '字段校验' + (i + 1), objective: obj, fixture: DE, difficulty: 'medium',
  expectedVerification: { type: 'element_present', description: '校验提示出现' }, credentialRequirement: 'none', riskLevel: 'LOW',
}));

// ── D. 长流程 25 ──
const dConfirm = ['搜索「耳机」→ 加入购物车 → 确认购物车出现该商品', '登录后新建项目 → 返回列表确认存在', '注册会员 → 提交 → 确认成功页', '搜索「显示器」→ 打开详情 → 确认参数', '填写表单 → 提交 → 查看回执'];
dConfirm.forEach((obj, i) => add({
  category: 'longflow', name: '多步确认' + (i + 1), objective: obj, fixture: EC, difficulty: 'hard',
  expectedVerification: { type: 'element_present', description: '最终状态确认' }, credentialRequirement: 'none', riskLevel: 'HIGH',
}));
const dDyn = ['等待页面加载完成后在搜索框输入「平板」并搜索', '在搜索框（id 已改为 query）输入「显示器」并搜索', '懒加载完成后搜索「机械键盘」', '等待动态元素出现后点击搜索', '在 SPA 路由切换后搜索「USB 网卡」'];
dDyn.forEach((obj, i) => add({
  category: 'longflow', name: '动态DOM' + (i + 1), objective: obj, fixture: 'ecommerce/search_lazy.html', difficulty: 'hard',
  expectedVerification: { type: 'element_present', description: '动态内容加载并定位成功' }, credentialRequirement: 'none', riskLevel: 'HIGH',
}));
const dSpa = ['登录 SaaS → 新建项目 → 在项目内创建任务 → 确认任务存在', '搜索商品 → 加购 → 进入结算 → 确认订单摘要', '注册 → 登录 → 修改资料 → 确认修改生效', '打开列表 → 筛选 → 导出 → 确认导出触发', '搜索 → 对比两商品 → 加入购物车 → 确认'];
dSpa.forEach((obj, i) => add({
  category: 'longflow', name: 'SPA多页' + (i + 1), objective: obj, fixture: SAAS_FIX, difficulty: 'hard',
  expectedVerification: { type: 'element_present', description: '跨步骤最终状态成立' }, credentialRequirement: 'none', riskLevel: 'HIGH',
}));
const dPay = ['登录后进入结算并模拟支付（使用支付凭据引用）', '加购后结算使用支付凭据完成下单'];
dPay.forEach((obj, i) => add({
  category: 'longflow', name: '含支付流程' + (i + 1), objective: obj, fixture: EC, difficulty: 'hard',
  expectedVerification: { type: 'element_present', description: '支付/下单结果' },
  credentialRequirement: 'required', riskLevel: 'CRITICAL', credentialRef: 'pay_demo',
  credentialValue: { card: { number: '4242424242424242', exp: '12/30', cvc: '123' } },
}));

const dExtra = ['登录后查看看板再导出报表', '搜索商品并加购后查看购物车数量', '注册会员并登录再修改头像', '打开列表筛选后翻页确认数据', '搜索「显示器」对比三款后加购', '登录 SaaS 创建项目并邀请成员', '填写表单提交后查询记录是否存在', '搜索「键盘」加购并进入结算确认地址'];
dExtra.forEach((obj, i) => add({
  category: 'longflow', name: '长流程扩展' + (i + 1), objective: obj, fixture: EC, difficulty: 'hard',
  expectedVerification: { type: 'element_present', description: '跨步骤最终状态成立' }, credentialRequirement: 'none', riskLevel: 'HIGH',
}));

// 写出
for (const t of tasks) {
  const file = path.join(OUT, t.id + '.json');
  fs.writeFileSync(file, JSON.stringify(t, null, 2), 'utf8');
}
// manifest
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ count: tasks.length, tasks: tasks.map((t) => t.id) }, null, 2), 'utf8');
console.log('Generated ' + tasks.length + ' real-world scenarios in ' + OUT);
const byCat = {};
tasks.forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + 1; });
console.log(JSON.stringify(byCat));
