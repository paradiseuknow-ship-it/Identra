'use strict';

/**
 * test_c141_async_no_busywait.js
 *
 * C141 守护（A 类）：async 上下文内**不得**用同步忙等充当等待。
 *
 * 缺陷背景（C141 §A 全仓横扫）：
 *   server/agent/runtime.js 的 `ensureBrowser` 在 async 函数里用
 *     `const end = Date.now() + (attempt + 1) * 300; while (Date.now() < end) { 微退避 }`
 *   做重试退避 —— 同步空转**阻塞事件循环** 300ms / 600ms：期间所有定时器、IO 回调、其他并发
 *   任务的回调全部饥饿（实测：1ms `setInterval` 在 900ms 墙钟内 tick 数为 **0**）。
 *   而同文件 :110 早已存在正确的非阻塞退避 `backoffSleep`（`new Promise(r => setTimeout(r, ms))`）
 *   —— 同文件两种写法并存，作者本知道正确写法。
 *
 * 为什么必须用**结构性**守护（而不是断言那一行文本）：
 *   忙等的有害性来自「在 async 上下文里同步占住事件循环」这个**形状**，而非某个具体变量名；
 *   断言具体文本只能防住一次回退，防不住换个变量名的同类重写。故本守护对**全仓**按形状扫描：
 *   「while (Date.now() …) 循环体」若**不含** `await` ⇒ 同步忙等 ⇒ 违规（白名单除外）。
 *
 * 判据（每条都配双向对照，防真空绿）：
 *   A 扫描器自身有效性 —— 已知忙等样例必须命中、已知非阻塞样例必须不命中
 *   B 全仓扫描        —— 违规集必须为空；白名单必须**在场**（防过期登记）
 *   C 修复锚点        —— ensureBrowser 的重试退避必须委托 backoffSleep（非阻塞），且数值等价
 *   D 白名单豁免的理由必须在源码里可读（SharedArrayBuffer 回退 + 同步上下文）
 *   E 隔离
 *
 * 扫描范围（显式声明，避免「扫了什么」隐形）：仓库根 `*.js` + `server/` 递归；
 *   跳过 node_modules / .git / release（**冻结发布快照**，含旧版副本，不进回归面、不得改）/
 *   .benchmark（本地取证产物，gitignored）。
 *
 * 隔离：FPB_DATA_DIR 指向 tmp；本套件不 require 任何业务模块，零浏览器、零 LLM、零网络。
 */

