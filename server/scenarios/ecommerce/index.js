'use strict';

// ecommerce 场景集：真实电商操作目标（搜索 / 加购 / 改版恢复）。
// 每个场景均为多步骤业务目标，禁止简单 demo。

module.exports = [
  {
    id: 'ecommerce.search',
    category: 'ecommerce',
    name: '商品搜索',
    objective: '在优选商城搜索框输入“机械键盘”并提交，确认结果区域出现相关商品',
    difficulty: 'EASY',
    fixture: 'ecommerce/search.html',
    expectedSteps: 3,
    expectedOutcome: { summary: '结果区出现“机械键盘”商品', verify: { type: 'text_present', expect: '机械键盘' } },
    failureInjection: null,
  },
  {
    id: 'ecommerce.add_to_cart',
    category: 'ecommerce',
    name: '搜索并加入购物车',
    objective: '在优选商城搜索“无线鼠标”，点击第一个结果的“加入购物车”按钮，验证购物车数量变为 1',
    difficulty: 'MEDIUM',
    fixture: 'ecommerce/search.html',
    expectedSteps: 4,
    expectedOutcome: { summary: '购物车计数 = 1', verify: { type: 'text_present', expect: '已加入购物车' } },
    failureInjection: null,
  },
  {
    id: 'ecommerce.lazy_recovery',
    category: 'ecommerce',
    name: '动态加载元素恢复',
    objective: '在优选商城动态加载页搜索框（首屏延迟 800ms 才可见）输入“显示器”并提交，验证恢复等待后执行成功',
    difficulty: 'MEDIUM',
    fixture: 'ecommerce/search_lazy.html',
    expectedSteps: 3,
    expectedOutcome: { summary: '搜索结果出现“显示器”', verify: { type: 'text_present', expect: '显示器' } },
    failureInjection: null, // 预期执行中触发元素未就绪→恢复(wait)→成功
  },
  {
    id: 'ecommerce.search_changed',
    category: 'ecommerce',
    name: '改版页面元素变更',
    objective: '在优选商城改版搜索页（搜索框 id 已变更）输入“键盘”并提交，验证恢复定位改版元素后成功',
    difficulty: 'HARD',
    fixture: 'ecommerce/search_changed.html',
    expectedSteps: 3,
    expectedOutcome: { summary: '搜索结果出现“键盘”', verify: { type: 'text_present', expect: '键盘' } },
    failureInjection: null, // 该场景为正向能力场景（演示改版后语义定位恢复）；纯失败注入见 failure.element_changed
  },
];
