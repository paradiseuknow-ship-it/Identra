# fingerprint-browser 产品能力矩阵

> 版本：v0.2.0-rc1 ｜ 审计日期：2026-08-29 ｜ **只读审计**（未修改任何源码）
> 配套：`PRODUCT_ARCHITECTURE.md`（架构）· `PRODUCT_GAP_AUDIT.md`（缺口与优先级）

## 评分口径

| 分 | 含义 |
|---|---|
| **0** | 完全缺失 |
| **1** | 占位：配置项/目录存在，但无实现或零消费点 |
| **2** | 骨架：有接口与部分实现，但不可用或严重不完整 |
| **3** | 可用：单机个人场景够用，有已知缺陷 |
| **4** | 良好：功能完整，细节有瑕疵 |
| **5** | 生产/商业级：可对客户交付 |

**竞品基线**为 2026 年主流反检测浏览器的公开能力（AdsPower / 比特浏览器 / Multilogin / Kameleo），用于判断「差多少」而非「谁更强」。

---

## A. 指纹伪装能力

| 能力项 | 分 | 使用场景与价值 | 与成熟产品差距 | 证据 |
|---|---:|---|---|---|
| User-Agent / platform / vendor | 5 | 基础身份伪装 | 持平 | `fp/inject.js:42-44` |
| `navigator.webdriver` 抹除 | 5 | 反自动化检测的第一道关 | 持平（写法正确：不可枚举 getter） | `inject.js:54-64` |
| Client Hints（JS 层） | 5 | 现代站点必查 | 持平 | `inject.js:74-112` |
| Client Hints（**网络层请求头**） | 5 | 服务端一致性校验 | 持平，属加分项 | `browserManager.js:94-144` |
| 屏幕 / 分辨率 / DPR | 5 | 设备画像 | 持平 | `inject.js:216-229` |
| 语言 / Accept-Language | 5 | 地域一致性 | 持平 | `inject.js:45-46` |
| **时区** | **2** | 地域一致性核心项 | **明显落后**：未覆盖 `Date.prototype.getTimezoneOffset`，JS 层时区可被直接读穿；且 `fp/data.js` 内「东区为负」注释与实际值 `+480` 自相矛盾 | `inject.js:233-241`；`data.js:39,50` |
| 硬件并发 / 设备内存 | 4 | 设备画像 | 持平 | `inject.js:47-48` |
| Plugin / MimeType | 4 | 老牌指纹项 | 持平 | `inject.js:121-197` |
| Canvas 2D 噪声 | 4 | **主流检测第一梯队** | 持平（三接口一致、幂等） | `inject.js:274-353` |
| WebGL vendor/renderer 字符串 | 4 | 显卡画像 | 持平 | `inject.js:357-378` |
| **WebGL 图像噪声** | **1** | 高级检测的硬指标 | **缺失**：参数已生成（`generate.js:203`）但从未注入，`readPixels` 无覆盖 → Canvas 过了、WebGL 图像直接穿帮 | `inject.js` 零引用 |
| **字体列表注入** | **0** | 高熵指纹，站点必采 | **缺失**：参数已生成（`generate.js:142`）但零消费点，无 `document.fonts` / measureText 注入 | — |
| AudioContext | 2 | 音频指纹 | **落后**：仅包裹 `getFloatFrequencyData`；主流检测的 `OfflineAudioContext` / `getFloatTimeDomainData` 未覆盖 | `inject.js:389-405` |
| ClientRects | 2 | 布局指纹 | **落后**：返回普通对象字面量，`instanceof DOMRect === false`，`toJSON` 返回空对象 | `inject.js:409-423` |
| WebRTC 防护 | 5 | **IP 泄露的头号杀手** | 持平且是亮点：5 种模式、剥离 host/mDNS 候选 | `inject.js:454-578` |
| 地理位置 | 5 | 地域一致性 | 持平（权限 + CDP 双通道） | `inject.js:244-270` |
| **Battery API** | **0** | 设备指纹补充项 | 缺失 | 全库无 `getBattery` |
| **Codec / canPlayType** | **0** | 音视频解码能力指纹，高熵 | 缺失 | 全库无 `canPlayType` |
| **TLS / JA3 指纹** | **0** | 网络层指纹（Cloudflare/Akamai 必查） | **重大缺失**：仅注释提及，`tlsDisabled` 只加了一个 `--ssl-version-max` 参数 | `browserManager.js:58,184-186` |
| SpeechVoices | 2 | 语音合成指纹 | 落后：仅当真实列表为空才伪造，且伪造值带 Mozilla 特征串 | `inject.js:427-437` |
| MediaDevices | 2 | 设备枚举指纹 | 落后：硬编码 3 个设备，`deviceId` 用 `Math.random()` **每次调用都变** | `inject.js:441-451` |
| WebGPU | 2 | 新兴指纹面 | 落后：仅处理 `disable`，`webgl`/`real` 无分支 | `inject.js:382-385` |
| DoNotTrack | 4 | 低权重补充 | 持平 | `inject.js:67` |
| **移动端（iOS/Android）指纹** | **0** | TikTok / Instagram 等移动优先平台 | **重大缺失**：无移动端 UA 与触控/传感器指纹体系。Kameleo 以此为最大卖点 | — |
| **Firefox / 非 Chromium 内核** | **0** | 覆盖不同指纹面、规避单一内核特征 | **缺失**：仅 Chromium。AdsPower（双内核）、Multilogin（Mimic+Stealthfox）、Kameleo（4 内核）均已支持 | — |

