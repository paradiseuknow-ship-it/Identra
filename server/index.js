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

require('./loadEnv'); // C15：.env 加载器（必须早于一切读 env 的模块：settings/browserManager/vault…）

const express = require('express');
const cors = require('cors');
const path = require('path');

const db = require('./db');
const browserManager = require('./browserManager');
const screencastManager = require('./screencastManager');
const vault = require('./vault');
const backup = require('./backup');
const settings = require('./settings'); // C14：运行时设置中心（保存即改 process.env，无需重启）
settings.applyToEnv(); // 启动时应用已保存的覆盖（settings 已设置的字段优先于 .env）
const { generateFingerprint, seedFromProfile } = require('./fp/generate');
const { runIntegrityCheck } = require('./integrity');
const { runWorkflow } = require('./automation/engine');
const { registrationTemplate, checkoutTemplate } = require('./automation/templates');
const { checkProxy, checkProxyGeo } = require('./proxyChecker');
const { requireAuth, assertStartupSecurity } = require('./auth');
const identity = require('./identity'); // CAP-O1：User/Workspace/RBAC 身份层（叠加于机器级边界之上）
const audit = require('./audit'); // CAP-O2：独立安全审计流
const fpTemplates = require('./fpTemplates'); // CAP-A1：指纹模板库
const proxyPool = require('./proxyPool'); // CAP-B1：代理池健康度与轮换

const app = express();
const PORT = process.env.PORT || 8787;
// STEP 0.5 §2.4：默认只监听本机。对外部署必须显式设置 FPB_BIND + FPB_API_TOKEN。
const BIND = process.env.FPB_BIND || '127.0.0.1';
// 远程 JS 执行（/api/browser/:id/evaluate）默认关闭：开启等于把浏览器会话的任意代码执行权交给调用方，
// 仅允许在受控的本机调试场景显式开启（FPB_ALLOW_EVALUATE=1）。
const EVALUATE_ENABLED = process.env.FPB_ALLOW_EVALUATE === '1';

// 优先使用配置内联代理，否则按 proxyId 从已保存列表解析
function resolveProxy(profile, proxies) {
  if (profile.proxyInline && profile.proxyInline.server) return profile.proxyInline;
  if (profile.proxyId && proxies) return proxies.find((x) => x.id === profile.proxyId) || null;
  return null;
}

// CAP-O1 §6：Profile 资源归属守卫（第一批 workspace-scoped 资源）。
// legacy 资源（无 workspaceId）= 本地默认工作区，仅 local 用户可访问 —— 模式 A 行为不变。
function guardProfile(res, user, profile, permission) {
  try {
    identity.assertCanAccessResource(user, profile, permission);
    return true;
  } catch (e) {
    res.status(e.status || 403).json({ ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e) });
    return false;
  }
}
// CAP-O2：Proxy / WorkflowTask / Vault 等其余 workspace-scoped 资源共用同一归属守卫
const guardResource = guardProfile;

