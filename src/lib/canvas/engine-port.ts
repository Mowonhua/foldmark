/**
 * 文件职责：定义延迟加载的白板引擎与应用之间的窄接口。
 * 定义范围：引擎挂载参数、保存屏障、图像导出和生命周期。
 */
import type { CanvasAssetPort, CanvasSession } from './types';
import type { CanvasSaveStatus } from './save-queue';

/** 结构职责：提供当前会话和界面外观；主题只影响控件，不修改已绘制图形的颜色。 */
export interface CanvasEngineOptions {
  host: HTMLElement;
  session: CanvasSession;
  documentPath: string;
  assets: CanvasAssetPort;
  theme: 'light' | 'dark';
  language: 'zh-CN' | 'en';
  onStatus(status: CanvasSaveStatus, error?: Error): void;
}
/**
 * 接口职责：隐藏具体渲染框架和图片缓存，向应用提供关闭前的保存屏障。
 * 调用方：全页画布；dispose 只能在成功 flush 或宿主销毁时调用。
 * 实现要求：外观更新不写正文；导出不触发下载；卸载后不保留 React 或画布监听器。
 */
export interface CanvasEngine {
  setTitle(title: string): void;
  /** 导入任务在首个异步操作前登记，退出保存屏障会等待附件与图形同时就绪。 */
  addImage(file: File): Promise<void>;
  setLocked(locked: boolean): void;
  setAppearance(theme: 'light' | 'dark', language: 'zh-CN' | 'en'): void;
  canCloseWithEscape(): boolean;
  flush(): Promise<boolean>;
  exportPNG(): Promise<Blob>;
  dispose(): void;
}