**注入痕迹（可被网站直接检测）**：
- `CanvasRenderingContext2D.prototype.__fpGID = true`（`inject.js:310`）为普通赋值 → `Object.getOwnPropertyNames` 直接暴露
- `whiten()` 统一返回无名函数（`inject.js:24-38`），与真实原生方法（带方法名）不符
- 伪造 `window.chrome.runtime`（`inject.js:587-596`）：真实 Chrome 网页上下文下该对象为 `undefined`，属**正向特征**
- `enumerateDevices` 的 `deviceId` 每次随机

> **A 组结论**：主流维度（UA / Canvas / WebRTC / 地理 / 屏幕）做得扎实，WebRTC 甚至是亮点；但**字体、WebGL 图像、音频、Codec、Battery、TLS 六个高价值维度缺失**，且移动端与非 Chromium 内核完全空白。对标成熟产品，本产品大致处于**「入门级国产工具」水平**（接近比特浏览器，弱于 AdsPower / Multilogin）。

---

## B. 环境（Profile）管理能力

| 能力项 | 分 | 使用场景与价值 | 与成熟产品差距 | 证据 |
|---|---:|---|---|---|
| 独立 userDataDir / Cookie / localStorage 隔离 | 5 | 防关联的根基 | 持平 | `browserManager.js:61-63,687` |
| 每环境独立代理 | 5 | 网络层隔离 | 持平 | `browserManager.js:571-607` |
| 指纹种子可复现 | 5 | 环境复现与备份 | 持平 | `fp/generate.js:7-24,83` |
| 环境 CRUD | 4 | 基础管理 | 持平 | `index.js:56/61/100/130/178` |
| 复制环境 | 4 | 批量造号 | 持平 | `index.js:161` |
| 全参数可视化编辑（50+ 项） | 4 | 精细化调优 | 持平，UI 深度不错 | `client/ProfileEditor.jsx` |
| 指纹实时预览 | 4 | 编辑时即时反馈 | 持平 | `POST /profiles/preview-fp` |
| 配置一致性体检 | 3 | 自检（UA↔引擎版本、时区有效性等） | **只告警不阻断**，成熟产品通常阻断或强提示 | `integrity.js:42-179` |
| 缓存清理（三档） | 4 | 环境重置 | 持平 | `browserManager.js:217-257` |
| **批量创建 / 批量导入导出 Profile** | **0** | **运营团队的刚需**（一次开 50 个店） | **重大缺失**：无 batch 接口。所有主流产品均支持批量创建、批量改指纹、批量绑代理 | — |
| **Profile 导入导出（含指纹与数据）** | **0** | 迁移、备份、团队协作 | **重大缺失**：仅 Cookie 导入导出，且**要求浏览器正在运行** | `index.js:484-495` |
| Cookie 导入导出 | 2 | 账号迁移 / 养号交接 | 落后：需运行中；且前端「导入 Cookie」文本框输入被**静默丢弃**（未进 payload） | `ProfileEditor.jsx:330 vs 816-849` |
| 环境分组 / 标签 / 文件夹 | 0 | 大规模管理 | 缺失 | — |
| 窗口同步 / 群控 | 0 | 比特浏览器核心卖点，批量效率提升 10× | 缺失 | — |

---

## C. 代理与网络能力

