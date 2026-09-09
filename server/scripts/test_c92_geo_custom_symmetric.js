'use strict';
// C92 守护测试 —— custom geolocation 非对称校验缺陷（generate.js + ProfileEditor 渲染崩溃链）。
// 缺陷背景（本批次修复）：
//   server/fp/generate.js custom 分支原只校验 lat（typeof number），lng 不校验 ——
//   ProfileEditor 地理位置选 custom、填了纬度还没填经度（自然中途输入态；清空字段=parseFloat('')=NaN）时：
//     ① fp.geolocation.lng = undefined 直通 preview → ProfileEditor 预览行 `undefined.toFixed(2)`
//        TypeError → 编辑器整页渲染崩溃（ErrorBoundary 兜底错误卡，编辑器不可用）；
//     ② 保存后 launch：inject.js getCurrentPosition longitude: undefined → 坐标伪装静默失效；
//     ③ NaN 透传到 UI 与注入层。
//   修复：custom 分支对称 Number.isFinite(lat) && Number.isFinite(lng)；坐标不成形 → 回退 random
//   并把 mode 如实改标 'random'（对齐 ip 回退既有改标语义）。客户端 ProfileEditor 预览行改用
//   ui/kit fmtGeo 共享原语（逐字段兜底，对抗性指纹形状绝不崩渲染）。
// 本测试三层（零浏览器、tmp 隔离、AI_PROVIDER=mock）：
//   P1（行为杀手，真实模块实跑）：直接 require server/fp/generate.js generateFingerprint ——
//      lat-only / lng=NaN 两种 killer 输入修复前必产出 lng=undefined / NaN，修复后指纹形状永远完整；
//      语义保留断言（both-valid 精确保真 / block / 纯 random 回归）。
//   P2（fmtGeo 单元）：从 client/src/ui/kit.jsx 实际源码剥注释提取 fmtGeo 函数体 new Function 实跑
//      （测的是发货代码，不是副本）—— null / 缺 lat / NaN / 正常值四态零抛零泄漏。
//   P3（结构锚点）：ProfileEditor 地理位置行消费 fmtGeo 且该文件无裸 geolocation .toFixed；
//      kit.jsx 导出 fmtGeo；generate.js custom 分支含对称 Number.isFinite。

process.env.AI_PROVIDER = 'mock';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

