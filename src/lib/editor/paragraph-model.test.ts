/** 文件职责：验证共享段落解码、边界和局部序列化契约。 */
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { markdownExtensions } from '../markdown';
import { documentField, softBreaksField, setSoftBreaks } from './state';
import { paragraphAt, paragraphLayout, replaceParagraphs } from './paragraphs';

function state(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [markdown({ extensions: markdownExtensions }), documentField, softBreaksField] });
}
function contents(value: EditorState): string[] {
  return paragraphLayout(value).paragraphs.map(paragraph => value.doc.sliceString(paragraph.from, paragraph.to));
}

describe('共享段落解码', () => {
  it.each([
    ['A\n\nB', ['A', 'B']],
    ['A\n\n\n\nB', ['A', '', 'B']],
    ['A\n\n\n\n\n\nB', ['A', '', '', 'B']],
    ['A\n\n', ['A', '']],
    ['\n\nB', ['', 'B']],
    ['', ['']],
    ['A\n', ['A', '']],
    ['A\n\n\nB', ['A', '', 'B']],
  ])('无损解码 %j', (source, expected) => {
    const value = state(source as string);
    expect(contents(value)).toEqual(expected);
    expect(value.doc.toString()).toBe(source);
  });
  it('分隔包含两个换行，绘制仅替换到后换行之前', () => {
    const layout = paragraphLayout(state('A\n  \nB'));
    expect(layout.separators).toEqual([{ from: 1, to: 5, blankTo: 4 }]);
    expect(paragraphAt(layout, 1)).toBe(0);
    expect(paragraphAt(layout, 3)).toBe(-1);
    expect(paragraphAt(layout, 5)).toBe(1);
  });
  it('选区变化复用文档模型，正文软换行不拆成独立段落', () => {
    const value = state('A\nsoft\n\nB');
    expect(contents(value)).toEqual(['A\nsoft', 'B']);
    expect(paragraphLayout(value.update({ selection: { anchor: 2 } }).state)).toBe(paragraphLayout(value));
  });
  it.each(['```md\nA\n\nB\n```', '    A\n\n    B', '$$\nA\n\nB\n$$', '> A\n>\n> B', '| A |\n| - |\n| B |'])('字面块内部空行保持原样：%j', source => {
    const value = state(source);
    const layout = paragraphLayout(value);
    expect(contents(value)).toEqual([source]);
    expect(layout.paragraphs[0].kind).toBe('literal');
    expect(layout.separators).toEqual([]);
  });
  it('紧列表首行独立，后续正文软行共用段落并保留所属任务', () => {
    const value = state('- [ ] A\n  body\n  soft\n- [ ] B');
    const layout = paragraphLayout(value);
    expect(contents(value)).toEqual(['- [ ] A', '  body\n  soft', '- [ ] B']);
    expect(layout.paragraphs.map(paragraph => paragraph.kind)).toEqual(['list', 'text', 'list']);
    expect(layout.paragraphs[1].item).toBe(layout.paragraphs[0].item);
    expect(layout.paragraphs[1].indent).toBe('  ');
    expect(layout.separators).toEqual([]);
  });
  it('嵌套标题与正文选择最近所属项，空正文按内容缩进归属', () => {
    const value = state('- [ ] 父\n  - [ ] 子\n\n    \n\n    正文\n- [ ] 后');
    const paragraphs = paragraphLayout(value).paragraphs;
    expect(paragraphs.map(paragraph => paragraph.kind)).toEqual(['list', 'list', 'empty', 'text', 'list']);
    expect(paragraphs[2].item).toBe(paragraphs[1].item);
    expect(paragraphs[3].item).toBe(paragraphs[1].item);
    expect(paragraphs[2].indent).toBe('    ');
    expect(paragraphs[1].indent).toBe('    ');
  });
  it('缺少尾空格的空任务仍把内容起点放在复选框之后', () => {
    const paragraph = paragraphLayout(state('- [ ]')).paragraphs[0];
    expect(paragraph.contentFrom).toBe(5);
    expect(paragraph.indent).toBe('  ');
  });
});

