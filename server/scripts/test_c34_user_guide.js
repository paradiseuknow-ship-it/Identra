'use strict';
// C34 守护测试 —— 用户手册契约（docs-only 批，静态守护，零浏览器）。
//   P1 docs/USER_GUIDE.md 存在
//   P2 覆盖全部 13 个控制台面板（nav 实际有的 tab 一个不落）
//   P3 覆盖关键工作流/FAQ 关键词（崩溃恢复 / 经验包 / 凭据红线）
//   P4 README 已链接手册
//   P5 手册不含真实凭据明文（sk- 形态）
//   P6 手册提到的端点真实存在（readiness / recover / tick 三个抽查）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

(async () => {
  const guidePath = path.join(ROOT, 'docs', 'USER_GUIDE.md');
  const guide = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';
  chk('P1 docs/USER_GUIDE.md 存在', !!guide, guidePath);

  // 与 client/src/App.jsx nav tab 逐一对账，防手册与实际面板脱节
  // C86：nav 已升级为四分组结构 ['key', 'Label', <Icon/>]，提取器允许第三个元素（图标节点）
  const appSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
  const navTabs = [...appSrc.matchAll(/\['([a-z]+)',\s*'([^']+)',\s*</g)].map((m) => m[2]);
  chk('P0a App.jsx 解析出 nav 面板名', navTabs.length >= 10, JSON.stringify(navTabs));
  const missTabs = navTabs.filter((label) => !guide.includes(label));
  chk('P2 手册覆盖全部 nav 面板（' + navTabs.length + ' 个）', missTabs.length === 0, 'missing=' + missTabs.join(' / '));

  const need = ['僵尸资源回收', '单次 tick', '经验包', 'credentialRef', '崩溃恢复', 'start.bat', 'FPB_MASTER_KEY'];
  const miss = need.filter((k) => !guide.includes(k));
  chk('P3 手册覆盖工作流/FAQ 关键词', miss.length === 0, 'missing=' + miss.join(' / '));

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  chk('P4 README 链接使用手册', readme.includes('docs/USER_GUIDE.md'), 'missing link');

  chk('P5 手册不含真实凭据明文', !/sk-[A-Za-z0-9]{8,}/.test(guide), 'found sk- literal');

  // 抽查手册引用的端点在生产源里真实存在
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'index.js'), 'utf8');
  chk('P6a readiness 端点真实存在', idx.includes("settingsRouter.get('/settings/readiness'"), 'missing');
  chk('P6b resources/recover 端点真实存在', agent.includes("router.post('/execution/resources/recover'"), 'missing');
  chk('P6c scheduler/tick 端点真实存在', agent.includes("router.post('/execution/scheduler/tick'"), 'missing');

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
