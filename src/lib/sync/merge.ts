/**
 * 文件职责：校验同步数据、编码增量版本，并在共同祖先上按并集合并 Markdown 正文。
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
/**
 * 差异块类型：决定合并界面要为该块提供哪些选择，以及能否不经用户决定直接采纳。
 * local 只有本端改动；remote 只有对端改动；same 两端改动结果相同；union 两端在同一处各自改动且互不覆盖，默认都保留；
 * overlap 两端改动同一段已有内容且结果不同，必须由用户选择。
 */
export type MergeHunkKind = 'local' | 'remote' | 'same' | 'union' | 'overlap';
/** 差异块选择；union 只能用于带 union 文本的差异块。 */
export type MergeChoice = 'local' | 'remote' | 'union';
/**
 * 结构职责：一处三方差异，供合并界面逐块展示和选择。
 * 字段说明：from/to 是该块在共同祖先正文中的字符区间，纯新增时 from === to；
 *   local/remote 分别是只应用本端、只应用对端编辑后的块内文本，未改动的一侧等于祖先原文；
 *   union 只在 kind 为 union 时给出，表示两端改动都保留的拼合结果。
 * 约束条件：差异块按 from 升序且互不重叠；块内文本不含祖先正文区间之外的内容。
 */
export interface MergeHunk { from: number; to: number; local: string; remote: string; union?: string; kind: MergeHunkKind }

/**
 * 函数职责：在祖先正文的一段区间内应用某一侧的行级编辑。
 * 输入说明：区间与编辑必须来自同一份祖先正文，编辑按 from 升序且互不重叠。
 * 输出说明：返回该区间应用编辑后的文本，区间之外的内容不参与。
 * 实现思路：正序遍历编辑，逐段拼接保留的原文与插入文本。
 */
