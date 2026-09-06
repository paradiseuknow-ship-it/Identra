# 池 v2 对齐重生成报告（B3 池对齐契约落地）

**日期**：2026-09-01 ｜ **状态**：✅ v2 池已就绪（生成期断言全绿 + 双回归全绿）；**跑 v2 benchmark 需用户授权，历史基线不可比**

---

## 0. 一句话结论

`phase12_pool_v2.json`（100 任务）已生成：**每个 objective 的目标资源/能力在对应 fixture 中确定性存在**，权威对齐 lint（audit v2 等价逻辑）零错配（v1 为 55/100）；v1 的 none+login 结构性缺陷以 30 个 `saas_demo` required 契约修复；v1 冻结池与 `real-world/` 场景目录零触碰。**尚未运行任何 v2 benchmark**。

## 1. 改了什么

### 1.1 新增：共享 lint 模块
- **`server/scripts/pool_alignment_lint.js`**：从 audit v2 逐字节抽取词典/规则/能力矩阵为可导出模块（`lintTask`/`lintPool`/`capabilityMatrix`/`isSearchOnly`）。audit 脚本本身冻结不动。

### 1.2 新增：v2 对齐生成器
- **`server/scripts/genPhase12PoolV2.js`**：按 6 个 fixture 真实能力重写 100 任务模板；**生成期五重 fail-fast 断言**（任一命中即 exit 2、不写任何产物）：
  1. 共享 lint 零错配；
  2. 引号词接地：objective 中每个「X」必须在 fixture 文本中出现，或 fixture 为 `search_lazy.html`（任意词确定性回显「搜索结果：X」，rw.083 探针实证），或 objective 期望「未找到相关商品」且 fixture 具有该确定性空结果提示；
  3. 登录契约一致性：needsLogin ↔ required+saas_demo 双向锁定；
  4. 登录 fixture 的 none 任务 objective 禁含登录后实体词（看板/导出/活跃用户）；
  5. 结构完整性（100 任务、id/objective 唯一、验证类型合法）。
- 产物：`server/scenarios/real-world-v2/rw.001..100.json + index.json`（含 credentialValue 供播种）+ **`phase12_pool_v2.json`**（与 v1 池同构，无明文凭据，`_meta.sha256` 可复核）。

### 1.3 模板对齐总表（v1 错配 → v2 归宿）

| v1 模板（错配根因） | 数量 | v2 归宿 |
|---|---|---|
| SaaS 搜索/建项目/改设置（login.html 无搜索/项目/设置能力） | 15 | 登录后看板观察/导出 CSV 多步变体（全部 required） |
| SaaS 数据查看 → list.html 订单/筛选臆造 | 5 | list.html 真实条目观察（戴尔/LG/飞利浦 榜单） |
| 电商 编辑/库存/订单/状态（search.html 无编辑/库存/订单） | 20 | 加购计数/价格确认（CATALOG 三商品确定性存在）+ list.html 只读榜变体 |
| 数据录入 公司字段/批量录入/文件上传（form 无公司字段/上传，download 无上传） | 10 | 两次提交确认 + download.html 下载链接任务 |
| 字段校验「去重」（form 无去重逻辑） | 1 | 两次提交均成功（真实行为） |
| 长流程 结算/支付/对比三款/翻页（无结算页） | 10 | 多商品加购链 + search_lazy 回显搜索（含「id 为 q」接地变体） |
| pay_demo 支付 ×2（无任何 fixture 具备支付能力） | 2 | 移除契约，改为高难加购 HIGH 任务；凭据族覆盖由 30 个 saas_demo 保留 |

### 1.4 harness 接线（B 类，默认路径零变化）
- **`phase10Benchmark.js` loadTasks**：场景目录解析序 = `FPB_SCENARIO_DIR` env 覆盖 → 默认 `scenarios/real-world`（不设 env 行为逐字节不变）。
- **`phase12Benchmark.js` selection 元数据**：`poolFile` 读 `FPB_POOL_FILE`（默认 `phase12_pool.json`）+ 新增 `scenarioDir` 透传（证据可溯源）。

## 2. 为什么

