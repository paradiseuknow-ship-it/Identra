# STEP 19 — Headless 信号证据归因审计（Evidence-Attribution Mode）

> 纪律来源：STEP 19 证据归因模式指令。目标**不是**把任何第三方检测分数做到 0%，
> 而是找出真实工程缺陷（A）与可安全修复的环境一致性问题（B）；架构固有限制（C）记录为产品边界；
> 仅针对检测站点的 spoof 优化（D）禁止。
> 审计工具：`server/scripts/audit_headless_signals.js`（3 模式 × 25 信号族，本地 file:// 探针，无第三方依赖）
> 工程测试：`server/scripts/test_step19_signal_shape.js`（断言实际执行的注入脚本字符串，10 断言 ×2 幂等）
> 原始数据：`STEP19_HEADLESS_SIGNAL_AUDIT.json`（仓库根）+ `.benchmark/step19_signal_audit_*.json`

## 一、审计方法

三模式对照（同一台真实 Windows 主机）：

| 模式 | 含义 |
|---|---|
| `product-headless` | 产品注入 + headless（架构最不利形态，用于暴露 C 类信号） |
| `product-hidden-headful` | 产品注入 + `hiddenWindow:true`（当前推荐反检测形态） |
| `control-headed` | 原生系统 Chrome 151，headed，无注入（真实性基线） |

contract 对照基线 = `session.fp`（launch 时 geo/引擎对齐后的**会话指纹**，非 profile 预生成值）。

## 二、最终三指标（指令七）

### Metric A — Contract Consistency（Profile contract 内部一致性）
**PASS** —— 两产品模式均 **13/13**（ua / timezone / languages / platform / hardwareConcurrency /
deviceMemory / screen w-h / avail / pixelRatio / webgl renderer / outer≥inner / Notification=default / webdriver=false）。

### Metric B — Browser Reality（真实浏览器环境一致性）
**PASS（本次审计后）** —— 与原生对照组逐项形状对齐：
plugins=5（每个 length=2，application/pdf+text/pdf）、navigator.mimeTypes=**2 共享实例**
（enabledPlugin→'PDF Viewer'）、permissions.query 原生映射（default→prompt）、Notification=default、
window.chrome keys=[loadTimes,csi,app]、描述符全部 proto:native-get。
本次修复 2 处 B 类（见 §四）；修复前 mimeTypes=5 / permQuery=default 与原生不符。

### Metric C — Third-party Detection（仅 Evidence，非 Success Definition）
- CreepJS headless%：hidden-headful **33%**（STEP 20 verify 13/13 ×2；纯 headless 67%）
- Pixelscan：Bot check PASS、Browser 卡 STEP 23 后 [ok]；「Masking detected」归因实验进行中（STEP 24）
- 对照组（无注入原生 Playwright）基线 FAIL 面：webdriver=true、Bot check FAIL、Location/Proxy 环境侧 FAIL——
  产品组全部 PASS，注入层一致性能力为正向证据。

## 三、25 信号族逐项判定（四问过滤后）

