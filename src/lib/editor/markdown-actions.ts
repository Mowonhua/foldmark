/**
 * 文件职责：提供正文菜单使用的局部 Markdown 格式与结构事务。
 * 定义范围：动作类型、可用性及活动态查询、受选区和隐藏范围约束的编辑命令。
 */
import { type EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { isolateHistory } from '@codemirror/commands';
import { translate } from '../i18n';
import { documentField } from './state';
import { paragraphAt, paragraphLayout, replaceParagraphs, type Paragraph } from './paragraphs';
import { fencedBlocks } from './fenced-blocks';
import { hiddenContentRanges } from './visibility';

/**
 * 结构职责：描述正文菜单允许发出的 Markdown 编辑意图。
 * 字段说明：行内动作包裹或取消标记；段落动作转换当前完整段落；块动作生成独立结构。
 * 约束条件：只处理单一选区；复杂容器、隐藏内容和字面块不得通过动作改写。
 */
export type MarkdownAction = 'bold' | 'italic' | 'strike' | 'inlineCode' | 'link' | 'paragraph'
  | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6'
  | 'quote' | 'bulletList' | 'orderedList' | 'taskList' | 'codeBlock' | 'mathBlock' | 'horizontalRule';

/**
 * 函数职责：查询当前选区能否安全执行局部 Markdown 动作。
 * 输入说明：view 为当前挂载视图；只读、IME、多选区及隐藏范围交叉均拒绝。
 * 输出说明：只返回可用性，不提交事务、不改变焦点或选区。
 * 实现思路：复用语法树、共同段落模型和隐藏投影构建局部修改计划。
 */
export function markdownActionEnabled(view: EditorView, action: MarkdownAction): boolean {
  return !view.composing && !view.state.readOnly && plan(view.state, action) !== null;
}

/**
 * 函数职责：查询光标或选区是否处于给定 Markdown 结构中。
 * 输入说明：state 必须包含文档模型；活动态不代表当前允许修改该结构。
 * 输出说明：不识别或跨结构的选区返回 false，不修改编辑状态。
 * 实现思路：从当前语法节点及列表标记读取活动格式，不用文本猜测语法语义。
 */
export function markdownActionActive(state: EditorState, action: MarkdownAction): boolean {
  if (state.selection.ranges.length !== 1) return false;
  const name = inlineNodes[action];
  if (name) return enclosingNode(state, name) !== null;
  if (action === 'codeBlock' || action === 'mathBlock') {
    const selection = state.selection.main;
    return fencedBlocks(state).some(block => block.kind === (action === 'codeBlock' ? 'code' : 'math')
      && selection.from >= block.from && selection.to <= block.to);
  }
  if (/^heading[1-6]$/.test(action)) return enclosingNode(state, `ATXHeading${action.at(-1)}`) !== null
    || enclosingNode(state, `SetextHeading${action.at(-1)}`) !== null;
  if (action === 'quote') return enclosingNode(state, 'Blockquote') !== null;
  if (action === 'horizontalRule') return enclosingNode(state, 'HorizontalRule') !== null;
  const paragraph = paragraphLayout(state).paragraphs[paragraphAt(paragraphLayout(state), state.selection.main.from)];
  if (!paragraph || state.selection.main.to > paragraph.to) return false;
  if (action === 'paragraph') return paragraph.kind === 'text' && !enclosingNode(state, 'Blockquote');
  if (paragraph.kind !== 'list' || !paragraph.item) return false;
  if (action === 'taskList') return !!paragraph.item.task;
  if (paragraph.item.task) return false;
  const marker = state.doc.sliceString(paragraph.item.markerFrom, paragraph.item.markerTo);
  return action === 'orderedList' ? /^\d/.test(marker) : action === 'bulletList' && /^[-+*]/.test(marker);
}

/**
 * 函数职责：提交一次可撤销的局部 Markdown 格式或结构修改。
 * 输入说明：调用时重新检查可用性；复杂范围不得拆分提交或跨过隐藏内容。
 * 输出说明：成功提交返回 true；无法安全执行时返回 false 且保持正文与选区。
 * 实现思路：复用段落替换计划与普通事务过滤，正文变化与目标选区在同一事务提交。
 */
export function runMarkdownAction(view: EditorView, action: MarkdownAction): boolean {
  if (view.composing || view.state.readOnly) return false;
  const spec = plan(view.state, action);
  if (!spec) return false;
  const transaction = view.state.update({ ...spec, annotations: isolateHistory.of('full'), userEvent: 'input.format', scrollIntoView: true });
  if (!transaction.docChanged) return false;
  view.dispatch(transaction); view.focus(); return true;
}

// ==================== 局部编辑计划 ====================

/** 行内活动态依赖语法节点，未闭合标记不得被误认为已应用格式。 */
const inlineNodes: Partial<Record<MarkdownAction, string>> = { bold: 'StrongEmphasis', italic: 'Emphasis', strike: 'Strikethrough', inlineCode: 'InlineCode', link: 'Link' };
const inlineMarks: Partial<Record<MarkdownAction, string>> = { bold: '**', italic: '*', strike: '~~' };

/** 同一节点必须包含完整选区；从两端之间的最内层语法节点向容器查找。 */
function enclosingNode(state: EditorState, name: string): SyntaxNode | null {
  const selection = state.selection.main;
  let node: SyntaxNode | null = state.field(documentField).tree.resolveInner(selection.from, 1);
  while (node) {
    if (node.name === name && node.from <= selection.from && node.to >= selection.to) return node;
    node = node.parent;
  }
  return null;
}

/** 字面语法与普通 Markdown 编辑契约不同；整段选中也不能将其内部重新解释为格式。 */
function literalSelection(state: EditorState, action: MarkdownAction): boolean {
  const selection = state.selection.main;
  let literal = false;
  state.field(documentField).tree.iterate({ from: selection.from, to: selection.to, enter(node) {
    if (/^(FencedCode|CodeBlock|MathBlock|InlineMath|InlineMathUnclosed|HTMLBlock|HTMLTag|Table|LinkReference)$/.test(node.name)
      || node.name === 'InlineCode' && action !== 'inlineCode') literal = true;
  } });
  return literal;
}

/** 所有动作先形成完整计划，再验证实际改动范围；不以裁剪改动的方式悄悄处理复杂选区。 */
function plan(state: EditorState, action: MarkdownAction): TransactionSpec | null {
  if (state.selection.ranges.length !== 1 || literalSelection(state, action)) return null;
  const selection = state.selection.main;
  const hidden = hiddenContentRanges(state);
  if (hidden.some(range => selection.from < range.to && selection.to > range.from
    || selection.empty && selection.from > range.from && selection.from < range.to)) return null;
  const spec = Object.hasOwn(inlineNodes, action) ? inlinePlan(state, action) : structurePlan(state, action);
  if (!spec) return null;
  let forbidden = false;
  state.changes(spec.changes).iterChangedRanges((from, to) => {
    if (hidden.some(range => from < range.to && to > range.from || from === to && from > range.from && from < range.to)) forbidden = true;
  });
  return forbidden ? null : spec;
}

/** 段落分隔中的空白物理行可作为新增内容的锚点，不改变共享段落模型对分隔的定义。 */
function separatorParagraph(state: EditorState): { paragraph: Paragraph; index: number } | null {
  const selection = state.selection.main;
  if (!selection.empty) return null;
  const line = state.doc.lineAt(selection.head), layout = paragraphLayout(state);
  if (line.text.trim() || paragraphAt(layout, selection.head) !== -1) return null;
  const next = layout.paragraphs.findIndex(paragraph => paragraph.from > selection.head);
  return { index: next < 0 ? layout.paragraphs.length : next,
    paragraph: { from: line.from, to: line.to, contentFrom: line.to, kind: 'empty', item: null, indent: line.text } };
}

/** 仅处理同一物理行的正文，标记删除保持其内部原文和选区的相对位置。 */
function inlinePlan(state: EditorState, action: MarkdownAction): TransactionSpec | null {
  const selection = state.selection.main;
  if (state.doc.lineAt(selection.from).number !== state.doc.lineAt(selection.to).number) return null;
  const separator = separatorParagraph(state);
  const paragraph = separator?.paragraph ?? paragraphLayout(state).paragraphs[paragraphAt(paragraphLayout(state), selection.from)];
  if (!paragraph || paragraph.kind === 'list' && selection.from < paragraph.contentFrom) return null;
  let structuralMark = false;
  state.field(documentField).tree.iterate({ from: selection.from, to: selection.to, enter(ref) {
    if (/^(HeaderMark|QuoteMark|ListMark|TaskMarker)$/.test(ref.name)
      && (selection.empty ? selection.from >= ref.from && selection.from < ref.to : selection.from < ref.to && selection.to > ref.from)) structuralMark = true;
  } });
  if (structuralMark) return null;
  const node = enclosingNode(state, inlineNodes[action]!);
  if (node && action !== 'link') {
    const first = node.firstChild, last = node.lastChild;
    if (!first || !last || !first.name.endsWith('Mark') || !last.name.endsWith('Mark') || first === last) return null;
    let content = state.doc.sliceString(first.to, last.from);
    // CodeSpan 的对称单空格属于语法 padding，取消格式时恢复其显示正文；全空格代码不剥离。
    const padding = action === 'inlineCode' && content.startsWith(' ') && content.endsWith(' ') && !!content.trim() ? 1 : 0;
    if (padding) content = content.slice(1, -1);
    const position = (value: number) => node.from + Math.max(0, Math.min(content.length, value - first.to - padding));
    return { changes: { from: node.from, to: node.to, insert: content }, selection: { anchor: position(selection.anchor), head: position(selection.head) } };
  }
  // 已有链接内部地址和标记不属于可再次包裹的文本，避免创建嵌套链接。
  if (action === 'link' && enclosingNode(state, 'Link')) return null;
  const text = state.doc.sliceString(selection.from, selection.to);
  if (action === 'link') {
    const label = text || translate('链接文字');
    const escaped = label.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const insert = `[${escaped}](https://)`;
    const from = selection.from + escaped.length + 3;
    if (separator) {
      const spec = replaceParagraphs(state, separator.index, separator.index - 1, [paragraph.indent + insert], paragraph.indent.length + escaped.length + 3, 'input.format');
      const anchor = (spec.selection as { anchor: number }).anchor;
      return { ...spec, selection: { anchor, head: anchor + 8 } };
    }
    return { changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: from, head: from + 8 } };
  }
  let mark = inlineMarks[action] ?? '`';
  if (action === 'inlineCode') {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(value => value.length));
    mark = '`'.repeat(longest + 1);
  }
  // CodeSpan 会剥掉单个边界空格；反引号位于边界时用空格分隔标记，同时保留原正文。
  // 强调标记不能紧贴边界空白；空白保留在原处，仅格式化所选的正文字符。
  const leading = action !== 'inlineCode' ? /^\s*/.exec(text)![0].length : 0;
  const trailing = action !== 'inlineCode' ? /\s*$/.exec(text)![0].length : 0;
  if (text && leading + trailing >= text.length) return null;
  const from = selection.from + leading, to = selection.to - trailing;
  const body = state.doc.sliceString(from, to);
  const padding = action === 'inlineCode' && body && (/^`|`$/.test(body) || /^ .* $/.test(body) && body.trim()) ? ' ' : '';
  const opening = mark + padding, closing = padding + mark;
  if (separator) return replaceParagraphs(state, separator.index, separator.index - 1,
    [paragraph.indent + opening + body + closing], paragraph.indent.length + opening.length, 'input.format');
  return { changes: { from, to, insert: opening + body + closing },
    selection: { anchor: from + opening.length, head: to + opening.length } };
}

