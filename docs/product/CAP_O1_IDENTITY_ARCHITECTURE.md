# CAP-O1 — User / Workspace / Role / Permission 身份基础层架构

> 状态：**STEP 11 设计稿 + 实现依据（2026-08-30）。最小可商业化闭环，不是完整企业 SaaS。**
> 上游约束：产品 = Generic AI Browser Operator + Fingerprint Browser。本层只做「身份与资源归属」，不引入任何站点类型判定，不改变执行链语义。

---

## 0. 只读审计结论（2026-08-30，以代码为准）

### 0.1 身份现状

| 项 | 现状 |
|---|---|
| 用户体系 | **无**。无 User / Workspace / Membership / Role 实体 |
| 认证 | 仅机器级（`server/auth.js`，STEP 0.5）：模式 A（loopback 放行）/ 模式 B（共享 `FPB_API_TOKEN`）。token 是**机器令牌**，不区分人 |
| 会话 | 无。token 无主体、无过期 |
| 前端 | 无 login、无 user/workspace state；`client/src/api.js` 零鉴权处理（模式 A 下不需要） |
| 归属字段 | 全部资源 0 个 `workspaceId / createdBy / ownerId / userId`（全仓扫描证实；`sessionExpired.js` 等命中是浏览器会话语义，非用户会话） |
| Credential Vault | `server/vault.js`——第三方网站凭据，与「用户登录密码」**概念隔离**，保持隔离 |

### 0.2 资源实体与归属

| 实体 | 存储 | 现有字段（关键） | 归属现状 |
|---|---|---|---|
| Profile | `data/profiles.json`（db.js facade） | id/name/fingerprint/proxy…/createdAt | 无归属 |
| Proxy | `data/proxies.json`（密码已 AES-GCM 加密落盘） | id/host/port/passwordEnc | 无归属 |
| Task(workflow) | `data/tasks.json` | id/steps | 无归属 |
| AI Task | `data/aiTasks.json`（taskManager） | id/objective/profileId/secretRefs/… | 无归属 |
| AI Credential | `data/aiCredentials.json` | id/profileId/site/available | profile-scoped，无 workspace |
| Execution/Step/Event | `aiExecutions.json` 等 | taskId | 经 Task 间接归属 |
| 审计 | 无独立 Audit 实体（events 仅运行事件） | — | 本阶段不新建，预留 |

### 0.3 API 边界现状

`server/index.js` 挂载 6 个业务 router + `agent/index.js`（67+ 端点），全部只过 `requireAuth`（机器级）。**没有任何端点具备用户级授权**。`profiles.json` 当前不存在（空仓起步 → 归属字段零迁移成本）。

### 0.4 存储

纯 JSON 文件 + facade（`db.js` / taskManager 内置 store），无 SQLite、无 migration。**最小迁移方案：沿用 JSON facade + 惰性归属补齐（legacy 资源视为本地默认工作区），不引入数据库。**

---

## 1. 双模式兼容设计（本层最关键决策）

现有 `auth.js` 的模式 A/B 必须继续成立，身份层以**叠加而非替换**方式接入：

```text
HTTP Request
 ↓
[新] /api/auth/* 公开身份路由（register/login/logout/me，自管权限）
 ↓
[新] identityResolver 中间件：session token → req.identityUser
 ↓
[扩] requireAuth（auth.js）：isPublicPath → identityUser → 机器 token → loopback
 ↓
[新] 资源归属守卫（profiles /tasks 等，按资源逐个接入）
 ↓
现有业务逻辑（零改动）
```

| 模式 | 行为 |
|---|---|
| **模式 A（本地单机，默认）** | 首次访问惰性 bootstrap：`local` 用户 + `默认工作区` + OWNER membership。loopback 请求自动挂 local 用户。**现有用户行为与全部回归零变化**——本地模式即单用户模式，归属层存在但恒放行 |
| **模式 B（token 共享部署）** | 机器 token 持有者映射为 local 用户（保持既有消费方兼容）；**session token 优先于机器 token**，带谁的 session 就是谁。未带 session 且非机器 token → 401 |

多用户隔离语义在模式 B 下完整生效；模式 A 下身份层自动退化为恒等映射。这是「单机产品形态不被破坏」与「商业 SaaS 可演进」的交点。

## 2. 实体设计

### A. User（`data/identity_users.json`）
```text
{ id, username, email?, passwordHash, status: 'active'|'disabled'|'local', createdAt, updatedAt }
```
- 密码：`scrypt`（N=16384）+ 随机 salt，存 `s1$<salt>$<hash>`。**明文密码任何时刻不落盘、不进日志、不进 LLM prompt、不进 trace。**
- `status:'local'` 为模式 A 引导用户，无密码不可登录，仅由 loopback/机器 token 映射。
- **与 Credential Vault 概念隔离**：登录密码 ≠ 第三方网站凭据，两个体系互不引用。

