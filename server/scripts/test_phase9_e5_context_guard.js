'use strict';
// test_phase9_e5_context_guard.js — Phase 9 P0：E5 误阻断修复专项测试
//
// 背景（phase68 100-task 真实数据）：
//   224 次 CONTEXT_WRONG_APP 中 196 次发生在 `navigate` 动作上，目标恒为
//   /saas/login.html，原因为守卫用「导航前当前页状态」判定站点矛盾。
//
// 本测试锁定修复后的行为边界：
//   放行：转场动作（上下文=目标地址） / 只读观察动作 / GENERIC + 强 SaaS 证据
//   阻断：GENERIC + 证据不足 / 明确错误上下文 / 目标地址与语义冲突 / 敏感动作策略
const assert = require('assert');
const contextGuard = require('../agent/contextGuard');
const classifier = require('../agent/pageStateClassifier');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// —— 构造 observation ——
function obs(o) {
  return Object.assign({ url: '', title: '', textSummary: '', visibleText: '', elements: [] }, o);
}
// 真实 SaaS 登录页（mock-site/saas/login.html）：title 含 CloudSaaS/控制台，
// url 含 /saas/，DOM 有 email + password + 登录按钮。
function saasLoginObs() {
  return obs({
    url: 'http://127.0.0.1:2963/saas/login.html',
    title: 'CloudSaaS - 控制台登录',
    textSummary: 'CloudSaaS 控制台 企业邮箱 密码 登录',
    elements: [
      { tag: 'input', type: 'text', name: 'email', id: 'email', ariaLabel: '企业邮箱' },
      { tag: 'input', type: 'password', name: 'password', id: 'password', ariaLabel: '密码' },
      { tag: 'button', type: 'button', role: 'button', id: 'loginBtn', text: '登录', ariaLabel: '登录按钮' },
    ],
  });
}
// 浏览器启动后的默认落地页（startupUrls: [] → 内置欢迎/起始页）：
// 有可见文本但无任何应用特征，分类器正确地判为 GENERIC —— 这正是 phase68 中
// 196 次 navigate 被误阻断时「当前页」的真实形态。
function browserStartObs() {
  return obs({
    url: 'about:blank',
    title: 'Browser',
    textSummary: '欢迎使用 新建窗口 打开标签页 设置 书签 历史记录',
    elements: [{ tag: 'button', type: 'button', role: 'button', text: '新建窗口' }],
  });
}
// 站点根（目录列表）—— 同样无任何应用特征
function siteRootObs() {
  return obs({
    url: 'http://127.0.0.1:2963/',
    title: 'Index of /',
    textSummary: 'admin data_entry ecommerce misc saas scraping',
    elements: [{ tag: 'a', type: 'a', role: 'link', text: 'saas/' }],
  });
}
function downloadPageObs() {
  return obs({
    url: 'http://127.0.0.1:2963/download.html',
    title: '资源下载',
    textSummary: '资源下载 下载示例文件 点击下面的链接下载 report.csv',
    elements: [{ tag: 'a', type: 'a', role: 'link', text: '下载示例文件' }],
  });
}
function shopListingObs() {
  return obs({
    url: 'http://127.0.0.1:2963/ecommerce/list.html',
    title: '商品列表',
    textSummary: '戴尔 显示器 ¥1999 加入购物车',
    elements: [{ tag: 'button', type: 'button', role: 'button', text: '加入购物车' }],
  });
}

const ps = (o) => classifier.classify(o);
const G = (a, o, site) => contextGuard.guard(a, ps(o), site, { observation: o });

