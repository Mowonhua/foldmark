/**
 * 文件职责：为受限的任务首行普通文字编辑增量映射列表模型。
 * 定义范围：严格资格判断、旧投影坐标映射和新语法树绑定；不推断 Markdown 新结构。
 */
import type { ChangeSet } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { DocumentModel, ListItem, TextChange } from '../markdown';

const ordinaryText = /^[\p{L}\p{N} ]*$/u;
const excludedContexts = new Set(['InlineCode','FencedCode','CodeBlock','MathBlock','InlineMath','InlineMathUnclosed']);

/** 任务按源位置排序；只检查最近的前置任务，避免把正文或后续普通列表误当任务首行。 */
function taskAtContent(model: DocumentModel, from: number, to: number): ListItem | null {
  let low = 0; let high = model.tasks.length;
  while (low < high) { const middle = (low+high) >>> 1; if (model.tasks[middle].from <= from) low = middle+1; else high = middle; }
  const item = model.tasks[low-1];
  return item && from >= item.contentFrom && to <= item.firstLineTo ? item : null;
}
/** 检查编辑端点的祖先，不让行内代码或公式因恰好只改字母而进入快路径。 */
function excludedContext(tree: Tree, position: number, side: -1 | 1): boolean {
  for (let node: SyntaxNode | null = tree.resolveInner(position,side); node; node = node.parent) if (excludedContexts.has(node.name)) return true;
  return false;
}
/** 从标记位置获取确切列表项；不能用可能位于下一节点边界的正文末端定位。 */
function listItemAt(tree: Tree, markerFrom: number): SyntaxNode | null {
  let node: SyntaxNode | null = tree.resolveInner(markerFrom,1);
  while (node && node.name !== 'ListItem') node = node.parent;
  return node;
}
/**
 * 函数职责：核验新树中受影响列表项及所有容器的身份与范围。
 * 输入说明：文字规则已排除所有可创建 Markdown 结构的字符与换行。
 * 输出说明：任何新旧祖先差异都拒绝快路径，由完整解析重新建立关系。
 * 实现思路：仅沿两个局部祖先链比较节点类型和映射后的边界，不扫描兄弟或子树。
 */
function unchangedContainers(model: DocumentModel, item: ListItem, changes: ChangeSet, nextTree: Tree): boolean {
  const oldItem = listItemAt(model.tree,item.markerFrom);
  const nextItem = listItemAt(nextTree,changes.mapPos(item.markerFrom,1));
  if (!oldItem || !nextItem || !nextItem.getChild('Task')?.getChild('TaskMarker')) return false;
  let previous: SyntaxNode | null = oldItem;
  let next: SyntaxNode | null = nextItem;
  while (previous && next) {
    if (previous.name !== next.name || changes.mapPos(previous.from,1) !== next.from || changes.mapPos(previous.to,1) !== next.to) return false;
    previous = previous.parent; next = next.parent;
  }
  return previous === null && next === null;
}
/**
 * 函数职责：在能证明列表结构不变时复用旧模型，避免遍历新树的全部节点。
 * 输入说明：changes 对应 previous.text，nextText 与 nextTree 来自同一次完整编辑器状态。
 * 输出说明：仅单个任务首行内容内 Unicode 字母、数字或普通空格的替换可返回新模型；其余返回 null，由调用方完整解析。
 * 实现思路：禁止换行、结构标记和代码/公式内容，核验新树中目标列表项及祖先边界，再映射全部坐标并重算受影响内容起点。
 */
export function tryMapTaskTextEdit(previous: DocumentModel, changes: ChangeSet, nextText: string, nextTree: Tree): DocumentModel | null {
  if (changes.empty || changes.length !== previous.text.length || changes.newLength !== nextText.length || nextTree.length !== nextText.length) return null;
  const edits: TextChange[] = [];
  changes.iterChanges((from,to,_nextFrom,_nextTo,insert)=>edits.push({ from,to,insert:insert.toString() }),true);
  if (edits.length !== 1) return null;
  const edit = edits[0];
  if (!ordinaryText.test(edit.insert) || !ordinaryText.test(previous.text.slice(edit.from,edit.to))) return null;
  const target = taskAtContent(previous,edit.from,edit.to);
  if (!target) return null;
  if (excludedContext(previous.tree,edit.from,1) || excludedContext(previous.tree,edit.to,-1)) return null;
  if (!unchangedContainers(previous,target,changes,nextTree)) return null;

  const delta = nextText.length-previous.text.length;
  const map = (position: number): number => changes.mapPos(position,1);
  const items: ListItem[] = [];
  const tasks: ListItem[] = [];
  for (const item of previous.items) {
    // 模型是只读投影；未移动的对象可以共享，但绝不原地修改旧模型。
    let mapped = item;
    if (item === target || (delta !== 0 && Math.max(item.to,item.moveTo,item.listTo,item.firstLineTo) >= edit.from)) {
      mapped = {
        ...item,
        from: map(item.from), to: map(item.to), firstLineTo: map(item.firstLineTo),
        markerFrom: map(item.markerFrom), markerTo: map(item.markerTo), contentFrom: map(item.contentFrom),
        moveFrom: map(item.moveFrom), moveTo: map(item.moveTo),
        parentFrom: item.parentFrom === null ? null : map(item.parentFrom),
        listFrom: map(item.listFrom), listTo: map(item.listTo),
        children: item.children.length ? item.children.map(map) : item.children,
        task: item.task ? { checked:item.task.checked, from:map(item.task.from), to:map(item.task.to) } : null,
      };
      if (item === target) {
        // 插入前导空格或删除全部正文会改变 contentFrom，不能只作位置映射。
        const leading = nextText.slice(mapped.task!.to,mapped.firstLineTo).search(/[^ \t]/);
        mapped.contentFrom = leading < 0 ? mapped.firstLineTo : mapped.task!.to+leading;
      }
    }
    items.push(mapped); if (mapped.task) tasks.push(mapped);
  }
  const headings = delta ? previous.headings.map(heading=>({ ...heading,from:map(heading.from),to:map(heading.to) })) : previous.headings;
  return { text:nextText,tree:nextTree,items,tasks,headings };
}