(async () => {
  // ================= P1：行为杀手（真实 generateFingerprint 实跑） =================
  const { generateFingerprint } = require(path.join(ROOT, 'server', 'fp', 'generate.js'));

  // -- P1a killer：custom + lat 有效的中途输入态（lng 缺失）--
  let fp;
  try {
    fp = generateFingerprint('c92-killer-lat-only', { os: 'Windows', geolocation: { mode: 'custom', lat: 34.05 } });
    chk('P1a.custom-lat-only.fingerprint-shape-complete',
      Number.isFinite(fp.geolocation.lat) && Number.isFinite(fp.geolocation.lng),
      'fp.geolocation=' + JSON.stringify(fp.geolocation));
    chk('P1a.custom-lat-only.mode-relabel-random',
      fp.geolocation.mode === 'random',
      'mode=' + fp.geolocation.mode + '（不成形 custom 必须如实改标 random，不得虚标 custom）');
  } catch (e) {
    chk('P1a.custom-lat-only.fingerprint-shape-complete', false, 'threw: ' + e.message);
    chk('P1a.custom-lat-only.mode-relabel-random', false, 'threw: ' + e.message);
  }

  // -- P1b killer：custom + 清空字段（parseFloat('')=NaN）--
  try {
    fp = generateFingerprint('c92-killer-nan-lng', { os: 'Windows', geolocation: { mode: 'custom', lat: 34.05, lng: NaN } });
    chk('P1b.custom-nan-lng.no-nan-passthrough',
      Number.isFinite(fp.geolocation.lat) && Number.isFinite(fp.geolocation.lng),
      'fp.geolocation=' + JSON.stringify(fp.geolocation));
    chk('P1b.custom-nan-lng.mode-relabel-random', fp.geolocation.mode === 'random', 'mode=' + fp.geolocation.mode);
  } catch (e) {
    chk('P1b.custom-nan-lng.no-nan-passthrough', false, 'threw: ' + e.message);
    chk('P1b.custom-nan-lng.mode-relabel-random', false, 'threw: ' + e.message);
  }

  // -- P1c 语义保留：custom 双值有效 → 精确保真（含 accuracy 默认与显式）--
  try {
    fp = generateFingerprint('c92-sem-both-valid', { os: 'Windows', geolocation: { mode: 'custom', lat: 34.05, lng: -118.24 } });
    chk('P1c.custom-both-valid.exact-preserve',
      fp.geolocation.mode === 'custom' && fp.geolocation.lat === 34.05 && fp.geolocation.lng === -118.24 && fp.geolocation.accuracy === 100,
      'fp.geolocation=' + JSON.stringify(fp.geolocation));
    fp = generateFingerprint('c92-sem-accuracy', { os: 'Windows', geolocation: { mode: 'custom', lat: 1.5, lng: 2.5, accuracy: 42 } });
    chk('P1c.custom-explicit-accuracy-preserve', fp.geolocation.accuracy === 42, 'accuracy=' + fp.geolocation.accuracy);
  } catch (e) {
    chk('P1c.custom-both-valid.exact-preserve', false, 'threw: ' + e.message);
    chk('P1c.custom-explicit-accuracy-preserve', false, 'threw: ' + e.message);
  }

  // -- P1d 既有语义回归：custom 无坐标 / block / 默认 random --
  try {
    fp = generateFingerprint('c92-reg-empty-custom', { os: 'Windows', geolocation: { mode: 'custom' } });
    chk('P1d.empty-custom.random-fallback-finite',
      fp.geolocation.mode === 'random' && Number.isFinite(fp.geolocation.lat) && Number.isFinite(fp.geolocation.lng),
      'fp.geolocation=' + JSON.stringify(fp.geolocation));
    fp = generateFingerprint('c92-reg-block', { os: 'Windows', geolocation: { mode: 'block' } });
    chk('P1d.block.mode-and-zeros-unchanged',
      fp.geolocation.mode === 'block' && fp.geolocation.lat === 0 && fp.geolocation.lng === 0,
      'fp.geolocation=' + JSON.stringify(fp.geolocation));
    fp = generateFingerprint('c92-reg-default-random', { os: 'Windows' });
    chk('P1d.default-random.finite',
      fp.geolocation.mode === 'random' && Number.isFinite(fp.geolocation.lat) && Number.isFinite(fp.geolocation.lng),
      'fp.geolocation=' + JSON.stringify(fp.geolocation));
  } catch (e) {
    chk('P1d.regression-trio', false, 'threw: ' + e.message);
  }

  // ================= P2：fmtGeo 单元（实际源码提取实跑） =================
  const kit = stripComments(read('client/src/ui/kit.jsx'));
  const m = kit.match(/export function fmtGeo\(geo\) \{[\s\S]*?\n\}/);
  chk('P2.fmtGeo.extracted-from-source', !!m, 'fmtGeo 必须存在于 client/src/ui/kit.jsx');
  if (m) {
    // 剥 export 前缀 → 纯函数定义 → new Function 实跑（模板内无反斜杠/backtick）
    const fnSrc = m[0].replace('export function fmtGeo', 'function fmtGeo');
    let fmtGeo = null;
    try { fmtGeo = new Function(fnSrc + '; return fmtGeo;')(); }
    catch (e) { chk('P2.fmtGeo.evaluable', false, e.message); }
    if (fmtGeo) {
      let out;
      try {
        out = fmtGeo(null); chk('P2.fmtGeo.null-safe', out === '—', 'got: ' + out);
        out = fmtGeo(undefined); chk('P2.fmtGeo.undefined-safe', out === '—', 'got: ' + out);
        out = fmtGeo({ mode: 'custom', lat: 1.5 }); chk('P2.fmtGeo.missing-lng.no-throw', out === '[custom] 1.50, -', 'got: ' + out);
        out = fmtGeo({ mode: 'custom', lat: NaN, lng: NaN }); chk('P2.fmtGeo.nan-no-leak', out.indexOf('NaN') === -1 && out.indexOf('undefined') === -1, 'got: ' + out);
        out = fmtGeo({ mode: 'ip', lat: 34.05, lng: -118.24 }); chk('P2.fmtGeo.normal-format', out === '[ip] 34.05, -118.24', 'got: ' + out);
        out = fmtGeo('garbage'); chk('P2.fmtGeo.primitive-safe', out === '—', 'got: ' + out);
      } catch (e) { chk('P2.fmtGeo.behavior', false, 'threw: ' + e.message); }
    }
  }

  // ================= P3：结构锚点 =================
  const pe = stripComments(read('client/src/components/ProfileEditor.jsx'));
  chk('P3.ProfileEditor.consumes-fmtGeo', /fmtGeo\(fp\.geolocation\)/.test(pe), '地理位置预览行必须走 fmtGeo 共享原语');
  chk('P3.ProfileEditor.no-raw-geolocation-toFixed',
    !/geolocation[^;\n]*\.toFixed\(/.test(pe), 'ProfileEditor 内 geolocation 链路禁止裸 .toFixed（整类回归锚点）');
  chk('P3.kit.exports-fmtGeo', /export function fmtGeo/.test(kit), 'fmtGeo 必须是 kit 具名导出');
  const gen = stripComments(read('server/fp/generate.js'));
  const customBranch = gen.match(/effectiveGeoMode === 'custom'[\s\S]*?geo = \{ lat[\s\S]*?\};/);
  chk('P3.generate.custom-branch-symmetric-isFinite',
    !!customBranch
    && (customBranch[0].match(/Number\.isFinite\(override\.geolocation\.lat\)/) || []).length === 1
    && (customBranch[0].match(/Number\.isFinite\(override\.geolocation\.lng\)/) || []).length === 1,
    'custom 分支必须对称校验 lat 与 lng（Number.isFinite × 2）');
  chk('P3.generate.fallback-relabels-custom',
    /effectiveGeoMode === 'ip' \|\| effectiveGeoMode === 'custom'\) \? 'random'/.test(gen),
    '回退分支必须把不成形 custom 如实改标 random');

  console.log('\n==== test_c92 summary: ' + pass + ' pass / ' + fail + ' fail ====');
  if (fail) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