| 能力项 | 分 | 使用场景与价值 | 与成熟产品差距 | 证据 |
|---|---:|---|---|---|
| HTTP / HTTPS 代理 | 5 | 基础 | 持平 | `httpProxyShim.js` |
| **SOCKS5 带认证** | **5** | 住宅代理普遍要求认证 | **优于多数竞品**：自研 shim 绕开 Chromium 原生不支持的限制 | `socksShim.js:16-95` |
| SOCKS4 | 2 | 老协议兼容 | 落后：仅拼 `socks4://` 前缀转交 Playwright，无 shim、无认证、无探测 | `browserManager.js:152` |
| SSH 隧道 | 0 | 比特/AdsPower 已支持 | 缺失 | — |
| 连通性检测 + 出口 IP | 5 | 上线前必检 | 持平 | `proxyChecker.js:224-247` |
| 协议自动识别与降级 | 5 | 容错 | 持平 | `proxyChecker.js:207,281` |
| 代理 → 时区/语言/地理**自动对齐** | 5 | **防关联关键**：IP 在美国却显示北京时区 = 秒封 | 持平，且**失败即阻断启动**（绝不回退直连）是正确且强硬的决策 | `browserManager.js:259-305` |
| 连接预热 | 4 | 首屏稳定性 | 持平 | `browserManager.js:521-549` |
| IP 信誉预检（住宅/机房分类） | 2 | 机房 IP 跑广告账户 = 高危 | 落后：**仅告警不改行为**，无法阻止用户用机房 IP 开广告账户 | `proxyPrecheck.js` |
| 代理市场 / 供应商集成 | 0 | 一站式采购（AdsPower 集成 50+ 供应商） | 缺失 | — |
| IP 自动轮换 | 0 | 大规模采集 | 缺失 | — |

---

## D. 自动化与 RPA 能力

| 能力项 | 分 | 使用场景与价值 | 与成熟产品差距 | 证据 |
|---|---:|---|---|---|
| 工作流 CRUD（脚本化任务） | 3 | 简单重复任务 | 落后：无可视化编辑器 | `index.js:402-429` |
| **可视化 RPA 流程编辑器** | **0** | **AdsPower 的核心护城河**：非技术人员拖拽即可编排养号/发布/采集 | **重大缺失** | — |
| **操作录制回放** | **0** | 快速生成自动化脚本 | **重大缺失**（`selfHealing/` 是空目录，0 个文件） | — |
| 窗口同步 / 群控 | 0 | 比特浏览器核心卖点 | 缺失 | — |
| Cookie Robot（自动养号） | 0 | Dolphin Anty 卖点 | 缺失 | — |
| 拟人化操作（移动/点击/输入/滚动） | 3 | 反行为检测 | 有后端实现但**前端无入口** | `index.js:312-347`；前端零调用 |
| 一键拟人 Google 搜索 | 2 | 演示用 | 同上，前端无入口 | `index.js:350` |
| 定时任务 / 调度 | 2 | 无人值守 | 落后：调度器**默认不启动**，需手动调 API | `agent/index.js:302-324` |

---

## E. AI Browser Operator 能力

| 能力项 | 分 | 使用场景与价值 | 与成熟产品差距 | 证据 |
|---|---:|---|---|---|
| 自然语言 → 执行计划 | 3 | 产品差异化方向 | 架构完整，但**业务成功率 6/100** | — |
| 计划审批（Approve/Modify/Reject） | 4 | 人机协同 | 优于多数竞品（AI 能力本身在竞品中罕见） | `AiPanel.jsx:152-154` |
| 执行时间线与快照 | 4 | 可观测性 | 优秀 | `TaskDetail.jsx` |
| 元素定位（语义 + 记忆 + 解析） | 3 | 核心 | 三层定位（显式 selector → elementMemory → semanticResolver）设计合理 | `tools.js:609-671` |
| 业务状态验证（契约驱动） | 4 | **杜绝假通过** | `DOM_CHANGED ≠ SUCCESS` 语义严格，业界少见 | `verification.js` |
| 失败归因（VIL） | 4 | 可诊断性 | 架构亮点 | `verification/verificationIntelligence.js` |
| 自愈与修复编排 | 3 | 稳定性 | 确定性恢复 + LLM 修复双层，但修复后成功率提升有限 | `recovery/`、`repair/` |
| **动作覆盖面** | **2** | — | **6 个已实现的动作被 schema 拦截**：`openTab` / `closeTab` / `switchTab` / `upload` / `download` / `dialog` 在 `tools.js` 已实现、浏览器层也已具备能力，但未被 `ACTION_TYPES` 收录 → 永远执行不到 | `schema/action.js:9-14` vs `tools.js:411,418,427,519,532,562` |
| **多标签页 / 文件上传下载 / 弹窗** | **0** | 真实业务流程的刚需（导出报表就要处理下载弹窗） | 因上一行被拦截，实际**不可用** | 同上 |
| hover / 拖拽 / 双击 / 右键 / 组合键 | 0 | 复杂交互 | 缺失 | — |
| 跨域 iframe | 0 | 支付/登录组件常见 | 缺失（仅支持同域） | `observation.js:122` |
| 验证码处理 | 0 | 登录流程必遇 | 缺失 | — |
| **人工升级后续跑** | **0** | **致命**：`HUMAN_ESCALATION` 是终态，无出边、不能重试、无接管界面 | 成熟产品允许人工接管后继续 | `taskStateManager.js:14` |
| 孤儿模块（写了没接线） | — | 技术债 | `intelligenceRouter`（执行链不调用）、`flowMemory`（读取侧仅 `/chat`）、`siteMemory`（**纯孤儿**）、`agentScore.js`（产品运行时零调用）、`sites/`（仅 generic 空壳） | — |

