# STEP 22 — Business E2E Verification Hardening + Secrets Workspace Isolation · RESULT

> 日期：2026-08-30 ｜ 触发：STEP 21B 只读侦察结论直接授权实施 ｜ 结论：**全部通过（harness 63/0 ×2，双回归 54/0 + 47/0）**

---

## 1. 目标与范围

| 目标 | 内容 | 结果 |
|---|---|---|
| I1 Secrets 安全前置 | `/secrets` 路由接入 identity/workspace 守卫；`aiCredentials` 服务端盖章；调用方伪造 workspaceId 失效 | ✅ 完成（安全矩阵 19 项全绿） |
| V1 验证证据类型 | 新增 `storage` / `url_pattern`；显式 opt-in `persistAfterReload`（reload→fresh observation→二次合约验证） | ✅ 完成（验证矩阵 16 项 + 三场景 E2E 全绿） |
| 22.6 newInformation | 不扩生产范围；测试层证明失败 attempt 与成功后观察非同一份（事件时间线 + attempt 记录） | ✅ 完成 |

## 2. 改动清单（生产代码 7 文件 + 1 新增 harness）

| 文件 | 改动 | 归因 |
|---|---|---|
| `server/agent/secretManager.js` | `createSecret` 落库 `workspaceId/createdBy`；`maskedView` 带 workspaceId；新增 `listRecords()` | I1 |
| `server/agent/index.js` | `/secrets` 三路由重写：POST 走 `assertCan('credential:manage')`+服务端盖章+audit；GET 走 `filterByWorkspace`+脱敏视图；新增 DELETE 走 `assertCanAccessResource` | I1 |
| `server/agent/observation.js` | COLLECT_JS 新增真实 Web Storage 快照（复用页内 redact/SENS 单一真源，敏感键→REDACTED，≤50 键）；cache-hit 分支刷新 storage（沿 cached.network 先例）；fresh observation 挂 `storage` 字段 | V1 |
| `server/agent/verification.js` | 新增 `case 'storage'`（exists/equals，fail-closed）与 `case 'url_pattern'`（真实 page.url()，非法/超长正则 FAIL 不抛出）；既有 case 零改动 | V1 |
| `server/agent/runtime.js` | persistAfterReload 最小接线：仅 `effV.businessState.persistAfterReload === true` 触发（推导合约不含该字段→默认路径零改动）；reload→`inspect(skipCache)`→二次 `verify`；失败→VERIFY_FAILED；成功→`toolRes.observation` 替换为 reload 后真实状态 | V2 |
| `server/agent/events.js` | 登记 `ai.verification.persist_reload` 事件类型（此前未登记会被 events 层静默丢弃） | 实施中发现 |
| `server/agent/schema/action.js` | `VERIFICATION_TYPES` 白名单补齐 `field_value/field_checked/url_pattern/storage`（引擎早已支持而 schema 门拒绝=一致性缺陷） | B 类 |
| `server/scripts/test_step22_business_e2e.js` | 新增：真实 HTTP 测试站 + 生产入口全链 harness（63 断言） | 测试 |

**零改动确认**：Success Definition、contract.js、verificationWindow.js、benchmark 任务池、Planner 决策语义、Runtime 主循环结构、task state machine、Router/siteMemory/flowMemory、fingerprint/anti-detect/browser core、payment 策略——全部未触碰（mtime + 标记 grep 双重取证）。

## 3. I1 安全矩阵（19/19 ×2）

- 未认证 401（由 `/api/ai` 挂载层 identityResolver+requireAuth 保证，不重复造轮子）
- `POST /secrets` MEMBER→403（`credential:manage` 为 OWNER/ADMIN 专属）
- **调用方伪造 workspaceId 被忽略**：落库恒为服务端 identity workspace
- 跨 workspace 不可见：bob（wsB）GET /secrets 看不到 wsA 任何 secret
- DELETE 越权 403；owner 删除 200；删除后列表不含
- audit 记录 secret.create/delete；audit payload 无明文

## 4. Verification 矩阵（16/16 ×2）

- storage：equals 命中 PASS / 不匹配 FAIL / 键缺失 FAIL / exists:false 反向 FAIL / sessionStorage 选区正确 / REDACTED 脱敏值仍可作存在性证据 / 观察层无 storage 数据 fail-closed FAIL / 缺 key FAIL
- url_pattern：匹配 PASS / 不匹配 FAIL / 非法正则 FAIL 且 Runtime 不崩 / 缺 pattern FAIL / >200 字符 FAIL
- persistAfterReload 默认安全：推导合约（login）不携带该字段；默认执行路径不触发复验块；显式声明原样进入 runtime 复验块

## 5. 三业务场景 E2E（真实生产链，禁 mock）

