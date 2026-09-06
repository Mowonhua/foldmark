/**
 * 文件职责：维护与源文事务同步的语法投影和折叠状态。
 * 定义范围：编辑模式、列表模型、折叠位置及撤销映射扩展。
 */
import { Facet, StateEffect, StateField, type ChangeSet, type EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { invertedEffects } from '@codemirror/commands';
import { parseDocument, type DocumentModel } from '../markdown';
import type { EditorActions, EditorOptions, ViewMode } from './types';
import { tryMapTaskTextEdit } from './incremental-model';

export const modeFacet = Facet.define<ViewMode, ViewMode>({ combine: values => values[0] ?? 'todo' });
export const actionsFacet = Facet.define<EditorActions, EditorActions>({ combine: values => values[0] });
export const resourcesFacet = Facet.define<Pick<EditorOptions, 'resolveResource' | 'openLink'>, Pick<EditorOptions, 'resolveResource' | 'openLink'>>({ combine: values => values[0] ?? {} });
export const setFolds = StateEffect.define<readonly number[]>();
export const holdCompletion = StateEffect.define<{ token: number; from: number }>();
export const releaseCompletion = StateEffect.define<number | 'all'>();

/** 已完成文本立即提交；短暂保留源位置只用于显示勾选反馈，不参与持久化或撤销。 */
export const completionField = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.effects.some(effect => effect.is(holdCompletion) || effect.is(releaseCompletion))) return value;
    const result = new Map([...value].map(([token, from]) => [token, transaction.changes.mapPos(from, 1)]));
    for (const effect of transaction.effects) {
      if (effect.is(holdCompletion)) result.set(effect.value.token, effect.value.from);
      if (effect.is(releaseCompletion)) { if (effect.value === 'all') result.clear(); else result.delete(effect.value); }
    }
    return result;
  },
});

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
