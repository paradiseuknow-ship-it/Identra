'use strict';
// webflow.com 只读连通性侦察（零注册零写入零表单提交）：
// 可达性 / 标题 / 反爬拦截特征 / 注册页结构采样。产物落 .benchmark/webflow_recon/。

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT = path.resolve(__dirname, '..', '..', '.benchmark', 'webflow_recon');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US' });
  const page = await ctx.newPage();
  const report = { steps: [] };

  async function visit(url, tag) {
    const t0 = Date.now();
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const title = await page.title();
      const status = resp ? resp.status() : null;
      await page.waitForTimeout(2500);
      const shot = path.join(OUT, tag + '.png');
      await page.screenshot({ path: shot, fullPage: false });
      const inputs = await page.$$eval('input', (els) => els.slice(0, 15).map((e) => ({
        type: e.type, name: e.name || null, id: e.id || null, placeholder: e.placeholder || null, visible: !!(e.offsetParent || e.getClientRects().length),
      })));
      report.steps.push({ tag, url, status, title, ms: Date.now() - t0, inputs, screenshot: shot });
      console.log('[recon]', tag, 'status=' + status, 'title=' + title.slice(0, 60), 'inputs=' + inputs.length);
    } catch (e) {
      report.steps.push({ tag, url, error: String(e.message).slice(0, 200), ms: Date.now() - t0 });
      console.log('[recon]', tag, 'ERROR:', String(e.message).slice(0, 120));
    }
  }

  await visit('https://webflow.com/', 'home');
  await visit('https://webflow.com/signup', 'signup');
  await visit('https://webflow.com/login', 'login');

  fs.writeFileSync(path.join(OUT, 'recon_report.json'), JSON.stringify(report, null, 2), 'utf8');
  await browser.close();
  console.log('RECON_DONE steps=' + report.steps.length);
})().catch((e) => { console.error('RECON_FATAL', e.message); process.exit(1); });
