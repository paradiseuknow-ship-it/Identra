'use strict';

// 升级/失败归因统计口径 v2（2026-08-31 P1 收口阶段 ② escalationSplit 口径修复）。
//
// 背景（最终 100-task 归因报告 §3.2）：旧 escalationSplit 为粗二分
//（codes 含 CREDENTIAL|POLICY|BLOCK|APPROVAL 或 final.error 文本 /凭据|凭证|审批|支付.*需/ → CREDIBLE，否则 REAL），
// 导致 21 个「验证反复失败触发的人工升级」（工程型，task.escalationKind='verification'）
// 全部被误计入 REAL escalation，污染「Real escalation ≤ 30%」门槛的语义。
//
// 纪律边界（用户指令 ③）：
//   - 只改统计分类，不改执行/升级语义（runtime/taskManager 一行不动）；
//   - 不修改 final.error 文本来「修正统计」；
//   - 保留原始 taxonomy（classifyTaxonomy / escalationSplit legacy 行为不变）；
//   - 输入仅取逐任务原始事件链字段（final.status / final.escalationKind / final.error / codes），
//     纯函数、无副作用 —— 任何分类结果都可由逐任务原始事件链复核。
//
// 分类集合（五类 + REAL 单列）：
//   CREDIBLE_BUSINESS    凭据/支付/审批等预期安全门控升级（能力边界，非缺陷）
//   VERIFY_RETRY         验证反复失败触发的升级（工程型）—— 不再计入 REAL
//   TIMEOUT              超时（任务级或动作级）
//   CANCELLED            任务取消 / 调度超时取消
//   ENGINEERING_FAILURE  元素定位(resolver)/执行(execution)/恢复(recovery)等工程型失败
//   REAL                 真实业务拒绝（CAPTCHA/OTP/风控/滑块等）—— 唯一计入 REAL 的类别

const CLASS_KEYS = ['CREDIBLE_BUSINESS', 'VERIFY_RETRY', 'TIMEOUT', 'CANCELLED', 'ENGINEERING_FAILURE', 'REAL'];

// 真实业务拒绝的显式信号（窄匹配，避免吞掉 VERIFY_RETRY/CREDIBLE 场景）。
// 注意：不用宽泛的「拒绝/denied/forbidden」—— 凭据门控与验证失败的消息里也可能出现这些词。
const BUSINESS_REFUSAL_RE = /captcha|验证码|human.?verification|otp|一次性密码|风控|滑块|cloudflare|denied by site|access denied by/i;

// 判定顺序（保证口径可审计）：
//   1. SUCCESS → null；CANCELLED → CANCELLED（状态优先，取消不参与升级归因）
//   2. 真实业务拒绝显式信号 → REAL（优先于 kind：验证重试若因 CAPTCHA 耗尽，本质是业务拒绝）
//   3. task.escalationKind（taskManager 持久化的原始事件链字段）映射：
//      verification → VERIFY_RETRY；credential/payment/permission/CRITICAL → CREDIBLE_BUSINESS；
//      timeout → TIMEOUT；resolver/execution/recovery/其它 → ENGINEERING_FAILURE
//   4. 无持久化 kind（FAILED / TIMEOUT 兜底对象等路径）→ codes + final.error 文本回退
function classifyEscalation(final, codes) {
  const status = final && final.status;
  if (!status || status === 'SUCCESS') return null;
  const errText = String((final && final.error) || '');
  if (status === 'CANCELLED') {
    // harness deadline 取消（error 带 benchmark_deadline 标记）本质是任务级超时，
    // 与用户/调度取消分开（口径修复 2026-08-31），否则 TIMEOUT 被错记进 CANCELLED。
    if (/benchmark_deadline/.test(errText)) return 'TIMEOUT';
    return 'CANCELLED';
  }
  const codeList = (Array.isArray(codes) ? codes : []).map((c) => String(c || ''));
  const codeStr = codeList.join(' ');
  const businessRefusal = BUSINESS_REFUSAL_RE.test(errText) || codeList.some((c) => BUSINESS_REFUSAL_RE.test(c));
  if (businessRefusal) return 'REAL';

  const kind = String((final && final.escalationKind) || '').toLowerCase();
  if (kind) {
    if (kind === 'verification') return 'VERIFY_RETRY';
    if (kind === 'credential' || kind === 'payment' || kind === 'permission' || kind === 'critical') return 'CREDIBLE_BUSINESS';
    if (kind === 'timeout') return 'TIMEOUT';
    return 'ENGINEERING_FAILURE';
  }

  // 回退：无持久化 kind —— 与旧 escalationSplit 同源的信号集，但按五类输出
  if (codeList.some((c) => /VERIF|VERIFICATION/.test(c)) || /验证.*(失败|未通过)|verify/i.test(errText)) return 'VERIFY_RETRY';
  if (codeList.some((c) => /CREDENTIAL|POLICY|BLOCK|APPROVAL/.test(c)) || /凭据|凭证|审批|支付.*需/.test(errText)) return 'CREDIBLE_BUSINESS';
  if (status === 'TIMEOUT' || /timeout|ETIMEDOUT|ECONN/i.test(codeStr)) return 'TIMEOUT';
  return 'ENGINEERING_FAILURE';
}

module.exports = { classifyEscalation, CLASS_KEYS, BUSINESS_REFUSAL_RE };
