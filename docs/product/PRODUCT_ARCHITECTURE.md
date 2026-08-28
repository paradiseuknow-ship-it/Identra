# fingerprint-browser 产品架构说明

> 版本：v0.2.0-rc1 ｜ 审计日期：2026-08-29 ｜ 文档性质：**只读审计产出**（本轮未修改任何源码）
> 目标读者：新加入的工程师、产品经理、架构评审者
> 配套文档：`PRODUCT_CAPABILITY_MATRIX.md`（能力矩阵）· `PRODUCT_GAP_AUDIT.md`（缺口清单）

---

## 一、一句话定位

**fingerprint-browser 是一个自托管的「多账号隔离浏览器」：为每个账号生成一个独立、可复现的浏览器指纹环境，并可选接入一个自然语言驱动的 AI 操作员来自动完成网页任务。**

它同时是**两个成熟度相差极大的产品**，共存在同一个仓库里：

| 子产品 | 成熟度 | 现状 |
|---|---|---|
| **A. 指纹浏览器本体**（多开 / 指纹伪装 / 代理隔离 / REST API） | 可用级 | 核心链路完整，缺商业化必需的工程与安全能力 |
| **B. AI Browser Operator**（自然语言 → 自动操作网页） | 研究级 | 架构深度罕见（15,247 行 / 16 个子目录），但真实业务成功率 **6/100（6%）** |

**理解这个双层结构是理解本仓库一切现象的前提**：仓库里 35 份 `PHASE*.md` 报告几乎全部在讲 B，而真正能交付给客户的是 A。

---

## 二、目标用户与使用场景

### 2.1 谁会用

| 用户群 | 核心诉求 | 本产品是否满足 |
|---|---|---|
| 跨境电商多店铺运营 | 一人多店、每店一环境，防平台关联封号 | **基本满足**（缺批量操作与团队协作） |
| 社媒矩阵运营者 | 批量养号、批量发布 | 部分满足（无 RPA 录制器、无窗口同步） |
| 广告投放 / 联盟营销 | 多广告账户隔离、防关联 | 基本满足（缺 IP 信誉预检的强策略） |
| 数据采集团队 | 高匿名爬取 | 满足（但缺 Codec / TLS 指纹，易被高级反爬识别） |
| **团队 / 工作室** | 多成员、权限分级、操作审计 | **不满足**（零鉴权、零用户体系） |
| 需要「AI 自动操作网页」的用户 | 自然语言下指令，Agent 自己干活 | **不满足**（6% 成功率，仅可用于研究） |

### 2.2 典型使用旅程（As-Is）

```
① 配置代理池        → 代理管理页：新增代理 → 连通性检测 → 看出口 IP 与地理
② 创建配置环境      → 配置管理页：新建配置 → 50+ 项指纹参数编辑 → 指纹实时预览
③ 关联代理与凭据    → 绑定代理（自动对齐时区/语言/地理位置）→ 录入账号密码（AES 加密）
④ 启动浏览器        → 独立 userDataDir 启动 → WebRTC/地理/UA 全部按配置注入
⑤ 人工操作          → 浏览器查看器（截图轮询 + 手动导航）
⑥ 或：让 AI 干活    → AI 操作员页：自然语言 → 生成计划 → 批准 → 执行 → 看时间线
```

**旅程断点**：⑤ 的「浏览器查看器」只能看截图和导航，**不能点击、不能输入** —— 用户必须去本机真实窗口里操作，或直接依赖 ⑥ 的 AI（而 AI 只有 6% 成功率）。

---

## 三、系统分层

