/** 文件职责：以文本事务维护待办正文和文件末尾的归档章节。 */
import type { DocumentModel, ListItem, TextChange } from './types';
import { afterLine, lineStart, parseDocument } from './parse';
import { taskIsArchived, taskIsComplete } from './projection';

/** 所有坐标相对同一源文；标题和正文区间均包含各自末尾换行。 */
export interface ArchiveSection { from: number; headingTo: number; to: number }

/** 只识别文档根节点的一级“归档”标题，章节在下一根级一级标题前结束。 */
export function archiveSections(model: DocumentModel): ArchiveSection[] {
  const roots = new Set<number>();
  for (let node = model.tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === 'ATXHeading1' || node.name === 'SetextHeading1') roots.add(node.from);
  }
  const headings = model.headings.filter(heading => roots.has(heading.from));
  return headings.flatMap((heading, index) => heading.text === '归档' ? [{
    from: lineStart(model.text, heading.from),
    headingTo: afterLine(model.text, heading.to),
    to: headings[index + 1] ? lineStart(model.text, headings[index + 1].from) : model.text.length,
  }] : []);
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
 * 将完整完成的最外层任务树前插到唯一末尾归档章节，未完成树整体恢复到归档前。
 * 任务内部的同级列表稳定分为未完成、已完成；completedFrom 是本次新完成项的源文坐标，
 * 仅将这些项放到已完成同级前面，不记录时间，也不重排已有归档根。
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
  for (const item of restored) {
    const body = without(model.text, range(item).from, item.moveTo, completed.filter(child => child.from > item.from && child.to <= item.to).map(range));
    active = append(active, promote(body, item, model.text));
  }
  let archived = '';
  for (const item of completed) {
    if (inArchive(item) && !restored.some(parent => item.from > parent.from && item.to <= parent.to)) continue;
    archived = append(archived, promote(model.text.slice(range(item).from, item.moveTo), item, model.text));
  }
  // 新完成的完整根树占据归档顶部；既有归档及备注保留源文顺序。
  for (const section of sections) {
    const rootIndent = model.items.filter(item => inArchive(item) && item.parentFrom === null && !restored.includes(item)).map(item => ({
      ...range(item), insert: promote(without(model.text, range(item).from, item.moveTo, restored.map(range)), item, model.text),
    }));
    // 既有归档根也统一到标记的根缩进，防止前插时异缩进根被解析为新项的子任务。
    archived = append(archived, without(model.text, section.headingTo, section.to, [...restored.map(range), ...rootIndent]));
  }
  // 章节必须与存活正文分成独立块，避免无末尾换行、列表或 Setext 语法吞掉新标题。
  if (active && !active.endsWith('\n')) active += newline;
  if (active && !/\r?\n[ \t]*\r?\n$/.test(active)) active += newline;
  if (archived && !/^\r?\n/.test(archived)) archived = newline + archived;
  const result = active + '# 归档' + newline + archived;
  if (result === model.text) return [];
  // 原文可能仍在输入未闭合围栏或 HTML；不能把真实任务搬进其内部变成普通文本。
  const candidate = parseDocument(result);
  const candidateSections = archiveSections(candidate);
  if (candidateSections.length !== 1 || candidateSections[0].from !== active.length || candidate.tasks.length !== model.tasks.length) return [];
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
