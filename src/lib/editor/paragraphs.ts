/**
 * 文件职责：定义预览段落、空段落及源码分隔的共同模型。
 * 定义范围：段落投影、源码位置查询和局部段落替换计划。
 */
import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { DocumentModel, ListItem } from '../markdown';
import { documentField, softBreaksField } from './state';

/**
 * 结构职责：表示一个可见段落或保持原生编辑的语法块。
 * 字段说明：from/to 不包含外部分隔；contentFrom 跳过容器标记或缩进；item 是所属列表项。
 * 约束条件：empty 也是一个独立段落；literal 内部空行不得解释成段落分隔，所有坐标使用内部 LF。
 */
export interface Paragraph {
  from: number;
  to: number;
  contentFrom: number;
  kind: 'text' | 'list' | 'empty' | 'literal';
  item: ListItem | null;
  indent: string;
}

/**
 * 结构职责：表示相邻可见段落之间的一行源码空白分隔。
 * 字段说明：from/to 包含分隔两侧换行；blankTo 是绘制替换末端，保留后一换行显示段落边界。
 * 约束条件：分隔与段落互不重叠，连续空白按“段落、分隔、段落”解码，结果与光标和视口无关。
 */
export interface ParagraphSeparator { from: number; to: number; blankTo: number }

/**
 * 结构职责：表示编辑器创建的段内换行。
 * 字段说明：from 指向 LF；to 越过 LF 和下一行的容器结构缩进。
 * 约束条件：用户额外缩进不包含在范围内；没有正文的续行也属于原段落，字面块内不产生此范围。
 */
export interface ParagraphLineBreak { from: number; to: number }

/**
 * 结构职责：提供同一源文的段落及分隔快照。
 * 字段说明：paragraphs、separators 和 lineBreaks 均按位置排序；紧凑列表可没有源码空行边界。
 * 约束条件：读取不改写源文；A\n\nB 是两段，A\n\n\n\nB 是中间含空段落的三段。
 */
export interface ParagraphLayout {
  paragraphs: readonly Paragraph[];
  separators: readonly ParagraphSeparator[];
  lineBreaks: readonly ParagraphLineBreak[];
}

/**
 * 函数职责：为投影、导航和编辑提供共享段落模型。
 * 输入说明：状态已挂载 documentField；模式、选区和视口不影响段落身份。
 * 输出说明：返回按文档快照缓存的只读模型，不产生事务或 IO。
 * 实现思路：语法树界定正文与字面块，源码补充空段落，编辑状态保留尚无正文的段内续行。
 */
const emptyBreaks: readonly number[] = [];
const layouts = new WeakMap<DocumentModel, { breaks: readonly number[]; layout: ParagraphLayout }>();
export function paragraphLayout(state: EditorState): ParagraphLayout {
  const model = state.field(documentField);
  const softBreaks = state.field(softBreaksField, false) ?? emptyBreaks;
  const cached = layouts.get(model);
  if (cached?.breaks === softBreaks) return cached.layout;
  const { doc } = state;
  const blocks = new Map<number, { last: number; literal: boolean }>();
  model.tree.iterate({ enter(node) {
    const literal = /^(FencedCode|CodeBlock|MathBlock|Table|Blockquote|HTMLBlock|HorizontalRule|LinkReference|ATXHeading[1-6]|SetextHeading[12])$/.test(node.name);
    if (!literal && node.name !== 'Paragraph' && node.name !== 'Task') return;
    const first = doc.lineAt(node.from).number;
    const last = doc.lineAt(node.to).number;
    blocks.set(first, { last, literal });
    // 字面块内部的段落、引用和空行不参与外层段落解码。
    return false;
  } });
  const headers = new Map<number, ListItem>();
  for (const item of model.items) headers.set(item.moveFrom, item);
  const paragraphs: Paragraph[] = [];
  const separators: ParagraphSeparator[] = [];
  const lineBreaks: ParagraphLineBreak[] = [];
  const positions = new Set(softBreaks);
  const explicitBreak = (number: number): boolean => {
    if (number >= doc.lines) return false;
    // 编辑时产生的续行不得吞并后来输入的独立标题、代码或列表项。
    return positions.has(doc.line(number).to) && !blocks.get(number + 1)?.literal && !headers.has(doc.line(number + 1).from);
  };
  const owners: ListItem[] = [];
  let itemIndex = 0;
  let needsParagraph = true;
  for (let number = 1; number <= doc.lines;) {
    const line = doc.line(number);
    // AST 不把尾部空白纳入列表范围；空行仍可沿缩进承载该列表的待输入正文。
    // 直到遇到真实的外部正文或新条目才放弃容器，避免输入首字时横向位置发生变化。
    while (owners.length && owners.at(-1)!.moveTo <= line.from && line.text.trim()) owners.pop();
    while (itemIndex < model.items.length && model.items[itemIndex].from <= line.to) {
      const item = model.items[itemIndex++];
      while (owners.length && owners.at(-1)!.to < item.from) owners.pop();
      owners.push(item);
    }
    const block = blocks.get(number);
    const whitespace = line.text.match(/^[ \t]*/)?.[0] ?? '';
    const blank = !line.text.trim();
    // 分隔之后必须先产生一个段落；该段落即使没有文字，也占据自己的物理行。
    // 单个终止换行不是完整分隔，因此文末空行仍作为一个可编辑段落保留。
    if (blank && !block?.literal && !needsParagraph && number < doc.lines) {
      separators.push({ from: paragraphs.at(-1)!.to, to: line.to + 1, blankTo: line.to });
      needsParagraph = true;
      number++;
      continue;
    }
    const header = headers.get(line.from);
    let item: ListItem | null = header ?? null;
    if (!item) {
      for (let index = owners.length - 1; index >= 0; index--) {
        const candidate = owners[index];
        const column = candidate.markerTo - candidate.moveFrom + 1;
        if ((!blank && candidate.to >= line.to) || (blank && whitespace.length >= column)) { item = candidate; break; }
      }
    }
    const kind: Paragraph['kind'] = block?.literal ? 'literal' : header ? 'list' : blank ? 'empty' : 'text';
    let last = block?.last ?? number;
    // 列表标题与后续正文具有不同键盘契约；正文中的软换行继续共用一个语法段落。
    if (header && !block?.literal && last > number && !explicitBreak(number)) {
      blocks.set(number + 1, { last, literal: false });
      last = number;
    }
    const indent = item ? ' '.repeat(item.markerTo - item.moveFrom + 1) : whitespace;
    if (!block?.literal) {
      for (let current = number; current <= last; current++) {
        if (!explicitBreak(current)) continue;
        const continuation = doc.line(current + 1);
        // AST 不表达待输入的空软行；编辑状态将它纳入原段落，后面的分隔继续独立解码。
        last = Math.max(last, current + 1, blocks.get(current + 1)?.last ?? current + 1);
        const structuralColumn = item ? indent.length : 0;
        let prefix = 0; let column = 0;
        while (prefix < continuation.text.length && column < structuralColumn) {
          const character = continuation.text[prefix];
          if (character !== ' ' && character !== '\t') break;
          const nextColumn = character === '\t' ? column + 4 - column % 4 : column + 1;
          // 一个 Tab 同时覆盖结构缩进和额外缩进时不能拆字符，保留它供用户直接编辑。
          if (nextColumn > structuralColumn) break;
          column = nextColumn;
          prefix++;
        }
        lineBreaks.push({ from: doc.line(current).to, to: continuation.from + prefix });
      }
    }
    // GFM 对缺少尾空格的空任务可能只生成普通列表；编辑正文起点仍须越过完整复选框。
    const emptyMarker = kind === 'list' && !item!.task
      ? /^[ \t]+\[ \][ \t]*$/.exec(doc.sliceString(item!.markerTo, line.to)) : null;
    paragraphs.push({
      from: line.from, to: doc.line(last).to,
      contentFrom: kind === 'list' ? emptyMarker ? line.to : item!.contentFrom : line.from + whitespace.length,
      kind, item, indent,
    });
    needsParagraph = false;
    number = last + 1;
  }
  const result = { paragraphs, separators, lineBreaks };
  layouts.set(model, { breaks: softBreaks, layout: result });
  return result;
}

