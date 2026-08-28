'use strict';

// Phase 11 — Business Completion Contract tests.
// 真实 Chromium + 真实 DOM（mock-site/phase11）+ 真实 verification 引擎。
// 覆盖：action≠business / objective→state / login / search / submit / alternative / forbidden。
// 运行：node server/scripts/test_phase11_business_contract.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const verification = require('../agent/verification');
const contract = require('../agent/verification/contract');
const observation = require('../agent/observation');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
function section(name) { console.log('\n=== ' + name + ' ==='); }

function startServer() {
  const root = path.resolve(__dirname, '..', '..', 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.statusCode = 403; res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.end('not found'); return; }
      const ext = path.extname(file);
      const ct = ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain';
      res.setHeader('Content-Type', ct);
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// 取真实页面观察（真实 DOM 快照，非 mock）
async function obs(page) {
  const r = await observation.inspect(page, { skipCache: true });
  return r.observation;
}

async function main() {
  const mock = await startServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  const browser = await chromium.launch({ headless: true });

  // ---- 1. action success ≠ business success ----
  section('1. action success ≠ business success（P0 核心）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/phase11/login-fail.html');
    const o = await obs(page);
    // action_success 只看工具是否成功 → 即便页面仍是登录失败页也判成功（错误口径）
    const aOk = verification.verify({ type: 'action_success' }, o, {});
    // 业务完成契约（LOGIN_SUCCESS）看业务结果 → 失败页不应判成功
    const bOk = verification.verify({ businessState: contract.deriveContract({ type: 'login' }) }, o, {});
    ok(aOk.success === true, 'action_success 把「动作执行」误判为成功（证据：still shows login form）');
    ok(bOk.success === false, 'ExpectedBusinessState(LOGIN_SUCCESS) 正确拒绝「动作成功但业务未完成」');
    ok(aOk.success !== bOk.success, '两者结论相反 → 证明 action≠business 被 contract 区分');
    await page.close();
  }

  // ---- 2. objective → expected business state ----
  section('2. objective → expected business state（映射）');
  {
    const c1 = contract.contractFromObjective('登录 SaaS 控制台', { type: 'click' });
    ok(c1 && c1.stateType === 'LOGIN_SUCCESS', 'objective「登录」→ LOGIN_SUCCESS（即使动作是 click）');
    const c2 = contract.contractFromObjective('搜索商品', { type: 'click' });
    ok(c2 && c2.stateType === 'SEARCH_SUCCESS', 'objective「搜索」→ SEARCH_SUCCESS');
    const c3 = contract.contractFromObjective('提交订单', { type: 'click' });
    ok(c3 && c3.stateType === 'FORM_SUBMIT_SUCCESS', 'objective「提交」→ FORM_SUBMIT_SUCCESS');
    // action 类型推导兜底
    const c4 = contract.deriveContract({ type: 'fill', value: 'hello' });
    ok(c4 && c4.stateType === 'FIELD_FILLED' && c4.requiredEvidence[0].expect === 'hello', 'deriveContract(fill,value=hello) → FIELD_FILLED 且 expect 已注入值');
    // validateContract
    const vr = contract.validateContract(c1);
    ok(vr.ok === true, 'validateContract(LOGIN_SUCCESS) 通过');
    const vr2 = contract.validateContract({ stateType: 'BOGUS', requiredEvidence: [] });
    ok(vr2.ok === false, 'validateContract 拒绝非法 stateType / 空 requiredEvidence');
  }

  // ---- 3. login success ----
  section('3. login success（真实 DOM）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/phase11/login-ok.html');
    const o = await obs(page);
    const r = verification.verify({ businessState: contract.deriveContract({ type: 'login' }) }, o, {});
    ok(r.success === true, '登录成功页 → LOGIN_SUCCESS 通过（evidence=' + (r.evidence[0] || '').slice(0, 40) + '）');
    await page.close();
  }

  // ---- 4. login failure ----
  section('4. login failure（真实 DOM，含 forbidden）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/phase11/login-fail.html');
    const o = await obs(page);
    const r = verification.verify({ businessState: contract.deriveContract({ type: 'login' }) }, o, {});
    ok(r.success === false, '登录失败页 → LOGIN_SUCCESS 拒绝');
    ok(r.forbiddenHit !== null, 'forbidden 信号（invalid）被识别 → 即便 required 部分命中也硬失败');
    await page.close();
  }

  // ---- 5. search success ----
  section('5. search success（真实 DOM）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/phase11/search-results.html');
    const o = await obs(page);
    const r = verification.verify({ businessState: contract.deriveContract({ type: 'search' }) }, o, {});
    ok(r.success === true, '有结果页 → SEARCH_SUCCESS 通过');
    await page.close();
  }

  // ---- 6. search empty ----
  section('6. search empty（真实 DOM，forbidden）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/phase11/search-empty.html');
    const o = await obs(page);
    const r = verification.verify({ businessState: contract.deriveContract({ type: 'search' }) }, o, {});
    ok(r.success === false, '无结果页 → SEARCH_SUCCESS 拒绝（forbidden "no results" 命中）');
    await page.close();
  }

  // ---- 7. form submit success ----
  section('7. form submit success（真实 DOM）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/phase11/submit-ok.html');
    const o = await obs(page);
    const r = verification.verify({ businessState: contract.deriveContract({ type: 'submit' }) }, o, {});
    ok(r.success === true, '提交成功页（Success/Confirmation） → FORM_SUBMIT_SUCCESS 通过');
    await page.close();
  }

  // ---- 8. form submit failure ----
  section('8. form submit failure（真实 DOM，forbidden）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/phase11/submit-fail.html');
    const o = await obs(page);
    const r = verification.verify({ businessState: contract.deriveContract({ type: 'submit' }) }, o, {});
    ok(r.success === false, '错误页（Error） → FORM_SUBMIT_SUCCESS 拒绝（forbidden "error" 命中）');
    await page.close();
  }

  // ---- 9. verification alternative state ----
  section('9. verification alternative state（allowedAlternatives）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/phase11/login-ok.html');
    const o = await obs(page);
    // required 故意要求不存在的 "checkout"，但允许 alternative "welcome"
    const c = {
      stateType: 'LOGIN_SUCCESS', expected: 'authenticated',
      requiredEvidence: [{ type: 'text_present', expect: 'checkout' }],
      forbiddenEvidence: [], allowedAlternatives: [{ type: 'text_present', expect: 'welcome' }],
      evidenceLogic: 'AND', confidence: 0.9,
    };
    const r = verification.verify({ businessState: c }, o, {});
    ok(r.success === true && r.alternativesMatched, 'required 未命中但 alternative(welcome) 命中 → 仍判成功');
    await page.close();
  }

  // ---- 10. forbidden evidence（硬失败优先） ----
  section('10. forbidden evidence（即便 required 命中也硬失败）');
  {
    const page = await browser.newPage();
    await page.goto(baseUrl + '/phase11/login-fail.html');
    const o = await obs(page);
    const c = {
      stateType: 'LOGIN_SUCCESS', expected: 'authenticated',
      requiredEvidence: [{ type: 'text_present', expect: 'login' }], // login-fail 含 "Login" → 命中
      forbiddenEvidence: [{ type: 'text_present', expect: 'invalid' }], // login-fail 含 "Invalid" → 命中
      evidenceLogic: 'AND', confidence: 0.9,
    };
    const r = verification.verify({ businessState: c }, o, {});
    ok(r.success === false && r.forbiddenHit, 'forbidden(invalid) 优先于 required(login) → 硬失败');
    await page.close();
  }

  // ---- 额外：P0 action_success 对关键动作不再作为唯一证据 ----
  section('11. P0：关键业务动作仅 action_success → 明确不足（buildEffectiveVerification）');
  {
    // B1：click 现在推导为可靠的「页面/状态变化」业务结果契约（page_change），
    // 取代旧有的「仅 action_success → insufficientOutcome 一律失败」。旧硬失败是 click 低成功率的假阴性根因之一。
    // 核心不变：禁止仅凭 action 执行成功认定业务完成（page_change 是真实业务结果验证，非 DOM 表面）。
    const stepKey = { action: { type: 'click', target: { semantic: '登录按钮' }, verification: { type: 'action_success' } } };
    const eff = verification.buildEffectiveVerification(stepKey);
    ok(eff.businessState && eff.businessState.stateType === 'GENERIC_STATE', 'click + 仅 action_success → 现在推导为 page_change 业务结果契约（可靠 outcome，非 insufficientOutcome）');
    // 真实业务结果验证：页面变化 → 通过；页面无变化 → 仍失败（杜绝 silent-pass / 动作成功=业务完成）
    const btnEl = { role: 'button', tag: 'button', text: '登录按钮', state: {} };
    const beforeObs = { url: 'http://x/1', textSummary: 'page one' };
    const afterChanged = { url: 'http://x/2', textSummary: 'page two', elements: [btnEl] };
    const afterSame = { url: 'http://x/1', textSummary: 'page one', elements: [btnEl] };
    const rChanged = verification.verify(eff, afterChanged, beforeObs);
    ok(rChanged.success === true, 'click 后页面变化 → 业务结果契约通过（真实结果被识别）');
    const rSame = verification.verify(eff, afterSame, beforeObs);
    ok(rSame.success === false, 'click 后页面无变化 → 业务结果契约仍失败（杜绝「动作成功=业务完成」）');

    // 关键动作 + expectedBusinessState → 走合约
    const stepContract = { action: { type: 'login', target: { semantic: '登录' }, expectedBusinessState: contract.deriveContract({ type: 'login' }) } };
    const eff2 = verification.buildEffectiveVerification(stepContract);
    ok(eff2.businessState && eff2.businessState.stateType === 'LOGIN_SUCCESS', 'login + expectedBusinessState → 走业务完成合约');
    // 自动推导：无合约但可推导类型
    const stepDerive = { action: { type: 'search', target: { semantic: '搜索框' }, verification: { type: 'none' } } };
    const eff3 = verification.buildEffectiveVerification(stepDerive);
    ok(eff3.businessState && eff3.businessState.stateType === 'SEARCH_SUCCESS', 'search 无合约但可自动推导 → SEARCH_SUCCESS 合约');
  }

  await browser.close();
  try { mock.server.close(); } catch (e) {}

  console.log('\n---------------------------------------------------');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  console.log('---------------------------------------------------');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('[phase11-test] 异常:', (e && e.stack) || e); process.exit(1); });
