'use strict';
/*
 * Phase 5 — Execution Failure Deep Analysis (READ-ONLY).
 * 对 Phase 4 归类为 ELEMENT_NOT_FOUND 的 29 个 case 做二级 taxonomy 分析。
 * 仅读取既有 runtime 数据（.benchmark/phase3_live_raw_store + phase4 分析产物），
 * 不修改任何执行能力 / planner / resolver / selector / retry / benchmark / success definition。
 *
 * 输出: .benchmark/phase5_element_failure_analysis.json
 */
const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, '..', '..', '.benchmark', 'phase3_live_raw_store');
const PHASE4 = path.join(__dirname, '..', '..', '.benchmark', 'phase4_blocker_analysis.json');
const OUT = path.join(__dirname, '..', '..', '.benchmark', 'phase5_element_failure_analysis.json');

const readJson = (f, d) => {
  try { return JSON.parse(fs.readFileSync(path.join(STORE, f), 'utf8')); } catch (e) { return d; }
};

const tasks = readJson('aiTasks.json', []);
const attempts = readJson('aiAttempts.json', []);
const steps = readJson('aiSteps.json', []);
const events = readJson('aiEvents.json', []);
const snaps = readJson('aiFailureSnapshots.json', []);
const repairs = readJson('aiRepairAttempts.json', []);

const stepTask = {};
steps.forEach((s) => { stepTask[s.id] = s.taskId; });
const taskAtt = {};
attempts.forEach((a) => {
  const tid = stepTask[a.stepId];
  if (tid) (taskAtt[tid] = taskAtt[tid] || []).push(a);
});

const phase4 = JSON.parse(fs.readFileSync(PHASE4, 'utf8'));
const efTasks = phase4.c1.perTask.filter((t) => t.taxonomy === 'ELEMENT_NOT_FOUND');

// ---- 信号提取 ----
function extractSelector(msg) {
  if (!msg) return null;
  let m = msg.match(/element_present="([^"]+)"/);
  if (m) return m[1];
  m = msg.match(/未找到元素\s+"([^"]+)"/);
  if (m) return m[1];
  return null;
}

const hasCJK = (s) => /[一-龥]/.test(s || '');

function analyzeOne(t) {
  const tid = t.taskId;
  const atts = taskAtt[tid] || [];
  const fails = atts.filter((a) => (a.error || {}).code === 'VERIFY_FAILED' || /未找到元素/.test(a.error && a.error.message || ''));
  const firstFail = fails[0] || atts.find((a) => a.status === 'FAILED') || atts[0];
  const action = (firstFail && firstFail.action) || null;
  const actionType = action && action.type;
  const verifyExpect = action && action.verification && action.verification.expect;
  const errMsg = (firstFail && firstFail.error && firstFail.error.message || '').replace(/\s+/g, ' ').trim();
  const errSel = extractSelector(errMsg) || verifyExpect || null;

  const mySnaps = snaps.filter((s) => s.taskId === tid);
  const snapText = mySnaps.map((s) => (s.visibleTexts || []).join(' ')).join(' ').replace(/\s+/g, ' ').trim();
  const blankSnap = snapText.length === 0;

  const laterSuccessFill = atts.some((a) => a.status === 'SUCCESS' && (a.action && ['fill', 'click', 'select'].includes(a.action.type)));
  const hasReloadWait = atts.some((a) => (a.action && ['reload', 'wait'].includes(a.action.type)));

  const diagCats = [...new Set(events.filter((e) => e.taskId === tid && e.type === 'agent.diagnosing').map((e) => e.payload && e.payload.category).filter(Boolean))];
  const verifyFt = [...new Set(events.filter((e) => e.taskId === tid && e.type === 'ai.verification.decision').map((e) => e.payload && e.payload.failureType).filter(Boolean))];
  const repStrategies = [...new Set(repairs.filter((r) => r.taskId === tid).map((r) => r.strategy))];

  const low = snapText.toLowerCase();
  const isLoginWall = /邮箱或密码错误|请登录|未登录|登录失效|登录页|sign\s?in|401|403|权限不足|需要登录/.test(snapText);
  const isIframe = /iframe|shadow|contentdocument|frame\b|#document/.test(low + ' ' + (errSel || '').toLowerCase());
  const isLoading = /加载中|正在加载|loading|载入|spinner/.test(low);

  // wrong-page 启发：任务意图关键词与快照页面类型冲突
  const taskName = t.name || '';
  const hasProductBrands = /戴尔|lg|飞利浦|华硕|明基/.test(low);
  const wrongPageUpload = /上传|upload/i.test(taskName) && /下载|download/.test(low);
  const wrongPageOrder = /订单|状态|退款|签收/i.test(taskName) && hasProductBrands && !/订单/.test(low);
  const wrongPageSaas = /saas/i.test(taskName) && hasProductBrands; // SaaS 控制台预期，却落在商品页
  const wrongPageRegister = /注册|register|多步确认/i.test(taskName) && /搜索|购物车/.test(low); // 注册/多步预期，却落在商城搜索页
  const wrongPage = wrongPageUpload || wrongPageOrder || wrongPageSaas || wrongPageRegister;

  // ---- 二级分类器（确定性、可解释）----
  const reasons = [];
  let cat, conf;
  if (isIframe) {
    cat = 'E3'; conf = 0.8; reasons.push('检测到 iframe/shadow DOM 上下文，主文档查询无法命中目标');
  } else if (blankSnap) {
    cat = 'E2'; conf = 0.8; reasons.push('快照可见文本为空 → SPA/页面未挂载或未就绪');
  } else if (isLoading) {
    cat = 'E2'; conf = 0.7; reasons.push('快照显示加载中/loading 态 → 页面未 ready');
  } else if (laterSuccessFill) {
    cat = 'E1'; conf = 0.8; reasons.push('后续 reload/wait 后同元素填充成功 → 元素可定位，原验证/选择器脆');
  } else if (isLoginWall) {
    cat = 'E6'; conf = 0.85; reasons.push('页面为登录/鉴权拦截态，受保护元素未渲染');
  } else if (wrongPage) {
    cat = 'E5'; conf = 0.7; reasons.push('快照页面类型与任务意图冲突（落在错误页面/上下文）→ 语义/上下文解析错位');
  } else if (hasCJK(errSel || '')) {
    cat = 'E5'; conf = 0.65; reasons.push('目标为语义描述而非稳定选择器，所在页面已渲染但元素缺失 → 语义解析落到错误上下文');
  } else if (errSel) {
    cat = 'E4'; conf = 0.6; reasons.push('目标为 CSS/结构选择器，页面已渲染但元素未出现 → 条件/异步渲染未产出该元素');
  } else {
    cat = 'E7'; conf = 0.5; reasons.push('证据不足，无法归入 E1-E6');
  }

  // resolver 结果描述
  let resolver;
  if (laterSuccessFill) resolver = '后续 reload/wait 后同元素填充成功（元素可定位）';
  else if (isLoginWall) resolver = '登录拦截页，目标元素未渲染';
  else if (blankSnap) resolver = '快照为空，DOM 未挂载';
  else resolver = '始终未在 DOM 中定位到目标';

  // observation 状态简述
  let obsState;
  if (blankSnap) obsState = '空白页（SPA 未挂载）';
  else if (isLoginWall) obsState = 'SaaS 登录/控制台页（邮箱或密码错误）';
  else if (/戴尔|lg|飞利浦|华硕|明基/.test(low)) obsState = '电商商品列表页';
  else if (/下载示例文件|资源下载/.test(low)) obsState = '资源下载页';
  else if (/会员注册|提交注册/.test(low)) obsState = '会员注册表单页';
  else if (/购物车|搜索/.test(low)) obsState = '电商搜索/空结果页';
  else obsState = '其他已渲染页面';

  return {
    taskId: tid,
    name: t.name,
    rawStatus: t.rawStatus,
    actionType,
    target: errSel || (action && JSON.stringify(action.target)) || null,
    verifyExpect,
    resolver,
    observationState: obsState,
    failureEvidence: {
      errMsg: errMsg.slice(0, 200),
      diagnosing: diagCats,
      verificationFailureType: verifyFt,
      repairStrategies: repStrategies,
      laterSuccessFill,
      hasReloadWait,
    },
    category: cat,
    confidence: conf,
    reasons,
  };
}

