'use strict';

// 策略：超时 / 页面未就绪 / 网络错误 → 等待 → 重载 → 返回后重载。

const PRE_SEQUENCE = ['wait', 'reload', 'back+reload'];

function getPreActions(attempts) {
  return [PRE_SEQUENCE[Math.min(attempts, PRE_SEQUENCE.length - 1)]];
}

module.exports = { getPreActions };
