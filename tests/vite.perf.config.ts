/** 文件职责：构建不受开发热更新干扰的浏览器性能验收页面。 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: { outDir: 'dist-perf', rollupOptions: { input: resolve(process.cwd(), 'tests/browser-performance.html') } },
  preview: { host: '127.0.0.1', port: 1421, strictPort: true },
});
