/**
 * 文件职责：把同一 Markdown 状态投影为可编辑的就地预览。
 * 定义范围：语法装饰、任务控件、公式与表格的惰性 DOM 渲染。
 */
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import katex from 'katex';
import { getHiddenRanges, type ListItem } from '../markdown';
import { actionsFacet, completionField, documentField, foldsField, modeFacet, resourcesFacet } from './state';

class ItemWidget extends WidgetType {
  constructor(readonly item: ListItem, readonly folded: boolean, readonly label: string) { super(); }
  eq(other: ItemWidget): boolean { return this.item.from === other.item.from && this.item.to === other.item.to && this.item.task?.checked === other.item.task?.checked && this.folded === other.folded && this.label === other.label; }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = `fm-item-controls${this.folded ? ' is-folded' : ''}`;
    const actions = view.state.facet(actionsFacet);
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'fm-fold-button';
    fold.textContent = this.folded ? '▸' : '▾';
    fold.setAttribute('aria-label', this.folded ? '展开条目' : '折叠条目');
    fold.setAttribute('aria-expanded', String(!this.folded));
    fold.dataset.fold = String(this.item.from);
    if (this.item.to <= this.item.firstLineTo) { fold.disabled = true; fold.classList.add('is-empty'); fold.tabIndex = -1; }
    fold.addEventListener('click', event => { event.preventDefault(); actions.toggleFold(this.item.from); });
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = this.item.task ? 'fm-task-checkbox' : 'fm-list-marker';
    marker.dataset.listMarker = String(this.item.from);
    if (this.item.task) {
      marker.setAttribute('role', 'checkbox');
      marker.setAttribute('aria-checked', String(this.item.task.checked));
      marker.setAttribute('aria-label', this.item.task.checked ? '恢复任务' : '完成任务');
      marker.textContent = this.item.task.checked ? '✓' : '';
      // 指针单击由拖动状态机在松开时判定；键盘产生 detail=0 的 click 独立激活。
      marker.addEventListener('click', event => { event.preventDefault(); if (event.detail === 0) actions.toggleTask(this.item.from); });
    } else {
      marker.textContent = this.label;
      marker.setAttribute('aria-label', '列表项标记，按 Alt 和方向键排序');
    }
    marker.addEventListener('keydown', event => {
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault(); actions.moveItem(this.item.from, event.key === 'ArrowUp' ? 'up' : 'down');
      }
    });
    wrapper.append(fold, marker);
    return wrapper;
  }
  ignoreEvent(): boolean { return true; }
}

class NoteWidget extends WidgetType {
  constructor(readonly label: string, readonly from: number | null = null) { super(); }
  eq(other: NoteWidget): boolean { return this.label === other.label && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement(this.from === null ? 'span' : 'button');
    element.className = 'fm-hidden-note';
    element.textContent = this.label;
    if (this.from !== null) element.addEventListener('click', () => view.state.facet(actionsFacet).toggleFold(this.from!));
    return element;
  }
  ignoreEvent(): boolean { return true; }
}

const mathCache = new Map<string, string>();
class MathWidget extends WidgetType {
  constructor(readonly expression: string, readonly block: boolean, readonly from: number, readonly valid: boolean) { super(); }
  eq(other: MathWidget): boolean { return this.expression === other.expression && this.block === other.block && this.from === other.from && this.valid === other.valid; }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement(this.block ? 'div' : 'span');
    element.className = this.block ? 'fm-math-block' : 'fm-math-inline';
    element.setAttribute('aria-label', this.expression);
    try {
      if (!this.valid) throw new Error('公式尚未闭合');
      const key = `${this.block}:${this.expression}`;
      let markup = mathCache.get(key);
      if (!markup) {
        markup = katex.renderToString(this.expression, { displayMode: this.block, throwOnError: true, trust: false, strict: 'warn', maxExpand: 500 });
        if (mathCache.size >= 128) mathCache.delete(mathCache.keys().next().value!);
        mathCache.set(key, markup);
      }
      // HTML 只来自关闭 trust 的 KaTeX；用户原文从不直接进入 innerHTML。
      element.innerHTML = markup;
    } catch (error) {
      element.classList.add('fm-math-error');
      element.textContent = `${this.block ? '$$' : '$'}${this.expression}${this.valid ? (this.block ? '$$' : '$') : ''}`;
      element.title = error instanceof Error ? error.message : '公式无法排版';
    }
    element.addEventListener('mousedown', event => { event.preventDefault(); view.state.facet(actionsFacet).focusAt(this.from + (this.block ? 2 : 1)); });
    return element;
  }
  ignoreEvent(): boolean { return true; }
}

