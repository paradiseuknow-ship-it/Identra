'use strict';

// STEP 16 — CAP-B1：代理池健康度与自动轮换。
//
// 覆盖：
//   Part 1 模块级（纯逻辑，零网络）：
//     A) recordCheck：滑动窗口（20 上限）/ 连续成功失败计数 / lastCheck 兼容回写
//     B) healthOf / metricsOf：unchecked→healthy→degraded→dead 状态机 + 成功率/平均延迟
//     C) pickReplacement：同池限定 / 排除自身与死代理 / 健康度→成功率→延迟→id 确定性排序
//     D) chooseRotation：五种拒绝理由 + 轮换命中
//   Part 2 e2e（模式 B）：
//     E) pool 字段归一化 / 健康汇总端点 / PUT 无法伪造健康档案
//     F) 显式轮换（替换成功 / 未死不换 / 无替补不换）+ 授权（跨工作区 403、MEMBER 403）
//     G) 审计 proxy.rotate + 红线
// 用法：node server/scripts/test_step16_proxy_pool.js

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

// ============================================================================
// Part 1 — 模块级
// ============================================================================
const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-b1-unit-'));
process.env.FPB_DATA_DIR = TMP1;
const proxyPool = require('../proxyPool');

(async () => {
  section('A) recordCheck：滑动窗口与计数');
  const px = { id: 'px_t' };
  for (let i = 0; i < 25; i++) proxyPool.recordCheck(px, { ok: true, latencyMs: 100 + i });
  ok(px.health.history.length === proxyPool.HEALTH_WINDOW, 'history 窗口上限（' + px.health.history.length + '=' + proxyPool.HEALTH_WINDOW + '）');
  ok(px.health.consecutiveOk === 25 && px.health.consecutiveFails === 0, '连续成功计数');
  ok(px.lastCheck && px.lastCheck.ok === true && Number.isFinite(px.lastCheck.at), 'lastCheck 兼容回写');
  proxyPool.recordCheck(px, { ok: false, error: 'timeout' });
  ok(px.health.consecutiveFails === 1 && px.health.consecutiveOk === 0, '一次失败清零连续成功');
  ok(proxyPool.healthOf(px) === 'degraded', 'degraded（有失败未达阈值）');

  section('B) healthOf / metricsOf 状态机');
  const fresh = { id: 'px_f' };
  ok(proxyPool.healthOf(fresh) === 'unchecked', '无记录 → unchecked');
  for (let i = 0; i < proxyPool.DEAD_THRESHOLD; i++) proxyPool.recordCheck(fresh, { ok: false, error: 'e' });
  ok(proxyPool.healthOf(fresh) === 'dead', '连续失败达阈值 → dead');
  const mix = { id: 'px_m' };
  proxyPool.recordCheck(mix, { ok: true, latencyMs: 200 });
  proxyPool.recordCheck(mix, { ok: true, latencyMs: 400 });
  proxyPool.recordCheck(mix, { ok: false });
  const mm = proxyPool.metricsOf(mix);
  ok(mm.status === 'degraded' && mm.successRate === 0.67 && mm.avgLatencyMs === 300, '成功率 2/3、平均延迟 300（仅成功样本）');

  section('C) pickReplacement 同池确定性挑选');
  const mk = (id, pool, health) => ({ id, pool, ...(health ? { health } : {}) });
  const healthy = mk('px_h', 'us', { consecutiveFails: 0, consecutiveOk: 5, history: Array.from({ length: 5 }, (_, i) => ({ ok: true, latencyMs: 100 + i * 10, at: 1 })) });
  const unchecked = mk('px_u', 'us');
  const dead = mk('px_d', 'us', { consecutiveFails: 5, consecutiveOk: 0, history: Array.from({ length: 5 }, () => ({ ok: false, latencyMs: null, at: 1 })) });
  const otherPool = mk('px_o', 'eu');
  const poolList = [healthy, unchecked, dead, otherPool];
  ok(proxyPool.pickReplacement('us', 'px_x', poolList).id === 'px_h', '健康优先于 unchecked');
  ok(proxyPool.pickReplacement('us', 'px_h', poolList).id === 'px_u', '排除自身后给 unchecked');
  ok(proxyPool.pickReplacement('us', 'px_h', [dead, otherPool]) === null, '同池无可用替补 → null');
  ok(proxyPool.pickReplacement(null, 'px_x', poolList) === null, '无池不轮换（跨池禁止）');
  const h1 = mk('px_a', 'us', { consecutiveFails: 0, consecutiveOk: 2, history: [{ ok: true, latencyMs: 500, at: 1 }, { ok: true, latencyMs: 500, at: 1 }] });
  const h2 = mk('px_b', 'us', { consecutiveFails: 0, consecutiveOk: 2, history: [{ ok: true, latencyMs: 100, at: 1 }, { ok: true, latencyMs: 100, at: 1 }] });
  ok(proxyPool.pickReplacement('us', 'px_x', [h1, h2]).id === 'px_b', '同状态按平均延迟升序');
  ok(proxyPool.pickReplacement('us', 'px_x', []) === null, '空池 → null');

  section('D) chooseRotation 决策矩阵');
  const profileBase = { proxyMode: 'saved', proxyId: 'px_d' };
  ok(proxyPool.chooseRotation({ proxyMode: 'inline' }, poolList).reason === 'not-saved-proxy', '非保存代理 → 不换');
  ok(proxyPool.chooseRotation({ ...profileBase, proxyAutoRotate: false }, poolList).reason === 'auto-rotate-disabled', '未开自动轮换 → 不换');
  ok(proxyPool.chooseRotation({ ...profileBase, proxyAutoRotate: true, proxyId: 'px_missing' }, poolList).reason === 'current-not-found', '当前代理不存在 → 不换');
  ok(proxyPool.chooseRotation({ ...profileBase, proxyAutoRotate: true, proxyId: 'px_u' }, poolList).reason === 'current-not-dead', '当前未死 → 不换');
  const hit = proxyPool.chooseRotation({ ...profileBase, proxyAutoRotate: true }, poolList);
  ok(hit.rotate === true && hit.to.id === 'px_h' && hit.reason === 'current-dead', 'dead + 同池有健康 → 轮换命中');
  const deadPool = [mk('px_d2', 'us', dead.health)];
  ok(proxyPool.chooseRotation({ ...profileBase, proxyAutoRotate: true, proxyId: 'px_d2' }, deadPool).reason === 'no-healthy-alternative', '同池全死 → fail-open 不换');

  // ============================================================================
  // Part 2 — e2e（模式 B，生产入口子进程）
  // ============================================================================
  const PORT2 = 18799;
  const BASE = 'http://127.0.0.1:' + PORT2;
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-b1-e2e-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT2), FPB_BIND: '127.0.0.1', FPB_API_TOKEN: 'b1-machine-token', FPB_DATA_DIR: TMP2 },
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

    for (const [u, p] of [['alice7', 'alice7-pass-1'], ['bob7', 'bob7-pass-12'], ['charlie7', 'charlie7-pass']]) {
      await api('POST', '/api/auth/register', null, { username: u, password: p });
    }
    const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).json;
    const A = await login('alice7', 'alice7-pass-1');
    const B = await login('bob7', 'bob7-pass-12');
    const C = await login('charlie7', 'charlie7-pass');

    section('E) pool 归一化 / 健康汇总 / 防伪造');
    const pxA = await api('POST', '/api/proxies', A.token, { name: 'us-1', server: 'http://10.0.0.1:8080', pool: '  us-pool  ' });
    const pxB = await api('POST', '/api/proxies', A.token, { name: 'us-2', server: 'http://10.0.0.2:8080', pool: 'us-pool' });
    const pxC = await api('POST', '/api/proxies', A.token, { name: 'no-pool', server: 'http://10.0.0.3:8080' });
    ok(pxA.status === 200 && pxA.json.pool === 'us-pool', 'pool 归一化（trim）');
    const PX1 = pxA.json.id, PX2 = pxB.json.id, PX3 = pxC.json.id;
    const blankPool = await api('POST', '/api/proxies', A.token, { name: 'blank', server: 'http://10.0.0.4:8080', pool: '   ' });
    ok(blankPool.json.pool === null, '空白 pool → null');
    ok((await api('GET', '/api/proxies/health', A.token)).json.total === 4, '健康汇总覆盖可见集');
    const h0 = await api('GET', '/api/proxies/health', A.token);
    ok(h0.json.summary.unchecked === 4 && h0.json.items.every((x) => x.status === 'unchecked'), '初始全 unchecked');
    ok((await api('GET', '/api/proxies/health', B.token)).json.total === 0, '健康汇总跨工作区隔离');

    // 服务端事实注入：直接改子进程 store（模拟此前 check 留下的健康档案）
    const injectDead = () => {
      const f = path.join(TMP2, 'proxies.json');
      const list = JSON.parse(fs.readFileSync(f, 'utf8'));
      const t = list.find((x) => x.id === PX1);
      t.health = { consecutiveFails: 5, consecutiveOk: 0, updatedAt: Date.now(), history: Array.from({ length: 5 }, () => ({ ok: false, latencyMs: null, at: Date.now() })) };
      fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf8');
    };
    injectDead();
    const h1 = await api('GET', '/api/proxies/health', A.token);
    const deadRow = h1.json.items.find((x) => x.id === PX1);
    ok(deadRow && deadRow.status === 'dead' && deadRow.consecutiveFails === 5 && h1.json.summary.dead === 1, '注入死代理后汇总 dead=1');

    // PUT 不可伪造健康：对死代理伪造健康档案必须无效
    const forge = await api('PUT', '/api/proxies/' + PX1, A.token, { health: { consecutiveFails: 0, consecutiveOk: 9, history: [{ ok: true, latencyMs: 1, at: 1 }] }, lastCheck: { ok: true }, name: 'us-1' });
    ok(forge.status === 200, 'PUT 其他字段正常');
    const h2 = await api('GET', '/api/proxies/health', A.token);
    ok(h2.json.items.find((x) => x.id === PX1).status === 'dead', 'PUT 伪造健康档案被剥离（仍 dead）');

    section('F) 显式轮换与授权');
    const prof = await api('POST', '/api/profiles', A.token, { name: '轮换号', proxyMode: 'saved', proxyId: PX1, proxyAutoRotate: true });
    ok(prof.status === 200 && prof.json.proxyId === PX1, 'profile 绑定死代理 + autoRotate');
    const rot = await api('POST', '/api/proxies/rotate', A.token, { profileId: prof.json.id });
    ok(rot.status === 200 && rot.json.rotated === true && rot.json.to.id === PX2, '轮换命中同池健康替补 us-2');
    const profAfter = await api('GET', '/api/profiles/' + prof.json.id, A.token);
    ok(profAfter.json.proxyId === PX2, 'profile.proxyId 已切换');
    const rot2 = await api('POST', '/api/proxies/rotate', A.token, { profileId: prof.json.id });
    ok(rot2.json.rotated === false && rot2.json.reason === 'current-not-dead', '当前健康 → 不换');
    const prof3 = await api('POST', '/api/profiles', A.token, { name: '无替补号', proxyMode: 'saved', proxyId: PX1, proxyAutoRotate: false });
    const rot3 = await api('POST', '/api/proxies/rotate', A.token, { profileId: prof3.json.id });
    ok(rot3.json.rotated === false && rot3.json.reason === 'auto-rotate-disabled', '未开 autoRotate → 不换');
    const prof4 = await api('POST', '/api/profiles', A.token, { name: '跨池号', proxyMode: 'saved', proxyId: PX3, proxyAutoRotate: true });
    const rot4 = await api('POST', '/api/proxies/rotate', A.token, { profileId: prof4.json.id });
    ok(rot4.json.rotated === false, '无池代理 → 不换（跨池禁止）');
    ok((await api('POST', '/api/proxies/rotate', B.token, { profileId: prof.json.id })).status === 403, '跨工作区轮换 → 403');
    await api('POST', '/api/auth/workspaces/' + A.workspaceId + '/members', A.token, { username: 'charlie7', role: 'MEMBER' });
    ok((await api('POST', '/api/proxies/rotate', C.token, { profileId: prof.json.id })).status === 403, 'MEMBER 轮换 → 403（profile:manage）');
    ok((await api('GET', '/api/proxies/health', C.token)).status === 200, 'MEMBER 读健康汇总 → 200');
    ok((await api('POST', '/api/proxies/rotate', A.token, { profileId: 'p_missing' })).status === 404, 'profile 不存在 → 404');

    section('G) 审计 + 红线');
    const aud = await api('GET', '/api/auth/audit?action=proxy.rotate', A.token);
    ok(aud.status === 200 && aud.json.total === 1 && aud.json.entries[0].detail.to === PX2 && aud.json.entries[0].detail.from === PX1, 'proxy.rotate 审计含 from/to');
    const srcIdx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const srcPool = fs.readFileSync(path.join(__dirname, '..', 'proxyPool.js'), 'utf8');
    ok((srcIdx + srcPool).indexOf('siteType') < 0, '无站点类型判定分支');
    ok(srcIdx.includes("'lastCheck', 'health'"), 'PUT 剥离健康字段（防伪造）');
    ok(srcPool.includes('DEAD_THRESHOLD') && srcPool.includes('HEALTH_WINDOW'), '状态机阈值显式常量');
    ok(srcIdx.includes('proxy.auto_rotate'), '启动钩子自动轮换已接线（审计可追溯）');
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
