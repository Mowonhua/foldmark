/**
 * 文件职责：把更新说明 Markdown 渲染为只读的安全 DOM 片段。
 * 定义范围：GFM 常用块级与行内结构的构建、链接协议白名单；原始 HTML 不透传。
 */
import { GFM, parser } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';

/**
 * 更新说明来自远端清单，按发布说明的常见写法解析：
 * 不套用编辑器的公式扩展，价格等普通美元文本不会被误认成公式。
 */
const notesParser = parser.configure(GFM);

/** 引用式链接的定义表；标签做空白归一并整体忽略大小写。 */
type LinkReferences = ReadonlyMap<string, { url: string; title: string }>;

/** 行内语法到元素标签的映射；其余节点是语法标记或原始 HTML，一律不输出。 */
const inlineTags: Record<string, string> = { Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'del', InlineCode: 'code' };

const entityCache = new Map<string, string>();

/** 只把已匹配的字符引用交给 DOM 解码；链接目标中的反斜杠转义一并还原。 */
function decodeText(value: string): string {
  return value.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g, '$1').replace(/&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]*);/g, entity => {
    const cached = entityCache.get(entity);
    if (cached !== undefined) return cached;
    const decoder = document.createElement('textarea'); decoder.innerHTML = entity;
    if (entityCache.size >= 128) entityCache.delete(entityCache.keys().next().value!);
    entityCache.set(entity, decoder.value);
    return decoder.value;
  });
}

function normalizeLabel(label: string): string { return label.trim().replace(/[ \t\r\n]+/g, ' ').toUpperCase().toLowerCase(); }

/** 链接只放行网页与非空邮件地址，与原生外链校验保持同一范围。 */
function safeLinkUrl(value: string): string | null {
  const clean = value.trim();
  if (!clean || /[\u0000-\u001f\u007f]/.test(clean)) return null;
  return /^(https?:\/\/|mailto:\S)/i.test(clean) ? clean : null;
}

/** 图片目标额外放行常见位图类的 data URL，与 CSP 的 img-src 一致。 */
function safeImageUrl(value: string): string | null {
  const clean = value.trim();
  if (!clean || /[\u0000-\u001f\u007f]/.test(clean)) return null;
  return /^(https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(clean) ? clean : null;
}

/**
 * 函数职责：渲染整篇更新说明为顶层块序列。
 * 输出说明：只包含安全 DOM；源文本一律经 textNode 写入，不经过 innerHTML。
 */
export function renderReleaseNotes(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const tree = notesParser.parse(source);
  const references = collectReferences(tree.topNode, source);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const rendered = renderBlock(node, source, references);
    if (rendered) fragment.append(rendered);
  }
  return fragment;
}

/** 同名引用定义保留第一次出现；只收集顶层定义，更新说明不会在容器内写引用。 */
function collectReferences(root: SyntaxNode, source: string): LinkReferences {
  const references = new Map<string, { url: string; title: string }>();
  for (let node = root.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'LinkReference') continue;
    const label = node.getChild('LinkLabel'); const url = node.getChild('URL');
    if (!label || !url) continue;
    const key = normalizeLabel(source.slice(label.from + 1, label.to - 1));
    if (!references.has(key)) {
      const title = node.getChild('LinkTitle');
      references.set(key, { url: decodeText(source.slice(url.from, url.to)), title: title ? decodeText(source.slice(title.from + 1, title.to - 1)) : '' });
    }
  }
  return references;
}

/** 引用式链接回查定义表；没有匹配时返回空串，由调用方降级为纯文本。 */
function linkDestination(node: SyntaxNode, source: string, references: LinkReferences, label: string): string {
  const url = node.getChild('URL');
  if (url) return decodeText(source.slice(url.from, url.to));
  const reference = node.getChild('LinkLabel');
  return references.get(normalizeLabel(reference ? source.slice(reference.from + 1, reference.to - 1) : label))?.url ?? '';
}

function element(name: string, content?: Node): HTMLElement {
  const element = document.createElement(name);
  if (content) element.append(content);
  return element;
}

/** 块级内容的行首行尾空白不参与排版，去掉首尾的纯空白文本节点。 */
function trimEdges(fragment: DocumentFragment): DocumentFragment {
  const trim = (child: ChildNode | null, side: 'start' | 'end'): void => {
    while (child instanceof Text) {
      const trimmed = side === 'start' ? child.data.replace(/^\s+/, '') : child.data.replace(/\s+$/, '');
      if (trimmed) { child.data = trimmed; return; }
      child.remove();
      child = side === 'start' ? fragment.firstChild : fragment.lastChild;
    }
  };
  trim(fragment.firstChild, 'start');
  trim(fragment.lastChild, 'end');
  return fragment;
}