| # | 信号族 | 产品值 | 原生对照 | 判定 | 说明 |
|---|---|---|---|---|---|
| 1 | mimeTypes | 2（共享实例） | 2 | **B（本次修复）** | 修复前 5，与原生不符 |
| 2 | plugins | 5 × length2 | 5 × length2 | 一致（STEP 23 修复保持） | PDF Viewer 系列现代清单 |
| 3 | screen | fp 池 | 1280x720@1.0 | 一致（托管） | 1280x720 已剔（STEP 19） |
| 4 | outerWidth/innerWidth | outer≥inner | outer>inner | 一致（B 已修） | 物理可能约束 |
| 5 | outerHeight/innerHeight | outer≥inner | outer>inner | 一致（B 已修） | 同上 |
| 6 | Notification.permission | default | default | 一致（B 已修） | denied→default 纠正保持 |
| 7 | navigator.webdriver | false | true（Playwright 自动化面） | 一致（托管） | 产品身份=真人指纹 |
| 8 | window.chrome | app/csi/loadTimes | 同 | 一致（STEP 23 修复） | runtime/webstore 已移除 |
| 9 | permissions API | default→prompt | default→prompt | **B（本次修复）** | 原生映射，修复前 default→default |
| 10 | connection | 4g/1.5/250 | 4g/1.6/100 | 一致（托管） | 池值合理 |
| 11 | contactsManager | 无 | 无 | 一致 | 桌面 Chrome 均无 |
| 12 | contentIndex | 无 | 无 | 一致 | 同上 |
| 13 | deviceMemory | fp 值 | 8 | 一致（托管） | contract 一致 |
| 14 | hardwareConcurrency | fp 值 | 20 | 一致（托管） | contract 一致 |
| 15 | WebGL vendor/renderer | OS 感知 ANGLE 池 | 真 GPU ANGLE | 一致（B 已修） | GPU 启用 + OS 过滤保持 |
| 16 | WebGPU | adapter-ok | adapter-ok | 一致 | |
| 17 | mediaDevices | 3 设备 | 3 设备 | 一致（小注） | 枚举顺序池固定 vs 原生实测序——非 headless 信号，记为低优先级打磨项，不在本 STEP 动 |
| 18 | speechSynthesis | 3 voices | 0（异步未载/机机无 voice） | 一致（托管） | 指纹身份组件，OS 形状合理 |
| 19 | fonts | 10/10 常用 | 10/10 | 一致 | |
| 20 | navigator.userAgentData | brands 151/Not=A?Brand v99 | 同构 | 一致（STEP 23 GREASE 修复保持 + **FIX-3 层一致**） | |
| 21 | Client Hints | platformVersion 15.0.0 / x86_64 | 同构 | 一致（FIX-3：网络头与 JS 层统一） | 引擎对齐后 brandsVer=151 |
| 22 | timezone/language | fp 对齐 | Asia/Shanghai zh-CN | 一致（托管） | 注：语言-时区跨区配对（如 Paris+ja-JP）为真实感打磨候选（非 headless 信号，不在本 STEP 动） |
| 23 | WebRTC | RTCPeerConnection + mDNS 掩码 | 同 | 一致 | STEP 17 无泄露实证 |
| 24 | iframe dims | inner 500x300 保持 | 同 | 一致 | |
| 25 | headless 专属 API 面 | 全清（UA/plugins/mimeTypes/chrome.app） | — | 一致 | 见下「纯 headless 残余」 |

### 纯 headless 残余（仅 product-headless 形态）
- **Worker / UA-CH 层严格信号**（CreepJS webDriverIsOn / hasHeadlessWorkerUA）：
  **C 类——架构固有限制**。`addInitScript` 不进入 Dedicated/Audio Worker；真实 headless 的 UA-CH 管道不可移除。
  **产品答案已落地 = hidden-headful 模式（STEP 20）**：真实 headful Chrome 进程 + 窗口移出屏幕，
  Worker/UA-CH 全真，从根上消除该层。纯 headless 模式保留为「速度优先、非对抗场景」形态，
  产品文档标注：反检测强场景必须 hidden-headful。

## 四、本次审计新增 B 类修复（均过四问）

### FIX-1 navigator.mimeTypes 形状（5→2 共享实例）
- **证据**：原生对照实测 5 插件 × length2、`navigator.mimeTypes.length===2`、
  `plugins[i].mimeTypes[j] === navigator.mimeTypes[j]` 恒等、enabledPlugin 均 'PDF Viewer'。
- **四问**：Q1 原生值合理 ✓ / Q2 注入每插件独立 mimeType 致 5 条，与原生矛盾 ✓ / Q3 共享实例不引入新不一致 ✓ /
  Q4 修复方向=向原生对齐，非为分数 ✓。
- **改动**：`server/fp/inject.js` PLUGINS 每插件 2 mimeType（application/pdf+text/pdf），
  `sharedMime` 按 type 共享实例，`epAssigned` Set 保证 enabledPlugin 归首插件，allMimeTypes 去重。

