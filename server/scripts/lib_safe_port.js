'use strict';
// C94 — Chrome unsafe-port 安全监听原语（共享，供全部带真实 Chromium goto 的测试消费）。
//
// 根因（.benchmark/phase9_regression_20260909_094756.txt 实证）：
//   测试用 server.listen(0) 取临时端口，OS 动态端口分配可能落在 Chrome 的
//   unsafe-port 黑名单内（本次命中 6000 = X11），page.goto 直接
//   FATAL net::ERR_UNSAFE_PORT → 套件「无统计行」→ phase9 OK=182/BAD=1 假红。
//   这是概率性 flake：端口不受控，任何 listen(0)+goto 测试都可能随机踩中。
//
// 设计契约：listenSafe(server, host) 不再使用 listen(0)，改为【显式候选端口】：
//   每次尝试从非特权段随机取一个不在 Chromium kRestrictedPorts 黑名单内的端口
//   直接 listen；EADDRINUSE / 地址未就绪 → close 后换下一候选（上限 50 次）。
//   ⚠️ 同对象 re-listen 仅允许发生在「从未成功绑定」的实例上（EADDRINUSE 路径，
//   C94 批内实证可靠）；成功绑定后再 close+re-listen 的实例 handle.address()
//   恒返回 null（Node 22 实证），必须避免——显式候选端口方案天然绕开该路径。
//   返回已 listening 的原 server（调用方契约零变化，消费 .address().port / .close()）。
//   UNSAFE_PORTS 与 Chromium net_error_list kRestrictedPorts 一致（80 项）。

const UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

function isUnsafePort(port) {
  return UNSAFE_PORTS.has(Number(port));
}

// 随机取一个非特权且不在黑名单内的候选端口
function randomSafePort() {
  let port;
  do {
    port = 1024 + Math.floor(Math.random() * (65536 - 1024));
  } while (isUnsafePort(port));
  return port;
}

// 监听并保证端口不在 Chrome 黑名单内；返回 Promise<server>（已 listening）。
function listenSafe(server, host) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryNext = () => {
      attempts++;
      if (attempts > 50) {
        reject(new Error('listenSafe: no safe port after 50 candidate attempts'));
        return;
      }
      const port = randomSafePort();
      const onError = (err) => {
        cleanup();
        // 从未成功绑定的实例可安全关闭后重试（EADDRINUSE 路径，Node 22 实证可靠）
        server.close(() => tryNext());
      };
      const onListening = () => {
        cleanup();
        const addr = server.address();
        if (!addr || isUnsafePort(addr.port)) {
          // 理论不可达（显式候选端口成功绑定后地址必然就绪）；防御性兜底不可重绑同对象，
          // 直接 fail-loud，避免同对象 re-listen 死循环。
          reject(new Error('listenSafe: bound address not ready (port=' + port + ')'));
          return;
        }
        resolve(server);
      };
      const cleanup = () => {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    tryNext();
  });
}

module.exports = { listenSafe, isUnsafePort, UNSAFE_PORTS, randomSafePort };
