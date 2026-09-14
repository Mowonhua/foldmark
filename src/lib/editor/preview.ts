/**
 * 文件职责：把同一 Markdown 状态投影为可编辑的就地预览。
 * 定义范围：语法装饰、任务控件、公式与表格的惰性 DOM 渲染。
 */
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import katex from 'katex';
import { getHiddenRanges, type DocumentModel, type ListItem } from '../markdown';
import { hiddenContentRanges } from './visibility';
import { actionsFacet, documentField, foldsField, modeFacet, resourcesFacet } from './state';
import { previewWindowField } from './viewport';
import type { EditorOptions } from './types';
import { CodeLanguageWidget } from './code-language';
import { paragraphLayout } from './paragraphs';
import { activateFencedBlock, fencedBlocks, pendingFencedBlock } from './fenced-blocks';
import { removeEmptyFencedBlock } from './fenced-block-editing';

/** 共享行内排版只依赖源文和资源端口；无 focusAt 时生成可嵌入整行按钮的只读内容。 */
interface InlineContext {
  model: DocumentModel;
  resources: Pick<EditorOptions, 'resolveResource' | 'openLink'>;
  focusAt?: (from: number) => void;
}

function inlineContext(view: EditorView): InlineContext {
  return { model: view.state.field(documentField), resources: view.state.facet(resourcesFacet), focusAt: from => view.state.facet(actionsFacet).focusAt(from) };
}

class ItemWidget extends WidgetType {
  constructor(readonly item: ListItem, readonly folded: boolean, readonly label: string) { super(); }
  eq(other: ItemWidget): boolean { return this.item.from === other.item.from && this.item.to === other.item.to && this.item.task?.checked === other.item.task?.checked && this.folded === other.folded && this.label === other.label; }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = `fm-item-controls${this.item.task ? ' fm-task-controls' : ''}${this.folded ? ' is-folded' : ''}`;
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
      // 可见完成标记由 CSS 主题变量绘制；名称和状态由 ARIA 提供，不依赖具体字形。
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

/** 已闭合但没有正文行的围栏显示空框；用户首次激活时才插入可编辑空行，读取预览不改写文件。 */
class EmptyCodeWidget extends WidgetType {
  constructor(readonly from: number, readonly kind: 'code' | 'math' = 'code') { super(); }
  eq(other: EmptyCodeWidget): boolean { return this.from === other.from && this.kind === other.kind; }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('div');
    element.className = `fm-code-line fm-code-start fm-code-end fm-empty-code${this.kind === 'math' ? ' fm-math-edit-line' : ''}`;
    element.setAttribute('aria-label', this.kind === 'math' ? '空公式块' : '空代码块');
    if (view.state.readOnly) return element;
    element.tabIndex = 0; element.setAttribute('role', 'button');
    const activate = (event: Event): void => {
      event.preventDefault();
      activateFencedBlock(view, this.from);
    };
    element.addEventListener('mousedown', activate);
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
      if (event.key === 'Backspace' && removeEmptyFencedBlock(view, this.from)) event.preventDefault();
    });
    return element;
  }
  ignoreEvent(): boolean { return true; }
}

/** 独立块间距计入 CodeMirror 的高度测量，不能用文本行外边距，否则鼠标定位会偏移。 */
class BlockGapWidget extends WidgetType {
  eq(): boolean { return true; }
  toDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'fm-block-gap';
    element.setAttribute('aria-hidden', 'true');
    return element;
  }
}

/** 块控件沿用所属列表的布局；坐标和事件仍由原控件负责，缩进不写回源文。 */
class IndentedWidget extends WidgetType {
  constructor(readonly widget: WidgetType, readonly margin: string) { super(); }
  eq(other: IndentedWidget): boolean { return this.margin === other.margin && this.widget.constructor === other.widget.constructor && this.widget.eq(other.widget); }
  toDOM(view: EditorView): HTMLElement {
    const element = this.widget.toDOM(view);
    element.style.marginLeft = this.margin;
    return element;
  }
  ignoreEvent(event: Event): boolean { return this.widget.ignoreEvent(event); }
  destroy(dom: HTMLElement): void { this.widget.destroy(dom); }
}

