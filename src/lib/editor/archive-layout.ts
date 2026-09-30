/**
 * 文件职责：将源文归档布局整理接入编辑器事务。
 * 定义范围：布局事务、选区与折叠的可靠内容映射。
 */
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { normalizeArchiveChanges, parseDocument, type DocumentModel, type ListItem } from '../markdown';
import { documentField, expandedCompletedGroupsField, foldsField, setExpandedCompletedGroups, setFolds } from './state';
import { setSourceReturn, sourceReturnField } from './source-position';

/**
 * 函数职责：生成相对当前状态的布局整理事务。
 * 输入说明：状态必须包含文档模型与折叠字段；completedFrom 使用状态中本次新完成项的坐标。
 * 输出说明：无布局或完成状态变化返回 null；有变化保留可靠匹配的选区与折叠。
 * 实现思路：共享 Markdown 内核负责布局，编辑层按内容恢复条目身份。
 */
export function archiveLayoutSpec(state: EditorState, completedFrom: readonly number[] = []): TransactionSpec | null {
  const before = state.field(documentField);
  const changes = state.changes(normalizeArchiveChanges(before, completedFrom));
  if (changes.empty && !completedFrom.length) return null;
  const after = changes.empty ? before : parseDocument(changes.apply(state.doc).toString());
  // 提升子项会改变行首缩进；用去除共同缩进的完整条目内容匹配，只恢复唯一身份。
  const key = (model: DocumentModel, item: ListItem): string => {
    const indent = model.text.slice(item.moveFrom, item.markerFrom);
    return model.text.slice(item.markerFrom, item.to).split('\n').map((line, index) => index && line.startsWith(indent) ? line.slice(indent.length) : line).join('\n');
  };
  const matches = new Map<number, ListItem>();
  const targets = new Map<string, ListItem[]>();
  for (const item of after.items) { const content = key(after, item); targets.set(content, [...targets.get(content) ?? [], item]); }
  for (const item of before.items) {
    const candidates = targets.get(key(before, item));
    if (candidates?.length === 1) matches.set(item.from, candidates[0]);
  }
  // 子项排序会改变祖先全文；以保留自身正文和完整子项内容的无序树键恢复唯一祖先身份。
  // 唯一结构可直接匹配；重复结构还需结合父项和动作顺序确认身份。
  // 两个快照共享结构编号；父键仅含子编号，避免深链重复转义完整子键导致指数膨胀。
  const identities = new Map<string, string>();
  const treeKeys = (model: DocumentModel): Map<number, string> => {
    const keys = new Map<number, string>();
    const items = new Map(model.items.map(item => [item.from, item]));
    for (const item of [...model.items].reverse()) {
      let own = ''; let position = item.markerFrom;
      for (const from of item.children) {
        const child = items.get(from)!;
        own += model.text.slice(position, Math.max(position, child.moveFrom));
        position = Math.min(item.to, child.moveTo);
      }
      own += model.text.slice(position, item.to);
      const indent = model.text.slice(item.moveFrom, item.markerFrom);
      own = own.split('\n').map((line, index) => index && line.startsWith(indent) ? line.slice(indent.length) : line).join('\n');
      const signature = JSON.stringify([own.trimEnd(), item.children.map(from => keys.get(from)).sort()]);
      if (!identities.has(signature)) identities.set(signature, String(identities.size));
      keys.set(item.from, identities.get(signature)!);
    }
    return keys;
  };
  const oldKeys = treeKeys(before); const newKeys = treeKeys(after);
  const structuralTargets = new Map<string, ListItem[]>();
  for (const item of after.items) { const content = newKeys.get(item.from)!; structuralTargets.set(content, [...structuralTargets.get(content) ?? [], item]); }
  for (const item of before.items) {
    if (matches.has(item.from)) continue;
    const candidates = structuralTargets.get(oldKeys.get(item.from)!);
    if (candidates?.length === 1) matches.set(item.from, candidates[0]);
  }
  // 内容相同的兄弟仍有可靠的动作身份：新完成项前插，其余同内容条目保持原顺序。
  // 按已映射父项限定候选，防止跨任务树把折叠和光标交给同名条目。
  const recent = new Set(completedFrom);
  const listOrdinals = (model: DocumentModel): Map<number, number> => {
    const lists = new Map<number | null, number[]>(); const ordinals = new Map<number, number>();
    for (const item of model.items) {
      const siblings = lists.get(item.parentFrom) ?? [];
      if (!siblings.includes(item.listFrom)) siblings.push(item.listFrom);
      lists.set(item.parentFrom, siblings); ordinals.set(item.from, siblings.indexOf(item.listFrom));
    }
    return ordinals;
  };
  const oldLists = listOrdinals(before); const newLists = listOrdinals(after);
  const duplicateGroups = new Map<number | null, Map<string, ListItem[]>>();
  for (const item of before.items) {
    const groups = duplicateGroups.get(item.parentFrom) ?? new Map<string, ListItem[]>();
    // 根任务会搬入归档列表；嵌套任务只能在原父项的同一段列表中重排。
    const identity = oldKeys.get(item.from)! + (item.parentFrom === null ? '' : `:${oldLists.get(item.from)}`);
    groups.set(identity, [...groups.get(identity) ?? [], item]); duplicateGroups.set(item.parentFrom, groups);
  }
  for (const [parent, groups] of duplicateGroups) {
    if (parent !== null && !matches.has(parent)) continue;
    const targetParent = parent === null ? null : matches.get(parent)!.from;
    for (const siblings of groups.values()) {
      if (siblings.every(item => matches.has(item.from))) continue;
      const candidates = (structuralTargets.get(oldKeys.get(siblings[0].from)!) ?? []).filter(item => item.parentFrom === targetParent
        && (parent === null || newLists.get(item.from) === oldLists.get(siblings[0].from)));
      if (candidates.length !== siblings.length) continue;
      const ordered = [...siblings].sort((a, b) => Number(recent.has(b.from)) - Number(recent.has(a.from)));
      ordered.forEach((item, index) => matches.set(item.from, candidates[index]));
    }
  }
  const map = (position: number): number => {
    const item = before.items.filter(item => position >= item.from && position <= item.to && matches.has(item.from)).at(-1);
    if (!item) return changes.mapPos(position, -1);
    const target = matches.get(item.from)!;
    const line = state.doc.lineAt(position);
    const first = state.doc.lineAt(item.moveFrom);
    const nextLines = after.text.slice(target.moveFrom, target.moveTo).split('\n');
    const offset = line.number - first.number;
    const lineFrom = target.moveFrom + nextLines.slice(0, offset).reduce((length, text) => length + text.length + 1, 0);
    const removedIndent = (item.markerFrom - item.moveFrom) - (target.markerFrom - target.moveFrom);
    return Math.min(target.to, lineFrom + Math.max(0, position - line.from - removedIndent));
  };
  const sourceReturn = state.field(sourceReturnField, false);
  const folds = new Set([...state.field(foldsField)].flatMap(from => matches.has(from) ? [matches.get(from)!.from] : []));
  const expandedGroups = new Set([...state.field(expandedCompletedGroupsField)].flatMap(from => matches.has(from) ? [matches.get(from)!.from] : []));
  const byFrom = new Map(before.items.map(item => [item.from, item]));
  // 新增完成子任务后重新收起相关摘要；使用布局映射后的父项身份，不能沿旧坐标误收起别的任务。
  for (const from of completedFrom) {
    const parent = byFrom.get(from)?.parentFrom;
    if (parent !== null && parent !== undefined && matches.has(parent)) expandedGroups.delete(matches.get(parent)!.from);
  }
  return {
    changes,
    selection: EditorSelection.create(state.selection.ranges.map(range => EditorSelection.range(map(range.anchor), map(range.head))), state.selection.mainIndex),
    effects: [
      setFolds.of([...folds]),
      setExpandedCompletedGroups.of([...expandedGroups]),
      // 布局移动会覆盖一大片旧坐标，返回预览的阅读锚点必须与选区使用同一身份映射。
      ...(sourceReturn ? [setSourceReturn.of({ ...sourceReturn, cursor: map(sourceReturn.cursor), anchor: map(sourceReturn.anchor) })] : []),
    ],
    sequential: true,
  };
}
