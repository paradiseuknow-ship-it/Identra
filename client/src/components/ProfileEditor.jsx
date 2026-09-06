import React, { useEffect, useRef, useState } from 'react';
import api from '../api';

const OS_OPTIONS = ['Windows', 'macOS', 'Linux', 'Android', 'iOS'];
const BROWSER_OPTIONS = ['Chrome', 'Edge', 'Safari'];
const WEBRTC_OPTIONS = [
  { value: 'proxy', label: '代理UDP（防泄漏）' },
  { value: 'forward', label: '转发' },
  { value: 'replace-udp', label: '替换' },
  { value: 'real', label: '真实' },
  { value: 'disable', label: '禁用' },
];
const TIMEZONE_OPTIONS = [
  { value: 'ip', label: '基于 IP' },
  { value: 'random', label: '随机' },
  { value: 'real', label: '真实' },
  { value: 'custom', label: '自定义' },
];
const GEO_OPTIONS = [
  { value: 'ip', label: '基于 IP' },
  { value: 'random', label: '随机' },
  { value: 'real', label: '真实' },
  { value: 'custom', label: '自定义' },
  { value: 'block', label: '禁止' },
];
const LANG_OPTIONS = [
  { value: 'ip', label: '基于 IP' },
  { value: 'random', label: '随机' },
  { value: 'real', label: '真实' },
  { value: 'custom', label: '自定义' },
];
const RESOLUTION_OPTIONS = [
  { value: 'random', label: '随机' },
  { value: 'predefined', label: '基于 User-Agent' },
  { value: 'custom', label: '自定义' },
];
const INTERFACE_LANG_OPTIONS = [
  { value: 'language', label: '基于语言' },
  { value: 'real', label: '真实' },
  { value: 'custom', label: '自定义' },
];
const WEBGPU_OPTIONS = [
  { value: 'webgl', label: '基于 WebGL' },
  { value: 'real', label: '真实' },
  { value: 'disable', label: '禁用' },
];

const TABS = [
  { key: 'basic', label: '基础设置' },
  { key: 'proxy', label: '代理信息' },
  { key: 'account', label: '账号平台' },
  { key: 'fingerprint', label: '指纹配置' },
  { key: 'advanced', label: '高级设置' },
];

