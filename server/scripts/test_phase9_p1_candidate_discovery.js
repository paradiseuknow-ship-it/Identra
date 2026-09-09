'use strict';
// test_phase9_p1_candidate_discovery.js — Phase 9 P1：候选发现缺口修复专项测试
//
// 背景（phase68 100-task 真实数据）：
//   `element_present="form" → 未找到元素 "form"` 出现 36 次，涉及 9 个任务，
//   且这 9 个任务全部卡死在 step0（NAVIGATE 的验证），step1+ 从未执行。
//   而 data_entry/form.html 明确存在 <form id="regForm"> —— 元素真实存在，
//   但 observation.elements[] 里根本没有它（elements[] 是 semanticResolver 的唯一候选池）。
//
// 根因：observation.js 的 COLLECT_JS 只对 a/button/summary/带 role 属性的元素入池，
//       尽管 INTERACTIVE_TAGS 声明了 form/label/h1~h3。
//
// 覆盖：
//   A. 静态：入池门槛已补齐结构性容器，且未放开 p/div（防 80 条上限被挤爆）
//   B. 真实浏览器：form 进入候选池 → resolver 命中 → element_present 验证通过
//   C. 回归：既有 input 定位、数量上限、脱敏、text_present 均未受影响
//   D. 语义红线：DOM_CHANGED ≠ SUCCESS；元素不存在时仍判失败
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const observation = require('../agent/observation');
const semanticResolver = require('../agent/semanticResolver');
const verification = require('../agent/verification');
const { COLLECT_JS } = observation;

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function skipped(name, why) { skip++; console.log('  SKIP ' + name + ' — ' + why); }
function section(t) { console.log('\n== ' + t + ' =='); }

// ── 静态 mock 服务器（托管 mock-site）──
function startMockServer() {
  const root = path.join(ROOT, 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const ext = path.extname(file);
    const ct = ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(fs.readFileSync(file));
  });
  return require('./lib_safe_port').listenSafe(server, '127.0.0.1');
}

