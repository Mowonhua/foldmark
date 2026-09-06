/**
 * 文件职责：从任务模型生成只读可见范围、搜索结果与折叠身份。
 * 定义范围：统一完成语义的视图投影与定位信息。
 */
import type { DocumentModel, HiddenRange, ListItem, TaskSearchResult } from './types';
import { afterLine } from './parse';

/** 按前序关系一次传播完成状态，普通列表祖先也参与父链连接。 */
function archivedItems(model: DocumentModel): Map<number, boolean> {
  const archived = new Map<number, boolean>();
  for (const item of model.items) archived.set(item.from, !!item.task?.checked || (item.parentFrom !== null && !!archived.get(item.parentFrom)));
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
 * 输出说明：待办隐藏完整已完成子树；归档保留祖先首行和相关章节。
 * 实现思路：待办取完成根；归档保留完成根和路径后计算补集。
 */
export function getHiddenRanges(model: DocumentModel, mode: 'todo' | 'archive' | 'source'): HiddenRange[] {
  if (mode === 'source') return [];
  const archived = archivedItems(model);
  const completedRoots = model.tasks.filter(item => item.task!.checked && (item.parentFrom === null || !archived.get(item.parentFrom)));
  if (mode === 'todo') return completedRoots.map(item => ({ from: item.moveFrom, to: item.moveTo, parentFrom: item.parentFrom, count: 1 }));
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
 * 输出说明：唯一内容返回完整内容键；重复内容返回空字符串默认展开。
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
