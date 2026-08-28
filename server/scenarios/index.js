'use strict';

// Scenario Framework 统一入口（Phase 5 Task 1）。
//
// 目录结构：
//   scenarios/
//     ecommerce/  saas/  admin/  data_entry/  scraping/   ← 能力验证场景（应成功）
//     failure/                                          ← Task 4 五类失败注入（应触发恢复/正确失败）
//     index.js                                           ← 本文件，聚合全部场景
//
// 场景 Schema（每个场景对象）：
//   {
//     id:              string            唯一标识
//     category:        string            分类（= 所属目录）
//     name:            string            可读名称
//     objective:       string            真实业务目标（交给 Planner 生成计划）
//     difficulty:      'EASY'|'MEDIUM'|'HARD'
//     fixture:         string|null       mock-site 相对路径；null=使用 dead port（网络失败注入）
//     expectedSteps:   number            参考步骤数（仅文档/评分参考）
//     expectedOutcome: { summary, verify }  业务预期（文档 + 可选断言）
//     failureInjection: null | { type, note }  失败注入类型（5 选 1 或 null）
//   }
//
// 失败注入类型（Task 4 必选）：
//   page_not_found | element_changed | network_failure | login_failure | verification_failure
//
// 注意：场景只描述“目标”，不预设执行步骤；真实计划由 Planner（DeepSeek）在运行时生成。
//       benchmark runner 通过 taskManager.createTask + start 走唯一真实链路执行。

const ecommerce = require('./ecommerce');
const saas = require('./saas');
const admin = require('./admin');
const dataEntry = require('./data_entry');
const scraping = require('./scraping');
const failure = require('./failure');

const CATEGORIES = ['ecommerce', 'saas', 'admin', 'data_entry', 'scraping', 'failure'];

function loadAll() {
  const groups = { ecommerce, saas, admin, dataEntry, scraping, failure };
  const out = [];
  for (const cat of CATEGORIES) {
    const list = groups[cat] || [];
    list.forEach((s) => {
      // 以目录名为权威 category，避免与文件内声明不一致
      out.push(Object.assign({ category: cat }, s, { category: cat }));
    });
  }
  return out;
}

function byCategory(cat) {
  return loadAll().filter((s) => s.category === cat);
}

function byInjection() {
  return loadAll().filter((s) => s.failureInjection && s.failureInjection.type);
}

function get(id) {
  return loadAll().find((s) => s.id === id) || null;
}

module.exports = { CATEGORIES, loadAll, byCategory, byInjection, get };