// CAP-O2：统一审计埋点。detail 只放业务标识（name/id/count）；敏感字段由 audit.redact 兜底。
function auditReq(req, action, resourceType, resourceId, detail) {
  const u = req.identityUser;
  audit.log({
    workspaceId: u ? u.currentWorkspaceId : null,
    actorId: u ? u.id : null,
    actorName: u ? u.username : '',
    actorType: u ? (u.__apiKey ? 'api_key' : (u.status === 'local' ? 'local' : 'user')) : 'anonymous',
    action, resourceType, resourceId, detail: detail || {},
  });
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

// STEP 0.5 §2.4：CORS 白名单化。此前为 cors()（= Access-Control-Allow-Origin: *），
// 任意站点都能跨域读写本机服务。默认只放通本机前端（含 Vite dev server 5173）。
const DEFAULT_ORIGINS = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const CORS_ORIGINS = (process.env.FPB_CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = CORS_ORIGINS.length ? CORS_ORIGINS : DEFAULT_ORIGINS;

app.use(cors({
  origin(origin, cb) {
    // 无 Origin 头：同源请求 / 服务端代理 / curl，放行（由鉴权中间件负责身份判定）
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));

// ---------------- Profiles ----------------
const router = express.Router();

// CAP-C1：Profile 构建共享入口 —— 单建（POST /profiles）与批量导入（/profiles/import）
// 走同一套默认值 / 指纹生成，杜绝两套构造逻辑漂移。
// CAP-A1：支持 templateId —— 模板基线合并（显式 input 覆盖模板，模板覆盖全局默认），
// 模板可见性走同一 workspace 归属守卫。
async function buildNewProfile(input, user) {
  let tpl = null;
  if (input.templateId) {
    tpl = fpTemplates.getTemplates().find((t) => t.id === input.templateId) || null;
    if (!tpl) { const e = new Error('模板不存在: ' + input.templateId); e.status = 404; throw e; }
    if (!identity.canAccessResource(user, tpl, 'profile:use')) { const e = new Error('无权使用该模板（跨工作区）'); e.status = 403; throw e; }
  }
  const eff = fpTemplates.mergeTemplateIntoInput(input, tpl);
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const profile = {
    id,
    name: eff.name || '未命名配置',
    group: eff.group || 'default',
    tags: eff.tags || [],
    notes: eff.notes || '',
    seed: eff.seed || id,
    headless: eff.headless === false ? false : true, // 默认无头（网页查看）；选"有界面"才弹窗
    proxyMode: eff.proxyMode === 'saved' || eff.proxyMode === 'none' || eff.proxyMode === 'inline' ? eff.proxyMode : 'inline',
    proxyId: eff.proxyMode === 'saved' ? (eff.proxyId || null) : null,
    // CAP-B1：自动轮换开关必须落盘（否则创建时传入恒被丢弃，显式/启动轮换全部失效）
    proxyAutoRotate: eff.proxyAutoRotate === true,
    proxyInline: eff.proxyMode === 'inline' ? (eff.proxyInline || null) : null,
    os: eff.os || 'Windows',
    browser: eff.browser || 'Chrome',
    startupUrls: eff.startupUrls || [],
    launchArgs: eff.launchArgs || [],
    launchBehavior: eff.launchBehavior || {
      restoreLastSession: false,
      blockVideo: false,
      blockImages: false,
      blockImagesThresholdKB: 10,
      clearCacheOnLaunch: false,
      cacheClearMode: 'none',
      clearCookies: false,
    },
    lastSessionUrls: eff.lastSessionUrls || [],
    fingerprintOverride: eff.fingerprintOverride || {},
    templateId: eff.templateId || null,
    // CAP-A1：创建时对模板的显式覆盖键清单（模板自检的漂移豁免依据——
    // 之后任何绕过模板流程的 override 改动都会被 template check 判为漂移）
    templateOverrides: tpl ? Object.keys(input.fingerprintOverride || {}) : undefined,
    fingerprint: null,
    createdAt: Date.now(),
    ...identity.stamp(user), // CAP-O1：workspaceId + createdBy/updatedBy 归属盖章
  };
  // 生成并缓存指纹（把 profile 级 os/browser 合并进 override）
  const mergedOverride = { os: profile.os, browser: profile.browser, ...profile.fingerprintOverride };
  const ipGeo = await resolveIpGeo(mergedOverride, resolveProxy(profile, db.getProxies()));
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), mergedOverride, ipGeo);
  return profile;
}

router.get('/profiles', (req, res) => {
  const list = db.getProfiles().map((p) => ({ ...p, running: browserManager.isRunning(p.id), vault: vault.getMaskedSummary(p.id) }));
  // CAP-O1：列表按身份过滤（模式 A 下恒等于本地用户视角，行为不变）
  res.json(identity.filterByWorkspace(list, req.identityUser));
});

router.post('/profiles', async (req, res) => {
  // CAP-O2：创建属管理能力（与 import 一致）——MEMBER（仅 profile:use）不可创建
  const u = req.identityUser;
  try { identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'profile:manage'); }
  catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e) }); }
  try {
    // CAP-A1：buildNewProfile 可能抛 404（模板不存在）/ 403（跨工作区模板）——
    // async handler 的 rejection Express 不接，必须显式 try/catch，否则请求悬挂超时
    const profile = await buildNewProfile(req.body || {}, u);
    db.upsertProfile(profile);
    auditReq(req, 'profile.create', 'profile', profile.id, { name: profile.name });
    res.json(profile);
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

// CAP-A1：批量建号——同一模板基线 + 每号独立 seed（「同形不同样」：稳定字段由模板钉住，
// 噪声字段由各 profile 独立派生）。强制忽略调用方传入的 seed，杜绝整批克隆同一指纹。
router.post('/profiles/batch', async (req, res) => {
  const u = req.identityUser;
  try {
    identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'profile:manage');
    const body = req.body || {};
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > fpTemplates.BATCH_MAX) {
      throw fpTemplates.err400('count 必须是 1-' + fpTemplates.BATCH_MAX + ' 的整数');
    }
    const namePrefix = String(body.namePrefix || '批量配置').slice(0, 60);
    const created = [];
    const errors = [];
    for (let i = 0; i < count; i++) {
      try {
        const profile = await buildNewProfile({
          ...body,
          name: namePrefix + ' ' + (i + 1),
          group: body.group || 'batch',
          seed: undefined, // 强制独立 seed
        }, u);
        db.upsertProfile(profile);
        created.push({ id: profile.id, name: profile.name, seed: profile.seed });
      } catch (e) {
        errors.push({ index: i, error: String(e.message || e).slice(0, 160) });
      }
    }
    auditReq(req, 'profile.batch_create', 'profile', null, { count: created.length, templateId: body.templateId || null, failed: errors.length });
    res.json({ ok: true, createdCount: created.length, created, errors });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e).slice(0, 200) });
  }
});

// CAP-C1：批量导出。?ids=a,b,c（逐 id 校验可见性，任一不可访问整体 403——授权不 fail-open）；
// 不带 ids → 导出当前身份可见的全部。导出文件剥离指纹缓存（导入按 seed 重算）与归属字段（导入方重新盖章）；
// 保留 seed（指纹连续性）。Vault 凭据与 Profile 天然隔离（CAP-O1 §7），不在导出文件内。
router.get('/profiles/export', (req, res) => {
  const all = db.getProfiles();
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  let selected;
  if (ids.length) {
    selected = [];
    for (const id of ids) {
      const p = all.find((x) => x.id === id);
      if (!p) return res.status(404).json({ ok: false, error: 'profile 不存在: ' + id });
      if (!identity.canAccessResource(req.identityUser, p, 'profile:use')) {
        return res.status(403).json({ ok: false, error: '无权导出 profile: ' + id });
      }
      selected.push(p);
    }
  } else {
    selected = identity.filterByWorkspace(all, req.identityUser);
  }
  const profiles = selected.map((p) => {
    const { fingerprint, workspaceId, createdBy, updatedBy, ...rest } = p;
    return rest;
  });
  res.setHeader('Content-Disposition', 'attachment; filename="fpb-profiles-export.json"');
  auditReq(req, 'profile.export', 'profile', null, { count: profiles.length, ids: profiles.map((p) => p.id) });
  res.json({ format: 'fpb-profiles', version: 1, exportedAt: new Date().toISOString(), count: profiles.length, profiles });
});