function renderBlock(node: SyntaxNode, source: string, references: LinkReferences): Node | null {
  const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
  if (heading) return element(`h${heading[1]}`, trimEdges(renderInline(node, source, references)));
  if (node.name === 'Paragraph') return element('p', trimEdges(renderInline(node, source, references)));
  if (node.name === 'BulletList' || node.name === 'OrderedList') return renderList(node, source, references);
  if (node.name === 'Blockquote') {
    const quote = element('blockquote');
    for (let child = node.firstChild; child; child = child.nextSibling) {
      const rendered = renderBlock(child, source, references);
      if (rendered) quote.append(rendered);
    }
    return quote;
  }
  if (node.name === 'FencedCode' || node.name === 'CodeBlock') return renderCode(node, source);
  if (node.name === 'Table') return renderTable(node, source, references);
  if (node.name === 'HorizontalRule') return document.createElement('hr');
  // LinkReference 属于引用定义，HTMLBlock 属于原始 HTML；两者都不作为可见内容输出。
  return null;
}

function renderList(node: SyntaxNode, source: string, references: LinkReferences): HTMLElement {
  const list = element(node.name === 'OrderedList' ? 'ol' : 'ul');
  // lezer 不区分紧凑与松散列表；项内块之间或项之间没有空行时按 GitHub 的紧凑输出，单段内容不包 p。
  const tight = listIsTight(node, source);
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'ListItem') list.append(renderListItem(child, source, references, tight));
  }
  return list;
}

function hasBlankLine(source: string, from: number, to: number): boolean {
  return /\n[ \t]*\r?\n/.test(source.slice(from, to));
}

function listIsTight(list: SyntaxNode, source: string): boolean {
  for (let item = list.firstChild; item; item = item.nextSibling) {
    if (item.name !== 'ListItem') continue;
    for (let child = item.firstChild; child; child = child.nextSibling) {
      if (child.name === 'Paragraph' && child.prevSibling && hasBlankLine(source, child.prevSibling.to, child.from)) return false;
    }
    const next = item.nextSibling;
    if (next && hasBlankLine(source, item.to, next.from)) return false;
  }
  return true;
}

/** 列表项内的任务标记渲染为禁用复选框；列表标记与未识别的裸文本不输出，嵌套列表递归。 */
function renderListItem(item: SyntaxNode, source: string, references: LinkReferences, tight: boolean): HTMLElement {
  const itemElement = element('li');
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name === 'ListMark') continue;
    if (child.name === 'Task') {
      const marker = child.getChild('TaskMarker');
      if (marker) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.disabled = true;
        checkbox.checked = source.slice(marker.from + 1, marker.to - 1).toLowerCase() === 'x';
        itemElement.append(checkbox, trimEdges(renderInline(child, source, references, marker.to, child.to)));
      } else itemElement.append(renderInline(child, source, references));
      continue;
    }
    if (child.name === 'Paragraph' && tight) {
      itemElement.append(trimEdges(renderInline(child, source, references)));
      continue;
    }
    const rendered = renderBlock(child, source, references);
    if (rendered) itemElement.append(rendered);
  }
  return itemElement;
}

