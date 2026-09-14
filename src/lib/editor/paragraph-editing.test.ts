/** 文件职责：通过真实键盘路径验证段落编辑和预览投影共同维护源码分隔。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';
import { paragraphAt, paragraphLayout } from './paragraphs';
import { previewField } from './preview';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
function editor(text: string, mode: 'todo' | 'source' = 'todo') {
  instance = new EditorController(document.body, { text, mode, onChange: () => {} });
  instance.focusAt(text.length);
}
function key(key: string, shiftKey = false, ctrlKey = false) {
  instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, ctrlKey, bubbles: true, cancelable: true }));
}
const lineCount = () => instance.view.contentDOM.querySelectorAll('.cm-line').length;
const editable = () => expect(paragraphAt(paragraphLayout(instance.state), instance.state.selection.main.head)).toBeGreaterThanOrEqual(0);

it('预览新增任务本身是新段落，源码自动补一行分隔', () => {
  editor('- [ ] A\n- [ ] B'); instance.focusAt(7); key('Enter');
  expect(instance.text).toBe('- [ ] A\n\n- [ ] \n\n- [ ] B');
  expect(lineCount()).toBe(3);
  key('Enter');
  expect(instance.text).toBe('- [ ] A\n\n\n\n- [ ] B');
  expect(lineCount()).toBe(3);
  instance.focusAt(instance.text.length); expect(lineCount()).toBe(3);
  instance.focusAt('- [ ] A\n\n'.length); key('Backspace');
  expect(instance.text).toBe('- [ ] A\n\n- [ ] B');
  expect(lineCount()).toBe(2);
});

it.each(['Backspace', 'Delete'])('%s 删除空段落并连带合并分隔，撤销恢复全部源文和光标', keyName => {
  editor('A\n\n\n\n\n\nB'); instance.focusAt(3); key(keyName);
  expect(instance.text).toBe('A\n\n\n\nB'); expect(lineCount()).toBe(3); editable();
  instance.undo(); expect(instance.text).toBe('A\n\n\n\n\n\nB');
  expect(instance.state.selection.main.head).toBe(3);
  instance.redo(); expect(instance.text).toBe('A\n\n\n\nB');
});

it.each(['字', '😀', 'á'])('删除最后一个字形 %s 后保留稳定的空段落', text => {
  editor('A\n\n' + text + '\n\nB'); instance.focusAt(3 + text.length); key('Backspace');
  expect(instance.text).toBe('A\n\n\n\nB'); expect(lineCount()).toBe(3); editable();
  instance.focusAt(instance.text.length); expect(lineCount()).toBe(3);
});

it('任务去标记只改变段落角色，空正文可输入并继续分段', () => {
  editor('- [ ] A\n- [ ] \n- [ ] B'); instance.focusAt('- [ ] A\n- [ ] '.length); key('Backspace');
  expect(instance.text).toBe('- [ ] A\n\n  \n\n- [ ] B'); expect(lineCount()).toBe(3); editable();
  const position = instance.state.selection.main.head;
  instance.view.dispatch({ changes: { from: position, insert: '正文' }, selection: { anchor: position + 2 }, userEvent: 'input.type' });
  expect(instance.view.contentDOM.querySelector('.fm-code-line')).toBeNull();
  key('Enter');
  expect(instance.text).toBe('- [ ] A\n\n  正文\n\n  \n\n- [ ] B');
  expect(lineCount()).toBe(4); editable();
});

it('空任务去标记后的空正文与输入文字后的正文使用同一缩进和源码前缀隐藏', () => {
  editor('- [ ] A\n- [ ] \n- [ ] B'); instance.focusAt('- [ ] A\n- [ ] '.length); key('Backspace');
  const cursor = instance.state.selection.main.head;
  const from = instance.state.doc.lineAt(cursor).from;
  const style = () => [...instance.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')][1].style.marginLeft;
  const before = style(); expect(before).not.toBe('');
  const hidden: [number, number][] = [];
  instance.state.field(previewField).between(from, cursor, (a, b) => { if (a === from && b === cursor) hidden.push([a, b]); });
  expect(hidden).toContainEqual([from, cursor]);
  instance.view.dispatch({ changes: { from: cursor, insert: 'a' }, selection: { anchor: cursor + 1 }, userEvent: 'input.type' });
  expect(style()).toBe(before);
});

it.each([false, true])('Enter 与 Ctrl Enter 都创建新段落：ctrl=%s', ctrl => {
  editor('A\n\nB'); instance.focusAt(1); key('Enter', false, ctrl);
  expect(instance.text).toBe('A\n\n\n\nB'); editable();
});

it('嵌套任务去标记保留父任务归属，软换行仍在同段', () => {
  editor('- [ ] 父\n  - [ ] 子正文\n  - [ ] 后'); instance.focusAt(instance.text.indexOf('子')); key('Backspace');
  expect(instance.text).toBe('- [ ] 父\n\n  子正文\n\n  - [ ] 后');
  instance.focusAt(instance.text.indexOf('子') + 1); key('Enter', true);
  expect(instance.text).toContain('  子\n  正文\n\n');
  expect(instance.model.tasks).toHaveLength(2);
});

it.each(['todo', 'source'] as const)('%s 模式下任务退格遵守对应结构规则', mode => {
  editor('- [ ] A\n- [ ] \n- [ ] B', mode); instance.focusAt('- [ ] A\n- [ ] '.length); key('Backspace');
  expect(instance.text).toBe(mode === 'source' ? '- [ ] A\n      \n- [ ] B' : '- [ ] A\n\n  \n\n- [ ] B');
});

it.each(['Backspace', 'Enter'])('前邻隐藏完成项时，%s 不把空段落送入归档', keyName => {
  const text = '- [ ] A\n- [x] C\n\n- [ ] \n- [ ] B';
  editor(text); instance.focusAt(text.indexOf('\n- [ ] B')); key(keyName);
  expect(instance.text).toBe(text); editable();
});

it.each([
  { text: 'A\n\nB', at: 1, expected: 'A\n\n\nB' },
  { text: '- [ ] A\n\n  body\n\n- [ ] B', at: 15, expected: '- [ ] A\n\n  body\n  \n\n- [ ] B' },
])('分隔前 Shift Enter 只增加一个段内换行：$text', ({ text, at, expected }) => {
  editor(text); const paragraphs = paragraphLayout(instance.state).paragraphs.length;
  instance.focusAt(at); key('Enter', true);
  expect(instance.text).toBe(expected); editable();
  expect(paragraphLayout(instance.state).paragraphs).toHaveLength(paragraphs);
  key('Enter', true); editable();
  expect(paragraphLayout(instance.state).paragraphs).toHaveLength(paragraphs);
  expect(instance.text.split('\n')).toHaveLength(text.split('\n').length + 2);
  const count = lineCount(); instance.focusAt(instance.text.length); expect(lineCount()).toBe(count);
  instance.undo(); expect(instance.text).toBe(expected);
  instance.undo(); expect(instance.text).toBe(text);
});

it('任务首行 Shift Enter 留在当前任务段，Ctrl Enter 在续行创建正文段', () => {
  const text = '- [ ] A\n\n- [ ] B';
  editor(text); instance.focusAt(7); key('Enter', true);
  expect(instance.text).toBe('- [ ] A\n  \n\n- [ ] B');
  expect(paragraphLayout(instance.state).paragraphs).toHaveLength(2); editable();
  key('Enter', false, true);
  expect(instance.text).toBe('- [ ] A\n  \n\n  \n\n- [ ] B');
  expect(paragraphLayout(instance.state).paragraphs).toHaveLength(3); editable();
});

it('连续纯换行在源码切换与撤销重做后仍可继续输入，不添加任何标记', () => {
  editor('- [ ] A\n\n- [ ] B'); instance.focusAt(7);
  key('Enter', true); key('Enter', true);
  const source = '- [ ] A\n  \n  \n\n- [ ] B';
  expect(instance.text).toBe(source);
  instance.setMode('source'); instance.setMode('todo');
  expect(instance.text).toBe(source);
  expect(paragraphLayout(instance.state).paragraphs).toHaveLength(2); editable();
  instance.undo(); instance.redo();
  expect(instance.text).toBe(source); editable();
  const cursor = instance.state.selection.main.head;
  instance.view.dispatch({ changes: { from: cursor, insert: 'text' }, selection: { anchor: cursor + 4 }, userEvent: 'input.type' });
  expect(instance.text).toBe('- [ ] A\n  \n  text\n\n- [ ] B');
  expect(paragraphLayout(instance.state).paragraphs).toHaveLength(2);
});

it.each(['Backspace', 'Delete'])('%s 删除段内换行时合并正文', keyName => {
  editor('AB\n\nC'); instance.focusAt(1); key('Enter', true);
  instance.focusAt(keyName === 'Backspace' ? 2 : 1); key(keyName);
  expect(instance.text).toBe('AB\n\nC'); editable();
});

it('段落间新建和删除空段落可往返，前后只保留一个分隔', () => {
  editor('A\n\nB'); instance.focusAt(1); key('Enter');
  expect(instance.text).toBe('A\n\n\n\nB'); expect(lineCount()).toBe(3);
  instance.setMode('source'); expect(lineCount()).toBe(5);
  instance.setMode('todo'); expect(lineCount()).toBe(3);
  instance.focusAt(3); key('Delete');
  expect(instance.text).toBe('A\n\nB'); expect(lineCount()).toBe(2);
});
