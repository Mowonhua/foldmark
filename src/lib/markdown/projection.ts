/**
 * 文件职责：从任务模型生成只读可见范围、搜索结果与折叠身份。
 * 定义范围：统一完成语义的视图投影与定位信息。
 */
import type { DocumentModel, HiddenRange, ListItem, TaskSearchResult } from './types';
import { afterLine } from './parse';
import { archiveSections } from './archive';

const archiveStates = new WeakMap<DocumentModel, Map<number, boolean>>();
const completionStates = new WeakMap<DocumentModel, Map<number, boolean>>();
const completedGroupCache = new WeakMap<DocumentModel, HiddenRange[]>();
/**
 * 函数职责：提取任务树内部可整体收起的连续已完成同级子树。
 * 输入说明：模型来自同一 Markdown 快照；普通列表桥接不截断任务祖先关系。
 * 输出说明：范围包含完整物理行，parentFrom 指向直接父项，count 包含组内全部任务后代。
 * 实现思路：按父项及原列表汇聚完整完成子树，不跨正文或不同列表合并。
 */
export function completedChildGroups(model: DocumentModel): HiddenRange[] {
  const cached = completedGroupCache.get(model);
  if (cached) return cached;
  const withinTask = new Map<number, boolean>();
  const counts = new Map<number, number>();
  for (const item of [...model.items].reverse()) counts.set(item.from, Number(!!item.task) + item.children.reduce((count, from) => count + (counts.get(from) ?? 0), 0));
  const groups: (HiddenRange & { listFrom: number })[] = [];
  const lastGroups = new Map<string, typeof groups[number]>();
  for (const item of model.items) {
    const nested = item.parentFrom !== null && !!withinTask.get(item.parentFrom);
    withinTask.set(item.from, nested || !!item.task);
    if (!nested || !taskIsComplete(model, item) || !/^[ \t>]*$/.test(model.text.slice(item.moveFrom, item.from))) continue;
    const identity = `${item.parentFrom}:${item.listFrom}`;
    const previous = lastGroups.get(identity);
    if (previous && previous.parentFrom === item.parentFrom && previous.listFrom === item.listFrom && previous.to === item.moveFrom) {
      previous.to = item.moveTo; previous.count += counts.get(item.from)!;
    } else {
      const group = { from: item.moveFrom, to: item.moveTo, parentFrom: item.parentFrom, count: counts.get(item.from)!, listFrom: item.listFrom };
      groups.push(group); lastGroups.set(identity, group);
    }
  }
  // 外层完成子树已经包含其后代计数，不能再把内部完成组重复装饰为第二个摘要。
  const result: HiddenRange[] = [];
  for (const group of groups.sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (result.at(-1) && result.at(-1)!.from <= group.from && result.at(-1)!.to >= group.to) continue;
    result.push({ from: group.from, to: group.to, parentFrom: group.parentFrom, count: group.count });
  }
  completedGroupCache.set(model, result);
  return result;
}
/** 一次逆序传播未完成后代，完成状态与归档状态分开缓存，供排序和自动折叠共享。 */
function completedItems(model: DocumentModel): Map<number, boolean> {
  const cached = completionStates.get(model);
  if (cached) return cached;
  const incomplete = new Set<number>();
  const completed = new Map<number, boolean>();
  for (let index = model.items.length - 1; index >= 0; index--) {
    const item = model.items[index];
    if (item.task && !item.task.checked) incomplete.add(item.from);
    completed.set(item.from, !!item.task?.checked && !incomplete.has(item.from));
    if (incomplete.has(item.from) && item.parentFrom !== null) incomplete.add(item.parentFrom);
  }
  completionStates.set(model, completed);
  return completed;
}
/** 只有最外层任务及全部任务后代完成才归档；普通列表容器不截断任务祖先链。 */
function archivedItems(model: DocumentModel): Map<number, boolean> {
  const cached = archiveStates.get(model);
  if (cached) return cached;
  const completed = completedItems(model);
  const archived = new Map<number, boolean>();
  const taskAncestors = new Map<number, boolean>();
  for (const item of model.items) {
    const hasTaskAncestor = item.parentFrom !== null && !!taskAncestors.get(item.parentFrom);
    archived.set(item.from, (!hasTaskAncestor && !!completed.get(item.from)) || (item.parentFrom !== null && !!archived.get(item.parentFrom)));
    taskAncestors.set(item.from, hasTaskAncestor || !!item.task);
  }
  archiveStates.set(model, archived);
  return archived;
}
/** 合并已排序的重叠范围，避免编辑器收到重叠的替换装饰。 */
function mergeRanges(ranges: HiddenRange[]): HiddenRange[] {
  const merged: HiddenRange[] = [];
  for (const range of ranges.sort((a,b)=>a.from-b.from || b.to-a.to)) {
    if (range.from >= range.to) continue;
    const previous = merged.at(-1);
    if (previous && range.from < previous.to) { previous.to = Math.max(previous.to, range.to); previous.count += range.count; }
    else merged.push({ ...range });
  }
  return merged;
}
/**
 * 函数职责：生成待办及归档模式的隐藏范围。
 * 输入说明：源码模式始终可见，任务范围必须来自共享模型。
 * 输出说明：待办保留尚未整体完成的任务树；归档保留完整完成根及相关章节。
 * 实现思路：待办取完成根；归档保留完成根和路径后计算补集。
 */
