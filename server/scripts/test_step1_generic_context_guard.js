'use strict';
// test_step1_generic_context_guard.js — STEP 1 去站点化专项测试
//
// 取代原 test_phase9_e5_context_guard.js。旧文件断言的是「期望站点 vs 当前站点类型」
// 的错配矩阵（saas / upload / download / shop），该前提在 STEP 1 已被证明错误：
//   phase68 100-task 运行时取证 —— 609 次 CONTEXT_WRONG_APP 中 553 次的理由
//   字面就是「期望站点=saas 但当前页面状态=GENERIC」。
// 本产品是通用 Web Operator，不存在「站点类型」这个可判定的输入。
//
// 本测试锁定新契约（动作前提校验 Page Capability Precondition）：
//   阻断：未就绪页(BLANK/LOADING) / 错误页 / upload×download 语义冲突 / 支付类无前提且能力非空
//   放行：只读观察 / 页面转场 / 证据不足（fail-open，避免过度阻断）
//   红线：源码中不得残留任何站点类型概念或 mock 站点品牌词

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contextGuard = require('../agent/contextGuard');
const classifier = require('../agent/pageStateClassifier');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

function obs(o) {
  return Object.assign({ url: '', title: '', textSummary: '', visibleText: '', elements: [] }, o);
}
const ps = (o) => classifier.classify(o);
const G = (a, o, opts) => contextGuard.guard(a, ps(o), opts === undefined ? { observation: o } : opts);

// ── 语料：刻意不使用任何 mock 站点品牌词（戴尔/LG/飞利浦/华硕/明基/cloudsaas）──
function genericLoginObs() {
  return obs({
    url: 'https://shop.example.com/login',
    title: 'Sign in',
    textSummary: 'Sign in to continue 邮箱 密码 登录',
    elements: [
      { tag: 'input', type: 'text', name: 'email', id: 'email', ariaLabel: '邮箱' },
      { tag: 'input', type: 'password', name: 'password', id: 'password', ariaLabel: '密码' },
      { tag: 'button', type: 'button', role: 'button', id: 'loginBtn', text: '登录' },
    ],
  });
}
function genericListingObs() {
  return obs({
    url: 'https://shop.example.com/products?page=2',
    title: 'Products',
    textSummary: '云服务器 2核4G 价格 ¥199 立即购买 共 32 条 下一页',
    elements: [
      { tag: 'a', role: 'link', text: '云服务器' },
      { tag: 'button', role: 'button', text: '立即购买' },
    ],
  });
}
function downloadOnlyObs() {
  return obs({
    url: 'https://files.example.com/download.html',
    title: '资源下载',
    textSummary: '资源下载 点击下面的链接下载 report.csv',
    elements: [{ tag: 'a', role: 'link', text: '下载 report.csv' }],
  });
}
function checkoutObs() {
  return obs({
    url: 'https://shop.example.com/checkout',
    title: '确认订单',
    textSummary: '确认订单 收货地址 合计 ¥199 提交订单',
    elements: [{ tag: 'button', role: 'button', text: '提交订单' }],
  });
}
function browserStartObs() {
  return obs({
    url: 'about:blank',
    title: 'Browser',
    textSummary: '欢迎使用 新建窗口 打开标签页 设置 书签 历史记录',
    elements: [{ tag: 'button', role: 'button', text: '新建窗口' }],
  });
}

