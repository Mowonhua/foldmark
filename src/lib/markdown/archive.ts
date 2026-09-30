/** 文件职责：以文本事务维护待办正文和文件末尾的归档章节。 */
import type { DocumentModel, ListItem, TextChange } from './types';
import { afterLine, lineStart, parseDocument } from './parse';
import { taskIsArchived, taskIsComplete } from './projection';

/** 所有坐标相对同一源文；headingTo 是标题及可选分区标记之后的正文起点。 */
export interface ArchiveSection { from: number; headingTo: number; to: number }

/** 有此标记的归档延伸至文件末尾或下一系统归档，兼容旧镜像中的一级标题，整理后只保留二级至六级路径。 */
const archiveMarker = '<!-- foldmark:archive -->';
type Heading = DocumentModel['headings'][number];

/**
 * 结构职责：保存根级标题划分的原文块，供任务在章节之间移动。
 * 字段说明：heading 为原标题，title 包含原始标题行及换行，body 为下一个标题前的正文；changed 标识插入造成的边界变化。
 * 约束条件：虚拟根的 heading 为空；children 按源文顺序排列，不含引用或列表内部标题。
 */
interface HeadingGroup { heading: Heading | null; title: string; body: string; children: HeadingGroup[]; changed?: boolean }

/**
 * 函数职责：取得文档直接子节点中的标题，排除任务正文和引用内标题。
 * 输入说明：模型及语法树来自同一快照。
 * 输出说明：返回按源文顺序排列的原标题对象。
 * 实现思路：以根节点的直接子节点坐标筛选共享标题模型。
 */
const rootHeadingCache = new WeakMap<DocumentModel, Heading[]>();
function rootHeadings(model: DocumentModel): Heading[] {
  const cached = rootHeadingCache.get(model);
  if (cached) return cached;
  const roots = new Set<number>();
  for (let node = model.tree.topNode.firstChild; node; node = node.nextSibling) {
    if (/^(ATX|Setext)Heading[1-6]$/.test(node.name)) roots.add(node.from);
  }
  const headings = model.headings.filter(heading => roots.has(heading.from));
  rootHeadingCache.set(model, headings);
  return headings;
}

/**
 * 函数职责：提取位置所属的完整标题路径。
 * 输入说明：from 为分区正文起点；position 为任务或标题的源文坐标。
 * 输出说明：路径只保留二级至六级标题的原级别与身份，不包含分区起点之前的标题。
 * 实现思路：按标题级别维护祖先栈；一级标题仍截断上一章节作用域，但不进入返回路径。
 */
function headingPath(model: DocumentModel, position: number, from = 0): Heading[] {
  const path: Heading[] = [];
  for (const heading of rootHeadings(model)) {
    if (heading.from < from) continue;
    if (heading.from >= position) break;
    while (path.length && path.at(-1)!.level >= heading.level) path.pop();
    path.push(heading);
  }
  return path.filter(heading => heading.level > 1);
}

/**
 * 函数职责：把一段源文按根级标题组织为保留原文的章节树。
 * 输入说明：text 为已扣除移动任务和系统归档标题的正文。
 * 输出说明：渲染未修改的树必须还原原文，标题内联格式及换行不变。
 * 实现思路：标题路径决定父节点，物理行区间决定正文归属。
 */
function headingGroups(text: string): HeadingGroup {
  const model = parseDocument(text);
  const root: HeadingGroup = { heading: null, title: '', body: '', children: [] };
  const stack = [root];
  let position = 0;
  for (const heading of rootHeadings(model)) {
    stack.at(-1)!.body += text.slice(position, lineStart(text, heading.from));
    while (stack.at(-1)!.heading && stack.at(-1)!.heading!.level >= heading.level) stack.pop();
    position = afterLine(text, heading.to);
    const group: HeadingGroup = { heading, title: text.slice(lineStart(text, heading.from), position), body: '', children: [] };
    stack.at(-1)!.children.push(group); stack.push(group);
  }
  stack.at(-1)!.body += text.slice(position);
  return root;
}

/**
 * 函数职责：在目标树中找到或镜像原标题路径并插入完整任务正文。
 * 输入说明：first 控制任务及新章节前插；created 在同批移动中按原标题坐标复用新节点。
 * 输出说明：只复用目标唯一且源路径无歧义的章节；重复路径生成独立章节。
 * 实现思路：逐层匹配标题文字与级别，缺失节点复制原标题原文；前插批次由调用方逆序遍历。
 */