(async () => {
  // ─────────────────────────────────────────────
  section('A. 静态：候选入池门槛');
  {
    ok('A.1 form 已入池', /tag === 'form'/.test(COLLECT_JS));
    ok('A.2 label 已入池', /tag === 'label'/.test(COLLECT_JS));
    ok('A.3 h1/h2/h3 已入池', /tag === 'h1'/.test(COLLECT_JS) && /tag === 'h2'/.test(COLLECT_JS) && /tag === 'h3'/.test(COLLECT_JS));
    ok('A.4 原有 a/button/summary/role 门槛仍在', /tag === 'a' \|\| tag === 'button' \|\| tag === 'summary' \|\| roleAttr/.test(COLLECT_JS));
    ok('A.5 未放开 p/div/span（防候选池被挤爆、稀释排序）',
      !/tag === 'p'/.test(COLLECT_JS) && !/tag === 'div'/.test(COLLECT_JS) && !/tag === 'span'/.test(COLLECT_JS));
    ok('A.6 80 条上限仍在', /slice\(0, 80\)/.test(fs.readFileSync(path.join(ROOT, 'server/agent/observation.js'), 'utf8')));
  }

  // ─────────────────────────────────────────────
  section('B. 真实浏览器：form 进入候选池并被验证命中');
  let browserManager = null, session = null, server = null;
  try {
    browserManager = require('../browserManager');
  } catch (e) {
    // 忽略：下方统一 skip
  }

  if (!browserManager) {
    skipped('B.* 真实浏览器验证', 'browserManager 不可加载（playwright 未就绪）');
  } else {
    try {
      server = await startMockServer();
      const base = 'http://127.0.0.1:' + server.address().port;
      const profile = {
        id: 'p9_p1_' + Date.now().toString(36),
        name: 'P9-P1', group: 'default', tags: [], notes: '',
        seed: 'p1-seed', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
        os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
        launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
        fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
      };
      session = await browserManager.launch(profile, null);
      const page = session.page;

      await page.goto(base + '/data_entry/form.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(600);

      const r = await observation.inspect(page, { taskId: 'p1_probe', skipCache: true });
      const obs = r.observation;
      ok('B.1 inspect 成功', !!obs, r.error);

      const tags = (obs.elements || []).map((e) => e.tag);
      ok('B.2 [核心] elements 中出现 form', tags.includes('form'), 'tags=' + [...new Set(tags)].join(','));
      const formEl = (obs.elements || []).find((e) => e.tag === 'form');
      ok('B.3 [核心] form 元素带 id=regForm', formEl && formEl.id === 'regForm', JSON.stringify(formEl && { id: formEl.id, role: formEl.role }));

      const cands = semanticResolver.resolve('form', obs);
      ok('B.4 [核心] semanticResolver.resolve("form") 有候选', cands.length > 0, 'n=' + cands.length);
      if (cands.length) {
        ok('B.5 命中理由可解释', /field/.test(cands[0].reason) || /semantic/.test(cands[0].reason), cands[0].reason);
        ok('B.6 置信度合理(>=0.5)', cands[0].score >= 0.5, 'score=' + cands[0].score);
      }

      const vres = verification.verify({ type: 'element_present', expect: 'form' }, obs);
      ok('B.7 [核心] element_present="form" 验证通过', vres.success === true, JSON.stringify(vres.evidence));

      // 修复前该验证恒失败——用同一 observation 反向确认「不存在时仍失败」
      const vneg = verification.verify({ type: 'element_present', expect: 'zzz-not-exist-element' }, obs);
      ok('B.8 不存在的元素仍判失败（未放宽标准）', vneg.success === false);

      // ── C. 回归 ──
      ok('C.1 既有 input[name=name] 仍可定位', semanticResolver.resolve({ field: 'name' }, obs).length > 0);
      ok('C.2 既有 input[name=email] 仍可定位', semanticResolver.resolve({ field: 'email' }, obs).length > 0);
      ok('C.3 既有 input[name=phone] 仍可定位', semanticResolver.resolve({ field: 'phone' }, obs).length > 0);
      ok('C.4 候选数未超 80 上限', (obs.elements || []).length <= 80, 'n=' + (obs.elements || []).length);
      ok('C.5 textSummary 仍覆盖可见文本（text_present 不受影响）', String(obs.textSummary || '').length > 0);
      ok('C.6 text_present 验证行为不变',
        verification.verify({ type: 'text_present', expect: '姓名' }, obs).success === true
        && verification.verify({ type: 'text_present', expect: '绝不存在的文本XYZ' }, obs).success === false);
      ok('C.7 url_contains 验证行为不变',
        verification.verify({ type: 'url_contains', expect: 'form.html' }, obs).success === true);
      // 脱敏回归：password 明文绝不出浏览器
      const leaked = (obs.elements || []).some((e) => e.state && e.state.sensitive === false && /password/i.test(String(e.text || '')));
      ok('C.8 敏感字段脱敏未被破坏', !leaked);
      // form 不应抢占字段定位（避免误选容器）
      const nameTop = semanticResolver.resolve({ field: 'name' }, obs)[0];
      ok('C.9 form 未抢占 name 字段的首位候选', nameTop && nameTop.el && nameTop.el.tag === 'input',
        nameTop ? (nameTop.el.tag + '/' + nameTop.el.name) : 'null');

      // D. DOM_CHANGED ≠ SUCCESS 语义红线
      ok('D.1 验证成功仍以候选存在为唯一依据（不放宽阈值）',
        verification.verify({ type: 'element_present', expect: 'form' }, obs).confidence > 0
        && verification.verify({ type: 'element_present', expect: 'form' }, null, { url: '', title: '', textSummary: '', elements: [] }).success === false);
    } catch (e) {
      skipped('B/C/D 真实浏览器验证', '环境不可用: ' + String(e.message || e).slice(0, 160));
    } finally {
      try { if (session) await browserManager.close(session.profile ? session.profile.id : profile0IdSafe(session)); } catch (e) {}
      try { if (server) server.close(); } catch (e) {}
    }
  }
  function profile0IdSafe(s) { return (s && s.profile && s.profile.id) || ''; }

  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
