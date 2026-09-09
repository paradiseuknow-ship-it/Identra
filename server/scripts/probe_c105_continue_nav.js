'use strict';
// C105 真实站点诊断（只读）：为什么 humanClick '#continue-nav' 找不到该元素？
//
// 现场：真实任务 task_mtudaiwupwsmo 连续 18 次
//   [click] humanClick: element not found: #continue-nav
// 而 selector 由当前 observation 生成 —— 说明观察里「有」而 DOM locator「找不到」。
// 三种可能：① 元素在 iframe 内；② 观察缓存过期（页面已导航）；③ 元素为 0 尺寸/不可见被过滤后
// 却仍出现在 elements 中。本 probe 用真实 profile 003 打开联盟链接，逐项排除。
//
// 只读：零注册、零提交、零写入。

const path = require('path');
const fs = require('fs');
const browserManager = require('../browserManager');
const observation = require('../agent/observation');

const URL_AFF = 'https://try.webflow.com/t0wz830c5n4y';

(async () => {
  const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'profiles.json'), 'utf8'));
  const list = Array.isArray(profiles) ? profiles : Object.values(profiles);
  const p = list.find((x) => x.id === 'p_mtts6di8i24m');
  if (!p) { console.log('profile 003 not found'); process.exit(1); }
  const prof = Object.assign({}, p, { headless: true }); // 覆盖：诊断无需弹窗

  const session = await browserManager.launch(prof, []);
  const page = await browserManager.getPage(prof.id);
  const resp = await page.goto(URL_AFF, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const out = { url: page.url(), status: resp ? resp.status() : null, title: await page.title() };
  console.log('[probe] url=' + out.url + ' status=' + out.status + ' title=' + String(out.title).slice(0, 70));

  // 1) observation 侧：是否出现 continue-nav
  const o = await observation.inspect(page, { taskId: 'probe_c105' });
  const obs = (o && o.observation) || o;
  out.obsUrl = obs.url;
  out.elements = (obs.elements || []).length;
  const cn = (obs.elements || []).filter((e) => String(e.id || '') === 'continue-nav'
    || /continue-nav/.test(String(e.cls || '') + ' ' + String(e.href || '')));
  out.continueNavInObs = cn.map((e) => ({ id: e.id, tag: e.tag, text: String(e.text || '').slice(0, 40), href: e.href, cls: String(e.cls || '').slice(0, 40), bbox: e.bbox }));
  console.log('[probe] observation: url=' + obs.url + ' elements=' + out.elements + ' continueNav=' + JSON.stringify(out.continueNavInObs));

  // 2) DOM 侧：主 frame 与全部 frame 的 #continue-nav 数量
  const mainCount = await page.locator('#continue-nav').count().catch((e) => 'ERR ' + e.message);
  out.mainFrameCount = mainCount;
  console.log('[probe] main frame #continue-nav count=' + mainCount);

  const frameInfo = await page.evaluate(() => {
    const res = { frames: [], inFrame: 0, sameOriginFrames: 0 };
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      let cnt = null, err = null;
      try { cnt = f.contentDocument ? f.contentDocument.querySelectorAll('#continue-nav').length : null; }
      catch (e) { err = String(e.message).slice(0, 60); }
      res.frames.push({ src: String(f.getAttribute('src') || '').slice(0, 80), cnt, err });
    }
    return res;
  }).catch((e) => ({ err: String(e.message) }));
  out.frames = frameInfo;
  console.log('[probe] iframes=' + JSON.stringify(frameInfo).slice(0, 400));

  // 3) 页面上真实存在的注册类 CTA（给 F13 修复提供 grounded 目标）
  const ctas = await page.evaluate(() => {
    const out = [];
    const els = Array.from(document.querySelectorAll('a,button'));
    for (const el of els) {
      const t = (el.innerText || '').trim().slice(0, 40);
      const href = el.getAttribute('href') || '';
      if (/sign up|get started|start for free|commence|register|free/i.test(t + ' ' + href)) {
        const r = el.getBoundingClientRect();
        out.push({ tag: el.tagName.toLowerCase(), id: el.id || null, text: t, href: href.slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    return out.slice(0, 12);
  }).catch((e) => ({ err: String(e.message) }));
  out.ctas = ctas;
  console.log('[probe] CTAs=' + JSON.stringify(ctas).slice(0, 900));

  const file = path.join(__dirname, '..', '..', '.benchmark', 'c105_probe_continue_nav_' + Date.now() + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('[probe] evidence: ' + file);

  try { await browserManager.closeSession(prof.id); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('[probe] FATAL', e.message); process.exit(1); });
