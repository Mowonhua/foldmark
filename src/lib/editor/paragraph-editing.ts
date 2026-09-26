/**
 * 文件职责：将预览键盘意图转换为共享模型上的段落编辑。
 * 定义范围：段落拆分、任务续项与转正文、段落合并和空段落删除。
 */
import { translate } from '../i18n';
import { EditorView } from '@codemirror/view';
import { findClusterBreak, type TransactionSpec } from '@codemirror/state';
import { documentField, mapSoftBreaks, modeFacet, setSoftBreaks, softBreaksField } from './state';
import { hiddenContentRanges } from './visibility';
import { paragraphAt, paragraphLayout, replaceParagraphs, type Paragraph, type ParagraphLayout } from './paragraphs';

/**
 * 结构职责：表示预览编辑器支持的结构键盘意图。
 * 字段说明：soft-enter 只插入段内换行，其余意图可修改段落与分隔。
 * 约束条件：源码、只读、多光标及 IME 组合阶段交给原有输入路径。
 */
export type ParagraphEdit = 'enter' | 'soft-enter' | 'backspace' | 'delete';

/**
 * 函数职责：在同一段落模型上执行结构编辑，并保护隐藏内容及字面块。
 * 输入说明：view 是唯一编辑视图，intent 来自普通无修饰键位。
 * 输出说明：接管时只提交一笔文本事务，未接管返回 false；不修改全篇未触及的分隔。
 * 实现思路：读取段落及真实容器边界，将键盘动作变为段落替换，再由共同序列化器维护分隔。
 */
export function editParagraph(view: EditorView, intent: ParagraphEdit): boolean {
  const { state } = view;
  if (view.composing || state.readOnly || state.facet(modeFacet) !== 'todo' || state.selection.ranges.length !== 1) return false;
  const selection = state.selection.main;
  const layout = paragraphLayout(state);
  const first = paragraphAt(layout, selection.from), last = paragraphAt(layout, selection.to);
  if (first < 0 || last < 0 || layout.paragraphs.slice(first, last + 1).some(p => p.kind === 'literal')) return false;
  if (intent === 'enter' || intent === 'soft-enter') return enter(view, layout, first, last, intent === 'soft-enter');
  if (!selection.empty) {
    const left = state.doc.sliceString(layout.paragraphs[first].from, selection.from);
    const right = state.doc.sliceString(selection.to, layout.paragraphs[last].to);
    return submit(view, replaceParagraphs(state, first, last, [left + right], left.length, 'delete'));
  }
  return remove(view, layout, first, intent === 'backspace' ? -1 : 1);
}

/** 列表首段属于父容器，正文段属于当前条目；合并只允许发生在兼容的容器中。 */
function container(paragraph: Paragraph): number | null {
  return paragraph.kind === 'list' ? paragraph.item?.parentFrom ?? null : paragraph.item?.from ?? null;
}

/** 所有结构命令在提交前统一检查真实写入范围，不让局部分隔维护触碰不可见正文。 */
function submit(view: EditorView, spec: TransactionSpec): boolean {
  // 主动非空选区沿用编辑器的显式删除契约；隐式结构编辑才需要检查可见性。
  if (!view.state.selection.main.empty) { view.dispatch(spec); return true; }
  const changes = view.state.changes(spec.changes);
  const hidden = hiddenContentRanges(view.state);
  let blocked = false;
  changes.iterChangedRanges((from, to) => {
    if (hidden.some(range => from < range.to && to > range.from)) blocked = true;
  });
  if (blocked) return protect(view);
  // 去标记可能改变列表归属，即使旧坐标没有触及隐藏正文，新段落也可能进入折叠或归档。
  // 先在无副作用的新状态检查目标段落，再交正常事务过滤器处理保存布局及光标映射。
  const planned = view.state.update({ ...spec, filter: false });
  const target = planned.newSelection.main.head;
  if (hiddenContentRanges(planned.state).some(range => target > range.from && target < range.to)) return protect(view);
  view.dispatch(spec);
  return true;
}

/** 跨语法保护边界的合并不回落到逐字符删除，否则默认原子删除会绕过结构约束。 */
function protect(view: EditorView): true {
  view.dispatch({ effects: EditorView.announce.of(translate('请先展开或切换到对应内容视图，再编辑此段落边界。')) });
  return true;
}

