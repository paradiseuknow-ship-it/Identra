'use strict';

// 全局异常守卫：单个浏览器会话的弹窗处理/会话断开等异步拒绝，绝不能拖垮整个服务进程。
// 此前出现过 ProtocolError(Page.handleJavaScriptDialog) 在会话已关闭时 reject 未被捕获，
// 触发 unhandledRejection 导致 node 进程退出、7788 端口随之中断（"窗口一关服务也挂"的底层原因）。
process.on('unhandledRejection', (reason) => {
  console.error('[uncaught] unhandledRejection:', (reason && reason.message) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught] uncaughtException:', (err && err.message) || err);
});

const express = require('express');
const cors = require('cors');
const path = require('path');

const db = require('./db');
const browserManager = require('./browserManager');
const vault = require('./vault');
const { generateFingerprint, seedFromProfile } = require('./fp/generate');
const { runIntegrityCheck } = require('./integrity');
const { runWorkflow } = require('./automation/engine');
const { registrationTemplate, checkoutTemplate } = require('./automation/templates');
const { checkProxy, checkProxyGeo } = require('./proxyChecker');

const app = express();
const PORT = process.env.PORT || 8787;

// 优先使用配置内联代理，否则按 proxyId 从已保存列表解析
function resolveProxy(profile, proxies) {
  if (profile.proxyInline && profile.proxyInline.server) return profile.proxyInline;
  if (profile.proxyId && proxies) return proxies.find((x) => x.id === profile.proxyId) || null;
  return null;
}

// 判断是否需要基于 IP 解析指纹，并返回检测结果
async function resolveIpGeo(override, proxy) {
  const tzIp = override.timezoneMode === 'ip';
  const langIp = override.languageMode === 'ip';
  const geoIp = override.geolocation?.mode === 'ip';
  if (!tzIp && !langIp && !geoIp) return null;

  if (proxy) {
    const r = await checkProxyGeo(proxy);
    return r.geo || null;
  }
  return null;
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ---------------- Profiles ----------------
const router = express.Router();

router.get('/profiles', (req, res) => {
  const list = db.getProfiles().map((p) => ({ ...p, running: browserManager.isRunning(p.id), vault: vault.getMaskedSummary(p.id) }));
  res.json(list);
});

router.post('/profiles', async (req, res) => {
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const profile = {
    id,
    name: req.body.name || '未命名配置',
    group: req.body.group || 'default',
    tags: req.body.tags || [],
    notes: req.body.notes || '',
    seed: req.body.seed || id,
    headless: req.body.headless === false ? false : true, // 默认无头（网页查看）；选"有界面"才弹窗
    proxyMode: req.body.proxyMode === 'saved' || req.body.proxyMode === 'none' || req.body.proxyMode === 'inline' ? req.body.proxyMode : 'inline',
    proxyId: req.body.proxyMode === 'saved' ? (req.body.proxyId || null) : null,
    proxyInline: req.body.proxyMode === 'inline' ? (req.body.proxyInline || null) : null,
    os: req.body.os || 'Windows',
    browser: req.body.browser || 'Chrome',
    startupUrls: req.body.startupUrls || [],
    launchArgs: req.body.launchArgs || [],
    launchBehavior: req.body.launchBehavior || {
      restoreLastSession: false,
      blockVideo: false,
      blockImages: false,
      blockImagesThresholdKB: 10,
      clearCacheOnLaunch: false,
      cacheClearMode: 'none',
      clearCookies: false,
    },
    lastSessionUrls: req.body.lastSessionUrls || [],
    fingerprintOverride: req.body.fingerprintOverride || {},
    fingerprint: null,
    createdAt: Date.now(),
  };
  // 生成并缓存指纹（把 profile 级 os/browser 合并进 override）
  const mergedOverride = { os: profile.os, browser: profile.browser, ...profile.fingerprintOverride };
  const ipGeo = await resolveIpGeo(mergedOverride, resolveProxy(profile, db.getProxies()));
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), mergedOverride, ipGeo);
  db.upsertProfile(profile);
  res.json(profile);
});

