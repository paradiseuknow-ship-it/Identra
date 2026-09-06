'use strict';
// test_pool_alignment_lint.js —— pool_alignment_lint.js 与 audit v2 的等价性测试。
// 纪律：断言「真正会执行的那份东西」——子进程真实运行 audit 脚本产出 --json，
// 与共享模块对同一冻结池的 lintPool 输出逐字段比对；并与权威快照 55 做对账。
// 运行：node server/scripts/test_pool_alignment_lint.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const lint = require('./pool_alignment_lint');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }

// ── 1. 模块级单测 ──
ok(Array.isArray(lint.NOUNS) && lint.NOUNS.includes('戴尔 U2723QE'), 'NOUNS 词典导出且含实体词');
ok(lint.SETTINGS_PAGE_RE instanceof RegExp, 'SETTINGS_PAGE_RE 导出');
ok(lint.isSearchOnly('搜索「机械键盘」') === true, 'isSearchOnly: 纯搜索句式');
ok(lint.isSearchOnly('搜索「机械键盘」并确认结果出现') === false, 'isSearchOnly: 含确认结果性动词不降级');
ok(lint.isSearchOnly('登录系统并查看看板') === false, 'isSearchOnly: 无搜索句式');
const cap = lint.capabilityMatrix('ecommerce/search.html');
ok(cap && cap.ids.includes('q') && cap.ids.includes('searchBtn') && cap.entities.includes('机械键盘'), 'capabilityMatrix: search.html id/实体');
ok(lint.capabilityMatrix('not/exist.html') === null, 'capabilityMatrix: 不存在 fixture 返回 null');

const mt = lint.lintTask({ id: 't1', objective: '登录后进入项目列表', fixture: 'saas/login.html' }, lint.fixtureRawText('saas/login.html'));
ok(mt.missing.includes('项目'), 'lintTask: objective 含 fixture 无名词命中');
const mt2 = lint.lintTask({ id: 't2', objective: '登录后查看看板', fixture: 'saas/login.html' }, lint.fixtureRawText('saas/login.html'));
ok(mt2.missing.length === 0, 'lintTask: 看板经同义词组豁免后对齐');
ok(lint.lintTask({ id: 't3', objective: '任意', fixture: 'no/such.html' }, null).missing[0] === '<fixture 文件不存在>', 'lintTask: fixture 缺失防护');

// ── 2. 与 audit v2 全池等价（子进程真实运行 audit 脚本）──
const tmpJson = path.join(ROOT, '.benchmark', 'lint_equiv_test_' + Date.now() + '.json');
execFileSync(process.execPath, [path.join(__dirname, 'audit_pool_fixture_alignment.js'), '--json', tmpJson], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const auditOut = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));

const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'phase12_pool.json'), 'utf8'));
const poolBefore = JSON.stringify(pool);
const { mismatch, searchOnlyPass } = lint.lintPool(pool.tasks);

const auditIds = auditOut.mismatch.map((r) => r.id).sort();
const lintIds = mismatch.map((r) => r.id).sort();
ok(JSON.stringify(auditIds) === JSON.stringify(lintIds), '等价: mismatch id 集合与 audit v2 完全一致 (' + auditIds.length + ' vs ' + lintIds.length + ')');
const auditMap = Object.fromEntries(auditOut.mismatch.map((r) => [r.id, r.missing]));
const lintMap = Object.fromEntries(mismatch.map((r) => [r.id, r.missing]));
ok(JSON.stringify(auditMap) === JSON.stringify(lintMap), '等价: 每任务 missing 明细与 audit v2 完全一致');
ok(auditOut.searchOnlyPass.map((s) => s.id).sort().join(',') === searchOnlyPass.map((s) => s.id).sort().join(','), '等价: searchOnlyPass 单列一致 (' + searchOnlyPass.length + ')');

// ── 3. 对账权威快照 55 = raw57 − 灰区3 + 人工1 ──
const snapPath = path.join(__dirname, 'pool_fixture_mismatch_list.json');
ok(fs.existsSync(snapPath), '权威快照存在: server/scripts/pool_fixture_mismatch_list.json');
if (fs.existsSync(snapPath)) {
  const snap = JSON.parse(snapPath.includes('{') ? snapPath : fs.readFileSync(snapPath, 'utf8'));
  const snapMism = (snap.mismatches || []).map((m) => m.id).sort();
  ok(snapMism.length === 55, '快照 mismatch 数 = 55 (实际 ' + snapMism.length + ')');
  const gray = new Set(['rw.064', 'rw.065', 'rw.089']);
  const reconciled = [...new Set([...lintIds.filter((i) => !gray.has(i)), 'rw.076'])].sort();
  ok(JSON.stringify(reconciled) === JSON.stringify(snapMism), '对账: lint(' + lintIds.length + ') − 灰区3 + 人工 rw.076 === 快照55');
}

// ── 4. 只读指纹：lintPool 不得改写池对象 ──
ok(JSON.stringify(pool) === poolBefore, '只读: lintPool 后池对象 JSON 指纹不变');

try { fs.unlinkSync(tmpJson); } catch (e) {}

console.log('test_pool_alignment_lint: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
