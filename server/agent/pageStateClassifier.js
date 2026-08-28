'use strict';

// Phase 6.1 — Page State Classifier (READ-ONLY classifier; no behavior change by itself).
//
// 输入：一次页面观察（observation），可接受：
//   - { visibleTexts: string[], url?, title? }
//   - { textSummary: string, url?, title? }
//   - 或上述字段的混合。
// 输出：{ state, confidence, signals: string[] }
//
// 状态枚举（与 Phase 5 observationState 对齐，便于回放校验）：
//   LOGIN_WALL        登录/鉴权拦截页（含 SaaS 控制台登录态、密码错误等）
//   DOWNLOAD_PAGE     资源下载页（与上传任务语义冲突时为错误上下文）
//   REGISTRATION      会员/账号注册表单页
//   PRODUCT_LISTING   电商商品列表页（含品牌名 / 价格 / 加入购物车）
//   SHOP_SEARCH_EMPTY 电商搜索空结果页（购物车：0 / 未找到相关商品）
//   BLANK             空白页（SPA 未挂载 / 未就绪）
//   GENERIC           其他已渲染页面（兜底）

function extractText(obs) {
  if (!obs) return { text: '', url: '', title: '' };
  const texts = Array.isArray(obs.visibleTexts) ? obs.visibleTexts : [];
  const text = (texts.join(' ') || obs.textSummary || obs.text || '').replace(/\s+/g, ' ').trim();
  const url = obs.url || '';
  const title = obs.title || '';
  return { text, url, title };
}

// 单信号判定，返回 { hit, conf, signals[] }
function detect(obs) {
  const { text, url, title } = extractText(obs);
  const low = text.toLowerCase();
  const urlLow = url.toLowerCase();
  const titleLow = title.toLowerCase();
  const out = { state: null, confidence: 0, signals: [] };

  // 1) BLANK：可见文本为空或仅空白 → SPA 未挂载 / 未就绪
  if (text.length === 0) {
    return { state: 'BLANK', confidence: 0.95, signals: ['visibleTexts 为空（SPA 未挂载/未就绪）'] };
  }

  // 2) LOGIN_WALL：登录/鉴权拦截（强信号优先）
  if (/邮箱或密码错误|密码错误|登录失效|账号或密码|请输入密码|请登录|未登录|需要登录|sign\s?in|log\s?in|login|register|create account|401|403|权限不足/.test(low) ||
      /\/login|\/signin|\/auth/.test(urlLow) || /登录|注册/.test(titleLow)) {
    out.state = 'LOGIN_WALL';
    out.confidence = 0.9;
    out.signals.push('检测到登录/鉴权拦截信号');
    return out;
  }

  // 3) DOWNLOAD_PAGE：资源下载页
  if (/资源下载|下载示例文件|点击下面的链接下载|download|文件下载/.test(low)) {
    out.state = 'DOWNLOAD_PAGE';
    out.confidence = 0.9;
    out.signals.push('检测到资源下载页信号');
    return out;
  }

  // 4) REGISTRATION：注册表单页
  if (/会员注册|提交注册|注册账号|注册新用户|sign up|create account/.test(low)) {
    out.state = 'REGISTRATION';
    out.confidence = 0.88;
    out.signals.push('检测到注册表单页信号');
    return out;
  }

  // 5) SHOP_SEARCH_EMPTY：搜索空结果（优先于商品列表，因更具体）
  if (/未找到相关商品|没有找到|搜索结果.*空|购物车：0|购物车:0|无搜索结果/.test(low)) {
    out.state = 'SHOP_SEARCH_EMPTY';
    out.confidence = 0.85;
    out.signals.push('检测到搜索空结果/购物车为 0 信号');
    return out;
  }

  // 6) PRODUCT_LISTING：商品列表（品牌名 / 价格 / 加入购物车）
  if (/戴尔|lg|飞利浦|华硕|明基|加入购物车|¥\s?\d|价格|\d+\.\d+\s*元|商品详情|sku/.test(low) || /product|item\/|goods/.test(urlLow)) {
    out.state = 'PRODUCT_LISTING';
    out.confidence = 0.85;
    out.signals.push('检测到电商商品列表信号');
    return out;
  }

  // 7) GENERIC：其他已渲染页面
  out.state = 'GENERIC';
  out.confidence = 0.6;
  out.signals.push('已渲染但无明确应用特征，归为 GENERIC');
  return out;
}

function classify(obs) {
  return detect(obs);
}

// 将 classifier 状态映射到 Phase 5 observationState 桶（用于回放准确率校验）
const BUCKET_MAP = {
  LOGIN_WALL: 'SaaS 登录/控制台页（邮箱或密码错误）',
  DOWNLOAD_PAGE: '资源下载页',
  REGISTRATION: '会员注册表单页',
  PRODUCT_LISTING: '电商商品列表页',
  SHOP_SEARCH_EMPTY: '电商搜索/空结果页',
  BLANK: '空白页（SPA 未挂载）',
  GENERIC: '电商商品列表页', // 兜底归入列表（多数 GENERIC 实为商城页变体）
};

function toBucket(state) {
  return BUCKET_MAP[state] || '电商商品列表页';
}

module.exports = { classify, extractText, toBucket, BUCKET_MAP };