router.get('/profiles/:id', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const mergedOverride = { os: p.os, browser: p.browser, ...p.fingerprintOverride };
  const ipGeo = await resolveIpGeo(mergedOverride, resolveProxy(p, db.getProxies()));
  p.fingerprint = generateFingerprint(seedFromProfile(p), mergedOverride, ipGeo);
  db.upsertProfile(p);
  res.json({ ...p, running: browserManager.isRunning(p.id), vault: vault.getMaskedSummary(p.id) });
});

// Profile Integrity：按需体检（开发期排查"脏 Profile"，非阻塞）
router.get('/profiles/:id/integrity', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    const mergedOverride = { os: p.os, browser: p.browser, ...p.fingerprintOverride };
    const ipGeo = await resolveIpGeo(mergedOverride, resolveProxy(p, db.getProxies()));
    const fp = generateFingerprint(seedFromProfile(p), mergedOverride, ipGeo);
    // 镜像启动时的 UA 对齐，使报告反映真实运行态（而非存储里的旧 UA）
    const realVer = browserManager.getChromeVersion();
    if (realVer && fp.userAgent && /Chrome\/\d+(\.\d+)*/.test(fp.userAgent)) {
      fp.userAgent = fp.userAgent.replace(/Chrome\/\d+(\.\d+)*/, 'Chrome/' + realVer);
    }
    const report = runIntegrityCheck(p, { fp, engineVersion: realVer, proxies: db.getProxies() });
    res.json({ id: p.id, ...report });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

router.put('/profiles/:id', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (req.body.regenerateSeed) {
    p.seed = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }
  const mode = req.body.proxyMode === 'saved' || req.body.proxyMode === 'none' || req.body.proxyMode === 'inline' ? req.body.proxyMode : p.proxyMode;
  Object.assign(p, {
    name: req.body.name ?? p.name,
    group: req.body.group ?? p.group,
    tags: req.body.tags ?? p.tags,
    notes: req.body.notes ?? p.notes,
    seed: req.body.seed ?? p.seed,
    headless: req.body.headless ?? p.headless,
    proxyMode: mode,
    proxyId: mode === 'saved' ? (req.body.proxyId !== undefined ? req.body.proxyId : p.proxyId) : null,
    proxyInline: mode === 'inline' ? (req.body.proxyInline !== undefined ? req.body.proxyInline : p.proxyInline) : null,
    os: req.body.os ?? p.os,
    browser: req.body.browser ?? p.browser,
    startupUrls: req.body.startupUrls ?? p.startupUrls,
    launchArgs: req.body.launchArgs ?? p.launchArgs,
    launchBehavior: req.body.launchBehavior ?? p.launchBehavior,
    fingerprintOverride: req.body.fingerprintOverride ?? p.fingerprintOverride,
  });
  const mergedOverride = { os: p.os, browser: p.browser, ...p.fingerprintOverride };
  const ipGeo = await resolveIpGeo(mergedOverride, resolveProxy(p, db.getProxies()));
  p.fingerprint = generateFingerprint(seedFromProfile(p), mergedOverride, ipGeo);
  db.upsertProfile(p);
  res.json(p);
});

router.post('/profiles/:id/duplicate', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const copy = JSON.parse(JSON.stringify(p));
  copy.id = id;
  copy.name = p.name + ' 副本';
  copy.seed = id;
  copy.lastSessionUrls = [];
  const copyOverride = { os: copy.os, browser: copy.browser, ...copy.fingerprintOverride };
  const ipGeo = await resolveIpGeo(copyOverride, resolveProxy(copy, db.getProxies()));
  copy.fingerprint = generateFingerprint(seedFromProfile(copy), copyOverride, ipGeo);
  copy.createdAt = Date.now();
  db.upsertProfile(copy);
  res.json(copy);
});

