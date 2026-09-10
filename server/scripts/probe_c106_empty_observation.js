'use strict';
// C106 真实站点诊断 v2：导航后 observation 报「0 元素」——页面真慢，还是观察层失效？
//
// v1 现场（probe_c106_signup_stage_1788997438964.json）：
//   landing  url=webflowmarketingmain.com/fr?...     els=80   inputs=0  clickables=40
//   entry    click "Commencer" → https://webflow.com/signup?utm_source=...
//   after-entry (等 4s)                              els=0    ← 观察元素集为空
//
// els=0 若为真，则 F15「no_advance_control」并非词表未命中，而是**快照里没有元素**，
// 所有基于 observation 的解析/推进必然全部落空。本 probe 分三路交叉验证：
//   A 真实 DOM（page.evaluate 直接数）      —— 页面到底有没有元素
//   B observation.inspect（产品观察路径）    —— 观察层报多少
//   C 多时点采样（0/3/8/15s）+ readyState + networkState —— 是竞态还是永久空
//
// 只读：零注册、零提交、零写入。

const path = require('path');
const fs = require('fs');
const browserManager = require('../browserManager');
const observation = require('../agent/observation');

const URL_AFF = 'https://try.webflow.com/t0wz830c5n4y';
const OUT = path.join(__dirname, '..', '..', '.benchmark', 'probe_c106_empty_obs_' + Date.now() + '.json');

async function domCount(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll('*');
    const inputs = Array.from(document.querySelectorAll('input,textarea,select')).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.id,
      placeholder: (el.getAttribute('placeholder') || '').slice(0, 40),
      autocomplete: el.getAttribute('autocomplete'),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    }));
    const buttons = Array.from(document.querySelectorAll('button,a[href],[role=button],input[type=submit]'))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        text: (el.innerText || el.textContent || el.value || '').trim().slice(0, 40),
        id: el.id,
        rect: (() => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
      }))
      .filter((b) => b.rect.w > 0 || b.rect.h > 0);
    return {
      readyState: document.readyState,
      totalNodes: all.length,
      bodyTextLen: (document.body ? (document.body.innerText || '').length : 0),
      bodyTextHead: (document.body ? (document.body.innerText || '').slice(0, 200) : ''),
      inputs,
      buttons: buttons.slice(0, 30),
      frames: Array.from(document.querySelectorAll('iframe')).map((f) => String(f.getAttribute('src') || '').slice(0, 80)),
    };
  }).catch((e) => ({ err: String(e.message).slice(0, 200) }));
}

async function obsCount(page) {
  try {
    const o = await observation.inspect(page, { taskId: 'probe_c106_v2' });
    const obs = (o && o.observation) || o;
    return {
      ok: o ? o.ok : null,
      url: obs && obs.url,
      elements: (obs && obs.elements || []).length,
      networkState: obs && obs.networkState,
      err: o && o.error ? String(o.error).slice(0, 200) : null,
      rawKeys: obs ? Object.keys(obs).slice(0, 20) : [],
    };
  } catch (e) {
    return { err: String(e.message).slice(0, 200) };
  }
}

(async () => {
  const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'profiles.json'), 'utf8'));
  const list = Array.isArray(profiles) ? profiles : Object.values(profiles);
  const p = list.find((x) => x.id === 'p_mtts6di8i24m');
  if (!p) { console.log('profile 003 not found'); process.exit(1); }
  const prof = Object.assign({}, p, { headless: true });

  const out = { samples: [] };
  await browserManager.launch(prof, []);
  const page = await browserManager.getPage(prof.id);

  await page.goto(URL_AFF, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  out.landing = { url: page.url(), dom: await domCount(page), obs: await obsCount(page) };
  console.log('[probe] landing domNodes=' + out.landing.dom.totalNodes + ' obsEls=' + out.landing.obs.elements);

  const entry = await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('a,button,[role=button]')).find((el) => {
      const t = (el.innerText || el.textContent || '').toLowerCase();
      const h = (el.getAttribute('href') || '').toLowerCase();
      return /commencer|commencez|get started|start for free|sign up/.test(t) || /signup|get-started/.test(h);
    });
    if (hit) { hit.click(); return (hit.innerText || hit.textContent || '').trim().slice(0, 40) + ' | ' + (hit.getAttribute('href') || '').slice(0, 60); }
    return null;
  }).catch((e) => 'ERR ' + e.message);
  out.entryClick = entry;
  console.log('[probe] entry → ' + entry);

  for (const wait of [0, 3000, 5000, 7000]) {
    if (wait) await page.waitForTimeout(wait);
    const s = { waitMs: wait, url: page.url(), dom: await domCount(page), obs: await obsCount(page) };
    out.samples.push(s);
    console.log(`[probe] +${wait}ms url=${String(s.url).slice(0, 60)} domNodes=${s.dom.totalNodes} domInputs=${(s.dom.inputs || []).length} obsEls=${s.obs.elements} readyState=${s.dom.readyState} net=${s.obs.networkState}`);
    (s.dom.inputs || []).slice(0, 6).forEach((i) => console.log('    DOM input:', JSON.stringify(i)));
    if (s.obs.err) console.log('    obs err: ' + s.obs.err);
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('[probe] evidence: ' + OUT);
  try { await browserManager.close(prof.id); } catch (e) { /* noop */ }
  process.exit(0);
})().catch((e) => { console.error('[probe] FATAL ' + e.message); process.exit(1); });
