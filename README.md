# 指纹浏览器 (Fingerprint Browser) — v0.2.0-rc1

基于 **Chromium** 的多账号隔离与管理工具：**指纹身份**、**代理隔离**、**加密凭据/支付保险库**，以及 **AI 自动化执行引擎**（LLM Planner 驱动真实浏览器完成任务：开站、填表、登录、搜索、验证、修复重试、业务结果核验）。

当前版本 `0.2.0-rc1`：v2 任务池（100 真实站点任务、真实 deepseek LLM）**99% SUCCESS + 1% 可信人工升级 = 100% 可接受结局率**（canonical240 基线，run6 2026-09-04）。

> 📖 **使用手册**：每个面板怎么用、常见工作流、FAQ、安全红线 → [docs/USER_GUIDE.md](docs/USER_GUIDE.md)

## 技术栈
- 后端：Node.js + Express + Playwright（控制 Chromium / 自定义 native 构建）
- 前端：React + Vite + TailwindCSS（AI Operator Console 仪表盘）
- LLM：DeepSeek（`deepseek-chat`，Planner / Diagnosis / Repair）
- 存储：本地 JSON（`data/`）+ 可选 SQLite（storeFacade 驱动切换）
- 敏感数据：AES-256-GCM 加密保险库（`server/vault.js`）

## 快速开始
**Windows 一键启动（推荐）**：双击 `start.bat` —— 自动装依赖 → 构建前端 → 生成保险库主密钥（写入 .env）→ 启动服务 → 自动打开控制台 `http://127.0.0.1:8787`。AI 功能在控制台「系统设置」里粘贴 DeepSeek API key 即可（密文落盘、即时生效，无需重启）。

手动方式：
```bash
# 1. 安装依赖（后端 + 前端）
npm run install:all

# 2. 安装 Chromium（仅首次）
npx playwright install chromium

# 3. 配置环境变量：复制 .env.example 为 .env 并填写
#    服务端启动时自动加载 .env（显式环境变量优先，不覆盖）
#    DEEPSEEK_API_KEY=sk-...   ← 也可在 UI「系统设置」配置（推荐）
#    FPB_MASTER_KEY=...        ← 加密保险库主密钥（start.bat 会自动生成）

# 4. 启动
npm run dev     # 开发模式（后端 8787 + 前端 5173 热更新）
npm start       # 仅后端（生产/长跑；自动服务 client/dist 静态前端）
npm run build   # 前端构建（client/dist）
FPB_NO_EMPTY_OUT_DIR=1 npm run build   # 零删除构建（dist 累积后清空动作会被 safe-delete 守卫拦截时用）
npm test        # 全量回归（runRegression.js 219 项 + phase9 212 项双护栏）
```

**一键启动（Windows，推荐）**：双击仓库根 `start.bat` —— 自动完成 Node 检查 → 服务端依赖 → 客户端依赖 → 前端构建 → 生成并写入 `FPB_MASTER_KEY` → 起服务并打开 `http://127.0.0.1:8787`。发布包解压后同样是双击 `start.bat`。

**首次运行就绪度自检**：控制台「就绪检查」页会在进入时自动跑一遍，并在必需项缺失时自动落到引导页（不再让用户猜缺什么）。

| 类别 | 检查项 | 未通过时做什么 |
|------|--------|----------------|
| 必需 | 身份会话 | 本机模式自动引导；多用户模式去「治理中心」建账号与角色 |
| 必需 | LLM 凭据 | 「系统设置 → LLM」填 provider + Key，点「测试连通」（Key 永不明文出站，只回 last4 掩码） |
| 必需 | 浏览器配置 | 「配置管理」新建配置后启动浏览器 |
| 可选 | 指纹模板 / 代理 / 自动化任务 | 缺失不影响启动，只影响对应能力 |

同口径机读端点：`GET /api/settings/readiness` → `stage: READY | SETUP_REQUIRED` + `checks[]`（每项含 `optional`、`hint`、`panel` 用于前端跳转）。

前端控制台：`http://localhost:5173`（开发）/ 后端 API：`http://localhost:8787`。

## 功能总览
| 能力 | 说明 |
|------|------|
| Profile 与指纹身份 | 种子化可复现指纹（UA/UA-CH/screen/时区/语言/字体/WebGL/Canvas/Audio/硬件），headful 真实分辨率回填，headless CDP metrics 对齐；运行态快照（时长/当前页面/页签数/代理，5s 轮询） |
| Native 身份架构（16-B） | 6 个 Chromium native patch ACTIVE（webdriver/platform/platformVersion/hardwareConcurrency/deviceMemory/maxTouchPoints），manifest=真实已启用架构，opt-in 缺省逐字节 stock；languages 走 CONFIG 层 pref 注入三端同源 |
| 代理管理 | HTTP/SOCKS5，出口 IP 预检、代理-指纹一致性（基于 IP 的时区/语言/地理推导） |
| 加密保险库 | 邮箱/密码/卡号/CVV 加密存储；LLM 永不见明文 CVV/卡号（credentialRef + masked） |
| AI 自动化引擎 | Planner→Runtime→Verification→Repair→Escalation 全链：业务状态核验、失败诊断、churn 熔断、replan 契约、凭据启动预检、可信升级（CREDIBLE_BUSINESS） |
| 调度与并发 | 定时触发（固定间隔 + cron 表达式按表不漂移）、批量执行、Worker 池、容量管理、断点续跑、崩溃恢复 |
| 可观测性与控制面 | AI Operator Console：任务时间线、VIL/ESCALATION 节点、指标面板、事件取证；执行引擎面板（调度器控制 / Worker 池 / 队列 / 资源池获取释放 / 提交执行 / 崩溃恢复扫描 / 动作契约与策略只读调试）；数据备份一键导出与全量恢复 |
| 智能记忆 | 站点画像 / 元素记忆 / 流记忆 / 失败知识只读面板 + 经验包导出导入（跨环境迁移）+ Router 决策试算 / 环境推荐 / 经验健康看板（准确率、LLM 节省、Memory ROI、站点×环境矩阵） |
| 治理与合规 | API Keys 自管（明文仅创建时出现一次、只读标记、撤销即失效）、凭据引用注册表（credentialRef 脱敏视图 + 明文就绪状态现算）、安全审计日志（只写不可篡改 + 过滤查询 + JSON 导出）、工作空间与成员 RBAC |
| 任务取证 | 单任务详情：结构化诊断（根因/置信/重试策略/证据/失败快照）、修复尝试与策略成功率、执行记录、动作链重放 |
| 评估基准 | 冻结 v2 任务池（100 任务）+ canonical240 基线 + 双回归护栏（219/0 + OK=212/BAD=0，全绿） |

