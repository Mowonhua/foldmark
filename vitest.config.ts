import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: ['src/lib/session/app-integration.test.ts'], environment: 'jsdom' } });
