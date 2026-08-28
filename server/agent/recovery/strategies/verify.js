'use strict';

// 策略：验证失败 → 重新观察后重试（runtime 每次 attempt 都重新观察）。

function getPreActions(attempts) {
  return [];
}

module.exports = { getPreActions };