/** 首行与正文共用段落模型，标题是允许转换的字面段落例外；其他容器不拆分。 */
function structureTarget(state: EditorState): { paragraph: Paragraph; index: number; content: string; insertBefore: boolean } | null {
  const layout = paragraphLayout(state), selection = state.selection.main;
  const separator = separatorParagraph(state);
  const index = separator?.index ?? paragraphAt(layout, selection.from), paragraph = separator?.paragraph ?? layout.paragraphs[index];
  if (!paragraph || selection.to > paragraph.to || enclosingNode(state, 'Blockquote')) return null;
  let headingNode: SyntaxNode | null = null;
  for (let node: SyntaxNode | null = state.field(documentField).tree.resolveInner(paragraph.contentFrom, 1); node; node = node.parent) {
    if (/^(ATXHeading[1-6]|SetextHeading[12])$/.test(node.name)) { headingNode = node; break; }
  }
  if (paragraph.kind === 'literal' && !headingNode) return null;
  let content = state.doc.sliceString(paragraph.contentFrom, paragraph.to);
  const indent = state.doc.sliceString(paragraph.from, paragraph.contentFrom);
  // 首行已经跳过缩进，续行也只移除同一容器前缀，避免生成块时重复增加结构缩进。
  if (indent) content = content.split('\n').map((line, lineIndex) => lineIndex && line.startsWith(indent) ? line.slice(indent.length) : line).join('\n');
  if (headingNode?.name.startsWith('Setext')) content = state.doc.lineAt(headingNode.from).text.trimStart();
  else if (headingNode) content = content.replace(/^#{1,6}[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '');
  return { paragraph, index, content, insertBefore: !!separator };
}

/** 段落转换只改选中段落；保留列表后代时只能替换列表首行标记，不能移除其容器。 */
function structurePlan(state: EditorState, action: MarkdownAction): TransactionSpec | null {
  const target = structureTarget(state);
  if (!target) return null;
  const { paragraph, index, content, insertBefore } = target;
  const selection = state.selection.main;
  const listAction = ['bulletList', 'orderedList', 'taskList'].includes(action);
  const blockAction = ['codeBlock', 'mathBlock', 'horizontalRule'].includes(action);
  if (blockAction) return blockPlan(state, action, paragraph, index, content, insertBefore);
  const item = paragraph.kind === 'list' ? paragraph.item : null;
  if (item && !listAction && item.to > item.firstLineTo) return null;
  const marker = action === 'paragraph' ? '' : action.startsWith('heading') ? '#'.repeat(Number(action.at(-1))) + ' '
    : action === 'quote' ? '> ' : action === 'bulletList' ? '- ' : action === 'orderedList' ? '1. ' : action === 'taskList' ? '- [ ] ' : null;
  if (marker === null) return null;
  const indent = item ? state.doc.sliceString(paragraph.from, item.markerFrom) : state.doc.sliceString(paragraph.from, paragraph.contentFrom);
  if (item) {
    if (action === 'taskList' && item.task) return null;
    // 改变列表标记列宽会改变后续缩进的容器归属；复杂列表不做隐式重缩进。
    const currentWidth = item.markerTo - item.markerFrom + 1;
    const nextWidth = action === 'orderedList' ? 3 : listAction ? 2 : 0;
    if (item.to > item.firstLineTo && nextWidth !== currentWidth) return null;
    // 仅首行标记参与替换；列表正文与子项的缩进原样保留。
    return { changes: { from: item.markerFrom, to: paragraph.contentFrom, insert: marker },
      selection: { anchor: item.markerFrom + marker.length + Math.max(0, selection.head - paragraph.contentFrom) } };
  }
  const lines = content.split('\n');
  // 多行正文成为容器时只在首行写标记，续行增加容器缩进；标题只支持单行内容。
  if (action.startsWith('heading') && lines.length > 1) return null;
  const body = indent + marker + lines[0] + lines.slice(1).map(line => '\n' + (action === 'quote' ? indent + '> ' : listAction ? indent + ' '.repeat(marker.length) : '') + line).join('');
  if (insertBefore) return action === 'paragraph' ? null : replaceParagraphs(state, index, index - 1, [body], body.length, 'input.format');
  return { changes: { from: paragraph.from, to: paragraph.to, insert: body }, selection: { anchor: paragraph.from + indent.length + marker.length + Math.min(lines[0].length, Math.max(0, selection.head - paragraph.contentFrom)) } };
}

/** 块转换复用段落分隔；列表首行只插入正文块，不能将任务标题变成围栏标记。 */
function blockPlan(state: EditorState, action: MarkdownAction, paragraph: Paragraph, index: number, content: string, insertBefore: boolean): TransactionSpec | null {
  const selection = state.selection.main;
  if (action === 'horizontalRule') {
    // 插入分隔线不替换所选文字；空行就地创建，已有正文后追加，保留列表正文的结构缩进。
    const indent = paragraph.item ? paragraph.indent : state.doc.sliceString(paragraph.from, paragraph.contentFrom);
    const rule = indent + '---';
    if (insertBefore) return replaceParagraphs(state, index, index - 1, [rule], rule.length, 'input.format');
    return paragraph.kind === 'empty' ? replaceParagraphs(state, index, index, [rule], rule.length, 'input.format')
      : replaceParagraphs(state, index + 1, index, [rule], rule.length, 'input.format');
  }
  // 块转换会替换段落正文，局部文字选区不能扩大为整段删除；段落样式转换则允许作用当前段。
  if (!selection.empty && (selection.from !== paragraph.from && selection.from !== paragraph.contentFrom || selection.to !== paragraph.to)) return null;
  const item = paragraph.kind === 'list' ? paragraph.item : null;
  if (item && !state.selection.main.empty) return null;
  const body = item ? '' : content;
  if (action === 'mathBlock' && /^\s*\$\$\s*$/m.test(body)) return null;
  const indent = paragraph.item ? paragraph.indent : state.doc.sliceString(paragraph.from, paragraph.contentFrom);
  const delimiter = action === 'mathBlock' ? '$$' : '`'.repeat(Math.max(3, 1 + Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length))));
  const formatted = `${indent}${delimiter}\n${indent}${body.replace(/\n/g, '\n' + indent)}\n${indent}${delimiter}`;
  const caret = indent.length + delimiter.length + 1 + indent.length;
  if (item) {
    const insert = '\n\n' + formatted + (paragraph.to === state.doc.length ? '\n\n' + indent : '\n');
    return { changes: { from: paragraph.to, insert }, selection: { anchor: paragraph.to + 2 + caret } };
  }
  return replaceParagraphs(state, index, insertBefore ? index - 1 : index, [formatted], caret, 'input.format');
}
