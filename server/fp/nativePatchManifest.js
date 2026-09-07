'use strict';

// Phase 16-B — Chromium Native Patch Manifest（16-A UPGRADE_STRATEGY §23 正式落地）
//
// 纪律：
//   - 每个 patch 单独管理：独立 source files / symbols / commit / 回滚
//   - enabled=false 直到对应 POC 真实落地并通过其 testSuite
//   - chromiumVersion 固定 152（与 Phase 16-A SOURCE_MAP 一致；rebase 时走 upgrade 流程）
//   - 本清单是项目 repo 内的事实源；chromium/src 内每 patch 一个独立 commit
//
// riskLevel ∈ { LOW, MEDIUM, HIGH }（与 16-A SOURCE_MAP 风险口径一致）

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];

const PATCHES = [
  {
    patchId: 'identity-config-plumbing',
    surface: 'identity.pipeline',
    chromiumVersion: '152',
    sourceFiles: ['chrome/browser/fingerprint/identity_config.h', 'chrome/browser/fingerprint/identity_config.cc'],
    sourceSymbols: ['IdentityConfig', 'IdentityConfig::FromProfileDir', 'IdentityConfig::Get'],
    dependencies: [],
    riskLevel: 'LOW',
    testSuite: ['N-IDP-01', 'N-IDP-02', 'N-IDP-03'],
    // 2026-09-07 POC #7 全链完成（source→0008 patch→build→runtime→N-IDP patched 14/0
    // →六项验证 6/6→N-AUTO 5/0 零退化）后 enable。C8 实证真值：identity.json 在
    // <user-data-dir> 根（Option B 同根），PostEarlyInitialization 派生 fp-* 开关
    // （append-if-absent，外部显式开关永远获胜），全部既有消费点（0002 传播 +
    // 0003-0007 renderer/browser 消费）零改动点亮。
    enabled: true,
    status: 'ACTIVE',
  },
  {
    // 2026-09-06 POC #1 全链完成（source→patch→build→runtime→N-AUTO 5/0→stock 等价）后 enable。
    // C3 实证真值：webdriver 实现是 Navigator::webdriver() 单函数（navigator.cc:100），
    // 且需 0002 的 kSwitchNames 白名单传播（renderer 进程边界）。
    patchId: 'automation-native-webdriver',
    surface: 'navigator.webdriver',
    chromiumVersion: '152',
    sourceFiles: [
      'third_party/blink/renderer/core/frame/navigator.cc',
      'content/browser/renderer_host/render_process_host_impl.cc',
    ],
    sourceSymbols: ['Navigator::webdriver', 'RenderProcessHostImpl::kSwitchNames'],
    dependencies: [],
    riskLevel: 'LOW',
    testSuite: ['N-AUTO-01', 'N-AUTO-02', 'N-AUTO-03', 'N-AUTO-04', 'N-AUTO-05'],
    enabled: true,
    status: 'ACTIVE',
  },
  {
    // C3 实证真值（16-A 规划修正）：navigator_id.cc 的 NavigatorID::platform() 被
    // NavigatorBase 覆写（navigator_base.h 声明 String platform() const override），
    // 对 platform 表面是死代码（仅 Android 非 reduced-UA 路径可达）。唯一 virtual
    // 生产点 = NavigatorBase::platform()（navigator_base.cc），window.navigator 与
    // WorkerNavigator 均派生 NavigatorBase —— 单点天然覆盖全部 consumer；renderer
    // 可达性需 0002 同款 kSwitchNames 白名单传播。vendor 不在本 patch 范围
    // （NavigatorBase 无 vendor override，留待后续 POC）。
    patchId: 'navigator-identity',
    surface: 'navigator.platform',
    chromiumVersion: '152',
    sourceFiles: [
      'third_party/blink/renderer/core/execution_context/navigator_base.cc',
      'content/browser/renderer_host/render_process_host_impl.cc',
    ],
    sourceSymbols: ['NavigatorBase::platform', 'RenderProcessHostImpl::kSwitchNames'],
    dependencies: ['identity-config-plumbing'],
    riskLevel: 'MEDIUM',
    testSuite: ['N-NAV-01', 'N-NAV-02', 'N-NAV-03', 'N-NAV-04', 'N-NAV-05', 'N-NAV-06', 'N-NAV-07', 'N-NAV-08', 'N-NAV-09', 'N-NAV-10'],
    // 2026-09-06 C3 POC 全链完成（source→0004 patch→build→runtime→N-NAV PATCHED 13/13
    // →ownership→双回归 105/0 + OK=98/BAD=0）后 flip（§18）。
    enabled: true,
    status: 'ACTIVE',
  },
  {
    patchId: 'platformversion-identity',
    surface: 'navigator.userAgentData.platformVersion',
    chromiumVersion: '152',
    // sourceFiles/symbols = C2 实施实证真值（0003 patch）：per-call 生产层 value_or
    // + CDP network 层 merge 回退；renderer 管道（navigation_request → DocumentLoader）
    // 无需 patch——让位后无 override，回落本函数。NoDestructor 缓存零触碰。
    sourceFiles: ['components/embedder_support/user_agent_utils.cc', 'content/browser/devtools/protocol/emulation_handler.cc'],
    sourceSymbols: ['embedder_support::GetUserAgentMetadata', 'EmulationHandler::SetUserAgentOverride'],
    dependencies: ['identity-config-plumbing', 'navigator-identity'],
    riskLevel: 'MEDIUM',
    testSuite: ['N-PV-01', 'N-PV-02', 'N-PV-03', 'N-PV-04', 'N-PV-05', 'N-PV-06', 'N-PV-07', 'N-PV-08', 'N-PV-09', 'N-PV-10'],
    enabled: true,
    status: 'ACTIVE',
  },
  {
    // C53 实证真值（0009 patch）：metadata 生产层 platform 覆盖 —— 与 0003（C2
    // platformVersion）同函数同语义（value_or + ASCII guard fail-open），消费同一
    // --fp-platform 开关（identity.json cpuProfile.platform 派生）。单点驱动
    // sec-ch-ua-platform 头 + JS userAgentData.platform（两者均消费
    // blink::UserAgentMetadata），与 0004 navigator.platform 形成三层同源，
    // 关闭 C50 N-XC-W1 边界。CDP override 显式传值仍获胜；空串 wipe 边界与 C2
    // 同类（browser 级 metadata 保持一致，见 patchspec）。
    patchId: 'ua-metadata-platform-identity',
    surface: 'userAgentMetadata.platform',
    chromiumVersion: '152',
    sourceFiles: ['components/embedder_support/user_agent_utils.cc'],
    sourceSymbols: ['embedder_support::GetUserAgentMetadata'],
    dependencies: ['identity-config-plumbing'],
    riskLevel: 'MEDIUM',
    testSuite: ['N-XC-S1', 'N-XC-S4', 'N-XC-P1', 'N-XC-P3', 'N-XC-P5', 'N-XC-P6'],
    enabled: true,
    status: 'ACTIVE',
  },
  {
    // C4 实证真值（16-A 规划确认）：navigator.hardwareConcurrency 唯一 virtual
    // 生产点 = NavigatorBase::hardwareConcurrency()（navigator_base.h:57 override；
    // WorkerNavigator 无独立覆写，window/Worker 单点同源）。stock 基值 =
    // NavigatorConcurrentHardware::hardwareConcurrency()（SysInfo::NumberOfProcessors）；
    // CDP probe（InspectorEmulationAgent::ApplyHardwareConcurrencyOverride，由
    // Emulation.setHardwareConcurrencyOverride 驱动）在 0005 插入点之后应用 =
    // 显式 CDP override 仍获胜（CDP_OWNED 语义天然保持）。renderer 可达性需
    // kSwitchNames 白名单传播（0002/0004 同款）。
    patchId: 'hardwareConcurrency-identity',
    surface: 'navigator.hardwareConcurrency',
    chromiumVersion: '152',
    sourceFiles: [
      'third_party/blink/renderer/core/execution_context/navigator_base.cc',
      'content/browser/renderer_host/render_process_host_impl.cc',
    ],
    sourceSymbols: ['NavigatorBase::hardwareConcurrency', 'RenderProcessHostImpl::kSwitchNames'],
    dependencies: ['identity-config-plumbing', 'navigator-identity'],
    riskLevel: 'LOW',
    testSuite: ['N-HC-01', 'N-HC-02', 'N-HC-03', 'N-HC-04', 'N-HC-05', 'N-HC-06', 'N-HC-07', 'N-HC-08'],
    // 2026-09-06 C4 POC 全链完成（source→0005 patch→build 50 步 NINJA_EXIT=0→runtime→
    // N-HC PATCHED 17/17→ownership→双回归）后 flip（§18）。enabled=4 = 已被 POC 证明的数量。
    enabled: true,
    status: 'ACTIVE',
  },
  {
    // C5 实证真值（2026-09-06 考古 + STOCK 实测）：navigator.deviceMemory 唯一
    // 生产点 = NavigatorDeviceMemory::deviceMemory()（navigator_device_memory.cc，
    // mixin 非 virtual 单函数、全库无覆写分叉）；NavigatorBase 多重继承该 mixin
    // （navigator_base.h:42），window/Worker 单点同源。stock 基值 =
    // ApproximatedDeviceMemory::GetApproximatedDeviceMemory()；core/inspector 无
    // DeviceMemory CDP probe = 无 CDP override 竞争（比 C4 更简）。patch 白名单 =
    // Chromium 真实输出域 {1,2,4,8,16,32} 精确字符串 token（ApproximatedDeviceMemory
    // 实际 clamp 桌面 [2,32]/Android [1,8]，crbug 454354290；STOCK 实测 32GB 机器
    // nativeRef=32 实证），bare/未知 token fail-open stock。renderer 可达性需
    // kSwitchNames 白名单传播（0002/0004/0005 同款）。
    patchId: 'deviceMemory-identity',
    surface: 'navigator.deviceMemory',
    chromiumVersion: '152',
    sourceFiles: [
      'third_party/blink/renderer/core/frame/navigator_device_memory.cc',
      'content/browser/renderer_host/render_process_host_impl.cc',
    ],
    sourceSymbols: ['NavigatorDeviceMemory::deviceMemory', 'RenderProcessHostImpl::kSwitchNames'],
    dependencies: ['identity-config-plumbing', 'navigator-identity'],
    riskLevel: 'LOW',
    testSuite: ['N-DM-01', 'N-DM-02', 'N-DM-03', 'N-DM-04', 'N-DM-05', 'N-DM-06', 'N-DM-07', 'N-DM-08'],
    // 2026-09-06 C5 POC 全链完成（source→0006 patch→build NINJA_EXIT=0→runtime→
    // N-DM PATCHED 21/0 + STOCK 2/2→ownership→双回归）后 flip（§18）。
    // 白名单 {1,2,4,8,16,32} = Chromium 真实输出域（STOCK 实测 32GB 机器
    // nativeRef=32 实证；spec 文本域 {0.25..8} 已过时）。enabled=5 = 已被 POC 证明的数量。
    enabled: true,
    status: 'ACTIVE',
  },
  {
    // C6 实证真值（2026-09-06 考古）：navigator.maxTouchPoints 唯一 .cc 生产点 =
    // NavigatorEvents::maxTouchPoints(Navigator&)（core/events/navigator_events.cc，
    // STATIC_ONLY 静态工具类非 mixin，签名带 Navigator& 参数）；绑定经
    // navigator_events.idl partial interface Navigator（ImplementedAs=NavigatorEvents），
    // WorkerNavigator 无此扩展 → Worker 端 navigator.maxTouchPoints 在 stock 即
    // undefined → 单 window 侧 patch 点即全局完整（与 C5 双端 includes 不同）。
    // stock 值链：Settings（settings.json5 maxTouchPoints initial 0）← WebPreferences
    // pointer_events_max_touch_points = ui::MaxTouchPoints() ← Windows
    // GetSystemMetrics(SM_MAXIMUMTOUCHES)。CDP 面：无 protocol 级 override probe
    // （content/browser/devtools 零匹配）；仅 DevToolsEmulator::SetTouchEventEmulationEnabled
    // 运行时写 Settings —— patch 拦截 JS 暴露点，Settings 存储层保持 stock，
    // DevToolsEmulator save/restore 与内部事件消费者不受破坏。patch 白名单 =
    // 真实输出域 {0,5,10}（Windows 触摸屏数字化仪 SM_MAXIMUMTOUCHES 常见 10 /
    // 无数字化仪 0；移动端典型 5），bare/越域 token fail-open stock。
    // renderer 可达性需 kSwitchNames 白名单传播（0002/0004/0005/0006 同款）。
    patchId: 'maxTouchPoints-identity',
    surface: 'navigator.maxTouchPoints',
    chromiumVersion: '152',
    sourceFiles: [
      'third_party/blink/renderer/core/events/navigator_events.cc',
      'content/browser/renderer_host/render_process_host_impl.cc',
    ],
    sourceSymbols: ['NavigatorEvents::maxTouchPoints', 'RenderProcessHostImpl::kSwitchNames'],
    dependencies: ['identity-config-plumbing', 'navigator-identity'],
    riskLevel: 'LOW',
    testSuite: ['N-MT-01', 'N-MT-02', 'N-MT-03', 'N-MT-04', 'N-MT-05', 'N-MT-06', 'N-MT-07', 'N-MT-08'],
    // 2026-09-06 C6 POC 全链完成（source→0007 patch→build 50 步 NINJA_EXIT=0→runtime→
    // N-MT PATCHED 20/0 + STOCK 2/0→ownership→双回归）后 flip（§18）。
    // 白名单 {0,5,10} = 真实输出域（Windows SM_MAXIMUMTOUCHES / 无数字化仪 0）。
    // enabled=6 = 已被 POC 证明的数量。
    enabled: true,
    status: 'ACTIVE',
  },
];

