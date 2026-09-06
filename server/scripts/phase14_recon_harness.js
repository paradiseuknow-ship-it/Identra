'use strict';

// Phase 14.7 — Webflow Controlled Recon Harness（真实站点只读测试 harness）
//
// 硬性边界（Phase 14 规格 §八/§十二）：
//   - 只读：零注册、零表单提交、零写入
//   - challenge / WAF block → HUMAN_ESCALATION 终态（现有 vocabulary）+ harness 级细分
//     （HUMAN_REQUIRED / BLOCKED_EXTERNAL）记录于 evidence——绝不自动处理、绝不换环境重试
//   - 每 task 完整 evidence 落盘（Environment Snapshot / Integrity / HTTP / Challenge /
//     Terminal State / Delta），进程结束后可独立复核
//   - Generic：无任何 Webflow 专用 selector / 业务逻辑，仅 URL 参数化
//
// 用法：
//   node server/scripts/phase14_recon_harness.js [--label phase14_recon] [--browser-only]
//   FPB_EVENTS_DIR=.benchmark/phase14_recon/events 同步走 events.js 按任务落盘链路

const fs = require('fs');
const path = require('path');
const browserManager = require('../browserManager');
const { captureEnvironmentSnapshot, buildEnvironmentSnapshot } = require('../fp/environmentSnapshot');
const { checkEnvironmentIntegrity } = require('../fp/environmentIntegrity');
const { computeEnvironmentDelta } = require('../fp/environmentDelta');
const { detectChallenge, terminalStateFor } = require('../fp/challengeDetector');

const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}

const LABEL = argOf('--label', 'phase14_recon');
const OUT = path.resolve(__dirname, '..', '..', '.benchmark', LABEL);
const TARGETS = {
  webflow: [
    { taskId: 'T01', name: 'home', url: 'https://webflow.com/' },
    { taskId: 'T02', name: 'signup page', url: 'https://webflow.com/signup' },
    { taskId: 'T03', name: 'login page', url: 'https://webflow.com/login' },
  ],
};

async function main() {
  const targetName = argOf('--target', 'webflow');
  const tasks = TARGETS[targetName];
  if (!tasks) { console.error('UNKNOWN_TARGET', targetName); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  if (process.env.FPB_EVENTS_DIR) fs.mkdirSync(process.env.FPB_EVENTS_DIR, { recursive: true });

  const profile = {
    id: 'recon_phase14',
    headless: true,
    browser: 'Chrome', // canonical 大小写（Phase 14.1 后小写会被归一，但显式 canonical 更稳）
    os: 'Windows',
    startupUrls: [],
    lastSessionUrls: [],
    launchBehavior: {},
  };

  const session = await browserManager.launch(profile, []);
  const page = await browserManager.getPage(profile.id);
  const fp = session.fp || null;
  const proxy = session.proxy || null;
  const runTag = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(OUT, runTag);
  fs.mkdirSync(runDir, { recursive: true });

  // baseline snapshot（attempt 基线，用于跨 task/跨 run Delta）
  let previousEvidence = null;
  const prevRunDir = fs.readdirSync(OUT).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d) && d !== runTag).sort().pop();
  if (prevRunDir) {
    const p = path.join(OUT, prevRunDir, '_tasks.json');
    if (fs.existsSync(p)) previousEvidence = JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  const results = [];
  let baselineSnapshot = null;

  for (const t of tasks) {
    const rec = { taskId: t.taskId, name: t.name, url: t.url, startedAt: Date.now() };
    try {
      // 1. Environment Snapshot（导航前基线）
      const snap = await captureEnvironmentSnapshot({ page, fp, profile, proxy, task: { taskId: t.taskId, executionId: runTag, attemptId: 'A1' } });
      if (!baselineSnapshot) baselineSnapshot = snap;
      rec.environmentSnapshot = snap;
      rec.environmentIntegrity = checkEnvironmentIntegrity(snap);

      // 2. 只读导航 + HTTP 状态
      const resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      rec.httpStatus = resp ? resp.status() : null;
      rec.pageTitle = await page.title().catch(() => null);
      rec.finalUrl = page.url();
      await page.waitForTimeout(2500).catch(() => {});
      const html = await page.content().catch(() => '');

      // 3. Challenge / 外部阻断检测（只识别不处理）
      rec.challengeDetection = detectChallenge({ status: rec.httpStatus, html, title: rec.pageTitle });
      const term = terminalStateFor(rec.challengeDetection);
      rec.terminalState = term; // { taskStatus, harnessClass, escalationKind }

      // 4. 截图留证
      const shot = path.join(runDir, `${t.taskId}_final.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      rec.screenshot = path.relative(path.resolve(__dirname, '..', '..'), shot);

      // 5. Delta：与同 run 首任务（环境基线）比较——隐式环境变化必须现形
      //    （session 排除：cookies 随导航自然积累属预期演化，非环境变化；跨 run delta 同样排除）
      rec.environmentDelta = computeEnvironmentDelta(baselineSnapshot, snap, { excludeSections: ['task', 'timestamp', 'snapshotVersion', 'session'] });
      if (previousEvidence && previousEvidence[t.taskId]) {
        rec.crossRunDelta = computeEnvironmentDelta(previousEvidence[t.taskId].environmentSnapshot, snap, { excludeSections: ['task', 'timestamp', 'snapshotVersion', 'session'] });
      }

      console.log(`[phase14] ${t.taskId} ${t.name}: http=${rec.httpStatus} integrity=${rec.environmentIntegrity.status} terminal=${term.taskStatus}${term.harnessClass ? '/' + term.harnessClass : ''} challenge=${rec.challengeDetection.kind || 'none'}`);
    } catch (e) {
      rec.error = String(e.message).slice(0, 300);
      rec.terminalState = { taskStatus: 'FAILED', harnessClass: null, escalationKind: null };
      console.log(`[phase14] ${t.taskId} ERROR: ${rec.error}`);
    }
    rec.finishedAt = Date.now();
    rec.durationMs = rec.finishedAt - rec.startedAt;
    results.push(rec);
    // 每 task 独立落盘（进程中途死亡也不丢已完成任务的证据）
    fs.writeFileSync(path.join(runDir, `${t.taskId}.json`), JSON.stringify(rec, null, 2), 'utf8');
  }

  fs.writeFileSync(path.join(runDir, '_tasks.json'), JSON.stringify(results.reduce((m, r) => { m[r.taskId] = r; return m; }, {}), null, 2), 'utf8');
  fs.writeFileSync(path.join(runDir, '_summary.json'), JSON.stringify({
    runTag, target: targetName, label: LABEL,
    tasks: results.map((r) => ({ taskId: r.taskId, httpStatus: r.httpStatus, terminal: r.terminalState, integrity: r.environmentIntegrity && r.environmentIntegrity.status, challenge: r.challengeDetection && r.challengeDetection.kind })),
  }, null, 2), 'utf8');

  await browserManager.close(profile.id).catch(() => {});
  console.log('PHASE14_HARNESS_DONE runDir=' + runDir);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