const pathCountCache = new WeakMap<DocumentModel, Map<number, Map<string, number>>>();
function placeInHeadingGroup(root: HeadingGroup, path: Heading[], body: string, model: DocumentModel, first: boolean, created: Map<number, HeadingGroup>): void {
  const newline = model.text.includes('\r\n') ? '\r\n' : '\n';
  const sections = archiveSections(model);
  const section = path.length ? sections.find(section => path[0].from >= section.headingTo && path[0].from < section.to) : undefined;
  const floor = section?.headingTo ?? 0;
  const countsByPartition = pathCountCache.get(model) ?? new Map<number, Map<string, number>>();
  pathCountCache.set(model, countsByPartition);
  let counts = countsByPartition.get(floor);
  const identity = (headings: Heading[]): string => JSON.stringify(headings.map(heading => [heading.level, heading.text]));
  if (!counts) {
    counts = new Map();
    const stack: Heading[] = [];
    for (const heading of rootHeadings(model)) {
      if (section ? heading.from < floor || heading.from >= section.to : sections.some(section => heading.from >= section.from && heading.from < section.to)) continue;
      while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
      stack.push(heading);
      // 一级标题不参与路径身份，但仍重置栈；不同一级章节下的同名二级路径也属于歧义。
      if (heading.level === 1) continue;
      const key = identity(stack.filter(heading => heading.level > 1)); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    countsByPartition.set(floor, counts);
  }
  // 后代的插入可能改变祖先末端，必须把边界变化传播到整条路径，尤其是 EOF 无换行的恢复项。
  root.changed = true;
  let group = root;
  for (let index = 0; index < path.length; index++) {
    const heading = path[index];
    // 待办保留原有一级标题，恢复时穿透该层寻找二级章节，同时保留实际父节点以传播边界变化。
    const candidates = group.children.flatMap(child => child.heading!.level === 1
      ? child.children.map(entry => ({ entry, parent: child })) : [{ entry: child, parent: group }])
      .filter(({ entry }) => entry.heading!.level === heading.level && entry.heading!.text === heading.text);
    let target = created.get(heading.from);
    if (!target && counts.get(identity(path.slice(0, index + 1))) === 1 && candidates.length === 1) {
      target = candidates[0].entry; candidates[0].parent.changed = true;
    }
    if (!target) {
      const title = model.text.slice(lineStart(model.text, heading.from), afterLine(model.text, heading.to));
      target = { heading, title: title.endsWith('\n') ? title : title + newline, body: newline, children: [] };
      if (first) group.children.unshift(target); else group.children.push(target);
      group.changed = true;
    }
    created.set(heading.from, target); group = target; group.changed = true;
  }
  // 只在插入点整理空白块分隔；原有章节未被插入时，标题与正文逐字保留。
  if (first) {
    const leading = group.body.match(/^(?:[ \t]*\r?\n)*/)?.[0] ?? '';
    const existing = group.body.slice(leading.length);
    group.body = (path.length ? newline : leading) + body + (existing ? (body.endsWith('\n') ? '' : newline) + existing : '');
  } else {
    group.body = /^[\s]*$/.test(group.body) ? (path.length ? newline : '') + body : group.body + blockSeparator(group.body, body, newline) + body;
  }
  group.changed = true;
}

/** 只补足新旧独立块之间的换行；不删除代码、标题或正文已有字符。 */
function blockSeparator(left: string, right: string, newline: string): string {
  if (!left || !right || /\r?\n[ \t]*\r?\n$/.test(left)) return '';
  if (left.endsWith('\n')) return right.startsWith('\n') ? '' : newline;
  return right.startsWith('\n') ? newline : newline + newline;
}

/**
 * 函数职责：按章节顺序渲染原文，只在改动节点边界补足块分隔。
 * 输入说明：changed 标识插入任务或子章节的节点；newline 由整份文档确定，虚拟根为空时也不能回退换行风格。
 * 输出说明：未修改的树精确还原原文，改动边界不让标题与任务拼接。
 * 实现思路：递归拼接标题、直属正文和子章节。
 */
function renderHeadingGroups(group: HeadingGroup, newline: string): string {
  let result = group.title + group.body;
  let previousChanged = !!group.changed;
  for (const child of group.children) {
    const text = renderHeadingGroups(child, newline);
    result += (previousChanged || child.changed ? blockSeparator(result, text, newline) : '') + text;
    previousChanged = !!child.changed;
  }
  return result;
}

/** 只识别根级一级“归档”；旧格式在下一 H1 结束，带紧邻根级标记的格式保留正文原始标题层级。 */
export function archiveSections(model: DocumentModel): ArchiveSection[] {
  const comments = new Set<number>();
  for (let node = model.tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === 'CommentBlock') comments.add(node.from);
  }
  const headings = rootHeadings(model).filter(heading => heading.level === 1);
  return headings.flatMap((heading, index) => {
    if (heading.text !== '归档') return [];
    let headingTo = afterLine(model.text, heading.to);
    const markerTo = afterLine(model.text, headingTo);
    const marked = comments.has(headingTo) && model.text.slice(headingTo, markerTo).replace(/\r?\n$/, '') === archiveMarker;
    if (marked) headingTo = markerTo;
    const next = marked ? headings.slice(index + 1).find(heading => heading.text === '归档') : headings[index + 1];
    return [{ from: lineStart(model.text, heading.from), headingTo, to: next ? lineStart(model.text, next.from) : model.text.length }];
  });
}