```
┌──────────────────────────────────────────────────────────────────┐
│  客户端层  client/  (Vite + React 18 + Tailwind 3)                 │
│  8 个视图，无路由（useState 切换），裸 fetch，SSE + 2.5s 轮询       │
└───────────────────────────┬──────────────────────────────────────┘
                            │  HTTP REST (/api) + SSE
┌───────────────────────────▼──────────────────────────────────────┐
│  HTTP 服务层  server/index.js  (~40 条路由)                        │
│  Profiles / Proxies / Browser / Vault / Tasks / Automation / AI    │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│  ① 指纹浏览器内核                    ② AI Browser Operator         │
│  ┌────────────────────────────┐    ┌──────────────────────────┐  │
│  │ fp/generate   指纹生成      │    │ server/agent/ 15,247 行   │  │
│  │ fp/inject     JS 注入脚本   │    │  planner → runtime →     │  │
│  │ browserManager 生命周期     │    │  tools → verification →  │  │
│  │ 代理 shim (HTTP/SOCKS5)     │    │  recovery → repair       │  │
│  │ geoip   地理对齐            │    │  + intelligence/*        │  │
│  │ vault   AES-256-GCM 凭据    │    │  + llm/ (openai|deepseek)│  │
│  │ integrity 配置体检          │    │  + observability/*       │  │
│  └────────────────────────────┘    └──────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│  存储层  server/data/*.json（纯 JSON 文件，无数据库）               │
│  profiles · proxies · tasks · vault · aiTasks · aiSteps ·          │
│  aiAttempts · aiElementMemory · aiFailureSnapshots …               │
└──────────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│  浏览器层  Playwright + Chromium（launchPersistentContext）        │
│  每 Profile 独立 userDataDir + 独立代理 shim + 独立指纹注入         │
└──────────────────────────────────────────────────────────────────┘
```

**代码规模**：287 个 JS 文件 / 约 40,800 行（不含 `node_modules` 与 `.benchmark`）。其中 `server/agent/` 独占 15,247 行，是仓库最大的单一模块。

---

## 四、模块职责地图

### 4.1 指纹浏览器内核

| 模块 | 路径 | 职责 |
|---|---|---|
| 指纹生成 | `server/fp/generate.js` | 按种子（`mulberry32(hashString(seed))`）确定性生成全套指纹参数 |
| 指纹注入 | `server/fp/inject.js` | 构造注入脚本，覆写 navigator / Canvas / WebGL / WebRTC / 地理等 |
| 浏览器管理 | `server/browserManager.js` | 启动参数、CDP、代理 shim、生命周期、截图、拟人化操作 |
| HTTP 代理 shim | `server/httpProxyShim.js` | HTTP/HTTPS 本地转发（CONNECT 重试 3 次） |
| SOCKS5 shim | `server/socksShim.js` | 自研握手，**绕过 Chromium 不支持 SOCKS5 认证的限制** |
| 代理检测 | `server/proxyChecker.js` | 连通性、出口 IP、协议自动识别与降级 |
| 代理信誉预检 | `server/proxyPrecheck.js` | 住宅/机房分类，仅告警不改行为 |
| 地理对齐 | `server/geoip.js` | 双数据源（ip-api → ipapi.co）解析出口 IP 地理 |
| 凭据保险箱 | `server/vault.js` | AES-256-GCM 加密账号密码 / 卡号，脱敏摘要 |
| 配置体检 | `server/integrity.js` | 6 项指纹一致性校验，**只告警不阻断** |
| 存储 | `server/db.js` | 纯 JSON 文件读写 |

### 4.2 AI Browser Operator（`server/agent/`）

| 目录 | 行数 | 职责 | 是否核心链路 |
|---|---|---|---|
| 根（runtime/tools/planner/…） | 5,919 | 执行主链路 | ✅ |
| `verification/` | 851 | 验证引擎 + 业务契约 + VIL 诊断 + 观察窗口 | ✅ |
| `execution/` | 1,907 | 队列 / Worker / 调度器 / 浏览器资源池 | ❌ **默认未启用** |
| `repair/` + `strategies` | 877 | 重试耗尽后的 LLM 诊断修复编排 | ✅ |
| `intelligence/` | 773 | elementMemory / flowMemory / siteMemory | 部分 |
| `intelligence/router` | 533 | 经验优先决策 | ❌ 仅 `/chat` |
| `intelligence/profile` | 642 | 环境评分 | 部分 |
| `intelligence/failure` | 412 | 失败知识库 | ✅ |
| `intelligence/evaluation` | 664 | 离线自评看板 | ❌ |
| `recovery/` | 418 | 确定性恢复（无 LLM） | ✅ |
| `diagnosis/` | 236 | LLM 诊断 | ✅ |
| `schema/` | 377 | 动作与计划契约定义 | ✅ |
| `observability/` | 612 | 指标聚合（只读 REST） | ❌ |
| `storage/` | 574 | jsonStore / sqliteStore | ✅ |
| `llm/` | 338 | provider 门面 + openai / deepseek / mock | ✅ |
| `sites/` | 114 | 站点适配器 | ❌ **仅 generic 空壳** |
| `selfHealing/` | **0** | — | ❌ **空目录** |

