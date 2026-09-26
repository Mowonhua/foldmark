/** 验证新增任务遵循当前光标的结构位置，同时保留正文、子项和撤销边界。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';

let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
function editor(text: string, cursor: number, mode: 'todo' | 'source' = 'todo') {
  instance = new EditorController(document.body, { text, mode, onChange() {} });
  instance.focusAt(cursor);
  return instance;
}

it.each(['todo', 'source'] as const)('%s 在当前任务后插入，保留后续项并可单次撤销重做', mode => {
  const source = '- [ ] 甲\n- [ ] 乙\n- [ ] 丙';
  const view = editor(source, source.indexOf('甲'), mode);
  view.insertTask();
  expect(view.text).toBe('- [ ] 甲\n- [ ] \n\n- [ ] 乙\n- [ ] 丙');
  expect(view.state.selection.main.head).toBe('- [ ] 甲\n- [ ] '.length);
  const inserted = view.text;
  view.undo(); expect(view.text).toBe(source);
  view.redo(); expect(view.text).toBe(inserted);
});

it('在嵌套任务后新增同级任务，保留其正文与子项', () => {
  const source = '- [ ] 父\n  - [ ] 子\n    正文\n    - [ ] 孙\n  - [ ] 后';
  const view = editor(source, source.indexOf('子'));
  view.insertTask();
  expect(view.text).toBe('- [ ] 父\n  - [ ] 子\n    正文\n    - [ ] 孙\n  - [ ] \n\n  - [ ] 后');
  expect(view.model.tasks[3].depth).toBe(view.model.tasks[1].depth);
});

it('光标位于空行时原位新增，不追加到文件末尾', () => {
  const source = '第一段\n\n最后一段';
  const view = editor(source, '第一段\n'.length);
  view.insertTask();
  expect(view.text).toBe('第一段\n- [ ] \n\n最后一段');
});

it('光标位于代码块时在完整代码块之后新增', () => {
  const source = '```js\ncode\n```\n\n末段';
  const view = editor(source, source.indexOf('code'));
  view.insertTask();
  expect(view.text).toBe('```js\ncode\n```\n- [ ] \n\n末段');
  expect(view.model.tasks).toHaveLength(1);
});

it('代码块中的空行仍在块后新增，缩进空行保留当前层级', () => {
  const source = '```js\n\n```\n\n末段';
  const view = editor(source, '```js\n'.length);
  view.insertTask();
  expect(view.text).toBe('```js\n\n```\n- [ ] \n\n末段');
  view.destroy();
  editor('- [ ] 父\n  \n\n尾段', '- [ ] 父\n  '.length).insertTask();
  expect(instance.text).toBe('- [ ] 父\n  - [ ] \n\n尾段');
});

it('源码中刚勾选的当前任务仍按冻结分区在其后新增', () => {
  const source = '- [ ] 甲\n- [ ] 乙';
  const view = editor(source, source.indexOf('甲'), 'source');
  view.view.dispatch({ changes: { from: 3, to: 4, insert: 'x' } });
  view.insertTask();
  expect(view.text).toBe('- [x] 甲\n- [ ] \n\n- [ ] 乙');
});

it.each([false, true])('从归档新增时返回待办且不写入归档，源码=%s', sourceMode => {
  const source = '- [ ] 甲\n\n# 归档\n\n- [x] 旧';
  const view = editor(source, 0);
  view.setMode('archive');
  if (sourceMode) view.setMode('source');
  view.focusAt(source.indexOf('旧'));
  view.insertTask();
  expect(view.getUIState().mode).toBe('todo');
  expect(view.state.selection.main.head).toBeLessThan(view.text.indexOf('# 归档'));
  expect(view.text.slice(view.text.indexOf('# 归档'))).toBe('# 归档\n\n- [x] 旧');
});
