/**
 * 文件职责：校验同步数据、编码增量版本并保守合并 Markdown。
 * 定义范围：纯内容合并、内容寻址、线上补丁编解码和版本祖先关系；不执行文件或网络访问。
 */
import { diffLines } from 'diff';
import type { DocumentContent, RevisionPatch, SyncDocument, SyncEnvelope, SyncRevision, SyncSelection, WireDocument, WireRevision } from './contracts';

export const sameContent = (a: DocumentContent, b: DocumentContent): boolean => a.text === b.text && a.name === b.name && a.archived === b.archived;
const field = <T>(base: T, local: T, remote: T): T | undefined => local === remote || remote === base ? local : local === base ? remote : undefined;
interface Edit { from: number; to: number; insert: string }
function edits(base: string, next: string): Edit[] {
  const parts = diffLines(base, next, { timeout: 200, maxEditLength: 10000 });
  if (!parts) throw new Error('SYNC_COMPLEX: 文档差异过大，请手动合并');
  const result: Edit[] = []; let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) { offset += part.value.length; continue; }
    const edit: Edit = { from: offset, to: offset, insert: '' };
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) { offset += parts[i].value.length; edit.to = offset; }
      else edit.insert += parts[i].value;
      i++;
    }
    i--; result.push(edit);
  }
  return result;
}
/** 结构行变化不尝试推测任务身份；宁可要求合并，也不能把移动误认成无关增删。 */
function structure(text: string): string {
  return text.split('\n').filter(line => /^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|`{3,}|~{3,}|<|>)/.test(line)).join('\n');
}
export function mergeContent(base: DocumentContent, local: DocumentContent, remote: DocumentContent): DocumentContent | null {
  const name = field(base.name, local.name, remote.name);
  const archived = field(base.archived, local.archived, remote.archived);
  if (name === undefined || archived === undefined) return null;
  let text = field(base.text, local.text, remote.text);
  if (text === undefined) {
    if (structure(base.text) !== structure(local.text) || structure(base.text) !== structure(remote.text)) return null;
    let left: Edit[], right: Edit[];
    try { left = edits(base.text, local.text); right = edits(base.text, remote.text); } catch { return null; }
    const all = [...left];
    for (const other of right) {
      if (left.some(edit => edit.from === other.from && edit.to === other.to && edit.insert === other.insert)) continue;
      // 相邻插入也按冲突处理，避免任意规定同一位置的内容顺序。
      if (left.some(edit => edit.from <= other.to && other.from <= edit.to)) return null;
      all.push(other);
    }
    text = base.text;
    for (const edit of all.sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  }
  return { text, name, archived };
}
/** 补丁只描述字符区间替换；越界、重叠或倒序都按损坏数据拒绝，避免静默拼出错误正文。 */
export function applyPatches(base: string, patches: RevisionPatch[]): string {
  let cursor = 0;
  for (const patch of patches) {
    if (!Number.isSafeInteger(patch.from) || !Number.isSafeInteger(patch.to) || patch.from < cursor || patch.to < patch.from || patch.to > base.length || typeof patch.insert !== 'string') throw new Error('SYNC_INVALID: 补丁格式无效');
    cursor = patch.to;
  }
  let text = base;
  for (const patch of [...patches].sort((a, b) => b.from - a.from)) text = text.slice(0, patch.from) + patch.insert + text.slice(patch.to);
  return text;
}
export async function revision(content: DocumentContent, parents: string[]): Promise<SyncRevision> {
  // 本机输入也遵守协议边界；先拒绝生成版本，避免将无法重新加载的记录写入本地状态。
  if (!content.name.trim() || content.name.length > 256 || new TextEncoder().encode(content.text).byteLength > 1024 * 1024) throw new Error('SYNC_LIMIT: 正文或名称超过同步限制，本机内容已保留');
  const ordered = [...new Set(parents)].sort();
  const canonical = { text: content.text, name: content.name, archived: content.archived };
  const bytes = new TextEncoder().encode(JSON.stringify([ordered, canonical]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { id, parents: ordered, content: canonical };
}
export function ancestors(doc: SyncDocument, head: string): Set<string> {
  const found = new Set<string>(); const pending = [head];
  while (pending.length) {
    const id = pending.pop()!;
    if (found.has(id)) continue;
    if (!Object.hasOwn(doc.revisions, id)) continue;
    found.add(id); pending.push(...doc.revisions[id].parents);
  }
  return found;
}
/** 多个并列共同祖先表示合并历史存在歧义，不能按时间或任意顺序挑选。 */
export function commonAncestor(doc: SyncDocument, left: string, right: string): SyncRevision | undefined {
  const a = ancestors(doc, left); const b = ancestors(doc, right);
  const common = [...a].filter(id => b.has(id));
  const superseded = new Set<string>();
  for (const id of common) for (const parent of doc.revisions[id].parents) {
    for (const ancestor of ancestors(doc, parent)) superseded.add(ancestor);
  }
  const latest = common.filter(id => !superseded.has(id));
  return latest.length === 1 ? doc.revisions[latest[0]] : undefined;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** 清单只包含稳定文档标识，序号必须能无损递增；不能把损坏的清单当成撤回全部文档。 */
export function validateSelection(value: unknown): SyncSelection {
  if (!record(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.ids)
    || value.ids.length > 200 || value.ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
    || new Set(value.ids).size !== value.ids.length) throw new Error('SYNC_INVALID: 文档选择清单无效');
  return { revision: value.revision as number, ids: [...value.ids].sort() };
}
/**
 * 信封只做结构与限额校验，不验哈希、不要求版本闭包：父版本与 base 可引用接收方已有的版本，
 * 内容校验在解码重建时按版本 ID 完成。上限只拒绝传输，不丢弃本地版本。
 */
export async function validateEnvelope(value: unknown): Promise<SyncEnvelope> {
  if (!record(value) || value.protocol !== 3) throw new Error('SYNC_PROTOCOL: 同步协议不兼容，请更新两端应用');
  if (value.needsFull !== undefined && typeof value.needsFull !== 'boolean') throw new Error('SYNC_INVALID: 同步数据格式无效');
  if (!Array.isArray(value.documents) || value.documents.length > 200 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 8 * 1024 * 1024) throw new Error('SYNC_LIMIT: 同步数据超过限制');
  const selection = value.selection === undefined ? undefined : validateSelection(value.selection);
  const ids = new Set<string>();
  for (const raw of value.documents) {
    if (!record(raw) || typeof raw.id !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.id) || ids.has(raw.id)
      || !['project', 'inspiration'].includes(String(raw.kind)) || typeof raw.head !== 'string' || !/^[a-f0-9]{64}$/.test(raw.head) || !record(raw.revisions)) throw new Error('SYNC_INVALID: 文档格式无效');
    ids.add(raw.id);
    if (selection && !selection.ids.includes(raw.id)) throw new Error('SYNC_INVALID: 文档不在本次选择清单中');
    const revisions = Object.values(raw.revisions);
    if (revisions.length > 4096) throw new Error('SYNC_INVALID: 版本集合无效');
    const checkpoints = raw.checkpoints ?? [];
    if (!Array.isArray(checkpoints) || checkpoints.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('SYNC_INVALID: 历史截点无效');
    for (const entry of revisions) {
      if (!record(entry) || typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry.id) || raw.revisions[entry.id] !== entry
        || !Array.isArray(entry.parents) || entry.parents.length > 2 || !entry.parents.every(parent => typeof parent === 'string' && /^[a-f0-9]{64}$/.test(parent))
        || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 256 || typeof entry.archived !== 'boolean'
        || typeof entry.text !== 'string' || new TextEncoder().encode(entry.text).byteLength > 1024 * 1024) throw new Error('SYNC_INVALID: 版本格式无效');
      // base 与 patches 必须成对出现；补丁的偏移边界由应用方按 base 正文校验。
      if ((entry.base === undefined) !== (entry.patches === undefined)
        || (entry.base !== undefined && (typeof entry.base !== 'string' || !/^[a-f0-9]{64}$/.test(entry.base)))
        || (entry.patches !== undefined && (!Array.isArray(entry.patches) || entry.patches.length > 100000
          || entry.patches.some(patch => !record(patch) || typeof patch.insert !== 'string' || new TextEncoder().encode(patch.insert).byteLength > 1024 * 1024)))) throw new Error('SYNC_INVALID: 版本格式无效');
    }
  }
  return value as unknown as SyncEnvelope;
}
/** 本机持久化记录保持全量自洽：逐版本验哈希并用 Kahn 消除拒绝环与断链，损坏时不能回退为空状态。 */
export async function validateStoredDocument(doc: SyncDocument): Promise<void> {
  const revisions = Object.values(doc.revisions);
  const checkpoints = doc.checkpoints ?? [];
  if (!revisions.length || revisions.length > 4096 || !Object.hasOwn(doc.revisions, doc.head)
    || checkpoints.some(id => !Object.hasOwn(doc.revisions, id))) throw new Error('SYNC_STATE: 版本集合无效');
  for (const entry of revisions) {
    if (typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry.id) || doc.revisions[entry.id] !== entry
      || !Array.isArray(entry.parents) || entry.parents.length > 2 || !entry.parents.every(parent => typeof parent === 'string' && /^[a-f0-9]{64}$/.test(parent) && (Object.hasOwn(doc.revisions, parent) || checkpoints.includes(entry.id)))
      || !entry.content || typeof entry.content.text !== 'string' || new TextEncoder().encode(entry.content.text).byteLength > 1024 * 1024
      || typeof entry.content.name !== 'string' || !entry.content.name.trim() || entry.content.name.length > 256 || typeof entry.content.archived !== 'boolean') throw new Error('SYNC_STATE: 版本格式无效');
    const expected = await revision(entry.content, entry.parents);
    if (expected.id !== entry.id) throw new Error('SYNC_STATE: 内容校验失败');
  }
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const entry of revisions) if (!done.has(entry.id) && entry.parents.every(parent => done.has(parent) || checkpoints.includes(entry.id) && !Object.hasOwn(doc.revisions, parent))) { done.add(entry.id); progress = true; }
  }
  if (done.size !== revisions.length) throw new Error('SYNC_STATE: 版本关系存在环');
}
/** 收集 head 可达且对端未确认持有的版本；known 之外的父版本即补丁基线候选。 */
function deltaRevisions(doc: SyncDocument, known: Set<string>): SyncRevision[] {
  const result: SyncRevision[] = []; const seen = new Set<string>(); const stack = [doc.head];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || known.has(id)) continue;
    seen.add(id);
    const entry = doc.revisions[id];
    if (!entry) continue;
    result.push(entry); stack.push(...entry.parents);
  }
  return result;
}
/**
 * 函数职责：把本机文档编码为对端的增量线上格式。
 * 输入说明：known 是对端已确认持有的版本闭包（含历史截点）；为空集时退化为全量传输。
 * 输出说明：正文只在补丁序列化后短于全文时压缩；基线只选用对端已有的版本，不依赖同包解码顺序。
 */
export function encodeDocument(doc: SyncDocument, known: Set<string>): WireDocument {
  const delta = deltaRevisions(doc, known);
  const pending = new Set(delta.map(entry => entry.id));
  const revisions: Record<string, WireRevision> = {};
  for (const entry of delta) {
    let wire: WireRevision = { id: entry.id, parents: entry.parents, name: entry.content.name, archived: entry.content.archived, text: entry.content.text };
    let best: { base: string; patches: ReturnType<typeof edits>; size: number } | undefined;
    for (const parent of entry.parents) {
      if (pending.has(parent)) continue;
      const base = doc.revisions[parent];
      if (!base) continue;
      try {
        const patches = edits(base.content.text, entry.content.text);
        const size = JSON.stringify(patches).length;
        if (!best || size < best.size) best = { base: parent, patches, size };
      } catch { /* 差异过大超出 diff 限额时退回全文传输。 */ }
    }
    if (best && best.size < entry.content.text.length) wire = { id: entry.id, parents: entry.parents, name: entry.content.name, archived: entry.content.archived, text: '', base: best.base, patches: best.patches };
    revisions[entry.id] = wire;
  }
  return { id: doc.id, kind: doc.kind, head: doc.head, revisions, ...(doc.checkpoints?.length ? { checkpoints: doc.checkpoints } : {}) };
}
/** 解码单个线上版本并按内容寻址校验；base 缺失是唯一可恢复失败，由发送方全量重试。 */
export async function decodeRevision(wire: WireRevision, resolve: (id: string) => SyncRevision | undefined): Promise<SyncRevision> {
  let text = wire.text;
  if (wire.base !== undefined) {
    const base = resolve(wire.base);
    if (!base) throw new Error('SYNC_BASE_MISSING: 对端引用了本机没有的版本，需要全量同步');
    text = applyPatches(base.content.text, wire.patches ?? []);
  }
  const entry = await revision({ text, name: wire.name, archived: wire.archived }, wire.parents);
  if (entry.id !== wire.id) throw new Error('SYNC_INVALID: 内容校验失败');
  return entry;
}
