'use strict';
// C78 守护测试 —— client 面板深扫 batch 3（IntelligencePanel/ObservabilityPanel/TemplatesPanel/
// AiPanel/SchedulesPanel/ReadinessPanel/AuthGate 首轮细读，~1700 行）。
// 缺陷背景（零浏览器可证）：
//   D1 B类（显示缺口）traceCollector 自 C56/verification-recovery 起聚合 kind:'RECOVERY'
//      时间线节点（recoveryAction/observationCount/elapsedMs，来源 ai.verification.recovered
//      事件——崩溃/失败后观察窗口内自动恢复成功），但 ObservabilityPanel.TimelineNode 没有
//      RECOVERY 分支：detail 恒为空串，徽章落到 KIND_COLOR 兜底灰色。恢复成功是产品核心
//      自愈能力的最关键证据链，在 UI 上完全不可见（USER_GUIDE §11 也从未提及）。
//      修复：TimelineNode 增加 RECOVERY 分支（动作/观测次数/耗时）+ KIND_COLOR 配色。
//   D2 防御硬化 trace 是跨层契约边界（节点由持久化集合聚合），TimelineNode 的
//      OBSERVATION/VERIFICATION 分支用 JSON.stringify(n.observation).slice(...) ——
//      JSON.stringify(undefined) 返回 undefined，.slice 直接 TypeError 渲染崩溃。
//      当前 server 契约有兜底（OBSERVATION 仅在 obs 存在时推送、VERIFICATION payload||{}），
//      不可达，记边界；但本测试以对抗性节点固化「任何节点形状都不崩」的渲染契约，
//      防契约漂移（C74 D4 同性质的 cheap 防御）。
// 两层：
//   A 层（运行时）：esbuild bundle + react-dom/server —— TimelineNode named-export SSR
//      节点矩阵（RECOVERY 可见性 + 对抗性缺字段节点 + 既有 9 类节点回归）。
//   B 层（文件断言）：RECOVERY 分支/配色/安全序列化锚定，防回归漂移（断言前剥行注释）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const CLIENT = path.join(ROOT, 'client');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// C58 P7b / C74 教训：断言前行级剥注释（naive /* */ 正则会从注释内 /* 起吞代码）。
const stripComments = (src) => src.split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');