export function getHiddenRanges(model: DocumentModel, mode: 'todo' | 'archive' | 'source'): HiddenRange[] {
  if (mode === 'source') return [];
  const archived = archivedItems(model);
  const completedRoots = model.tasks.filter(item => archived.get(item.from) && (item.parentFrom === null || !archived.get(item.parentFrom)));
  if (mode === 'todo') return mergeRanges([
    ...completedRoots.map(item => ({ from: item.moveFrom, to: item.moveTo, parentFrom: item.parentFrom, count: 1 })),
    // 已整理的归档章节整体隐藏，包括备注；尚未整理的未完成任务仍须可达。
    ...archiveSections(model).map(section => ({
      from: section.from,
      to: model.tasks.some(item => item.from >= section.headingTo && item.to <= section.to && !archived.get(item.from)) ? section.headingTo : section.to,
      parentFrom: null, count: 0,
    })),
  ]);
  const byFrom = new Map(model.items.map(item => [item.from,item]));
  const visible: HiddenRange[] = [];
  const keep = (from: number, to: number): void => { visible.push({ from, to, parentFrom: null, count: 0 }); };
  for (const item of completedRoots) {
    keep(item.moveFrom, item.moveTo);
    let parentFrom = item.parentFrom;
    while (parentFrom !== null) {
      const parent = byFrom.get(parentFrom)!; keep(parent.moveFrom, afterLine(model.text,parent.firstLineTo)); parentFrom = parent.parentFrom;
    }
    // 保留章节层级路径，而非展示与归档无关的整份文档标题。
    let level = 7;
    for (let index = model.headings.length - 1; index >= 0; index--) {
      const heading = model.headings[index];
      if (heading.from < item.from && heading.level < level) { keep(heading.from, afterLine(model.text,heading.to)); level = heading.level; }
    }
  }
  const hidden: HiddenRange[] = [];
  let position = 0;
  for (const range of mergeRanges(visible)) {
    if (position < range.from) hidden.push({ from: position, to: range.from, parentFrom: null, count: 0 });
    position = range.to;
  }
  if (position < model.text.length) hidden.push({ from: position, to: model.text.length, parentFrom: null, count: 0 });
  return hidden;
}
/**
 * 函数职责：按统一完成语义检索任务标题与正文。
 * 输入说明：词项按空白拆分并且全部匹配，空查询返回范围内全部任务。
 * 输出说明：提供原文定位、标题、摘要与所属最近章节。
 * 实现思路：前序传播归档状态，读取任务所属源文并提取展示信息。
 */
export function searchTasks(model: DocumentModel, query: string, includeArchived = false): TaskSearchResult[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const archived = archivedItems(model);
  const results: TaskSearchResult[] = [];
  // 子任务有独立搜索结果，不能通过父项正文把隐藏任务带回待办搜索。
  const nested = new Map<number, ListItem[]>();
  const ancestors: ListItem[] = [];
  for (const task of model.tasks) {
    while (ancestors.length && task.from >= ancestors.at(-1)!.to) ancestors.pop();
    const parent = ancestors.at(-1);
    if (parent) { const children = nested.get(parent.from) ?? []; children.push(task); nested.set(parent.from, children); }
    ancestors.push(task);
  }
  let headingIndex = -1;
  for (const item of model.tasks) {
    while (headingIndex + 1 < model.headings.length && model.headings[headingIndex + 1].from < item.from) headingIndex++;
    const isArchived = !!archived.get(item.from);
    if (!includeArchived && isArchived) continue;
    let body = '';
    let position = item.contentFrom;
    for (const child of nested.get(item.from) ?? []) {
      body += model.text.slice(position, Math.max(position, child.moveFrom));
      position = child.moveTo;
    }
    body += model.text.slice(Math.min(position, item.to), item.to);
    const normalized = body.toLocaleLowerCase();
    if (!terms.every(term => normalized.includes(term))) continue;
    results.push({ item, from: item.from, to: item.to, title: model.text.slice(item.contentFrom,item.firstLineTo), excerpt: body.replace(/\s+/g,' ').slice(0,200), heading: model.headings[headingIndex]?.text ?? '', archived: isArchived });
  }
  return results;
}
const foldIdentities = new WeakMap<DocumentModel, Map<string, number>>();
/**
 * 函数职责：提供不依赖位置的可靠折叠恢复身份。
 * 输入说明：只匹配全文相同且在文档内唯一的列表项。
 * 输出说明：唯一内容返回完整内容键；重复内容返回空字符串，不单独持久化其折叠身份。
 * 实现思路：按文档快照缓存内容计数，不使用可能碰撞的短哈希。
 */
export function foldKey(model: DocumentModel, item: ListItem): string {
  let counts = foldIdentities.get(model);
  if (!counts) {
    counts = new Map();
    for (const entry of model.items) { const content=model.text.slice(entry.from,entry.to); counts.set(content,(counts.get(content)??0)+1); }
    foldIdentities.set(model, counts);
  }
  const content = model.text.slice(item.from,item.to);
  return counts.get(content) === 1 ? `item:${content}` : '';
}
/**
 * 函数职责：判断条目是否属于可整体归档的已完成子树。
 * 输入说明：item 来自同一模型；普通列表容器仍继承任务祖先约束。
 * 输出说明：只有最外层任务全部完成时，其完整子树才属于归档。
 * 实现思路：自底向上标记未完成后代，按前序跟踪任务祖先并传播归档状态。
 */
export function taskIsArchived(model: DocumentModel, item: ListItem): boolean { return archivedItems(model).get(item.from) ?? false; }

/** 条目已勾选且全部任务后代已完成；未完成祖先只影响归档归属，不影响条目自身完成。 */
export function taskIsComplete(model: DocumentModel, item: ListItem): boolean { return completedItems(model).get(item.from) ?? false; }
