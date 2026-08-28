'use strict';
// Step 2-A 单元回归：resolver 必须接收 field 并据此评分（数据流缺陷修复验证）。
// 不依赖浏览器，手工构造 observation（模拟 observation.js 的输出形状）。
// 覆盖用户指定三对：field=email/semantic=邮箱、field=password/semantic=密码、field=search/semantic=搜索。
const resolver = require('./server/agent/semanticResolver');

// 构造一个最小 observation 元素（与 observation.js 暴露的字段一致）
function el(o) {
  return Object.assign({
    id: null, role: 'input', tag: 'input', type: 'text', name: null, cls: null,
    text: '', placeholder: null, label: null, ariaLabel: null, visible: true,
    innerText: '', roleText: '',
  }, o);
}

let pass = 0, fail = 0;
const rows = [];
function check(name, cond, detail) {
  if (cond) { pass++; rows.push('✅ ' + name); }
  else { fail++; rows.push('❌ ' + name + ' :: ' + detail); }
}

// 登录页：email / password / search / username 输入框
const loginObs = {
  url: 'http://x/login',
  elements: [
    el({ id: 'emailIn', name: 'email', type: 'email', placeholder: '邮箱', label: '邮箱' }),
    el({ id: 'pwIn', name: 'password', type: 'password', placeholder: '密码', label: '密码' }),
    el({ id: 'searchIn', name: 'q', type: 'search', placeholder: '搜索' }),
    el({ id: 'userIn', name: 'username', type: 'text', placeholder: '用户名' }),
  ],
};

// 1. 用户指定的三个必需对
const e = resolver.resolve({ field: 'email', semantic: '邮箱' }, loginObs);
check('field=email / semantic=邮箱 → emailIn', e[0] && e[0].elementId === 'emailIn', e[0] && e[0].elementId);

const p = resolver.resolve({ field: 'password', semantic: '密码' }, loginObs);
check('field=password / semantic=密码 → pwIn', p[0] && p[0].elementId === 'pwIn', p[0] && p[0].elementId);

const s = resolver.resolve({ field: 'search', semantic: '搜索' }, loginObs);
check('field=search / semantic=搜索 → searchIn', s[0] && s[0].elementId === 'searchIn', s[0] && s[0].elementId);

// 2. 证明 field 确实被接收（而非只看 semantic）
//    歧义场景：email 输入框无易匹配中文文本，username 输入框 placeholder 含「邮箱」会诱导纯语义误判。
const ambObs = {
  url: 'http://x',
  elements: [
    el({ id: 'realEmail', name: 'email', type: 'email', placeholder: 'Email address' }),
    el({ id: 'trapUser', name: 'username', type: 'text', placeholder: '邮箱/用户名' }),
  ],
};
const c = resolver.resolve({ field: 'email', semantic: '账号登录' }, ambObs);
check('field 被接收：歧义下 field=email 选中 realEmail（而非 placeholder 含邮箱的 trapUser）',
  c[0] && c[0].elementId === 'realEmail', c[0] && (c[0].elementId + ' reason=' + c[0].reason));
check('评分理由显式包含 field 命中信号', c[0] && /field/.test(c[0].reason), c[0] && c[0].reason);

// 3. 向后兼容：仅传 semantic 字符串仍可解析（旧调用路径）
const onlySem = resolver.resolve('邮箱', loginObs);
check('仅 semantic 字符串（旧路径）兼容 → emailIn', onlySem[0] && onlySem[0].elementId === 'emailIn', onlySem[0] && onlySem[0].elementId);

// 4. type bonus：password 字段对 password 输入框加成
const pw = resolver.resolve({ field: 'password' }, loginObs);
check('field=password 命中 password 输入框（含 type 加成）', pw[0] && pw[0].elementId === 'pwIn', pw[0] && pw[0].elementId);

console.log('Step 2-A Resolver 单元测试（field 信号验证）');
console.log('='.repeat(60));
rows.forEach((r) => console.log(r));
console.log('='.repeat(60));
console.log(`PASS: ${pass}  FAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
