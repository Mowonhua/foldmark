/** 文件职责：验证会话内段内换行身份的映射、历史和外部替换边界。 */
import { expect, it } from 'vitest';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { history, redo, undo } from '@codemirror/commands';
import { modeFacet, setSoftBreaks, softBreakHistory, softBreaksField } from './state';

function state(source: string, positions: readonly number[] = []): EditorState {
  const value = EditorState.create({ doc: source, extensions: [softBreaksField, history(), softBreakHistory] });
  return value.update({ effects: setSoftBreaks.of(positions), annotations: Transaction.addToHistory.of(false) }).state;
}

it('身份 effect 使用修改后的 LF 坐标，并过滤无效位置和重复项', () => {
  const value = state('AB').update({ changes: { from: 1, insert: '\n\n' }, effects: setSoftBreaks.of([2, 1, 1, -1, 0, 99, 1.5]) }).state;
  expect(value.doc.toString()).toBe('A\n\nB');
  expect(value.field(softBreaksField)).toEqual([1, 2]);
});
it('在 LF 前插入内容向右映射，在 LF 后插入内容保持身份位置', () => {
  const value = state('A\nB', [1]);
  expect(value.update({ changes: { from: 1, insert: '前' } }).state.field(softBreaksField)).toEqual([2]);
  expect(value.update({ changes: { from: 2, insert: '后' } }).state.field(softBreaksField)).toEqual([1]);
});
it('删除 LF 不把身份转交给紧邻的另一个 LF', () => {
  const value = state('A\n\nB', [1]);
  expect(value.update({ changes: { from: 1, to: 2 } }).state.field(softBreaksField)).toEqual([]);
});
it('删除前一个换行后正确映射仍存活的后一个换行', () => {
  const value = state('A\n\nB', [2]);
  expect(value.update({ changes: { from: 1, to: 2 } }).state.field(softBreaksField)).toEqual([1]);
});
it('替换原换行即使插入另一个 LF 也不继承旧身份', () => {
  const value = state('A\nB', [1]);
  expect(value.update({ changes: { from: 1, to: 2, insert: '\n' } }).state.field(softBreaksField)).toEqual([]);
});
it('全文替换清理会话身份，但不写入任何源码标记', () => {
  const value = state('A\nB', [1]).update({ changes: { from: 0, to: 3, insert: 'C\nD' } }).state;
  expect(value.field(softBreaksField)).toEqual([]);
  expect(value.doc.toString()).toBe('C\nD');
});
it('新增换行的文本与身份共同撤销和重做', () => {
  let value = state('AB');
  value = value.update({ changes: { from: 1, insert: '\n' }, effects: setSoftBreaks.of([1]), userEvent: 'input' }).state;
  expect(undo({ state: value, dispatch: transaction => { value = transaction.state; } })).toBe(true);
  expect(value.doc.toString()).toBe('AB');
  expect(value.field(softBreaksField)).toEqual([]);
  expect(redo({ state: value, dispatch: transaction => { value = transaction.state; } })).toBe(true);
  expect(value.doc.toString()).toBe('A\nB');
  expect(value.field(softBreaksField)).toEqual([1]);
});
it('删除 LF 和全文替换均能通过撤销恢复旧身份', () => {
  for (const changes of [{ from: 1, to: 2 }, { from: 0, to: 3, insert: '新' }]) {
    let value = state('A\nB', [1]).update({ changes, userEvent: 'delete' }).state;
    expect(value.field(softBreaksField)).toEqual([]);
    expect(undo({ state: value, dispatch: transaction => { value = transaction.state; } })).toBe(true);
    expect(value.doc.toString()).toBe('A\nB');
    expect(value.field(softBreaksField)).toEqual([1]);
  }
});
it('源码切换保留同一字段，纯文本重新加载不推断身份', () => {
  const mode = new Compartment();
  let value = EditorState.create({ doc: 'A\n\nB', extensions: [softBreaksField, mode.of(modeFacet.of('todo'))] });
  value = value.update({ effects: setSoftBreaks.of([1]) }).state;
  const identities = value.field(softBreaksField);
  value = value.update({ effects: mode.reconfigure(modeFacet.of('source')) }).state;
  expect(value.field(softBreaksField)).toBe(identities);
  value = value.update({ effects: mode.reconfigure(modeFacet.of('todo')) }).state;
  expect(value.field(softBreaksField)).toBe(identities);
  expect(state(value.doc.toString()).field(softBreaksField)).toEqual([]);
});
