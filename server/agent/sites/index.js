'use strict';

// Site Adapter 层：为 AI 提供站点知识（knownFlows / selectors hints / special handling）。
// 不是写死流程，而是"网站经验"：AI 不知道网站时，Adapter 提供候选定位与已知流程。
// 未来 Repair Knowledge 依赖此注册表（site → 历史成功修复策略）。

// Site Adapter 契约（Phase 1.5 定义）：
// {
//   site: 'example.com',
//   match: (host, url) => bool,          // 匹配
//   knownFlows: ['login','signup',...],  // 已知流程
//   selectors: { login: '...', signup: '...', email: '...', submit: '...' },  // 站点级选择器（AI 优先于此）
//   validators: { loggedIn: '语义描述或函数', ... },                          // 状态校验
//   rules: { consent: 'accept', ... },                                       // 站点规则
//   hints: ['...']                                                           // 提示
// }
// 解析优先级：Site Adapter 选择器 → Semantic Resolver → 纯 AI（降低成本）。

// generic 适配器：零知识兜底，AI 完全靠观察
const generic = {
  site: 'generic',
  match: () => true,
  knownFlows: [],
  selectors: {},
  validators: {},
  rules: {},
  hints: [],
  resolve: null, // 无特化解析，交给 semanticResolver 通用逻辑
};

const adapters = {
  generic,
};

// 按 URL 匹配站点适配器
function getAdapter(url) {
  const host = safeHost(url);
  for (const a of Object.values(adapters)) {
    if (a === generic) continue;
    if (a.match && a.match(host, url)) return a;
  }
  return generic;
}

function safeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return String(url || '').toLowerCase();
  }
}

// 注册新适配器（可被 sites/*.js 文件加载）
function register(adapter) {
  if (!adapter || !adapter.site) return;
  adapters[adapter.site] = {
    match: () => false,
    knownFlows: [],
    selectors: {},
    validators: {},
    rules: {},
    hints: [],
    ...adapter,
  };
}

function list() {
  return Object.keys(adapters).map((k) => ({
    site: adapters[k].site,
    knownFlows: adapters[k].knownFlows || [],
    selectors: Object.keys(adapters[k].selectors || {}),
    validators: Object.keys(adapters[k].validators || {}),
  }));
}

// 站点知识注入到 Observation 摘要（可选）：含选择器/校验器/规则（供 AI 与自愈优先使用）
function knowledgeFor(url) {
  const a = getAdapter(url);
  return {
    site: a.site,
    knownFlows: a.knownFlows || [],
    selectors: a.selectors || {},
    validators: Object.keys(a.validators || {}),
    rules: a.rules || {},
    hints: (a.hints || []).slice(0, 20),
  };
}

// 获取站点级选择器（resolveSelector 可优先使用；命中则跳过语义解析，降低 LLM 成本）
function selectorFor(url, semanticKey) {
  const a = getAdapter(url);
  const sel = a.selectors && a.selectors[semanticKey];
  return sel || null;
}

// 便于后续按文件自动加载 server/agent/sites/*.js
function loadFromDir() {
  const fs = require('fs');
  const path = require('path');
  const dir = __dirname;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js') && f !== 'index.js') {
      try {
        const mod = require(path.join(dir, f));
        if (mod && mod.site) register(mod);
      } catch (e) {
        // 单个适配器加载失败不影响整体
      }
    }
  }
}
loadFromDir();

module.exports = { getAdapter, register, list, knowledgeFor, selectorFor, generic, safeHost };