/** 从一个原文区间扣除任意重叠删除范围，保留剩余字符的顺序和字节内容。 */
function without(text: string, from: number, to: number, removed: { from: number; to: number; insert?: string }[]): string {
  let position = from;
  let result = '';
  for (const range of [...removed].sort((a, b) => a.from - b.from)) {
    if (range.to <= position || range.from >= to) continue;
    result += text.slice(position, Math.max(position, range.from));
    if (range.from >= position) result += range.insert ?? '';
    position = Math.min(to, Math.max(position, range.to));
  }
  return result + text.slice(position, to);
}

/** 只移除实际存在的空白缩进，懒续行和代码内容不能因提升层级而丢字符。 */
function promote(text: string, item: ListItem, source: string): string {
  // 根列表节点可包含自身行首空白，实际标记列才能准确表示需移除的缩进。
  const prefix = source.slice(item.moveFrom, item.markerFrom);
  if (prefix.includes('>') || !prefix.length) return text;
  return text.replace(/^[ \t]+/gm, spaces => spaces.slice(Math.min(spaces.length, prefix.length)));
}

/**
 * 将完整完成的最外层任务树按原二级至六级标题路径前插到末尾归档；恢复时复用或重建路径。
 * 任务内部的同级列表稳定分为未完成、已完成；completedFrom 是本次新完成项的源文坐标，
 * 仅将这些项放到已完成同级前面，不记录时间，也不重排已有归档章节。
 * 普通列表桥接不截断任务祖先约束；正文、子树、缩进和换行风格随完整条目保留。
 * 返回相对输入快照的互不重叠事务；重复调用无变化，空归档标题仍保留。
 * 未闭合代码或 HTML 等语法会吞掉归档标题或任务时返回空事务，保留原文等待修正。
 */
