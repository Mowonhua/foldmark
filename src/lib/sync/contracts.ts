/**
 * 文件职责：定义局域网同步的版本、绑定和持久化端口。
 * 定义范围：网络数据不含本机路径；同步模块通过文档端口读取和条件写入。
 */
import type { CanvasAsset } from '../canvas/types';
export type DocumentId = string;
export type RevisionId = string;
export interface DocumentContent { text: string; name: string; archived: boolean }
/** 内容寻址版本包含父版本，合并不依赖设备时间；父版本顺序固定。 */
export interface SyncRevision { id: RevisionId; parents: RevisionId[]; content: DocumentContent }
export interface SyncDocument {
  id: DocumentId;
  kind: 'project' | 'inspiration';
  head: RevisionId;
  revisions: Record<RevisionId, SyncRevision>;
  /** 双方已确认的历史截点保留原哈希与父标识，允许截点之前的正文从活动历史移出。 */
  checkpoints?: RevisionId[];
}
/** 行级补丁以字符偏移定位；应用时必须按 from 升序不重叠，否则视为损坏数据。 */
export interface RevisionPatch { from: number; to: number; insert: string }
/**
 * 线上传输版本与持久化格式分离：正文以全文或相对 base 版本的补丁传输，接收方重建后按哈希校验。
 * base 与 patches 必须同时存在；缺省 base 时 text 为完整正文。
 */
export interface WireRevision {
  id: RevisionId;
  parents: RevisionId[];
  name: string;
  archived: boolean;
  text: string;
  base?: RevisionId;
  patches?: RevisionPatch[];
}
/** 线上文档只携带对端缺失的版本；revisions 为空表示 head 无变化。 */
export interface WireDocument {
  id: DocumentId;
  kind: 'project' | 'inspiration';
  head: RevisionId;
  revisions: Record<RevisionId, WireRevision>;
  checkpoints?: RevisionId[];
}
/** 本地绑定只存于本机。暂停不会删除文档或向对方传播删除。 */
export interface SyncBinding {
  localId: string;
  enabled: boolean;
  acknowledged?: RevisionId;
}
/** 写入日志先于正文落盘；重启时必须比较 expected 与 target，不能直接重放覆盖。 */
export interface PendingApply { expected: DocumentContent; target: RevisionId }
export interface SyncRecord {
  document: SyncDocument;
  binding?: SyncBinding;
  conflict?: { local: RevisionId; remote: RevisionId; reason: string };
  pending?: PendingApply;
  error?: string;
  /** 对端最近报告的 head；其祖先闭包视为对端已持有，增量编码以此为下界，跟踪偏差只会多传不会传错。 */
  peerKnown?: RevisionId;
}
/** 用户所选文档的完整清单；revision 是本机持久化操作序号，不是设备时间。 */
export interface SyncSelection { revision: number; ids: DocumentId[] }
export interface SyncState { version: 1; pairing?: string; records: Record<DocumentId, SyncRecord>; selectionRevision?: number; remoteSelection?: SyncSelection }
/**
 * 协议 3 为增量传输：版本按 peerKnown 差集编码，正文可缩为行级补丁；needsFull 请求对端下轮回复全量。
 * selection 缺省仅供本机旧版本记录校验，网络接收必须包含。
 */
/** 请求只包含正文中已有的内容标识；offset 为已接收的连续字节数。 */
export interface AssetRequest { documentId: DocumentId; assetId: string; offset: number }
/** 一次交换最多携带一个 256 KiB 图片块；全部接收并验摘要后才允许使用。 */
export interface AssetChunk extends AssetRequest { data: string }
/** 图片字节仅供附件端口保存，不写入文档正文或版本日志。 */
export interface SyncAttachment { asset: CanvasAsset; bytes: Uint8Array }
export interface SyncEnvelope {
  protocol: 3; documents: WireDocument[]; selection?: SyncSelection; needsFull?: boolean;
  /** 可选扩展保留普通旧文档兼容性；带图片的文档要求双方声明支持。 */
  assetProtocol?: 1;
  assetRequests?: AssetRequest[];
  assetChunks?: AssetChunk[];
}
/** 文档写入须复用保存协调器；编辑中或有受保护草稿时允许推迟，禁止覆盖。 */
export interface SyncDocumentPort {
  read(localId: string): Promise<DocumentContent>;
  apply(localId: string, expected: DocumentContent, next: DocumentContent): Promise<void>;
  accept(documentId: DocumentId, kind: SyncDocument['kind'], content: DocumentContent, attachments?: SyncAttachment[]): Promise<string | null>;
  /** 本机路径只能由绑定解析；读取必须校验附件摘要。 */
  readAsset?(localId: string, asset: CanvasAsset): Promise<Uint8Array>;
  /** 返回前完成附件校验与持久化；失败禁止继续写入引用该附件的正文。 */
  writeAsset?(localId: string, attachment: SyncAttachment): Promise<void>;
}
export interface SyncStore {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}
export interface PairingOffer { version: 1; address: string; addresses?: string[]; certificate: number[]; token: string; expires: number }
export interface ConnectionStatus { paired: boolean; session?: string; address?: string; pending?: string; listening: boolean }
/** 原生端隐藏连接凭证；前端只处理明确选择的文档及经过认证的消息。 */
export interface SyncTransport {
  status(): Promise<ConnectionStatus>;
  offer(): Promise<PairingOffer>;
  pair(offer: PairingOffer): Promise<boolean>;
  approve(accept: boolean): Promise<void>;
  unpair(): Promise<void>;
  probe(): Promise<void>;
  /** 通知已连接的对端拉取本机版本；无连接时保留版本，重连后交换。 */
  notify(): Promise<void>;
  /** 释放前台长连接；不撤销配对，也不清除未确认版本。 */
  disconnect(): Promise<void>;
  exchange(envelope: SyncEnvelope): Promise<SyncEnvelope>;
  respond(id: string, envelope?: SyncEnvelope, error?: string): Promise<void>;
  address(address: string): Promise<void>;
}
