# PRODUCT_CORE_ROADMAP

> 版本：v1.0  
> 生成日期：2026-08-29  
> 状态：**路线图 P0 全清 + P1 已修：CAP-E5 / CAP-E6 / SEC-E7 / CAP-L1 / CAP-L2 / CAP-F1 / CAP-F2 / CAP-K1 / CAP-K2 / CAP-K3 / CAP-O1 / CAP-M1 / CAP-C1 / CAP-O2 / CAP-A1 / CAP-B1（截至 2026-08-30，STEP 16）。P0/P1/P2 产品化缺口全部清零。STEP 11 顺带修复存量 P0：大量 Profile 目录下启动事件循环冻结（spawnSync×N → O(1) 枚举）。STEP 17 真实反检测站点验证（2026-08-30）：CreepJS 13/13 ×2 + Iphey reliable——同 profile 跨会话 FP ID/UA/canvas 稳定、异号异指纹、WebRTC mDNS 掩码无泄露；已知边界：headless 模式被 CreepJS 识别（67%），反检测强场景需有界面模式（harness `server/scripts/verify_antidetect_sites.js`）。STEP 18 headless/geo 实证（2026-08-30）：CreepJS headless 检出 67% vs headful 33%——反检测强场景必须 headful；geo 三元一致（出口 IP→指纹→页内时区/语言）全链路打通；连带修复 `fetchEgressIpDirect` 单源 ipify 在 CN 直连被 RST → 三源回退+超时（harness `server/scripts/verify_headless_and_geo.js`）。STEP 19 headless 信号逐项消隐（2026-08-30）：CreepJS 模态框取证拿到逐信号清单——修复 GPU 无条件禁用（headless WebGL 恢复可用 + hardwareAcceleration 旋钮生效）、WEBGL 池 OS 感知（Windows 不再抽到 Apple GPU）、outer>=inner、Notification.permission denied→default、SCREENS 池剔除 1280x720；严格版剩余信号（webDriverIsOn/hasHeadlessWorkerUA）定位到 Worker/UA-CH 层（addInitScript 不可达），出路为 CDP worker 注入或 hidden-headful（harness `server/scripts/verify_headless_signals.js`）。STEP 20 hidden-headful 模式（2026-08-30）：`launchBehavior.hiddenWindow=true` = 有界面但窗口移出屏幕（`--window-position=-32000,-32000` + 禁 backgrounding/renderer-backgrounding 节流）——真实 headful Chrome 进程，UA/Worker/UA-CH 全真，从根上消除 STEP 19 定位的 Worker/UA-CH 层严格信号；与 useRealScreen 互斥（off-screen 窗口无法最大化，走 fp.screen 固定视口分支，截图稳定）。CreepJS 实证 13/13 ×2：headless% 33（headful 等效）、webdriver=false、UA 无 Headless、离屏截图 621KB 可用、screenX=-27355 离屏生效、visibilityState=visible、同 profile 跨会话 FP ID 一致（harness `server/scripts/verify_hidden_headful.js`）。STEP 21 Pixelscan 真实站点验证（2026-08-30，hidden-headful 形态）：14/14 ×2——Bot check「No automated behavior detected」通过、webdriver=false、HTTP UA===JS UA、WebGL 非 Apple、跨会话 Canvas/WebGL/AudioContext/Font Hash 全一致；诚实记录边界：Pixelscan 比 CreepJS 激进，Fingerprint 卡标记「Masking detected」+ Browser 卡 FAIL（多浏览器特征嗅探），status-bar 恒停轮询文案，完成判据须用明细区填充度（harness `server/scripts/verify_pixelscan.js`，探针 `probe_pixelscan.js`）。STEP 22 Pixelscan 归因实验（2026-08-30，8/8 ×2）：A（产品注入）vs B（同启动条件无注入原生 Chrome 对照）——**Browser 卡归因 H1 注入痕迹**（仅产品组 FAIL，对照组通过，多浏览器特征嗅探源自指纹注入层，转入对抗研究）；**反直觉强证据：对照组 Bot check FAIL（Automated behavior detected, webdriver=true）而产品组 PASS——注入层确实掩盖 Playwright 自动化痕迹，产品价值直接实证**；Masking 卡两侧本次均未触发（CLEAN_BOTH，依赖扫描后段，单次快照不可作稳定判据）（harness `server/scripts/verify_pixelscan_attribution.js`）。STEP 23 注入层嗅探特征消隐（2026-08-30，diff harness 8/8 ×2）：产品 vs 原生对照组全信号 battery diff（95 信号），定位并修复 6 类注入痕迹——①插件池 Chrome~90 老清单→现代 5 插件 PDF Viewer 系列（Pixelscan 古老特征签名头号嫌疑）；②whiten toString 保留函数名 + 显式名参数（V8 不对属性赋值推断函数名）+ 覆盖面补齐 geo/media/speech；③navigator/screen/plugins/userAgentData 描述符迁原型（own:JS-get→proto:native-get，位置与原生一致）；④移除 chrome.runtime/webstore 多余 mock（真实 Chrome 151 只有 loadTimes/csi/app）；⑤brands GREASE 现代化（Not?A_Brand v24→Not=A?Brand v99 首位）；⑥移除非原生 navigator.deviceName/macAddress 注入。**白名单外候选 17→0**；终极实测：Pixelscan Browser 卡 **FAIL→PASS**（H1 注入痕迹消除），CreepJS 13/13 保持、Pixelscan 14/14 保持、双回归 51/0+44/0（harness `server/scripts/verify_injection_diff.js`）。STEP 19R 证据归因审计（2026-08-30，纪律升级：第三方检测仅作 Evidence，禁检测站点特定优化）：3 模式 × 25 信号族审计（product-headless / product-hidden-headful / control-headed 原生对照，harness `server/scripts/audit_headless_signals.js`，报告 `docs/product/STEP19_HEADLESS_SIGNAL_AUDIT.md` + `STEP19_HEADLESS_SIGNAL_AUDIT.json`）——Metric A Contract Consistency **PASS 13/13 ×2**、Metric B Browser Reality **PASS**（新增 2 处 B 类修复：①mimeTypes 形状 5→2 共享实例对齐原生（enabledPlugin→'PDF Viewer'、plugins[i].mimeTypes[j]===mimeTypes[j] 恒等）；②permissions.query 原生映射 default→prompt）；Metric C 第三方检测降级为证据。纯 headless 残余 Worker/UA-CH 层判 **C 类架构固有限制**——产品边界=hidden-headful（已落地），反检测强场景必须 hiddenWindow；**STEP 19 STOP — remaining signals are architectural / detection-specific**；STEP 24「Masking 卡对抗」按新纪律判 D 类中止。工程测试 `test_step19_signal_shape.js` 10/10 ×2。STEP 19R 追加 FIX-3 层一致性（B 类）：`applyClientHints`（网络层 CDP 头）与 inject.js（JS 层 userAgentData）两套实现互相矛盾（GREASE 旧 Not?A_Brand v24 vs 现代 Not=A?Brand v99；platformVersion Windows 10.0.0 vs 15.0.0）——真实 Chrome 两层恒一致，已逐字段统一；新增 `test_step19_layer_consistency.js`（本地 HTTP server 捕获头 vs 页内 JS 比对，L0–L8 共 11 断言）11/11 ×2；并实证版本对齐无残留（147-seed→引擎 151：UA/sec-ch-ua/fullVersionList/uaFullVersion 四处全对齐），STEP 24 留档「对齐型 seed Browser 卡单次 FAIL」闭环为站点侧判定波动。hiddenWindow 前端 UI 开关（2026-08-30）：ProfileEditor「启动时行为」新增「隐身窗口模式」Toggle（launchBehavior.hiddenWindow），三处默认对象补齐，重打包 dist（index-BmXdkMwA.js），E2E 冒烟（API 落盘 + 静态服务 + bundle 文案）全过；server 零改动，回归沿用 FIX-3 后基线。STEP 21B 决策（2026-08-30）：**方案 B**——CAP-M1 现状满足单进程商业化需求；六项缺口（once/daily/weekly/cron 完整调度语义 / workspace concurrency limit / cross-instance exactly-once / per-run durable idempotency token / lastRunStatus 聚合 / template entity 拆分）**记录在案、暂不实施**；反检测验证路线正式 STOP（CreepJS/Pixelscan 仅作 Evidence）；正式转入 **P2-C「AI Operator Business E2E」**——Business Success 为北极星，首批 Scenario A(Login)/C(Form Fill)/E(Multi-step)，真实链路（真实 browserManager/taskManager/observation/verification/memory，禁 mock 造成功）。**STEP 22 Business E2E Verification Hardening + Secrets Workspace Isolation（2026-08-30）：①I1 /secrets 安全前置——三路由接 identity/workspace（POST 盖章 workspaceId/createdBy+credential:manage RBAC、GET filterByWorkspace+脱敏视图、新增 DELETE assertCanAccessResource），调用方伪造 workspaceId 失效，安全矩阵 19 项 ×2；②V1 验证证据扩展——新增 storage（exists/equals，复用页内 redact 单一真源，cache-hit 刷新）与 url_pattern（真实 page.url()，非法正则 fail-closed FAIL）证据类型，显式 opt-in persistAfterReload（reload→fresh observation→二次合约验证，推导合约不携带该字段故默认路径零改动）；③真实测试站三场景 E2E（A Login vault+credentialRef→LOGIN_SUCCESS→reload 复验 / C Form url_pattern+storage 合约→持久化重填充 / E Multi-step 确定性失败注入→ELEMENT_NOT_FOUND 诊断→退避重试→SUCCESS）+ F1/F2 失败注入（状态丢失→HUMAN_ESCALATION、reload 超时→VERIFY_FAILED）；④实证机制事实：click 对未挂载元素 auto-wait 不受 timeoutMs 约束（humanClick→boundingBox），确定性注入正解=挂载即 display:none→boundingBox null→真实 ELEMENT_NOT_FOUND；⑤schema/action.js VERIFICATION_TYPES 白名单补齐 field_value/field_checked/url_pattern/storage（B 类一致性）；⑥harness 63/0 ×2 幂等（隔离 FPB_DATA_DIR），双回归 54/0+47/0（基线 53/0+46/0）；红线 audit 确认禁止清单零触碰；完整报告 docs/product/STEP22_BUSINESS_E2E_RESULT.md（harness server/scripts/test_step22_business_e2e.js）。**  
> 前序文档：`PRODUCT_ARCHITECTURE.md`（架构原则）/ `PRODUCT_CAPABILITY_MATRIX.md`（旧 A–J 分组）/ `PRODUCT_GAP_AUDIT.md`（旧缺口审计）  
> 本文档取代后两者的能力分组与优先级定义。旧文档保留作为历史取证，不再作为排期依据。

---

## 0. 本次纠偏的性质

**这是一次产品方向纠偏，不是一次代码重构。**

仓库当前形态可以用一句话概括，也是本路线图要消除的核心矛盾：

> 这里有两个成熟度相差 2–3 个量级的产品。  
> **产品一「指纹浏览器」**：可用、完整、接近商业级。  
> **产品二「AI Browser Operator」**：架构罕见地完整（planner / runtime / resolver / verification / observation / VIL / repair / recovery / memory / failure intelligence / browser pool / scheduler 全都在），  
> 但在真实业务上**成功率 6/100，80% 的任务以升级告终**。

过去若干轮开发由 Benchmark 驱动，结果是：**工程指标在涨，业务指标不动。**  
本文档把优先级锚点从「benchmark 分数」整体搬回「真实商业产品能力」。

### 0.1 北极星（唯一）

> 用户只需要告诉 AI：**「我要在这个网站完成什么事情」**。  
> 不需要告诉他点击哪个按钮、填哪个 selector、等几秒。

任何让这句话更接近现实的工作，优先级高于一切。

### 0.2 四问决策闸门（每个开发任务必须先过）

| #  | 问题                     | 否决含义                       |
| -- | ---------------------- | -------------------------- |
| Q1 | 真实用户会不会用？              | 只有 benchmark 会用 → 停        |
| Q2 | 未知网站能不能用？              | 只对已知 fixture 生效 → 停        |
| Q3 | 是通用能力还是特例？             | 需要 `if site === X` 才成立 → 停 |
| Q4 | 是否增强「AI 浏览器自动完成任务」的能力？ | 只增强"跑分" → 停                |

**四问皆否则直接停止。**&#x672C;文档 P0/P1/P2 每一项都附四问答复。

---

## 1. Product Definition

### 1.1 一句话定义

> **一个类似 AdsPower / 比特浏览器的 AI Fingerprint Browser，  
> 但 AI 不只是负责生成指纹，而是能够在用户提供目标网站、代理、账号凭据和经过用户授权的支付信息后，  
> 像人类一样完成真实网站操作，并能够观察页面、分析网络请求和错误、判断失败原因、自动恢复、重新尝试，  
> 并持续从历史执行结果中学习。**

### 1.2 拆解定义中的四个不可省略成分

| 成分                    | 含义                  | 缺了会变成什么             |
| --------------------- | ------------------- | ------------------- |
| **指纹浏览器底座**           | 多 Profile、多指纹、多代理隔离 | 一个普通的 Playwright 脚本 |
| **像人类一样操作真实网站**       | 目标驱动，非 selector 驱动  | 一个 RPA 录制回放工具       |
| **观察 / 分析 / 诊断 / 恢复** | 失败后**分析**而非 retry   | 一个会重试的点击器           |
| **从真实结果中学习**          | 学习源是业务验证结果          | 一个不断自我强化的错误记忆库      |

### 1.3 明确不是什么