export function normalizeArchiveChanges(model: DocumentModel, completedFrom: readonly number[] = []): TextChange[] {
  const sorted = sortCompletedChildren(model, new Set(completedFrom));
  if (sorted !== model.text) {
    const next = parseDocument(sorted);
    if (next.tasks.length !== model.tasks.length) return [];
    const result = normalizeArchiveChanges(next).reduceRight((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), sorted);
    return textDifference(model.text, result);
  }
  const sections = archiveSections(model);
  const byFrom = new Map(model.items.map(item => [item.from, item]));
  const completed = model.tasks.filter(item => taskIsArchived(model, item)
    && (item.parentFrom === null || !taskIsArchived(model, byFrom.get(item.parentFrom)!)));
  if (!sections.length && !completed.length) return [];
  const inArchive = (item: ListItem): boolean => sections.some(section => item.from >= section.headingTo && item.to <= section.to);
  const restored = model.tasks.filter(item => {
    if (!inArchive(item) || taskIsArchived(model, item)) return false;
    let parent = item.parentFrom;
    while (parent !== null) {
      const ancestor = byFrom.get(parent)!;
      if (ancestor.task && !taskIsArchived(model, ancestor)) return false;
      parent = ancestor.parentFrom;
    }
    return true;
  });
  const newline = model.text.includes('\r\n') ? '\r\n' : '\n';
  const range = (item: ListItem): { from: number; to: number; insert?: string } => {
    // 一行可同时含父级和子级列表标记；删除子项时保留父标记并结束它所在的行。
    const sharesParentLine = !/^[ \t>]*$/.test(model.text.slice(item.moveFrom, item.from));
    return { from: sharesParentLine ? item.from : item.moveFrom, to: item.moveTo, insert: sharesParentLine ? newline : '' };
  };
  const append = (left: string, right: string): string => !left ? right : !right ? left : left + (left.endsWith('\n') ? '' : newline) + right;
  let active = without(model.text, 0, model.text.length, [...sections, ...completed.filter(item => !inArchive(item)).map(range)]);
  const activeGroups = headingGroups(active);
  const restoredGroups = new Map<number, HeadingGroup>();
  let unheadedRestored = '';
  for (const item of restored) {
    const body = without(model.text, range(item).from, item.moveTo, completed.filter(child => child.from > item.from && child.to <= item.to).map(range));
    const section = sections.find(section => item.from >= section.headingTo && item.to <= section.to)!;
    const path = headingPath(model, item.moveFrom, section.headingTo);
    if (path.length) placeInHeadingGroup(activeGroups, path, promote(body, item, model.text), model, false, restoredGroups);
    else unheadedRestored = append(unheadedRestored, promote(body, item, model.text));
  }
  active = append(renderHeadingGroups(activeGroups, newline), unheadedRestored);
  const archivedGroups = headingGroups('');
  // 既有归档及备注保留源文顺序，新完成的完整根树随后前插到各自标题路径。
  for (const section of sections) {
    const rootIndent = model.items.filter(item => inArchive(item) && item.parentFrom === null && !restored.includes(item)).map(item => ({
      ...range(item), insert: promote(without(model.text, range(item).from, item.moveTo, restored.map(range)), item, model.text),
    }));
    // 既有归档根也统一到标记的根缩进，防止前插时异缩进根被解析为新项的子任务。
    const existing = headingGroups(without(model.text, section.headingTo, section.to, [...restored.map(range), ...rootIndent]));
    // 历史镜像只去掉根级一级标题，直属正文回到归档根；任务内部标题仍作为完整正文保留。
    const children: HeadingGroup[] = [];
    for (const child of existing.children) {
      if (child.heading!.level !== 1) { children.push(child); continue; }
      existing.body = append(existing.body, child.body);
      children.push(...child.children); existing.changed = true;
    }
    existing.children = children;
    // 分区的直属正文必须先合并到虚拟根，不能被前一分区末尾的子标题吸收。
    archivedGroups.body = append(archivedGroups.body, existing.body);
    archivedGroups.children.push(...existing.children);
    if (existing.changed || (sections.length > 1 && existing.children.length)) archivedGroups.changed = true;
  }
  const createdGroups = new Map<number, HeadingGroup>();
  // 前插按逆源序执行，保证同一次整理中的任务与新章节最终仍按源序排列。
  for (const item of [...completed].reverse()) {
    if (inArchive(item) && !restored.some(parent => item.from > parent.from && item.to <= parent.to)) continue;
    const section = sections.find(section => item.from >= section.headingTo && item.to <= section.to);
    const path = headingPath(model, range(item).from, section?.headingTo);
    placeInHeadingGroup(archivedGroups, path, promote(model.text.slice(range(item).from, item.moveTo), item, model.text), model, true, createdGroups);
  }
  // 去掉一级边界后，较深根标题不能跟在较浅根标题之后，否则重解析会把两条独立路径合并。
  // 只稳定排序归档顶层，二级开始的通常路径顺序及路径内部层级保持原样。
  const previousRoots = [...archivedGroups.children];
  archivedGroups.children.sort((left, right) => right.heading!.level - left.heading!.level);
  if (archivedGroups.children.some((group, index) => group !== previousRoots[index])) archivedGroups.changed = true;
  let archived = renderHeadingGroups(archivedGroups, newline);
  // 标记保留旧布局的分区兼容性；新镜像仅包含二级至六级标题，不改变原级别。
  const marked = archivedGroups.children.length > 0 || sections.some(section => model.text.slice(afterLine(model.text, section.from), section.headingTo).trim() === archiveMarker);
  // 章节必须与存活正文分成独立块，避免无末尾换行、列表或 Setext 语法吞掉新标题。
  if (active && !active.endsWith('\n')) active += newline;
  if (active && !/\r?\n[ \t]*\r?\n$/.test(active)) active += newline;
  if (archived && !/^\r?\n/.test(archived)) archived = newline + archived;
  const prefix = '# 归档' + newline + (marked ? archiveMarker + newline : '');
  const result = active + prefix + archived;
  if (result === model.text) return [];
  // 原文可能仍在输入未闭合围栏或 HTML；不能把真实任务搬进其内部变成普通文本。
  const candidate = parseDocument(result);
  const candidateSections = archiveSections(candidate);
  if (candidateSections.length !== 1 || candidateSections[0].from !== active.length
    || candidateSections[0].headingTo !== active.length + prefix.length || candidateSections[0].to !== result.length
    || candidate.tasks.length !== model.tasks.length) return [];
  // 缩小替换范围，使未受布局移动影响的前后文仍可由编辑器正常映射光标。
  return textDifference(model.text, result);
}

