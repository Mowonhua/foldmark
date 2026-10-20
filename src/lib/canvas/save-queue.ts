/**
 * 文件职责：把画布的高频变化合并为有序的正文提交。
 * 定义范围：内存图片、保存状态和附件先于正文的提交队列。
 */
import type { CanvasAsset, CanvasAssetPort, CanvasDocument, CanvasImageMime, CanvasSession } from './types';
import { translate } from '../i18n';
import { MAX_CANVAS_IMAGE_BYTES } from './assets';

/** 结构职责：承载编辑引擎尚未写入附件的图片；dataURL 只存在内存，不进入 Markdown。 */
export interface CanvasBinaryFile { id: string; dataURL: string; mimeType: string; created: number }
/** 结构职责：描述一次场景变化；图形快照保留引擎字段，不包含视口和工具状态。 */
export interface CanvasScene { elements: readonly Record<string, unknown>[]; files: Record<string, CanvasBinaryFile>; title: string }
/** 结构职责：区分正文已提交、待提交和失败；saved 不代表磁盘已写入，磁盘状态由原保存器维护。 */
export type CanvasSaveStatus = 'saved' | 'dirty' | 'saving' | 'error';
/** 接口职责：向保存队列提供正文会话、附件目录和状态反馈；同一实例只属于一个打开会话。 */
export interface CanvasSaveOptions {
  session: CanvasSession;
  documentPath: string;
  assets: CanvasAssetPort;
  onStatus(status: CanvasSaveStatus, error?: Error): void;
}

/**
 * 接口职责：在交互完成或退出前提交最新画布，附件成功落盘后才写正文。
 * 调用方：全页画布和应用退出保存屏障。
 * 实现要求：队列串行；失败保留待提交场景；拖动中的状态不写正文。
 */
export class CanvasSaveQueue {
  private latest: CanvasScene | null = null;
  private pending: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interacting = false;
  private disposed = false;
  private saved: CanvasDocument;
  private known = new Map<string, { source: string; asset: CanvasAsset }>();
  constructor(private readonly options: CanvasSaveOptions) { this.saved = options.session.document; }

  /** 受控图片导入已经完成附件落盘，登记后无需在场景提交时再次散列与写入。 */
  rememberFile(id: string, source: string, asset: CanvasAsset): void { this.known.set(id, { source, asset }); }

  /** 高频回调只保留最新引用；序列化与图片解码推迟到交互结束后的保存阶段。 */
  update(scene: CanvasScene): void {
    if (this.disposed || this.options.session.readOnly) return;
    this.latest = scene;
    this.options.onStatus('dirty');
    clearTimeout(this.timer);
    if (!this.interacting) this.timer = setTimeout(() => { void this.flush(); }, 400);
  }
  setInteracting(active: boolean): void {
    this.interacting = active;
    clearTimeout(this.timer);
    if (!active && this.latest) this.timer = setTimeout(() => { void this.flush(); }, 0);
  }
  /** 退出屏障可在指针未松开时调用，明确提交最后一个可见场景；失败允许原地重试。 */
  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    this.pending = this.save().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async save(): Promise<boolean> {
    while (this.latest && !this.disposed) {
      const scene = this.latest; this.latest = null;
      // 引擎可能在异步附件写入期间更新对象；固定本次快照，下一轮单独处理后续变化。
      const elements = structuredClone(scene.elements.filter(element => !element.isDeleted));
      const files = { ...scene.files };
      this.options.onStatus('saving');
      try {
        const assets: Record<string, CanvasAsset> = {};
        for (const element of elements) {
          if (element.type !== 'image' || typeof element.fileId !== 'string') continue;
          const id = element.fileId;
          if (Object.hasOwn(assets, id)) continue;
          const file = Object.hasOwn(files, id) ? files[id] : undefined;
          const known = this.known.get(id);
          if (known && (!file || known.source === file.dataURL)) assets[id] = known.asset;
          else if (!file && Object.hasOwn(this.saved.files, id) && !known) {
            assets[id] = this.saved.files[id];
          } else {
            if (!file) throw new Error(translate('图片数据缺失，请重新插入图片。'));
            const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/.exec(file.dataURL);
            if (!match || match[1] !== file.mimeType) throw new Error(translate('仅支持 PNG、JPEG 和 WebP 图片。'));
            if (match[2].length > Math.ceil(MAX_CANVAS_IMAGE_BYTES / 3) * 4) throw new Error(translate('请选择不超过 20 MiB 的 PNG、JPEG 或 WebP 图片。'));
            const binary = atob(match[2]);
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
            assets[id] = await this.options.assets.put(this.options.documentPath, bytes, match[1] as CanvasImageMime);
            this.known.set(id, { source: file.dataURL, asset: assets[id] });
          }
        }
        const next: CanvasDocument = { ...this.saved, title: scene.title, elements, files: assets };
        if (!this.options.session.commit(next)) throw new Error(translate('画布原文已变化，当前编辑已保留，请先导出画布。'));
        this.saved = next;
      } catch (cause) {
        this.latest ??= scene;
        this.options.onStatus('error', cause instanceof Error ? cause : new Error(String(cause)));
        return false;
      }
    }
    if (!this.disposed) this.options.onStatus('saved');
    return true;
  }
  dispose(): void { clearTimeout(this.timer); this.disposed = true; this.known.clear(); }
}
