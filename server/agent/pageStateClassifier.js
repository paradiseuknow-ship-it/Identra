'use strict';

// Phase 6.1 — Page State Classifier（STEP 1 去站点化重写版）
//
// 性质：READ-ONLY 分类器。自身不改变任何行为语义，不判成功，不写状态。
//
// 输入：一次页面观察（observation），可接受：
//   - { visibleTexts: string[], url?, title?, elements?[] }
//   - { textSummary: string, url?, title?, elements?[] }
//   - 或上述字段的混合。
// 输出：{ state, confidence, signals: string[], capabilities: string[] }
//
// ── 为什么重写（STEP 1）────────────────────────────────────────────────────
// 旧实现把「站点品类」硬编码进分类器：
//   - 用 mock 压测站点独有的若干品牌名作为「商品列表」的判定信号；
//   - 把兜底态 GENERIC 一律映射到「某个具体行业的列表页」桶。
// 后果：真实互联网上任何不含那些品牌词的页面都不被识别为列表；
//       而任何无特征页面都被当成该行业页面，进而在守卫里被判成「上下文错误」。
// phase68 100-task 中 609 次 CONTEXT_WRONG_APP 有 553 次源于此链路。
// 本产品是通用 Web Operator，不存在「站点品类」这一概念。
//
// ── 设计原则（STEP 1）──────────────────────────────────────────────────────
// 1. 状态只描述「页面正在提供什么能力」，不描述「这是哪个站点/行业」。
// 2. 判定信号通用：登录墙、错误页、空结果、列表、详情、结算、支付、回执
//    是所有网站共有的形态，与品牌、品类、行业无关。
// 3. 兜底态 GENERIC 保持中立，绝不归入任何具体类别。
// 4. 额外输出 capabilities（能力标签），供 contextGuard 做「动作前提校验」，
//    替代原来的「期望站点 vs 当前站点」矛盾矩阵。

// 状态枚举（与站点/行业无关）
const STATES = [
  'BLANK',          // 空白页（SPA 未挂载 / 未就绪）
  'LOADING',        // 加载中（骨架屏 / 加载提示 / spinner）
  'ERROR',          // 错误页（404 / 500 / 拒绝访问 / 加载失败）
  'LOGIN_WALL',     // 登录 / 鉴权拦截页
  'REGISTRATION',   // 注册 / 开户表单页
  'DOWNLOAD_PAGE',  // 资源下载页
  'PAYMENT',        // 支付页
  'CHECKOUT',       // 结算 / 购物车页
  'CONFIRMATION',   // 成功 / 回执页
  'EMPTY_RESULT',   // 空结果 / 无数据页
  'LISTING',        // 列表 / 搜索结果页
  'DETAIL',         // 详情页
  'FORM_PAGE',      // 表单页（有输入控件但无上述特征）
  'GENERIC',        // 其他已渲染页面（中立兜底）
];

// ── 通用信号（不含任何品牌词 / 品类名 / mock 站点特征）────────────────────
const RE = {
  LOADING: /(加载中|正在加载|加载中\.\.\.|请稍候|请稍等|loading\.\.\.|loading\s?\.\.\.|please wait|just a moment|正在处理|处理中)/i,
  ERROR: /(\b(404|403|500|502|503|504)\b|页面不存在|页面无法访问|页面走丢了|页面已失效|服务器错误|服务不可用|网关错误|请求失败|加载失败|出错了|发生错误|internal server error|not found|something went wrong|went wrong|access denied|service unavailable|bad gateway)/i,
  LOGIN: /(邮箱或密码错误|密码错误|用户名或密码|登录失效|账号或密码|请输入密码|请登录|请先登录|未登录|需要登录|重新登录|会话已过期|登录已过期|sign\s?in|log\s?in|login|authenticate)/i,
  LOGIN_URL: /(\/login|\/signin|\/sign-in|\/auth|\/session\/new|\/passport)/i,
  REGISTER: /(会员注册|提交注册|注册账号|注册新用户|创建账号|立即注册|免费注册|sign\s?up|create account|register now|join now)/i,
  DOWNLOAD: /(资源下载|下载示例文件|点击下面的链接下载|文件下载|点击下载|download\s?now|save file|\.zip|\.csv|\.pdf)/i,
  PAYMENT: /(支付金额|确认支付|立即支付|去支付|支付方式|银行卡|信用卡|卡号|有效期|cvv|cvc|pay\s?now|proceed to payment|payment method|card number|支付宝|微信支付|apple pay|google pay)/i,
  CHECKOUT: /(去结算|结算|确认订单|提交订单|下单|购物车|购物袋|checkout|place order|shopping cart|order summary)/i,
  CONFIRMATION: /(下单成功|提交成功|支付成功|创建成功|保存成功|操作成功|已提交|已完成|订单号|流水号|thank you|successfully|order\s?id|confirmation|receipt)/i,
  EMPTY: /(未找到|没有找到|无搜索结果|暂无数据|没有数据|暂无记录|没有记录|空空如也|no results|no records|no data|nothing found|0\s*results)/i,
  // 空购物车是「空结果」的一种，必须在 CHECKOUT 之前判定，否则会被误判为可结算页
  EMPTY_CART: /(购物车[：:]?\s*0|购物车为空|购物车是空的|cart[:\s]*0\b|0\s*items?|your cart is empty|empty cart)/i,
  LISTING: /(加入购物车|add to cart|价格|¥\s?\d|\$\s?\d|\d+\.\d+\s*元|sku|商品列表|下一页|上一页|共\s*\d+\s*条|第\s*\d+\s*页|next page|pagination|sort by|filter)/i,
  LISTING_URL: /(\/(products?|items?|goods|list|search|category|catalog|results?)(\/|\?|$|s\b))|(\?|&)(page|q|query|keyword|category)=/i,
  DETAIL: /(商品详情|产品详情|详情描述|规格参数|图文详情|product detail|item detail|description)/i,
  DETAIL_URL: /(\/(product|item|goods|detail|p)\/[^/]+|\/detail|\/dp\/)/i,
};

