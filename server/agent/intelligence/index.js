'use strict';

// Browser Experience Intelligence 统一入口（Phase 3.1 + 3.2 + 3.3）。

const memoryRecord = require('./memoryRecord');
const siteMemory = require('./siteMemory');
const elementMemory = require('./elementMemory');
const flowMemory = require('./flowMemory');
const flowSchema = require('./flowSchema');
const flowMatcher = require('./flowMatcher');
const flowPlanner = require('./flowPlanner');

const failure = {
  schema: require('./failure/schema'),
  scoring: require('./failure/failureScoring'),
  knowledge: require('./failure/failureKnowledge'),
  matcher: require('./failure/failureMatcher'),
  advisor: require('./failure/failureAdvisor'),
  collector: require('./failure/failureCollector'),
};

const profile = {
  schema: require('./profile/schema'),
  scoring: require('./profile/profileScore'),
  metrics: require('./profile/profileMetrics'),
  analyzer: require('./profile/profileAnalyzer'),
  matcher: require('./profile/profileMatcher'),
  advisor: require('./profile/profileAdvisor'),
};

const router = require('./router');
const evaluation = require('./evaluation');

module.exports = {
  memoryRecord, siteMemory, elementMemory, flowMemory, flowSchema, flowMatcher, flowPlanner,
  failure, profile, router, evaluation,
};
