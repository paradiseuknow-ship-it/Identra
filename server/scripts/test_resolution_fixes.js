'use strict';

// STEP 6 targeted test（P6 分辨率层修复）：
//   ① semanticResolver CJK 缩写扩展：「加购按钮」必须解析到加入购物车按钮（smoke5 rw.094 铁证回归），
//      且「搜索按钮」「搜索框」等既有语义零回归；
//   ② 记忆失败反馈的置信度数学：recordOutcome(false) 单调降置信、falsePositive 计数、低成功率自动 DEPRECATED；
//   ③ runtime.js 接线：验证失败收口路径存在 recordFailure 惩罚调用（源码接线断言，既有先例同款）；
//   ④ repair 脚本：FPB_DATA_DIR 隔离环境 dry-run/apply/幂等，只弃用投毒记录。
// 纪律：断言真实模块求值行为（require 真文件），不 eval 源码；仅 ③ 为接线断言（precedent: test_task_actions_summary）。

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('  ✗ ' + msg); } }

// ── ① semanticResolver 缩写扩展（子进程直调真实模块）──
function runResolver(expr) {
  const out = execFileSync(process.execPath, ['-e', `
    const sr = require('${ROOT.replace(/\\/g, '/')}/server/agent/semanticResolver.js');
    const obs = {
      url: 'http://127.0.0.1:14365/ecommerce/search.html',
      elements: [
        { id: 'q', role: 'input', tag: 'input', text: '搜索商品，如 机械键盘 | 搜索框 | q', ariaLabel: '搜索框', name: 'q', visible: true },
        { id: 'searchBtn', role: 'button', tag: 'button', text: '搜索', ariaLabel: '搜索按钮', visible: true },
        { id: 'addBtn', role: 'button', tag: 'button', text: '加入购物车', ariaLabel: '加入购物车', visible: true }
      ]
    };
    const cands = sr.resolve(${expr}, obs);
    console.log(JSON.stringify(cands.slice(0, 3).map(c => ({ selector: c.selector, score: c.score }))));
  `], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

console.log('① semanticResolver CJK 缩写扩展');
{
  const cart = runResolver(`{ field: 'addToCartBtn', semantic: '加购按钮' }`);
  ok(cart.length >= 1 && cart[0].selector === '#addBtn', '「加购按钮」top1 必须 #addBtn，实际 ' + JSON.stringify(cart));
  const viaFull = runResolver(`{ field: 'addToCartBtn', semantic: '加入购物车按钮' }`);
  ok(viaFull.length >= 1 && viaFull[0].selector === '#addBtn', '「加入购物车按钮」top1 必须 #addBtn');
  const search = runResolver(`{ field: 'searchBtn', semantic: '搜索按钮' }`);
  ok(search.length >= 1 && search[0].selector === '#searchBtn', '「搜索按钮」零回归 top1 #searchBtn');
  const box = runResolver(`{ field: 'q', semantic: '搜索框' }`);
  ok(box.length >= 1 && box[0].selector === '#q', '「搜索框」零回归 top1 #q');
  const variants = execFileSync(process.execPath, ['-e', `
    const sr = require('${ROOT.replace(/\\/g, '/')}/server/agent/semanticResolver.js');
    console.log(JSON.stringify(sr.semanticVariants('加购按钮')));
  `], { encoding: 'utf8' });
  const v = JSON.parse(variants.trim());
  ok(v.length === 2 && v[1] === '加入购物车按钮', 'semanticVariants 展开正确，实际 ' + JSON.stringify(v));
  const v2 = JSON.parse(execFileSync(process.execPath, ['-e', `
    const sr = require('${ROOT.replace(/\\/g, '/')}/server/agent/semanticResolver.js');
    console.log(JSON.stringify(sr.semanticVariants('登录表单')));
  `], { encoding: 'utf8' }).trim());
  ok(v2.length === 1 && v2[0] === '登录表单', '无缩写命中时不变体');
}

// ── ② 记忆失败反馈置信度数学（纯函数，无 store 副作用）──
console.log('② 记忆失败反馈置信度数学');
{
  const { recordOutcome } = require(path.join(ROOT, 'server', 'agent', 'intelligence', 'memoryRecord.js'));
  const rec = { samples: { success: 16, failed: 0 }, successRate: 1, confidence: 1, source: { type: 'ai_success' }, status: 'ACTIVE' };
  const confs = [];
  for (let i = 0; i < 3; i++) { recordOutcome(rec, false); confs.push(rec.confidence); }
  ok(JSON.stringify(confs) === JSON.stringify([0.941, 0.889, 0.842]), '16胜记录连吃3败 confidence=0.941>0.889>0.842，实际 ' + confs.join(','));
  ok(confs[2] >= 0.8, '3 败后仍 >= MIN_CONFIDENCE（0.8）——证明纯反馈不足以单任务自愈，需数据修复配合');
  const weak = { samples: { success: 1, failed: 5 }, successRate: 0, confidence: 1, source: { type: 'ai_success' }, status: 'ACTIVE' };
  recordOutcome(weak, false);
  ok(weak.status === 'DEPRECATED', '长期低成功率（<0.4 且 total>=5）自动 DEPRECATED');
  const { getCandidate } = require(path.join(ROOT, 'server', 'agent', 'intelligence', 'elementMemory.js'));
  ok(typeof getCandidate === 'function' && getCandidate.length >= 2, 'getCandidate 可调用（降级入口存在）');
}

// ── ③ runtime.js 接线断言（验证失败收口路径存在惩罚调用）──
console.log('③ runtime.js 记忆惩罚接线');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'runtime.js'), 'utf8');
  const idxFail = src.indexOf("const failErr = {\n        code: 'VERIFY_FAILED',\n        message: vres.evidence.join('; '),");
  ok(idxFail > 0, '验证失败收口点定位');
  const before = src.slice(Math.max(0, idxFail - 1200), idxFail);
  ok(/P6（记忆失败反馈）/.test(before) && /recordFailure\(mc\.site, mc\.semantic, mc\.context/.test(before), 'failAttempt 前存在 recordFailure 惩罚调用');
  ok(/memoryConfirmation/.test(before), '惩罚以 memoryConfirmation（解析自记忆的候选）为条件');
  const confirmCount = (src.match(/confirmPendingSuccess/g) || []).length;
  ok(confirmCount >= 2, '既有 confirmPendingSuccess 双确认路径未被破坏（实际 ' + confirmCount + ' 处）');
}