| 场景 | 链路 | 结果 |
|---|---|---|
| A Login | navigate→vault+credentialRef 填 email/password→submit→LOGIN_SUCCESS 合约→**persistAfterReload 全链复验**（reload→fresh observationId→二次验证） | ✅ SUCCESS |
| C Form | navigate→填 name/email→submit→`url_pattern /form/done` + `storage formSubmitted` 合约→新会话打开 /form 服务端持久化值重填充 | ✅ SUCCESS |
| E Multi-step | /step-a→click→/step-b→**受控失败注入**（按钮挂载即 `display:none`，首试真实 ELEMENT_NOT_FOUND ×3）→diagnosis→deterministic recovery（退避 300/600/1200ms）→第 4 次 attempt 成功→/step-c 三证据合约（url_pattern+text+storage） | ✅ SUCCESS |

**22.6 newInformation 证据**：e3 失败记录 ×3 与成功 attempt 分离；task.step_started ×4 证明多 attempt；事件时间线证明成功观察晚于失败观察（fresh 血缘）。

## 6. 失败注入设计的关键实证（本轮挖出的机制事实）

1. **click 对未挂载元素的 auto-wait 不受 timeoutMs 约束**（`humanClick→locator.boundingBox()` 等到元素出现才返回）——「延时按钮+短 timeout」造不出真实失败（run1c/d/e 三轮实证，e3 单次尝试 6052ms 成功）。
2. **确定性注入正解**：按钮挂载但 `display:none` → boundingBox() 立即返回 null → 抛 `element not found` → `errorClassifier` 按 message 归类 ELEMENT_NOT_FOUND → 诊断链闭合。
3. 事件语义：`agent.diagnosing.payload.category`=失败分类（ELEMENT_NOT_FOUND），`agent.retrying.payload.reason`=原始错误码（TOOL_EXECUTION）——两者同现=诊断→恢复链闭合。

## 7. F 失败注入（persistAfterReload 边界，6/6 ×2）

- F1 状态丢失：sessionStorage.once reload 后消失 → reverified success=false → 任务 HUMAN_ESCALATION（显式失败终态，未判 SUCCESS）
- F2 reload 超时（hang 页 2s 超时）→ `reload_failed` 事件 + attempt 级 VERIFY_FAILED「reload 不可完成」落库 ×2
- 产品边界（C 类，记录不改架构）：F2 场景下 repair 路径可能绕过 persist 复验使任务最终 SUCCESS——步骤级失败保证已达成（reload_failed+VERIFY_FAILED），attempt 级架构性绕过留档

## 8. 明文五面断言（5/5 ×2）

密码明文（vault 内唯一）不进：① task record ② 任务事件流 ③ 数据目录全部 JSON ④ audit 流 ⑤ 任务面只见 credentialRef。明文只进浏览器输入层。

## 9. 幂等 ×2 + 双回归

| 验证 | 结果 |
|---|---|
| harness run2a（隔离 FPB_DATA_DIR） | **63/0** |
| harness run2b（另一隔离目录） | **63/0** |
| runRegression.js（顺序执行 1/2） | **54 通过 / 0 失败**（基线 53/0，+1 无失败） |
| run_phase9_regression.sh（顺序执行 2/2） | **OK=47 / BAD=0**（基线 46/0，+1 无失败） |

已知非缺陷项不变：phase3_live_raw_store 缺 visibleTexts 的长期 FAIL 未出现（本轮全绿）。

## 10. 红线 grep audit

- STEP 22 足迹：`persistAfterReload/persist_reload` 仅命中 runtime/events/verification/schema-action 四文件；`listRecords` 仅 secretManager+agent/index；`case 'storage'/'url_pattern'` ×2 于 verification.js
- 禁止清单模块（contract.js/verificationWindow/planner/taskManager/stepManager/siteMemory/flowMemory/deepseek/browserManager/paymentField/policy）：零 STEP 22 标记（browserManager 今日 mtime 来自更早会话，内容 grep 零命中）
- 明文面：harness G 节动态断言 ×2 全绿（静态 grep 辅证）

## 11. 结论与下一步

**结论**：STEP 22 两个核心目标全部实证达成——① /secrets 从「全量泄漏+无盖章+无删除」收敛为 RBAC 严格受控资源；② 验证证据类型从闭集 11 种扩展到含 storage/url_pattern/persistAfterReload 的完整业务状态证明链，且默认路径零改动（红线遵守）。Business Success 验证从「内部状态成功」前进到「真实业务状态 + reload 持久性证明」。

**下一步（待授权）**：
- 把 `requiredEvidence` 闭集（planner 契约提示侧）与 schema 白名单的扩展同步给 LLM planner 提示词（本次未动 planner，属授权边界外）
- F2 修复路径绕过 persist 复验的 attempt 级架构收敛（C 类边界，需产品决策）
- 以 STEP 22 能力重跑 100-task 业务基线，度量 Business Success 增益