---

## 五、核心链路

### 5.1 链路 A：启动一个隔离浏览器环境

```
POST /api/browser/:id/launch
  → browserManager.launch(profile)
      ├─ resolveLaunchIpGeo()      代理 → 出口 IP → 地理/时区（失败即阻断，绝不回退直连）
      ├─ generateFingerprint(seed) 确定性生成，randomFingerprint=true 时掺入 Date.now()
      ├─ integrity.check()         6 项一致性体检（只告警）
      ├─ buildArgs()               启动参数 + Client Hints 网络层头
      ├─ startProxyShim()          每 Profile 独立 shim 进程
      ├─ launchPersistentContext() 独立 userDataDir + locale/timezone/geolocation/permissions
      ├─ context.addInitScript(buildInjectionScript(fp))   ← 指纹注入主通道
      └─ applyClientHints() (CDP)  网络层 UA/Client Hints
```

**关键设计**：指纹注入走 `addInitScript`（即 `Page.addScriptToEvaluateOnNewDocument`），对 context 内所有页面与同源 iframe **在文档创建前**生效 —— 这是正确的做法。

### 5.2 链路 B：AI 自动完成一个自然语言任务

```
① 自然语言解析   parser.parse（无 LLM key 时走正则兜底）
② 经验决策       intelligence/router.decide（仅 /chat 入口调用，执行链不调用）
③ 建任务         taskManager.createTask → Execution → lock.acquire
④ 规划           flowPlanner.planWithMemory → planner.planObjective → provider.plan
                 ↑ 规划前 capturePlanningObservation() 真实导航+观察（Phase 9 P4 新增）
⑤ 执行主循环     runtime.run → ensureBrowser → resolvePlan
⑥ 单步执行       runStep → createAttempt → tools.execute
⑦ 动作门控       validateAction → policy.allowsAction → lock.getOwner
                 → pageStateClassifier.classify + contextGuard.guard   ← Phase 9 P0 修复点
⑧ 元素定位       resolveSelector：显式 selector → elementMemory.getCandidate
                 → semanticResolver.resolve → waitForElement 重试
⑨ 执行动作       runTool（30+ case，支持 iframe 前缀选择器）
⑩ 验证           verification.buildEffectiveVerification → verify
                 → 失败进 verificationIntelligence.analyze（VIL）
                 → 可观察决策进 verificationWindow.runObservationWindow
⑪ 确定性恢复     recoveryManager.attempt → errorClassifier → strategies(wait/reload/back)
⑫ AI 修复编排    repairManager → failureAdvisor（命中经验跳过 LLM）
                 → diagnosisEngine → repairPlanner → repairPolicy → executor
⑬ REPLAN         planner.replan（上限 maxReplans=2）
⑭ 终态           complete / fail / escalate
```

**这条链路的设计深度在业界属于罕见**：它不是「LLM 调 Playwright 一把梭」，而是把「执行 / 验证 / 归因 / 恢复 / 修复 / 记忆」拆成了独立的、可观测的、可单独验证的层。Phase 9 的全部工作都在这条链路上。

---

## 六、数据模型

存储为 `server/data/*.json`（纯文件，无数据库，无原子写，无并发锁）。

| 实体 | 文件 | 说明 |
|---|---|---|
| Profile（配置环境） | `profiles.json` | 指纹参数 + 代理绑定 + 启动配置 |
| Proxy（代理） | `proxies.json` | 密码经 `db.js` 透明加解密 |
| Vault（凭据） | `vault.json` | AES-256-GCM 密文，tmp+rename 原子写 |
| Task（工作流） | `tasks.json` | 传统自动化任务 |
| AI Task / Step / Attempt | `aiTasks.json` / `aiSteps.json` / `aiAttempts.json` | AI 操作员的三层结构 |
| Element Memory | `aiElementMemory.json` | 元素定位经验（成功/失败计数 + 置信度） |
| Failure Snapshot | `aiFailureSnapshots.json` | 失败现场证据快照 |