const mathCache = new Map<string, string>();
class MathWidget extends WidgetType {
  constructor(readonly expression: string, readonly block: boolean, readonly from: number, readonly valid: boolean, readonly source = '') { super(); }
  eq(other: MathWidget): boolean { return this.expression === other.expression && this.block === other.block && this.from === other.from && this.valid === other.valid && this.source === other.source; }
  toDOM(view: EditorView): HTMLElement {
    const context = inlineContext(view);
    if (this.block) context.focusAt = () => { activateFencedBlock(view, this.from); };
    const rendered = this.render(context);
    if (!this.block) return rendered;
    const block = fencedBlocks(view.state).find(block => block.nodeFrom === this.from);
    if (!block) return rendered;
    const frame = document.createElement('div');
    frame.className = 'fm-math-frame';
    // 用不可见的正文副本保留编辑态行高和自动折行；公式排版不参与文档高度计算。
    // 高公式在同一视口内滚动，不能在离开编辑态时推动后续段落。
    const source = view.state.sliceDoc(block.bodyFrom, block.bodyTo).split('\n');
    source.forEach((text, index) => {
      const line = document.createElement('div');
      line.className = `fm-math-size-line${index === 0 ? ' fm-code-start' : ''}${index === source.length - 1 ? ' fm-code-end' : ''}`;
      line.setAttribute('aria-hidden', 'true');
      line.textContent = text.startsWith(block.indent) ? text.slice(block.indent.length) : text;
      if (!line.textContent) line.append(document.createElement('br'));
      frame.append(line);
    });
    frame.append(rendered);
    return frame;
  }
  render(context: InlineContext): HTMLElement {
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
    if (context.focusAt) element.addEventListener('mousedown', event => { event.preventDefault(); context.focusAt!(this.from + (this.block ? 2 : 1)); });
    return element;
  }
  ignoreEvent(): boolean { return true; }
}

/** 只允许可安全显示的链接协议，原文本始终可通过进入编辑或源码视图修改。 */
function safeUrl(value: string, image: boolean): string | null {
  const clean = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(clean)) return null;
  if (/^(https?:|mailto:|#|\.\.?\/|\/)/i.test(clean) || !/^[a-z][a-z\d+.-]*:/i.test(clean)) return clean;
  if (image && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(clean)) return clean;
  return null;
}

interface LinkTarget { url: string; title: string }
interface InlineLabel { node: SyntaxNode; source: string; sourceFrom: number; from: number; to: number }
const referenceCache = new WeakMap<DocumentModel, ReadonlyMap<string, LinkTarget>>();
const entityCache = new Map<string, string>();

/** 标签只做大小写与空白归一，不能反转义后匹配，否则不同引用标签会错误合并。 */
function normalizeLabel(label: string): string { return label.trim().replace(/[ \t\r\n]+/g, ' ').toUpperCase().toLowerCase(); }

/** 只把已匹配的单个字符引用交给 DOM 解码，源文不能作为 HTML 标签进入 DOM。 */
function decodeLinkText(value: string): string {
  return value.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g, '$1').replace(/&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]*);/g, entity => {
    const cached = entityCache.get(entity);
    if (cached !== undefined) return cached;
    const decoder = document.createElement('textarea'); decoder.innerHTML = entity;
    if (entityCache.size >= 128) entityCache.delete(entityCache.keys().next().value!);
    entityCache.set(entity, decoder.value);
    return decoder.value;
  });
}

function linkDestination(raw: string): string { return decodeLinkText(raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw); }

/** 引用定义来自同一棵完整语法树；同名定义保留第一次出现者，并按文档快照缓存。 */
function linkReferences(model: DocumentModel): ReadonlyMap<string, LinkTarget> {
  const cached = referenceCache.get(model);
  if (cached) return cached;
  const references = new Map<string, LinkTarget>();
  model.tree.iterate({ enter: cursor => {
    if (cursor.name !== 'LinkReference') return;
    const node = cursor.node;
    const label = node.getChild('LinkLabel'); const url = node.getChild('URL'); const title = node.getChild('LinkTitle');
    if (label && url) {
      const key = normalizeLabel(model.text.slice(label.from + 1, label.to - 1));
      if (!references.has(key)) references.set(key, { url: linkDestination(model.text.slice(url.from, url.to)), title: title ? decodeLinkText(model.text.slice(title.from + 1, title.to - 1)) : '' });
    }
    return false;
  } });
  referenceCache.set(model, references);
  return references;
}

/**
 * 函数职责：统一解析正文和表格中的行内、引用式及自动链接。
 * 输入说明：节点和模型必须属于同一源文快照；不存在引用定义时返回 null 以保留原文。
 * 输出说明：控件共享资源解析与安全协议校验，源码始终不修改。
 * 实现思路：优先采用语法 URL 节点，引用式回查标签，自动邮件和 www 补足协议。
 */
