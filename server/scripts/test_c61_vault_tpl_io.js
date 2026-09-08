'use strict';
// C61 守护测试 —— vault.js 读路径硬化 + 卡局部更新合并 + fpTemplates.js I/O 硬化
// （tmp 隔离、零浏览器、零网络、纯模块；vault/fpTemplates 的文件路径在模块加载时定死，
//  因此本测试在 require 前设置 FPB_VAULT_FILE / FPB_DATA_DIR 完成单进程隔离）。
// 缺陷背景（老模块 vault/fpTemplates 首轮深扫——C60 jsonStore 同族缺陷，vault 自持
// 读写不走 jsonStore，C60 加固没有覆盖到）：
//   D1 (A类/数据丢失) vault readAll 的 catch 把瞬时文件锁（EPERM/EBUSY/EACCES——正是
//      writeAll 自己在重试加固的同一故障面）与「文件损坏」混为一谈静默返回 {}，
//      而 setProfileSecrets/deleteProfileSecrets 全是 read-modify-write → 一次瞬时锁后
//      下一次写把整个 vault 覆写成 {}（全部凭据密文静默蒸发）。
//   D2 (A类/数据丢失) fpTemplates saveTemplates 裸 writeFileSync + getTemplates 损坏/锁
//      静默 []，index.js 读改写 → 模板库整体静默清空（同族）。
//   D3 (B类) vault setProfileSecrets 注释承诺「局部更新：合并已有密文」，实际 card
//      浅合并整卡替换 → 局部卡更新把 sibling 字段密文全部置 null。
//   D4 (B类) 真损坏 JSON 时旧文件被静默丢弃后覆写 → 侧车 .corrupt-<ts> 保全（C60 先例）。
// 覆盖：
//   P0 基线：vault 写读 roundtrip + 脱敏视图不回明文
//   P1 D1 最强实证：读时瞬时 EBUSY（前 2 次抛错后放行）→ setProfileSecrets 不清空老凭据
//   P2 D1 fail-loud：持续 EBUSY → 抛出且磁盘 vault 原样未覆写
//   P3 D4 损坏 vault 侧车保全：corrupt JSON → .corrupt-<ts> 侧车保留原始字节
//   P4 D3 card 局部更新：只改 expMonth → sibling 密文保留；null = 显式清除
//   P5 写路径卫生：正常操作后无 .tmp 残留
//   P6 fpTemplates 基线：createTemplate 校验 + roundtrip + mergeTemplateIntoInput 语义
//   P7 D2 最强实证：读时瞬时 EBUSY → saveTemplates(getTemplates().concat) 不清空模板库
//   P8 D2 fail-loud：持续 EBUSY → getTemplates 抛出、磁盘原样
//   P9 D4/D2 损坏模板库侧车保全 + 原子写无 .tmp 残留

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + JSON.stringify(detail)); }
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// ---------- 子进程阶段脚本（vault / fpTemplates 各一个 child，env 隔离） ----------
const CHILD_SCRIPT = `
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('FAIL ' + name + ' :: ' + JSON.stringify(detail)); }
}
const which = process.env.C61_PHASE;
const realReadFileSync = fs.readFileSync;
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

if (which === 'vault') {
  const vault = require(path.join(process.env.FPB_ROOT, 'server', 'vault.js'));
  const VFILE = process.env.FPB_VAULT_FILE;

  // ---- P0 基线 ----
  vault.setProfileSecrets('p1', { email: 'a@b.com', password: 'secret1', card: { number: '4111111111111111', expMonth: '12', expYear: '2030', cvv: '123', name: 'T' } });
  const back = vault.getProfileSecrets('p1');
  chk('P0.roundtrip', back.email === 'a@b.com' && back.password === 'secret1' && back.card.number === '4111111111111111' && back.card.cvv === '123', back);
  const masked = vault.getMaskedSummary('p1');
  const raw = readJson(VFILE);
  chk('P0.masked-no-plaintext', masked.hasEmail && masked.card && masked.card.numberMasked === '****1111' && !JSON.stringify(raw).includes('4111111111111111') && !JSON.stringify(raw).includes('a@b.com'), 'vault file stores ciphertext only');
  chk('P0.on-disk-encrypted', typeof raw.p1.email === 'string' && raw.p1.email !== 'a@b.com', 'email ciphertext on disk');
  vault.setProfileSecrets('p2', { email: 'c@d.com' });
  vault.setProfileSecrets('p3', { email: 'e@f.com' });

  // ---- P1 D1 最强实证：瞬时读锁 → 不清空 ----
  let calls = 0;
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === String(VFILE) && calls < 2) { calls++; const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    vault.setProfileSecrets('p4', { email: 'g@h.com' }); // 修复后：重试两次后成功
  } finally { fs.readFileSync = realReadFileSync; }
  const disk1 = readJson(VFILE);
  chk('P1.transient-lock-no-wipe', disk1.p1 && disk1.p2 && disk1.p3 && disk1.p4 && disk1.p1.email !== undefined, 'transient lock must NOT wipe vault (got keys: ' + Object.keys(disk1).join(',') + ')');
  chk('P1.retried', calls === 2, 'should retry exactly 2 transient failures, got ' + calls);

  // ---- P2 D1 fail-loud：持续读锁 → 抛出且磁盘原样 ----
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === String(VFILE)) { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
    return realReadFileSync.call(fs, p, ...rest);
  };
  let threw = null;
  try { vault.setProfileSecrets('p5', { email: 'x@y.com' }); } catch (e) { threw = e; }
  finally { fs.readFileSync = realReadFileSync; }
  chk('P2.read-throws', threw && threw.code === 'EBUSY', 'persistent lock must throw (fail-loud), got: ' + (threw && threw.code));
  const disk2 = readJson(VFILE);
  chk('P2.disk-untouched', disk2.p1 && disk2.p2 && disk2.p3 && disk2.p4 && !disk2.p5, 'failed write must NOT overwrite vault with {}');
  chk('P2.data-recoverable', vault.getProfileSecrets('p1').email === 'a@b.com', 'after unlock, old credentials intact');

  // ---- P3 D4 损坏 vault 侧车保全 ----
  fs.writeFileSync(VFILE, '{{corrupt-vault', 'utf8');
  chk('P3.corrupt-fallback', vault.getProfileSecrets('p1') === null, 'real corruption returns null profile (fresh vault contract)');
  const sidecars = fs.readdirSync(path.dirname(VFILE)).filter((n) => n.startsWith('vault.json.corrupt-'));
  chk('P3.sidecar-preserved', sidecars.length === 1 && fs.readFileSync(path.join(path.dirname(VFILE), sidecars[0]), 'utf8') === '{{corrupt-vault', 'corrupt vault must be sidecar-preserved, not silently discarded');
  chk('P3.fresh-start', (() => { vault.setProfileSecrets('new', { email: 'n@n.com' }); return vault.getProfileSecrets('new').email === 'n@n.com'; })(), 'vault continues from empty after sidecar');

  // ---- P4 D3 card 局部更新 ----
  vault.setProfileSecrets('pc', { card: { number: '4222222222222222', expMonth: '01', expYear: '2029', cvv: '999', name: 'ORIG' } });
  vault.setProfileSecrets('pc', { card: { expMonth: '11' } }); // 只改 expMonth
  const pc = vault.getProfileSecrets('pc').card;
  chk('P4.partial-card-merge', pc.number === '4222222222222222' && pc.expMonth === '11' && pc.expYear === '2029' && pc.cvv === '999' && pc.name === 'ORIG', 'partial card update must preserve sibling ciphertext (got: ' + JSON.stringify(pc) + ')');
  vault.setProfileSecrets('pc', { card: { name: null } }); // null = 显式清除
  const pc2 = vault.getProfileSecrets('pc').card;
  chk('P4.null-clears-single-field', pc2.name === null && pc2.number === '4222222222222222' && pc2.cvv === '999', 'explicit null clears only that field');

  // ---- P5 写路径卫生 ----
  vault.setProfileSecrets('p9', { email: 'z@z.com' });
  const tmpLeft = fs.readdirSync(path.dirname(VFILE)).filter((n) => n.endsWith('.tmp'));
  chk('P5.no-tmp-leftover', tmpLeft.length === 0, 'no .tmp residue after normal writes (got: ' + tmpLeft.join(',') + ')');
}

if (which === 'tpl') {
  const fpTemplates = require(path.join(process.env.FPB_ROOT, 'server', 'fpTemplates.js'));
  const TPL_FILE = fpTemplates.TPL_FILE;

  // ---- P6 基线 ----
  let e400 = null;
  try { fpTemplates.createTemplate({ name: 'bad', fingerprintOverride: { timezone: 'Not/AZone' } }); } catch (e) { e400 = e; }
  chk('P6.bad-tz-rejected', e400 && e400.status === 400, 'invalid IANA tz must 400, got: ' + (e400 && e400.status));
  const tpl = fpTemplates.createTemplate({ name: 'win-chrome', os: 'windows', browser: 'chrome', fingerprintOverride: { timezone: 'America/New_York', language: 'en-US' } });
  fpTemplates.saveTemplates(fpTemplates.getTemplates().concat(tpl));
  const tpl2 = fpTemplates.createTemplate({ name: 'mac-chrome', os: 'mac', browser: 'chrome', fingerprintOverride: {} });
  fpTemplates.saveTemplates(fpTemplates.getTemplates().concat(tpl2));
  const names = fpTemplates.getTemplates().map((t) => t.name).sort();
  chk('P6.roundtrip', JSON.stringify(names) === JSON.stringify(['mac-chrome', 'win-chrome']), 'template library roundtrip (got: ' + JSON.stringify(names) + ')');
  const merged = fpTemplates.mergeTemplateIntoInput({ fingerprintOverride: { timezone: 'Asia/Tokyo' } }, fpTemplates.getTemplates()[0]);
  chk('P6.merge-semantics', merged.os === fpTemplates.getTemplates()[0].os && merged.fingerprintOverride.timezone === 'Asia/Tokyo' && merged.fingerprintOverride.language === 'en-US', 'input overrides template, template fills gaps');

  // ---- P7 D2 最强实证：瞬时读锁 → 模板库不清空 ----
  let calls = 0;
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === String(TPL_FILE) && calls < 2) { calls++; const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    const tpl3 = fpTemplates.createTemplate({ name: 'linux-chrome', os: 'linux', browser: 'chrome', fingerprintOverride: {} });
    fpTemplates.saveTemplates(fpTemplates.getTemplates().concat(tpl3)); // 修复后：重试两次后成功
  } finally { fs.readFileSync = realReadFileSync; }
  const afterNames = fpTemplates.getTemplates().map((t) => t.name).sort();
  chk('P7.transient-lock-no-wipe', JSON.stringify(afterNames) === JSON.stringify(['linux-chrome', 'mac-chrome', 'win-chrome']), 'transient lock must NOT wipe template library (got: ' + JSON.stringify(afterNames) + ')');
  chk('P7.retried', calls === 2, 'should retry exactly 2 transient failures, got ' + calls);

  // ---- P8 D2 fail-loud：持续读锁 → 抛出、磁盘原样 ----
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === String(TPL_FILE)) { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
    return realReadFileSync.call(fs, p, ...rest);
  };
  let threw = null;
  try { fpTemplates.saveTemplates(fpTemplates.getTemplates().concat(tpl)); } catch (e) { threw = e; }
  finally { fs.readFileSync = realReadFileSync; }
  chk('P8.getTemplates-throws', threw && threw.code === 'EBUSY', 'persistent lock must throw (fail-loud), got: ' + (threw && threw.code));
  chk('P8.disk-untouched', fpTemplates.getTemplates().length === 3, 'failed RMW must NOT overwrite library with []');

  // ---- P9 D4 损坏侧车 + 原子写卫生 ----
  fs.writeFileSync(TPL_FILE, ']]corrupt-templates', 'utf8');
  chk('P9.corrupt-fallback', JSON.stringify(fpTemplates.getTemplates()) === '[]', 'real corruption returns [] (fresh contract)');
  const sidecars = fs.readdirSync(path.dirname(TPL_FILE)).filter((n) => n.startsWith('fp_templates.json.corrupt-'));
  chk('P9.sidecar-preserved', sidecars.length === 1 && fs.readFileSync(path.join(path.dirname(TPL_FILE), sidecars[0]), 'utf8') === ']]corrupt-templates', 'corrupt template file must be sidecar-preserved');
  fpTemplates.saveTemplates(fpTemplates.getTemplates().concat(tpl));
  chk('P9.recovers', fpTemplates.getTemplates().length === 1 && fpTemplates.getTemplates()[0].name === 'win-chrome', 'library rebuilds after sidecar');
  const tmpLeft = fs.readdirSync(path.dirname(TPL_FILE)).filter((n) => n.endsWith('.tmp'));
  chk('P9.no-tmp-leftover', tmpLeft.length === 0, 'no .tmp residue after atomic writes (got: ' + tmpLeft.join(',') + ')');
}

console.log('CHILD_RESULT ' + pass + ' ' + fail);
if (fail > 0) { failures.forEach((f) => console.log('CHILD_FAILED ' + f)); process.exit(1); }
`;

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c61-'));

  const runPhase = (phase, extraEnv) => {
    const r = spawnSync(NODE, ['-e', CHILD_SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        C61_PHASE: phase,
        FPB_ROOT: ROOT,
        FPB_VAULT_FILE: path.join(tmpRoot, 'vault.json'),
        FPB_DATA_DIR: path.join(tmpRoot, 'data'),
        FPB_ALLOW_EPHEMERAL_KEY: '1',
        ...extraEnv,
      },
      timeout: 120000,
    });
    if (r.error) throw r.error;
    const out = (r.stdout || '') + (r.stderr || '');
    process.stdout.write(out);
    const m = (r.stdout || '').match(/CHILD_RESULT (\d+) (\d+)/);
    if (!m) throw new Error('child [' + phase + '] produced no CHILD_RESULT (exit=' + r.status + ')');
    return { pass: Number(m[1]), fail: Number(m[2]) };
  };

  try {
    // vault 阶段 + fpTemplates 阶段（各自独立 child，env 隔离互不污染）
    for (const phase of ['vault', 'tpl']) {
      const r = runPhase(phase);
      pass += r.pass; fail += r.fail;
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* tmp 清理尽力而为 */ }
  }

  console.log('\n===== C61 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (fail > 0) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
