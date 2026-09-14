/**
 * 文件职责：验证隐藏围栏的真实键盘编辑行为。
 * 定义范围：代码边界导航、删除保护、源码与合法文档事务。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorController } from './index';
import { setCodeLanguage } from './code-language';
import { paragraphLayout } from './paragraphs';

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const instances: EditorController[] = [];
function editor(text: string): EditorController {
  const parent = document.createElement('div'); document.body.append(parent);
  const instance = new EditorController(parent, { text, mode: 'todo', onChange: () => {} });
  instances.push(instance); return instance;
}
function key(instance: EditorController, name: string): void {
  instance.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true }));
}
afterEach(() => { instances.splice(0).forEach(instance => instance.destroy()); document.body.replaceChildren(); });

describe('代码围栏编辑边界', () => {
  it('代码首尾删除保留围栏，内部删除正常工作', () => {
    const source = '```ts\nhello\n```'; const instance = editor(source);
    instance.focusAt(6); key(instance, 'Backspace'); expect(instance.text).toBe(source);
    instance.focusAt(11); key(instance, 'Delete'); expect(instance.text).toBe(source);
    instance.focusAt(7); key(instance, 'Backspace'); expect(instance.text).toBe('```ts\nello\n```');
  });
  it('左右箭头跳过围栏并到达相邻正文行', () => {
    const instance = editor('before\n```\nhello\n```\nafter');
    instance.focusAt(6); key(instance, 'ArrowRight'); expect(instance.state.selection.main.head).toBe(11);
    key(instance, 'ArrowLeft'); expect(instance.state.selection.main.head).toBe(6);
    instance.focusAt(16); key(instance, 'ArrowRight'); expect(instance.state.selection.main.head).toBe(21);
    key(instance, 'ArrowLeft'); expect(instance.state.selection.main.head).toBe(16);
  });
  it('文首文末围栏不成为光标落点', () => {
    const instance = editor('```\nhello\n```');
    instance.focusAt(4); key(instance, 'ArrowLeft'); expect(instance.state.selection.main.head).toBe(4);
    instance.focusAt(9); key(instance, 'ArrowRight'); expect(instance.state.selection.main.head).toBe(9);
  });
  it('代码块前后正文的边界删除不会整段删掉隐藏围栏', () => {
    const source = 'before\n```\nhello\n```\nafter'; const instance = editor(source);
    instance.focusAt(6); key(instance, 'Delete'); expect(instance.text).toBe(source);
    instance.focusAt(21); key(instance, 'Backspace'); expect(instance.text).toBe(source);
  });
  it('单独开围栏可继续输入并回车自动闭合', () => {
    const instance = editor('```'); instance.focusAt(3); key(instance, 'Enter');
    expect(instance.text).toBe('```\n\n```\n\n'); expect(instance.state.selection.main.head).toBe(4);
    key(instance, 'ArrowRight'); expect(instance.state.selection.main.head).toBe(instance.text.length);
    key(instance, 'ArrowLeft'); expect(instance.state.selection.main.head).toBe(4);
    key(instance, 'Backspace'); expect(instance.text).toBe('');
    expect(paragraphLayout(instance.state).paragraphs).toMatchObject([{ kind: 'empty', contentFrom: 0 }]);
    instance.view.dispatch({ changes: { from: 0, insert: '块外正文' }, userEvent: 'input.type' });
    expect(instance.text).toBe('块外正文');
  });
  it('语言更新、撤销、粘贴事务和显式范围删除正常生效', () => {
    const instance = editor('```\nhello\n```'); instance.focusAt(4);
    expect(setCodeLanguage(instance.view, 0, 'ts')).toBe(true); expect(instance.text).toBe('```ts\nhello\n```');
    instance.undo(); expect(instance.text).toBe('```\nhello\n```');
    instance.view.dispatch({ changes: { from: 4, to: 9, insert: 'paste' }, userEvent: 'input.paste' });
    expect(instance.text).toBe('```\npaste\n```');
    instance.view.dispatch({ selection: { anchor: 4, head: 9 } }); key(instance, 'Backspace');
    expect(instance.text).toBe('```\n\n```');
  });
  it('源码模式允许编辑围栏本身', () => {
    const instance = editor('```\nhello\n```'); instance.setMode('source');
    instance.focusAt(3); key(instance, 'Backspace'); expect(instance.text).toBe('``\nhello\n```');
  });
});