- ❌ 不是一个跑分更高的 benchmark agent
- ❌ 不是一个 SaaS 专用自动化脚本
- ❌ 不是一个把五个 mock 站点跑通的演示品
- ❌ 不是一个「点得快、点得多」的乱点机器（用户 §十四：最终产品不是乱点）

### 1.4 P0 原则：真实网站优先

`mock-site/`、`benchmark/`、`server/scenarios/*`、`saas/login.html`、`ecommerce/cart.html`  
**只能作为自动化回归测试资产，绝不能成为产品能力定义。**

判定规则（对任何"新功能"都适用）：

> 这个功能是不是**现实网站也需要**？  
> 如果这个能力只在 mock 站点上有意义 → 它不是产品能力，是测试夹具。



---

## 2. User Journey

### 2.1 主用户旅程（付费用户视角）

```
① 创建 Profile
   用户设定：目标网站 + 代理 + 账号凭据 +（可选）授权支付信息
   [Profile 七要素]
   1. 身份（fingerprint）      → A
   2. 网络（proxy）            → B
   3. 凭据（credentials）      → C + N（加密存储）
   4. 支付授权（payment grant）→ L（加密 / 最小权限 / 可撤销）
   5. 目标（objective）        → D
   6. 边界（policy：能做什么/不能做什么）→ N
   7. 记忆（该站点的历史经验）→ K

② 下达目标（自然语言，非步骤）
   "帮我在 webflow.com 注册一个账号，选择 Starter 套餐，完成购买并截图确认"

③ AI 自主执行（用户不看过程，只看结果）
   Intent → Target → Page → Element → Action → Observation
          → Business State →（失败）→ Recovery

④ 遇到阻塞时请求介入
   CAPTCHA / 短信验证码 / 需要人工决策 → 升级给用户
   用户处理后 → **任务必须能续跑**（当前不能，见 CAP-J1）

⑤ 拿到可验证的结果
   不是"我点过了"，而是"订单号 XXX，已扣款 $14，截图在此"

⑥ 下一次更快
   同一网站第二次执行，AI 应已记住元素位置与流程
```

### 2.2 六个必须打通的 Scenario

| ID      | Scenario    | 要求          | 当前状态                                                                         |
| ------- | ----------- | ----------- | ---------------------------------------------------------------------------- |
| **001** | 打开并理解一个未知页面 | 真实网站 + 未知网站 | ⚠️ 能打开，但"理解"被站点类型分类污染（CAP-E2）                                                |
| **002** | 注册账号        | 真实网站 + 未知网站 | ❌ 卡在中文 label 定位（CAP-E5-LABEL-RANKING）+ 无 `ACCOUNT_ALREADY_EXISTS` 语义（CAP-I1） |
| **003** | 登录          | 真实网站 + 未知网站 | ⚠️ 登录态验证弱，`login_state` 契约单点                                                 |
| **004** | 选择会员套餐      | 真实网站 + 未知网站 | ⚠️ 多标签 / 弹窗动作未登记（CAP-F1）                                                     |
| **005** | 授权并完成支付     | 授权测试环境      | ❌ **AI 链路根本无法填卡**（CAP-L1）                                                    |
| **006** | 失败后自动恢复     | 真实网站 + 未知网站 | ❌ 升级即死锁（CAP-J1）+ 无网络证据只能猜（CAP-H1）                                            |

### 2.3 未知网站分层引入（逐步，不一次性）

```
Tier 0  授权测试环境      —— 支付相关（Scenario 005）
Tier 1  未知 SaaS 产品站  —— 注册 / 登录 / 订阅
Tier 2  未知电商站        —— 搜索 / 加购 / 结算
Tier 3  未知 AI 工具站    —— 注册 / API Key 获取
Tier 4  未知会员/内容站   —— 登录 / 选套餐 / 订阅
```

每一 Tier 的准入判据：**不使用任何站点专用代码路径完成全部流程。**

---

## 3. Architecture

### 3.1 正确抽象链（用户 §五，本项目的架构宪法）

```
Intent  →  Target  →  Page  →  Element  →  Action  →  Observation
                                                          ↓
                              Recovery  ←  Business State  ←┘
```

| 环节                 | 产品职责           | 当前实现                                          | 污染/缺口                                              |
| ------------------ | -------------- | --------------------------------------------- | -------------------------------------------------- |
| **Intent**         | 理解用户想达成什么业务结果  | `planner.js`                                  | 干净（无站点分支）                                          |
| **Target**         | 把意图落成"要操作什么对象" | `schema/action.js` `TARGET_KEYS`              | 7 键够用，缺语义角色规范（见 3.3）                               |
| **Page**           | 判断当前页面是什么形态    | `pageStateClassifier.js`                      | ⚠️ **按站点类型分类，非页面形态**                               |
| **Element**        | 未知 DOM 中定位目标元素 | `semanticResolver.js` + `selectorFallback.js` | 干净，但中文 label 排名有缺口                                 |
| **Action**         | 执行动作           | `tools.js` + `contextGuard.js`                | ⚠️ **contextGuard 有 saas/upload/download/shop 分支** |
| **Observation**    | 记录发生了什么        | `observation.js`                              | ⚠️ 无网络层（只有 pending 计数器）                            |
| **Business State** | 判断业务是否真的达成     | `verification.js` + VIL                       | ⚠️ 准确率 36.81%，存在 silent pass                       |
| **Recovery**       | 失败后分析并恢复       | `repair/` + `recovery/` + `diagnosis/`        | ⚠️ 升级即死锁；诊断未接生产链                                   |

### 3.2 各模块产品职责重定义

| 模块               | 产品职责（新）                      | 常见误用（要消除）                               |
| ---------------- | ---------------------------- | --------------------------------------- |
| **Planner**      | 把业务目标拆成**业务语义步骤**，而非点击序列     | 写出 `input[name='username']` 这类 selector |
| **Resolver**     | 在**未知 DOM** 中按语义角色定位元素       | 依赖站点选择器表 / fixture 结构                   |
| **Runtime**      | 编排步骤、管理预算与失败预算               | 吞掉失败继续往下走                               |
| **Observation**  | 记录**可诊断**的完整事实：DOM + 网络 + 错误 | 只截屏 + 文本摘要                              |
| **Verification** | 判断**业务状态**是否达成，输出带证据的判定      | 用"页面变了"冒充"业务成了"                         |

### 3.3 Target Contract 通用化原则

当前 `TARGET_KEYS = ['semantic','role','field','text','selector','index','url']`（`schema/action.js:36`）。

**原则**：Target 必须描述**语义角色**，不能描述**脆弱 selector**。

| ✅ 通用（语义角色）                          | ❌ 脆弱（结构耦合）                                    |
| ----------------------------------- | --------------------------------------------- |
| `role: 'textbox'`, `semantic: '邮箱'` | `selector: '#app > div:nth-child(2) > input'` |
| `semantic: '提交订单按钮'`                | `selector: 'button.btn-primary.submit'`       |
| `role: 'link'`, `text: '定价'`        | `selector: 'a[href="/pricing"]'`              |

`selector` 保留为**最后兜底**（Resolver 失败时的逃生舱），但不得成为 Planner 的首选输出。


### 3.4 当前架构的三处污染（必须清掉）

#### 污染一：核心执行链上的站点类型分支 🔴 最高优先级架构问题

**位置**：`server/agent/contextGuard.js`，在生产链 `server/agent/tools.js:206` 被**每个动作执行前**调用。

```js
// contextGuard.js:54-60 —— 从动作推导"期望站点"
function deriveExpectedSite(action) {
  if (/saas|控制台|cloud/.test(url) || /saas/.test(sem)) return 'saas';
  if (/upload|上传/.test(url) || /upload|上传|文件/.test(sem)) return 'upload';
  if (/download|下载/.test(url) || /download|下载/.test(sem)) return 'download';
  if (/shop|mall|商城|商品|订单|库存/.test(url) || /订单|商品|商城/.test(sem)) return 'shop';
  return null;
}

// contextGuard.js:63-66 —— 站点矛盾矩阵（只对 saas / upload 两个 key 有定义）
const SITE_CONFLICT = {
  saas:   ['PRODUCT_LISTING','SHOP_SEARCH_EMPTY','DOWNLOAD_PAGE','REGISTRATION','GENERIC'],
  upload: ['DOWNLOAD_PAGE','SHOP_SEARCH_EMPTY','PRODUCT_LISTING','GENERIC'],
};

// contextGuard.js:209 —— 执行链上的 SaaS 专用证据裁决
if (site === 'saas' && state === 'GENERIC') { ... }
```

**为什么这是问题**：

1. `if site === 'saas'` **字面意义上**就是用户明令禁止的核心执行逻辑（用户 §四）。
2. 关键词直接来自 mock 站点语料：`cloudsaas`、`控制台`、`工作台`、`数据看板`、`导出报表`、`活跃用户`、`企业邮箱`（`contextGuard.js:118-120`）。
3. 四类站点中只有两个有冲突矩阵，`download`/`shop` 有 derive 无矩阵——**逻辑不对称，是补丁叠加而非设计**。
4. 在未知网站上，URL 含 `cloud` 或 `admin` 的任意页面都会被归入 `saas` 分支走专用裁决。

**讽刺之处**：项目里有一个**架构正确**的设施被空置了——  
`server/agent/sites/index.js`（Site Adapter 层，114 行）定义了完整的站点知识契约  
（`match` / `knownFlows` / `selectors` / `validators` / `rules` / `hints` + `generic` 零知识兜底），  
按 host 注册、generic 兜底、AI 无知识时靠观察。**但 `adapters` 里只有 `generic` 一个，0 个真实适配器。**

> 正确的设施空转，错误的补丁长在主链上。这是本次架构纠偏的第一号目标。

#### 污染二：页面状态分类器用的是「站点类型桶」，不是「页面形态」

**位置**：`server/agent/pageStateClassifier.js`

```js
// pageStateClassifier.js:95-103
const BUCKET_MAP = {
  LOGIN_WALL:        'SaaS 登录/控制台页（邮箱或密码错误）',
  DOWNLOAD_PAGE:     '资源下载页',
  REGISTRATION:      '会员注册表单页',
  PRODUCT_LISTING:   '电商商品列表页',
  SHOP_SEARCH_EMPTY: '电商搜索/空结果页',
  BLANK:             '空白页（SPA 未挂载）',
  GENERIC:           '电商商品列表页', // 兜底归入列表（多数 GENERIC 实为商城页变体）
};
```

状态名本身（`PRODUCT_LISTING` / `SHOP_SEARCH_EMPTY` / `DOWNLOAD_PAGE`）就是五个 mock 站点页面的直接映射。  
`GENERIC` 兜底被硬编码为「电商商品列表页」——**因为 benchmark 池里电商占比高，所以兜底也归电商**。  
这已经不是产品逻辑，是数据集统计特征泄漏进了生产代码。

`toBucket()` 的注释写明用途是「用于回放准确率校验」——**纯 benchmark 评价机器，位于生产代码中。**

#### 污染三：网络层只有计数器，没有数据

**位置**：`server/agent/observation.js:16-26`

```js
function ensureNetHook(page) {
  page.on('request',        () => { page.__pendingRequests = (page.__pendingRequests || 0) + 1; });
  page.on('requestfinished',() => { page.__pendingRequests = Math.max(0, (page.__pendingRequests || 0) - 1); });
  page.on('requestfailed',  () => { page.__pendingRequests = Math.max(0, (page.__pendingRequests || 0) - 1); });
}
```

注释自称「不新增全局 event system」。结果是：

- 请求 URL、方法、状态码、响应体、耗时、重定向链 —— **全部丢弃**
- 401 / 403 / 429 / 500 / CAPTCHA / Bot detection / Session expiration / CSRF —— **全部不可见**
- 无 store 承载（`server/data/` 下无任何 network 相关文件）
- 唯一一处 CDP（`browserManager.js:97`）用途是 `Emulation.setUserAgentOverride`（指纹伪装），与网络无关

`observation.networkState` 最终只有两个值：`'pending'` / `'idle'`（`observation.js:315-317`）。

> **诊断一个看不见的东西只能靠猜。66/100 的 VERIFY_FAILED 与 36.81% 的验证准确率，根因就在这里。**

---


## 4. Capability Matrix（A–O）

图例：**EXISTS** 生产可用 ｜ **PARTIAL** 有架构有缺口 ｜ **MISSING** 未建 ｜ **BROKEN** 有实现但不可用/不可信

| 组     | 能力                   | 状态               | 一句话结论                                         |
| ----- | -------------------- | ---------------- | --------------------------------------------- |
| **A** | Fingerprint Browser  | **EXISTS**       | 商业级指纹，覆盖度高，缺模板化与一致性 UI                        |
| **B** | Proxy Network        | **EXISTS**       | http/socks5 + 自研 SOCKS5 认证 shim + 自动协议探测，强    |
| **C** | Profile Management   | **PARTIAL**      | CRUD 齐全，缺批量、分组权限、凭据绑定 UI                      |
| **D** | AI Browser Operator  | **PARTIAL**      | 架构罕见地完整，但业务成功率 6/100                          |
| **E** | Page Understanding   | **PARTIAL** 🔴   | 采集够，但分类器被站点类型污染（见 3.4 污染二）                    |
| **F** | Action Execution     | **PARTIAL**      | 24 个登记 / 30 个实现，6 个实现未登记；缺 hover/drag/iframe  |
| **G** | Verification         | **PARTIAL** 🔴   | VIL 架构优秀，准确率 36.81%，存在 silent pass            |
| **H** | Network Intelligence | **MISSING** 🔴   | 只有 pending 计数器，无任何网络数据（见 3.4 污染三）             |
| **I** | Failure Diagnosis    | **MISSING（生产链）** | 模块存在但为孤儿；20 类分类未接生产                           |
| **J** | Self Healing         | **PARTIAL** 🔴   | repair/recovery 完整，但升级即死锁（`selfHealing/` 空目录） |
| **K** | Memory Learning      | **PARTIAL**      | 37 个文件，写入闸已修好，读侧大面积孤儿                         |
| **L** | Payment Automation   | **BROKEN** 🔴    | 加密与红线通过，但 AI 链路无法填卡                           |
| **M** | Workflow Automation  | **PARTIAL**      | 队列/Worker/调度/checkpoint 在，定时与批量缺              |
| **N** | Security             | **BROKEN** 🔴    | 可被匿名拖库 + 无鉴权 RCE + 脱敏 100% 失效                 |
| **O** | Team SaaS            | **MISSING**      | 无用户/权限/租户/API Key                             |


