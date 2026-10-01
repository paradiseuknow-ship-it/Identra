'use strict';

// C156 守护：网络失败证据的「归属判定」（页面遥测信标 vs 当前操作）
//
// 实证（真实联盟漏斗走查，profile=p_phase23_mu3amqhd）：
//   www.spocket.co 主文档 HTTP 200、页面完整渲染，却因两条**同源分析/转化上报**
//   请求的 403 被判 HTTP_403_FORBIDDEN（severity=blocking ⇒ retryPolicy=escalate,
//   confidence 0.97）⇒ 整任务 HUMAN_ESCALATION。那两条 403：
//     rt=fetch  /…/ag/g/c?v=2&tid=G-T5CPMQK441…       ← 测量协议上报
//     rt=image  /…/gs/ccm/collect?…tid=AW-862529334   ← 转化上报
//
// 本守护钉住三件事：
//   ① 遥测信标失败**不得**成为「当前操作失败」的证据；
//   ② 真实业务 4xx / 主文档 4xx 的判定**逐字不变** —— fail-closed，绝不放宽；
//   ③ 被排除的证据必须仍可复查（不许凭空消失，那是另一种「假装不知道」）。

const fs = require('fs');
const os = require('os');
const path = require('path');

// C140 纪律：夹具一律隔离数据根，绝不写入 server/data。
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c156_telemetry_' + Date.now());

