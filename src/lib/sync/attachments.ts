/**
 * 文件职责：协调画布图片的缺失请求、限额分块与完整性校验。
 * 定义范围：附件交换状态与写入正文前的附件准备，不解析本机路径。
 */
import type { CanvasAsset } from '../canvas/types';
import { canvasAssetsFromText } from '../canvas/model';
import { verifyCanvasAssetBytes } from '../canvas/assets';
import type { AssetRequest, SyncAttachment, SyncDocumentPort, SyncEnvelope } from './contracts';

export const ASSET_CHUNK_BYTES = 256 * 1024;
/** 接收字节缓存上限；重启丢弃未完成字节，并从零重新请求，不形成半成品附件。 */
export const ASSET_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * 接口职责：为版本交换隔离附件传输；版本引擎仍独占文档状态与确认。
 * 调用方：同步引擎的 offer、receive、apply 和 accept。
 * 实现要求：只接收已请求且属于正文的附件，完成摘要校验后才返回字节。
 */
export class AttachmentExchange {
  private wanted = new Map<string, { request: AssetRequest; asset: CanvasAsset; bytes?: Uint8Array }>();
  private complete = new Map<string, Uint8Array>();
  /** 只有尚无持久化副本的文档保留完整字节；接收、撤回或换版后立即释放无引用缓存。 */
  private waiting = new Map<string, Set<string>>();
  private verifiedLocal = new Set<string>();
  private requests: AssetRequest[] = [];
  /** 发送方向只保留最近一张图片，避免每个块重新读盘；单图已由附件契约限制为 20 MiB。 */
  private source?: { id: string; documentId: string; bytes: Uint8Array };
  private supported?: boolean;
  constructor(private readonly port: SyncDocumentPort) {}
  get pending(): boolean { return this.wanted.size > 0 || this.requests.length > 0; }
  get peerSupportsAssets(): boolean { return this.supported === true; }
  reset(): void { this.wanted.clear(); this.complete.clear(); this.waiting.clear(); this.verifiedLocal.clear(); this.requests = []; this.source = undefined; this.supported = undefined; }
  /** 取消选择或解除关联后不得继续请求旧文档图片；已经落盘的共享附件不受影响。 */
  retain(documentIds: Set<string>): void {
    for (const [key, value] of this.wanted) if (!documentIds.has(value.request.documentId)) this.wanted.delete(key);
    this.requests = this.requests.filter(request => documentIds.has(request.documentId));
    if (this.source && !documentIds.has(this.source.documentId)) this.source = undefined;
    for (const id of this.waiting.keys()) if (!documentIds.has(id)) this.waiting.delete(id);
    this.releaseUnused();
  }
  private releaseUnused(): void {
    const retained = new Set([...this.waiting.values()].flatMap(ids => [...ids]));
    for (const id of this.complete.keys()) if (!retained.has(id)) this.complete.delete(id);
  }
  /** 完成图片可提前写入不可变附件目录；只有全部就绪后才允许调用方写正文或创建绑定。 */
  async require(documentId: string, text: string, localId?: string, verifyLocal = false): Promise<SyncAttachment[]> {
    const attachments: SyncAttachment[] = []; let missing = false;
    const referenced = canvasAssetsFromText(text);
    if (referenced.length && this.supported === false) throw new Error('SYNC_PROTOCOL: 对端不支持画布图片同步，请更新两端应用');
    for (const [key, value] of this.wanted) if (value.request.documentId === documentId && !referenced.some(asset => asset.id === value.asset.id)) this.wanted.delete(key);
    const waiting = new Set(referenced.map(asset => asset.id)); this.waiting.set(documentId, waiting);
    for (const asset of referenced) {
      const localKey = localId === undefined ? undefined : `${localId}:${asset.id}:${asset.path}:${asset.size}:${asset.mimeType}`;
      // 附件按内容不可变；同一配对会话中已经完整读验的本机副本无需每个分块重新读盘与散列。
      if (!verifyLocal && localKey && this.verifiedLocal.has(localKey)) { waiting.delete(asset.id); continue; }
      if (localId && this.port.readAsset) {
        try { await this.port.readAsset(localId, asset); this.verifiedLocal.add(localKey!); waiting.delete(asset.id); continue; }
        catch { this.verifiedLocal.delete(localKey!); /* 缺失或损坏都必须重新取得完整字节；存储端仍保护已有损坏文件。 */ }
      }
      const bytes = this.complete.get(asset.id);
      if (bytes) {
        await verifyCanvasAssetBytes(bytes, asset);
        if (localId) {
          if (!this.port.writeAsset) throw new Error('SYNC_SAVE: 当前文档端口不能保存画布图片');
          await this.port.writeAsset(localId, { asset, bytes });
          this.verifiedLocal.add(localKey!); waiting.delete(asset.id);
        } else { attachments.push({ asset, bytes }); waiting.add(asset.id); }
        continue;
      }
      const key = documentId + ':' + asset.id;
      if (!this.wanted.has(key)) this.wanted.set(key, { request: { documentId, assetId: asset.id, offset: 0 }, asset });
      waiting.add(asset.id);
      missing = true;
    }
    if (!waiting.size) this.waiting.delete(documentId);
    this.releaseUnused();
    if (missing) throw new Error('SYNC_ASSET_PENDING: 正在接收画布图片，正文保留原版本');
    return attachments;
  }
  /** 只接收先前请求的连续块；重复包不重复追加，校验失败从头重试。 */
  async receive(envelope: SyncEnvelope): Promise<void> {
    this.supported = envelope.assetProtocol === 1;
    this.requests = envelope.assetRequests ?? [];
    if (!this.supported) { this.wanted.clear(); this.requests = []; }
    for (const chunk of envelope.assetChunks ?? []) {
      const key = chunk.documentId + ':' + chunk.assetId, pending = this.wanted.get(key);
      if (!pending || chunk.offset !== pending.request.offset) continue;
      const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0));
      if (bytes.length !== Math.min(ASSET_CHUNK_BYTES, pending.asset.size - chunk.offset)) throw new Error('SYNC_INVALID: 图片分块长度无效');
      if (!pending.bytes) {
        const allocated = [...this.complete.values()].reduce((sum, value) => sum + value.length, 0)
          + [...this.wanted.values()].reduce((sum, value) => sum + (value.bytes?.length ?? 0), 0);
        if (allocated + pending.asset.size > ASSET_CACHE_BYTES) throw new Error('SYNC_LIMIT: 画布图片接收缓存超过 64 MiB，请分批同步');
        // 只分配一次目标缓冲区，避免图片收齐时再拼接出一份同样大小的副本。
        pending.bytes = new Uint8Array(pending.asset.size);
      }
      pending.bytes.set(bytes, pending.request.offset); pending.request.offset += bytes.length;
      if (pending.request.offset !== pending.asset.size) continue;
      try { await verifyCanvasAssetBytes(pending.bytes, pending.asset); }
      catch (error) { pending.request.offset = 0; throw error; }
      this.complete.set(pending.asset.id, pending.bytes); this.wanted.delete(key);
    }
  }
  /** 每轮只服务一块，信封大小与图片总大小无关；请求必须由引擎按版本引用和本机绑定授权。 */
  async offer(resolve: (request: AssetRequest, cached?: Uint8Array) => Promise<Uint8Array | undefined>): Promise<Pick<SyncEnvelope, 'assetProtocol' | 'assetRequests' | 'assetChunks'>> {
    const requests = [...this.wanted.values()].slice(0, 1).map(value => ({ ...value.request }));
    const request = this.requests.shift();
    if (!request) return { assetProtocol: 1, ...(requests.length ? { assetRequests: requests } : {}) };
    const identity = request.documentId + ':' + request.assetId;
    const bytes = await resolve(request, this.source?.id === identity ? this.source.bytes : undefined);
    if (!bytes || request.offset >= bytes.length) return { assetProtocol: 1, ...(requests.length ? { assetRequests: requests } : {}) };
    const part = bytes.subarray(request.offset, request.offset + ASSET_CHUNK_BYTES);
    this.source = request.offset + part.length < bytes.length ? { id: identity, documentId: request.documentId, bytes } : undefined;
    let binary = ''; for (let offset = 0; offset < part.length; offset += 8192) binary += String.fromCharCode(...part.subarray(offset, offset + 8192));
    return { assetProtocol: 1, ...(requests.length ? { assetRequests: requests } : {}), assetChunks: [{ ...request, data: btoa(binary) }] };
  }
}