// ── ④ repair 脚本（FPB_DATA_DIR 隔离）──
console.log('④ repair_poisoned_element_memory 脚本行为');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-repair-'));
  const poisoned = { id: 'p1', site: '127.0.0.1', status: 'ACTIVE', semantic: '加购按钮', confidence: 1, patterns: [{ text: '搜索', role: 'button', success: 16, failed: 0 }] };
  const healthy = { id: 'h1', site: '127.0.0.1', status: 'ACTIVE', semantic: '加入购物车按钮', confidence: 1, patterns: [{ text: '加入购物车', role: 'button', success: 10, failed: 0 }] };
  const otherSite = { id: 'o1', site: 'example.com', status: 'ACTIVE', semantic: '加购按钮', confidence: 1, patterns: [{ text: '搜索', role: 'button', success: 3, failed: 0 }] };
  const already = { id: 'd1', site: '127.0.0.1', status: 'DEPRECATED', semantic: '加购按钮', confidence: 0.2, patterns: [{ text: '搜索', role: 'button', success: 2, failed: 9 }] };
  fs.writeFileSync(path.join(tmp, 'aiElementMemory.json'), JSON.stringify([poisoned, healthy, otherSite, already]));
  const env = { ...process.env, FPB_DATA_DIR: tmp };
  const script = path.join(ROOT, 'server', 'scripts', 'repair_poisoned_element_memory.js');
  const dry = execFileSync(process.execPath, [script], { env, encoding: 'utf8' });
  ok(/命中投毒判据: 1/.test(dry), 'dry-run 恰好命中 1 条投毒记录');
  ok(/dry-run/.test(dry), 'dry-run 不写入标记输出');
  ok(JSON.parse(fs.readFileSync(path.join(tmp, 'aiElementMemory.json'), 'utf8')).find(r => r.id === 'p1').status === 'ACTIVE', 'dry-run 后投毒记录仍 ACTIVE（零写盘）');
  const applied = execFileSync(process.execPath, [script, '--apply'], { env, encoding: 'utf8' });
  ok(/已弃用 1 条/.test(applied), 'apply 弃用恰好 1 条');
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'aiElementMemory.json'), 'utf8'));
  ok(after.find(r => r.id === 'p1').status === 'DEPRECATED', '投毒记录已 DEPRECATED');
  ok(after.find(r => r.id === 'p1').deprecatedReason && /P6_DATA_REPAIR/.test(after.find(r => r.id === 'p1').deprecatedReason), '弃用原因可审计');
  ok(after.find(r => r.id === 'h1').status === 'ACTIVE', '健康记录不受影响');
  ok(after.find(r => r.id === 'o1').status === 'ACTIVE', '其他站点记录不受影响（site 限定 127.0.0.1）');
  const again = execFileSync(process.execPath, [script, '--apply'], { env, encoding: 'utf8' });
  ok(/命中投毒判据: 0/.test(again) && /已弃用 0 条/.test(again), '二次 apply 幂等（0 命中 0 写入）');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── ⑤ P1.2 bare-tag matching signal（Phase 13，rw.068 铁证）──