describe('共同段落序列化', () => {
  it('删除与空段落替换有不同语义', () => {
    const value = state('A\n\nX\n\nB');
    expect(value.update(replaceParagraphs(value, 1, 1, [], 0, 'delete')).newDoc.toString()).toBe('A\n\nB');
    expect(value.update(replaceParagraphs(value, 1, 1, [''], 0, 'input')).newDoc.toString()).toBe('A\n\n\n\nB');
  });
  it('删除空段落不吞掉相邻空段落', () => {
    const value = state('A\n\n\n\n\n\nB');
    const next = value.update(replaceParagraphs(value, 1, 1, [], 'before', 'delete')).state;
    expect(next.doc.toString()).toBe('A\n\n\n\nB');
    expect(contents(next)).toEqual(['A', '', 'B']);
    expect(next.selection.main.head).toBe(1);
  });
  it.each([
    [0, 0, [''], '\n\nB'],
    [1, 1, [''], 'A\n\n'],
    [0, 0, [], 'B'],
    [1, 1, [], 'A'],
    [0, 1, [], ''],
  ])('文首文末不增加外围分隔：%i..%i', (first, last, replacement, expected) => {
    const value = state('A\n\nB');
    const next = value.update(replaceParagraphs(value, first as number, last as number, replacement as string[], 0, 'input')).state;
    expect(next.doc.toString()).toBe(expected);
    expect(paragraphLayout(next).paragraphs.length).toBeGreaterThan(0);
  });
  it('after 到下一任务内容起点，before 到上一段末尾', () => {
    const value = state('A\n\nX\n\n- [ ] 后');
    const after = value.update(replaceParagraphs(value, 1, 1, [], 'after', 'delete')).state;
    expect(after.doc.toString()).toBe('A\n\n- [ ] 后');
    expect(after.selection.main.head).toBe(after.doc.length - 1);
  });
  it('插入拆分只规范触及边界，数字光标相对替换内容', () => {
    const value = state('- [ ] A\n- [ ] B\n- [ ] C\n- [ ] D');
    const next = value.update(replaceParagraphs(value, 1, 1, ['- [ ] B', '  body'], 11, 'input')).state;
    expect(next.doc.toString()).toBe('- [ ] A\n\n- [ ] B\n\n  body\n\n- [ ] C\n- [ ] D');
    expect(next.selection.main.head).toBe(next.doc.toString().indexOf('body'));
  });
  it('完整序列化后重新解码保留各段落，包括首尾空段落', () => {
    const value = state('原文');
    const expected = ['', 'A', '', 'B', ''];
    const next = value.update(replaceParagraphs(value, 0, 0, expected, 0, 'input')).state;
    expect(contents(state(next.doc.toString()))).toEqual(expected);
  });
  it('未变化的相邻分隔不进入事务改动范围', () => {
    const value = state('前\n\n旧\n\n后');
    const transaction = value.update(replaceParagraphs(value, 1, 1, ['新'], 1, 'input'));
    const ranges: number[][] = [];
    transaction.changes.iterChangedRanges((from, to) => ranges.push([from, to]));
    expect(ranges).toEqual([[3, 4]]);
    expect(transaction.newSelection.main.head).toBe(4);
  });
});
describe('纯换行的编辑状态', () => {
  it.each([
    { source: 'A\n\n\nB', breaks: [1], expected: ['A\n', 'B'] },
    { source: 'A\n\n\n\nB', breaks: [1, 2], expected: ['A\n\n', 'B'] },
    { source: '- [ ] A\n  \n\n- [ ] B', breaks: [7], expected: ['- [ ] A\n  ', '- [ ] B'] },
  ])('空续行依赖编辑意图且不添加源码标记：$source', ({ source, breaks, expected }) => {
    const value = state(source).update({ effects: setSoftBreaks.of(breaks) }).state;
    expect(contents(value)).toEqual(expected);
    expect(value.doc.toString()).toBe(source);
    for (const lineBreak of paragraphLayout(value).lineBreaks) expect(paragraphAt(paragraphLayout(value), lineBreak.to)).toBeGreaterThanOrEqual(0);
  });
  it('相同源码的续行状态改变时不能复用旧分隔缓存', () => {
    const original = state('A\n\n\nB');
    expect(contents(original)).toEqual(['A', '', 'B']);
    const changed = original.update({ effects: setSoftBreaks.of([1]) }).state;
    expect(contents(changed)).toEqual(['A\n', 'B']);
    expect(contents(changed.update({ effects: setSoftBreaks.of([]) }).state)).toEqual(['A', '', 'B']);
  });
  it('源码中已有反斜杠不被误认成编辑器换行标记', () => {
    expect(paragraphLayout(state('A\\\n\n\nB')).lineBreaks).toEqual([]);
  });
});
