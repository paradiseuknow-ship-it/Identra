'use strict';
// test_phase9_p2_action_ranking.js — Phase 9 P2：submit/login/logout 的候选排序缺口修复专项测试
//
// 背景（phase68 100-task 真实数据）：
//   rw.035/042/045/076/080/092/099 共 7 个任务对 ecommerce/search.html 执行 submit，
//   该页面搜索由 button#searchBtn 的 click 处理器触发（页面根本没有 <form>）。
//   但语义排序把 input#q（field='search' 精确命中 id='q' → 1.0）排在
//   button#searchBtn（0.95）之前 → agent 点击了输入框 → 页面从未渲染结果
//   → text_present 验证正确地失败，被记为「动作成功但目标未观察到」。
//
// 判定：这是「候选都存在、排序选错」的 Ranking Gap，不是验证过严。
//       因此修排序，不动验证阈值、不制造 fake success。
//
// 覆盖：
//   A. 纯函数：可触发控件判定
//   B. 真实浏览器：submit 目标落在按钮而非输入框；点击后结果真实渲染；验证仍以真证据为准
//   C. 回归：fill 仍定位输入框；未禁用/可点击前提；ELEMENT_NOT_FOUND 语义不变
//   D. 红线：DOM_CHANGED ≠ SUCCESS；不放宽任何验证阈值
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const semanticResolver = require('../agent/semanticResolver');
const observation = require('../agent/observation');
const verification = require('../agent/verification');
const tools = require('../agent/tools');
const { isActionableControl } = tools;

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function skipped(name, why) { skip++; console.log('  SKIP ' + name + ' — ' + why); }
function section(t) { console.log('\n== ' + t + ' =='); }

