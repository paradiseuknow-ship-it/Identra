'use strict';
// C106 真实站点诊断：分步注册表单「email 已填 → password 未出现」时，页面上到底有什么？
//
// 现场：真实任务 task_mtuqje3txasfd
//   idx27 fill {semantic:'注册邮箱输入框', field:'email'}      SUCCESS
//   idx28 fill {semantic:'注册密码输入框', field:'password'}    FAILED 未找到输入目标: password
//   idx29 fill {semantic:'email',          field:'password'}    SUCCESS  ← 静默填错字段（F16）
//   staged_form_advance × 2 → no_advance_control                ← 页面上「没找到」前进控件
//
// 本 probe 用真实 profile 003 走联盟链接，逐步 dump 每一步的 input 与可点击控件，
// 回答两个问题：
//   Q1 email 填完后，页面上是否真的没有 password 字段？（分步 vs 同页）
//   Q2 若没有，前进控件的真实文案/结构是什么？为何 ADVANCE_TERMS 没命中？
//
// 边界：只填测试邮箱并点「继续」，不进入支付、不提交最终注册。

const path = require('path');
const fs = require('fs');
const browserManager = require('../browserManager');
const observation = require('../agent/observation');

const URL_AFF = 'https://try.webflow.com/t0wz830c5n4y';
const TEST_EMAIL = process.env.PROBE_EMAIL || 'probe.c106.' + Date.now() + '@example.com';
const OUT = path.join(__dirname, '..', '..', '.benchmark', 'probe_c106_signup_stage_' + Date.now() + '.json');

function dumpInputs(els) {
  return els
    .filter((e) => /input|textarea|select/i.test(String(e.tag || '')))
    .map((e) => ({
      tag: e.tag,
      type: e.type,
      name: e.name,
      id: e.id,
      placeholder: String(e.placeholder || '').slice(0, 40),
      label: String(e.label || e['aria-label'] || '').slice(0, 40),
      text: String(e.text || '').slice(0, 40),
      bbox: e.bbox,
    }));
}

function dumpClickables(els) {
  return els
    .filter((e) => /button|^a$|link/i.test(String(e.tag || '') + ' ' + String(e.role || '')) || String(e.role) === 'button')
    .map((e) => ({
      tag: e.tag,
      role: e.role,
      type: e.type,
      text: String(e.text || '').slice(0, 50),
      id: e.id,
      cls: String(e.cls || '').slice(0, 50),
      href: String(e.href || '').slice(0, 60),
      bbox: e.bbox,
    }));
}

(async () => {
  const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'profiles.json'), 'utf8'));
  const list = Array.isArray(profiles) ? profiles : Object.values(profiles);
  const p = list.find((x) => x.id === 'p_mtts6di8i24m');
  if (!p) { console.log('profile 003 not found'); process.exit(1); }
  const prof = Object.assign({}, p, { headless: true });

  const out = { steps: [] };
  const session = await browserManager.launch(prof, []);
  const page = await browserManager.getPage(prof.id);

  async function snap(label) {
    await page.waitForTimeout(4000);
    const o = await observation.inspect(page, { taskId: 'probe_c106' });
    const obs = (o && o.observation) || o;
    const s = {
      label,
      url: page.url(),
      title: String(await page.title()).slice(0, 80),
      obsElements: (obs.elements || []).length,
      inputs: dumpInputs(obs.elements || []),
      clickables: dumpClickables(obs.elements || []).slice(0, 40),
    };
    out.steps.push(s);
    console.log(`[probe] ${label} url=${s.url} els=${s.obsElements} inputs=${s.inputs.length} clickables=${s.clickables.length}`);
    s.inputs.slice(0, 10).forEach((i) => console.log('   input:', JSON.stringify(i)));
    return s;
  }

  await page.goto(URL_AFF, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await snap('landing');

  // 进入注册：优先点 data-testid / 文本含 get started|start for free|sign up|commencez 的控件
  const entered = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('a,button,[role=button]'));
    const hit = cands.find((el) => {
      const t = (el.innerText || el.textContent || '').toLowerCase();
      const h = (el.getAttribute('href') || '').toLowerCase();
      return /get started|start for free|sign up|sign in|commencez|essayer| créer/.test(t) || /signup|sign-up|get-started/.test(h);
    });
    if (hit) { hit.click(); return (hit.innerText || hit.textContent || '').trim().slice(0, 40) + ' | href=' + (hit.getAttribute('href') || '').slice(0, 60); }
    return null;
  }).catch((e) => 'ERR ' + e.message);
  out.entryClick = entered;
  console.log('[probe] entry click → ' + entered);
  await snap('after-entry');

  // 若有 email 输入：填入测试邮箱，dump（不点继续）
  const emailSel = await page.evaluate(() => {
    const el = document.querySelector('input[type=email], input[name*=email i], input[id*=email i], input[placeholder*="email" i]');
    if (!el) return null;
    if (el.id) return '#' + el.id;
    if (el.getAttribute('name')) return 'input[name="' + el.getAttribute('name') + '"]';
    return null;
  }).catch(() => null);
  out.emailSelector = emailSel;
  console.log('[probe] email selector=' + emailSel);
  if (emailSel) {
    try {
      await page.fill(emailSel, TEST_EMAIL, { timeout: 8000 });
      out.emailFilled = true;
    } catch (e) { out.emailFilled = 'ERR ' + e.message; }
    await snap('after-email-fill');

    // 点前进控件（继续）：dump 点之前候选 + 点之后
    const adv = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('button,a,[role=button],input[type=submit]'));
      return cands.map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        text: (el.innerText || el.textContent || el.value || '').trim().slice(0, 40),
        id: el.id,
        cls: String(el.className || '').slice(0, 60),
        rect: (() => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
      })).filter((c) => c.rect.w > 0 || c.rect.h > 0);
    }).catch((e) => ({ err: String(e.message) }));
    out.advanceCandidates = adv;
    console.log('[probe] advance candidates=' + JSON.stringify(adv).slice(0, 900));

    const clicked = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('button,a,[role=button],input[type=submit]'));
      const hit = cands.find((el) => {
        const t = (el.innerText || el.textContent || el.value || '').toLowerCase();
        return /continue|next|sign up|create account|get started|proceed|submit/.test(t);
      });
      if (hit) { hit.click(); return (hit.innerText || hit.textContent || hit.value || '').trim().slice(0, 40); }
      return null;
    }).catch((e) => 'ERR ' + e.message);
    out.advanceClick = clicked;
    console.log('[probe] advance click → ' + clicked);
    await snap('after-advance');
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('[probe] evidence: ' + OUT);
  try { await browserManager.close(prof.id); } catch (e) { /* noop */ }
  process.exit(0);
})().catch((e) => { console.error('[probe] FATAL ' + e.message); process.exit(1); });
