'use strict';

// STEP 15 — CAP-A1：指纹模板库 + 批量建号 + 模板级一致性自检。
//
// 覆盖：
//   Part 1 模块级：
//     A) normalizeOverride 键白名单（未知键剥离 / screen 收紧）
//     B) validateTemplateInput（坏时区 / 坏 locale / 越界数值 → 400；合法 → 归一化通过）
//     C) mergeTemplateIntoInput 合并优先级（input > 模板 > 默认）
//   Part 2 e2e（模式 B）：
//     D) 模板 CRUD + 校验拒绝 + workspace 盖章 + 跨工作区不可见
//     E) 单建引用模板（templateId 落库 / 稳定字段生效 / input 覆盖模板 / 跨工作区模板 403）
//     F) 批量建号（N 条独立 seed / 名称序号 / 强制忽略调用方 seed / 校验 / MEMBER 403）
//     G) 模板级一致性自检（全过 / 篡改后抓出 WARNING）
//     H) 审计（template.create / profile.batch_create / template.check）
//     I) 红线：无 siteType / 无白名单外键透传
// 用法：node server/scripts/test_step15_fp_templates.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }
function expectThrow(fn, wantStatus) {
  try { fn(); return false; } catch (e) { return !wantStatus || e.status === wantStatus; }
}

// ============================================================================
// Part 1 — 模块级
// ============================================================================
const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-a1-unit-'));
process.env.FPB_DATA_DIR = TMP1;
const fpTemplates = require('../fpTemplates');

