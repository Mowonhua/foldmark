/**
 * 文件职责：统一代码围栏和块公式的正文边界。
 * 定义范围：共享块模型、围栏显示范围和空块激活。
 */
import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { DocumentModel } from '../markdown';
import { documentField, modeFacet } from './state';
import { draftFencedBlocksField } from './fenced-block-state';
import { paragraphLayout } from './paragraphs';

/**
 * 结构职责：描述一块源文及其可编辑正文。
 * 字段说明：nodeFrom 为语法节点起点；from/to 包含独立行缩进；bodyFrom/bodyTo 不含围栏。
 * 约束条件：正文使用内部 LF 坐标；无正文行时 hasBody=false，单行公式正文允许为空。
 */
export interface FencedBlock {
  kind: 'code' | 'math';
  nodeFrom: number;
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  indent: string;
  delimiter: string;
  closed: boolean;
  hasBody: boolean;
  /** 需要隐藏的标记范围；wholeLine 表示该物理行只承载围栏，预览中零高显示。 */
  marks: readonly { from: number; to: number; wholeLine: boolean }[];
}

/** 只有开围栏和尾随空白时仍处于创建阶段，不能提前隐藏开围栏或把输入焦点移到后方空白。 */
export function pendingFencedBlock(state: EditorState, block: FencedBlock): boolean {
  return !!state.field(draftFencedBlocksField, false)?.includes(block.nodeFrom)
    || !block.closed && !state.doc.sliceString(block.bodyFrom, block.bodyTo).trim();
}

/**
 * 函数职责：维护块后分隔及可以继续输入的同容器正文出口。
 * 输入说明：closingEnd 属于 spec 执行后的文档；continuationIndent 指定出口缩进，emptyOutlet 要求创建时有空行。
 * 输出说明：返回一次事务中的编辑计划；源码模式不整理，已有合适出口不重复新增。
 * 实现思路：创建块时保留外部空行，后续编辑复用同容器正文；不清理已有内容或移动块内光标。
 */
export function withFencedBlockSeparator(state: EditorState, spec: TransactionSpec, closingEnd: number, continuationIndent?: string, emptyOutlet = false): TransactionSpec[] {
  if (state.facet(modeFacet) !== 'todo') return [spec];
  const doc = state.changes(spec.changes).apply(state.doc);
  if (continuationIndent !== undefined) {
    // 同容器的后续正文已经提供输入出口时不重复插行；新块在文末也必须有可到达的出口。
    const next = paragraphLayout(state.update({ ...spec, filter: false }).state).paragraphs.find(paragraph => paragraph.from > closingEnd);
    if (next && (next.kind === 'empty' || !emptyOutlet && next.kind === 'text') && next.indent === continuationIndent) {
      return next.from === closingEnd + 1 ? [spec, { changes: { from: closingEnd, insert: '\n' }, sequential: true }] : [spec];
    }
    const line = doc.lineAt(closingEnd);
    const suffix = closingEnd < doc.length && doc.line(line.number + 1).text.trim() ? '\n' : '';
    return [spec, { changes: { from: closingEnd, insert: '\n\n' + continuationIndent + suffix }, sequential: true }];
  }
  if (closingEnd >= doc.length) return [spec];
  const line = doc.lineAt(closingEnd);
  if (closingEnd !== line.to || !doc.line(line.number + 1).text.trim()) return [spec];
  return [spec, { changes: { from: closingEnd, insert: '\n' }, sequential: true }];
}

/**
 * 函数职责：提供绘制与键盘行为共用的代码及公式边界。
 * 输入说明：状态已挂载 documentField；读取不改写源文。
 * 输出说明：返回按节点位置排序、随文档快照缓存的块集合。
 * 实现思路：复用语法节点身份，按实际定界符与物理行计算正文及隐藏范围。
 */