/** 缩小替换范围，让布局之外的光标和状态仍可由标准文本事务映射。 */
function textDifference(source: string, result: string): TextChange[] {
  if (source === result) return [];
  let from = 0;
  while (from < source.length && from < result.length && source[from] === result[from]) from++;
  let oldTo = source.length;
  let newTo = result.length;
  while (oldTo > from && newTo > from && source[oldTo - 1] === result[newTo - 1]) { oldTo--; newTo--; }
  return [{ from, to: oldTo, insert: result.slice(from, newTo) }];
}

/**
 * 按同父级同列表重排任务内部条目，递归先处理后代；不跨列表、引用或普通正文移动。
 * 已勾但仍有未完成后代的条目留在未完成组，保证后代仍可操作。
 * 无可靠独立物理行的列表保持原样；没有动作坐标时保留已完成项既有顺序。
 */
function sortCompletedChildren(model: DocumentModel, recent: ReadonlySet<number>): string {
  const groups = new Map<number | null, Map<number, ListItem[]>>();
  const withinTask = new Map<number, boolean>();
  for (const item of model.items) {
    withinTask.set(item.from, !!item.task || (item.parentFrom !== null && !!withinTask.get(item.parentFrom)));
    const lists = groups.get(item.parentFrom) ?? new Map<number, ListItem[]>();
    const siblings = lists.get(item.listFrom) ?? [];
    siblings.push(item); lists.set(item.listFrom, siblings); groups.set(item.parentFrom, lists);
  }
  const completed = (item: ListItem): boolean => taskIsComplete(model, item);
  const render = (from: number, to: number, parent: number | null): string => {
    let result = ''; let position = from;
    for (const siblings of groups.get(parent)?.values() ?? []) {
      // 同行列表标记不能移走父级标记；保留其结构，避免移动范围越过父正文。
      if (siblings.some(item => item.moveFrom < from || !/^[ \t>]*$/.test(model.text.slice(item.moveFrom, item.from)))) continue;
      const parts = new Map(siblings.map(item => [item.from, render(item.moveFrom, item.moveTo, item.from)]));
      const order = parent !== null && withinTask.get(parent) ? [...siblings].sort((a, b) =>
        Number(completed(a)) - Number(completed(b)) || (completed(a) ? Number(recent.has(b.from)) - Number(recent.has(a.from)) : 0)) : siblings;
      result += model.text.slice(position, siblings[0].moveFrom);
      for (let index = 0; index < order.length; index++) {
        let part = parts.get(order[index].from)!;
        // 原来的末项可能没有行分隔，移到列表内部时必须补齐，防止相邻标题拼接。
        if (index < order.length - 1 && !part.endsWith('\n')) part += model.text.includes('\r\n') ? '\r\n' : '\n';
        result += part;
      }
      position = siblings.at(-1)!.moveTo;
    }
    return result + model.text.slice(position, to);
  };
  return render(0, model.text.length, null);
}