router.delete('/profiles/:id', (req, res) => {
  try {
    if (browserManager.isRunning(req.params.id)) browserManager.close(req.params.id);
    try { vault.deleteProfileSecrets(req.params.id); }
    catch (e) { console.warn('[delete] vault 清理失败(已忽略):', e.message); }
    db.deleteProfile(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[delete] 失败:', e);
    res.status(500).json({ error: e.message || '删除失败' });
  }
});

// 仅生成指纹预览（不落库），供编辑器实时预览
router.post('/profiles/preview-fp', async (req, res) => {
  const seed = req.body.seed || 'preview';
  const override = req.body.fingerprintOverride || {};
  const ipGeo = await resolveIpGeo(override, resolveProxy({ proxyId: req.body.proxyId, proxyInline: req.body.proxyInline }, db.getProxies()));
  const fp = generateFingerprint(seed, override, ipGeo);
  res.json(fp);
});

router.use('/', (req, res, next) => next());

// ---------------- Proxy ----------------
const proxyRouter = express.Router();
proxyRouter.get('/proxies', (req, res) => res.json(db.getProxiesPublic()));
proxyRouter.post('/proxies', (req, res) => {
  const list = db.getProxies();
  const proxy = {
    id: 'px_' + Date.now().toString(36),
    name: req.body.name || 'proxy',
    type: req.body.type || 'http',
    server: req.body.server,
    username: req.body.username || '',
    password: req.body.password || '',
    bypass: req.body.bypass || '',
    refreshUrl: req.body.refreshUrl || '',
    ipLookupChannel: req.body.ipLookupChannel || 'ipify',
  };
  list.push(proxy);
  db.saveProxies(list);
  res.json(proxy);
});
proxyRouter.put('/proxies/:id', (req, res) => {
  const list = db.getProxies();
  const p = list.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  Object.assign(p, req.body);
  db.saveProxies(list);
  res.json(p);
});
proxyRouter.delete('/proxies/:id', (req, res) => {
  db.saveProxies(db.getProxies().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});
proxyRouter.post('/proxies/:id/check', async (req, res) => {
  const p = db.getProxies().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const result = await checkProxy(p);
  // 更新最近检测结果
  p.lastCheck = result;
  db.saveProxies(db.getProxies());
  res.json(result);
});
proxyRouter.post('/proxies/:id/check-geo', async (req, res) => {
  const p = db.getProxies().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const result = await checkProxyGeo(p);
  res.json(result);
});
proxyRouter.post('/proxies/check-inline', async (req, res) => {
  try {
    const result = await checkProxy(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

// ---------------- Browser control ----------------
const browserRouter = express.Router();
browserRouter.post('/browser/:id/launch', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    await browserManager.launch(p, db.getProxies());
    res.json({ ok: true, running: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});
browserRouter.post('/browser/:id/stop', async (req, res) => {
  await browserManager.close(req.params.id);
  res.json({ ok: true, running: false });
});
browserRouter.get('/browser/status', (req, res) => {
  const all = db.getProfiles().map((p) => ({ id: p.id, running: browserManager.isRunning(p.id) }));
  res.json(all);
});
// 网页"云查看"：当前页面截图（base64）
browserRouter.get('/browser/:id/screenshot', async (req, res) => {
  try {
    const b64 = await browserManager.screenshot(req.params.id);
    res.json({ ok: true, data: b64 });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
// 网页"云查看"：导航到指定网址
browserRouter.post('/browser/:id/navigate', async (req, res) => {
  try {
    await browserManager.navigate(req.params.id, req.body.url);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
// 在当前页面执行一段 JS（仅用于本地调试/指纹验证）
browserRouter.post('/browser/:id/evaluate', async (req, res) => {
  try {
    const page = await browserManager.getPage(req.params.id);
    const script = String(req.body.script || '');
    const result = await page.evaluate((s) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('return (' + s + ')');
      return fn();
    }, script);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
// 行为层：拟人化鼠标/键盘/滚动（对抗 Google reCAPTCHA / Cloudflare 行为审计）
browserRouter.post('/browser/:id/human-move', async (req, res) => {
  try {
    const page = await browserManager.getPage(req.params.id);
    await browserManager.humanMove(page, Number(req.body.x), Number(req.body.y), req.body.options || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
browserRouter.post('/browser/:id/human-click', async (req, res) => {
  try {
    const page = await browserManager.getPage(req.params.id);
    await browserManager.humanClick(page, req.body.selector, req.body.options || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
browserRouter.post('/browser/:id/human-type', async (req, res) => {
  try {
    const page = await browserManager.getPage(req.params.id);
    await browserManager.humanType(page, req.body.selector, req.body.text, req.body.options || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
browserRouter.post('/browser/:id/human-scroll', async (req, res) => {
  try {
    const page = await browserManager.getPage(req.params.id);
    await browserManager.humanScroll(page, Number(req.body.deltaY) || 300, req.body.options || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
// 一键拟人 Google 搜索：先处理 EU Cookie 同意 -> 聚焦搜索框 -> 输入 -> 回车
// 用于验证“指纹+网络+行为”三层对齐后，Google 是否仍弹 reCAPTCHA。
browserRouter.post('/browser/:id/human-google-search', async (req, res) => {
  try {
    const page = await browserManager.getPage(req.params.id);
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });

    // 1) 若出现 GDPR Cookie 同意浮层，拟人点击“全部拒绝/全部接受”（欧盟首次访问常见）
    // 先用 evaluate 探测真实按钮（最稳定），再用 humanClick 完成拟人点击。
    const consentBtn = await page.evaluate(() => {
      const texts = ['Alle ablehnen', 'Reject all', 'Alle akzeptieren', 'Accept all'];
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const t of texts) {
        const b = buttons.find((el) => (el.innerText || el.textContent || '').includes(t));
        if (b) {
          const rect = b.getBoundingClientRect();
          return { text: t, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      return null;
    }).catch(() => null);
    if (consentBtn) {
      try {
        await browserManager.humanMove(page, consentBtn.x, consentBtn.y);
        await page.mouse.down();
        await new Promise((r) => setTimeout(r, 60 + Math.random() * 80));
        await page.mouse.up();
        await page.waitForTimeout(1000);
      } catch (_) {}
    }

    // 2) 拟人聚焦搜索框、输入、提交
    await page.waitForSelector('textarea[name="q"], input[name="q"]', { timeout: 8000 });
    await browserManager.humanClick(page, 'textarea[name="q"], input[name="q"]');
    await browserManager.humanType(page, 'textarea[name="q"], input[name="q"]', req.body.query || 'fingerprint browser', { baseDelay: 50, randomDelay: 120 });
    await page.keyboard.press('Enter');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------------- Vault (凭据/支付) ----------------
const vaultRouter = express.Router();
vaultRouter.get('/vault/:id', (req, res) => {
  res.json(vault.getMaskedSummary(req.params.id) || { hasEmail: false, hasPassword: false, card: null });
});
vaultRouter.post('/vault/:id', (req, res) => {
  const ok = vault.setProfileSecrets(req.params.id, req.body);
  res.json({ ok });
});

// ---------------- Tasks (工作流) ----------------
const taskRouter = express.Router();
taskRouter.get('/tasks', (req, res) => res.json(db.getTasks()));
taskRouter.post('/tasks', (req, res) => {
  const list = db.getTasks();
  const task = {
    id: 'tk_' + Date.now().toString(36),
    name: req.body.name || '工作流',
    type: req.body.type || 'custom', // registration | checkout | custom
    profileId: req.body.profileId || null,
    config: req.body.config || {},    // 站点选择器/URL
    steps: req.body.steps || [],      // 自定义步骤
    createdAt: Date.now(),
  };
  list.push(task);
  db.saveTasks(list);
  res.json(task);
});
taskRouter.put('/tasks/:id', (req, res) => {
  const list = db.getTasks();
  const t = list.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  Object.assign(t, req.body);
  db.saveTasks(list);
  res.json(t);
});
taskRouter.delete('/tasks/:id', (req, res) => {
  db.saveTasks(db.getTasks().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});

// 兼容别名：AI 任务生命周期也暴露到 /api/tasks/:id/*（与 /api/ai/tasks/:id/* 等价），
// 避免客户端按列表路径调用 404（Phase 12B § API2）。仅代理 AI TaskManager，不影响遗留自动化工作流。
(() => {
  let aiTaskManager;
  try { aiTaskManager = require('./agent/taskManager'); } catch (e) { aiTaskManager = null; }
  if (!aiTaskManager) return;
  const proxy = (fn) => (req, res) => {
    try { res.json(fn(req.params.id, req.body || {})); }
    catch (e) { res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
  };
  taskRouter.post('/tasks/:id/start', proxy((id) => { const r = aiTaskManager.start(id); return { task: r.task, executionId: r.execution.id }; }));
  taskRouter.post('/tasks/:id/pause', proxy((id, body) => aiTaskManager.pauseForHuman(id, (body && body.reason) || 'manual pause', { manual: true })));
  taskRouter.post('/tasks/:id/resume', proxy((id) => aiTaskManager.resume(id)));
  taskRouter.post('/tasks/:id/cancel', proxy((id) => aiTaskManager.cancel(id)));
  taskRouter.post('/tasks/:id/retry', proxy((id) => { const r = aiTaskManager.retry(id); return { task: r.task, executionId: r.execution.id }; }));
})();


// ---------------- Automation run ----------------
const automationRouter = express.Router();
automationRouter.post('/automation/run', async (req, res) => {
  const { profileId, taskId, steps: rawSteps, opts } = req.body;
  const p = db.getProfile(profileId);
  if (!p) return res.status(404).json({ error: 'profile not found' });

  let steps = rawSteps;
  if (!steps && taskId) {
    const task = db.getTask(taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    steps = task.steps && task.steps.length ? task.steps
      : (task.type === 'registration' ? registrationTemplate(task.config)
        : task.type === 'checkout' ? checkoutTemplate(task.config) : []);
  }
  if (taskId && !rawSteps) {
    const task = db.getTask(taskId);
    if (task) { p.id = profileId; /* keep */ }
  }
  if (!steps || !steps.length) return res.status(400).json({ error: 'no steps' });

  const result = await runWorkflow(p, steps, { vars: opts?.vars, freshPage: opts?.freshPage !== false });
  res.json(result);
});

// 模板生成预览
automationRouter.post('/automation/preview', (req, res) => {
  const { type, config } = req.body;
  if (type === 'registration') return res.json(registrationTemplate(config));
  if (type === 'checkout') return res.json(checkoutTemplate(config));
  res.status(400).json({ error: 'unknown type' });
});

// 简单 Cookie 导入/导出（需该 profile 浏览器正在运行）
const cookieRouter = express.Router();
cookieRouter.get('/cookies/:id/export', async (req, res) => {
  const s = browserManager.getSession(req.params.id);
  if (!s) return res.status(409).json({ error: 'profile 未运行' });
  res.json(await s.context.cookies());
});
cookieRouter.post('/cookies/:id/import', async (req, res) => {
  const s = browserManager.getSession(req.params.id);
  if (!s) return res.status(409).json({ error: 'profile 未运行' });
  const cookies = Array.isArray(req.body) ? req.body : req.body.cookies;
  await s.context.addCookies(cookies);
  res.json({ ok: true, count: cookies.length });
});

app.use('/api', router, proxyRouter, browserRouter, vaultRouter, taskRouter, automationRouter, cookieRouter);

// AI Browser Operator（Phase 1.1 基础设施）
app.use('/api/ai', require('./agent'));

// 静态前端（生产构建）
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (require('fs').existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`[server] 指纹浏览器后端已启动: http://localhost:${PORT}`);
  console.log(`[server] 首次运行请先执行: npx playwright install chromium`);
  // 启动时清理上次崩溃遗留的孤儿 chrome 进程，防止 SingletonLock 冲突 / 内存占用
  browserManager.cleanupOrphanedChromium();
  // 启动定时僵尸进程扫描（默认 5 分钟），强杀非活跃 profile 的残留 chrome 进程
  browserManager.startZombieKiller();

  // Phase 12B §I6/§I7/§T18：周期清理与优雅关闭
  const lock = require('./agent/lock');
  const recoveryManager = require('./agent/recovery/recoveryManager');
  const _timers = [];
  _timers.push(setInterval(() => { try { lock.pruneExpired(); } catch (e) {} }, 5 * 60 * 1000)); // 惰性锁定时清理
  _timers.push(setInterval(() => { try { recoveryManager.scanStaleTasks(30 * 60 * 1000); } catch (e) {} }, 10 * 60 * 1000)); // stale 任务恢复

  let _shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log('[server] 收到 ' + signal + '，开始优雅关闭：清理定时任务与孤儿浏览器...');
    _timers.forEach((t) => { try { clearInterval(t); } catch (e) {} });
    try { browserManager.cleanupOrphanedChromium(); } catch (e) {}
    process.exit(0);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
});

module.exports = app;