const REQUIRED_FIELDS = ['patchId', 'surface', 'chromiumVersion', 'sourceFiles', 'sourceSymbols', 'dependencies', 'riskLevel', 'testSuite', 'enabled'];

// fail-fast 校验：缺字段/重复 patchId/非法 riskLevel/依赖指向不存在 patch → throw
function validateManifest(patches) {
  const seen = new Set();
  const ids = (patches || []).map((p) => p.patchId);
  (patches || []).forEach((p, i) => {
    for (const f of REQUIRED_FIELDS) {
      if (!(f in p)) throw new Error('[fp.patchManifest] patch[' + i + '] 缺字段 ' + f);
    }
    if (seen.has(p.patchId)) throw new Error('[fp.patchManifest] 重复 patchId ' + p.patchId);
    seen.add(p.patchId);
    if (!RISK_LEVELS.includes(p.riskLevel)) throw new Error('[fp.patchManifest] ' + p.patchId + ' 非法 riskLevel ' + p.riskLevel);
    if (!Array.isArray(p.sourceFiles) || !p.sourceFiles.length) throw new Error('[fp.patchManifest] ' + p.patchId + ' sourceFiles 必须非空');
    if (!Array.isArray(p.sourceSymbols) || !p.sourceSymbols.length) throw new Error('[fp.patchManifest] ' + p.patchId + ' sourceSymbols 必须非空');
  });
  for (const p of patches || []) {
    for (const dep of p.dependencies) {
      if (!seen.has(dep)) throw new Error('[fp.patchManifest] ' + p.patchId + ' 依赖不存在的 patch ' + dep);
    }
  }
  return true;
}