/**
 * 函数职责：查询源码位置所在段落。
 * 输入说明：位置可位于段落末端；纯分隔内部不属于段落。
 * 输出说明：返回 paragraphs 下标，分隔内部返回 -1。
 * 实现思路：对有序段落起点二分后检查完整范围。
 */
export function paragraphAt(layout: ParagraphLayout, position: number): number {
  let low = 0; let high = layout.paragraphs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (layout.paragraphs[middle].from <= position) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  return index >= 0 && position <= layout.paragraphs[index].to ? index : -1;
}

/**
 * 函数职责：替换连续段落并统一维护相邻的一行分隔空行。
 * 输入说明：first/last 包含端点；last=first-1 表示在 first 前插入，不替换已有段落。
 * replacement=[] 删除段落，[''] 保留或插入一个空段落。
 * 输出说明：caret 数字相对替换内容以双换行连接后的偏移；before 回前段末尾，after 到后段内容起点。
 * 约束条件：没有替换内容时数字零按 before 处理；没有前段或后段时分别落在文首或文末。
 * 实现思路：仅重写选中段落和最近两侧分隔，不吞掉相邻空段落；文首文末不增加外围分隔。
 */
export function replaceParagraphs(state: EditorState, first: number, last: number, replacement: readonly string[], caret: number | 'before' | 'after', userEvent: string): TransactionSpec {
  const { paragraphs } = paragraphLayout(state);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || first > paragraphs.length || last < first - 1 || last >= paragraphs.length) throw new RangeError('无效的段落替换范围');
  const before = paragraphs[first - 1];
  const after = paragraphs[last + 1];
  const from = before?.to ?? 0;
  const to = after?.from ?? state.doc.length;
  const body = replacement.join('\n\n');
  if (typeof caret === 'number' && (!Number.isInteger(caret) || caret < 0 || caret > body.length)) throw new RangeError('光标超出替换段落范围');
  const prefix = before && replacement.length ? '\n\n' : '';
  const suffix = after && replacement.length ? '\n\n' : '';
  const insert = replacement.length ? prefix + body + suffix : before && after ? '\n\n' : '';
  const delta = insert.length - (to - from);
  const anchor = caret === 'after' ? after ? after.contentFrom + delta : state.doc.length + delta
    : caret === 'before' || !replacement.length ? before?.to ?? 0 : from + prefix.length + caret;
  // 边界参与序列化，但相同源文不需要进入改动范围；尤其不能让邻接隐藏分隔触发写保护。
  const original = state.doc.sliceString(from, to);
  let commonStart = 0;
  while (commonStart < original.length && commonStart < insert.length && original[commonStart] === insert[commonStart]) commonStart++;
  let commonEnd = 0;
  while (commonEnd < original.length - commonStart && commonEnd < insert.length - commonStart
    && original[original.length - commonEnd - 1] === insert[insert.length - commonEnd - 1]) commonEnd++;
  return {
    changes: { from: from + commonStart, to: to - commonEnd, insert: insert.slice(commonStart, insert.length - commonEnd) },
    selection: { anchor }, userEvent, scrollIntoView: true,
  };
}
