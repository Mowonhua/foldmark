/**
 * 文件职责：定义内嵌画布的持久化数据与平台无关的附件端口。
 * 定义范围：画布快照、图片引用、画布打开会话和附件读写契约。
 */

/** 结构职责：限定可离线解码的静态图片类型；不接收可执行 SVG 或外部 URL。 */
export type CanvasImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * 结构职责：指向同目录共享附件中的不可变图片。
 * 字段说明：id 为原始字节的 SHA-256；path 为 .assets/ 下的内容寻址相对路径。
 * 约束条件：路径不可逃逸附件目录，mimeType 必须与实际图片格式一致；持久化数据不含 data URL。
 */
export interface CanvasAsset {
  id: string;
  path: string;
  mimeType: CanvasImageMime;
  size: number;
  created: number;
}

/**
 * 结构职责：保存一张可独立搬运的自由白板。
 * 字段说明：elements 为编辑引擎的图形快照，files 按图形引用的文件标识索引附件。
 * 约束条件：version 固定为 1；id 在文档内稳定；工具、选区、缩放与滚动不进入正文。
 */
export interface CanvasDocument {
  version: 1;
  id: string;
  title: string;
  elements: readonly Record<string, unknown>[];
  files: Record<string, CanvasAsset>;
}

/**
 * 接口职责：隔离画布编辑与桌面、Android、浏览器的附件持久化。
 * 调用方：画布会话、完整文档导入导出及附件同步适配器。
 * 实现要求：先完整校验并保存附件再返回引用；相同内容复用；读取验证摘要，失败保留旧数据。
 */
export interface CanvasAssetPort {
  put(documentPath: string, bytes: Uint8Array, mimeType: CanvasImageMime): Promise<CanvasAsset>;
  read(documentPath: string, asset: CanvasAsset): Promise<Uint8Array>;
}

/**
 * 结构职责：把画布卡片连接到唯一的正文编辑会话。
 * 字段说明：commit 以打开时及最近提交的块快照校验，外部修改或块删除后拒绝覆盖。
 * 约束条件：只读会话禁止 commit；close 必须恢复正文阅读位置，展开状态不写正文历史。
 */
export interface CanvasSession {
  document: CanvasDocument;
  readOnly: boolean;
  commit(next: CanvasDocument): boolean;
  close(): void;
}
