/**
 * 文件职责：校验同步版本并保守合并 Markdown。
 * 定义范围：纯内容合并、内容寻址和版本祖先关系；不执行文件或网络访问。
 */
import { diffLines } from 'diff';
import type { DocumentContent, SyncDocument, SyncEnvelope, SyncRevision, SyncSelection } from './contracts';

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
/** 收到完整包后先校验所有文档，再允许任何写入。上限只拒绝传输，不丢弃本地版本。 */
export async function validateEnvelope(value: unknown): Promise<SyncEnvelope> {
  if (!record(value) || value.protocol !== 2) throw new Error('SYNC_PROTOCOL: 同步协议不兼容，请更新两端应用');
  if (!Array.isArray(value.documents) || value.documents.length > 200 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 8 * 1024 * 1024) throw new Error('SYNC_LIMIT: 同步数据超过限制');
  const selection = value.selection === undefined ? undefined : validateSelection(value.selection);
  const ids = new Set<string>();
  for (const raw of value.documents) {
    if (!record(raw) || typeof raw.id !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.id) || ids.has(raw.id)
      || !['project', 'inspiration'].includes(String(raw.kind)) || typeof raw.head !== 'string' || !record(raw.revisions)) throw new Error('SYNC_INVALID: 文档格式无效');
    ids.add(raw.id);
    if (selection && !selection.ids.includes(raw.id)) throw new Error('SYNC_INVALID: 文档不在本次选择清单中');
    const revisions = Object.values(raw.revisions);
    const checkpoints = raw.checkpoints ?? [];
    if (!Array.isArray(checkpoints) || checkpoints.some(id => typeof id !== 'string' || !Object.hasOwn(raw.revisions!, id))) throw new Error('SYNC_INVALID: 历史截点无效');
    if (!revisions.length || revisions.length > 4096 || !Object.hasOwn(raw.revisions, raw.head)) throw new Error('SYNC_INVALID: 版本集合无效');
    for (const entry of revisions) {
      if (!record(entry) || typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry.id) || raw.revisions[entry.id] !== entry
        || !Array.isArray(entry.parents) || entry.parents.length > 2 || !entry.parents.every(parent => typeof parent === 'string' && /^[a-f0-9]{64}$/.test(parent) && (Object.hasOwn(raw.revisions!, parent) || checkpoints.includes(entry.id)))
        || !record(entry.content) || typeof entry.content.text !== 'string' || new TextEncoder().encode(entry.content.text).byteLength > 1024 * 1024
        || typeof entry.content.name !== 'string' || !entry.content.name.trim() || entry.content.name.length > 256 || typeof entry.content.archived !== 'boolean') throw new Error('SYNC_INVALID: 版本格式无效');
      const expected = await revision(entry.content as unknown as DocumentContent, entry.parents as string[]);
      if (expected.id !== entry.id) throw new Error('SYNC_INVALID: 内容校验失败');
    }
    // Kahn 消除已验证根节点，同时拒绝环与不连通的伪造版本关系。
    const done = new Set<string>();
    let progress = true;
    while (progress) {
      progress = false;
      for (const entry of revisions as unknown as SyncRevision[]) if (!done.has(entry.id) && entry.parents.every(parent => done.has(parent) || checkpoints.includes(entry.id) && !Object.hasOwn(raw.revisions!, parent))) { done.add(entry.id); progress = true; }
    }
    if (done.size !== revisions.length) throw new Error('SYNC_INVALID: 版本关系存在环');
  }
  return value as unknown as SyncEnvelope;
}
