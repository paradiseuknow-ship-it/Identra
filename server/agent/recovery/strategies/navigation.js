'use strict';

// 策略：导航失败 → 重载 → 返回后重载 → 等待。

const PRE_SEQUENCE = ['reload', 'back+reload', 'wait'];

function getPreActions(attempts) {
  return [PRE_SEQUENCE[Math.min(attempts, PRE_SEQUENCE.length - 1)]];
}

module.exports = { getPreActions };