(async () => {
  // ================= A 层：SSR 运行时渲染 =================
  let esbuild;
  try { esbuild = require(path.join(CLIENT, 'node_modules', 'esbuild')); }
  catch (e) { esbuild = require('esbuild'); }

  const entry = `
    import React from 'react';
    import { renderToString } from 'react-dom/server';
    import { TimelineNode } from '${CLIENT.replace(/\\/g, '/')}/src/components/ObservabilityPanel.jsx';

    const results = {};
    const tryRender = (key, node) => {
      try { const html = renderToString(React.createElement(TimelineNode, { n: node })); results[key] = { ok: true, html }; }
      catch (e) { results[key] = { ok: false, err: e.constructor.name + ': ' + e.message }; }
    };
    const T = 1730000000000;

    // A1：RECOVERY 节点（D1 最强实证——恢复动作/观测次数必须出现在渲染输出中）
    tryRender('recovery', { kind: 'RECOVERY', ts: T, stepId: 's1', recoveryAction: 'waitLong', observationCount: 3, elapsedMs: 12500 });

    // A2/A3：对抗性缺字段节点（D2 渲染契约——任何节点形状不允许崩）
    tryRender('observationMissing', { kind: 'OBSERVATION', ts: T, stepId: 's1', attemptId: 'a1' });
    tryRender('verificationMissing', { kind: 'VERIFICATION', ts: T, type: 'ai.verification.completed' });
    // A3b：VERIFICATION payload=null（JSON.stringify(null)="null" 合法但需不崩）
    tryRender('verificationNull', { kind: 'VERIFICATION', ts: T, type: 'agent.recovered', payload: null });

    // A4：既有节点类型回归矩阵（PLAN/STEP/ACTION/ERROR/REPAIR/RETRY/VIL/ESCALATION/CHECKPOINT）
    tryRender('plan', { kind: 'PLAN', ts: T, objective: 'reg-a', stepCount: 4 });
    tryRender('step', { kind: 'STEP', ts: T, type: 'navigate', description: 'open page', status: 'SUCCESS' });
    tryRender('action', { kind: 'ACTION', ts: T, status: 'SUCCESS', action: { type: 'click' } });
    tryRender('error', { kind: 'ERROR', ts: T, code: 'E1', message: 'boom', snapshotRef: 'snap1' });
    tryRender('repair', { kind: 'REPAIR', ts: T, strategy: 'reload', status: 'DONE', risk: 'LOW' });
    tryRender('retry', { kind: 'RETRY', ts: T, index: 2 });
    tryRender('vil', { kind: 'VIL', ts: T, decision: 'CONTINUE', failureType: 'NONE', why: 'stable', confidence: 0.9 });
    tryRender('escalation', { kind: 'ESCALATION', ts: T, reason: 'budget exhausted' });
    tryRender('checkpoint', { kind: 'CHECKPOINT', ts: T, url: 'https://x', lastSuccessfulAction: 'click#3' });
    tryRender('observationFull', { kind: 'OBSERVATION', ts: T, observation: { url: 'https://y', title: 'T' } });

    const markers = (k, arr) => {
      const r = results[k] || {};
      if (!r.ok) return { ok: false, err: r.err };
      return { ok: true, missing: arr.filter((m) => !r.html.includes(m)) };
    };
    console.log('SSR_RESULT ' + JSON.stringify({
      recovery: markers('recovery', ['RECOVERY', 'waitLong', '3']),
      observationMissing: results.observationMissing ? { ok: results.observationMissing.ok, err: results.observationMissing.err || null } : null,
      verificationMissing: results.verificationMissing ? { ok: results.verificationMissing.ok, err: results.verificationMissing.err || null } : null,
      verificationNull: results.verificationNull ? { ok: results.verificationNull.ok, err: results.verificationNull.err || null } : null,
      regression: Object.fromEntries(['plan','step','action','error','repair','retry','vil','escalation','checkpoint','observationFull'].map((k) => [k, results[k] ? results[k].ok : false])),
    }));
  `;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c78-ssr-'));
  const bundlePath = path.join(tmpDir, 'bundle.cjs');
  try {
    const out = esbuild.buildSync({
      stdin: { contents: entry, resolveDir: tmpDir, loader: 'jsx', sourcefile: 'c78-ssr-entry.jsx' },
      absWorkingDir: CLIENT,
      nodePaths: [path.join(CLIENT, 'node_modules')],
      bundle: true, platform: 'node', format: 'cjs', jsx: 'transform', write: false,
    });
    fs.writeFileSync(bundlePath, out.outputFiles[0].text);
    const stdout = execFileSync(process.execPath, [bundlePath], { encoding: 'utf8', timeout: 60000 });
    const line = stdout.split('\n').find((l) => l.startsWith('SSR_RESULT '));
    if (!line) {
      chk('A.ssr-result-line', false, 'no SSR_RESULT line in output: ' + stdout.slice(0, 400));
    } else {
      const r = JSON.parse(line.slice('SSR_RESULT '.length));
      chk('A1.recovery-visible', r.recovery && r.recovery.ok && r.recovery.missing.length === 0,
        'recovery node render: ' + JSON.stringify(r.recovery));
      chk('A2.observation-missing-no-crash', r.observationMissing && r.observationMissing.ok,
        'adversarial OBSERVATION node: ' + JSON.stringify(r.observationMissing));
      chk('A3.verification-missing-no-crash', r.verificationMissing && r.verificationMissing.ok,
        'adversarial VERIFICATION node: ' + JSON.stringify(r.verificationMissing));
      chk('A3b.verification-null-no-crash', r.verificationNull && r.verificationNull.ok,
        'VERIFICATION payload=null: ' + JSON.stringify(r.verificationNull));
      const reg = r.regression || {};
      chk('A4.regression-9-kinds', Object.keys(reg).length === 10 && Object.values(reg).every(Boolean),
        'existing node kinds regression: ' + JSON.stringify(reg));
    }
  } catch (e) {
    chk('A.ssr-pipeline', false, e.constructor.name + ': ' + e.message);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  // ================= B 层：文件断言（剥注释后锚定） =================
  const obsSrc = stripComments(read('client/src/components/ObservabilityPanel.jsx'));

  chk('B1.timeline-node-named-export', /export\s+function\s+TimelineNode/.test(obsSrc),
    'TimelineNode must stay named-exported for SSR probe access');
  chk('B2.recovery-color', /RECOVERY:\s*'bg-/.test(obsSrc),
    'KIND_COLOR must carry an explicit RECOVERY entry');
  chk('B3.recovery-branch', /kind\s*===\s*'RECOVERY'/.test(obsSrc) && /recoveryAction/.test(obsSrc),
    "TimelineNode must render a RECOVERY branch consuming recoveryAction");
  chk('B4.no-bare-stringify-slice',
    !/JSON\.stringify\(n\.observation\)\.slice/.test(obsSrc) && !/JSON\.stringify\(n\.payload\)\.slice/.test(obsSrc),
    'bare JSON.stringify(...).slice fragile pattern must not return');
  chk('B5.safe-json-helper', /function\s+safeJson/.test(obsSrc),
    'safeJson helper expected guarding OBSERVATION/VERIFICATION detail rendering');

  console.log('\\nSUMMARY pass=' + pass + ' fail=' + fail);
  if (fail) { failures.forEach((f) => console.log('FAILED :: ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