### A — Fingerprint Browser ｜ **EXISTS**

| 项                           | 证据                                                                                                                                 | 状态                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Canvas 噪声注入                 | `fp/inject.js`                                                                                                                     | ✅                  |
| WebGL / WebGL Image         | `fp/inject.js`、`fp/generate.js`                                                                                                    | ✅                  |
| AudioContext                | `fp/inject.js`、`generate.js`                                                                                                       | ✅                  |
| Fonts / ClientRects         | `fp/inject.js`                                                                                                                     | ✅                  |
| **WebRTC 控制**               | `inject.js:453-512`（含 `publicIp` 覆写、`block` 模式）                                                                                    | ✅                  |
| **Geolocation 伪装**          | `inject.js:245-264`（real / mock / block 三态）                                                                                        | ✅                  |
| Permissions 一致性             | `inject.js:199-205`（Notification 与 permissions.query 对齐）                                                                           | ✅                  |
| navigator 覆写                | UA / UA-CH / platform / language / plugins / mimeTypes / hardwareConcurrency / deviceMemory / doNotTrack / maxTouchPoints / vendor | ✅                  |
| screen 覆写                   | width/height/avail\*/colorDepth/pixelDepth/devicePixelRatio/outer\*                                                                | ✅                  |
| mediaDevices / speechVoices | `inject.js:441-443`                                                                                                                | ✅                  |
| 指纹生成                        | `generate.js`：audioContext/canvas/webgl/webglImage/language/timezone/platform/screen/UA                                            | ✅                  |
| 一致性自检                       | `integrity.js` 190 行（UA 版本、时区合法性）                                                                                                  | ⚠️ 仅 HTTP API，无 UI |
| 指纹模板库                       | —                                                                                                                                  | ❌ MISSING          |
| 批量指纹生成                      | —                                                                                                                                  | ❌ MISSING          |

**结论：A 是当前唯一达到商业级的能力组。** 缺的是产品化外壳（模板、批量、UI），不是核心能力。

### B — Proxy Network ｜ **EXISTS**

| 项                  | 证据                                                    | 状态        |
| ------------------ | ----------------------------------------------------- | --------- |
| HTTP / SOCKS5      | `proxyChecker.js:12,122,180`                          | ✅         |
| **SOCKS5 认证 shim** | `socksShim.js` 204 行（自研握手，绕开 Chromium 不支持 SOCKS5 认证）  | ✅ 罕见能力    |
| HTTP 代理 shim       | `httpProxyShim.js` 186 行                              | ✅         |
| **自动协议探测**         | `proxyChecker.js:205-251`（端口同时监听 HTTP/SOCKS5 时真正发包验证） | ✅         |
| **绝不回退直连**         | `proxyChecker.js:178` 注释明示                            | ✅ 防 IP 泄漏 |
| GeoIP              | `geoip.js` 108 行 + `/proxies/:id/check-geo`           | ✅         |
| 代理 CRUD + 检测 API   | `index.js:204-249` 共 7 个路由                            | ✅         |
| 代理池轮换 / 健康度        | —                                                     | ❌ MISSING |

**结论：B 同样达到商业级**，`socksShim` 与「绝不回退直连」是差异化资产。缺代理池运营层。

### C — Profile Management ｜ **PARTIAL**

| 项          | 证据                                                                                                                                                                     | 状态        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| CRUD       | `index.js:56,61,100,130,178`                                                                                                                                           | ✅         |
| 复制 Profile | `index.js:161` `/profiles/:id/duplicate`                                                                                                                               | ✅         |
| 完整性检查      | `index.js:111` `/profiles/:id/integrity`                                                                                                                               | ✅         |
| 指纹预览       | `index.js:192` `/profiles/preview-fp`                                                                                                                                  | ✅         |
| 字段模型       | `index.js:63-91`：name/group/tags/notes/seed/headless/proxyMode(saved|inline|none)/os/browser/startupUrls/launchArgs/launchBehavior/lastSessionUrls/fingerprintOverride | ✅ 完整      |
| 凭据绑定       | `vault.js` AES-256-GCM 存在，但无 Profile 级绑定 UI                                                                                                                            | ⚠️        |
| 批量导入 / 导出  | —                                                                                                                                                                      | ❌ MISSING |
| 分组权限       | —                                                                                                                                                                      | ❌ MISSING |

### D — AI Browser Operator ｜ **PARTIAL（架构罕见的完整，业务 6/100）**

| 项                | 证据                                                                     | 状态        |
| ---------------- | ---------------------------------------------------------------------- | --------- |
| Planner          | `planner.js` 287 行，**无站点分支（已核实）**                                      | ✅         |
| Runtime          | `runtime.js` 688 行，**无站点分支（已核实）**                                      | ✅         |
| 语义解析             | `semanticResolver.js` 271 行，**无站点分支（已核实）**                             | ✅         |
| 步骤/任务编排          | `stepManager.js` 181 + `taskManager.js` 479 + `taskStateManager.js` 74 | ✅         |
| 队列 / 调度 / Worker | `execution/` 19 文件                                                     | ✅         |
| 预算 / 锁 / 检查点     | `budget.js` / `lock.js` / `checkpoint.js`                              | ✅         |
| LLM Provider     | `llm/` deepseek + openai + provider 抽象                                 | ✅         |
| 可观测性             | `observability/` 10 文件                                                 | ✅         |
| **业务成功率**        | 100-task 实测 **6%**                                                     | 🔴        |
| **升级率**          | **80%**（其中 67% 为真实能力不足导致）                                              | 🔴        |
| Planner 成功率      | **96%**                                                                | ✅ 计划不是瓶颈  |
| 执行成功率            | 57.81%                                                                 | ⚠️        |
| **验证准确率**        | **36.81%**                                                             | 🔴 最大黑洞   |
| 恢复成功率            | **2.17%**                                                              | 🔴        |
| 修复成功率            | 60.75%（186 次修复，113 次判定 ok）                                             | ⚠️ 但业务未挽回 |

**关键判读**：96% 计划成功 → 57.81% 执行成功 → 36.81% 验证准确 → 6% 业务成功。  
**漏斗不是卡在"想不出怎么做"，而是卡在"做完了判断不出到底成没成"。**  
这直接指向 H（看不见网络）+ G（验证不准）+ I（诊断不了）三处，而不是 Planner。

### E — Page Understanding ｜ **PARTIAL** 🔴

| 项                 | 证据                                                                                                                                  | 状态                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 事实采集              | `observation.js:282-306`：url/title/textSummary/visibleText/roleText/elements(≤80)/errors(≤10)/loadingState/domFingerprint/timestamp | ✅ 充分                           |
| 血缘追踪              | `observationId` / `parentObservationId` / `actionFinishedAt` / `fresh`                                                              | ✅ 设计精良                         |
| before/after diff | `previousObservationDiff` 六维（url/text/dom/keyText/elementState/pageStructure）                                                       | ✅ 支撑 VIL                       |
| 观察缓存              | `observationCache.js` + domHash                                                                                                     | ✅                              |
| **页面形态分类**        | `pageStateClassifier.js`                                                                                                            | 🔴 按站点类型分（污染二）                 |
| **上下文守卫**         | `contextGuard.js`（生产链 `tools.js:206`）                                                                                               | 🔴 站点类型分支（污染一）                 |
| **网络可观测**         | `networkState` 仅 `pending`/`idle`                                                                                                   | 🔴 MISSING（污染三）                |
| 中文 label 定位       | `semanticResolver.js:139`                                                                                                           | ⚠️ 已知缺口 `CAP-E5-LABEL-RANKING` |

### F — Action Execution ｜ **PARTIAL**

| 项              | 证据                                                                                                                                                                                                                                    | 状态                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 已登记动作（24）      | `schema/action.js:9-14`：navigate/inspect/wait/scroll/extract/screenshot/reload/back/forward/getUrl/getTitle/click/fill/select/press/check/uncheck/login/logout/submit/delete/update_account_settings/purchase/payment/password_change | ✅                 |
| 风险分级           | `TYPE_RISK_FLOOR`（LOW/MEDIUM/HIGH/CRITICAL），`payment`/`password_change` = CRITICAL                                                                                                                                                    | ✅ 设计正确            |
| 敏感字段保护         | `SENSITIVE_FIELDS`（password/cvv/cardNumber/otp/...）只允许 `credentialRef`                                                                                                                                                                | ✅ **红线通过**        |
| **已实现但未登记（6）** | `tools.js:411/418/427/519/532/562`：openTab / closeTab / switchTab / upload / download / dialog                                                                                                                                        | 🔴 **CAP-05**     |
| hover / drag   | —                                                                                                                                                                                                                                     | ❌ MISSING         |
| iframe 切换      | —                                                                                                                                                                                                                                     | ❌ MISSING（真实网站高频） |


### G — Verification ｜ **PARTIAL** 🔴

| 项 | 证据 | 状态 |
|---|---|---|
| 契约类型（10） | `verification.js`：url_contains/text_present/text_absent/element_present/element_absent/field_value/field_checked/login_state/page_change/action_success | ✅ |
| VIL | `verification/verificationIntelligence.js` + `verificationWindow.js` + `contract.js` | ✅ 架构优秀 |
| 观察窗口 | `SCHEDULE_STATE_UNKNOWN=[300,800,1600]` / `SCHEDULE_TIMING=[250,600,1200,2200]` / `MAX=5200ms` | ✅ |
| DOM_CHANGED 语义 | → `RETRY_VERIFY`（**不判成功**） | ✅ 红线通过 |
| SUBMIT_RESULT_UNKNOWN | → `HUMAN_ESCALATE` | ✅ 红线通过 |
| **准确率** | **36.81%** | 🔴 |
| **silent pass** | `verification.js:110-120`：`page_change` 在 `before` 缺失时「URL 已加载即视为变化」→ `success:true, confidence:0.6` | 🔴 **CAP-G1** |
| **agentScore.verification = 100** | 与 verificationAccuracy 36.81% 并存 | 🔴 指标定义失真 |

> **指标失真说明**：`agentScore.verification=100` 衡量的是「验证层有没有产出结论」，
> `verificationAccuracy=36.81%` 衡量的是「结论与业务真相是否一致」。
> 两者并存正是"执行成功 ≠ 业务成功"的量化证据——**这正是用户要求降级 Execution Success 为辅助指标的原因。**

**silent pass 根因链**（已运行时复核）：
```
executor.js:58  →  ctx 不含 observation
verifyFailed.js:112  →  beforeObs = null
contract.js 派生  →  契约含 { type:'page_change' }
verification.js:111-116  →  before 缺失时 URL 已加载即视为变化 → true
结果  →  一个真实失败被报成"修复成功"
```
已在 `test_repair_step5.js` §2b 建立【已知缺陷标记】用例固化该行为。

### H — Network Intelligence ｜ **MISSING** 🔴

用户 §八 要求的网络能力，逐项核对：

| 要求能力 | 实现 | 状态 |
|---|---|---|
| Request 记录 | 无（只 +1 计数） | ❌ |
| Response 记录 | 无 | ❌ |
| HTTP Status | 无 | ❌ |
| Redirect 链 | 无 | ❌ |
| XHR / Fetch | 无 | ❌ |
| GraphQL / API endpoint | 无 | ❌ |
| Response body | 无 | ❌ |
| Network error | 无 | ❌ |
| CORS 错误 | 无 | ❌ |
| 403 / 401 / 429 / 500 | 无 | ❌ |
| Payment API failure | 无 | ❌ |
| **Captcha 检测** | 无 | ❌ |
| **Bot detection** | 无 | ❌ |
| **Session expiration** | 无 | ❌ |
| **CSRF** | 无 | ❌ |
| 网络数据持久化 | `server/data/` 下无任何 network 文件 | ❌ |

**H 不是 PARTIAL，是 MISSING。**
（`grep page.on('request')` 能命中，极易被误判为 EXISTS——这是本次审计最需要澄清的一处。）

### I — Failure Diagnosis ｜ **MISSING（生产链）**

| 项 | 证据 | 状态 |
|---|---|---|
| 诊断模块 | `diagnosis/` 3 文件（engine/prompt/schema） | ⚠️ 存在但非生产主链 |
| 失败分类法 | `executionFailureTaxonomy.js` 149 行 | 🔴 **孤儿模块**：仅被离线脚本 `scripts/analyze_phase4.js:17` 引用；runtime / stepManager / taskManager **零 require** |
| `ACCOUNT_EXISTS` | 生产代码零命中 | ❌ |
| `CARD_DECLINED` | 生产代码零命中 | ❌ |
| `3DS` | 生产代码零命中 | ❌ |
| `RATE_LIMIT` | 生产代码零命中 | ❌ |
| `CAPTCHA` | 生产代码零命中 | ❌ |
| `BOT_DETECTED` | 生产代码零命中 | ❌ |
| `SESSION_EXPIRED` | `repair/strategies/sessionExpired.js` 存在 | ⚠️ 仅策略名，非诊断分类 |
| `Evidence → Diagnosis → Confidence → Recovery` 四段式 | — | ❌ MISSING |