> **E 组结论**：架构深度罕见，但**「最后一公里」没打通**——6 个动作被 schema 拦死、人工升级后无法续跑、真实业务流程必需的上传下载与多标签页不可用。这些不是算法问题，是**接线问题**，修复成本远低于架构重构。

---

## F. 团队协作与权限

| 能力项 | 分 | 使用场景与价值 | 与成熟产品差距 | 证据 |
|---|---:|---|---|---|
| 用户体系 / 登录 | 0 | **商业化前提** | **完全缺失**：前端 grep `token\|Authorization\|Bearer\|localStorage` 零命中 | — |
| 角色与权限分级 | 0 | 团队协作刚需 | 缺失（AdsPower 三级权限，Multilogin 企业级 RBAC） | — |
| 操作审计日志 | 0 | 合规与追责 | 缺失 | — |
| 环境共享 / 转移 | 0 | 团队协作 | 缺失 | — |
| 子账号 / 席位管理 | 0 | 商业模式（按席位收费） | 缺失 | — |
| 密码隐形托管（员工可用但看不到） | 0 | 紫鸟浏览器卖点：员工离职带不走账号 | 缺失（有 AES 加密存储，但无「只托管不展示」的访问控制层） | `vault.js` |

> **F 组是本项目与商业产品之间最宽的鸿沟。** 所有主流产品都把团队协作为核心卖点与主要收费维度，本项目为零。

---

## G. API 与生态集成

| 能力项 | 分 | 使用场景与价值 | 与成熟产品差距 | 证据 |
|---|---:|---|---|---|
| REST API 覆盖面 | 4 | 可编程 | **后端远超前端**：约 85 条路由，前端只用掉约 1/3 | `index.js` + `agent/index.js` |
| Selenium / Puppeteer / Playwright 集成 | 1 | **开发者生态的入场券**（所有主流产品均支持） | **基本缺失**：仅暴露 `/browser/:id/evaluate`（执行任意 JS），无标准自动化协议接入 | `index.js:297` |
| Local API（本地自动化桥接） | 1 | 同上 | 缺失 | — |
| API 鉴权（Token） | 0 | 安全 | 缺失（Multilogin 为 token-based auth） | — |
| API 文档 | 0 | **开发者能否上手的决定因素** | 缺失（README 无 API 章节） | — |
| 浏览器扩展管理 | 0 | 生态 | 缺失 | — |
| 脚本市场 / 模板市场 | 0 | 生态 | 缺失 | — |

---

## H. 数据与存储

| 能力项 | 分 | 使用场景与价值 | 与成熟产品差距 | 证据 |
|---|---:|---|---|---|
| 凭据加密（AES-256-GCM） | 4 | 账号资产保护 | 实现正确（IV 12 字节、tag 附密文） | `vault.js:24-42` |
| 主密钥管理 | 2 | 加密的根 | **降级危险**：`FPB_MASTER_KEY` 缺失时使用一次性内存随机密钥并仅打 warn → **重启后已存凭据永久不可解密** | `vault.js:17-20` |
| 脱敏输出 | 4 | 防泄露 | 完整 | `vault.js:118`、`db.js:100` |
| 存储引擎 | 1 | — | **纯 JSON 文件**（GoLogin/AdsPower 均有云同步能力） | `db.js:11-14` |
| **写入原子性 / 并发安全** | **1** | 多请求下的数据正确性 | **缺失**：`fs.writeFileSync` 直接覆盖，非原子、无锁、无队列 → 并发下静默丢更新 | `db.js:52-55` |
| 云同步 / 多机漫游 | 0 | 团队协作与灾备 | 缺失 | — |
| 备份与恢复 | 0 | 数据安全 | 缺失 | — |