// 数据根隔离必须早于**任何** require（含 node 内置）：dataRoot / browserManager / identityStore
// 的数据根在**模块加载期**解析，晚于首个 require 的隔离行只覆盖一半（C140 EX-08 同族实证）。
// 故此处用内联 require 把隔离行顶到最前，使本套件满足最严形态。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c141_busywait_' + Date.now());

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RUNTIME_PATH = path.join(__dirname, '..', 'agent', 'runtime.js');
const FSSAFE_PATH = path.join(__dirname, '..', 'fsSafe.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}
const j = (a) => JSON.stringify(a);

// 只剥**整行注释**：内联注释里的 `/* 微退避 */` 属合法文档，且必须剥掉 ——
// 否则注释里的文本会污染「循环体是否含 await」的判定。
function stripFullLineComments(s) {
  return s.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
}
// 剥行尾块注释（`} /* 微退避 */` 这类行内注释同样不是代码）
function stripInlineBlockComments(s) {
  return s.replace(/\/\*[^\n]*?\*\//g, ' ');
}

// 把字符串字面量整体替换为等长空白（字符串**不是代码**）。
// ★ 这一步是扫描器能扫**自身**的前提：本文件里的正/负样例代码都以字符串形态存在，
// 若不遮蔽，扫描自己时会把样例当成真的忙等 ⇒ 自我误报（假红）。
function blankStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\'' || c === '"') {
      const q = c;
      out += ' ';
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += ' ';
        i++;
      }
      out += ' ';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const RE_WHILE_NOW = /while\s*\(\s*Date\.now\(\)\s*[-<]/g;

// 取 while 循环体（花括号配对）；无花括号体（`while (…) x++;`）按「到行尾」兜底。
function extractionOf(src) {
  const out = [];
  RE_WHILE_NOW.lastIndex = 0;
  let m;
  while ((m = RE_WHILE_NOW.exec(src))) {
    const openIdx = src.indexOf('{', RE_WHILE_NOW.lastIndex - 1);
    const lineEnd = src.indexOf('\n', RE_WHILE_NOW.lastIndex);
    if (openIdx < 0 || (lineEnd >= 0 && openIdx > lineEnd)) {
      out.push({ body: src.slice(m.index, lineEnd < 0 ? src.length : lineEnd), braced: false });
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let i = openIdx; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) { out.push({ body: src.slice(m.index), braced: true }); continue; }
    out.push({ body: src.slice(m.index, end + 1), braced: true });
  }
  return out;
}

// 违规判据：存在 while (Date.now() …) 且其循环体**不含 await** ⇒ 同步忙等
// （先剥注释、再遮蔽字符串 —— 两者都不是代码；顺序无关，但必须都做，否则会误报/自咬）
function findSyncBusyWaits(src) {
  const clean = blankStrings(stripInlineBlockComments(stripFullLineComments(src)));
  return extractionOf(clean)
    .filter((e) => !/\bawait\b/.test(e.body))
    .map((e) => e.body.replace(/\s+/g, ' ').slice(0, 120));
}

// ════════════════════════════════════════════════════════════════════════════
// A 扫描器自身有效性（双向对照）
// ════════════════════════════════════════════════════════════════════════════
console.log('[A] 扫描器有效性');
const SAMPLE_BUSY = 'async function f() {\n  const end = Date.now() + 300;\n  while (Date.now() < end) { /* spin */ }\n}\n';
const SAMPLE_POLL = 'async function g() {\n  const end = Date.now() + 300;\n  while (Date.now() < end) { await sleep(50); }\n}\n';
const SAMPLE_BUSY_INLINE = 'async function h() {\n  const end = Date.now() + 300;\n  while (Date.now() < end) { /* 微退避 */ }\n}\n';
check('A1 已知忙等样例必须命中（否则全仓扫描恒绿 = 真空）',
  findSyncBusyWaits(SAMPLE_BUSY).length === 1, 'hits=' + findSyncBusyWaits(SAMPLE_BUSY).length);
check('A2 ★ 已知非阻塞轮询样例必须**不**命中（否则判据恒红、无法区分）',
  findSyncBusyWaits(SAMPLE_POLL).length === 0, 'hits=' + findSyncBusyWaits(SAMPLE_POLL).length);
check('A3 行内块注释 `/* 微退避 */` 不提供 `await` 迹象 ⇒ 仍判为忙等（注释被正确剥除）',
  findSyncBusyWaits(SAMPLE_BUSY_INLINE).length === 1, 'hits=' + findSyncBusyWaits(SAMPLE_BUSY_INLINE).length);
check('A4 ★ revert 对照：把非阻塞样例改成忙等后必须翻红（证明 A2 的绿不是恒绿）',
  findSyncBusyWaits(SAMPLE_POLL.replace('await sleep(50);', '/* nop */')).length === 1, '');

// ════════════════════════════════════════════════════════════════════════════
// B 全仓扫描
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[B] 全仓扫描');
const SKIP_DIRS = new Set(['node_modules', '.git', 'release', '.benchmark', '.workbuddy', 'dist']);

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const scanRoots = [ROOT, path.join(ROOT, 'server')];
const files = [];
const seen = new Set();
for (const r of scanRoots) {
  let ents;
  try { ents = fs.readdirSync(r, { withFileTypes: true }); } catch (e) { continue; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(r, e.name), files);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      files.push(path.join(r, e.name));
    }
  }
}
const uniq = files.filter((f) => (seen.has(f) ? false : (seen.add(f), true)));

check('B0 防空：扫描面 > 100 个 .js（否则空白扫描会退化成真空绿）', uniq.length > 100, 'n=' + uniq.length);

// 白名单：唯一合法例外 —— fsSafe.syncSleep 的 sync 上下文回退（见 C1b/C1c 的源码实证）
const ALLOW = new Map([
  ['server/fsSafe.js', 'syncSleep：优先 Atomics.wait(SharedArrayBuffer)，仅在其不可用（极老环境）时退回 busy-wait；调用方为同步上下文（readFileSyncRetry / atomicWriteFileSync），无 async 可用'],
]);

const hits = [];
for (const abs of uniq) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
  const found = findSyncBusyWaits(src);
  if (found.length) hits.push({ rel, n: found.length, sample: found[0] });
}
const violations = hits.filter((h) => !ALLOW.has(h.rel));

check('B1 ★ 全仓无未登记同步忙等（async 上下文内不得阻塞事件循环）',
  violations.length === 0,
  violations.map((v) => v.rel + ' x' + v.n).join(',') + (violations.length ? ' | ' + j(violations[0].sample) : ''));

// ★ 白名单必须**在场**：登记过期（文件已不存在不该有的例外 / 例外已被移除）⇒ 红
const allowPresent = [...ALLOW.keys()].filter((rel) => hits.some((h) => h.rel === rel));
check('B2 ★ 白名单登记未过期：每一项都必须真的仍有忙等形状（否则该例外在漂移）',
  allowPresent.length === ALLOW.size, 'present=' + j(allowPresent) + ' expect=' + ALLOW.size);

// runtime.js 是本次 A 类修复的对象：必须已从命中集中消失（与 B1 互补）
check('B3 ★ 修复对象已从命中集消失：server/agent/runtime.js 不再含同步忙等',
  !hits.some((h) => h.rel === 'server/agent/runtime.js'),
  'hits=' + j(hits.map((h) => h.rel)));

// ════════════════════════════════════════════════════════════════════════════
// C 修复锚点（结构性，不锚具体行号）
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[C] 修复锚点');
const rtSrc = fs.readFileSync(RUNTIME_PATH, 'utf8');
const rtCode = stripInlineBlockComments(stripFullLineComments(rtSrc));

function extractFunctionBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const ebBody = extractFunctionBody(rtCode, 'ensureBrowser');
check('C0 ensureBrowser 真实函数体可提取（防空：提取失败时 C1/C2 会退化为真空绿）',
  !!ebBody, ebBody ? 'len=' + ebBody.length : '提取失败');

check('C1 ★ ensureBrowser 重试退避已委托非阻塞 backoffSleep(attempt + 1)',
  !!ebBody && /await\s+backoffSleep\(\s*attempt\s*\+\s*1\s*\)/.test(ebBody), '');
check('C1b ★ 委托目标 backoffSleep 的真实实现是 Promise + setTimeout（非阻塞）', (() => {
  const b = extractFunctionBody(rtCode, 'backoffSleep');
  return !!b && /new\s+Promise\(/.test(b) && /setTimeout\(/.test(b) && !/while\s*\(/.test(b);
})(), '');
check('C1c revert 对照：移除委托后的文本必须判为「未委托」（否则 C1 是真空绿）',
  !/await\s+backoffSleep\(\s*attempt\s*\+\s*1\s*\)/.test(String(ebBody || '').replace(/await\s+backoffSleep\(\s*attempt\s*\+\s*1\s*\)/g, '')),
  '');

// 数值等价：旧式 (attempt+1)*300 在 attempt ∈ {0,1} 上等于 backoffSleep(attempt+1)
// backoffSleep(attempt) = min(5000, 300 * 2^(max(0, attempt-1)))
const boBody = extractFunctionBody(rtCode, 'backoffSleep') || '';
const mBase = boBody.match(/const\s+base\s*=\s*(\d+)/);
const mCap = boBody.match(/const\s+cap\s*=\s*(\d+)/);
check('C2 防空：backoffSleep 的 base/cap 可从源码解析（否则 C2b 退化为真空绿）',
  !!mBase && !!mCap, 'base=' + (mBase && mBase[1]) + ' cap=' + (mCap && mCap[1]));
if (mBase && mCap) {
  const base = Number(mBase[1]);
  const cap = Number(mCap[1]);
  const oldMs = [0, 1].map((a) => (a + 1) * 300);
  const newMs = [0, 1].map((a) => Math.min(cap, base * Math.pow(2, Math.max(0, (a + 1) - 1))));
  check('C2b ★ 数值逐值等价：旧忙等窗 (attempt+1)*300 === backoffSleep(attempt+1)，attempt∈{0,1}',
    j(oldMs) === j(newMs), 'old=' + j(oldMs) + ' new=' + j(newMs));
  check('C2c revert 对照：旧实现下「按 attempt 而非 attempt+1」的窗必须不等（证明 C2b 不是恒真）',
    j([0, 1].map((a) => (a + 1) * 300)) !== j([0, 1].map((a) => Math.min(cap, base * Math.pow(2, Math.max(0, a - 1))))),
    '');
}

// ════════════════════════════════════════════════════════════════════════════
// D 白名单豁免的理由必须在源码里可读
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[D] 白名单豁免理由');
for (const rel of ALLOW.keys()) {
  const abs = path.join(ROOT, rel);
  const src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const hitsThis = findSyncBusyWaits(src);
  check('D1 [' + rel + '] 确有忙等形状（白名单不是空转）', hitsThis.length === 1, 'n=' + hitsThis.length);
  check('D2 [' + rel + '] 同一函数内可见 SharedArrayBuffer + Atomics.wait 优先路径（回退有据）',
    /Atomics\.wait\(/.test(src) && /SharedArrayBuffer/.test(src), '');
  check('D3 [' + rel + '] 回退路径处在 catch 内（即「不可用时才退回」而非首选项）',
    /Atomics\.wait\([\s\S]{0,200}?catch\s*\([\s\S]{0,400}?while\s*\(\s*Date\.now\(\)/.test(stripInlineBlockComments(src)), '');
}

// ════════════════════════════════════════════════════════════════════════════
// E 隔离
// ════════════════════════════════════════════════════════════════════════════
console.log('\n[E] 隔离');
const dd = String(process.env.FPB_DATA_DIR || '');
// 判据必须与 os.tmpdir() 比对（Windows 上是 `C:\...\AppData\Local\Temp`，含 "emp" 不含 "tmp"
// —— 写成 /tmp/i 会恒假；这是本守护首跑的自身缺陷，已修）
const tmpRoot = os.tmpdir();
check('E1 FPB_DATA_DIR 落在 os.tmpdir() 下且不在仓库内',
  dd.length > 0 && dd.indexOf(tmpRoot) === 0 && dd.indexOf(ROOT) < 0,
  'FPB_DATA_DIR=' + dd + ' tmp=' + tmpRoot);

console.log('\n== C141-A 结果: PASS ' + pass + ' / FAIL ' + fail + ' ==');
process.exit(fail ? 1 : 0);
