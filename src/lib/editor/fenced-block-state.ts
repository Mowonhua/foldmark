/**
 * 文件职责：记录预览键入围栏到明确确认之间的草稿身份。
 * 定义范围：草稿节点映射、确认 effect 和撤销恢复；不修改 Markdown 或解释块正文。
 */
import { MapMode, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import type { SyntaxNode } from '@lezer/common';
import { documentField, modeFacet } from './state';

/** 草稿身份附着在开头字符，删除或替换它时不能转交给同坐标的新节点。 */
function mapDrafts(positions: readonly number[], changes: ChangeDesc): readonly number[] {
  const removed: { from: number; to: number }[] = [];
  changes.iterChangedRanges((from, to) => { if (from < to) removed.push({ from, to }); }, true);
  return positions.flatMap(position => {
    if (removed.some(range => position >= range.from && position < range.to)) return [];
    const mapped = changes.mapPos(position, 1, MapMode.TrackDel);
    return mapped === null ? [] : [mapped];
  });
}

/** 源码光标向左解析开行；精确起点查询向右解析，避免落入前一个语法节点。 */
function blockNode(state: EditorState, position: number, exact: boolean): SyntaxNode | null {
  if (position < 0 || position > state.doc.length) return null;
  let node: SyntaxNode | null = state.field(documentField).tree.resolveInner(position, exact ? 1 : -1);
  while (node && node.name !== 'FencedCode' && node.name !== 'MathBlock') node = node.parent;
  return node && (!exact || node.from === position) ? node : null;
}

/**
 * 确认一次块创建；坐标是事务完成后语法节点的 nodeFrom。
 * effect 只移除草稿身份，不插入围栏或正文；历史映射必须跟随该节点位置。
 */
export const confirmFencedBlock = StateEffect.define<number>({ map: (position, changes) => mapDrafts([position], changes)[0] });
/** 仅供历史恢复完整集合；集合采用该恢复事务完成后的坐标。 */
const restoreDrafts = StateEffect.define<readonly number[]>({ map: mapDrafts });

/**
 * 有序且不重复的草稿节点起点，限 todo 中 input.type 新生成且光标仍在开行的语法块。
 * 继续输入代码语言或公式正文保留身份；普通变更映射位置，删除开头或语法身份消失时移除。
 * 新建 EditorState 不把已加载的块当成草稿；模式切换不改写源文或自动确认草稿。
 */
export const draftFencedBlocksField = StateField.define<readonly number[]>({
  create: () => [],
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.effects.some(effect => effect.is(confirmFencedBlock) || effect.is(restoreDrafts))) return value;
    let next = transaction.docChanged ? mapDrafts(value, transaction.changes) : value;
    const state = transaction.state;
    if (transaction.docChanged && state.facet(modeFacet) === 'todo' && transaction.isUserEvent('input.type')) {
      const additions: number[] = [];
      for (const selection of transaction.newSelection.ranges) {
        if (!selection.empty) continue;
        const node = blockNode(state, selection.head, false);
        if (!node || state.doc.lineAt(node.from).number !== state.doc.lineAt(selection.head).number) continue;
        const oldPosition = transaction.changes.invertedDesc.mapPos(node.from, -1, MapMode.TrackDel);
        const oldNode = oldPosition === null ? null : blockNode(transaction.startState, oldPosition, true);
        // 修改已加载或已确认块的语言/正文不重新进入草稿；只有此笔输入新生成的语法身份才登记。
        if (!oldNode || oldNode.name !== node.name || mapDrafts([oldNode.from], transaction.changes)[0] !== node.from) additions.push(node.from);
      }
      next = [...next, ...additions];
    }
    for (const effect of transaction.effects) {
      if (effect.is(confirmFencedBlock)) next = next.filter(position => position !== effect.value);
      if (effect.is(restoreDrafts)) next = effect.value;
    }
    const valid = [...new Set(next.filter(position => blockNode(state, position, true) !== null))].sort((a, b) => a - b);
    return valid.length === value.length && valid.every((position, index) => position === value[index]) ? value : valid;
  },
});

/** 块确认、输入和删除的撤销恢复起始草稿集合；反演 effect 使用恢复后文档的节点坐标。 */
export const draftFencedBlockHistory: Extension = invertedEffects.of(transaction => transaction.docChanged
  || transaction.effects.some(effect => effect.is(confirmFencedBlock) || effect.is(restoreDrafts))
  ? [restoreDrafts.of(transaction.startState.field(draftFencedBlocksField))] : []);