> 用户 §十 要求的 20 类分类，当前生产链**实际区分的只有 ELEMENT_NOT_FOUND / VERIFY_FAILED / POLICY_BLOCK / OTHER 四类**（100-task 实测分布 3 / 66 / 13 / 12）。
> 66 条 `VERIFY_FAILED` 是一个**拒答**，不是诊断结论。

### J — Self Healing ｜ **PARTIAL** 🔴

| 项 | 证据 | 状态 |
|---|---|---|
| Repair 框架 | `repair/` 13 文件（manager/planner/policy/schema/attempts/executor） | ✅ |
| 修复策略（7） | elementChanged / generic / navigation / obstruction / sessionExpired / timeout / verifyFailed | ✅ |
| Recovery 框架 | `recovery/` 10 文件 | ✅ |
| 重试红线 | `verifyFailed.js:17` — WAIT/RECHECK/RETRY_VERIFY **绝不重执行原 action**；唯一合法重执行入口是 `ACTION_REAL_FAILURE` | ✅ 红线通过 |
| **HUMAN_ESCALATION 出边** | `taskStateManager.js:14` 列为终态，但 `:18-32` `TASK_TRANSITIONS` **无该键** → `:53-56` 回退 `[]` → 抛「非法 Task 状态转换」 | 🔴 **CAP-J1 死锁** |
| **续跑能力** | `index.js:443` `/tasks/:id/resume` 无法跨越终态校验 | 🔴 升级即终点 |
| `selfHealing/` 目录 | 0 文件 | ❌ 空壳 |
| 升级率 | 80%（真实能力不足占 67%） | 🔴 |
| 恢复成功率 | 2.17% | 🔴 |

> **CAP-J1 是最不对称的一处**：修复成本约等于加一个状态转移表条目，
> 但它决定了 80% 的任务是"暂停等用户处理"还是"彻底死掉"。

### K — Memory Learning ｜ **PARTIAL**

| 项 | 证据 | 状态 |
|---|---|---|
| 模块规模 | `intelligence/` 37 文件 | ✅ |
| **elementMemory 写入闸** | `runtime.js:343-346`：**业务验证通过才写** | ✅ **已修好**（污染治理生效） |
| flowMemory | `taskManager.js:402` 写，`planner.js` **零引用** | 🔴 有写无读 = 零价值投资 |
| siteMemory | 成功侧 `recordTaskResult` 生产链零调用（仅失败侧） | 🔴 半孤儿 |
| intelligenceRouter | 只在 `/chat` 读，**执行链不消费决策** | 🔴 空转 |
| failureKnowledge / failureMatcher | 存在 | ⚠️ 需核实消费方 |
| 学习源治理 | 写入闸已修，读侧未回流 | ⚠️ |


### L — Payment Automation ｜ **BROKEN** 🔴

用户 §十三 要求的能力链逐项核对：

| 链环节 | 实现 | 状态 |
|---|---|---|
| Payment Intent | `purchase` / `payment` 两个动作类型已登记 | ✅ |
| Authorization Policy | `policy.js` + `TYPE_RISK_FLOOR`（payment=CRITICAL）+ `FPB_ALLOW_AUTOPAY` 默认关 | ✅ |
| **Payment Action** | `tools.js:673-686` `resolveFillValue` **只映射 email/password** | 🔴 **BROKEN** |
| Network Observation | 依赖 H | 🔴 H MISSING |
| Payment Result | 五态区分（authorized/declined/3ds/pending/failed） | ❌ MISSING |
| Verification | 依赖 G | ⚠️ G 36.81% |
| Audit | 审计日志无 actor、不可导出（依赖 O） | ⚠️ |

```js
// tools.js:673-686 —— AI 链路填不了卡的根因
function resolveFillValue(field, secrets) {
  const f = String(field).toLowerCase();
  if (f.includes('email'))    return s.email    || null;
  if (f.includes('password')) return s.password || null;
  return s.email || s.password || null;   // ← card / cvv / exp 全部落到这里
}
```

**红线通过项（必须保住）**：
- ✅ Vault AES-256-GCM 加密存储
- ✅ 凭据不进 prompt（`SENSITIVE_FIELDS` 只允许 `credentialRef`，禁止 value 字面量）
- ⚠️ 但脱敏正则 100% 失效（SEC-N4），**卡号可能经 observation → LLM**，实际红线已被击穿

### M — Workflow Automation ｜ **PARTIAL**

| 项 | 证据 | 状态 |
|---|---|---|
| 队列 | `execution/queueManager.js` | ✅ |
| Worker 池 | `execution/` worker*/executorPool/capacityManager | ✅ |
| 调度器 | `execution/scheduler.js` + `schedulerLoop.js` | ✅ |
| 浏览器资源池 | `execution/browserResourcePool.js` + `resourceRecovery.js` | ✅ |
| 检查点 / 断点续跑 | `checkpoint.js` | ✅ |
| 可保存工作流 | — | ⚠️ PARTIAL |
| 定时触发 | — | ❌ MISSING |
| 批量执行 | — | ❌ MISSING |
| 可视化编排 | — | ❌ MISSING |


### N — Security ｜ **BROKEN** 🔴

| 项 | 证据 | 风险 |
|---|---|---|
| API 无鉴权 | `index.js:497-500`，`/api/*` 与 `/api/ai/*` 全部无 auth 中间件 | 🔴 任何人可增删改任务、读凭据 |
| CORS | `index.js:50` `app.use(cors())` → `ACAO: *` | 🔴 任意网站可跨域调用 |
| 监听地址 | `index.js:509` `app.listen(PORT)` 未传 host → **0.0.0.0** | 🔴 暴露到网络 |
| **路径穿越** | `agent/index.js:510` → `evidence.js:35` `path.join(SNAP_DIR, taskId, file)`，`file` 取自 URL **零校验** | 🔴 **可远程拖库** |
| **远程代码执行** | `index.js:297-310` `POST /browser/:id/evaluate` → `new Function('return (' + script + ')')`，无鉴权 | 🔴 **匿名 RCE** |
| **脱敏失效** | `observation.js:49-52` 正则双重转义（`\\s` `\\b` 为字面反斜杠），**运行时验证 4 条样本全部未脱敏** | 🔴 **卡号/CVV 进 LLM、日志、trace、benchmark JSON** |
| 主密钥降级 | `vault.js:18-19` `FPB_MASTER_KEY` 缺失 → 一次性内存随机密钥，重启后凭据**永久不可解密**，仅 `console.warn` | 🔴 静默数据丢失 |

**这四项叠加构成一条完整攻击链**：
```
匿名攻击者 → CORS * + 0.0.0.0 + 无鉴权
         → POST /browser/:id/evaluate  → RCE（拿下服务器）
         → GET /snapshots/:taskId/..%2f..%2fprofiles.json → 拖库
```
同时**脱敏失效直接击穿用户支付红线**（用户 §十三：「不把 CVV/完整支付凭据暴露给 LLM、Memory、普通日志、trace、benchmark JSON」）。

### O — Team SaaS ｜ **MISSING**

| 项 | 状态 |
|---|---|
| 用户体系 | ❌ MISSING |
| 角色权限 | ❌ MISSING |
| 多租户隔离 | ❌ MISSING |
| API Key | ❌ MISSING |
| 审计日志 | ⚠️ PARTIAL（有留痕但无 actor、不可导出） |
| 用量计量 / 计费 | ❌ MISSING |

---

## 5. Current State

### 5.1 工程基线（已完成）

| 项 | 结果 |
|---|---|
| 代码库 | git 初始化，首次提交 `03a1048`，**487 文件 / 63,462 行** |
| 回归套件 | **34 文件 → 33 通过 / 0 失败 / 1 已知缺口 / 6 取证跳过，144.5s** |
| 回归执行器 | `server/scripts/runRegression.js`（跨平台 Node，非 bash） |
| 缺口登记 | `server/scripts/KNOWN_GAPS.json`（4 条登记纪律） |
| CI | `.github/workflows/ci.yml`（回归 + 前端构建双 job） |
| 环境模板 | `.env.example`（41 变量 / 8 组） |
| 许可证 | `LICENSE` **专有商业许可**（非 MIT，防竞品直接拿去卖） |

**回归套件现在是"可信的红灯"**：取证型测试在语料漂移时判 `SKIP` 而非 `FAIL`
（判据是语料规模 / 命中率，不是文件是否存在），已知缺陷以【已知缺陷标记】用例固化而非掩盖。

### 5.2 产品基线（100-task 真实评测，`.benchmark/phase12_100task_1787785122280.json`）

条件：真实 DeepSeek + 真实 Chromium，simulated=false，无 mock/fallback。

| 指标 | 值 | 判读 |
|---|---|---|
| **业务成功率** | **6%** | 🔴 终极指标 |
| **升级率** | **80%** | 🔴 五分之四的任务靠人来兜 |
| 升级中真实能力不足占比 | **67%** | 🔴 不是安全策略拦的，是真不会 |
| Planner 成功率 | 96% | ✅ 计划不是瓶颈 |
| 执行成功率 | 57.81% | ⚠️ 中间指标，非产品成功 |
| **验证准确率** | **36.81%** | 🔴 最大黑洞 |
| 恢复成功率 | 2.17% | 🔴 等于没有 |
| 修复判定 ok 率 | 60.75%（186/113） | ⚠️ 修了但业务没挽回 |
| 平均步数 | 5.31 | — |
| 平均恢复次数 | 4.62 | ⚠️ 高恢复 + 低挽回 = 无效重试 |
| 平均耗时 | 36.3s | — |
| 平均成本 | $0.002 / task（总 $0.1985） | ✅ 成本不是问题 |
| **失败分布** | `VERIFY_FAILED` **66** / `POLICY_BLOCK` 13 / `OTHER` 12 / `ELEMENT_NOT_FOUND` 3 | 🔴 66 条是"不知道成没成" |

### 5.3 一句话现状

> **底座（A、B）已商业级；引擎（D）架构罕见地完整但业务上不会干活；
> 让引擎会干活的三个东西——网络（H）、诊断（I）、可信验证（G）——分别是 MISSING、MISSING、36.81%；
> 而外壳（N、O）处于"现在拿出去卖会被人拿下服务器"的状态。**

---

## 6. Missing Capability

按「不做会怎样」排序的缺口清单（ID 用于后续追踪与 `KNOWN_GAPS.json` 登记）。

### 6.1 安全缺口（不修则不可对外）

| ID | 缺口 | 证据 | 不修的后果 |
|---|---|---|---|
| `SEC-N1` | 快照路径穿越 | `evidence.js:35` + `agent/index.js:510` | 远程拖库（含凭据、任务、截图） |
| `SEC-N2` | evaluate 无鉴权 RCE | `index.js:297-310` | 服务器被匿名接管 |
| `SEC-N3` | 无鉴权 + CORS `*` + 0.0.0.0 | `index.js:50/497-500/509` | 任意网站可调用本机 agent |
| `SEC-N4` | 脱敏正则双重转义失效 | `observation.js:49-52`（运行时验证 4/4 未脱敏） | **卡号/CVV 进 LLM、日志、trace、benchmark JSON**，击穿用户支付红线 |
| `SEC-N5` | 主密钥缺失静默降级 | `vault.js:18-19` | 重启后凭据永久不可解密，且无人知晓 |


### 6.2 能力缺口（不修则不是这个产品）

| ID | 缺口 | 证据 | 不修的后果 |
|---|---|---|---|
| `CAP-J1` | HUMAN_ESCALATION 无出边 | `taskStateManager.js:14 vs :18-32` | **升级即死锁**，80% 任务无法续跑 |
| `CAP-G1` | `page_change` 在 before 缺失时空过 | `verification.js:110-120` + `executor.js:58` | 真实失败被报成修复成功，验证准确率不可信 |
| `CAP-E1` | contextGuard 站点类型分支 | `contextGuard.js:54-66,100,209` | 违反用户红线；未知网站被 mock 语料误判 |
| `CAP-E2` | pageStateClassifier 站点类型桶 | `pageStateClassifier.js:95-103` | 页面理解不可泛化；兜底硬编码为电商 |
| `CAP-H1` | 无网络采集与持久化 | `observation.js:16-26`；无 store | 失败原因不可观测，诊断只能猜 |
| `CAP-H2` | 网络信号未接入诊断 | 依赖 CAP-H1 | 401/403/429/Captcha/Bot/Session 全不可见 |
| `CAP-I1` | 20 类失败分类未接生产链 | `executionFailureTaxonomy.js` 孤儿 | 实际只区分 4 类，66 条 VERIFY_FAILED 是拒答 |
| `CAP-I2` | 无 Evidence→Diagnosis→Confidence→Recovery 四段式 | — | 恢复不是基于诊断，是盲目重试（恢复成功率 2.17%） |
| `CAP-F1` | 6 个已实现动作未登记（CAP-05） | `tools.js:411/418/427/519/532/562` vs `schema/action.js:9-14` | 多标签/上传/下载/弹窗在真实网站不可用 |
| `CAP-F2` | 缺 hover / drag / iframe 切换 | — | 真实网站悬浮菜单、拖拽上传、嵌套表单不可操作 |
| `CAP-L1` | 支付填卡链路 BROKEN | `tools.js:673-686` | Scenario 005 根本不可能完成 |
| `CAP-L2` | 支付五态未区分 | — | 无法区分成功/拒付/3DS/待处理/失败 |

### 6.3 效率缺口（不修则投资不产生回报）

