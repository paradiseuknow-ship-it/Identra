'use strict';
// webflow.com 侦察第二轮：使用项目自带的反检测浏览器栈（browserManager）
// 对比裸 Playwright 的 403 结果——这正是产品核心价值的首次实战检验。
// 仍为只读侦察：零注册零写入零表单提交。

const fs = require('fs');
const path = require('path');
const browserManager = require('../browserManager');

const OUT = path.resolve(__dirname, '..', '..', '.benchmark', 'webflow_recon');

(async () => {
  const profile = {
    id: 'recon_webflow',
    headless: true,
    browser: 'Chrome', // 必须匹配 fp/data.js 模板池大小写（'Chrome'），小写会导致 UA 池过滤失败回退随机（iPhone UA × Windows platform 错配 → 秒被 WAF 识别）
    os: 'Windows',
    startupUrls: [],
    lastSessionUrls: [],
    launchBehavior: {},
  };
  const session = await browserManager.launch(profile, []);
  const page = await browserManager.getPage(profile.id);
  const report = { steps: [] };

  async function visit(url, tag) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const title = await page.title();
      await page.waitForTimeout(3000);
      const shot = path.join(OUT, tag + '_hardened.png');
      await page.screenshot({ path: shot, fullPage: false });
      const inputs = await page.$$eval('input', (els) => els.slice(0, 15).map((e) => ({
        type: e.type, name: e.name || null, id: e.id || null, visible: !!(e.offsetParent || e.getClientRects().length),
      }))).catch(() => []);
      const ua = await page.evaluate(() => navigator.userAgent).catch(() => null);
      report.steps.push({ tag, url, status: resp ? resp.status() : null, title, ua, inputs });
      console.log('[hardened]', tag, 'status=' + (resp ? resp.status() : '?'), 'title=' + String(title).slice(0, 60));
    } catch (e) {
      report.steps.push({ tag, url, error: String(e.message).slice(0, 200) });
      console.log('[hardened]', tag, 'ERROR:', String(e.message).slice(0, 120));
    }
  }

  await visit('https://webflow.com/', 'home');
  await visit('https://webflow.com/signup', 'signup');
  await visit('https://webflow.com/login', 'login');

  fs.writeFileSync(path.join(OUT, 'recon_report_hardened.json'), JSON.stringify(report, null, 2), 'utf8');
  await browserManager.close(profile.id).catch(() => {});
  console.log('HARDENED_RECON_DONE');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
