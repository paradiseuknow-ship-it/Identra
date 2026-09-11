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
//   ❌ 至今**没有** SkillExecutor —— Skill 从不驱动执行（§25.2「先落数据，后落执行」）
//
// 结构保证（§8.2 / §2 Q2）：Skill 层是**规划层的上游替换，不是执行层的旁路**。
// 由于本模块不导出任何执行入口，且未来 Executor 展开后仍走 tools.runTool，
// 「Skill 绕过 Phase 17-A 凭据闸」在结构上不可能发生。
// ============================================================================

// PHASE 17-D 追加：SkillRouter（五级判定 + 三态预检）。
// ★ 它仍然**不是**执行入口 —— shadow() 只产出决策与证据，route() 是纯函数。
//   执行侧（SkillExecutor / handover）属 17-E，本阶段不存在。
const schema = require('./skillSchema');
const lifecycle = require('./skillLifecycle');
const evidence = require('./skillEvidence');
const builder = require('./skillBuilder');
const router = require('./skillRouter');

module.exports = { schema, lifecycle, evidence, builder, router };
