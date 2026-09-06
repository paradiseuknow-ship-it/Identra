'use strict';

// Phase 16-B §22 — Security / Leakage 扫描 harness（进 runRegression 自动发现）
// 扫描对象（当前阶段真实存在的泄漏面）：
//   LS1 identity 落盘文件字节（identityStore 写出的 identity.json）
//   LS2 buildIdentity 返回对象全键树
//   LS3 buildInjectionScript 注入脚本全文（页面实际执行的东西）
// 禁止模式：凭据/令牌/会话秘密的字段名与常见值形态。
// 纪律：只断言真实产物（落盘字节与求值字符串），不做 mock 拼接。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateFingerprint } = require('../fp/generate');
const F = require('../fp/identityFactory');
const identityStore = require('../fp/identityStore');
const { canonicalIdentityString } = require('../fp/identitySchema');
const { buildInjectionScript } = require('../fp/inject');

// 键名黑名单（与 identitySchema.FORBIDDEN_KEY_RE 对齐并加宽值形态）
const KEY_RE = /pass(word)?|secret|token|cookie|credential|authoriz|api[-_]?key|private[-_]?key|session[-_]?id/i;
// 值形态黑名单：Bearer 头 / PEM 私钥 / JWT / 长十六进制秘密串（>=48 hex，排除 noiseSeed 之外的整型）
const VAL_RE = /Bearer\s+[A-Za-z0-9._-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 200) : '')); console.log('  FAIL ' + name); }
}

function scanKeys(value, base, hits) {
  if (value === null || typeof value !== 'object') return hits;
  for (const k of Object.keys(value)) {
    const p = base ? base + '.' + k : k;
    if (KEY_RE.test(k)) hits.push('key:' + p);
    scanKeys(value[k], p, hits);
  }
  return hits;
}
function scanText(label, text) {
  const keyHit = text.match(new RegExp(KEY_RE.source, 'i'));
  const valHit = text.match(VAL_RE);
  return { keyHit: keyHit ? label + ':' + keyHit[0] : null, valHit: valHit ? label + ':' + valHit[0] : null };
}

const fp = generateFingerprint('leak::scan::seed1', { os: 'Windows', browser: 'Chrome' }, null);
const identity = F.buildIdentity('leak::scan::seed1', fp);

console.log('== LS1 identity.json 落盘字节 ==');
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp16b-leak-'));
  identityStore.writeIdentity('p_leak_scan', identity, { root: tmpRoot });
  const bytes = fs.readFileSync(identityStore.identityFilePath('p_leak_scan', tmpRoot), 'utf8');
  assert('LS1a 落盘内容 = canonical 序列化（无额外注入）', bytes === canonicalIdentityString(identity));
  const s1 = scanText('identity.json', bytes);
  assert('LS1b 落盘字节无秘密键名', !s1.keyHit, s1.keyHit);
  assert('LS1c 落盘字节无秘密值形态', !s1.valHit, s1.valHit);
  const leftovers = fs.readdirSync(path.dirname(identityStore.identityFilePath('p_leak_scan', tmpRoot)))
    .filter((f) => f !== 'identity.json');
  assert('LS1d 无 tmp 残留（原子写干净）', leftovers.length === 0, leftovers.join(','));
}

console.log('== LS2 buildIdentity 输出键树 ==');
{
  const hits = scanKeys(identity, '', []);
  assert('LS2 全键树无秘密键名', hits.length === 0, hits.join(','));
  const s2 = scanText('identity-object', JSON.stringify(identity));
  assert('LS2b 序列化后无秘密值形态', !s2.valHit, s2.valHit);
}

console.log('== LS3 注入脚本全文 ==');
{
  const script = buildInjectionScript(fp);
  // 键名黑名单对注入脚本放行 fonts/UA 等正常词（脚本属渲染面，不携带凭据）；
  // 值形态黑名单（Bearer/PEM/JWT）必须零命中。
  const valHit = script.match(VAL_RE);
  assert('LS3a 注入脚本无秘密值形态（Bearer/PEM/JWT）', !valHit, valHit && valHit[0]);
  assert('LS3b 注入脚本不含 identityId/seed 明文（identity 与注入面隔离）',
    script.indexOf(identity.identityId) === -1 && script.indexOf(identity.seed) === -1);
}

console.log('== LS4 browserManager 现行 launch args（只读扫描）==');
{
  const bmSrc = fs.readFileSync(path.join(__dirname, '..', 'browserManager.js'), 'utf8');
  const valHit = bmSrc.match(VAL_RE);
  assert('LS4a browserManager 源无秘密值形态', !valHit, valHit && valHit[0]);
  // launch args 不得包含明文凭据类 flag 值
  const credArg = bmSrc.match(/['"]--\w*(password|token|secret|cookie)[\w-]*=[^'"]+['"]/i);
  assert('LS4b launch args 无 --*=凭据 形态', !credArg, credArg && credArg[0]);
}

console.log('');
console.log('RESULT pass=' + pass + ' fail=' + fail);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