| ID | 缺口 | 证据 |
|---|---|---|
| ~~`CAP-K1`~~ | ✅ 已修复（2026-08-29，STEP 8） | 原缺口比「有写无读」更深，是三处串联：①读侧只在 `/chat` 创建路径（`index.js:422`），生产执行路径 `runtime.resolvePlan` 从不查 flowMemory —— 写（complete）与读永不相遇；②`recordOutcomeFlow` 生产链**零调用**，置信度只涨不跌，接读侧会让过期 flow 被永久重放；③`toPlan` 把一切非导航状态重建成 click（有损重放）。修复：`flowPlanner.tryFlowPlan` 成为唯一读侧入口（先过 `schema/plan.validatePlan`，不过即降级 LLM）；`runtime.resolvePlan` 在规划观察**之前**查 flow（命中省一次导航+LLM）；`stateFromStep/toPlan` 保真（actionType/field/非敏感 value/credentialRef/verification/expectedBusinessState，敏感字段值提取侧再拦一道）；`taskManager.fail/escalate` 对 `task.flowUsedId` 记失败降置信（1 成功+1 失败 → 0.5 < 0.85 降级 LLM）；`/chat` 路径同步 markFlowUsed。回归 `test_step8_flow_readback.js` 29 条全绿（含 runtime.resolvePlan 真实命中断言、LLM 零调用 spy、双缺 fill 校验门 fail-safe） |
| ~~`CAP-K2`~~ | ✅ 已修复（2026-08-30，STEP 9） | Router 决策此前只在 `/chat` 消费 profileId，失败经验 warnings 在执行链零消费。修复（三段接线，全 fail-open、只建议不执行）：①新增 `router/taskInputEnhancer.js`（`enhanceTaskInput`/`toIntelligence` 纯函数）——`POST /tasks` 创建前咨询 Router：调用方未指定 profileId 时补齐（显式指定永不覆盖），决策摘要（profileId/flowId/expectedSuccess/warnings）挂 `task.routerHints` 并随响应返回 intelligence 字段；`/chat` 同步挂 routerHints；②`createTask` 落库 `routerHints` 字段；③`contextBuilder.build` 把 `task.routerHints` 透传进 context，两个序列化点（`planner.contextBlock` + `deepseek.buildContextSection`）同步渲染「Router 经验提示（规划时主动规避，禁止据此臆造契约）」。回归 `test_step9_router_wiring.js` 24 条全绿（含 fail-open stub 断言、显式 profileId 不被覆盖、双序列化点有必出/无必不出、无 LLM 端到端链路）。注意：`router/index.js.decide` 是 require 时的引用拷贝，stub 必须打在 `intelligenceRouter` 内层模块 |
| ~~`CAP-K3`~~ | ✅ 已修复（2026-08-30，STEP 10） | `recordTaskResult` 生产链零调用（只有 Phase 3.1 测试在调）——真实业务结果从未进入 Site Memory，读侧（Router/contextBuilder/flowMemory.merge）消费的是永远为空的画像。修复（只接线、不改语义、全 fail-open）：①`taskManager.complete` 回写 `recordTaskResult(site, { ok:true, flowName: planGoal‖objective, avgSteps: result.completedSteps })`——成功依据 = runtime 在全部 step 通过业务验证 + B.4 守卫后的 complete，绝不吃 action_success；②`taskManager.fail` 回写 `ok:false`（flowName 同源，否则成功率聚合只吃成功永远虚高；failureType 只取显式原因码，无 reason 不从自由文本臆造类别）；③**终态幂等守卫**：`transitionTask` 对 next===current 直接放行，complete/fail/escalate 对已终态任务重入会整函数体重跑（事件重发 + flowMemory/profileAnalyzer/siteMemory 全部双计）——三个函数入口统一加 `isTaskTerminal` 早退；cancel 旧守卫补上漏掉的 HUMAN_ESCALATION；④escalate()/cancel() 不回写（升级与取消不是已证实的失败结果）；⑤顺手登记漏掉的 `task.escalated` 事件类型。回归 `test_step10_site_memory_wiring.js` 24 条全绿 ×2（含重入不双计、1F+1S 两次运行两个事实、fail-open、escalate/cancel 零回写） |
| ~~`CAP-E5-LABEL-RANKING`~~ | ✅ 已修复（2026-08-29） | `semanticResolver.js` 新增 `elementClass` / 标签冗余降权 / **描述性封顶** / 同分控件优先；回归 `test_step5_label_ranking.js` 26 条全绿，原失败用例 `test_resolver.js` 已达 17/17 |
| ~~`CAP-E6-NEARBY-TEXT-DEAD`~~ | ✅ 已修复（2026-08-29） | `observation.js` 的 COLLECT_JS 新增 `precedingText` / `siblingTextOf` / `containerTextOf` 三路邻近文本采集（只取「紧邻在前」文本，避免同容器多字段串味；全部走 redact）；`semanticResolver.js` 加描述性元素封顶（0.75），解决 h3 自击语义 0.92 压过控件邻近命中 0.82 的残留形态。回归 `test_step5_nearby_text.js` 62 条全绿（含 COLLECT_JS 语法守卫） |
| ~~`SEC-E7-TEMPLATE-ESCAPE`~~ | ✅ 已修复（2026-08-29，**CAP-E6 测试连带挖出**） | `COLLECT_JS` 是模板字面量，页内正则的单反斜杠被当转义序列吃掉（`\s`→字母 s、`\b`→退格符 U+0008、`\d`→字母 d），脱敏六条规则中四条完全失效 —— 卡号 / CVV / Bearer 长期明文进入喂给 LLM 的 observation。修复：页内正则一律双反斜杠；补齐 CVV「词在前」顺序盲区；`test_security_baseline.js` 的 `loadRedact()` 改为从页内生效脚本抽取（旧写法绕过模板字面量处理，测试全绿而生产失效） |

### 6.4 产品化缺口

| ID | 缺口 |
|---|---|
| ~~`CAP-C1`~~ | ✅ 已修复（2026-08-30，STEP 13）：Profile 批量导入/导出——export（全部可见或 ?ids= 逐 id 校验，授权 fail-closed；剥离指纹缓存与归属、保留 seed）+ import（profile:manage 权限、新 id+重新盖章+名称去重+逐条 fail-open+上限 200）+ buildNewProfile 共享构建。细节见 §7.5 P2 表 |
| ~~`CAP-M1`~~ | ✅ 已修复（2026-08-30，STEP 12）：`server/agent/scheduleTrigger.js` 定时触发/批量执行——aiSchedules 实体（模板+profileIds 批量+intervalMs+autoStart）、1s tick 只扫到期、每 profile 独立 AI Task、归属继承 schedule、执行链与 /execution/submit 同决策、全 fail-open；API `/api/ai/schedules*` CRUD+手动 trigger（身份守卫，跨工作区拒绝）。细节见 §7.5 P2 表 |
| ~~`CAP-O1`~~ | ✅ 已修复（2026-08-30，STEP 11）：商业 SaaS 身份与 Workspace 基础层——设计文档 `docs/product/CAP_O1_IDENTITY_ARCHITECTURE.md`；`server/identity.js`（User/Workspace/Membership/Session，scrypt 密码 hash，session 落盘只存 sha256(token)，OWNER/ADMIN/MEMBER 三角色 RBAC 唯一检查入口 `can/assertCan`）；`identityResolver`+`requireAuth` 中间件链（双模式：本地单机 loopback 自动挂 local 用户；`FPB_API_TOKEN` 部署模式机器 token ≡ local 用户，无身份 401 fail-closed）；Profile 全路由 workspace 归属守卫（`filterByWorkspace`/`assertCanAccessResource`，跨工作区读改删一律 403）；AI Task 服务端盖章 `workspaceId/createdBy`（不接受调用方伪造）；注册即赠个人工作区；legacy 无归属资源仅 local 用户可见（零迁移）。细节见 §7.3 P1 表 |
| ~~`CAP-O2`~~ | ✅ 已修复（2026-08-30，STEP 14）：API Key + 独立审计 + 守卫补全——①`server/audit.js` 独立安全审计流（有界环形 5000 条、内存缓存+防抖落盘、递归脱敏 password/token/card/cvv/cookie，查询/导出走内存）；②API Key 第三种身份来源（`fpbak_` 前缀、sha256 落盘、明文仅创建响应一次、绑定 user+workspace、RBAC 完全继承所属角色、readOnly 写守卫 403、身份自管端点对一切 key 禁写防自举提权、每用户每工作区上限 20）；③守卫补全：Proxy/WorkflowTask/Vault/Browser/Automation/Cookies 全部 workspace 盖章+归属校验（创建需 manage/task:manage、使用需 profile:use、MEMBER 写 vault 403）；④连带修复：proxy/vault 写路径异常返回 JSON（此前 FPB_MASTER_KEY 缺失时凭据加密 fail-closed 抛错 → Express 裸 500 HTML）。回归 `test_step14_apikey_audit.js` 70 条 ×2 全绿 |
| ~~`CAP-A1`~~ | ✅ 已修复（2026-08-30，STEP 15）：指纹模板库 + 批量建号 + 模板级一致性自检——`server/fpTemplates.js`（OVERRIDE_KEYS 键白名单归一化 + IANA 时区/locale/数值边界校验 + mergeTemplateIntoInput 优先级 input>模板>默认）；路由 `/api/templates*`（workspace-scoped，创建/改删 profile:manage，check 声明在 :id 之前）；POST /profiles/batch（同模板基线 + 强制独立 seed「同形不同样」，1-50，逐条 fail-open，调用方同 seed 强制忽略）；模板自检 = integrity 体检 + **模板契约漂移检测**（模板钉住键 vs profile override 比对，templateOverrides 显式覆盖豁免——生成器对非法值静默回退，fp 层抓不到必须在契约层比对）；连带修复 POST /profiles 对 buildNewProfile 抛错无 try/catch（async rejection 请求悬挂超时）。回归 `test_step15_fp_templates.js` 55 条 ×2 全绿 |
| ~~`CAP-B1`~~ | ✅ 已修复（2026-08-30，STEP 16）：代理池健康度与自动轮换——`server/proxyPool.js`（滑动窗口 HEALTH_WINDOW=20、状态机 unchecked→healthy→degraded→dead（DEAD_THRESHOLD=3）、成功率=窗口 ok 占比、平均延迟仅成功样本、pickReplacement 同池确定性排序 健康度→成功率降序→延迟升序→id）；健康数据是服务端事实（仅 check 路由 recordCheck 写入，客户端 PUT 剥离 id/workspaceId/createdBy/lastCheck/health 防伪造）；池 = proxy.pool 可选字符串（normalizePool），**跨池绝不轮换**；显式 POST /proxies/rotate（profile:manage）+ launch 启动前自动轮换钩子（仅 proxyAutoRotate===true 且当前 dead 且同池有替补，找不到 fail-open 保持原代理），审计 proxy.rotate / proxy.auto_rotate；GET /proxies/health 汇总（workspace-scoped）。**连带修复真实缺陷**：buildNewProfile 与 PUT /profiles 均未持久化 proxyAutoRotate——创建/更新时传入恒被静默丢弃，显式与自动轮换全部失效；已补字段落盘。回归 `test_step16_proxy_pool.js` 44 条 ×2 全绿 |

---

## 7. P0 / P1 / P2（按商业价值排序）

### 7.1 排序原则（先说清楚为什么是这个顺序）

商业价值的判据不是"技术难度低"或"benchmark 涨得多"，而是：

1. **卖不卖得出去** —— 一个能被匿名 RCE 的产品，无论 AI 多强都无人敢装。
2. **用户会不会留下来** —— 80% 任务升级且升级即死锁，用户第一次遇到验证码就流失。
3. **是不是这个产品** —— 网络智能 / 失败诊断 / 泛化到未知网站，是「AI Browser Operator」与「会重试的点击器」的分界线。
4. **投资有没有回报** —— 有写无读的记忆层是零回报投资，排在能让记忆真正生效的项之后。

**因此顺序是：安全 → 死锁 → 可观测 → 可诊断 → 可泛化 → 可完成支付 → 可学习。**

> 关于"是否应把安全排在最前"的说明：审计曾建议把 `CAP-J1`（死锁）排在安全之前，理由是其直接决定业务可用性。
> **本路线图不采纳该建议。**理由：安全四项构成一条可被外部匿名利用的完整攻击链（RCE → 拖库），
> 且 `SEC-N4` 脱敏失效导致卡号进入 LLM，已实际击穿用户支付红线——
> 这是"产品能不能存在"的问题，优先于"产品好不好用"的问题。
> 同时，安全五项的修复成本极低（合计约数十行改动），不构成排期压力。

---


### 7.2 P0 — 必须做（没有这些，产品不成立）

#### P0-1　安全基线（`SEC-N1` ~ `SEC-N5`）

| 子项 | 内容 | 成本 |
|---|---|---|
| `SEC-N1` | `evidence.js:35` 对 `file` 做白名单校验（拒绝 `..`、路径分隔符，限定扩展名） | ~5 行 |
| `SEC-N2` | `/browser/:id/evaluate` 加鉴权 + 默认关闭（仅 `NODE_ENV=development` 或显式开关启用） | ~10 行 |
| `SEC-N3` | API 鉴权中间件 + CORS 白名单 + 默认绑定 `127.0.0.1` | ~30 行 |
| `SEC-N4` | 修正脱敏正则双重转义（源码 `\\s` → `\s`，`\\b` → `\b`），补单元测试断言真实卡号被脱敏 | ~3 行 + 测试 |
| `SEC-N5` | `vault.js` `FPB_MASTER_KEY` 缺失改为 **fail-fast**（抛错退出），不再静默降级 | ~5 行 |

