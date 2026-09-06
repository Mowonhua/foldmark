/** 文件职责：独立运行编辑器基准，普通行为测试不执行性能采样。 */
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/lib/editor/*.perf.ts'], environment: 'jsdom' } });
