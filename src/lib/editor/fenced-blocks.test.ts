/** 文件职责：验证代码与公式共享边界及空闭块激活，不依赖浏览器布局。 */
import { expect, it } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { markdownExtensions } from '../markdown';
import { documentField } from './state';
import { activateFencedBlock, fencedBlocks } from './fenced-blocks';
import { paragraphLayout } from './paragraphs';

function state(source: string, readOnly = false) {
  return EditorState.create({ doc: source, extensions: [markdown({ extensions: markdownExtensions }), documentField, EditorState.readOnly.of(readOnly)] });
}
function view(source: string, readOnly = false) {
  const target = { state: state(source, readOnly), focused: false,
    dispatch(...specs: TransactionSpec[]) { this.state = this.state.update(...specs).state; },
    focus() { this.focused = true; },
  };
  return { target, view: target as unknown as EditorView };
}

it.each(['```\n```', '$$\n$$'])('空闭块首次激活补正文行，第二次只定位：%j', source => {
  const instance = view(source);
  expect(fencedBlocks(instance.target.state)[0]).toMatchObject({ closed: true, hasBody: false });
  expect(activateFencedBlock(instance.view, 0)).toBe(true);
  const delimiter = source.split('\n')[0];
  expect(instance.target.state.doc.toString()).toBe(delimiter + '\n\n' + delimiter + '\n\n');
  expect(instance.target.state.selection.main.head).toBe(delimiter.length + 1);
  expect(fencedBlocks(instance.target.state)[0]).toMatchObject({ closed: true, hasBody: true, bodyFrom: delimiter.length + 1, bodyTo: delimiter.length + 1 });
  expect(activateFencedBlock(instance.view, 0)).toBe(true);
  expect(instance.target.state.doc.toString()).toBe(delimiter + '\n\n' + delimiter + '\n\n');
  expect(paragraphLayout(instance.target.state).paragraphs.at(-1)).toMatchObject({ kind: 'empty', contentFrom: instance.target.state.doc.length });
  expect(instance.target.focused).toBe(true);
});
it.each(['```\n\n```', '$$\n\n$$'])('已有空正文行不额外插入：%j', source => {
  const instance = view(source);
  expect(activateFencedBlock(instance.view, 0)).toBe(true);
  expect(instance.target.state.doc.toString()).toBe(source);
});
it.each(['$$x^2$$', '$$$$', '$$ x $$'])('单行公式激活只定位正文：%j', source => {
  const instance = view(source), block = fencedBlocks(instance.target.state)[0];
  expect(block).toMatchObject({ kind: 'math', closed: true, hasBody: true, bodyFrom: 2, bodyTo: source.length - 2 });
  expect(block.marks).toEqual([{ from: 0, to: 2, wholeLine: false }, { from: source.length - 2, to: source.length, wholeLine: false }]);
  expect(activateFencedBlock(instance.view, 0)).toBe(true);
  expect(instance.target.state.doc.toString()).toBe(source);
  expect(instance.target.state.selection.main.head).toBe(2);
});
it.each(['```js\ncode', '$$\nx^2'])('未闭合但已有正文可以直接定位：%j', source => {
  const instance = view(source), block = fencedBlocks(instance.target.state)[0];
  expect(block).toMatchObject({ closed: false, hasBody: true, bodyFrom: source.indexOf('\n') + 1, bodyTo: source.length });
  expect(block.marks).toHaveLength(1);
  expect(activateFencedBlock(instance.view, 0)).toBe(true);
  expect(instance.target.state.doc.toString()).toBe(source);
});
it.each(['```', '$$'])('单独开围栏不由点击行为补闭合：%j', source => {
  const instance = view(source);
  expect(activateFencedBlock(instance.view, 0)).toBe(false);
  expect(instance.target.state.doc.toString()).toBe(source);
});
it('列表中独立围栏包含结构缩进，正文额外缩进仍保留', () => {
  const source = '- [ ] A\n\n  ~~~~ts\n      code\n  ~~~~';
  const block = fencedBlocks(state(source))[0];
  expect(block).toMatchObject({ kind: 'code', nodeFrom: source.indexOf('~~~~'), from: source.indexOf('  ~~~~'), indent: '  ', delimiter: '~~~~', closed: true, hasBody: true });
  expect(source.slice(block.bodyFrom, block.bodyTo)).toBe('    code');
  expect(block.marks.every(mark => mark.wholeLine)).toBe(true);
});
it('同行列表标记保留，激活只复制结构缩进', () => {
  const source = '- ```\n  ```';
  const instance = view(source), block = fencedBlocks(instance.target.state)[0];
  expect(block).toMatchObject({ nodeFrom: 2, from: 2, indent: '  ', hasBody: false });
  expect(block.marks[0]).toEqual({ from: 2, to: 5, wholeLine: false });
  expect(activateFencedBlock(instance.view, 2)).toBe(true);
  expect(instance.target.state.doc.toString()).toBe('- ```\n  \n  ```\n\n  ');
  expect(instance.target.state.selection.main.head).toBe(8);
  const exit = paragraphLayout(instance.target.state).paragraphs.at(-1)!;
  expect(exit).toMatchObject({ kind: 'empty', indent: '  ', contentFrom: instance.target.state.doc.length });
});
it('公式开行已有正文时仅隐藏美元标记，保留该行正文', () => {
  const source = '$$x\ny\n$$';
  const block = fencedBlocks(state(source))[0];
  expect(block).toMatchObject({ bodyFrom: 2, bodyTo: 5, closed: true, hasBody: true });
  expect(block.marks[0]).toEqual({ from: 0, to: 2, wholeLine: false });
});
it('缓存随文档快照复用，普通缩进代码不被补认成围栏', () => {
  const value = state('```\nx\n```\n\n    ```');
  expect(fencedBlocks(value)).toHaveLength(1);
  expect(fencedBlocks(value.update({ selection: { anchor: 4 } }).state)).toBe(fencedBlocks(value));
});
it('只读及失效节点激活不修改状态', () => {
  const instance = view('$$\n$$', true);
  expect(activateFencedBlock(instance.view, 0)).toBe(false);
  expect(instance.target.focused).toBe(false);
  expect(activateFencedBlock(view('正文').view, 0)).toBe(false);
});