## 发布包（portable）
```bash
node server/scripts/pack_release.js --zip   # 产出 release/identra-vX.Y.Z-win64.zip
```
目标机器只需 Node 18+：解压 zip → 双击 `start.bat`（自动装依赖/构建/生成主密钥）→ 控制台自动打开 → 「系统设置」粘贴 DeepSeek key（即时生效）。打包器含安全红线：`.env` / vault / 运行时设置 / node_modules 一旦检出即 fail-fast，真实凭据绝不随包分发。

## 常用命令
```bash
npm run dev            # 开发：后端 + 前端
npm start              # 仅后端
npm test               # 全量回归（server/scripts/test_*.js 自动发现）
bash server/scripts/run_phase9_regression.sh   # 第二回归护栏（顺序执行）
```

## 架构要点
```
server/
  index.js            # Express API + 静态托管
  browserManager.js   # 浏览器生命周期 / CDP / 指纹接线（C7-CONFIG: languages pref 注入）
  fp/
    generate.js       # 指纹生成（种子可复现）
    inject.js         # JS 注入层（navigator/screen/canvas/WebGL/Audio/WebRTC/UA-CH 回放）
    uaBrands.js       # UA-CH brands 唯一事实源=原生运行时捕获回放（P4.2）
    nativePatchManifest.js  # Native patch 注册表（enabled=已被 POC 证明的数量）
    identity*         # identity schema/factory/store（16-B 身份同源）
  agent/              # AI Operator：planner/runtime/verification/repair/intelligence
  scripts/            # 测试与基准（test_*.js 自动发现；runRegression/phase9/canonical240）
client/               # React 仪表盘
data/                 # 运行时存储（gitignore）
.benchmark/           # 取证与报告（gitignore）
```