/** 代码块输出等宽正文；只剥去围栏行与缩进标记，不做语法高亮。 */
function renderCode(node: SyntaxNode, source: string): HTMLElement | null {
  const lines = source.slice(node.from, node.to).split('\n');
  if (node.name === 'FencedCode') {
    lines.shift();
    // 未闭合围栏没有收尾行，最后一行是正文时必须保留。
    if (lines.length && /^(`{3,}|~{3,})[ \t]*$/.test(lines[lines.length - 1].trim())) lines.pop();
  } else {
    for (let index = 0; index < lines.length; index++) lines[index] = lines[index].replace(/^ {1,4}/, '');
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return null;
  return element('pre', element('code', document.createTextNode(lines.join('\n'))));
}

/** 表格空单元格没有 TableCell 节点，必须按分隔符补齐列，不能让后列左移。 */
function renderTable(node: SyntaxNode, source: string, references: LinkReferences): HTMLElement {
  const columnsOf = (row: SyntaxNode): (SyntaxNode | null)[] => {
    const cells: (SyntaxNode | null)[] = [];
    let pending: SyntaxNode | null = null;
    for (let child = row.firstChild; child; child = child.nextSibling) {
      if (child.name === 'TableCell') pending = child;
      if (child.name === 'TableDelimiter' && child.from !== row.from) { cells.push(pending); pending = null; }
    }
    if (pending || row.lastChild?.name !== 'TableDelimiter') cells.push(pending);
    return cells;
  };
  const header = node.getChild('TableHeader');
  const columns = header ? columnsOf(header).length : 0;
  const table = element('table');
  if (!columns || !header) return table;
  const delimiter = node.getChild('TableDelimiter');
  const alignment = delimiter ? source.slice(delimiter.from, delimiter.to).split('|').map(part => part.trim()).filter(Boolean)
    .map(part => part.startsWith(':') && part.endsWith(':') ? 'center' : part.endsWith(':') ? 'right' : part.startsWith(':') ? 'left' : '') : [];
  const fill = (row: SyntaxNode, name: 'th' | 'td', parent: HTMLElement): void => {
    const cells = columnsOf(row);
    const rowElement = element('tr');
    for (let column = 0; column < columns; column++) {
      const cellElement = element(name);
      const cell = cells[column];
      if (cell) cellElement.append(trimEdges(renderInline(cell, source, references)));
      if (alignment[column]) cellElement.style.textAlign = alignment[column];
      rowElement.append(cellElement);
    }
    parent.append(rowElement);
  };
  const head = element('thead');
  fill(header, 'th', head);
  table.append(head);
  const body = element('tbody');
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableRow') fill(child, 'td', body);
  }
  if (body.hasChildNodes()) table.append(body);
  return table;
}

/**
 * 函数职责：渲染行内内容，语法标记节点跳过，未覆盖的间隙作为纯文本补齐。
 * 输入说明：from/to 允许只渲染父节点的一段，供链接标签与任务正文复用。
 */
function renderInline(parent: SyntaxNode, source: string, references: LinkReferences, from = parent.from, to = parent.to): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const end = Math.min(to, parent.to);
  let position = Math.max(from, parent.from);
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.to <= position) continue;
    if (child.from >= end) break;
    if (child.from > position) fragment.append(document.createTextNode(source.slice(position, child.from)));
    const raw = source.slice(child.from, child.to);
    const tag = inlineTags[child.name];
    if (tag) fragment.append(element(tag, renderInline(child, source, references)));
    else if (child.name === 'Link' || child.name === 'Image' || child.name === 'Autolink' || child.name === 'URL') fragment.append(renderLinkish(child, source, references));
    else if (child.name === 'Escape') fragment.append(document.createTextNode(raw.slice(1)));
    else if (child.name === 'Entity') fragment.append(document.createTextNode(decodeText(raw)));
    else if (child.name === 'HardBreak') fragment.append(document.createElement('br'));
    position = child.to;
  }
  if (position < end) fragment.append(document.createTextNode(source.slice(position, end)));
  return fragment;
}

/** 链接、图片与自动链接共用目标校验；目标不安全时降级为纯文本标签。 */
function renderLinkish(node: SyntaxNode, source: string, references: LinkReferences): Node {
  if (node.name === 'URL') return renderAutoLink(source.slice(node.from, node.to));
  if (node.name === 'Autolink') {
    const url = node.getChild('URL');
    return renderAutoLink(url ? source.slice(url.from, url.to) : source.slice(node.from, node.to));
  }
  const opening = node.firstChild;
  let closing = opening?.nextSibling ?? null;
  while (closing && !(closing.name === 'LinkMark' && source.slice(closing.from, closing.to) === ']')) closing = closing.nextSibling;
  if (!opening || !closing) return document.createTextNode(source.slice(node.from, node.to));
  const label = renderInline(node, source, references, opening.to, closing.from);
  const destination = linkDestination(node, source, references, source.slice(opening.to, closing.from));
  if (node.name === 'Image') {
    const clean = safeImageUrl(destination);
    if (!clean) return label;
    const image = document.createElement('img');
    image.src = clean; image.alt = source.slice(opening.to, closing.from); image.loading = 'lazy';
    return image;
  }
  const clean = safeLinkUrl(destination);
  if (!clean) return label;
  const link = element('a', label);
  link.setAttribute('href', clean);
  // 面板统一代理点击并走系统外链通道；href 只提供地址与悬停提示。
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener noreferrer');
  return link;
}

/** 自动链接补全 www 与裸邮箱的协议；其余目标按原文走同一白名单。 */
function renderAutoLink(label: string): Node {
  const destination = /^www\./i.test(label) ? `http://${label}`
    : !/^[a-z][a-z\d+.-]*:/i.test(label) && /^[^\s@]+@[^\s@]+$/.test(label) ? `mailto:${label}` : label;
  const clean = safeLinkUrl(destination);
  if (!clean) return document.createTextNode(label);
  const link = element('a', document.createTextNode(label));
  link.setAttribute('href', clean);
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener noreferrer');
  return link;
}