(async () => {
  // ─────────────────────────────────────────────────────────
  section('Case 1  真实 SaaS 登录页：classifier 识别 + 无 E5 + 动作放行');
  {
    const o = saasLoginObs();
    const c = ps(o);
    ok('1.1 classifier 命中 LOGIN_WALL', c.state === 'LOGIN_WALL', 'got=' + c.state);
    const action = { type: 'fill', target: { semantic: '企业邮箱输入框', field: 'email' }, value: 'ops@cloudsaas.io' };
    const g = G(action, o);
    ok('1.2 fill 不被阻断', g.blocked === false, 'reason=' + g.reason);
    ok('1.3 E5 计数为 0（code 为空）', g.code === null);
    // 登录后 dashboard（同一 URL/SPA）：仍可继续操作
    const dash = obs({
      url: 'http://127.0.0.1:2963/saas/login.html',
      title: 'CloudSaaS - 控制台登录',
      textSummary: 'CloudSaaS 控制台 企业邮箱 密码 登录 数据看板 本月活跃用户 导出 CSV',
      elements: [{ tag: 'button', type: 'button', role: 'button', id: 'exportBtn', text: '导出 CSV', ariaLabel: '导出报表按钮' }],
    });
    const g2 = G({ type: 'click', target: { semantic: '导出报表按钮' } }, dash);
    ok('1.4 dashboard 上 click 不被阻断', g2.blocked === false, 'reason=' + g2.reason);
  }

  // ─────────────────────────────────────────────────────────
  section('Case 2  SaaS 页面但证据不完整：不得 silent allow');
  {
    // 2a. 仅可见文本含 SaaS 语义，但 URL/title 无结构性身份 → 证据不足 → 阻断
    const textOnly = obs({
      url: 'http://example.com/page1',
      title: 'page1',
      textSummary: '控制台 数据看板 活跃用户 工作台',
      elements: [{ tag: 'input', type: 'text', name: 'email' }, { tag: 'input', type: 'password', name: 'pwd' }],
    });
    ok('2.1 classifier 判 GENERIC', ps(textOnly).state === 'GENERIC');
    const g = G({ type: 'fill', target: { semantic: 'saas 邮箱输入框' } }, textOnly);
    ok('2.2 无结构性身份 → 阻断（不 silent allow）', g.blocked === true && g.code === 'CONTEXT_WRONG_APP', 'blocked=' + g.blocked);

    // 2b. 只有 URL 结构性身份、无佐证 → score=1 → 阻断
    const urlOnly = obs({ url: 'http://x/saas/blank.html', title: 'x', textSummary: 'hello world', elements: [] });
    const ev = contextGuard.saasEvidence(urlOnly);
    ok('2.3 仅 1 条证据时 allow=false', ev.allow === false, JSON.stringify(ev));
    const g2 = G({ type: 'click', target: { semantic: 'saas 某按钮' } }, urlOnly);
    ok('2.4 仅 1 条证据 → 仍阻断', g2.blocked === true, 'blocked=' + g2.blocked);

    // 2c. 结构性身份 + 1 条佐证 = 2 → 放行
    const twoSig = obs({
      url: 'http://x/saas/settings.html', title: 'Settings',
      textSummary: '租户 工作区 组织设置',
      elements: [{ tag: 'input', type: 'text', name: 'email' }, { tag: 'input', type: 'password', name: 'password' }],
    });
    const ev2 = contextGuard.saasEvidence(twoSig);
    ok('2.5 结构性身份 + 佐证 → allow=true', ev2.allow === true && ev2.score >= 2, JSON.stringify(ev2));
    ok('2.6 放行时带 evidence 供 telemetry', G({ type: 'fill', target: { semantic: 'saas 设置项' } }, twoSig).evidence !== null);
  }

  // ─────────────────────────────────────────────────────────
  section('Case 3  Generic 页面 + expected SaaS：必须 BLOCK');
  {
    const o = siteRootObs();
    ok('3.1a 站点根目录判 GENERIC', ps(o).state === 'GENERIC', 'got=' + ps(o).state);
    ok('3.1b 浏览器起始页判 GENERIC', ps(browserStartObs()).state === 'GENERIC', 'got=' + ps(browserStartObs()).state);
    // 非转场、非只读的元素动作，且无 SaaS 证据 → 阻断
    const g = G({ type: 'fill', target: { semantic: '企业邮箱输入框' } }, o, 'saas');
    ok('3.2 fill（非转场/非只读）在 GENERIC 无证据页 → BLOCK', g.blocked === true && g.code === 'CONTEXT_WRONG_APP', 'blocked=' + g.blocked);
    const g2 = G({ type: 'click', target: { semantic: '登录按钮' } }, o, 'saas');
    ok('3.3 click 同上 → BLOCK', g2.blocked === true);
    // 电商列表页 vs 期望 SaaS：明确错配，必须阻断
    const g3 = G({ type: 'fill', target: { semantic: 'saas 字段' } }, shopListingObs(), 'saas');
    ok('3.4 商品列表页 vs 期望 SaaS → BLOCK', g3.blocked === true && g3.code === 'CONTEXT_WRONG_APP');
    // 注册页 vs 期望 SaaS：必须阻断（title 不含「注册/登录」以免被规则2优先命中为 LOGIN_WALL）
    const reg = obs({
      url: 'http://x/reg.html', title: 'Create Account',
      textSummary: '会员注册 提交注册 注册账号',
      elements: [{ tag: 'button', type: 'button', role: 'button', text: '提交注册' }],
    });
    ok('3.5a 注册页判 REGISTRATION', ps(reg).state === 'REGISTRATION', 'got=' + ps(reg).state);
    ok('3.5b 注册页 vs 期望 SaaS → BLOCK', G({ type: 'fill', target: { semantic: 'saas 字段' } }, reg, 'saas').blocked === true);
    // 空搜索结果页 vs 期望 SaaS：必须阻断
    const emptyShop = obs({ url: 'http://x/shop/search', title: '搜索', textSummary: '未找到相关商品 购物车：0', elements: [] });
    ok('3.6 SHOP_SEARCH_EMPTY vs 期望 SaaS → BLOCK', G({ type: 'fill', target: { semantic: 'saas 字段' } }, emptyShop, 'saas').blocked === true);
  }

  // ─────────────────────────────────────────────────────────
  section('Case 4  明确错误上下文：必须 BLOCK（含转场目标地址冲突）');
  {
    // 4a. 上传任务落在下载页（phase68 中 28 次的真实场景）→ 阻断
    const o = downloadPageObs();
    ok('4.1 分类器判 DOWNLOAD_PAGE', ps(o).state === 'DOWNLOAD_PAGE', 'got=' + ps(o).state);
    const g = G({ type: 'upload', target: { semantic: '头像上传控件', field: 'avatar' } }, o);
    ok('4.2 upload 在下载页 → BLOCK', g.blocked === true && g.code === 'CONTEXT_WRONG_APP');
    // 4b. 转场动作的「目标地址」与语义冲突 → 仍阻断（不是 bypass）
    const g2 = G({ type: 'navigate', target: { url: 'http://127.0.0.1:2963/download.html', semantic: '上传文件页面' } }, o, 'upload');
    ok('4.3 navigate 到下载页 + expectedSite=upload → BLOCK（目标地址冲突）', g2.blocked === true, 'blocked=' + g2.blocked);
    // 4c. 正确的转场目标 → 放行
    const g3 = G({ type: 'navigate', target: { url: 'http://127.0.0.1:2963/data_entry/upload.html' } }, o, 'upload');
    ok('4.4 navigate 到上传页 + expectedSite=upload → PASS', g3.blocked === false, 'reason=' + g3.reason);
    // 4d. BLANK 页上元素动作 → E2 阻断仍生效
    const blank = obs({ url: 'about:blank', title: '', textSummary: '', elements: [] });
    ok('4.5 BLANK 页判 BLANK', ps(blank).state === 'BLANK');
    const g5 = G({ type: 'fill', target: { semantic: '邮箱' } }, blank);
    ok('4.6 fill 在 BLANK 页 → CONTEXT_NOT_READY 阻断', g5.blocked === true && g5.code === 'CONTEXT_NOT_READY');
    const g6 = G({ type: 'navigate', target: { url: 'http://127.0.0.1:2963/saas/login.html' } }, blank);
    ok('4.7 navigate 在 BLANK 页 → PASS（转场不受 E2 约束）', g6.blocked === false, 'reason=' + g6.reason);
  }

  // ─────────────────────────────────────────────────────────
  section('Case 5  敏感动作：安全策略不变（守卫不绕过 policy，且不因 P0 放宽）');
  {
    const policy = require('../agent/policy');
    const task = { id: 't1', riskLevel: 'MEDIUM', permissions: {}, profileId: 'p1', objective: 'test' };
    // password_change / delete / payment 等应继续被 policy 审批或拦截
    const sensitive = [
      { type: 'password_change', target: { semantic: '密码' }, value: 'newPass123' },
      { type: 'delete', target: { semantic: '删除账号按钮' } },
      { type: 'payment', target: { semantic: '支付按钮' } },
    ];
    for (const a of sensitive) {
      const d = policy.allowsAction(a, task);
      ok('5.x policy 对 ' + a.type + ' 仍有策略判定（非直接放行）',
        typeof d.allowed === 'boolean' && (d.allowed === false || d.requiresApproval === true),
        JSON.stringify(d));
    }
    // 守卫本身不得因敏感动作而放行错误上下文
    const g = G({ type: 'password_change', target: { semantic: 'saas 密码字段' } }, siteRootObs(), 'saas');
    ok('5.4 敏感动作在 GENERIC 无证据页 → 守卫仍 BLOCK', g.blocked === true);
    // 真实 SaaS 页上敏感动作：守卫放行，但 policy 仍独立拦截（守卫不是安全闸门）
    const g2 = G({ type: 'password_change', target: { semantic: '密码' } }, saasLoginObs());
    ok('5.5 真实 SaaS 页上守卫不阻断（安全由 policy 独立负责）', g2.blocked === false);
    const d2 = policy.allowsAction({ type: 'password_change', target: { semantic: '密码' }, value: 'x' }, task);
    ok('5.6 policy 对 password_change 仍要求审批/拒绝', d2.allowed === false || d2.requiresApproval === true, JSON.stringify(d2));
  }

  // ─────────────────────────────────────────────────────────
  section('Case 6  Regression：E5 原有语义仍存在');
  {
    ok('6.1 ELEMENT_ACTIONS 未被削弱', contextGuard.ELEMENT_ACTIONS.has('fill') && contextGuard.ELEMENT_ACTIONS.has('click') && contextGuard.ELEMENT_ACTIONS.has('upload'));
    ok('6.2 SITE_CONFLICT.saas 仍含 DOWNLOAD_PAGE/REGISTRATION/PRODUCT_LISTING',
      ['DOWNLOAD_PAGE', 'REGISTRATION', 'PRODUCT_LISTING'].every((s) => contextGuard.SITE_CONFLICT.saas.includes(s)));
    ok('6.3 E5 错误码仍为 CONTEXT_WRONG_APP', G({ type: 'upload', target: { semantic: '上传' } }, downloadPageObs()).code === 'CONTEXT_WRONG_APP');
    ok('6.4 deriveExpectedSite 语义不变', contextGuard.deriveExpectedSite({ target: { url: '/saas/x' } }) === 'saas'
      && contextGuard.deriveExpectedSite({ target: { semantic: '上传文件' } }) === 'upload'
      && contextGuard.deriveExpectedSite({ target: {} }) === null);
    // 无 observation（老调用签名 / opts 缺失）时不得崩溃，且 GENERIC 无证据仍阻断
    const g = contextGuard.guard({ type: 'fill', target: { semantic: 'saas 字段' } }, { state: 'GENERIC', confidence: 0.6, signals: [] }, 'saas');
    ok('6.5 缺省 observation（向后兼容）→ 阻断而非放行', g.blocked === true, 'blocked=' + g.blocked);
    // 三参数老签名仍可用
    const g2 = contextGuard.guard({ type: 'navigate', target: { url: '/saas/login.html' } }, { state: 'GENERIC', confidence: 0.6, signals: [] });
    ok('6.6 三参数老签名：navigate 不再被误阻断', g2.blocked === false);
    // 空输入防御
    ok('6.7 空 action/pageState 不抛异常', contextGuard.guard(null, null).blocked === false);
    // 核心回归：phase68 中被阻断的真实 navigate 现在必须放行
    const g3 = G({ type: 'navigate', target: { url: 'http://127.0.0.1:2963/saas/login.html' } }, browserStartObs());
    ok('6.8a [核心回归] 浏览器起始页 → navigate /saas/login.html 放行', g3.blocked === false, 'reason=' + g3.reason);
    ok('6.8b [核心回归] 站点根目录 → navigate /saas/login.html 放行', G({ type: 'navigate', target: { url: 'http://127.0.0.1:2963/saas/login.html' } }, siteRootObs()).blocked === false);
    // 只读观察动作不再被页面语义矛盾阻断
    const insp = G({ type: 'inspect', target: { semantic: '头像上传控件' } }, downloadPageObs());
    ok('6.10 [回归] inspect 在下载页不再被阻断（观察不产生副作用）', insp.blocked === false, 'reason=' + insp.reason);
    ok('6.11 [回归] inspect 放行标记 guardMode=read_only', insp.guardMode === 'read_only');
    // 但会改变状态的动作在同样页面上仍被阻断
    ok('6.12 [回归] upload 在下载页仍被阻断（E5 语义保留）',
      G({ type: 'upload', target: { semantic: '头像上传控件' } }, downloadPageObs()).blocked === true);
  }

  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
