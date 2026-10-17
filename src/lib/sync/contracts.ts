/**
 * 文件职责：定义局域网同步的版本、绑定和持久化端口。
 * 定义范围：网络数据不含本机路径；同步模块通过文档端口读取和条件写入。
 */
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
}
/** 用户所选文档的完整清单；revision 是本机持久化操作序号，不是设备时间。 */
export interface SyncSelection { revision: number; ids: DocumentId[] }
export interface SyncState { version: 1; pairing?: string; records: Record<DocumentId, SyncRecord>; selectionRevision?: number; remoteSelection?: SyncSelection }
/** 协议 2 支持撤回待接收文档；selection 缺省仅供本机旧版本记录校验，网络接收必须包含。 */
export interface SyncEnvelope { protocol: 2; documents: SyncDocument[]; selection?: SyncSelection }
/** 文档写入须复用保存协调器；编辑中或有受保护草稿时允许推迟，禁止覆盖。 */
export interface SyncDocumentPort {
  read(localId: string): Promise<DocumentContent>;
  apply(localId: string, expected: DocumentContent, next: DocumentContent): Promise<void>;
  accept(documentId: DocumentId, kind: SyncDocument['kind'], content: DocumentContent): Promise<string | null>;
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
  exchange(envelope: SyncEnvelope): Promise<SyncEnvelope>;
  respond(id: string, envelope?: SyncEnvelope, error?: string): Promise<void>;
  address(address: string): Promise<void>;
}
