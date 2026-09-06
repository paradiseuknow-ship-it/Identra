'use strict';

// 策略：验证失败 → 依据 Diagnosis 决定前置动作。
//
// 改造前：getPreActions() 恒返回 []，等价于「把同一个动作原样再执行一次」。
// STEP 0 取证：phase68 中 VERIFY_FAILED 占 51.3%，且全部是这种零信息重试 ——
// 页面明明已经写了「该邮箱已被注册」，系统却在重打同一个注册动作 3 次。
//
// 改造后：前置动作由 Diagnosis.retryPolicy 驱动（表在 diagnosis/failureDiagnoser.js，单一真源）。
// 红线：本模块只决定「重试前先做什么」，不判定成功、不改验证阈值、不绕过验证码/3DS/风控。

const { PRE_ACTIONS_BY_POLICY } = require('../../diagnosis/failureDiagnoser');

// R9 状态重置守卫（2026-09-04）：verify 策略的语义是「不重执行动作，重观察 + 重验证」。
// reload/back 型前置动作与本语义互斥：
//   - 客户端状态（SPA / JS 渲染的登录态、确认提示、导出结果）：reload 直接清空一切，
//     把一次可重观察的验证失败变成不可恢复的 churn。
//     实证：run4 + 双诊断 rw.026（.benchmark/run4_diag/、run4_diag2/，E3.1-DIAG +
//     agent.repairing 事件 + 截图铁证）——导出点击 SUCCESS 后 text_present 验证失败，
//     重试序列第 2/3 步 reload → 登录态与导出提示全部蒸发（此后所有截图均为裸登录页），
//     17-18 attempts 烧尽 240s deadline。
//   - 服务端持久化结果：重观察读 live DOM 本就足够，reload 从不必要。
// 页面卡死 / 导航失效场景由 timeout / navigation 策略保留 reload，不受本守卫影响；
// generic 策略（UNKNOWN 类）同样保留原表行为。
const STATE_RESET_ACTIONS = new Set(['reload', 'back+reload']);

function getPreActions(attempts, ctx = {}) {
  const d = ctx.diagnosis;
  const policy = d && d.retryPolicy;
  if (!policy) return [];
  const seq = PRE_ACTIONS_BY_POLICY[policy] || [];
  return seq.filter((a) => !STATE_RESET_ACTIONS.has(a));
}

module.exports = { getPreActions };