const results = efTasks.map(analyzeOne);

// ---- 统计 ----
const DIST = {
  E1: 'selector失效',
  E2: '页面未ready',
  E3: 'iframe/shadow DOM',
  E4: 'dynamic loading',
  E5: 'semantic resolution错误',
  E6: 'permission/auth导致隐藏',
  E7: 'unknown',
};
const dist = {};
results.forEach((r) => { dist[r.category] = (dist[r.category] || 0) + 1; });
const total = results.length;
const distPct = {};
Object.keys(DIST).forEach((k) => { distPct[k] = dist[k] ? +(dist[k] / total * 100).toFixed(1) : 0; });

// 预计修复收益（仅分析估算，供 Phase 6 修复排期参考；不修改任何能力）
const fixBenefit = {
  E1: { desc: '验证/定位选择器鲁棒化（去除 [value=] 等脆属性、语义回退到稳定选择器）', recoverable: dist.E1 || 0, note: '元素实际可定位，仅选择器/验证表达式不匹配' },
  E2: { desc: 'wait-for-ready / SPA 挂载等待 + 重试退避', recoverable: dist.E2 || 0, note: '空白快照，等待后大概率可渲染' },
  E3: { desc: '跨 iframe/shadow DOM 上下文定位', recoverable: dist.E3 || 0, note: '需上下文切换能力' },
  E4: { desc: '等待异步/条件渲染完成后再定位', recoverable: dist.E4 || 0, note: '元素依赖数据/条件渲染' },
  E5: { desc: '页面状态/上下文感知 + 语义→稳定选择器映射', recoverable: dist.E5 || 0, note: '多因落在错误页面或语义解析错位' },
  E6: { desc: '鉴权/会话预置（benchmark 凭证修正或真实登录态）', recoverable: dist.E6 || 0, note: '受保护元素被登录墙替换' },
  E7: { desc: '需补充遥测后再判定', recoverable: 0, note: '证据不足' },
};

const out = {
  generatedAt: new Date().toISOString(),
  source: 'phase4 ELEMENT_NOT_FOUND subset (read-only)',
  total,
  distribution: dist,
  distributionPct: distPct,
  categoryLabels: DIST,
  fixBenefit,
  perCase: results,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

// ---- 控制台摘要 ----
console.log('Phase5 ELEMENT_NOT_FOUND 二级分类 (n=' + total + ')');
console.log('分布: ' + Object.keys(DIST).map((k) => `${k}=${dist[k] || 0}(${distPct[k]}%)`).join('  '));
console.log('');
results.forEach((r) => {
  console.log(`${r.category} (${r.confidence}) | ${r.name} | act=${r.actionType} | tgt=${r.target} | obs=${r.observationState}`);
  console.log(`   resolver: ${r.resolver}`);
  console.log(`   evidence: diag=${r.failureEvidence.diagnosing.join('/')} vft=${r.failureEvidence.verificationFailureType.join('/')} | ${r.failureEvidence.errMsg.slice(0, 90)}`);
});
console.log('\nWrote ' + OUT);
