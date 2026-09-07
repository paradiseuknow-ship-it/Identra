'use strict';
// C48 守护测试 —— 使用手册（docs/USER_GUIDE.md）与真实功能面对账。
// 背景：C22-C47 批次给控制台新增了大量用户可见能力（实时画面 / 崩溃恢复 / 凭据引用 /
//   Deprecation 卡 / 存储治理），但手册停更于 C30 前后——用户看不见新功能=功能不存在。
// 本测试三向对账（手册 ↔ 前端接线 ↔ api.js），防止手册再漂移：
//   P1 手册覆盖度：五个新功能面必须都有用户可读的说明
//   P2 手册声明 ↔ 前端真实接线（组件里必须找得到对应实现锚点）
//   P3 手册提到的端点在 api.js 真实消费（不是写了没有的路由）
//   P4 安全红线章节完整（手册删红线=事故）
//   P5 README 基线格式健全（双回归数字模式存在，防手滑清空）
// 特性：零浏览器、零删除、零网络（纯文件断言），任意环境可跑。

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const guide = read('docs/USER_GUIDE.md');
const api = read('client/src/api.js');

(async () => {
  // ---- P1 手册覆盖度 ----
  const mustHave = [
    ['实时画面（screencast）', /实时查看浏览器画面|CDP 实时流/],
    ['崩溃恢复（recover）', /崩溃恢复（recover）|checkpoint 重建/],
    ['凭据引用（credentialRef）', /凭据引用（credentialRef）/],
    ['Deprecation 卡', /Deprecation 卡|遗留端点（\/ai\/queue/],
    ['存储使用与清理', /存储使用与清理/],
    ['清理 dry-run 两步确认', /清理预览.*dry-run|dry-run，不删任何文件/s],
    ['Esc 快捷键 FAQ', /按 Esc 即关闭/],
    ['磁盘工作流 E', /磁盘占用越来越大/],
  ];
  for (const [name, re] of mustHave) {
    chk('P1 手册含「' + name + '」', re.test(guide), 'USER_GUIDE.md 缺章节');
  }

  // ---- P2 手册声明 ↔ 前端真实接线 ----
  {
    const bv = read('client/src/components/BrowserViewer.jsx');
    chk('P2a BrowserViewer 真有实时流+低速降级（手册 §2 声明）',
      bv.includes('CDP screencast') && bv.includes('低速'), 'screencast 接线缺失');
  }
  {
    const td = read('client/src/components/TaskDetail.jsx');
    chk('P2b TaskDetail 真有崩溃恢复+状态门控（手册 §6 声明）',
      td.includes('recoverTask') && /RUNNING\/HEALING\/RECOVERING/.test(td), 'recover 接线缺失');
  }
  {
    const gp = read('client/src/components/GovernancePanel.jsx');
    chk('P2c GovernancePanel 真有凭据引用脱敏卡（手册 §10 声明）',
      gp.includes('credentialRef') && gp.includes('listSecrets'), 'secrets 卡缺失');
  }
  {
    const op = read('client/src/components/ObservabilityPanel.jsx');
    chk('P2d ObservabilityPanel 真有 Deprecation 视图（手册 §11 声明）',
      op.includes('DeprecationView') && op.includes('dash.deprecation'), 'deprecation 卡缺失');
  }
  {
    const sp = read('client/src/components/SettingsPanel.jsx');
    chk('P2e SettingsPanel 真有 StorageView（手册 §12 声明）',
      sp.includes('function StorageView') && sp.includes('dryRun: true') && sp.includes('dryRun: false'),
      'StorageView/dryRun 接线缺失');
  }

  // ---- P3 手册提到的端点在 api.js 真实消费 ----
  {
    chk('P3 api.js 消费 /system/storage（存储统计）',
      api.includes("'/system/storage'"), 'storageStats 未消费');
    chk('P3 api.js 消费 /system/storage/cleanup',
      api.includes("'/system/storage/cleanup'"), 'storageCleanup 未消费');
    chk('P3 api.js 消费 /ai/secrets（凭据引用）',
      api.includes("'/ai/secrets'"), 'secrets 未消费');
    chk('P3 api.js 消费 /settings/readiness（就绪检查 §1）',
      api.includes("'/settings/readiness'"), 'readiness 未消费');
  }

  // ---- P4 安全红线章节完整 ----
  {
    chk('P4 红线章节存在且含 credentialRef 红线',
      /## 15\. 安全红线/.test(guide) && guide.includes('LLM 永不见明文 CVV/卡号/密码'),
      '红线章节被删改');
    chk('P4 保险库章节保留产品红线表述',
      guide.includes('credentialRef（引用）'), '§5 红线表述缺失');
  }

  // ---- P5 README 基线格式健全 ----
  {
    const readme = read('README.md');
    chk('P5 README 双回归基线数字模式存在（**N/0** 与 OK=N/BAD=0）',
      /\*\*\d+\/0\*\*/.test(readme) && /OK=\d+\/BAD=0/.test(readme),
      '基线数字被清空');
    chk('P5 README 链接使用手册',
      readme.includes('USER_GUIDE'), '手册链接缺失');
  }

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail);
  if (fail > 0) { console.log('FAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
