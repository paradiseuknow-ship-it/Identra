'use strict';

// data_entry 场景集：表单填写与提交。

module.exports = [
  {
    id: 'data_entry.registration',
    category: 'data_entry',
    name: '会员注册',
    objective: '在会员注册页填写姓名“张三”、邮箱“zhangsan@test.io”、手机号“13800000000”，点击“提交注册”，验证出现“注册成功”',
    difficulty: 'EASY',
    fixture: 'data_entry/form.html',
    expectedSteps: 4,
    expectedOutcome: { summary: '出现“注册成功，欢迎 张三”', verify: { type: 'text_present', expect: '注册成功' } },
    failureInjection: null,
  },
  {
    id: 'data_entry.profile_update',
    category: 'data_entry',
    name: '资料更新提交',
    objective: '在会员注册页填写姓名“李四”、邮箱“lisi@test.io”、手机号“13900000000”并提交，验证成功提示包含姓名',
    difficulty: 'EASY',
    fixture: 'data_entry/form.html',
    expectedSteps: 4,
    expectedOutcome: { summary: '出现“注册成功，欢迎 李四”', verify: { type: 'text_present', expect: '李四' } },
    failureInjection: null,
  },
];
