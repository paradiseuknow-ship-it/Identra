'use strict';

// ============================================================================
// PHASE 17-C — Project Skill 统一入口（设计依据：.benchmark/PHASE17B_PROJECT_SKILL_ARCHITECTURE.md）
//
// 本阶段边界（§25.1）：
//   PHASE 17-C「基础骨架（无 Skill 执行）」：
//     ✅ Schema 定义 + SEC1–SEC8 安全校验
//     ✅ 集合注册（aiSkill / aiSkillHistory / aiSkillEvidence / aiSkillRuns）
//     ✅ SkillBuilder（**只产 CANDIDATE，不接执行**）
//     ✅ Evidence Chain 落库
//   PHASE 17-D「Router + 预检（**不接执行**）」：
//     ✅ SkillRouter 五级判定 + 三态预检（MATCH / MISMATCH / INDETERMINATE）
//     ✅ 独立性判定（aiSkillRuns）
//     ✅ **影子模式**：只做「决策 + 证据」，决策结果**不改变执行路径**
//   PHASE 17-E「Executor / Handover / Lifecycle」：
//     ✅ SkillExecutor 七步契约（ROUTE → PRECHECK → EXECUTE → OBSERVE → VERIFY_STATE
//        → HANDOVER / CONTINUE → FINAL_VERIFICATION）
//     ✅ Handover Contract（结构化 12+ 原因 + SKILL_HANDOVER_ONCE，不可循环）
//     ✅ 生命周期状态机（CANDIDATE → ACTIVE → REVALIDATING → STALE → DEPRECATED）
//     ✅ 集合 aiSkillExecutions（执行记录，executionId 配对）
//     ✅ 受监督接线：Runtime 主循环把「这一步用 Skill 动作还是 Generic 动作」的决策权
//        交给 Executor，**物理执行仍走既有 runStep → tools.execute 全管线**
//
// 结构保证（§8.2 / §2 Q2）：Skill 层是**规划层的上游替换，不是执行层的旁路**。
//   skillExecutor 不 require 任何浏览器 / 工具层模块（见 test_c113 组 N 的静态断言），
//   它唯一的产出是「语义动作」与「何时交还控制权」——
//   「Skill 绕过 Phase 17-A 凭据闸 / 绕过 verification.js」在结构上不可能发生。
// ============================================================================

const schema = require('./skillSchema');
const lifecycle = require('./skillLifecycle');
const evidence = require('./skillEvidence');
const builder = require('./skillBuilder');
const router = require('./skillRouter');
const executor = require('./skillExecutor');

module.exports = { schema, lifecycle, evidence, builder, router, executor };
