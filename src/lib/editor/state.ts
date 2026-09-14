/**
 * 文件职责：维护与源文事务同步的语法投影和折叠状态。
 * 定义范围：编辑模式、列表模型、折叠位置及撤销映射扩展。
 */
import { Facet, MapMode, StateEffect, StateField, type ChangeDesc, type ChangeSet, type EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { invertedEffects } from '@codemirror/commands';
import { parseDocument, type DocumentModel } from '../markdown';
import type { EditorActions, EditorOptions, ViewMode } from './types';
import { tryMapTaskTextEdit } from './incremental-model';

export const modeFacet = Facet.define<ViewMode, ViewMode>({ combine: values => values[0] ?? 'todo' });
/** 源码沿用进入它的业务视图；单纯切换显示形式不改变任务归属。 */
export const sourceViewFacet = Facet.define<'todo' | 'archive', 'todo' | 'archive'>({ combine: values => values[0] ?? 'todo' });
export const actionsFacet = Facet.define<EditorActions, EditorActions>({ combine: values => values[0] });
export const resourcesFacet = Facet.define<Pick<EditorOptions, 'resolveResource' | 'openLink'>, Pick<EditorOptions, 'resolveResource' | 'openLink'>>({ combine: values => values[0] ?? {} });
export const setFolds = StateEffect.define<readonly number[]>();

/** 映射实际 LF 字符的两端，删除或替换该字符时不把身份转移到邻接换行。 */
export function mapSoftBreaks(positions: readonly number[], changes: ChangeDesc): readonly number[] {
  const mapped: number[] = [];
  const removed: { from: number; to: number }[] = [];
  changes.iterChangedRanges((from, to) => { if (from < to) removed.push({ from, to }); }, true);
  for (const position of positions) {
    let low = 0; let high = removed.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (removed[middle].to <= position) low = middle + 1;
      else high = middle;
    }
    // TrackDel 保留改动端点；同宽替换仍可能映射出一个字符，必须排除被替换的旧 LF。
    if (removed[low] && removed[low].from <= position) continue;
    const from = changes.mapPos(position, 1, MapMode.TrackDel);
    const to = changes.mapPos(position + 1, -1, MapMode.TrackDel);
    if (from !== null && to !== null && to === from + 1) mapped.push(from);
  }
  return mapped;
}

/** 设置当前文档中显式段内换行的 LF 坐标；effect 使用事务完成后的坐标，替换全部已有身份。 */
export const setSoftBreaks = StateEffect.define<readonly number[]>({ map: mapSoftBreaks });

/**
 * 记录当前编辑会话创建的段内换行身份，不向 Markdown 写入额外标记。
 * 切换源码视图保留字段，普通文本编辑映射 LF；外部全文替换清空，撤销 effect 可恢复旧身份。
 * 纯 Markdown 重新加载无法区分空软行和段落分隔，因此新 EditorState 不推断历史身份。
 */
export const softBreaksField = StateField.define<readonly number[]>({
  create: () => [],
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged) {
      let wholeDocument = false;
      transaction.changes.iterChangedRanges((from, to) => {
        if (from === 0 && to === transaction.startState.doc.length) wholeDocument = true;
      });
      next = wholeDocument ? [] : mapSoftBreaks(value, transaction.changes);
    }
    for (const effect of transaction.effects) if (effect.is(setSoftBreaks)) next = effect.value;
    if (next === value) return value;
    // 外部 effect 也必须指向真实 LF；去重排序保证模型与历史共享确定的坐标集合。
    const valid = [...new Set(next.filter(position => Number.isInteger(position) && position >= 0
      && position < transaction.newDoc.length && transaction.newDoc.sliceString(position, position + 1) === '\n'))].sort((a, b) => a - b);
    return valid.length === value.length && valid.every((position, index) => position === value[index]) ? value : valid;
  },
});

/** 文本编辑及显式身份变更一起撤销；反演值属于撤销事务完成后的起始文档坐标。 */
export const softBreakHistory = invertedEffects.of(transaction => transaction.docChanged || transaction.effects.some(effect => effect.is(setSoftBreaks))
  ? [setSoftBreaks.of(transaction.startState.field(softBreaksField))] : []);
/**
 * 函数职责：优先复用增量语法树，生成当前完整任务模型。
 * 输入说明：状态中的语言扩展必须使用共享 Markdown 配置。
 * 输出说明：模型始终覆盖全部正文；语法后台解析未完成时使用共享解析器补全。
 * 实现思路：普通任务首行文字通过受限坐标映射更新；结构编辑或新树未就绪时完整投影，选区与视口移动复用旧模型。
 */
function modelFor(state: EditorState, previous?: DocumentModel, changes?: ChangeSet): DocumentModel {
  const text = state.doc.toString();
  const tree = ensureSyntaxTree(state, state.doc.length, 40);
  if (tree && previous && changes) {
    const mapped = tryMapTaskTextEdit(previous,changes,text,tree);
    if (mapped) return mapped;
  }
  return parseDocument(text, tree ?? undefined);
}

export const documentField = StateField.define<DocumentModel>({
  create: modelFor,
  update: (value, transaction) => transaction.docChanged ? modelFor(transaction.state,value,transaction.changes) : value,
});

export const foldsField = StateField.define<ReadonlySet<number>>({
  create: () => new Set(),
  update(value, transaction) {
    let mapped = transaction.docChanged ? new Set([...value].map(pos => transaction.changes.mapPos(pos, 1))) : value;
    for (const effect of transaction.effects) if (effect.is(setFolds)) mapped = new Set(effect.value);
    return mapped;
  },
});

/** 文本撤销恢复操作前的折叠位置；单独折叠事务不进入文本历史。 */
export const foldHistory = invertedEffects.of(transaction => transaction.docChanged
  ? [setFolds.of([...transaction.startState.field(foldsField)])] : []);
