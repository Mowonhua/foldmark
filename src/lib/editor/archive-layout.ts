/**
 * 文件职责：将源文归档布局整理接入编辑器事务。
 * 定义范围：布局事务、选区与折叠的可靠内容映射。
 */
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { normalizeArchiveChanges, parseDocument, type DocumentModel, type ListItem } from '../markdown';
import { documentField, foldsField, setFolds } from './state';
import { setSourceReturn, sourceReturnField } from './source-position';

/**
 * 函数职责：生成相对当前状态的布局整理事务。
 * 输入说明：状态必须包含文档模型与折叠字段。
 * 输出说明：无变化返回 null；有变化保留可唯一匹配的条目选区和折叠。
 * 实现思路：共享 Markdown 内核负责布局，编辑层按内容恢复条目身份。
 */
export function archiveLayoutSpec(state: EditorState): TransactionSpec | null {
  const before = state.field(documentField);
  const changes = state.changes(normalizeArchiveChanges(before));
  if (changes.empty) return null;
  const after = parseDocument(changes.apply(state.doc).toString());
  // 提升子项会改变行首缩进；用去除共同缩进的完整条目内容匹配，只恢复唯一身份。
  const key = (model: DocumentModel, item: ListItem): string => {
    const indent = model.text.slice(item.moveFrom, item.from);
    return model.text.slice(item.from, item.to).split('\n').map((line, index) => index && line.startsWith(indent) ? line.slice(indent.length) : line).join('\n');
  };
  const matches = new Map<number, ListItem>();
  const targets = new Map<string, ListItem[]>();
  for (const item of after.items) { const content = key(after, item); targets.set(content, [...targets.get(content) ?? [], item]); }
  for (const item of before.items) {
    const candidates = targets.get(key(before, item));
    if (candidates?.length === 1) matches.set(item.from, candidates[0]);
  }
  const map = (position: number): number => {
    const item = before.items.filter(item => position >= item.from && position <= item.to && matches.has(item.from)).at(-1);
    if (!item) return changes.mapPos(position, -1);
    const target = matches.get(item.from)!;
    const line = state.doc.lineAt(position);
    const first = state.doc.lineAt(item.from);
    const nextLines = after.text.slice(target.from, target.to).split('\n');
    const offset = line.number - first.number;
    const lineFrom = target.from + nextLines.slice(0, offset).reduce((length, text) => length + text.length + 1, 0);
    const removedIndent = offset ? (item.from - item.moveFrom) - (target.from - target.moveFrom) : item.from - line.from;
    return Math.min(target.to, lineFrom + Math.max(0, position - line.from - removedIndent));
  };
  const sourceReturn = state.field(sourceReturnField, false);
  return {
    changes,
    selection: EditorSelection.create(state.selection.ranges.map(range => EditorSelection.range(map(range.anchor), map(range.head))), state.selection.mainIndex),
    effects: [
      setFolds.of([...state.field(foldsField)].flatMap(from => matches.has(from) ? [matches.get(from)!.from] : [])),
      // 布局移动会覆盖一大片旧坐标，返回预览的阅读锚点必须与选区使用同一身份映射。
      ...(sourceReturn ? [setSourceReturn.of({ ...sourceReturn, cursor: map(sourceReturn.cursor), anchor: map(sourceReturn.anchor) })] : []),
    ],
    sequential: true,
  };
}
