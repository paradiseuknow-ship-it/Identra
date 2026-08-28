'use strict';

// 策略：未知错误 → 原动作直接重试（无特殊前置动作）。

function getPreActions(attempts) {
  return [];
}

module.exports = { getPreActions };
