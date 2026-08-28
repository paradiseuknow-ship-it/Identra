'use strict';

// scraping 场景集：数据抓取（只读提取）。

module.exports = [
  {
    id: 'scraping.product_list',
    category: 'scraping',
    name: '抓取商品列表',
    objective: '打开比价网商品列表页，抓取页面中至少 5 个商品名称，验证列表包含“戴尔 U2723QE”等条目',
    difficulty: 'MEDIUM',
    fixture: 'scraping/list.html',
    expectedSteps: 2,
    expectedOutcome: { summary: '页面渲染 10 条商品且含目标条目', verify: { type: 'text_present', expect: '戴尔 U2723QE' } },
    failureInjection: null,
  },
  {
    id: 'scraping.prices',
    category: 'scraping',
    name: '抓取价格信息',
    objective: '打开比价网商品列表页，提取页面中的价格信息，验证出现“¥”标价',
    difficulty: 'EASY',
    fixture: 'scraping/list.html',
    expectedSteps: 2,
    expectedOutcome: { summary: '价格区域出现“¥”符号', verify: { type: 'text_present', expect: '¥' } },
    failureInjection: null,
  },
];
