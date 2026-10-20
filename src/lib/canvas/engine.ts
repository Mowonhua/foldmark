/**
 * 文件职责：把 Excalidraw 的渲染、历史和图片缓存封装为应用画布引擎。
 * 定义范围：延迟挂载、场景提交、局部阅读状态、主题更新及 PNG 导出。
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, MainMenu, FONT_FAMILY, CaptureUpdateAction, convertToExcalidrawElements, exportToBlob, getSceneVersion } from '@excalidraw/excalidraw';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import { CanvasSaveQueue, type CanvasBinaryFile } from './save-queue';
import type { CanvasEngine, CanvasEngineOptions } from './engine-port';
import { translate } from '../i18n';
import { MAX_CANVAS_IMAGE_BYTES, validateCanvasImage } from './assets';
import type { CanvasImageMime } from './types';

/** 阅读位置仅存内存，不随正文同步；有界缓存避免长期打开不同画布导致增长。 */
const positions = new Map<string, Pick<AppState, 'scrollX' | 'scrollY' | 'zoom'>>();

function imageDataURL(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * 函数职责：只在画布展开时挂载完整渲染引擎，并从附件恢复图片。
 * 输入说明：host 独占引擎 DOM；附件必须属于当前文档所在目录。
 * 输出说明：返回保存及卸载接口；图片恢复失败时不挂载空白可编辑场景。
 * 实现思路：先读取附件，再创建局部 React 根；场景版本变化交给串行保存队列。
 */
export async function mountCanvasEngine(options: CanvasEngineOptions): Promise<CanvasEngine> {
  // 字体全部由 Vite 同源提供，离线应用不能依赖 Excalidraw 默认 CDN。
  (window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL('canvas-assets/', document.baseURI).href;
  const initialFiles: BinaryFiles = {};
  const needed = new Set(options.session.document.elements.filter(element => element.type === 'image' && !element.isDeleted).map(element => String(element.fileId)));
  const loaded = new Map<string, string>();
  // 只恢复当前图形实际使用的图片；串行读取避免打开时同时持有全部原始二进制副本。
  for (const id of needed) {
    const asset = options.session.document.files[id];
    let dataURL = loaded.get(asset.id);
    if (!dataURL) {
      const bytes = await options.assets.read(options.documentPath, asset);
      dataURL = imageDataURL(bytes, asset.mimeType); loaded.set(asset.id, dataURL);
    }
    initialFiles[id] = { id: id as BinaryFileData['id'], dataURL: dataURL as BinaryFileData['dataURL'], mimeType: asset.mimeType, created: asset.created };
  }
  const root = createRoot(options.host);
  const queue = new CanvasSaveQueue(options);
  for (const [id, file] of Object.entries(initialFiles)) queue.rememberFile(id, file.dataURL, options.session.document.files[id]);
  let api: ExcalidrawImperativeAPI | undefined;
  let title = options.session.document.title;
  let version: number | undefined;
  let theme = options.theme;
  let language = options.language;
  let disposed = false;
  let locked = false;
  const imports = new Set<Promise<void>>();
  let importTail = Promise.resolve();
  const key = `${options.documentPath}\n${options.session.document.id}`;
  const position = positions.get(key);
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const scene = () => {
    if (!api) return;
    queue.update({ elements: api.getSceneElementsIncludingDeleted() as unknown as Record<string, unknown>[], files: api.getFiles() as Record<string, CanvasBinaryFile>, title });
  };
  const render = () => root.render(createElement(Excalidraw, {
    initialData: {
      elements: options.session.document.elements as unknown as ExcalidrawElement[],
      files: initialFiles,
      appState: { ...position, viewBackgroundColor: 'transparent', currentItemRoughness: 0, currentItemStrokeWidth: 1, currentItemFontFamily: FONT_FAMILY.Helvetica },
      scrollToContent: !position,
    },
    excalidrawAPI: (value: ExcalidrawImperativeAPI) => { api = value; resolveReady(); },
    langCode: language === 'en' ? 'en' : 'zh-CN', theme,
    viewModeEnabled: options.session.readOnly || locked,
    handleKeyboardGlobally: false,
    autoFocus: true,
    aiEnabled: false,
    validateEmbeddable: false,
    onLinkOpen: (_element, event) => { event.preventDefault(); },
    // 原生保存、导入和分享必须经过宿主附件与文档协调器，不能启动独立文件会话。
    UIOptions: { canvasActions: { changeViewBackgroundColor: false, loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false }, tools: { image: false } },
    onChange: (elements, _state, files) => {
      const next = getSceneVersion(elements);
      if (version === undefined) { version = next; return; }
      if (disposed || options.session.readOnly || next === version) return;
      version = next;
      queue.update({ elements: elements as unknown as Record<string, unknown>[], files: files as Record<string, CanvasBinaryFile>, title });
    },
    onPointerDown: () => queue.setInteracting(true),
    onPointerUp: () => queue.setInteracting(false),
    onPaste: data => {
      const invalid = Object.values(data.files ?? {}).some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType));
      if (invalid) { options.onStatus('error', new Error(translate('仅支持 PNG、JPEG 和 WebP 图片。'))); return false; }
      return true;
    },
  }, createElement(MainMenu, null, createElement(MainMenu.DefaultItems.ClearCanvas))));
  render();
  await ready;
  return {
    setTitle(value) { if (title !== value) { title = value; scene(); } },
    setLocked(value) { if (locked !== value && !disposed) { locked = value; render(); } },
    addImage(file) {
      if (!api || locked || options.session.readOnly || disposed) return Promise.reject(new Error(translate('画布当前无法编辑。')));
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > MAX_CANVAS_IMAGE_BYTES) return Promise.reject(new Error(translate('请选择不超过 20 MiB 的 PNG、JPEG 或 WebP 图片。')));
      const task = importTail.catch(() => {}).then(async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        validateCanvasImage(bytes, file.type as CanvasImageMime);
        const asset = await options.assets.put(options.documentPath, bytes, file.type as CanvasImageMime);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: asset.mimeType }));
        const width = bitmap.width, height = bitmap.height; bitmap.close();
        if (disposed || !api) return;
        const dataURL = imageDataURL(bytes, asset.mimeType);
        queue.rememberFile(asset.id, dataURL, asset);
        api.addFiles([{ id: asset.id as BinaryFileData['id'], dataURL: dataURL as BinaryFileData['dataURL'], mimeType: asset.mimeType, created: asset.created }]);
        const state = api.getAppState();
        const scale = Math.min(1, 640 / Math.max(width, height));
        const shape = convertToExcalidrawElements([{ type: 'image', x: options.host.clientWidth / state.zoom.value / 2 - state.scrollX - width * scale / 2,
          y: options.host.clientHeight / state.zoom.value / 2 - state.scrollY - height * scale / 2, width: width * scale, height: height * scale,
          fileId: asset.id as BinaryFileData['id'], status: 'saved' }]);
        api.updateScene({ elements: [...api.getSceneElements(), ...shape], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        // 加载中的图片属于退出屏障之前已接受的输入，即使页面锁定也必须提交。
        scene();
      });
      importTail = task;
      imports.add(task);
      void task.finally(() => imports.delete(task)).catch(() => {});
      return task;
    },
    setAppearance(nextTheme, nextLanguage) {
      if (disposed || theme === nextTheme && language === nextLanguage) return;
      theme = nextTheme; language = nextLanguage; render();
    },
    canCloseWithEscape() {
      const state = api?.getAppState();
      return !state || state.activeTool.type === 'selection' && !state.editingTextElement && !state.openMenu && !state.openDialog && !Object.keys(state.selectedElementIds).length;
    },
    async flush() {
      try { await Promise.all([...imports]); return await queue.flush(); }
      catch (cause) { options.onStatus('error', cause instanceof Error ? cause : new Error(String(cause))); return false; }
    },
    async exportPNG() {
      if (!api) throw new Error(translate('画布尚未加载完成。'));
      // 导出比例有上限，避免巨大坐标场景申请超大位图；正文和附件保持原始精度。
      return exportToBlob({ elements: api.getSceneElements(), files: api.getFiles(), mimeType: 'image/png', maxWidthOrHeight: 4096,
        appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false, exportEmbedScene: false } });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (api) {
        const state = api.getAppState();
        positions.delete(key); positions.set(key, { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom });
        if (positions.size > 32) positions.delete(positions.keys().next().value!);
      }
      queue.dispose(); root.unmount(); api = undefined;
    },
  };
}