---

## I. 运维与可观测性

| 能力项 | 分 | 场景与价值 | 差距 | 证据 |
|---|---:|---|---|---|
| 崩溃防护（unhandledRejection / uncaughtException） | 4 | 稳定性 | **原型级项目中的亮点** | `index.js:6-10` |
| 优雅关闭 | 4 | 稳定性 | 亮点 | `index.js:525-534` |
| 孤儿进程清理 / 僵尸扫描 | 4 | 稳定性 | 亮点 | `index.js:515-518` |
| 任务状态自愈（重启恢复中断任务） | 4 | 稳定性 | 亮点 | `recoveryManager.js:75` |
| 日志 | 1 | 排障 | **`server/` 下 854 处 `console.log`**，无分级/轮转/结构化，无日志框架 | — |
| 健康检查 / 指标 | 1 | 运维 | 根路径无 `/health`、无 `/metrics` | — |
| 单元测试体系 | 1 | 质量保障 | 82 个脚本中 48 个 `test_*.js`，但**无测试框架、无断言库（仅 10 个用 node:assert）、无覆盖率**，runner 靠 **grep 解析 stdout 的 `PASS=` 字符串**判成败 | `run_phase9_regression.sh` |
| `npm test` | 0 | 工程基本盘 | **缺失** | `package.json` 仅 6 个 script |
| 版本控制 | 0 | **一切的基石** | **`.git` 目录不存在** | — |
| CI/CD | 0 | 质量门禁 | 无 `.github`、无 `Dockerfile`、无 `docker-compose` | — |
| 环境配置模板 | 0 | 部署 | 无 `.env.example`（但代码依赖 `FPB_MASTER_KEY` / `DEEPSEEK_API_KEY` / `PORT`） | — |
| LICENSE | 0 | **分发阻塞项** | 缺失 | — |
| 仓库卫生 | 0 | 可维护性 | 根目录 48 个 `.md`（35 个 `PHASE*.md` 研究日志）、18 个临时 `.js`、8 个 `.log`、8 个 `.json`，`.gitignore` 仅 4 行 | — |

---

## J. 前端产品体验

| 能力项 | 分 | 场景与价值 | 差距 | 证据 |
|---|---:|---|---|---|
| 配置管理页 | 4 | 主工作台 | 完整 | `App.jsx:141-192` |
| 配置编辑器（5 Tab / 50+ 项） | 4 | 核心交互 | 完整，深度不错 | `ProfileEditor.jsx` |
| AI 操作员页 | 4 | 差异化功能 | 完整（含 SSE、审批、时间线） | `AiPanel.jsx` |
| 任务详情页 | 4 | 可观测性 | 完整（只读） | `TaskDetail.jsx` |
| 代理管理页 | 2 | 代理池维护 | **骨架**：无编辑/更新入口 | `ProxyPanel.jsx` |
| 自动化任务页 | 2 | 任务管理 | **骨架**；用原生 `prompt()` 让用户手抄配置 ID | `TaskPanel.jsx:14` |
| Observability 页 | 2 | 运维看板 | **骨架**：纯只读，无加载态，硬编码「图像服务未启用」与实际能渲染快照矛盾 | `ObservabilityPanel.jsx:179` |
| **浏览器查看器** | **2** | **用户实际操作的窗口** | **关键断点**：只能看截图 + 手动导航，**不能点击、不能输入**。后端已实现 `human-click`/`human-type`/`human-move`/`human-scroll` 但前端零入口 | `BrowserViewer.jsx` |
| 路由 / 深链 | 0 | 可用性 | **无 router**，纯 `useState` 切换，无深链、无前进后退 | `App.jsx:12,75` |
| 设计系统 | 1 | 专业度 | Tailwind 但**无组件库**（`Section`/`Field`/`Toggle` 在 `ProfileEditor` 内部重复造轮子）；深色硬编码 `#0b0f17`，**未配 `darkMode`** 导致 Observability 页随系统明暗变色而全局不跟 | `tailwind.config.js`、`index.css:13` |
| 国际化 | 1 | 出海必需 | **仅中文**，无 i18n；大量硬编码英文混排（Observability / Approve / Reject…） | — |
| 表单校验 | 1 | 数据正确性 | `ProfileEditor.save()` **零校验**，名称可为空 | `ProfileEditor.jsx:140` |
| 错误处理一致性 | 1 | 专业度 | **三套并存**：toast / 原生 `alert()` / 内联红字；`AiPanel.load()` 直接 `catch(e){}` 吞掉全部错误 | `AiPanel.jsx:55-58` |
| 空态 | 2 | 体验 | 配置管理页无空态（列表为空时整页空白） | — |
| 响应式 | 1 | 移动端 | 侧边栏 `w-48` 固定无折叠，移动端不可用 | `App.jsx:74` |