const blockCache = new WeakMap<DocumentModel, readonly FencedBlock[]>();
export function fencedBlocks(state: EditorState): readonly FencedBlock[] {
  const model = state.field(documentField);
  const cached = blockCache.get(model);
  if (cached) return cached;
  const result: FencedBlock[] = [];
  const items = new Map(model.items.map(item => [item.from, item]));
  model.tree.iterate({ enter(ref) {
    if (ref.name !== 'FencedCode' && ref.name !== 'MathBlock') return;
    const { doc } = state;
    const first = doc.lineAt(ref.from), last = doc.lineAt(ref.to);
    const prefix = doc.sliceString(first.from, ref.from);
    const from = prefix.trim() ? ref.from : first.from;
    // 同行列表标记必须保留，但下一行只能复制容器缩进，不能再次生成列表标记。
    let indent = prefix;
    for (let parent = ref.node.parent; parent; parent = parent.parent) {
      const item = parent.name === 'ListItem' ? items.get(parent.from) : undefined;
      if (item && item.moveFrom === first.from) {
        const start = item.markerFrom - first.from, end = item.markerTo - first.from;
        indent = indent.slice(0, start) + ' '.repeat(end - start) + indent.slice(end);
      }
    }
    const marks: { from: number; to: number; wholeLine: boolean }[] = [];
    const addMark = (start: number, end: number, standalone: boolean) => {
      const line = doc.lineAt(start);
      const wholeLine = standalone && !doc.sliceString(line.from, start).trim();
      marks.push({ from: wholeLine ? line.from : start, to: standalone ? line.to : end, wholeLine });
    };
    let closed: boolean, hasBody: boolean, bodyFrom: number, bodyTo: number, delimiter: string;
    if (ref.name === 'FencedCode') {
      const codeMarks = ref.node.getChildren('CodeMark');
      if (!codeMarks.length) return false;
      delimiter = doc.sliceString(codeMarks[0].from, codeMarks[0].to);
      closed = codeMarks.length > 1;
      for (const mark of codeMarks) addMark(mark.from, mark.to, true);
      const bodyLast = last.number - Number(closed);
      hasBody = bodyLast > first.number;
      bodyFrom = hasBody ? doc.line(first.number + 1).from : first.to;
      bodyTo = hasBody ? doc.line(bodyLast).to : bodyFrom;
    } else {
      delimiter = '$$';
      const firstEnd = first.text.trimEnd().length + first.from;
      const inline = first.number === last.number && firstEnd >= ref.from + 4 && doc.sliceString(firstEnd - 2, firstEnd) === '$$';
      const closingEnd = last.from + last.text.trimEnd().length;
      const closingFrom = closingEnd - 2;
      closed = inline || (last.number > first.number && doc.sliceString(closingFrom, closingEnd) === '$$'
        && /^[ \t>]*$/.test(doc.sliceString(last.from, closingFrom)));
      const openingHasContent = inline || !!doc.sliceString(ref.from + 2, first.to).trim();
      addMark(ref.from, ref.from + 2, !openingHasContent);
      if (closed) addMark(closingFrom, closingEnd, !inline);
      const bodyLast = last.number - Number(closed && !inline);
      hasBody = openingHasContent || bodyLast > first.number;
      bodyFrom = openingHasContent ? ref.from + 2 : hasBody ? doc.line(first.number + 1).from : first.to;
      bodyTo = inline ? closingFrom : hasBody ? doc.line(bodyLast).to : bodyFrom;
    }
    // 仅跳过与围栏一致的结构前缀；代码或公式自身的额外缩进仍是可编辑正文。
    if (hasBody && doc.lineAt(bodyFrom).number > first.number && doc.sliceString(bodyFrom, bodyFrom + indent.length) === indent) bodyFrom += indent.length;
    result.push({ kind: ref.name === 'FencedCode' ? 'code' : 'math', nodeFrom: ref.from, from, to: last.to,
      bodyFrom, bodyTo, indent, delimiter, closed, hasBody, marks });
    return false;
  } });
  blockCache.set(model, result);
  return result;
}

/**
 * 函数职责：将焦点置入块正文，无正文行的闭合空块在首次编辑时补一个输入行。
 * 输入说明：from 为当前节点起点，只读状态不接管。
 * 输出说明：激活成功返回 true；必要的源文插入可一次撤销。
 * 实现思路：从共享边界选择正文落点，闭合且没有正文行时局部插入容器缩进。
 */
export function activateFencedBlock(view: EditorView, from: number): boolean {
  if (view.state.readOnly) return false;
  const block = fencedBlocks(view.state).find(candidate => candidate.nodeFrom === from);
  if (!block || (!block.hasBody && !block.closed)) return false;
  if (block.hasBody) view.dispatch({ selection: { anchor: block.bodyFrom }, scrollIntoView: true });
  else {
    const opening = view.state.doc.lineAt(block.nodeFrom);
    const insert = '\n' + block.indent;
    const spec = { changes: { from: opening.to, insert }, selection: { anchor: opening.to + insert.length }, userEvent: 'input', scrollIntoView: true };
    view.dispatch(...withFencedBlockSeparator(view.state, spec, block.to + insert.length, block.indent, true));
  }
  view.focus();
  return true;
}