/** Enter 拆分段落，Shift Enter 保留段内软换行；列表首段续项也使用相同分隔序列化。 */
function enter(view: EditorView, layout: ParagraphLayout, first: number, last: number, soft: boolean): boolean {
  const { state } = view, selection = state.selection.main;
  const paragraph = layout.paragraphs[first], ending = layout.paragraphs[last];
  if (container(paragraph) !== container(ending)) return false;
  if (selection.from < paragraph.contentFrom) {
    const raw = state.doc.sliceString(paragraph.from, paragraph.to);
    if (!/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[ \][ \t]*$/.test(raw)) return false;
  }
  const left = state.doc.sliceString(paragraph.from, selection.from);
  const right = state.doc.sliceString(selection.to, ending.to);
  if (soft) {
    // 段内换行只写 LF 和容器缩进；尚未输入文字的续行身份保存在编辑状态，不向源码添加标记。
    const insert = '\n' + paragraph.indent;
    const changes = state.changes({ from: selection.from, to: selection.to, insert });
    const breaks = mapSoftBreaks(state.field(softBreaksField), changes);
    const spec = { changes, selection: { anchor: selection.from + insert.length }, effects: setSoftBreaks.of([...breaks, selection.from]), userEvent: 'input' };
    return submit(view, spec);
  }
  let prefix = paragraph.indent;
  if (paragraph.kind === 'list' && paragraph.item && selection.from <= paragraph.item.firstLineTo) {
    const item = paragraph.item;
    const line = state.doc.lineAt(item.from);
    const raw = state.doc.sliceString(paragraph.from, paragraph.to);
    const empty = !state.doc.sliceString(paragraph.contentFrom, paragraph.to).trim()
      || /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[ \][ \t]*$/.test(raw);
    if (empty) {
      const indent = state.doc.sliceString(line.from, item.markerFrom);
      return submit(view, replaceParagraphs(state, first, last, [indent], indent.length, 'input'));
    }
    const marker = state.doc.sliceString(item.markerFrom, item.markerTo).replace(/\d+/, digits => String(Number(digits) + 1));
    prefix = state.doc.sliceString(line.from, item.markerFrom) + marker + (item.task ? ' [ ] ' : ' ');
  }
  return submit(view, replaceParagraphs(state, first, last, [left, prefix + right], left.length + 2 + prefix.length, 'input'));
}

/** 任务去标记后沿真实相邻列表容器继续正文，不把复选框的宽度当成 Markdown 缩进。 */
function unlist(view: EditorView, layout: ParagraphLayout, index: number): boolean {
  const paragraph = layout.paragraphs[index], item = paragraph.item!;
  let previous = index - 1;
  while (previous >= 0 && layout.paragraphs[previous].kind === 'empty') previous--;
  let target = previous >= 0 ? layout.paragraphs[previous].item : null;
  const items = view.state.field(documentField).items;
  while (target && target.depth > item.depth) target = items.find(candidate => candidate.from === target!.parentFrom) ?? null;
  const indent = target ? ' '.repeat(target.markerTo - view.state.doc.lineAt(target.from).from + 1) : '';
  const content = view.state.doc.sliceString(paragraph.contentFrom, paragraph.to);
  return submit(view, replaceParagraphs(view.state, index, index, [indent + content], indent.length, 'delete'));
}

/** 删除空段落或合并相邻段落，逐字删除仍使用编辑器默认字形规则。 */
function remove(view: EditorView, layout: ParagraphLayout, index: number, direction: -1 | 1): boolean {
  const { state } = view, pos = state.selection.main.head;
  const paragraph = layout.paragraphs[index];
  const raw = state.doc.sliceString(paragraph.from, paragraph.to);
  if (direction === -1 && paragraph.kind === 'list' && paragraph.item &&
    (pos === paragraph.contentFrom || /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[ \][ \t]*$/.test(raw))) return unlist(view, layout, index);
  if (paragraph.kind === 'empty') return submit(view, replaceParagraphs(state, index, index, [], direction === -1 ? 'before' : 'after', 'delete'));
  const atBoundary = direction === -1 ? pos === paragraph.contentFrom : pos === paragraph.to;
  if (!atBoundary) {
    if (paragraph.kind !== 'text') return false;
    const offset = pos - paragraph.from, next = findClusterBreak(raw, offset, direction === 1);
    const remaining = raw.slice(0, Math.min(offset, next)) + raw.slice(Math.max(offset, next));
    return !remaining.trim() ? submit(view, replaceParagraphs(state, index, index, [paragraph.indent], paragraph.indent.length, 'delete')) : false;
  }
  const adjacentIndex = index + direction, adjacent = layout.paragraphs[adjacentIndex];
  if (!adjacent) return false;
  if (adjacent.kind === 'empty') return submit(view, replaceParagraphs(state, adjacentIndex, adjacentIndex, [], direction === -1 ? 'after' : 'before', 'delete'));
  if (adjacent.kind === 'literal' || container(adjacent) !== container(paragraph)) {
    // 正文首段可以并回所属任务标题，但不能越过另一条任务或字面块的边界。
    if (!(direction === -1 && adjacent.kind === 'list' && paragraph.item?.from === adjacent.item?.from)) return protect(view);
  }
  const before = direction === -1 ? adjacent : paragraph, after = direction === -1 ? paragraph : adjacent;
  const left = state.doc.sliceString(before.from, before.to), right = state.doc.sliceString(after.contentFrom, after.to);
  return submit(view, replaceParagraphs(state, Math.min(index, adjacentIndex), Math.max(index, adjacentIndex), [left + right], left.length, 'delete'));
}
