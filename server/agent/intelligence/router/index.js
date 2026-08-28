'use strict';

// Intelligence Router 统一导出（Phase 3.5）。

module.exports = {
  schema: require('./decisionSchema'),
  scoring: require('./decisionScoring'),
  contextBuilder: require('./contextBuilder'),
  advisorRegistry: require('./advisorRegistry'),
  explain: require('./explain'),
  cache: require('./decisionCache'),
  router: require('./intelligenceRouter'),
  decide: require('./intelligenceRouter').decide,
  recommendProfileId: require('./intelligenceRouter').recommendProfileId,
};
