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
 * ## 判据构成（= 主判据 ∨ 四项已登记条件 ⇒ 旧行为的**严格超集**）
 *   ① 唯一事实源 `credentialAuthorization.isCredentialAction`（英文词表 + credentialRef + 凭据动作类型）
 *   ② 登记项 a：`risk === 'CRITICAL'` —— 事实源不读 risk（风险由 schema/policy 定级）
 *   ③ 登记项 b：`type === 'delete'`  —— 事实源的 CREDENTIAL_ACTION_TYPES 不含 delete
 *   ④ 登记项 c：**子串**兼容面   —— 事实源是「归一后全等」，子串面严格宽于它
 *   ⑤ 登记项 d：**本地化写值语义面**（C144）—— 只在写值动作上生效（见下方常量块）
 *
 * ## 为什么登记项必须保留（删除任一 = **放宽**，须显式授权 + 独立回归）
 *   主判据是「归一后全等」，而历史实现是**子串**判定 —— 直接只留主判据会让
 *   `cardExpiry` / `cardholder` / `password_confirm` / `otp_code` 这类真实子串形态
 *   由 true 变 false（= 把凭据动作重新放回自动重做路径）。保留后本模块输出是旧行为的
 *   **严格超集**：只收紧、零放宽（C143 实测放宽面 0 / 10293 例电池）。
 *
 * ## ⚠️ 已登记的过判（C143 实测保留；C144 只修其中「写值」那一半）
 *   登记项 c 对**动作类型不敏感**：真实数据里「登录按钮」等 click 语义（CJK 凭据词 × click
 *   共 232 例）与 `product-card` / `待付款订单` 同族命中 ⇒ 无谓升级人工。
 *   与「合法凭据子串」（cardExpiry 等 1633 例）**不可分离**，删除即放宽。
 *   C144 的本地化层**只在写值动作**上生效，故这 232 例 click 面**一格未动**（仍未修）。
 *
 * ## ❌ 谁**不得**使用本模块
 *   · 授权闸 `credentialAuthorization.authorize` / `isCredentialAction` 的调用方（闸门口径必须纯）
 *   · 任何「跨域是否放行」判定 —— 本模块对动作类型不敏感，用作放行判据会误伤普通控件
 *
 * ## 依赖方向
 *   只 `require('./credentialAuthorization')`；事实源**零 require** ⇒ 无环依赖。
 *   ⚠️ 本模块的 `require` 数量被 C142 守护 A9 锚定为**恒 1**（改锚须显式授权），
 *      故登记项 d 的「写值动作类型」用**本地常量**表达，其真实性改由 C144 守护与
 *      `schema/action.js:ACTION_TYPES` 对拍（L16 形状/字段名真实性守护），不在此引入第二依赖。
 */

const credentialAuthorization = require('./credentialAuthorization');

/**
 * 子串兼容面（登记项 c）—— **全仓唯一定义处**。
 * 逐字承自 C142 前 `verifyFailed.js` / `runtime.js` 两份副本中的同一串（两份逐字相同）。
 * 只服务本模块；不得被授权闸引用。
 */
const CREDENTIAL_SUBSTRING_COMPAT_RE = /password|card|cvv|otp|支付|付款|登录|密码|卡号/;

