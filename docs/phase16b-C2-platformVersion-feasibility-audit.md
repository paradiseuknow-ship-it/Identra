# Phase 16-B C2 — platformVersion Native POC「只读可行性审计」

- 审计日期：2026-09-06
- 性质：READ-ONLY AUDIT（Step 0）——零代码修改、零 manifest 修改、零 patch、零 benchmark 运行
- Chromium：**152.0.7977.113**（chrome/VERSION 实证；构建产物 out/Default 由同一 source 树编译，CDP Browser.getVersion 实证一致）
- 结论：**C2_FEASIBILITY = PASS**，ROI Preview = **PROCEED-CONDITIONAL**（非编码授权）

---

## 1. 版本一致性（§三 闸门）

| 项 | 值 | 证据 |
|---|---|---|
| chrome/VERSION | 152.0.7977.113 | `D:/chromium/src/chrome/VERSION` |
| 构建产物 | chrome.dll/chrome.exe 2026-09-06 04:57 由本树编译 | ninja log + CDP Browser.getVersion = Chrome/152.0.7977.113 |
| 判定 | **一致 → 继续审计** | — |

## 2. Native production point（§四/§五A 核心答案）

**单点，Browser 进程，位置实证：**

```
embedder_support::GetUserAgentMetadata()
  components/embedder_support/user_agent_utils.cc:660-686
    └─ metadata.platform_version = GetPlatformVersion()   // line 683
         ├─ IS_WIN  → GetWindowsPlatformVersion()
         │             = GetUniversalApiContractVersion()    // line 152
         │             读 HKLM\Microsoft\Windows Runtime\WellKnownContracts
         │               \Windows.Foundation.UniversalApiContract（注册表实时值）
         │             格式 "major.minor.0"；registry 读取失败兜底
         │             kHighestKnownUniversalApiContractVersion（OS 相关常量，非 Chromium 版本）
         ├─ IS_LINUX/IS_FUCHSIA → 空串（line 607）
         └─ 其他    → base::SysInfo::OperatingSystemVersionNumbers() → "M.m.b"
```

对外暴露：`ChromeContentBrowserClient::GetUserAgentMetadata()`（chrome_content_browser_client.cc:7721 → embedder_support）。
**结论：platformVersion 的 desktop 生产点是唯一的、且来自真实 OS 运行时值（注册表/SysInfo），Chromium 侧零版本硬编码。**

## 3. Consumers（§五B/C/D）

### Consumer 1 — Client Hints HTTP headers（Browser 进程）
`content/browser/client_hints/client_hints.cc` `UpdateNavigationRequestClientUaHeadersImpl`：
- header 生产：`AddUAHeader(kUAPlatformVersion, ua_metadata->platform_version)` → `Sec-CH-UA-Platform-Version`
- **数据源三级优先**（line 682-711 实证）：
  1. `is_ua_override_on` → `NavigatorDelegate::GetUserAgentOverride().ua_metadata_override`（WebContents::SetUserAgentOverride 通道）
  2. devtools per-session override → `EmulationHandler::ApplyUserAgentMetadataOverrides`（devtools_instrumentation.cc:1680）
  3. **fallback = `delegate->GetUserAgentMetadata()`（line 711，即 §2 单点）**
- 判定：**HTTP 层与 Native 生产点同源**（override 未激活时）；override 通道是外部注入，不是第二生产点。

### Consumer 2 — NavigatorUAData / JS（Renderer 进程）
数据下发（renderer 启动一次）：`render_process_host_impl.cc:2017` `params->ua_metadata = GetContentClient()->browser()->GetUserAgentMetadata()` → mojom → `RenderThreadImpl::GetUserAgentMetadata()`（render_thread_impl.cc:864 接收）。