**四问**：Q1 ✅（没有用户会接受可被远程接管的产品）｜Q2 ✅（与网站无关，通用）｜Q3 ✅（通用安全基线）｜Q4 ✅（保住支付红线，AI 才能碰支付）
**验收**：`curl` 匿名调用 `/api/*` 返回 401；路径穿越返回 400；无 `FPB_MASTER_KEY` 时进程拒绝启动；脱敏测试断言 `4111 1111 1111 1111` → `CARD_REDACTED`。

#### P0-2　解除升级死锁（`CAP-J1`）

`taskStateManager.js` 补 `HUMAN_ESCALATION` 的出边，让 `/tasks/:id/resume` 能跨越终态续跑。

**四问**：Q1 ✅（用户处理完验证码必须能继续）｜Q2 ✅（任何真实网站都会遇到需要人工的环节）｜Q3 ✅（通用状态机修复）｜Q4 ✅（把 80% 升级从"终点"变成"暂停"）
**验收**：升级 → resume → 从检查点继续，且升级次数 ≥2 仍能续跑。

#### P0-3　消除验证 silent pass（`CAP-G1`）

`executor.js:58` 向 `ctx` 传入 observation；`verification.js:110-120` 在 `before` 缺失时**不得**默认判定 `page_change` 成功。

**四问**：Q1 ✅（"报成功但实际没成"是用户最不能接受的失败）｜Q2 ✅（与网站无关）｜Q3 ✅（通用验证语义）｜Q4 ✅（验证准确率是所有自愈的前提）
**验收**：`test_repair_step5.js` §2b【已知缺陷标记】用例**翻转**（断言从 `ok===true` 变为 `ok===false`），并同步删除该标记注释。

#### P0-4　清掉核心执行链的站点类型分支（`CAP-E1` + `CAP-E2`）

| 子项 | 做法 |
|---|---|
| `CAP-E1` | 删除 `contextGuard.js` 的 `deriveExpectedSite` / `SITE_CONFLICT` / `saasEvidence` 站点类型分支；改用**动作语义 vs 页面形态**的通用矛盾判定（如「上传动作落在无文件输入的页面」）。保留 mock 语料关键词的测试断言，但移出生产代码。 |
| `CAP-E2` | `pageStateClassifier` 状态从「站点类型桶」改为**页面形态**：`authenticated_area` / `auth_wall` / `form_page` / `empty_result` / `error_page` / `loading` / `generic`。删除 `BUCKET_MAP`（纯 benchmark 评价机器）。 |
| 附带 | 激活已空置的正确设施：`server/agent/sites/index.js` 的 Site Adapter 契约（已有 `generic` 零知识兜底），让站点特例**注册进适配器**而不是**写进执行链**。 |

**四问**：Q1 ✅（用户要的是"任意网站"，不是"五个 mock 站"）｜Q2 ✅（**这就是未知网站能力的门禁**）｜Q3 ✅（把特例从主链挪到注册表）｜Q4 ✅（决定能不能走出已知站点）
**验收**：在 3 个**从未见过**的真实网站上完成 001/003，全程零站点专用分支；`grep -rn "saas" server/agent/` 在生产链零命中。

#### P0-5　建立网络智能层（`CAP-H1` + `CAP-H2`）

| 子项 | 做法 |
|---|---|
| `CAP-H1` | 用 Playwright 事件（非全局 event system，保持现有克制风格）采集 request/response：URL、method、status、timing、redirect 链、失败原因、关键 response body 摘要；写入新的 `networkEvents` store（按 taskId/stepId 索引，保留最近 N 条 + 错误全留）。 |
| `CAP-H2` | 从网络事件中识别 8 类业务信号：`401/403`（未授权/被拒）/`429`（限流）/`5xx`、Captcha、Bot detection、Session expiration、CSRF、Payment API failure，作为**一等公民字段**进入 Observation。 |

**四问**：Q1 ✅（用户 §八 明确"网络层必须成为核心能力"）｜Q2 ✅（未知网站上网络是唯一可靠的事实来源）｜Q3 ✅（通用 HTTP 语义）｜Q4 ✅（把"猜失败原因"变成"看失败原因"，是 66 条 VERIFY_FAILED 的唯一解）
**验收**：注入 401/429/500/Captcha 页面，Observation 中能读出对应信号；`VERIFY_FAILED` 的归因从"unknown"降为具体类别的比例 ≥ 60%。

#### P0-6　失败诊断接入生产链（`CAP-I1` + `CAP-I2`）

| 子项 | 做法 |
|---|---|
| `CAP-I1` | 把孤儿模块 `executionFailureTaxonomy.js` 接入 runtime/stepManager；补齐 `ACCOUNT_ALREADY_EXISTS` / `PAYMENT_DECLINED` / `3DS_REQUIRED` / `RATE_LIMITED` / `CAPTCHA` / `BOT_DETECTED` / `SESSION_EXPIRED` / `CSRF_FAILED` 等业务语义分类。 |
| `CAP-I2` | 诊断输出结构化四段式：`Evidence → Diagnosis → Confidence → Recovery Strategy`；**Recovery 必须由 Diagnosis 驱动**，禁止无诊断的盲目重试。 |

**四问**：Q1 ✅（用户 §九：「失败后必须分析，而不是 retry」）｜Q2 ✅（业务语义分类通用）｜Q3 ✅（分类法通用）｜Q4 ✅（恢复成功率 2.17% 的直接解药）
**验收**：100-task 重跑后 `VERIFY_FAILED` 占比从 66% 降至 ≤ 25%（其余归入具体类别）；恢复成功率从 2.17% 提升至 ≥ 20%。

#### P0-7　登记 6 个已实现动作（`CAP-F1`，原 CAP-05）

把 `openTab` / `closeTab` / `switchTab` / `upload` / `download` / `dialog` 六个**已实现**动作登记进 `schema/action.js` 的 `ACTION_TYPES` 并补 `TYPE_RISK_FLOOR`。

**四问**：Q1 ✅（多标签、文件上传下载、系统弹窗是真实网站日常）｜Q2 ✅（通用浏览器能力）｜Q3 ✅（通用）｜Q4 ✅（解锁购物车、多步表单、导出文件等高频流程）
**验收**：六个动作在真实网站上可用；**成本约 6 行改动**，性价比最高的一项。

> ✅ **已修复（2026-08-29，STEP 7）**。六行动作确实只值 6 行，但只做这 6 行是不够的，
> 实测补了三件被漏掉的事（回归 `server/scripts/test_step7_action_surface.js`，86 条全绿）：
>
> 1. **只登记名字不写参数契约 → 模型照样产出非法结构**。`ACTION_CONSTRAINTS` 会自动把
>    `ACTION_TYPES.join(', ')` 列进提示，但模型不知道 `drag` 的终点在 `value`、
>    `dialog` 要 `target.intent`、`upload` 要 `target.url`。已在 `planner.js` 补六条参数说明。
>    另：`intent` 必须同时加进 `TARGET_KEYS`，否则规范化阶段只拷贝 `TARGET_KEYS` 列出的键，
>    `intent` 会在校验之后被静默丢弃 —— 又一处"校验通过但信息丢了"。
> 2. **`upload` 是唯一「把本机文件内容送到远端」的动作**，不限制路径等于任意文件外泄。
>    新增 `UPLOAD_ROOT`（`server/data/uploads`）白名单，`schema` 与 `tools` 各校验一次；
>    同时把目录内文件名列进 Planner 提示（模型看不到磁盘，否则只能瞎猜文件名反复被拒）。
>    风险下限定 `HIGH`，默认需人工审批。
> 3. **`dialog` 用平表定级会把 `accept` 与 `dismiss` 拉成同权**。`accept` 可能确认
>    「删除账号 / 确认支付 / 放弃未保存更改」，实际等价于 `delete`。新增 `INTENT_RISK_FLOOR`
>    做 `type:intent` 细分（accept→HIGH，dismiss→MEDIUM），并同步改 `policy.effectiveRisk`
>    —— 只改 schema 不改 policy，细分就白做了。
>
> 顺带修掉一个「漏配恰好等于默认值」的隐患：`check` 从未出现在 `TYPE_RISK_FLOOR` 里，
> 静默退回默认 `MEDIUM`，值恰好正确所以一直没暴露。

---


### 7.3 P1 — 应该做（有这些，产品才好用）

| ID | 内容 | 依赖 | 四问简答 |
|---|---|---|---|
| ~~`CAP-F2`~~ | ✅ **已修复（2026-08-29，STEP 7）**：新增 `hover` / `drag` 两个动作；iframe 部分**没有新增 `switchFrame`**，而是修好了既有 `' >> '` 寻址的选择器生成（详见下方说明）。同批修掉 `press` / `scroll` 的死参数（两者此前完全忽略 `action.target`，导致 iframe 内按回车、滚动列表不可能实现）。回归：`test_step7_action_surface.js`（86 条） | CAP-F1 | Q1 ✅ 悬浮菜单/拖拽上传/嵌套表单常见｜Q2 ✅ ｜Q3 ✅ ｜Q4 ✅ |
| ~~`CAP-L1`~~ | ✅ **已修复（2026-08-29）**：新增 `server/agent/paymentField.js`（通用支付字段识别 + 取值格式化）；`resolveFillValue` → `resolveFill`，按 autocomplete / 通用构词把卡号·有效期·CVV·持卡人映射到 `vault.card` 各段；`observation.js` 采集 `autocomplete` 并把敏感掩码扩到 autocomplete + `ccnum`/`cvv2`/`exp` 等漏网写法。**连带修掉两个死护栏**：① `SENSITIVE_FIELDS.includes(field.toLowerCase())` 比对的是驼峰列表 → `cardNumber`/`apiKey`/`passwordConfirm` 三项永远命中不了；② 页内掩码不看 autocomplete。回归：`test_step6_payment_capability.js`（144 条） | SEC-N4 | Q1 ✅ 支付是核心卖点｜Q2 ✅ ｜Q3 ✅ ｜Q4 ✅ |
| ~~`CAP-L2`~~ | ✅ **已修复（2026-08-29）**：新增 `server/agent/paymentStateClassifier.js`（只读五态：authorized / declined / 3ds_challenge / pending / failed），取代单一 `BUSINESS_PAYMENT_FAILED` 粗桶；新增 `wait_only` 重试策略 —— **pending 只等待 + 重新观察，刻意不含 reload**（支付 POST 后 reload 触发「确认重新提交表单」，自动确认 = 重复扣款）。3DS 唯一出口是 escalate。回归：同上（Case 11–17） | CAP-H1, CAP-L1 | Q1 ✅ ｜Q2 ✅ ｜Q3 ✅ ｜Q4 ✅ |
| ~~`CAP-K1`~~ | ✅ **已修复（2026-08-29，STEP 8）**：`flowPlanner.tryFlowPlan` 唯一读侧入口（validatePlan 门）+ `runtime.resolvePlan` 接线 + `stateFromStep/toPlan` 写读保真 + `fail/escalate` 失败反馈闭环（详见 6.3 表）。回归：`test_step8_flow_readback.js`（29 条） | CAP-I1 | Q1 ✅ 第二次更快（命中跳过导航观察+LLM）｜Q2 ✅ ｜Q3 ✅ ｜Q4 ✅ |
| `CAP-K2` | intelligenceRouter 决策接入执行链 | CAP-K1 | Q1 ✅ ｜Q2 ✅ ｜Q3 ✅ ｜Q4 ✅ |
| `CAP-K3` | siteMemory 成功侧写入接进生产链 | CAP-K1 | Q1 ✅ ｜Q2 ✅ ｜Q3 ✅ ｜Q4 ✅ |
| ~~`CAP-E5-LABEL-RANKING`~~ | ✅ **已修复（2026-08-29）**：排序层引入元素类别（控件 vs 描述性容器）+ 标签冗余降权 + 描述性封顶 + 同分控件优先，未整体重写 Resolver。回归：`server/scripts/test_step5_label_ranking.js`（26 条） | — | Q1 ✅ ｜Q2 ✅ ｜Q3 ✅ ｜Q4 ✅ |
| ~~`CAP-E6-NEARBY-TEXT-DEAD`~~ | ✅ **已修复（2026-08-29）**：COLLECT_JS 补三路邻近文本采集（`precedingText` / `siblingTextOf` / `containerTextOf`，只取紧邻在前文本以杜绝串味，全部走 redact）+ 描述性元素封顶。**已按备忘先加 COLLECT_JS 语法守卫**（`test_step5_nearby_text.js` Case 1/11，62 条全绿） | CAP-E5 | Q1 ✅ 真实站点大量用 div/h3 做字段标题而不写 label[for]｜Q2 ✅ ｜Q3 ✅ ｜Q4 ✅ |
| ~~`SEC-E7-TEMPLATE-ESCAPE`~~ | ✅ **已修复（2026-08-29）**：页内正则反斜杠被模板字面量吃掉，脱敏六条规则中四条失效（卡号/CVV/Bearer 明文进 LLM）。改为双反斜杠 + 补齐 CVV 词在前顺序 + 安全基线测试改为断言页内生效脚本 | CAP-E6（测试连带发现） | Q1 ✅ 直接决定敏感数据是否进模型上下文｜Q2 ✅ ｜Q3 ✅ ｜Q4 ✅ |
| ~~`CAP-M1`~~ | ✅ **已修复（2026-08-30，STEP 12）**：`scheduleTrigger.js` 定时触发/批量执行（aiSchedules 实体 + 1s tick 只扫到期 + 每 profile 独立任务 + 归属继承 + 执行链与 /execution/submit 同决策 + fail-open + 身份守卫）。测试 `test_step12_schedule_trigger.js` 72 条全绿 ×2（模块级：创建校验/批量 fire/直启 spy/入队 spy/tick 到期/PAUSED/fail-open/守卫矩阵；e2e：模式 B 全 CRUD + 触发 + 跨工作区拒绝 + task.scheduleId/归属继承断言；红线 2）。连带修复既有 flaky：test_step6 明文断言裸子串匹配 `timestamp: Date.now()`（13 位数字偶含 '917' 子串 ~1% 假阳性）→ 探针归零全部 JSON number 再匹配 | — | Q1 ✅ 运营刚需｜Q2 ✅ ｜Q3 ✅ ｜Q4 ⚠️ 属外围但商业价值明确 |
| ~~`CAP-C1`~~ | ✅ **已修复（2026-08-30，STEP 13）**：`/api/profiles/export` + `/api/profiles/import`（详见 §6.4）。测试 `test_step13_profile_transfer.js` 36 条全绿 ×2（e2e 模式 B：导出结构剥离/seed 连续性/跨工作区 403 fail-closed/迁移重新盖章/名称去重/MEMBER 权限边界/上限与校验/fail-open 结构；红线 2）。连带：`buildNewProfile` 抽取为单建/导入共享入口；test_step6 flaky 二次根因定位（observation 遥测回显 taskId 字符串内嵌时间戳随机含子串）→ 探针递归剔除遥测 ID 字段 | — | Q1 ✅ 多账号用户刚需｜Q2 ✅ ｜Q3 ✅ ｜Q4 ⚠️ |
| ~~`CAP-O1`~~ | ✅ **已修复（2026-08-30，STEP 11）**：`server/identity.js` 身份层（User/Workspace/Membership/Session 四 store，纯 JSON facade，`FPB_DATA_DIR` 可隔离）；密码 scrypt（`s1$salt$hash`）+ timingSafeEqual，明文禁入落盘/日志/LLM；session 落盘只存 sha256(token)，TTL 7 天；OWNER(11 权限)/ADMIN(8，无 workspace:update/delete/billing:manage)/MEMBER(3) 三角色静态矩阵，唯一检查入口 `identity.can/assertCan`——「ADMIN 授 OWNER → 403（不可转移 Owner）」即由权限矩阵自然实现；统一中间件链 `identityResolver → requireAuth`（auth.js 加 identityUser 早退），禁各 route 自写 if；**双模式兼容**：模式 A（本地单机，默认）loopback 惰性 bootstrap local 用户+默认工作区，既有行为零变化；模式 B（`FPB_API_TOKEN` 共享部署）机器 token ≡ local 用户（向后兼容），无身份 401 fail-closed；**Profile 第一批 workspace-scoped**：列表 `filterByWorkspace` + 单资源 `assertCanAccessResource`，跨工作区即使知道 id 也一律 403/不可见；AI Task 服务端盖章（不信任调用方伪造）；注册即赠个人工作区 + 主工作区=最近成员关系（创建即切换）；legacy 无归属资源仅 local 用户可见（零迁移，惰性不批量补齐）。**概念隔离**：Credential Vault 与 User Authentication 完全独立（vault 管网站凭据，identity 管登录身份）。测试 `test_step11_identity.js` 64 条全绿 ×2（模块级 32 + e2e 子进程生产入口 30 + 红线 2，含 RBAC 矩阵、跨工作区拒绝矩阵、机器 token 兼容、logout 失效、fail-closed）。**顺带修复存量 P0**：`browserManager` 孤儿 Chromium 清理从「每 Profile 目录一次 spawnSync（1538 目录→最多 1538 次同步 PowerShell）」重构为一次 `Get-CimInstance` 枚举 + Node 侧匹配（O(N)→O(1)）——原实现导致数据量大时启动事件循环冻结、HTTP 假死 | SEC-N3 | Q1 ✅ 团队/售卖账号场景必备｜Q2 ✅ ｜Q3 ✅ ｜Q4 ⚠️ 商业化地基 |