console.log('⑤ P1.2 semanticResolver bare-tag signal');
{
  const srMod = require(path.join(ROOT, 'server', 'agent', 'semanticResolver.js'));
  // Case A 正向：expect="h2"、池内有 h2[text=资源下载] → ≥1 candidate 且 top1 命中该 h2
  const caseA = execFileSync(process.execPath, ['-e', `
    const sr = require('${ROOT.replace(/\\/g, '/')}/server/agent/semanticResolver.js');
    const obs = { elements: [ { tag: 'h2', text: '资源下载', visible: true }, { tag: 'button', text: '下载', visible: true } ] };
    const c = sr.resolve('h2', obs);
    console.log(JSON.stringify(c.map(x => ({ tag: x.el.tag, score: x.score, matchedBy: x.matchedBy }))));
  `], { encoding: 'utf8' });
  const a = JSON.parse(caseA.trim().split('\n').pop());
  ok(a.length >= 1 && a[0].tag === 'h2' && a[0].matchedBy === 'attribute',
    'Case A: resolve("h2") 必须 ≥1 candidate 且 top1 tag=h2/matchedBy=attribute，实际 ' + JSON.stringify(a));

  // Case B 大小写归一：expect="H2" → 同样命中（normalize 全局 toLowerCase）
  const caseB = execFileSync(process.execPath, ['-e', `
    const sr = require('${ROOT.replace(/\\/g, '/')}/server/agent/semanticResolver.js');
    const obs = { elements: [ { tag: 'h2', text: '资源下载', visible: true } ] };
    console.log(JSON.stringify(sr.resolve('H2', obs).map(x => x.el.tag)));
  `], { encoding: 'utf8' });
  const b = JSON.parse(caseB.trim().split('\n').pop());
  ok(b.length === 1 && b[0] === 'h2', 'Case B: resolve("H2") 大小写不敏感命中 h2，实际 ' + JSON.stringify(b));

  // Case C 不可满足自然语言不能被 bare-tag 伪造：「商品列表容器」不在词表，bare-tag 信号零参与。
  // 注：若语义池元素 text 与 expect 有中文 bigram 重叠，命中来自既有 scoreSemantic 信号（非本 Phase 新增），
  // 其 matchedBy 必须为 'semantic'；真实 observation contract 中 div 不入池，结构性 0 候选不变。
  const caseC = execFileSync(process.execPath, ['-e', `
    const sr = require('${ROOT.replace(/\\/g, '/')}/server/agent/semanticResolver.js');
    const obs = { elements: [ { tag: 'div', id: 'list', text: '商品列表', visible: true } ] };
    const c = sr.resolve('商品列表容器', obs);
    console.log(JSON.stringify({ n: c.length, by: c.map(x => x.matchedBy) }));
  `], { encoding: 'utf8' });
  const c = JSON.parse(caseC.trim().split('\n').pop());
  ok(srMod.bareTagHint('商品列表容器') === null, 'Case C: 「商品列表容器」不在词表，bareTagHint=null');
  ok(c.by.every((m) => m !== 'tag'), 'Case C: 无任何候选经 bare-tag 命中，实际 ' + JSON.stringify(c));

  // Case D 不存在元素：expect="form"、池内只有 input/button → 0 candidate
  const caseD = execFileSync(process.execPath, ['-e', `
    const sr = require('${ROOT.replace(/\\/g, '/')}/server/agent/semanticResolver.js');
    const obs = { elements: [ { tag: 'input', name: 'q', visible: true }, { tag: 'button', text: '搜索', visible: true } ] };
    console.log(JSON.stringify(sr.resolve('form', obs).length));
  `], { encoding: 'utf8' });
  ok(JSON.parse(caseD.trim().split('\n').pop()) === 0, 'Case D: 池内无 form 元素时 resolve("form") 必须 0 candidate');

  // Case E CSS 不回归：expect="#searchBtn" 仍走 CSS selector fallback 行为不变
  const caseE = execFileSync(process.execPath, ['-e', `
    const sr = require('${ROOT.replace(/\\/g, '/')}/server/agent/semanticResolver.js');
    const obs = { elements: [ { id: 'searchBtn', role: 'button', tag: 'button', text: '搜索', visible: true } ] };
    const c = sr.resolve('#searchBtn', obs);
    console.log(JSON.stringify(c.map(x => ({ selector: x.selector, matchedBy: x.matchedBy }))));
  `], { encoding: 'utf8' });
  const e = JSON.parse(caseE.trim().split('\n').pop());
  ok(e.length >= 1 && e[0].selector === '#searchBtn', 'Case E: CSS 形态仍走 fallback 命中 #searchBtn，实际 ' + JSON.stringify(e));

  // 词表 = 显式 tag vocabulary（CONTROL ∪ DESCRIPTIVE），非猜测 heuristic
  const want = new Set(['input', 'textarea', 'select', 'button', 'a', 'summary', 'form', 'label', 'h1', 'h2', 'h3', 'img']);
  ok(srMod.BARE_TAGS && srMod.BARE_TAGS.size === want.size && [...want].every((t) => srMod.BARE_TAGS.has(t)),
    'BARE_TAGS 词表 = CONTROL_TAGS ∪ DESCRIPTIVE_TAGS 全集');
  ok(srMod.bareTagHint('a >> css=input') === null, 'CSS 形态 target 不触发 bare-tag（优先 fallback）');
  ok(srMod.bareTagHint('加入购物车') === null, '自然语言不触发 bare-tag');
}

console.log('\n结果: ' + passed + ' passed / ' + failed + ' failed');
process.exit(failed ? 1 : 0);
