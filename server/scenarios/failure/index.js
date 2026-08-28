'use strict';

// failure 场景集（Phase 5 Task 4）：覆盖 5 类必选失败注入，验证 Recovery 真实触发。
// 这些场景预期触发对应失败类别，并验证恢复框架（recoveryManager / repairManager）被真实调用。

module.exports = [
  {
    id: 'failure.page_not_found',
    category: 'failure',
    name: '页面不存在',
    objective: '访问一个不存在的页面路径 /missing.html，验证导航失败后系统正确识别并终止（不静默通过）',
    difficulty: 'HARD',
    fixture: 'missing.html', // 404，由 mock server 返回 not found
    expectedSteps: 1,
    expectedOutcome: { summary: '导航失败，任务以 FAILED/升级 终态结束', verify: null },
    failureInjection: { type: 'page_not_found', note: '目标资源缺失 → NAVIGATION_FAILED' },
  },
  {
    id: 'failure.element_changed',
    category: 'failure',
    name: '元素改变',
    objective: '在改版搜索页（元素 id 已变更）执行搜索，验证元素定位失败后恢复尝试被触发',
    difficulty: 'HARD',
    fixture: 'ecommerce/search_changed.html',
    expectedSteps: 2,
    expectedOutcome: { summary: '恢复框架被触发（重试/重定位）', verify: null },
    failureInjection: { type: 'element_changed', note: '目标元素 id 变更 → ELEMENT_NOT_FOUND' },
  },
  {
    id: 'failure.network_failure',
    category: 'failure',
    name: '网络失败',
    objective: '访问一个不可达的端口（连接被拒），验证网络错误被分类并触发恢复（等待/重连）',
    difficulty: 'HARD',
    fixture: null, // 使用 dead port URL
    expectedSteps: 1,
    expectedOutcome: { summary: 'NETWORK_ERROR 被识别，恢复尝试后正确终止', verify: null },
    failureInjection: { type: 'network_failure', note: '连接被拒 → NETWORK_ERROR' },
  },
  {
    id: 'failure.login_failure',
    category: 'failure',
    name: '登录失败',
    objective: '使用错误密码登录，验证认证失败后验证失败被正确识别并触发恢复/升级（不绕过鉴权）',
    difficulty: 'HARD',
    fixture: 'saas/login.html',
    expectedSteps: 2,
    expectedOutcome: { summary: 'VERIFY_FAILED（登录被拒）后恢复尝试，正确终止', verify: null },
    failureInjection: { type: 'login_failure', note: '凭据错误 → VERIFICATION_FAILED' },
  },
  {
    id: 'failure.verification_failure',
    category: 'failure',
    name: '验证失败',
    objective: '在操作台点击执行按钮，但服务端永不返回“操作成功”，验证验证失败被识别并触发修复编排',
    difficulty: 'HARD',
    fixture: 'misc/verify_fail.html',
    expectedSteps: 2,
    expectedOutcome: { summary: 'VERIFY_FAILED 被识别，修复编排触发后正确终止', verify: null },
    failureInjection: { type: 'verification_failure', note: '动作成功但断言不满足 → VERIFY_FAILED' },
  },
];