export default function ProfileEditor({ profile, proxies, onClose, onSaved }) {
  const isNew = !profile?.id;
  const [activeTab, setActiveTab] = useState('basic');
  const [form, setForm] = useState(() => (profile ? normalizeProfile(profile) : emptyProfile()));
  const [fp, setFp] = useState(profile?.fingerprint || null);
  const [vault, setVault] = useState({ email: '', password: '', card: { number: '', expMonth: '', expYear: '', cvv: '', name: '', zip: '' } });
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [fpError, setFpError] = useState(null);
  const [templates, setTemplates] = useState([]); // C13：新建时的可选模板基线

  useEffect(() => {
    if (isNew) api.listTemplates().then(setTemplates).catch(() => {});
  }, [isNew]);

  const sectionRefs = {
    basic: useRef(null),
    proxy: useRef(null),
    account: useRef(null),
    fingerprint: useRef(null),
    advanced: useRef(null),
  };
  const mainRef = useRef(null);

  const refreshPreview = async (payload) => {
    const seed = form.seed || (profile?.id || 'preview');
    try {
      const data = await api.previewFp({
        seed,
        proxyId: form.proxyId,
        fingerprintOverride: payload?.fingerprintOverride ?? form.fingerprintOverride,
      });
      setFp(data);
      setFpError(null);
    } catch (e) {
      setFpError(e.message || '预览生成失败');
    }
  };

  useEffect(() => { refreshPreview(); }, []);
  useEffect(() => { refreshPreview(); }, [form.proxyId]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActiveTab(visible.target.dataset.tab);
      },
      { root: main, threshold: [0.25, 0.5, 0.75] }
    );
    Object.values(sectionRefs).forEach((ref) => {
      if (ref.current) observer.observe(ref.current);
    });
    return () => observer.disconnect();
  }, []);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setOv = (k, v) => setForm((f) => ({ ...f, fingerprintOverride: { ...f.fingerprintOverride, [k]: v } }));
  const setNested = (prefix, k, v) => setForm((f) => ({ ...f, [prefix]: { ...f[prefix], [k]: v } }));
  const setBehavior = (k, v) => setForm((f) => ({ ...f, launchBehavior: { ...(f.launchBehavior || {}), [k]: v } }));

  const scrollTo = (key) => {
    setActiveTab(key);
    sectionRefs[key].current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const regenerateFingerprint = async () => {
    setRegenerating(true);
    try {
      if (isNew) {
        const newSeed = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
        setField('seed', newSeed);
        await refreshPreview();
      } else {
        const updated = await api.regenerateSeed(profile.id);
        setForm((f) => ({ ...f, seed: updated.seed }));
        setFp(updated.fingerprint);
      }
    } catch (e) {
      alert('生成失败: ' + e.message);
    } finally {
      setRegenerating(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const payload = buildPayload(form);
      let saved;
      if (isNew) saved = await api.createProfile(payload);
      else saved = await api.updateProfile(profile.id, payload);

      const v = vault;
      if (v.email || v.password || v.card.number || v.card.cvv) {
        await api.setVault(saved.id, {
          email: v.email || undefined,
          password: v.password || undefined,
          card: Object.fromEntries(Object.entries(v.card).map(([k, val]) => [k, val || undefined])),
        });
      }
      onSaved();
    } catch (e) { alert('保存失败: ' + e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center overflow-auto p-4 z-50">
      <div className="w-full max-w-6xl bg-panel border border-edge rounded-xl shadow-2xl flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge shrink-0">
          <h3 className="text-lg font-semibold">{isNew ? '新建配置' : '编辑配置'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>

        <div className="border-b border-edge shrink-0 px-5">
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button key={t.key}
                onClick={() => scrollTo(t.key)}
                className={`px-4 py-2.5 text-sm border-b-2 transition-colors ${activeTab === t.key ? 'border-sky-500 text-sky-400 font-medium' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          <div ref={mainRef} className="flex-1 overflow-y-auto p-5 space-y-6">
            <div data-tab="basic" ref={sectionRefs.basic}><BasicTab form={form} setField={setField} setOv={setOv} /></div>
            <div data-tab="proxy" ref={sectionRefs.proxy}><ProxyTab form={form} setField={setField} proxies={proxies} /></div>
            <div data-tab="account" ref={sectionRefs.account}><AccountTab form={form} setField={setField} setBehavior={setBehavior} vault={vault} setVault={setVault} /></div>
            <div data-tab="fingerprint" ref={sectionRefs.fingerprint}><FingerprintTab form={form} setField={setField} setOv={setOv} setNested={setNested} fp={fp} refreshPreview={refreshPreview} /></div>
            <div data-tab="advanced" ref={sectionRefs.advanced}><AdvancedTab form={form} setField={setField} setOv={setOv} /></div>

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-4 py-2 rounded bg-edge hover:bg-slate-700">取消</button>
              <button onClick={save} disabled={busy} className="px-4 py-2 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50">
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>

          <div className="w-80 border-l border-edge bg-panel/50 p-4 overflow-y-auto shrink-0 hidden md:block">
            <SummaryPanel fp={fp} form={form} onRegenerate={regenerateFingerprint} regenerating={regenerating} isNew={isNew} onRetry={refreshPreview} fpError={fpError} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryPanel({ fp, form, onRegenerate, regenerating, isNew, onRetry, fpError }) {
  const ov = form.fingerprintOverride;
  const seed = form.seed || (isNew ? '（新建）' : form.seed);

  const noiseLabel = (k) => {
    const v = ov[k];
    if (v === false) return '真实';
    if (v === true || v === undefined) return '噪音';
    return String(v);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-200">概要</div>
        <div className="flex items-center gap-1">
          <button
            onClick={onRetry}
            title="刷新预览"
            className="text-xs flex items-center gap-1 px-2 py-1 rounded bg-edge hover:bg-slate-700 text-slate-300"
          >
            <span>⟳</span>
            <span>刷新</span>
          </button>
          <button
            onClick={onRegenerate}
            disabled={regenerating}
            className="text-xs flex items-center gap-1 px-2 py-1 rounded bg-sky-600/20 text-sky-400 hover:bg-sky-600/30 disabled:opacity-50"
          >
            <span>↻</span>
            <span>{regenerating ? '生成中…' : '生成新指纹'}</span>
          </button>
        </div>
      </div>

      {!fp ? (
        fpError ? (
          <div className="text-xs text-rose-400 space-y-2">
            <div>预览失败：{fpError}</div>
            <button onClick={onRetry} className="px-2 py-1 rounded bg-edge hover:bg-slate-700">重试</button>
          </div>
        ) : (
          <div className="text-xs text-slate-500">生成中…</div>
        )
      ) : (
        <div className="text-xs space-y-2 text-slate-300">
          {fp.ipGeo && (
            <div className="text-emerald-400 mb-2">
              基于 IP: {fp.ipGeo.ip} · {fp.ipGeo.country} {fp.ipGeo.city}
            </div>
          )}
          <Row label="浏览器" value={`${form.browser} (${form.os})`} />
          <Row label="User-Agent" value={fp.userAgent} multiline />
          <Row label="WebRTC" value={WEBRTC_OPTIONS.find((x) => x.value === (ov.webRtc || 'proxy'))?.label} />
          <Row label="时区" value={`${fp.timezone} (${fp.timezoneOffset >= 0 ? '+' : ''}${fp.timezoneOffset / 60}h)`} />
          <Row label="地理位置" value={`[${fp.geolocation.mode}] ${fp.geolocation.lat.toFixed(2)}, ${fp.geolocation.lng.toFixed(2)}`} />
          <Row label="语言" value={fp.language} />
          <Row label="界面语言" value={fp.interfaceLanguage} />
          <Row label="分辨率" value={`${fp.screen.width}x${fp.screen.height} @ ${fp.screen.pixelRatio}x`} />
          <Row label="字体" value={fp.fonts || '默认'} />
          <Row label="Canvas" value={noiseLabel('canvas')} />
          <Row label="WebGL图像" value={noiseLabel('webglImage')} />
          <Row label="AudioContext" value={noiseLabel('audioContext')} />
          <Row label="媒体设备" value={noiseLabel('mediaDevices')} />
          <Row label="ClientRects" value={noiseLabel('clientRects')} />
          <Row label="SpeechVoices" value={noiseLabel('speechVoices')} />
          <Row label="WebGL元数据" value={`${fp.webgl?.vendor || '-'} / ${fp.webgl?.renderer || '-'}`} multiline />
          <Row label="WebGPU" value={WEBGPU_OPTIONS.find((x) => x.value === (ov.webgpu || 'webgl'))?.label} />
          <Row label="CPU" value={`${fp.hardwareConcurrency} 核`} />
          <Row label="RAM" value={`${fp.deviceMemory} GB`} />
          <Row label="设备名" value={fp.deviceName || '-'} />
          <Row label="MAC" value={fp.mac || '-'} />
          <Row label="Do Not Track" value={fp.doNotTrack === null ? '默认' : fp.doNotTrack ? '开启' : '关闭'} />
          {ov.randomFingerprint && <div className="text-amber-400">每次启动重新生成指纹</div>}
          <div className="pt-2 text-slate-500 border-t border-edge">种子: {seed}</div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, multiline }) {
  return (
    <div className={multiline ? 'block' : 'flex justify-between gap-2'}>
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={multiline ? 'block text-slate-300 break-all mt-0.5' : 'text-slate-300 text-right break-all'}>{value || '-'}</span>
    </div>
  );
}

function BasicTab({ form, setField, setOv }) {
  return (
    <div className="space-y-4">
      <Section title="基础信息">
        <div className="grid grid-cols-2 gap-4">
          <Field label="名称"><input className="inp" value={form.name} onChange={(e) => setField('name', e.target.value)} /></Field>
          <Field label="分组"><input className="inp" value={form.group} onChange={(e) => setField('group', e.target.value)} /></Field>
          <Field label="标签 (逗号分隔)"><input className="inp" value={form.tags} onChange={(e) => setField('tags', e.target.value)} placeholder="例如: 电商, 美国" /></Field>
          <Field label="指纹种子"><input className="inp" value={form.seed} onChange={(e) => setField('seed', e.target.value)} placeholder="留空自动生成" /></Field>
          {isNew && (
            <Field label="指纹模板 (可选基线)">
              <select className="inp" value={form.templateId || ''} onChange={(e) => setField('templateId', e.target.value || undefined)}>
                <option value="">不使用模板</option>
                {(templates || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div className="mt-3"><Field label="备注"><textarea className="inp w-full" rows={2} value={form.notes} onChange={(e) => setField('notes', e.target.value)} /></Field></div>
      </Section>

      <Section title="浏览器与系统">
        <div className="grid grid-cols-3 gap-4">
          <Field label="操作系统">
            <select className="inp" value={form.os} onChange={(e) => { setField('os', e.target.value); setOv('os', e.target.value); }}>
              {OS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="浏览器">
            <select className="inp" value={form.browser} onChange={(e) => { setField('browser', e.target.value); setOv('browser', e.target.value); }}>
              {BROWSER_OPTIONS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="运行模式">
            <select className="inp" value={String(form.headless)} onChange={(e) => setField('headless', e.target.value === 'true')}>
              <option value="true">无头 (headless)</option>
              <option value="false">有界面</option>
            </select>
          </Field>
        </div>
      </Section>

      <Section title="Cookie">
        <Field label="导入 Cookie (JSON / Netscape / Name=Value)">
          <textarea className="inp w-full" rows={3} value={form.cookieImport} onChange={(e) => setField('cookieImport', e.target.value)} placeholder="仅保存，启动后自动注入" />
        </Field>
      </Section>
    </div>
  );
}

function ProxyTab({ form, setField, proxies }) {
  const [result, setResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const inline = (() => {
    const pi = form.proxyInline;
    if (!pi) return { type: 'socks5', host: '', port: '', username: '', password: '' };
    if (pi.host && pi.port) return pi;
    // 兜底：如果 proxyInline 只有 server，拆成 host/port
    if (pi.server) {
      const raw = String(pi.server).replace(/^[a-z0-9]+:\/\//i, '');
      const [host, port] = raw.split(':');
      return { ...pi, host: host || '', port: port || '' };
    }
    return pi;
  })();

  const setInline = (k, v) =>
    setField('proxyInline', { ...inline, [k]: v });

  const checkInline = async () => {
    if (!inline.host || !inline.port) return;
    setChecking(true); setResult(null);
    try {
      const r = await api.checkInlineProxy({
        type: inline.type,
        server: `${inline.host}:${inline.port}`,
        username: inline.username || '',
        password: inline.password || '',
      });
      // 后端识别出实际可用协议与当前选择不一致时，自动修正类型
      if (r.ok && r.detectedType && r.detectedType !== inline.type) {
        setInline('type', r.detectedType);
      }
      setResult(r);
    } catch (e) {
      setResult({ ok: false, error: e.message });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title="代理绑定">
        <Field label="代理方式">
          <select className="inp" value={form.proxyMode} onChange={(e) => setField('proxyMode', e.target.value)}>
            <option value="inline">直接填写代理</option>
            <option value="saved">使用已保存代理</option>
            <option value="none">不使用代理</option>
          </select>
        </Field>

        {form.proxyMode === 'saved' && (
          <div className="mt-3 grid grid-cols-1 gap-3">
            <Field label="已添加的代理">
              <select className="inp" value={form.proxyId || ''} onChange={(e) => setField('proxyId', e.target.value || null)}>
                <option value="">选择代理…</option>
                {proxies.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type}://{p.server})</option>)}
              </select>
            </Field>
            <div className="text-xs text-slate-500">新增/检测代理请到「代理管理」页面。</div>
          </div>
        )}

        {form.proxyMode === 'inline' && (
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="类型">
                <select className="inp" value={inline.type} onChange={(e) => setInline('type', e.target.value)}>
                  <option value="socks5">Socks5</option>
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                </select>
              </Field>
              <Field label="主机">
                <input className="inp" value={inline.host} onChange={(e) => setInline('host', e.target.value)}
                  onBlur={(e) => {
                    const parsed = parseProxyString(e.target.value);
                    if (parsed) {
                      setField('proxyInline', { ...inline, ...parsed });
                    }
                  }}
                  placeholder="127.0.0.1 或 整段 IP:端口:用户:密码" />
                <div className="text-xs text-slate-500 mt-1">支持整段粘贴（如 1.2.3.4:1080:user:pass），点击其他位置会自动拆分填入。</div>
              </Field>
              <Field label="端口">
                <input className="inp" value={inline.port} onChange={(e) => setInline('port', e.target.value)} placeholder="1080" />
              </Field>
              <div className="flex items-end">
                <button onClick={checkInline} disabled={checking || !inline.host || !inline.port}
                  className="w-full px-3 py-1.5 rounded bg-sky-600 text-white text-sm hover:bg-sky-500 disabled:opacity-50">
                  {checking ? '检测中…' : '检测'}
                </button>
              </div>
              <Field label="用户名（可选）">
                <input className="inp" value={inline.username} onChange={(e) => setInline('username', e.target.value)} placeholder="留空则无鉴权" />
              </Field>
              <Field label="密码（可选）">
                <input className="inp" type="password" value={inline.password} onChange={(e) => setInline('password', e.target.value)} />
              </Field>
            </div>
            {result && (
              <div className={`text-sm ${result.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                {result.ok
                  ? `检测通过${result.detectedType && result.detectedType !== inline.type ? `（已自动识别为 ${result.detectedType.toUpperCase()}）` : ''}: ${result.ip} (${result.latencyMs}ms)`
                  : `检测失败: ${result.error}`}
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

function AccountTab({ form, setField, setBehavior, vault, setVault }) {
  return (
    <div className="space-y-4">
      <Section title="账号凭据 (AES 加密)">
        <div className="grid grid-cols-2 gap-4">
          <Field label="邮箱"><input className="inp" value={vault.email} onChange={(e) => setVault({ ...vault, email: e.target.value })} /></Field>
          <Field label="密码"><input className="inp" type="password" value={vault.password} onChange={(e) => setVault({ ...vault, password: e.target.value })} /></Field>
        </div>
      </Section>

      <Section title="支付信息 (AES 加密)">
        <div className="grid grid-cols-2 gap-4">
          <Field label="卡号"><input className="inp" value={vault.card.number} onChange={(e) => setVault({ ...vault, card: { ...vault.card, number: e.target.value } })} /></Field>
          <Field label="持卡人"><input className="inp" value={vault.card.name} onChange={(e) => setVault({ ...vault, card: { ...vault.card, name: e.target.value } })} /></Field>
          <Field label="有效期月 (MM)"><input className="inp" value={vault.card.expMonth} onChange={(e) => setVault({ ...vault, card: { ...vault.card, expMonth: e.target.value } })} /></Field>
          <Field label="有效期年 (YYYY)"><input className="inp" value={vault.card.expYear} onChange={(e) => setVault({ ...vault, card: { ...vault.card, expYear: e.target.value } })} /></Field>
          <Field label="CVV"><input className="inp" value={vault.card.cvv} onChange={(e) => setVault({ ...vault, card: { ...vault.card, cvv: e.target.value } })} /></Field>
          <Field label="账单邮编"><input className="inp" value={vault.card.zip} onChange={(e) => setVault({ ...vault, card: { ...vault.card, zip: e.target.value } })} /></Field>
        </div>
        <div className="text-xs text-slate-500 mt-2">提交后明文不会回传前端，仅保存密文与脱敏摘要。</div>
      </Section>

      <Section title="启动标签页">
        <Field label="起始 URL（每行一个）">
          <textarea className="inp w-full" rows={3} value={form.startupUrls} onChange={(e) => setField('startupUrls', e.target.value)} placeholder="https://www.google.com" />
        </Field>
      </Section>

      <Section title="启动时行为">
        <div className="space-y-3">
          <Toggle label="继续浏览上次打开的网页" checked={form.launchBehavior?.restoreLastSession === true} onChange={(v) => setBehavior('restoreLastSession', v)} />
          <Toggle label="禁止加载视频" checked={form.launchBehavior?.blockVideo === true} onChange={(v) => setBehavior('blockVideo', v)} />
          <div>
            <Toggle label="隐身窗口模式（有界面但移出屏幕外）" checked={form.launchBehavior?.hiddenWindow === true} onChange={(v) => setBehavior('hiddenWindow', v)} />
            <div className="text-xs text-slate-500 mt-1">
              真实有界面浏览器进程，窗口放到屏幕外不可见：指纹真实度最高（推荐反检测场景使用）。启用后使用指纹固定分辨率、截图稳定；与「使用真实屏幕分辨率」互斥。
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Toggle label="禁止加载大图（省流量）" checked={form.launchBehavior?.blockImages === true} onChange={(v) => setBehavior('blockImages', v)} />
            <input
              type="number"
              min={0}
              className="inp w-20"
              value={form.launchBehavior?.blockImagesThresholdKB ?? 10}
              onChange={(e) => setBehavior('blockImagesThresholdKB', parseInt(e.target.value) || 0)}
              disabled={form.launchBehavior?.blockImages !== true}
            />
            <span className="text-sm text-slate-400">KB 以上的图片不加载（0 = 全部禁止）</span>
          </div>
          <div className="text-xs text-slate-500">仅勾选「禁止加载大图」后生效；验证码 / 反爬挑战图已自动放行，不影响图形验证通过。</div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-300">启动时缓存清理</span>
            <select
              className="inp"
              value={form.launchBehavior?.cacheClearMode || (form.launchBehavior?.clearCacheOnLaunch === true ? 'full' : 'none')}
              onChange={(e) => setBehavior('cacheClearMode', e.target.value)}
            >
              <option value="none">不清理</option>
              <option value="cache">仅清理缓存（保留登录）</option>
              <option value="full">彻底重置（含站点数据）</option>
            </select>
          </div>
          {(form.launchBehavior?.cacheClearMode || (form.launchBehavior?.clearCacheOnLaunch === true ? 'full' : 'none')) === 'full' && (
            <div className="flex items-center gap-3">
              <Toggle label="同时清除 Cookies" checked={form.launchBehavior?.clearCookies === true} onChange={(v) => setBehavior('clearCookies', v)} />
            </div>
          )}
          <div className="text-xs text-slate-500">
            「仅清理缓存」只删 HTTP / Code Cache，保留 LocalStorage、IndexedDB、Service Worker 与 Cookies，登录态不丢；「彻底重置」连站点状态一起清（Cookies 默认保留，除非勾选清除）。
          </div>
        </div>
      </Section>
    </div>
  );
}

function FingerprintTab({ form, setField, setOv, setNested, fp, refreshPreview }) {
  const ov = form.fingerprintOverride;
  const setGeo = (k, v) => setNested('fingerprintOverride', 'geolocation', { ...(ov.geolocation || {}), [k]: v });
  const setScreen = (k, v) => setNested('fingerprintOverride', 'screen', { ...(ov.screen || {}), [k]: v });

  return (
    <div className="space-y-4">
      <Section title="实时指纹预览">
        <button onClick={() => refreshPreview()} className="text-xs px-2 py-1 rounded bg-edge hover:bg-slate-700 mb-2">刷新预览</button>
        {fp?.ipGeo && (
          <div className="text-xs mb-2 text-emerald-400">
            基于 IP 检测: {fp.ipGeo.ip} · {fp.ipGeo.country} {fp.ipGeo.city} · 时区 {fp.ipGeo.timezone} · 语言 {fp.ipGeo.language || '(根据国家推断)'}
          </div>
        )}
        {fp ? (
          <pre className="text-xs bg-black/40 rounded p-3 overflow-auto max-h-48 text-slate-300">
            {JSON.stringify(fp, null, 2)}
          </pre>
        ) : <div className="text-xs text-slate-500">生成中…</div>}
      </Section>

      <Section title="网络与位置">
        <div className="grid grid-cols-2 gap-4">
          <Field label="WebRTC">
            <select className="inp" value={ov.webRtc || 'proxy'} onChange={(e) => setOv('webRtc', e.target.value)}>
              {WEBRTC_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="时区">
            <select className="inp" value={ov.timezoneMode || 'ip'} onChange={(e) => setOv('timezoneMode', e.target.value)}>
              {TIMEZONE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          {ov.timezoneMode === 'custom' && (
            <Field label="自定义时区"><input className="inp" value={ov.timezone || ''} onChange={(e) => setOv('timezone', e.target.value)} placeholder="Asia/Shanghai" /></Field>
          )}
          <Field label="地理位置">
            <select className="inp" value={(ov.geolocation && ov.geolocation.mode) || 'ip'} onChange={(e) => setGeo('mode', e.target.value)}>
              {GEO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          {(ov.geolocation?.mode === 'custom') && (
            <>
              <Field label="纬度"><input className="inp" type="number" step="0.0001" value={ov.geolocation.lat || ''} onChange={(e) => setGeo('lat', parseFloat(e.target.value))} /></Field>
              <Field label="经度"><input className="inp" type="number" step="0.0001" value={ov.geolocation.lng || ''} onChange={(e) => setGeo('lng', parseFloat(e.target.value))} /></Field>
              <Field label="精度 (m)"><input className="inp" type="number" value={ov.geolocation.accuracy || ''} onChange={(e) => setGeo('accuracy', parseFloat(e.target.value))} /></Field>
            </>
          )}
        </div>
      </Section>

      <Section title="语言与区域">
        <div className="grid grid-cols-2 gap-4">
          <Field label="语言">
            <select className="inp" value={ov.languageMode || 'ip'} onChange={(e) => setOv('languageMode', e.target.value)}>
              {LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          {ov.languageMode === 'custom' && (
            <Field label="自定义语言"><input className="inp" value={ov.language || ''} onChange={(e) => setOv('language', e.target.value)} placeholder="en-US" /></Field>
          )}
          <Field label="界面语言">
            <select className="inp" value={ov.interfaceLanguageMode || 'language'} onChange={(e) => setOv('interfaceLanguageMode', e.target.value)}>
              {INTERFACE_LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          {ov.interfaceLanguageMode === 'custom' && (
            <Field label="自定义界面语言"><input className="inp" value={ov.interfaceLanguage || ''} onChange={(e) => setOv('interfaceLanguage', e.target.value)} placeholder="en-US" /></Field>
          )}
        </div>
      </Section>

      <Section title="屏幕与字体">
        <div className="grid grid-cols-2 gap-4">
          <Field label="分辨率策略">
            <select className="inp" value={ov.resolutionMode || 'predefined'} onChange={(e) => setOv('resolutionMode', e.target.value)}>
              {RESOLUTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          {ov.resolutionMode === 'custom' && (
            <>
              <Field label="宽度"><input className="inp" type="number" value={ov.screen?.width || ''} onChange={(e) => setScreen('width', parseInt(e.target.value))} /></Field>
              <Field label="高度"><input className="inp" type="number" value={ov.screen?.height || ''} onChange={(e) => setScreen('height', parseInt(e.target.value))} /></Field>
              <Field label="DPR"><input className="inp" type="number" step="0.1" value={ov.screen?.pixelRatio || ''} onChange={(e) => setScreen('pixelRatio', parseFloat(e.target.value))} /></Field>
            </>
          )}
          <Field label="字体"><input className="inp" value={ov.fonts || ''} onChange={(e) => setOv('fonts', e.target.value)} placeholder="留空使用系统默认" /></Field>
        </div>
      </Section>

      <Section title="硬件噪音开关">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Toggle label="Canvas" checked={ov.canvas !== false} onChange={(v) => setOv('canvas', v)} />
          <Toggle label="WebGL 图像" checked={ov.webglImage !== false} onChange={(v) => setOv('webglImage', v)} />
          <Toggle label="AudioContext" checked={ov.audioContext !== false} onChange={(v) => setOv('audioContext', v)} />
          <Toggle label="媒体设备" checked={ov.mediaDevices !== false} onChange={(v) => setOv('mediaDevices', v)} />
          <Toggle label="ClientRects" checked={ov.clientRects !== false} onChange={(v) => setOv('clientRects', v)} />
          <Toggle label="SpeechVoices" checked={ov.speechVoices !== false} onChange={(v) => setOv('speechVoices', v)} />
        </div>
      </Section>

      <Section title="WebGL / WebGPU / 硬件">
        <div className="grid grid-cols-2 gap-4">
          <Field label="WebGL 厂商"><input className="inp" value={ov.webgl?.vendor || ''} onChange={(e) => setOv('webgl', { ...(ov.webgl || {}), vendor: e.target.value })} placeholder="Google Inc. (NVIDIA)" /></Field>
          <Field label="WebGL 渲染器"><input className="inp" value={ov.webgl?.renderer || ''} onChange={(e) => setOv('webgl', { ...(ov.webgl || {}), renderer: e.target.value })} placeholder="ANGLE (...)" /></Field>
          <Field label="WebGPU">
            <select className="inp" value={ov.webgpu || 'webgl'} onChange={(e) => setOv('webgpu', e.target.value)}>
              {WEBGPU_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="CPU 核心数"><input className="inp" type="number" value={ov.hardwareConcurrency || ''} onChange={(e) => setOv('hardwareConcurrency', parseInt(e.target.value) || undefined)} placeholder="8" /></Field>
          <Field label="RAM (GB)"><input className="inp" type="number" value={ov.deviceMemory || ''} onChange={(e) => setOv('deviceMemory', parseInt(e.target.value) || undefined)} placeholder="8" /></Field>
          <Field label="设备名称"><input className="inp" value={ov.deviceName || ''} onChange={(e) => setOv('deviceName', e.target.value)} /></Field>
          <Field label="MAC 地址"><input className="inp" value={ov.mac || ''} onChange={(e) => setOv('mac', e.target.value)} placeholder="B8:CA:3A:80:8D:32" /></Field>
          <Field label="Do Not Track">
            <select className="inp" value={ov.doNotTrack === null ? '' : String(ov.doNotTrack)} onChange={(e) => setOv('doNotTrack', e.target.value === '' ? null : e.target.value === 'true')}>
              <option value="">默认</option>
              <option value="true">开启</option>
              <option value="false">关闭</option>
            </select>
          </Field>
        </div>
      </Section>
    </div>
  );
}

function AdvancedTab({ form, setField, setOv }) {
  const ov = form.fingerprintOverride;
  return (
    <div className="space-y-4">
      <Section title="启动参数">
        <Field label="额外 Chromium 启动参数（每行一个）">
          <textarea className="inp w-full" rows={4} value={form.launchArgs} onChange={(e) => setField('launchArgs', e.target.value)} placeholder="--disable-notifications" />
        </Field>
      </Section>

      <Section title="浏览器行为">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Toggle label="硬件加速" checked={ov.hardwareAcceleration !== false} onChange={(v) => setOv('hardwareAcceleration', v)} />
          <Toggle label="禁用 TLS 特性" checked={ov.tlsDisabled === true} onChange={(v) => setOv('tlsDisabled', v)} />
          <Toggle label="端口扫描保护" checked={ov.portScanProtection === true} onChange={(v) => setOv('portScanProtection', v)} />
          <Toggle label="随机指纹（每次启动重新生成）" checked={ov.randomFingerprint === true} onChange={(v) => setOv('randomFingerprint', v)} />
        </div>
      </Section>
    </div>
  );
}

// ---- helpers ----

// 解析整段代理字符串，支持：
//   IP:端口:用户:密码
//   socks5://IP:端口:用户:密码
//   用户:密码@IP:端口
//   IP:端口
function parseProxyString(raw) {
  if (!raw) return null;
  let s = raw.trim();
  let type = null;
  const scheme = s.match(/^(socks5|http|https):\/\/(.*)$/i);
  if (scheme) { type = scheme[1].toLowerCase(); s = scheme[2]; }

  if (s.includes('@')) {
    const idx = s.indexOf('@');
    const auth = s.slice(0, idx);
    const hostport = s.slice(idx + 1);
    const ac = auth.split(':');
    const [user, pass] = [ac[0] || '', ac.slice(1).join(':')];
    const hp = hostport.split(':');
    return { type, host: hp[0] || '', port: hp[1] || '', username: user, password: pass };
  }

  const parts = s.split(':');
  if (parts.length >= 4) {
    return {
      type,
      host: parts[0],
      port: parts[1],
      username: parts[2],
      password: parts.slice(3).join(':'),
    };
  }
  if (parts.length === 2) {
    return { type, host: parts[0], port: parts[1], username: '', password: '' };
  }
  return null;
}

function Section({ title, children }) {
  return (
    <div className="border border-edge rounded-lg p-4 bg-panel/40">
      <div className="text-sm font-semibold text-slate-200 mb-3">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      {children}
    </label>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-sky-500" />
      <span className="text-sm text-slate-300">{label}</span>
    </label>
  );
}

function emptyProfile() {
  return {
    name: '', group: 'default', tags: '', notes: '', seed: '',
    headless: false, proxyMode: 'inline', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome',
    startupUrls: '', cookieImport: '', launchArgs: '',
    launchBehavior: {
      restoreLastSession: false,
      blockVideo: false,
      blockImages: false,
      blockImagesThresholdKB: 10,
      clearCacheOnLaunch: false,
      cacheClearMode: 'none',
      clearCookies: false,
      hiddenWindow: false,
    },
    fingerprintOverride: {
      timezoneMode: 'ip',
      languageMode: 'ip',
      geolocation: { mode: 'ip' },
      webRtc: 'proxy',
    },
  };
}

function normalizeProfile(profile) {
  return {
    name: profile.name || '',
    group: profile.group || 'default',
    tags: Array.isArray(profile.tags) ? profile.tags.join(', ') : (profile.tags || ''),
    notes: profile.notes || '',
    seed: profile.seed || '',
    headless: profile.headless !== false,
    proxyMode: profile.proxyMode === 'custom' ? 'saved' : (profile.proxyMode || 'inline'),
    proxyId: profile.proxyId || null,
    proxyInline: (() => {
      const pi = profile.proxyInline || null;
      if (!pi) return null;
      if (pi.host && pi.port) return pi;
      // 兼容旧存储：server 是 host:port，需要拆回 host/port 才能在表单里显示
      if (pi.server) {
        const raw = String(pi.server).replace(/^[a-z0-9]+:\/\//i, '');
        const [host, port] = raw.split(':');
        return { ...pi, host: host || '', port: port || '' };
      }
      return pi;
    })(),
    os: profile.os || 'Windows',
    browser: profile.browser || 'Chrome',
    startupUrls: Array.isArray(profile.startupUrls) ? profile.startupUrls.join('\n') : (profile.startupUrls || ''),
    cookieImport: profile.cookieImport || '',
    launchArgs: Array.isArray(profile.launchArgs) ? profile.launchArgs.join('\n') : (profile.launchArgs || ''),
    launchBehavior: {
      restoreLastSession: false,
      blockVideo: false,
      blockImages: false,
      blockImagesThresholdKB: 10,
      clearCacheOnLaunch: false,
      cacheClearMode: 'none',
      clearCookies: false,
      hiddenWindow: false,
      ...(profile.launchBehavior || {}),
    },
    fingerprintOverride: (() => {
      const ov = profile.fingerprintOverride || {};
      const geo = { mode: 'ip', ...(ov.geolocation || {}) };
      return {
        timezoneMode: 'ip',
        languageMode: 'ip',
        webRtc: 'proxy',
        ...ov,
        geolocation: geo,
      };
    })(),
  };
}

function buildPayload(form) {
  const parseLines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const parseTags = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    name: form.name,
    group: form.group,
    tags: parseTags(form.tags),
    notes: form.notes,
    seed: form.seed || undefined,
    templateId: form.templateId || undefined,
    headless: form.headless,
    proxyMode: form.proxyMode,
    proxyId: form.proxyMode === 'saved' ? form.proxyId : null,
    proxyInline: form.proxyMode === 'inline' && form.proxyInline?.host && form.proxyInline?.port
      ? {
          type: form.proxyInline.type || 'socks5',
          server: `${form.proxyInline.host}:${form.proxyInline.port}`,
          username: form.proxyInline.username || '',
          password: form.proxyInline.password || '',
        }
      : null,
    os: form.os,
    browser: form.browser,
    startupUrls: parseLines(form.startupUrls),
    launchArgs: parseLines(form.launchArgs),
    launchBehavior: form.launchBehavior || {
      restoreLastSession: false,
      blockVideo: false,
      blockImages: false,
      blockImagesThresholdKB: 10,
      clearCacheOnLaunch: false,
      hiddenWindow: false,
    },
    fingerprintOverride: form.fingerprintOverride,
  };
}
