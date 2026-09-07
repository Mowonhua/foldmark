import { afterEach, describe, expect, it } from 'vitest';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { documentField, modeFacet, sourceViewFacet } from './state';
import { sourceScopeExtension, sourceScopeField, sourceVisibleRanges } from './source-scope';

const text = '# 工作\n\n- [ ] active\n  body\n\n# 归档\n\n- [x] archived\n';
function source(view: 'todo' | 'archive' = 'todo'): EditorState {
  return EditorState.create({ doc: text, extensions: [documentField, modeFacet.of('source'), sourceViewFacet.of(view), sourceScopeExtension] });
}
const visibleText = (state: EditorState): string => sourceVisibleRanges(state).map(range => state.doc.sliceString(range.from, range.to)).join('');
const views: EditorView[] = [];
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); });

describe('来源视图源码范围', () => {
  it('待办与归档源码仅保留各自原文，源码不应用任务折叠', () => {
    expect(visibleText(source())).toBe('# 工作\n\n- [ ] active\n  body\n\n');
    expect(visibleText(source('archive'))).toContain('# 归档');
    expect(visibleText(source('archive'))).toContain('- [x] archived');
    expect(visibleText(source('archive'))).not.toContain('active');
  });
  it('源码中编辑完成标记只映射原冻结范围，不让编辑行消失', () => {
    const state = source();
    const checkbox = text.indexOf('[ ]') + 1;
    const changed = state.update({ changes: { from: checkbox, to: checkbox + 1, insert: 'x' } }).state;
    expect(visibleText(changed)).toContain('- [x] active');
    const inserted = changed.update({ changes: { from: checkbox + 3, insert: '新增文字' } }).state;
    expect(inserted.field(sourceScopeField)[0].from).toBe(state.field(sourceScopeField)[0].from + 4);
    expect(visibleText(inserted)).not.toContain('archived');
  });
  it('归档源码允许修改和恢复完成任务，而待办文本保持原样', () => {
    const state = source('archive');
    const checkbox = text.indexOf('[x]') + 1;
    const changed = state.update({ changes: { from: checkbox, to: checkbox + 1, insert: ' ' } }).state;
    expect(visibleText(changed)).toContain('- [ ] archived');
    expect(changed.doc.sliceString(0, text.indexOf('# 归档'))).toBe(text.slice(0, text.indexOf('# 归档')));
  });
  it('拒绝跨隐藏区间的替换和直接写入另一视图', () => {
    const state = source();
    expect(state.update({ changes: { from: 0, to: text.length, insert: 'replacement' } }).state.doc.toString()).toBe(text);
    const archived = text.indexOf('archived');
    expect(state.update({ changes: { from: archived, to: archived + 8, insert: 'secret change' } }).state.doc.toString()).toBe(text);
  });
  it('全选交集可以编辑可见源码，保留另一视图及章节分隔', () => {
    const state = source();
    const visible = sourceVisibleRanges(state);
    const changed = state.update({ changes: visible.map(range => ({ ...range, insert: 'replacement\n\n' })) }).state;
    expect(changed.doc.toString()).toBe('replacement\n\n' + text.slice(text.indexOf('# 归档')));
  });
  it('重新进入源码会按当前来源重新计算边界', () => {
    const mode = new Compartment();
    let state = EditorState.create({ doc: text, extensions: [documentField, mode.of([modeFacet.of('todo'), sourceViewFacet.of('todo')]), sourceScopeExtension] });
    expect(state.field(sourceScopeField)).toEqual([]);
    state = state.update({ effects: mode.reconfigure([modeFacet.of('source'), sourceViewFacet.of('archive')]) }).state;
    expect(visibleText(state)).not.toContain('active');
    state = state.update({ effects: mode.reconfigure([modeFacet.of('source'), sourceViewFacet.of('todo')]) }).state;
    expect(visibleText(state)).toContain('active');
  });
  it('跨区域选区只提取可见源文', () => {
    const state = source().update({ selection: EditorSelection.single(0, text.length) }).state;
    const selection = state.selection.main;
    expect(sourceVisibleRanges(state, selection.from, selection.to).map(range => state.doc.sliceString(range.from, range.to)).join('')).not.toContain('archived');
  });
  it('全选替换自动补足隐藏章节分隔，不要求用户提供尾换行', () => {
    const state = source();
    const range = sourceVisibleRanges(state)[0];
    const changed = state.update({ changes: { ...range, insert: 'replacement' } }).state;
    expect(changed.doc.toString()).toBe('replacement\n' + text.slice(text.indexOf('# 归档')));
    expect(visibleText(changed)).toBe('replacement\n');
  });
  it('归档源码保留备注与空行', () => {
    const state = EditorState.create({ doc: text + '\n归档备注\n', extensions: [documentField, modeFacet.of('source'), sourceViewFacet.of('archive'), sourceScopeExtension] });
    expect(visibleText(state)).toBe('# 归档\n\n- [x] archived\n\n归档备注\n');
  });
  it('真实全选和复制只操作当前源码视图', () => {
    const parent = document.createElement('div'); document.body.append(parent);
    const view = new EditorView({ state: source(), parent }); views.push(view); view.focus();
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(view.state.selection.main.to).toBe(text.indexOf('# 归档'));
    // 鼠标拖动可跨越被隐藏的区间，剪贴板仍只能输出可见片段。
    view.dispatch({ selection: EditorSelection.single(0, text.length) });
    const copied: Record<string, string> = {};
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', { value: { clearData() {}, setData: (type: string, value: string) => { copied[type] = value; } } });
    view.contentDOM.dispatchEvent(copy);
    expect(copied['text/plain']).toBe(text.slice(0, text.indexOf('# 归档')));
  });
  it('空待办源码允许在归档之前新增内容', () => {
    const archivedOnly = '# 归档\n\n- [x] done\n';
    const state = EditorState.create({ doc: archivedOnly, extensions: [documentField, modeFacet.of('source'), sourceScopeExtension] });
    const changed = state.update({ changes: { from: 0, insert: '- [ ] new' } }).state;
    expect(changed.doc.toString()).toBe('- [ ] new\n' + archivedOnly);
    expect(visibleText(changed)).toBe('- [ ] new\n');
  });
});
