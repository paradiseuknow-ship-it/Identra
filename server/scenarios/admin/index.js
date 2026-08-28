'use strict';

// admin 场景集：管理后台用户管理操作。

module.exports = [
  {
    id: 'admin.create_user',
    category: 'admin',
    name: '创建新用户',
    objective: '在 AdminOS 用户管理页填写用户名“alice”、邮箱“alice@corp.io”、角色 viewer，点击“创建用户”，验证提示“用户已创建”',
    difficulty: 'MEDIUM',
    fixture: 'admin/users.html',
    expectedSteps: 4,
    expectedOutcome: { summary: '出现“用户已创建：alice”', verify: { type: 'text_present', expect: '用户已创建' } },
    failureInjection: null,
  },
];
