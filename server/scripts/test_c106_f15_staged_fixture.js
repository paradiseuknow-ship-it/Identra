'use strict';
// C106 F15 — 分步表单推进【真实浏览器 fixture】端到端守护。
//
// 为什么还需要这一层（不能只靠零浏览器 stub）：
//   C105 的核心教训是「fixture 绿 ≠ 真实站点绿」——四个真实缺陷无一被本地 fixture 覆盖。
//   stub 版守护只证明控制流正确，证明不了「真实 observation 能看到 Continue 按钮」、
//   「semanticResolver 能把 semantic='Continue' 接到真实 DOM 上」、
//   「真实浏览器点击后重新观察能解析到 password」这三件事。
//   本文件用真实 Chromium + 真实 observation/semanticResolver + 真实点击验证整链路。
//
// 覆盖场景：
//   A 标准分步表单（email + Continue → 点击后挂载 password）→ 推进成功
//   B 死路（有 Continue 但点击后 password 仍不出现）→ 推进失败且只点一次
//   C 无前进控件（只有 email）→ 零点击

const http = require('http');
const { chromium } = require('playwright');
const observation = require('../agent/observation');
const tools = require('../agent/tools');
const stagedForm = require('../agent/stagedFormAdvance');
const { listenSafe } = require('./lib_safe_port');

const PAGES = {
  // A：Webflow 注册分步表单的同构复刻（邮箱 → 继续 → 密码）
  '/staged': [
    '<!doctype html><html><body><form id="signup" action="#">',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '<button id="continue-btn" type="submit">Continue</button>',
    '<div id="step2" style="display:none">',
    '<input id="password" name="password" type="password" placeholder="Password">',
    '<button id="create-btn" type="submit">Create account</button>',
    '</div></form>',
    '<script>',
    "document.getElementById('continue-btn').addEventListener('click', function(e){",
    "  e.preventDefault();",
    "  document.getElementById('step2').style.display='block';",
    "  this.style.display='none';",
    '});',
    '</script></body></html>',
  ].join('\n'),

  // B：死路 —— Continue 存在且可点，但推进后目标字段仍不出现（必须立刻停止，不连点）
  '/deadend': [
    '<!doctype html><html><body><form id="signup" action="#">',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '<button id="continue-btn" type="submit">Continue</button>',
    '</form>',
    '<script>',
    "document.getElementById('continue-btn').addEventListener('click', function(e){ e.preventDefault(); });",
    '</script></body></html>',
  ].join('\n'),

  // C：无前进控件 —— 只有 email，没有任何 Continue/Next/Submit
  '/noadvance': [
    '<!doctype html><html><body><form id="signup" action="#">',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '</form></body></html>',
  ].join('\n'),
};

let pass = 0; let fail = 0; const rows = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('❌ FAIL | ' + name + ' | ' + detail); }
  rows.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (detail || ''));
}

function makeDeps(page) {
  const state = { clicks: [] };
  return {
    state,
    deps: {
      task: { id: 'c106fixture', profileId: 'fixture', currentExecutionId: 'e1' },
      step: { id: 's_fill_password' },
      action: { type: 'fill', target: { field: 'password' } },
      browserManager: { getPage: async () => page },
      observation,
      tools: {
        resolveSelector: (action, obs, meta, pg, opts) => tools.resolveSelector(action, obs, meta, pg, opts),
        execute: async ({ action }) => {
          const sel = (action.target || {}).selector;
          state.clicks.push({ semantic: (action.target || {}).semantic, selector: sel });
          try {
            await page.click(sel, { timeout: 5000 });
            return { success: true, observation: {} };
          } catch (e) {
            return { success: false, error: { code: 'ELEMENT_NOT_FOUND', message: String((e && e.message) || e).slice(0, 120) } };
          }
        },
      },
    },
  };
}

(async () => {
  const server = http.createServer((req, res) => {
    const p = String(req.url || '/').split('?')[0];
    const html = PAGES[p];
    if (!html) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  // C94：临时端口必须避开 Chrome unsafe-port 黑名单（端口 0 自动分配可能命中 6000 → ERR_UNSAFE_PORT）
  await listenSafe(server, '127.0.0.1');
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true });

  try {
    // ── A：标准分步表单 ──
    {
      const page = await browser.newPage();
      await page.goto(BASE + '/staged', { waitUntil: 'domcontentloaded' });
      const { deps, state } = makeDeps(page);

      const obs0 = await observation.inspect(page, { taskId: 'c106fixture' });
      const before = await tools.resolveSelector(deps.action, obs0.observation, {}, page);
      check('A0 推进前 password 字段确实不可解析（尚未挂载）', !before, before && before.selector);

      const r = await stagedForm.tryAdvance(deps);
      check('A1 推进成功', r.advanced === true, JSON.stringify({ advanced: r.advanced, term: r.term, reason: r.reason }));
      check('A2 命中前进控件 Continue', r.term === 'Continue', r.term);
      check('A3 点击 selector 指向 #continue-btn', String(r.selector || '').indexOf('continue-btn') >= 0, r.selector);
      check('A4 仅点击一次', state.clicks.length === 1, JSON.stringify(state.clicks));

      const obs2 = await observation.inspect(page, { taskId: 'c106fixture', skipCache: true });
      const after = await tools.resolveSelector(deps.action, obs2.observation, {}, page);
      check('A5 推进后 password 可解析', !!(after && after.selector), after && after.selector);
      check('A6 解析结果非合成 id（#el-N）', !!(after && after.selector) && !stagedForm.isSyntheticSelector(after.selector), after && after.selector);
      await page.close();
    }

    // ── B：死路（推进后字段仍不出现）──
    {
      const page = await browser.newPage();
      await page.goto(BASE + '/deadend', { waitUntil: 'domcontentloaded' });
      const { deps, state } = makeDeps(page);
      const r = await stagedForm.tryAdvance(deps);
      check('B1 死路 → advanced=false', r.advanced === false, JSON.stringify({ advanced: r.advanced, reason: r.reason }));
      check('B2 reason=field_still_absent', r.reason === 'field_still_absent', r.reason);
      check('B3 只点击一次（不连点第二个前进词）', state.clicks.length === 1, JSON.stringify(state.clicks));
      await page.close();
    }

    // ── C：无前进控件 ──
    {
      const page = await browser.newPage();
      await page.goto(BASE + '/noadvance', { waitUntil: 'domcontentloaded' });
      const { deps, state } = makeDeps(page);
      const r = await stagedForm.tryAdvance(deps);
      check('C1 无前进控件 → advanced=false', r.advanced === false, JSON.stringify({ advanced: r.advanced, reason: r.reason }));
      check('C2 reason=no_advance_control', r.reason === 'no_advance_control', r.reason);
      check('C3 零点击（不误点页面其他元素）', state.clicks.length === 0, JSON.stringify(state.clicks));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n================================================================');
  console.log('PASS: ' + pass + ' / FAIL: ' + fail);
  if (fail > 0) { console.log('失败项:\n' + rows.filter((r) => r.startsWith('FAIL')).join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