(async () => {
  // ─────────────────────────────────────────────────────────
  section('Case 1  分类器去站点化：不依赖品牌词 / 不把兜底态归入电商');
  {
    const c1 = ps(genericListingObs());
    ok('1.1 无品牌词的通用列表页仍判 LISTING', c1.state === 'LISTING', 'got=' + c1.state);
    ok('1.2 LISTING 带 listing 能力标签', c1.capabilities.includes('listing'), JSON.stringify(c1.capabilities));

    const start = ps(browserStartObs());
    ok('1.3 浏览器起始页判 GENERIC（中立兜底，不再冒充电商页）', start.state === 'GENERIC', 'got=' + start.state);
    ok('1.4 GENERIC 的 toBucket 不再返回电商桶', classifier.toBucket('GENERIC').indexOf('电商') === -1,
      classifier.toBucket('GENERIC'));

    const login = ps(genericLoginObs());
    ok('1.5 登录页判 LOGIN_WALL', login.state === 'LOGIN_WALL', 'got=' + login.state);
    ok('1.6 登录页带 authentication 能力', login.capabilities.includes('authentication'), JSON.stringify(login.capabilities));

    const err = ps(obs({ url: 'https://x.com/nope', title: '404', textSummary: '404 页面不存在' }));
    ok('1.7 错误页判 ERROR', err.state === 'ERROR', 'got=' + err.state);
    ok('1.8 错误页带 error 能力', err.capabilities.includes('error'));

    const loading = ps(obs({ url: 'https://x.com/a', title: 'a', textSummary: '加载中...' }));
    ok('1.9 加载页判 LOADING', loading.state === 'LOADING', 'got=' + loading.state);

    const emptyCart = ps(obs({ url: 'https://x.com/cart', title: 'Cart', textSummary: '购物车：0 件' }));
    ok('1.10 空购物车判 EMPTY_RESULT（不再被误判成可结算页）', emptyCart.state === 'EMPTY_RESULT', 'got=' + emptyCart.state);

    const co = ps(checkoutObs());
    ok('1.11 结算页判 CHECKOUT', co.state === 'CHECKOUT', 'got=' + co.state);
    ok('1.12 结算页带 checkout + cart 能力', co.capabilities.includes('checkout') && co.capabilities.includes('cart'),
      JSON.stringify(co.capabilities));
  }

  // ─────────────────────────────────────────────────────────
  section('Case 2  E2 未就绪：BLANK / LOADING 上需元素动作仍阻断');
  {
    const blank = obs({ url: 'about:blank', title: '', textSummary: '', elements: [] });
    const loading = obs({ url: 'https://x.com/a', title: 'a', textSummary: '加载中...', elements: [] });
    for (const o of [blank, loading]) {
      const s = ps(o).state;
      const g = G({ type: 'fill', target: { semantic: '邮箱' } }, o);
      ok(`2.x fill on ${s} -> CONTEXT_NOT_READY`, g.blocked === true && g.code === 'CONTEXT_NOT_READY',
        JSON.stringify({ blocked: g.blocked, code: g.code }));
      const g2 = G({ type: 'click', target: { semantic: '登录按钮' } }, o);
      ok(`2.x click on ${s} -> blocked`, g2.blocked === true);
      // 转场动作不受 E2 约束：导航正是脱离未就绪页的手段
      const g3 = G({ type: 'navigate', target: { url: 'https://shop.example.com/login' } }, o);
      ok(`2.x navigate on ${s} -> NOT blocked`, g3.blocked === false, 'reason=' + g3.reason);
    }
  }

  // ─────────────────────────────────────────────────────────
  section('Case 3  错误页：改变状态的动作阻断，观察不阻断');
  {
    const err = obs({ url: 'https://x.com/nope', title: '404', textSummary: '404 页面不存在', elements: [] });
    const g = G({ type: 'click', target: { semantic: '提交' } }, err);
    ok('3.1 click 在错误页 -> 阻断', g.blocked === true && g.code === 'CONTEXT_WRONG_APP', JSON.stringify(g));
    ok('3.2 阻断 guardMode=error_page', g.guardMode === 'error_page', 'got=' + g.guardMode);
    const g2 = G({ type: 'inspect', target: { semantic: '页面' } }, err);
    ok('3.3 inspect 在错误页 -> 放行（保留诊断能力）', g2.blocked === false);
  }

  // ─────────────────────────────────────────────────────────
  section('Case 4  [核心回归] 转场动作不再被当前页形态误阻断');
  {
    // phase68 中 196 次 navigate 被阻断的真实场景：起始页/站点根 → 目标地址
    const g = G({ type: 'navigate', target: { url: 'https://shop.example.com/login' } }, browserStartObs());
    ok('4.1 浏览器起始页 → navigate 放行', g.blocked === false, 'reason=' + g.reason);
    ok('4.2 guardMode=destination', g.guardMode === 'destination');
    // 目标地址与动作目标冲突时仍阻断（不是 bypass，守卫对象换成了目的地）
    const g2 = G({ type: 'navigate', target: { url: 'https://files.example.com/download.html', semantic: '上传文件页面' } },
      browserStartObs());
    ok('4.3 navigate 目标为下载地址 + 动作目标=upload -> 阻断', g2.blocked === true && g2.code === 'CONTEXT_WRONG_APP',
      JSON.stringify({ blocked: g2.blocked, code: g2.code }));
    const g3 = G({ type: 'navigate', target: { url: 'https://files.example.com/upload.html', semantic: '上传文件页面' } },
      browserStartObs());
    ok('4.4 navigate 目标为上传地址 + 动作目标=upload -> 放行', g3.blocked === false, 'reason=' + g3.reason);
  }

  // ─────────────────────────────────────────────────────────
  section('Case 5  动作前提校验：upload × download 语义冲突');
  {
    const o = downloadOnlyObs();
    ok('5.1 分类器判 DOWNLOAD_PAGE', ps(o).state === 'DOWNLOAD_PAGE', 'got=' + ps(o).state);
    const g = G({ type: 'upload', target: { semantic: '头像上传控件', field: 'avatar' } }, o);
    ok('5.2 upload 在下载页 -> 阻断 CONTEXT_WRONG_APP', g.blocked === true && g.code === 'CONTEXT_WRONG_APP',
      JSON.stringify({ blocked: g.blocked, code: g.code }));
    const g2 = G({ type: 'download', target: { semantic: '下载 report.csv' } }, o);
    ok('5.3 download 在下载页 -> 放行', g2.blocked === false, 'reason=' + g2.reason);
    const g3 = G({ type: 'inspect', target: { semantic: '头像上传控件' } }, o);
    ok('5.4 inspect 在下载页 -> 放行（观察不产生副作用）', g3.blocked === false && g3.guardMode === 'read_only');
    // 具备 upload 能力的页面 → upload 放行
    const uploadable = obs({
      url: 'https://x.com/settings', title: '设置', textSummary: '上传头像',
      elements: [{ tag: 'input', type: 'file', name: 'avatar' }],
    });
    ok('5.5 有 file input 的页带 upload 能力', ps(uploadable).capabilities.includes('upload'),
      JSON.stringify(ps(uploadable).capabilities));
    const g4 = G({ type: 'upload', target: { semantic: '头像上传控件' } }, uploadable);
    ok('5.6 upload 在具备 upload 能力的页 -> 放行', g4.blocked === false, 'reason=' + g4.reason);
  }

  // ─────────────────────────────────────────────────────────
  section('Case 6  动作前提校验：支付类要求 cart/checkout/payment 能力');
  {
    // 列表页上发起支付：页面能力非空且不含任何支付能力 → 阻断
    const g = G({ type: 'payment', target: { semantic: '支付按钮' } }, genericListingObs());
    ok('6.1 payment 在列表页 -> 阻断', g.blocked === true && g.code === 'CONTEXT_WRONG_APP', JSON.stringify(g));
    ok('6.2 guardMode=capability_missing', g.guardMode === 'capability_missing', 'got=' + g.guardMode);
    ok('6.3 evidence 带 required/present 供诊断', !!(g.evidence && g.evidence.required && g.evidence.present),
      JSON.stringify(g.evidence));
    // 结算页上发起支付 → 放行（安全由 policy 独立把关，守卫不是安全闸门）
    const g2 = G({ type: 'payment', target: { semantic: '支付按钮' } }, checkoutObs());
    ok('6.4 payment 在结算页 -> 放行', g2.blocked === false, 'reason=' + g2.reason);
    const g3 = G({ type: 'checkout', target: { semantic: '去结算' } }, checkoutObs());
    ok('6.5 checkout 在结算页 -> 放行', g3.blocked === false);
    const g4 = G({ type: 'purchase', target: { semantic: '立即购买' } }, genericListingObs());
    ok('6.6 purchase 在列表页 -> 阻断（列表页无结算/支付能力）', g4.blocked === true, JSON.stringify(g4));
  }

  // ─────────────────────────────────────────────────────────
  section('Case 7  fail-open：能力证据缺失时绝不阻断（避免过度阻断）');
  {
    const noCap = { state: 'GENERIC', confidence: 0.6, signals: [], capabilities: [] };
    const g = contextGuard.guard({ type: 'payment', target: { semantic: '支付按钮' } }, noCap, {});
    ok('7.1 能力集合为空 -> 放行（宁可放行也不误杀）', g.blocked === false, JSON.stringify(g));
    const g2 = contextGuard.guard({ type: 'upload', target: { semantic: '上传' } }, noCap, {});
    ok('7.2 upload 在无能力证据页 -> 放行', g2.blocked === false);
    // 仅凭"缺少 upload 能力"不足以阻断；必须有 download 的正向反证
    const listingOnly = { state: 'LISTING', confidence: 0.7, signals: [], capabilities: ['navigation', 'listing'] };
    const g3 = contextGuard.guard({ type: 'upload', target: { semantic: '上传' } }, listingOnly, {});
    ok('7.3 upload 在无 download 反证的列表页 -> 放行（不做缺失即阻断）', g3.blocked === false, JSON.stringify(g3));
  }

  // ─────────────────────────────────────────────────────────
  section('Case 8  通用动作目标推导（deriveActionGoal）与安全职责分离');
  {
    ok('8.1 deriveActionGoal upload', contextGuard.deriveActionGoal({ type: 'upload', target: {} }) === 'upload');
    ok('8.2 deriveActionGoal download', contextGuard.deriveActionGoal({ type: 'download', target: {} }) === 'download');
    ok('8.3 deriveActionGoal payment', contextGuard.deriveActionGoal({ type: 'checkout', target: {} }) === 'payment');
    ok('8.4 deriveActionGoal authentication', contextGuard.deriveActionGoal({ type: 'login', target: {} }) === 'authentication');
    ok('8.5 deriveActionGoal 空目标 -> null', contextGuard.deriveActionGoal({ type: 'click', target: {} }) === null);

    const policy = require('../agent/policy');
    const task = { id: 't1', riskLevel: 'MEDIUM', permissions: {}, profileId: 'p1', objective: 'test' };
    for (const a of [
      { type: 'password_change', target: { semantic: '密码' }, value: 'newPass123' },
      { type: 'delete', target: { semantic: '删除账号按钮' } },
      { type: 'payment', target: { semantic: '支付按钮' } },
    ]) {
      const d = policy.allowsAction(a, task);
      ok('8.6 policy 对 ' + a.type + ' 仍独立判定（守卫不是安全闸门）',
        typeof d.allowed === 'boolean' && (d.allowed === false || d.requiresApproval === true), JSON.stringify(d));
    }
    // 敏感动作在具备能力的页面上：守卫放行，policy 独立拦截
    const g = G({ type: 'password_change', target: { semantic: '密码' } }, genericLoginObs());
    ok('8.7 登录页上 password_change 守卫放行（安全交由 policy）', g.blocked === false, 'reason=' + g.reason);
  }

  // ─────────────────────────────────────────────────────────
  section('Case 9  兼容性与防御');
  {
    ok('9.1 空 action/pageState 不抛异常', contextGuard.guard(null, null).blocked === false);
    // 旧调用签名（第三参数为站点字符串）不得崩溃，且该提示完全不参与判定
    const g = contextGuard.guard({ type: 'fill', target: { semantic: '任意字段' } }, { state: 'GENERIC', confidence: 0.6, signals: [] }, 'saas');
    ok('9.2 旧签名（站点字符串）不抛异常', g.blocked === false, JSON.stringify(g));
    ok('9.3 旧签名被标记为已忽略', g.legacySiteHintIgnored === 'saas', JSON.stringify(g.legacySiteHintIgnored));
    ok('9.4 三参数缺省 opts 不抛异常', contextGuard.guard({ type: 'click', target: {} }, { state: 'LISTING', confidence: 0.7, signals: [] }).blocked === false);
    ok('9.5 ELEMENT_ACTIONS 未被削弱', contextGuard.ELEMENT_ACTIONS.has('fill') && contextGuard.ELEMENT_ACTIONS.has('click') && contextGuard.ELEMENT_ACTIONS.has('upload'));
    ok('9.6 READ_ONLY_ACTIONS 未含会改变状态的动作', !contextGuard.READ_ONLY_ACTIONS.has('click') && !contextGuard.READ_ONLY_ACTIONS.has('fill'));
  }

  // ─────────────────────────────────────────────────────────
  section('Case 10  [红线] 源码中不得残留站点类型概念 / mock 站点品牌词');
  {
    const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    const guardSrc = src('agent/contextGuard.js');
    const clsSrc = src('agent/pageStateClassifier.js');
    const all = guardSrc + '\n' + clsSrc;
    const banned = [
      ['saas 站点概念', /saas/i],
      ['期望站点 expectedSite', /expectedSite/i],
      ['站点错配矩阵 SITE_CONFLICT', /SITE_CONFLICT/],
      ['mock 品牌词 戴尔', /戴尔/],
      ['mock 品牌飞利浦', /飞利浦/],
      ['mock 品牌 华硕', /华硕/],
      ['mock 品牌 明基', /明基/],
      ['cloudsaas', /cloudsaas/i],
      ['电商桶硬编码', /电商商品列表页/],
    ];
    for (const [name, re] of banned) {
      ok('10.x 源码不含 ' + name, !re.test(all), '命中：' + (all.match(re) || [])[0]);
    }
    ok('10.9 守卫导出不再含 deriveExpectedSite', contextGuard.deriveExpectedSite === undefined);
    ok('10.10 守卫导出仍含 guard', typeof contextGuard.guard === 'function');
    ok('10.11 分类器导出 capabilities 相关能力', typeof classifier.detectCapabilities === 'function');
  }

  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
