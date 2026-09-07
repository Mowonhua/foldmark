/** 文件职责：以文本事务维护待办正文和文件末尾的归档章节。 */
import type { DocumentModel, ListItem, TextChange } from './types';
import { afterLine, lineStart, parseDocument } from './parse';
import { taskIsArchived } from './projection';

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
  const prefix = source.slice(item.moveFrom, item.from);
  if (prefix.includes('>') || !prefix.length) return text;
  return text.replace(/^[ \t]+/gm, spaces => spaces.slice(Math.min(spaces.length, prefix.length)));
}

/**
 * 将真正完成的任务子树移入唯一末尾归档章节，未完成子树恢复到归档前。
 * 已完成嵌套项提升到顶层，正文相对缩进和换行风格保持；其余文本不改写。
 * 返回相对输入快照的互不重叠事务；重复调用无变化，空归档标题仍保留。
 * 未闭合代码或 HTML 等语法会吞掉归档标题或任务时返回空事务，保留原文等待修正。
 */
export function normalizeArchiveChanges(model: DocumentModel): TextChange[] {
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
  for (const section of sections) archived = append(archived, without(model.text, section.headingTo, section.to, restored.map(range)));
  for (const item of completed) {
    if (inArchive(item) && !restored.some(parent => item.from > parent.from && item.to <= parent.to)) continue;
    archived = append(archived, promote(model.text.slice(range(item).from, item.moveTo), item, model.text));
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
  let from = 0;
  while (from < model.text.length && from < result.length && model.text[from] === result[from]) from++;
  let oldTo = model.text.length;
  let newTo = result.length;
  while (oldTo > from && newTo > from && model.text[oldTo - 1] === result[newTo - 1]) { oldTo--; newTo--; }
  return [{ from, to: oldTo, insert: result.slice(from, newTo) }];
}