(async () => {
  section('A) normalizeOverride 键白名单');
  const norm = fpTemplates.normalizeOverride({
    screen: { width: 1920, height: 1080, pixelRatio: 1 },
    language: 'en-US',
    hardwareConcurrency: 8,
    evilPayload: { x: 1 },
    seed: 'hack',
    templateId: 'forged',
  });
  ok(norm.language === 'en-US' && norm.hardwareConcurrency === 8, '白名单内键保留');
  ok(!('evilPayload' in norm) && !('seed' in norm) && !('templateId' in norm), '白名单外键全部剥离');
  ok(norm.screen.width === 1920 && norm.screen.pixelRatio === 1, 'screen 数值收紧通过');
  ok(Object.keys(fpTemplates.normalizeOverride('not-an-object')).length === 0, '非对象输入 → 空 override');
  ok(fpTemplates.normalizeOverride({ screen: 'bad' }).screen === undefined, 'screen 非对象 → 剥离');

  section('B) validateTemplateInput 校验');
  ok(expectThrow(() => fpTemplates.validateTemplateInput({ name: '' }), 400), '空名 → 400');
  ok(expectThrow(() => fpTemplates.validateTemplateInput({ name: 'x', fingerprintOverride: { timezone: 'Mars/Olympus' } }), 400), '坏 IANA 时区 → 400');
  ok(expectThrow(() => fpTemplates.validateTemplateInput({ name: 'x', fingerprintOverride: { language: 'not a locale!!' } }), 400), '坏 locale → 400');
  ok(expectThrow(() => fpTemplates.validateTemplateInput({ name: 'x', fingerprintOverride: { screen: { width: 100, height: 1080 } } }), 400), 'screen 越界 → 400');
  ok(expectThrow(() => fpTemplates.validateTemplateInput({ name: 'x', fingerprintOverride: { hardwareConcurrency: 999 } }), 400), 'hardwareConcurrency 越界 → 400');
  ok(expectThrow(() => fpTemplates.validateTemplateInput({ name: 'x', fingerprintOverride: { deviceMemory: 3 } }), 400), 'deviceMemory 非法值 → 400');
  const good = fpTemplates.validateTemplateInput({ name: 't', fingerprintOverride: { timezone: 'Asia/Shanghai', language: 'zh-CN', deviceMemory: 8 } });
  ok(good.timezone === 'Asia/Shanghai' && good.deviceMemory === 8, '合法输入通过并归一化');

  section('C) mergeTemplateIntoInput 优先级（input > 模板）');
  const tpl = { id: 'ft_t1', os: 'Windows', browser: 'Chrome', fingerprintOverride: { language: 'en-US', timezone: 'America/New_York' } };
  const m1 = fpTemplates.mergeTemplateIntoInput({}, tpl);
  ok(m1.os === 'Windows' && m1.fingerprintOverride.language === 'en-US' && m1.fingerprintOverride.timezone === 'America/New_York', '空 input → 全模板基线 + templateId 落上');
  const m2 = fpTemplates.mergeTemplateIntoInput({ fingerprintOverride: { timezone: 'Asia/Tokyo' } }, tpl);
  ok(m2.fingerprintOverride.timezone === 'Asia/Tokyo' && m2.fingerprintOverride.language === 'en-US', '显式 input 覆盖模板对应键，其余键保留');
  ok(fpTemplates.mergeTemplateIntoInput({}, null).templateId === undefined, '无模板 → 不落 templateId');

  // ============================================================================
  // Part 2 — e2e（模式 B，生产入口子进程）
  // ============================================================================
  const PORT2 = 18798;
  const BASE = 'http://127.0.0.1:' + PORT2;
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-a1-e2e-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT2), FPB_BIND: '127.0.0.1', FPB_API_TOKEN: 'a1-machine-token', FPB_DATA_DIR: TMP2 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const _childOut = [];
  child.stdout.on('data', (d) => _childOut.push(String(d)));
  child.stderr.on('data', (d) => _childOut.push(String(d)));

  async function waitReady() {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(BASE + '/api/ai/health', { signal: AbortSignal.timeout(1000) });
        if (r.status === 200 || r.status === 401) return true;
      } catch (e) { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }
  async function api(method, p, token, body) {
    const r = await fetch(BASE + p, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { /* 非 JSON */ }
    return { status: r.status, json: j };
  }

  try {
    section('生产 server 启动（模式 B）');
    const ready = await waitReady();
    ok(ready, '生产 server 子进程启动成功');
    if (!ready) throw new Error('server 未就绪');

    for (const [u, p] of [['alice6', 'alice6-pass-1'], ['bob6', 'bob6-pass-12'], ['charlie6', 'charlie6-pass']]) {
      await api('POST', '/api/auth/register', null, { username: u, password: p });
    }
    const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).json;
    const A = await login('alice6', 'alice6-pass-1');
    const B = await login('bob6', 'bob6-pass-12');
    const C = await login('charlie6', 'charlie6-pass');
    ok(A.token && B.token && C.token, '三用户注册登录成功');

    section('D) 模板 CRUD / 校验 / 盖章 / 隔离');
    const tplBody = {
      name: 'US-Win11-Chrome-1080p',
      description: '美国环境基线',
      os: 'Windows',
      browser: 'Chrome',
      fingerprintOverride: {
        screen: { width: 1920, height: 1080, pixelRatio: 1 },
        language: 'en-US',
        timezone: 'America/New_York',
        hardwareConcurrency: 8,
        deviceMemory: 8,
      },
    };
    const mkT = await api('POST', '/api/templates', A.token, tplBody);
    ok(mkT.status === 201 && mkT.json.workspaceId === A.workspaceId, '模板创建并盖章 workspaceId');
    const TPL = mkT.json.id;
    ok(mkT.json.fingerprintOverride.evilPayload === undefined, '模板落库前白名单归一化');
    ok((await api('POST', '/api/templates', A.token, { name: '' })).status === 400, '空名 → 400');
    ok((await api('POST', '/api/templates', A.token, { name: 'x', fingerprintOverride: { timezone: 'Mars/Olympus' } })).status === 400, '坏时区 → 400');
    const bobTpl = await api('POST', '/api/templates', B.token, { name: 'bob-模板' });
    ok(bobTpl.status === 201, 'bob 自建模板成功');
    ok((await api('GET', '/api/templates', B.token)).json.length === 1, '模板列表跨工作区隔离');
    ok((await api('DELETE', '/api/templates/' + TPL, B.token)).status === 403, '跨工作区删模板 → 403');
    // 模板永远创建在创建者自己的当前工作区（charlie 对 alice 区是 MEMBER，但对己区是 OWNER）
    const cTpl = await api('POST', '/api/templates', C.token, { name: 'charlie-模板' });
    ok(cTpl.status === 201 && cTpl.json.workspaceId === C.workspaceId, 'MEMBER 建模板落自己工作区（身份语义一致）');

    section('E) 单建引用模板（templateId / 稳定字段 / 覆盖优先级）');
    const p1 = await api('POST', '/api/profiles', A.token, { name: '模板号1', templateId: TPL });
    ok(p1.status === 200 && p1.json.templateId === TPL, 'templateId 落库');
    ok(p1.json.os === 'Windows' && p1.json.fingerprintOverride.screen.width === 1920, '模板基线生效（os/screen）');
    ok(p1.json.fingerprint.language === 'en-US' && p1.json.fingerprint.timezone === 'America/New_York', '生成指纹携带模板语言/时区');
    ok(p1.json.fingerprint.hardwareConcurrency === 8 && p1.json.fingerprint.deviceMemory === 8, '硬件指纹由模板钉住');
    const p2 = await api('POST', '/api/profiles', A.token, { name: '覆盖号', templateId: TPL, fingerprintOverride: { timezone: 'Asia/Tokyo' } });
    ok(p2.json.fingerprint.timezone === 'Asia/Tokyo' && p2.json.fingerprint.language === 'en-US', 'input 覆盖模板时区，语言保留模板基线');
    ok((await api('POST', '/api/profiles', A.token, { name: 'x', templateId: 'ft_notexist' })).status === 404, '不存在模板 → 404');
    ok((await api('POST', '/api/profiles', B.token, { name: 'x', templateId: TPL })).status === 403, '跨工作区模板 → 403');

    section('F) 批量建号（同形不同样）');
    const bat = await api('POST', '/api/profiles/batch', A.token, { templateId: TPL, count: 5, namePrefix: '农场' });
    ok(bat.status === 200 && bat.json.createdCount === 5 && bat.json.errors.length === 0, '批量创建 5 条全成');
    const seeds = bat.json.created.map((x) => x.seed);
    const ids = bat.json.created.map((x) => x.id);
    ok(new Set(seeds).size === 5 && new Set(ids).size === 5, 'seed 与 id 全部独立');
    ok(bat.json.created.every((x, i) => x.name === '农场 ' + (i + 1)), '名称按前缀+序号生成');
    const first = await api('GET', '/api/profiles/' + bat.json.created[0].id, A.token);
    ok(first.json.fingerprint.hardwareConcurrency === 8 && first.json.fingerprint.language === 'en-US', '批量号继承模板稳定字段');
    const details = await api('GET', '/api/profiles', A.token);
    const batchFps = details.json.filter((x) => bat.json.created.some((c) => c.id === x.id)).map((x) => x.fingerprint.mac);
    ok(new Set(batchFps).size === batchFps.length, '批量号噪声字段（mac）彼此不同——同形不同样');
    const forced = await api('POST', '/api/profiles/batch', A.token, { count: 2, namePrefix: '克隆尝试', seed: 'same_seed_everyone' });
    ok(forced.status === 200 && new Set(forced.json.created.map((x) => x.seed)).size === 2, '调用方传入同一 seed 被强制忽略');
    ok((await api('POST', '/api/profiles/batch', A.token, { count: 0 })).status === 400, 'count=0 → 400');
    ok((await api('POST', '/api/profiles/batch', A.token, { count: 51 })).status === 400, 'count=51 → 400');
    ok((await api('POST', '/api/auth/workspaces/' + A.workspaceId + '/members', A.token, { username: 'charlie6', role: 'MEMBER' })).status === 201, 'alice 授 charlie MEMBER');
    ok((await api('POST', '/api/profiles/batch', C.token, { count: 2 })).status === 403, 'MEMBER 批量建号 → 403');
    // 跨工作区模板：批量与 import 同语义——逐条 fail-open（200 + errors），不做整体 403
    const batBad = await api('POST', '/api/profiles/batch', B.token, { templateId: TPL, count: 2 });
    ok(batBad.status === 200 && batBad.json.createdCount === 0 && batBad.json.errors.length === 2, '跨工作区模板批量 → 逐条 fail-open（0 成 2 败）');

    section('G) 模板级一致性自检');
    const chk1 = await api('GET', '/api/templates/' + TPL + '/check', A.token);
    ok(chk1.status === 200 && chk1.json.checked === 7 && chk1.json.pass === 7 && chk1.json.warning === 0, '模板名下 7 号（单建2+批量5）全部体检 PASS');
    const victim = bat.json.created[0].id;
    await api('PUT', '/api/profiles/' + victim, A.token, { fingerprintOverride: { timezone: 'Bogus/Zone' } });
    const chk2 = await api('GET', '/api/templates/' + TPL + '/check', A.token);
    const badRow = (chk2.json.details || []).find((d) => d.profileId === victim);
    ok(chk2.json.checked === 7 && chk2.json.warning >= 1 && badRow && badRow.pass === false, '篡改时区后被自检抓出（WARNING 定位到具体号）');
    ok((badRow.failed || []).some((m) => m.indexOf('timezone') >= 0), '失败详情指明 timezone 维度');
    ok((await api('GET', '/api/templates/' + TPL + '/check', B.token)).status === 403, '跨工作区自检 → 403');
    ok((await api('GET', '/api/templates/ft_missing/check', A.token)).status === 404, '不存在模板自检 → 404');

    section('H) 审计');
    const audBatch = await api('GET', '/api/auth/audit?action=profile.batch_create', A.token);
    ok(audBatch.status === 200 && audBatch.json.total >= 2 && (audBatch.json.entries || []).some((e) => e.detail && e.detail.count === 5), 'batch_create 审计（含 count=5 那批）');
    const actions = new Set((await api('GET', '/api/auth/audit', A.token)).json.entries.map((e) => e.action));
    ok(['template.create', 'template.check', 'profile.create'].every((a) => actions.has(a)), '模板动作齐备入审计');
    ok((await api('GET', '/api/auth/audit', C.token)).status === 403, 'MEMBER 读审计 → 403');

    section('I) 红线');
    const srcIdx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const srcTpl = fs.readFileSync(path.join(__dirname, '..', 'fpTemplates.js'), 'utf8');
    ok((srcIdx + srcTpl).indexOf('siteType') < 0, '无站点类型判定分支');
    ok(srcTpl.includes('OVERRIDE_KEYS') && srcTpl.includes('normalizeOverride'), 'override 走键白名单归一化');
    ok((srcIdx.match(/auditReq\(/g) || []).length >= 16, '新路由审计接线齐备');
    const tplFile = fs.readFileSync(path.join(TMP2, 'fp_templates.json'), 'utf8');
    ok(tplFile.indexOf('evilPayload') < 0 && tplFile.indexOf('password') < 0, '模板落盘无白名单外键 / 无敏感字段');
  } catch (e) {
    fail++;
    console.error('  ✘ 异常中断:', e.message);
    console.error(_childOut.join('').slice(-2500));
  } finally {
    try { child.kill(); } catch (e) {}
  }

  console.log('\n================ 汇总 ================');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