validateManifest(PATCHES);

function getPatch(patchId) {
  const p = PATCHES.find((x) => x.patchId === patchId);
  if (!p) throw new Error('[fp.patchManifest] 未知 patch ' + patchId);
  return p;
}

// 行为接线判定（browserManager/nativeOwnership 消费）：
//   - 正式激活唯一来源 = manifest.enabled（§18：双回归全通过后才翻转）
//   - 显式测试通道 = FPB_FORCE_ACTIVE_PATCHES=<patchId[,patchId...]>，仅供 N-PV
//     让位矩阵在 manifest 仍 PLANNED 时驱动行为接线；生产环境禁止设置该 env，
//     每次命中都会 console.warn 留痕（不允许 silent fallback）。
function isPatchActive(patchId) {
  const p = getPatch(patchId);
  if (p.enabled) return true;
  const forced = String(process.env.FPB_FORCE_ACTIVE_PATCHES || '');
  if (forced.split(',').map((s) => s.trim()).filter(Boolean).includes(patchId)) {
    console.warn('[fp.patchManifest] TEST-CHANNEL forced active: ' + patchId + ' (FPB_FORCE_ACTIVE_PATCHES)');
    return true;
  }
  return false;
}

// 拓扑序（依赖优先）返回 enabled patches —— 供 apply 顺序与 rebase 顺序消费
function enabledPatchesInDependencyOrder() {
  const out = [];
  const visit = (p, stack) => {
    if (out.includes(p) || stack.includes(p)) return;
    for (const dep of p.dependencies) {
      const d = getPatch(dep);
      if (d.enabled) visit(d, stack.concat(p));
    }
    if (p.enabled) out.push(p);
  };
  for (const p of PATCHES) visit(p, []);
  return out;
}

module.exports = { RISK_LEVELS, PATCHES, REQUIRED_FIELDS, validateManifest, getPatch, isPatchActive, enabledPatchesInDependencyOrder };