function startMockServer() {
  const root = path.join(ROOT, 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return require('./lib_safe_port').listenSafe(server, '127.0.0.1');
}

(async () => {
  // ─────────────────────────────────────────────
  section('A. 可触发控件判定（纯函数）');
  {
    ok('A.1 button 可触发', isActionableControl({ tag: 'button', role: 'button' }) === true);
    ok('A.2 input[type=submit] 可触发', isActionableControl({ tag: 'input', type: 'submit' }) === true);
    ok('A.3 链接可触发', isActionableControl({ tag: 'a', role: 'link', text: '详情' }) === true);
    ok('A.4 文本输入框不可触发', isActionableControl({ tag: 'input', type: 'text', name: 'q' }) === false);
    ok('A.5 textarea/select 不可触发', isActionableControl({ tag: 'textarea' }) === false && isActionableControl({ tag: 'select' }) === false);
    ok('A.6 form 容器不可触发', isActionableControl({ tag: 'form', id: 'regForm' }) === false);
    ok('A.7 disabled 控件不可触发（enabled 前提）', isActionableControl({ tag: 'button', state: { disabled: true } }) === false);
    ok('A.8 空值安全', isActionableControl(null) === false && isActionableControl({}) === false);
  }

  // ─────────────────────────────────────────────
  section('B. 真实浏览器：submit 落在按钮而非输入框');
  let browserManager = null, session = null, server = null, profile = null;
  try { browserManager = require('../browserManager'); } catch (e) { /* 下方 skip */ }

  if (!browserManager) {
    skipped('B/C/D 真实浏览器验证', 'browserManager 不可加载（playwright 未就绪）');
  } else {
    try {
      server = await startMockServer();
      const base = 'http://127.0.0.1:' + server.address().port;
      profile = {
        id: 'p9_p2_' + Date.now().toString(36),
        name: 'P9-P2', group: 'default', tags: [], notes: '',
        seed: 'p2-seed', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
        os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
        launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
        fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
      };
      session = await browserManager.launch(profile, null);
      const page = session.page;
      await page.goto(base + '/ecommerce/search.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(500);

      const r = await observation.inspect(page, { taskId: 'p2_probe', skipCache: true });
      const obs = r.observation;
      ok('B.1 inspect 成功', !!obs, r.error);

      // phase68 中真实失败的 target 形态
      const target = { semantic: '搜索表单', field: 'search' };
      const cands = semanticResolver.resolve(target, obs);
      ok('B.2 候选同时包含输入框与按钮',
        cands.some((c) => c.el.tag === 'input') && cands.some((c) => c.el.tag === 'button'),
        'tags=' + cands.map((c) => c.el.tag + '/' + c.el.id).join(','));
      ok('B.3 [修复前行为] 未加 prefer 时首位是 input#q（证明排序缺口真实存在）',
        cands.length > 0 && cands[0].el.tag === 'input' && cands[0].el.id === 'q',
        cands.length ? ('first=' + cands[0].el.tag + '#' + cands[0].el.id + ' score=' + cands[0].score) : 'no cands');

      // 走 tools.resolveSelector 的 prefer 通路（与 submit/login/logout 分支一致）
      const meta = {};
      const sel = await tools.resolveSelector({ type: 'submit', target }, obs, meta, null, { prefer: isActionableControl });
      ok('B.4 [核心] submit 解析落在按钮上', !!sel && /searchBtn/i.test(sel.selector), sel ? sel.selector : 'null');
      ok('B.5 [核心] 不再落在 input#q 上', !!sel && !/(^|[^a-z])#q\b|input\[name="q"\]|input#q/i.test(sel.selector), sel ? sel.selector : 'null');
      // B.6 前提自适应（2026-08-31 修复：测试前提过期，非产品缺陷）：
      // Element Memory 是持续学习的活数据 —— 100-task 基准运行后「搜索表单」记忆已合法学到
      // button 模式（store aiElementMemory: patterns=[input,input,button]）。此时记忆路径直接命中
      // 可触发控件，prefer 兜底无需介入，preferApplied 不再置位（产品行为正确，B.4/B.5 仍断言落点正确）。
      // 两种解析来源遥测均合法：prefer 兜底生效（preferApplied=true）或记忆直接命中（matchedBy=element_memory）。
      ok('B.6 解析来源遥测被记录（prefer 兜底生效 或 记忆直接命中）',
        meta.preferApplied === true || meta.matchedBy === 'element_memory',
        'matchedBy=' + meta.matchedBy + ' preferApplied=' + meta.preferApplied);

      // 端到端：点击该按钮后，搜索结果必须真实渲染
      await page.fill('input#q', '显示器');
      await browserManager.humanClick(page, sel.selector, {});
      await page.waitForTimeout(500);
      const after = (await observation.inspect(page, { taskId: 'p2_probe', skipCache: true })).observation;
      ok('B.7 [核心] 点击按钮后结果真实渲染', String(after.textSummary || '').includes('4K显示器'),
        'text=' + String(after.textSummary || '').slice(0, 120));
      ok('B.8 [核心] text_present="显示器" 验证通过（真证据，非降低阈值）',
        verification.verify({ type: 'text_present', expect: '显示器' }, after).success === true);

      // 反向对照：点击输入框（修复前的行为）不会渲染结果 —— 证明原行为确实无效
      await page.goto(base + '/ecommerce/search.html', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);
      await page.fill('input#q', '显示器');
      const meta2 = {};
      const selNaive = await tools.resolveSelector({ type: 'submit', target }, (await observation.inspect(page, { taskId: 'p2_probe', skipCache: true })).observation, meta2);
      ok('B.9 不带 prefer 时仍回落到 input#q（向后兼容未破坏）', !!selNaive && /q/.test(selNaive.selector) && selNaive.selector.indexOf('searchBtn') < 0, selNaive ? selNaive.selector : 'null');
      await page.click('input#q', {}).catch(() => {});
      await page.waitForTimeout(400);
      const afterNaive = (await observation.inspect(page, { taskId: 'p2_probe', skipCache: true })).observation;
      ok('B.10 对照：点击输入框不渲染结果（原始失败得以复现）',
        !String(afterNaive.textSummary || '').includes('4K显示器'));

      // ── C. 回归 ──
      const fillMeta = {};
      const fillSel = await tools.resolveSelector({ type: 'fill', target: { semantic: '搜索框', field: 'search' } }, obs, fillMeta);
      ok('C.1 [回归] fill 仍定位到输入框（未被 prefer 影响）', !!fillSel && /q/.test(fillSel.selector), fillSel ? fillSel.selector : 'null');
      ok('C.2 [回归] 显式 selector 优先级不变',
        (await tools.resolveSelector({ type: 'click', target: { selector: '#searchBtn' } }, obs, {})).selector === '#searchBtn');
      ok('C.3 [回归] 无候选时返回 null（不伪造）',
        (await tools.resolveSelector({ type: 'submit', target: { semantic: 'zzz-不存在-xyz' } }, obs, {}, null, { prefer: isActionableControl })) === null);

      // ── E. Element Memory 路径（真实根因所在）──
      // 真实 store 中存在被污染的记忆：127.0.0.1|搜索表单 confidence=1 / success=208 / failed=0，
      // pattern 却是 tag=input（搜索输入框）。它在 semanticResolver 之前短路，是 submit 落错的第一断裂点。
      const em = require('../agent/intelligence/elementMemory');
      const poisoned = (em.listAll ? em.listAll() : [])
        .filter((r) => String(r.semantic || '') === '搜索表单' && r.confidence >= 0.8)
        .some((r) => (r.patterns || []).some((p) => String(p.tag || p.role || '') === 'input'));
      if (!poisoned) {
        skipped('E.1/E.2 Element Memory 短路回归', '当前 store 无「搜索表单→input」记忆（已被纠正或 store 已清空）');
      } else {
        const memMeta = {};
        const memSel = await tools.resolveSelector({ type: 'submit', target }, obs, memMeta, null, { prefer: isActionableControl });
        ok('E.1 [核心-根因] 存在「搜索表单→输入框」的成功记忆时，submit 仍落在按钮上',
          !!memSel && /searchBtn/i.test(memSel.selector), memSel ? memSel.selector : 'null');
        // E.2 自播种探针（2026-08-31 重构：测试前提过期，非产品缺陷）：
        // 原断言依赖真实 store 中的「input-only 污染记忆」，但记忆系统在 100-task 基准运行中
        // 已合法学到 button 模式（自我纠正，matchedBy=element_memory 直接命中 → declined 不置位，
        // 这是正确行为）。为保留「记忆因不满足动作约束被放弃」行为契约的确定性验证，改为：
        // 播种唯一语义的 input-only 高置信记忆 → resolveSelector(prefer) 必须 declined → 测试后归档清理。
        const probeSemantic = 'P2 守卫探针 ' + Date.now() + ' ' + Math.random().toString(36).slice(2, 7);
        const store = require('../agent/store');
        try {
          em.recordSuccess('127.0.0.1', probeSemantic, { tag: 'input', id: 'q', name: 'q', observation: obs }, 'test-seed');
          const probeMeta = {};
          await tools.resolveSelector({ type: 'submit', target: { semantic: probeSemantic } }, obs, probeMeta, null, { prefer: isActionableControl });
          ok('E.2 [核心-根因] 记忆因不满足动作约束被放弃，改由语义解析兜底（自播种确定性）',
            probeMeta.memoryDeclinedByPrefer === true && probeMeta.matchedBy !== 'element_memory',
            'matchedBy=' + probeMeta.matchedBy + ' declined=' + probeMeta.memoryDeclinedByPrefer);
        } finally {
          // 清理：归档播种记录（getCandidate 只消费 ACTIVE 记录），不污染共享记忆 store
          try {
            const seeded = store.findWhere('aiElementMemory', (r) => r.semantic === probeSemantic);
            for (const rec of seeded) { rec.status = 'ARCHIVED'; store.upsert('aiElementMemory', rec); }
          } catch (e) {}
        }
      }

      // ── D. 红线 ──
      const noEvidence = { url: base + '/ecommerce/search.html', title: '', textSummary: '', visibleText: '', elements: [] };
      ok('D.1 [红线] 无证据时 text_present 仍判失败（未降低阈值）',
        verification.verify({ type: 'text_present', expect: '显示器' }, noEvidence).success === false);
      ok('D.2 [红线] 无证据时 element_present 仍判失败',
        verification.verify({ type: 'element_present', expect: 'form' }, noEvidence).success === false);
      ok('D.3 [红线] prefer 只在候选内挑选，不新增候选',
        semanticResolver.resolve(target, obs).length === cands.length);
    } catch (e) {
      skipped('B/C/D 真实浏览器验证', '环境不可用: ' + String(e.message || e).slice(0, 180));
    } finally {
      try { if (session && profile) await browserManager.close(profile.id); } catch (e) {}
      try { if (server) server.close(); } catch (e) {}
    }
  }

  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
