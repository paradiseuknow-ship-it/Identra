'use strict';

// 根据国家代码推语言（覆盖主流市场）
const COUNTRY_LANG = {
  US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', IE: 'en-IE', ZA: 'en-ZA', SG: 'en-SG', IN: 'en-IN',
  CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', MO: 'zh-HK',
  JP: 'ja-JP', KR: 'ko-KR',
  DE: 'de-DE', AT: 'de-DE', CH: 'de-CH',
  FR: 'fr-FR', BE: 'fr-BE', LU: 'fr-FR',
  ES: 'es-ES', MX: 'es-MX', AR: 'es-AR', CL: 'es-CL', CO: 'es-CO', PE: 'es-PE', VE: 'es-VE',
  IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR',
  RU: 'ru-RU', UA: 'uk-UA', BY: 'be-BY', KZ: 'ru-RU',
  NL: 'nl-NL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', PL: 'pl-PL',
  CZ: 'cs-CZ', SK: 'sk-SK', HU: 'hu-HU', RO: 'ro-RO', BG: 'bg-BG', HR: 'hr-HR', SI: 'sl-SI',
  GR: 'el-GR', TR: 'tr-TR', IL: 'he-IL', AE: 'ar-AE', SA: 'ar-SA', EG: 'ar-EG',
  TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID', MY: 'ms-MY', PH: 'en-PH',
};

function countryToLanguage(code) {
  if (!code) return null;
  return COUNTRY_LANG[code.toUpperCase()] || null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function normalizeIpApi(d) {
  const lang = countryToLanguage(d.countryCode);
  return {
    ip: d.query,
    country: d.country,
    countryCode: d.countryCode,
    region: d.regionName,
    city: d.city,
    zip: d.zip,
    lat: d.lat,
    lng: d.lon,
    timezone: d.timezone,
    offset: Math.round(d.offset / 60), // ip-api 返回秒，转成分钟
    language: lang,
    isp: d.isp,
    org: d.org,
  };
}

function parseUtcOffset(str) {
  if (!str) return 0;
  const m = String(str).match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = parseInt(m[2], 10);
  const mins = parseInt(m[3], 10);
  return sign * (hours * 60 + mins);
}

function normalizeIpapiCo(d) {
  const offsetMin = parseUtcOffset(d.utc_offset);
  const lang = countryToLanguage(d.country_code);
  return {
    ip: d.ip,
    country: d.country_name,
    countryCode: d.country_code,
    region: d.region,
    city: d.city,
    zip: d.postal,
    lat: parseFloat(d.latitude),
    lng: parseFloat(d.longitude),
    timezone: d.timezone,
    offset: offsetMin,
    language: lang,
    isp: d.org,
    org: d.org,
  };
}

async function lookupIp(ip) {
  // 1) ip-api.com（免费，限非商业/低速）
  try {
    const data = await fetchJson(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,offset,isp,org,as,query`);
    if (data && data.status === 'success') return normalizeIpApi(data);
  } catch (e) {}

  // 2) ipapi.co
  try {
    const data = await fetchJson(`https://ipapi.co/${ip}/json/`);
    if (data && data.ip && !data.error) return normalizeIpapiCo(data);
  } catch (e) {}

  return null;
}

module.exports = { lookupIp, countryToLanguage, COUNTRY_LANG };
