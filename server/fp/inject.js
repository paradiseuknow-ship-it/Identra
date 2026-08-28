'use strict';

// 生成注入到每个页面（addScriptToEvaluateOnNewDocument）的 JS 字符串。
// 在页面任何脚本运行前执行，覆盖指纹相关 API。fp 为已生成的指纹对象。
function buildInjectionScript(fp) {
  const cfg = JSON.stringify(fp);
  return `(function(){
  const FP = ${cfg};
  const NOISE = FP.noiseSeed || 0;

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
  function whiten(obj){
    if (!obj) return;
    if (typeof obj === 'function') {
      try { Object.defineProperty(obj, 'toString', { value: () => 'function () { [native code] }', configurable: true }); } catch (e) {}
      return;
    }
    if (typeof obj !== 'object') return;
    for (const k of Object.getOwnPropertyNames(obj)) {
      try {
        const v = obj[k];
        if (typeof v === 'function') Object.defineProperty(v, 'toString', { value: () => 'function () { [native code] }', configurable: true });
        else if (v && typeof v === 'object') whiten(v);
      } catch (e) {}
    }
  }

  // ---- navigator 基础属性 ----
  try {
    Object.defineProperty(navigator, 'userAgent', { get: () => FP.userAgent });
    Object.defineProperty(navigator, 'platform', { get: () => FP.platform });
    Object.defineProperty(navigator, 'vendor', { get: () => FP.vendor });
    Object.defineProperty(navigator, 'language', { get: () => FP.language });
    Object.defineProperty(navigator, 'languages', { get: () => FP.languages.slice() });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => FP.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => FP.deviceMemory, configurable: true });
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
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => (FP.os === 'Android' || FP.os === 'iOS' ? 5 : 0) });
    if (FP.doNotTrack !== null) Object.defineProperty(navigator, 'doNotTrack', { get: () => FP.doNotTrack ? '1' : '0' });
  } catch(e){}

  // ---- navigator.userAgentData（User-Agent Client Hints）----
  // 仅改 navigator.userAgent 字符串不够：headless 模式下 navigator.userAgentData.brands 会暴露
  // "HeadlessChrome"，且 platform / uaFullVersion / fullVersionList 均可能与伪造的 UA 不一致。
  // 必须同步覆盖，使 brands/platform/version 与 UA 完全对齐，掐灭无头特征。
  try {
    const uaVer = (function(){ const p = FP.userAgent.split('Chrome/')[1]; if (!p) return '151.0.0.0'; return p.split(' ')[0] || '151.0.0.0'; })();
    const majorVer = uaVer.split('.')[0];
    const osPlatform = (FP.os === 'Windows' ? 'Windows'
      : (FP.os === 'macOS' || FP.os === 'Mac') ? 'macOS'
      : FP.os === 'Linux' ? 'Linux'
      : FP.os === 'Android' ? 'Android'
      : FP.os === 'iOS' ? 'iOS' : 'Windows');
    const brands = [
      { brand: 'Google Chrome', version: majorVer },
      { brand: 'Chromium', version: majorVer },
      { brand: 'Not?A_Brand', version: '24' },
    ];
    const fullVersionList = [
      { brand: 'Google Chrome', version: uaVer },
      { brand: 'Chromium', version: uaVer },
      { brand: 'Not?A_Brand', version: '24.0.0.0' },
    ];
    const Ctor = (typeof NavigatorUAData !== 'undefined') ? NavigatorUAData : null;
    const uaDataObj = Ctor ? Object.create(Ctor.prototype) : {};
    Object.defineProperty(uaDataObj, 'brands', { get: () => brands.slice() });
    Object.defineProperty(uaDataObj, 'mobile', { get: () => false });
    Object.defineProperty(uaDataObj, 'platform', { get: () => osPlatform });
    uaDataObj.getHighEntropyValues = function(hints) {
      return Promise.resolve({
        brands: brands.slice(),
        mobile: false,
        platform: osPlatform,
        platformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        model: '',
        uaFullVersion: uaVer,
        fullVersionList: fullVersionList.slice(),
      });
    };
    whiten(uaDataObj.getHighEntropyValues);
    Object.defineProperty(navigator, 'userAgentData', { get: () => uaDataObj, configurable: true });
  } catch(e){}

  // ---- 设备名 / MAC（部分脚本可能尝试读取 chrome.runtime 或自定义属性，先覆盖常见探测点） ----
  try {
    Object.defineProperty(navigator, 'deviceName', { get: () => FP.deviceName });
    Object.defineProperty(navigator, 'macAddress', { get: () => FP.mac });
  } catch(e){}

  // ---- 伪装 plugins / mimeTypes（二者必须一致，否则被识别为自动化） ----
  try {
    const ITER = (typeof Symbol !== 'undefined' && Symbol.iterator) ? Symbol.iterator : '__iter';
    // 真实 Chrome 默认内置插件清单
    const PLUGINS = [
      { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer2',
        mimeTypes: [{ type: 'application/pdf', description: 'Portable Document Format', suffixes: 'pdf' }] },
      { name: 'Chrome PDF Viewer', description: '', filename: 'internal-pdf-viewer',
        mimeTypes: [{ type: 'application/pdf', description: '', suffixes: 'pdf' }] },
      { name: 'Native Client', description: '', filename: 'internal-nacl-plugin',
        mimeTypes: [{ type: 'application/x-nacl', description: '', suffixes: '' },
                    { type: 'application/x-pnacl', description: '', suffixes: '' }] },
    ];
    const PluginCtor = window.Plugin;
    const MimeTypeCtor = window.MimeType;
    const PluginArrayCtor = window.PluginArray;
    const MimeTypeArrayCtor = window.MimeTypeArray;

    function makeMimeType(m, owner) {
      const mt = MimeTypeCtor ? Object.create(MimeTypeCtor.prototype) : {};
      Object.defineProperties(mt, {
        type: { value: m.type },
        description: { value: m.description || '' },
        suffixes: { value: m.suffixes || '' },
        enabledPlugin: { value: owner, configurable: true },
      });
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
    built.forEach(({ inst, mts }) => mts.forEach((mt) => { try { Object.defineProperty(mt, 'enabledPlugin', { value: inst, configurable: true }); } catch (e) {} allMimeTypes.push(mt); }));

    const pa = PluginArrayCtor ? Object.create(PluginArrayCtor.prototype) : {};
    Object.defineProperties(pa, {
      length: { value: built.length },
      item: { value: (i) => (built[i] ? built[i].inst : null) },
      namedItem: { value: (n) => { const b = built.find((x) => x.inst.name === n); return b ? b.inst : null; } },
      refresh: { value: function() {} },
      [ITER]: { value: function*() { for (const b of built) yield b.inst; } },
    });
    built.forEach((b, i) => { try { Object.defineProperty(pa, i, { value: b.inst, enumerable: false, configurable: true }); } catch (e) {} }); // 支持 navigator.plugins[i] 方括号访问（不可枚举）
    Object.defineProperty(navigator, 'plugins', { get: () => pa, configurable: true });

    const ma = MimeTypeArrayCtor ? Object.create(MimeTypeArrayCtor.prototype) : {};
    Object.defineProperties(ma, {
      length: { value: allMimeTypes.length },
      item: { value: (i) => allMimeTypes[i] || null },
      namedItem: { value: (n) => allMimeTypes.find((x) => x.type === n) || null },
      [ITER]: { value: function*() { for (const x of allMimeTypes) yield x; } },
    });
    allMimeTypes.forEach((mt, i) => { try { Object.defineProperty(ma, i, { value: mt, enumerable: false, configurable: true }); } catch (e) {} }); // 支持 navigator.mimeTypes[i] 方括号访问（不可枚举）
    Object.defineProperty(navigator, 'mimeTypes', { get: () => ma, configurable: true });
  } catch(e){}

  // ---- Notification.permission 与 navigator.permissions.query 一致性 ----
  // 风控会同时读两者：若一个 denied 一个 default 即判定自动化。这里让 query 的结果
  // 始终与 Notification.permission 对齐，二者永不矛盾。
  try {
    if (window.Notification && navigator.permissions && navigator.permissions.query) {
      const realQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (descriptor) {
        if (descriptor && descriptor.name === 'notifications' && typeof window.Notification.permission === 'string') {
          return Promise.resolve({ name: 'notifications', state: window.Notification.permission, onchange: null });
        }
        // 非 notifications 查询（含非法 name）交还原生，让其按标准抛出 TypeError，避免假代跑暴露。
        return realQuery(descriptor);
      };
    }
  } catch (e) {}

  // ---- screen ----
  try {
    const s = FP.screen;
    Object.defineProperty(screen, 'width', { get: () => s.width });
    Object.defineProperty(screen, 'height', { get: () => s.height });
    Object.defineProperty(screen, 'availWidth', { get: () => s.availWidth });
    Object.defineProperty(screen, 'availHeight', { get: () => s.availHeight });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  } catch(e){}
  try {
    Object.defineProperty(window, 'devicePixelRatio', { get: () => FP.screen.pixelRatio, configurable: true });
    Object.defineProperty(window, 'outerWidth', { get: () => FP.screen.availWidth, configurable: true });
    Object.defineProperty(window, 'outerHeight', { get: () => FP.screen.availHeight, configurable: true });
  } catch(e){}

  // ---- 时区：Playwright 已通过 timezoneId 参数设置原生时区，此处不再 JS 覆盖，避免 Pixelscan 识别为 spoof ----
  // 保留最小兜底：确保 resolvedOptions.timeZone 与 FP.timezone 一致（通常已由 Chromium 设置好）
  try {
    const TZ = FP.timezone;
    const origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function(...a){
      const opts = origResolved.apply(this, a);
      if (TZ) opts.timeZone = TZ;
      return opts;
    };
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

  // ---- 关闭自动化特征 / 补齐浏览器对象 ----
  try {
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    // headless 下 window.chrome 不完整，补齐关键子对象避免被 Akamai/Cloudflare/reCAPTCHA Enterprise 深度遍历标记
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {
      OnConnect: {}, OnMessage: {}, OnInstalled: {}, OnStartup: {}, OnSuspend: {},
      connect: function () {
        return { postMessage: function () {}, onMessage: { addListener: function () {} }, onDisconnect: { addListener: function () {} }, disconnect: function () {} };
      },
      sendMessage: function () { return Promise.resolve(); },
      getURL: function () { return ''; },
      getManifest: function () { return {}; },
      id: '',
    };
    if (!window.chrome.webstore) window.chrome.webstore = { onInstallStageChanged: {}, onDownloadProgress: {}, getInstallStage: function () {}, beginInstall: function () {} };
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
  try {
    whiten(window.chrome);
    if (navigator.permissions && navigator.permissions.query) whiten(navigator.permissions.query);
    if (HTMLCanvasElement.prototype.getContext) whiten(HTMLCanvasElement.prototype.getContext);
    if (HTMLCanvasElement.prototype.toDataURL) whiten(HTMLCanvasElement.prototype.toDataURL);
    if (HTMLCanvasElement.prototype.toBlob) whiten(HTMLCanvasElement.prototype.toBlob);
    if (Element.prototype.getBoundingClientRect) whiten(Element.prototype.getBoundingClientRect);
    if (window.AudioContext && window.AudioContext.prototype.createAnalyser) whiten(window.AudioContext.prototype.createAnalyser);
    if (window.WebGLRenderingContext) { whiten(WebGLRenderingContext.prototype.getParameter); whiten(WebGLRenderingContext.prototype.getExtension); }
    if (window.WebGL2RenderingContext) { whiten(WebGL2RenderingContext.prototype.getParameter); whiten(WebGL2RenderingContext.prototype.getExtension); }
    if (window.RTCPeerConnection) whiten(window.RTCPeerConnection);
  } catch (e) {}
})();`;
}

module.exports = { buildInjectionScript };
