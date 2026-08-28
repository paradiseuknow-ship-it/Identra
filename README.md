# 指纹浏览器 (Fingerprint Browser) — MVP

基于 **Chromium 内核**的多账号隔离与管理工具，带**指纹伪装**、**代理隔离**、**加密凭据/支付保险库**，以及**自动化执行引擎**（RPA：自动开站、填表、注册、按 CVV 自动支付）。

> 架构采用分层设计：指纹注入逻辑独立成模块。MVP 阶段用 Playwright 驱动 Chromium 并通过 CDP 注入指纹验证效果；生产阶段这套注入逻辑可直接下沉到自定义 Chromium 编译里（AdsPower / Multilogin 同路，需自行 patch `third_party/blink` 中 fingerprint 相关 API）。

## 技术栈
- 后端：Node.js + Express + Playwright（控制 Chromium）
- 前端：React + Vite + TailwindCSS
- 存储：本地 JSON 文件（`data/`）
- 敏感数据：AES-256-GCM 加密（`server/vault.js`）

## 快速开始
```bash
# 1. 安装依赖
npm run install:all

# 2. 安装 Chromium 浏览器（仅首次）
npx playwright install chromium

# 3. （可选）设置加密主密钥，否则使用一次性内存密钥
#    Windows PowerShell:
$env:FPB_MASTER_KEY = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
#    bash:
export FPB_MASTER_KEY=$(head -c 32 /dev/urandom | base64)

# 4. 启动（同时起后端 + 前端）
npm run dev
#   后端: http://localhost:8787  前端: http://localhost:5173
```

## 模块说明
| 模块 | 文件 | 作用 |
|------|------|------|
| 指纹生成 | `server/fp/generate.js` | 种子化可复现指纹（UA/屏幕/时区/语言/字体/WebGL/硬件） |
| 指纹注入 | `server/fp/inject.js` | `addScriptToEvaluateOnNewDocument` 覆盖 navigator/screen/Date/canvas/WebGL/Audio/WebRTC |
| 浏览器管理 | `server/browserManager.js` | 每 profile 一实例，绑定代理与指纹 |
| 代理检测 | `server/proxyChecker.js` | 经代理访问检测站点，回传出口 IP/延迟 |
| 加密保险库 | `server/vault.js` | AES 加密存储邮箱/密码/卡号/CVV，前端仅见脱敏摘要 |
| 自动化引擎 | `server/automation/engine.js` | 执行工作流（goto/fill/click/wait/extract…），占位符从保险库解密注入 |
| 工作流模板 | `server/automation/templates.js` | 注册 / 结账预设，选择器按站点配置 |

## 典型用法
1. **配置管理**：新建 profile → 生成指纹（按 seed 可复现）→ 绑定代理 → 在编辑器中填写邮箱/密码、卡号/CVV（加密保存）。
2. **代理管理**：新增 HTTP/SOCKS5 代理，点「检测」验证出口 IP。
3. **自动化任务**：新建「注册流程」或「结账流程」，填目标 URL 与选择器；运行时选一个 profile 执行。
   - 账号类值用 `{{email}}` `{{password}}`；
   - 支付类值用 `{{card.number}}` `{{card.name}}` `{{card.expMonth}}` `{{card.expYear}}` `{{card.cvv}}` `{{card.zip}}`；
   - 运行时由保险库解密注入，绝不回传明文到前端。

## 合规与安全
- 指纹伪装 + 自动化是**双用途**能力：适用于自测注册/支付流程、管理你授权拥有的账号、无障碍自动化等合法场景。
- **请只对你拥有或获明确授权的账号/卡号使用，并遵守目标网站的 ToS。**
- 本项目**不**提供任何规避支付风控、盗卡测试、批量薅羊毛的专门设计。
- 卡号/CVV 为敏感数据：请务必设置 `FPB_MASTER_KEY` 环境变量；数据库文件 `data/vault.json` 仅存密文。

## 生产级 Chromium 定制路线（后续）
1. 拉取 Chromium 源码，`gn args` 打开 `is_official_build`。
2. patch `third_party/blink/renderer/core/frame/navigator.cc` 等，让 fingerprint API 直接读取 profile 配置（比 JS 注入更隐蔽、更难被检测）。
3. patch WebGL/Canvas/AudioContext 实现层，从源头返回确定性噪声。
4. 将 `server/fp/` 的伪装逻辑迁移为 C++ 侧的 profile 参数。
