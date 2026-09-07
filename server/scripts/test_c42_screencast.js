'use strict';
// C42 守护测试 —— 浏览器实时画面流（零浏览器）。
// 覆盖：
//   P1 FrameHub 首帧立即发出（接入即有画面）
//   P2 FrameHub 节流：interval 内连续 push 合并，只发最新一帧（不堆积不回放旧帧）
//   P3 FrameHub 订阅计数 0→1 触发 start、1→0 触发 stop（无观众自动释放）
//   P4 FrameHub stop 后 pending 帧与 timer 清空（不泄漏）
//   P5 FrameHub 单订阅者异常不中断广播
//   P6 SSE 端点错误契约：浏览器未运行 → 400 JSON（不挂起 SSE）
//   P7 SSE 端点鉴权/存在性契约：未知 profile → 404
//   P8 接线静态断言：index.js 路由存在且引用 screencastManager；BrowserViewer 双模式 + EventSource + 降级

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const read = (rel) => require('fs').readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  const { createFrameHub, resetForTests } = require(path.join(ROOT, 'server', 'screencastManager.js'));

  // P1：首帧立即发出
  {
    resetForTests();
    const hub = createFrameHub({ minFrameIntervalMs: 100 });
    const got = [];
    hub.subscribe((f) => got.push(f));
    hub.pushFrame('JPEG-1');
    chk('P1 首帧立即发出（不等 interval）',
      got.length === 1 && got[0].seq === 1 && got[0].jpeg === 'JPEG-1',
      'got=' + JSON.stringify(got));
  }

  // P2：节流合并，最新帧胜出
  {
    resetForTests();
    const hub = createFrameHub({ minFrameIntervalMs: 200 });
    const got = [];
    hub.subscribe((f) => got.push(f));
    hub.pushFrame('A');
    await sleep(5);
    hub.pushFrame('B');
    hub.pushFrame('C'); // interval 内连续覆盖
    await sleep(250);
    chk('P2 interval 内连续 push 合并为一次且最新帧胜出',
      got.length === 2 && got[0].jpeg === 'A' && got[1].jpeg === 'C',
      'got=' + JSON.stringify(got.map((f) => f.jpeg)));
  }

  // P3：订阅计数生命周期
  {
    resetForTests();
    let starts = 0, stops = 0;
    const hub = createFrameHub({ minFrameIntervalMs: 50, onNeedStart: () => { starts++; }, onNeedStop: () => { stops++; } });
    const u1 = hub.subscribe(() => {});
    const u2 = hub.subscribe(() => {});
    chk('P3a 多订阅者只触发一次 start', starts === 1 && hub.subscriberCount() === 2, 'starts=' + starts);
    u1();
    chk('P3b 仍有订阅者时不 stop', stops === 0, 'stops=' + stops);
    u2();
    chk('P3c 最后订阅者离开触发 stop', stops === 1 && hub.subscriberCount() === 0, 'stops=' + stops);
  }

  // P4：interval 内挂起的 pending 帧在全部退订后不再发出（timer/pending 清理，无泄漏）
  {
    resetForTests();
    let stops = 0;
    const hub = createFrameHub({ minFrameIntervalMs: 300, onNeedStop: () => { stops++; } });
    const u = hub.subscribe(() => {});
    hub.pushFrame('FIRST');   // 首帧立即发（seq=1）
    hub.pushFrame('PENDING'); // interval 内挂起（timer + pending）
    u();                       // 全部退订 → 清 timer/pending + stop
    await sleep(400);
    chk('P4 退订后挂起的 pending 帧不再发出 + stop 触发',
      hub.latestSeq() === 1 && stops === 1,
      'latestSeq=' + hub.latestSeq() + ' stops=' + stops);
  }

  // P5：订阅者异常隔离
  {
    resetForTests();
    const hub = createFrameHub({ minFrameIntervalMs: 0 });
    const got = [];
    hub.subscribe(() => { throw new Error('bad subscriber'); });
    hub.subscribe((f) => got.push(f));
    hub.pushFrame('OK');
    chk('P5 单订阅者异常不中断广播', got.length === 1 && got[0].jpeg === 'OK', 'got=' + got.length);
  }

  // P6+P7：SSE 端点错误契约（tmp 隔离真实服务器）
  try {
    const os = require('os');
    const fs = require('fs');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-guard-'));
    const { spawn } = require('child_process');
    const PORT = 22750 + (process.pid % 50);
    const env = {
      ...process.env, PORT: String(PORT), AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 15).toString('base64'),
      DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '',
    };
    const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let srvLog = '';
    srv.stdout.on('data', (d) => { srvLog += d; });
    srv.stderr.on('data', (d) => { srvLog += d; });
    const waitReady = async () => {
      for (let i = 0; i < 40; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT}/api/browser/status`);
          if (r.ok) return true;
        } catch { /* not yet */ }
        await sleep(250);
      }
      return false;
    };
    const ready = await waitReady();
    if (!ready) throw new Error('server not ready: ' + srvLog.slice(-400));

    // P7：未知 profile → 404
    const r404 = await fetch(`http://127.0.0.1:${PORT}/api/browser/definitely-missing/stream`);
    chk('P7 SSE 端点未知 profile → 404 JSON', r404.status === 404, 'status=' + r404.status);

    // P6：真实存在但未运行的 profile → 400 JSON（先建一个 profile）
    const cr = await fetch(`http://127.0.0.1:${PORT}/api/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'c42-stream-probe' }),
    });
    const created = await cr.json().catch(() => ({}));
    const pid = created.id || created.profile?.id;
    if (!pid) {
      chk('P6 profile 创建探针', false, 'create resp=' + JSON.stringify(created).slice(0, 200));
    } else {
      const r400 = await fetch(`http://127.0.0.1:${PORT}/api/browser/${pid}/stream`);
      const body = await r400.json().catch(() => ({}));
      chk('P6 浏览器未运行 → 400 JSON（不挂起 SSE）',
        r400.status === 400 && body.ok === false && /未运行/.test(String(body.error || '')),
        'status=' + r400.status + ' body=' + JSON.stringify(body));
    }
    srv.kill();
  } catch (e) {
    chk('P6/P7 SSE 端点契约', false, e.message);
  }

  // P8：接线静态断言
  {
    const idx = read('server/index.js');
    const viewer = read('client/src/components/BrowserViewer.jsx');
    const routeWired = idx.includes("screencastManager.getHub(browserManager, p.id)")
      && idx.includes("browserRouter.get('/browser/:id/stream'")
      && idx.includes("event: frame\\ndata:");
    const viewerWired = viewer.includes("new EventSource(`/api/browser/${profileId}/stream`)")
      && viewer.includes("addEventListener('frame'")
      && viewer.includes("setMode('slow')") // 断线降级
      && viewer.includes("mode === 'stream' ? '● 实时流' : '低速模式'");
    chk('P8 接线：SSE 路由引用 FrameHub；Viewer 双模式 + EventSource + 断线降级',
      routeWired && viewerWired, 'route=' + routeWired + ' viewer=' + viewerWired);
  }

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail);
  if (fail > 0) { console.log('FAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
