/** 文件职责：冻结来源视图的源码边界，保护不可见任务，并限制选取和复制范围。 */
import { EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { archiveSections, getHiddenRanges } from '../markdown';
import { documentField, modeFacet, sourceViewFacet } from './state';

/** 左闭右开的原文坐标；源码会话内只随文本事务映射，不按新任务状态重新分类。 */
export interface SourceScopeRange { from: number; to: number }
/** 文件重载或明确恢复整份草稿时重建范围，不能将原文件的隐藏坐标套到新文件。 */
export const refreshSourceScope = StateEffect.define<null>();

/** 正式归档源码保留完整章节的标题、空行和备注；旧文件沿用任务投影兼容。 */
function scopeFor(state: EditorState): SourceScopeRange[] {
  if (state.facet(modeFacet) !== 'source') return [];
  const model = state.field(documentField);
  const sourceView = state.facet(sourceViewFacet);
  const sections = sourceView === 'archive' ? archiveSections(model) : [];
  if (!sections.length) return getHiddenRanges(model, sourceView);
  const hidden: SourceScopeRange[] = [];
  let position = 0;
  for (const section of sections) {
    if (position < section.from) hidden.push({ from: position, to: section.from });
    position = section.to;
  }
  if (position < state.doc.length) hidden.push({ from: position, to: state.doc.length });
  return hidden;
}

/** 非源码模式为空；进入源码或切换来源时从业务投影重建，编辑期间保持冻结。 */
export const sourceScopeField = StateField.define<readonly SourceScopeRange[]>({
  create: scopeFor,
  update(value, transaction) {
    if (transaction.state.facet(modeFacet) !== 'source') return value.length ? [] : value;
    if (transaction.effects.some(effect => effect.is(refreshSourceScope)) || transaction.startState.facet(modeFacet) !== 'source' || transaction.startState.facet(sourceViewFacet) !== transaction.state.facet(sourceViewFacet)) {
      return scopeFor(transaction.state);
    }
    // 边界新增文本属于可见视图，不扩张隐藏区间；复选框编辑不得触发重新分类。
    return transaction.docChanged ? value.map(range => ({ from: transaction.changes.mapPos(range.from, 1), to: transaction.changes.mapPos(range.to, -1) })).filter(range => range.from < range.to) : value;
  },
});

/** 返回选区与可见源码的交集；全选、复制和剪切共用此边界，不含折叠过滤。 */
export function sourceVisibleRanges(state: EditorState, from = 0, to = state.doc.length): SourceScopeRange[] {
  const result: SourceScopeRange[] = [];
  let position = from;
  for (const hidden of state.field(sourceScopeField)) {
    if (hidden.to <= position || hidden.from >= to) continue;
    if (hidden.from > position) result.push({ from: position, to: Math.min(hidden.from, to) });
    position = Math.max(position, hidden.to);
  }
  if (position < to) result.push({ from: position, to });
  return result;
}

/** 空选区遵循编辑器的整行复制语义，但任何情况下都不能输出隐藏正文。 */
function visibleClipboardText(state: EditorState): string {
  return state.selection.ranges.map(selection => {
    const line = selection.empty ? state.doc.lineAt(selection.head) : null;
    return sourceVisibleRanges(state, line?.from ?? selection.from, line?.to ?? selection.to)
      .map(range => state.doc.sliceString(range.from, range.to)).join('');
  }).join('\n');
}

/** 注册冻结范围、不可见源码写保护、可见源码全选与剪贴板输出。 */
export const sourceScopeExtension: Extension = [
  sourceScopeField,
  invertedEffects.of(transaction => transaction.effects.some(effect => effect.is(refreshSourceScope)) ? [refreshSourceScope.of(null)] : []),
  EditorState.allowMultipleSelections.of(true),
  EditorState.transactionFilter.of(transaction => {
    if (!transaction.docChanged || transaction.startState.facet(modeFacet) !== 'source' || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.effects.some(effect => effect.is(refreshSourceScope))) return transaction;
    const state = transaction.startState;
    const hidden = state.field(sourceScopeField);
    let forbidden = false;
    transaction.changes.iterChangedRanges((from, to) => {
      if (hidden.some(range => from < range.to && to > range.from
        || from === to && ((from > range.from && from < range.to)
          || (from === 0 && range.from === 0 && state.facet(sourceViewFacet) === 'archive')
          || (from === state.doc.length && range.to === state.doc.length && state.facet(sourceViewFacet) === 'todo')))) forbidden = true;
    });
    // 拒绝整笔越界事务，避免仅删除部分选区后用户无法预测剩余文本。
    if (forbidden) return [];
    // 全选替换可以不带末尾换行；补足分隔，避免隐藏标题或任务被并入可见最后一行。
    const next = transaction.newDoc;
    const separators: { from: number; insert: string }[] = [];
    for (const range of hidden) {
      const from = transaction.changes.mapPos(range.from, 1);
      if (from > 0 && next.sliceString(from - 1, from) !== '\n') separators.push({ from, insert: '\n' });
    }
    return separators.length ? [transaction, { changes: separators, sequential: true }] : transaction;
  }),
  Prec.highest(keymap.of([{ key: 'Mod-a', run(view) {
    if (view.state.facet(modeFacet) !== 'source') return false;
    const ranges = sourceVisibleRanges(view.state);
    if (ranges.length) view.dispatch({ selection: EditorSelection.create(ranges.map(range => EditorSelection.range(range.from, range.to))), userEvent: 'select' });
    return true;
  } }])),
  EditorView.clipboardOutputFilter.of((text, state) => state.facet(modeFacet) === 'source' ? visibleClipboardText(state) : text),
];
