/** 文件职责：裁去选区的行间留白，并将代码区域的高亮限制在各行边框内。 */
import { Decoration, Direction, EditorView, RectangleMarker, layer } from '@codemirror/view';

interface CodeRowBounds { left: number; right: number; top: number; bottom: number }
interface VerticalBounds { top: number; bottom: number }

/**
 * CodeMirror 会把相邻行的选区接到行间中点；这里只移除排版留白，不改变文字命中和选区位置。
 * 文本矩形按浏览器的实际换行测量；空行仍保留可见的换行选区，代码行保留代码框内的原有几何。
 */
function lineGaps(view: EditorView, originTop: number): VerticalBounds[] {
  const gaps: VerticalBounds[] = [];
  for (const element of view.contentDOM.querySelectorAll<HTMLElement>('.cm-line, .fm-block-gap')) {
    const bounds = element.getBoundingClientRect();
    if (!bounds.height || element.classList.contains('fm-code-line')) continue;
    if (element.classList.contains('fm-block-gap')) {
      gaps.push({ top: bounds.top - originTop, bottom: bounds.bottom - originTop });
      continue;
    }
    const bands: VerticalBounds[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // 行内操作入口不属于可选正文，其按钮尺寸与绝对定位不能扩大文字高亮。
      if (node.parentElement?.closest('.fm-item-controls, .fm-line-action')) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width && rect.height) bands.push({ top: rect.top, bottom: rect.bottom });
      }
    }
    if (!bands.length) {
      const caret = view.coordsAtPos(view.posAtDOM(element));
      if (caret) bands.push(caret);
    }
    let top = bounds.top;
    for (const band of bands.sort((a, b) => a.top - b.top)) {
      const bottom = Math.min(bounds.bottom, band.top);
      if (bottom > top) gaps.push({ top: top - originTop, bottom: bottom - originTop });
      top = Math.max(top, Math.min(bounds.bottom, band.bottom));
    }
    if (bands.length && top < bounds.bottom) gaps.push({ top: top - originTop, bottom: bounds.bottom - originTop });
  }
  return gaps.sort((a, b) => a.top - b.top);
}

/** 跨多行的矩形按留白区间拆开，保留每段原有的水平边界。 */
function clipLineGaps(marker: RectangleMarker, gaps: VerticalBounds[]): RectangleMarker[] {
  const pieces: RectangleMarker[] = [];
  const bottom = marker.top + marker.height;
  let top = marker.top;
  for (const gap of gaps) {
    if (gap.bottom <= top) continue;
    if (gap.top >= bottom) break;
    if (gap.top > top) pieces.push(new RectangleMarker('cm-selectionBackground', marker.left, top, marker.width, gap.top - top));
    top = Math.max(top, gap.bottom);
  }
  if (top < bottom) pieces.push(new RectangleMarker('cm-selectionBackground', marker.left, top, marker.width, bottom - top));
  return pieces;
}

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
  // 背景层无法改变文字颜色；标记跟随选区更新，使实色主题也能提供可读的反色选区。
  EditorView.decorations.compute(['selection'], state => Decoration.set(
    state.selection.ranges.filter(range => !range.empty).map(range => Decoration.mark({ class: 'fm-selected' }).range(range.from, range.to)),
  )),
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
      const gaps = lineGaps(view, originTop);
      const rows = [...view.contentDOM.querySelectorAll<HTMLElement>('.fm-code-line')].map(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left - originLeft + element.clientLeft * view.scaleX, right: bounds.left - originLeft + (element.clientLeft + element.clientWidth) * view.scaleX, top: bounds.top - originTop, bottom: bounds.bottom - originTop };
      });
      return ranges.flatMap(range => RectangleMarker.forRange(view, 'cm-selectionBackground', range)
        .flatMap(marker => clipLineGaps(marker, gaps)).flatMap(marker => clipToCodeRows(marker, rows)));
    },
    update: update => update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.some(transaction => transaction.effects.length > 0),
  }),
  // drawSelection 继续负责光标和原生选区隐藏；只替换它的背景，保持输入与多选区行为。
  EditorView.baseTheme({
    '.cm-selectionLayer .cm-selectionBackground': { display: 'none' },
    '.fm-selectionLayer': { zIndex: '-2 !important' },
  }),
];
