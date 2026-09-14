/** 文件职责：验证段落输入、分隔空行投影及编辑导航。 */
import { afterEach, expect, it } from 'vitest';
import { EditorController } from './index';
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
let instance: EditorController;
function editor(text: string): EditorController {
  instance = new EditorController(document.body, { text, mode: 'todo', onChange: () => {} });
  instance.focusAt(text.length);
  return instance;
}
function key(key: string, shiftKey = false): void {
  instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
}
afterEach(() => { instance?.destroy(); document.body.replaceChildren(); });
it('Enter 分段但只显示两个编辑行，撤销恢复原文', () => {
  editor('前段'); key('Enter');
  expect(instance.text).toBe('前段\n\n');
  expect(instance.state.selection.main.head).toBe(4);
  expect(instance.view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(2);
  instance.undo(); expect(instance.text).toBe('前段');
});
it('Shift Enter 仅插入一个换行，源码模式保留原生 Enter', () => {
  editor('正文'); key('Enter', true); expect(instance.text).toBe('正文\n');
  instance.setMode('source'); key('Enter'); expect(instance.text).toBe('正文\n\n');
  expect(instance.view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(3);
});
it('选区替换为段落边界', () => {
  editor('前删除后'); instance.view.dispatch({ selection: { anchor: 1, head: 3 } }); key('Enter');
  expect(instance.text).toBe('前\n\n后');
});
it('左右移动跳过隐藏分隔，退格一次合并段落', () => {
  editor('前\n\n后'); instance.focusAt(3); key('ArrowLeft');
  expect(instance.state.selection.main.head).toBe(1);
  key('ArrowRight'); expect(instance.state.selection.main.head).toBe(3);
  key('Backspace'); expect(instance.text).toBe('前后');
});
it('代码正文空行保留且 Enter 仍为单换行', () => {
  editor('```\na\n\nb\n```'); instance.focusAt(5); key('Enter');
  expect(instance.text).toBe('```\na\n\n\nb\n```');
  expect(instance.view.contentDOM.querySelectorAll('.fm-code-line')).toHaveLength(4);
});
it('连续 Enter 每次增加一个可输入行，空文档也可继续输入', () => {
  editor(''); key('Enter'); key('Enter');
  expect(instance.text).toBe('\n\n\n\n');
  expect(instance.view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(3);
  key('Backspace'); expect(instance.text).toBe('\n\n');
});
it.each([
  { text: '- [ ] 任务', expected: '- [ ] 任务\n\n- [ ] ', sourceExpected: '- [ ] 任务\n- [ ] ' },
  { text: '- 条目', expected: '- 条目\n\n- ', sourceExpected: '- 条目\n- ' },
  { text: '> 引用', expected: '> 引用\n> ', sourceExpected: '> 引用\n> ' },
])('$text 按容器规则续项，源码使用原生换行', ({ text, expected, sourceExpected }) => {
  editor(text); key('Enter');
  expect(instance.text).toBe(expected);
  expect(instance.state.selection.main.head).toBe(expected.length);
  expect(instance.view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(2);
  expect(instance.undo()).toBe(true);
  expect(instance.text).toBe(text);
  instance.setMode('source');
  instance.focusAt(text.length); key('Enter');
  expect(instance.text).toBe(sourceExpected);
  expect(instance.state.selection.main.head).toBe(sourceExpected.length);
  expect(instance.view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(2);
});
it('单行段内换行不折叠，切到源码后恢复完整分隔空行', () => {
  editor('第一段\n段内\n\n第二段');
  expect(instance.view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(3);
  instance.setMode('source');
  expect(instance.view.contentDOM.querySelectorAll('.cm-line')).toHaveLength(4);
  expect(instance.text).toBe('第一段\n段内\n\n第二段');
});
