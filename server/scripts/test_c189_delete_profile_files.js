'use strict';

// C189 守护：「删除环境时可选是否删除本地数据文件」+「清理残留环境目录」。
//
// 用户 2026-10-22：① 需要清理磁盘上堆积的环境目录；② 以后删除环境要有「是否删除文件」的选项。
// 真实数据：data/profiles 下曾有 1181 个目录不在库内、约 16 GB / 25 万文件 —— 因为历史上的
// 单条删除与批量删除都只删库记录（profiles.json），不删 <dataRoot>/profiles/<id>。
// 库记录一旦消失，这些目录就再无 UI 入口，只能手工清盘。
//
// 本守护钉住的是**行为**（真实 HTTP + 真实 fs，非源码文本）：
//   A 单条删除：缺省＝保留目录（旧行为）；deleteFiles:true ⇒ 目录真删；非严格 true ⇒ 不删；
//   B 批量删除：confirm 令牌缺失 ⇒ 400 且零删除；deleteFiles:true ⇒ filesRemoved 与目录同步消失；
//   C 残留清理：清点口径＝「盘上目录 − 库内 id」；缺 confirm ⇒ 400 零删除；清理时**绝不**碰库内环境；
//   D 严格性：deleteFiles 只接受布尔 true（字符串 'yes' / 1 一律不放行删除面）；
//   E 幂等：删过的 id 再删 ⇒ 404，不 500。
//
// 运行：node server/scripts/test_c187_delete_profile_files.js

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 23120 + (process.pid % 40);
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(os.tmpdir(), 'c187_delete_files_' + Date.now());
const PROOT = path.join(DATA, 'profiles');

let pass = 0;
let fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + ' :: ' + (detail === undefined ? '' : String(detail).slice(0, 200))); console.log('  FAIL  ' + name + ' :: ' + (detail === undefined ? '' : String(detail).slice(0, 200))); }
}
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got)); }
function section(t) { console.log('\n' + t); }

