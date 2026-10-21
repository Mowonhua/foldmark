/**
 * 文件职责：把同步文档操作接入现有配置、编辑会话与保存协调器。
 * 定义范围：路径只在此端口解析，远端请求不能指定本机文件路径。
 */
import type { AppConfig, FilePort, Project } from '../contracts';
import type { ProjectSession } from './types';
import type { DocumentContent, SyncAttachment, SyncDocumentPort } from '../sync/contracts';
import type { CanvasAsset, CanvasAssetPort } from '../canvas/types';
import { canvasAssetsFromText } from '../canvas/model';
import { verifyCanvasAssetBytes } from '../canvas/assets';
import { sameContent } from '../sync/merge';
export interface SyncDocumentOptions {
  files: FilePort;
  /** 画布附件使用与编辑器相同的持久化端口；无图片的旧文档不依赖此端口。 */
  assets?: CanvasAssetPort;
  config(): AppConfig;
  session(id: string): ProjectSession | undefined;
  capture(): void;
  composing(id: string): boolean;
  persist(): Promise<boolean>;
  changed(): void;
  inspiration(): Promise<string>;
  receivePath(name: string): Promise<string | null>;
}
export class SessionSyncDocuments implements SyncDocumentPort {
  /** 无本地修改时按磁盘基线指纹缓存正文；打开文档的监听器保持基线新鲜，写入路径不经过缓存。 */
  private cached = new Map<string, { token: string; content: DocumentContent }>();
  constructor(private readonly options: SyncDocumentOptions) {}
  private token(revision: string, project: Project): string { return `${revision}\n${project.name}\n${project.archived ?? false}`; }
  private project(id: string): Project {
    const config = this.options.config();
    const project = id === 'inspiration' && config.inspiration ? { id, name: '灵感', path: config.inspiration.path } : config.projects.find(project => project.id === id);
    if (!project) throw new Error('SYNC_MISSING: 项目关联已移除，已暂停同步');
    return project;
  }
  async read(id: string): Promise<DocumentContent> {
    this.options.capture();
    const project = this.project(id); const session = this.options.session(id);
    // 正在输入或编辑画布只是暂时不可读，交互结束后同步会自动补上，不能记成待处理错误。
    if (this.options.composing(id)) throw new Error('SYNC_DEFER: 正在输入或编辑画布');
    if (session?.saver.hasProtectedRecovery) throw new Error('SYNC_BUSY: 正在输入或有待处理草稿');
    // 每轮同步多次读取同一文档；基线指纹与项目资料未变时跳过整轮读盘与草稿检查。
    if (session && !session.saver.hasLocalChanges) {
      const hit = this.cached.get(id);
      if (hit?.token === this.token(session.saver.diskSnapshot.revision, project)) return hit.content;
    }
    if (session) {
      await session.saver.checkExternal();
      if (!await session.saver.flush()) throw new Error('SYNC_SAVE: 请先处理本机保存失败或冲突');
    }
    const snapshot = await this.options.files.read(project.path);
    const draft = await this.options.files.loadRecovery(project.path);
    if (draft && draft.text !== snapshot.text) throw new Error('SYNC_BUSY: 本机有尚未保存的输入或草稿');
    if (session?.saver.hasLocalChanges || this.options.composing(id)) throw new Error('SYNC_DEFER: 本机有尚未保存的输入');
    const current = this.project(id);
    const content = { text: snapshot.text, name: current.name, archived: current.archived ?? false };
    if (session) this.cached.set(id, { token: this.token(snapshot.revision, current), content });
    return content;
  }
  async apply(id: string, expected: DocumentContent, next: DocumentContent): Promise<void> {
    if (!sameContent(await this.read(id), expected)) throw new Error('SYNC_CHANGED: 本机内容或项目资料已变化');
    const project = this.project(id); const session = this.options.session(id);
    for (const asset of canvasAssetsFromText(next.text)) await this.readAsset(id, asset);
    if (session) await session.saver.applySynchronized(expected.text, next.text);
    else {
      const snapshot = await this.options.files.read(project.path);
      if (snapshot.text !== expected.text) throw new Error('SYNC_CHANGED: 外部文件已变化');
      await this.options.files.write(project.path, next.text, snapshot.revision);
    }
    const current = this.project(id);
    if (current.name !== expected.name || (current.archived ?? false) !== expected.archived) throw new Error('SYNC_CHANGED: 同步期间项目资料已变化');
    if (id !== 'inspiration') {
      current.name = next.name; current.archived = next.archived;
      if (session) session.project = current;
    }
    if (!await this.options.persist()) throw new Error('SYNC_SAVE: 项目资料保存失败');
    this.options.changed();
  }
  async readAsset(id: string, asset: CanvasAsset): Promise<Uint8Array> {
    if (!this.options.assets) throw new Error('SYNC_SAVE: 画布图片存储不可用');
    return this.options.assets.read(this.project(id).path, asset);
  }
  async writeAsset(id: string, attachment: SyncAttachment): Promise<void> {
    await this.saveAttachments(this.project(id).path, [attachment]);
  }
  /** 附件摘要由引用确定；保存后再读原引用，禁止只比较 put 返回值便放行正文。 */
  private async saveAttachments(path: string, attachments: SyncAttachment[]): Promise<void> {
    if (!attachments.length) return;
    const assets = this.options.assets;
    if (!assets) throw new Error('SYNC_SAVE: 画布图片存储不可用');
    for (const { asset, bytes } of attachments) {
      await verifyCanvasAssetBytes(bytes, asset);
      await assets.put(path, bytes, asset.mimeType);
      await assets.read(path, asset);
    }
  }
  async accept(documentId: string, kind: 'project' | 'inspiration', content: DocumentContent, attachments: SyncAttachment[] = []): Promise<string | null> {
    if (kind === 'inspiration') { const path = await this.options.inspiration(); await this.saveAttachments(path, attachments); return 'inspiration'; }
    const config = this.options.config();
    // 文件和配置已保存、同步日志尚未保存时重试，复用明确 ID，不能按同名猜测关联。
    if (config.projects.some(project => project.id === documentId)) return documentId;
    const path = await this.options.receivePath(content.name); if (!path) return null;
    await this.saveAttachments(path, attachments);
    for (const asset of canvasAssetsFromText(content.text)) {
      if (!this.options.assets) throw new Error('SYNC_SAVE: 画布图片存储不可用');
      await this.options.assets.read(path, asset);
    }
    await this.options.files.create(path, content.text);
    config.projects = [...config.projects, { id: documentId, path, name: content.name, archived: content.archived }];
    if (!await this.options.persist()) throw new Error('SYNC_SAVE: 接收项目配置保存失败，文件已保留');
    this.options.changed(); return documentId;
  }
}
