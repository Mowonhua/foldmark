/**
 * 文件职责：统一代码块与公式块的围栏补全、正文输入和删除边界。
 * 定义范围：块内按键、空块删除、隐藏定界符的导航与选区修正。
 */
import { EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import { fencedBlocks, pendingFencedBlock, withFencedBlockSeparator } from './fenced-blocks';
import { mapSoftBreaks, modeFacet, setSoftBreaks, softBreaksField } from './state';
import { paragraphAt, paragraphLayout, replaceParagraphs } from './paragraphs';
import { hiddenContentRanges } from './visibility';
import { confirmFencedBlock, draftFencedBlocksField } from './fenced-block-state';

/**
 * 函数职责：在独立开围栏末端回车时补齐一个正文行和闭围栏。
 * 输入说明：只接管已由语法模型确认、尚无正文的代码或公式开围栏。
 * 输出说明：一次可撤销事务，光标停在正文结构缩进之后。
 * 实现思路：复用共享块边界及原始围栏字符，避免列表和块内缩进由不同规则生成。
 */
export function completeFencedBlock(view: EditorView): boolean {
  const { state } = view;
  if (view.composing || state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const position = state.selection.main.head;
  const block = fencedBlocks(state).find(block => pendingFencedBlock(state, block)
    && position >= state.doc.lineAt(block.nodeFrom).to
    && (state.field(draftFencedBlocksField, false)?.includes(block.nodeFrom) || position <= block.bodyTo));
  if (!block) return false;
  const opening = state.doc.lineAt(block.nodeFrom);
  const from = block.kind === 'math' ? block.nodeFrom + 2 : opening.to;
  const inlineClosed = block.kind === 'math' && block.closed && state.doc.lineAt(block.to).number === opening.number;
  const content = block.kind === 'math' ? state.doc.sliceString(from, inlineClosed ? block.bodyTo : opening.to) : '';
  const insert = `\n${block.indent}${content}\n${block.indent}${block.delimiter}`;
  // 后方空白可能是已有段落间隙；只在开围栏后插入正文和闭围栏，不覆盖这些空白。
  const spec = { changes: { from, to: opening.to, insert }, selection: { anchor: from + 1 + block.indent.length }, effects: confirmFencedBlock.of(block.nodeFrom), userEvent: 'input' };
  view.dispatch(...withFencedBlockSeparator(state, spec, from + insert.length, block.indent, true));
  return true;
}

/**
 * 函数职责：在块内插入普通换行并保留缩进，开围栏先尝试自动补全。
 * 输入说明：预览代码与公式正文共用；源码只保留开围栏补全，其余输入交原生规则。
 * 输出说明：成功时只增加块内输入行，不能创建外部段落或软换行状态。
 * 实现思路：由共享正文范围定位输入点，单行公式首次换行展开为多行定界结构。
 */
export function fencedBlockEnter(view: EditorView): boolean {
  if (completeFencedBlock(view)) return true;
  const { state } = view, selection = state.selection.main;
  if (view.composing || state.readOnly || state.facet(modeFacet) !== 'todo' || state.selection.ranges.length !== 1) return false;
  const block = fencedBlocks(state).find(block => block.hasBody && selection.from >= block.bodyFrom && selection.to <= block.bodyTo);
  if (!block) return false;
  if (block.kind === 'math' && block.closed && state.doc.lineAt(block.from).number === state.doc.lineAt(block.to).number) {
    const left = state.doc.sliceString(block.bodyFrom, selection.from), right = state.doc.sliceString(selection.to, block.bodyTo);
    const prefix = state.doc.sliceString(block.from, block.nodeFrom);
    const before = `${prefix}$$\n${block.indent}${left}\n${block.indent}`;
    const insert = `${before}${right}\n${block.indent}$$`;
    const spec = { changes: { from: block.from, to: block.to, insert }, selection: { anchor: block.from + before.length }, userEvent: 'input' };
    view.dispatch(...withFencedBlockSeparator(state, spec, block.from + insert.length, block.indent, true));
    return true;
  }
  const line = state.doc.lineAt(selection.from);
  const leading = line.text.match(/^[ \t]*/)?.[0] ?? '';
  const indent = leading.length >= block.indent.length ? leading : block.indent;
  const insert = '\n' + indent;
  const spec = { changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length }, userEvent: 'input' };
  const end = block.to + insert.length - (selection.to - selection.from);
  view.dispatch(...(block.closed ? withFencedBlockSeparator(state, spec, end, block.indent) : [spec]));
  return true;
}

/**
 * 函数职责：删除当前激活的空块及其多余段落分隔。
 * 输入说明：from 可指定空块控件的节点；默认使用单空选区，只读、IME 和非空正文不接管。
 * 输出说明：整块删除可一次撤销，相邻任务及隐藏内容保持完整。
 * 实现思路：确认正文仅有空白，再由段落序列化器移除该语法块。
 */
export function removeEmptyFencedBlock(view: EditorView, from?: number): boolean {
  const { state } = view, selection = state.selection.main;
  if (view.composing || state.readOnly || state.facet(modeFacet) !== 'todo' || state.selection.ranges.length !== 1 || !selection.empty) return false;
  const block = fencedBlocks(state).find(block => from === undefined
    ? block.hasBody && selection.head >= block.bodyFrom && selection.head <= block.bodyTo : block.nodeFrom === from);
  if (!block || (!block.hasBody && !block.closed) || state.doc.sliceString(block.bodyFrom, block.bodyTo).trim()) return false;
  if (hiddenContentRanges(state).some(range => block.from < range.to && block.to > range.from)) return true;
  const layout = paragraphLayout(state), index = paragraphAt(layout, block.nodeFrom);
  const paragraph = layout.paragraphs[index];
  // 同行列表标记属于外围条目；只有完整独立段落才连带整理两侧分隔。
  const spec = paragraph?.from === block.from && paragraph.to === block.to
    ? replaceParagraphs(state, index, index, [], 'before', 'delete')
    : { changes: { from: block.from, to: block.to, insert: '' }, selection: { anchor: block.from }, userEvent: 'delete' };
  // Shift Enter 创建块前曾把这个 LF 标记为段内续行；块删除后它已成为段落分隔，不能复活为空软行。
  const breaks = state.field(softBreaksField).filter(position => position !== block.from - 1);
  view.dispatch({ ...spec, effects: setSoftBreaks.of(mapSoftBreaks(breaks, state.changes(spec.changes))) });
  return true;
}

/** 正文两端保护隐藏围栏，空块删除由独立命令先行处理，源码仍可直接改写定界符。 */
function protectDelete(view: EditorView, direction: -1 | 1): boolean {
  if (view.composing || view.state.facet(modeFacet) === 'source' || view.state.selection.ranges.some(range => !range.empty)) return false;
  return view.state.selection.ranges.some(selection => fencedBlocks(view.state).some(block => block.hasBody && (direction === -1
    ? selection.head === block.bodyFrom || block.closed && block.to < view.state.doc.length && selection.head === block.to + 1
    : block.closed && selection.head === block.bodyTo || block.from > 0 && selection.head === block.from - 1)));
}

/** 选区落入定界符时恢复到正文，避免点击公式后先编辑到 $$ 标记。 */
function bodySelection(state: EditorState): EditorSelection | null {
  if (state.facet(modeFacet) === 'source') return null;
  const blocks = fencedBlocks(state).filter(block => block.hasBody && !pendingFencedBlock(state, block));
  const emptyParagraphs = paragraphLayout(state).paragraphs.filter(paragraph => paragraph.kind === 'empty');
  const endpoint = (position: number): number => {
    for (const block of blocks) {
      if (position >= block.from && position < block.bodyFrom) return block.bodyFrom;
      if (block.closed && position > block.bodyTo && position <= block.to) return block.bodyTo;
    }
    for (const paragraph of emptyParagraphs) {
      if (position >= paragraph.from && position < paragraph.contentFrom) return paragraph.contentFrom;
    }
    return position;
  };
  const selection = EditorSelection.create(state.selection.ranges.map(range => EditorSelection.range(endpoint(range.anchor), endpoint(range.head))), state.selection.mainIndex);
  return selection.eq(state.selection) ? null : selection;
}

/** 共享删除守卫和围栏导航，优先于普通 Markdown 编辑命令。 */
export const fencedBlockEditing: Extension = [
  EditorView.atomicRanges.of(view => {
    if (view.state.facet(modeFacet) === 'source') return Decoration.none;
    const layout = paragraphLayout(view.state);
    const atoms = fencedBlocks(view.state).filter(block => block.hasBody && !pendingFencedBlock(view.state, block)).flatMap(block => {
      const opening = Decoration.mark({}).range(block.from ? block.from - 1 : 0, block.bodyFrom);
      const next = layout.paragraphs[paragraphAt(layout, block.to) + 1];
      const exit = next && (next.kind === 'empty' || next.kind === 'text') ? next.contentFrom : block.to < view.state.doc.length ? block.to + 1 : block.to;
      return block.closed ? [opening, Decoration.mark({}).range(block.bodyTo, exit)] : [opening];
    });
    return Decoration.set(atoms, true);
  }),
  Prec.highest(keymap.of([
    { key: 'Backspace', run: view => removeEmptyFencedBlock(view) || protectDelete(view, -1), shift: view => removeEmptyFencedBlock(view) || protectDelete(view, -1) },
    { key: 'Delete', run: view => protectDelete(view, 1) },
    { key: 'Mod-Backspace', run: view => protectDelete(view, -1) },
    { key: 'Mod-Delete', run: view => protectDelete(view, 1) },
    { key: 'Ctrl-h', run: view => protectDelete(view, -1) },
  ])),
  EditorState.transactionFilter.of(transaction => {
    const selection = bodySelection(transaction.state);
    return selection ? [transaction, { selection, sequential: true }] : transaction;
  }),
];