function req(method, p, body, token) {
  return new Promise((resolve) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    // C189 夹具缺陷修复：不带 body 的方法必须显式补 Content-Length。
    // 本机 node 的 http client 在 DELETE 上不写 `Transfer-Encoding: chunked`，于是 r.write()
    // 的字节**从未上线**（实测：服务端收到 METHOD=DELETE / TE=undefined / CL=undefined / BODY 空），
    // 表现为「服务端读不到 req.body」+ 偶发 ECONNRESET（服务端先响应、客户端还在写）。
    // 浏览器 fetch 会自动带 Content-Length，故这是**夹具缺陷**而非产品缺陷。
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request('http://127.0.0.1:' + PORT + p, { method, timeout: 20000, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}
const j = (r) => { try { return JSON.parse(r.body); } catch (e) { return null; } };

function bootServer() {
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      FPB_DATA_DIR: DATA,
      FPB_VAULT_FILE: path.join(DATA, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(DATA, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 12).toString('base64'),
      DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const r = await req('GET', '/api/auth/me');
    if (r.code === 200 || r.code === 401) return true;
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

// 造一个「环境数据目录」：埋入与真实 Chrome profile 同构的子目录 + 文件，
// 这样「目录存在/消失」就是可判定的，而不是只看一个空目录名。
function seedProfileDir(id) {
  const base = path.join(PROOT, id);
  fs.mkdirSync(path.join(base, 'Default', 'Cache'), { recursive: true });
  fs.mkdirSync(path.join(base, 'Default', 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(path.join(base, 'Default', 'Cookies'), 'cookie-db-' + id);
  fs.writeFileSync(path.join(base, 'Default', 'Cache', 'data_0'), 'cache-' + id);
  fs.writeFileSync(path.join(base, 'Default', 'Local Storage', 'leveldb', '000001.log'), 'ls-' + id);
  fs.writeFileSync(path.join(base, 'Local State'), '{"profile":"' + id + '"}');
  return base;
}
const dirExists = (id) => fs.existsSync(path.join(PROOT, id));

async function createProfile(name) {
  const r = j(await req('POST', '/api/profiles', { name }));
  return r && r.id ? r.id : null;
}

async function main() {
  fs.mkdirSync(PROOT, { recursive: true });
  const srv = bootServer();
  let srvErr = '';
  srv.stderr.on('data', (c) => { srvErr += c.toString(); });

  const ready = await waitReady();
  chk('P0 隔离实例就绪（FPB_DATA_DIR 全隔离，不动产品 data/）', ready, srvErr.slice(-200));
  if (!ready) { try { srv.kill(); } catch (e) {} process.exit(1); }

  try {
    // ------------------------------------------------------------ A 单条删除
    section('A 单条删除的「是否删文件」');
    const a1 = await createProfile('c187-a1');
    const a2 = await createProfile('c187-a2');
    const a3 = await createProfile('c187-a3');
    const a4 = await createProfile('c187-a4');
    chk('A0 建立 4 个环境', !!(a1 && a2 && a3 && a4), [a1, a2, a3, a4].join(','));
    [a1, a2, a3, a4].forEach(seedProfileDir);
    chk('A0 四个环境目录都已落盘', [a1, a2, a3, a4].every(dirExists));

    // A1：缺省（不带 body）⇒ 与旧行为一致：只删库记录，盘上目录保留
    let r = await req('DELETE', '/api/profiles/' + a1);
    let b = j(r);
    eq('A1 缺省删除 → 200 ok', [r.code, b && b.ok], [200, true]);
    eq('A1 缺省 deleteFiles=false', b && b.deleteFiles, false);
    chk('A1 缺省时本地目录**保留**（旧行为不变）', dirExists(a1));
    chk('A1 库内记录已消失', !(j(await req('GET', '/api/profiles')) || []).some((p) => p.id === a1));

    // A2：显式 true ⇒ 目录真删（含子目录与文件）
    r = await req('DELETE', '/api/profiles/' + a2, { deleteFiles: true });
    b = j(r);
    eq('A2 deleteFiles:true → 200 ok', [r.code, b && b.ok], [200, true]);
    eq('A2 回传 deleteFiles=true', b && b.deleteFiles, true);
    chk('A2 本地目录已删除', !dirExists(a2));

    // A3：显式 false ⇒ 与缺省同口径
    r = await req('DELETE', '/api/profiles/' + a3, { deleteFiles: false });
    eq('A3 deleteFiles:false → 200', r.code, 200);
    chk('A3 本地目录保留', dirExists(a3));

    // A4：严格性 —— 只有布尔 true 才打开删除面
    r = await req('DELETE', '/api/profiles/' + a4, { deleteFiles: 'yes' });
    eq('A4 deleteFiles:"yes" → 200（不报错）', r.code, 200);
    eq('A4 字符串不视为 true', (j(r) || {}).deleteFiles, false);
    chk('A4 字符串 "yes" 时本地目录保留（不放宽删除面）', dirExists(a4));

    // A5：幂等 —— 已删除的 id 再删是 404，不是 500
    r = await req('DELETE', '/api/profiles/' + a2, { deleteFiles: true });
    eq('A5 重复删除 → 404', r.code, 404);

    // ------------------------------------------------------------ B 批量删除
    section('B 批量删除的「是否删文件」');
    const b1 = await createProfile('c187-b1');
    const b2 = await createProfile('c187-b2');
    [b1, b2].forEach(seedProfileDir);
    chk('B0 两个环境目录已落盘', dirExists(b1) && dirExists(b2));

    // B1：无 confirm ⇒ 400 且零删除（目录与记录都必须在）
    r = await req('DELETE', '/api/profiles', { deleteFiles: true });
    b = j(r);
    eq('B1 缺 confirm → 400', [r.code, b && b.error], [400, 'CONFIRM_REQUIRED']);
    chk('B1 令牌缺失时目录零删除', dirExists(b1) && dirExists(b2));

    // B2：confirm 但 deleteFiles 缺省 ⇒ 只删记录
    r = await req('DELETE', '/api/profiles', { confirm: 'DELETE_ALL' });
    b = j(r);
    eq('B2 批量删除 → 200', [r.code, b && b.ok], [200, true]);
    eq('B2 filesRemoved=0（未勾选清盘）', b && b.filesRemoved, 0);
    chk('B2 未勾选时目录保留', dirExists(b1) && dirExists(b2));

    // B3：confirm + deleteFiles:true ⇒ filesRemoved 与目录同步消失
    const b3 = await createProfile('c187-b3');
    const b4 = await createProfile('c187-b4');
    [b3, b4].forEach(seedProfileDir);
    r = await req('DELETE', '/api/profiles', { confirm: 'DELETE_ALL', deleteFiles: true });
    b = j(r);
    eq('B3 批量删除(清盘) → 200', [r.code, b && b.ok], [200, true]);
    eq('B3 filesRemoved=2', b && b.filesRemoved, 2);
    chk('B3 两个目录都已删除', !dirExists(b3) && !dirExists(b4));
    const leftAfterB = fs.readdirSync(PROOT);
    chk('B3 b3/b4 已不在 profiles 根下', leftAfterB.indexOf(b3) < 0 && leftAfterB.indexOf(b4) < 0, JSON.stringify(leftAfterB));

    // ------------------------------------------------------------ C 残留清理
    section('C 残留环境目录的清点与清理');

    // C0：A 段里「只删记录、保留文件」的三个环境，此刻正是孤儿 —— 这条因果链就是
    //     历史上 1181 个目录 / 16 GB 残留的成因，因此必须由清点口径显式识别出来。
    let ro = j(await req('GET', '/api/profiles/orphans'));
    const keptDirs = [a1, a3, a4, b1, b2]; // A1/A3/A4 单条保留 + B2 批量保留
    chk('C0 「保留文件」的已删环境全部被识别为孤儿',
      !!ro && keptDirs.every((id) => ro.ids.indexOf(id) >= 0), JSON.stringify(ro && ro.ids));
    eq('C0 孤儿数=5（A 段 3 个 + B 段 2 个保留目录）', ro && ro.orphanCount, 5);
    const c0 = j(await req('DELETE', '/api/profiles/orphans', { confirm: 'PURGE_ORPHANS' }));
    eq('C0 清掉后 removed=5', c0 && c0.removed, 5);
    eq('C0 清空后孤儿数=0', (j(await req('GET', '/api/profiles/orphans')) || {}).orphanCount, 0);

    const keep = await createProfile('c187-keep');
    seedProfileDir(keep);
    const o1 = 'p_c187orphan_aaa1';
    const o2 = 'p_c187orphan_bbb2';
    seedProfileDir(o1);
    seedProfileDir(o2);

    r = await req('GET', '/api/profiles/orphans');
    b = j(r);
    eq('C1 清点 → 200', [r.code, b && b.ok], [200, true]);
    eq('C1 孤儿数=2（只算盘上有、库里没有的）', b && b.orphanCount, 2);
    chk('C1 列出两个孤儿 id', !!b && b.ids.indexOf(o1) >= 0 && b.ids.indexOf(o2) >= 0, JSON.stringify(b && b.ids));
    chk('C1 库内环境**不**被算作孤儿', !!b && b.ids.indexOf(keep) < 0, JSON.stringify(b && b.ids));

    // C2：缺 confirm ⇒ 400 且零删除
    r = await req('DELETE', '/api/profiles/orphans', {});
    b = j(r);
    eq('C2 缺 confirm → 400', [r.code, b && b.error], [400, 'CONFIRM_REQUIRED']);
    chk('C2 令牌缺失时孤儿目录仍在', dirExists(o1) && dirExists(o2));
    chk('C2 令牌缺失时库内环境目录也仍在', dirExists(keep));

    // C3：正确令牌 ⇒ 孤儿消失，库内环境毫发无伤
    r = await req('DELETE', '/api/profiles/orphans', { confirm: 'PURGE_ORPHANS' });
    b = j(r);
    eq('C3 清理 → 200', [r.code, b && b.ok], [200, true]);
    eq('C3 removed=2', b && b.removed, 2);
    chk('C3 孤儿目录已删除', !dirExists(o1) && !dirExists(o2));
    chk('C3 库内环境目录**未被误删**（关键安全面）', dirExists(keep));
    chk('C3 库内环境记录仍在', (j(await req('GET', '/api/profiles')) || []).some((p) => p.id === keep));

    // C4：再清一次 ⇒ 0 个（幂等，不报错）
    r = await req('DELETE', '/api/profiles/orphans', { confirm: 'PURGE_ORPHANS' });
    b = j(r);
    eq('C4 空集合清理 → 200 removed=0', [r.code, b && b.removed], [200, 0]);
    chk('C4 幂等后库内环境目录仍在', dirExists(keep));
  } finally {
    try { srv.kill(); } catch (e) { /* 已退出 */ }
  }

  // 清理夹具（本测试自建的 tmp 数据根，非产品数据）
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* tmp 尽力而为 */ }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'HAS FAILURE') + '  pass=' + pass + ' fail=' + fail);
  if (fail) console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(fail === 0 ? 0 : 1);
}

// readdir 辅助：判断某项是不是目录（readdir 默认返回名字，这里兼容两种形态）
function fd(name) { return name; }


main().catch((e) => {
  console.error('FATAL', e);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