## 当前基线（2026-09-11）
- **C108（mock plan strict 契约修复）**：收口 C79 登记的真实 A 类缺陷——`provider.mock planForTask` 返回「规范化运行时 Step」（action 为对象、顶层 `type: 'NAVIGATE'`），而 `planner.planObjective` 按「严格 Step 契约」消费（`normalizeStrictToCanonical`：顶层 action=动作字符串 + semantic/expectedResult）→ 归一后全部步骤退化为 ACT/空 action/空描述 → `validatePlan` 恒拒绝 → **mock planObjective 恒失败**：/chat mock 模式恒 400（session 创建后规划阶段失败）、runtime REPLAN 恒 fail-fast（恢复链「意外地快」是死路径副作用，不是性能）。修复：planForTask 产出严格 Step 契约（与真实 LLM provider `deepseekPlan` 同走 `validatePlanStrict` 自校验 fail-loud，契约漂移在生成期炸掉而非校验层静默重试三次后 400）+ 凭据契约对齐（有 ref → email/password 身份字段一律 credentialRef 禁 value 编造；无 ref → 零 credentialRef 且敏感字段动作不规划，空集反向守卫）。**附带时序重基线（C79 专门批次承诺的收口）**：mock REPLAN 变为真实可用 → step22 受控失败注入场景（F1）恢复链多走「repair 耗尽 → replan → 执行 → 再失败 → 升级」全程，实测 **193.4s 到 HUMAN_ESCALATION**（c108_run1/run5/run6 三跑一致，事件级证据 `.benchmark/c108_step22_run*.log`）；`runRegression` 对该套件启用**专属超时覆盖**（480s，仅执行时间窗对齐真实恢复链成本，**断言口径零变化，非降阈值**）+ step22 等待窗 180s→300s 观测真实终态（`PAUSED_FOR_HUMAN` 计入显式交人终态）。守护测试：`test_c108_mock_planner_contract` **21/0**（P1 空集反向守卫 + P2 planObjective 全链 NAVIGATE 打头/入口地址保真/描述非空 + P3 凭据引用对齐 + P4 引用不可用清单不误伤 + P5 漂移守卫 + P6 REPLAN 死路径激活实证 + P7 真实服务器 /chat 200+taskId+计划挂载，tmp 隔离零浏览器）；既有断言升级到修复后行为（修断言不放宽阈值）：`test_c79`（chat 400→创建 session+任务归属取证）、`test_c84`（P1d 400+审计留存 → 200+taskId 且审计锚定任务 id，更强归属断言）。双回归全绿 **214/0（699.7s）+ OK=207/BAD=0** 双历史最佳（`.benchmark/c108_runregression3.log` / `c108_phase9.log`）。
- **PHASE 17-A（决策消费 + 凭据安全）**：两个 P0 落地并双回归全绿 **213/0 + OK=206/BAD=0**。**P0-A Credential Action Authorization Gate**（新模块 `server/agent/credentialAuthorization.js`）——R6 实证「误点第三方授权入口 → 导航到 `github.com/login` → 继续把环境凭据写进第三方域输入框 4 次」；废弃 C106 F21「双向子域包含」判据（字符串相似 ≠ 授权关系），改建 `Task → Authorized Flow → Allowed Origin → Credential Action` 显式授权上下文：十级判定（非凭据动作放行 → 授权上下文缺失 / originless 本地上下文 / origin 不可解析 / 挑战页 / 跨 origin iframe → 显式授权 → 第三方 OAuth 面不继承主站授权 → 运行期授予 → opt-in 流程跳转 → 其余拒绝），无法证明 AUTHORIZED 一律 **fail closed**；闸门在 `tools.js` 三处接线（动作前 + 定位后 + 目标元素所在文档 origin 复检），runtime 对 `CREDENTIAL_ACTION_BLOCKED` **不重试/不 repair/不 reload**，直接 `escalate` 并写安全 evidence（不落凭据值）。**P0-B Diagnosis Decision Gate**（新模块 `server/agent/diagnosisDecision.js`）——R3 实证「LLM 已正确诊断『分步表单，密码框尚未出现』(conf 0.95)，Runtime 仍机械重放 `fill password` 12 次 / 473s」；六态 `STATES`（TARGET_NOT_PRESENT_YET / MULTI_STEP_FORM / NAVIGATION_IN_PROGRESS / CROSS_ORIGIN_DRIFT / SECURITY_CHALLENGE / TARGET_STALE）→ `POLICY`（block/require/allowAdvance/maxRepeats/escalate/noRepair/credentialOnly），诊断**拥有 BLOCK CURRENT ACTION 的能力**；刻意**不是 Verification**——`evaluate` 输出无 `success`/`verified` 字段，只能改下一步动作策略，不能产出 SUCCESS、不能改 Success Definition、不能绕 Verification。**Anti-flapping 最小修复**：同失败签名 + 决策未变 + `noRepair:true` → 直接 escalate，**只停止重复 repair，不重写 repair engine**（历史同签名可空转 21 次 repair）。守护测试：`test_c107_credential_boundary` 34/0（契约 + 静态断言：无站点名字面量 / 无残留子域包含判据 / 闸在观察之前）+ `test_c107_credential_boundary_fixture` 17/0（真实 Chromium 闸门层）+ `test_c107_r6_crossorigin_replay` 21/0（真实 runtime 端到端：第三方域 password fill **4→0**、页面余额 **空**、repair **反复→0**、reload **无限→0**、耗时 **长循环→3.4s**、终态 `HUMAN_ESCALATION`）+ `test_c107_diagnosis_consumption` 18/0（R3：password fill **12→2**、repair **21→0**、**473s→20.6s**）+ `test_c107_anti_flapping` 17/0（含**负向对照** `repairCalls` 正例 0 vs 反例 1，排除「repair 链路本身坏掉」的假绿）。**附带修复一类系统性测试缺陷**：多个既有 fixture 用「不存在的硬编码/动态 taskId」调 `tools.runTool` 填凭据字段 → P0-A 上线后 fail closed（**正确行为**），修 fixture 而非放宽阈值（`test_c71_tools_hardening` 20/3→**23/0**、`test_step6_payment_capability` 139/5→**144/0**（表单改挂真实 HTTP origin，顺带把端到端 fill 变成真正穿过 Gate 的实证）、`test_c106_f16_f17_fixture` 9/4→13/0、`test_c106_f20_typing_fixture` 4/9→13/0）；`test_step22_business_e2e` 的两轮独立复跑证明其 4 项失败为**启动时序 flake**（63/0 ×2），`test_gen_pool_v2` 为 `core.autocrlf=true` 的**一次性检出行尾产物**（24/0）。**未做**：真实 Webflow E2E（PX 挑战页恒返回，属环境限制，不允许绕过）——等人工授权。
- **PHASE 17-C（Project Skill 基础骨架，不接执行）**：按 17-B 报告 §25.1 授权的第 1–4 项落地「**先落数据，后落执行**」——**只产 `CANDIDATE`，无 SkillRouter / 无 SkillExecutor**。新增 `server/agent/skill/`（1255 行 / 5 模块）：`skillSchema.js`（SEC1–SEC8 安全闸 + 结构校验，纯函数零 I/O 零 LLM）、`skillEvidence.js`（五要素证据 + 独立性判定，独立集合 `aiSkillEvidence`）、`skillLifecycle.js`（PROMOTION/STALE 阈值 + `skillConfidence`，**不做状态转移**——转移属 17-D）、`skillBuilder.js`（**确定性提炼，无 LLM**）、`index.js`（**刻意不含 Router/Executor**）。新集合 `aiSkill`（主记录，规模 10²–10³ **刻意不设水位**）/ `aiSkillHistory` 2000 / `aiSkillEvidence` 3000 / `aiSkillRuns` 4000（防重演 aiAttempts 42MB 事故）。消费点 = `taskManager.complete()` 内与 `flowMemory` **并列** fail-open 调用 `skillBuilder.observe(task)`（只消费 complete 路径 → 假成功不入 Skill；Skill 无独立执行链 ⇒ **结构上不可能绕过 17-A 凭据闸**）。**G2（单次成功即晋升）的解法是改公式而非降阈值**：阈值 0.85 原样保留，未过门禁时部分分 = `ind/2*0.4 + sess/2*0.2` 且**封顶 0.84** → 1 成功/1 会话 = 0.300、**2/2 = 1.000（唯一跨阈值点）**；独立性三要件 = 不同 `executionId` ∧ 不同会话 ∧ 时间差 >10min（按 executionId **去重**）。两处与设计稿的**刻意偏差**已在代码注释记录：[D1] SEC1 只扫可执行体（不含 boundaries，否则 §16.1 强制的 `requiresHumanOn: MFA/3DS` 会误拒任何合法 Skill）、[D2] SEC6 只拒**裁决型**断言（不拒 `samples.success` **计数**字段，否则统计基座无法落库）。**顺带修复一处真实死护栏（同源两处）**：`FORBIDDEN_VALUE_HINTS` 含 `'document.querySelector'`（大写 S）而比较前 blob 已 `toLowerCase()` → **恒不命中**；取证 `aiFlowMemory.json` 对三种禁用形态零命中 → 纯收紧、行为中性；`skillSchema.SEC7` 与 `intelligence/flowSchema.js` 同因同修 + 守护断言。守护测试 `test_c109_skill_schema` **62/0** + `test_c109_skill_builder` **75/0**（137 断言，含正向对照与「证明真正执行到写路径」的 GATE 断言）。**顺带修复回归执行器的环境非确定性缺陷（零断言改动）**：后台/嵌套 shell 下 `TEMP`/`TMP` 可能缺失或为 POSIX 形态 → `os.tmpdir()` 回落「可创建但不可列」的 `%SystemRoot%\temp` → esbuild 解析 `stdin.resolveDir` 父目录 Access denied → 8 个 SSR/esbuild 套件（c70/c74/c78/c80/c81/c82/c87/c88）整套假红；新增唯一事实源 `server/scripts/tmpEnvGuard.js`（`%LOCALAPPDATA%` → `os.homedir()` → 仓库内 `.benchmark/.tmp` 兜底，win32 显式拒绝 POSIX 形态），`runRegression.js` 与 `run_phase9_regression.sh` 共用，env 正常时零行为变化。双回归 **217/0 + OK=210/BAD=0**。**未做（待人工授权）**：SkillRouter（17-D）/ SkillExecutor（17-E）/ 真实 Webflow E2E / canonical240 重基线 / 模型升级 / benchmark 修改。
- **PHASE 17-D（Router 五级判定 + 三态预检，影子模式，**不接执行**）**：按 17-B 报告 §25.1 第 5–7 项落地。新增 `server/agent/skill/skillRouter.js`（656 行，**纯函数 + fail-open 落库**）。① **五级判定**：Intent 归一化 → Capability 匹配 → Environment 适用性（不匹配 = 不选它，**不是失败**）→ 置信度/陈旧过滤 → State Contract 预检（★G1）；② **三态预检**（C105 教训的强制落地）：`MATCH` / `MISMATCH` / **`INDETERMINATE`**——无观察 / 空 URL / `about:blank` / `data:blob:` / 非 http(s) / 无元素池 / `loadingState='loading'` 六类触发条件一律走 Generic **且不记录任何 Skill 失败**（「空集 ≠ 不存在」：把第三态当 MISMATCH 会重演 C105 F2「延时挂载按钮 → 30s 超时 → reload → BLANK 页死亡螺旋」）；**FALSE 优先于 INDETERMINATE**（AND 语义下确定性否定足以定论，否则真不匹配会被误判成「不确定」从而绕过 STALE 判定）；③ **五条决胜规则** `ENV_SPECIFICITY → CONFIDENCE_DESC → LAST_SUCCESS_DESC → REQUIRED_CLAUSES_DESC → **REFUSE**`（显式拒绝平局——C105 D-A「同分按 DOM 顺序决胜 → 永远点第一个 button」是缺陷温床）；④ **独立性判定**（`aiSkillRuns` 为唯一数据源）。新集合 `aiSkillRouting`（水位 4000；每任务至多一条含回填）。**影子闭环 = 决策期写入 + 终态回填**：`runtime.resolvePlan` 内**复用已有 `planningObs`**（零新增导航 / 零新增观察成本 / 零新增失败模式）调 `router.shadow()`；`taskManager.complete/fail/escalate` 调 `recordRoutingActual()` 回填 `actual`（SUCCESS / FAILED / HUMAN_ESCALATION）——只有两侧都在才能比对「Router 会怎么决定 vs 实际结果」（§25.1 门禁）。**三层结构保证决策不改变执行路径**：模块导出面无执行 API + 调用点返回值未赋给任何变量（`try{…}catch{}` 内）+ 静态断言 `stripComments` 后零执行旁路；**端到端路径证明**（§25.3「必须证明真正执行到了目标代码路径」）用真实 `resolvePlan` / `complete` 调用链实测写入与回填（`.benchmark/phase17d_e2e_probe.js` + `phase17d_e2e_path_proof.txt`）。**实现期四修**：⚠️ **预检目标修正（不修则预检形同虚设）**——预检对象是「**第一个可执行状态**」而非「入口状态」（builder 产出 `entryState='LANDING'` 且其契约**全 SOFT**（A/B 测试与多入口情形刻意不参与状态拒绝），直接对入口预检会让**任何** Skill 都得到 `NO_REQUIRED_CLAUSE → INDETERMINATE`）；`wouldPromoteReasons` 未随 `route()` 输出映射（影子数据缺诊断）；**决策字段与观测字段必须分离**（平局拒绝时 `skillId` 曾仍指向影子候选 → 拆 `skillId`（决策，仅 `decision=SKILL` 时非空）/ `observedSkillId`（观测），**避免「拒绝」被误读成「选了某一个」**）；`OBSERVABLE_TYPES` 补 `url_contains`（17-C 遗留：该类型是 `deriveContract('navigate')` 的权威契约，缺失导致导航步被整步丢弃）。**并发协作处置（如实记录）**：工作区出现**非本会话**改动（`skillBuilder.js` mtime 晚于我方最后编辑 + 提交 `a3f4398` C111 证据链引用悬挂修复）——处置 = ①取证缺陷真实性（当前 16 skill / 16 chain、悬挂 0 条 → 缺陷真实但需达水位 3000 才触发）②验证修复行为中性（旧链存在时重指后 ref 值不变）③补 **CH0–CH4 五条守护断言**使其不再是「无守护的孤儿改动」（builder 套件 75 → **80/0**）④报告中标注来源。守护测试 `test_c110_skill_router` **85/0**（P0 4 / T8 三态 15 / X 预检目标 3 / G1 逐级 12 / K 决胜 12 / E 影子 17 / T9 不污染统计 6 / G2 独立性 5 / S 静态 13）。**双回归**：`phase9` **OK=212/BAD=0**；`runRegression` 轮 1（上会话遗留编排链）**218/1**，唯一失败为 `test_step22_business_e2e` 的 **F1 恢复链时序 flake**（`PASS=62 FAIL=1`，断言 `F1 任务进入显式交人终态（RUNNING）`，379.9s 仍未收敛）→ 按既有纪律**独立复跑证清白**（**63/0**，`RUN_ID=run_mtw869bj`，`F1 → HUMAN_ESCALATION` ✓，`.benchmark/phase17d_step22_rerun.txt`）后**全量复跑取干净基线 219/0**（853.0s，零失败零 flake）。**★ 结构性事实（必须固化）**：`builder` 恒产 `CANDIDATE` 且 17-D **不做状态转移**（转移属 17-E）⇒ ④ 级门禁过滤掉所有 Skill ⇒ 当前 `decision` **结构性恒为 `GENERIC`**；但 `prestateScope='SHADOW'` 仍产出有效预检信号，17-E 一接晋升即可立刻拿到「**晋升前 N 次任务本可以用 Skill**」的历史证据而不必空跑。**未做（待人工授权）**：SkillExecutor（17-E）/ POC-2 与 Generic vs Skill A/B（17-F）/ 真实 Webflow E2E / canonical240 重基线 / 模型升级 / benchmark 修改。
- **可靠性**：v2 池 100 任务 × 真实 deepseek：run3b→run6 = 95% → 97% → 98% → **99% SUCCESS**（唯一非 SUCCESS = CREDIBLE_BUSINESS 可信升级，按设计工作）
- **回归护栏**：全绿基线 runRegression **190/0** + phase9 **OK=183/BAD=0**（C92 口径；当前口径 runRegression **198/0**（397.3s）+ phase9 **OK=191/BAD=0** 全绿——**C94 safe_port 批次收口**（治理「临时端口随机命中 Chrome unsafe-port 黑名单 → page.goto ERR_UNSAFE_PORT 概率性假红」：lib_safe_port 共享原语 + 15 处测试迁移；收口时发现实现已由「绑定后校验重绑」改版为「显式候选端口」，而守护测试仍停旧契约 → B2 FATAL 无统计行，测试侧同步重写 B2 EADDRINUSE 重绑/B3 候选耗尽 reject/B4 5000 次采样守卫，并修 P1 误列 445（不在 Chromium kRestrictedPorts）与 P3a 整类守卫自指死结；test_c94 43/0）；C105 后口径；**C105 REAL-WEB AGENT RELIABILITY M1：F1-F6 落地 + 双回归归因修复**——F1 语义兜底词法关联收紧（零证据拒点，C105 法语站 Plateforme 误点机器根因）、F2 selector 接地判定降级为可观测标记 staleSelectorSuspected 不弃用（首轮回归实证：观察快照无法区分「selector 过期」与「目标尚未挂载」，弃用导致 step22 Scenario E 延时按钮被误判 → 语义兜底解析出合成 id #el-N → 30s 超时 → reload → BLANK 页死亡螺旋 → HUMAN_ESCALATION；D-B 死循环防护由 F5+F5b+repair 有界收口承担）、F3 P2 恒真判定表面化（host+pathname，query 不参与——pscd=try.webflow.com query 注入不再把真导航证据误判恒真）+ urlSurfaceKey 非法 URL 回退剥 query/hash 原始串（守卫不再静默失效，test_verification_invalid_evidence 28/28）、F4 replan 产出 selector 接地净化剥离留痕、F5 anti-flapping 同签名熔断 FLAP_THRESHOLD=4（阈值 2 会截断延时按钮「3 败 1 成」合法瞬时窗口——step22 63/0 实证修订）+ F5b reload 每 step 上限 1 次、F6 恢复词源接地（elementMissing 变体须在当前观察可解析）；test_c105_reliability 19/19 回放 fixture 守护 + matchedby 6/6 + 根目录 test_resolver 17/17（case7 改零证据拒点新契约）+ variant_cap 8/8；C104b replan gate unlock（runtime/planner 悬挂改动）随本批一并收口。**M2 grounding 增强**：data-testid/data-test/data-qa 与锚点 href（pathname 剥 query 防 token 泄漏）接入四层链路——observation 提取 → scoreField TIER 顶层（1.0，与 id 同级）/scoreSemantic 语义池/F1 兜底身份 → selectorFor 生成（testid 最高优先压过 id；无文本锚点 a[href*=pathname] 子串形态）→ selectorGrounded 接地快路 + cssGroundedInObs 复合属性面（data-testid/href），test_c105_m2_grounding 7/7 零浏览器守护；bbox/hit-test 属浏览器行为面归 M3 fixture 矩阵；**M3 REAL-WEB fixture 矩阵（Test A–J + Negative Test，26/26）落地**：observation 对可交互元素做中心点 elementFromPoint hit-test（输出 hitTest=clear/occluded/offscreen/zero-area/unknown，offscreen/unknown 一律不否决——防 M1 F2「快照分不清未挂载 vs 不存在」覆辙）+ semanticResolver 可操作性地面守卫（F7 零面积出局 / F8 occluded 出局，**全阻断回落保留候选并打 blockedBy**，空集会被上层误读成「元素不存在」而真实语义是「点不到」）+ verification 的 element_present/element_absent/field_value 改走 requireActionable:false 存在性通道（点不到 ≠ 不存在）+ href pathname 进语义池（无文本锚点唯一身份来源，且是语言中立信号——英文 signup 命中法语页 CTA 属正确行为）；矩阵覆盖法语落地页（C105 主诉复刻）/中文/overlay 遮挡不点击/延时挂载/零面积/联盟参数 URL/data-testid icon/href 锚点/offscreen 放行/遮挡 vs 干净；test_c105_m3_realweb_matrix 26/26（本地 fixture + 真实 Chromium 零 mock）+ step22 E2E 63/0；**登记边界**：F3 只解决 query 污染，子域 host 子串（try.webflow.com ⊃ webflow.com）仍判恒真——修它需重定义「到达站点」语义触 C103 面，已用断言固化防意外变更。**C105 真实站点复跑（4 轮，授权执行）**：新增 run_webflow_real_e2e.js 驱动真实 server 跑联盟注册任务，逐轮归因暴露四个本地 fixture 完全未覆盖的确定性缺陷并最小修复——F9 planner 语义语言契约（中文意译语义在英文/法文页零词法交集 → 解析零候选 + element_present 验证恒失败，实证 4 次 VERIFY_FAILED）、F10 合成 id 拒用（selectorFor 兜底 #el-N 是 observation 逻辑索引不是 DOM id → 30s 超时螺旋；改为无锚点返回 null + 执行面统一拒用）、F11 计划契约（field 臆造 CTA 文案/编造 DOM id + navigate 证据用入口域名被 P2 判恒真）、F14 重复 id 可见实例选择（重复 id 首个实例常是隐藏副本 w=0，探针实证落地页 #continue-nav 4 实例首个 w=0 → .first() 误报 not found ×18）、F13 熔断签名抗变体轮换（field 恒定 semantic 轮换使旧签名永远「新」→ 同字段重试 12 次/473s）。进展可测：第 1 轮 HUMAN_ESCALATION（点不进入口）→ 第 4 轮 FAILED（成功点进注册入口、22 步 63 动作、卡在分步表单填密码——Webflow 注册为分步表单，属规划能力边界非工程缺陷）；守护 test_c105_f10_f11_realweb 11/11 + test_c105_f14_duplicate_id 4/4（零浏览器 fake page）。**C106 分步表单推进（F15）**：真实站点第 4 轮卡点归因——注册是分步表单（邮箱 → 继续 → 密码），planner 假设单页表单 → `fill password` 时字段**尚未挂载** → ELEMENT_NOT_FOUND → 重试/replan/熔断全在重放同一步（实证同字段 12 次 / 473s → FAILED）。语义缺口是 ELEMENT_NOT_FOUND 混淆了「目标不存在」（该 replan）与「目标尚未出现」（该先推进再重查）。修：新模块 server/agent/stagedFormAdvance.js（字段类动作 + ELEMENT_NOT_FOUND + 未熔断 + 有预算时，点保守前进词表解析出的控件后重查目标；每 step 上限 2 次；**点击一次即止**，推进后字段仍不出现立即停止绝不连点；词表经危险词过滤）；runtime 主循环插入于 flap 记账后、重试决策前，推进成功重置 flap 记账（否则被 F5 熔断误伤），全程 agent.staged_form_advance 事件留痕。**真实浏览器 fixture 打脸 stub**：场景「页面只有 email 输入框」下，词表原含复合词 "Continue with email" 与输入框词法交集 → 把 email 输入框本身解析成前进控件并点击（stub 完全测不出）；修法两道：词表禁含字段名复合词（新增 P3d 整类守卫）+ 结构过滤 isAdvanceControl（只认 button/a/input[type=submit|button|image]/role=button|link，拒绝一切输入框/textarea/select/reset）——**语义评分负责排序、结构过滤负责合法性，二者不可互相替代**。守护 test_c106_f15_staged_advance 49/0（零浏览器：触发面/词表/结构合法性 + A–H 行为杀手含「输入框不得被点」+ 整类守卫）、test_c106_f15_staged_fixture 13/0（真实 Chromium + 真实 observation/semanticResolver + 真实点击：分步推进成功 / 死路只点一次 / 无控件零点击）。**C106 M2 真实站点第 5 轮归因（F16/F17/F18）**：第 5 轮真实 E2E（task_mtuqje3txasfd，283.5s → HUMAN_ESCALATION）经 execution.actions + aiEvents + 两个只读探针交叉取证，暴露三个本地 fixture 零覆盖的确定性缺陷——**F16「填错字段」型假成功**（`fill {semantic:'email', field:'password'}` 值被写进 email 框并判 SUCCESS：field 解析不到时评分器退而接受 semantic 命中的另一个可填字段；对 write 动作写错字段比找不到更危险，故 target.field 与 semantic 不等价时候选必须自带 field 证据——属性命中 token 或 input type 语义等价，否则拒绝并留痕 fieldMismatchRejected）、**F17「观察全崩=全盲」**（walk 内 `el.tagName.toLowerCase()` 在真实页抛 TypeError → inspect 返回 `{ok:false}` 且**无 observation** → 所有动作一律报「未找到」，与页面真实内容无关、F15 也恒报 no_advance_control；修法三层：tagName 空值防御 + `walk` 外层 try 截断保底（保留已采集元素 + walkError 留痕，降级为「部分可见」而非「全盲」）+ fill/click 分支 `obs.ok===false` 报 OBSERVATION_FAILED fail-loud，**观察失败 ≠ 元素不存在**，否则恢复分支走错）、**F18 反爬挑战页识别**（探针实证 webflow.com/signup 落地其实是 PerimeterX 挑战页「Confirm you're not a bot / press and hold」，DOM 仅 22–26 节点、零 input，而 agent 在其上反复填注册表单空转 283s 且升级理由完全误导；新模块 server/agent/botChallenge.js 文本多语言 + 供应商组件 + URL 三通道、置信度分层，runtime 命中即 escalate(reason='BOT_CHALLENGE')，**只识别+交给人，绝不解题/绝不隐藏自动化痕迹/绝不触碰挑战控件**）。守护 test_c106_f16_f17_unit 17/0 + test_c106_f16_f17_fixture 13/0（真实 Chromium：坏元素容错 / 填对字段 / 拒绝填错字段 / 观察失败零写入）+ test_c106_f18_bot_challenge 34/0（多语言文本 + 7 家供应商 + 负例防误判 + 反站点特判整类守卫）+ test_c106_f18_bot_challenge_fixture 6/0。⚠️ **红线处置**：真实 Webflow 注册路径已被 PX 人机验证拦截，任何自动化通过尝试都属 CAPTCHA/PX/WAF bypass，故停止真实注册 E2E，改由 F18 明确上报「需真人通过验证」。**C106 M3 人类化输入（F20，用户现场观察驱动）**：用户现场观察「注册第一步输入邮箱，输入太快 → 界面刷新 → 只输了一小部分 → 页面又刷新 → 又把密码输入到邮箱里」，归因出三个 execution 层缺陷——**F20-a 注入节奏**（fill 走 `humanType(baseDelay:30, randomDelay:60)` 均值 60ms/字符 ≈17 字符/秒，而人类是 150–250ms/字符；新模块 server/agent/humanInput.js 的 typingProfile 给出 base 90 + rand 0–110（均值 ~145ms）、凭据类字段 ×1.25，**>120 字符降级 mode:'fill' 整体赋值**——长文本对应人类「粘贴」，否则地板 25ms × 4000 字符 = 100s 会击穿 withBrowserOp 的 25s 超时，此缺陷由守护测试跑出而非设计预设）、**F20-b 输入前稳定等待**（waitFieldStable：元素两次采样尺寸/可见/非 disabled 一致，上限 1.5s，避开受控组件 re-render 窗口）、**F20-c 输入后回读校验**（humanType 末尾回读 DOM 值，不等则「重聚焦 + 全选清空 + 重输」一次，仍不等 → tools 报 FILL_VALUE_MISMATCH fail-loud；**此前 fill 从不回读，只进去几个字符也判 SUCCESS**，这正是错误能一路静默传到验证层的根因）。关键取舍：循环中间**绝不回退索引重输**（受控组件 setState 异步，中间回读落后于实际输入会造成字符重复，宁可慢不可错），只在末尾补录；valuesMatch 对非敏感字段允许前端格式化（去分隔符后相等视为成功），**密码/CVV/卡号绝不宽松**（空格是有效字符）。守护 test_c106_f20_human_input 32/0（零浏览器：节奏与预算/等价判定/凭据掩码/稳定判定 + 纪律锁「无站点名、无绕过动词、不触碰 verification 判据面」+ 6 条接入面断言防「改模块不接线」）、test_c106_f20_typing_fixture 13/0（真实 Chromium：**C1 对照组复现用户现象**——受控组件 re-render 重建 input 致焦点丢失时，关守卫只进去 "user@" 5 字符、开守卫补录成完整值；含超长值降级、死路 fail-loud、格式化不误报）。**C106 M4 网络就绪判据分层（F19，破除 WAIT 死循环）**：第 6 轮真实 E2E 实证 27 个动作全卡 step_001，固定循环 `networkState=pending → EVENTUAL_CONSISTENCY → WAIT → 误诊 NETWORK_REQUEST_FAILED(conf 0.9) → wait`。两个根因均为确定性缺陷——**判据语义**：请求计数器把所有 request 一视同仁（document/xhr/fetch/长轮询/analytics beacon/websocket 全 +1），真实站点（SPA + analytics + 长轮询）pending 恒为真 → `verificationIntelligence._analyze` 第 2 步短路命中 WAIT → 第 3 步起整条判据链（loading / domChanged / 证据）永远走不到；**挂载时机**（比恒 pending 更危险）：`ensureNetHook` 原先只在首次 inspect 才挂 → 页面加载期间的 document / 阻塞脚本 / 首屏 xhr 全部漏计 → 「没抓到」会**伪装成已就绪**。修：抽独立模块 server/agent/networkReadiness.js（避免 browserManager 反向依赖 agent/observation），按请求类型给阻塞窗口（document/script/stylesheet 20s、xhr/fetch 3s 首屏窗口，ping(beacon)/eventsource/websocket/image/font/media 一律不计入）；browserManager 新增 `newTrackedPage()` 统一入口（5 处 newPage 全替换）**page 创建即 attach**；observation 收敛为委托。守住「该等的时候要等」：首屏 xhr 在 3s 窗口内仍判 pending、主 frame 阻塞脚本长挂仍判 pending、iframe 子 frame 长挂不钉住主页面。踩坑两则：sed 批量替换把 helper 内部也换了 → `newTrackedPage` 自递归（grep 落盘验证抓到，已加 F5 断言防复发）；fake page 无 `page.on` 但 attach 已先建空分层表 → 堵死 `__pendingRequests` 回退路径（改「不能监听就绝不建表」）。守护 test_c106_f19_network_readiness 13/0（真实 Chromium + 真实挂起请求：长轮询 4s 后 idle 且有未完成请求佐证为真阳性 / 首屏 xhr 窗口内 pending / 阻塞脚本 pending / iframe 不钉住 / 验证链不再短路 + 源码纪律锁）。前一交付 C92：custom geolocation 非对称校验缺陷修复（test_c92 21/0，详见 git 历史 e027450 后日志））
- **交付 C83 — 审计覆盖对账（server/index.js 面）**：37 条 mutation 路由全量枚举，6 条真实审计链断裂补埋点 —— browser.evaluate（RCE 等价面）/ navigate / human-click/type/google-search（会话驱动面）/ cookies import（认证态注入）/ export（cookie exfil 面）/ automation/run 成功+失败双路径（业务关键 mutation）；detail 只记长度/数量（凭据明文红线），冻结 allowlist 豁免 5 条无状态预览/诊断面 + 2 条高频拟人流（环形缓冲冲刷边界），test_c83 72/0
- **交付 C85 — /schedules 子路由审计闭环（scheduleTrigger.js 面，C84 登记的收尾候选）**：C84 闭环 agent/index.js 34 面后，/schedules 独立子路由（自带守卫也自带审计盲区）create/update/delete/trigger 四面零审计；补 4 处 audit.logRequest 埋点（ai.schedule.*），意图归因同款（resourceId=scheduleId，运行细节归 events/trace）；tick 高频自动触发不逐次审计（环形缓冲冲刷边界，events.emit('schedule.triggered') 已覆盖）仅手动 trigger 落审计，P2c 结构断言固化「审计只在 HTTP 意图层、模块层禁调」；objective/targetUrl 明文不入 detail（C81 红线），无效创建 400 不落审计（无实体即无意图实现），跨工作区 403 守卫先于埋点，test_c85 41/0
- **交付 C84 — AI 面审计闭环（agent/index.js 面，C83 登记的后续批次）**：/api/ai/* 全部 34 条 mutation 路由此前零审计（AI 任务全生命周期在安全审计链不可见），补 28 处埋点 + 2 既有 secrets + 4 冻结豁免 = 34 面闭环；意图归因设计——审计只补「谁在何时对哪个任务做了什么」（resourceId=taskId），运行细节仍归 trace/aiSteps 证据链；/chat 审计点锚在任务创建：mock 规划恒失败（C79 已证边界）→ 400 响应但意图审计落盘（行为面最强实证）；聊天/暂停原因明文只记 *Len，modify 只记 patch 字段名（C81 红线）；audit.logRequest 共享原语提升（index.js auditReq 与 agent aiAudit 同源，C62 fsSafe 纪律），test_c84 102/0
- **交付 C82 — 浮动 async handler 悬挂清退**：Express 4 不接 rejection，`/automation/run`（runWorkflow 设计性抛错契约 → 悬挂至超时 UI 零反馈，真实 B 类）+ profiles GET/PUT/duplicate/preview-fp + proxies check-geo + browser stop 共 7 处统一 try/catch 固化「路由层永远回 JSON 不悬挂」契约，pre-fix TIMEOUT 悬挂实录 → post-fix 快速 500 JSON；P3 结构化守卫全量扫描 async handler 防整类回归，test_c82 18/0
- **交付 C50 — N-XCONS 双层一致性守护**：native identity.json 驱动下 JS↔HTTP Client Hints 全链实测（test_fp16b_nxcons.js，stock 4/0 + patched 9/0 + 1 边界留痕）——platformVersion 双层承诺实证成立（C2 头层真实跟随）；UA/platform/brands 未驱动面原生同源无断裂；边界 W1（navigator.platform JS 层 vs sec-ch-ua-platform 头 OS 面）显式留痕为 POC #3 冻结单面设计，OS 面联动列为后续扩展。Chrome 151→152 漂移实锤：getHighEntropyValue 单数 API 已移除（存量资产零击穿，全部已用复数）。详见 `.benchmark/C50_NXCONS_CROSS_CONSISTENCY.md`
- **端点×UI 对账主线完案（C22–C36）**：server 路由与 client 消费差全部闭合或判定不做；遗留端点（/ai/queue、/ai/events、/ai/observability/metrics）已带 RFC 8594 deprecation 标记；/auth/register+login 评估结论 = local 自动身份 + 治理中心建号已闭环 readiness auth 项，不新增登录页
- **身份架构**：16-B 全家族收口（6 Native ACTIVE + languages CONFIG + brands/screen CLOSED，详见 `.benchmark/PHASE16B_ROI_GATE.md`）
- **交付**：C35 凭据引用治理 UI（credentialRef 注册/删除/脱敏视图，明文闭环走 Profile 编辑器 vault）+ 任务详情手动恢复按钮；A 类缺陷修复：maskedView 的 available 改为 vault 只读现算（修复「先注册后补录明文 → 列表与 Planner 永远显示不可用」）
- **交付**：C29 执行引擎补齐（提交执行 / 崩溃恢复 / 资源池获取释放 / 动作契约与策略只读调试）
- **交付**：C28 Intelligence 决策试算 + 经验健康看板上线；C27 任务取证四件套（诊断/修复/执行/重放）上线
- **交付**：C26 治理中心上线 —— API Key 自管 / 安全审计日志 / 工作空间与成员 RBAC（C25 经验包导出导入、C24 智能记忆面板、C23 执行引擎面板、C22 数据备份恢复 均已上线）
- **交付**：C14 系统设置中心上线 —— API key / 模型配置 UI 化（密文落盘 + 保存即生效 + 连通测试 + env 对账）

## 合规与安全
- 指纹伪装 + 自动化是**双用途**能力：适用于自测注册/支付流程、管理你拥有或获明确授权的账号、无障碍自动化等合法场景。
- **请只对你拥有或获明确授权的账号/卡号使用，并遵守目标网站的 ToS。**
- 本项目**不**提供任何规避支付风控、CAPTCHA/3DS、盗卡测试、批量薅羊毛的专门设计；LLM 侧凭据判定链保证模型永不见明文 CVV/卡号。
- 卡号/CVV 为敏感数据：务必设置 `FPB_MASTER_KEY`；`data/vault.json` 仅存密文。`.env` 与 `data/` 已被 gitignore。

## 环境变量（.env）
| 变量 | 必填 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | AI 任务必填 | DeepSeek API key（**推荐直接在 UI「系统设置」里配置**，密文落盘、保存即生效；缺省时 AI 任务 fail-fast，Profile 管理不受影响） |
| `FPB_MASTER_KEY` | 建议 | 保险库主密钥（base64 32 字节）；不设则一次性内存密钥 |
| `FPB_NATIVE_CHROME` | 可选 | 指向 native patched chrome.exe（启用 16-B Native 身份架构） |
| `FPB_SCENARIO_DIR` / `FPB_POOL_FILE` | 可选 | 基准任务池覆盖（v2 池） |

完整变量清单见 `.env.example`。
