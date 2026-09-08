/** @type {import('tailwindcss').Config} */
// UI 高级化重构（2026-09-09）：AI Workspace 设计系统 tokens
// 原则：空间产生层级，边框只做极弱分隔；近黑非纯黑；状态色只用于点/文字/极轻背景。
// 兼容性：保留 ink/panel/edge 三个历史 token 名（17 个现有面板零改动继承新配色）。
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0B0C10',      // 页面背景（近黑，非纯黑）
        panel: '#12141A',    // 卡片/面板表面
        raised: '#181B22',   // 悬浮/次级表面
        edge: '#21242D',     // 极弱边框
        accent: '#4D7CF6',   // 唯一交互强调色（克制蓝）
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', '-apple-system', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
      },
      maxWidth: {
        page: '1400px',
      },
    },
  },
  plugins: [],
};
