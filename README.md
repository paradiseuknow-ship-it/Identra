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
npm test        # 全量回归（runRegression.js 195 项 + phase9 188 项双护栏）
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
| 评估基准 | 冻结 v2 任务池（100 任务）+ canonical240 基线 + 双回归护栏（195/1 + OK=188/BAD=1，唯一失败=并行 C94 在途半成品） |

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

## 当前基线（2026-09-09）
- **可靠性**：v2 池 100 任务 × 真实 deepseek：run3b→run6 = 95% → 97% → 98% → **99% SUCCESS**（唯一非 SUCCESS = CREDIBLE_BUSINESS 可信升级，按设计工作）
- **回归护栏**：全绿基线 runRegression **190/0** + phase9 **OK=183/BAD=0**（C92 口径；当前口径 runRegression **194/1**（376.5s）+ phase9 **OK=187/BAD=1**——唯一失败 test_c94_safe_port = 并行 C94 批次 listenSafe 在途半成品，未跟踪新文件+18 处测试迁移 M 状态、其实现与自身 B2/B3 契约矛盾，非本批归属，落地后回到 **195/0**；C105 后口径；**C105 REAL-WEB AGENT RELIABILITY M1：F1-F6 落地 + 双回归归因修复**——F1 语义兜底词法关联收紧（零证据拒点，C105 法语站 Plateforme 误点机器根因）、F2 selector 接地判定降级为可观测标记 staleSelectorSuspected 不弃用（首轮回归实证：观察快照无法区分「selector 过期」与「目标尚未挂载」，弃用导致 step22 Scenario E 延时按钮被误判 → 语义兜底解析出合成 id #el-N → 30s 超时 → reload → BLANK 页死亡螺旋 → HUMAN_ESCALATION；D-B 死循环防护由 F5+F5b+repair 有界收口承担）、F3 P2 恒真判定表面化（host+pathname，query 不参与——pscd=try.webflow.com query 注入不再把真导航证据误判恒真）+ urlSurfaceKey 非法 URL 回退剥 query/hash 原始串（守卫不再静默失效，test_verification_invalid_evidence 28/28）、F4 replan 产出 selector 接地净化剥离留痕、F5 anti-flapping 同签名熔断 FLAP_THRESHOLD=4（阈值 2 会截断延时按钮「3 败 1 成」合法瞬时窗口——step22 63/0 实证修订）+ F5b reload 每 step 上限 1 次、F6 恢复词源接地（elementMissing 变体须在当前观察可解析）；test_c105_reliability 19/19 回放 fixture 守护 + matchedby 6/6 + 根目录 test_resolver 17/17（case7 改零证据拒点新契约）+ variant_cap 8/8；C104b replan gate unlock（runtime/planner 悬挂改动）随本批一并收口。**M2 grounding 增强**：data-testid/data-test/data-qa 与锚点 href（pathname 剥 query 防 token 泄漏）接入四层链路——observation 提取 → scoreField TIER 顶层（1.0，与 id 同级）/scoreSemantic 语义池/F1 兜底身份 → selectorFor 生成（testid 最高优先压过 id；无文本锚点 a[href*=pathname] 子串形态）→ selectorGrounded 接地快路 + cssGroundedInObs 复合属性面（data-testid/href），test_c105_m2_grounding 7/7 零浏览器守护；bbox/hit-test 属浏览器行为面归 M3 fixture 矩阵；**M3 REAL-WEB fixture 矩阵（Test A–J + Negative Test，26/26）落地**：observation 对可交互元素做中心点 elementFromPoint hit-test（输出 hitTest=clear/occluded/offscreen/zero-area/unknown，offscreen/unknown 一律不否决——防 M1 F2「快照分不清未挂载 vs 不存在」覆辙）+ semanticResolver 可操作性地面守卫（F7 零面积出局 / F8 occluded 出局，**全阻断回落保留候选并打 blockedBy**，空集会被上层误读成「元素不存在」而真实语义是「点不到」）+ verification 的 element_present/element_absent/field_value 改走 requireActionable:false 存在性通道（点不到 ≠ 不存在）+ href pathname 进语义池（无文本锚点唯一身份来源，且是语言中立信号——英文 signup 命中法语页 CTA 属正确行为）；矩阵覆盖法语落地页（C105 主诉复刻）/中文/overlay 遮挡不点击/延时挂载/零面积/联盟参数 URL/data-testid icon/href 锚点/offscreen 放行/遮挡 vs 干净；test_c105_m3_realweb_matrix 26/26（本地 fixture + 真实 Chromium 零 mock）+ step22 E2E 63/0；**登记边界**：F3 只解决 query 污染，子域 host 子串（try.webflow.com ⊃ webflow.com）仍判恒真——修它需重定义「到达站点」语义触 C103 面，已用断言固化防意外变更。前一交付 C92：custom geolocation 非对称校验缺陷修复（test_c92 21/0，详见 git 历史 e027450 后日志））
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