function extractText(obs) {
  if (!obs) return { text: '', url: '', title: '', elements: [] };
  const texts = Array.isArray(obs.visibleTexts) ? obs.visibleTexts : [];
  const text = (texts.join(' ') || obs.textSummary || obs.text || '').replace(/\s+/g, ' ').trim();
  const url = obs.url || '';
  const title = obs.title || '';
  const elements = Array.isArray(obs.elements) ? obs.elements : [];
  return { text, url, title, elements };
}

function elHaystack(el) {
  if (!el) return '';
  return String(
    [el.name, el.type, el.id, el.text, el.ariaLabel, el.placeholder, el.label, el.roleText, el.role, el.tag].filter(Boolean).join(' ')
  ).toLowerCase();
}

// ── 能力标签识别（结构性证据优先于文本关键词）──────────────────────────────
function detectCapabilities(obs, state) {
  const { text, url, elements } = obs;
  const low = text.toLowerCase();
  const caps = new Set();

  const isPassword = (e) => String(e.type || '').toLowerCase() === 'password' || /password|密码|passwd/.test(elHaystack(e));
  const isFileInput = (e) => String(e.type || '').toLowerCase() === 'file' || /上传|upload|dropzone|拖拽到此|drag.*drop/.test(elHaystack(e));
  const isFormField = (e) => {
    const tag = String(e.tag || '').toLowerCase();
    const type = String(e.type || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type);
    }
    return false;
  };
  const isLink = (e) => String(e.tag || '').toLowerCase() === 'a' || String(e.role || '').toLowerCase() === 'link';
  const isSearchBox = (e) => /search|搜索|查询|keyword|关键词/.test(elHaystack(e));

  if (elements.some(isLink)) caps.add('navigation');
  if (state === 'LOGIN_WALL' || elements.some(isPassword)) caps.add('authentication');
  if (state === 'REGISTRATION' || RE.REGISTER.test(text)) caps.add('registration');
  if (elements.some(isSearchBox) || /搜索|search/.test(low)) caps.add('search');
  if (elements.some(isFileInput)) caps.add('upload');
  if (state === 'DOWNLOAD_PAGE' || /下载|download/.test(low) || /download/i.test(url)) caps.add('download');
  if (elements.some(isFormField)) caps.add('form');
  if (state === 'LISTING') caps.add('listing');
  if (state === 'DETAIL') caps.add('detail');
  if (state === 'CHECKOUT') { caps.add('cart'); caps.add('checkout'); }
  if (state === 'PAYMENT') caps.add('payment');
  if (state === 'CONFIRMATION') caps.add('confirmation');
  if (state === 'ERROR') caps.add('error');
  if (state === 'LOADING') caps.add('loading');

  // CHECKOUT/PAYMENT 的文本兜底（有些站点的结算区是纯 DOM 组件，无文本特征）
  if (!caps.has('cart') && RE.CHECKOUT.test(text)) caps.add('cart');
  if (!caps.has('payment') && RE.PAYMENT.test(text)) caps.add('payment');

  return Array.from(caps);
}

