/**
 * 文件职责：统一完成过滤与折叠的隐藏范围，约束不可见正文的键盘访问。
 * 定义范围：隐藏投影、原子光标范围和空选区删除保护；不改写 Markdown 语义。
 */
import { EditorSelection, EditorState, Prec, Transaction, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { getHiddenRanges, type DocumentModel } from '../markdown';
import { completionField, documentField, foldsField, modeFacet } from './state';
import { codeFenceEditing } from './code-fence-editing';

/**
 * 结构职责：表示预览和键盘行为共同采用的隐藏内容区间。
 * 字段说明：kind 区分整行过滤与首行后折叠；itemFrom 指向折叠项或完成摘要的父项。
 * 约束条件：范围左闭右开、已排序且互不重叠，源码模式没有隐藏范围。
 */
export interface HiddenContentRange {
  from: number; to: number;
  kind: 'completed' | 'filtered' | 'fold';
  itemFrom: number | null;
  count: number;
}
/** 同一模型只保留最新界面依赖组合；文本快照释放后缓存可自动回收。 */
interface VisibilityCache {
  mode: string; folds: ReadonlySet<number>; completions: ReadonlyMap<number, number>;
  ranges: readonly HiddenContentRange[]; atoms?: DecorationSet;
}
const visibilityCache = new WeakMap<DocumentModel, VisibilityCache>();

/**
 * 函数职责：派生当前完成过滤与折叠共同决定的隐藏范围。
 * 输入说明：state 必须包含文档、完成过渡、模式及折叠字段。
 * 输出说明：相同依赖组合返回缓存结果，预览与原子光标范围复用同一结果。
 * 实现思路：先选择过滤范围，再覆盖折叠范围并合并重叠区间。
 */
export function hiddenContentRanges(state: EditorState): readonly HiddenContentRange[] {
  const mode = state.facet(modeFacet);
  if (mode === 'source') return [];
  const model = state.field(documentField);
  const folds = state.field(foldsField);
  const completions = state.field(completionField);
  const cached = visibilityCache.get(model);
  if (cached?.mode === mode && cached.folds === folds && cached.completions === completions) return cached.ranges;
  const completing = [...completions.values()];
  const ranges: HiddenContentRange[] = getHiddenRanges(model,mode)
    .filter(range => mode !== 'todo' || !completing.some(from => from >= range.from && from < range.to))
    .map(range => ({ from: range.from, to: range.to, kind: mode === 'todo' ? 'completed' : 'filtered', itemFrom: range.parentFrom, count: range.count }));
  for (const item of model.items) {
    if (folds.has(item.from) && item.to > item.firstLineTo) ranges.push({ from: item.firstLineTo, to: item.to, kind: 'fold', itemFrom: item.from, count: 0 });
  }
  ranges.sort((a,b)=>a.from-b.from || b.to-a.to);
  const merged: HiddenContentRange[] = [];
  for (const range of ranges) {
    if (range.from >= range.to) continue;
    const previous = merged.at(-1);
    if (previous && range.from < previous.to) { previous.to = Math.max(previous.to, range.to); continue; }
    // 连续完成子项共用父级摘要；折叠提示和不同父项的摘要保持独立。
    if (previous && previous.to === range.from && previous.kind === 'completed' && range.kind === 'completed' && previous.itemFrom === range.itemFrom) {
      previous.to = range.to; previous.count += range.count; continue;
    }
    merged.push({ ...range });
  }
  visibilityCache.set(model,{ mode, folds, completions, ranges: merged });
  return merged;
}
/**
 * 函数职责：把共同隐藏范围交给 CodeMirror 原子光标导航。
 * 输入说明：与 hiddenContentRanges 使用同一状态。
 * 输出说明：仅供 atomicRanges 使用，不作为第二份预览装饰绘制。
 * 实现思路：将已合并的隐藏区间转换为范围集合并缓存。
 */
export function hiddenContentAtoms(state: EditorState): DecorationSet {
  const ranges = hiddenContentRanges(state);
  if (!ranges.length) return Decoration.none;
  const cached = visibilityCache.get(state.field(documentField))!;
  return cached.atoms ??= Decoration.set(ranges.map(range => Decoration.mark({}).range(range.from,range.to)),true);
}
/** 返回首个末端不小于指定位置的区间索引，键盘热路径无需扫描整份清单。 */
function nearbyRange(ranges: readonly HiddenContentRange[], position: number): number {
  let low = 0; let high = ranges.length;
  while (low < high) { const middle = (low + high) >>> 1; if (ranges[middle].to < position) low = middle + 1; else high = middle; }
  return low;
}
/** 整行过滤的前边界位于上一行换行之后，后退时落到上一条可见行的末端。 */
function visibleBoundary(state: EditorState, range: HiddenContentRange, direction: -1 | 1): number {
  if (direction === 1) return range.to;
  if (range.kind === 'fold') return range.from;
  if (!range.from) return range.to;
  const previous = state.doc.sliceString(Math.max(0,range.from-2),range.from);
  return range.from - (previous.endsWith('\r\n') ? 2 : previous.endsWith('\n') ? 1 : 0);
}
/**
 * 函数职责：拦截空选区删除即将触及的不可见正文。
 * 输入说明：direction 表示删除方向；源码、IME 及主动非空选区由正常编辑命令处理。
 * 输出说明：危险操作只移动光标并提示，不删除隐藏段；普通删除返回 false。
 * 实现思路：查找光标附近的隐藏边界，并保护连接隐藏整行的换行分隔。
 */
export function protectHiddenDelete(view: EditorView, direction: -1 | 1): boolean {
  if (view.composing || view.state.facet(modeFacet) === 'source' || view.state.selection.ranges.some(range=>!range.empty)) return false;
  const hidden = hiddenContentRanges(view.state);
  let protectedSelection = false;
  const selections = view.state.selection.ranges.map(selection => {
    const position = selection.head;
    const index = nearbyRange(hidden,Math.max(0,position - (direction === -1 ? 2 : 0)));
    for (let next = index; next < Math.min(index+2,hidden.length); next++) {
      const range = hidden[next];
      const previous = visibleBoundary(view.state,range,-1);
      // 折叠末端不包含最后一行换行；也要保护它，避免下一项被并入不可见正文。
      const separator = range.kind === 'fold' ? view.state.doc.sliceString(range.to,Math.min(view.state.doc.length,range.to+2)) : '';
      const backwardLimit = range.to + (separator.startsWith('\r\n') ? 2 : separator.startsWith('\n') ? 1 : 0);
      const touches = direction === -1 ? position > range.from && position <= backwardLimit : position >= Math.min(previous,range.from) && position < range.to;
      if (!touches) continue;
      protectedSelection = true;
      return EditorSelection.cursor(visibleBoundary(view.state,range,direction));
    }
    return selection;
  });
  if (!protectedSelection) return false;
  view.dispatch({ selection: EditorSelection.create(selections,view.state.selection.mainIndex), effects: EditorView.announce.of('已跳过隐藏内容；展开条目或进入源码模式后可编辑。'), annotations: Transaction.addToHistory.of(false), scrollIntoView: true });
  return true;
}
/**
 * 函数职责：在模式或折叠变化后让不可见位置的选区重新可达。
 * 输入说明：已主动跨越隐藏内容且两端可见的选区保持原样。
 * 输出说明：无需修正返回 null，否则仅调整选区不写文本历史。
 * 实现思路：定位落在隐藏区间内部的端点并映射到可见边界。
 */
export function visibleSelection(state: EditorState): EditorSelection | null {
  const hidden = hiddenContentRanges(state);
  if (!hidden.length) return null;
  const endpoint = (position: number, direction: -1 | 1): number => {
    const range = hidden[nearbyRange(hidden,position)];
    return range && position > range.from && position < range.to ? visibleBoundary(state,range,direction) : position;
  };
  const selection = EditorSelection.create(state.selection.ranges.map(range => {
    if (range.empty) {
      const hiddenRange = hidden[nearbyRange(hidden,range.head)];
      const direction = hiddenRange && range.head - hiddenRange.from < hiddenRange.to - range.head ? -1 : 1;
      return EditorSelection.cursor(endpoint(range.head,direction));
    }
    return EditorSelection.range(endpoint(range.anchor,range.anchor < range.head ? -1 : 1),endpoint(range.head,range.anchor < range.head ? 1 : -1));
  }),state.selection.mainIndex);
  return selection.eq(state.selection) ? null : selection;
}
/**
 * 结构职责：将共同范围、键盘保护与选区可达性连接到编辑器。
 * 字段说明：高优先级删除守卫先于 Markdown 及默认删除运行。
 * 约束条件：显式选择删除、复制粘贴、撤销与源码编辑维持正常语义。
 */
export const contentVisibility: Extension = [
  codeFenceEditing,
  EditorView.atomicRanges.of(view=>hiddenContentAtoms(view.state)),
  Prec.highest(keymap.of([
    { key: 'Backspace', run: view=>protectHiddenDelete(view,-1), shift: view=>protectHiddenDelete(view,-1) },
    { key: 'Delete', run: view=>protectHiddenDelete(view,1) },
    { key: 'Mod-Backspace', run: view=>protectHiddenDelete(view,-1) },
    { key: 'Mod-Delete', run: view=>protectHiddenDelete(view,1) },
    { key: 'Ctrl-h', run: view=>protectHiddenDelete(view,-1) },
  ])),
  EditorState.transactionFilter.of(transaction => {
    const selection = visibleSelection(transaction.state);
    return selection ? [transaction,{ selection, sequential: true }] : transaction;
  }),
];