### FIX-2 permissions.query 原生状态映射（default→prompt）
- **证据**：原生对照实测 `Notification.permission='default'` ↔ `permissions.query` state=**'prompt'**
  （denied↔denied 同理）；default+default 组合在原生 Chrome 不存在。
- **四问**：Q1 原生映射合理 ✓ / Q2 注入直接回显 default，非原生语义 ✓ / Q3 与 denied→default 纠正链兼容 ✓ /
  Q4 向原生对齐 ✓。
- **改动**：`server/fp/inject.js` query 拦截器 `p==='default' ? 'prompt' : p`。

### FIX-3 网络层 Client Hints 头与 JS 层 userAgentData 层一致性（STEP 19R 追加）
- **证据（代码层 + 运行时实测）**：真实 Chrome 的 sec-ch-ua 请求头与 `navigator.userAgentData` **两层恒一致**。
  此前产品两层各自实现且互相矛盾——GREASE：网络层旧 `Not?A_Brand v24`（末位）vs JS 层现代
  `Not=A?Brand v99`（首位，STEP 23 只改了 inject 层）；platformVersion：Windows 网络层 `10.0.0`（Win10 语义）
  vs JS 层 `15.0.0`（Win11 语义）。服务端可见头、页面 JS 可见 brands，任一不一致即可嗅探，且属内部自相矛盾。
- **四问**：Q1 两层一致是原生事实 ✓ / Q2 我们两层逐字段矛盾 ✓ / Q3 统一取 inject 层已验证形状，不引入新不一致 ✓ /
  Q4 非为分数，是消除自身矛盾 ✓。**B 类成立。**
- **改动**：`server/browserManager.js` `applyClientHints` brands/fullVersionList 与 inject.js 逐字段统一
  （`Not=A?Brand` 99 / 99.0.0.0 首位），platformVersion 恒定 `'15.0.0'`。
- **验证**：新增 `test_step19_layer_consistency.js`（本地 HTTP server 捕获请求头 vs 页内 JS 逐字段比对，
  L0–L8 共 11 断言）**11/11 ×2**；并用「seed 预生成 UA 147 → 引擎 151 对齐」场景实证**版本对齐无残留**
  （User-Agent / sec-ch-ua / fullVersionList / uaFullVersion 四处均为引擎完整版本 151.0.7922.174）——
  STEP 24 留档的「对齐型 seed Browser 卡单次 FAIL」线索就此闭环：可检面无版本残留，判站点侧判定波动（诚实记录）。

## 五、指令「五」三个已发现问题重新判定

1. **WebGL `--disable-gpu` 矛盾**：A 类，**已修**（此前 STEP 19）。本次审计复核：两产品模式
   webgl adapter-ok、renderer 为 OS 感知 ANGLE 池值、UA/platform/webGL 三者无矛盾。✅ 关闭
2. **outerHeight < innerHeight**：A 类，**已修**。复核：两模式 outerGeInner=true。✅ 关闭
3. **Notification.permission 注入成 denied**：A 类，**已修**（denied→default）。本次扩展修复其
   衍生面 permissions.query 原生映射（FIX-2）。✅ 关闭

## 六、结论

**STEP 19 STOP — remaining signals are architectural / detection-specific**

- Chromium/headless 固有限制（C）：纯 headless 的 Worker/UA-CH 层——产品边界=hidden-headful 模式（已落地）；
- 检测站点特定（D）：不做。不针对 CreepJS DOM/字符串写任何逻辑；
- 真实产品能力：hidden-headful 模式 + geo 三元一致 + mDNS 掩码 + 现代 Chrome 151 形状全对齐；
- 需要 headed 模式的场景：反检测强场景（已在产品内实现为 hiddenWindow 选项）；
- 未来独立 Browser Engine 工作：仅当需要纯 headless 形态也过严格检测时（商业价值存疑，不建议投入）。

修复不影响任何执行语义：注入层形状修复，不触碰 Planner / Runtime / Success Definition / Benchmark / Decision Semantics / Evidence Score。