**并发风险**：`db.writeJson` 用 `fs.writeFileSync` 直接覆盖，非原子、无锁、无队列。`server/index.js` 多处存在「先读数组 → 修改 → 整体回写」的模式，多请求并发下会**静默丢更新**。

---

## 七、部署形态与运行时

| 项 | 现状 |
|---|---|
| 形态 | 单机自托管：Node.js 服务（默认 `PORT=8787`）+ 本机 Chromium |
| 启动 | `npm run install:all` → `npm run dev`（concurrently 起前后端） |
| 前端产物 | `client/dist`，由 `server/index.js` 静态托管 + SPA fallback |
| 监听地址 | `app.listen(PORT)` **未传 host → 绑定 0.0.0.0 全网卡** |
| 鉴权 | **无** |
| CORS | `app.use(cors())` **全开，无白名单** |
| 主密钥 | 环境变量 `FPB_MASTER_KEY`（base64 32 字节）；**缺失时降级为一次性内存随机密钥，重启后已存凭据永久不可解密** |
| 崩溃防护 | ✅ `unhandledRejection` + `uncaughtException` 捕获 |
| 优雅关闭 | ✅ SIGTERM/SIGINT → `gracefulShutdown` |
| 进程自愈 | ✅ 启动清孤儿 Chromium + 僵尸进程定时扫描 |
| 外部守护 | ❌ 无 systemd / PM2 / Docker restart policy |
| 日志 | ❌ `server/` 下 **854 处 `console.log`**，无分级、无轮转、无结构化 |
| 健康检查 | ⚠️ 仅 `server/agent/index.js` 有子系统级 `/health`；根路径无 `/health`、无 `/metrics` |

**值得肯定的一点**：崩溃防护、优雅关闭、进程自愈这三件事，在原型级项目里意外地做得比较到位。

---

## 八、关键设计决策与权衡

| 决策 | 收益 | 代价 |
|---|---|---|
| 指纹用 JS 注入而非改 Chromium 内核 | 开发成本极低，可快速覆盖 20+ 维度 | **抗检测能力弱于内核级方案**（AdsPower / Multilogin 均为自研内核）；留下可枚举的注入痕迹 |
| 自研 SOCKS5 shim | 绕开 Chromium 不支持 SOCKS5 认证的限制 | 需长期维护握手协议实现 |
| 代理失败即阻断启动 | 绝不「裸奔」暴露真实 IP | 代理抖动时可用性下降 |
| 存储用 JSON 文件 | 零依赖，便于人工检查与调试 | 无并发安全、无事务、无法水平扩展 |
| AI Agent 拆成「验证/归因/恢复/修复」四层 | 每一层可独立验证、可观测、可单独演进 | 复杂度极高（15,247 行），调试与维护成本大 |
| `DOM_CHANGED ≠ SUCCESS` 严格语义 | 杜绝「点一下就算成功」的假通过 | 真实业务成功率低（6%），但对研究诚实性至关重要 |
| 无 LLM key 时静默降级到 mock | 离线可跑通链路 | **危险**：mock 返回固定的 6 步 form 流程，与用户 objective 无关，会被误认为真实产出 |

---

## 九、三句话说清现状

1. **「指纹浏览器」部分是一个能用的单机工具**，核心隔离与指纹能力成立，但缺团队协作、权限、批量操作、以及若干关键指纹维度 —— 差的是「商业化」，不是「能跑」。
2. **「AI Browser Operator」是一个高质量的架构原型**，验证/恢复/修复分层的深度罕见，但 6% 的业务成功率意味着它目前只能作为研究资产，不能作为产品功能售卖。
3. **工程化是最大的单点短板**：无版本控制、无 CI、无 LICENSE、无 `npm test`、无鉴权 —— 这些不是「好不好用」的问题，是「能不能交付给客户」的问题。