---

## 总览热图

| 组 | 平均 | 判定 | 一句话 |
|---|---:|---|---|
| A 指纹伪装 | **2.7 / 5** | 可用，有明显短板 | 主流项扎实，**字体/WebGL图像/音频/Codec/Battery/TLS 六项缺失**，移动端与非 Chromium 内核空白 |
| B 环境管理 | **2.6 / 5** | 单机可用，团队不可用 | 隔离与指纹复现做得好，**批量操作与导入导出为 0** |
| C 代理网络 | **3.6 / 5** | **本项目最强项** | SOCKS5 认证 shim 与地理自动对齐优于多数竞品 |
| D 自动化 RPA | **0.7 / 5** | 近乎空白 | 无可视化 RPA、无录制回放、无群控 |
| E AI Operator | **2.4 / 5** | 架构强、落地弱 | 分层设计罕见，但**6% 成功率 + 6 个动作被 schema 拦死 + 升级后不能续跑** |
| F 团队协作 | **0.0 / 5** | **完全空白** | 零用户体系、零权限、零审计 —— 商业化的最大鸿沟 |
| G API 生态 | **1.0 / 5** | 有接口无生态 | 85 条路由但无标准自动化协议接入、无鉴权、无文档 |
| H 数据存储 | **1.9 / 5** | 加密对、工程错 | AES-256-GCM 正确，但**主密钥可降级丢失、写入非原子、无并发保护** |
| I 运维工程 | **1.5 / 5** | **原型级** | 崩溃防护是亮点，但**无 git / 无 CI / 无 LICENSE / 无 npm test / 无日志框架** |
| J 前端体验 | **2.2 / 5** | 内部工具原型 | 功能纵深够，**浏览器查看器不能操作**是最大体验断点 |

## 竞品对标总表

| 维度 | 本产品 | 比特浏览器 | AdsPower | Multilogin | Kameleo |
|---|---|---|---|---|---|
| 内核 | Chromium | Chromium | Chromium + Firefox | **自研 Mimic + Stealthfox** | **Chromium/Edge/Firefox/Safari** |
| 指纹深度 | 中等（缺 6 项 + 痕迹可检测） | 中等 | 良 | **标杆** | 良（移动端最强） |
| 移动端指纹 | ❌ | 弱 | 弱 | 部分 | **最强** |
| 可视化 RPA | ❌ | 基础 | **强（护城河）** | 需第三方 | 需第三方 |
| 窗口同步 / 群控 | ❌ | **强（核心卖点）** | 部分 | ❌ | ❌ |
| 批量操作 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 团队协作 / 权限 | ❌ | 基础 | **三级权限** | **企业级 SSO + 审计** | 中 |
| 自动化 API | 仅任意 JS 执行 | Selenium/Puppeteer | **Selenium/Puppeteer/Playwright** | **完整 API** | **SDK 深度集成** |
| 代理生态 | 自配（SOCKS5 shim 出色） | 50+ 供应商集成 | 50+ 供应商集成 | 自配 | 自配 |
| 免费额度 | 自托管全功能 | 10 环境永久免费 | 2 环境 | 仅付费试用 | 2 并发 / 300 分钟 |
| AI Agent | **有（架构最强）** | 无 | 部分（紫鸟 Agent 为竞品） | 无 | 无 |
| 商业化就绪 | ❌ | ✅ | ✅ | ✅ | ✅ |

## 一句话结论

> **本产品的「技术内核」（代理 shim、指纹注入、Agent 分层架构）质量高于平均水平，但「产品外壳」（团队协作、RPA、批量操作、工程化、安全）几乎为空白。**
> 它不是「做得不够好」，而是**只做了整个产品版图的中间那一层**——底层能力与上层交付之间缺了关键的一环。
