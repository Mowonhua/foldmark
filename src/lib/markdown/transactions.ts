/**
 * 文件职责：将任务状态和列表结构操作转换为单次文本事务。
 * 定义范围：完成恢复、同级移动、位置映射和整体缩进。
 */
import type { DocumentModel, ListItem, TextChange } from './types';
import { lineStart } from './parse';

/** 返回指定列表项；无效或过期位置必须拒绝，避免误改相邻源文。 */
function requireItem(model: DocumentModel, from: number): ListItem {
  const item = model.items.find(item => item.from === from);
  if (!item) throw new Error('ITEM_NOT_FOUND'); return item;
}
/**
 * 函数职责：生成完成、整组完成或恢复的状态字符替换。
 * 输入说明：存在未完成后代时，完成父项要求 completeGroup=true。
 * 输出说明：全部更改相对旧快照且互不重叠，恢复包含所有已完成祖先。
 * 实现思路：限定子树任务集合，恢复时沿父链回溯。
 */
export function taskToggleChanges(model: DocumentModel, itemFrom: number, completeGroup = false): TextChange[] {
  const item = requireItem(model, itemFrom);
  if (!item.task) throw new Error('NOT_A_TASK');
  const checked = !item.task.checked;
  const descendants = model.tasks.filter(task => task.from > item.from && task.to <= item.to);
  if (checked && !completeGroup && descendants.some(task => !task.task!.checked)) throw new Error('TASK_GROUP_REQUIRED');
  const targets = [item];
  if (checked && completeGroup) targets.push(...descendants.filter(task => !task.task!.checked));
  if (!checked) {
    const byFrom = new Map(model.items.map(entry => [entry.from, entry]));
    let parent = item.parentFrom;
    while (parent !== null) {
      const ancestor = byFrom.get(parent)!;
      if (ancestor.task?.checked) targets.push(ancestor);
      parent = ancestor.parentFrom;
    }
  }
  return targets.map(target => ({ from: target.task!.from + 1, to: target.task!.from + 2, insert: checked ? 'x' : ' ' })).sort((a,b)=>a.from-b.from);
}
/** 校验同列表同父级落点，返回未删除源项之前的插入位置。 */
function moveTarget(model: DocumentModel, source: ListItem, beforeFrom: number | null): number {
  const siblings = model.items.filter(item => item.listFrom === source.listFrom && item.parentFrom === source.parentFrom);
  // 同一物理行内的嵌套列表无法独立搬移，必须先通过正常输入建立独立行。
  if (source.from !== source.moveFrom && model.text.slice(source.moveFrom, source.from).trim()) throw new Error('INVALID_MOVE');
  if (beforeFrom === null) return siblings.at(-1)!.moveTo;
  const target = siblings.find(item => item.from === beforeFrom);
  if (!target || model.text.slice(target.moveFrom, target.from).trim()) throw new Error('INVALID_MOVE');
  return target.moveFrom;
}
/**
 * 函数职责：移动完整列表项且保持其它字符原样。
 * 输入说明：beforeFrom 为相同父级、同列表目标，null 表示列表末尾。
 * 输出说明：删除与插入组成一笔事务；无变化返回空数组。
 * 实现思路：移动物理行范围，仅在文件末尾缺少换行时补足结构分隔。
 */
export function moveItemChanges(model: DocumentModel, sourceFrom: number, beforeFrom: number | null): TextChange[] {
  const source = requireItem(model, sourceFrom);
  const target = moveTarget(model, source, beforeFrom);
  if (target === source.moveFrom || target === source.moveTo) return [];
  const newline = model.text.includes('\r\n') ? '\r\n' : '\n';
  let insert = model.text.slice(source.moveFrom, source.moveTo);
  if (!insert.endsWith('\n')) insert += newline;
  // 松散列表末项没有后续分隔；移到列表内部时需补回已有的空行语义。
  const loose = model.items.some(item => item.listFrom === source.listFrom && /\r?\n[ \t]*\r?\n/.test(model.text.slice(item.to, item.moveTo)));
  if (loose && !/\r?\n[ \t]*\r?\n$/.test(insert)) insert += newline;
  // 目标可位于没有末尾换行的文档末端，此时先结束存活条目的最后一行。
  if (target > 0 && model.text[target - 1] !== '\n') insert = newline + insert;
  return [{ from: source.moveFrom, to: source.moveTo, insert: '' }, { from: target, to: target, insert }].sort((a,b)=>a.from-b.from);
}
/**
 * 函数职责：映射排序条目内部的光标与后代折叠位置。
 * 输入说明：需与 moveItemChanges 使用相同参数，范围外位置交给编辑器事务映射。
 * 输出说明：返回保留条目内相对偏移的新位置。
 * 实现思路：计算删除引起的插入偏移及文件末尾额外分隔。
 */
export function moveItemPosition(model: DocumentModel, sourceFrom: number, beforeFrom: number | null, position: number): number {
  const source = requireItem(model, sourceFrom);
  if (position < source.moveFrom || position > source.moveTo) return position;
  const target = moveTarget(model, source, beforeFrom);
  if (target === source.moveFrom || target === source.moveTo) return position;
  const prefix = target > 0 && model.text[target - 1] !== '\n' ? (model.text.includes('\r\n') ? 2 : 1) : 0;
  return target - (target > source.moveFrom ? source.moveTo - source.moveFrom : 0) + prefix + position - source.moveFrom;
}
/**
 * 函数职责：整体缩进或反缩进列表项，包括代码与隐藏后代。
 * 输入说明：缩进需要前一同级项；顶层或无法可靠反缩进时返回空事务。
 * 输出说明：返回互不重叠的行首更改，不重新编号或改写正文。
 * 实现思路：使用承接项标记宽度确定目标缩进，按完整物理行调整。
 */
export function indentItemChanges(model: DocumentModel, itemFrom: number, direction: 1 | -1): TextChange[] {
  const item = requireItem(model, itemFrom);
  const siblings = model.items.filter(entry => entry.listFrom === item.listFrom && entry.parentFrom === item.parentFrom);
  const previous = siblings[siblings.indexOf(item) - 1];
  if (direction === 1 && !previous) return [];
  if (direction === -1 && item.parentFrom === null) return [];
  if (model.text.slice(item.moveFrom, item.from).trim()) return [];
  const parent = direction === -1 ? requireItem(model, item.parentFrom!) : previous;
  const parentColumn = parent.from - lineStart(model.text, parent.from);
  const currentColumn = item.from - item.moveFrom;
  const amount = direction === 1 ? parent.markerTo - parent.markerFrom + 1 : currentColumn - parentColumn;
  if (amount <= 0) return [];
  const changes: TextChange[] = [];
  for (let start = item.moveFrom; start < item.moveTo;) {
    const end = model.text.indexOf('\n', start);
    const lineTo = end < 0 ? model.text.length : end;
    if (model.text.slice(start, lineTo).trim()) {
      if (direction === 1) changes.push({ from: start, to: start, insert: ' '.repeat(amount) });
      else {
        const spaces = model.text.slice(start, lineTo).match(/^ */)![0].length;
        // 懒续行可能没有预期缩进，禁止为了反缩进删除正文字符。
        changes.push({ from: start, to: start + Math.min(amount, spaces), insert: '' });
      }
    }
    if (end < 0) break; start = end + 1;
  }
  return changes;
}