function linkWidget(node: SyntaxNode, model: DocumentModel): LinkWidget | null {
  const text = (from: number, to: number): string => model.text.slice(from, to);
  if (node.name === 'Autolink' || node.name === 'URL') {
    const urlNode = node.name === 'URL' ? node : node.getChild('URL');
    if (!urlNode) return null;
    const label = text(urlNode.from, urlNode.to);
    const destination = /^www\./i.test(label) ? `http://${label}` : !/^[a-z][a-z\d+.-]*:/i.test(label) && /^[^\s@]+@[^\s@]+$/.test(label) ? `mailto:${label}` : label;
    return new LinkWidget(label, destination, node.from, false);
  }
  if (node.name !== 'Link' && node.name !== 'Image') return null;
  const opening = node.firstChild;
  let closing = opening?.nextSibling ?? null;
  while (closing && !(closing.name === 'LinkMark' && text(closing.from, closing.to) === ']')) closing = closing.nextSibling;
  if (!opening || !closing) return null;
  const label = text(opening.to, closing.from);
  const url = node.getChild('URL'); const title = node.getChild('LinkTitle');
  let target: LinkTarget | undefined;
  if (url) target = { url: linkDestination(text(url.from, url.to)), title: title ? decodeLinkText(text(title.from + 1, title.to - 1)) : '' };
  else {
    const reference = node.getChild('LinkLabel');
    const referenceLabel = reference ? text(reference.from + 1, reference.to - 1) : '';
    target = linkReferences(model).get(normalizeLabel(referenceLabel || label));
  }
  if (!target) return null;
  return new LinkWidget(label, target.url, node.from, node.name === 'Image', target.title, { node, source: model.text, sourceFrom: 0, from: opening.to, to: closing.from });
}

class LinkWidget extends WidgetType {
  constructor(readonly label: string, readonly url: string, readonly from: number, readonly image: boolean, readonly title = '', readonly inline?: InlineLabel) { super(); }
  eq(other: LinkWidget): boolean { return this.label === other.label && this.url === other.url && this.from === other.from && this.image === other.image && this.title === other.title; }
  toDOM(view: EditorView): HTMLElement { return this.render(inlineContext(view)); }
  render(context: InlineContext, from = this.inline?.from, to = this.inline?.to): HTMLElement {
    const resources = context.resources;
    const original = safeUrl(this.url, this.image) ?? (resources.resolveResource && !/[\u0000-\u001f\u007f]/.test(this.url) && /^(?:[a-z]:[\\/]|file:)/i.test(this.url) ? this.url : null);
    const url = original === null ? null : resources.resolveResource?.(original) ?? original;
    if (this.image && url) {
      const image = document.createElement('img');
      image.src = url; image.alt = this.inline ? inlineContent(this.inline.node, this.inline.source, this.inline.sourceFrom, context, Math.max(from!, this.inline.from), Math.min(to!, this.inline.to)).textContent ?? this.label : this.label; image.loading = 'lazy'; image.className = 'fm-image';
      if (this.title) image.title = this.title;
      if (context.focusAt) image.addEventListener('click', () => context.focusAt!(this.from + 2));
      return image;
    }
    const link: HTMLElement = document.createElement(context.focusAt ? 'a' : 'span');
    link.className = 'fm-link';
    if (this.inline) link.append(inlineContent(this.inline.node, this.inline.source, this.inline.sourceFrom, context, Math.max(from!, this.inline.from), Math.min(to!, this.inline.to)));
    else link.textContent = this.label || this.url;
    // 聚合任务的整行按钮负责定位，内部链接不生成第二个可交互目标。
    if (!context.focusAt) { if (this.title) link.title = this.title; return link; }
    if (url) link.setAttribute('href', url);
    link.title = this.title ? `${this.title} · 点击编辑；Ctrl + 点击打开链接` : '点击编辑；Ctrl + 点击打开链接';
    link.setAttribute('rel', 'noopener noreferrer'); link.setAttribute('target', '_blank');
    link.addEventListener('click', event => {
      if (!event.ctrlKey && !event.metaKey) { event.preventDefault(); context.focusAt!(this.from + 1); return; }
      if (original && resources.openLink) { event.preventDefault(); void resources.openLink(original); }
    });
    return link;
  }
  ignoreEvent(): boolean { return true; }
}

/**
 * 函数职责：按共享语法节点渲染表格单元格及链接文字中的行内组合语法。
 * 输入说明：source 为源文切片，sourceFrom 把节点绝对坐标映射到该原文。
 * 输出说明：只创建安全 DOM；链接与公式复用正文预览的资源和错误处理契约。
 * 实现思路：保留子节点之间的文字，省略语法标记，并递归渲染语义子节点。
 */