/** 只允许可安全显示的链接协议，原文本始终可通过进入编辑或源码视图修改。 */
function safeUrl(value: string, image: boolean): string | null {
  const clean = value.trim();
  if (/^(https?:|mailto:|#|\.\.?\/|\/)/i.test(clean) || !/^[a-z][a-z\d+.-]*:/i.test(clean)) return clean;
  if (image && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(clean)) return clean;
  return null;
}

class LinkWidget extends WidgetType {
  constructor(readonly label: string, readonly url: string, readonly from: number, readonly image: boolean) { super(); }
  eq(other: LinkWidget): boolean { return this.label === other.label && this.url === other.url && this.from === other.from && this.image === other.image; }
  toDOM(view: EditorView): HTMLElement {
    const resources = view.state.facet(resourcesFacet);
    const original = safeUrl(this.url, this.image) ?? (resources.resolveResource && /^[a-z]:[\\/]/i.test(this.url) ? this.url : null);
    const url = original === null ? null : resources.resolveResource?.(original) ?? original;
    if (this.image && url) {
      const image = document.createElement('img');
      image.src = url; image.alt = this.label; image.loading = 'lazy'; image.className = 'fm-image';
      image.addEventListener('click', () => view.state.facet(actionsFacet).focusAt(this.from + 2));
      return image;
    }
    const link = document.createElement('a');
    link.textContent = this.label || this.url;
    if (url) link.href = url;
    link.title = '点击编辑；Ctrl + 点击打开链接';
    link.rel = 'noopener noreferrer'; link.target = '_blank';
    link.addEventListener('click', event => {
      if (!event.ctrlKey && !event.metaKey) { event.preventDefault(); view.state.facet(actionsFacet).focusAt(this.from + 1); return; }
      if (original && resources.openLink) { event.preventDefault(); void resources.openLink(original); }
    });
    return link;
  }
  ignoreEvent(): boolean { return true; }
}

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number) { super(); }
  eq(other: TableWidget): boolean { return this.source === other.source && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div'); wrapper.className = 'fm-table-wrap';
    const table = document.createElement('table');
    const rows = this.source.split(/\r?\n/);
    for (let index = 0; index < rows.length; index++) {
      if (index === 1) continue;
      const row = document.createElement('tr');
      for (const value of rows[index].trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/)) {
        const cell = document.createElement(index === 0 ? 'th' : 'td');
        cell.textContent = value.trim().replace(/\\\|/g, '|');
        row.append(cell);
      }
      table.append(row);
    }
    table.addEventListener('mousedown', event => { event.preventDefault(); view.state.facet(actionsFacet).focusAt(this.from + 1); });
    wrapper.append(table);
    return wrapper;
  }
  ignoreEvent(): boolean { return true; }
}

/**
 * 函数职责：构造与当前源文一致的预览装饰。
 * 输入说明：折叠和完成过滤区间先合并，之后才加入行内装饰。
 * 输出说明：替换范围不重叠；昂贵公式 DOM 仅由 CodeMirror 在可见时创建。
 * 实现思路：基于共享语法树访问节点，活动结构保留标记，其余内容按语义排版。
 */
