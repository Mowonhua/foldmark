/**
 * 文件职责：串行协调文档版本、合并和可恢复的条件写入。
 * 定义范围：同步数据持久化；连接与编辑器通过独立端口注入。
 */
import type { DocumentContent, RevisionId, SyncDocument, SyncDocumentPort, SyncEnvelope, SyncRecord, SyncRevision, SyncState, SyncStore, WireDocument } from './contracts';
import { ancestors, commonAncestor, decodeRevision, encodeDocument, mergeContent, revision, sameContent, validateEnvelope, validateSelection, validateStoredDocument } from './merge';
const INSPIRATION_DOCUMENT = '00000000-0000-4000-8000-000000000001';
export class SyncEngine {
  private state: SyncState = { version: 1, records: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  /** 本机无法解码对端增量时置位，下轮 offer 携带 needsFull 请对端全量重发；成功接收后清除。 */
  private needsFull = false;
  /** 对端请求全量时置位，由下一次 offer 消费；内存标记丢失无碍，对端解码失败会再次请求。 */
  private peerRequestsFull = false;
  constructor(private readonly documents: SyncDocumentPort, private readonly store: SyncStore, private readonly changed: () => void = () => {}) {}
  snapshot(): SyncState { return structuredClone(this.state); }
  private run<T>(operation: () => Promise<T>, loading = false): Promise<T> {
    const task = this.queue.catch(() => {}).then(() => {
      if (!loading && !this.loaded) throw new Error('SYNC_STATE: 同步记录尚未成功加载');
      return operation();
    });
    this.queue = task;
    return task.finally(this.changed);
  }
  private async save(): Promise<void> { await this.store.save(structuredClone(this.state)); }
  load(): Promise<void> {
    return this.run(async () => {
      const saved = await this.store.load();
      if (!saved) { this.loaded = true; return; }
      if (saved.version !== 1 || !saved.records || typeof saved.records !== 'object') throw new Error('SYNC_STATE: 同步记录格式无效，原数据保留');
      if (saved.selectionRevision !== undefined && (!Number.isSafeInteger(saved.selectionRevision) || saved.selectionRevision < 0)) throw new Error('SYNC_STATE: 文档选择序号无效');
      if (saved.remoteSelection) saved.remoteSelection = validateSelection(saved.remoteSelection);
      // 本地历史可能超过单次网络上限，因此逐文档校验；损坏时不能回退为空状态。
      for (const [id, entry] of Object.entries(saved.records)) {
        await validateStoredDocument(entry.document);
        if (id !== entry.document.id || entry.binding && (typeof entry.binding.localId !== 'string' || typeof entry.binding.enabled !== 'boolean')) throw new Error('SYNC_STATE: 文档绑定无效');
        if (entry.peerKnown !== undefined && (typeof entry.peerKnown !== 'string' || !/^[a-f0-9]{64}$/.test(entry.peerKnown))) throw new Error('SYNC_STATE: 对端版本记录无效');
        for (const head of [entry.conflict?.local, entry.conflict?.remote, entry.pending?.target]) if (head && !Object.hasOwn(entry.document.revisions, head)) throw new Error('SYNC_STATE: 恢复版本缺失');
      }
      this.state = saved;
      this.loaded = true;
    }, true);
  }
  enable(localId: string, kind: SyncDocument['kind']): Promise<string> {
    return this.run(async () => {
      const existing = Object.values(this.state.records).find(record => record.binding?.localId === localId);
      if (existing) { if (!existing.binding!.enabled) this.advanceSelection(); existing.binding!.enabled = true; await this.capture(existing); await this.save(); return existing.document.id; }
      const content = await this.documents.read(localId);
      const root = await revision(content, []);
      const id = kind === 'inspiration' ? INSPIRATION_DOCUMENT : crypto.randomUUID();
      const pending = this.state.records[id];
      if (pending) {
        pending.binding = { localId, enabled: true };
        pending.document.revisions[root.id] = root;
        const remote = pending.document.head;
        pending.document.head = root.id;
        if (remote !== root.id) pending.conflict = { local: root.id, remote, reason: '两端灵感簿已有不同内容，请合并' };
      } else this.state.records[id] = { document: { id, kind, head: root.id, revisions: { [root.id]: root } }, binding: { localId, enabled: true } };
      this.advanceSelection(); await this.save(); return id;
    });
  }
  private advanceSelection(): void {
    const next = (this.state.selectionRevision ?? 0) + 1;
    if (!Number.isSafeInteger(next)) throw new Error('SYNC_STATE: 文档选择序号超出范围');
    this.state.selectionRevision = next;
  }
  disable(id: string): Promise<void> { return this.run(async () => { const record = this.state.records[id]; if (record?.binding?.enabled) { this.advanceSelection(); record.binding.enabled = false; } await this.save(); }); }
  reset(): Promise<void> { return this.run(async () => { this.state = { version: 1, records: {} }; await this.save(); }); }
  /** 配对代次发生变化时清除旧映射，防止退出发生在撤销凭证与清理状态之间时泄露旧选择。 */
  attachPairing(pairing?: string): Promise<void> {
    return this.run(async () => {
      if (this.state.pairing === pairing) return;
      this.state = { version: 1, pairing, records: {} }; await this.save();
    });
  }
  private async capture(record: SyncRecord): Promise<void> {
    if (!record.binding?.enabled) return;
    const actual = await this.documents.read(record.binding.localId);
    if (record.pending) {
      const target = record.document.revisions[record.pending.target];
      if (sameContent(actual, target.content)) { record.document.head = target.id; delete record.pending; delete record.conflict; }
      else if (sameContent(actual, record.pending.expected)) {
        await this.documents.apply(record.binding.localId, actual, target.content);
        record.document.head = target.id; delete record.pending; delete record.conflict;
      } else {
        const local = await revision(actual, [record.document.head]);
        record.document.revisions[local.id] = local; record.document.head = local.id;
        record.conflict = { local: local.id, remote: target.id, reason: '恢复同步写入时发现本机内容已变化' };
        delete record.pending;
      }
      await this.save();
    }
    // 元数据与正文是同一个版本，重命名和归档也要参与并发检查。
    const current = await this.documents.read(record.binding.localId);
    if (!sameContent(current, record.document.revisions[record.document.head].content)) {
      const next = await revision(current, [record.document.head]);
      record.document.revisions[next.id] = next; record.document.head = next.id;
      if (record.conflict) record.conflict.local = next.id;
    }
    delete record.error;
  }
  private async captureAll(): Promise<void> {
    for (const record of Object.values(this.state.records)) {
      try { await this.capture(record); } catch (error) { record.error = String(error); }
    }
    await this.save();
  }
  /** 对端已确认持有的版本及其祖先与历史截点无需重传；跟踪偏差的代价只是多传，不会影响正确性。 */
  private knownRevisions(record: SyncRecord): Set<RevisionId> {
    const known = new Set<RevisionId>(record.document.checkpoints ?? []);
    if (record.peerKnown) for (const id of ancestors(record.document, record.peerKnown)) known.add(id);
    return known;
  }
  /** full 为 true 或对端请求时忽略增量跟踪发送全部活动版本，用于对端状态不完整后的恢复。 */
  offer(full = false): Promise<SyncEnvelope> {
    return this.run(async () => {
      await this.captureAll();
      const serveFull = full || this.peerRequestsFull;
      this.peerRequestsFull = false;
      const selected = Object.values(this.state.records).filter(record => record.binding?.enabled);
      // 暂时无法读取的文档仍在清单中；文件错误不能被误解为用户取消选择。
      const envelope: SyncEnvelope = {
        protocol: 3,
        selection: { revision: this.state.selectionRevision ?? 0, ids: selected.map(record => record.document.id).sort() },
        documents: selected.filter(record => !record.error).map(record => encodeDocument(record.document, serveFull ? new Set() : this.knownRevisions(record))),
        ...(this.needsFull ? { needsFull: true } : {}),
      };
      return validateEnvelope(envelope);
    });
  }
  /**
   * 解码文档中的全部新版本；已在本机记录中的版本直接复用，跳过重复哈希。
   * 返回前保证 head 可解析，任一基线缺失都抛出 SYNC_BASE_MISSING 且不改动任何记录。
   */
  private async decodeDocument(remote: WireDocument): Promise<SyncRevision[]> {
    const resolved: Record<RevisionId, SyncRevision> = { ...(this.state.records[remote.id]?.document.revisions ?? {}) };
    const pending = new Map(Object.entries(remote.revisions));
    const fresh: SyncRevision[] = [];
    let progress = true;
    while (progress && pending.size) {
      progress = false;
      for (const [id, wire] of pending) {
        if (resolved[id]) { pending.delete(id); progress = true; continue; }
        if (wire.base !== undefined && !resolved[wire.base]) continue;
        const entry = await decodeRevision(wire, base => resolved[base]);
        resolved[id] = entry; fresh.push(entry); pending.delete(id); progress = true;
      }
    }
    if (pending.size || !resolved[remote.head]) throw new Error('SYNC_BASE_MISSING: 对端引用了本机没有的版本，需要全量同步');
    return fresh;
  }
  receive(value: unknown): Promise<void> {
    return this.run(async () => {
      const incoming = await validateEnvelope(value);
      if (!incoming.selection) throw new Error('SYNC_PROTOCOL: 对端缺少文档选择清单，请更新两端应用');
      const selected = validateSelection(incoming.selection), previous = this.state.remoteSelection;
      // 全量请求与选择序号无关：对端状态重建后序号回退，不能随旧清单一起被丢弃。
      if (incoming.needsFull) this.peerRequestsFull = true;
      if (previous && selected.revision < previous.revision) return;
      if (previous && selected.revision === previous.revision && JSON.stringify(selected.ids) !== JSON.stringify(previous.ids)) throw new Error('SYNC_INVALID: 相同选择序号对应不同文档');
      // 仅撤回尚未接收的副本。已关联文件、正在处理的本机正文都不传播删除。
      for (const [id, entry] of Object.entries(this.state.records)) if (!entry.binding && !selected.ids.includes(id)) delete this.state.records[id];
      this.state.remoteSelection = selected;
      await this.captureAll();
      try {
        // 先解码全部文档：任一文档缺基线都不应用部分修改，并请求对端下轮全量重发。
        const decoded = new Map<string, SyncRevision[]>();
        for (const remote of incoming.documents) decoded.set(remote.id, await this.decodeDocument(remote));
        for (const remote of incoming.documents) await this.merge(remote, decoded.get(remote.id)!);
        this.needsFull = false;
        await this.save();
      } catch (error) {
        if (error instanceof Error && error.message.includes('SYNC_BASE_MISSING')) this.needsFull = true;
        throw error;
      }
    });
  }
  private async merge(remote: WireDocument, fresh: SyncRevision[]): Promise<void> {
    const record = this.state.records[remote.id];
    if (!record) {
      const revisions: Record<RevisionId, SyncRevision> = {};
      for (const entry of fresh) revisions[entry.id] = entry;
      this.state.records[remote.id] = { document: { id: remote.id, kind: remote.kind, head: remote.head, revisions, ...(remote.checkpoints?.length ? { checkpoints: [...remote.checkpoints] } : {}) }, peerKnown: remote.head };
      return;
    }
    if (record.binding && !record.binding.enabled) return;
    if (record.document.kind !== remote.kind) throw new Error('SYNC_INVALID: 文档类型不一致');
    // 相同版本 ID 已校验内容哈希，重传只扩充已知历史，不创建新编辑。
    for (const entry of fresh) record.document.revisions[entry.id] = entry;
    record.document.checkpoints = [...new Set([...(record.document.checkpoints ?? []), ...(remote.checkpoints ?? [])])];
    record.peerKnown = remote.head;
    if (!record.binding) { record.document.head = remote.head; return; }
    if (record.error || record.pending) return;
    try {
      const doc = record.document;
      if (doc.head === remote.head) {
        record.binding.acknowledged = doc.head;
        // 只在对端明确持有相同版本后压缩活动历史。冲突和写入日志中的版本不得清除。
        // 旧备份重连若落在截点之前则转为人工合并，绝不能凭时间选择覆盖。
        if (!record.conflict && !record.pending) {
          doc.revisions = { [doc.head]: doc.revisions[doc.head] }; doc.checkpoints = [doc.head];
        }
        return;
      }
      if (ancestors(doc, doc.head).has(remote.head)) return;
      let target = doc.revisions[remote.head];
      if (!ancestors(doc, remote.head).has(doc.head)) {
        const base = commonAncestor(doc, doc.head, remote.head);
        const merged = base && mergeContent(base.content, doc.revisions[doc.head].content, target.content);
        if (!merged) { record.conflict = { local: doc.head, remote: remote.head, reason: base ? '两端修改存在重叠或任务结构变化' : '没有唯一共同版本，请合并双方内容' }; return; }
        target = await revision(merged, [doc.head, remote.head]); doc.revisions[target.id] = target;
      }
      await this.apply(record, target.id);
    } catch (error) { record.error = String(error); }
  }
  private async apply(record: SyncRecord, target: string): Promise<void> {
    const expected = record.document.revisions[record.document.head].content;
    record.pending = { expected, target };
    await this.save();
    await this.documents.apply(record.binding!.localId, expected, record.document.revisions[target].content);
    record.document.head = target; delete record.pending; delete record.conflict; delete record.error;
    await this.save();
  }
  /**
   * 函数职责：接收待同步文档，或按用户明确选择关联本机已有项目。
   * 输入说明：existingLocalId 仅来自本机项目选择；缺省时创建副本，不能按名称推断关联。
   * 输出说明：已有项目不被直接写入；内容不同则持久化双方版本并进入冲突处理。
   * 实现思路：串行检查关联唯一性和本机可读状态，再保存绑定及必要的独立本机版本。
   */
  accept(id: string, existingLocalId?: string): Promise<void> {
    return this.run(async () => {
      const record = this.state.records[id]; if (!record || record.binding) return;
      const content = record.document.revisions[record.document.head].content;
      if (existingLocalId !== undefined && (record.document.kind !== 'project' || !existingLocalId || existingLocalId === 'inspiration')) throw new Error('SYNC_BINDING: 只能关联已有项目');
      const localId = existingLocalId ?? await this.documents.accept(id, record.document.kind, content);
      if (localId === null) return;
      if (Object.values(this.state.records).some(other => other.binding?.localId === localId)) throw new Error('SYNC_BINDING: 文档已关联同步');
      const actual = await this.documents.read(localId);
      // 明确关联只读取本机正文；不同内容没有共同基线，必须先保存双方供用户选择。
      if (!sameContent(actual, content)) {
        const local = await revision(actual, []); const remote = record.document.head;
        record.document.revisions[local.id] = local; record.document.head = local.id;
        record.conflict = { local: local.id, remote, reason: '本机已有不同内容，请合并' };
      }
      record.binding = { localId, enabled: true };
      this.advanceSelection();
      await this.save();
    });
  }
  resolve(id: string, local: string, remote: string, content: DocumentContent): Promise<void> {
    return this.run(async () => {
      const record = this.state.records[id]; if (!record?.binding) throw new Error('SYNC_BINDING: 文档未关联');
      await this.capture(record); await this.save();
      if (record.document.head !== local || record.conflict?.remote !== remote) throw new Error('SYNC_CHANGED: 内容已变化，请重新比较');
      const merged = await revision(content, [local, remote]); record.document.revisions[merged.id] = merged;
      await this.apply(record, merged.id);
    });
  }
}
