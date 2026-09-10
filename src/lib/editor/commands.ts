/**
 * 文件职责：实现任务结构中的键盘输入，保留普通 Markdown 与 IME 行为。
 * 定义范围：代码围栏补全、任务首行续项、正文换行和整项缩进。
 */
import type { EditorView, KeyBinding } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { indentItemChanges } from '../markdown';
import { documentField, modeFacet } from './state';

/**
 * 函数职责：在预览正文中插入段落分隔或段内换行。
 * 输入说明：只接管可编辑预览；列表、引用、代码及表格交回各自的输入规则。
 * 输出说明：替换选区并将光标放在新段落起点，整个操作可一次撤销。
 * 实现思路：用共享语法树识别容器，按文档内部换行坐标构造事务。
 */
export function paragraphEnter(view: EditorView, soft = false): boolean {
  const { state } = view;
  if (view.composing || state.readOnly || state.facet(modeFacet) !== 'todo' || state.selection.ranges.length !== 1) return false;
  const selection = state.selection.main;
  for (const position of [selection.from, selection.to]) {
    let node: SyntaxNode | null = state.field(documentField).tree.resolveInner(position, -1);
    while (node) {
      if (/^(ListItem|Blockquote|FencedCode|CodeBlock|MathBlock|Table)$/.test(node.name)) return false;
      node = node.parent;
    }
  }
  const insert = soft ? '\n' : '\n\n';
  view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length }, userEvent: 'input' });
  return true;
}

/**
 * 函数职责：在未闭合的 Markdown 开围栏末尾换行，并补齐匹配的闭围栏。
 * 输入说明：仅接管 todo、source 中的单个空选区；组合输入及已有闭围栏交给默认行为。
 * 输出说明：返回是否接管 Enter；成功时以一笔可撤销事务插入空代码行和闭围栏，光标停在代码行缩进之后。
 * 实现思路：通过当前语法树确认开围栏身份与未闭合状态，保留围栏长度、字符与空白缩进；坐标使用文档内部的单字符换行。
 */
export function codeFenceEnter(view: EditorView): boolean {
  const { state } = view;
  if (view.composing || state.facet(modeFacet) === 'archive' || state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  if (pos !== line.to) return false;
  const opening = /^([\t ]*)(`{3,}|~{3,})[^\r\n]*$/.exec(line.text);
  if (!opening) return false;
  const markerFrom = line.from + opening[1].length;
  let node: SyntaxNode | null = state.field(documentField).tree.resolveInner(markerFrom, 1);
  while (node && node.name !== 'FencedCode') node = node.parent;
  if (!node) return false;
  const marks = node.getChildren('CodeMark');
  // 只有当前行确为唯一开围栏时才补全；代码正文中的短围栏和已有闭围栏不属于输入触发点。
  if (marks.length !== 1 || marks[0].from !== markerFrom) return false;
  const indent = opening[1];
  view.dispatch({
    changes: { from: pos, insert: `\n${indent}\n${indent}${opening[2]}` },
    selection: { anchor: pos + 1 + indent.length },
    userEvent: 'input',
  });
  return true;
}

/**
 * 函数职责：仅在单光标位于任务首行时接管列表输入。
 * 输入说明：todo 与 source 共用空任务退出；源码的其他列表输入、中文候选组合、选区及普通正文交给 CodeMirror 默认行为。
 * 输出说明：同级新任务或退出空任务是一笔可撤销事务。
 * 实现思路：任务范围取语法树，缩进与标记从原文保留。
 */
export function taskEnter(view: EditorView, continuation = false): boolean {
  if (view.composing) return false;
  const mode = view.state.facet(modeFacet);
  if (view.state.readOnly || mode === 'archive' || !view.state.selection.main.empty || view.state.selection.ranges.length !== 1) return false;
  const pos = view.state.selection.main.head;
  const model = view.state.field(documentField);
  // 空任务的可编辑位置从闭括号后开始，不能用跳过尾随空白的 contentFrom 限制。
  // GFM 不把缺少尾随空格的 [ ] 解析成 Task；只在语法树确认的列表首行补认空标记，避免误删代码或正文。
  const emptyItem = continuation ? undefined : model.items.find(candidate => {
    if (pos < candidate.markerTo || pos > candidate.firstLineTo) return false;
    const marker = /^[ \t]+\[ \]([ \t]*)$/.exec(model.text.slice(candidate.markerTo, candidate.firstLineTo));
    return marker !== null && pos >= candidate.firstLineTo - marker[1].length;
  });
  // 源码模式也必须一次退出空任务；其他输入继续交给 Markdown 默认键位，保留原有续项和 Shift-Enter 行为。
  if (mode === 'source' && !emptyItem) return false;
  const item = emptyItem ?? model.tasks.find(candidate => pos >= candidate.contentFrom && pos <= candidate.firstLineTo);
  if (!item) return false;
  const line = view.state.doc.lineAt(item.from);
  const indent = line.text.slice(0, item.from - line.from);
  const marker = model.text.slice(item.markerFrom, item.markerTo);
  const eol = model.text.includes('\r\n') ? '\r\n' : '\n';
  if (emptyItem || (!continuation && !model.text.slice(item.contentFrom, item.firstLineTo).trim())) {
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
  { key: 'Enter', run: view => codeFenceEnter(view) || taskEnter(view) || paragraphEnter(view) },
  { key: 'Shift-Enter', run: view => taskEnter(view, true) || paragraphEnter(view, true) },
  { key: 'Tab', run: view => indentTask(view, 1) },
  { key: 'Shift-Tab', run: view => indentTask(view, -1) },
];
