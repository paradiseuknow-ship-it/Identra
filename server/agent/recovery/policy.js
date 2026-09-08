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
  // C76 D1：SERVER_ERROR（5xx）此前未映射 → resolve 返回 null → runtime 只退避重试
  // 原动作，永远拿不到 timeout 策略的 wait/waitLong/reload 序列（recoveryManager 注释
  // 自述 waitLong 为「限流/5xx/异步一致性」设计，却路由不到 5xx，自相矛盾）。
  // 与 NETWORK_ERROR 同路（等待+重载），亦与 repairPlanner 的 SERVER_ERROR 映射对齐。
  SERVER_ERROR: 'timeout',
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
