const BASE = '/api';

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const api = {
  // profiles
  listProfiles: () => req('GET', '/profiles'),
  getProfile: (id) => req('GET', '/profiles/' + id),
  createProfile: (b) => req('POST', '/profiles', b),
  updateProfile: (id, b) => req('PUT', '/profiles/' + id, b),
  regenerateSeed: (id) => req('PUT', '/profiles/' + id, { regenerateSeed: true }),
  deleteProfile: (id) => req('DELETE', '/profiles/' + id),
  duplicateProfile: (id) => req('POST', '/profiles/' + id + '/duplicate'),
  previewFp: (b) => req('POST', '/profiles/preview-fp', b),

  // proxies
  listProxies: () => req('GET', '/proxies'),
  createProxy: (b) => req('POST', '/proxies', b),
  updateProxy: (id, b) => req('PUT', '/proxies/' + id, b),
  deleteProxy: (id) => req('DELETE', '/proxies/' + id),
  checkProxy: (id) => req('POST', '/proxies/' + id + '/check'),
  checkProxyGeo: (id) => req('POST', '/proxies/' + id + '/check-geo'),
  checkInlineProxy: (b) => req('POST', '/proxies/check-inline', b),
  proxyHealth: () => req('GET', '/proxies/health'),
  rotateProfileProxy: (profileId) => req('POST', '/proxies/rotate', { profileId }),

  // profiles 迁移 / 体检（CAP-C1 / integrity）
  exportProfiles: () => req('GET', '/profiles/export'),
  importProfiles: (b) => req('POST', '/profiles/import', b),
  batchCreateProfiles: (b) => req('POST', '/profiles/batch', b),

  // templates（CAP-A1 指纹模板库）
  listTemplates: () => req('GET', '/templates'),
  createTemplate: (b) => req('POST', '/templates', b),
  updateTemplate: (id, b) => req('PUT', '/templates/' + id, b),
  deleteTemplate: (id) => req('DELETE', '/templates/' + id),
  checkTemplate: (id) => req('GET', '/templates/' + id + '/check'),
  profileIntegrity: (id) => req('GET', '/profiles/' + id + '/integrity'),

  // settings（C14 运行时设置中心）
  getSettings: () => req('GET', '/settings'),
  updateSettings: (b) => req('PUT', '/settings', b),
  testLlm: (b) => req('POST', '/settings/test', b),
  // profiles 运行态快照（C20）
  profileRuntime: () => req('GET', '/profiles/runtime'),
  // 数据备份（C22）
  exportBackup: () => req('GET', '/backup/export'),
  restoreBackup: (snapshot) => req('POST', '/backup/restore', snapshot),

  // schedules（C17 定时调度，挂 /api/ai/schedules）
  listSchedules: () => req('GET', '/ai/schedules'),
  createSchedule: (b) => req('POST', '/ai/schedules', b),
  updateSchedule: (id, b) => req('PUT', '/ai/schedules/' + id, b),
  deleteSchedule: (id) => req('DELETE', '/ai/schedules/' + id),
  triggerSchedule: (id) => req('POST', '/ai/schedules/' + id + '/trigger'),

  // execution engine（C23 执行引擎：scheduler + worker 池 + 队列 + 资源池）
  executionStatus: () => req('GET', '/ai/execution/scheduler/status'),
  executionQueue: () => req('GET', '/ai/execution/queue'),
  executionWorkers: () => req('GET', '/ai/execution/workers'),
  executionResources: () => req('GET', '/ai/execution/resources'),
  workerStart: (b) => req('POST', '/ai/execution/workers/start', b || {}),
  workerStop: (id) => req('POST', '/ai/execution/workers/' + id + '/stop', {}),
  schedulerCtl: (action) => req('POST', '/ai/execution/scheduler/' + action, {}),

  // intelligence（C24 智能记忆：站点画像 / 流记忆 / 失败知识，只读出口）
  intelSites: () => req('GET', '/ai/intelligence/sites'),
  intelSiteDetail: (site) => req('GET', '/ai/intelligence/sites/' + encodeURIComponent(site)),
  intelFlows: () => req('GET', '/ai/intelligence/flows'),
  intelFailures: () => req('GET', '/ai/intelligence/failures'),

  // browser
  launch: (id) => req('POST', '/browser/' + id + '/launch'),
  stop: (id) => req('POST', '/browser/' + id + '/stop'),
  status: () => req('GET', '/browser/status'),

  // vault
  getVault: (id) => req('GET', '/vault/' + id),
  setVault: (id, b) => req('POST', '/vault/' + id, b),

  // tasks
  listTasks: () => req('GET', '/tasks'),
  createTask: (b) => req('POST', '/tasks', b),
  updateTask: (id, b) => req('PUT', '/tasks/' + id, b),
  deleteTask: (id) => req('DELETE', '/tasks/' + id),

  // automation
  runAutomation: (b) => req('POST', '/automation/run', b),
  previewAutomation: (b) => req('POST', '/automation/preview', b),

  // cookies
  exportCookies: (id) => req('GET', '/cookies/' + id + '/export'),
  importCookies: (id, cookies) => req('POST', '/cookies/' + id + '/import', { cookies }),

  // AI Browser Operator
  aiCreateTask: (b) => req('POST', '/ai/tasks', b),
  aiListTasks: () => req('GET', '/ai/tasks'),
  aiGetTask: (id) => req('GET', '/ai/tasks/' + id),
  aiStartTask: (id) => req('POST', '/ai/tasks/' + id + '/start'),
  aiPauseTask: (id) => req('POST', '/ai/tasks/' + id + '/pause'),
  aiCancelTask: (id) => req('POST', '/ai/tasks/' + id + '/cancel'),
  aiResumeTask: (id) => req('POST', '/ai/tasks/' + id + '/resume'),
  aiRetryTask: (id) => req('POST', '/ai/tasks/' + id + '/retry'),
  aiTaskEvents: (id) => req('GET', '/ai/tasks/' + id + '/recent-events'),
  aiHealth: () => req('GET', '/ai/health'),
  // Phase 1.4：Chat / Session / Stats / Snapshot / Approval
  aiChat: (b) => req('POST', '/ai/chat', b),
  aiSessions: () => req('GET', '/ai/sessions'),
  aiLLMStats: () => req('GET', '/ai/llm/stats'),
  aiSnapshots: (id) => req('GET', '/ai/tasks/' + id + '/snapshots'),
  aiApprove: (id) => req('POST', '/ai/tasks/' + id + '/approve'),
  aiReject: (id) => req('POST', '/ai/tasks/' + id + '/reject'),
  aiModify: (id, b) => req('POST', '/ai/tasks/' + id + '/modify', b),

  // Phase 4.3 Observability（agent 路由挂载于 /api/ai）
  aiDashboard: () => req('GET', '/ai/observability/dashboard'),
  aiTrace: (taskId) => req('GET', '/ai/observability/trace/' + taskId),
  aiReplay: (taskId) => req('GET', '/ai/tasks/' + taskId + '/replay'),
};

export default api;