function buildPreview(state: EditorState): DecorationSet {
  const mode = state.facet(modeFacet);
  if (mode === 'source') return Decoration.none;
  const model = state.field(documentField);
  const folds = state.field(foldsField);
  const ranges: Range<Decoration>[] = [];
  const completing = new Set(state.field(completionField).values());
  const hidden = getHiddenRanges(model, mode).filter(range => mode !== 'todo' || ![...completing].some(from => from >= range.from && from < range.to)).map(range => ({ from: range.from, to: range.to, widget: range.parentFrom !== null && range.count ? new NoteWidget(`已完成 ${range.count} 项`) : undefined, block: true }));
  for (const item of model.items) if (folds.has(item.from) && item.to > item.firstLineTo) hidden.push({ from: item.firstLineTo, to: item.to, widget: new NoteWidget(' … 已折叠', item.from), block: false });
  hidden.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: typeof hidden = [];
  for (const range of hidden) {
    const last = merged.at(-1);
    if (last && range.from < last.to) { last.to = Math.max(last.to, range.to); continue; }
    if (range.from < range.to) merged.push({ ...range });
  }
  for (const range of merged) ranges.push(Decoration.replace({ widget: range.widget, block: range.block }).range(range.from, range.to));
  // 隐藏区间已排序且不重叠，二分定位避免大清单装饰与已完成项形成平方级扫描。
  const overlappingRange = (from: number, to: number): typeof merged[number] | undefined => {
    let low = 0; let high = merged.length;
    while (low < high) { const middle = (low + high) >>> 1; if (merged[middle].to <= from) low = middle + 1; else high = middle; }
    const range = merged[low];
    return range && range.from < to ? range : undefined;
  };
  const overlapsHidden = (from: number, to: number): boolean => !!overlappingRange(from, to);
  const active = (from: number, to: number): boolean => mode !== 'archive' && state.selection.ranges.some(selection => selection.from <= to && selection.to >= from);
  const addMark = (from: number, to: number, className: string): void => { if (from < to && !overlapsHidden(from, to)) ranges.push(Decoration.mark({ class: className }).range(from, to)); };
  const hide = (from: number, to: number): void => { if (from < to && !overlapsHidden(from, to)) ranges.push(Decoration.replace({}).range(from, to)); };
  const lines = new Set<string>();
  const lineStyle = (from: number, className: string): void => {
    const start = state.doc.lineAt(from).from;
    if (overlapsHidden(start, start + 1) || lines.has(`${start}:${className}`)) return;
    lines.add(`${start}:${className}`); ranges.push(Decoration.line({ class: className }).range(start));
  };
  const orderedCounters = new Map<number, number>();
  for (const item of model.items) {
    const marker = model.text.slice(item.markerFrom, item.markerTo);
    let label = '•';
    if (/^\d/.test(marker)) { const number = orderedCounters.get(item.listFrom) ?? Number.parseInt(marker); orderedCounters.set(item.listFrom, number + 1); label = `${number}.`; }
    if (overlapsHidden(item.from, item.firstLineTo)) continue;
    ranges.push(Decoration.replace({ widget: new ItemWidget(item, folds.has(item.from), label) }).range(item.markerFrom, item.task ? item.task.to : item.markerTo));
    lineStyle(item.from, `fm-list-line${item.task?.checked ? ' fm-completed-line' : ''}${completing.has(item.from) ? ' fm-completing-line' : ''}`);
  }
  const visit = (node: SyntaxNode): void => {
    const hiddenRange = overlappingRange(node.from, node.to);
    if (hiddenRange && node.from >= hiddenRange.from && node.to <= hiddenRange.to) return;
    const name = node.name;
    const source = model.text.slice(node.from, node.to);
    const editing = active(node.from, node.to);
    if (/^ATXHeading[1-6]$/.test(name)) {
      lineStyle(node.from, `fm-heading fm-h${name.at(-1)}`);
      if (!editing && node.firstChild?.name === 'HeaderMark') hide(node.firstChild.from, Math.min(node.firstChild.to + 1, node.to));
    }
    if (name === 'Emphasis' || name === 'StrongEmphasis' || name === 'Strikethrough' || name === 'InlineCode') {
      addMark(node.from, node.to, ({ Emphasis: 'fm-em', StrongEmphasis: 'fm-strong', Strikethrough: 'fm-strike', InlineCode: 'fm-code' } as Record<string, string>)[name]);
      if (!editing) for (let child = node.firstChild; child; child = child.nextSibling) if (/Mark$/.test(child.name)) hide(child.from, child.to);
    }
    if ((name === 'Link' || name === 'Image') && !editing && !overlapsHidden(node.from, node.to)) {
      const match = source.match(/^!?\[([^]*)\]\(([^\s)]*)(?:\s+[^]*)?\)$/);
      if (match) { ranges.push(Decoration.replace({ widget: new LinkWidget(match[1], match[2], node.from, name === 'Image') }).range(node.from, node.to)); return; }
    }
    if (name === 'MathBlock' || name === 'InlineMath') {
      if (!editing && !overlapsHidden(node.from, node.to)) {
        const block = name === 'MathBlock'; const delimiter = block ? '$$' : '$';
        const trimmed = source.trim(); const valid = trimmed.length > delimiter.length && trimmed.endsWith(delimiter);
        const expression = trimmed.slice(delimiter.length, valid ? -delimiter.length : undefined).trim();
        ranges.push(Decoration.replace({ widget: new MathWidget(expression, block, node.from, valid), block }).range(node.from, node.to));
      }
      return;
    }
    if (name === 'Table' && !editing && !overlapsHidden(node.from, node.to)) { ranges.push(Decoration.replace({ widget: new TableWidget(source, node.from), block: true }).range(node.from, node.to)); return; }
    if (name === 'Blockquote') for (let line = state.doc.lineAt(node.from); line.from <= node.to; ) { lineStyle(line.from, 'fm-quote'); if (line.number >= state.doc.lines) break; line = state.doc.line(line.number + 1); }
    if (name === 'QuoteMark' && !active(state.doc.lineAt(node.from).from, state.doc.lineAt(node.from).to)) hide(node.from, Math.min(node.to + 1, state.doc.length));
    if (name === 'FencedCode' || name === 'CodeBlock') {
      for (let line = state.doc.lineAt(node.from); line.from <= node.to; ) { lineStyle(line.from, 'fm-code-line'); if (line.number >= state.doc.lines) break; line = state.doc.line(line.number + 1); }
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(model.tree.topNode);
  return Decoration.set(ranges, true);
}

export const previewField = StateField.define<DecorationSet>({
  create: buildPreview,
  update: (value, transaction) => transaction.docChanged || transaction.selection || transaction.effects.length || transaction.reconfigured ? buildPreview(transaction.state) : value,
  provide: field => EditorView.decorations.from(field),
});
