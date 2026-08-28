'use strict';

// saas 场景集：SaaS 控制台登录 / 看板 / 导出 / 错误登录恢复。

module.exports = [
  {
    id: 'saas.login_dashboard',
    category: 'saas',
    name: '登录并查看看板',
    objective: '使用企业邮箱 ops@cloudsaas.io 与密码 Saas#2024 登录 CloudSaaS 控制台，确认数据看板出现',
    difficulty: 'EASY',
    fixture: 'saas/login.html',
    expectedSteps: 3,
    expectedOutcome: { summary: '看板区域可见且显示活跃用户', verify: { type: 'text_present', expect: '数据看板' } },
    failureInjection: null,
  },
  {
    id: 'saas.export_report',
    category: 'saas',
    name: '导出报表',
    objective: '登录 CloudSaaS 控制台后点击“导出 CSV”按钮，验证出现导出成功提示',
    difficulty: 'MEDIUM',
    fixture: 'saas/login.html',
    expectedSteps: 4,
    expectedOutcome: { summary: '出现“报表已导出”提示', verify: { type: 'text_present', expect: '报表已导出' } },
    failureInjection: null,
  },
  {
    id: 'saas.login_failure',
    category: 'saas',
    name: '错误凭据登录失败',
    objective: '使用错误密码登录 CloudSaaS 控制台（预期认证失败，验证系统拒绝并触发恢复/升级路径）',
    difficulty: 'HARD',
    fixture: 'saas/login.html',
    expectedSteps: 2,
    expectedOutcome: { summary: '登录被拒绝（不应出现看板）', verify: { type: 'text_present', expect: '邮箱或密码错误' } },
    failureInjection: null, // 纯失败注入见 failure.login_failure；此处保留为错误凭据登录的能力场景
  },
];
