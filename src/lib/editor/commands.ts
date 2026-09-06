/**
 * 文件职责：实现任务结构中的键盘输入，保留普通 Markdown 与 IME 行为。
 * 定义范围：任务首行续项、正文换行和整项缩进。
 */
import type { EditorView, KeyBinding } from '@codemirror/view';
import { indentItemChanges } from '../markdown';
import { documentField, modeFacet } from './state';

/**
 * 函数职责：仅在单光标位于任务首行时接管列表输入。
 * 输入说明：中文候选组合、选区、源码及普通正文都交给 CodeMirror 默认行为。
 * 输出说明：同级新任务或退出空任务是一笔可撤销事务。
 * 实现思路：任务范围取语法树，缩进与标记从原文保留。
 */
export function taskEnter(view: EditorView, continuation = false): boolean {
  if (view.composing) return false;
  if (view.state.facet(modeFacet) !== 'todo' || !view.state.selection.main.empty || view.state.selection.ranges.length !== 1) return false;
  const pos = view.state.selection.main.head;
  const model = view.state.field(documentField);
  const item = model.tasks.find(candidate => pos >= candidate.contentFrom && pos <= candidate.firstLineTo);
  if (!item) return false;
  const line = view.state.doc.lineAt(item.from);
  const indent = line.text.slice(0, item.from - line.from);
  const marker = model.text.slice(item.markerFrom, item.markerTo);
  const eol = model.text.includes('\r\n') ? '\r\n' : '\n';
  if (!continuation && !model.text.slice(item.contentFrom, item.firstLineTo).trim()) {
    view.dispatch({ changes: { from: line.from, to: item.firstLineTo, insert: indent }, selection: { anchor: line.from + indent.length }, userEvent: 'input' });
    return true;
  }
  const nextMarker = /^\d/.test(marker) ? marker.replace(/\d+/, digits => String(Number(digits) + 1)) : marker;
  const prefix = continuation ? ' '.repeat(item.markerTo - line.from + 1) : `${indent}${nextMarker} [ ] `;
  view.dispatch({ changes: { from: pos, insert: `${eol}${prefix}` }, selection: { anchor: pos + eol.length + prefix.length }, userEvent: 'input' });
  return true;
}

/** 整项缩进复用语法模型；不在任务首行时允许常规 Tab 行为。 */
export function indentTask(view: EditorView, direction: 1 | -1): boolean {
  if (view.composing || view.state.facet(modeFacet) !== 'todo') return false;
  const pos = view.state.selection.main.head;
  const model = view.state.field(documentField);
  const item = model.items.find(candidate => pos >= candidate.from && pos <= candidate.firstLineTo);
  if (!item) return false;
  const changes = indentItemChanges(model, item.from, direction);
  if (changes.length) view.dispatch({ changes, userEvent: 'input.indent' });
  return true;
}

export const taskKeymap: KeyBinding[] = [
  { key: 'Enter', run: view => taskEnter(view) },
  { key: 'Shift-Enter', run: view => taskEnter(view, true) },
  { key: 'Tab', run: view => indentTask(view, 1) },
  { key: 'Shift-Tab', run: view => indentTask(view, -1) },
];
