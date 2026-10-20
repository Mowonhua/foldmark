import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

/** 字体按需加载，许可随安装包分发；开发服务与构建产物使用相同资源路径。 */
function canvasRuntimeAssets() {
  const directory = resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts');
  const licenses = resolve('docs/licenses/canvas');
  // 引擎的 Helvetica 映射沿用原路径，实际提供基于 Liberation Sans 2 的本地 OFL 字体。
  const fontSource = (name: string) => name.split(sep).join('/') === 'Liberation/LiberationSans-Regular.woff2'
    ? resolve('third_party/canvas-fonts/LiberationSans-Regular.woff2') : resolve(directory, name);
  return {
    name: 'taskrail-canvas-runtime-assets',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/canvas-assets/fonts', (request, response, next) => {
        const path = resolve(directory, `.${decodeURIComponent(request.url?.split('?')[0] ?? '')}`);
        const name = relative(directory, path);
        if (name.startsWith(`..${sep}`) || name === '..' || !/\.woff2$/.test(name)) { next(); return; }
        try { response.setHeader('Content-Type', 'font/woff2'); response.setHeader('Cache-Control', 'public,max-age=86400'); response.end(readFileSync(fontSource(name))); }
        catch { next(); }
      });
    },
    generateBundle(this: import('rollup').PluginContext) {
      for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.woff2')) continue;
        const source = resolve(entry.parentPath, entry.name);
        const name = relative(directory, source);
        this.emitFile({ type: 'asset', fileName: `canvas-assets/fonts/${name.split(sep).join('/')}`, source: readFileSync(fontSource(name)) });
      }
      for (const entry of readdirSync(licenses, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const source = resolve(entry.parentPath, entry.name);
        this.emitFile({ type: 'asset', fileName: `canvas-assets/licenses/${relative(licenses, source).split(sep).join('/')}`, source: readFileSync(source) });
      }
    },
  };
}

export default defineConfig({
  plugins: [svelte(), canvasRuntimeAssets()],
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  clearScreen: false,
});