// CAP-C1：批量导入。创建属管理能力（profile:manage）——MEMBER（仅 profile:use）不可导入。
// 新 id / 重新盖章 / 名称冲突去重（不静默覆盖）；单条失败不影响其余（逐条 fail-open）。
router.post('/profiles/import', async (req, res) => {
  const u = req.identityUser;
  if (!u) return res.status(401).json({ ok: false, error: '未登录' });
  try {
    identity.assertCan(u.id, u.currentWorkspaceId, 'profile:manage');
  } catch (e) {
    return res.status(e.status || 403).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
  const body = req.body || {};
  const items = Array.isArray(body.profiles) ? body.profiles : Array.isArray(body) ? body : null;
  if (!items || !items.length) return res.status(400).json({ ok: false, error: 'profiles 数组必填' });
  if (items.length > 200) return res.status(400).json({ ok: false, error: '单次导入上限 200 条' });
  const existingNames = new Set(identity.filterByWorkspace(db.getProfiles(), u).map((p) => p.name));
  const imported = [];
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    try {
      let name = String(item.name || '导入配置').slice(0, 120);
      if (existingNames.has(name)) {
        name = name + ' (导入)';
        let n = 2;
        while (existingNames.has(name)) { name = name.replace(/ \(导入\)( \d+)?$/, '') + ' (导入) ' + n; n++; }
      }
      existingNames.add(name);
      const profile = await buildNewProfile({ ...item, name }, u);
      db.upsertProfile(profile);
      imported.push({ id: profile.id, name: profile.name, sourceId: item.id || null });
    } catch (e) {
      errors.push({ index: i, error: String(e.message || e).slice(0, 160) });
    }
  }
  auditReq(req, 'profile.import', 'profile', null, { count: imported.length, failed: errors.length });
  res.json({ ok: true, importedCount: imported.length, imported, errors });
});

// Profile 运行态快照（C20）：全部运行中 Profile 的实时信息（C20 前用户只能看到 running 布尔）。
// 注意必须注册在 /profiles/:id 之前，否则 'runtime' 会被当作 id 吞掉。
router.get('/profiles/runtime', (req, res) => {
  const nameById = new Map(db.getProfiles().map((p) => [p.id, p.name]));
  const snapshots = browserManager.runtimeSnapshots().map((s) => ({ ...s, name: nameById.get(s.profileId) || s.profileId }));
  res.json({ profiles: snapshots, at: Date.now() });
});

router.get('/profiles/:id', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return;
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
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return;
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
  if (!guardProfile(res, req.identityUser, p, 'profile:manage')) return;
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
    proxyAutoRotate: req.body.proxyAutoRotate === undefined ? (p.proxyAutoRotate === true) : req.body.proxyAutoRotate === true,
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
  p.updatedBy = req.identityUser ? req.identityUser.id : p.updatedBy; // CAP-O1：归属审计
  db.upsertProfile(p);
  auditReq(req, 'profile.update', 'profile', p.id, { name: p.name });
  res.json(p);
});

router.post('/profiles/:id/duplicate', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:manage')) return;
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
  copy.workspaceId = p.workspaceId; // 副本留在源工作区
  copy.createdBy = req.identityUser ? req.identityUser.id : copy.createdBy; // CAP-O1：归属审计
  db.upsertProfile(copy);
  auditReq(req, 'profile.duplicate', 'profile', copy.id, { sourceId: p.id, name: copy.name });
  res.json(copy);
});