function inlineContent(node: SyntaxNode, source: string, sourceFrom: number, context: InlineContext, from = node.from, to = node.to): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const text = (start: number, end: number): string => source.slice(start - sourceFrom, end - sourceFrom);
  let position = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    if (child.from > position) fragment.append(document.createTextNode(text(position, child.from)));
    if (/Mark$/.test(child.name)) { position = child.to; continue; }
    const raw = text(Math.max(from, child.from), Math.min(to, child.to));
    const tag = ({ Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'del', InlineCode: 'code' } as Record<string, string>)[child.name];
    if (tag) {
      const element = document.createElement(tag);
      if (tag === 'code') element.className = 'fm-code';
      element.append(inlineContent(child, source, sourceFrom, context, Math.max(from, child.from), Math.min(to, child.to)));
      fragment.append(element);
    } else if (child.name === 'InlineMath' || child.name === 'InlineMathUnclosed') {
      // 首行摘要截断公式时保留可见原文，不能把后续任务正文一并排入标题。
      if (child.to > to) { fragment.append(document.createTextNode(raw)); position = to; continue; }
      const valid = child.name === 'InlineMath';
      fragment.append(new MathWidget(raw.slice(1, valid ? -1 : undefined), false, child.from, valid).render(context));
    } else if (child.name === 'Link' || child.name === 'Image' || child.name === 'Autolink' || child.name === 'URL') {
      const widget = linkWidget(child, context.model);
      fragment.append(widget ? widget.render(context, from, to) : document.createTextNode(raw));
    } else if (child.name === 'Escape') fragment.append(document.createTextNode(raw.slice(1)));
    else if (child.name === 'Entity') fragment.append(document.createTextNode(decodeLinkText(raw)));
    else fragment.append(document.createTextNode(raw));
    position = child.to;
  }
  if (position < to) fragment.append(document.createTextNode(text(position, to)));
  return fragment;
}

/**
 * 按任务所属文档的语法快照排版首行，保留全文引用定义及资源解析上下文。
 * item 必须来自 model；只生成展示 DOM，不挂载编辑器或改变原文及任务定位坐标。
 */
export function renderTaskTitle(model: DocumentModel, item: ListItem, resources: InlineContext['resources'] = {}): DocumentFragment {
  let node: SyntaxNode | null = model.tree.resolveInner(item.contentFrom, 1);
  while (node && node.name !== 'Task' && node.name !== 'Paragraph') node = node.parent;
  if (!node) {
    const fragment = document.createDocumentFragment();
    fragment.append(document.createTextNode(model.text.slice(item.contentFrom, item.firstLineTo)));
    return fragment;
  }
  return inlineContent(node, model.text, 0, { model, resources }, item.contentFrom, item.firstLineTo);
}

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number, readonly node: SyntaxNode) { super(); }
  eq(other: TableWidget): boolean { return this.source === other.source && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div'); wrapper.className = 'fm-table-wrap';
    const table = document.createElement('table');
    const delimiterNode = this.node.getChild('TableDelimiter');
    const delimiter = delimiterNode ? this.source.slice(delimiterNode.from - this.from, delimiterNode.to - this.from).trim().replace(/^\||\|$/g, '').split('|') : [];
    let columnCount = 0;
    for (let rowNode = this.node.firstChild; rowNode; rowNode = rowNode.nextSibling) {
      if (rowNode.name !== 'TableHeader' && rowNode.name !== 'TableRow') continue;
      const row = document.createElement('tr');
      const cells: (SyntaxNode | null)[] = [];
      let pending: SyntaxNode | null = null;
      // 空单元格没有 TableCell 节点，必须以语法分隔符补齐列，不能让后列左移。
      for (let child = rowNode.firstChild; child; child = child.nextSibling) {
        if (child.name === 'TableCell') pending = child;
        if (child.name === 'TableDelimiter' && child.from !== rowNode.from) { cells.push(pending); pending = null; }
      }
      if (pending || rowNode.lastChild?.name !== 'TableDelimiter') cells.push(pending);
      if (rowNode.name === 'TableHeader') columnCount = cells.length;
      for (let column = 0; column < columnCount; column++) {
        const cellNode = cells[column];
        const cell = document.createElement(rowNode.name === 'TableHeader' ? 'th' : 'td');
        cell.dataset.sourceFrom = String(cellNode?.from ?? rowNode.from);
        const alignment = delimiter[column]?.trim() ?? '';
        if (alignment.endsWith(':')) cell.style.textAlign = alignment.startsWith(':') ? 'center' : 'right';
        if (cellNode) cell.append(inlineContent(cellNode, this.source, this.from, inlineContext(view)));
        row.append(cell);
      }
      table.append(row);
    }
    table.addEventListener('mousedown', event => {
      if (event.defaultPrevented || ((event.ctrlKey || event.metaKey) && (event.target as Element).closest('a'))) return;
      event.preventDefault();
      const cell = (event.target as Element).closest<HTMLElement>('[data-source-from]');
      view.state.facet(actionsFacet).focusAt(cell ? Number(cell.dataset.sourceFrom) : this.from + 1);
    });
    wrapper.append(table);
    return wrapper;
  }
  ignoreEvent(): boolean { return true; }
}

