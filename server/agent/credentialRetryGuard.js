'use strict';

/**
 * credentialRetryGuard —— 「凭据动作 ⇒ 阻断自动重做」族的**唯一实现**（C143）。
 *
 * ## 这一族是什么
 *   两个消费方都问同一个问题：「该动作失败后，是否**不要**自动重做（重执行 / REPLAN），
 *   而应交人工？」—— 因为把凭据再次填进可能已漂移的页面，正是 17-A 的原始事故形态。
 *     · `server/agent/repair/strategies/verifyFailed.js`：真实失败 ⇒ `needsApproval + REAUTH_OR_PAUSE`
 *     · `server/agent/runtime.js`（`isReplanCandidate`）：⇒ 不进自动 REPLAN
 *
 * ## 为什么单独成模块，而不是放进 credentialAuthorization.js
 *   事实源 `credentialAuthorization` 的定位是**授权闸的唯一口径**：纯英文词表 + 「归一后
 *   **全等**」。而本族带**历史兼容包袱**（子串正则、`risk`、`delete`），且其中子串面
 *   **对本模块的语义词表无感知**——放进事实源会被误用于闸门，违反闸门红线第 1 条
 *   （不得误伤普通控件）。分层放置：事实源保持"纯口径"，本模块承载"兼容包袱 + 使用边界"。
 *
 * ## C143 缺陷背景（本模块的成立理由）
 *   `runtime.js` 内 `isCredentialishStep` 与 `verifyFailed.js` 内旧实现**逐字同形**，
 *   即同一判据在仓库里存在**两份**副本。C142 的全仓横扫按**函数名**分组找「同名多实现」，
 *   而这两份**异名同义**（`isCredentialishStep` / `isCredentialAction`）⇒ 结构性漏检，
 *   于是 C142 只收口了 verifyFailed 那一份，runtime 侧**仍在漏判 15 项凭据动作**。
 *   ⇒ 本模块 = 该族唯一的实现；两份副本的差异面从此不可能再各自漂移。
 *
 * ## 判据构成（= 主判据 ∨ 三项已登记条件 ⇒ 旧行为的**严格超集**）
 *   ① 唯一事实源 `credentialAuthorization.isCredentialAction`（英文词表 + credentialRef + 凭据动作类型）
 *   ② 登记项 a：`risk === 'CRITICAL'` —— 事实源不读 risk（风险由 schema/policy 定级）
 *   ③ 登记项 b：`type === 'delete'`  —— 事实源的 CREDENTIAL_ACTION_TYPES 不含 delete
 *   ④ 登记项 c：**子串**兼容面   —— 事实源是「归一后全等」，子串面严格宽于它
 *
 * ## 为什么登记项必须保留（删除任一 = **放宽**，须显式授权 + 独立回归）
 *   主判据是「归一后全等」，而历史实现是**子串**判定 —— 直接只留主判据会让
 *   `cardExpiry` / `cardholder` / `password_confirm` / `otp_code` 这类真实子串形态
 *   由 true 变 false（= 把凭据动作重新放回自动重做路径）。保留后本模块输出是旧行为的
 *   **严格超集**：只收紧、零放宽（C143 实测放宽面 0 / 10293 例电池）。
 *
 * ## ⚠️ 已登记的过判（C143 实测保留，本批不修）
 *   登记项 c 对**动作类型不敏感**：真实数据里「登录按钮」等 click 语义（CJK 凭据词 × click
 *   共 232 例）与 `product-card` / `待付款订单` 同族命中 ⇒ 无谓升级人工。
 *   与「合法凭据子串」（cardExpiry 等 1633 例）**不可分离**，删除即放宽。
 *   修正需与本地化词表一并做「按动作类型分层」，另批立项。
 *
 * ## ❌ 谁**不得**使用本模块
 *   · 授权闸 `credentialAuthorization.authorize` / `isCredentialAction` 的调用方（闸门口径必须纯）
 *   · 任何「跨域是否放行」判定 —— 本模块对动作类型不敏感，用作放行判据会误伤普通控件
 *
 * ## 依赖方向
 *   只 `require('./credentialAuthorization')`；事实源**零 require** ⇒ 无环依赖。
 */

const credentialAuthorization = require('./credentialAuthorization');

/**
 * 子串兼容面（登记项 c）—— **全仓唯一定义处**。
 * 逐字承自 C142 前 `verifyFailed.js` / `runtime.js` 两份副本中的同一串（两份逐字相同）。
 * 只服务本模块；不得被授权闸引用。
 */
const CREDENTIAL_SUBSTRING_COMPAT_RE = /password|card|cvv|otp|支付|付款|登录|密码|卡号/;

/**
 * 该动作失败后是否应**阻断自动重做**（唯一实现）。
 * @param {object} action 生产 Action（不是 step 包装体）
 * @returns {boolean}
 */
function isCredentialActionBlockingRetry(action) {
  const a = action || {};
  // ① 唯一事实源（覆盖 15 项历史漏判：email / credentialRef / username / user_id /
  //    passwd / pwd / cvc / securitycode / expiry / ssn / token / code / Password / CVV / 验证码）
  if (credentialAuthorization.isCredentialAction(a)) return true;
  // ② 登记项 a：风险等级（事实源不读 risk）
  if (a.risk === 'CRITICAL') return true;
  // ③ 登记项 b：删除（事实源的凭据动作类型不含 delete）
  if (a.type === 'delete') return true;
  // ④ 登记项 c：子串兼容面（逐字保留历史写法，含 `a.target &&` 的短路语义）
  const f = String((a.target && (a.target.field || a.target.semantic)) || '');
  if (CREDENTIAL_SUBSTRING_COMPAT_RE.test(f)) return true;
  return false;
}

module.exports = {
  isCredentialActionBlockingRetry,
  CREDENTIAL_SUBSTRING_COMPAT_RE,
};