JS 读取链（逐跳实证）：
```
navigator.userAgentData / navigator.platform…
  navigator_ua.cc:18  UserAgentMetadata metadata = GetUserAgentMetadata()
  ← LocalDOMWindow::GetUserAgentMetadata()        local_dom_window.cc:464
  ← FrameLoader::UserAgentMetadata()              frame_loader.cc:1597
  ← LocalFrameClientImpl::UserAgentMetadata()     local_frame_client_impl.cc:954
      ├─ UA override on → RenderFrameImpl::UserAgentMetadataOverride()
      │                    render_frame_impl.cc:4909（RendererPreferences）
      ├─ 否则 → Platform::Current()->UserAgentMetadata()
      │          renderer_blink_platform_impl.cc:359 → RenderThreadImpl（=Browser 单点下发值）
      └─ probe::ApplyUserAgentMetadataOverride        （CDP renderer 侧 probe）
  → NavigatorUAData::getHighEntropyValues → setPlatformVersion   navigator_ua_data.cc:155
```
判定：**JS 层与 Browser 生产点同源**（override/probe 未激活时）。

### Consumer 3 — Workers（同源佐证）
`service_worker_version.cc:2689`、`shared_worker_host.cc:494` —— 均消费 `browser()->GetUserAgentMetadata()` 单点。

### 判定总汇
**SINGLE PRODUCTION SOURCE 成立**：一个 Browser 进程函数（§2），三类真实 consumer 自动跟随。§五D 的「MULTIPLE PRODUCTION SOURCES」**未命中**——Chromium 152 架构本身已是单源。

## 4. Existing overrides（CDP/Playwright/JS 通道盘点）

| 通道 | 位置 | platformVersion 影响 | 性质 |
|---|---|---|---|
| CDP `Emulation.setUserAgentOverride` | emulation_handler.cc:908-963（browser 校验合并）→ 存 session 级 `ua_metadata_override_` | 完全覆盖（963 行逐字段合并入 new_ua_metadata） | 外部注入通道，非生产点 |
| CDP `Emulation` renderer probe | inspector_emulation_agent.cc:875 → probe::ApplyUserAgentMetadataOverride | 完全覆盖（JS 读数路径） | 同上 |
| WebContents override（request desktop site 等） | user_agent_metadata.h `UserAgentOverride.ua_metadata_override` → client_hints 优先级① | 完全覆盖 | Chromium 内建 per-WebContents |
| **本项目 CDP 注入** | server/browserManager.js:201-209 `Emulation.setUserAgentOverride` 带 `platformVersion:'15.0.0'` 硬编码 | **当前压制原生值的主通道** | 项目自己的多点拼接病灶 |
| **本项目 JS fallback** | server/fp/inject.js:163 `platformVersion:'15.0.0'` 硬编码 | 无 brands 捕获时的 JS 兜底 | 第二份拷贝 |
| Playwright userAgent 选项 | 只改 UA 字符串，不动 metadata（项目注释 browserManager.js:145-147 实证认知） | 不单独影响 platformVersion | — |

## 5. CURRENT ownership map（§六/§七）

```
Identity（fp profile）
  └─ platformVersion
       ├─ ❌ 无独立 identity 字段（identitySchema 仅 V4 格式校验注释：16-B4 派生源待建）
       │
       ├─ [HTTP]  Sec-CH-UA-Platform-Version  ← CDP override '15.0.0'（browserManager.js:209，硬编码拷贝#1）
       ├─ [JS]    navigator.userAgentData.platformVersion
       │            ← CDP override 回放（同上拷贝#1 生效于 probe）
       │            ← inject.js fallback '15.0.0'（inject.js:163，硬编码拷贝#2）
       └─ [Native] user_agent_utils.cc 真实 OS 值（被上述 override 压制，未暴露）
```
对照 brands（P4.2 已修）：`fp._uaBrands` 原生捕获回放，双层同源——**platformVersion 是最后一个仍处于多点硬编码的 UA-CH 字段**（identityFactory.js:12 注释预留的 16-B4 债务）。

