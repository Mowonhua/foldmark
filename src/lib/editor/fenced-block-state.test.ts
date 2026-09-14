/** 文件职责：验证围栏确认之前的会话草稿身份、坐标映射与历史恢复。 */
import { expect, it } from 'vitest';
import { Compartment, EditorState } from '@codemirror/state';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { markdownExtensions } from '../markdown';
import { documentField, modeFacet } from './state';
import { confirmFencedBlock, draftFencedBlockHistory, draftFencedBlocksField } from './fenced-block-state';

function state(source: string, mode: 'todo' | 'source' = 'todo') {
  return EditorState.create({ doc: source, extensions: [markdown({ extensions: markdownExtensions }), documentField,
    modeFacet.of(mode), draftFencedBlocksField, history(), draftFencedBlockHistory] });
}
function type(value: EditorState, position: number, text: string) {
  return value.update({ changes: { from: position, insert: text }, selection: { anchor: position + text.length }, userEvent: 'input.type', annotations: isolateHistory.of('full') }).state;
}

it.each(['```', '$$'])('todo 逐字键入 %s 成为草稿，加载同源文则不是草稿', marker => {
  let value = state('');
  for (const character of marker) value = type(value, value.doc.length, character);
  expect(value.field(draftFencedBlocksField)).toEqual([0]);
  expect(state(value.doc.toString()).field(draftFencedBlocksField)).toEqual([]);
});
it.each([['```', 'typescript'], ['$$', 'x+y$$']])('草稿 %s 继续输入语言或正文保留身份', (marker, text) => {
  const value = type(state(''), 0, marker);
  expect(type(value, value.doc.length, text).field(draftFencedBlocksField)).toEqual([0]);
});
it.each(['```', '$$'])('源码键入和粘贴 %s 不生成草稿', marker => {
  expect(type(state('', 'source'), 0, marker).field(draftFencedBlocksField)).toEqual([]);
  expect(state('').update({ changes: { from: 0, insert: marker }, selection: { anchor: marker.length }, userEvent: 'input.paste' }).state.field(draftFencedBlocksField)).toEqual([]);
});
it('已有代码块修改语言与正文不重新成为草稿', () => {
  const value = state('```\nbody\n```');
  expect(type(value, 3, 'ts').field(draftFencedBlocksField)).toEqual([]);
  expect(type(value, 4, 'x').field(draftFencedBlocksField)).toEqual([]);
});
it('确认 effect 使用修改完成后的节点起点', () => {
  const value = type(state(''), 0, '```');
  const next = value.update({ changes: [{ from: 0, insert: '\n' }, { from: 3, insert: '\n\n```' }], effects: confirmFencedBlock.of(1) }).state;
  expect(next.doc.toString()).toBe('\n```\n\n```');
  expect(next.field(draftFencedBlocksField)).toEqual([]);
});
it('普通前方插入映射草稿，删除标记和全文替换清理身份', () => {
  const value = type(state('前\n\n'), 3, '```');
  expect(value.field(draftFencedBlocksField)).toEqual([3]);
  expect(value.update({ changes: { from: 0, insert: '新增' } }).state.field(draftFencedBlocksField)).toEqual([5]);
  expect(value.update({ changes: { from: 5, to: 6 } }).state.field(draftFencedBlocksField)).toEqual([]);
  expect(value.update({ changes: { from: 0, to: value.doc.length, insert: '```\nbody\n```' } }).state.field(draftFencedBlocksField)).toEqual([]);
});
it('输入围栏时光标已到正文行，不登记开行草稿', () => {
  const value = type(state(''), 0, '```\nbody');
  expect(value.field(draftFencedBlocksField)).toEqual([]);
});
it('列表内开头记录真实语法节点起点，不记录行缩进', () => {
  const value = type(state('- [ ] A\n  '), 10, '```');
  expect(value.field(draftFencedBlocksField)).toEqual([10]);
});
it('确认和删除的 undo/redo 恢复对应草稿身份', () => {
  let value = type(state(''), 0, '$$');
  value = value.update({ changes: { from: 2, insert: '\n\n$$' }, selection: { anchor: 3 }, effects: confirmFencedBlock.of(0), userEvent: 'input', annotations: isolateHistory.of('full') }).state;
  expect(value.field(draftFencedBlocksField)).toEqual([]);
  expect(undo({ state: value, dispatch: transaction => { value = transaction.state; } })).toBe(true);
  expect(value.doc.toString()).toBe('$$');
  expect(value.field(draftFencedBlocksField)).toEqual([0]);
  expect(redo({ state: value, dispatch: transaction => { value = transaction.state; } })).toBe(true);
  expect(value.field(draftFencedBlocksField)).toEqual([]);
  expect(undo({ state: value, dispatch: transaction => { value = transaction.state; } })).toBe(true);
  value = value.update({ changes: { from: 1, to: 2 }, userEvent: 'delete', annotations: isolateHistory.of('full') }).state;
  expect(value.field(draftFencedBlocksField)).toEqual([]);
  expect(undo({ state: value, dispatch: transaction => { value = transaction.state; } })).toBe(true);
  expect(value.field(draftFencedBlocksField)).toEqual([0]);
});
it('源码来回切换保留草稿且不改写源文', () => {
  const mode = new Compartment();
  let value = EditorState.create({ doc: '', extensions: [markdown({ extensions: markdownExtensions }), documentField, draftFencedBlocksField, mode.of(modeFacet.of('todo'))] });
  value = type(value, 0, '```');
  const original = value.field(draftFencedBlocksField);
  value = value.update({ effects: mode.reconfigure(modeFacet.of('source')) }).state;
  expect(value.field(draftFencedBlocksField)).toBe(original);
  value = value.update({ effects: mode.reconfigure(modeFacet.of('todo')) }).state;
  expect(value.field(draftFencedBlocksField)).toBe(original);
  expect(value.doc.toString()).toBe('```');
});