> **`CAP-F2` 最重要的一条判断：不要新增 `switchFrame` 动作。**
> 路线图原本写的是「补 hover / drag / iframe 切换三个动作」，但动手后发现 iframe 的
> **寻址方案本来就有且可用**（`observation` 生成 `iframe#x >> ...`，`tools.makeLocator`
> 消费，click/fill/select/check/uncheck/upload/download 七个分支都在用）。
> 真正坏的是**选择器生成错了**，而且错了两层：
>
> ① `observation` 用全局自增计数器生成 `iframe:nth-of-type(n)`。但 `nth-of-type` 的语义是
> 「同父级同类型兄弟中的第 N 个」，不是「全文第 N 个 iframe」。两个 iframe 分属不同容器时
> 正确索引都是 1，计数器却给出 1 和 2 → 选择器指向不存在的元素（实测命中 0 个）。
>
> ② 那么换成「同父级序号」够不够？也不够 —— 上面那个例子里两个 iframe 的 `nth-of-type`
> 都是 1，选择器变成**歧义**的（实测 3 个分属不同容器的 iframe 会被
> `iframe:nth-of-type(1)` 全部命中，Playwright 严格模式下直接抛 strict mode violation）。
>
> 本质错配：**数的是文档序，写出来的却是同父级序**。修法改为「候选 + 唯一性校验」：
> 优先 `iframe#id` / `iframe[name=...]`，位置兜底用 Playwright 的 `:nth-match(iframe, n)`
> （表达的正是文档序，且天然唯一）。若此时再新增一个有状态的 `switchFrame` 动作，
> 就会形成两套寻址体系互相打架，且 frame 上下文状态会在 step 之间泄漏。
>
> **同批发现的两个「死参数」**：`press` 与 `scroll` 此前完全忽略 `action.target`
> （而 schema 又强制要求 target）。`press` 直接 `page.keyboard.press()`，键盘事件只发给
> 当前焦点 —— 于是在 iframe 内的输入框里按回车根本不可能实现。现在两者都先解析 target，
> 解析不出再退回原行为（fail-open，既有行为不退化）。
>
> **一个连带的能力缺口**：观察集不收 `draggable="true"` 的元素。看板卡片、拖拽排序、
> 拖拽上传区大量用 `<div draggable="true">` —— 它既不在 `INTERACTIVE_TAGS` 里也没有
> `role`，于是被整条采集链丢掉，Planner 根本看不见拖拽源。已按标准属性放行。
> 但拖拽的**放置区**通常只是个纯容器（不 draggable），观察集依然收不到，
> 所以 `resolveDropTarget` 做了三级兜底：CSS 选择器 → 语义解析 → Playwright 文本引擎。
> 第三级是必需的，因为「拖到写着『回收站』的那块地方」是模型最自然的表达。
>
> **方法论沉淀（测试侧）**：`page.locator('a >> b')` 在本版本 Playwright **不穿透 frame**，
> 恒返回 0 —— 所以验证 observation 产出的选择器必须用生产代码 `tools.makeLocator`
> （已导出）来解析，用 `page.locator` 断言会得到「全是 0」的假结果。

> P1 里的 `CAP-E5` / `CAP-E6` / `SEC-E7` / `CAP-L1` / `CAP-L2` / `CAP-F1` / `CAP-F2`
> 已于 2026-08-29 全部修复并从 `server/scripts/KNOWN_GAPS.json` 移出（该表当前 `gaps` 为空）。
>
> **`CAP-L1` 的两条方法论沉淀**：
> ① **「看起来在生效」的护栏要专门验证一次**。禁止敏感字段字面量的判定写了三年，实际因为
> `toLowerCase()` 比对驼峰列表而从未命中过 —— 死护栏比没有护栏更危险，因为它会让人以为已经挡住了。
> ② **短词只能精确命中、复合词只能子串命中**。`exp` / `pan` / `cid` 这类三字母词做子串匹配，
> 会把 `expand` / `panel` / `customer-id` 全误伤；而 `cardholdername` 又必须靠子串才能命中
> `cardholder`。两套键集都从 `paymentField.js` 以 `JSON.stringify` 注入页内脚本，
> 从机制上杜绝 Node 侧与页内脚本漂移（SEC-E7 的教训）。
> **方法论沉淀（本案最值钱的部分）**：`SEC-E7` 不是被审计发现的，是被 CAP-E6 的**端到端断言**挖出来的 ——
> 此前 `test_security_baseline.js` 从**源码文件**里 eval 出 redact 再断言，绕过了模板字面量的转义处理，
> 于是「源码看起来对 / 测试全绿」与「页内实际失效」可以同时成立。
> 凡是被 `page.evaluate(字符串)` 执行的脚本，测试都必须断言**求值后的那份文本**，而不是源码里的那份文本。

---

### 7.4 P2 — 后续做（商业化与规模化）

| ID | 内容 |
|---|---|
| ~~`CAP-O2`~~ | ✅ 已修复（2026-08-30，STEP 14）。三层：**审计**——`server/audit.js`：`log(entry)` 唯一写入口（workspaceId/actorId/actorName/actorType=user\|api_key\|local/action/resourceType/resourceId/detail）、MAX_ENTRIES=5000 环形、内存缓存+300ms 防抖落盘 `identity_audit.json`（查询/导出走内存，测试确定性）、`redact` 递归脱敏（SENSITIVE_KEY_RE：password/secret/token/card/cvv/cvc/authorization/cookie/credential → `«redacted»`，字符串截断 200，深度 4）；查询 `GET /api/auth/audit?workspaceId=&action=&resourceType=&actorId=&limit=`、导出 `GET /api/auth/audit/export`（均 audit:read=OWNER/ADMIN）。**API Key**——`identity.createApiKey/apiKeyByToken/revokeApiKey/listApiKeys`：明文 `fpbak_`+48hex 只在创建响应出现一次，落盘 `{keyHash: sha256, prefix, userId, workspaceId, readOnly, lastUsedAt(60s 写节流), revokedAt}`；解析优先级 session > fpbak_（无效明确 fail-closed null，绝不落回 loopback/机器 token 分支）> 模式A loopback > 机器 token；key 身份 = 所属用户 + 固定 currentWorkspaceId（`__apiKey` 标记），RBAC 零新体系全继承；`enforceApiKeyWriteGuard`（业务挂载：readOnly 写 403）与 `enforceNoApiKeyWriteGuard`（/api/auth 内：任何 key 写 403，防「用 key 造 key」自举提权）；上限 20/user/workspace；CRUD `POST/GET/DELETE /api/auth/api-keys*`。**守卫补全**——Proxy（列表过滤/创建 profile:manage/改删归属校验/响应不回显明文密码/防归属字段伪造）、WorkflowTask（task:manage 同构）、Vault（读 profile:use / 写 credential:manage）、Browser launch/stop/screenshot/navigate、Automation run、Cookies 全部挂 profile:use 归属校验；POST /profiles 收紧为 profile:manage（与 import 一致）。**连带修复**——proxy/vault 写路径 try/catch 返回 JSON（此前 FPB_MASTER_KEY 缺失时 vault.encrypt fail-closed 抛错 → Express 裸 500 HTML，e2e 挖出）。回归 `test_step14_apikey_audit.js` 70 条 ×2（模块级 audit/ApiKey/guard 单元 + 模式 B e2e D–H 八段 + 红线） |
| ~~`CAP-A1`~~ | ✅ 已修复（2026-08-30，STEP 15）。**模板库**——`server/fpTemplates.js`：`OVERRIDE_KEYS` 22 键白名单归一化（未知键剥离，防垃圾/夹带进生成器）；`validateTemplateInput`（IANA 时区 Intl 校验 / LOCALE_RE / screen 320-16384 / hardwareConcurrency 1-64 / deviceMemory∈{1,2,4,8} / timezoneMode/languageMode 枚举）；`mergeTemplateIntoInput`（优先级：显式 input > 模板 > 全局默认）。**路由**——`/api/templates` CRUD（workspace 盖章 + filterByWorkspace；创建/改/删 = profile:manage，读 = 成员；GET /:id/check 声明在 /:id 之前）；POST /profiles 接受 templateId（模板可见性走 canAccessResource，404/403 区分）；**POST /profiles/batch**（count 1-50、namePrefix+序号、group=batch、**强制独立 seed**——调用方传同一 seed 一律忽略，杜绝整批克隆；逐条 fail-open 与 import 同语义）。**模板级一致性自检**——GET /templates/:id/check：对模板名下全部可见 profile 聚合 integrity 体检 + **契约漂移检测**：模板钉住键 vs profile 当前 override 逐键 JSON 比对，`templateOverrides`（创建时显式覆盖键清单）豁免合法偏离，绕过模板流程的改动判 DRIFT——关键认知：生成器对非法 override（如坏时区）会**静默回退**到合法随机值，fp 层面无异常可抓，必须在契约层比对。**连带修复**——POST /profiles 对 buildNewProfile 抛错（模板 404/403）无 try/catch → async rejection 请求悬挂超时（Express 4 不接 async 错误）。回归 `test_step15_fp_templates.js` 55 条 ×2（模块级 A-C + e2e D-I + 红线） |
| ~~`CAP-B1`~~ | ✅ 已修复（2026-08-30，STEP 16）。**健康度**——`server/proxyPool.js`：`recordCheck(proxy, result)` 滑动窗口（HEALTH_WINDOW=20，push→shift 裁剪，lastCheck 兼容回写）；状态机 `healthOf`：unchecked（无记录）→ healthy → degraded（窗口内连续失败≥1）→ dead（DEAD_THRESHOLD=3）；`metricsOf`：{status, checked, successRate（窗口 ok 占比，2 位小数）, avgLatencyMs（仅成功样本）, consecutiveFails, lastCheckedAt}。**服务端事实原则**——健康数据只能由 POST /proxies/:id/check 的 recordCheck 写入；客户端 PUT 剥离 `['id','workspaceId','createdBy','lastCheck','health']`，伪造健康档案无效（e2e 实证：PUT 伪造后仍 dead）。**轮换**——池 = `proxy.pool` 可选字符串（normalizePool trim+截断）；`pickReplacement(poolName, excludeId, proxies)` 同池非 dead 候选按 STATUS_RANK（healthy<unchecked<degraded<dead）→ successRate 降序 → avgLatency 升序 → id localeCompare 确定性排序取首；**跨池绝不轮换**；`chooseRotation(profile, proxies)` 纯函数五种不换 reason（not-saved-proxy / auto-rotate-disabled / current-not-found / current-not-dead / no-healthy-alternative，全 fail-open 保持原代理，绝不因健康数据静默改变执行语义）；显式 POST /proxies/rotate（profile:manage，改的是 profile）+ browser launch 启动前自动轮换钩子（仅 profile.proxyAutoRotate===true 且当前 dead 且同池有替补，审计 proxy.auto_rotate）；GET /proxies/health 汇总（filterByWorkspace + summary 计数）。**连带修复真实缺陷**——buildNewProfile 与 PUT /profiles 均未持久化 `proxyAutoRotate`：创建/更新时传入恒被静默丢弃，显式与自动轮换全部失效（e2e F 段挖出），已补字段落盘。回归 `test_step16_proxy_pool.js` 44 条 ×2（模块级 A-D 状态机/决策矩阵 + e2e E-G 健康汇总/防伪造/显式轮换与授权 + 审计红线） |
| `CAP-M2` | 可视化工作流编排 |
| `CAP-COMM-1` | 计费 / 订阅 / 试用 |
| `CAP-COMM-2` | 团队 SaaS 外壳（成员管理、配额、用量看板） |