interface PreviewStructure {
  mode: string;
  folds: ReadonlySet<number>;
  window: { from: number; to: number };
  hidden: { from: number; to: number; widget: NoteWidget | undefined; block: boolean }[];
  decorations: DecorationSet;
}
/** 选区变化不改变列表结构，复用整份文档的过滤和控件装饰。 */
const structureCache = new WeakMap<DocumentModel, PreviewStructure>();

/**
 * 函数职责：构造与当前源文一致的预览装饰。
 * 输入说明：折叠和完成过滤区间先合并，之后才加入行内装饰。
 * 输出说明：替换范围不重叠；昂贵公式 DOM 仅由 CodeMirror 在可见时创建。
 * 实现思路：基于共享语法树访问节点，活动结构保留标记，其余内容按语义排版。
 */
function buildPreview(state: EditorState): DecorationSet {
  const mode = state.facet(modeFacet);
  if (mode === 'source') return Decoration.set(hiddenContentRanges(state).map(range => Decoration.replace({ block: true, inclusiveEnd: false }).range(range.from, range.to)), true);
  const model = state.field(documentField);
  const folds = state.field(foldsField);
  const ranges: Range<Decoration>[] = [];
  const window = state.field(previewWindowField);
  let cached = structureCache.get(model);
  if (cached?.mode !== mode || cached.folds !== folds || cached.window !== window) cached = undefined;
  const merged: PreviewStructure['hidden'] = cached?.hidden ?? [];
  if (!cached) {
    for (const range of hiddenContentRanges(state)) {
      const widget = range.kind === 'fold' ? new NoteWidget(' … 已折叠',range.itemFrom)
        : range.itemFrom !== null && range.count ? new NoteWidget(`已完成 ${range.count} 项`) : undefined;
      merged.push({ from: range.from, to: range.to, widget, block: range.kind !== 'fold' });
    }
    // 过滤范围右端是下一条可见行的起点；块替换不能吞掉该行的缩进、标题等行装饰。
    for (const range of merged) ranges.push(Decoration.replace({ widget: range.widget, block: range.block, inclusiveEnd: false }).range(range.from, range.to));
  }
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
  if (!cached) {
    const orderedCounters = new Map<number, number>();
    for (const item of model.items) {
      if (item.from > window.to) break;
      const marker = model.text.slice(item.markerFrom, item.markerTo);
      let label = '•';
      if (/^\d/.test(marker)) { const number = orderedCounters.get(item.listFrom) ?? Number.parseInt(marker); orderedCounters.set(item.listFrom, number + 1); label = `${number}.`; }
      if (item.firstLineTo < window.from || overlapsHidden(item.from, item.firstLineTo)) continue;
      ranges.push(Decoration.replace({ widget: new ItemWidget(item, folds.has(item.from), label) }).range(item.markerFrom, item.task ? item.contentFrom : item.markerTo));
      lineStyle(item.from, `fm-list-line${item.task?.checked ? ' fm-completed-line' : ''}`);
    }
    cached = { mode, folds, window, hidden: merged, decorations: Decoration.set(ranges, true) };
    structureCache.set(model, cached);
    ranges.length = 0;
  }
  // CodeMirror 的行和块控件是平级 DOM，不能依赖列表祖先的 CSS 继承缩进。
  // 深层条目覆盖父项的行归属；仅隐藏容器要求的前导空白，代码自身缩进必须保留。
  const layout = new Map<number, { margin: string; prefixTo: number }>();
  for (const item of model.items) {
    if (item.from > window.to) break;
    if (item.to < window.from) continue;
    const opening = state.doc.lineAt(item.from);
    const markerEnd = item.markerTo - opening.from;
    const continuation = markerEnd + (opening.text.slice(markerEnd).match(/^[ \t]+/)?.[0].length ?? 0);
    const first = state.doc.lineAt(Math.max(item.from, window.from)).number;
    const last = state.doc.lineAt(Math.min(item.to, window.to)).number;
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      const heading = number === opening.number;
      const whitespace = line.text.match(/^[ \t]*/)?.[0].length ?? 0;
      const depth = item.depth + (heading ? 0 : 1);
      layout.set(line.from, { margin: `calc(var(--editor-font-size, 16px) * ${depth * 1.5})`, prefixTo: line.from + Math.min(whitespace, heading ? item.markerFrom - line.from : continuation) });
    }
  }
  // 空正文及空续行尚不一定进入 ListItem.to；沿共享段落归属布局，输入首字不会再触发横移。
  const paragraphs = paragraphLayout(state);
  const editableBlocks = new Map(fencedBlocks(state).map(block => [block.nodeFrom, block]));
  for (const paragraph of paragraphs.paragraphs) {
    if (paragraph.from > window.to) break;
    if (paragraph.kind === 'empty' && paragraph.to >= window.from && !overlapsHidden(paragraph.from, paragraph.to + 1)) {
      ranges.push(Decoration.line({ attributes: { 'data-empty-paragraph-from': String(paragraph.from) } }).range(paragraph.from));
    }
    if (!paragraph.item || paragraph.kind === 'literal' || paragraph.to < window.from) continue;
    const first = state.doc.lineAt(Math.max(paragraph.from, window.from)).number;
    const last = state.doc.lineAt(Math.min(paragraph.to, window.to)).number;
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number);
      if (line.from === paragraph.item.moveFrom) continue;
      const whitespace = line.text.match(/^[ \t]*/)?.[0].length ?? 0;
      layout.set(line.from, {
        margin: `calc(var(--editor-font-size, 16px) * ${(paragraph.item.depth + 1) * 1.5})`,
        prefixTo: line.from + Math.min(whitespace, paragraph.indent.length),
      });
    }
  }
  const replacedBlocks: { from: number; to: number }[] = [];
  const blockReplacement = (node: SyntaxNode, widget: WidgetType, includeLineBreak = false): void => {
    const line = state.doc.lineAt(node.from);
    // 吃掉缩进空白所在的整行，避免在块控件前残留一个有行高的文本片段。
    // 同行存在列表标记时保留该片段，任务控件仍必须可操作。
    const from = /^[ \t]*$/.test(model.text.slice(line.from, node.from)) ? line.from : node.from;
    if (overlapsHidden(from, node.to)) return;
    const margin = layout.get(line.from)?.margin ?? '';
    // 公式整体替换需包含闭围栏后的换行，否则块控件与段落分隔之间会残留空文本行。
    const separator = includeLineBreak ? paragraphs.separators.find(separator => separator.from === node.to) : undefined;
    const to = includeLineBreak && state.doc.lineAt(node.to).to === node.to ? Math.min((separator?.blankTo ?? node.to) + 1, state.doc.length) : node.to;
    ranges.push(Decoration.replace({ widget: new IndentedWidget(widget, margin), block: true, inclusiveEnd: false }).range(from, to));
    replacedBlocks.push({ from, to });
  };
  const spacedLines = new Set<number>();
  const separateBlock = (node: SyntaxNode): void => {
    if (!/^(FencedCode|CodeBlock|Blockquote|MathBlock|Table|Paragraph|Task)$/.test(node.name)) return;
    const line = state.doc.lineAt(node.from);
    if (line.number === 1 || spacedLines.has(line.from)) return;
    const previous = state.doc.line(line.number - 1);
    // 容器首行与其内容是同一块；列表标题、引用首段不能各加一次间距。
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (/^(ListItem|Blockquote)$/.test(parent.name) && state.doc.lineAt(parent.from).from === line.from) return;
      // 同一引用内只有容器标记的行在预览中也是空行，不能再次补间距。
      if (parent.name === 'Blockquote' && parent.from <= previous.to && /^[ \t]*(?:>[ \t]*)+$/.test(previous.text)) return;
    }
    // 显式段落分隔由空行投影统一处理，不叠加额外块间距；被过滤的前块也不产生留白。
    if (!previous.text.trim() || overlapsHidden(previous.from, line.from) || overlapsHidden(line.from, line.from + 1)) return;
    spacedLines.add(line.from);
    ranges.push(Decoration.widget({ widget: new BlockGapWidget(), block: true, side: -1 }).range(line.from));
  };
  const visit = (node: SyntaxNode): void => {
    if (node.to < window.from || node.from > window.to) return;
    const hiddenRange = overlappingRange(node.from, node.to);
    if (hiddenRange && node.from >= hiddenRange.from && node.to <= hiddenRange.to) return;
    const pending = editableBlocks.get(node.from);
    if ((node.name === 'FencedCode' || node.name === 'MathBlock') && pending && pendingFencedBlock(state, pending)) return;
    separateBlock(node);
    const name = node.name;
    const source = model.text.slice(node.from, node.to);
    const editing = active(node.from, node.to);
    if (/^ATXHeading[1-6]$/.test(name)) {
      lineStyle(node.from, `fm-heading fm-h${name.at(-1)}`);
      if (!editing && node.firstChild?.name === 'HeaderMark') hide(node.firstChild.from, Math.min(node.firstChild.to + 1, node.to));
    }
    if (/^SetextHeading[12]$/.test(name)) {
      lineStyle(node.from, `fm-heading fm-h${name.at(-1)}`);
      const mark = node.getChild('HeaderMark');
      if (mark && !editing) {
        const line = state.doc.lineAt(mark.from);
        const to = Math.min(state.doc.length, line.to + 1);
        if (!overlapsHidden(line.from, to)) ranges.push(Decoration.replace({ block: true }).range(line.from, to));
      }
    }
    if (name === 'Emphasis' || name === 'StrongEmphasis' || name === 'Strikethrough' || name === 'InlineCode') {
      addMark(node.from, node.to, ({ Emphasis: 'fm-em', StrongEmphasis: 'fm-strong', Strikethrough: 'fm-strike', InlineCode: 'fm-code' } as Record<string, string>)[name]);
      if (!editing) for (let child = node.firstChild; child; child = child.nextSibling) if (/Mark$/.test(child.name)) hide(child.from, child.to);
    }
    if (name === 'LinkReference') {
      if (!editing && !overlapsHidden(node.from, node.to)) {
        const from = state.doc.lineAt(node.from).from;
        const to = Math.min(state.doc.length, state.doc.lineAt(node.to).to + 1);
        if (!overlapsHidden(from, to)) ranges.push(Decoration.replace({ block: true }).range(from, to));
      }
      return;
    }
    if (name === 'Link' || name === 'Image' || name === 'Autolink' || name === 'URL') {
      if (!editing && !overlapsHidden(node.from, node.to)) {
        const widget = linkWidget(node, model);
        if (widget) { ranges.push(Decoration.replace({ widget }).range(node.from, node.to)); return; }
      }
      // 链接内部 URL 属于同一个编辑结构，不能在其源码露出时再单独替换目标字符串。
      if (name !== 'URL') return;
    }
    if (name === 'MathBlock') {
      const block = editableBlocks.get(node.from);
      if (!block || overlapsHidden(node.from, node.to)) return;
      if (pendingFencedBlock(state, block)) return;
      if (!editing && block.hasBody) {
        const expression = model.text.slice(block.bodyFrom, block.bodyTo).trim();
        blockReplacement(node, expression ? new MathWidget(expression, true, node.from, block.closed, source) : new EmptyCodeWidget(node.from, 'math'), true);
        return;
      }
      if (!block.hasBody) {
        if (block.closed) blockReplacement(node, new EmptyCodeWidget(node.from, 'math'));
        return;
      }
      for (const mark of block.marks) {
        if (mark.wholeLine) lineStyle(mark.from, 'fm-code-fence');
        hide(mark.from, mark.to);
      }
      const first = state.doc.lineAt(block.bodyFrom).number, last = state.doc.lineAt(block.bodyTo).number;
      for (let number = first; number <= last; number++) {
        lineStyle(state.doc.line(number).from, `fm-code-line fm-math-edit-line${number === first ? ' fm-code-start' : ''}${number === last ? ' fm-code-end' : ''}`);
      }
      return;
    }
    if (name === 'InlineMath' || name === 'InlineMathUnclosed') {
      if (name === 'InlineMathUnclosed' && editing && !overlapsHidden(node.from, node.to)) ranges.push(Decoration.mark({ class: 'fm-math-error', attributes: { title: '公式尚未闭合，请补充 $' } }).range(node.from, node.to));
      if (!editing && !overlapsHidden(node.from, node.to)) {
        const delimiter = '$';
        const trimmed = source.trim(); const valid = name !== 'InlineMathUnclosed' && trimmed.length > delimiter.length && trimmed.endsWith(delimiter);
        const expression = trimmed.slice(delimiter.length, valid ? -delimiter.length : undefined).trim();
        ranges.push(Decoration.replace({ widget: new MathWidget(expression, false, node.from, valid) }).range(node.from, node.to));
      }
      return;
    }
    if (name === 'Table' && !editing && !overlapsHidden(node.from, node.to)) { blockReplacement(node, new TableWidget(source, node.from, node)); return; }
    if (name === 'Blockquote') for (let line = state.doc.lineAt(node.from); line.from <= node.to; ) { lineStyle(line.from, 'fm-quote'); if (line.number >= state.doc.lines) break; line = state.doc.line(line.number + 1); }
    if (name === 'QuoteMark' && !active(state.doc.lineAt(node.from).from, state.doc.lineAt(node.from).to)) hide(node.from, Math.min(node.to + 1, state.doc.length));
    if (name === 'FencedCode' || name === 'CodeBlock') {
      let firstLine = state.doc.lineAt(node.from).number;
      let lastLine = state.doc.lineAt(node.to).number;
      // 代码正文直接使用原编辑器行；进入编辑也不展开围栏，完整源码模式在入口统一跳过预览。
      const sharedBlock = editableBlocks.get(node.from);
      if (name === 'FencedCode' && sharedBlock && pendingFencedBlock(state, sharedBlock)) return;
      const emptyClosed = !!sharedBlock?.closed && !sharedBlock.hasBody;
      if (sharedBlock?.hasBody) {
        // 围栏单独作为零高行隐藏，不能替换到下一行起点；否则 CodeMirror 会吞掉代码首行的行装饰。
        for (const mark of sharedBlock.marks) {
          if (mark.wholeLine) lineStyle(mark.from, 'fm-code-fence');
          hide(mark.from, mark.to);
        }
        firstLine = state.doc.lineAt(sharedBlock.bodyFrom).number;
        lastLine = state.doc.lineAt(sharedBlock.bodyTo).number;
      }
      if (emptyClosed) {
        blockReplacement(node, new EmptyCodeWidget(node.from));
      } else {
        for (let number = firstLine; number <= lastLine; number++) {
          lineStyle(state.doc.line(number).from, `fm-code-line${number === firstLine ? ' fm-code-start' : ''}${number === lastLine ? ' fm-code-end' : ''}`);
        }
      }
      if (name === 'FencedCode' && editing && (sharedBlock?.hasBody || emptyClosed)) {
        const info = node.getChild('CodeInfo');
        const language = info ? model.text.slice(info.from, info.to).match(/^\S*/)?.[0] ?? '' : '';
        if (!overlapsHidden(node.from, node.to)) {
          // 零高控件锚定闭围栏行前，浮在后续文字上方；不能放在行末分隔替换之后，
          // 否则 CodeMirror 会为两种块边界之间的空片段生成一条额外文本行。
          const anchor = sharedBlock?.closed ? state.doc.lineAt(node.to).from : Math.min(node.to + 1, state.doc.length);
          ranges.push(Decoration.widget({ widget: new CodeLanguageWidget(node.from, language), block: true, side: -1 }).range(anchor));
        }
      }
      return;
    }
    for (let child = node.firstChild; child && child.from <= window.to; child = child.nextSibling) if (child.to >= window.from) visit(child);
  };
  visit(model.tree.topNode);
  // 段落模型是源码分隔的唯一来源；投影只隐藏分隔空行，不再从视口或光标推断空段落。
  for (const separator of paragraphs.separators) {
    if (separator.from > window.to) break;
    if (separator.to < window.from || overlapsHidden(separator.from, separator.to)
      || replacedBlocks.some(block => separator.from >= block.from && separator.from < block.to)) continue;
    ranges.push(Decoration.replace({ paragraphSeparator: true }).range(separator.from, separator.blankTo));
  }
  for (const [from, entry] of layout) {
    if (overlapsHidden(from, from + 1) || replacedBlocks.some(block => from >= block.from && from < block.to)) continue;
    ranges.push(Decoration.line({ attributes: { style: `margin-left: ${entry.margin}` } }).range(from));
    // 围栏已整行隐藏；重复覆盖会破坏替换装饰的边界。
    if (!lines.has(`${from}:fm-code-fence`)) hide(from, entry.prefixTo);
  }
  return cached.decorations.update({ add: ranges, sort: true });
}

export const previewField = StateField.define<DecorationSet>({
  create: buildPreview,
  update: (value, transaction) => transaction.docChanged || transaction.selection || transaction.effects.length || transaction.reconfigured ? buildPreview(transaction.state) : value,
  provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => {
    const atoms: Range<Decoration>[] = [];
    // 导航和删除将两个源码换行视为同一边界；绘制仍保留一个换行。
    const cursor = view.state.field(field).iter();
    while (cursor.value) {
      if (cursor.value.spec.paragraphSeparator) atoms.push(Decoration.replace({}).range(cursor.from, cursor.to + 1));
      cursor.next();
    }
    if (view.state.facet(modeFacet) !== 'source') {
      for (const lineBreak of paragraphLayout(view.state).lineBreaks) atoms.push(Decoration.replace({}).range(lineBreak.from, lineBreak.to));
    }
    return Decoration.set(atoms, true);
  })],
});