router.delete('/profiles/:id', (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:manage')) return;
  try {
    if (browserManager.isRunning(req.params.id)) browserManager.close(req.params.id);
    try { vault.deleteProfileSecrets(req.params.id); }
    catch (e) { console.warn('[delete] vault 清理失败(已忽略):', e.message); }
    db.deleteProfile(req.params.id);
    auditReq(req, 'profile.delete', 'profile', req.params.id, { name: p.name });
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

// ---------------- Fingerprint Templates (CAP-A1) ----------------
// workspace-scoped：创建/改/删 = profile:manage；读 = 任意成员（filterByWorkspace）。
// GET /templates/:id/check 必须声明在 /templates/:id 之前（C1 教训：防 :id 吞子路径）。
const templateRouter = express.Router();
templateRouter.get('/templates', (req, res) => {
  res.json(identity.filterByWorkspace(fpTemplates.getTemplates(), req.identityUser));
});
templateRouter.post('/templates', (req, res) => {
  const u = req.identityUser;
  try {
    identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'profile:manage');
    const tpl = { ...fpTemplates.createTemplate(req.body || {}), ...identity.stamp(u) };
    fpTemplates.saveTemplates(fpTemplates.getTemplates().concat(tpl));
    auditReq(req, 'template.create', 'fp_template', tpl.id, { name: tpl.name });
    res.status(201).json(tpl);
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e).slice(0, 200) });
  }
});
// 模板级一致性自检：对该模板名下全部可见 profile 跑 integrity 体检并聚合
templateRouter.get('/templates/:id/check', (req, res) => {
  const tpl = fpTemplates.getTemplates().find((t) => t.id === req.params.id);
  if (!tpl) return res.status(404).json({ error: 'not found' });
  if (!guardResource(res, req.identityUser, tpl, 'profile:use')) return;
  const profiles = identity.filterByWorkspace(db.getProfiles(), req.identityUser).filter((p) => p.templateId === tpl.id);
  const engineVersion = browserManager.getChromeVersion();
  const details = profiles.map((p) => {
    try {
      // 自检不做网络依赖（ipGeo=null）：模板体检关注配置一致性，而非出口环境
      const mergedOverride = { os: p.os, browser: p.browser, ...p.fingerprintOverride };
      const fp = generateFingerprint(seedFromProfile(p), mergedOverride, null);
      if (engineVersion && fp.userAgent && /Chrome\/\d+(\.\d+)*/.test(fp.userAgent)) {
        fp.userAgent = fp.userAgent.replace(/Chrome\/\d+(\.\d+)*/, 'Chrome/' + engineVersion);
      }
      const report = runIntegrityCheck(p, { fp, engineVersion, proxies: db.getProxies() });
      const failed = report.results.filter((r) => !r.ok).map((r) => r.area + ': ' + r.msg);
      // CAP-A1 模板契约漂移检测：模板钉住的键若与 profile 当前 override 不一致、
      // 且不在创建时显式覆盖清单（templateOverrides）内 → 判漂移（生成器会对非法值
      // 静默回退，fp 层面抓不到，必须在契约层比对）
      const exempt = new Set(p.templateOverrides || []);
      const drift = Object.keys(tpl.fingerprintOverride || {})
        .filter((k) => JSON.stringify((p.fingerprintOverride || {})[k]) !== JSON.stringify(tpl.fingerprintOverride[k]) && !exempt.has(k));
      if (drift.length) failed.push('template: 模板钉住键漂移(未经模板流程): ' + drift.join(','));
      return { profileId: p.id, name: p.name, pass: report.pass && drift.length === 0, status: report.pass && drift.length === 0 ? report.status : 'DRIFT', failed };
    } catch (e) {
      return { profileId: p.id, name: p.name, pass: false, status: 'ERROR', failed: [String(e.message || e).slice(0, 200)] };
    }
  });
  const passCount = details.filter((d) => d.pass).length;
  auditReq(req, 'template.check', 'fp_template', tpl.id, { checked: details.length, pass: passCount, warning: details.length - passCount });
  res.json({ templateId: tpl.id, checked: details.length, pass: passCount, warning: details.length - passCount, details });
});
templateRouter.get('/templates/:id', (req, res) => {
  const tpl = fpTemplates.getTemplates().find((t) => t.id === req.params.id);
  if (!tpl) return res.status(404).json({ error: 'not found' });
  if (!guardResource(res, req.identityUser, tpl, 'profile:use')) return;
  res.json(tpl);
});
templateRouter.put('/templates/:id', (req, res) => {
  try {
    const list = fpTemplates.getTemplates();
    const tpl = list.find((t) => t.id === req.params.id);
    if (!tpl) return res.status(404).json({ error: 'not found' });
    if (!guardResource(res, req.identityUser, tpl, 'profile:manage')) return;
    const body = { ...(req.body || {}) };
    ['id', 'workspaceId', 'createdBy'].forEach((k) => delete body[k]); // 防归属伪造
    fpTemplates.updateTemplate(tpl, body);
    tpl.updatedBy = req.identityUser ? req.identityUser.id : tpl.updatedBy;
    fpTemplates.saveTemplates(list);
    auditReq(req, 'template.update', 'fp_template', tpl.id, { name: tpl.name });
    res.json(tpl);
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});
templateRouter.delete('/templates/:id', (req, res) => {
  const list = fpTemplates.getTemplates();
  const tpl = list.find((t) => t.id === req.params.id);
  if (!tpl) return res.status(404).json({ error: 'not found' });
  if (!guardResource(res, req.identityUser, tpl, 'profile:manage')) return;
  // 已引用该模板的 profile 保留 templateId（成为悬挂引用，指纹不受影响——生成只用 seed+override 快照）
  fpTemplates.saveTemplates(list.filter((t) => t.id !== req.params.id));
  auditReq(req, 'template.delete', 'fp_template', tpl.id, { name: tpl.name });
  res.json({ ok: true });
});

// ---------------- Proxy ----------------
// CAP-O2：proxy 升级为 workspace-scoped 资源——列表按身份过滤；创建需 profile:manage
// （与 Profile 一致）；改/删走统一归属守卫；响应不回显代理明文密码（落盘本就只存密文）。
const proxyRouter = express.Router();
proxyRouter.get('/proxies', (req, res) => res.json(identity.filterByWorkspace(db.getProxiesPublic(), req.identityUser)));
proxyRouter.post('/proxies', (req, res) => {
  const u = req.identityUser;
  try {
    identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'profile:manage');
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
    pool: proxyPool.normalizePool(req.body.pool), // CAP-B1：池标签（可选；轮换只在同池内进行）
    ...identity.stamp(u), // CAP-O2：workspaceId + createdBy/updatedBy 归属盖章
    };
    list.push(proxy);
    db.saveProxies(list); // 内部 vault.encrypt：FPB_MASTER_KEY 缺失时 fail-closed 抛错
    auditReq(req, 'proxy.create', 'proxy', proxy.id, { name: proxy.name, server: proxy.server, type: proxy.type });
    res.json({ ...proxy, password: proxy.password ? '••••••' : '' });
  } catch (e) {
    // STEP 14 修复：凭据加密拒绝（如 FPB_MASTER_KEY 缺失）等异常必须返回 JSON，不得裸 500 HTML
    res.status(e.status || 500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});
proxyRouter.put('/proxies/:id', (req, res) => {
  try {
    const list = db.getProxies();
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (!guardResource(res, req.identityUser, p, 'profile:manage')) return;
    const body = { ...(req.body || {}) };
    // 防归属/健康伪造：归属字段与健康档案均不受客户端控制（健康只能由 check 路由写入）
    ['id', 'workspaceId', 'createdBy', 'lastCheck', 'health'].forEach((k) => delete body[k]);
    if (body.pool !== undefined) body.pool = proxyPool.normalizePool(body.pool);
    Object.assign(p, body);
    p.updatedBy = req.identityUser ? req.identityUser.id : p.updatedBy;
    db.saveProxies(list);
    auditReq(req, 'proxy.update', 'proxy', p.id, { name: p.name });
    res.json({ ...p, password: p.password ? '••••••' : '' });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});
proxyRouter.delete('/proxies/:id', (req, res) => {
  try {
    const list = db.getProxies();
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (!guardResource(res, req.identityUser, p, 'profile:manage')) return;
    db.saveProxies(list.filter((x) => x.id !== req.params.id));
    auditReq(req, 'proxy.delete', 'proxy', p.id, { name: p.name });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});
proxyRouter.post('/proxies/:id/check', async (req, res) => {
  const list = db.getProxies();
  const p = list.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardResource(res, req.identityUser, p, 'profile:use')) return;
  try {
    const result = await checkProxy(p);
    proxyPool.recordCheck(p, result); // CAP-B1：健康档案（滑动窗口 + 连续计数）
    db.saveProxies(list);
    auditReq(req, 'proxy.check', 'proxy', p.id, { ok: !!result.ok });
    res.json({ ...result, health: proxyPool.metricsOf(p) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});
// CAP-B1：池健康汇总（读 = 任意成员，按可见集过滤）
proxyRouter.get('/proxies/health', (req, res) => {
  const list = identity.filterByWorkspace(db.getProxiesPublic(), req.identityUser);
  const items = list.map((p) => ({
    id: p.id, name: p.name, pool: p.pool || null,
    server: p.server, type: p.type,
    ...proxyPool.metricsOf(p),
  }));
  const summary = { healthy: 0, unchecked: 0, degraded: 0, dead: 0 };
  items.forEach((x) => { summary[x.status] = (summary[x.status] || 0) + 1; });
  res.json({ ok: true, total: items.length, summary, items });
});

// CAP-B1：显式轮换——把 profile 的保存代理换到同池健康替补（profile:manage，因为改的是 profile）
proxyRouter.post('/proxies/rotate', async (req, res) => {
  const u = req.identityUser;
  try {
    const profileId = req.body && req.body.profileId;
    const p = db.getProfile(profileId);
    if (!p) return res.status(404).json({ error: 'profile not found' });
    if (!guardResource(res, u, p, 'profile:manage')) return;
    const proxies = db.getProxies();
    const decision = proxyPool.chooseRotation(p, proxies);
    if (!decision.rotate) {
      return res.json({ ok: true, rotated: false, reason: decision.reason });
    }
    const fromId = p.proxyId;
    p.proxyId = decision.to.id;
    p.updatedBy = u ? u.id : p.updatedBy;
    db.upsertProfile(p);
    auditReq(req, 'proxy.rotate', 'profile', p.id, { from: fromId, to: decision.to.id, reason: decision.reason });
    res.json({ ok: true, rotated: true, from: fromId, to: { id: decision.to.id, name: decision.to.name, pool: decision.to.pool || null } });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

proxyRouter.post('/proxies/:id/check-geo', async (req, res) => {
  const p = db.getProxies().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardResource(res, req.identityUser, p, 'profile:use')) return;
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
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return; // CAP-O2：使用即需 profile:use
  try {
    // CAP-B1：启动前自动轮换（仅 profile.proxyAutoRotate=true 且当前保存代理已 dead 且同池有替补；
    // 找不到替补保持原代理 fail-open——绝不因健康数据静默改变执行语义）
    const proxies = db.getProxies();
    const rot = proxyPool.chooseRotation(p, proxies);
    if (rot.rotate) {
      p.proxyId = rot.to.id;
      p.updatedBy = req.identityUser ? req.identityUser.id : p.updatedBy;
      db.upsertProfile(p);
      auditReq(req, 'proxy.auto_rotate', 'profile', p.id, { to: rot.to.id, reason: rot.reason });
    }
    await browserManager.launch(p, proxies);
    auditReq(req, 'browser.launch', 'profile', p.id, { name: p.name });
    res.json({ ok: true, running: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});
browserRouter.post('/browser/:id/stop', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return;
  await browserManager.close(req.params.id);
  auditReq(req, 'browser.stop', 'profile', p.id, {});
  res.json({ ok: true, running: false });
});
browserRouter.get('/browser/status', (req, res) => {
  const all = db.getProfiles().map((p) => ({ id: p.id, running: browserManager.isRunning(p.id) }));
  res.json(all);
});
// 网页"云查看"：当前页面截图（base64）
browserRouter.get('/browser/:id/screenshot', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return;
  try {
    const b64 = await browserManager.screenshot(req.params.id);
    res.json({ ok: true, data: b64 });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
// C42 网页"云直播"：CDP screencast 帧流（SSE）。页面不动不出帧（零带宽）；
// 帧率上限 ≈8fps（FrameHub 节流），无观众自动 stop 释放 CDP session。
browserRouter.get('/browser/:id/stream', (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return;
  if (!browserManager.isRunning(p.id)) return res.status(400).json({ ok: false, error: '浏览器未运行' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  let unsubscribe = null;
  let heartbeat = null;
  try {
    const hub = screencastManager.getHub(browserManager, p.id);
    unsubscribe = hub.subscribe((frame) => {
      try { res.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`); } catch { /* 连接已断 */ }
    });
    res.write(`data: ${JSON.stringify({ ok: true, mode: 'screencast' })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ ok: false, error: String(e.message || e) })}\n\n`);
  }
  heartbeat = setInterval(() => {
    // C45 缺陷修复（B 类）：浏览器会话停止后旧实现心跳只写 ping → 僵流保活、
    // hub 订阅永不释放、客户端永远显示"实时流已连接"的冻结画面。
    // 修复：心跳时检查浏览器存活，已停止则主动断流（客户端 onerror → 自动降级低速）。
    if (!browserManager.isRunning(p.id)) { cleanup(); return; }
    try { res.write(': ping\n\n'); } catch { /* 忽略 */ }
  }, 15000);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; // C45：幂等守卫（心跳断流 + res close 双路径只清理一次）
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    if (unsubscribe) unsubscribe(); // 最后一个订阅者离开 → hub 自动 stop + 释放 CDP
    try { res.end(); } catch { /* 已结束 */ }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
});
// 网页"云查看"：导航到指定网址
browserRouter.post('/browser/:id/navigate', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return;
  try {
    await browserManager.navigate(req.params.id, req.body.url);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
// 在当前页面执行一段 JS（STEP 0.5 §2.3：默认关闭，需 FPB_ALLOW_EVALUATE=1）。
// 此端点等价于对浏览器会话的无鉴权远程代码执行（new Function），不得默认可用。
browserRouter.post('/browser/:id/evaluate', async (req, res) => {
  if (!EVALUATE_ENABLED) {
    return res.status(403).json({
      ok: false,
      error: 'EVALUATE_DISABLED',
      message: '远程 JS 执行已默认关闭。本机调试请设置 FPB_ALLOW_EVALUATE=1 后重启。',
    });
  }
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
// CAP-O2：vault 以 profileId 为键 → 守卫挂在对应 Profile 资源上：
//   读掩码摘要 = profile:use；写入凭据 = credential:manage（ADMIN/OWNER）。
const vaultRouter = express.Router();
vaultRouter.get('/vault/:id', (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return;
  res.json(vault.getMaskedSummary(req.params.id) || { hasEmail: false, hasPassword: false, card: null });
});
vaultRouter.post('/vault/:id', (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'credential:manage')) return;
  try {
    const ok = vault.setProfileSecrets(req.params.id, req.body);
    // 审计只记录字段名集合，值由 audit.redact 兜底（双保险）
    auditReq(req, 'vault.set', 'profile', req.params.id, { fields: Object.keys(req.body || {}) });
    res.json({ ok });
  } catch (e) {
    // FPB_MASTER_KEY 缺失等加密拒绝：JSON 错误而非裸 500 HTML
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

// ---------------- Settings (C14: 运行时设置中心) ----------------
// GET = 掩码视图 + env 对账（任何已认证用户可读）；PUT/POST test = workspace:update（ADMIN/OWNER）。
// apiKey 永不明文出站（settings.getMasked 只回 last4 掩码）；testLlm 结果也绝不含 key。
// C47：存储使用与清理治理（白名单 + dryRun 默认 + 防路径逃逸）
const systemStorage = require('./systemStorage');
const storageRouter = express.Router();
storageRouter.get('/system/storage', async (req, res) => {
  try { res.json({ ok: true, items: await systemStorage.collectStats(), root: undefined }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});
storageRouter.post('/system/storage/cleanup', async (req, res) => {
  try {
    const body = req.body || {};
    const r = await systemStorage.cleanup({
      targets: Array.isArray(body.targets) ? body.targets : [],
      olderThanDays: Number(body.olderThanDays) || 7,
      keepRecent: Number(body.keepRecent) || 3,
      dryRun: body.dryRun !== false, // 默认 dry-run：不显式传 false 不删任何东西
      isRunning: (id) => browserManager.isRunning(id),
    });
    if (!r.ok) return res.status(400).json(r);
    auditReq(req, body.dryRun === false ? 'storage.cleanup' : 'storage.cleanup.dryrun', 'system', 'storage', { freed: r.freed, count: r.count });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});

const settingsRouter = express.Router();
settingsRouter.get('/settings', (req, res) => {
  try { res.json(settings.getMasked()); }
  catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
});
settingsRouter.put('/settings', (req, res) => {
  const u = req.identityUser;
  try { identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'workspace:update'); }
  catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e) }); }
  try {
    const masked = settings.updateSettings(req.body || {});
    auditReq(req, 'settings.update', 'settings', 'runtime', { fields: Object.keys(req.body || {}) });
    res.json({ ok: true, settings: masked });
  } catch (e) {
    // FPB_MASTER_KEY 缺失等加密拒绝 → JSON 错误而非裸 500
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});
settingsRouter.post('/settings/test', (req, res) => {
  const u = req.identityUser;
  try { identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'workspace:update'); }
  catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e) }); }
  settings.testLlm(req.body || {}).then((r) => {
    auditReq(req, 'settings.test', 'settings', 'runtime', { ok: r.ok, error: r.error || null });
    res.json(r);
  }).catch((e) => res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) }));
});

// C30：系统就绪度自检（首次运行引导 + 健康体检只读聚合）。
// 只读 GET：所有凭据一律走既有掩码接口（明文永不出站），代理只计数不输出。
settingsRouter.get('/settings/readiness', (req, res) => {
  try {
    const u = req.identityUser || null;
    const llm = (settings.getMasked().llm) || {};
    const profiles = db.getProfiles() || [];
    const tasks = db.getTasks() || [];
    const templates = fpTemplates.getTemplates() || [];
    const proxies = db.getProxies() || [];
    const snapshots = browserManager.runtimeSnapshots() || [];

    const llmReady = !!(llm.provider && llm.provider.set) && !!(llm.apiKey && llm.apiKey.set);
    const isLocal = !!u && u.status === 'local';
    const kind = !u ? 'none' : (u.__apiKey ? 'apiKey' : (isLocal ? 'local' : 'session'));
    const role = u ? (identity.roleOf(u.id, u.currentWorkspaceId) || null) : null;

    const checks = [
      { key: 'auth', label: '身份会话', ok: !!u, optional: false,
        detail: u ? `${u.username} · ${role || '无角色'} · ${kind === 'apiKey' ? 'API Key' : kind === 'local' ? '本地单机' : '会话登录'}` : '未解析到身份',
        hint: '本机模式自动引导；多用户模式需在治理中心建立账号与角色', panel: 'governance' },
      { key: 'llm', label: 'LLM 凭据', ok: llmReady, optional: false,
        detail: llmReady ? `${llm.provider.masked} / ${(llm.model && llm.model.masked) || '(默认模型)'} / Key ${(llm.apiKey && llm.apiKey.masked) || ''}` : '缺少 provider 或 API Key',
        hint: '系统设置 → LLM：填 provider 与 Key 后点「测试连通」', panel: 'settings' },
      { key: 'profile', label: '浏览器配置', ok: profiles.length > 0, optional: false,
        detail: `${profiles.length} 个配置`, hint: '配置管理 → 新建配置，然后启动浏览器', panel: 'profiles' },
      { key: 'template', label: '指纹模板', ok: templates.length > 0, optional: true,
        detail: `${templates.length} 个模板（可选，用于复用指纹基线）`, hint: '指纹模板 → 保存复用基线', panel: 'templates' },
      { key: 'proxy', label: '代理', ok: proxies.length > 0, optional: true,
        detail: `${proxies.length} 条代理（可选，跨境/多地区场景需要）`, hint: '代理管理 → 添加代理并做健康检查', panel: 'proxies' },
      { key: 'task', label: '自动化任务', ok: tasks.length > 0, optional: true,
        detail: `${tasks.length} 个任务（可选，AI 操作员/定时调度需要）`, hint: '自动化任务 → 新建任务', panel: 'tasks' },
    ];
    const blockers = checks.filter((c) => !c.optional && !c.ok);

    res.json({
      ok: blockers.length === 0,
      generatedAt: Date.now(),
      stage: blockers.length === 0 ? 'READY' : 'SETUP_REQUIRED',
      auth: u ? { userId: u.id, username: u.username, workspaceId: u.currentWorkspaceId || null, role, kind } : null,
      llm: { ready: llmReady, provider: (llm.provider && llm.provider.masked) || null, model: (llm.model && llm.model.masked) || null, keyMasked: (llm.apiKey && llm.apiKey.masked) || null, baseUrl: (llm.baseUrl && llm.baseUrl.masked) || null },
      assets: { profiles: profiles.length, templates: templates.length, proxies: proxies.length, tasks: tasks.length, activeSessions: snapshots.length },
      security: { bind: BIND, tokenRequired: !!process.env.FPB_API_TOKEN, evaluateEnabled: EVALUATE_ENABLED, masterKeySet: !!process.env.FPB_MASTER_KEY },
      checks,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

// ---------------- Backup / Restore（C22 数据备份） ----------------
settingsRouter.get('/backup/export', (req, res) => {
  const u = req.identityUser;
  try { identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'workspace:update'); }
  catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e) }); }
  try {
    const snap = backup.collectSnapshot();
    auditReq(req, 'backup.export', 'backup', 'data', { files: Object.keys(snap.files).length });
    res.attachment('identra-backup-' + new Date(snap.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json');
    res.json(snap);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

settingsRouter.post('/backup/restore', (req, res) => {
  const u = req.identityUser;
  try { identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'workspace:delete'); } // 恢复=全量覆盖 → 最严格档
  catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e) }); }
  try {
    const r = backup.restoreSnapshot(req.body || {});
    auditReq(req, 'backup.restore', 'backup', 'data', { restored: r.restored.length, preRestoreDir: r.preRestoreDir });
    res.json({ ok: true, restored: r.restored, preRestoreDir: r.preRestoreDir, note: '恢复前旧数据已快照到 pre-restore 目录；建议重启服务确保全部模块重新读盘' });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

// ---------------- Tasks (工作流) ----------------
// CAP-O2：workflow task 升级为 workspace-scoped 资源（task:manage = ADMIN/OWNER）
const taskRouter = express.Router();
taskRouter.get('/tasks', (req, res) => res.json(identity.filterByWorkspace(db.getTasks(), req.identityUser)));
taskRouter.post('/tasks', (req, res) => {
  const u = req.identityUser;
  try { identity.assertCan(u && u.id, u && u.currentWorkspaceId, 'task:manage'); }
  catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e) }); }
  const list = db.getTasks();
  const task = {
    id: 'tk_' + Date.now().toString(36),
    name: req.body.name || '工作流',
    type: req.body.type || 'custom', // registration | checkout | custom
    profileId: req.body.profileId || null,
    config: req.body.config || {},    // 站点选择器/URL
    steps: req.body.steps || [],      // 自定义步骤
    createdAt: Date.now(),
    ...identity.stamp(u),
  };
  list.push(task);
  db.saveTasks(list);
  auditReq(req, 'task.create', 'workflow_task', task.id, { name: task.name, type: task.type });
  res.json(task);
});
taskRouter.put('/tasks/:id', (req, res) => {
  const list = db.getTasks();
  const t = list.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (!guardResource(res, req.identityUser, t, 'task:manage')) return;
  const body = { ...(req.body || {}) };
  ['id', 'workspaceId', 'createdBy'].forEach((k) => delete body[k]); // 防归属伪造
  Object.assign(t, body);
  t.updatedBy = req.identityUser ? req.identityUser.id : t.updatedBy;
  db.saveTasks(list);
  auditReq(req, 'task.update', 'workflow_task', t.id, { name: t.name });
  res.json(t);
});
taskRouter.delete('/tasks/:id', (req, res) => {
  const list = db.getTasks();
  const t = list.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (!guardResource(res, req.identityUser, t, 'task:manage')) return;
  db.saveTasks(list.filter((x) => x.id !== req.params.id));
  auditReq(req, 'task.delete', 'workflow_task', t.id, { name: t.name });
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
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return; // CAP-O2

  let steps = rawSteps;
  if (!steps && taskId) {
    const task = db.getTask(taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (!guardResource(res, req.identityUser, task, 'task:read')) return; // CAP-O2
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
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return; // CAP-O2
  const s = browserManager.getSession(req.params.id);
  if (!s) return res.status(409).json({ error: 'profile 未运行' });
  res.json(await s.context.cookies());
});
cookieRouter.post('/cookies/:id/import', async (req, res) => {
  const p = db.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!guardProfile(res, req.identityUser, p, 'profile:use')) return; // CAP-O2
  const s = browserManager.getSession(req.params.id);
  if (!s) return res.status(409).json({ error: 'profile 未运行' });
  const cookies = Array.isArray(req.body) ? req.body : req.body.cookies;
  await s.context.addCookies(cookies);
  res.json({ ok: true, count: cookies.length });
});

// STEP 0.5 §2.1：所有业务 API 之前插入身份边界。静态前端与 SPA fallback 不在此列。
// CAP-O1：身份路由（register/login 公开；me/workspaces 自管权限）挂机器级边界之前；
//          identityResolver 先解析 req.identityUser，requireAuth 对已解析身份放行。
app.use('/api/auth', identity.router);
app.use('/api', identity.identityResolver, requireAuth, identity.enforceApiKeyWriteGuard, router, templateRouter, proxyRouter, browserRouter, vaultRouter, storageRouter, settingsRouter, taskRouter, automationRouter, cookieRouter);

// AI Browser Operator（Phase 1.1 基础设施）
app.use('/api/ai', identity.identityResolver, requireAuth, identity.enforceApiKeyWriteGuard, require('./agent'));

// 静态前端（生产构建）
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (require('fs').existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// STEP 0.5 §2.4：启动期安全自检 —— 把「匿名 + 对外暴露」的非法组合挡在启动之前，不静默降级。
const _secProblems = assertStartupSecurity({ bind: BIND, corsWildcard: false });
if (_secProblems.length && process.env.FPB_ALLOW_INSECURE !== '1') {
  console.error('\n[security] 启动被拒绝 —— 检测到不安全的配置组合：');
  _secProblems.forEach((p, i) => console.error(`  ${i + 1}. ${p}`));
  console.error('\n若你完全清楚风险且仍需启动，设置 FPB_ALLOW_INSECURE=1 显式确认。\n');
  process.exit(1);
}

app.listen(PORT, BIND, () => {
  const auth = require('./auth');
  console.log(`[server] 指纹浏览器后端已启动: http://${BIND}:${PORT}`);
  console.log(
    `[security] 身份模式=${auth.mode === 'token' ? 'token（全部请求需鉴权）' : 'local（仅 loopback 放行）'}` +
      ` / 绑定=${BIND} / CORS 白名单=${ALLOWED_ORIGINS.length} 条 / 远程JS执行=${EVALUATE_ENABLED ? '⚠️ 开启' : '关闭'}`
  );
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
