'use strict';

// Recovery Policy：错误类别 → 恢复策略解析。
// 策略以独立文件存放（strategies/），新增策略（popup/cookieBanner/loginExpired）不污染主流程。

const STRATEGY_MAP = {
  ELEMENT_NOT_FOUND: 'elementMissing',
  ELEMENT_NOT_INTERACTABLE: 'elementMissing',
  TIMEOUT: 'timeout',
  PAGE_NOT_READY: 'timeout',
  NETWORK_ERROR: 'timeout',
  NAVIGATION_FAILED: 'navigation',
  VERIFICATION_FAILED: 'verify',
  BROWSER_CRASH: 'relaunch',
  CREDENTIAL_MISSING: null,   // 不可自动恢复
  APPROVAL_REQUIRED: null,    // 需人工
  UNKNOWN: 'generic',
};

function resolve(category) {
  return STRATEGY_MAP[category] || null;
}

module.exports = { STRATEGY_MAP, resolve };
