/**
 * 文件职责：约束预览模式代码围栏的键盘可达性，保留代码正文的直接编辑。
 * 定义范围：围栏原子范围、选区修正和空选区删除守卫；不拦截正文事务。
 */
import { EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { documentField, modeFacet } from './state';
import type { DocumentModel } from '../markdown';

/**
 * 结构职责：记录一个具有正文行的围栏与可编辑正文边界。
 * 字段说明：from/to 是完整围栏区域，bodyFrom/bodyTo 是正文首尾位置。
 * 约束条件：正文可以为空行；尚未产生正文行的开围栏不进入投影。
 */
interface CodeFenceRange { from: number; to: number; bodyFrom: number; bodyTo: number; closed: boolean }
/** 语法投影随文本快照释放，选区移动复用已有边界而不扫描语法树。 */
const fenceCache = new WeakMap<DocumentModel, readonly CodeFenceRange[]>();

/**
 * 函数职责：从共享语法树派生需要隐藏的围栏边界。
 * 输入说明：状态必须包含 documentField 和 modeFacet。
 * 输出说明：源码模式返回空集合，未闭合且已有正文的代码只隐藏开围栏。
 * 实现思路：按 CodeMark 所在行确定正文范围，复用编辑器文本坐标。
 */
function codeFences(state: EditorState): readonly CodeFenceRange[] {
  if (state.facet(modeFacet) === 'source') return [];
  const model = state.field(documentField);
  const cached = fenceCache.get(model);
  if (cached) return cached;
  const ranges: CodeFenceRange[] = [];
  model.tree.iterate({ enter(ref) {
    if (ref.name !== 'FencedCode') return;
    const marks = ref.node.getChildren('CodeMark');
    const first = state.doc.lineAt(ref.from); const last = state.doc.lineAt(ref.to);
    const closed = marks.length > 1;
    const bodyLast = last.number - (closed ? 1 : 0);
    if (bodyLast <= first.number) return false;
    ranges.push({ from: first.from, to: last.to, bodyFrom: state.doc.line(first.number + 1).from, bodyTo: state.doc.line(bodyLast).to, closed });
    return false;
  } });
  fenceCache.set(model, ranges);
  return ranges;
}

/**
 * 函数职责：为隐藏围栏生成原子导航范围。
 * 输入说明：使用当前编辑状态的围栏投影。
 * 输出说明：只供 atomicRanges 使用，不绘制装饰。
 * 实现思路：将围栏及相邻换行合并为跳向可见行的范围。
 */
function fenceAtoms(state: EditorState): DecorationSet {
  const ranges = codeFences(state).flatMap(fence => {
    const opening = Decoration.mark({}).range(fence.from ? fence.from - 1 : 0, fence.bodyFrom);
    return fence.closed ? [opening, Decoration.mark({}).range(fence.bodyTo, fence.to < state.doc.length ? fence.to + 1 : fence.to)] : [opening];
  });
  return Decoration.set(ranges, true);
}

/**
 * 函数职责：保护代码正文边界上的空选区删除。
 * 输入说明：direction 为删除方向；显式选区、IME 和源码模式保持正常语义。
 * 输出说明：边界删除返回 true，不修改正文或历史。
 * 实现思路：识别代码正文和相邻外部正文触及围栏的边界，不过滤文档事务。
 */
function protectFenceDelete(view: EditorView, direction: -1 | 1): boolean {
  if (view.composing || view.state.selection.ranges.some(range => !range.empty)) return false;
  const fences = codeFences(view.state);
  // 默认删除命令会跨越 atomicRanges；外部正文也必须保护，防止一次删除吞掉整条围栏。
  return view.state.selection.ranges.some(selection => fences.some(fence => direction === -1
    ? selection.head === fence.bodyFrom || fence.closed && fence.to < view.state.doc.length && selection.head === fence.to + 1
    : fence.closed && selection.head === fence.bodyTo || fence.from > 0 && selection.head === fence.from - 1));
}

/**
 * 函数职责：把落在隐藏围栏行上的选区端点移回代码正文。
 * 输入说明：显式跨越代码的选区保留可见端点。
 * 输出说明：选区已可见时返回 null；不修改文本。
 * 实现思路：按围栏行与正文边界映射端点，补足文首文末的原子导航边界。
 */
function fenceSelection(state: EditorState): EditorSelection | null {
  const fences = codeFences(state);
  if (!fences.length) return null;
  const endpoint = (position: number): number => {
    for (const fence of fences) {
      if (position >= fence.from && position < fence.bodyFrom) return fence.bodyFrom;
      if (fence.closed && position > fence.bodyTo && position <= fence.to) return fence.bodyTo;
    }
    return position;
  };
  const selection = EditorSelection.create(state.selection.ranges.map(range => EditorSelection.range(endpoint(range.anchor), endpoint(range.head))), state.selection.mainIndex);
  return selection.eq(state.selection) ? null : selection;
}

export const codeFenceEditing: Extension = [
  EditorView.atomicRanges.of(view => fenceAtoms(view.state)),
  Prec.highest(keymap.of([
    { key: 'Backspace', run: view => protectFenceDelete(view, -1), shift: view => protectFenceDelete(view, -1) },
    { key: 'Delete', run: view => protectFenceDelete(view, 1) },
    { key: 'Mod-Backspace', run: view => protectFenceDelete(view, -1) },
    { key: 'Mod-Delete', run: view => protectFenceDelete(view, 1) },
    { key: 'Ctrl-h', run: view => protectFenceDelete(view, -1) },
  ])),
  EditorState.transactionFilter.of(transaction => {
    const selection = fenceSelection(transaction.state);
    return selection ? [transaction, { selection, sequential: true }] : transaction;
  }),
];
