import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // 默认 vite 会清空 outDir（删除历史 hash 产物）。在带 safe-delete 守卫的环境里，
    // dist/assets 累积后清空动作会触发 bulk-delete 拦截，导致构建被拒。
    // 需要「零删除构建」时：FPB_NO_EMPTY_OUT_DIR=1 npm run build（旧 hash 文件保留，不影响正确性）。
    emptyOutDir: process.env.FPB_NO_EMPTY_OUT_DIR !== '1',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.FPB_API_URL || 'http://localhost:8787',
    },
  },
});
