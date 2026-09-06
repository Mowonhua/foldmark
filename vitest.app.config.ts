/**
 * 文件职责：在浏览器条件下编译真实 Svelte App，执行独立的应用集成验收。
 * 定义范围：Svelte 转换、jsdom 环境与 App 测试范围；不影响纯内核测试配置。
 */
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: { conditions: ['browser'] },
  test: {
    include: ['src/lib/session/app-integration.test.ts'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/', pretendToBeVisual: true } },
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
