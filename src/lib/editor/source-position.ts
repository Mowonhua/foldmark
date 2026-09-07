/**
 * 文件职责：保存源码切换的来源阅读位置并随正文编辑映射。
 * 定义范围：来源位置状态、可见行锚点采集和滚动恢复。
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { SourceReturn } from '../contracts';
import { modeFacet } from './state';

/** 保存或清除进入源码前的位置；位置归属于当前项目的 EditorState。 */
export const setSourceReturn = StateEffect.define<SourceReturn | null>();
/** 历史只能恢复当前源码会话的位置，预览中撤销旧编辑不得复活已退出的源码定位。 */
const restoreSourceHistory = StateEffect.define<{ position: SourceReturn | null; session: symbol }>();
const sourcePositionSession = StateField.define<symbol>({
  create: () => Symbol('source-position'),
  update: (value, transaction) => transaction.startState.facet(modeFacet) !== 'source' && transaction.state.facet(modeFacet) === 'source' ? Symbol('source-position') : value,
});
export const sourceReturnField = StateField.define<SourceReturn | null>({
  create: () => null,
  update(value, transaction) {
    let next = value && transaction.docChanged ? { ...value, cursor: transaction.changes.mapPos(value.cursor, 1), anchor: transaction.changes.mapPos(value.anchor, 1) } : value;
    for (const effect of transaction.effects) {
      if (effect.is(setSourceReturn)) next = effect.value;
      if (effect.is(restoreSourceHistory) && transaction.state.facet(modeFacet) === 'source' && effect.value.session === transaction.state.field(sourcePositionSession)) next = effect.value.position;
    }
    return next;
  },
});
export const sourcePositionHistory: Extension = [sourcePositionSession, invertedEffects.of(transaction => transaction.docChanged && transaction.startState.facet(modeFacet) === 'source'
  ? [restoreSourceHistory.of({ position: transaction.startState.field(sourceReturnField), session: transaction.startState.field(sourcePositionSession) })] : [])];

/**
 * 函数职责：记录视口顶部正在阅读的原文行及像素偏移。
 * 输入说明：应在切换装饰之前读取当前 EditorView 的布局。
 * 输出说明：完整文档坐标与视口内偏移；无真实布局时保留 scrollTop 作为退路。
 * 实现思路：用 CodeMirror 行块查询把滚动位置转成可随文档映射的语义锚点。
 */
export function captureSourcePosition(view: EditorView): SourceReturn {
  const { scrollTop, clientHeight } = view.scrollDOM;
  const cursor = view.state.selection.main.head;
  if (!clientHeight) return { cursor, scrollTop, anchor: cursor, offset: 0 };
  const top = view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.clientTop;
  const block = view.lineBlockAtHeight(Math.max(0, top - view.documentTop));
  return { cursor, scrollTop, anchor: block.from, offset: view.documentTop + block.top - top };
}

/**
 * 函数职责：在新视图布局完成后将同一原文行恢复到相同屏幕位置。
 * 输入说明：位置必须属于当前文档；isCurrent 用于取消被项目切换或后续操作淘汰的测量。
 * 输出说明：只更新滚动，不改变光标、正文和撤销历史。
 * 实现思路：通过 requestMeasure 分离布局读取与滚动写入，按行块像素差校正。
 */
export function restoreSourcePosition(view: EditorView, position: SourceReturn, isCurrent: () => boolean): void {
  let attempts = 0;
  const measure = (): void => view.requestMeasure({
    key: restoreSourcePosition,
    read: () => {
      if (!isCurrent()) return null;
      if (!view.scrollDOM.clientHeight) return position.scrollTop;
      const block = view.lineBlockAt(Math.min(position.anchor, view.state.doc.length));
      const top = view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.clientTop;
      return Math.max(0, view.scrollDOM.scrollTop + view.documentTop + block.top - top - position.offset);
    },
    write: scrollTop => {
      if (scrollTop === null || !isCurrent()) return;
      // CodeMirror 在测量写阶段之后还会补偿行高变化；必须等它结束，避免两次叠加同一滚动差。
      view.dom.ownerDocument.defaultView!.requestAnimationFrame(() => {
        if (!isCurrent()) return;
        const changed = Math.abs(view.scrollDOM.scrollTop - scrollTop) > 0.5;
        view.scrollDOM.scrollTop = scrollTop;
        // 远处行块首次可能使用估计高度；滚动后校正实际排版，不把光标拉到视口中。
        if (changed && ++attempts < 3) measure();
      });
    },
  });
  measure();
}
