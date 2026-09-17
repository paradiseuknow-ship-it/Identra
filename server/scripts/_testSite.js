'use strict';

// 共享 test-site 启动助手（浏览器类测试专用）。
// 关键：带版本探针（/ping）。若 9555 上跑的是残留旧进程（路由不全），
// 自动杀掉旧进程并用当前代码重新拉起，避免"404 当成功/元素为空"的假阳性。

const { spawn, exec } = require('child_process');
const net = require('net');
const path = require('path');
const http = require('http');

const PORT = 9555;
const VERSION = 10; // 必须与 server/test-site/server.js 的 VERSION 一致（C140：9→10，新增路由）
let proc = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:' + PORT + '/ping', { timeout: 2000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function killOnPort(port) {
  return new Promise((resolve) => {
    exec('netstat -ano | grep ":' + port + '" | grep LISTENING', (err, stdout) => {
      const pids = new Set((stdout || '').split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean));
      for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch (e) {} }
      setTimeout(resolve, 500);
    });
  });
}

async function ensure() {
  // 已有进程且版本匹配 → 复用
  if (await portOpen(PORT)) {
    const p = await ping();
    if (p && p.version === VERSION) return;
    await killOnPort(PORT); // 残留旧进程 → 杀掉重开
  }
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'test-site', 'server.js')], { stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {
    if (await portOpen(PORT)) {
      const p = await ping();
      if (p && p.version === VERSION) return;
    }
    await sleep(300);
  }
  throw new Error('test-site 启动失败（版本不匹配或端口不可用）');
}

// C140：夹具计数器复位。test-site 进程会跨套件/跨次回归存活（端口已有且版本匹配时 ensure()
// 不重启进程）⇒ 计数不复位会让「慢 N 次后转快」类夹具在后一次运行时恒快，断言静默变红。
function resetFlaky4() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:' + PORT + '/flaky4-reset', { timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function cleanup() {
  if (proc) { try { proc.kill(); } catch (e) {} proc = null; }
}

module.exports = { ensure, cleanup, resetFlaky4, PORT, VERSION, sleep };