function applyRegion(base: string, from: number, to: number, region: Edit[]): string {
  let text = ''; let cursor = from;
  for (const edit of region) { text += base.slice(cursor, edit.from) + edit.insert; cursor = edit.to; }
  return text + base.slice(cursor, to);
}
/** 位于同一位置的多个插入必须有固定顺序，否则两端各自合并会得到不同正文而无法收敛。 */
const insertOrder = (insert: string): string => (/(^|\n)\s*#{1,6}\s/.test(insert) ? '1' : '0') + insert;
/**
 * 函数职责：把两端在同一个差异块内的编辑并成一次可确定重现的应用顺序。
 * 输入说明：两侧编辑互不覆盖同一段已有字符，纯新增可落在同一位置。
 * 输出说明：按位置升序返回编辑列表，可直接交给 applyRegion。
 * 实现思路：先按 from、再按 to 排序，使同一位置的插入排在自该位置开始的替换之前；
 *   位置完全相同的插入按“带标题行的排后、其余按文本比较”定序。
 *   新增章节因此排在新增任务之后，对端新增的任务不会被并进本机新建的章节或落到归档章节之后。
 */
function unionEdits(left: Edit[], right: Edit[]): Edit[] {
  const order = (edit: Edit): string => insertOrder(edit.insert);
  return [...left, ...right].sort((a, b) => a.from - b.from || a.to - b.to
    || (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}
/**
 * 函数职责：按行级差异计算三方合并的差异块，并判定每块可直接采纳还是必须选择。
 * 输入说明：base 为共同祖先正文，local 与 remote 为两端正文；差异过大时抛 SYNC_COMPLEX。
 * 输出说明：按正文位置升序返回差异块，只改动一侧的内容也会给出对应块。
 * 实现思路：分别求两端相对祖先的行级编辑，把相互重叠或相邻的编辑并为一个差异块；
 *   块内分别应用两端编辑得到两块文本，结果相同或只有一侧改动即可直接采纳；
 *   两端都改动时只按是否覆盖同一段已有字符区分并集与冲突，不因任务归档、排序造成的移动而拒绝合并。
 */
export function diffHunks(base: string, local: string, remote: string): MergeHunk[] {
  const entries = [
    ...edits(base, local).map(edit => ({ edit, local: true })),
    ...edits(base, remote).map(edit => ({ edit, local: false })),
  ].sort((a, b) => a.edit.from - b.edit.from || a.edit.to - b.edit.to);
  const hunks: MergeHunk[] = [];
  for (let index = 0; index < entries.length;) {
    const from = entries[index].edit.from;
    let to = entries[index].edit.to; let end = index + 1;
    // 中间没有两端都保持原样的内容时不能把它们当成互不相关的改动：相邻改动必须一起判断。
    while (end < entries.length && entries[end].edit.from <= to) { to = Math.max(to, entries[end].edit.to); end++; }
    const group = entries.slice(index, end); index = end;
    const left = group.filter(entry => entry.local).map(entry => entry.edit);
    const right = group.filter(entry => !entry.local).map(entry => entry.edit);
    const ancestor = base.slice(from, to);
    const localText = applyRegion(base, from, to, left);
    const remoteText = applyRegion(base, from, to, right);
    const collides = left.some(a => right.some(b => a.from < b.to && b.from < a.to));
    const kind: MergeHunkKind = localText === remoteText ? 'same' : remoteText === ancestor ? 'local'
      : localText === ancestor ? 'remote' : collides ? 'overlap' : 'union';
    hunks.push({ from, to, local: localText, remote: remoteText, ...(kind === 'union' ? { union: applyRegion(base, from, to, unionEdits(left, right)) } : {}), kind });
  }
  return hunks;
}
/**
 * 函数职责：给出差异块的默认选择，未决定的位置为 null。
 * 输入说明：hunks 必须来自同一次 diffHunks。
 * 输出说明：单端改动取改动的一侧，两端改动相同时取本端文本（两侧结果一致），并集块取两端都保留，
 *   覆盖同一段内容的冲突块返回 null。
 */
export function defaultChoices(hunks: MergeHunk[]): (MergeChoice | null)[] {
  return hunks.map(hunk => hunk.kind === 'local' || hunk.kind === 'same' ? 'local'
    : hunk.kind === 'remote' ? 'remote' : hunk.kind === 'union' ? 'union' : null);
}
/**
 * 函数职责：按逐块选择把差异块拼回完整正文。
 * 输入说明：choices 与 hunks 一一对应，null 表示尚未决定并使用 pending 占位；union 只能选择带 union 文本的差异块。
 * 输出说明：返回合并后的完整正文，未改动区间原样保留；选择与差异块不匹配时抛 SYNC_INVALID。
 */
export function assembleMerge(base: string, hunks: MergeHunk[], choices: (MergeChoice | null)[], pending = ''): string {
  if (choices.length !== hunks.length) throw new Error('SYNC_INVALID: 差异块选择数量不匹配');
  let text = ''; let cursor = 0;
  hunks.forEach((hunk, index) => {
    const choice = choices[index];
    const piece = choice === 'local' ? hunk.local : choice === 'remote' ? hunk.remote : choice === 'union' ? hunk.union : choice === null ? pending : undefined;
    if (piece === undefined) throw new Error('SYNC_INVALID: 差异块不支持该选择');
    text += base.slice(cursor, hunk.from) + piece; cursor = hunk.to;
  });
  return text + base.slice(cursor);
}
/**
 * 函数职责：用共同祖先合并两端文档内容，能确定的部分直接合并。
 * 输入说明：base 为共同祖先内容，local 与 remote 为两端内容。
 * 输出说明：返回合并结果；正文存在两端改动同一段内容且结果不同的差异块时返回 null，交给用户选择。
 * 实现思路：项目资料按字段取值，正文按差异块逐块决定；两端各自新增的内容都保留，
 *   任务归档、排序造成的移动不再单独构成冲突，只有两端改动同一段已有内容时才要求人工选择。
 */
export function mergeContent(base: DocumentContent, local: DocumentContent, remote: DocumentContent): DocumentContent | null {
  const name = field(base.name, local.name, remote.name);
  const archived = field(base.archived, local.archived, remote.archived);
  if (name === undefined || archived === undefined) return null;
  let text = field(base.text, local.text, remote.text);
  if (text === undefined) {
    let hunks: MergeHunk[];
    try { hunks = diffHunks(base.text, local.text, remote.text); } catch { return null; }
    const choices = defaultChoices(hunks);
    if (choices.some(choice => choice === null)) return null;
    text = assembleMerge(base.text, hunks, choices);
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