// 单信号判定，返回 { state, confidence, signals[], capabilities[] }
function detect(obs) {
  const o = extractText(obs);
  const { text, url, title, elements } = o;
  const low = text.toLowerCase();
  const urlLow = url.toLowerCase();
  const titleLow = title.toLowerCase();
  const out = { state: null, confidence: 0, signals: [], capabilities: [] };

  const done = (state, confidence, signal) => {
    out.state = state;
    out.confidence = confidence;
    if (signal) out.signals.push(signal);
    out.capabilities = detectCapabilities(o, state);
    return out;
  };

  // 1) BLANK：可见文本为空 → SPA 未挂载 / 未就绪
  if (text.length === 0) return done('BLANK', 0.95, 'visibleTexts 为空（SPA 未挂载/未就绪）');

  // 2) LOADING：加载中
  if (RE.LOADING.test(text)) return done('LOADING', 0.8, '检测到加载中信号');

  // 3) ERROR：错误页（先于 LOGIN_WALL：404/500 页面常含「登录」导航）
  if (RE.ERROR.test(text) || RE.ERROR.test(title)) return done('ERROR', 0.9, '检测到错误页信号');

  // 4) LOGIN_WALL：登录 / 鉴权拦截
  if (RE.LOGIN.test(low) || RE.LOGIN_URL.test(urlLow) || /登录|sign in|log in/.test(titleLow)) {
    return done('LOGIN_WALL', 0.9, '检测到登录/鉴权拦截信号');
  }

  // 5) REGISTRATION：注册 / 开户表单
  if (RE.REGISTER.test(text) || /注册|sign up/.test(titleLow)) {
    return done('REGISTRATION', 0.88, '检测到注册表单页信号');
  }

  // 6) DOWNLOAD_PAGE：资源下载页
  if (RE.DOWNLOAD.test(low)) return done('DOWNLOAD_PAGE', 0.9, '检测到资源下载页信号');

  // 「加入购物车 / add to cart」是列表页上的动作按钮，不是结算页特征。
  // 判定结算/购物车类形态前先剔除，否则任何带加购按钮的列表页都会被误判成 CHECKOUT。
  const noAddToCart = text.replace(/加入购物车|add\s*to\s*cart/gi, '');

  // 6.5) 空购物车 / 空结果购物车：先于 CHECKOUT 判定
  if (RE.EMPTY_CART.test(noAddToCart)) return done('EMPTY_RESULT', 0.85, '检测到空购物车信号');

  // 7) PAYMENT：支付页
  if (RE.PAYMENT.test(text)) return done('PAYMENT', 0.85, '检测到支付页信号');

  // 8) CHECKOUT：结算 / 购物车
  if (RE.CHECKOUT.test(noAddToCart)) return done('CHECKOUT', 0.85, '检测到结算/购物车页信号');

  // 9) CONFIRMATION：成功 / 回执
  if (RE.CONFIRMATION.test(text)) return done('CONFIRMATION', 0.85, '检测到成功/回执页信号');

  // 10) EMPTY_RESULT：空结果（优先于 LISTING，因更具体）
  if (RE.EMPTY.test(text)) return done('EMPTY_RESULT', 0.8, '检测到空结果/无数据信号');

  // 11) LISTING：列表 / 搜索结果（通用信号：分页 / 排序 / 价格 / 加购 / 条目数）
  if (RE.LISTING.test(text) || RE.LISTING_URL.test(urlLow) || elements.length >= 8) {
    return done('LISTING', 0.7, '检测到列表/搜索结果页信号');
  }

  // 12) DETAIL：详情页
  if (RE.DETAIL.test(text) || RE.DETAIL_URL.test(urlLow) || /详情|detail/i.test(titleLow)) {
    return done('DETAIL', 0.7, '检测到详情页信号');
  }

  // 13) FORM_PAGE：有表单控件但无上述特征
  if (elements.some((e) => {
    const tag = String(e.tag || '').toLowerCase();
    const type = String(e.type || '').toLowerCase();
    return (tag === 'input' || tag === 'select' || tag === 'textarea') && !['hidden', 'submit', 'button'].includes(type);
  })) {
    return done('FORM_PAGE', 0.65, '检测到表单控件但无更强特征');
  }

  // 14) GENERIC：中立兜底（STEP 1：不再归入任何具体类别）
  return done('GENERIC', 0.6, '已渲染但无明确形态特征，归为 GENERIC（中立兜底）');
}

function classify(obs) {
  return detect(obs);
}

// 状态 → 人类可读标签（STEP 1：取代旧的桶映射表）
// 旧的映射表把兜底态 GENERIC 一律归入某个具体行业类别，是品类假设的来源之一，已废弃。
const STATE_LABEL = {
  BLANK: '空白页（SPA 未挂载）',
  LOADING: '加载中页',
  ERROR: '错误页',
  LOGIN_WALL: '登录/鉴权拦截页',
  REGISTRATION: '注册表单页',
  DOWNLOAD_PAGE: '资源下载页',
  PAYMENT: '支付页',
  CHECKOUT: '结算/购物车页',
  CONFIRMATION: '成功/回执页',
  EMPTY_RESULT: '空结果/无数据页',
  LISTING: '列表/搜索结果页',
  DETAIL: '详情页',
  FORM_PAGE: '表单页',
  GENERIC: '通用页面（无明确形态特征）',
};

function toBucket(state) {
  return STATE_LABEL[state] || STATE_LABEL.GENERIC;
}

module.exports = { classify, extractText, detectCapabilities, toBucket, STATE_LABEL, STATES };