/**
 * ── 登记项 d：本地化写值语义面（C144）────────────────────────────────────────
 *
 * ## 为什么需要它
 *   事实源 `CREDENTIAL_FIELDS` 是**纯英文**词表，登记项 c 的中文面只有
 *   「支付 / 付款 / 登录 / 密码 / 卡号」五个。于是在真实落盘数据（server/data + .benchmark，
 *   1051 个 JSON）里，以中文命名的**凭据字段语义**在**写值动作**上 fail-open：
 *     · 无 field、仅 semantic：去重 4 种取值、共 148 例
 *       （密码输入框 57 / 用户名输入框 42 / 邮箱输入框 35 / 手机号输入框 14），
 *       其中仅「密码输入框」被登记项 c 的中文面覆盖，其余 3 种恒 false；
 *     · 中文落在 field 侧同样存在（用户名输入框 30 / 用户名 14 / 邮箱 7 例），同样恒 false。
 *   后果与 17-A 同形态：**凭据动作失败被当作普通失败**，放回自动重做路径
 *   （把凭据再填进可能已漂移的页面）。
 *
 * ## 为什么必须按动作类型分层（本层的核心约束）
 *   同一批数据里 **click** 承载的是「动作 / 区域」而不是「字段」
 *   （登录按钮 / 登录表单区域 / 待支付订单 / 购买后页面状态 / 等待结算页面加载 …）。
 *   本地化词若不分动作无差别纳入，就会把这些普通控件一起升级人工
 *   ⇒ 违反事实源红线第 1 条（不得误伤普通控件）。故本层**只在写值动作**上生效。
 *
 * ## 为什么放在本模块而不是事实源
 *   事实源的定位是「授权闸纯口径（归一后全等）」，本层是**收紧**（fail closed 方向）
 *   的兼容扩面，口径不同源。分层理由见文件头「为什么单独成模块」。
 *
 * ## 零放宽
 *   本层只可能把 false 变 true（新增一条 `return true` 分支），叠加在原判据之后
 *   ⇒ 输出仍是旧行为的**严格超集**。删除任一登记项才是放宽（须显式授权 + 独立回归）。
 *
 * ## 锚定性（不靠注释约定，两条都在加载期断言）
 *   ① 每个词必须锚定一个**已在事实源 `CREDENTIAL_FIELDS` 中**的概念
 *      —— 否则词表与事实源脱钩，本层会变成「第二份口径」；
 *   ② 每个词必须与登记项 c 的子串面**不相交** —— 否则该条是**死条件**
 *      （c 已无条件 `return true`，本层那条永不产生行为差异）。
 *
 * ## ⚠️ 本层**不**纳入「手机号」
 *   「手机号」不锚定事实源任何概念 ⇒ 那是**扩概念**，不是本地化，属产品决策
 *   （真实数据 14 例，任务 objective 含手机号但均无 `credentialRef`）。
 *   本批有意留作登记缺口，在 C142 守护 G 组在册。
 *
 * ## 动作类型范围
 *   本批保守只取 `fill`。实测 `press` / `select` 与 `fill` 在本数据集上**结果完全等价**
 *   （收紧面与误伤面均无差异），故不纳入 —— 少一个未观测形状。
 */
const LOCALIZED_WRITE_ACTION_TYPES = ['fill'];

const LOCALIZED_CREDENTIAL_FIELD_WORDS = [
  { word: '邮箱', concept: 'email' },
  { word: '用户名', concept: 'username' },
  { word: '验证码', concept: 'otp' },
];

for (let i = 0; i < LOCALIZED_CREDENTIAL_FIELD_WORDS.length; i++) {
  const x = LOCALIZED_CREDENTIAL_FIELD_WORDS[i];
  if (credentialAuthorization.CREDENTIAL_FIELDS.indexOf(x.concept) < 0) {
    throw new Error('credentialRetryGuard: 本地化词「' + x.word + '」锚定的概念「'
      + x.concept + '」不在事实源 CREDENTIAL_FIELDS 中（词表与事实源脱钩）');
  }
  if (CREDENTIAL_SUBSTRING_COMPAT_RE.test(x.word)) {
    throw new Error('credentialRetryGuard: 本地化词「' + x.word
      + '」已被登记项 c 的子串面无条件覆盖 ⇒ 该条是死条件，应删除而非保留');
  }
}

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
  // ⑤ 登记项 d：本地化写值语义面（仅写值动作；口径与 ④ 复用同一个 f：field 优先、回退 semantic）
  if (f && LOCALIZED_WRITE_ACTION_TYPES.indexOf(a.type) >= 0) {
    for (let i = 0; i < LOCALIZED_CREDENTIAL_FIELD_WORDS.length; i++) {
      if (f.indexOf(LOCALIZED_CREDENTIAL_FIELD_WORDS[i].word) >= 0) return true;
    }
  }
  return false;
}

module.exports = {
  isCredentialActionBlockingRetry,
  CREDENTIAL_SUBSTRING_COMPAT_RE,
  LOCALIZED_WRITE_ACTION_TYPES,
  LOCALIZED_CREDENTIAL_FIELD_WORDS,
};
