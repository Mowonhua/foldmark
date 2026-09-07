/** 文件职责：验证来源源码切换、返回位置和项目状态隔离。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';
import { sourceViewFacet } from './state';
const editors: EditorController[] = [];
function editor() {
  const instance = new EditorController(document.body, { text: '# 工作\n\n- [ ] 当前任务\n  正文\n\n# 归档\n\n- [x] 已归档\n  归档正文\n', mode: 'todo', onChange() {} });
  editors.push(instance); return instance;
}
afterEach(() => { editors.splice(0).forEach(instance => instance.destroy()); document.body.replaceChildren(); });
it('待办源码只显示待办，返回进入前的光标位置，切换不进入文本历史', () => {
  const instance = editor();
  const cursor = instance.text.indexOf('当前任务');
  instance.focusAt(cursor);
  instance.toggleSource();
  expect(instance.view.contentDOM.textContent).toContain('- [ ] 当前任务');
  expect(instance.view.contentDOM.textContent).not.toContain('已归档');
  expect(instance.getUIState().sourceReturn?.cursor).toBe(cursor);
  instance.focusAt(instance.text.indexOf('正文'));
  instance.toggleSource();
  expect(instance.getUIState().mode).toBe('todo');
  expect(instance.state.selection.main.head).toBe(cursor);
  expect(instance.undo()).toBe(false);
});
it('归档源码保留来源，允许编辑当前分区并返回归档原位置', () => {
  const instance = editor();
  instance.setMode('archive');
  const cursor = instance.text.indexOf('已归档');
  instance.focusAt(cursor);
  instance.toggleSource();
  expect(instance.state.facet(sourceViewFacet)).toBe('archive');
  expect(instance.view.contentDOM.textContent).toContain('- [x] 已归档');
  expect(instance.view.contentDOM.textContent).not.toContain('当前任务');
  expect(instance.state.readOnly).toBe(false);
  instance.view.dispatch({ changes: { from: cursor, insert: '新' } });
  instance.focusAt(instance.text.length);
  instance.toggleSource();
  expect(instance.getUIState().mode).toBe('archive');
  expect(instance.state.selection.main.head).toBe(cursor + 1);
});
it('保存项目源码状态后切到其他项目，再恢复仍记得来源与进入位置', () => {
  const instance = editor();
  instance.setMode('archive');
  const cursor = instance.text.indexOf('归档正文');
  instance.focusAt(cursor); instance.toggleSource();
  const state = instance.state, ui = instance.getUIState();
  instance.restoreState(instance.createState('- [ ] 另一项目', 'todo'));
  instance.restoreState(state, ui);
  expect(instance.view.contentDOM.textContent).not.toContain('当前任务');
  instance.toggleSource();
  expect(instance.getUIState().mode).toBe('archive');
  expect(instance.state.selection.main.head).toBe(cursor);
});
it('源码删除和撤销同时恢复进入前位置，不把原锚点压到被删除段末端', () => {
  const instance = editor();
  const cursor = instance.text.indexOf('当前任务') + 2;
  instance.focusAt(cursor); instance.toggleSource();
  instance.view.dispatch({ changes: { from: cursor - 2, to: cursor + 2, insert: '' }, userEvent: 'input' });
  instance.undo();
  expect(instance.getUIState().sourceReturn?.cursor).toBe(cursor);
  instance.toggleSource();
  expect(instance.state.selection.main.head).toBe(cursor);
});
it('新源码会话撤销上次源码编辑时，保留这次进入的位置', () => {
  const instance = editor();
  instance.focusAt(instance.text.indexOf('当前任务')); instance.toggleSource();
  instance.view.dispatch({ changes: { from: instance.text.indexOf('当前任务'), insert: '新增' }, userEvent: 'input' });
  instance.toggleSource();
  const cursor = instance.text.indexOf('正文');
  instance.focusAt(cursor); instance.toggleSource(); instance.undo();
  expect(instance.getUIState().sourceReturn?.cursor).toBe(cursor - 2);
});
it('恢复整份草稿可替换完整文档，但归档源码始终只显示恢复后的归档区域', () => {
  const instance = editor();
  const original = instance.text;
  instance.setMode('archive'); instance.toggleSource();
  const replacement = '- [ ] 恢复的待办\n\n# 归档\n\n- [x] 恢复的归档\n';
  instance.setText(replacement);
  expect(instance.text).toBe(replacement);
  expect(instance.view.contentDOM.textContent).toContain('恢复的归档');
  expect(instance.view.contentDOM.textContent).not.toContain('恢复的待办');
  instance.undo();
  expect(instance.text).toBe(original);
  expect(instance.view.contentDOM.textContent).toContain('已归档');
  expect(instance.view.contentDOM.textContent).not.toContain('当前任务');
});
