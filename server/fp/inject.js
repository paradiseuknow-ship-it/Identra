'use strict';

// 生成注入到每个页面（addScriptToEvaluateOnNewDocument）的 JS 字符串。
// 在页面任何脚本运行前执行，覆盖指纹相关 API。fp 为已生成的指纹对象。
function buildInjectionScript(fp) {
  const cfg = JSON.stringify(fp);
  return `(function(){
  const FP = ${cfg};
  const NOISE = FP.noiseSeed || 0;
  // Phase 16-B ownership（§14 §17）：Native patch 持有的 surface 集合（由 launcher 经
  // fp._nativeOwned 注入，来自 nativeOwnership.nativeOwnedSurfaces()）。JS hook 对
  // NATIVE_OWNED surface 自动让位，杜绝「Native + JS 双重覆盖」；默认空集 = 全部 JS_OWNED，
  // 行为与 16-B 之前逐字节等价。
  const NATIVE_OWNED_SET = new Set(Array.isArray(FP._nativeOwned) ? FP._nativeOwned : []);

  function rng(seed){
    let a = seed >>> 0;
    return function(){
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const r = rng(NOISE + 1);
  const r2 = rng(NOISE + 2);

  // 把任意注入函数的 toString 伪造成 native code，对抗 chrome.csi.toString() 等源泄露检测。
  // STEP 23（CAP 嗅探特征消隐）：toString 必须保留函数名——原生格式是
  // 「function getContext() { [native code] }」，此前无名的「function () { [native code] }」
  // 本身就是可嗅探痕迹（真实原生函数均有名字）。
  // 注意：V8 对「obj.prop = function(){}」不做函数名推断（实测 name=''），因此必须
  // 在调用点显式传入原生函数名（explicitName），否则洗白结果仍是匿名格式。
  function whiten(obj, explicitName){
    if (!obj) return;
    if (typeof obj === 'function') {
      try {
        const n = obj.name || explicitName || '';
        Object.defineProperty(obj, 'toString', { value: () => 'function ' + n + '() { [native code] }', configurable: true });
      } catch (e) {}
      return;
    }
    if (typeof obj !== 'object') return;
    for (const k of Object.getOwnPropertyNames(obj)) {
      try {
        const v = obj[k];
        if (typeof v === 'function') Object.defineProperty(v, 'toString', { value: () => 'function ' + (v.name || k) + '() { [native code] }', configurable: true });
        else if (v && typeof v === 'object') whiten(v);
      } catch (e) {}
    }
  }
  // STEP 23：把 accessor getter 的 toString 洗白为原生格式「function get <key>() { [native code] }」，
  // 使 Object.getOwnPropertyDescriptor(...).get.toString() 与原生完全一致。
  function whitenGetter(obj, key){
    try {
      const d = Object.getOwnPropertyDescriptor(obj, key);
      if (d && typeof d.get === 'function') {
        Object.defineProperty(d.get, 'toString', { value: () => 'function get ' + key + '() { [native code] }', configurable: true });
      }
    } catch (e) {}
  }

  // ---- navigator 基础属性 ----
  // STEP 23（CAP 嗅探特征消隐）：覆盖必须落在 Navigator.prototype 上——真实 Chrome 的
  // userAgent/platform/vendor/... 描述符在【原型】上（proto:native-get），此前在实例上
  // own 定义导致 Object.getOwnPropertyDescriptor(navigator, k) 返回注入描述符
  // （原生返回 undefined），描述符位置迁移本身就是可嗅探痕迹（Pixelscan Browser 卡
  // 多浏览器特征签名的候选源）。同时每个 getter 的 toString 洗白为原生格式。
  try {
    const NP = (typeof Navigator !== 'undefined') ? Navigator.prototype : navigator;
    const nativeEnumerable = (key) => {
      try {
        const d = Object.getOwnPropertyDescriptor(Navigator.prototype, key) || Object.getOwnPropertyDescriptor(navigator, key);
        return d ? !!d.enumerable : false;
      } catch (e) { return false; }
    };
    const defNav = (key, getter) => {
      Object.defineProperty(NP, key, { get: getter, configurable: true, enumerable: nativeEnumerable(key) });
      whitenGetter(NP, key);
    };
    defNav('userAgent', () => FP.userAgent);
    // Phase 16-B C3（navigator-identity）：platform 为 NATIVE_OWNED 时 JS 完全让位
    // —— 不在 navigator 实例上创建 own property，原生 Navigator.prototype getter
    // 生效；patched 二进制下原生 NavigatorBase::platform() 即 identity
    // （--fp-platform switch，window/Worker/iframe 同 renderer 进程天然同源）。
    // own descriptor 缺席性同时构成 JS 注入 vs 原生的判别依据（N-NAV-06）。
    // gate 未开（stock 二进制 / manifest 未 flip）：保持 JS 生产 FP.platform
    // 既有行为逐字节不变。
    if (!NATIVE_OWNED_SET.has('navigator.platform')) {
      defNav('platform', () => FP.platform);
    }
    defNav('vendor', () => FP.vendor);
    defNav('language', () => FP.language);
    defNav('languages', () => FP.languages.slice());
    // Phase 16-B C4（hardwareConcurrency-identity）：hardwareConcurrency 为
    // NATIVE_OWNED 时 JS 完全让位（同 C3 platform 让位模式）—— 原生
    // NavigatorBase::hardwareConcurrency() 即 identity（--fp-hardware-concurrency
    // switch，window/Worker/iframe 同 renderer 进程天然同源）。own descriptor
    // 缺席性构成 JS 注入 vs 原生的判别依据（N-HC 矩阵）。gate 未开：保持 JS
    // 生产 FP.hardwareConcurrency 既有行为逐字节不变。
    if (!NATIVE_OWNED_SET.has('navigator.hardwareConcurrency')) {
      defNav('hardwareConcurrency', () => FP.hardwareConcurrency);
    }
    // Phase 16-B C5（deviceMemory-identity）：deviceMemory 为 NATIVE_OWNED 时
    // JS 完全让位（同 C3/C4 让位模式）—— 原生 NavigatorDeviceMemory::deviceMemory()
    // 即 identity（--fp-device-memory switch，白名单 = Chromium 真实输出域
    // {1,2,4,8,16,32}，window/Worker 天然同源）。own descriptor 缺席性构成
    // JS 注入 vs 原生的判别依据（N-DM 矩阵）。gate 未开：保持 JS 生产
    // FP.deviceMemory 既有行为逐字节不变。
    if (!NATIVE_OWNED_SET.has('navigator.deviceMemory')) {
      defNav('deviceMemory', () => FP.deviceMemory);
    }
    // navigator.webdriver 伪造：真实浏览器在 Navigator.prototype 上以【不可枚举 getter】定义(返回 false)。
    // 错误的做法是 delete 原型后在实例上重定义——这会让
    // Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver') 变为 undefined，
    // 与真实浏览器不一致，被 creepjs / fingerprintjs 等高级检测识破（"原型链说谎"权重极低，直接高强度验证）。
    // 正确做法：直接在 Navigator.prototype 上以 getter 返回 false，保持原型描述符存在，与真实 Chrome 完全一致。
    try {
      if (typeof Navigator !== 'undefined') {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get: () => false,
          configurable: true,
          enumerable: false,
        });
        // 把 getter 的 toString 洗白为 native code，避免 "() => false" 暴露非原生实现。
        const wdDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
        if (wdDesc && typeof wdDesc.get === 'function') whiten(wdDesc.get);
      }
    } catch (e) {}
    // Phase 16-B C6（maxTouchPoints-identity）：maxTouchPoints 为 NATIVE_OWNED 时
    // JS 完全让位（同 C3/C4/C5 让位模式）—— 原生 NavigatorEvents::maxTouchPoints()
    // 即 identity（--fp-max-touch-points switch，白名单 = 真实输出域 {0,5,10}）。
    // own descriptor 缺席性构成 JS 注入 vs 原生的判别依据（N-MT 矩阵）。
    // gate 未开：保持 JS 生产 FP.os 派生值既有行为逐字节不变。
    if (!NATIVE_OWNED_SET.has('navigator.maxTouchPoints')) {
      defNav('maxTouchPoints', () => (FP.os === 'Android' || FP.os === 'iOS' ? 5 : 0));
    }
    if (FP.doNotTrack !== null) defNav('doNotTrack', () => FP.doNotTrack ? '1' : '0');
    // STEP 23：移除 navigator.deviceName / navigator.macAddress 注入——真实 Chrome 根本
    // 没有这两个属性（'deviceName' in navigator === false），主动添加非原生属性本身就是
    // 可嗅探痕迹。fp 数据模型中的 deviceName/mac 字段保留（integrity/模板契约不变），
    // 只是不再暴露到页面 navigator 上。
  } catch(e){}

  // ---- navigator.userAgentData（User-Agent Client Hints）----
  // 仅改 navigator.userAgent 字符串不够：headless 模式下 navigator.userAgentData.brands 会暴露
  // "HeadlessChrome"，且 platform / uaFullVersion / fullVersionList 均可能与伪造的 UA 不一致。
  // 必须同步覆盖，使 brands/platform/version 与 UA 完全对齐，掐灭无头特征。
  //
  // P4.2：brands 唯一事实源 = 浏览器原生运行时（native browser value is the source of truth）。
  // 优先回放 Node 侧在注入前捕获的原生 brands（FP._uaBrands，与 HTTP 层 setUserAgentOverride
  // 逐字节同源）；无捕获时在 init 期直接读原生 navigator.userAgentData（init script 早于任何
  // 页面脚本运行，此刻原生值尚未被覆盖）。两者都不可得（如 about:blank 无 UA-CH）则不覆盖，
  // 保持浏览器原生——绝不硬编码 GREASE 字符串/版本表（Chrome 153+ 变更时自动跟随原生值，
  // 见 .benchmark/step19_drift_probe.json 漂移取证）。
  try {
    const uaVer = (function(){ const p = FP.userAgent.split('Chrome/')[1]; if (!p) return '151.0.0.0'; return p.split(' ')[0] || '151.0.0.0'; })();
    const osPlatform = (FP.os === 'Windows' ? 'Windows'
      : (FP.os === 'macOS' || FP.os === 'Mac') ? 'macOS'
      : FP.os === 'Linux' ? 'Linux'
      : FP.os === 'Android' ? 'Android'
      : FP.os === 'iOS' ? 'iOS' : 'Windows');
    let brands = null;
    try {
      if (FP._uaBrands && FP._uaBrands.length) {
        brands = FP._uaBrands.map((b) => ({ brand: String(b.brand), version: String(b.version) }));
      } else if (typeof navigator !== 'undefined' && navigator.userAgentData
        && Array.isArray(navigator.userAgentData.brands) && navigator.userAgentData.brands.length) {
        brands = Array.from(navigator.userAgentData.brands).map((b) => ({
          // 既有产品契约：无头二进制原生 brands 中的 HeadlessChrome 呈现为 Google Chrome，
          // 其余 brand/顺序/数量/版本逐项保留，不做任何其他替换。
          brand: (b.brand === 'HeadlessChrome') ? 'Google Chrome' : String(b.brand),
          version: String(b.version),
        }));
      }
    } catch (e) { brands = null; }
    if (brands) {
      const nativeUaDataRef = (typeof navigator !== 'undefined' && navigator.userAgentData) ? navigator.userAgentData : null;
      const fullVersionList = (FP._uaFullVersionList && FP._uaFullVersionList.length)
        ? FP._uaFullVersionList.map((b) => ({ brand: String(b.brand), version: String(b.version) }))
        : brands.map((b) => ({ brand: b.brand, version: /^\d+$/.test(b.version) ? b.version + '.0.0.0' : b.version }));
      const Ctor = (typeof NavigatorUAData !== 'undefined') ? NavigatorUAData : null;
      const uaDataObj = Ctor ? Object.create(Ctor.prototype) : {};
      Object.defineProperty(uaDataObj, 'brands', { get: () => brands.slice() });
      Object.defineProperty(uaDataObj, 'mobile', { get: () => false });
      Object.defineProperty(uaDataObj, 'platform', { get: () => osPlatform });
      whitenGetter(uaDataObj, 'brands');
      whitenGetter(uaDataObj, 'mobile');
      whitenGetter(uaDataObj, 'platform');
      uaDataObj.getHighEntropyValues = function(hints) {
        // Phase 16-B C2（platformversion-identity）：platformVersion 为 NATIVE_OWNED 时
        // JS 不再生产该值（让位），改为从原生 userAgentData 回读——CDP override 缺省时
        // emulation 层 merge 回退到 patched 原生值（=identity），无 override 时原生
        // metadata 本身即 identity。原生值缺失时保留空串（诚实透传原生，不伪造、
        // 不静默 fallback 到错误 identity）。C2 inactive：保持既有 '15.0.0' 行为。
        const pvNativeOwned = NATIVE_OWNED_SET.has('navigator.userAgentData.platformVersion');
        const base = {
          brands: brands.slice(),
          mobile: false,
          platform: osPlatform,
          platformVersion: pvNativeOwned ? '' : '15.0.0',
          architecture: 'x86',
          bitness: '64',
          model: '',
          uaFullVersion: uaVer,
          fullVersionList: fullVersionList.slice(),
        };
        // fullVersionList 优先取原生值（CDP override 之后原生即回放值，仍与 brands 同源）
        let nativeHev = null;
        try {
          if (nativeUaDataRef && typeof nativeUaDataRef.getHighEntropyValues === 'function') {
            nativeHev = nativeUaDataRef.getHighEntropyValues(pvNativeOwned
              ? ['fullVersionList', 'platformVersion']
              : ['fullVersionList']);
          }
        } catch (e) {}
        return Promise.resolve(nativeHev).then((nv) => {
          try {
            if (nv && Array.isArray(nv.fullVersionList) && nv.fullVersionList.length) {
              base.fullVersionList = nv.fullVersionList.map((b) => ({
                brand: (b.brand === 'HeadlessChrome') ? 'Google Chrome' : String(b.brand),
                version: String(b.version),
              }));
            }
            if (pvNativeOwned && nv && typeof nv.platformVersion === 'string' && nv.platformVersion) {
              base.platformVersion = nv.platformVersion;
            }
          } catch (e) {}
          return base;
        });
      };
      whiten(uaDataObj.getHighEntropyValues, 'getHighEntropyValues');
      // userAgentData 描述符放在 Navigator.prototype（原生在原型上），避免实例 own 描述符泄露注入痕迹。
      const NP2 = (typeof Navigator !== 'undefined') ? Navigator.prototype : navigator;
      Object.defineProperty(NP2, 'userAgentData', { get: () => uaDataObj, configurable: true });
      whitenGetter(NP2, 'userAgentData');
    }
    // brands 不可得（原生缺失且无捕获回放）→ 不覆盖 userAgentData，保持浏览器原生双层同源。
  } catch(e){}

  // STEP 23：navigator.deviceName / navigator.macAddress 注入已移除——真实 Chrome 没有这两个
  // 属性，主动添加非原生属性本身就是可嗅探痕迹（fp 数据模型字段保留，见上方 navigator 块注释）。

  // ---- 伪装 plugins / mimeTypes（二者必须一致，否则被识别为自动化） ----
  try {
    const ITER = (typeof Symbol !== 'undefined' && Symbol.iterator) ? Symbol.iterator : '__iter';
    // STEP 23（关键修复）：插件清单现代化——此前是 Chrome ~90 时代的三个老插件
    // （Chrome PDF Plugin / Chrome PDF Viewer / Native Client），真实 Chrome 151 报告
    // 五个 PDF Viewer 系列插件。过时清单正是 Pixelscan「多浏览器特征签名 Chrome-22-28」
    // 古老特征的头号嫌疑源（对照组实证：原生为 5 插件清单）。
    // STEP 19 证据归因审计（B 类修复）：原生 Chrome 151 每个 PDF 插件 length=2
    // （application/pdf + text/pdf），navigator.mimeTypes 仅 2 条**共享实例**
    // （enabledPlugin 均指首个插件 'PDF Viewer'）。此前每插件独立 1 个 mimeType →
    // navigator.mimeTypes.length=5，与原生 2 不符（3 模式对照实测）。
    const MIME_DEFS = [
      { type: 'application/pdf', description: 'Portable Document Format', suffixes: 'pdf' },
      { type: 'text/pdf', description: 'Portable Document Format', suffixes: 'pdf' },
    ];
    const PLUGIN_NAMES = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
    const PLUGINS = PLUGIN_NAMES.map((name) => ({
      name, description: 'Portable Document Format', filename: 'internal-pdf-viewer',
      mimeTypes: MIME_DEFS,
    }));
    const PluginCtor = window.Plugin;
    const MimeTypeCtor = window.MimeType;
    const PluginArrayCtor = window.PluginArray;
    const MimeTypeArrayCtor = window.MimeTypeArray;

    // STEP 19 审计（B 类）：同 type 的 MimeType 必须是**共享实例**（原生 Chrome 实证
    // plugins[i].mimeTypes[0] === navigator.mimeTypes[0] 对所有 PDF 插件成立）。
    const sharedMime = {};
    function makeMimeType(m, owner) {
      if (sharedMime[m.type]) return sharedMime[m.type];
      const mt = MimeTypeCtor ? Object.create(MimeTypeCtor.prototype) : {};
      Object.defineProperties(mt, {
        type: { value: m.type },
        description: { value: m.description || '' },
        suffixes: { value: m.suffixes || '' },
        enabledPlugin: { value: owner, configurable: true },
      });
      sharedMime[m.type] = mt;
      return mt;
    }

    function makePlugin(p) {
      const inst = PluginCtor ? Object.create(PluginCtor.prototype) : {};
      const mts = p.mimeTypes.map((m) => makeMimeType(m, inst));
      const mtArr = MimeTypeArrayCtor ? Object.create(MimeTypeArrayCtor.prototype) : {};
      Object.defineProperties(mtArr, {
        length: { value: mts.length },
        item: { value: (i) => mtArr[i] || null },
        namedItem: { value: (n) => mts.find((x) => x.type === n) || null },
        [ITER]: { value: function*() { for (const x of mts) yield x; } },
      });
      Object.defineProperties(inst, {
        name: { value: p.name },
        description: { value: p.description || '' },
        filename: { value: p.filename || '' },
        length: { value: mts.length },
        item: { value: (i) => mts[i] || null },
        namedItem: { value: (n) => mts.find((x) => x.type === n) || null },
        mimeTypes: { value: mtArr, configurable: true },
        [ITER]: { value: function*() { for (const x of mts) yield x; } },
      });
      mts.forEach((mt, j) => { try { Object.defineProperty(mtArr, j, { value: mt, enumerable: false, configurable: true }); } catch (e) {} }); // 支持 navigator.plugins[i].mimeTypes[j] 方括号访问（不可枚举，对齐真实 PluginArray）
      return { inst, mts };
    }

    const built = PLUGINS.map(makePlugin);
    const allMimeTypes = [];
    // STEP 19 审计（B 类）：enabledPlugin 只归首个遭遇该 mimeType 的插件（原生指 'PDF Viewer'）；
    // allMimeTypes 共享实例去重 → navigator.mimeTypes.length = 2 与原生一致。
    const epAssigned = new Set();
    built.forEach(({ inst, mts }) => mts.forEach((mt) => {
      try { if (!epAssigned.has(mt)) { Object.defineProperty(mt, 'enabledPlugin', { value: inst, configurable: true }); epAssigned.add(mt); } } catch (e) {}
      if (!allMimeTypes.includes(mt)) allMimeTypes.push(mt);
    }));

    const pa = PluginArrayCtor ? Object.create(PluginArrayCtor.prototype) : {};
    Object.defineProperties(pa, {
      length: { value: built.length },
      item: { value: (i) => (built[i] ? built[i].inst : null) },
      namedItem: { value: (n) => { const b = built.find((x) => x.inst.name === n); return b ? b.inst : null; } },
      refresh: { value: function() {} },
      [ITER]: { value: function*() { for (const b of built) yield b.inst; } },
    });
    built.forEach((b, i) => { try { Object.defineProperty(pa, i, { value: b.inst, enumerable: false, configurable: true }); } catch (e) {} }); // 支持 navigator.plugins[i] 方括号访问（不可枚举）
    const NPP = (typeof Navigator !== 'undefined') ? Navigator.prototype : navigator; // STEP 23：描述符迁原型（原生在原型上）
    Object.defineProperty(NPP, 'plugins', { get: () => pa, configurable: true });
    whitenGetter(NPP, 'plugins');

    const ma = MimeTypeArrayCtor ? Object.create(MimeTypeArrayCtor.prototype) : {};
    Object.defineProperties(ma, {
      length: { value: allMimeTypes.length },
      item: { value: (i) => allMimeTypes[i] || null },
      namedItem: { value: (n) => allMimeTypes.find((x) => x.type === n) || null },
      [ITER]: { value: function*() { for (const x of allMimeTypes) yield x; } },
    });
    allMimeTypes.forEach((mt, i) => { try { Object.defineProperty(ma, i, { value: mt, enumerable: false, configurable: true }); } catch (e) {} }); // 支持 navigator.mimeTypes[i] 方括号访问（不可枚举）
    Object.defineProperty(NPP, 'mimeTypes', { get: () => ma, configurable: true });
    whitenGetter(NPP, 'mimeTypes');
  } catch(e){}

  // ---- Notification.permission 与 navigator.permissions.query 一致性 ----
  // 风控会同时读两者：若一个 denied 一个 default 即判定自动化。这里让 query 的结果
  // 始终与 Notification.permission 对齐，二者永不矛盾。
  // STEP 19 证据归因审计（B 类修复）：原生 Chrome 的映射是 default→prompt、
  // granted→granted、denied→denied（对照组实测：default+default 组合在原生不存在）。
  // 此前直接回显 Notification.permission（default→default），本身就是非原生语义痕迹。
  try {
    if (window.Notification && navigator.permissions && navigator.permissions.query) {
      const realQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (descriptor) {
        if (descriptor && descriptor.name === 'notifications' && typeof window.Notification.permission === 'string') {
          const p = window.Notification.permission;
          const nativeState = p === 'default' ? 'prompt' : p; // 原生映射（实测对照组）
          return Promise.resolve({ name: 'notifications', state: nativeState, onchange: null });
        }
        // 非 notifications 查询（含非法 name）交还原生，让其按标准抛出 TypeError，避免假代跑暴露。
        return realQuery(descriptor);
      };
    }
  } catch (e) {}

  // ---- screen ----
  // STEP 23：描述符迁移到 Screen.prototype（原生 screen.* 描述符在原型上，proto:native-get），
  // 实例 own 定义会泄露注入痕迹；getter toString 洗白为原生格式。
  try {
    const s = FP.screen;
    const SP = (typeof Screen !== 'undefined' && Screen.prototype) ? Screen.prototype : screen;
    const defScreen = (key, getter) => {
      Object.defineProperty(SP, key, { get: getter, configurable: true });
      whitenGetter(SP, key);
    };
    defScreen('width', () => s.width);
    defScreen('height', () => s.height);
    defScreen('availWidth', () => s.availWidth);
    defScreen('availHeight', () => s.availHeight);
    defScreen('colorDepth', () => 24);
    defScreen('pixelDepth', () => 24);
  } catch(e){}
  try {
    Object.defineProperty(window, 'devicePixelRatio', { get: () => FP.screen.pixelRatio, configurable: true });
    // STEP 19 修复：outer 必须 >= inner（真实浏览器外框恒包含内容区；fullscreen/F11 下相等）。
    // 此前 outerHeight=availHeight 会在 headless 大视口下出现 outerHeight < innerHeight 的
    // 物理上不可能状态（实证：1040 < 1080），是 CreepJS headless 判分的强信号。
    Object.defineProperty(window, 'outerWidth', { get: () => Math.max(FP.screen.availWidth, window.innerWidth | 0), configurable: true });
    Object.defineProperty(window, 'outerHeight', { get: () => Math.max(FP.screen.availHeight, window.innerHeight | 0), configurable: true });
    // STEP 23：window 尺寸类原生描述符就在实例上（own），位置已对齐，洗白 getter 即可。
    whitenGetter(window, 'devicePixelRatio');
    whitenGetter(window, 'outerWidth');
    whitenGetter(window, 'outerHeight');
  } catch(e){}

  // ---- Notification.permission 合理性（STEP 19）----
  // headless Chromium 恒返回 'denied'（Windows 系统级禁用通知也会如此），而 fresh 身份的
  // 真实 Chrome 只会是 'default'——'denied' 是 CreepJS headless 判据之一。
  // 仅当真实值为 'denied' 时纠正为 'default'（用户显式授权过的 persistent profile 不动）。
  // STEP 23：getter 洗白为原生格式（原生为 own:native-get）。
  try {
    if (window.Notification && window.Notification.permission === 'denied') {
      Object.defineProperty(window.Notification, 'permission', { get: () => 'default', configurable: true });
      whitenGetter(window.Notification, 'permission');
    }
  } catch (e) {}

  // ---- 时区：Playwright 已通过 timezoneId 参数设置原生时区，此处不再 JS 覆盖，避免 Pixelscan 识别为 spoof ----
  // 保留最小兜底：确保 resolvedOptions.timeZone 与 FP.timezone 一致（通常已由 Chromium 设置好）
  try {
    const TZ = FP.timezone;
    const origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function resolvedOptions(...a){
      const opts = origResolved.apply(this, a);
      if (TZ) opts.timeZone = TZ;
      return opts;
    };
    whiten(Intl.DateTimeFormat.prototype.resolvedOptions);
  } catch(e){}

  // ---- 地理位置 ----
  try {
    if (navigator.geolocation && FP.geolocation && FP.geolocation.mode !== 'real') {
      const geo = navigator.geolocation;
      const fakePos = {
        coords: {
          latitude: FP.geolocation.lat,
          longitude: FP.geolocation.lng,
          accuracy: FP.geolocation.accuracy,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      };
      geo.getCurrentPosition = function(success, error, opts){
        if (FP.geolocation.mode === 'block') { if (error) error({ code: 1, message: 'User denied Geolocation' }); return; }
        if (success) setTimeout(() => success(fakePos), 0);
      };
      geo.watchPosition = function(success, error, opts){
        if (FP.geolocation.mode === 'block') { if (error) error({ code: 1, message: 'User denied Geolocation' }); return 0; }
        if (success) setTimeout(() => success(fakePos), 0);
        return Math.floor(Math.random() * 1e9);
      };
      geo.clearWatch = function(id){};
    }
  } catch(e){}

  // ---- Canvas 噪声（稳定 + 极弱 + getImageData/toDataURL/toBlob 一致 + 幂等无二次叠加） ----
  try {
    if (FP.canvas !== false) {
      const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;
      const getContext = HTMLCanvasElement.prototype.getContext;

      // 对 2d 上下文强制 willReadFrequently：使底层使用 CPU 画布，getImageData 返回独立副本，
      // 与画布 backstore 不共享内存（部分 Chromium 引擎下 GPU 画布的 img.data 会别名 backstore，
      // 一旦被改就会「写回原画布」造成噪声二次叠加）。willReadFrequently 仅为性能提示，不影响渲染结果。
      HTMLCanvasElement.prototype.getContext = function(type, attrs){
        const opts = (type === '2d') ? Object.assign({}, attrs, { willReadFrequently: true }) : attrs;
        return getContext.apply(this, [type, opts]);
      };

      // 在 2D 上下文原型上【仅包裹一次】：getContext 每次调用都返回同一 context 实例，
      // 若在 getContext 内重复包裹 getImageData 会造成 wrapper 层层嵌套，每次调用都「再叠一层噪声」，
      // 这正是此前像素逐级衰减（10→8→6→4）的根因。原型级包裹 + 标记位，彻底杜绝嵌套叠加。
      if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.__fpGID) {
        const nativeGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h){
          const img = nativeGetImageData.apply(this, arguments);
          const src = img.data;
          // 复制到独立数组 out，仅对 out 施加噪声，绝不回写画布（画布 backstore 始终干净）。
          const out = new Uint8ClampedArray(src.length);
          out.set(src);
          // 噪声种子 = 原像素采样 + 全局 noiseSeed：同一 canvas 内容 → 同一噪声（跨刷新/跨方法一致）；
          // 不同内容 → 不同噪声。因画布永不写回，src 永远是干净原像素，故每次读取结果恒定一致（幂等）。
          let s = (NOISE + 1) >>> 0;
          for (let i = 0; i < src.length; i += 251) s = (s + src[i] * (i + 1)) >>> 0;
          const rr = rng(s);
          for (let i = 0; i < out.length; i += 4) {
            const n = (rr() * 2 - 1) * 2;
            out[i] = clamp(src[i] + n);
            out[i + 1] = clamp(src[i + 1] + n);
            out[i + 2] = clamp(src[i + 2] + n);
          }
          return new ImageData(out, img.width, img.height);
        };
        CanvasRenderingContext2D.prototype.__fpGID = true;
      }
      if (typeof CanvasRenderingContext2D !== 'undefined') whiten(CanvasRenderingContext2D.prototype.getImageData);

      // toDataURL / toBlob 必须反映同一份噪声，且与 getImageData 完全一致（否则自相矛盾被标记）。
      // 方案：getImageData 已改为「复制后施加噪声、绝不回写画布」（见上），故画布 backstore 始终干净。
      // 这里直接在本画布上：取噪声副本 → 临时铺噪声 → 原生导出 → 立刻还原干净像素。
      // 全程不碰 clone / drawImage（规避部分引擎下 drawImage 或共享 backstore 导致的原画布污染），
      // 且每次导出前画布都是干净的，因此 getImageData / toDataURL / toBlob 任意次数结果恒定一致（幂等、无二次叠加）。
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(...a){
        try {
          if (this.width && this.height) {
            // 关键：原画布「只被读取、绝不被写入」。getImageData 已是 copy-fix（不回写画布），
            // 因此读出的是独立噪声副本；把该副本写到【临时画布】，从临时画布原生导出。
            // 原画布像素始终干净 → getImageData/toDataURL/toBlob 任意次数结果恒定一致（幂等、无二次叠加）。
            const ctx = this.getContext('2d');
            const noised = ctx.getImageData(0, 0, this.width, this.height);   // 独立噪声副本，画布仍干净
            const tmp = document.createElement('canvas');
            tmp.width = this.width; tmp.height = this.height;
            tmp.getContext('2d').putImageData(noised, 0, 0);                  // 噪声写入临时画布
            return origToDataURL.apply(tmp, a);                               // 从临时画布导出（含噪声）
          }
        } catch (e) {}
        return origToDataURL.apply(this, a);
      };
      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      if (origToBlob) {
        HTMLCanvasElement.prototype.toBlob = function(cb, ...a){
          try {
            if (this.width && this.height) {
              const ctx = this.getContext('2d');
              const noised = ctx.getImageData(0, 0, this.width, this.height);
              const tmp = document.createElement('canvas');
              tmp.width = this.width; tmp.height = this.height;
              tmp.getContext('2d').putImageData(noised, 0, 0);
              return origToBlob.call(tmp, cb, ...a);                          // 临时画布异步导出，原画布干净
            }
          } catch (e) {}
          return origToBlob.apply(this, [cb, ...a]);
        };
      }
    }
  } catch(e){}

  // ---- WebGL 伪装 ----
  try {
    const wrapParam = (proto) => {
      const gp = proto.getParameter;
      proto.getParameter = function(p){
        if (p === 37445) return FP.webgl.vendor;
        if (p === 37446) return FP.webgl.renderer;
        if (p === 7936 || p === 0x1F00) return FP.webgl.vendor;
        if (p === 7937 || p === 0x1F01) return FP.webgl.renderer;
        if (p === 0x9245) return FP.webgl.renderer;
        return gp.apply(this, arguments);
      };
      const ge = proto.getExtension;
      proto.getExtension = function(name){
        const ext = ge.apply(this, arguments);
        if (name === 'WEBGL_debug_renderer_info' && !ext) {
          return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
        }
        return ext;
      };
    };
    if (window.WebGLRenderingContext) wrapParam(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) wrapParam(WebGL2RenderingContext.prototype);
  } catch(e){}

  // ---- WebGPU 伪装 ----
  try {
    if (FP.webgpu === 'disable' && navigator.gpu) {
      delete navigator.gpu;
    }
  } catch(e){}

  // ---- AudioContext 噪声 ----
  try {
    if (FP.audioContext !== false && (window.AudioContext || window.webkitAudioContext)) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const origAnalyser = AC.prototype.createAnalyser;
      AC.prototype.createAnalyser = function(){
        const an = origAnalyser.apply(this, arguments);
        const origGetFloat = an.getFloatFrequencyData;
        if (origGetFloat) {
          an.getFloatFrequencyData = function(arr){
            origGetFloat.apply(this, arguments);
            for (let i = 0; i < arr.length; i++) arr[i] += (r() * 2 - 1) * 1e-3;
            return arr;
          };
        }
        return an;
      };
    }
  } catch(e){}

  // ---- ClientRects 噪声 ----
  try {
    if (FP.clientRects !== false) {
      const origGetBounding = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function(){
        const rect = origGetBounding.apply(this, arguments);
        const n = () => (r2() * 2 - 1) * 0.02;
        return {
          x: rect.x + n(), y: rect.y + n(),
          width: rect.width + n(), height: rect.height + n(),
          top: rect.top + n(), left: rect.left + n(),
          right: rect.right + n(), bottom: rect.bottom + n(),
          toJSON: () => ({}),
        };
      };
    }
  } catch(e){}

  // ---- SpeechVoices ----
  try {
    if (FP.speechVoices !== false && window.speechSynthesis) {
      const origGetVoices = window.speechSynthesis.getVoices;
      window.speechSynthesis.getVoices = function(){
        const list = origGetVoices ? origGetVoices.apply(this, arguments) : [];
        return list.length ? list : [
          { name: 'Microsoft David - English (United States)', lang: 'en-US', default: true, localService: true, voiceURI: 'urn:moz-tts:sapi:Microsoft David - English (United States)?en-US' },
          { name: 'Microsoft Zira - English (United States)', lang: 'en-US', default: false, localService: true, voiceURI: 'urn:moz-tts:sapi:Microsoft Zira - English (United States)?en-US' },
        ];
      };
    }
  } catch(e){}

  // ---- MediaDevices 枚举 ----
  try {
    if (FP.mediaDevices !== false && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const origEnum = navigator.mediaDevices.enumerateDevices;
      navigator.mediaDevices.enumerateDevices = function(){
        return Promise.resolve([
          { deviceId: 'default', kind: 'audioinput', label: '默认 - 麦克风 (Realtek(R) Audio)', groupId: 'mic' },
          { deviceId: 'default', kind: 'audiooutput', label: '默认 - 扬声器 (Realtek(R) Audio)', groupId: 'spk' },
          { deviceId: Math.random().toString(36).slice(2), kind: 'videoinput', label: 'Integrated Webcam', groupId: 'cam' },
        ]);
      };
    }
  } catch(e){}

  // ---- WebRTC 控制 ----
  try {
    const mode = FP.webRtc;
    const publicIp = FP.webRtcPublicIp;
    const RealRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (RealRTCPeerConnection && mode !== 'real') {
      // replace-udp 但拿不到公网 IP 时退化为 disable，避免泄漏本地 IP
      const effectiveMode = (mode === 'replace-udp' && !publicIp) ? 'disable' : mode;

      // 改写单条 candidate 字符串（按 SDP 空格分词处理，避免正则词边界异常）
      const rewriteCandidate = (candStr) => {
        if (!candStr) return candStr;
        // 其它模式：剥离 host 候选（内网 IP）与 mDNS 候选（.local 泄露主机名）
        if (effectiveMode !== 'replace-udp') {
          if (/typ host/.test(candStr) || /\.local\b/.test(candStr)) return null;
          return candStr;
        }
        // replace-udp：地址(第5个 token)改写为出口公网 IP，host 类型伪装为 srflx，
        // 并移除 headless 的 network-cost 999 自动化特征
        const tokens = candStr.split(' ');
        if (tokens.length > 4 && publicIp) tokens[4] = publicIp; // 地址字段
        if (tokens[6] === 'typ' && tokens[7]) {
          if (tokens[7] === 'host' || tokens[7] === 'srflx' || tokens[7] === 'prflx') {
            tokens[7] = 'srflx';
          }
        }
        const out = [];
        for (let i = 0; i < tokens.length; i++) {
          if (tokens[i] === 'network-cost') { i++; continue; } // 跳过 network-cost 及其数值
          out.push(tokens[i]);
        }
        return out.join(' ');
      };

      // 把一个 candidate 对象过滤/改写；返回 null 表示丢弃
      const filterCandidateObj = (cand) => {
        if (!cand || !cand.candidate) return cand; // null candidate（收集结束）原样透传
        const rewritten = rewriteCandidate(cand.candidate);
        if (rewritten === null) return null;
        try {
          return new RTCIceCandidate(Object.assign({}, cand, { candidate: rewritten }));
        } catch (e) {
          return new RTCIceCandidate({ candidate: rewritten, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex });
        }
      };

      // 包装候选事件回调：修改候选后再交给站点。
      // RTCIceCandidateEvent.candidate 是只读 getter，无法直接改写，故用合成对象传入。
      const wrapCandidateHandler = (origFn) => function (evt) {
        const c = evt && evt.candidate;
        const filtered = filterCandidateObj(c);
        if (filtered === null) {
          return origFn.call(this, { type: 'icecandidate', candidate: null });
        }
        return origFn.call(this, { type: 'icecandidate', candidate: filtered });
      };

      const Wrapped = function (config) {
        if (effectiveMode === 'disable') {
          throw new DOMException('WebRTC is disabled', 'NotAllowedError');
        }
        const cfg = Object.assign({}, config || {});
        // proxy/forward 模式：强制 relay 并加 STUN，避免本地内网 IP 作为 host 候选出现。
        // replace-udp 模式：正常收集候选（含 STUN 反射），随后把所有 IP 改写为出口公网 IP。
        if (effectiveMode === 'proxy' || effectiveMode === 'forward') {
          cfg.iceServers = cfg.iceServers && cfg.iceServers.length
            ? cfg.iceServers
            : [{ urls: 'stun:stun.l.google.com:19302' }];
          cfg.iceTransportPolicy = 'relay';
        } else if (effectiveMode === 'replace-udp') {
          cfg.iceServers = cfg.iceServers && cfg.iceServers.length
            ? cfg.iceServers
            : [{ urls: 'stun:stun.l.google.com:19302' }];
        }
        const pc = new RealRTCPeerConnection(cfg);

        // 拦截 onicecandidate 赋值
        try {
          const nativeDesc = Object.getOwnPropertyDescriptor(RealRTCPeerConnection.prototype, 'onicecandidate');
          let userHandler = null;
          Object.defineProperty(pc, 'onicecandidate', {
            configurable: true,
            get() { return userHandler; },
            set(fn) {
              userHandler = (typeof fn === 'function') ? wrapCandidateHandler(fn) : fn;
              if (nativeDesc) nativeDesc.set.call(pc, userHandler);
            },
          });
        } catch (e) {}

        // 拦截 addEventListener('icecandidate')
        const origAddEvt = pc.addEventListener;
        pc.addEventListener = function (type, listener, opts) {
          if (type === 'icecandidate' && typeof listener === 'function') {
            return origAddEvt.call(this, type, wrapCandidateHandler(listener), opts);
          }
          return origAddEvt.call(this, type, listener, opts);
        };

        // 兜底：部分 API 仍会通过 addIceCandidate 注入候选
        const origAdd = pc.addIceCandidate;
        pc.addIceCandidate = function (cand) {
          if (!cand || !cand.candidate) return origAdd ? origAdd.apply(this, arguments) : Promise.resolve();
          const c = cand.candidate;
          if (effectiveMode !== 'replace-udp' && (/typ host/.test(c) || /\.local\b/.test(c))) {
            return Promise.resolve();
          }
          if (effectiveMode === 'replace-udp' && publicIp) {
            cand.candidate = rewriteCandidate(c);
            if (cand.address) cand.address = publicIp;
            if (cand.relatedAddress) cand.relatedAddress = publicIp;
          }
          return origAdd ? origAdd.apply(this, arguments) : Promise.resolve();
        };
        return pc;
      };
      Wrapped.prototype = RealRTCPeerConnection.prototype;
      window.RTCPeerConnection = Wrapped;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;

      // 禁用 getUserMedia 进一步避免本地音视频指纹
      if (effectiveMode === 'disable' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia = function () {
          return Promise.reject(new DOMException('getUserMedia disabled', 'NotAllowedError'));
        };
      }
    }
  } catch (e) {}

  // ---- fonts 身份消费（Phase 16-B §29 止血）----
  // 缺口（Phase 16-A 审计发现 #2）：fp.fonts 生成后从未被任何页面 API 消费——字体探测
  // 主 API document.fonts.check 一直反映宿主机真实字体，与 identity 无关。
  // 本修复让特定字族可用性由 identity 驱动：FP.fonts 列表内 → 可用，不在 → 不可用；
  // 通用字族（serif/monospace 等）与解析失败路径交还原生（fail-open，不改变通用族语义）。
  // STEP 23 纪律：覆盖落在 FontFaceSet.prototype（原生描述符位置，避免实例 own 描述符泄露），
  // 覆盖函数为具名函数 check 并洗白 toString 为原生格式。
  try {
    if (!NATIVE_OWNED_SET.has('fonts.check') && Array.isArray(FP.fonts) && FP.fonts.length && typeof FontFaceSet !== 'undefined' && typeof FontFaceSet.prototype.check === 'function') {
      const FONT_SET = new Set(FP.fonts.map(function (f) { return String(f).trim().toLowerCase(); }));
      const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'fangsong', 'emoji']);
      const nativeCheck = FontFaceSet.prototype.check;
      // 从 font shorthand 截取 size 之后的 family 列表（'italic bold 12px/1.5 "A", B' → '"A", B'）。
      // 注意：本函数整体位于 buildInjectionScript 的模板字面量内，反斜杠必须双份
      //（单份会被模板吞掉 → 整个注入脚本 Invalid regular expression → 全部 hook 未安装）。
      const familyList = (fontStr) => {
        const m = fontStr.match(/(?:^|\\s)\\S*[\\d.]+(?:px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|q|cm|mm|in)(?:\\s*\\/\\s*\\S+)?\\s+([\\s\\S]+)$/i);
        return m ? m[1] : fontStr;
      };
      const stripQuotes = (s) => s.replace(/^["']+|["']+$/g, '').trim();
      FontFaceSet.prototype.check = function check(font, text) {
        try {
          if (typeof font !== 'string' || !font) return nativeCheck.apply(this, arguments);
          // 空 text 探测：原生对任意字族恒返回 true（spec quirk）。保持与原生逐字节一致
          //（返回 false 会制造与原生不同的行为面），identity 判定仅在真实文本探测时生效。
          if (text === undefined || text === null || text === '') return nativeCheck.apply(this, arguments);
          const fams = familyList(font).split(',').map(stripQuotes).filter(Boolean);
          if (!fams.length) return nativeCheck.apply(this, arguments);
          const resolved = fams.map((f) => f.toLowerCase());
          // 仅通用字族 → 原生判定；含特定字族 → 全部命中 identity 列表才可用（identity 驱动）。
          if (resolved.every((f) => GENERIC_FAMILIES.has(f))) return nativeCheck.apply(this, arguments);
          return resolved.every((f) => GENERIC_FAMILIES.has(f) || FONT_SET.has(f));
        } catch (e) {
          return nativeCheck.apply(this, arguments);
        }
      };
      whiten(FontFaceSet.prototype.check, 'check');
    }
    // FP.fonts 缺失/为空 → 不覆盖，保持浏览器原生（与 brands 双缺不覆盖契约一致）。
  } catch (e) {}

  // ---- 关闭自动化特征 / 补齐浏览器对象 ----
  // STEP 23：移除 chrome.runtime / chrome.webstore 注入——真实系统 Chrome 151（headful/hidden-
  // headful）的 window.chrome 只有 loadTimes/csi/app 三个键（对照组实证），多余的 runtime/webstore
  // mock 对象（getManifest 返回 {} 等）本身就是深度遍历型检测（Akamai/Cloudflare）的强痕迹。
  // 旧注释场景（headless 补齐）已由 hidden-headful 模式（真实 Chrome 进程）取代。
  try {
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.app) window.chrome.app = {
      isInstalled: false,
      getIsInstalled: function () { return false; },
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    };
    if (!window.chrome.csi) window.chrome.csi = function () {
      // 真实返回值形如 { totalTime, onloadT, startE, startL, adp }
      return { totalTime: 0, onloadT: 0, startE: Date.now(), startL: Date.now(), adp: false };
    };
      if (!window.chrome.loadTimes) window.chrome.loadTimes = function () {
        // 真实返回值含 requestTime/startTime/commitLoadTime/connectionInfo 等
        const t = Date.now() / 1000;
        return {
          requestTime: t - 0.6, startTime: t - 0.6, commitLoadTime: t - 0.5,
          redirectStart: 0, redirectEnd: 0, finishDocumentLoadTime: t - 0.2, finishLoadTime: t,
          navigationType: 'Other', npn: true, connectionInfo: 'h2', connectionInfoString: 'h2',
          firstPaintTime: t - 0.4, firstPaintAfterLoadTime: 0,
        };
      };
  } catch(e){}

  // ---- 统一洗白所有注入函数的 toString：对抗 chrome.csi.toString() / 原型方法源码泄露 / permissions.query.toString() ----
  // STEP 23：覆盖面补齐——geo / mediaDevices / speechSynthesis 的覆盖函数此前未纳入洗白
  // （diff 实证 fn.geo.getCurrentPosition / fn.media.enumerateDevices / fn.media.getUserMedia /
  // fn.speech.getVoices toString 直接暴露注入源码）。
  try {
    whiten(window.chrome);
    if (navigator.permissions && navigator.permissions.query) whiten(navigator.permissions.query, 'query');
    if (HTMLCanvasElement.prototype.getContext) whiten(HTMLCanvasElement.prototype.getContext, 'getContext');
    if (HTMLCanvasElement.prototype.toDataURL) whiten(HTMLCanvasElement.prototype.toDataURL, 'toDataURL');
    if (HTMLCanvasElement.prototype.toBlob) whiten(HTMLCanvasElement.prototype.toBlob, 'toBlob');
    if (Element.prototype.getBoundingClientRect) whiten(Element.prototype.getBoundingClientRect, 'getBoundingClientRect');
    if (window.AudioContext && window.AudioContext.prototype.createAnalyser) whiten(window.AudioContext.prototype.createAnalyser, 'createAnalyser');
    if (window.WebGLRenderingContext) { whiten(WebGLRenderingContext.prototype.getParameter, 'getParameter'); whiten(WebGLRenderingContext.prototype.getExtension, 'getExtension'); }
    if (window.WebGL2RenderingContext) { whiten(WebGL2RenderingContext.prototype.getParameter, 'getParameter'); whiten(WebGL2RenderingContext.prototype.getExtension, 'getExtension'); }
    if (window.RTCPeerConnection) whiten(window.RTCPeerConnection, 'RTCPeerConnection');
    if (navigator.geolocation && navigator.geolocation.getCurrentPosition) whiten(navigator.geolocation.getCurrentPosition, 'getCurrentPosition');
    if (navigator.geolocation && navigator.geolocation.watchPosition) whiten(navigator.geolocation.watchPosition, 'watchPosition');
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) whiten(navigator.mediaDevices.enumerateDevices, 'enumerateDevices');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) whiten(navigator.mediaDevices.getUserMedia, 'getUserMedia');
    if (window.speechSynthesis && window.speechSynthesis.getVoices) whiten(window.speechSynthesis.getVoices, 'getVoices');
  } catch (e) {}
})();`;
}

module.exports = { buildInjectionScript };