### B. Workspace（`data/identity_workspaces.json`）
```text
{ id, name, ownerId, planId: 'free', status: 'active', createdAt, updatedAt }
```

### C. Membership（`data/identity_memberships.json`）
```text
{ id, workspaceId, userId, role: 'OWNER'|'ADMIN'|'MEMBER', status: 'active', createdAt }
```
一个 User 可属多个 Workspace；每个 Workspace 至少一个 OWNER；转移 Owner 本阶段不做（记入 blockers）。

### D. Session（`data/identity_sessions.json`）
```text
{ token(sha256 后落盘), userId, workspaceId(当前上下文), createdAt, expiresAt }
```
- 明文 token 只在 login 响应出现一次；落盘存 sha256（防存储泄露直接冒用）。TTL 7 天。
- 内存 Map 缓存 + 文件持久化，重启不清登录态。

## 3. 权限模型（Workspace + RBAC，仅三角色）

```text
const ROLE_PERMISSIONS = {
  OWNER: [ profile:manage, profile:use, task:manage, task:create, task:read,
           credential:manage, member:manage, workspace:update, workspace:delete,
           audit:read, billing:manage ],
  ADMIN: [ profile:manage, profile:use, task:manage, task:create, task:read,
           credential:manage, member:manage, audit:read ],
  MEMBER: [ profile:use, task:create, task:read ],
};
```

| 能力 | OWNER | ADMIN | MEMBER |
|---|:-:|:-:|:-:|
| 删除/更新 Workspace、Billing | ✅ | ❌ | ❌ |
| 管理成员 | ✅ | ✅ | ❌ |
| 增删改 Profile/Proxy/Credential | ✅ | ✅ | ❌ |
| 启动 Profile / 执行 Task | ✅ | ✅ | ✅（被授权范围内） |
| 查看 Workspace 内 Task | ✅ | ✅ | ✅（自己的 + 被授权的） |
| 查看审计 | ✅ | ✅ | ❌ |

禁止过早设计几十种细粒度权限。检查入口唯一：`identity.can(userId, workspaceId, permission)`——**禁止 route 内各自 if 拼权限**。

## 4. 资源归属矩阵（以 0.2 审计为准，非照抄模板）

| Resource | Workspace | User | Profile | Global | 说明 |
|---|:-:|:-:|:-:|:-:|---|
| Profile | YES | createdBy | — | NO | **第一批 workspace-scoped**。proxy/fp 属 profile 内嵌 |
| AI Task | YES | createdBy | optional | NO | 本阶段：stamp `workspaceId/createdBy` + 创建归属；跨 workspace 读取拒绝 |
| Execution/Step/Event | 经 Task | 经 Task | 经 Task | NO | 不直接加字段（避免机械加列） |
| AI Credential | 经 Profile | — | YES | NO | 跟随 Profile 归属，独立字段后置 |
| Proxy | YES | createdBy | optional | NO | workspace-scoped（阶段二接入守卫） |
| Workflow Task | YES | createdBy | — | NO | 同 Proxy，阶段二 |
| SiteMemory/FlowMemory | Global（聚合层） | — | — | YES | 经验聚合是跨任务统计，**不做用户隔离**（与 Router 语义一致） |
| System config | — | — | — | YES | — |

**Legacy 数据迁移规则**：无 `workspaceId` 的既有资源视为「本地默认工作区」——模式 A 下可见可改；模式 B 下仅 local 用户可见。惰性补齐（读到时补写），不做批量迁移脚本。

## 5. Authorization 中间件

```js
// 1) 身份解析（每个 /api 请求一次）
identityResolver(req) → req.identityUser | null
// 2) 资源守卫（在需要隔离的路由内调用，统一出口）
identity.requireWorkspace(userId, wsId, 'profile:manage')   // 抛 403 语义错误
identity.filterByWorkspace(list, user)                       // 列表过滤
identity.stamp(user, wsId)                                   // { workspaceId, createdBy, updatedBy }
```

## 6. Profile = 第一批隔离资源（验收用例）

```text
same workspace member  → GET/PUT/DELETE 按角色放行或拒绝
different workspace    → GET /profiles 列表不可见；GET /profiles/:id 403；DELETE 403
non-member / 无 session→ 模式 B 下 401
OWNER/ADMIN            → 按 §3 矩阵
```

## 7. 红线（本层不触碰）

- 不改 Success Definition / Verification / Planner / Router 语义
- 不给 LLM 任何密码/凭据明文（登录密码与 vault 双重隔离）
- 模式 A 本地行为与全部既有回归零变化
- 不引入 siteType 判定、不为 benchmark 改本层

## 8. 本阶段范围外（Blockers → 后续条目）

- Owner 转移、Billing 实体、配额/套餐执行（planId 仅占位）
- Proxy / Workflow-Task / Credential 的守卫接入（阶段二）
- 独立 AuditLog 实体（先用既有 events）
- API Key（机器 token 已覆盖）
- 前端 login UI（本阶段 API-first）
