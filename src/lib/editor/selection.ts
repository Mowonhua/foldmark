/** 文件职责：保留 CodeMirror 的选区几何，并将代码区域的高亮限制在各行边框内。 */
import { Direction, EditorView, RectangleMarker, layer } from '@codemirror/view';

interface CodeRowBounds { left: number; right: number; top: number; bottom: number }

/**
 * 跨行选区可能用一个矩形覆盖多行；按代码行上下边界拆分，才能分别处理不同缩进。
 * 代码区域之外的片段保持原样，避免改变段落、控件以及源码模式的选择显示。
 */
function clipToCodeRows(marker: RectangleMarker, rows: CodeRowBounds[]): RectangleMarker[] {
  if (marker.width === null) return [marker];
  const bottom = marker.top + marker.height;
  const intersecting = rows.filter(row => row.top < bottom && row.bottom > marker.top);
  if (!intersecting.length) return [marker];
  const edges = [...new Set([marker.top, bottom, ...intersecting.flatMap(row => [Math.max(marker.top, row.top), Math.min(bottom, row.bottom)])])].sort((a, b) => a - b);
  const pieces: RectangleMarker[] = [];
  for (let i = 1; i < edges.length; i++) {
    const top = edges[i - 1], end = edges[i];
    const row = intersecting.find(row => row.top < end && row.bottom > top);
    const left = row ? Math.max(marker.left, row.left) : marker.left;
    const right = row ? Math.min(marker.left + marker.width, row.right) : marker.left + marker.width;
    if (right > left) pieces.push(new RectangleMarker('cm-selectionBackground', left, top, right - left, end - top));
  }
  return pieces;
}

export const codeSelection = [
  layer({
    above: false,
    class: 'fm-selectionLayer',
    markers(view) {
      const ranges = view.state.selection.ranges.filter(range => !range.empty);
      if (!ranges.length) return [];
      const scroll = view.scrollDOM.getBoundingClientRect();
      // RectangleMarker 使用滚动内容坐标；DOM 边框须转换到同一坐标系，并保留缩放比例。
      const originLeft = (view.textDirection === Direction.LTR ? scroll.left : scroll.right - view.scrollDOM.clientWidth * view.scaleX) - view.scrollDOM.scrollLeft * view.scaleX;
      const originTop = scroll.top - view.scrollDOM.scrollTop * view.scaleY;
      const rows = [...view.contentDOM.querySelectorAll<HTMLElement>('.fm-code-line')].map(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left - originLeft + element.clientLeft * view.scaleX, right: bounds.left - originLeft + (element.clientLeft + element.clientWidth) * view.scaleX, top: bounds.top - originTop, bottom: bounds.bottom - originTop };
      });
      return ranges.flatMap(range => RectangleMarker.forRange(view, 'cm-selectionBackground', range).flatMap(marker => clipToCodeRows(marker, rows)));
    },
    update: update => update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.some(transaction => transaction.effects.length > 0),
  }),
  // drawSelection 继续负责光标和原生选区隐藏；只替换它的背景，保持输入与多选区行为。
  EditorView.baseTheme({
    '.cm-selectionLayer .cm-selectionBackground': { display: 'none' },
    '.fm-selectionLayer': { zIndex: '-2 !important' },
  }),
];
