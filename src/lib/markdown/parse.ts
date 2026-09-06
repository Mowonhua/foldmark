/**
 * 文件职责：从共享 Markdown 语法树构建列表关系模型。
 * 定义范围：语法解析、源文坐标及父子关系。
 */
import { parser } from '@lezer/markdown';
import type { Tree } from '@lezer/common';
import type { DocumentModel, ListItem } from './types';
import { markdownExtensions } from './syntax';
const sharedParser = parser.configure(markdownExtensions);

/** 返回包含 position 的物理行起点；所有位置均为 UTF-16 偏移。 */
export function lineStart(text: string, position: number): number { return text.lastIndexOf('\n', position - 1) + 1; }
/** 返回行内容末端，排除 CRLF 的两个字符。 */
export function lineEnd(text: string, position: number): number {
  const lf = text.indexOf('\n', position);
  const end = lf < 0 ? text.length : lf;
  return end > 0 && text[end - 1] === '\r' ? end - 1 : end;
}
/** 返回当前行分隔符之后的位置；文件末尾无需存在换行。 */
export function afterLine(text: string, position: number): number {
  const lf = text.indexOf('\n', position); return lf < 0 ? text.length : lf + 1;
}
/**
 * 函数职责：从与编辑器一致的语法树提取列表及任务模型。
 * 输入说明：外部树必须对应相同文本；没有提供时调用共享解析器。
 * 输出说明：保留节点和物理行坐标，tasks 与 items 共享对象。
 * 实现思路：单次深度遍历建立父子关系，再按同列表相邻项确定移动分隔。
 */
export function parseDocument(text: string, tree?: Tree): DocumentModel {
  const syntax = tree ?? sharedParser.parse(text);
  const model: DocumentModel = { text, tree: syntax, items: [], tasks: [], headings: [] };
  const parents: ListItem[] = [];
  const listLast = new Map<number, ListItem>();
  syntax.iterate({
    enter(node) {
      if (node.name === 'ListItem') {
        const list = node.node.parent!;
        const marker = node.node.getChild('ListMark')!;
        const taskMarker = node.node.getChild('Task')?.getChild('TaskMarker');
        const content = taskMarker?.to ?? marker.to;
        const firstLineTo = lineEnd(text, node.from);
        let contentFrom = content;
        while (contentFrom < firstLineTo && /[ \t]/.test(text[contentFrom])) contentFrom++;
        const item: ListItem = {
          from: node.from, to: node.to, firstLineTo, markerFrom: marker.from, markerTo: marker.to,
          contentFrom, moveFrom: lineStart(text, node.from), moveTo: afterLine(text, node.to),
          parentFrom: parents.at(-1)?.from ?? null, listFrom: list.from, listTo: list.to, depth: parents.length,
          task: taskMarker ? { from: taskMarker.from, to: taskMarker.to, checked: text[taskMarker.from + 1].toLowerCase() === 'x' } : null,
          children: [],
        };
        parents.at(-1)?.children.push(item.from);
        const previous = listLast.get(item.listFrom);
        if (previous) previous.moveTo = item.moveFrom;
        listLast.set(item.listFrom, item);
        model.items.push(item); if (item.task) model.tasks.push(item); parents.push(item);
      }
      if (/^(ATX|Setext)Heading[1-6]$/.test(node.name)) {
        const marks = node.node.getChildren('HeaderMark');
        const start = marks[0]?.from === node.from ? marks[0].to : node.from;
        const end = marks.at(-1)?.from !== node.from ? marks.at(-1)?.from ?? node.to : node.to;
        model.headings.push({ from: node.from, to: node.to, level: Number(node.name.at(-1)), text: text.slice(start, end).trim() });
      }
    },
    leave(node) { if (node.name === 'ListItem') parents.pop(); },
  });
  return model;
}