### C2 candidate ownership（目标态）
```
Identity.platformVersion（profile 配置，osVersion 派生链 16-B4）
  ↓ native patch（GetUserAgentMetadata 层 value_or 注入）
UserAgentMetadata.platform_version（Browser 单点）
  ├─ HTTP Sec-CH-UA-Platform-Version（自动同源）
  ├─ NavigatorUAData JS（自动同源，renderer 下发链自动跟随）
  └─ Workers（自动同源）
+ 项目侧让位：browserManager.js CDP override 停发 platformVersion（或整段让位 inject.js NATIVE_OWNED_SET）
+ inject.js fallback 移除/让位
```

## 6. Patch surface audit（§八，估算非实施）

**复用 POC #1 已验证模式**（switch → 读 identity → value_or 原生值）：

| 项 | 估算 |
|---|---|
| 文件数 | 2（`components/embedder_support/user_agent_utils.cc` 主体 + identity plumbing；可复用/扩展 POC #1 的 identity 读取路径） |
| 新增行数 | ~30-60 行（含 opt-in 守卫、identity 读取、错误 fail-fast） |
| 删除行数 | 0 |
| 函数数 | 1 个核心函数（GetUserAgentMetadata 内 platform_version 赋值点 value_or 化）+ plumbing helper |
| struct 修改 | 0（UserAgentMetadata 不动） |
| build 依赖 | components/embedder_support 一个库 + 最终 link（增量编译预估 <30min） |
| test 依赖 | 新 N-PV 行为矩阵（§10）+ 双回归（框架就绪） |
| Playwright 依赖 | 0（Playwright 本身不改） |
| Level 判定 | **Level B**（多 consumer 但单 metadata source 驱动——恰为 spec Level B 定义；未达 Level C：无需改 Network service/Playwright；远优于 Level D） |

关键架构事实：**Chromium 已内建单源多 consumer 传播，C2 不需要「建立」生产点，只需在单点换数据源（identity value_or OS 值）**——这是 patch 面可控的根本原因。

## 7. 版本升级非漂移审计（§九，C2 核心价值）

| 检查项 | 结果 |
|---|---|
| 生产点 hardcoded version | 无（注册表/SysInfo 实时读，§2 实证） |
| version-specific branch | 无（仅 OS family 分支 IS_WIN/IS_LINUX，非版本号分支） |
| UA string parsing 依赖 | 无（platformVersion 独立于 UA 字符串解析） |
| `if ChromiumVersion == 152` 类结构 | **全树 grep 未命中**（§五 grep 输出核对） |
| C2 patch 含版本常量？ | **设计上必须为零**——identity 值来自 profile 运行时读取，patch 本身无版本数字 |
| CDP/Playwright override 依赖 | C2 后项目侧停发 override（让位 native），漂移源消除 |

结论：**version-upgrade non-drift 机制层成立**——C2 patch 形态 = 「identity 配置 → Chromium 原生 metadata pipeline → 全 consumer」，正是 §九要求的目标形态；Chrome 153/154 升级时 patch 位点（GetUserAgentMetadata）为长期稳定 API，无版本快照可漂移。此点恰是 POC #1（webdriver 单点）无法回答、而 C2 结构性可证的核心命题。

## 8. 三层一致性验证矩阵设计（§十，设计不执行）

| Layer | Expected Source | Current Owner | C2 Candidate Owner |
|---|---|---|---|
| NavigatorUAData.platformVersion（JS） | UserAgentMetadata.platform_version | CDP override '15.0.0' + inject.js fallback | Native（identity） |
| Client Hints（Sec-CH-UA-Platform-Version） | 同上 | CDP override | Native（identity） |
| HTTP header（网络层捕获） | 同上 | CDP override | Native（identity） |
| JS injection fallback（inject.js） | — | 硬编码 '15.0.0' | 移除/让位 |
| CDP override（browserManager） | — | 硬编码 '15.0.0' | 停发/让位 |

行为测试设计（C2 实施阶段执行）：本地 http server 捕获请求头 + JS getHighEntropyValues 同页双读 + Workers 读数，断言三层 == identity.platformVersion；无开关 stock 对照组断言逐字节原生；N-PV-01..05 矩阵沿用 N-AUTO 命名法。
三层相等（`Navigator == ClientHints == HTTP == Identity` 且单一 production source）：**架构上可达成**。