const AGENT = path.join(__dirname, '..', 'agent');
const detector = require(path.join(AGENT, 'network/businessErrorDetector'));
const diagnoser = require(path.join(AGENT, 'diagnosis/failureDiagnoser'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  << ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ── 真实运行实测的失败条目 ──────────────────────────────────────────────
// 关键 token（tid=G-T5CPMQK441 / tid=AW-862529334 及 rcb/frm/apvc/en/dl/_p/_gaz）
// 逐字取自真实站点实测（_c156_out/c156_repro_headless.json）；仅主机名与随机路径段泛化。
const REAL_GA4_403 = 'https://shop.example.test/_t/x/ag/g/c?v=2&tid=G-T5CPMQK441&gtm=45g92e69t1&_p=1790830210166&_gaz=1&gcd=';
const REAL_ADS_403 = 'https://shop.example.test/_t/x/gs/ccm/collect?rcb=12&frm=0&apvc=0&tid=AW-862529334&en=page_view&dl=https%3A%2F%2Fshop.example.test%2F';
const REAL_AD_PING_FAIL = 'https://re.example-sdk.test/v1/s';

function rec(over) {
  return Object.assign({
    method: 'GET', url: 'https://api.example.com/v1/orders', resourceType: 'fetch',
    status: 200, failed: false, failureText: null, bodyPreview: null, at: Date.now(),
  }, over);
}
function netWrap(over) {
  return Object.assign({
    attached: true, pending: 0, sinceTs: 0,
    counts: { requests: 1, completed: 1, failures: 0, api: 1, status4xx: 0, status5xx: 0, consoleErrors: 0, consoleWarnings: 0, pageErrors: 0 },
    failures: [], apiResponses: [], console: [], pageErrors: [],
    lastRequestAt: Date.now(), lastResponseAt: Date.now(),
  }, over);
}
// 真实场景的网络快照（主文档 200 + 2 条遥测 403 + 1 条广告 ping 传输层失败）
const REAL_CASE_NET = netWrap({
  failures: [
    rec({ url: REAL_GA4_403, resourceType: 'fetch', status: 403 }),
    rec({ url: REAL_ADS_403, resourceType: 'image', status: 403 }),
    rec({ url: REAL_AD_PING_FAIL, resourceType: 'ping', status: undefined, failed: true, failureText: 'net::ERR_CONNECTION_CLOSED' }),
  ],
});

(async () => {
  // ───────────────────────────────────────────────────────
  section('A 组  归属判据单元（telemetrySignal 唯一实现）');
  {
    ok('A1 真实测量协议上报（tid=G-…）→ measurement-tid',
      detector.telemetrySignal(rec({ url: REAL_GA4_403, resourceType: 'fetch', status: 403 })) === 'measurement-tid',
      detector.telemetrySignal(rec({ url: REAL_GA4_403, resourceType: 'fetch', status: 403 })));
    ok('A2 真实转化上报（tid=AW-…）→ measurement-tid',
      detector.telemetrySignal(rec({ url: REAL_ADS_403, resourceType: 'image', status: 403 })) === 'measurement-tid',
      detector.telemetrySignal(rec({ url: REAL_ADS_403, resourceType: 'image', status: 403 })));

    ok('A3 rt=ping → 结构性命中（平台语义只承载遥测）',
      detector.telemetrySignal(rec({ url: REAL_AD_PING_FAIL, resourceType: 'ping', failed: true })) === 'resourceType=ping');
    ok('A4 rt=beacon → 结构性命中',
      detector.telemetrySignal(rec({ url: 'https://x.example.test/b', resourceType: 'beacon' })) === 'resourceType=beacon');
    ok('A5 埋点端点路径 + 埋点事件参数 → telemetry-endpoint（双命中）',
      detector.telemetrySignal(rec({ url: 'https://shop.example.test/collect?en=page_view&_p=1', resourceType: 'fetch' })) === 'telemetry-endpoint');

    // ★ 统一闸门：主文档永不降级（哪怕 URL 带测量协议特征）
    ok('A6 ★ 主文档 403 永不降级（闸门优先于全部充分条件）',
      detector.telemetrySignal(rec({ url: 'https://shop.example.test/c?tid=G-ABC123', resourceType: 'document', status: 403 })) === null,
      detector.telemetrySignal(rec({ url: 'https://shop.example.test/c?tid=G-ABC123', resourceType: 'document', status: 403 })));

    ok('A7 真实业务 API 403（fetch，JSON 接口）不降级',
      detector.telemetrySignal(rec({ url: 'https://api.example.com/v1/orders', resourceType: 'fetch', status: 403 })) === null);
    ok('A8 埋点路径但无埋点参数（业务接口）不降级',
      detector.telemetrySignal(rec({ url: 'https://api.example.com/api/analytics/report?range=7d', resourceType: 'fetch', status: 403 })) === null);
    ok('A9 埋点参数但非埋点路径（业务接口）不降级',
      detector.telemetrySignal(rec({ url: 'https://api.example.com/v1/pay?en=checkout', resourceType: 'fetch', status: 403 })) === null);
    ok('A10 图片 403 但 URL 无遥测特征 → 不降级（不按资源类型一刀切）',
      detector.telemetrySignal(rec({ url: 'https://shop.example.test/assets/hero.png', resourceType: 'image', status: 403 })) === null);
    ok('A11 空/缺字段输入不崩、不误判',
      detector.telemetrySignal(null) === null && detector.telemetrySignal({}) === null
      && detector.telemetrySignal({ resourceType: 'fetch' }) === null);
  }

  // ───────────────────────────────────────────────────────
  section('B 组  detect() 终局：遥测失败被排除，真实失败一分不让');
  {
    const r = detector.detect({ network: REAL_CASE_NET, attempted: true });
    ok('B1 ★ 真实案例不再产出任何 blocking 证据', r.hasBlockingError === false, r.summary);
    ok('B2 ★ 真实案例 primary 为空（页面其实完好，无网络失败信号）', r.primary === null, r.primary);
    ok('B3 被排除的证据完整留痕（3 条，含 code/status/url/reason）',
      Array.isArray(r.suppressed) && r.suppressed.length === 3
      && r.suppressed.every((s) => s.code && s.url && s.reason), JSON.stringify(r.suppressed));
    ok('B4 summary 显式声明「按证据归属排除」', /证据归属排除/.test(r.summary), r.summary);

    // 真实证据不得被遥测掩盖
    const api403 = netWrap({
      apiResponses: [rec({ url: 'https://api.example.com/v1/orders', method: 'POST', status: 403 })],
      failures: [rec({ url: 'https://api.example.com/v1/orders', method: 'POST', status: 403 })],
    });
    const r2 = detector.detect({ network: api403, attempted: true });
    ok('B5 ★ 真实业务 API 403 仍判 blocking（未放宽）',
      r2.hasBlockingError === true && r2.primary && r2.primary.code === 'HTTP_403_FORBIDDEN', r2.summary);

    const doc403 = netWrap({ failures: [rec({ url: 'https://shop.example.test/dashboard', resourceType: 'document', status: 403 })] });
    const r3 = detector.detect({ network: doc403, attempted: true });
    ok('B6 ★ 主文档 403 仍判 blocking（未放宽）',
      r3.hasBlockingError === true && r3.primary.code === 'HTTP_403_FORBIDDEN', r3.summary);

    // ★ 去重正确性：被抑制条目不得占用 code，从而屏蔽后续真实证据
    const mixed = netWrap({
      failures: [
        rec({ url: REAL_GA4_403, resourceType: 'fetch', status: 403 }),
        rec({ url: 'https://api.example.com/v1/orders', method: 'POST', status: 403 }),
      ],
    });
    const r4 = detector.detect({ network: mixed, attempted: true });
    ok('B7 ★ 遥测 403 不得屏蔽同 code 的真实 403（去重只在真正产出时占用）',
      r4.hasBlockingError === true && r4.primary.code === 'HTTP_403_FORBIDDEN'
      && r4.suppressed.length === 1, JSON.stringify({ root: r4.primary && r4.primary.code, sup: r4.suppressed.length }));

    // 排除遥测后，其它证据链必须完好
    const withCaptcha = detector.detect({ network: REAL_CASE_NET, pageText: '请完成安全验证', attempted: true });
    ok('B8 排除遥测不吞掉其它证据（CAPTCHA 仍被识别）',
      withCaptcha.primary && withCaptcha.primary.code === 'BUSINESS_CAPTCHA_REQUIRED',
      withCaptcha.primary && withCaptcha.primary.code);

    ok('B9 network=null 不崩、suppressed 为空',
      (() => { const x = detector.detect({ attempted: true }); return x.suppressed.length === 0 && x.findings.length === 0; })());
    ok('B10 空 failures 不崩、suppressed 为空',
      detector.detect({ network: netWrap({}), attempted: true }).suppressed.length === 0);

    // 传输层失败同样分归属
    const onlyTelemetryFails = netWrap({ failures: [rec({ url: REAL_AD_PING_FAIL, resourceType: 'ping', failed: true, failureText: 'ERR' })] });
    const r5 = detector.detect({ network: onlyTelemetryFails, attempted: true });
    ok('B11 全部传输层失败皆遥测 → 不产出 NETWORK_REQUEST_FAILED（避免抬高「网络有问题」可信度）',
      !r5.findings.some((f) => f.code === 'NETWORK_REQUEST_FAILED'), r5.summary);

    const realFail = netWrap({ failures: [rec({ url: 'https://api.example.com/v1/submit', failed: true, failureText: 'ERR_CONNECTION_CLOSED' })] });
    const r6 = detector.detect({ network: realFail, attempted: true });
    ok('B12 真实业务请求的传输层失败仍产出 NETWORK_REQUEST_FAILED',
      r6.findings.some((f) => f.code === 'NETWORK_REQUEST_FAILED'), r6.summary);
  }

  // ───────────────────────────────────────────────────────
  section('C 组  不变量：唯一实现 / 判定链完整 / 不得触达成功定义');
  {
    const srcDet = fs.readFileSync(path.join(AGENT, 'network/businessErrorDetector.js'), 'utf8');
    const srcDia = fs.readFileSync(path.join(AGENT, 'diagnosis/failureDiagnoser.js'), 'utf8');
    const srcObs = fs.readFileSync(path.join(AGENT, 'observation.js'), 'utf8');

    ok('C1 telemetrySignal 唯一实现（全 agent 面恰 1 处定义）',
      (srcDet.match(/function telemetrySignal\s*\(/g) || []).length === 1
      && !/function telemetrySignal\s*\(/.test(srcDia),
      (srcDet.match(/function telemetrySignal\s*\(/g) || []).length);

    ok('C2 主文档闸门在源码中位于充分条件之前（顺序断言）',
      srcDet.indexOf("if (rt === 'document') return null;") > 0
      && srcDet.indexOf('TELEMETRY_RESOURCE_TYPES.has(rt)') > srcDet.indexOf("if (rt === 'document') return null;"),
      { gate: srcDet.indexOf("if (rt === 'document') return null;"), rt: srcDet.indexOf('TELEMETRY_RESOURCE_TYPES.has(rt)') });

    ok('C3 归属判定只作用于「证据产出」，不触达成功定义（不得出现 success 赋值）',
      !/\bsuccess\s*=/.test(srcDet) && !/\bSUCCESS\b/.test(srcDet));

    ok('C4 诊断器只做留痕、不重复实现归属（消费 detection.suppressed）',
      /detection\.suppressed/.test(srcDia) && !/telemetry-tid|TELEMETRY_PATH_RE/.test(srcDia));

    ok('C5 与既有同类正确范式对齐：observation.computeChallenge 仍只在 document 上判硬阻断',
      /resourceType === 'document'/.test(srcObs));

    ok('C6 不含站点/品牌词（同 test_step2 红线口径）',
      !/saas/i.test(srcDet) && !/cloudsaas/i.test(srcDet) && !/戴尔|飞利浦|华硕/.test(srcDet));

    ok('C7 detect() 返回契约向后兼容（原有 5 个字段俱在）',
      (() => {
        const x = detector.detect({ network: REAL_CASE_NET, attempted: true });
        return Array.isArray(x.findings) && 'primary' in x && typeof x.hasBlockingError === 'boolean'
          && typeof x.silentFailure === 'boolean' && typeof x.summary === 'string';
      })());
  }

  // ───────────────────────────────────────────────────────
  section('D 组  错误实现对照：证明断言有分辨力');
  {
    const DOC_403 = rec({ url: 'https://shop.example.test/dashboard', resourceType: 'document', status: 403 });
    const API_403 = rec({ url: 'https://api.example.com/v1/orders', resourceType: 'fetch', status: 403 });
    const IMG_403 = rec({ url: 'https://shop.example.test/assets/hero.png', resourceType: 'image', status: 403 });

    // D1 漏掉主文档闸门 ⇒ 会把「主文档 403」误降级
    const wrongNoDocGate = (r) => {
      const rt = String((r && r.resourceType) || '').toLowerCase();
      if (rt === 'ping' || rt === 'beacon') return 'x';
      if (/[?&]tid=[a-z]{1,3}-[a-z0-9]{3,}/i.test(String((r && r.url) || ''))) return 'x';
      return null;
    };
    ok('D1 对照实现（漏主文档闸门）在带 tid 的主文档 403 上误降级；正确实现不降级',
      wrongNoDocGate(rec({ url: 'https://shop.example.test/c?tid=G-ABC123', resourceType: 'document', status: 403 })) !== null
      && detector.telemetrySignal(rec({ url: 'https://shop.example.test/c?tid=G-ABC123', resourceType: 'document', status: 403 })) === null);

    // D2 不做正向识别 ⇒ 会把真实 API 403 误降级
    const wrongNoPositiveId = (r) => (String((r && r.resourceType) || '').toLowerCase() === 'document' ? null : 'x');
    ok('D2 对照实现（非 document 全降级）在真实 API 403 上误降级；正确实现不降级',
      wrongNoPositiveId(API_403) !== null && detector.telemetrySignal(API_403) === null);

    // D3 按资源类型一刀切 ⇒ 会把普通图片 403 误降级
    const wrongImageBlanket = (r) => (String((r && r.resourceType) || '').toLowerCase() === 'image' ? 'x' : null);
    ok('D3 对照实现（image 一律降级）在普通图片 403 上误降级；正确实现不降级',
      wrongImageBlanket(IMG_403) !== null && detector.telemetrySignal(IMG_403) === null);

    // D4 只按「路径命中」判（漏掉参数双命中）⇒ 会把业务 analytics 接口误降级
    const wrongPathOnly = (r) => (/(^|\/)(collect|analytics)(\/|$|\?)/i.test(String((r && r.url) || '')) ? 'x' : null);
    ok('D4 对照实现（仅路径命中）在业务 analytics 接口上误降级；正确实现不降级',
      wrongPathOnly(rec({ url: 'https://api.example.com/api/analytics/report?range=7d' })) !== null
      && detector.telemetrySignal(rec({ url: 'https://api.example.com/api/analytics/report?range=7d' })) === null);

    // D5 丢弃留痕 ⇒ 证据凭空消失
    const wrongDropTrace = (r) => ({ findings: [], primary: null, hasBlockingError: false, silentFailure: false, suppressed: [], summary: 'x' });
    ok('D5 对照实现（丢弃 suppressed）会失去证据可复查性；正确实现保留 3 条留痕',
      wrongDropTrace(REAL_CASE_NET).suppressed.length === 0
      && detector.detect({ network: REAL_CASE_NET, attempted: true }).suppressed.length === 3);
  }

  console.log('\n────────────────────────────');
  console.log(`C156 结果: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('守护异常：', e); process.exit(1); });