- v1 池 26pp 假阳性的主根因是**生成时 objective 与 fixture 从未对齐**（B 类池生成缺陷）；v2 从源头消除，使「执行成功≠业务成功」的口径缺陷不再有错配任务可供寄生。
- none+login 结构性不可满足（v1 最大损失源 ~20pp）：v2 中凡 objective 要求登录后状态的任务一律 required+saas_demo（30 个），none 任务只指向未登录可达状态。
- pay_demo 移除：6 个 fixture 均无结算/支付能力，v1 该 2 任务结构上不可满足；敏感字段门/凭据族工程覆盖不依赖池中存在支付任务。
- 接线采用 `FPB_TASK_DEADLINE` 同款三级解析模式，保证「不授权不切换池」：v1 冻结池仍是默认执行源。

## 3. 文件

| 文件 | 操作 |
|---|---|
| `server/scripts/pool_alignment_lint.js` | 新增（共享 lint 模块） |
| `server/scripts/genPhase12PoolV2.js` | 新增（v2 生成器，fail-fast） |
| `server/scripts/test_pool_alignment_lint.js` | 新增（等价性 17 断言 ×2） |
| `server/scripts/test_scenario_dir_override.js` | 新增（接线 11 断言 ×2） |
| `server/scripts/test_gen_pool_v2.js` | 新增（产物/行为 24 断言 ×3） |
| `phase12_pool_v2.json` + `server/scenarios/real-world-v2/`（101 文件） | 新增产物 |
| `server/scripts/phase10Benchmark.js` / `phase12Benchmark.js` | 修改（env 接线，默认零变化） |
| `phase12_pool.json` / `server/scenarios/real-world/` / `audit_pool_fixture_alignment.js` | **零触碰**（测试内指纹断言） |

## 4. 测试（全部真实子进程求值，非源码 eval）

- `test_pool_alignment_lint` **17/0 ×2**：共享模块与 audit v2 子进程输出全等（id 集合 + 逐任务 missing 明细 + searchOnlyPass）；权威对账 lint57 − 灰区3 + 人工 rw.076 === 快照 55；lintPool 只读指纹。
- `test_scenario_dir_override` **11/0 ×2**：默认=v1 冻结值；env=v2 对齐值；相对路径生效；非法目录显式抛错不静默空池；两池同 id 不同 objective（切换真实生效）。
- `test_gen_pool_v2` **24/0 ×3**：lint 零错配；分布 30/25/20/25；required 30 全 saas_demo 且落登录 fixture；池无明文凭据；引号词接地独立复核；场景文件与池一一对应；**确定性重生成逐字节不变**；v1 冻结产物指纹不变；**负向注入错配任务 → exit 2 且零写盘**。

## 5. 回归（顺序执行）

- `runRegression.js`：**75/0**（72 基线 + 3 个新测试自动收编）
- `run_phase9_regression.sh`：**OK=68 / BAD=0**（65 基线 + 3）
- 日志：`.benchmark/regression_1788238591359.log`、`.benchmark/phase9_regression_20260901_130159.txt`

## 6. 下一步（全部需授权）

1. **smoke（被 DEEPSEEK_API_KEY 阻塞）**：`rw.094/083/004/027/034` 5-10 任务，E1 actions 摘要完成 rw.083 最终归因 + 验证 P4/P5 契约效果；
2. **v2 池 benchmark 决策**：smoke 后评估是否以 `FPB_SCENARIO_DIR=<v2目录> FPB_POOL_FILE=phase12_pool_v2.json` 启动新基线（历史基线不可比；预期假阳性 26pp → ≈0，Business Success 口径口径纯度提升）；
3. **rw.083 readiness 修复**：等 smoke 证据确认 A/C 类后再修（探针已排除基础设施层，指向 planner 证据臆造 = P5 类）。

## 7. 边界与诚实声明

- v2 池 100% feasible 是**静态对齐**结论（objective↔fixture 内容确定性），不预支执行成功率；harness「fallback 路径执行成功即 SUCCESS」的口径缺陷仍在（B2 报告已登记），v2 池只是消除了错配寄生面。
- search_lazy 回显类任务（D2 ×5）验证的是「回显出现」，商品词无需在 fixture 中静态存在——这是 rw.083 探针实证的确定性机制，非放宽验证。
- 30 个 required 任务占比 30%（v1 为 10+2）：凭据供给配置质量将更直接地影响新基线，属预期设计。