## 9. 与 POC #1 对比（§十一）

| 维度 | POC #1（已完成） | C2 |
|---|---|---|
| patch 面 | 1 函数 + 1 行数据 | ~2 文件 30-60 行（大一个数量级） |
| consumer 数 | 1（navigator.webdriver JS 面） | ≥3（HTTP/JS/Workers，自动同源） |
| 证明命题 | Native ownership 全链可闭环 | 单源多 consumer 同源 + 版本免疫 |
| 风险增量 | 极低 | 低-中：override 通道交互（须让位项目侧硬编码）；renderer 下发时机（启动期一次性） |
| 复用度 | — | identity plumbing/测试框架/回归框架/patch 工具链全复用 |

**不因 POC #1 成功默认 C2 值得**——C2 的独立价值在于它是 ROI Gate ⑤（版本免疫跨面价值）的唯一可验证点；若 C2 做完仍不能证明同源收益，按 Gate STOP。

## 10. Feasibility Score（§十二）

| # | 维度 | 评分 | 依据 |
|---|---|---|---|
| 1 | Native production point clarity | **PASS** | 单点实证（文件:行号全落盘） |
| 2 | Single-source propagation | **PASS** | Chromium 架构本身单源；override 为外部注入可让位 |
| 3 | Multi-consumer benefit | **PASS** | 3 类 consumer 零额外 patch 自动同源 |
| 4 | Patch minimality | **PASS** | Level B 下限（value_or 单点换源） |
| 5 | Default stock equivalence | **PASS** | value_or 模式与 POC #1 同构，缺省零行为差 |
| 6 | Version-upgrade non-drift | **PASS** | patch 零版本常量 + 原生源实时 OS 读 |
| 7 | Regression feasibility | **PASS** | 三层一致断言可设计 + 双回归框架现成 |

**C2_FEASIBILITY = PASS**（STOP 条件 §十五 十项逐一核对：全部未命中——source 可定位、生产点唯一、ownership 可建、patch 面可控、无需动 benchmark/planner/fixture、不依赖检测站反馈、stock 可保持、regression 可设计）

## 11. ROI Preview（§十三）

- **ARCHITECTURAL_BENEFIT = HIGH**：消除项目内 3 份 platformVersion 拷贝（JS fallback + CDP override + 被压制的原生值），建立「identity → native 单点 → 全 consumer」；同时是 16-B4 osVersion 派生链的 Native 落点，直接偿还 identityFactory.js:12 预留债务
- **MAINTENANCE_COST = MEDIUM-LOW**：Level B patch + 长期稳定位点；但需项目侧让位接线（inject.js/browserManager.js）并维持 N-PV 矩阵
- **TESTABILITY = HIGH**：三层一致断言全可本地化（无需外网/检测站）
- **UPGRADE_RISK = LOW**：零版本常量；位点稳定

```text
ROI Preview: PROCEED-CONDITIONAL
```
条件 = ① C2 实施必须同步完成项目侧 JS/CDP 让位（否则同源收益不成立）；② patch 面超预算（>100 行 / >3 文件）即回本 Gate 复审；③ N-PV 矩阵全绿 + 双回归零退化。

## 12. Blocking issues

无阻断。两项实施期注意（非阻断）：
1. `GetUniversalApiContractVersion` 有 NoDestructor 进程级缓存——C2 注入点须在 `GetUserAgentMetadata()` 层（per-call），不得改缓存层语义
2. 项目侧让位接线（inject.js:163 / browserManager.js:209）属于 C2 实施范围，本轮未动

## 13. Final recommendation

C2 在架构上成立、patch 面可控、测试可闭环、版本免疫可实证——**建议授权进入实施，但按纪律 STOP 等待显式编码授权**。

---
*审计证据：全部结论基于 D:/chromium/src（152.0.7977.113）grep/sed 只读检查，行号均实证；项目侧结论基于 fingerprint-browser/server 只读 grep。本轮零文件修改（本文档除外）。*
