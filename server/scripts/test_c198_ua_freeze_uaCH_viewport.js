'use strict';
// C198：反检测一致性（UA Reduction 冻结格式 / UA-CH native 回读 / viewport 物理合理性）
// 守护。实证基线（.benchmark/C198_REPORT.md）：
//   ① 真 Chrome 157 UA = Chrome/157.0.0.0（小版本冻结）；完整版本只在 uaFullVersion/fullVersionList
//   ② 真 Win11 platformVersion=19.0.0（OS 映射真值，需无 override 裸探测）
//   ③ headful 自定义分辨率 Emulation 覆写 → outer==inner / inner>avail 物理不可能
//   ④ userAgentData 是 Secure context 特性，非安全上下文不得补定义
// A 单元（行为）｜B 源断言（接线）｜C integrity 判据（冻结格式）
const _fsC198 = require('fs');
const _osC198 = require('os');
const _pathC198 = require('path');
process.env.FPB_DATA_DIR = _fsC198.mkdtempSync(_pathC198.join(_osC198.tmpdir(), 'fpb-c198-guard-'));

const { freezeChromeUaVersion, alignUaToEngine, uaChromeMajor } = require('../fp/uaVersion');
const { runIntegrityCheck } = require('../integrity');

const SERVER = _pathC198.join(__dirname, '..');
const read = (p) => _fsC198.readFileSync(_pathC198.join(SERVER, p), 'utf8');
const BM = read('browserManager.js');
const IDX = read('index.js');
const INJ = read('fp/inject.js');

let pass = 0, fail = 0;
function chk(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

console.log('== A 单元：fp/uaVersion 行为 ==');
{
  const poolUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.196 Safari/537.36';
  const frozen = alignUaToEngine(poolUa, '157.0.8103.38');
  chk('A1 对齐产出冻结格式 Chrome/<major>.0.0.0', /Chrome\/157\.0\.0\.0/.test(frozen), frozen);
  chk('A2 非版本部位逐字节保留', frozen.startsWith('Mozilla/5.0 (Windows NT 10.0; Win64; x64)') && frozen.endsWith('Safari/537.36'));
  chk('A3 已冻结 UA 幂等', alignUaToEngine('Mozilla/5.0 (X) Chrome/157.0.0.0 Safari/537.36', '157.0.8103.38') === 'Mozilla/5.0 (X) Chrome/157.0.0.0 Safari/537.36');
  chk('A4 引擎版本缺失原样返回', alignUaToEngine(poolUa, null) === poolUa && alignUaToEngine(poolUa, '') === poolUa);
  const ffUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';
  chk('A5 非 Chrome UA 不动', alignUaToEngine(ffUa, '157.0.8103.38') === ffUa);
  const edgeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.2277.83';
  const edgeOut = freezeChromeUaVersion(edgeUa);
  chk('A6 freeze 只冻 Chrome/ 不动 Edg/', /Chrome\/157\.0\.0\.0/.test(edgeOut) && /Edg\/157\.0\.2277\.83/.test(edgeOut), edgeOut);
  chk('A7 uaChromeMajor 兼容两种格式', uaChromeMajor('a Chrome/157.0.0.0 b') === 157 && uaChromeMajor('a Chrome/157.0.8103.38 b') === 157 && uaChromeMajor('Firefox/121.0') === null);
}

console.log('== B 源断言：三消费点接线 ==');
{
  chk('B1 launch 对齐走单一实现', BM.includes('alignUaToEngine(fp.userAgent, realVer)'));
  chk('B2 launch 无全版本注入残留', !BM.includes("'Chrome/' + realVer"));
  chk('B3 index 两处对齐走单一实现', IDX.includes('alignUaToEngine(fp.userAgent, realVer)') && IDX.includes('alignUaToEngine(fp.userAgent, engineVersion)'));
  chk('B4 index 无全版本注入残留', !IDX.includes("'Chrome/' + realVer") && !IDX.includes("'Chrome/' + engineVersion"));
  chk('B5 inject secure-context 守卫', INJ.includes('if (brands && nativeUaDataRef)'));
  chk('B6 inject native HEV 提示表含三高熵值', INJ.includes("getHighEntropyValues(['fullVersionList', 'platformVersion', 'uaFullVersion'])"));
  chk('B7 inject platformVersion 回退链首选项 _uaHev', INJ.includes('(FP._uaHev && FP._uaHev.platformVersion)'));
  chk('B8 inject uaFullVersion 回退链首选项 _uaHev', INJ.includes('(FP._uaHev && FP._uaHev.uaFullVersion) || uaVer'));
  chk('B9 userAgentMetadata platformVersion 捕获真值优先', BM.includes("platformVersion: (fp._uaHev && fp._uaHev.platformVersion) || '15.0.0'"));
  chk('B10 无 override 裸探测存在且接线', BM.includes('async function captureNativeHev(') && BM.includes('await captureNativeHev(launchOpts.executablePath, realVer)'));
  chk('B11 headful 自定义/隐藏分支 viewport=null', BM.includes('} else if (isHeadful) {') && /else if \(isHeadful\) \{[\s\S]{0,600}launchOpts\.viewport = null;/.test(BM));
  chk('B12 headless 视口高度物理合理（≤ avail-88）', BM.includes('Math.max(480, Math.min(sh, availH - 88))'));
  chk('B13 headful 分支不再设置 deviceScaleFactor 依赖 emulation', (() => {
    const m = BM.match(/else if \(isHeadful\) \{([\s\S]*?)\n  \} else \{/);
    return !!m && !m[1].includes('deviceScaleFactor');
  })());
}

console.log('== C integrity 判据（冻结格式） ==');
{
  const mkFp = (ua) => ({
    userAgent: ua, language: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'],
    timezone: 'Europe/Berlin', platform: 'Win32', hardwareConcurrency: 8, deviceMemory: 8,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, pixelRatio: 1 },
    webgl: null,
  });
  const prof = { id: 'p_c198_guard', os: 'Windows', browser: 'Chrome', fingerprintOverride: {} };
  const r1 = runIntegrityCheck(prof, { fp: mkFp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'), engineVersion: '157.0.8103.38', proxies: [] });
  const uaFmtFrozen = r1.results.find((x) => /UA 格式/.test(x.msg));
  chk('C1 冻结格式 UA 判 ok', uaFmtFrozen && uaFmtFrozen.ok === true, uaFmtFrozen && uaFmtFrozen.msg);
  const r2 = runIntegrityCheck(prof, { fp: mkFp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.38 Safari/537.36'), engineVersion: '157.0.8103.38', proxies: [] });
  const uaFmtFull = r2.results.find((x) => /UA 格式/.test(x.msg));
  chk('C2 全版本 UA 判 warn（Reduction 冻结面）', uaFmtFull && uaFmtFull.ok === false, uaFmtFull && uaFmtFull.msg);
  const r3 = runIntegrityCheck(prof, { fp: mkFp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'), engineVersion: '157.0.8103.38', proxies: [] });
  const uaEng = r3.results.find((x) => /UA.*↔.*引擎/.test(x.msg));
  chk('C3 冻结 UA 与引擎 major 一致判 ok', uaEng && uaEng.ok === true, uaEng && uaEng.msg);
}

console.log(`\nC198 guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