---

### 7.5 P0 全表（一页速览）

| # | ID | 内容 | Q1 用户用 | Q2 未知站 | Q3 通用 | Q4 增强完成力 | 成本 |
|---|---|---|---|---|---|---|---|
| 1 | `SEC-N1~N5` | 安全基线（拖库/RCE/鉴权/脱敏/主密钥） | ✅ | ✅ | ✅ | ✅ | 极低 |
| 2 | `CAP-J1` | 解除升级死锁 | ✅ | ✅ | ✅ | ✅ | 极低 |
| 3 | `CAP-G1` | 消除验证 silent pass | ✅ | ✅ | ✅ | ✅ | 低 |
| 4 | `CAP-E1/E2` | 清掉执行链站点类型分支 | ✅ | ✅ | ✅ | ✅ | 中 |
| 5 | `CAP-H1/H2` | 网络智能层 | ✅ | ✅ | ✅ | ✅ | 中高 |
| 6 | `CAP-I1/I2` | 失败诊断接入生产链 | ✅ | ✅ | ✅ | ✅ | 中高 |
| 7 | `CAP-F1` | 登记 6 个已实现动作 | ✅ | ✅ | ✅ | ✅ | 极低 |

---

## 8. Benchmark Role

### 8.1 定位（用户 §十五）

> **Benchmark 是测试工具，不是产品目标。**

`benchmark/`、`mock-site/`、`server/scenarios/*`、`saas/login.html`、`ecommerce/cart.html`
**全部降级为自动化回归测试资产**。它们的唯一用途是：防止已修好的能力在后续开发中被改坏。

### 8.2 一票否决判据

任何为 benchmark 提出的能力，必须先回答：

> **「这个功能是不是现实网站也需要？」**
>
> 答「只有 mock 站点需要」→ 拒绝。
> 答「是」→ 举出一个真实网站的具体例子，说不出来就是没有。

### 8.3 明令禁止（红线）

| # | 禁止行为 |
|---|---|
| R1 | 为某个 benchmark 特例增加 `if taskId === 'xxx'` |
| R2 | 为某个 fixture 结构增加 `if site === 'xxx'` / `if siteType === 'saas'` |
| R3 | 为提高分数修改 **success definition** |
| R4 | 为提高分数修改 **benchmark scoring** |
| R5 | 为提高分数修改 **verification truth** |
| R6 | 因某个 benchmark 失败而添加网站专用逻辑 |
| R7 | 大规模重写 Agent 架构（用户 §二十二：已有架构不删除，只重新定位） |
| R8 | 不断增加 Phase 文档（本文档使用 A–O 能力 ID，不再新增 Phase 编号） |

### 8.4 指标优先级（用户确认的严格顺序）

```
1. Business Success        ← 终极指标
2. Real Escalation         ← 真实能力弱点导致的升级（非安全门控）
3. VERIFY_FAILED / ELEMENT_NOT_FOUND
4. Business Recovery / VIL Recovery
5. 场景矩阵 / Long Workflow 成功率
6. Execution Success       ← 仅辅助指标，绝不作为产品成功的替代品
```

> `agentScore.verification = 100` 与 `verificationAccuracy = 36.81%` 并存，
> 是"辅助指标冒充产品成功"的活标本。以后者为准。

### 8.5 评测纪律

- 最终验收基准必须 **CODE FREEZE**（`server/agent/**`、VIL、resolver、repair/recovery、success definition、benchmark 判定逻辑全冻结）
- 跑批期间**只分析、不修改**
- 复用资产：`phase12_pool.json`（100 task）、`server/scripts/phase12Benchmark.js`、`analyze_phase12.js`（纯只读）
- **禁止**：因为分数不好看而在跑批中改代码或重跑

---

## 9. Real Website Validation

### 9.1 原则

> Benchmark 分数不承认真实网站。真实网站才有最终否决权。

### 9.2 六 Scenario 的真实网站验收表

| ID | Scenario | 验收标准 | 当前 |
|---|---|---|---|
| 001 | 打开并理解未知页面 | 说得出"这是什么页面、能做什么、下一步能点哪" | ⚠️ 待 CAP-E2 |
| 002 | 注册账号 | 注册成功并验证；邮箱已存在时识别为 `ACCOUNT_ALREADY_EXISTS` 而非盲目重试 | ❌ 待 CAP-E5 + CAP-I1 |
| 003 | 登录 | 登录成功并通过业务态验证（不是"页面变了"） | ⚠️ 待 CAP-G1 |
| 004 | 选择会员套餐 | 多标签/弹窗流程下完成选择 | ❌ 待 CAP-F1 |
| 005 | 授权并完成支付 | 授权测试环境下完成，五态可区分，审计完整 | ❌ 待 CAP-L1/L2 + SEC-N4 |
| 006 | 失败后自动恢复 | 注入 401/429/Captcha/Session 过期，AI 能识别并恢复 | ❌ 待 CAP-H1/H2 + CAP-J1 |

### 9.3 未知网站分层准入

| Tier | 场景类型 | 准入判据 |
|---|---|---|
| **Tier 0** | 授权测试环境（支付） | 五态可区分 + 审计完整 + 脱敏生效 |
| **Tier 1** | 未知 SaaS 产品站 | 001/002/003 全通，**零站点专用代码路径** |
| **Tier 2** | 未知电商站 | 004 + 购物车流程，零站点专用代码路径 |
| **Tier 3** | 未知 AI 工具站 | 002/003 + API Key 获取 |
| **Tier 4** | 未知会员/内容站 | 003 + 004 + 订阅 |

**每一 Tier 的准入判据相同：不使用任何站点专用代码路径完成全部流程。**

### 9.4 验收阶段门槛（分阶段，不一次性）

```
Gate 0  代码冻结 + 基线快照
Gate 1  1 个未知网站 × 3 次  —— 通过才扩展
Gate 2  归因分析（每次失败必须归入具体类别，不允许 unknown）
Gate 3  扩展至每 Tier 5 个未知网站 × 3 次
```

---

## 10. Commercialization

### 10.1 现状：能力成熟度的巨大落差

```
A 指纹浏览器 ████████████  商业级
B 代理网络   ████████████  商业级
C Profile   ███████░░░░░  可用，缺批量
D AI Operator ██░░░░░░░░  架构完整，业务 6/100
E 页面理解   ██████░░░░░  采集强，理解被污染
F 动作执行   ███████░░░░  缺高频动作
G 验证       ████░░░░░░░  36.81%
H 网络智能   ░░░░░░░░░░░  MISSING
I 失败诊断   ░░░░░░░░░░░  MISSING（生产链）
J 自愈       ██████░░░░░  框架在，升级死锁
K 记忆学习   ██████░░░░░  写入修好，读侧空转
L 支付自动化 ███░░░░░░░░  AI 链路 BROKEN
M 工作流     ███████░░░░  调度在，定时缺
N 安全       ██░░░░░░░░░  BROKEN（可被 RCE + 拖库）
O 团队 SaaS  ░░░░░░░░░░░  MISSING
```

### 10.2 商业化四层

| 层 | 目标用户 | 依赖成熟度 | 当前可否售卖 |
|---|---|---|---|
| **Individual** | 个人跨境/多账号用户 | A + B + C 已达商业级 | ✅ **现在就能卖**（指纹浏览器本体） |
| **Pro** | 需要 AI 自动化的个人 | A–G 达标 + N 达标 | ❌ 缺 N + G |
| **Business** | 小团队 | + O1（用户/权限） | ❌ 缺 O |
| **Enterprise** | 自部署 / 私有化 | + O2（多租户/审计导出） | ❌ 缺 O2 |

### 10.3 商业化路径建议（与 P0 对齐）

```
阶段一（现在即可）  以「指纹浏览器 + 代理网络」本体切入 Individual 层
                    → 但必须先完成 SEC-N1~N5，否则卖出去的是一台远程可入侵的机器

阶段二（P0 完成后） 以「AI Browser Operator（真实网站可用）」切入 Pro 层
                    → 核心卖点从"防关联"升级为"防关联 + AI 替你干活"
                    → 差异化对标 AdsPower / 比特：它们没有 AI Operator

阶段三（P1 完成后） Business 层：团队权限 + 批量 Profile + 定时任务

阶段四（P2 完成后） Enterprise 层：私有化 + 多租户 + 审计导出
```

### 10.4 差异化定位（一句话）

> **AdsPower / 比特浏览器卖的是"让你看起来像很多个人"。
> 我们要卖的是"让你看起来像很多个人，并且 AI 能替其中每一个人在真实网站上把事情办成"。**

前半句已经是商业级（A + B），后半句需要 P0 全部完成。

### 10.5 待决问题（不在本文档裁决，需用户确认）

| ID | 问题 | 为何待决 |
|---|---|---|
| **Q4** | 生产环境支付自动化是否在路线图内？（用户 §4 要求支持 vs §22 把 Scenario 005 限定在授权测试环境） | 决定 `CAP-L1/L2` 的验收环境范围与合规投入 |
| **Q-A** | 是否分叉发布「指纹浏览器本体」（Individual 层，可立即售卖）与「AI Operator」（Pro 层）两条线？ | 决定 P0 期间是否同步推进商业化外壳 |
| **Q-B** | 许可证是否维持专有商业许可，或在某个时间点切换 BUSL-1.1（延迟开源）？ | 已在 `LICENSE` 附选型说明，待决策 |

---

## 附录 A：本次审计的取证方法

| 结论 | 取证方式 | 未采信的表象 |
|---|---|---|
| H = MISSING | 读 `observation.js:16-26` 源码 + `ls server/data/` 无 network 文件 + 全仓 `newCDPSession` 只有 1 处且用于 UA 覆写 | `grep page.on('request')` 会命中 → 极易误判 EXISTS |
| `SEC-N4` 脱敏失效 | 打印正则 `re.source` + `re.test("4111 1111 1111 1111")` 运行时验证，4 条样本全部未脱敏 | 代码里"有脱敏函数" → 误判为已实现 |
| `CAP-G1` silent pass | 追 `executor.js:58` → `verifyFailed.js:112` → `verification.js:110-120` 完整链路 + 测试固化 | 「验证通过率 100%」的 agentScore |
| `CAP-E1` 站点分支在生产链 | 确认 `tools.js:206` 在每个动作执行前调用 `contextGuard.guard()` | 「只是启发式辅助判断」 |
| 数据集漂移 | 取证测试判据用**语料规模/命中率**而非**文件存在** | 「文件在」→ 误判数据仍有效 |

**教训（供后续审计复用）**：
1. **数据集漂移比数据集缺失更隐蔽** —— 判据必须是内容规模，不是文件存在。
2. **"有函数"不等于"功能生效"** —— 脱敏、验证这类安全/正确性功能必须运行时验证。
3. **grep 命中不等于能力存在** —— 计数器 `page.on('request')` 与网络智能层是两回事。

## 附录 B：文档状态与后续

| 项 | 状态 |
|---|---|
| STEP 1 工程地基 | ✅ 完成（回归 33 通过 / 0 失败，git `03a1048`） |
| STEP 2 STOP | ✅ 已遵守，未自动继续开发；原计划的 CAP-05 从"现在实现"改为"纳入 P0"（`CAP-F1`） |
| STEP 3 只读审计 | ✅ 完成，全程未修改任何源码 |
| STEP 4 生成 Roadmap | ✅ 本文档 |
| STEP 5 P0/P1/P2 | ✅ 见 §7 |
| **STEP 6 等待授权** | ⏸ **当前状态。不开始任何代码修改，等待下一阶段开发授权。** |

**下一阶段授权后建议的执行顺序**：
`SEC-N1~N5`（1 天）→ `CAP-F1`（半天）→ `CAP-J1`（半天）→ `CAP-G1`（1 天，含翻转 §2b 标记用例）
→ `CAP-E1/E2`（3–5 天，含真实网站验证）→ `CAP-H1/H2`（5–8 天）→ `CAP-I1/I2`（5–8 天）
→ Gate 1 验收（1 个未知网站 × 3 次）。
