'use strict';

// 指纹伪装用到的真实数据池。数值取自真实浏览器分布，保证伪装自然。

const USER_AGENTS = [
  // Windows + Chrome
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.196 Safari/537.36', platform: 'Win32', os: 'Windows', browser: 'Chrome', vendor: 'Google Inc.' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.3619.0 Safari/537.36', platform: 'Win32', os: 'Windows', browser: 'Chrome', vendor: 'Google Inc.' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.3396.87 Safari/537.36', platform: 'Win32', os: 'Windows', browser: 'Chrome', vendor: 'Google Inc.' },
  // Windows + Edge
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.196 Safari/537.36 Edg/149.0.7827.196', platform: 'Win32', os: 'Windows', browser: 'Edge', vendor: 'Google Inc.' },
  // macOS + Chrome
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.196 Safari/537.36', platform: 'MacIntel', os: 'macOS', browser: 'Chrome', vendor: 'Google Inc.' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.3619.0 Safari/537.36', platform: 'MacIntel', os: 'macOS', browser: 'Chrome', vendor: 'Google Inc.' },
  // macOS + Safari
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15', platform: 'MacIntel', os: 'macOS', browser: 'Safari', vendor: 'Apple Computer, Inc.' },
  // Linux + Chrome
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.196 Safari/537.36', platform: 'Linux x86_64', os: 'Linux', browser: 'Chrome', vendor: 'Google Inc.' },
  // Android + Chrome
  { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.196 Mobile Safari/537.36', platform: 'Linux armv8l', os: 'Android', browser: 'Chrome', vendor: 'Google Inc.' },
  { ua: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.3619.0 Mobile Safari/537.36', platform: 'Linux armv8l', os: 'Android', browser: 'Chrome', vendor: 'Google Inc.' },
  // iOS + Safari
  { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', platform: 'iPhone', os: 'iOS', browser: 'Safari', vendor: 'Apple Computer, Inc.' },
  { ua: 'Mozilla/5.0 (iPad; CPU OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', platform: 'iPad', os: 'iOS', browser: 'Safari', vendor: 'Apple Computer, Inc.' },
];

// 屏幕分辨率（按 OS 分组，保持分辨率与平台一致）
const SCREENS = {
  // Windows 池已剔除 [1280,720]（STEP 19：该分辨率在 CreepJS hasVvpScreenRes 的
  // headless 默认尺寸名单内，随机命中会直接拉高 headless 判分）
  Windows: [[1920, 1080], [1536, 864], [1366, 768], [2560, 1440], [3840, 2160]],
  macOS: [[1440, 900], [2560, 1440], [1920, 1080], [1680, 1050], [2880, 1800], [3840, 2160]],
  Linux: [[1920, 1080], [1366, 768], [2560, 1440], [1280, 1024], [3840, 2160]],
  Android: [[1080, 2400], [1080, 2340], [1440, 3200], [720, 1600]],
  iOS: [[1179, 2556], [1170, 2532], [1284, 2778], [1488, 2246], [1536, 2048]],
};

// 像素比（与分辨率搭配）
const PIXEL_RATIOS = [1, 1, 1, 1.25, 1.5, 2, 2, 2.5, 3];

// 时区 -> UTC 偏移（分钟，Date.getTimezoneOffset 约定东区为负）
const TIMEZONES = [
  { tz: 'America/New_York', offset: -300 },
  { tz: 'America/Los_Angeles', offset: -480 },
  { tz: 'America/Chicago', offset: -360 },
  { tz: 'America/Denver', offset: -420 },
  { tz: 'America/Toronto', offset: -300 },
  { tz: 'Europe/London', offset: 0 },
  { tz: 'Europe/Berlin', offset: 60 },
  { tz: 'Europe/Paris', offset: 60 },
  { tz: 'Europe/Moscow', offset: 180 },
  { tz: 'Asia/Shanghai', offset: 480 },
  { tz: 'Asia/Tokyo', offset: 540 },
  { tz: 'Asia/Singapore', offset: 480 },
  { tz: 'Asia/Hong_Kong', offset: 480 },
  { tz: 'Australia/Sydney', offset: 600 },
  { tz: 'Pacific/Auckland', offset: 720 },
];

const LANGUAGES = [
  ['en-US', 'en'],
  ['en-GB', 'en'],
  ['zh-CN', 'zh'],
  ['zh-TW', 'zh'],
  ['de-DE', 'de'],
  ['fr-FR', 'fr'],
  ['ja-JP', 'ja'],
  ['es-ES', 'es'],
  ['ru-RU', 'ru'],
  ['pt-BR', 'pt'],
  ['ko-KR', 'ko'],
];

// 常见系统字体（用于 navigator.plugins / fonts 枚举）
const FONT_SETS = {
  Windows: ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana', 'Microsoft YaHei', 'SimSun', 'Segoe Print', 'Segoe Script'],
  macOS: ['Helvetica Neue', '.SF NS', 'Menlo', 'Monaco', 'Arial', 'Times New Roman', 'Geneva', 'Lucida Grande', 'PingFang SC', 'STHeiti'],
  Linux: ['DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Cantarell', 'Arial', 'FreeSans', 'Noto Sans', 'Noto Serif CJK SC'],
  Android: ['Roboto', 'Noto Sans', 'Droid Sans', 'Arial', 'Source Sans Pro'],
  iOS: ['.SF UI Text', '.SF UI Display', 'Helvetica Neue', 'Arial', 'Menlo', 'PingFang SC'],
};

// WebGL 显卡分布
const WEBGL = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Apple Inc.', renderer: 'Apple GPU' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

// CPU 核心数 / RAM (GB)
const HARDWARE_CONCURRENCY = [4, 6, 8, 8, 10, 12, 16, 24];
const DEVICE_MEMORY = [4, 8, 8, 16, 16, 32];

// 设备名称
const DEVICE_NAMES = {
  Windows: ['DESKTOP-QRE2GC9', 'DESKTOP-A1B2C3D', 'LAPTOP-XYZ1234', 'WORKSTATION-88', 'PC-2024HOME'],
  macOS: ['MacBook-Pro-16', 'MacBook-Air-M2', 'iMac-24-2023', 'Mac-mini-M1', 'MacBook-Pro-14'],
  Linux: ['ubuntu-desktop', 'fedora-workstation', 'debian-pc', 'linux-devbox', 'pop-os'],
  Android: ['Pixel 8', 'SM-S918B', 'Mi 13', 'OnePlus 12', 'Galaxy S24'],
  iOS: ['iPhone 15 Pro', 'iPhone 14', 'iPad Pro 12.9', 'iPhone 15', 'iPad Air 5'],
};

// 地理位置分布
const GEOLOCATIONS = [
  { lat: 40.7128, lng: -74.0060, accuracy: 100 },      // New York
  { lat: 34.0522, lng: -118.2437, accuracy: 500 },      // Los Angeles
  { lat: 51.5074, lng: -0.1278, accuracy: 200 },        // London
  { lat: 52.5200, lng: 13.4050, accuracy: 300 },        // Berlin
  { lat: 48.8566, lng: 2.3522, accuracy: 250 },         // Paris
  { lat: 31.2304, lng: 121.4737, accuracy: 200 },       // Shanghai
  { lat: 35.6762, lng: 139.6503, accuracy: 300 },       // Tokyo
  { lat: 1.3521, lng: 103.8198, accuracy: 500 },        // Singapore
  { lat: -33.8688, lng: 151.2093, accuracy: 400 },      // Sydney
];

// MAC 地址
const MAC_PREFIXES = ['B8-CA-3A', 'A4-5E-60', '3C-5A-B4', '00-1A-2B', 'D4-6D-6D', '90-9A-4A', '5C-87-9C'];

module.exports = {
  USER_AGENTS, SCREENS, PIXEL_RATIOS, TIMEZONES, LANGUAGES,
  FONT_SETS, WEBGL, HARDWARE_CONCURRENCY, DEVICE_MEMORY,
  DEVICE_NAMES, GEOLOCATIONS, MAC_PREFIXES,
};
